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
    let current: CustomInstructions | undefined;
    pi.on('before_agent_start', event => {
      current = readCustomInstructions(dataDir);
      const {text,revision} = current;
      if (!text.trim()) {
        if (!revision) return;
        return {systemPrompt: `${event.systemPrompt}\n\n全局自定义指令状态（本次新执行读取，版本 ${revision}）：当前未设置全局自定义指令。历史中来自旧版自定义指令的偏好、回答格式或标记不再作为当前要求；本轮用户要求与宿主规则继续适用。`};
      }
      return {systemPrompt: `${event.systemPrompt}\n\n用户的全局自定义指令（用于所有交互会话；当前有效版本：${revision}，本次新执行读取）：\n以下是当前有效的用户偏好。历史消息或工具结果中由旧版自定义指令产生的偏好、回答格式和标记仅作历史背景，不能覆盖本版本；有冲突时采用本版本。本轮用户的明确要求优先于这些偏好。继续遵守宿主系统规则、权限与工具协议。\n<friend_custom_instructions>\n${text}\n</friend_custom_instructions>`};
    });
    pi.on('context_with_system', event => {
      if (!current?.revision) return;
      // Request-only context survives Pi's forced system projection without changing native history.
      const content = current.text.trim()
        ? `[Friend 用户设置上下文，非新聊天任务]\n本次执行采用全局自定义指令版本 ${current.revision}。回复前核对系统上下文 <friend_custom_instructions> 中的当前要求；历史回答的格式和标记不代表当前偏好。继续原用户任务，保持工具和结构化协议，本轮用户明确要求优先。\n本次生效的用户指令正文：\n${current.text}`
        : `[Friend 用户设置上下文，非新聊天任务]\n本次执行的全局自定义指令已清空（版本 ${current.revision}）。不要继续采用历史中由旧版指令产生的回答格式或标记；按本轮用户要求继续原任务，保持工具和结构化协议。`;
      return {messages: [...event.messages, {role: 'custom', customType: 'friend-pi.custom-instructions.context.v1', display: false, content, timestamp: Date.now()}]};
    });
  };
}
