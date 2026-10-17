import {CapabilityError,RecordStore,digest,type JsonObject} from '@friend-pi/core';
import {V2Store,text,optionalText,arrayText,intOrNull} from './store.js';
import {
  createTeam,getTeam,updateTeam,setTeamStatus,createTask,getTask,listTasks,
  transitionTask,addRequirementVersion,setDependencies,completeAttempt,failAttempt,markAttemptRunning,
  startRework,recoverStaleAttempts,
} from './task-board.js';
import {scheduleOnce,runningAttempts,readyFrontier} from './scheduler.js';
import {createBudget,readBudget,getTeamBudgets,reserve,settle,release,budgetExhausted,assertTeamBudget} from './budget.js';
import {
  startVerification,recordChecks,runChecks,submitVerdict,applyVerdict,evaluateMergeGates,integrateTask,
  requiredVerdictKinds,assertNoSilentMerge,
} from './verification.js';
import {provisionMember,admitMember,markMemberFailed,stopMember,listMembers} from './roster.js';
import {sendMessage,queueMessage,deliverMessage,incorporateMessage,expireMessages,listMessages,waitForMessages,assertFifo} from './messages.js';
import type {SwarmV2Actor,SwarmV2Risk} from './types.js';

export interface V2Context {origin?: string; actorId?: string; projectId?: string; sessionId?: string; projectDir?: string}
const IRREVERSIBLE = new Set(['team.pause', 'team.resume', 'integrate', 'budget.release', 'attempt.recover']);
const AGENT_FORBIDDEN = new Set(['team.create', 'member.provision', 'member.admit', 'member.stop', 'schedule.once', 'budget.create', 'budget.release', 'integrate', 'team.pause', 'team.resume']);

/** Adapter over the v2 modules; controller owns idempotency and origin checks. */
export class CoordinationService {
  readonly v2: V2Store;
  constructor(readonly store: RecordStore) { this.v2 = V2Store.open(store); }
  private assertAllowed(action: string, ctx: V2Context): void {
    if (IRREVERSIBLE.has(action) && ctx.origin !== 'user' && ctx.origin !== 'plugin') throw new CapabilityError('PERMISSION_DENIED', '该动作需要用户确认');
    if (AGENT_FORBIDDEN.has(action) && ctx.origin === 'agent') throw new CapabilityError('PERMISSION_DENIED', '该动作仅协调者或用户可执行');
  }
  /** Controller boundary: bind every v2 action to the calling project/session. */
  private bindScope(action: string, input: JsonObject, ctx: V2Context): JsonObject {
    const teamRow = (teamId: string) => this.v2.row<{project_id: string; root_session_id: string}>('SELECT project_id,root_session_id FROM swarm_v2_teams WHERE team_id=?', teamId);
    if (action === 'team.create') return {...input, projectId: ctx.projectId, rootSessionId: ctx.sessionId, workspaceRoot: ctx.projectDir || input.workspaceRoot, teamId: typeof input.teamId === 'string' ? input.teamId : `team:${ctx.projectId}:${ctx.sessionId}`};
    let objectTeam: string | null = null;
    const lookup: [string, string, string][] = [
      ['taskId', 'swarm_v2_tasks', 'team_id'], ['memberId', 'swarm_v2_members', 'team_id'],
      ['budgetId', 'swarm_v2_budgets', 'team_id'], ['messageId', 'swarm_v2_messages', 'team_id'],
      ['verificationId', 'swarm_v2_verifications', 'team_id'], ['verdictId', 'swarm_v2_verdicts', 'team_id'],
    ];
    for (const [field, table, column] of lookup) {
      if (objectTeam) break;
      const id = input[field];
      if (typeof id === 'string' && id) {
        const row = this.v2.row<Record<string, unknown>>(`SELECT ${column} AS team_id FROM ${table} WHERE ${field === 'taskId' ? 'task_id' : field === 'memberId' ? 'member_id' : field === 'budgetId' ? 'budget_id' : field === 'messageId' ? 'message_id' : field === 'verificationId' ? 'verification_id' : 'verdict_id'}=?`, id);
        if (row) objectTeam = String(row.team_id);
      }
    }
    if (!objectTeam && typeof input.attemptId === 'string') {
      const row = this.v2.row<{team_id: string}>('SELECT t.team_id FROM swarm_v2_attempts a JOIN swarm_v2_tasks t ON t.task_id=a.task_id WHERE a.attempt_id=?', input.attemptId);
      if (row) objectTeam = row.team_id;
    }
    if (!objectTeam && (typeof input.entryId === 'string' || typeof input.reservationId === 'string')) {
      const row = this.v2.row<{team_id: string}>('SELECT b.team_id FROM swarm_v2_budget_entries e JOIN swarm_v2_budgets b ON b.budget_id=e.budget_id WHERE e.reservation_id=?', String(input.entryId ?? input.reservationId));
      if (row) objectTeam = row.team_id;
    }
    const declaredTeam = typeof input.teamId === 'string' && input.teamId ? input.teamId : null;
    if (objectTeam && declaredTeam && objectTeam !== declaredTeam) throw new CapabilityError('PERMISSION_DENIED', '对象不属于所声明的团队');
    const teamId = objectTeam ?? declaredTeam;
    if (!teamId) throw new CapabilityError('VALIDATION_ERROR', 'v2 动作缺少可绑定到当前项目/会话的团队');
    const team = teamRow(teamId);
    if (!team || team.project_id !== ctx.projectId || team.root_session_id !== ctx.sessionId) throw new CapabilityError('PERMISSION_DENIED', '团队不属于当前项目/会话');
    return {...input, teamId};
  }
  private teamId(input: JsonObject): string { return text(input.teamId, 'teamId', 200); }
  dispatch(action: string, input: JsonObject, ctx: V2Context = {}): unknown {
    this.assertAllowed(action, ctx);
    if (ctx.projectId) input = this.bindScope(action, input, ctx);
    const v2 = this.v2, store = this.store, actorId = ctx.actorId || 'controller';
    switch (action) {
      case 'snapshot': return this.snapshot(this.teamId(input));
      case 'team.create': {
        const teamInput: Parameters<typeof createTeam>[1] = {
          projectId: text(input.projectId, 'projectId', 200), rootSessionId: text(input.rootSessionId, 'rootSessionId', 200),
          workspaceRoot: text(input.workspaceRoot, 'workspaceRoot', 4000),
          autonomyLevel: intOrNull(input.autonomyLevel, 'autonomyLevel', 0, 4) ?? undefined,
        };
        if (input.teamId !== undefined) teamInput.teamId = text(input.teamId, 'teamId', 200);
        if (input.policy && typeof input.policy === 'object') teamInput.policy = input.policy as Record<string, unknown>;
        return createTeam(v2, teamInput);
      }
      case 'team.status': return this.snapshot(this.teamId(input));
      case 'team.pause': return setTeamStatus(v2, this.teamId(input), expectedRevision(input), 'paused');
      case 'team.resume': return setTeamStatus(v2, this.teamId(input), expectedRevision(input), 'running');
      case 'member.provision': return provisionMember(store, {
        teamId: this.teamId(input), name: text(input.name, 'name', 120), role: text(input.role, 'role', 20),
        contextMode: optionalText(input.contextMode, 'contextMode', 20) ?? 'fresh',
        modelRef: optionalText(input.modelRef, 'modelRef', 200),
        capabilities: input.capabilities, writeScopes: input.writeScopes,
        memberPath: optionalText(input.memberPath, 'memberPath', 300),
      });
      case 'member.admit': return admitMember(store, text(input.memberId, 'memberId', 200), {firstEntryId: text(input.firstEntryId, 'firstEntryId', 200), firstEntryPersisted: input.firstEntryPersisted === true, generation: intOrNull(input.generation, 'generation', 0) ?? undefined});
      case 'member.fail': return markMemberFailed(store, text(input.memberId, 'memberId', 200), text(input.reason, 'reason', 5000));
      case 'member.stop': return stopMember(store, text(input.memberId, 'memberId', 200), input.objects as never);
      case 'member.list': return listMembers(store, this.teamId(input));
      case 'task.create': return createTask(v2, this.teamId(input), {
        title: text(input.title, 'title', 200), description: text(input.description, 'description', 16384),
        mode: (optionalText(input.mode, 'mode', 10) ?? 'write') as never, risk: (optionalText(input.risk, 'risk', 2) ?? 'V1') as SwarmV2Risk,
        dependencies: arrayText(input.dependencies, 'dependencies', 64, 100), writeScopes: arrayText(input.writeScopes, 'writeScopes', 64, 500),
        acceptance: arrayText(input.acceptance, 'acceptance', 64, 500), checksRef: optionalText(input.checksRef, 'checksRef', 200),
        workspacePolicy: (optionalText(input.workspacePolicy, 'workspacePolicy', 20) ?? 'worktree') as never,
        logicalStepId: optionalText(input.logicalStepId, 'logicalStepId', 200) ?? undefined,
      }, actorId);
      case 'task.get': return getTask(v2, text(input.taskId, 'taskId', 200));
      case 'task.list': return listTasks(v2, this.teamId(input), {status: optionalText(input.status, 'status', 20) as never ?? undefined, includeDeleted: input.includeDeleted === true}).slice(0, intOrNull(input.limit, 'limit', 1, 100) ?? 100);
      case 'task.transition': {
        const transition = text(input.transition, 'transition', 30);
        if (['claim', 'admit', 'deliver', 'verify', 'complete', 'retry'].includes(transition)) throw new CapabilityError('PERMISSION_DENIED', '该状态迁移必须通过 attempt.complete / verify.apply / integrate / scheduler 完成');
        return transitionTask(v2, text(input.taskId, 'taskId', 200), expectedRevision(input), transition, actorId);
      }
      case 'task.addRequirement': return addRequirementVersion(v2, text(input.taskId, 'taskId', 200), expectedRevision(input), {prompt: text(input.prompt, 'prompt', 16384), reason: optionalText(input.reason, 'reason', 1000) ?? undefined, automatic: input.automatic === true}, actorId);
      case 'task.setDependencies': return setDependencies(v2, text(input.taskId, 'taskId', 200), expectedRevision(input), arrayText(input.dependencies, 'dependencies', 64, 100), actorId);
      case 'task.rework': return startRework(v2, this.teamId(input), arrayText(input.taskIds, 'taskIds', 64, 100), text(input.reason, 'reason', 5000), input.changes as Record<string,string> | undefined);
      case 'schedule.once': {
        const teamId = this.teamId(input);
        // Hard gate per task: an exhausted team or that task's budget blocks the dispatch.
        // No synthetic reservation rows are written before an attempt exists (P1.1 attaches
        // native reservations/settlement from the member runtime).
        const reserveHook = (task: {taskId: string}) => {
          try {
            assertTeamBudget(v2, teamId);
            const taskBudget = getTeamBudgets(v2, teamId).find(item => item.scope === 'task' && item.scopeId === task.taskId);
            if (taskBudget && budgetExhausted(v2, taskBudget)) return null;
            return {tokens: 0, costMicros: 0};
          } catch { return null; }
        };
        return scheduleOnce(v2, teamId, {maxWorkers: intOrNull(input.maxWorkers, 'maxWorkers', 1, 16) ?? undefined, memberIdForTask: input.memberIdForTask as Record<string,string> | undefined, reserve: reserveHook});
      }
      case 'attempt.running': return markAttemptRunning(v2, text(input.attemptId, 'attemptId', 200), {generation: intOrNull(input.generation, 'generation', 0) ?? 1, workspaceId: optionalText(input.workspaceId, 'workspaceId', 200)});
      case 'attempt.complete': return completeAttempt(v2, text(input.attemptId, 'attemptId', 200), {summary: text(input.summary, 'summary', 100000), commitSha: optionalText(input.commitSha, 'commitSha', 200), candidateTip: optionalText(input.candidateTip, 'candidateTip', 200), resultDigest: optionalText(input.resultDigest, 'resultDigest', 200), sessionId: optionalText(input.sessionId, 'sessionId', 200), sessionFile: optionalText(input.sessionFile, 'sessionFile', 2000), evidenceRefs: arrayText(input.evidenceRefs, 'evidenceRefs', 100, 500), artifactIds: arrayText(input.artifactIds, 'artifactIds', 100, 200)});
      case 'attempt.fail': return failAttempt(v2, text(input.attemptId, 'attemptId', 200), {reason: text(input.reason, 'reason', 5000), unknown: input.unknown === true});
      case 'attempt.recover': return recoverStaleAttempts(v2, this.teamId(input), {leaseMs: intOrNull(input.leaseMs, 'leaseMs', 1000, 86_400_000) ?? undefined});
      case 'budget.create': return createBudget(v2, {teamId: this.teamId(input), scope: text(input.scope, 'scope', 10) as never, scopeId: text(input.scopeId, 'scopeId', 200), tokenLimit: intOrNull(input.tokenLimit, 'tokenLimit', 1), costLimitMicros: intOrNull(input.costLimitMicros, 'costLimitMicros', 1), timeLimitMs: intOrNull(input.timeLimitMs, 'timeLimitMs', 1), concurrencyLimit: intOrNull(input.concurrencyLimit, 'concurrencyLimit', 1, 16)});
      case 'budget.read': return readBudget(v2, text(input.budgetId, 'budgetId', 200));
      case 'budget.reserve': return reserve(v2, {teamId: this.teamId(input), budgetId: text(input.budgetId, 'budgetId', 200), attemptId: text(input.attemptId, 'attemptId', 200), tokens: intOrNull(input.tokens, 'tokens', 0) ?? 0, costMicros: intOrNull(input.costMicros, 'costMicros', 0) ?? 0});
      case 'budget.settle': return settle(v2, {entryId: text(input.entryId, 'entryId', 200), tokens: intOrNull(input.tokens, 'tokens', 0) ?? undefined, costMicros: intOrNull(input.costMicros, 'costMicros', 0) ?? undefined, unknown: input.unknown === true});
      case 'budget.release': return release(v2, text(input.entryId, 'entryId', 200));
      case 'budget.exhausted': return {exhausted: budgetExhausted(v2, readBudget(v2, text(input.budgetId, 'budgetId', 200)))};
      case 'verify.start': return startVerification(v2, {teamId: this.teamId(input), taskId: text(input.taskId, 'taskId', 200), candidateDigest: text(input.candidateDigest, 'candidateDigest', 200), level: text(input.level, 'level', 2) as SwarmV2Risk, checks: input.checks as never, attemptId: optionalText(input.attemptId, 'attemptId', 200) ?? undefined});
      case 'verify.runChecks': return runChecks(v2, {teamId: this.teamId(input), taskId: optionalText(input.taskId, 'taskId', 200), attemptId: optionalText(input.attemptId, 'attemptId', 200), verificationId: optionalText(input.verificationId, 'verificationId', 200), checks: input.checks as never, artifacts: input.artifacts as never, files: input.files as never, executor: input.results && typeof input.results === 'object' ? (spec: {checkId?: string; id?: string}) => (input.results as Record<string, never>)[String(spec.checkId ?? spec.id ?? '')] : undefined});
      case 'verify.checks': return recordChecks(v2, text(input.verificationId, 'verificationId', 200), input.results as never);
      case 'verify.submit': return submitVerdict(v2, {verificationId: text(input.verificationId, 'verificationId', 200), kind: text(input.kind, 'kind', 20) as never, reviewerMemberId: text(input.reviewerMemberId, 'reviewerMemberId', 200), sessionId: optionalText(input.sessionId, 'sessionId', 200), sessionFile: optionalText(input.sessionFile, 'sessionFile', 2000), approved: input.approved === true, findings: arrayText(input.findings, 'findings', 50, 2000), taskIds: arrayText(input.taskIds, 'taskIds', 64, 100), resultVersions: (input.resultVersions && typeof input.resultVersions === 'object' ? input.resultVersions : {}) as Record<string, number>, candidateDigest: text(input.candidateDigest, 'candidateDigest', 200), reviewedTip: text(input.reviewedTip, 'reviewedTip', 200), binding: optionalText(input.binding, 'binding', 30) as never});
      case 'verify.apply': return applyVerdict(v2, text(input.verdictId, 'verdictId', 200));
      case 'gates': return evaluateMergeGates(v2, {taskId: text(input.taskId, 'taskId', 200), candidateDigest: text(input.candidateDigest, 'candidateDigest', 200), verdictId: optionalText(input.verdictId, 'verdictId', 200) ?? undefined, ...(input.gateInput && typeof input.gateInput === 'object' ? input.gateInput as object : {})});
      case 'integrate': return integrateTask(v2, {taskId: text(input.taskId, 'taskId', 200), candidateDigest: text(input.candidateDigest, 'candidateDigest', 200), verdictId: optionalText(input.verdictId, 'verdictId', 200) ?? undefined, files: input.files as never, gateInput: input.gateInput as never});
      case 'message.send': return sendMessage(store, {teamId: this.teamId(input), messageId: optionalText(input.messageId, 'messageId', 200), sender: {kind: text(input.senderKind, 'senderKind', 20), id: optionalText(input.senderId, 'senderId', 200), generation: intOrNull(input.senderGeneration, 'senderGeneration', 0) ?? undefined}, targetId: text(input.targetId, 'targetId', 200), targetKind: optionalText(input.targetKind, 'targetKind', 30) ?? 'member', type: text(input.type, 'type', 100), deliveryMode: text(input.deliveryMode, 'deliveryMode', 10), body: text(input.body, 'body', 16384), provenance: input.provenance, expiresAt: optionalText(input.expiresAt, 'expiresAt', 100)});
      case 'message.queue': return queueMessage(store, text(input.messageId, 'messageId', 200));
      case 'message.deliver': return deliverMessage(store, text(input.messageId, 'messageId', 200));
      case 'message.incorporate': return incorporateMessage(store, text(input.messageId, 'messageId', 200), text(input.nativeEntryId, 'nativeEntryId', 200));
      case 'message.expire': return expireMessages(store, this.teamId(input), optionalText(input.now, 'now', 100) ?? undefined);
      case 'message.list': return listMessages(store, this.teamId(input), {targetId: optionalText(input.targetId, 'targetId', 200), afterSequence: intOrNull(input.afterSequence, 'afterSequence', 0) ?? undefined, limit: intOrNull(input.limit, 'limit', 1, 200) ?? 100});
      case 'message.wait': return waitForMessages(store, this.teamId(input), {afterSequence: intOrNull(input.afterSequence, 'afterSequence', 0) ?? 0, targetId: optionalText(input.targetId, 'targetId', 200), timeoutMs: intOrNull(input.timeoutMs, 'timeoutMs', 10_000, 3_600_000) ?? 10_000, pollMs: intOrNull(input.pollMs, 'pollMs', 1, 100) ?? 100});
      case 'message.assertFifo': return assertFifo(store, this.teamId(input), text(input.targetId, 'targetId', 200));
      case 'journal.read': return v2.events(this.teamId(input), intOrNull(input.afterSeq, 'afterSeq', 0) ?? 0, intOrNull(input.limit, 'limit', 1, 2000) ?? 500);
      case 'audit.export': return this.snapshot(this.teamId(input));
      case 'projection.rebuild': return v2.refreshProjection(this.teamId(input));
      case 'silentMerge.assert': return assertNoSilentMerge(v2, this.teamId(input));
      default: throw new CapabilityError('VALIDATION_ERROR', `未知 Swarm v2 动作：${action}`);
    }
  }
  snapshot(teamId: string): unknown {
    const team = getTeam(this.v2, teamId);
    const tasks = listTasks(this.v2, teamId);
    const summary = this.v2.refreshProjection(teamId);
    return {
      v: 2, schemaVersion: summary.schemaVersion, team, summary,
      members: listMembers(this.store, teamId), tasks,
      runningAttempts: runningAttempts(this.v2, teamId), readiness: readyFrontier(this.v2, teamId),
      budgets: getTeamBudgets(this.v2, teamId), projection: this.v2.projection(teamId),
      journal: this.v2.events(teamId, 0, 50), silentMerge: summary.silentMerge,
      requiredVerdictKinds: {V0: requiredVerdictKinds('V0'), V1: requiredVerdictKinds('V1'), V2: requiredVerdictKinds('V2'), V3: requiredVerdictKinds('V3')},
    };
  }
}
function expectedRevision(input: JsonObject): number { const value = input.expectedRevision ?? input.revision; if (!Number.isSafeInteger(value) || Number(value) < 1) throw new CapabilityError('VALIDATION_ERROR', 'expectedRevision无效'); return Number(value); }
export {digest};
