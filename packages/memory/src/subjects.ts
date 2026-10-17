import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Subject registry: normalizes stable dotted subject keys, normalizes claim
 * values, and reads the active peers of one subject from memory_records.
 *
 * This module deliberately has no runtime dependency on `index.ts` or on the
 * memory controller. The schema migration and controller both import these
 * helpers (directly or through MemoryMigrationHooks), so they must stay pure
 * except for the explicit `DatabaseSync` parameters of the data functions.
 */

export type SubjectCardinality = 'single' | 'multi';
export type SubjectValueType = 'string' | 'enum' | 'number' | 'date' | 'url' | 'path' | 'command' | 'freeform';
export type SubjectSensitivity = 'normal' | 'sensitive';
export type SubjectScope = 'project' | 'personal';

export interface SubjectDefinition {
  projectId: string;
  scope: SubjectScope;
  key: string;
  label: string;
  aliases: string[];
  cardinality: SubjectCardinality;
  valueType: SubjectValueType;
  sensitivity: SubjectSensitivity;
  createdAt: string;
  updatedAt: string;
}

export interface SubjectPeer {
  id: string;
  revision: number;
  claimHash: string;
  content: string;
  conditions: string[];
  trust: string | null;
  updatedAt: string;
}

export const DEFAULT_SUBJECT_CARDINALITY: SubjectCardinality = 'single';

const MAX_SUBJECT_KEY_LENGTH = 200;
const MAX_LABEL_LENGTH = 200;
const CARDINALITIES = new Set<string>(['single', 'multi']);
const VALUE_TYPES = new Set<string>(['string', 'enum', 'number', 'date', 'url', 'path', 'command', 'freeform']);
const SENSITIVITIES = new Set<string>(['normal', 'sensitive']);
const SCOPES = new Set<string>(['project', 'personal']);

/** Same canonicalization as core `digest`; kept local so this module stays standalone. */
const digest = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

function subjectError(message: string): Error {
  const error = new Error(message);
  (error as Error & { code?: string }).code = 'VALIDATION_ERROR';
  return error;
}

function isoTime(value: string): string {
  return new Date(value).toISOString();
}

function validTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/**
 * Normalize a subject key: NFKC, trim, lowercase, collapse whitespace /
 * underscore / hyphen / colon into '.', keep only [a-z0-9._-], collapse and
 * strip dots. Returns undefined rather than inventing a key when the input is
 * unusable (non-string, empty, '..' segments, longer than 200 characters).
 */
export function normalizeSubjectKey(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const folded = raw.normalize('NFKC').trim().toLowerCase();
  if (!folded || folded.includes('..')) return undefined;
  const key = folded
    .replace(/[\s_\-:]+/gu, '.')
    .replace(/[^a-z0-9._-]+/gu, '')
    .replace(/\.{2,}/gu, '.')
    .replace(/^\.+|\.+$/gu, '');
  if (!key || key.length > MAX_SUBJECT_KEY_LENGTH) return undefined;
  return key;
}

/**
 * Normalize a claim value for same-subject value comparison: NFKC, lowercase,
 * collapse whitespace, strip trailing sentence punctuation, trim. Leading
 * punctuation and internal punctuation are preserved on purpose.
 */
export function normalizeSubjectValue(value: string): string {
  if (typeof value !== 'string') throw subjectError('主题值必须是字符串');
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[。.!?;,\s]+$/u, '')
    .trim();
}

/**
 * Stable hash for "the same claimed value": normalized content plus sorted
 * normalized conditions. Ignoring order keeps hash comparisons deterministic.
 */
export function subjectClaimHash(record: { content: string; conditions?: string[] }): string {
  if (!record || typeof record.content !== 'string') throw subjectError('主题声明必须包含正文');
  const conditions = Array.isArray(record.conditions)
    ? record.conditions.filter((value): value is string => typeof value === 'string').map(normalizeSubjectValue).sort()
    : [];
  return digest({ v: 1, value: normalizeSubjectValue(record.content), conditions });
}

/**
 * A key is valid when it is a bounded lowercase dotted segment key. Hyphens are
 * accepted in an already-materialized key (e.g. a registry row such as
 * `project-rule.abc123`); model/legacy inputs still go through
 * `normalizeSubjectKey`, which folds hyphens into dots.
 */
export function isValidSubjectKey(key: string): boolean {
  return typeof key === 'string' && key.length > 0 && key.length <= MAX_SUBJECT_KEY_LENGTH
    && !key.includes('..') && /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u.test(key);
}

interface SubjectRow {
  project_id: string;
  scope: string;
  key: string;
  label: string;
  aliases_json: string;
  cardinality: string;
  value_type: string;
  sensitivity: string;
  created_at: string;
  updated_at: string;
}

const SUBJECT_COLUMNS = 'project_id,scope,key,label,aliases_json,cardinality,value_type,sensitivity,created_at,updated_at';

function decodeAliases(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

function fromRow(row: SubjectRow): SubjectDefinition {
  return {
    projectId: String(row.project_id),
    scope: String(row.scope) as SubjectScope,
    key: String(row.key),
    label: String(row.label),
    aliases: decodeAliases(row.aliases_json),
    cardinality: (CARDINALITIES.has(String(row.cardinality)) ? String(row.cardinality) : DEFAULT_SUBJECT_CARDINALITY) as SubjectCardinality,
    valueType: (VALUE_TYPES.has(String(row.value_type)) ? String(row.value_type) : 'freeform') as SubjectValueType,
    sensitivity: (String(row.sensitivity) === 'sensitive' ? 'sensitive' : 'normal') as SubjectSensitivity,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function transaction<T>(db: DatabaseSync, work: () => T): T {
  if (db.isTransaction) return work();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Read one registered subject, or undefined when it has never been registered. */
export function getSubject(db: DatabaseSync, projectId: string, scope: string, key: string): SubjectDefinition | undefined {
  const row = db.prepare(`SELECT ${SUBJECT_COLUMNS} FROM memory_subjects WHERE project_id=? AND scope=? AND key=?`).get(projectId, scope, key);
  return row ? fromRow(row as unknown as SubjectRow) : undefined;
}

/**
 * Upsert a subject definition. Re-registering an existing key preserves the
 * first label and created_at, unions aliases (first-seen order), and refreshes
 * cardinality / value_type / sensitivity / updated_at from the input.
 */
export function registerSubject(db: DatabaseSync, input: SubjectDefinition): SubjectDefinition {
  if (!db || typeof db.prepare !== 'function') throw subjectError('subject 注册需要数据库连接');
  const projectId = typeof input?.projectId === 'string' ? input.projectId.trim() : '';
  if (!projectId) throw subjectError('subject 注册需要项目编号');
  const scope = input?.scope;
  if (typeof scope !== 'string' || !SCOPES.has(scope)) throw subjectError('subject scope 必须是 project 或 personal');
  const key = input?.key;
  if (!isValidSubjectKey(key)) throw subjectError('subject 键无效');
  const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, MAX_LABEL_LENGTH) : key;
  const aliases = Array.isArray(input.aliases)
    ? [...new Set(input.aliases.filter((value): value is string => typeof value === 'string').map(value => value.trim()).filter(Boolean))]
    : [];
  const cardinality = input.cardinality ?? DEFAULT_SUBJECT_CARDINALITY;
  if (!CARDINALITIES.has(String(cardinality))) throw subjectError('subject cardinality 无效');
  const valueType = input.valueType ?? 'freeform';
  if (!VALUE_TYPES.has(String(valueType))) throw subjectError('subject valueType 无效');
  const sensitivity = input.sensitivity ?? 'normal';
  if (!SENSITIVITIES.has(String(sensitivity))) throw subjectError('subject sensitivity 无效');
  const providedUpdatedAt = validTime(input.updatedAt) ? isoTime(input.updatedAt) : new Date().toISOString();
  const providedCreatedAt = validTime(input.createdAt) ? isoTime(input.createdAt) : providedUpdatedAt;
  return transaction(db, () => {
    const existing = getSubject(db, projectId, scope as SubjectScope, key);
    const createdAt = existing?.createdAt ?? providedCreatedAt;
    const updatedAt = existing && existing.updatedAt > providedUpdatedAt ? existing.updatedAt : providedUpdatedAt;
    const mergedAliases = [...new Set([...(existing?.aliases ?? []), ...aliases])];
    const definition: SubjectDefinition = {
      projectId, scope: scope as SubjectScope, key,
      label: existing?.label ?? label,
      aliases: mergedAliases,
      cardinality: cardinality as SubjectCardinality,
      valueType: valueType as SubjectValueType,
      sensitivity: sensitivity as SubjectSensitivity,
      createdAt, updatedAt,
    };
    db.prepare(`INSERT INTO memory_subjects(${SUBJECT_COLUMNS}) VALUES(?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(project_id,scope,key) DO UPDATE SET
        label=excluded.label,
        aliases_json=excluded.aliases_json,
        cardinality=excluded.cardinality,
        value_type=excluded.value_type,
        sensitivity=excluded.sensitivity,
        updated_at=excluded.updated_at`)
      .run(projectId, definition.scope, key, definition.label, JSON.stringify(mergedAliases), definition.cardinality, definition.valueType, definition.sensitivity, createdAt, updatedAt);
    return definition;
  });
}

/** List subjects of one project, optionally restricted to one scope. Deterministic ordering. */
export function listSubjects(db: DatabaseSync, projectId: string, scope?: SubjectScope): SubjectDefinition[] {
  if (scope !== undefined && !SCOPES.has(String(scope))) throw subjectError('subject scope 必须是 project 或 personal');
  const rows = scope === undefined
    ? db.prepare(`SELECT ${SUBJECT_COLUMNS} FROM memory_subjects WHERE project_id=? ORDER BY scope ASC,key ASC`).all(projectId)
    : db.prepare(`SELECT ${SUBJECT_COLUMNS} FROM memory_subjects WHERE project_id=? AND scope=? ORDER BY key ASC`).all(projectId, scope);
  return rows.map(row => fromRow(row as unknown as SubjectRow));
}

interface PeerRow {
  id: string;
  revision: number;
  trust: string | null;
  json: string;
}

interface StoredRecordShape {
  content?: unknown;
  conditions?: unknown;
  updatedAt?: unknown;
  trust?: unknown;
}

/**
 * Active, enabled peers that claim the same subject in the same project and
 * scope, most recently updated first. `excludeId` lets a newly saved or
 * re-activated record ignore itself. Claims are normalized here so callers can
 * compare `claimHash` values directly.
 */
export function activeSubjectPeers(db: DatabaseSync, input: { projectId: string; scope: string; subjectKey: string; excludeId?: string }): SubjectPeer[] {
  if (!db || typeof db.prepare !== 'function') throw subjectError('读取主题对等记录需要数据库连接');
  const projectId = typeof input?.projectId === 'string' ? input.projectId : '';
  if (!projectId) throw subjectError('读取主题对等记录需要项目编号');
  const scope = input.scope;
  if (typeof scope !== 'string' || !SCOPES.has(scope)) throw subjectError('subject scope 必须是 project 或 personal');
  const subjectKey = input.subjectKey;
  if (!isValidSubjectKey(subjectKey)) throw subjectError('subject 键无效');
  const excludeId = typeof input.excludeId === 'string' && input.excludeId ? input.excludeId : undefined;
  const rows = db.prepare(`SELECT id,revision,trust,json FROM memory_records
      WHERE project_id=? AND scope=? AND subject_key=? AND status='active' AND enabled=1${excludeId ? ' AND id<>?' : ''}
      ORDER BY json_extract(json,'$.updatedAt') DESC,rowid DESC`)
    .all(...(excludeId ? [projectId, scope, subjectKey, excludeId] : [projectId, scope, subjectKey])) as unknown as PeerRow[];
  return rows.map(row => {
    let stored: StoredRecordShape = {};
    try {
      stored = JSON.parse(String(row.json)) as StoredRecordShape;
    } catch {
      stored = {};
    }
    const content = typeof stored.content === 'string' ? stored.content : '';
    const conditions = Array.isArray(stored.conditions) ? stored.conditions.filter((value): value is string => typeof value === 'string') : [];
    const trust = row.trust !== null && row.trust !== undefined
      ? String(row.trust)
      : typeof stored.trust === 'string' ? stored.trust : null;
    return {
      id: String(row.id),
      revision: Number(row.revision),
      claimHash: subjectClaimHash({ content, conditions }),
      content,
      conditions,
      trust,
      updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : '',
    };
  });
}
