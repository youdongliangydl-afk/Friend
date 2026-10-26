export type ComposerKeyAction = 'send' | 'newline' | 'none';
/** Legacy base mapping: Enter submits, any modifier inserts a newline. */
export function composerKeyAction(event: { key: string; isComposing?: boolean; keyCode?: number; repeat?: boolean; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }, composing = false): ComposerKeyAction {
  if (event.key !== 'Enter' || composing || event.isComposing || event.keyCode === 229 || event.repeat) return 'none';
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ? 'newline' : 'send';
}
/** Streaming queue semantics: Enter queues, ⌘/Ctrl+Enter appends as followUp, ⌘⇧/Ctrl+Shift+Enter steers. */
export type ComposerSubmitIntent = 'send' | 'queue' | 'followUp' | 'steer' | 'newline' | 'none';
export interface ComposerSubmitState { running?: boolean; hasContent?: boolean; composing?: boolean; member?: boolean }
export function composerSubmitIntent(event: { key: string; isComposing?: boolean; keyCode?: number; repeat?: boolean; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }, state: ComposerSubmitState = {}): ComposerSubmitIntent {
  if (event.key !== 'Enter' || state.composing || event.isComposing || event.keyCode === 229 || event.repeat) return 'none';
  const command = event.metaKey === true || event.ctrlKey === true;
  if (!command && (event.shiftKey === true || event.altKey === true)) return 'newline';
  if (state.hasContent === false) return 'none';
  if (state.member === true || state.running !== true) return 'send';
  return command ? (event.shiftKey === true ? 'steer' : 'followUp') : 'queue';
}
export function insertNewline(value: string, start: number, end: number) {
  return { value: value.slice(0, start) + '\n' + value.slice(end), caret: start + 1 };
}
