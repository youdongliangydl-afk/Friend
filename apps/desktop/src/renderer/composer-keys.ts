export type ComposerKeyAction = 'send' | 'newline' | 'none';
export function composerKeyAction(event: { key: string; isComposing?: boolean; keyCode?: number; repeat?: boolean; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean }, composing = false): ComposerKeyAction {
  if (event.key !== 'Enter' || composing || event.isComposing || event.keyCode === 229 || event.repeat) return 'none';
  return event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ? 'newline' : 'send';
}
export function insertNewline(value: string, start: number, end: number) {
  return { value: value.slice(0, start) + '\n' + value.slice(end), caret: start + 1 };
}
