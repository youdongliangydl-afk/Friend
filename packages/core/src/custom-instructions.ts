import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { RecordStore } from './index.js';

export interface CustomInstructions { text: string; revision: number }
const key = 'custom-instructions';
export const MAX_CUSTOM_INSTRUCTIONS = 32_000;

export function readCustomInstructions(dataDir: string): CustomInstructions {
  const store = new RecordStore('desktop', dataDir);
  try {
    const row = store.get<{text:string}>(key);
    return {text: row?.value.text || '', revision: row?.revision || 0};
  } finally { store.close(); }
}

export function saveCustomInstructions(dataDir: string, input: Record<string, unknown>): CustomInstructions {
  if (typeof input.text !== 'string' || input.text.length > MAX_CUSTOM_INSTRUCTIONS || input.text.includes('\0')) throw new Error('自定义指令必须是文本，最多 32,000 个字符，且不能包含空字符');
  if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0) throw new Error('自定义指令版本无效，请重新读取');
  const store = new RecordStore('desktop', dataDir);
  try {
    return store.transaction(() => {
      const current = store.get<{text:string}>(key);
      if ((current?.revision || 0) !== input.revision) throw new Error('自定义指令已在其他窗口更新，请重新读取后再保存；当前草稿已保留');
      const row = store.put(key, {text: input.text as string}, current?.revision ?? null);
      return {text: row.value.text, revision: row.revision};
    });
  } finally { store.close(); }
}

/** Pi rebuilds the prompt for each new execution; never modify its native history. */
export function customInstructionsExtension(dataDir: string): ExtensionFactory {
  return pi => {
    pi.on('before_agent_start', event => {
      const {text} = readCustomInstructions(dataDir);
      if (!text.trim()) return;
      return {systemPrompt: `${event.systemPrompt}\n\n用户的全局自定义指令（用于所有交互会话）：\n以下是用户偏好；遵守宿主系统规则、权限与工具协议，本轮用户的明确要求优先于这些偏好。\n<friend_custom_instructions>\n${text}\n</friend_custom_instructions>`};
    });
  };
}
