#!/usr/bin/env python3
"""Build the implementation appendix only; the historical research book is immutable."""
import html
import json
import textwrap
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
OLD = ROOT / 'docs/research/2026-10-07-friend-pi-evolution/planning-data.json'
BASELINE = {x['id']: x for x in json.loads(OLD.read_text())['points']}
SOURCE_LEDGER = json.loads((ROOT / 'docs/sources.json').read_text())
SOURCES = {x['name']: x for x in SOURCE_LEDGER['sources']}
PI_SHA = SOURCES['Pi']['commit']

POINTS = [
 dict(id='01',title='等待真实终止回执，再显示停止',
 before='宿主客观检查不在原 Swarm 取消链中：stop 已返回 stopped，延迟检查仍可继续写文件。旧稿回填风险没有本轮 GUI 复现，不能同列为确认缺陷。',
 after=['一次停止覆盖成员、Git/隔离操作、客观检查和独立复核；拥有进程组的子进程等待 close 收据，晚到结果不再采用。','正在停止与已终止、现场未知分开。未知对象保留现场并暂停，显式检查后才能新尝试；冷恢复不自动重放副作用。','设置中的任务详情可展开停止回执；工作台只呈现当前 DAG、暂停和停止。'],
 boundary='停止不能撤销已经发生的写入、网络请求等外部效果。完整操作对象的终止与未知副作用是两种不同证据。',
 check='本次 Swarm/Expert 62/62 的针对性测试包含真实本地延迟检查及子进程、复核、隔离 Git 取消、晚到结果、跨进程冷恢复；最终 macOS 点击停止的证据由根 Agent 单列。',
 refs=[('packages/swarm/src/managed.ts','export'),('packages/swarm/src/index.ts','stopReceipt'),('apps/desktop/src/renderer/panels.tsx','停止回执')],
 tests=['packages/swarm/test/evolution.test.ts','tests/sdk-worker.test.ts'],
 viz=dict(side0='已停止 ✓',side1='正在停止…',center0=['停止按钮已返回','延迟检查仍可能写入'],center1=['成员 / 检查 / Git / 复核','等待 close，拒收晚到结果'],panel0=['停止状态早于真实终止','检查未在取消所有权内'],panel1=['设置 · 任务诊断','已终止 / 现场未知','保留原工作区'],flow0=['stop','stopped','仍在写'],flow1=['stop','stopping','收据 / 暂停'])),
 dict(id='02',title='原始历史缺失时保留身份和索引',
 before='已登记的 Pi JSONL 缺失时传入 undefined，可能建立新历史并重写原会话索引。旧文件是否被删除并未得到证明。',
 after=['区分新建空会话和恢复会话。恢复前校验路径、JSONL 头部/条目链、原生会话及项目身份，失败不建替代历史。','会话菜单“重新定位原始历史”连接宿主 session.relocate，选择原 JSONL 后由 SDK 校验完整条目链、原 Pi 身份及项目目录；恢复失败仍保留旧索引。新建会话是另一身份。','生产新建空会话写入真实 Pi 头部和自定义条目链，冷重启可继续读取，不伪造聊天消息。'],
 boundary='SQLite 只维护索引和业务记录；不存另一份权威聊天全文。不自动推断历史损坏后可以重放任何工具。',
 check='desktop-lifecycle 的缺史保护/空会话冷恢复测试和 sdk-worker 的空会话原生恢复测试对应这些路径。全量结果与真实重定位旅程查看根验收记录。',
 refs=[('apps/desktop/src/main.ts','原始会话历史缺失'),('apps/desktop/src/sdk-worker.ts','原始历史条目损坏'),('apps/desktop/src/renderer/App.tsx','重新定位原始历史')],
 tests=['tests/desktop-lifecycle.test.ts','tests/sdk-worker.test.ts'],
 viz=dict(side0='原会话',side1='原会话保留',center0=['原 JSONL 不可用','新空历史成为原会话入口'],center1=['恢复校验失败 → 明确错误','原身份与索引保持'],panel0=['缺失历史被当作新建','入口可能静默改写'],panel1=['会话菜单 · 重新定位','完整 JSONL / Pi 身份','另建 = 新会话身份'],flow0=['缺史','新建','改索引'],flow1=['缺史','阻止替代','定位原史'])),
 dict(id='03',title='原生消息完整投影与可读工具过程',
 before='本轮流式工具过程已有，但冷恢复 DTO 只保留 role/text/id，图片、thinking、工具名/参数/结果关联丢失。Markdown 直接显示语法。',
 after=['当前与冷恢复都从 Pi 原生条目投影图片、思考块、toolCallId、参数、结果和错误；不另存聊天权威。','安全 Markdown 展示表格、列表、链接、代码。工具过程可折叠，输入和输出按同一个 toolCallId 关联。','原始用户输入边界绑定条目和 hash，附加的文件材料不会混进轮次原文预览。'],
 boundary='工具内容和网页文本仍是数据；安全链接限制协议，文件解析遵守项目边界。原生消息结构不能成为执行 HTML 的理由。',
 check='evolution-runtime 冷投影测试覆盖图片/思考/工具身份与用户原文边界；同源 renderer 的实际宽窄界面阅读由根 Computer Use 验证。',
 refs=[('apps/desktop/src/message-projection.ts','projectMessages'),('apps/desktop/src/renderer/ui.tsx','Markdown'),('apps/desktop/src/sdk-worker.ts','projectMessages(entries)')],
 tests=['tests/evolution-runtime.test.ts','tests/sdk-worker.test.ts'],
 viz=dict(side0='历史会话',side1='历史会话',center0=['| 文件 | 状态 |','read 结果仅剩文本'],center1=['可读表格 / 代码 / 图片','read#call-1 → 对应原输出'],panel0=['原史有结构','冷投影没有保留结构'],panel1=['同一 Pi JSONL','图片 / 思考 / 工具块','当前和冷恢复共用投影'],flow0=['原条目','text','关联丢失'],flow1=['原条目','完整投影','折叠过程'])),
 dict(id='04',title='四种范围的完整 Git 变更与双栏 Diff',
 before='只读 git diff HEAD 漏掉未跟踪的新文件；文件可预览时 Diff 仍显示没有改动。',
 after=['只读 Git status 的 NUL 分隔清单涵盖已跟踪、未跟踪、删除、重命名及文件模式；二进制/大文件明确标记。未跟踪文件显示新增内容，不自动 git add。','只实现已批准的工作区、未暂存、已暂存、本轮期间四种范围；按文件折叠，行内/双栏、行号和增删色展示。','本轮保存启动基线，缺基线或 HEAD 变化明确不可用。期间净变化包括同期外部编辑，不能宣称全由 Agent 产生。'],
 boundary='Codex 公共仓库包含 Rust Git 采集、diffy/TUI 展示和 turn-diff 追踪，没有开源桌面 React Diff。这里是参考其语义后的 Friend-Pi 原实现；未扩展 Branch/Commit，也未复用闭源客户端。',
 check='evolution-runtime Git fixture 覆盖中文/空格/换行文件名、空新增、二进制、已暂存及本轮范围，并验证 Git index 没改变。重命名、模式与完整实际 Diff 旅程以根 QA 为准。',
 refs=[('apps/desktop/src/workspace-files.ts','workspaceDiff'),('apps/desktop/src/renderer/Workbench.tsx','function Diff('),('docs/sources.json','Codex')],
 tests=['tests/evolution-runtime.test.ts'],
 viz=dict(side0='开发会话',side1='开发会话',center0=['Agent 新建 new.txt','Diff：当前没有改动'],center1=['new.txt · 未跟踪新增','tracked.ts · 修改 / 行号'],panel0=['Diff HEAD','遗漏新文件'],panel1=['Diff · 工作区 / 未暂存','已暂存 / 本轮期间','双栏：旧行 | 新行'],flow0=['新文件','未跟踪','漏报'],flow1=['status -z','完整清单','按文件差异'])),
 dict(id='05',title='纠正一个事实，保留同条消息的其他约束',
 before='蓝色改为绿色后，两条仍并列有效；同 entry 的数据库与 UTF-8 共用来源，改数据库会连带丢掉 UTF-8。第一项为原真实 GUI 观察，第二项为原组合 fixture。',
 after=['SourceRef 可携带片段起止、hash、factId；原 entry 仍可回查。精确撤回被纠正片段，保留同消息其他事实。','普通明确纠正在召回/安全边界前更新有效约束；不能可靠消歧时隔离相关事实，不能同时宣称旧值都有效。','Memory 失效 epoch 跨进程持久化，派生草稿/现场采用前重查；原生默认与显式无限上下文分别处理，不强制展示 Context 页。'],
 boundary='纠正范围必须与有来源的事实匹配。自述“已纠正”不替代实际有效版本变化；歧义时保留原史，不能猜用户的新意图。',
 check='Memory automation 与 Topic rebuild 测试覆盖同源 sibling 保留、明确纠正、歧义隔离、冷启动及跨进程失效；根单列连续对话的真实操作证据。',
 refs=[('packages/core/src/index.ts','sourceFactRefs'),('packages/memory/src/index.ts','reconcileUserCorrection'),('packages/topic-rebuild/src/index.ts','correct')],
 tests=['packages/memory/test/automation.test.ts','packages/topic-rebuild/test/rebuild.test.ts'],
 viz=dict(side0='长期任务',side1='长期任务',center0=['SQLite + UTF-8（同消息）','改数据库 → 两条都失效'],center1=['数据库：更新到新有效版本','UTF-8：继续保持有效'],panel0=['以整 entry 撤回','旧/新颜色可能并列'],panel1=['Settings · 来源诊断','事实片段 / hash / 版本','歧义 → 隔离，不猜'],flow0=['entry','整条失效','兄弟约束丢失'],flow1=['fact span','定点替代','其他继续有效'])),
 dict(id='06',title='遗忘谱系抑制与自动学习的有效边界',
 before='fork 换会话身份后旧事实可再成为候选，并未证明 active 已复活；“请帮我记住”误拒绝，候选存在重复/冲突。',
 after=['遗忘按来源片段/事实身份跨 fork 与冷启动抑制，处理派生并保留原史；同条其他事实不被连带忘记。','按用户最新选择，项目事实、经客观结果支持的经验，以及有用户原话/独立证据支持的稳定偏好可自动生效，不要求每条手动 accept。','单次要求不泛化为个人偏好；来源不实、歧义和与有效事实冲突保留内部候选。附件不能冒充用户偏好，秘密不进入学习/召回。方法候选仍走 Expert 原有验证门槛。'],
 boundary='这是对旧“所有候选逐条手动采用/个人偏好只明确记住”的已批准调整，不等于任何模型生成文本都自动可信。自动 active 也必须有来源和生效范围。',
 check='Memory automation 对遗忘 fork、冷启动、late reflection、来源伪造、附件偏好、secret redaction 与自动发布提供针对性覆盖；语义提取效果不由 fake provider 通过数推断。',
 refs=[('packages/memory/src/index.ts','const explicit ='),('packages/memory/src/index.ts','sourceQuotes'),('packages/memory/src/index.ts','case \'forget\'')],
 tests=['packages/memory/test/automation.test.ts','packages/memory/test/memory.test.ts'],
 viz=dict(side0='项目经验',side1='项目经验',center0=['旧来源换 session 身份','已忘事实可再进入候选'],center1=['遗忘绑定事实谱系','真实经验 / 稳定偏好自动生效'],panel0=['重复候选','中文明确记住误拒'],panel1=['Settings · 记忆管理','纠正 / 停用 / 遗忘','不实 / 歧义仍待证据'],flow0=['忘记','fork','再次候选'],flow1=['来源谱系','持续抑制','保留其他事实'])),
 dict(id='07',title='单驻留学习进程，后台串行且可与前台并行',
 before='旧学习实例随会话各自调度；前台 B 只通知 B，A 的后台仍运行。旧规划曾建议全局前台抢占，这已被用户后续并行策略替代。',
 after=['一个独立驻留 Node 学习宿主统一领取持久队列，后台模型调用串行，跨控制器租约与恢复阶段避免重复领取/重跑完成阶段。','前台会话可与背景同时执行，不再用旧“前台启动必取消背景”作通过标准。背景失败有有界重试与等待配置状态，模型可单独配置。','关闭窗口隐藏而继续学习；真正退出应用取消等待中的调用、等进程终止并保存分析阶段。重启从保留阶段接续，不自动重放未知工具副作用。'],
 boundary='后台处理原史派生分析，不向前台 Pi 原会话追加一轮聊天。无限上下文模式可准备派生草稿，但只能在前台安全边界成为原生现场。没有新增额度硬上限。',
 check='learning-host 以真实本地 Node + fake HTTP 覆盖串行、前后台重叠、暂停/恢复、崩溃阶段恢复、删除 fencing 和退出停止。真实隐藏/退出的 macOS 行为由根 GUI 记录。',
 refs=[('apps/desktop/src/learning-worker.ts','run'),('apps/desktop/src/main.ts','before-quit'),('packages/memory/src/index.ts','learningHostAvailable')],
 tests=['tests/learning-host.test.ts','packages/memory/test/automation.test.ts'],
 viz=dict(side0='B 前台运行',side1='B 前台运行',center0=['会话 A / B 各自调度','旧计划：前台抢占背景'],center1=['前台执行 ∥ 后台学习','单 Node · 后台队列串行'],panel0=['分散会话学习状态','退出边界需统一'],panel1=['Settings · 后台学习','暂停 / 恢复 / 来源阶段','隐藏继续；退出停止'],flow0=['会话 A','会话 B','分散调度'],flow1=['统一队列','单宿主','阶段持久化'])),
 dict(id='08',title='自动与明确采用专家使用同一权限规则',
 before='auto use 的只读专家未及时约束 bash，明确指定却会拦截；GUI 无当前真实采用版本，Swarm 成员未记录实际 frozen adoption。',
 after=['采用时立即相交有效工具范围；自动/明确路径一致，多专家不会扩大本轮权限。ID/version/hash、Skill 与方法冻结，目录可用不等于实际采用。','Swarm 为整图冻结目录，成员实际采用向父控制器请求同版本，立即缩小自身 scope，并写自己的 Pi 原生收据。无效明确专家报错，缺可选插件的基本角色与错误区分。','工作台 Expert 只展示本轮真实采用专家；选择、编辑、版本差异、启停、回滚在设置。原生收据保存失败不能声称已采用成功。'],
 boundary='Skill 文本不能新增脚本/工具/权限，worktree 不是 OS 沙箱。冻结目录只有版本权威，不能当作成员已阅读/采用方法。',
 check='本次 62/62 包含 Expert 自动立即限权/交集/日志失败、public Pi 成员真实 auto use 后 Bash 被拒且文件没写；新编辑不改历史版本。真实模型效果另验。',
 refs=[('packages/expert/src/index.ts','adoptedToolScope'),('packages/swarm/src/member.ts','expert.adopt'),('apps/desktop/src/renderer/Workbench.tsx','friend-pi.expert.adoption')],
 tests=['packages/expert/test/adoption-scope.test.ts','packages/swarm/test/member.test.ts'],
 viz=dict(side0='当前运行',side1='当前运行',center0=['auto use：只读专家','下一次 Bash 仍未被限权'],center1=['adopt v2 → 立即范围交集','明确 / 自动共用策略'],panel0=['Expert：全库列表','无法判断本轮采用'],panel1=['Expert · 本轮采用','研究专家 v2 · Skill','编辑在下次运行生效'],flow0=['目录','auto use','规则不一致'],flow1=['冻结版本','实际采用','原生收据'])),
 dict(id='09',title='复核指向任务，返工只重跑依赖闭包',
 before='独立复核只拒绝任务 A 时 A/B 全图重跑；原成果、成员尝试与隔离已有，但返工方法调整缺少可达入口。',
 after=['结构化 review 提供 taskIds/resultVersions；只返工被拒任务及其下游依赖，复用独立已完成成果。无法归因暂停，不猜全图重试。','原 Task.prompt/originalPrompt 不被改写；新的 requirementVersion、尝试和复核原史保留。自动返工最多两轮，再失败需要调整方法。','工作台显示 DAG 与状态；设置任务详情在 paused 边界提供定向返工、原因/新要求，未知现场需要明确确认。SDK 将 rework 纳入真正运行 authority。'],
 boundary='不承诺本轮新增所有自动规划草案编辑、图/列表双模式或成员完整轨迹浏览器。采用的是已批准的定向闭包返工与轻 DAG，独立进程/worktree 和原史入口继续保留。',
 check='本次 62/62 覆盖 A→C 返工而 B 不重跑、requirements v1→v2、无归因暂停、两轮停止线及 review 原会话保留。设置 Modal 已有代码可达，最终点击闭环看根验收。',
 refs=[('packages/swarm/src/index.ts','requirementVersions'),('apps/desktop/src/renderer/panels.tsx','调整任务并定向返工'),('apps/desktop/src/sdk-worker.ts','swarmExecutionActions')],
 tests=['packages/swarm/test/evolution.test.ts','packages/swarm/test/swarm.test.ts'],
 viz=dict(side0='复核返工',side1='复核返工',center0=['A：被拒 → 重跑','B：已通过 → 也重跑'],center1=['A → C：重跑闭包','B：已通过 → 直接复用'],panel0=['全图重试','要求文本可能覆写'],panel1=['Settings · 任务详情','paused · 原因 / 新要求','保留 v1；建立 v2'],flow0=['拒绝 A','重跑 A+B','浪费成果'],flow1=['拒绝 A','A+下游','B 保留'])),
 dict(id='10',title='提交后通知，冲突从有来源的三方版本合并',
 before='CAS 已防覆盖；问题一是 shared.changed 早于 commit，另一连接读不到通知版本。问题二是双写冲突仅让人刷新草稿，缺自主合并。两者不是同一故障。',
 after=['最外层 commit 成功后再通知，事件携带 graph/document/revision/digest；回滚不发已提交通知，订阅者故障不能回滚已经持久化的材料。','成员和 GUI 带实际读取的 baseRevision/baseDigest。非重叠修改确定性三方合并；重叠时有限调用模型，必须引用三方 digest，合并后再 CAS；思考时不占锁。','缺来源、关键约束/接口互斥、无法可靠合并、取消或连续 CAS 竞争时保存三方冲突并暂停，等待成员终止。工作台保持轻 DAG，编辑及诊断在设置。'],
 boundary='自动化不等于任意挑一个覆盖另一个。模型合并/竞争最多两轮；未加入 durable outbox 的恰好一次投递承诺，冷恢复以持久快照为准。',
 check='本次 62/62 对双 SQLite 可见性、COMMIT 故障、通知故障、非重叠、增删空文档、来源约束、重叠模型、两次 CAS 竞争和活动图暂停均有针对性验证。GUI 已携带 digest，根另验点击保存。',
 refs=[('packages/swarm/src/shared.ts','afterCommit'),('packages/core/src/index.ts','afterCommit'),('apps/desktop/src/renderer/panels.tsx','baseDigest')],
 tests=['packages/swarm/test/evolution.test.ts','tests/evolution-runtime.test.ts'],
 viz=dict(side0='协作材料',side1='协作材料',center0=['已提交事件先发出','另一个连接尚读不到 v2'],center1=['commit v2 → changed(v2, hash)','三方：base / latest / proposed'],panel0=['CAS 防止覆盖已有效','冲突后只能刷新草稿'],panel1=['Settings · 共享材料','非重叠自动合并','不确定 → 保留三方并暂停'],flow0=['event','commit','刷新冲突'],flow1=['commit','通知','验证合并 / 暂停'])),
 dict(id='11',title='只读探索形成版本计划，用户批准后执行',
 before='计划模式已有工具边界禁写，但缺 ls/find/grep 原生探索，回答的“计划”没有独立版本审批与采用身份。',
 after=['使用 Pi 原生 read/ls/find/grep 与受限 friend_plan；Plan 禁写、禁 Bash 和 Swarm 执行，在嵌套工具边界同样生效。','模型必须实际 submit 版本化计划，审批绑定 id/revision/hash 与当时模型/思考等级/Single或Swarm 配置。旧版本、重复批准或配置改变拒绝。','中央简短审批卡提供打开全文、开始、修改、退出；全文作为文件材料打开。批准才产生执行 run，不把模型口头“已提交”当计划。'],
 boundary='Plan 与 Single/Swarm 正交，不新增 Team 模式。审批取消、会话切换和 stale plan 不会自动启动执行。',
 check='PlanStore 的版本/配置冻结测试与 sdk-worker 的原生 submit、模型自述不可替代、Plan 越界 write 拒绝对应此流程；根完成真实客户端批准旅程。',
 refs=[('apps/desktop/src/plan-store.ts','decide'),('apps/desktop/src/sdk-worker.ts','friend_plan'),('apps/desktop/src/renderer/App.tsx','plan.approve')],
 tests=['tests/evolution-runtime.test.ts','tests/sdk-worker.test.ts'],
 viz=dict(side0='先规划',side1='计划待批准',center0=['先规划开关：禁写','回答计划，无采用版本'],center1=['计划 v2 · 全文材料','开始 / 修改 / 退出'],panel0=['探索仅 read','没有 ls/find/grep'],panel1=['文件 · 计划全文','绑定 hash 与执行快照','开始后新执行 run'],flow0=['只读回答','切开关','无版本审批'],flow1=['只读探索','submit v2','用户批准执行'])),
 dict(id='12',title='会话归档、恢复与有边界的删除',
 before='横向项目栏、左会话状态、新建、重命名和名称搜索已有；缺可恢复归档及明确删除流程，不应把已有布局写成缺失。',
 after=['近期/归档切换；归档会话只读，恢复后可继续。忙碌及正在停止会话不能归档或进入删除确认。','删除先展示明确范围与 token，实际执行清理 Friend-Pi 拥有的主/成员/复核原史和独占业务记录，写 tombstone 阻止晚到学习复活。中断清理可显式幂等接续。','项目代码、原附件、Git worktree/成果和外部重新定位的原史保留；单独存在其他有效来源的记忆可继续，失去唯一来源的停止自动采用。'],
 boundary='本轮范围只有归档、删除、恢复。没有新增置顶、状态筛选、原史正文检索、跨会话待处理中心或关闭项目；名称搜索与 Friend 主布局保留。',
 check='desktop-lifecycle 覆盖 archive late state、只读/忙碌拒绝、删除闭包/晚到 fencing、cleanup 幂等接续；根须单列真实删除确认和冷重启。',
 refs=[('apps/desktop/src/main.ts','session.delete.preview'),('apps/desktop/src/main.ts','finishDeletion'),('apps/desktop/src/renderer/App.tsx','删除会话')],
 tests=['tests/desktop-lifecycle.test.ts','packages/memory/test/automation.test.ts'],
 viz=dict(side0='近期会话',side1='近期 / 归档',center0=['完成会话持续堆在近期','无归档与明确删除边界'],center1=['归档：只读，可恢复','删除：范围确认 + token'],panel0=['已有名称搜索 / 重命名','项目栏与状态卡已存在'],panel1=['会话菜单 · 归档 / 恢复','删除原史与独占记录','项目文件 / Git 成果保留'],flow0=['近期','持续累积','无可恢复收纳'],flow1=['近期','归档只读','恢复继续'])),
 dict(id='13',title='轮次浮卡只预览用户原文',
 before='Codex 风格侧轨、定位、收藏和键盘操作已有；浮卡把用户问题与助手摘要一起展示，不够聚焦。',
 after=['浮卡只展示该轮真正的用户原始输入，不混入助手摘要，也不混入附加文件内容。保留空白和换行。','继续使用现有侧轨点击定位、书签及 ArrowUp/Down、Home/End、B、Escape、ArrowRight 焦点操作。','收藏和布局位置保存在各自会话本地展示状态，不更改 Pi 原始聊天内容。'],
 boundary='本轮没有新增关键词、仅书签、Topic 过滤或全库正文检索。Codex 图片只借鉴侧轨浮卡布局，不采用夜间主题。',
 check='evolution-runtime 对用户输入 textEnd/hash 边界保真；定位、书签与键盘已有代码。最新纯用户浮卡的真实阅读效果由根 Computer Use 单列。',
 refs=[('apps/desktop/src/renderer/TurnIndex.tsx','userText'),('apps/desktop/src/message-projection.ts','textEnd'),('apps/desktop/src/renderer/App.tsx','TurnIndex')],
 tests=['tests/evolution-runtime.test.ts'],
 viz=dict(side0='轮次列表',side1='轮次列表',center0=['用户：先验证功能…','助手摘要混在同一浮卡'],center1=['用户：先验证功能…','纯用户原文 + 书签'],panel0=['侧轨 / 定位已有','浮卡展示多种内容'],panel1=['短线侧轨 → 原文浮卡','键盘跳轮 / 收藏保留','保持浅色主题'],flow0=['侧轨','用户 + 助手','预览混合'],flow1=['侧轨','用户原文','定位 / 收藏'])),
 dict(id='14',title='两个镜像开合按钮与原有可拖分栏',
 before='左右拖动、键盘调宽、比例冷恢复和窄屏隐藏已有；右上多模块入口增加布局理解成本。',
 after=['右上保留两个镜像按钮，分别控制左会话栏和右统一工作台，按钮状态与实际开合一致。','继续使用现有分隔条拖动、键盘调宽、宽度恢复和窄屏抽屉；不把这些已有能力重新算作本轮从零完成。','工作台内部五页保持轻量；输入区的计划与协作控制保留 Friend 位置，窗口变窄时保持关键操作可达。'],
 boundary='本轮不增加阅读/协作预设、每项目布局方案、字体/密度设置或双击恢复默认。真实窄屏、键盘焦点与尺寸恢复仍需同候选 GUI 验证。',
 check='ResizeHandle/App/CSS 的既有路径保留，本轮镜像按钮和五页布局已接入。具体拖动前后像素和键盘状态只引用根验收实际截图，示意图不是结果。',
 refs=[('apps/desktop/src/renderer/ResizeHandle.tsx','onKeyDown'),('apps/desktop/src/renderer/App.tsx','展开右侧工作台'),('apps/desktop/src/renderer/layout.css','@media')],
 tests=[],
 viz=dict(side0='会话栏',side1='会话栏 ⇆',center0=['可拖分栏已有','右上多模块按钮'],center1=['横向项目栏 / 左侧会话','⇆ 会话栏    ⇆ 工作台'],panel0=['文件 / Diff / Swarm','Expert / Memory / Context','模块入口较多'],panel1=['一处工作台内切五页','拖动 + 键盘调宽','窄屏抽屉 / 比例恢复'],flow0=['多入口','切模块','布局成本'],flow1=['两个按钮','一致开合','五轻页'])),
 dict(id='15',title='文件树、可关闭预览标签与安全分段阅读',
 before='已有文本/图片附件和相对路径文本预览，没有文件树、多材料标签或可达的图片预览；历史图片结构问题属于 03。',
 after=['文件页提供名称过滤的项目文件树，打开文本、Markdown、图片及来源/计划虚拟材料；最多六个预览标签，单标签可关闭。','文本 UTF-8 分段，代码行号/定位与下一段；Markdown 安全渲染，允许的图片按大小限制。二进制/不支持类型明确说明并可系统打开。','realpath 项目边界拒绝符号链接逃逸；材料可添加到输入框。文件预览与 Diff 共用项目边界，原附件不因会话删除而移除。'],
 boundary='文件树有深度/条目上限，文本和图像有大小边界。不是完整 IDE、编辑器、交互终端或浏览器；未扩展全部附件压缩/去重/能力工作流。',
 check='evolution-runtime 覆盖 UTF-8 分页、长行/行定位、图片与 symlink 逃逸；工作台树/切标签/关闭标签/系统打开的真实操作由根记录。',
 refs=[('apps/desktop/src/workspace-files.ts','previewFile'),('apps/desktop/src/renderer/Workbench.tsx','关闭预览'),('apps/desktop/src/renderer/Workbench.tsx','读取下一段')],
 tests=['tests/evolution-runtime.test.ts'],
 viz=dict(side0='项目会话',side1='项目会话',center0=['手填一个相对路径','只打开单份文本'],center1=['项目树 → 多材料标签','代码 1/2/3 行 · 下一段'],panel0=['文本预览已有','图片路径边界不通'],panel1=['文件 · a.ts / 计划 ×','图片 / Markdown / 文本','原文来源 / 安全边界'],flow0=['路径文本','单预览','切换需重填'],flow1=['文件树','标签切换','关闭 / 分段'])),
 dict(id='16',title='设置集中配置、作用域与独立模型测试',
 before='有模型服务与部分默认项，但默认 Swarm 可与关闭 Swarm 插件矛盾；自定义模型能力固定为 text/non-reasoning，长期管理分散在工作台。',
 after=['设置可搜索字段，区分全局/项目默认；模型、思考等级、模式、插件依赖与 native/infinite 组合在保存时校验，矛盾不静默降级。','自定义兼容服务可配置协议、reasoning、图像能力和上下文窗口；保存认证、实际 model.test 与真实任务派发是三种独立结果。Key 字段保存后清空。','全部插件启停和专家/记忆/验证/学习长期管理集中设置。当前执行冻结快照与下一安全边界配置分开；忙碌时排队，空闲 reload 并重新绑定。'],
 boundary='配置生效边界明确，不能把保存成功称模型调用成功，也不能把测试 OK 称真实任务验收。自定义能力配置不自动证明服务器支持相应语义。',
 check='Main 的 model.test 在 allowlist 后显式注册并由 public runtime.complete 调用；原生 reload 与只启 Expert/禁 Memory 路径有 SDK 测试。作用域/UI/真实服务连通性由根单列。',
 refs=[('apps/desktop/src/main.ts','model.test'),('apps/desktop/src/provider-settings.ts','contextWindow'),('apps/desktop/src/renderer/App.tsx','function SettingsPanel')],
 tests=['tests/sdk-worker.test.ts'],
 viz=dict(side0='新会话',side1='新会话',center0=['默认 Swarm + 插件关闭','新建可能静默变 Single'],center1=['依赖矛盾 → 保存拒绝','当前冻结 / 下次配置分别显示'],panel0=['管理表单分散','模型能力固定'],panel1=['Settings · 搜索 / 项目','模型能力 / 插件 / 学习','保存 ≠ 测试 ≠ 实际任务'],flow0=['配置保存','矛盾','静默降级'],flow1=['配置校验','安全边界','真实 reload'])),
 dict(id='18',title='默认原生 Pi 上下文，按需开启无限上下文',
 before='工作台展示现场/预算/原史长卡；旧研究提议后台连续现场，容易被误解为所有会话默认使用自定义重建。',
 after=['默认 native：Pi 公开 loop、JSONL、压缩维护原生上下文。旧 enabled:true 不自动迁为 infinite，只有用户显式选择才启用自定义现场。','infinite 模式在安全边界以 operationId、来源覆盖/版本与持久 Memory epoch 验证采用；后台只做派生草稿，成功进入 Pi 原生条目后才推进覆盖水位。','工作台不再提供 Context 页面。记忆/消息来源、原文/前后文作为文件材料回查；手动整理、回退与高级现场诊断放设置。失败保留有效现场并回退 Pi，取消不额外重放工具。'],
 boundary='“无限上下文”表示有限窗口内长期承接与来源回查，不是无限 token，也不是所有多主题/长任务语义组合已经完成真实模型验收。派生准备不等于采用。',
 check='Topic 的 native 默认、原生公开组合、草稿/水位、相同摘要不同 operation、新输入 tail、取消与跨进程失效都有测试。完整真实长任务连续性待根分层验收。',
 refs=[('packages/topic-rebuild/src/index.ts','private mode'),('packages/topic-rebuild/src/index.ts','prepareDraft'),('apps/desktop/src/main.ts','contextMode:\'native\'')],
 tests=['packages/topic-rebuild/test/rebuild.test.ts','packages/topic-rebuild/test/native-combination.test.ts','packages/swarm/test/native-lifecycle.test.ts'],
 viz=dict(side0='长期任务',side1='长期任务',center0=['现场 / 预算 / 长表单','模式边界不够明确'],center1=['默认 native · Pi 原生压缩','显式 infinite → 来源验证重建'],panel0=['Context 独立页','现场长卡占工作区'],panel1=['文件 · 原文 / 前后文','Settings · 高级整理','草稿成功采用才推进'],flow0=['后台准备','容易当已用','边界混合'],flow1=['派生草稿','原生采用','推进水位'])),
 dict(id='19',title='单一工作台五轻页，显示本轮真实记录',
 before='六模块共用侧面板但含整库/管理表单；Memory 无 per-run 注入收据，Expert 有原生采用记录却未被 GUI 消费，不能用库列表代替本轮采用。',
 after=['右上一个工作台开合按钮（另一个为会话栏），内含文件 / Diff / Swarm / Expert / Memory 五页，不提供 Context。全部启停、全库编辑和长任务诊断去设置。','Swarm 显示当前 run 的 DAG；Expert 显示真实 adopted 的冻结专家；Memory 按实际 injected-to-context/request-prepared/response-observed/tool-read 原生收据显示版本与来源。','旧轮无收据显示“尚无记录”，已观察空结果显示“未提供”。目录、检索命中、准备草稿和模型自称不算实际采用；Memory 收据也不推断模型决策的因果依赖。'],
 boundary='轻页面中的版本和来源来自原生收据，SQLite 可重建索引。后台学习产出、全文库和当前 run 使用是不同信息，界面不能互相替代。',
 check='Memory-alone public Pi fake 请求与冷恢复测试、Expert native adoption、SDK run receipt 恢复与 Workbench 对 runId 的过滤支撑数据链；最终五页操作体验另由根 CUA 验证。',
 refs=[('apps/desktop/src/renderer/Workbench.tsx',"WorkbenchPage='file'"),('packages/memory/src/index.ts','observeProviderResponse'),('apps/desktop/src/sdk-worker.ts','receipts:')],
 tests=['packages/memory/test/native-usage.test.ts','packages/expert/test/native-adoption.test.ts','tests/sdk-worker.test.ts'],
 viz=dict(side0='当前会话',side1='当前会话',center0=['右上六个模块入口','当前库列表 ≠ 本轮使用'],center1=['对话保留 Friend 主布局','本轮 runId → 原生收据'],panel0=['文件 / Diff / Swarm','Expert / Memory / Context','整库与管理表单混杂'],panel1=['文件 / Diff / Swarm','Expert / Memory','少量当前信息 → 设置管理'],flow0=['库中存在','列表展示','误认本轮用过'],flow1=['真实收据','版本 / 来源','不推断因果'])),
]

# Resolve line links from the actual current source; fail rather than invent a pointer.
def source_link(path, needle):
    content = (ROOT/path).read_text()
    lines = content.splitlines()
    found = next((i+1 for i,s in enumerate(lines) if needle in s), None)
    if found is None:
        # Content pointers may be renamed during integration. A real file link remains valid.
        return path, None
    return path, found

def md_link(path, needle=None):
    line = source_link(path, needle)[1] if needle else None
    return f'[{path}]({ROOT/path}{":"+str(line) if line else ""})'

def esc(value): return html.escape(str(value),quote=True)

def wrapped(text, width):
    # Count full-width CJK as two units; SVG geometry is fixed and no HTML foreignObject is used.
    rows=[]; row=''; n=0
    for char in text:
        weight=2 if ord(char)>255 else 1
        if n+weight>width:
            rows.append(row);row='';n=0
        row+=char;n+=weight
    if row: rows.append(row)
    return rows

def svg_text(x,y,text,size=15,fill='#293f32',weight=400,width=35,lineh=24,maxlines=None):
    rows=wrapped(text,width)
    if maxlines and len(rows)>maxlines:
        rows=rows[:maxlines];rows[-1]=rows[-1][:-1]+'…'
    chunks=[f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{fill}">']
    for i,row in enumerate(rows):chunks.append(f'<tspan x="{x}" dy="{0 if i==0 else lineh}">{esc(row)}</tspan>')
    chunks.append('</text>');return ''.join(chunks)

def rect(x,y,w,h,fill,stroke='#dbe5de',radius=12):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{radius}" fill="{fill}" stroke="{stroke}"/>'

def pane(point,x,after):
    v=point['viz']; suffix='1' if after else '0'; accent='#24744d' if after else '#a75d45'; pieces=[]
    pieces += [rect(x,116,660,558,'#fff'),rect(x,116,660,45,'#f3f7f4',radius=12)]
    pieces += [svg_text(x+17,144,'Friend-Pi',17,weight=650,width=30),svg_text(x+140,143,'独立会话   开发项目   + 打开项目',14,width=55),svg_text(x+560,143,'⇆  ⇆' if after else '▤ ⋯ ⋯',18,width=15)]
    pieces += [f'<line x1="{x+116}" y1="161" x2="{x+116}" y2="674" stroke="#e1e8e3"/>',f'<line x1="{x+420}" y1="161" x2="{x+420}" y2="674" stroke="#e1e8e3"/>']
    pieces += [svg_text(x+14,192,'会话',14,weight=650,width=16),rect(x+10,210,96,45,'#eaf2ec'),svg_text(x+20,229,'+ 新会话',13,width=15),svg_text(x+15,277,'搜索名称',12,fill='#819185',width=16),rect(x+10,300,96,104,'#f3f6f3')]
    pieces += [svg_text(x+20,323,'当前任务',13,weight=650,width=12),svg_text(x+20,352,v['side'+suffix],12,fill=accent,width=12,lineh=20,maxlines=2),svg_text(x+17,650,'⚙ 设置',14,width=14)]
    pieces += [svg_text(x+135,190,'当前对话 / 原生 Pi 历史',14,weight=650,width=40),rect(x+134,210,268,106,'#f6f8f5')]
    pieces += [svg_text(x+150,233,'用户目标',12,fill='#829083',width=33),svg_text(x+150,263,v['center'+suffix][0],17,weight=550,width=29,lineh=25,maxlines=2)]
    pieces += [rect(x+134,330,268,134,'#eaf4eb' if after else '#fcf2ed',stroke='#cddfce' if after else '#efd5ca')]
    pieces += [svg_text(x+150,355,'优化后机制' if after else '优化前问题',12,fill=accent,width=35),svg_text(x+150,387,v['center'+suffix][1],16,width=30,lineh=25,maxlines=3)]
    fy=485
    for i,label in enumerate(v['flow'+suffix]):
        tx=x+139+i*87
        pieces += [rect(tx,fy,79,56,'#f5f8f4',radius=8),svg_text(tx+8,fy+22,label,12,fill=accent,width=10,lineh=17,maxlines=2)]
        if i<2:pieces += [svg_text(tx+79,fy+33,'→',13,fill='#7b9180',width=3)]
    pieces += [rect(x+134,567,268,80,'#fff',stroke='#cddbcc',radius=15),svg_text(x+149,591,'输入你的目标…',13,fill='#8a978b',width=35),svg_text(x+149,628,'+   先规划 ◯   Single / Swarm   →',12,width=41)]
    panel=v['panel'+suffix]
    pieces += [svg_text(x+436,188,'工作材料 / 设置' if after else '原工作台',13,weight=600,width=28)]
    if after:
        pieces += [svg_text(x+436,212,'文件  Diff  Swarm',11,fill='#6f8974',width=34),svg_text(x+436,233,'Expert  Memory',11,fill='#6f8974',width=34)]
    else:
        pieces += [svg_text(x+436,221,'六模块与整库管理',11,fill='#8f837b',width=34)]
    py=270
    for i,label in enumerate(panel):
        pieces += [rect(x+435,py,209,85,'#f5f9f4' if after else '#faf5f1',radius=9),svg_text(x+447,py+26,label,14,fill=accent if i==0 else '#526856',width=25,lineh=22,maxlines=3)]
        py+=96
    pieces += [svg_text(x+436,626,'布局/行为示意',11,fill='#8c978e',width=26),svg_text(x+436,645,'非验收截图',11,fill='#8c978e',width=26)]
    return ''.join(pieces)

def diagram(point):
    title=f'{point["id"]} · {point["title"]}'
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="760" viewBox="0 0 1400 760" role="img" aria-labelledby="title desc">'
      f'<title id="title">{esc(title)} 优化前后示意</title>'
      '<desc id="desc">两列浅色 Friend-Pi 产品布局示意。左为研究时问题，右为已批准实现范围。机制流程也以示意表达，不是实际界面截图或验收结果。</desc>'
      '<style>text{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}</style>'
      '<rect width="1400" height="760" fill="#eef4ef"/>'
      +svg_text(30,39,title,25,weight=650,width=100)
      +svg_text(30,69,'历史基线 → 已批准实施范围；所有流程与卡片均为说明示意，不代表真实 Computer Use 通过。',14,fill='#768279',width=172)
      +svg_text(30,100,'优化前 · 研究时状态',15,fill='#a75d45',weight=600,width=65)
      +svg_text(710,100,'优化后 · 当前源码机制 / 布局',15,fill='#24744d',weight=600,width=75)
      +pane(point,30,False)+pane(point,710,True)
      +svg_text(30,709,point['boundary'],13,fill='#67766b',width=196,lineh=21,maxlines=2)
      +'</svg>')

intro = ('本附录记录用户最终批准的实施范围，逐项对照旧研究的历史问题。原规划书及其截图保留原时点证据；'
         '旧书“待决策/未实施”的状态不能直接用于判断当前源码。本文不把旧规划中的较宽子建议自动算入本轮范围。')
evidence = ('图均为浅色产品/机制示意，不是操作截图。Swarm/Expert focused 测试在本次实际执行 62/62，'
            '其中原生 Pi 执行使用 fake provider 与临时项目；这不等于真实模型效果、完整桌面旅程或最终交付验收。'
            '其他条目列出当前源码和对应测试入口，最终执行结果、Computer Use 截图、候选 commit、Pi SHA 与包摘要以根 Agent 的 .artifacts/qa 记录为准。')
md=['# Friend-Pi 已批准优化实施附录','',intro,'',evidence,'',
    f'固定 Pi：`{PI_SHA}`；插件仍通过公开 SDK/扩展运行，Pi JSONL 是原始聊天的唯一来源。当前整合源码与制品验证应分别记录，本文不复用旧包哈希作为新候选身份。','',
    '可交互浏览：[优化前后对比页](comparison.html)。历史材料：[原规划书](../../research/2026-10-07-friend-pi-evolution/规划书.md)、[旧规划数据](../../research/2026-10-07-friend-pi-evolution/planning-data.json)。','',
    '## 当前产品边界','',
    '- 顶部横向项目、左侧会话、中央对话、输入区计划/Single/Swarm 控制保留 Friend 布局；右上两个镜像按钮控制会话栏与统一工作台。',
    '- 工作台只有文件、Diff、Swarm、Expert、Memory 五个轻页面；没有 Context 页。启停、全库编辑、验证、学习及高级诊断都在设置。',
    '- 默认原生 Pi 上下文；无限上下文须显式开启。后台一个独立 Node 宿主、模型调用串行，允许与前台并行；关窗隐藏继续，真正退出才停止。',
    '- 有来源的项目事实、已验证经验与稳定偏好可自动生效；歧义/冲突/无可靠来源保持内部候选。方法成长仍受既有客观验证门槛约束。','',
    '| 项 | 实施要点 | 范围状态 |','| --- | --- | --- |']
for p in POINTS: md.append(f'| [{p["id"]}](#{p["id"]}) | {p["title"]} | 已有源码；最终制品/GUI 证据另列 |')
md += ['| 17 | 既有专家验证与受限成长 | 保留原机制、管理迁设置；本轮不扩展模板/套件编辑能力 |','']

sections=[]
for p in POINTS:
    path=HERE/f'{p["id"]}.svg';path.write_text(diagram(p))
    md += [f'<a id="{p["id"]}"></a>',f'## {p["id"]} · {p["title"]}','',
           '**优化前。** '+p['before'],'','**当前实现。**','']
    md += [f'- {line}' for line in p['after']]
    md += ['','**边界。** '+p['boundary'],'','**验证。** '+p['check'],'',
           '源码：'+ '；'.join(md_link(path,needle) for path,needle in p['refs'])+'。','']
    if p['tests']: md+=['测试入口：'+'；'.join(md_link(t) for t in p['tests'])+'。','']
    md += [f'![{p["id"]} 优化前后产品示意（非验收截图）]({path})','']
    def html_ref(path,needle=None):
        line=source_link(path,needle)[1] if needle else None
        label=path+(f':{line}' if line else '')
        rel='../../../'+path
        return f'<a href="{esc(rel)}">{esc(label)}</a>'
    sections.append(f'<section id="p{p["id"]}" data-query="{esc(p["id"]+p["title"]+p["before"]+" ".join(p["after"]))}">'
        +f'<div class="section-header"><span class="number">{p["id"]}</span><h2>{esc(p["title"])}</h2><span class="badge">当前源码 · 待同候选验收</span></div>'
        +f'<p><strong>优化前。</strong>{esc(p["before"])}</p>'
        +'<div class="changed"><strong>当前实现</strong><ul>'+''.join('<li>'+esc(a)+'</li>' for a in p['after'])+'</ul></div>'
        +f'<figure><img src="{p["id"]}.svg" alt="{esc(p["title"])}优化前后示意" loading="lazy"><figcaption>产品与机制示意，非真实界面截图，不能替代验收。</figcaption></figure>'
        +f'<p class="boundary"><strong>边界。</strong>{esc(p["boundary"])}</p>'
        +f'<p><strong>验证。</strong>{esc(p["check"])}</p>'
        +'<p class="refs">源码：'+ ' · '.join(html_ref(path,needle) for path,needle in p['refs'])+'</p>'
        +('<p class="refs">测试：'+' · '.join(html_ref(t) for t in p['tests'])+'</p>' if p['tests'] else '')+'</section>')

kept=('既有 2 个独立正例 + 1 个范围外反例 + 必要客观检查的发布门槛、版本冻结、撤回/回滚、仅文本方法成长继续保留。'
      '管理入口移至设置；本轮不新增代码/研究/整合模板，也不宣称完整验证套件编辑增强已经完成。'
      '既有专家成长测试不等于本轮重新跑了真实模型自动发布全旅程。')
md += ['## 17 · 保留既有验证与成长，不增加本轮范围','',kept,'',
       '源码与测试：'+md_link('packages/expert/src/index.ts')+'；'+md_link('packages/expert/test/expert.test.ts')+'；'+md_link('packages/expert/test/expert-safety.test.ts')+'。','',
       '## 来源、复用与结果记录','',
       '本轮业务代码是 Friend-Pi 原实现；Pi 是未修改的运行时依赖，其他产品仅作架构/交互源码参考。没有复制闭源桌面 React Diff，也没有叠加其他完整 Agent loop。固定来源以 '+md_link('docs/sources.json')+' 与各包 `SOURCES.md` 为准。','',
       '| 参考 | 固定版本 / 许可 | 本轮关系 |','| --- | --- | --- |']
for name,use in [('Pi','公开 SDK、扩展、工具与压缩'),('Codex','记忆读写分离、停止/恢复、Git/TUI Diff 语义；无桌面 React 源码复用'),('MiMo-Code','派生后台工作、成功采用后推进水位；独立 Node 宿主为新适配'),('DeepSeekHarness','任务图、消息/来源的状态边界'),('MiniMax Code','执行所有权与停止级联的源码参考')]:
    s=SOURCES[name];md.append(f'| [{name}]({s["repository"]}/tree/{s["commit"]}) | `{s["commit"]}` / {s["license"]} | {use} |')
md += ['', '包内来源说明：'+'；'.join(md_link(f'packages/{package}/SOURCES.md') for package in ['swarm','expert','memory','topic-rebuild'])+'。','',
       '本文的链接与示意图生成可重复：`python3 docs/implementation/2026-10-07/build_appendix.py`。生成器只写本实施目录，不改研究书、业务代码或验收数据。','',
       '最终候选验收请从 '+md_link('docs/verification.md')+' 和根 Agent 当前 `.artifacts/qa` 报告核对：测试范围/模型性质、实际宽窄/键盘/停止/冷重启旅程、候选 commit、固定 Pi SHA、制品摘要、绝对路径。生成这份说明与上述动作是不同结果。','']
(HERE/'修复清单.md').write_text('\n'.join(md))

reference_rows=[]
for name in ['Pi','Codex','MiMo-Code','DeepSeekHarness','MiniMax Code']:
 s=SOURCES[name];reference_rows.append(f'<tr><td><a href="{s["repository"]}/tree/{s["commit"]}">{esc(name)}</a></td><td><code>{s["commit"]}</code></td><td>{esc(s["license"])}</td><td>{esc(s["mode"])}</td></tr>')
nav=''.join(f'<a href="#p{p["id"]}">{p["id"]} {esc(p["title"])}</a>' for p in POINTS)
page='''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Friend-Pi · 已批准优化实施对比</title><style>
:root{color-scheme:light;--ink:#253b2c;--muted:#6c7e70;--green:#24744d}*{box-sizing:border-box}body{margin:0;background:#f1f6f1;color:var(--ink);font:16px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}a{color:#216546;text-decoration:none}a:hover{text-decoration:underline}header{max-width:1300px;margin:auto;padding:40px 28px 20px}h1{font-size:34px;line-height:1.3;margin:0 0 16px}h2{font-size:23px;line-height:1.45;margin:0;flex:1}p{margin:12px 0}.lead{max-width:1100px}.notice{border-left:4px solid #9ab99f;background:#fff;padding:14px 20px;border-radius:0 12px 12px 0;color:#526557}.shell{display:grid;grid-template-columns:240px minmax(0,1fr);gap:24px;max-width:1420px;margin:auto;padding:20px 28px 60px}aside{position:sticky;top:16px;align-self:start;max-height:calc(100vh - 32px);overflow:auto;background:#fff;border:1px solid #d7e3d9;border-radius:14px;padding:14px}aside input{width:100%;padding:10px 12px;border:1px solid #cddbcc;border-radius:8px;font:inherit}nav{display:flex;flex-direction:column;margin-top:12px}nav a{font-size:13px;padding:8px 7px;border-bottom:1px solid #edf2ed}.content{min-width:0}section{background:#fff;border:1px solid #d7e3d9;border-radius:18px;margin:0 0 28px;padding:26px;scroll-margin-top:16px}.section-header{display:flex;gap:13px;align-items:center;flex-wrap:wrap}.number{border-radius:10px;background:#e7f2e8;color:#24744d;font-weight:700;padding:5px 12px}.badge{font-size:11px;color:#69826d;padding:4px 9px;background:#f0f6ef;border-radius:7px}.changed{background:#f3f8f2;border-radius:12px;padding:14px 20px;margin-top:20px}ul{padding-left:24px;margin:9px 0}li{margin:9px 0}figure{margin:22px -9px 12px}figure img{display:block;width:100%;height:auto;border-radius:14px;border:1px solid #d8e2d9}figcaption{font-size:12px;color:var(--muted);margin:7px 9px}.boundary{border-left:3px solid #a7bdaa;padding-left:13px}.refs{font-size:12px;overflow-wrap:anywhere;color:#6c7e70}code{font-size:12px;overflow-wrap:anywhere;background:#f2f5f1;padding:2px 5px;border-radius:4px}table{border-collapse:collapse;width:100%;font-size:13px}td,th{text-align:left;border-bottom:1px solid #dfe7df;padding:9px}footer{font-size:13px;color:var(--muted)}[hidden]{display:none!important}@media(max-width:900px){header{padding:28px 18px 12px}.shell{display:block;padding:12px 18px 35px}aside{position:static;max-height:none;margin-bottom:22px}nav{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}section{padding:18px}h1{font-size:27px}h2{font-size:20px}.badge{display:none}}@media print{aside{display:none}.shell{display:block;padding:0}section{break-inside:avoid;border-radius:0}header{padding:0 0 18px}body{background:#fff;font-size:11px}h1{font-size:22px}h2{font-size:17px}figure{margin:12px 0}}
</style></head><body>'''
page+=f'<header><h1>Friend-Pi · 已批准优化实施对比</h1><p class="lead">{esc(intro)}</p><div class="notice">{esc(evidence)}</div><p class="refs">固定 Pi：<code>{PI_SHA}</code> · <a href="修复清单.md">Markdown 修复清单</a> · <a href="../../research/2026-10-07-friend-pi-evolution/index.html">历史研究书</a></p></header>'
page+='<div class="shell"><aside><input id="query" placeholder="筛选优化点…" aria-label="筛选优化点"><nav>'+nav+'<a href="#kept">17 保留既有成长，不扩展</a><a href="#sources">来源与结果边界</a></nav></aside><main class="content">'+''.join(sections)
page+=f'<section id="kept"><div class="section-header"><span class="number">17</span><h2>既有专家验证与受限成长继续保留</h2></div><p>{esc(kept)}</p><p class="refs">既有源码与测试保留，管理统一迁至设置。不是本轮新增的产品能力。</p></section>'
page+='<section id="sources"><h2>来源与结果边界</h2><p>Friend-Pi 业务为新实现，Pi 为固定且未修改的运行时；其他项目是参考，不是另一个执行底座。没有复制闭源桌面 React Diff。</p><table><thead><tr><th>来源</th><th>固定 commit</th><th>许可</th><th>实际模式</th></tr></thead><tbody>'+''.join(reference_rows)+'</tbody></table><p class="refs"><a href="../../../docs/sources.json">固定来源账本</a> · <a href="../../../packages/memory/SOURCES.md">Memory 来源与证据边界</a> · <a href="../../../packages/topic-rebuild/SOURCES.md">Topic 来源与证据边界</a></p><p>最终候选的 commit、Pi SHA、制品摘要、绝对路径、真实模型与 Computer Use 结果由根 Agent 写入当前 .artifacts/qa 验收记录。本文没有用旧包哈希或示意图替代这些证据。</p></section>'
page+='</main></div><script>const query=document.getElementById("query");query.addEventListener("input",()=>{const value=query.value.trim().toLocaleLowerCase();for(const section of document.querySelectorAll("section[data-query]"))section.hidden=Boolean(value)&&!section.dataset.query.toLocaleLowerCase().includes(value);});</script></body></html>'
(HERE/'comparison.html').write_text(page)
print(json.dumps({'directory':str(HERE),'points':len(POINTS),'diagrams':len(list(HERE.glob('*.svg'))),'files':['修复清单.md','comparison.html','build_appendix.py']},ensure_ascii=False))
