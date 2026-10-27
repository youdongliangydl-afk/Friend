import type { DurableEntryLike } from './durable-projection.js';
import { INPUT_BOUNDARY_KIND, RUNTIME_WAKE_KIND } from './durable-projection.js';

/**
 * Import gate for turning an existing Pi JSONL transcript into Pi Durable entries.
 *
 * Switching a session to the durable backend must not silently lose its history, and it must not
 * pretend a damaged file was imported. This converts what it understands, counts what it skips, and
 * lets the caller refuse the switch when anything was dropped.
 *
 * `branch_summary` has no Durable counterpart: Durable branches by forking a conversation rather
 * than recording a summary entry. Those rows are imported as an ordinary custom kind so the text
 * survives, and are reported separately so the caller can decide.
 */

/** One Pi JSONL entry, as `SessionManager` hands it to the worker. */
export interface PiJsonlEntryLike {
  readonly id?: string;
  readonly type?: string;
  readonly timestamp?: string;
  readonly customType?: string;
  readonly data?: unknown;
  readonly message?: unknown;
  readonly summary?: string;
  readonly content?: unknown;
  readonly details?: unknown;
}

export interface DurableImportDraft {
  readonly kind: string;
  readonly model?: readonly unknown[];
  readonly data?: unknown;
}

export interface DurableImportResult {
  readonly drafts: readonly DurableImportDraft[];
  /** Rows whose type has no safe mapping; the caller must treat a non-zero count as a refusal. */
  readonly skipped: readonly { index: number; type: string; id?: string }[];
  /** Branch summaries imported as custom entries because Durable has no equivalent entry kind. */
  readonly branchSummaries: number;
  /** Every entry id present more than once in the source file. */
  readonly duplicateIds: readonly string[];
}

const BRANCH_SUMMARY_KIND = 'friend-pi.branch-summary';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function roleKind(role: unknown): string | undefined {
  if (role === 'user') return 'pi.user';
  if (role === 'assistant') return 'pi.assistant';
  if (role === 'toolResult') return 'pi.tool-result';
  if (role === 'system') return 'pi.system';
  return undefined;
}

/**
 * Convert one Pi entry, or report why it cannot be converted.
 *
 * Untyped `custom_message` rows keep their payload under `data` because Durable entries have no
 * separate `content`/`details` channels; the shape is preserved well enough for provenance reads.
 */
export function piEntryToDurableDraft(entry: PiJsonlEntryLike): DurableImportDraft | undefined {
  const type = typeof entry.type === 'string' ? entry.type : '';
  if (type === 'message') {
    const message = record(entry.message);
    const kind = roleKind(message.role);
    if (kind === undefined) return undefined;
    return { kind, model: [entry.message] };
  }
  if (type === 'custom') {
    const kind = typeof entry.customType === 'string' && entry.customType ? entry.customType : undefined;
    if (kind === undefined) return undefined;
    return { kind, ...(entry.data === undefined ? {} : { data: entry.data }) };
  }
  if (type === 'custom_message') {
    const kind = typeof entry.customType === 'string' && entry.customType ? entry.customType : undefined;
    if (kind === undefined) return undefined;
    return { kind, data: { content: entry.content, details: entry.details } };
  }
  if (type === 'compaction') {
    return { kind: 'pi.compaction', data: { summary: typeof entry.summary === 'string' ? entry.summary : '' } };
  }
  if (type === 'branch_summary') {
    return { kind: BRANCH_SUMMARY_KIND, data: { summary: typeof entry.summary === 'string' ? entry.summary : '' } };
  }
  return undefined;
}

/**
 * Convert a whole transcript in file order.
 *
 * Order is preserved because Durable appends entries linearly; reordering would change which
 * message the model sees as most recent.
 */
export function piEntriesToDurableDrafts(entries: readonly PiJsonlEntryLike[]): DurableImportResult {
  const drafts: DurableImportDraft[] = [];
  const skipped: { index: number; type: string; id?: string }[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  let branchSummaries = 0;
  entries.forEach((entry, index) => {
    const id = typeof entry.id === 'string' ? entry.id : undefined;
    if (id !== undefined) {
      if (seen.has(id)) duplicates.add(id);
      else seen.add(id);
    }
    const draft = piEntryToDurableDraft(entry);
    if (draft === undefined) {
      skipped.push({ index, type: typeof entry.type === 'string' ? entry.type : '(missing)', ...(id === undefined ? {} : { id }) });
      return;
    }
    if (draft.kind === BRANCH_SUMMARY_KIND) branchSummaries += 1;
    drafts.push(draft);
  });
  return { drafts, skipped, branchSummaries, duplicateIds: [...duplicates] };
}

/** True when the transcript can be imported without losing anything the caller cares about. */
export function importIsLossless(result: DurableImportResult): boolean {
  return result.skipped.length === 0 && result.duplicateIds.length === 0;
}

/**
 * Kinds an imported entry may carry. Exposed so the worker can assert that its own custom markers
 * (`friend-pi.*`) survive the round trip instead of being reshape-shifted on the way in.
 */
export const IMPORTED_MARKER_KINDS = { inputBoundary: INPUT_BOUNDARY_KIND, runtimeWake: RUNTIME_WAKE_KIND } as const;

/** Round-trip check used by tests and by the import gate before it commits anything. */
export function draftToProjectionInput(draft: DurableImportDraft, id: string): DurableEntryLike {
  return { id, kind: draft.kind, ...(draft.model === undefined ? {} : { model: draft.model }), ...(draft.data === undefined ? {} : { data: draft.data }) };
}
