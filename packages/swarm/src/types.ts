import type {PermissionMode} from '@friend-pi/core';
export type GraphStatus = 'created'|'running'|'stopping'|'paused'|'completed'|'awaiting_review'|'ready'|'integrated'|'failed'|'stopped';
export type TaskStatus = 'pending'|'running'|'completed'|'skipped'|'unknown'|'blocked'|'cancelled';
export interface Check { command: string; args: string[] }
export interface Task {
  memberId?: string; memberName?: string; resumeFromAttempt?:string;
  id: string; title: string; prompt: string; dependencies: string[]; mode: 'read'|'write';
  expertId?: string; writeScopes: string[]; status: TaskStatus; currentAttempt?: string;
  modelId?:string;thinkingLevel?:string;roleId?:string;logicalStepId?:string;workflowHeld?:boolean;
  rework: number; resultRevision: number;
  originalPrompt?:string; requirementVersions?:{version:number;prompt:string;reason?:string;at:string}[];
}
export interface Attempt {
  memberId?: string; generation?: number; retainedFrom?:string;
  id: string; taskId: string; number: number; resultRevision: number; status: 'running'|'completed'|'failed'|'unknown';
  cwd: string; mode: 'read'|'write'; ownerPid: number; ownerRuntime: string; startedAt: string; finishedAt?: string;
  modelId?: string; thinkingLevel?: string; expert?: unknown; writeScopes: string[];
  sessionId?: string; sessionFile?: string; summary?: string; commit?: string; error?: string;
  requirementVersion?:number; expertAdoptions?:unknown[];
}
export interface Baseline { repoRoot: string; projectRelative: string; head: string; branch?: string }
export interface Review { attemptId: string; approved: boolean; findings: string; at: string; sessionId?: string; sessionFile?: string;taskIds?:string[];resultVersions?:Record<string,number> }
export interface ReviewAttempt {attemptId:string;cwd:string;status:'running'|'completed'|'failed'|'unknown';startedAt:string;finishedAt?:string;sessionId?:string;sessionFile?:string;error?:string}
export interface CheckResult { command: string; args: string[]; exitCode: number|null; output: string; at: string;cancelled?:boolean;operationId?:string }
export interface StopObject {id:string;kind:'member'|'check'|'git'|'activity';status:'terminated'|'unknown';pid?:number;exitCode?:number|null;signal?:string|null;detail?:string}
export interface StopReceipt {operationId:string;requestedAt:string;finishedAt:string;objects:StopObject[];unknownAttemptIds:string[]}
export interface Graph {
  collaborationVersion?: 2;
  id: string; projectId: string; sessionId: string; projectDir: string; goal: string; status: GraphStatus;
  createdAt: string; updatedAt: string; tasks: Task[]; attempts: Attempt[]; maxWorkers: number; reworkRound: number;
  modelId?: string; thinkingLevel?: string; agentDir?: string; checks: Check[]; baseline?: Baseline;
  integration?: {cwd: string; head?: string; checks: CheckResult[]; review?: Review}; error?: string;
  stopReceipt?:StopReceipt;expertCatalog?:unknown;expertUnavailable?:boolean;runId?:string;
  executionOwner?:{pid:number;runtime:string};
  executionStyle?:'team'|'swarm';workflowId?:string;deferPreparation?:boolean;integratedTaskIds?:string[];parentTools?:string[];permissionMode?:PermissionMode;temporaryWriteRoot?:string;goalId?:string;audit?:boolean;auditEvidence?:unknown;
  reviews?:Review[];reviewAttempts?:ReviewAttempt[];
}
export interface MemberMessage {id: string; graphId: string; from: string; to: string; body: string; createdAt: string; deliveredAt?: string; processedAt?: string; attemptId?: string; memberId?:string; sequence?:number; receivedAt?:string; nativeEntryId?:string; bodyDigest?:string; generation?:number; senderMemberId?:string; kind?:'constraint'|'discussion'}
export interface Teammate {
  id:string; projectId:string; rootSessionId:string; name:string; description:string; key?:string;
  state:'idle'|'running'|'stopping'|'paused'|'failed'; generation:number; nextSequence:number;
  createdAt:string; updatedAt:string; graphId?:string; taskId?:string; attemptId?:string;
  sessionId?:string; sessionFile?:string; cwd?:string; modelId?:string; thinkingLevel?:string;
  ownerPid?:number; ownerRuntime?:string; discussion?:boolean; reason?:string; stopReceipt?:StopObject;
}
export interface SharedDocument { graphId: string; name: string; content: string; file: string; version: number; digest: string; updatedAt: string;origin?:{taskId?:string;attemptId?:string;operationId?:string};merged?:boolean;mergeSources?:{revision:number;digest:string}[] }
export interface SharedConflict {id:string;graphId:string;name:string;status:'pending'|'resolved'|'paused'|'cancelled';base?:SharedDocument;latest?:SharedDocument;proposed:string;proposedDigest:string;origin?:SharedDocument['origin'];reason?:string;createdAt:string;resolvedRevision?:number;ownerPid?:number}
export interface MemberStart {
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
  | {v:1|2;type:'event';event:unknown}
  | {v:1|2;type:'settled';summary:string;sessionId?:string;sessionFile?:string}
  | {v:1|2;type:'failed';error:string}
  | {v:1|2;type:'processed';messageId:string}
  | {v:1|2;type:'received';messageId:string}
  | {v:1|2;type:'context';messageId:string;nativeEntryId:string}
  | {v:1|2;type:'usage';entryId:string;tokens?:number}
  | {v:1|2;type:'request';requestId:string;action:'send'|'shared.read'|'shared.write'|'expert.adopt';input:Record<string,unknown>}
  | {v:1|2;type:'expert.adopted';adoption:unknown;toolScope?:string[]}
  | {v:1|2;type:'confirm';requestId:string;title:string;message:string}));
export interface MemberHandle { send(message: MemberInput): void; stop(): void|Promise<StopObject>;pid?:number;groupOwned?:boolean;closed?:Promise<StopObject> }
export type MemberLauncher = (start: MemberStart, output: (message: MemberOutput) => void, exited: (code: number|null) => void) => MemberHandle;
