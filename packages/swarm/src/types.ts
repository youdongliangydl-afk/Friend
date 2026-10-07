export type GraphStatus = 'created'|'running'|'paused'|'awaiting_review'|'ready'|'integrated'|'failed'|'stopped';
export type TaskStatus = 'pending'|'running'|'completed'|'unknown'|'blocked'|'cancelled';
export interface Check { command: string; args: string[] }
export interface Task {
  id: string; title: string; prompt: string; dependencies: string[]; mode: 'read'|'write';
  expertId?: string; writeScopes: string[]; status: TaskStatus; currentAttempt?: string;
  rework: number; resultRevision: number;
}
export interface Attempt {
  id: string; taskId: string; number: number; resultRevision: number; status: 'running'|'completed'|'failed'|'unknown';
  cwd: string; mode: 'read'|'write'; ownerPid: number; ownerRuntime: string; startedAt: string; finishedAt?: string;
  modelId?: string; thinkingLevel?: string; expert?: unknown; writeScopes: string[];
  sessionId?: string; sessionFile?: string; summary?: string; commit?: string; error?: string;
}
export interface Baseline { repoRoot: string; projectRelative: string; head: string; branch?: string }
export interface Review { attemptId: string; approved: boolean; findings: string; at: string }
export interface CheckResult { command: string; args: string[]; exitCode: number|null; output: string; at: string }
export interface Graph {
  id: string; projectId: string; sessionId: string; projectDir: string; goal: string; status: GraphStatus;
  createdAt: string; updatedAt: string; tasks: Task[]; attempts: Attempt[]; maxWorkers: number; reworkRound: number;
  modelId?: string; thinkingLevel?: string; agentDir?: string; checks: Check[]; baseline?: Baseline;
  integration?: {cwd: string; head?: string; checks: CheckResult[]; review?: Review}; error?: string;
}
export interface MemberMessage {id: string; graphId: string; from: string; to: string; body: string; createdAt: string; deliveredAt?: string; processedAt?: string; attemptId?: string}
export interface SharedDocument { graphId: string; name: string; content: string; file: string; version: number; digest: string; updatedAt: string }
export interface MemberStart {
  v: 1; type: 'start'; graphId: string; taskId: string; attemptId: string; cwd: string; dataDir: string;
  agentDir: string; sessionDir: string; modelId?: string; thinkingLevel?: string; prompt: string;
  expert?: unknown; mode: 'read'|'write'; writeScopes: string[];
}
export type MemberInput = MemberStart | {v:1;type:'steer';messageId:string;text:string} | {v:1;type:'stop'} | {v:1;type:'confirm.response';requestId:string;accepted:boolean} | {v:1;type:'request.response';requestId:string;result?:unknown;error?:string};
export type MemberOutput =
  | {v:1;type:'ready';sessionId:string;sessionFile?:string}
  | {v:1;type:'event';event:unknown}
  | {v:1;type:'settled';summary:string;sessionId?:string;sessionFile?:string}
  | {v:1;type:'failed';error:string}
  | {v:1;type:'processed';messageId:string}
  | {v:1;type:'request';requestId:string;action:'send'|'shared.read'|'shared.write';input:Record<string,unknown>}
  | {v:1;type:'confirm';requestId:string;title:string;message:string};
export interface MemberHandle { send(message: MemberInput): void; stop(): void }
export type MemberLauncher = (start: MemberStart, output: (message: MemberOutput) => void, exited: (code: number|null) => void) => MemberHandle;
