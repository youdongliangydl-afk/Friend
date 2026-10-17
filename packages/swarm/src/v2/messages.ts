/**
 * Swarm coordination v2 — message envelopes (P0-SPEC §2E).
 *
 * Four durable states: accepted -> queued -> delivered -> incorporated, plus a
 * terminal `expired`. Every transition is transactional, journalled, and
 * strictly ordered: no deliver before queue, no incorporate before deliver, and
 * per-target sequences are monotonic and unique.
 *
 * Idempotency: a replayed messageId with the same body/envelope digest returns
 * the stored message; the same messageId with any different payload is a
 * VERSION_CONFLICT and never creates a second row.
 *
 * FIFO: `deliverMessage` refuses to move a message past an earlier envelope for
 * the same (team, target) that is still accepted/queued, so delivery order can
 * never invert sequence order. Cursor pagination (`afterSequence > 0`) and
 * cursor waits require an explicit `targetId` because sequences are per-target.
 */
import {randomUUID} from 'node:crypto';
import {CapabilityError,ConflictError,digest,type RecordStore} from '@friend-pi/core';
import {V2Store,intOrNull,obj,optionalText,text,v2Now} from './store.js';
import {MESSAGE_STATES,type SwarmV2Message,type SwarmV2MessageMode,type SwarmV2MessageState} from './types.js';

export const MAX_MESSAGE_BODY = 16384;
export const MAX_MESSAGE_PROVENANCE = 8192;
export const MESSAGE_WAIT_MIN_TIMEOUT_MS = 10_000;
export const MESSAGE_WAIT_MAX_TIMEOUT_MS = 3_600_000;
export const MESSAGE_WAIT_MAX_POLL_MS = 100;

const SYSTEM_ACTOR = {kind: 'system' as const, id: 'swarm-v2-messages'};
const ACTOR_KINDS = new Set(['lead', 'member', 'human', 'system']);
const DELIVERY_MODES = new Set<SwarmV2MessageMode>(['queue', 'trigger']);

export interface MessageSender {
  kind: string;
  id?: string | null;
  generation?: number;
}

export interface SendMessageInput {
  teamId: string;
  messageId?: string | null;
  sender: MessageSender;
  targetId: string;
  targetKind?: string;
  type: string;
  deliveryMode: SwarmV2MessageMode | string;
  body: string;
  provenance?: unknown;
  expiresAt?: string | null;
}

export interface ListMessagesOptions {
  targetId?: string | null;
  afterSequence?: number;
  limit?: number;
}

export interface WaitMessagesInput {
  /**
   * Optional target scope. Required when `afterSequence > 0`: per-target
   * sequences make a targetless cursor ambiguous (and unsafe to paginate).
   */
  targetId?: string | null;
  afterSequence?: number;
  timeoutMs: number;
  pollMs?: number;
}

export interface WaitMessagesResult {
  messages: SwarmV2Message[];
  timedOut: boolean;
}

type Row = Record<string, unknown>;

function toMessage(row: Row): SwarmV2Message {
  return {
    messageId: String(row.message_id),
    teamId: String(row.team_id),
    senderKind: String(row.sender_kind),
    senderId: row.sender_id === null || row.sender_id === undefined ? null : String(row.sender_id),
    senderGeneration: row.sender_generation === null || row.sender_generation === undefined ? null : Number(row.sender_generation),
    targetKind: String(row.target_kind),
    targetId: String(row.target_id),
    type: String(row.type),
    deliveryMode: String(row.delivery_mode) as SwarmV2MessageMode,
    sequence: Number(row.sequence),
    bodyDigest: String(row.body_digest),
    bodyLength: Number(row.body_length),
    body: String(row.body),
    provenance: JSON.parse(String(row.provenance_json)) as Record<string, unknown>,
    state: String(row.state) as SwarmV2MessageState,
    acceptedAt: String(row.accepted_at),
    queuedAt: row.queued_at === null || row.queued_at === undefined ? null : String(row.queued_at),
    deliveredAt: row.delivered_at === null || row.delivered_at === undefined ? null : String(row.delivered_at),
    incorporatedAt: row.incorporated_at === null || row.incorporated_at === undefined ? null : String(row.incorporated_at),
    nativeEntryId: row.native_entry_id === null || row.native_entry_id === undefined ? null : String(row.native_entry_id),
    attemptId: row.attempt_id === null || row.attempt_id === undefined ? null : String(row.attempt_id),
    generation: row.generation === null || row.generation === undefined ? null : Number(row.generation),
    expiresAt: row.expires_at === null || row.expires_at === undefined ? null : String(row.expires_at),
  };
}

function messageRow(v2: V2Store, messageId: string): Row | undefined {
  return v2.row<Row>('SELECT * FROM swarm_v2_messages WHERE message_id=?', messageId);
}

function requireMessage(v2: V2Store, messageId: string): SwarmV2Message {
  const row = messageRow(v2, messageId);
  if (!row) throw new CapabilityError('VALIDATION_ERROR', `消息不存在：${messageId}`);
  return toMessage(row);
}

function requireTeam(v2: V2Store, teamId: string): void {
  if (!v2.row<{team_id: string}>('SELECT team_id FROM swarm_v2_teams WHERE team_id=?', teamId)) {
    throw new CapabilityError('VALIDATION_ERROR', `团队不存在：${teamId}`);
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  }
  return value;
}

function provenanceOf(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  const value = obj(input);
  const serialized = JSON.stringify(canonical(value));
  if (serialized.length > MAX_MESSAGE_PROVENANCE) throw new CapabilityError('VALIDATION_ERROR', `provenance 超过 ${MAX_MESSAGE_PROVENANCE} 字符`);
  return JSON.parse(serialized) as Record<string, unknown>;
}

function timeOrNull(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new CapabilityError('VALIDATION_ERROR', `${field} 必须是有效时间`);
  return new Date(value).toISOString();
}

function actorOf(senderKind: string, senderId: string | null, generation: number | null): {kind: 'lead' | 'member' | 'human' | 'system'; id: string; generation?: number} {
  return {
    kind: (ACTOR_KINDS.has(senderKind) ? senderKind : 'system') as 'lead' | 'member' | 'human' | 'system',
    id: senderId ?? senderKind,
    ...(generation === null ? {} : {generation}),
  };
}

/**
 * Send one message into a target's durable FIFO. `sequence` is per
 * (team, target) max+1 and therefore unique per target.
 */
export function sendMessage(store: RecordStore, input: SendMessageInput): SwarmV2Message {
  const v2 = V2Store.open(store);
  const teamId = text(input?.teamId, 'teamId', 200);
  const sender = obj(input?.sender) as unknown as MessageSender;
  const senderKind = text(sender.kind, 'sender.kind', 20);
  const senderId = optionalText(sender.id, 'sender.id', 200);
  const senderGeneration = sender.generation === undefined ? null : intOrNull(sender.generation, 'sender.generation', 0) ?? null;
  const targetId = text(input?.targetId, 'targetId', 200);
  const targetKind = optionalText(input?.targetKind, 'targetKind', 30) ?? 'member';
  const type = text(input?.type, 'type', 100);
  const deliveryMode = String(input?.deliveryMode ?? '');
  if (!DELIVERY_MODES.has(deliveryMode as SwarmV2MessageMode)) throw new CapabilityError('VALIDATION_ERROR', `deliveryMode 无效：${deliveryMode || '(空)'}`);
  const body = text(input?.body, 'body', MAX_MESSAGE_BODY);
  const bodyDigest = digest(body);
  const provenance = provenanceOf(input?.provenance);
  const provenanceJson = JSON.stringify(provenance);
  const expiresAt = timeOrNull(input?.expiresAt, 'expiresAt');
  const messageId = optionalText(input?.messageId, 'messageId', 200) ?? randomUUID();
  return v2.transaction(() => {
    requireTeam(v2, teamId);
    const existing = messageRow(v2, messageId);
    if (existing) {
      const stored = toMessage(existing);
      const same = stored.teamId === teamId && stored.bodyDigest === bodyDigest &&
        stored.targetId === targetId && stored.targetKind === targetKind &&
        stored.type === type && stored.deliveryMode === deliveryMode &&
        stored.senderKind === senderKind && stored.senderId === senderId && stored.senderGeneration === senderGeneration &&
        JSON.stringify(stored.provenance) === provenanceJson && stored.expiresAt === expiresAt;
      if (!same) throw new ConflictError(`messageId 已用于不同消息内容：${messageId}`);
      return stored;
    }
    const sequence = Number((v2.row<{n: number}>('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM swarm_v2_messages WHERE team_id=? AND target_id=?', teamId, targetId) as {n: number}).n);
    const at = v2Now();
    v2.db.prepare('INSERT INTO swarm_v2_messages(message_id,team_id,sender_kind,sender_id,sender_generation,target_kind,target_id,type,delivery_mode,sequence,body_digest,body_length,body,provenance_json,state,accepted_at,queued_at,delivered_at,incorporated_at,native_entry_id,attempt_id,generation,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(messageId, teamId, senderKind, senderId, senderGeneration, targetKind, targetId, type, deliveryMode, sequence, bodyDigest, body.length, body, provenanceJson, 'accepted', at, null, null, null, null, null, null, expiresAt);
    v2.journal(teamId, 'message.accepted', actorOf(senderKind, senderId, senderGeneration), {kind: 'message', id: messageId, revision: 1}, {
      messageId, targetId, targetKind, type, deliveryMode, sequence, bodyDigest,
    });
    return requireMessage(v2, messageId);
  });
}

/** accepted -> queued. Replaying a queued message is idempotent. */
export function queueMessage(store: RecordStore, messageId: string): SwarmV2Message {
  const v2 = V2Store.open(store);
  const id = text(messageId, 'messageId', 200);
  return v2.transaction(() => {
    const message = requireMessage(v2, id);
    if (message.state === 'queued') return message;
    if (message.state !== 'accepted') throw new CapabilityError('VALIDATION_ERROR', `消息状态 ${message.state} 不允许入队`);
    const at = v2Now();
    v2.db.prepare("UPDATE swarm_v2_messages SET state='queued',queued_at=? WHERE message_id=? AND state='accepted'").run(at, id);
    v2.journal(message.teamId, 'message.queued', SYSTEM_ACTOR, {kind: 'message', id}, {messageId: id, sequence: message.sequence, queuedAt: at});
    return requireMessage(v2, id);
  });
}

/** queued -> delivered (records deliveredAt). Replaying a delivered message is idempotent. */
export function deliverMessage(store: RecordStore, messageId: string): SwarmV2Message {
  const v2 = V2Store.open(store);
  const id = text(messageId, 'messageId', 200);
  return v2.transaction(() => {
    const message = requireMessage(v2, id);
    if (message.state === 'delivered') return message;
    if (message.state !== 'queued') {
      throw new CapabilityError('VALIDATION_ERROR', message.state === 'accepted' ? '消息必须先入队才能投递' : `消息状态 ${message.state} 不允许投递`);
    }
    // FIFO: never deliver past an earlier envelope for the same target that has
    // not reached a terminal delivery state yet (accepted/queued still block).
    const earlier = v2.row<{message_id: string}>(
      "SELECT message_id FROM swarm_v2_messages WHERE team_id=? AND target_id=? AND sequence<? AND state IN ('accepted','queued') LIMIT 1",
      message.teamId, message.targetId, message.sequence,
    );
    if (earlier) throw new CapabilityError('VERSION_CONFLICT', '存在更早的未投递消息');
    const at = v2Now();
    v2.db.prepare("UPDATE swarm_v2_messages SET state='delivered',delivered_at=? WHERE message_id=? AND state='queued'").run(at, id);
    v2.journal(message.teamId, 'message.delivered', SYSTEM_ACTOR, {kind: 'message', id}, {messageId: id, sequence: message.sequence, deliveredAt: at});
    return requireMessage(v2, id);
  });
}

/**
 * delivered -> incorporated, pinning the native journal entry. Re-incorporating
 * with the same entry is idempotent; a different entry is a VERSION_CONFLICT.
 */
export function incorporateMessage(store: RecordStore, messageId: string, nativeEntryId: string): SwarmV2Message {
  const v2 = V2Store.open(store);
  const id = text(messageId, 'messageId', 200);
  const entryId = text(nativeEntryId, 'nativeEntryId', 200);
  return v2.transaction(() => {
    const message = requireMessage(v2, id);
    if (message.state === 'incorporated') {
      if (message.nativeEntryId !== entryId) throw new ConflictError(`消息已并入不同原生条目：${message.nativeEntryId}`);
      return message;
    }
    if (message.state !== 'delivered') {
      throw new CapabilityError('VALIDATION_ERROR', message.state === 'expired' ? '消息已过期，不能并入' : '消息必须先投递才能并入');
    }
    const earlier = v2.rows<{sequence: number}>("SELECT sequence FROM swarm_v2_messages WHERE team_id=? AND target_id=? AND sequence<? AND state IN ('accepted','queued','delivered')", message.teamId, message.targetId, message.sequence);
    if (earlier.length) throw new CapabilityError('VERSION_CONFLICT', '存在更早的未并入消息');
    const at = v2Now();
    v2.db.prepare("UPDATE swarm_v2_messages SET state='incorporated',incorporated_at=?,native_entry_id=? WHERE message_id=? AND state='delivered'").run(at, entryId, id);
    v2.journal(message.teamId, 'message.incorporated', SYSTEM_ACTOR, {kind: 'message', id}, {messageId: id, sequence: message.sequence, nativeEntryId: entryId, incorporatedAt: at});
    return requireMessage(v2, id);
  });
}

/**
 * Mark every not-yet-incorporated message whose expiresAt is at/before `now`
 * as `expired`. Idempotent; returns the messages transitioned by this call.
 */
export function expireMessages(store: RecordStore, teamId: string, now?: string): SwarmV2Message[] {
  const v2 = V2Store.open(store);
  const team = text(teamId, 'teamId', 200);
  const at = timeOrNull(now, 'now') ?? v2Now();
  return v2.transaction(() => {
    requireTeam(v2, team);
    const rows = v2.rows<Row>("SELECT * FROM swarm_v2_messages WHERE team_id=? AND expires_at IS NOT NULL AND expires_at<=? AND state IN ('accepted','queued','delivered') ORDER BY sequence,rowid", team, at);
    const expired: SwarmV2Message[] = [];
    for (const row of rows) {
      const message = toMessage(row);
      v2.db.prepare("UPDATE swarm_v2_messages SET state='expired' WHERE message_id=? AND state IN ('accepted','queued','delivered')").run(message.messageId);
      v2.journal(team, 'message.expired', SYSTEM_ACTOR, {kind: 'message', id: message.messageId}, {messageId: message.messageId, sequence: message.sequence, expiresAt: message.expiresAt, expiredAt: at});
      expired.push({...message, state: 'expired'});
    }
    return expired;
  });
}

/** Sequence-cursor pagination in ascending sequence order (optionally per target). */
export function listMessages(store: RecordStore, teamId: string, options: ListMessagesOptions = {}): SwarmV2Message[] {
  const v2 = V2Store.open(store);
  const team = text(teamId, 'teamId', 200);
  const where = ['team_id=?'];
  const args: (string | number)[] = [team];
  const targetId = optionalText(options?.targetId, 'targetId', 200);
  if (targetId !== null) { where.push('target_id=?'); args.push(targetId); }
  const afterSequence = options?.afterSequence === undefined ? 0 : intOrNull(options.afterSequence, 'afterSequence', 0) ?? 0;
  // Sequences are per target; a global cursor would silently skip messages whose
  // per-target sequence is below the cursor. Cursor pagination requires a target.
  if (afterSequence > 0 && targetId === null) throw new CapabilityError('VALIDATION_ERROR', '跨目标分页需要 targetId');
  if (afterSequence > 0) { where.push('sequence>?'); args.push(afterSequence); }
  const limit = options?.limit === undefined ? 100 : intOrNull(options.limit, 'limit', 1, 200) ?? 100;
  return v2.rows<Row>(`SELECT * FROM swarm_v2_messages WHERE ${where.join(' AND ')} ORDER BY sequence ASC,rowid ASC LIMIT ?`, ...args, limit).map(toMessage);
}

export function getMessage(store: RecordStore, messageId: string): SwarmV2Message | undefined {
  const v2 = V2Store.open(store);
  const row = messageRow(v2, text(messageId, 'messageId', 200));
  return row ? toMessage(row) : undefined;
}

/**
 * Wait primitive. Only messages created AFTER this call are observed (existing
 * backlog never satisfies the wait), filtered by `sequence > afterSequence`.
 * When `afterSequence > 0`, `targetId` is required because sequences are
 * per-target; a target-scoped wait also ignores other targets entirely.
 * Poll interval is bounded (<=100ms); timeout is 10s..1h per the v2 contract.
 */
export async function waitForMessages(store: RecordStore, teamId: string, input: WaitMessagesInput): Promise<WaitMessagesResult> {
  const v2 = V2Store.open(store);
  const team = text(teamId, 'teamId', 200);
  requireTeam(v2, team);
  const targetId = optionalText(input?.targetId, 'targetId', 200);
  const afterSequence = input?.afterSequence === undefined ? 0 : intOrNull(input.afterSequence, 'afterSequence', 0) ?? 0;
  if (afterSequence > 0 && targetId === null) throw new CapabilityError('VALIDATION_ERROR', '跨目标分页需要 targetId');
  const timeoutMs = intOrNull(input?.timeoutMs, 'timeoutMs', MESSAGE_WAIT_MIN_TIMEOUT_MS, MESSAGE_WAIT_MAX_TIMEOUT_MS) as number;
  const pollMs = Math.min(intOrNull(input?.pollMs, 'pollMs', 1, 1000) ?? MESSAGE_WAIT_MAX_POLL_MS, MESSAGE_WAIT_MAX_POLL_MS);
  const baselineRow = targetId === null
    ? Number((v2.row<{n: number}>('SELECT COALESCE(MAX(rowid),0) AS n FROM swarm_v2_messages WHERE team_id=?', team) as {n: number}).n)
    : Number((v2.row<{n: number}>('SELECT COALESCE(MAX(rowid),0) AS n FROM swarm_v2_messages WHERE team_id=? AND target_id=?', team, targetId) as {n: number}).n);
  const collect = (): SwarmV2Message[] => targetId === null
    ? v2.rows<Row>('SELECT * FROM swarm_v2_messages WHERE team_id=? AND rowid>? AND sequence>? ORDER BY rowid ASC', team, baselineRow, afterSequence).map(toMessage)
    : v2.rows<Row>('SELECT * FROM swarm_v2_messages WHERE team_id=? AND target_id=? AND rowid>? AND sequence>? ORDER BY rowid ASC', team, targetId, baselineRow, afterSequence).map(toMessage);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = collect();
    if (found.length) return {messages: found, timedOut: false};
    if (Date.now() >= deadline) return {messages: [], timedOut: true};
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
}

/**
 * FIFO assertion: messages that were delivered/incorporated in sequence order
 * must also have non-decreasing delivery/incorporation timestamps. A violation
 * proves out-of-order delivery or a corrupted envelope.
 */
export function assertFifo(store: RecordStore, teamId: string, targetId: string): {ok: true; targetId: string; checked: number} {
  const v2 = V2Store.open(store);
  const team = text(teamId, 'teamId', 200);
  const target = text(targetId, 'targetId', 200);
  const rows = v2.rows<Row>("SELECT * FROM swarm_v2_messages WHERE team_id=? AND target_id=? AND (delivered_at IS NOT NULL OR incorporated_at IS NOT NULL) ORDER BY sequence ASC,rowid ASC", team, target);
  let previousDelivered: string | null = null;
  let previousIncorporated: string | null = null;
  for (const row of rows) {
    const message = toMessage(row);
    if (message.deliveredAt !== null) {
      if (previousDelivered !== null && message.deliveredAt < previousDelivered) {
        throw new CapabilityError('VALIDATION_ERROR', `FIFO 违例：target ${target} 的 sequence ${message.sequence} 早于前序消息投递`);
      }
      previousDelivered = message.deliveredAt;
    }
    if (message.incorporatedAt !== null) {
      if (previousIncorporated !== null && message.incorporatedAt < previousIncorporated) {
        throw new CapabilityError('VALIDATION_ERROR', `FIFO 违例：target ${target} 的 sequence ${message.sequence} 早于前序消息并入`);
      }
      previousIncorporated = message.incorporatedAt;
    }
  }
  return {ok: true, targetId: target, checked: rows.length};
}

/**
 * Four-state lifecycle consistency assertion. Verifies the state implies the
 * right timestamps/native entry, that stored digests match the body, and that
 * timestamps never go backwards.
 */
export function assertMessageLifecycle(message: SwarmV2Message): true {
  const fail = (detail: string): never => { throw new CapabilityError('VALIDATION_ERROR', `消息生命周期不合法：${detail}`); };
  if (!MESSAGE_STATES.includes(message.state)) fail(`未知状态 ${String(message.state)}`);
  if (!Number.isSafeInteger(message.sequence) || message.sequence < 1) fail('sequence 必须为正整数');
  if (message.bodyDigest !== digest(message.body)) fail('bodyDigest 与正文不匹配');
  if (message.bodyLength !== message.body.length) fail('bodyLength 与正文不匹配');
  const requireNull = (value: string | null, name: string): void => { if (value !== null) fail(`${message.state} 状态下 ${name} 必须为空`); };
  const requireSet = (value: string | null, name: string): void => { if (value === null || value === '') fail(`${message.state} 状态下 ${name} 不能为空`); };
  if (message.state === 'accepted') {
    requireNull(message.queuedAt, 'queuedAt');
    requireNull(message.deliveredAt, 'deliveredAt');
    requireNull(message.incorporatedAt, 'incorporatedAt');
    requireNull(message.nativeEntryId, 'nativeEntryId');
  } else if (message.state === 'queued') {
    requireSet(message.queuedAt, 'queuedAt');
    requireNull(message.deliveredAt, 'deliveredAt');
    requireNull(message.incorporatedAt, 'incorporatedAt');
    requireNull(message.nativeEntryId, 'nativeEntryId');
  } else if (message.state === 'delivered') {
    requireSet(message.queuedAt, 'queuedAt');
    requireSet(message.deliveredAt, 'deliveredAt');
    requireNull(message.incorporatedAt, 'incorporatedAt');
    requireNull(message.nativeEntryId, 'nativeEntryId');
  } else if (message.state === 'incorporated') {
    requireSet(message.queuedAt, 'queuedAt');
    requireSet(message.deliveredAt, 'deliveredAt');
    requireSet(message.incorporatedAt, 'incorporatedAt');
    requireSet(message.nativeEntryId, 'nativeEntryId');
  } else if (message.state === 'expired') {
    if (message.expiresAt === null) fail('expired 状态必须有 expiresAt');
  }
  const ordered = [message.queuedAt, message.deliveredAt, message.incorporatedAt].filter((value): value is string => value !== null);
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index] < ordered[index - 1]) fail('时间戳顺序倒置');
  }
  return true;
}
