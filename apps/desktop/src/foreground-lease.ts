/**
 * M02 cross-process foreground lease (versioned contract, v2).
 *
 * The desktop SDK worker publishes one lease per session under the `runtime`
 * RecordStore namespace; the independent learning host reads all of them and
 * yields background model work while a foreground run is active. The lease is a
 * *contract*, not a local lock: it must be readable across processes, must expire
 * when the writer dies, and must stay backward compatible with the v1 rows
 * (`{pid,active,runId,expiresAt}`) still present in existing data directories.
 *
 * v2 adds the writer version, kind tag, session identity and heartbeat timestamp
 * so a reader can distinguish leases, refresh them without guessing, and ignore
 * malformed/unknown rows instead of blocking background learning forever.
 */
import type { RecordStore } from '@friend-pi/core';

export const FOREGROUND_LEASE_VERSION = 2;
export const FOREGROUND_LEASE_KIND = 'foreground';
/** Must stay comfortably above the 5s SDK heartbeat pulse (SDK worker). */
export const FOREGROUND_LEASE_TTL_MS = 15000;
export const FOREGROUND_LEASE_PREFIX = 'foreground:';

export interface ForegroundLease {
  v: 2;
  kind: 'foreground';
  pid: number;
  sessionId: string;
  runId?: string;
  active: boolean;
  heartbeatAt: string;
  /** Epoch milliseconds; a lease is only considered until this instant. */
  expiresAt: number;
}

export type ForegroundLeaseInput = Omit<ForegroundLease, 'v' | 'kind' | 'heartbeatAt' | 'expiresAt'>;

/** A dead PID never blocks the host. EPERM means the process exists but is not ours. */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!(error && typeof error === 'object' && 'code' in error && error.code === 'EPERM');
  }
}

function validPid(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function validExpiry(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Publish (or refresh) this process's foreground lease for one session. */
export function writeForegroundLease(store: RecordStore, lease: ForegroundLeaseInput, now: number = Date.now()): ForegroundLease {
  if (!store || typeof store.put !== 'function') throw new TypeError('foreground lease 需要 RecordStore');
  if (!lease || typeof lease !== 'object') throw new TypeError('foreground lease 输入必须是对象');
  if (!validPid(lease.pid)) throw new TypeError('foreground lease pid 必须是正整数');
  if (typeof lease.sessionId !== 'string' || !lease.sessionId.trim() || lease.sessionId.length > 200) throw new TypeError('foreground lease sessionId 必须是非空字符串');
  if (typeof lease.active !== 'boolean') throw new TypeError('foreground lease active 必须是布尔值');
  if (lease.runId !== undefined && (typeof lease.runId !== 'string' || lease.runId.length > 200)) throw new TypeError('foreground lease runId 必须是字符串');
  if (!Number.isFinite(now)) throw new TypeError('foreground lease now 必须是毫秒时间戳');
  const written: ForegroundLease = {
    v: FOREGROUND_LEASE_VERSION,
    kind: FOREGROUND_LEASE_KIND,
    sessionId: lease.sessionId,
    pid: lease.pid,
    ...(lease.runId === undefined ? {} : { runId: lease.runId }),
    active: lease.active,
    heartbeatAt: new Date(now).toISOString(),
    expiresAt: now + FOREGROUND_LEASE_TTL_MS,
  };
  store.put(`${FOREGROUND_LEASE_PREFIX}${lease.sessionId}`, written);
  return written;
}

/**
 * Read every foreground lease, normalizing legacy v1 rows to the v2 shape and
 * dropping expired, malformed or unknown-version rows. `now` is injectable so
 * tests never depend on wall-clock timing.
 */
export function readForegroundLeases(store: RecordStore, now: number = Date.now()): ForegroundLease[] {
  if (!store || typeof store.list !== 'function') throw new TypeError('foreground lease 需要 RecordStore');
  const leases: ForegroundLease[] = [];
  for (const row of store.list<Record<string, unknown>>(FOREGROUND_LEASE_PREFIX)) {
    const sessionId = row.key.slice(FOREGROUND_LEASE_PREFIX.length);
    if (!sessionId) continue;
    const value = row.value;
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const version = (value as { v?: unknown }).v;
    // Unknown future versions are not interpretable; never let them block work.
    if (version !== undefined && version !== 1 && version !== FOREGROUND_LEASE_VERSION) continue;
    const expiresAt = (value as { expiresAt?: unknown }).expiresAt;
    if (!validExpiry(expiresAt)) continue;
    // Expired leases are ignored for both reads and busy checks.
    if (expiresAt <= now) continue;
    const active = (value as { active?: unknown }).active === true;
    const pid = (value as { pid?: unknown }).pid;
    if (!validPid(pid)) continue;
    const runId = (value as { runId?: unknown }).runId;
    if (runId !== undefined && typeof runId !== 'string') continue;
    const heartbeatAtValue = (value as { heartbeatAt?: unknown }).heartbeatAt;
    const heartbeatAt = typeof heartbeatAtValue === 'string' && Number.isFinite(Date.parse(heartbeatAtValue))
      ? heartbeatAtValue
      // Legacy v1 rows have no heartbeat; derive it from the fixed TTL.
      : new Date(expiresAt - FOREGROUND_LEASE_TTL_MS).toISOString();
    leases.push({
      v: FOREGROUND_LEASE_VERSION,
      kind: FOREGROUND_LEASE_KIND,
      pid,
      sessionId,
      ...(runId === undefined ? {} : { runId }),
      active,
      heartbeatAt,
      expiresAt,
    });
  }
  // Deterministic order independent of SQLite key ordering details.
  return leases.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
}

/** True while some live foreground process holds an unexpired, active lease. */
export function foregroundBusy(store: RecordStore, now: number = Date.now()): boolean {
  return readForegroundLeases(store, now).some(lease => lease.active && alive(lease.pid));
}
