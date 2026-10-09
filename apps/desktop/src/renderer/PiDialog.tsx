import {useState} from 'react';
import {Modal,Field} from './ui.js';
import type {DialogRequest,JsonObject} from './types.js';
export function PiDialog({ dialog, respond }: { dialog: DialogRequest; respond(value: JsonObject): void }) {
  const [value, setValue] = useState(dialog.prefill || dialog.options?.[0] || '');
  return <Modal title={dialog.title} onClose={() => respond({ cancelled: true })}><form onSubmit={event => { event.preventDefault(); respond(dialog.kind === 'confirm' ? { confirmed: true } : { value }); }}>{dialog.message && <p className="dialog-message">{dialog.message}</p>}{dialog.kind === 'select' ? <Field label="选择"><select value={value} onChange={event => setValue(event.target.value)}>{dialog.options?.map(option => <option value={option} key={option}>{option}</option>)}</select></Field> : dialog.kind === 'input' ? <Field label="输入"><input value={value} onChange={event => setValue(event.target.value)} /></Field> : dialog.kind === 'editor' ? <Field label="编辑内容"><textarea rows={9} value={value} onChange={event => setValue(event.target.value)} /></Field> : null}<div className="button-row right"><button type="button" onClick={() => respond({ cancelled: true })}>取消</button><button className="primary" type="submit">{dialog.kind === 'confirm' ? '允许此操作' : '确认'}</button></div></form></Modal>;
}

