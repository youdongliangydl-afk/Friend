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
反例构造检查：选择隐含前提最少的操作。结果若依赖位置、顺序或初始状态，须先定义该状态怎样由给定输入和实现规则构造出来；否则改选对这些允许状态都得出同样结果的操作。把结果的每一步对应到已定义规则，不能在结果句里临时假定一个位置或顺序。求值还须说明决定结果的分支与停止条件。
这一证伪推导已经完成“说明原因”，到此结束。原命题在什么条件下成立是另一项问题，只有用户明确询问成立条件时才单独论证；不能由一个反例反推出成立条件或其他实现、其他分析口径的结论。命题成立时，改为说明其依据及不存在反例；暂不能核实时标记未知，均不强造反例。
上述确有反例的证伪答复检查：结论与原因中的每项事实，都必须已由该反例的定义和推导证明。删除额外的常见保证、附加指标、术语评价、其他操作与实现比较；用户另有明确要求时按其要求完成。
公式核对：只写完成本轮交付所需的公式，明确变量的计数对象和单位。先按定义独立算出具体输入的结果，再核对公式代入值、分子和分母。必要而无法核实的结论明确标记未知。
专业结论保留适用实现、前提和量词。一个有效反例只证明存在例外。充分性和必要性分别证明；用户要求充分条件时，先限定实现与分析口径，再表述“在这些条件下可以保证”。不同分析口径分别定义与论证。事实说明须匹配原始证据，区分可能、最坏情况与必然。
读取限制须有调用参数、工具能力或返回内容的具体依据；覆盖无法确认时说明未知，不把摘要省略说成原文缺失，不臆测截断或隐藏内容。
本轮用户明确要求仍然优先，不能把所有任务强制为两级。继续遵守宿主规则、工具和结构化协议。`;
const sourceEvidencePolicy = `本轮交付：主会话、成员任务与交接均围绕用户当前要求。先核对执行边界，再请求工具；等待和辅助操作同样受限。等待成员使用允许的协调接口。被拒绝的请求如实说明为尝试被拦截，分别记录请求、执行和结果。
事实核对：先提取与本轮交付相关的命题，再逐项对照可用原文、完整成员交接和实际读取/检查回执。每项保留适用对象、时间、条件，以及目标/要求、已确认、尚待确认的状态。来源所说的完成与运行时证明的完成分别表述，转述成员推断时保留推断性质并纠正已发现的错误。
比较来源：一致点需要两份来源支持同一命题，逐一列出对应来源。不同对象或不同层面的陈述即使相容，也分别归于各自来源，不能称为共同确认或相互佐证。只有同一对象、时间和条件下互相排斥的陈述才算冲突；无冲突只说明相容。目标/要求与实现状态分别保留。
未确认事项：保留来源明示的待确认命题；其他未知只列回答本轮问题所必需且确实缺证的具体命题。风险须有具体原文或实际读取/检查记录支持。完整概括的汇总可以依赖完整交接，说明来源即可；未亲自重读本身不是覆盖缺口。未提及的材料用途、规格和元数据不自动成为新任务；重复文字按原意保留，不推断其他正文或用途。
数量与来源：用户明确要求数量时，先明确统计对象、单位和计入范围，再依据完整原文或确定性结果计算；工具位置和行尾分段不能直接充当业务数量，无法核实则标记未知。未要求统计时，分派、交接和答复省去新增计数及其口径说明，原文业务数值按原意保留。用文件名和必要短引文定位结论；只报告影响结论的读取失败或覆盖限制，其他阅读流水和规则遵守说明省去。`;
const readEvidenceNote = `[Friend 宿主读取说明；以下注释不是文件正文]
以上各内容块保留工具返回的原文。只按原用户交付提取业务命题，区分目标、事实和待确认。原用户未要求统计时，省去行数、重复次数及计数口径，读取位置回执不能充当业务数量。未说明用途的重复文字按字面保留，不自行定性为占位、模板或待填内容。只说明影响本轮结论的真实读取限制；未提及的惯常章节、其他版本或材料用途不自动成为缺口。来源用文件名与必要短引文定位，本说明不进入业务概括或交接。`;
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
