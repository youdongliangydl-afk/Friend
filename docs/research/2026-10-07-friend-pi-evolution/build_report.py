#!/usr/bin/env python3
"""Build an offline, evidence-linked planning book. Does not change the app."""
from pathlib import Path
import json, shutil, html, hashlib, datetime

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
QA = ROOT / '.artifacts/qa/evolution-audit'
data = json.loads((OUT / 'planning-data.json').read_text())
points = data['points']
esc = html.escape
from urllib.parse import urlparse
def source_title(url):
    names={'code-review':'Codex 官方代码审阅','git-worktrees':'Codex 官方 Worktree','projects':'Codex 官方项目与会话','memory':'MiniMax 官方 Memory','memories':'Codex 官方 Memory','byok':'MiniMax 官方自定义模型','team':'MiniMax 官方 Agent Team','tasks':'MiniMax 官方任务与历史','panels':'MiniMax 官方开发面板','shortcuts':'MiniMax 官方快捷键','appearance':'MiniMax 官方外观','deepseek-harness':'DeepSeek Harness 官方仓库','user-stop-cascade.ts':'MiniMax 停止级联源码','verification-policy.ts':'MiniMax 复核策略源码','TOOL_RECOVERY.zh-CN.md':'Reasonix 中断工具恢复','TURN_RESULTS.zh-CN.md':'Reasonix 本轮成果与检查','SESSION_MEMORY_RETRIEVAL.zh-CN.md':'Reasonix 记忆与上下文','SUBAGENT_PROFILES.zh-CN.md':'Reasonix 子智能体档案','GUIDE.zh-CN.md':'Reasonix 使用指南','MODEL_SETTINGS.zh-CN.md':'Reasonix 模型设置','TaskMonitorPanel.tsx':'Reasonix 任务监控源码'}
    return names.get(urlparse(url).path.rstrip('/').split('/')[-1],urlparse(url).netloc+' 一手资料')
for folder in ['evidence', 'screenshots', 'visuals/png']:
    (OUT / folder).mkdir(parents=True, exist_ok=True)
(OUT / 'reference-images').mkdir(exist_ok=True)
for name, source in {
 'codex-turn-preview.png': '/var/folders/94/wmtph9h55md7cwpy00mf_z0m0000gn/T/codex-clipboard-79bab6fe-6dc4-4c15-a923-46dff32a0fee.png',
 'user-unified-workbench.png': '/var/folders/94/wmtph9h55md7cwpy00mf_z0m0000gn/T/codex-clipboard-2e1b0998-33c0-43c1-be49-d260ace780fa.png'
}.items():
    if Path(source).exists(): shutil.copy2(source, OUT / 'reference-images' / name)

copies = {
 'client': ['client-functional-audit.md','client-completeness-matrix.json','boundary-report.json','test-output.txt','typecheck-output.txt'],
 'swarm-expert': ['audit-report.md','coverage.json','probe-results.json'],
 'memory-rebuild': ['report.zh.md','requirement-coverage.json','regression-observations.json','positive-observations.json'],
 'research/minimax-reasonix': ['research-notes.md','feature-inventory.json','hands-on-coverage-draft.json','hands-on-coverage-draft.md'],
 'research/codex-dsh': ['friend-pi-usage-receipt-boundary.md','research.zh.md','sources.json','capability-inventory.json','hands-on-coverage-draft.json','hands-on-coverage-draft.md']
}
for folder, files in copies.items():
    dest = OUT / 'evidence' / folder
    dest.mkdir(parents=True, exist_ok=True)
    for name in files:
        shutil.copy2(QA / folder / name, dest / name)
shutil.copy2(QA / 'competitor-independent-results.json', OUT / 'evidence/competitor-independent-results.json')

# Preserve original CUA bytes. The API currently returns JPEG bytes even when
# the original capture filename ended in .png. No pixels are modified here.
shots = sorted(set(s for p in points for s in p['screens']) | {
    'friend-memory-disabled','friend-memory-reenabled','friend-swarm-form',
    'dsh-general','dsh-builtins','dsh-plan-execution-result','zcode-memory',
    'zcode-computer-use','zcode-login-condition','minimax-mcp-loading'
})
for name in shots:
    src = QA / 'screenshots' / (name + '.png')
    raw = src.read_bytes()
    assert raw.startswith(b'\xff\xd8'), name
    (OUT / 'screenshots' / (name + '.jpg')).write_bytes(raw)
    shutil.copy2(QA / 'screenshots' / (name + '.txt'), OUT / 'screenshots' / (name + '.txt'))
for p in points:
    for typ in ['before','after','comparison']:
        name = f"{p['id']}-{typ}.png"
        shutil.copy2(QA / 'report-render' / name, OUT / 'visuals/png' / name)
shutil.copy2(QA / 'report-render/visual-review.json', OUT / 'evidence/visual-review.json')

gaps = [
 ('SWARM-STOP-OBJECTIVE-CHECK','P1','停止后宿主检查继续执行','真实延迟Node进程探针'),
 ('SWARM-TARGETED-REWORK','P2','返工重跑未受影响任务','独立两任务控制器探针'),
 ('EXPERT-AUTO-TOOL-SCOPE','P2','自动采用与明确采用工具范围不一致','独立专家策略探针'),
 ('SWARM-SHARED-EVENT-COMMIT','P2','共享变更事件先于事务提交','双SQLite连接探针'),
 ('R02','P1','纠正一个事实丢掉同来源无关约束','Memory/ReBuild组合回归'),
 ('R01','P2','普通更正仍同时保留新旧有效要求','组合回归及本轮真实GUI'),
 ('M01','P2','请帮我记住的中文表达误拒绝','独立明确偏好回归'),
 ('M02','P2','跨会话前台未抢占另一后台调用','双活控制器回归'),
 ('M03','P2','遗忘原史fork后换词事实重新成为候选','真实Pi fork与fake reflection回归'),
 ('CL-01','P1','缺失原史静默替换索引','真实Main隔离VM/harness'),
 ('CL-02','P2','Diff漏掉未跟踪文件','真实Git与本轮真实GUI'),
 ('CL-03','P2','冷恢复消息投影丢工具/多模态结构','真实Pi JSONL与SDK进程'),
 ('CL-05','P2','默认Swarm和默认插件互相矛盾','实际Main隔离harness')
]
metadata = {
 'date': data['date'], 'scope': 'audit and product research only; evolution not implemented',
 'sourceCommit': '5ec4b39fb7301ac57715976458f602909fc0a0fb',
 'piCommit': 'eb326d265ae0b88489a6d10319307780df827cdf',
 'appSha256': 'a066e009e9d073ee3f49fc5b0e73307da857d57d6b2a425cabd16e7fbc6097d4',
 'zipSha256': '62fcb20db6aed9edbcbd44e6f6c9d246528cfff3e07e2b792419f33c8c570375',
 'appPath': str(ROOT / '.artifacts/mac/Friend-Pi.app'),
 'testSummary': '95 existing tests PASS; 43/31 focused are subsets, not added to 95; 5 new positive probes PASS; 13 confirmed gaps across independent probes/harnesses',
 'functionalCompleteness': 'NOT_PASSED', 'evolutionImplemented': False,
 'confirmedGaps': [dict(zip(['id','severity','finding','evidenceLevel'],g)) for g in gaps],
 'researchFeatureUnits': {'MiniMax':34,'Reasonix':28,'Codex':24,'DSH':26,'ZCode':24},
 'cuaCodex': 'BLOCKED_SELF_APP; no bypass attempted',
 'credentials': 'No auth files or keys read or copied in this audit/research; existing configured models only',
 'screenshotPolicy': 'Real CUA JPEG bytes, separate from illustrative before/after SVG and PNG',
 'decisionStatus': 'Point19 unified light workbench is user-selected; other choices pending; no source functionality changed'
}
(OUT / 'verification-summary.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2))

intro = '''# Friend-Pi 后续演进规划书

2026-10-07 · 本地候选核验与竞品体验 · 19 个可分别决策的优化点

**当前已开发能力的完备性尚未通过。** 本轮重跑原有95项测试、类型检查与制品摘要复核通过，但独立需求探针/harness确认13项缺口。核心Single、Swarm、Expert、Memory和ReBuild路径确实存在，不能把‘存在并能完成小任务’当作‘原计划所有边界已完备’。建议先修原承诺，再选择体验增强。本文只交付核验与演进方案，没有执行这些演进。

主界面继续使用浅色Friend布局：顶栏横向项目，左栏纵向会话与状态，中央对话和轮次侧轨，底部计划滑块及Single/Swarm，右上单一工作台入口，内部切文件/Diff/Swarm/Expert/Memory五页。设置承接启停、全库与长期管理；上下文后台维持，不设工作台页面。统一轻量工作台为用户已确定的方向（19），其余演进待选择。取消上下文页不算修复R01/R02，后台纠正和来源失效仍是首要修复项。当前预览、书签、拖动分栏已经实现，这里是增强方案，不重复宣称新开发。

## 阅读与决策

- [可交互规划书](index.html)：逐项看图、筛选优先级，选择‘采用/稍后/不做’，导出本地决策JSON。不会自动执行、联网或改变Friend-Pi配置。
- [19组图集](visuals/index.html)：每点都有优化前/后产品布局对比，SVG可放大，PNG可下载。
- [完整核验摘要](verification-summary.json)与[evidence/](evidence/)：原始报告、功能矩阵和强复现结果。
- 所有‘前’图是**固定候选的缩略示意和示例数据**，依据源码/实测构图；真实截图另列。所有‘后’图是**未实现方案**，不能当作开发完成证据。

## 固定候选与核验边界

| 项目 | 固定身份 / 结果 |
|---|---|
| 被核验业务源码 | `5ec4b39fb7301ac57715976458f602909fc0a0fb` |
| Pi | `eb326d265ae0b88489a6d10319307780df827cdf` |
| macOS app树SHA256 | `a066e009e9d073ee3f49fc5b0e73307da857d57d6b2a425cabd16e7fbc6097d4` |
| ZIP SHA256 | `62fcb20db6aed9edbcbd44e6f6c9d246528cfff3e07e2b792419f33c8c570375` |
| 当前app | `/Users/youdongliang/Desktop/Friend-Pi/.artifacts/mac/Friend-Pi.app` |
| 原有测试 | 新跑95/95与typecheck通过；Swarm/Expert43、Memory/ReBuild31属于既有覆盖子集，不累加成169 |
| 新正向边界 | 真实Git冲突保留、Expert回滚不可变版本；SQLite保存/遗忘故障原子回滚、跨会话原史查询，共5项通过 |
| 独立缺口 | 下表13项；source/harness、fake provider与真实GUI层级分别标明 |

根Agent本轮实际Friend-Pi旅程：新隔离项目、真实DeepSeek只读请求与流式结算；普通纠正→有效约束冲突；Memory候选采用/来源/纠正v3/版本/搜索/导出；Expert新建/编辑v2/回滚v3/停用及验证表单；自动拆分被非法范围拒绝、手动两只读成员整合、共享材料v1；原史搜索/前后文和小会话整理回退；文本文件预览与漏报Diff；轮次浮卡、319→251拖分栏、720×610窄屏、空闲Memory禁用/重新加载与业务数据保留。所有写入在本次自有测试项目或其插件业务记录，未修改原Friend或现有Pi配置，没有读/打印/转移API Key。

本轮未完整重做：真实图片模型旅程、Pi四类交互的确认/取消/超时GUI全组合、成员崩溃/合并失败的GUI全路径、真正长窗口多主题所有组合、每插件单独原生Pi GUI旅程。部分有现有同候选测试/前轮真实模型证据，但不能换算成本轮全GUI验收。新回归失败不会被旧报告里的localCandidateVerified盖过；也没有声称正式Acceptance。

## 确认缺口

P1/P2是缺陷严重程度；规划的P0/P1/P2是施工顺序，两套含义不同。CL-04旧提交回填目前仅源码风险，不纳入13项确认数。

| ID | 程度 | 现象 | 本轮证据 |
|---|---|---|---|
'''
intro += '\n'.join('| '+' | '.join(g)+' |' for g in gaps)
intro += '''

另有部分实现/增强边界：Dream语义去重、冲突/过期；专家结构化适用范围与非JSON客观基准；缺Expert时方法候选恢复补投；Plan陌生目录只读探索；已有suite读回编辑；Markdown常用结构、完整历史投影、长期设置归位。浏览器、交互终端、Team、侧聊、浮动多窗口、外部Agent后端、旧Friend迁移是首版排除项，不能作为首版开发缺陷计数。

原始核验：[客户端59条](evidence/client/client-completeness-matrix.json) · [Swarm/Expert28条](evidence/swarm-expert/coverage.json) · [Memory/ReBuild37条](evidence/memory-rebuild/requirement-coverage.json)。这些矩阵有交叉，不相加为独立功能数或通过率。

## 竞品体验与版本

调研先建完整功能地图，再访问可用客户端入口及小批真实旅程：MiniMax34、Reasonix28、Codex24、DSH26、ZCode24，共136条**按产品归类的功能条目**。这不是136条已跑通过的测试。每条标为资料、看到入口、过程核实、具体结果核实、加载中、受限或未执行；主报告不把按钮存在算执行通过。

| 产品 | 已安装版本 | 本轮实际体验 | 资料/源码边界 |
|---|---|---|---|
| MiniMax Code | 3.0.68 | 首页/项目选择、真实任务提交尝试、设置搜索/通用/个性化记忆/快捷键/审查/工作树/连接、插件/技能/MCP管理、自定义Agent表单、Schedule/Sites/Remote入口 | 新任务提交后未见可确认执行结果，插件/MCP/Sites持续加载；不猜网络原因。公开TUI/runtime `56221c121c6e63d0e50b68f57d4abf083afed119` 与桌面不同 |
| Reasonix | 1.38.6 | 隔离项目读取README+测试、一次工具批准、停止ask、正式Plan生成→审批→两文件改动+两测试通过、文件树→Markdown预览、多类设置与健康检查页面 | 精确标签 `e2145b031deef603d9ec1acc9d30f9a1e1ac9325`；当前repo Studio `63195e95a5b95c4b2c69481dea272fc4d5ce0bcd` 是另一条线。Diff点击未证明转变；多成员/rewind恢复全流程未完成 |
| DeepSeek Harness | 0.2.0-rc.2 | 首设向导跳过充值、隔离工作区真实只读测试、工具输入/输出EXIT=0、Plan菜单→右全文审批→批准执行→两文件改动+两测试通过、两只读成员协作/谱系/成员原会话、通用/模型/插件/Agentpreset | 初始充值提醒不等于无额度，现有配置确实能运行。本机代码工作视图未启用，未改用户设置，专门Trajectory及Changes未体验。源码 `5badb15009ae1756c3afe0ae0cef1faafc290ccc` 所属版本0.2.1-alpha.1与装机不同，完整SHA见来源记录 |
| Codex desktop | 26.1002.51308 | 本轮Computer Use明确禁止访问自应用；仅使用用户给定轮次预览截图、官方资料与公开源码 | 没有绕过限制，没有GUI通过声明。公开CLI/backend `afb436df8b70bb5bc57b86d9a3e829968988cd21` 不等于闭源desktop；官方旧Codex文档重定向统一ChatGPT/Codex，新增Work/dots不自动算装机功能 |
| ZCode | 3.14.3 | 跳过登录后查看模型、外观、浏览器/电脑控制、快捷键、记忆、子Agent、插件、MCP、技能、命令、Hooks，共12页；未改已有草稿 | 未配置可执行模型，本轮无真实任务。源 `29628c9acdb81b703bbd4080c207a0e7ce5e276e`；Computer Use公开NOTICE为占位，看到设置不能当作真系统控制；记忆页本机实际存在，与旧官网‘无管理UI’不同 |

Reasonix与DSH的批准后实现均被根Agent独立再跑Node24测试和Git差异验证：各2/2测试、仅index.js/test.mjs，+2/−1。[独立结果](evidence/competitor-independent-results.json)。它证明这些夹具的happy path，不证明产品所有组合正确。

功能全集与逐项范围：[MiniMax/Reasonix地图](evidence/research/minimax-reasonix/research-notes.md) · [62条体验覆盖](evidence/research/minimax-reasonix/hands-on-coverage-draft.md) · [Codex/DSH/ZCode地图](evidence/research/codex-dsh/research.zh.md) · [74条体验覆盖](evidence/research/codex-dsh/hands-on-coverage-draft.md)。远程/手机配对、IM外发、充值、发布、购买、额外系统权限和新凭证配置只研究入口，未执行。没有把同名Ocean装机应用映射成未经核实的社区主题项目，后者仅保留额外开源参考。

## 产品取舍与依赖顺序

1. **A：原承诺修复门槛。** 01–08先做；09定向返工、10事件顺序、11只读探索、16配置依赖、17suite读回里的既有承诺修补也应提前，不能因放在增强组就延后。所有13回归先转绿，再选体验扩张。
2. **B：日常开发主流程。** 03/04的消息与变更为基础，完成11计划审批、12会话待处理、15文件材料、16设置归位。每项独立可用，避免等待整套大改才交付。
3. **C：四能力可解释性。** 09任务图与定向返工、10共享冲突、17专家验证、18现场来源；以可回查证据衡量，不靠更复杂的Dashboard。
4. **D：使用质量。** 13轮次筛选、14布局预设和快捷键；保留已经满足的Friend布局，持续窄屏/键盘检查。

19统一轻量工作台已由用户选定为交互方向。建议的首批选择是A的原承诺修复，加B中的11、12、15、16，并与19一起整合。用户也可以只选修复；其余不默认实施。工作量S=局部闭包，M=跨2–3层接口，L=涉及持久语义/迁移/调度的较大闭包；不是工期承诺。应在修复边界确认后拆成可单独验收的小批。浏览器/交互终端/Goal无限循环/云端/IM/Canvas/多媒体生成作为研究中的扩张方向留后评估，本规划不默认把它们重新装回简化Friend。

公共边界始终保持：Pi原生SDK/JSONL权威；四插件独立安装；版本化跨插件请求和事件；快照在安全边界生效；本地独立数据；不修改Agent loop；不凭界面状态宣称OS沙箱。

## 逐项优化方案

每点可独立选择，但必须满足依赖。‘预期效果’是待验证的产品假设，不是已测提升率。

'''
lines = [intro]
fields = [('current','优化前'),('reference','竞品对照与证据范围'),('proposal','优化方案'),('ui','客户端变化'),('effect','预期使用体验'),('boundary','实现边界'),('acceptance','完成判据'),('risk','风险与限制')]
for p in points:
    lines += [f"### {p['id']} · {p['title']}\n\n**{p['priority']} · {p['kind']} · 工作量{p['effort']} · 依赖：{', '.join(p['depends']) or '无'}**\n"]
    for key,label in fields:
        lines.append(f"**{label}。** {p[key]}\n")
    lines.append(f"![{p['id']}优化前后对比，未来未实现](visuals/png/{p['id']}-comparison.png)\n")
    lines.append(f"[可放大SVG](visuals/{p['id']}-comparison.svg) · [优化前](visuals/{p['id']}-before.svg) · [优化后](visuals/{p['id']}-after.svg)\n")
    if p['screens']:
        lines.append('**真实截图。** '+' · '.join(f'[{s}](screenshots/{s}.jpg)' for s in p['screens'])+'。截图仅支持上文已注明的观察，不能证明全部交互组合。\n')
    lines.append('**核验依据。** '+ '；'.join(p['evidence'])+'。\n')
    if p['id']=='19': lines.append('[当前Memory/Expert采用证据与最小接口建议](evidence/research/codex-dsh/friend-pi-usage-receipt-boundary.md)\n')
    if p['id']=='19': lines.append('[用户明确指定统一工作台的原图](reference-images/user-unified-workbench.png)\n')
    if p['id']=='13': lines.append('[用户给定Codex轮次预览原图](reference-images/codex-turn-preview.png)\n')
    if p['sources']:
        lines.append('**一手参考。** '+' · '.join(f'[{source_title(u)}]({u})' for i,u in enumerate(p['sources']))+'。\n')
lines.append('''## 验收与后续施工方式

每批要形成可复现闭包：需求回归→控制器/SDK测试→同候选实际GUI→真实模型小旅程→冷重启/取消→制品与来源记录。先保留当前失败用例，不允许改变断言掩盖缺口。写并发仍用独立worktree，整合串行；GUI保持单一调度。新接口先冻结再并行，每个子Agent明确目录与共享写边界。

本地报告不创建远端、发npm、签名发行或宣布Acceptance。你选择后再实施；涉及持久数据迁移时另给备份/回退的可审核方案。新候选最终记录代码commit、Pi SHA、app/ZIP摘要及绝对路径；重新跑同候选Computer Use，而不是用本次研究截图冒充新候选验收。

## 开源参考与引用记录

本轮只研究和生成原创示意图，没有复制竞品实现源码。Pi保留原固定SHA。MiniMax公开源主要MIT、部分vendored Apache-2.0；Reasonix标签MIT；DSH MIT；Codex Apache-2.0；ZCode Apache-2.0及NOTICE中明确的第三方/占位范围。后续实际复用仍按文件核查许可证、固定commit、版权/NOTICE和修改记录，不能只写一句致谢替代许可义务。

完整精确来源见[evidence/research/codex-dsh/sources.json](evidence/research/codex-dsh/sources.json)和[MiniMax/Reasonix引用笔记](evidence/research/minimax-reasonix/research-notes.md)。官方在线资料截至2026-10-07可读；装机版本和源码检出刻意分别记录，不自动更新软件或用户参考工作树。

## 决策表

逐项选择‘采用 / 稍后 / 不做’，可追加范围和验收条件。交互版导出的是本地JSON，不发送至服务，也不会直接触发开发。

| ID | 优化点 | 顺序 | 你的决定 |
|---|---|---|---|
''')
lines += [f"| {p['id']} | {p['title']} | {p['priority']} | {'已确定方向，尚未实施' if p['id']=='19' else '待选择'} |" for p in points]
(OUT / '规划书.md').write_text('\n'.join(lines))

cards=[]
for p in points:
    content=''.join(f'<div class="field"><b>{esc(label)}</b><p>{esc(p[key])}</p></div>' for key,label in fields)
    localreceipt='<a href="evidence/research/codex-dsh/friend-pi-usage-receipt-boundary.md">Memory/Expert采用源码边界与接口</a>' if p['id']=='19' else ''
    screenlinks=' · '.join(f'<a target="_blank" href="screenshots/{s}.jpg">{esc(s)}</a>' for s in p['screens'])
    sources=' · '.join(f'<a target="_blank" rel="noreferrer" href="{esc(u)}">{esc(source_title(u))}</a>' for i,u in enumerate(p['sources']))
    cards.append(f'''<article class="point" id="p{p['id']}" data-priority="{p['priority']}"><div class="point-head"><span class="tag">{p['priority']}</span><h2>{p['id']} · {esc(p['title'])}</h2><select aria-label="{esc(p['title'])}的决定" data-decision="{p['id']}"><option value="pending">待选择</option><option value="adopt">采用</option><option value="later">稍后</option><option value="skip">不做</option></select></div><p class="meta">{esc(p['kind'])} · 工作量{p['effort']} · 依赖 {', '.join(p['depends']) or '无'} · 未来未实现</p><a class="compare" href="visuals/{p['id']}-comparison.svg" target="_blank"><img loading="lazy" src="visuals/png/{p['id']}-comparison.png" alt="优化前后示意；当前缩略示意，未来未实现"></a><div class="details">{content}</div><div class="evidence">核验：{esc('；'.join(p['evidence']))}<br>真实截图：{screenlinks or '此项为源码/harness证据，无真实GUI截图'}<br>{sources}<br>{localreceipt}</div><label class="notes-label">补充范围与验收条件<textarea data-note="{p['id']}" placeholder="你可以只选其中一部分，或调整优先级。"></textarea></label></article>''')
nav=''.join(f'<a href="#p{p["id"]}">{p["id"]} {esc(p["title"])}</a>' for p in points)
gaprows=''.join('<tr>'+''.join('<td>'+esc(v)+'</td>' for v in g)+'</tr>' for g in gaps)
page='''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Friend-Pi 后续演进规划书</title><style>
:root{font-family:Inter,-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#243930;background:#f4f6f3;font-size:15px;line-height:1.7}*{box-sizing:border-box}body{margin:0}a{color:#267457}button,select{font:inherit;border:1px solid #c4d6c9;background:white;border-radius:8px;padding:7px 10px;color:#234331;cursor:pointer}.shell{max-width:1600px;margin:auto;display:grid;grid-template-columns:248px 1fr;gap:24px;padding:24px}.nav{position:sticky;top:20px;height:calc(100vh - 40px);overflow:auto;background:white;border:1px solid #dbe4dc;border-radius:16px;padding:18px}.nav a{display:block;font-size:13px;padding:6px 0;text-decoration:none}.brand{font-size:23px;font-weight:750;color:#3a7f68;margin-bottom:14px}.cover,.point,.audit{background:white;border:1px solid #dbe4dc;border-radius:18px;margin-bottom:22px;padding:26px}.cover h1{font-size:32px;line-height:1.3;margin:10px 0}.kicker{font-size:12px;letter-spacing:1px;color:#598b72}.notice{border-left:4px solid #c29534;background:#fcf5e7;padding:14px 18px}.hint{color:#607165}.toolbar{position:sticky;top:0;z-index:2;background:#f4f6f3f5;backdrop-filter:blur(8px);display:flex;gap:10px;flex-wrap:wrap;padding:12px 0}.point{scroll-margin-top:78px}.point-head{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.point-head h2{font-size:23px;flex:1;margin:0}.tag{background:#e4f0e6;color:#38694e;font-weight:700;padding:2px 10px;border-radius:30px;font-size:12px}.meta{font-size:13px;color:#65756c}.compare{display:block;background:#f7f9f6;border:1px solid #dce5dc;border-radius:12px;margin:18px 0;overflow:hidden}.compare img{display:block;width:100%;height:auto}.details{display:grid;grid-template-columns:1fr 1fr;gap:18px}.field{padding:14px;background:#f9faf7;border-radius:10px}.field b{color:#385f4b}.field p{margin:7px 0 0}.evidence{font-size:12px;color:#6a776d;margin-top:16px;overflow-wrap:anywhere}.notes-label{display:block;margin-top:16px;color:#566c5e}textarea{display:block;width:100%;min-height:74px;font:inherit;padding:10px;border-radius:8px;border:1px solid #cbd9cc;margin-top:8px}.audit summary{cursor:pointer;font-size:20px;font-weight:700}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;border-bottom:1px solid #e2e8df;padding:10px;vertical-align:top}code{font-size:12px;overflow-wrap:anywhere}.product{display:grid;grid-template-columns:150px 1fr;gap:14px;margin:14px 0}.footer{font-size:12px;color:#637166}.status{font-size:13px;color:#578266}article[hidden]{display:none}@media(max-width:950px){.shell{grid-template-columns:1fr;padding:12px}.nav{position:static;height:auto;max-height:230px}.details{grid-template-columns:1fr}.cover,.point,.audit{padding:18px}.point-head h2{font-size:20px}}@media print{.nav,.toolbar,select,textarea,.notes-label{display:none}.shell{display:block;padding:0}.point,.audit{break-inside:avoid;border-radius:0}.compare img{max-height:400px;object-fit:contain}.cover{border:none}}
</style></head><body><div class="shell"><aside class="nav"><div class="brand">Friend <small>Pi</small></div><b>19 项演进决策</b><p class="hint">浅色 · 原Friend布局<br>先修功能，再选增强</p>__NAV__<hr><a href="规划书.md">完整Markdown规划书</a><a href="规划书.pdf">可分享PDF</a><a href="visuals/index.html">19组SVG图集</a><a href="verification-summary.json">核验摘要与候选身份</a></aside><main><section class="cover"><span class="kicker">产品核验 · 竞品研究 · 决策稿 / 2026-10-07</span><h1>Friend-Pi 后续演进规划书</h1><p>19 个优化点，每点有现状、竞品依据、实施边界、完成判据和前后产品对比图。保留横向项目、纵向会话、轮次侧轨、底部计划/协作控制与统一工作台五个轻页面；启停和详细管理放设置，上下文不展示。</p><div class="notice"><b>修复前历史基线：当时功能完备性未通过。</b><br>原95项测试与制品核对通过；新增独立核验确认13个缺口。用户现已批准并实施本批修复；请查看 <a href="../../implementation/2026-10-07/comparison.html">最新实施对比与边界</a>。此处保留研究时点证据。已有轮次预览、书签、拖动分栏不重复算作待开发。</div><p class="hint">图中左侧是源码/实测依据的缩略示意与示例数据，右侧是未来方案；实际截图另附。采用选项只保存到本浏览器并可导出JSON，不联网、不自动执行。</p><p><a href="规划书.md">阅读全文与全部功能覆盖边界</a> · <a href="evidence/research/minimax-reasonix/hands-on-coverage-draft.md">MiniMax / Reasonix覆盖</a> · <a href="evidence/research/codex-dsh/hands-on-coverage-draft.md">Codex / DSH / ZCode覆盖</a></p></section><section class="audit"><details><summary>功能核验：13个确认缺口与证据</summary><p>95既有测试通过；专项43/31是其子集，不重复累加。新增5个正向故障边界通过。P1/P2缺陷程度与规划P0/P1/P2施工顺序分别使用。</p><table><thead><tr><th>ID</th><th>程度</th><th>现象</th><th>证据</th></tr></thead><tbody>__GAPS__</tbody></table><p><a href="evidence/client/client-functional-audit.md">客户端核验</a> · <a href="evidence/swarm-expert/audit-report.md">Swarm/Expert</a> · <a href="evidence/memory-rebuild/report.zh.md">Memory/ReBuild</a></p><p>本轮真实GUI覆盖主要开发旅程；图片模型、全交互超时/取消、崩溃合并恢复GUI全路径与长窗口全组合仍未完整覆盖。源码、fake Provider、历史同候选证据和本轮实际GUI严格分开。</p></details></section><section class="audit"><details><summary>竞品范围：136条功能地图，实际执行与受限分别记录</summary><div class="product"><b>MiniMax 3.0.68</b><span>设置、Memory summary、快捷键、审查/工作树、Plugin/MCP与Agent表单等已查看。新任务派发未确认结果，清单持续加载；执行未写通过。公开CLI与桌面不同。</span></div><div class="product"><b>Reasonix 1.38.6</b><span>真实只读测试、一次性工具批准、停止ask、正式Plan审批执行、文件预览；批准后Node24独立复验2/2通过。Diff按钮点击未证明实际切换。</span></div><div class="product"><b>DSH 0.2.0-rc.2</b><span>真实只读测试、工具EXIT=0、计划全文与批准执行，独立复验2/2通过。另实际两只读成员完成并打开原会话。代码工作视图未开，不把普通工具展开当Trajectory或Changes验收。</span></div><div class="product"><b>Codex 26.1002</b><span>Computer Use安全限制禁止访问自应用；本轮仅用户截图、官方文档与公开源研究，不声称亲手GUI验证。闭源桌面与开源CLI区分。</span></div><div class="product"><b>ZCode 3.14.3</b><span>12个管理页面实际查看，未配置模型所以没有真实运行。Computer Use源是占位，设置开关不等于实跑。未转移任何API Key。</span></div><p>Phone/IM/remote/充值/发布/新凭证/额外权限没有执行。Ocean装机身份未验证，未与同名社区主题相混。本稿不以通过率概括这些不同证据。</p></details></section><section class="audit"><details><summary>推荐顺序与产品取舍</summary><p>A：先修13缺口与已承诺但有限的路径。B：计划审批、会话待处理、文件材料和设置归位。C：任务图/专家验证/来源连续性。D：轮次筛选与布局质量。09/10/11/16/17中的既有承诺修复提前，不能等增强。</p><p>S/M/L是相对闭包大小，不是工期保证。浏览器、交互终端、Team、侧聊、多窗口、云端、IM与媒体生成不默认加入简化Friend。保持Pi loop和JSONL权威、四独立插件与安全边界快照。</p></details></section><div class="toolbar"><select id="filter" aria-label="按优先级筛选"><option value="all">全部优化点</option><option>P0</option><option>P1</option><option>P2</option></select><button id="export">导出我的决策</button><button id="print">打印 / 另存PDF</button><span class="status" id="decision-status" aria-live="polite"></span></div>__CARDS__<p class="footer">业务候选 5ec4b39 · Pi eb326d2 · 当前 app 未重建。报告工件与示意图是独立研究交付；没有创建远端、发npm、签名发行或宣称Acceptance。__HASH__</p></main></div><script>
const key='friend-pi-evolution-decisions-2026-10-07';let choices={};try{choices=JSON.parse(localStorage.getItem(key)||'{}')}catch{}if(!choices['19'])choices['19']={decision:'adopt',note:'用户已明确：统一工作台五个轻页面，启停/管理放设置，取消上下文tab。方案尚未实施。'};const ids=__IDS__;const titles=__TITLES__;
function status(){document.querySelector('#decision-status').textContent=`已选择 ${Object.values(choices).filter(x=>x.decision&&x.decision!=='pending').length} / ${ids.length} 项`}
function persist(){try{localStorage.setItem(key,JSON.stringify(choices))}catch{}status()}
document.querySelectorAll('[data-decision]').forEach(el=>{const id=el.dataset.decision;el.value=choices[id]?.decision||'pending';el.addEventListener('change',()=>{choices[id]={...choices[id],decision:el.value};persist()})});document.querySelectorAll('[data-note]').forEach(el=>{const id=el.dataset.note;el.value=choices[id]?.note||'';el.addEventListener('input',()=>{choices[id]={...choices[id],note:el.value};persist()})});
document.querySelector('#filter').addEventListener('change',e=>document.querySelectorAll('.point').forEach(el=>el.hidden=e.target.value!=='all'&&el.dataset.priority!==e.target.value));document.querySelector('#print').addEventListener('click',()=>window.print());document.querySelector('#export').addEventListener('click',()=>{const value={report:'Friend-Pi后续演进规划书',reportDate:'2026-10-07',candidate:'5ec4b39fb7301ac57715976458f602909fc0a0fb',evolutionImplemented:false,exportedAt:new Date().toISOString(),points:ids.map((id,i)=>({id,title:titles[i],decision:choices[id]?.decision||'pending',note:choices[id]?.note||''}))};const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));a.download='Friend-Pi演进决策.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)});status();
</script></body></html>'''
page = page.replace('__NAV__',nav).replace('__GAPS__',gaprows).replace('__CARDS__',''.join(cards)).replace('__HASH__', metadata['appSha256']).replace('__IDS__',json.dumps([p['id'] for p in points])).replace('__TITLES__',json.dumps([p['title'] for p in points], ensure_ascii=False))
(OUT / 'index.html').write_text(page)

# Self-contained printable PDF, with exact text and high-resolution diagrams.
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Image, PageBreak
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
normal=ParagraphStyle('zh',fontName='STSong-Light',fontSize=10,leading=16,wordWrap='CJK',spaceAfter=8)
title=ParagraphStyle('title',parent=normal,fontSize=22,leading=28,spaceAfter=15)
heading=ParagraphStyle('heading',parent=normal,fontSize=15,leading=21,spaceAfter=12)
story=[]
def para(txt,style=normal):
    return Paragraph(esc(txt).replace('\n','<br/>'),style)
story += [para('Friend-Pi 后续演进规划书',title),para('2026-10-07 · 19项决策稿 · 未来方案未实现',heading),para('当前完备性未通过。95既有测试通过，13独立缺口确认；先修原承诺，再选体验增强。真实截图和逐条功能矩阵见同目录HTML/Markdown。PDF包含19个优化点的完整核心说明和独立前后示意图。'),para('固定候选：'+metadata['sourceCommit']),para('Pi：'+metadata['piCommit']),para('app树摘要：'+metadata['appSha256']),para('本PDF的优化前界面是依据固定候选的缩略示意及示例数据，不是真实截图；优化后为尚未实现的提案。图集SVG/HTML可放大。'),para('施工：A原承诺修复；B日常开发主流程；C四能力可解释性；D布局使用质量。S/M/L是相对闭包大小，不是工期承诺。'),para('竞品边界：MiniMax派发未确认、Codex自应用CUA受限、ZCode未配置模型；Reasonix/DSH指定Plan夹具实际执行并独立复验各2测试通过，不推广到全部功能。'),PageBreak(),para('13个确认缺口',heading)]
for g in gaps: story.append(para(' · '.join(g)))
story += [para('额外部分路径：Dream语义整理、Expert基准管理/适用范围、只读Plan目录探索、常用Markdown、设置归位。首版排除能力不列为开发缺陷。'),PageBreak()]
for p in points:
    story += [para(p['id']+' · '+p['title'],title),para(p['priority']+' / '+p['kind']+' / 工作量'+p['effort']+' / 依赖 '+(','.join(p['depends']) or '无'))]
    for key,label in fields: story.append(para(label+'：'+p[key]))
    story += [para('核验依据：'+'；'.join(p['evidence'])),para('真实截图：'+(', '.join(p['screens']) or '仅源码/隔离harness；无GUI截图')),para('一手来源：\n'+'\n'.join(p['sources'])),para('本地采用边界证据：evidence/research/codex-dsh/friend-pi-usage-receipt-boundary.md') if p['id']=='19' else Spacer(1,1),PageBreak()]
    for typ,label in [('before','优化前 · 缩略示意与示例数据'),('after','优化后 · 尚未实现')]:
        file=OUT/'visuals/png'/f"{p['id']}-{typ}.png"
        from PIL import Image as PILImage
        w,h=PILImage.open(file).size
        story += [para(p['id']+' · '+p['title'],heading),para(label),Image(str(file),width=510,height=510*h/w),para(p['current'] if typ=='before' else p['proposal']),PageBreak()]
if isinstance(story[-1],PageBreak): story.pop()
def footer(canvas,doc):
    canvas.setFont('STSong-Light',8);canvas.setFillColorRGB(.4,.5,.43);canvas.drawString(42,28,'Friend-Pi · 2026-10-07 · 决策稿，未实施');canvas.drawRightString(555,28,str(doc.page))
SimpleDocTemplate(str(OUT/'规划书.pdf'),pagesize=A4,rightMargin=42,leftMargin=42,topMargin=42,bottomMargin=44,title='Friend-Pi 后续演进规划书',author='Friend-Pi research').build(story,onFirstPage=footer,onLaterPages=footer)

manifest=[]
for path in sorted(OUT.rglob('*')):
    if path.is_file() and path.name not in ['delivery-manifest.json']:
        raw=path.read_bytes();manifest.append({'file':str(path.relative_to(OUT)),'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest()})
(OUT/'delivery-manifest.json').write_text(json.dumps({'date':data['date'],'auditedCandidate':metadata['sourceCommit'],'futureImplemented':False,'files':manifest},ensure_ascii=False,indent=2))
print(json.dumps({'points':len(points),'confirmedGaps':len(gaps),'report':str(OUT/'index.html'),'pdf':str(OUT/'规划书.pdf'),'files':len(manifest)},ensure_ascii=False))
