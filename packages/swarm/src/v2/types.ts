/**
 * Swarm coordination v2 — shared contracts.
 *
 * The v2 plane is additive: existing DAG/team workflows keep their storage and
 * behaviour, while v2 adds an append-only journal plus materialized current-state
 * tables for the blueprint's tasks/attempts/verdicts/budget/message model.
 */
export type SwarmV2Mode = 'read' | 'write';
export type SwarmV2Risk = 'V0' | 'V1' | 'V2' | 'V3';
export type SwarmV2TeamStatus = 'created' | 'running' | 'paused' | 'stopping' | 'stopped' | 'completed';
export type SwarmV2MemberRole = 'lead' | 'worker' | 'reviewer' | 'verifier' | 'external' | 'observer';
export type SwarmV2MemberPhase = 'provisioning' | 'active' | 'failed' | 'stopped';
export type SwarmV2MemberStatus = 'running' | 'idle' | 'suspect' | 'unknown' | 'stopped';
export type SwarmV2TaskStatus =
  | 'ready' | 'claimed' | 'in_progress' | 'delivered' | 'verified' | 'done'
  | 'blocked' | 'returned' | 'cancelled' | 'deleted';
export type SwarmV2AttemptStatus = 'prepared' | 'running' | 'unknown' | 'completed' | 'failed';
export type SwarmV2AttemptTerminal =
  | 'completed' | 'failed' | 'unknown' | 'interrupted' | 'budget_exhausted';
export type SwarmV2BudgetScope = 'team' | 'task' | 'member';
export type SwarmV2BudgetEntryState = 'reserved' | 'settled' | 'released' | 'unknown';
export type SwarmV2MessageMode = 'queue' | 'trigger';
export type SwarmV2MessageState = 'accepted' | 'queued' | 'delivered' | 'incorporated' | 'expired';
export type SwarmV2VerificationStatus = 'pending' | 'checking' | 'reviewing' | 'passed' | 'failed' | 'stale';
export type SwarmV2VerdictKind = 'reviewer' | 'verifier';
export type SwarmV2Binding = 'exact-tip' | 'clean-rebase-waived' | 'stale-tip';
export type SwarmV2WorkspaceKind = 'worktree' | 'staging' | 'readonly' | 'shared';

export interface SwarmV2Actor {kind: 'lead' | 'member' | 'human' | 'system'; id: string; generation?: number}
export interface SwarmV2Aggregate {kind: string; id: string; revision?: number}
export interface SwarmV2JournalEvent {
  eventId: string;
  seq: number;
  type: string;
  actor: SwarmV2Actor;
  aggregate: SwarmV2Aggregate;
  at: string;
  payloadDigest: string;
  data: Record<string, unknown>;
}

export interface SwarmV2Team {
  teamId: string;
  projectId: string;
  rootSessionId: string;
  workspaceRoot: string;
  status: SwarmV2TeamStatus;
  autonomyLevel: number;
  policy: Record<string, unknown>;
  revision: number;
  reworkRound: number;
  failureFingerprints: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SwarmV2Member {
  memberId: string;
  teamId: string;
  memberPath: string;
  name: string;
  role: SwarmV2MemberRole;
  contextMode: 'fresh' | 'fork' | 'seed';
  modelRef: string | null;
  generation: number;
  phase: SwarmV2MemberPhase;
  status: SwarmV2MemberStatus;
  sessionId: string | null;
  sessionFile: string | null;
  capability: Record<string, unknown>;
  writeScopes: string[];
  leaseExpiresAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface SwarmV2TaskDraft {
  title: string;
  description: string;
  mode: SwarmV2Mode;
  risk: SwarmV2Risk;
  dependencies?: string[];
  writeScopes?: string[];
  acceptance: string[];
  checksRef?: string | null;
  workspacePolicy?: SwarmV2WorkspaceKind;
  logicalStepId?: string;
}

export interface SwarmV2Task {
  taskId: string;
  teamId: string;
  revision: number;
  title: string;
  description: string;
  mode: SwarmV2Mode;
  risk: SwarmV2Risk;
  status: SwarmV2TaskStatus;
  ownerMemberId: string | null;
  currentAttemptId: string | null;
  logicalStepId: string;
  resultRevision: number;
  resultArtifactIds: string[];
  reworkCount: number;
  requirementVersion: number;
  acceptance: string[];
  checksRef: string | null;
  workspacePolicy: SwarmV2WorkspaceKind;
  dependencies: string[];
  writeScopes: string[];
  blockedReason: SwarmV2BlockedReason | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  tombstone: boolean;
}

export type SwarmV2BlockedKind = 'dependency' | 'budget' | 'resource' | 'unknown' | 'policy' | 'human';
export interface SwarmV2BlockedReason {kind: SwarmV2BlockedKind; cause: string; by?: string}

export interface SwarmV2Attempt {
  attemptId: string;
  taskId: string;
  number: number;
  status: SwarmV2AttemptStatus;
  memberId: string | null;
  generation: number;
  workspaceId: string | null;
  baseRev: string | null;
  depsDigest: string | null;
  requirementVersion: number;
  budgetReservationId: string | null;
  startedAt: string;
  finishedAt: string | null;
  terminalReason: SwarmV2AttemptTerminal | null;
  summary: string | null;
  sessionId: string | null;
  sessionFile: string | null;
  commitSha: string | null;
  resultDigest: string | null;
  candidateTip: string | null;
  evidenceRefs: string[];
}

export interface SwarmV2Budget {
  budgetId: string;
  teamId: string;
  scope: SwarmV2BudgetScope;
  scopeId: string;
  tokenLimit: number | null;
  tokenUsed: number;
  tokenReserved: number;
  costLimitMicros: number | null;
  costUsed: number;
  timeLimitMs: number | null;
  timeUsedMs: number;
  concurrencyLimit: number | null;
  unknown: boolean;
  paused: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface SwarmV2BudgetEntry {
  reservationId: string;
  budgetId: string;
  attemptId: string;
  upperBoundTokens: number;
  upperBoundCostMicros: number;
  state: SwarmV2BudgetEntryState;
  tokens: number | null;
  costMicros: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface SwarmV2Message {
  messageId: string;
  teamId: string;
  senderKind: string;
  senderId: string | null;
  senderGeneration: number | null;
  targetKind: string;
  targetId: string;
  type: string;
  deliveryMode: SwarmV2MessageMode;
  sequence: number;
  bodyDigest: string;
  bodyLength: number;
  body: string;
  provenance: Record<string, unknown>;
  state: SwarmV2MessageState;
  acceptedAt: string;
  queuedAt: string | null;
  deliveredAt: string | null;
  incorporatedAt: string | null;
  nativeEntryId: string | null;
  attemptId: string | null;
  generation: number | null;
  expiresAt: string | null;
}

export interface SwarmV2Verdict {
  verdictId: string;
  verificationId: string;
  teamId: string;
  taskId: string;
  kind: SwarmV2VerdictKind;
  approved: boolean;
  findings: string[];
  taskIds: string[];
  resultVersions: Record<string, number>;
  candidateDigest: string;
  reviewedTip: string;
  binding: SwarmV2Binding;
  reviewerMemberId: string;
  sessionId: string | null;
  sessionFile: string | null;
  sealed: boolean;
  createdAt: string;
}

export interface SwarmV2Verification {
  verificationId: string;
  teamId: string;
  taskId: string;
  attemptId: string | null;
  candidateDigest: string;
  contractDigest: string;
  level: SwarmV2Risk;
  status: SwarmV2VerificationStatus;
  checks: SwarmV2CheckResult[];
  findings: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SwarmV2CheckResult {
  checkId: string;
  kind: string;
  passed: boolean;
  exitCode?: number;
  detail?: string;
  evidenceRef?: string;
}

export interface SwarmV2MergeGate {code: string; passed: boolean; detail: string}
export interface SwarmV2MergeDecision {
  allowed: boolean;
  gates: SwarmV2MergeGate[];
  failed: SwarmV2MergeGate[];
  candidateDigest: string;
  verdictId: string | null;
}
export interface SwarmV2ApplyReceipt {
  taskId: string;
  operationId: string;
  status: 'applied' | 'rejected' | 'unknown';
  files: {path: string; digest: string; state: string}[];
  candidateDigest: string;
  verdictId: string | null;
  baselineDigest: string | null;
  at: string;
}

export interface SwarmV2StopObject {id: string; kind: string; status: 'terminated' | 'unknown'}
export interface SwarmV2StopReceipt {
  receiptId: string;
  teamId: string;
  scopeKind: string;
  scopeId: string;
  objects: SwarmV2StopObject[];
  status: 'complete' | 'unknown';
  createdAt: string;
}

export interface SwarmV2ReworkReceipt {
  taskIds: string[];
  affected: string[];
  reason: string;
  fingerprint: string;
  reworkRound: number;
  created: string[];
}

export interface SwarmV2StateSummary {
  schemaVersion: number;
  teams: number;
  members: number;
  tasks: Record<SwarmV2TaskStatus, number>;
  attempts: Record<SwarmV2AttemptStatus, number>;
  messages: Record<SwarmV2MessageState, number>;
  budgets: number;
  verifications: number;
  verdicts: number;
  journalEvents: number;
  silentMerge: number;
  baselineDigest: string;
}

export const TASK_STATUSES: SwarmV2TaskStatus[] = ['ready', 'claimed', 'in_progress', 'delivered', 'verified', 'done', 'blocked', 'returned', 'cancelled', 'deleted'];
export const ATTEMPT_STATUSES: SwarmV2AttemptStatus[] = ['prepared', 'running', 'unknown', 'completed', 'failed'];
export const MESSAGE_STATES: SwarmV2MessageState[] = ['accepted', 'queued', 'delivered', 'incorporated', 'expired'];

/** Allowed task transitions (8-state machine + tombstones). Unknown actions are rejected. */
export const TASK_TRANSITIONS: Record<SwarmV2TaskStatus, Partial<Record<string, SwarmV2TaskStatus>>> = {
  ready: {claim: 'claimed', block: 'blocked', cancel: 'cancelled', delete: 'deleted'},
  claimed: {admit: 'in_progress', release: 'ready', block: 'blocked', cancel: 'cancelled'},
  in_progress: {deliver: 'delivered', block: 'blocked', cancel: 'cancelled'},
  delivered: {verify: 'verified', return: 'returned', block: 'blocked'},
  verified: {complete: 'done', return: 'returned', block: 'blocked'},
  done: {},
  blocked: {unblock: 'ready', cancel: 'cancelled', delete: 'deleted'},
  returned: {retry: 'ready'},
  cancelled: {},
  deleted: {},
};

export const DEFAULT_MAX_TASKS = 256;
export const DEFAULT_MAX_WORKERS = 4;
export const MAX_WORKERS = 16;
export const DEFAULT_MAX_REPAIR_ROUNDS = 2;
export const MAX_TASK_REWORK = 2;
export const MAX_GRAPH_REWORK = 2;
export const ROLE_CAPABILITIES: Record<SwarmV2MemberRole, string[]> = {
  lead: ['create', 'delegate', 'review', 'integrate', 'budget', 'stop', 'message'],
  worker: ['claim', 'deliver', 'message'],
  reviewer: ['review', 'read'],
  verifier: ['verify', 'read'],
  external: ['read'],
  observer: ['read'],
};
