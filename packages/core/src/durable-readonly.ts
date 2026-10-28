import { DatabaseSync } from 'node:sqlite';
import { CURRENT_SQLITE_SCHEMA_VERSION } from '@earendil-works/pi-durable/storage/sqlite';
import { durablePiEntries, type PiShapedEntry } from './durable-plugin-host.js';

/**
 * Read-only access to another session's durable storage.
 *
 * Durable's "one process owns a storage at a time" is a statement about **writes**: its commit path
 * assumes a single writer and it takes no cross-process lock. Reads are a different matter — SQLite
 * in WAL mode serves any number of concurrent readers, so a session process can read a peer's
 * transcript while that peer keeps writing. Verified against a live writer before this module
 * existed, not assumed.
 *
 * Only the read path is opened here. `SqliteStorage.open()` cannot be used for this because it runs
 * migrations inside a transaction, which a read-only connection cannot do; the schema version is
 * checked instead, and a file from a newer Durable is refused rather than misread.
 */

/** Columns this reader depends on; a mismatch means the file is not shaped like a durable storage. */
const REQUIRED = { table: 'entries', columns: ['id', 'conversation_id', 'record'] as const };

export interface DurableReadOnlySession {
  readonly conversationId: string;
  /** Chronological, like every other history consumer expects. */
  entries(): readonly PiShapedEntry[];
  /** Schema version recorded by the file itself. */
  readonly schemaVersion: number;
  close(): void;
}

function rowsOf(database: DatabaseSync, sql: string): Record<string, unknown>[] {
  return database.prepare(sql).all() as Record<string, unknown>[];
}

/**
 * Open one durable storage file for reading.
 *
 * Throws when the file is missing, when it is not a durable storage, or when it was written by a
 * newer schema than this build understands — a partial or misread transcript is worse than a clear
 * refusal, because provenance would then point at text that was never said.
 */
export function openDurableReadOnly(path: string): DurableReadOnlySession {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = new Set(
      rowsOf(database, "SELECT name FROM sqlite_master WHERE type='table'").map(row => String(row.name)),
    );
    for (const required of ['entries', 'conversations', 'durable_schema'])
      if (!tables.has(required)) throw new Error(`不是可读的 Pi Durable 存储：缺少表 ${required}`);

    const columns = new Set(rowsOf(database, `PRAGMA table_info(${REQUIRED.table})`).map(row => String(row.name)));
    for (const column of REQUIRED.columns)
      if (!columns.has(column)) throw new Error(`Pi Durable 存储结构不匹配：${REQUIRED.table} 缺少列 ${column}`);

    const versionRow = database.prepare('SELECT version FROM durable_schema WHERE singleton = 1').get() as
      | { version?: number }
      | undefined;
    const schemaVersion = Number(versionRow?.version ?? 0);
    if (schemaVersion > CURRENT_SQLITE_SCHEMA_VERSION)
      throw new Error(`Pi Durable 存储版本 ${schemaVersion} 高于本程序支持的 ${CURRENT_SQLITE_SCHEMA_VERSION}，拒绝读取`);

    const conversations = rowsOf(database, 'SELECT id, record FROM conversations ORDER BY id ASC');
    const conversationId = conversations.length ? String(conversations[0].id) : '';

    const raw = rowsOf(database, 'SELECT id, record FROM entries ORDER BY id ASC').map(row => ({
      id: String(row.id),
      ...(JSON.parse(String(row.record)) as Record<string, unknown>),
    }));

    return {
      conversationId,
      schemaVersion,
      entries: () => durablePiEntries(raw as never),
      close: () => database.close(),
    };
  } catch (error) {
    try { database.close(); } catch { /* keep the original failure */ }
    throw error;
  }
}
