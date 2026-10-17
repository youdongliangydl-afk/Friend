/**
 * Swarm coordination v2 — member roster (P0-SPEC §2E).
 *
 * Lifecycle: provisioning -> active -> stopped, or provisioning -> failed.
 * A member row is never deleted: names and member paths stay reserved for the
 * whole team (including failed/stopped members) so a late native write can
 * never be attributed to a recycled identity.
 *
 * Every mutation is one transaction: current-state row + append-only journal.
 * Late writes are fenced by `assertGeneration` (code STALE_GENERATION).
 */
import {randomUUID} from 'node:crypto';
import {CapabilityError,ConflictError,type RecordStore} from '@friend-pi/core';
import {V2Store,arrayText,intOrNull,obj,optionalText,text,v2Now} from './store.js';
import {
  ROLE_CAPABILITIES,
  type SwarmV2Member,
  type SwarmV2MemberPhase,
  type SwarmV2MemberRole,
  type SwarmV2MemberStatus,
  type SwarmV2StopObject,
  type SwarmV2StopReceipt,
} from './types.js';

const SYSTEM_ACTOR = {kind: 'system' as const, id: 'swarm-v2-roster'};
const ROLES = new Set<string>(Object.keys(ROLE_CAPABILITIES));
const CONTEXT_MODES = new Set(['fresh', 'fork', 'seed']);
const MEMBER_STATUSES = new Set<SwarmV2MemberStatus>(['running', 'idle', 'suspect', 'unknown', 'stopped']);
/** Provisioned once and immutable afterwards; updates must not rewrite identity. */
export const IMMUTABLE_MEMBER_FIELDS = ['name', 'role', 'modelRef', 'contextMode', 'memberPath', 'generation'] as const;
const MUTABLE_MEMBER_FIELDS = new Set(['writeScopes', 'leaseExpiresAt', 'sessionId', 'sessionFile']);

export interface ProvisionMemberInput {
  teamId: string;
  name: string;
  role: SwarmV2MemberRole | string;
  contextMode?: 'fresh' | 'fork' | 'seed' | string;
  modelRef?: string | null;
  /** Free-form capability metadata (object), or a bounded string list folded into `{capabilities: [...]}`. */
  capabilities?: unknown;
  writeScopes?: unknown;
  memberPath?: string | null;
}

export interface AdmitMemberInput {
  firstEntryId: string;
  /** I3: a member may only become active after its first native entry is durable. */
  firstEntryPersisted: boolean;
  /** Optional new incarnation generation; defaults to the provisioned generation (0). */
  generation?: number;
}

export interface UpdateMemberPatch {
  writeScopes?: unknown;
  leaseExpiresAt?: string | null;
  sessionId?: string | null;
  sessionFile?: string | null;
}

/**
 * Late-write fence error. Runtime `code` is the stable 'STALE_GENERATION' token
 * required by the v2 contract while still being a CapabilityError, so callers
 * that normalize capability errors keep their details.
 */
export class StaleGenerationError extends CapabilityError {
  constructor(readonly memberId: string, readonly expectedGeneration: number, readonly actualGeneration: number) {
    super('PERMISSION_DENIED', `STALE_GENERATION：成员 ${memberId} 的 generation 已过期（写入期望 ${expectedGeneration}，当前 ${actualGeneration}）`, {
      code: 'STALE_GENERATION', memberId, expectedGeneration, actualGeneration,
    });
    Object.defineProperty(this, 'code', {value: 'STALE_GENERATION', enumerable: true, configurable: true, writable: false});
    this.name = 'StaleGenerationError';
  }
}

type Row = Record<string, unknown>;

function toMember(row: Row): SwarmV2Member {
  return {
    memberId: String(row.member_id),
    teamId: String(row.team_id),
    memberPath: String(row.member_path),
    name: String(row.name),
    role: String(row.role) as SwarmV2MemberRole,
    contextMode: String(row.context_mode) as SwarmV2Member['contextMode'],
    modelRef: row.model_ref === null || row.model_ref === undefined ? null : String(row.model_ref),
    generation: Number(row.generation),
    phase: String(row.phase) as SwarmV2MemberPhase,
    status: String(row.status) as SwarmV2MemberStatus,
    sessionId: row.session_id === null || row.session_id === undefined ? null : String(row.session_id),
    sessionFile: row.session_file === null || row.session_file === undefined ? null : String(row.session_file),
    capability: JSON.parse(String(row.capability_json)) as Record<string, unknown>,
    writeScopes: JSON.parse(String(row.write_scopes_json)) as string[],
    leaseExpiresAt: row.lease_expires_at === null || row.lease_expires_at === undefined ? null : String(row.lease_expires_at),
    revision: Number(row.revision),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function memberRow(v2: V2Store, memberId: string): Row | undefined {
  return v2.row<Row>('SELECT * FROM swarm_v2_members WHERE member_id=?', memberId);
}

function requireMemberRow(v2: V2Store, memberId: string): Row {
  const row = memberRow(v2, memberId);
  if (!row) throw new CapabilityError('VALIDATION_ERROR', `成员不存在：${memberId}`);
  return row;
}

function requireTeam(v2: V2Store, teamId: string): void {
  if (!v2.row<{team_id: string}>('SELECT team_id FROM swarm_v2_teams WHERE team_id=?', teamId)) {
    throw new CapabilityError('VALIDATION_ERROR', `团队不存在：${teamId}`);
  }
}

function capabilityOf(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (Array.isArray(input)) return {capabilities: arrayText(input, 'capabilities', 32, 100)};
  const value = obj(input);
  if (JSON.stringify(value).length > 8192) throw new CapabilityError('VALIDATION_ERROR', 'capabilities 过大');
  return value;
}

function timeOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new CapabilityError('VALIDATION_ERROR', `${field} 必须是有效时间`);
  return new Date(value).toISOString();
}

function stopObjects(value: unknown): SwarmV2StopObject[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw new CapabilityError('VALIDATION_ERROR', '停止对象必须是非空有界数组');
  const seen = new Set<string>();
  return value.map(raw => {
    const item = obj(raw);
    const id = text(item.id, '停止对象 id', 200);
    if (seen.has(id)) throw new CapabilityError('VALIDATION_ERROR', `停止对象重复：${id}`);
    seen.add(id);
    const kind = text(item.kind, '停止对象 kind', 50);
    if (item.status !== 'terminated' && item.status !== 'unknown') throw new CapabilityError('VALIDATION_ERROR', '停止对象状态必须是 terminated 或 unknown');
    return {id, kind, status: item.status};
  });
}

/** Create one provisioning member. Name and memberPath are team-wide permanent reservations. */
export function provisionMember(store: RecordStore, input: ProvisionMemberInput): SwarmV2Member {
  const v2 = V2Store.open(store);
  const teamId = text(input?.teamId, 'teamId', 200);
  const name = text(input?.name, 'name', 120);
  const role = String(input?.role ?? '');
  if (!ROLES.has(role)) throw new CapabilityError('VALIDATION_ERROR', `成员角色无效：${role || '(空)'}`);
  const contextMode = String(input?.contextMode ?? 'fresh');
  if (!CONTEXT_MODES.has(contextMode)) throw new CapabilityError('VALIDATION_ERROR', `contextMode 无效：${contextMode}`);
  const modelRef = optionalText(input?.modelRef, 'modelRef', 200);
  const memberPath = optionalText(input?.memberPath, 'memberPath', 300) ?? `members/${name}`;
  const writeScopes = arrayText(input?.writeScopes, 'writeScopes', 64, 500);
  const capability = capabilityOf(input?.capabilities);
  return v2.transaction(() => {
    requireTeam(v2, teamId);
    const clash = v2.row<{name: string; member_path: string}>('SELECT name,member_path FROM swarm_v2_members WHERE team_id=? AND (name=? OR member_path=?)', teamId, name, memberPath);
    if (clash) {
      throw new CapabilityError('VALIDATION_ERROR', String(clash.name) === name
        ? `成员名称已被占用（含 failed/stopped）：${name}`
        : `成员路径已被占用：${memberPath}`);
    }
    const memberId = randomUUID();
    const at = v2Now();
    v2.db.prepare('INSERT INTO swarm_v2_members(member_id,team_id,name,member_path,role,context_mode,model_ref,generation,phase,status,session_id,session_file,capability_json,write_scopes_json,lease_expires_at,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(memberId, teamId, name, memberPath, role, contextMode, modelRef, 0, 'provisioning', 'idle', null, null, JSON.stringify(capability), JSON.stringify(writeScopes), null, 1, at, at);
    v2.journal(teamId, 'member.provisioned', SYSTEM_ACTOR, {kind: 'member', id: memberId, revision: 1}, {
      memberId, name, memberPath, role, contextMode, generation: 0, modelRef,
    });
    return toMember(requireMemberRow(v2, memberId));
  });
}

/**
 * Provisioning -> active. I3: the first native journal entry must already be
 * persisted, otherwise admission is rejected and the member stays provisioning.
 */
export function admitMember(store: RecordStore, memberId: string, input: AdmitMemberInput): SwarmV2Member {
  const v2 = V2Store.open(store);
  const id = text(memberId, 'memberId', 200);
  const firstEntryId = text(input?.firstEntryId, 'firstEntryId', 200);
  if (input?.firstEntryPersisted !== true) {
    throw new CapabilityError('VALIDATION_ERROR', 'I3：firstEntryPersisted 必须为 true；首个原生条目未持久化时禁止激活成员');
  }
  const requestedGeneration = input.generation === undefined ? undefined : intOrNull(input.generation, 'generation', 0, Number.MAX_SAFE_INTEGER) ?? undefined;
  return v2.transaction(() => {
    const row = requireMemberRow(v2, id);
    const member = toMember(row);
    if (member.phase !== 'provisioning') throw new CapabilityError('VALIDATION_ERROR', `仅 provisioning 成员可激活（当前 ${member.phase}）`);
    const generation = requestedGeneration ?? member.generation;
    if (generation < member.generation) throw new CapabilityError('VALIDATION_ERROR', 'generation 不能回退');
    const at = v2Now();
    v2.db.prepare("UPDATE swarm_v2_members SET phase='active',status='idle',generation=?,revision=revision+1,updated_at=? WHERE member_id=?")
      .run(generation, at, id);
    v2.journal(member.teamId, 'member.admitted', SYSTEM_ACTOR, {kind: 'member', id, revision: member.revision + 1}, {
      memberId: id, firstEntryId, firstEntryPersisted: true, generation,
    });
    return toMember(requireMemberRow(v2, id));
  });
}

/** Provisioning -> failed. The name reservation survives; only provisioning members may fail. */
export function markMemberFailed(store: RecordStore, memberId: string, reason: string): SwarmV2Member {
  const v2 = V2Store.open(store);
  const id = text(memberId, 'memberId', 200);
  const failureReason = text(reason, 'reason', 1000);
  return v2.transaction(() => {
    const row = requireMemberRow(v2, id);
    const member = toMember(row);
    if (member.phase !== 'provisioning') throw new CapabilityError('VALIDATION_ERROR', `仅 provisioning 成员可标记失败（当前 ${member.phase}）`);
    const at = v2Now();
    v2.db.prepare("UPDATE swarm_v2_members SET phase='failed',revision=revision+1,updated_at=? WHERE member_id=?").run(at, id);
    v2.journal(member.teamId, 'member.failed', SYSTEM_ACTOR, {kind: 'member', id, revision: member.revision + 1}, {memberId: id, reason: failureReason});
    return toMember(requireMemberRow(v2, id));
  });
}

/**
 * Update only mutable runtime metadata. Identity fields (name/role/modelRef/
 * contextMode/memberPath/generation) are rejected so a member can never be
 * silently re-identified; CAS prevents lost updates.
 */
export function updateMember(store: RecordStore, memberId: string, expectedRevision: number, patch: UpdateMemberPatch): SwarmV2Member {
  const v2 = V2Store.open(store);
  const id = text(memberId, 'memberId', 200);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new CapabilityError('VALIDATION_ERROR', 'expectedRevision 无效');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new CapabilityError('VALIDATION_ERROR', '成员更新必须是对象');
  const keys = Object.keys(patch);
  if (!keys.length) throw new CapabilityError('VALIDATION_ERROR', '成员更新没有可更新字段');
  for (const key of keys) {
    if ((IMMUTABLE_MEMBER_FIELDS as readonly string[]).includes(key)) throw new CapabilityError('VALIDATION_ERROR', `成员字段 ${key} 不可变`);
    if (!MUTABLE_MEMBER_FIELDS.has(key)) throw new CapabilityError('VALIDATION_ERROR', `未知成员字段：${key}`);
  }
  if (patch.writeScopes !== undefined) arrayText(patch.writeScopes, 'writeScopes', 64, 500);
  if (patch.leaseExpiresAt !== undefined) timeOrNull(patch.leaseExpiresAt, 'leaseExpiresAt');
  if (patch.sessionId !== undefined) optionalText(patch.sessionId, 'sessionId', 200);
  if (patch.sessionFile !== undefined) optionalText(patch.sessionFile, 'sessionFile', 2000);
  return v2.transaction(() => {
    const row = requireMemberRow(v2, id);
    const member = toMember(row);
    if (member.revision !== expectedRevision) throw new ConflictError();
    const at = v2Now();
    v2.db.prepare('UPDATE swarm_v2_members SET write_scopes_json=?,lease_expires_at=?,session_id=?,session_file=?,revision=revision+1,updated_at=? WHERE member_id=?')
      .run(
        patch.writeScopes === undefined ? JSON.stringify(member.writeScopes) : JSON.stringify(arrayText(patch.writeScopes, 'writeScopes', 64, 500)),
        patch.leaseExpiresAt === undefined ? member.leaseExpiresAt : timeOrNull(patch.leaseExpiresAt, 'leaseExpiresAt'),
        patch.sessionId === undefined ? member.sessionId : optionalText(patch.sessionId, 'sessionId', 200),
        patch.sessionFile === undefined ? member.sessionFile : optionalText(patch.sessionFile, 'sessionFile', 2000),
        at,
        id,
      );
    v2.journal(member.teamId, 'member.updated', SYSTEM_ACTOR, {kind: 'member', id, revision: member.revision + 1}, {memberId: id, fields: keys.filter(key => key !== 'memberId')});
    return toMember(requireMemberRow(v2, id));
  });
}

/**
 * Stop one member with a per-object receipt. `complete` requires every object to
 * be terminated; any `unknown` object keeps the member's status unknown and
 * pauses the whole team (no automatic retry without an operator decision).
 */
export function stopMember(store: RecordStore, memberId: string, objects: SwarmV2StopObject[]): SwarmV2StopReceipt {
  const v2 = V2Store.open(store);
  const id = text(memberId, 'memberId', 200);
  const parsed = stopObjects(objects);
  return v2.transaction(() => {
    const row = requireMemberRow(v2, id);
    const member = toMember(row);
    if (member.phase === 'stopped') throw new CapabilityError('VALIDATION_ERROR', '成员已停止，不能重复停止');
    const allTerminated = parsed.every(item => item.status === 'terminated');
    const status: SwarmV2StopReceipt['status'] = allTerminated ? 'complete' : 'unknown';
    const at = v2Now();
    const receiptId = randomUUID();
    const nextPhase: SwarmV2MemberPhase = allTerminated ? 'stopped' : member.phase;
    const nextStatus: SwarmV2MemberStatus = allTerminated ? 'stopped' : 'unknown';
    v2.db.prepare('UPDATE swarm_v2_members SET phase=?,status=?,revision=revision+1,updated_at=? WHERE member_id=?')
      .run(nextPhase, nextStatus, at, id);
    if (!allTerminated) {
      const team = v2.row<{status: string; revision: number}>('SELECT status,revision FROM swarm_v2_teams WHERE team_id=?', member.teamId);
      if (team) v2.db.prepare("UPDATE swarm_v2_teams SET status='paused',revision=revision+1,updated_at=? WHERE team_id=?").run(at, member.teamId);
    }
    v2.db.prepare('INSERT INTO swarm_v2_stop_receipts VALUES(?,?,?,?,?,?,?)')
      .run(receiptId, member.teamId, 'member', member.memberId, JSON.stringify(parsed), status, at);
    v2.journal(member.teamId, allTerminated ? 'member.stopped' : 'member.stop_unknown', SYSTEM_ACTOR, {kind: 'member', id, revision: member.revision + 1}, {
      receiptId, memberId: member.memberId, status, objects: parsed, teamPaused: !allTerminated,
    });
    return {receiptId, teamId: member.teamId, scopeKind: 'member', scopeId: member.memberId, objects: parsed, status, createdAt: at};
  });
}

/** Fence a late write against the member's current incarnation generation. */
export function assertGeneration(store: RecordStore, memberId: string, generation: number): SwarmV2Member {
  const v2 = V2Store.open(store);
  const id = text(memberId, 'memberId', 200);
  if (!Number.isSafeInteger(generation) || generation < 0) throw new CapabilityError('VALIDATION_ERROR', 'generation 无效');
  const member = toMember(requireMemberRow(v2, id));
  if (member.generation !== generation) throw new StaleGenerationError(id, generation, member.generation);
  return member;
}

export function getMember(store: RecordStore, memberId: string): SwarmV2Member | undefined {
  const v2 = V2Store.open(store);
  const row = memberRow(v2, text(memberId, 'memberId', 200));
  return row ? toMember(row) : undefined;
}

export function listMembers(store: RecordStore, teamId: string): SwarmV2Member[] {
  const v2 = V2Store.open(store);
  return v2.rows<Row>('SELECT * FROM swarm_v2_members WHERE team_id=? ORDER BY created_at,rowid', text(teamId, 'teamId', 200)).map(toMember);
}

/** Exported for service/tests that need the status vocabulary without importing types.ts directly. */
export const ROSTER_MEMBER_STATUSES: readonly SwarmV2MemberStatus[] = [...MEMBER_STATUSES];
