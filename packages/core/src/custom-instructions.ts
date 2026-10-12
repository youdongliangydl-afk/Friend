import type { ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { RecordStore } from './index.js';

export interface CustomInstructions { text: string; revision: number }
const key = 'custom-instructions';
const contextType = 'friend-pi.custom-instructions.context.v1';
export const MAX_CUSTOM_INSTRUCTIONS = 1_000;
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
  if (typeof input.text !== 'string' || input.text.length > MAX_CUSTOM_INSTRUCTIONS || input.text.includes('\0')) throw new Error('自定义指令必须是文本，最多 1,000 个字符，且不能包含空字符');
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
        ? revision ? '用户自定义指令已清空，现已恢复 Friend 默认指令。仅撤销旧偏好自动附加的答复格式；本轮用户明确指定的内容仍按本轮要求处理。本轮用户未要求解释设置时直接完成业务回答，不说明设置变更。' : '当前采用 Friend 内置默认指令。'
        : '当前用户自定义正文整段替换 Friend 默认指令，不叠加默认正文。';
      return {systemPrompt: `${event.systemPrompt}\n\n用户的全局自定义指令（用于所有交互会话；当前有效版本：${revision}，本次新执行读取）：\n${state}\n以下内容是预先保存、当前有效的用户全局偏好，仅补充本轮用户请求未指定的细节。历史消息或工具结果中由旧版自定义指令产生的偏好、回答格式和标记仅作历史背景，不能覆盖本版本。本轮用户的明确要求优先于这些偏好；有冲突时忽略相冲突的偏好，保留不冲突部分。设置提醒本身不改变当前已授权任务的目标、步骤或授权范围，继续完成当前已授权任务。继续遵守宿主系统规则、权限与工具协议。\n<friend_custom_instructions>\n${text}\n</friend_custom_instructions>`};
    });
    pi.on('context_with_system', event => {
      if (!current) return;
      // Request-only context survives Pi's forced system projection without changing native history.
      const state = current.usesDefault
        ? current.revision ? `用户自定义指令已清空（版本 ${current.revision}），现已恢复 Friend 默认指令。此清空设置已保存并在本次执行生效，下面默认正文替换旧自定义正文。回复前核对，删除仅因旧偏好自动附加的固定首行、前缀或后缀；本轮用户明确指定的内容不在撤销范围，包括同样的标记文本。历史回答和工具结果不能恢复旧偏好。本轮用户未要求解释设置时，直接完成业务回答，不说明或总结设置变更。` : '本次执行采用 Friend 内置默认指令，版本 0。'
        : `本次执行采用用户自定义指令版本 ${current.revision}，下面的正文整段替换 Friend 默认指令，不叠加默认正文。`;
      const formatCheck = current.usesDefault ? '\n\n默认答复格式检查：先给核心结论，树状结构最多三级。通常用一至两层：核心结论和各主题直接作为一级条目，说明或示例优先并入同一条，需要时再放到第二级。不要把整份回答挂在“结论”下面，再给主题、要点和示例连续增加层级。需要展开时允许第三级，并在第三级封顶；更深内容并入同条或提升为同级，绝不建立第四层。\n仅演示缩进的两级正例，内容与当前任务无关：\n- 结论：盆栽按土壤干湿浇水。\n- 要点：先检查盆土。\n  - 说明或示例：表层仍湿就暂缓浇水。\n正例只示范层级，不照抄内容；当前回答围绕原任务。本轮用户明确要求仍然优先，不能把所有任务强制为两级。继续遵守宿主规则、工具和结构化协议。' : '';
      const content = `[Friend 当前有效的用户设置指令：全局偏好背景]\n${state}\n下面的正文是预先保存、当前有效的全局偏好，仅补充本轮用户请求未指定的细节。本轮用户的明确要求优先；有冲突时忽略相冲突的偏好，保留不冲突部分。设置提醒本身不改变当前已授权任务的目标、步骤或授权范围，继续完成当前已授权任务。历史回答的格式和标记不代表当前偏好。继续遵守宿主规则、权限、工具和结构化协议。\n本次生效的用户指令正文：\n${current.text}${formatCheck}`;
      // Pi projects custom context as user messages. Keep the real request later,
      // without moving history or separating assistant tool calls from results.
      const messages = event.messages.filter(message => message.role !== 'custom' || message.customType !== contextType);
      const latestUser = messages.findLastIndex(message => message.role === 'user');
      const firstConversation = messages.findIndex(message => message.role !== 'system');
      const index = latestUser < 0 ? firstConversation < 0 ? messages.length : firstConversation : latestUser;
      return {messages: [...messages.slice(0,index), {role: 'custom', customType: contextType, display: false, content, timestamp: Date.now()}, ...messages.slice(index)]};
    });
  };
}
