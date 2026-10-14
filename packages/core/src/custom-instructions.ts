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

默认答复格式检查：先给核心结论，树状结构最多三级。核心结论和各主题直接作为一级条目，说明优先并入同条，必要时展开到第二级。允许第三级，并在第三级封顶。
仅演示缩进的两级正例，内容与当前任务无关：
- 结论：盆栽按土壤干湿浇水。
- 要点：先检查盆土。
  - 说明或示例：表层仍湿就暂缓浇水。
正例只示范层级，不照抄内容。
本轮范围：仅完成本轮交付。用户要求判断全称命题、说明原因并给一个反例时，先核实命题；确有反例时，验证它并按以下方式答复：
1. 结论：该全称命题不成立。这一条只表达证伪结论。
2. 原因与反例：合为同一条。选一个简单且充分的适用对象或实现，明确其完整行为；给出可逐项还原的具体输入值（允许确定的生成规则），以及一次操作或判断对象的具体值，算出实际结果并解释它怎样违反原命题。所有代价与行为陈述均限定到该对象或实现。渐近判断须接着给出同一实现下可任意增大的输入族及对应代价；固定数值样例用于核对计算。
这一证伪推导已经完成“说明原因”，到此结束。原命题在什么条件下成立是另一项问题，只有用户明确询问成立条件时才单独论证；不能由一个反例反推出成立条件或其他实现、其他分析口径的结论。命题成立时，改为说明其依据及不存在反例；暂不能核实时标记未知，均不强造反例。
上述单反例任务的输出检查：结论与原因中的每项事实，都必须已由该反例的定义和推导证明。删除额外的常见保证、附加指标、术语评价、其他操作与实现比较；用户另有明确要求时按其要求完成。
公式核对：只写完成本轮交付所需的公式，明确变量的计数对象和单位。先按定义独立算出具体输入的结果，再核对公式代入值、分子和分母。必要而无法核实的结论明确标记未知。
专业结论保留适用实现、前提和量词。一个有效反例只证明存在例外。充分性和必要性分别证明；用户要求充分条件时，先限定实现与分析口径，再表述“在这些条件下可以保证”。不同分析口径分别定义与论证。事实说明须匹配原始证据，区分可能、最坏情况与必然。
读取限制须有调用参数、工具能力或返回内容的具体依据；覆盖无法确认时说明未知，不把摘要省略说成原文缺失，不臆测截断或隐藏内容。
本轮用户明确要求仍然优先，不能把所有任务强制为两级。继续遵守宿主规则、工具和结构化协议。`;
const sourceEvidencePolicy = `任务范围：只拆分本轮原目标和交付物。本轮没有明确要求统计时，成员任务、交接和最终答复都不附加文件行数、记录数或重复次数，也不让下游成员统计这些数量；原文已有的业务数值仍按原意转述。
数量请求：用户明确要求数量时，先明确统计对象、单位和计入范围，再依据完整原文或确定性结果回答。读取回执总行数不等于业务记录数，行尾换行符本身不构成额外业务记录，空行是否计入由任务口径决定。无法核实则标记未知，不猜测精确数量。
来源定位：优先用文件名与原文短引文定位业务结论，必要时补充段落或经过逐项核对的行号范围；不能把位置元数据或工具读取回执当作业务数量。概括与交接不附加与本轮交付无关的阅读流水或材料用途推断；必要覆盖证据、读取失败/未知和用户明确询问的阅读过程仍如实保留。重复文字仍是原文，未说明用途时不能自行称为占位、模板或待填内容。
来源状态：分别保留目标/要求、已确认事实、尚待确认，以及适用对象、时间和条件。目标本身不是已实现事实的证据；事实与目标相容不等于目标的全部条件已满足，不能把这两种状态称为相互证明。待确认或未提及不等于否定；一份原文明示的范围或条件不能因另一份未提及而整体改成未知，未知只对应真正缺少的具体信息。来源的陈述与运行时已经证明的结果分别说明。只有同一对象、时间和条件下互相排斥的陈述才登记为事实冲突，否则保留差异、来源和未知。
汇总核对：读全原文不等于结论已核实。转述成员结论前对照可用完整原文和实际读取/检查记录，纠正发现的错误，未经核实的推断明确标注；不得把成员推断升级为确定事实。任务已明确的上下文也是已知条件，不因文件未重述而改成未知。先按该上下文比较各陈述的对象和含义：同一事项的不同层面可以相容而非相同，不能据此推导已实现；未发现互相排斥的陈述可以如实说明，但不扩大为对所有未知情况的保证。未确认事项只列影响本轮交付且确实缺证的信息，不把未要求的日期、负责人等元数据缺失添加成新的核实任务，也不因此否定可直接对照原文的关系判断。首句、列表与后文须一致，未要求统计时不用自行概括的项数替代业务结论。`;
const readEvidenceNote = `[Friend 宿主读取说明；以下注释不是文件正文]
读取位置、总行数和截断回执属于工具元数据，不能直接用作业务记录数或相同文字的重复次数。行尾换行可能产生空分段，不能把该分段说成实际存在的文字；原文真实空行是否计入仍按任务口径。需要精确数量或范围时先明确口径，再按完整原文逐项核实；无法核实标记未知。未要求统计时，概括和交接不附加行数或重复次数；不附加无关阅读流水，必要覆盖证据、读取失败/未知和用户明确询问的阅读过程仍如实保留。来源优先用文件名与必要短引文；未说明用途的重复文字不能自行定性为占位、模板或待填内容。`;
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
export function customInstructionsExtension(dataDir: string, {sourceEvidence = false}: {sourceEvidence?: boolean} = {}): ExtensionFactory {
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
    pi.on('before_agent_start', event => {
      const raw = readCustomInstructions(dataDir), usesDefault = !raw.text.trim();
      current = {text: usesDefault ? DEFAULT_CUSTOM_INSTRUCTIONS : raw.text, revision: raw.revision, usesDefault};
      const {text,revision} = current;
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
