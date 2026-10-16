import type {SourceRef,ArtifactRef,CapabilityDependency,EvidenceReceipt,SourceFence,ErrorCode,PermissionMode,CheckRef} from '@friend-pi/core';
export interface ExecutionPolicy {v:1;workspace:'isolated'|'shared';review:'required'|'none';dirtyBaseline:'snapshot'|'reject'}
export type GraphStatus = 'created'|'running'|'stopping'|'paused'|'completed'|'awaiting_review'|'ready'|'integrated'|'failed'|'stopped';
export type TaskStatus = 'pending'|'running'|'completed'|'skipped'|'unknown'|'blocked'|'cancelled';
export interface Check { command: string; args: string[] }
export interface Task {
  waiting?:TaskWait;
  constraints?:string[];unresolved?:string[];
  contract?:TaskContract;
  memberId?: string; memberName?: string; resumeFromAttempt?:string;
  id: string; title: string; prompt: string; dependencies: string[]; mode: 'read'|'write';
  expertOverrides?:import('@friend-pi/core').ExpertSpawnOverrides;
  expertId?: string; writeScopes: string[]; status: TaskStatus; currentAttempt?: string;
  modelId?:string;thinkingLevel?:string;roleId?:string;logicalStepId?:string;workflowHeld?:boolean;
  rework: number; resultRevision: number;
  originalPrompt?:string; requirementVersions?:{version:number;prompt:string;reason?:string;automatic?:boolean;at:string}[];
}
export interface Attempt {
  usageObserved?:boolean;
  requiredHandoff?:import('./handoff.js').HandoffRef;
  handoffRead?:ReturnType<typeof import('./handoff.js').verifyHandoffRead>;
  nativeChecks?:CheckRef[];trialTerminalOutcome?:'completed'|'failed'|'cancelled'|'unknown';trialObservation?:{key:string;outcome:'completed'|'failed'|'cancelled'|'unknown';status:'observed'|'waiting';attempts?:number;retryAt?:number;error?:string;result?:unknown};
  childCreationStarted?:boolean;exitReceipt?:StopObject;reservationsReleased?:boolean;startPromptDigest?:string;frozen?:FrozenExecution;sourceFence?:SourceFence;resourceReservationId?:string;budgetReservationId?:string;targetBaselines?:Record<string,string>;inputBaselines?:Record<string,string>;dependencyResults?:{taskId:string;resultRevision:number;commit?:string;artifactDigest?:string}[];
  memberId?: string; generation?: number; retainedFrom?:string;
  id: string; taskId: string; number: number; resultRevision: number; status: 'running'|'completed'|'failed'|'unknown';
  cwd: string; mode: 'read'|'write'; ownerPid: number; ownerRuntime: string; startedAt: string; finishedAt?: string;
  modelId?: string; thinkingLevel?: string; expert?: unknown; writeScopes: string[];
  sessionId?: string; sessionFile?: string; summary?: string; commit?: string; error?: string;
  requirementVersion?:number; expertAdoptions?:unknown[];
}
export interface Baseline { repoRoot: string; projectRelative: string; head: string; branch?: string }
export interface Review { attemptId: string; approved: boolean; findings: string; at: string; sessionId?: string; sessionFile?: string;taskIds?:string[];resultVersions?:Record<string,number>;candidateDigest?:string;kind?:'reviewer'|'verifier' }
export interface ReviewAttempt {attemptId:string;cwd:string;status:'running'|'completed'|'failed'|'unknown';startedAt:string;finishedAt?:string;sessionId?:string;sessionFile?:string;error?:string}
export interface CheckResult { command: string; args: string[]; exitCode: number|null; output: string; at: string;cancelled?:boolean;operationId?:string }
export interface StopObject {id:string;kind:'member'|'check'|'git'|'activity';status:'terminated'|'unknown';pid?:number;exitCode?:number|null;signal?:string|null;detail?:string}
export interface StopReceipt {operationId:string;requestedAt:string;finishedAt:string;objects:StopObject[];unknownAttemptIds:string[]}
export interface Graph {
  claims?:import('./reporting.js').ClaimCitation[];
  executionPolicy?:ExecutionPolicy;executionPolicyExplicit?:boolean;reviewContractRequired?:boolean;snapshotDir?:string;repositoryBaseline?:Baseline;

  planning?:{reason:string;strategy:'collaboration';estimatesKnown:false};
  schemaVersion?:3;contract?:TaskContract;budget?:BudgetSnapshot;sourceFence?:SourceFence;pauseReason?:{code:ErrorCode;message:string;operationId?:string};failureFingerprints?:string[];cumulativeTaskCount?:number;
  collaborationVersion?: 2;
  id: string; projectId: string; sessionId: string; projectDir: string; goal: string; status: GraphStatus;
  createdAt: string; updatedAt: string; tasks: Task[]; attempts: Attempt[]; maxWorkers: number; reworkRound: number;
  modelId?: string; thinkingLevel?: string; agentDir?: string; checks: Check[]; baseline?: Baseline;
  integration?: {reviewStatus?:'not_requested'|'required'|'approved'|'rejected';applyReservationId?:string;cwd: string; head?: string; checks: CheckResult[]; review?: Review;verifier?:Review;candidateDigest?:string;verification?:VerificationRecord}; error?: string;
  stopReceipt?:StopReceipt;expertCatalog?:unknown;expertUnavailable?:boolean;runId?:string;
  executionOwner?:{pid:number;runtime:string};
  executionStyle?:'team'|'swarm';workflowId?:string;deferPreparation?:boolean;integratedTaskIds?:string[];parentTools?:string[];permissionMode?:PermissionMode;temporaryWriteRoot?:string;goalId?:string;audit?:boolean;auditEvidence?:unknown;
  reviews?:Review[];reviewAttempts?:ReviewAttempt[];
}
export interface TaskWait {kind:'dependency'|'member'|'concurrency'|'resource'|'budget'|'workflow'|'paused';message:string;dependencyIds?:string[];memberId?:string;reservationId?:string;resourceKeys?:string[];blockingTaskId?:string;blockingGraphId?:string}
export interface MemberMessage {id: string; graphId: string; from: string; to: string; body: string; createdAt: string; deliveredAt?: string; processedAt?: string; attemptId?: string; memberId?:string; sequence?:number; receivedAt?:string; nativeEntryId?:string; bodyDigest?:string; generation?:number; senderMemberId?:string; kind?:'constraint'|'discussion';contextKind?:'constraint'|'discussion';contextGraphId?:string;contextTaskId?:string}
export interface Teammate {
  id:string; projectId:string; rootSessionId:string; name:string; description:string; key?:string;
  state:'provisioning'|'idle'|'running'|'stopping'|'paused'|'failed'; generation:number; nextSequence:number;
  createdAt:string; updatedAt:string; graphId?:string; taskId?:string; attemptId?:string;
  provisioning?:{attemptId:string;generation:number;intentAt:string;snapshotDigest?:string;firstEntryId?:string};sessionId?:string; sessionFile?:string; cwd?:string; modelId?:string; thinkingLevel?:string;
  ownerPid?:number; ownerRuntime?:string; discussion?:boolean; reason?:string; stopReceipt?:StopObject;
}
export interface SharedDocument { graphId: string; name: string; content: string; file: string; version: number; digest: string; updatedAt: string;origin?:{taskId?:string;attemptId?:string;operationId?:string};merged?:boolean;mergeSources?:{revision:number;digest:string}[] }
export interface SharedConflict {id:string;graphId:string;name:string;status:'pending'|'resolved'|'paused'|'cancelled';base?:SharedDocument;latest?:SharedDocument;proposed:string;proposedDigest:string;origin?:SharedDocument['origin'];reason?:string;createdAt:string;resolvedRevision?:number;ownerPid?:number}
export interface MemberStart {
  requiredHandoff?:import('./handoff.js').HandoffRef;
  resourceReservationId?:string;sourceFence?:SourceFence;candidateDigest?:string;verificationKind?:'reviewer'|'verifier';frozen?:FrozenExecution;
  v: 1|2; type: 'start'; graphId: string; taskId: string; attemptId: string; cwd: string; dataDir: string;
  agentDir: string; sessionDir: string; modelId?: string; thinkingLevel?: string; prompt: string;
  expert?: unknown; mode: 'read'|'write'; writeScopes: string[]; reviewResult?: boolean;
  executionStyle?:'team'|'swarm';roleId?:string;parentTools?:string[];permissionMode?:PermissionMode;temporaryWriteRoot?:string;
  resultVersions?:Record<string,number>;
  memberId?:string; rootSessionId?:string; generation?:number; nativeSessionFile?:string; discussion?:boolean;
}
export type MemberInput = MemberStart | {v:1|2;type:'steer';messageId:string;text:string;memberId?:string;generation?:number;attemptId?:string;bodyDigest?:string} | {v:1;type:'stop'} | {v:1;type:'confirm.response';requestId:string;accepted:boolean} | {v:1;type:'request.response';requestId:string;result?:unknown;error?:string};
export type MemberOutput = ({memberId?:string;generation?:number;attemptId?:string;protocol?:2} & (
  | {v:1|2;type:'ready';sessionId:string;sessionFile?:string}
  | {v:1|2;type:'started';entryId:string;promptDigest:string;snapshotDigest?:string}
  | {v:1|2;type:'event';event:unknown}
  | {v:1|2;type:'settled';summary:string;sessionId?:string;sessionFile?:string}
  | {v:1|2;type:'failed';error:string}
  | {v:1|2;type:'processed';messageId:string}
  | {v:1|2;type:'received';messageId:string}
  | {v:1|2;type:'context';messageId:string;nativeEntryId:string}
  | {v:1|2;type:'usage';entryId:string;tokens?:number}
  | {v:1|2;type:'native.check';entryId:string;operationId:string}
  | {v:1|2;type:'request';requestId:string;action:'expert.validate'|'lease.check'|'handoff.read'|'send'|'shared.read'|'shared.write'|'expert.adopt'|'expert.confirm';input:Record<string,unknown>}
  | {v:1|2;type:'expert.adopted';adoption:unknown;toolScope?:string[]}
  | {v:1|2;type:'confirm';requestId:string;title:string;message:string}));
export interface MemberHandle { send(message: MemberInput): void; stop(): void|Promise<StopObject>;pid?:number;groupOwned?:boolean;closed?:Promise<StopObject> }
export type MemberLauncher = (start: MemberStart, output: (message: MemberOutput) => void, exited: (code: number|null) => void) => MemberHandle;

export type Risk='low'|'medium'|'high';
export type ArtifactKind='answer'|'file'|'git'|'external';
export type VerificationLevel='V0'|'V1'|'V2';
export interface ResourceScope {kind:'path'|'external';key:string;access:'read'|'write'}
export interface CheckSpec {id:string;kind:'file.exists'|'file.hash'|'json.schema'|'csv.contract'|'source.coverage'|'command';target?:string;args?:Record<string,unknown>;command?:string;argv?:string[]}
export interface ArtifactSpec {id:string;kind:ArtifactKind;target:string;required:boolean;taskId?:string;schema?:Record<string,unknown>;sources?:SourceRef[]}
export interface TaskContract {version:number;goal:string;risk:Risk;artifacts:ArtifactSpec[];checks:CheckSpec[];verification:VerificationLevel;resources:ResourceScope[];permissionDigest:string;acceptance:string[];forbiddenEffects:string[]}
export interface BudgetSnapshot {budgetId:string;parentBudgetId?:string;tokenLimit?:number;tokenUsed:number;tokenReserved:number;tokenUnknown:boolean;maxWorkers:number;parentMaxWorkers?:number;maxTasks:64;maxRepairRounds:2;deadline?:string}
export interface FrozenExecution {executionPolicy?:ExecutionPolicy;resolvedExpert?:import('@friend-pi/core').ResolvedExpertSpawn;schemaVersion:3;graphRevision:number;contractDigest:string;modelId?:string;thinkingLevel?:string;agentDir:string;parentTools:string[];writeScopes:string[];permissionDigest:string;executionRoleRef?:{id:string;version:number;hash:string};memoryRefs:CapabilityDependency[];expertRefs:CapabilityDependency[];skillRefs:{id:string;version:number;hash:string}[];adoptionRefs:unknown[];dependencyEpoch:number;budget?:BudgetSnapshot}
export interface ArtifactVersion {graphId:string;artifactId:string;revision:number;digest:string;mediaType:string;taskId:string;attemptId:string;sourceRefs:SourceRef[];artifactRefs?:ArtifactRef[];operationReceiptIds?:string[];stagingPath?:string;target?:string;targetBaseline?:string;commit?:string;appliedOperationId?:string;stale?:boolean}
export interface ExternalOperation {resourceReservationId?:string;id:string;graphId:string;taskId:string;attemptId:string;connector:string;target:string;action:string;payloadDigest:string;payload?:Record<string,unknown>;idempotencyKey?:string;expectedTargetVersion?:string;authorizationId:string;status:'prepared'|'dispatched'|'confirmed'|'rejected'|'unknown';externalId?:string;resultDigest?:string;reconciliation?:EvidenceReceipt;error?:string;revision:number}
export interface VerificationRecord {id:string;graphId:string;level:VerificationLevel;status:'pending'|'checking'|'reviewing'|'verifying'|'passed'|'failed'|'stale';candidateDigest:string;contractDigest:string;findings?:string;modelJudged?:boolean;checks:CheckResult[];reviewer?:Review;verifier?:Review;at:string}
