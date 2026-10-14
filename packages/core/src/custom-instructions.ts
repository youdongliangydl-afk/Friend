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
const defaultResponseGuard = `

默认答复格式检查：遵循默认正文的整体风格，先给核心结论，再作简洁说明；本轮明确要求优先。示例不作为当前任务的必填栏目。
本轮范围：只完成本轮要求。用户只要一个反例时只给一个，不附加成立条件、其他实现比较或额外的统计与风险栏目。
反例应明确适用对象或实现的完整行为、具体输入、一次操作、初始状态和量词。按这些定义逐步求值，说明结果怎样违反原命题；不能在结论中临时增添位置、顺序或行为假设。
反例内部自检：从已定义的状态执行到真实的停止条件。存在提前停止时，以实际到达的停止点计算步骤；结构总大小或最大循环次数不等于本次操作的实际访问次数。顺序或状态尚未固定时，先分别还原两种允许状态下的同一次操作；结果不同就固定其中一种状态并明确构造，或改选结果不变的操作，不能仅宣称“与顺序无关”。内部校验不增加用户未要求的答复栏目。
渐近判断应给出同一实现下可任意增大的输入族及对应代价；固定数值样例仅核对计算。一个有效反例只证明存在例外，不推出其他输入或操作也必然产生相同结果；无法验证时标记未知，不强造反例。
公式按定义核对具体输入，明确计数对象、单位、分子与分母。专业结论保留适用实现、前提和量词。充分条件与必要条件分别论证；只在已验证的前提下表述“在这些条件下可以保证”。事实说明须匹配原始证据，区分可能、最坏情况与必然。
读取限制须有调用参数、工具能力或返回内容的具体依据；覆盖无法确认时说明未知，不把摘要省略说成原文缺失，不臆测截断或隐藏内容。
继续遵守宿主规则、权限、工具和结构化协议。`;
const sourceEvidencePolicy = `主会话、Team／Swarm 成员及交接均以原用户本轮请求为交付边界。委派只拆解目标、输入、权限、依赖和必要验收，不新增用户未要求的统计、审计或答复栏目。直接回答问题，保留必要的文件名和短引文。
依据完整原文或完整交接概括，保留陈述的对象、属性、时点、状态和量词。目标与计划不写成完成事实；不同来源的相容陈述分别归属，只有各来源对同一业务命题均有依据才称共同确认。重复文字可合并表达，但不能据其重复形式推断用途、判作占位内容或改写原意。
未知仅指来源明确待确认的事项，或回答本轮具体问题必需而缺失的证据。原文没有列出的额外问题不补作未知，空栏目省略。完整交接可以支持汇总，未亲自重读不构成覆盖缺口；必要复核若只读了片段，须继续读取才能对未见部分作判断。读取限制只在有具体依据且影响本轮结论时报告。
仅在原用户明确要求数量时新增统计：先定义对象、单位和计入范围，再按完整原文或确定性结果计算；无法核实则标记未知。保留原文业务数值，不把去重条目、工具位置或行尾分段当作正文数量。
最终发出前逐句核对：它是否回答本轮问题，是否有原文或已核实结果支持。删除无依据的数量、用途和风险推断，以及未要求的文档结构、阅读过程、角色状态与遵规声明。以上不改变权限、完整交接和独立复核协议。`;
const readEvidenceNote = `[Friend 宿主读取说明；以下注释不是文件正文]
以上内容块保留工具原文；本注释不进入业务概括或交接。按原用户问题提取结论和必要来源，重复文字按字面理解，不推断用途或判作占位内容。空栏目省略，不新增未要求的数量、未知事项或阅读过程。若需要判断未返回的正文，按工具续读提示读完后再判断，不从片段推断全文。`;
const instructionPolicy = '以下正文是当前有效的全局偏好，仅补充本轮未指定的细节；本轮用户的明确要求优先，冲突时只忽略冲突部分。历史中已被本次有效版本替换的旧自定义指令，不再作为当前开头、结尾或格式要求。历史回答、成员结果和工具输出中的惯用格式不是当前格式要求；转述时遵循本轮明确要求和当前有效正文。只有当前有效正文或本轮明确要求指定固定开头、结尾或标记时才使用，并逐字遵循指定内容；不能根据历史样式、任务名称或轮次自行推断、递增或创造新的标记。未指定标记时直接回答业务内容。旧答复不追溯重排，事实错误仍应纠正。设置提醒本身不改变已授权任务的目标、步骤或授权范围；继续完成任务，并遵守宿主规则、权限、工具和结构化协议。';

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

/** Pi owns execution/history; preference reminders remain request-only. */
export function customInstructionsExtension(dataDir: string, {sourceEvidence = false, executionId}: {sourceEvidence?: boolean; executionId?: () => string | undefined} = {}): ExtensionFactory {
  const hostPolicy = sourceEvidence ? `宿主事实与来源规则（不属于用户自定义正文；继续遵守工具、权限和结构化协议）：\n<friend_source_evidence>\n${sourceEvidencePolicy}\n</friend_source_evidence>\n` : '';
  return pi => {
    const readNotes = new WeakSet<object>();
    if (sourceEvidence) pi.on('tool_result', event => {
      // Pi's downstream merge treats null structuredContent as absent when content changes.
      if (event.toolName !== 'read' || event.isError || event.structuredContent === null || !event.content.length || event.content.some(part => part.type !== 'text')) return;
      if (event.content.some(part => readNotes.has(part))) return;
      // Append a separately labelled host note through Pi's public result hook.
      // Preserve every original part and structured result; never rewrite source text.
      const note = {type: 'text' as const, text: readEvidenceNote};
      readNotes.add(note);
      return {content: [...event.content, note], ...(event.structuredContent === undefined ? {} : {structuredContent: event.structuredContent})};
    });
    let current: (CustomInstructions & {usesDefault: boolean}) | undefined;
    let owner: string | undefined;
    pi.on('before_agent_start', event => {
      const id = executionId?.();
      if (!current || !id || owner !== id) {
        const raw = readCustomInstructions(dataDir), usesDefault = !raw.text.trim();
        current = {text: usesDefault ? DEFAULT_CUSTOM_INSTRUCTIONS : raw.text, revision: raw.revision, usesDefault};
        owner = id;
      }
      const {text,revision,usesDefault} = current;
      const state = usesDefault
        ? `本次采用 Friend 默认指令，版本 ${revision}。本轮未询问设置时，答复仅围绕本轮业务。`
        : '当前用户自定义正文整段替换 Friend 默认指令，不叠加默认正文。';
      return {systemPrompt: `${event.systemPrompt}\n\n用户的全局自定义指令（用于所有交互会话；当前有效版本：${revision}，本次新执行读取）：\n${state}\n${instructionPolicy}\n<friend_custom_instructions>\n${text}\n</friend_custom_instructions>${hostPolicy ? '\n\n'+hostPolicy : ''}${usesDefault ? defaultResponseGuard : ''}`};
    });
    pi.on('context_with_system', event => {
      if (!current) return;
      // Request-only context survives Pi's forced system projection without changing native history.
      const state = current.usesDefault
        ? `本次采用 Friend 默认指令，版本 ${current.revision}。本轮未询问设置时，答复仅围绕本轮业务。`
        : `本次执行采用用户自定义指令版本 ${current.revision}，下面的正文整段替换 Friend 默认指令，不叠加默认正文。`;
      const content = `[Friend 当前有效的用户设置指令：全局偏好背景]\n${state}\n${instructionPolicy}\n本次生效的用户指令正文：\n${current.text}${hostPolicy ? '\n\n'+hostPolicy : ''}${current.usesDefault ? defaultResponseGuard : ''}`;
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
