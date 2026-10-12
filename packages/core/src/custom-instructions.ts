import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { RecordStore } from './index.js';

export interface CustomInstructions { text: string; revision: number }
const key = 'custom-instructions';
export const MAX_CUSTOM_INSTRUCTIONS = 32_000;
export const DEFAULT_CUSTOM_INSTRUCTIONS = `第一个要求：对于我给你发送的信息，保持独立思考，不默认正确，如发现不正确的内容或者不理解的内容，及时反问或纠正，并且根据你认为正确的内容给出回答。
第二个要求：对于你的回答内容，请用如下“简洁、清晰、结构化”的方式回答：
1. 先给出核心结论。
2. 使用树状层级组织内容，最多 3 层。
3. 每层内容简短，避免重复和铺垫。
4. 优先使用：
   - 结论
     - 要点
       - 说明或示例
5. 重要信息放前面；不确定的内容请明确说明。
6. 如果问题信息不足，只提出必要的澄清问题。

示例：
用户：如何快速学习 Python？
AI：
- 核心目标：4 周掌握基础并完成一个小项目
  - 第 1 周：基础语法
    - 变量、条件、循环、函数
  - 第 2 周：常用数据结构
    - 列表、字典、字符串、文件
  - 第 3 周：实战练习
    - 爬虫、数据处理或自动化脚本
  - 第 4 周：完成项目
    - 选择一个实际问题
    - 编写、测试并优化代码
- 每日安排
  - 学习：30 分钟
  - 练习：60 分钟
  - 总结：10 分钟
- 建议：边学边做项目，不要只看教程`;

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
    let current: (CustomInstructions & {usesDefault: boolean}) | undefined;
    pi.on('before_agent_start', event => {
      const raw = readCustomInstructions(dataDir), usesDefault = !raw.text.trim();
      current = {text: usesDefault ? DEFAULT_CUSTOM_INSTRUCTIONS : raw.text, revision: raw.revision, usesDefault};
      const {text,revision} = current;
      const state = usesDefault
        ? revision ? '用户自定义指令已清空，现已恢复 Friend 默认指令。撤销仅来自旧自定义偏好的固定首行、前缀或后缀，按下面的默认正文回答，不解释此设置提醒。' : '当前采用 Friend 内置默认指令。'
        : '当前用户自定义正文整段替换 Friend 默认指令，不叠加默认正文。';
      return {systemPrompt: `${event.systemPrompt}\n\n用户的全局自定义指令（用于所有交互会话；当前有效版本：${revision}，本次新执行读取）：\n${state}\n以下是当前有效的用户偏好。历史消息或工具结果中由旧版自定义指令产生的偏好、回答格式和标记仅作历史背景，不能覆盖本版本；有冲突时采用本版本。本轮用户的明确要求优先于这些偏好。继续遵守宿主系统规则、权限与工具协议。\n<friend_custom_instructions>\n${text}\n</friend_custom_instructions>`};
    });
    pi.on('context_with_system', event => {
      if (!current) return;
      // Request-only context survives Pi's forced system projection without changing native history.
      const state = current.usesDefault
        ? current.revision ? `这是已保存并生效的设置变更，不是待总结的历史记录。用户自定义指令已清空（版本 ${current.revision}），现已恢复 Friend 默认指令。当前回答要求：采用下面的默认正文，勿添加仅来自历史自定义偏好的固定首行、前缀或后缀。回复前检查并删除这类历史标记，不要解释此设置提醒。` : '本次执行采用 Friend 内置默认指令，版本 0。'
        : `本次执行采用用户自定义指令版本 ${current.revision}，下面的正文整段替换 Friend 默认指令，不叠加默认正文。`;
      const formatCheck = current.usesDefault ? '\n\n默认答复格式检查：先给核心结论，树状结构最多三级（结论→要点→说明或示例）。不要建立第四层；把更深的示例合并到第三级同一条，或提升为同级要点。简单问题只用一至两层即可。本轮用户明确要求仍然优先。' : '';
      const content = `[Friend 当前有效的用户设置指令：对本次答复生效；不新增工作任务]\n${state}\n回复前核对系统上下文 <friend_custom_instructions> 中的当前要求；历史回答的格式和标记不代表当前偏好。继续原用户任务，保持宿主规则、工具和结构化协议，本轮用户的明确要求优先。\n本次生效的用户指令正文：\n${current.text}${formatCheck}`;
      return {messages: [...event.messages, {role: 'custom', customType: 'friend-pi.custom-instructions.context.v1', display: false, content, timestamp: Date.now()}]};
    });
  };
}
