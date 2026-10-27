/**
 * Translation from Pi Durable agent events to the coding-agent style events the desktop worker
 * already consumes.
 *
 * The worker's subscription is written against Pi's session events, so this module is the only
 * place that knows both vocabularies. Two mappings are worth stating because they replace
 * assumptions made earlier:
 *
 * - `run_end` is the settle boundary (`agent_settled`). Durable does have a per-run terminal
 *   event, so settlement does not need to be inferred from idleness.
 * - `tool_execution_end` carries an entry only when the tool task actually produced a result.
 *   A faulted or orphaned tool call arrives without one, and that is the failure signal.
 */

/** The event subset the desktop worker handles today. */
export type PiWorkerEvent =
  | { type: 'agent_start' }
  | { type: 'agent_settled' }
  | { type: 'message_start'; message: unknown }
  | { type: 'message_end'; message: unknown }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: 'compaction_start'; reason?: string }
  | { type: 'compaction_end'; reason?: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** First model message of an entry, which is where Durable stores the conversational payload. */
function messageOf(entry: unknown): unknown {
  const model = record(entry).model;
  return Array.isArray(model) && model.length ? model[0] : undefined;
}

/**
 * Translate one Durable event. Returns `undefined` for events the worker has no use for
 * (`snapshot`, `turn_*`, `message_update`, `inbox_update`, `submission`, usage, …), so callers can
 * ignore them rather than growing a second parallel event vocabulary.
 */
export function translateAgentEvent(event: unknown): PiWorkerEvent | undefined {
  const source = record(event);
  switch (source.type) {
    case 'run_start':
      return { type: 'agent_start' };
    case 'run_end':
      return { type: 'agent_settled' };
    case 'message_start':
      return { type: 'message_start', message: source.message };
    case 'message_end': {
      const entry = record(source.entry);
      const message = messageOf(entry);
      return { type: 'message_end', message: message ?? entry };
    }
    case 'tool_execution_start':
      return {
        type: 'tool_execution_start',
        toolCallId: String(source.toolCallId ?? ''),
        toolName: String(source.toolName ?? ''),
        args: source.args,
      };
    case 'tool_execution_end': {
      const message = messageOf(source.entry);
      return {
        type: 'tool_execution_end',
        toolCallId: String(source.toolCallId ?? ''),
        toolName: String(source.toolName ?? ''),
        result: message === undefined ? undefined : record(message).content,
        // No entry means the task faulted or was orphaned; that is the only failure signal here.
        isError: source.entry === undefined,
      };
    }
    case 'compaction_start':
      return { type: 'compaction_start', ...(typeof source.reason === 'string' ? { reason: source.reason } : {}) };
    case 'compaction_end':
      return { type: 'compaction_end', ...(typeof source.reason === 'string' ? { reason: source.reason } : {}) };
    default:
      return undefined;
  }
}

/** Translate a batch, dropping events with no counterpart. */
export function translateAgentEvents(events: readonly unknown[]): PiWorkerEvent[] {
  const translated: PiWorkerEvent[] = [];
  for (const event of events) {
    const mapped = translateAgentEvent(event);
    if (mapped !== undefined) translated.push(mapped);
  }
  return translated;
}
