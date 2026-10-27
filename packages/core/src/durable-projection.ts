import { createHash } from 'node:crypto';
import type { HistoryItem } from './index.js';

/**
 * Projection from Pi Durable entry records onto the `HistoryItem` shape the memory, expert and
 * topic-rebuild lines already consume.
 *
 * Why this exists: those three lines read `HistoryItem`, which was modelled on Pi's JSONL entry
 * schema (`type`/`customType`/`message.role`/`parentId`/`summary`). Durable's `EntryRecord` is
 * `{id, kind, model?, data?, head?}`, so switching the execution backend must not be allowed to
 * reach them. Everything is translated here and nowhere else.
 *
 * Deliberate limitations, kept visible rather than silently absorbed:
 * - `parentId` has no Durable counterpart. Durable branches by forking a conversation that
 *   references its parent; entries inside one conversation are a linear append log. Callers that
 *   need branch shape must use the conversation ancestry, not this field.
 * - An entry carries no timestamp of its own; it comes from the first model message, then
 *   `data.timestamp`, otherwise it is empty.
 */

/** Pi entry type a Durable entry reports as, so downstream `type` checks keep working. */
const MESSAGE_KINDS: Record<string, true> = {
  'pi.user': true,
  'pi.assistant': true,
  'pi.system': true,
  'pi.tool-result': true,
};

/** Boundary marker written by input tracking; a `custom` entry on Pi, a kind here. */
export const INPUT_BOUNDARY_KIND = 'friend-pi.input.v1';
/** Automatic-turn marker; a matching content digest marks the row as a custom row. */
export const RUNTIME_WAKE_KIND = 'friend-pi.runtime-wake.input';

export interface DurableEntryLike {
  /** Durable brands entry ids (numeric at runtime); callers pass them through unchanged. */
  readonly id: string | number;
  readonly kind: string;
  readonly model?: readonly unknown[];
  readonly data?: unknown;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value
      .map(part => (object(part).type === 'text' && typeof object(part).text === 'string' ? String(object(part).text) : ''))
      .filter(Boolean)
      .join('\n');
  return '';
}

/** Same algorithm as core's `digest`, duplicated here to avoid a module cycle with `index.ts`. */
function digestOf(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Pi entry type a Durable entry reports as, so downstream `type` checks keep working. */
export function historyTypeOf(kind: string): string {
  if (MESSAGE_KINDS[kind]) return 'message';
  if (kind === 'pi.compaction') return 'compaction';
  return 'custom';
}

/**
 * Translate Durable entries into the `HistoryItem` list the three provenance lines consume.
 *
 * `automatic` and `boundaries` mirror Pi's two custom markers: a runtime wake entry whose content
 * digest matches marks the row as `custom`, and an input boundary records the verified prefix of
 * user text so `userText` stays trustworthy rather than being re-derived from prose.
 */
export function durableHistoryItems(entries: readonly DurableEntryLike[]): HistoryItem[] {
  const automatic = new Map<string, string>();
  const boundaries = new Map<string, { textEnd: number; hash: string }>();
  for (const entry of entries) {
    if (!entry.data) continue;
    const data = object(entry.data);
    if (entry.kind === RUNTIME_WAKE_KIND) automatic.set(String(data.entryId), String(data.hash));
    if (entry.kind === INPUT_BOUNDARY_KIND) boundaries.set(String(data.entryId), { textEnd: Number(data.textEnd), hash: String(data.hash) });
  }
  return entries.map(entry => {
    const message = Array.isArray(entry.model) && entry.model.length ? object(entry.model[0]) : undefined;
    const data = object(entry.data);
    const value =
      message !== undefined
        ? text(message.content)
        : entry.kind === 'pi.compaction'
          ? String(data.summary ?? '')
          : typeof data.text === 'string'
            ? data.text
            : '';
    const boundary = boundaries.get(String(entry.id));
    const userText =
      boundary && digestOf(value.slice(0, boundary.textEnd)) === boundary.hash ? value.slice(0, boundary.textEnd) : undefined;
    const timestamp =
      message && typeof message.timestamp === 'number'
        ? new Date(message.timestamp).toISOString()
        : typeof data.timestamp === 'string'
          ? data.timestamp
          : '';
    return {
      id: String(entry.id),
      // Durable appends entries in order; there is no per-entry parent link.
      parentId: null,
      type: historyTypeOf(entry.kind),
      timestamp,
      role: automatic.get(String(entry.id)) === digestOf(value) ? 'custom' : message && typeof message.role === 'string' ? message.role : undefined,
      text: value,
      userText,
      ...(message && typeof message.toolName === 'string' ? { toolName: message.toolName } : {}),
      ...(typeof data.sourceKind === 'string' ? { sourceKind: data.sourceKind } : {}),
    };
  });
}
