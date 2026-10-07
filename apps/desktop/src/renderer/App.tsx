import { useCallback, useEffect, useRef, useState } from 'react';
import { ExpertPanel, MemoryPanel, RebuildPanel, SwarmPanel } from './panels.js';
import { asList, asObject, contentText, errorText, pluginLabels, type AppState, type DialogRequest, type JsonObject, type PluginName, type WorkspaceTab } from './types.js';
import { Badge, Empty, Field, JsonView, Markdown, Modal } from './ui.js';
import {TurnIndex,messageAnchor} from './TurnIndex.js';

const EMPTY: AppState = { projects: [], sessions: [], current: null, models: [], providers: [] };
const plugins: PluginName[] = ['swarm', 'expert', 'memory', 'topic-rebuild'];
const labels: Record<WorkspaceTab, string> = { ...pluginLabels, file: '文件', diff: 'Diff', providers: '模型设置' };
interface ToolRun { id: string; name: string; status: string; input: unknown; output?: unknown; error?: boolean }
function pickedPaths(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  const result = asObject(value);
  const values = Array.isArray(value) ? value : Array.isArray(result.paths) ? result.paths : result.path ? [result.path] : [];
  return values.map(item => typeof item === 'string' ? item : String(asObject(item).path || '')).filter(Boolean);
}

function ProviderPanel({ state, report, refresh }: { state: AppState; report(message: string, error?: boolean): void; refresh(): Promise<AppState> }) {
  const [provider, setProvider] = useState(state.current?.modelId?.split('/')[0] || state.providers[0]?.id || 'openai');
  const [custom, setCustom] = useState(''); const [apiKey, setApiKey] = useState(''); const [baseUrl, setBaseUrl] = useState(''); const [modelId, setModelId] = useState(''); const [api, setApi] = useState('openai-completions');
  const [pending, setPending] = useState(false);
  return <div className="panel-content"><div className="panel-intro"><h2>选择你自己的模型</h2><p>凭证保存在 Friend-Pi 独立目录。先打开项目会话，保存后可在对话输入区选择型号。</p></div><form className="card" onSubmit={event => { event.preventDefault(); setPending(true); void window.friendPi.request('provider.save', { provider: provider === '__custom' ? custom : provider, apiKey, ...(baseUrl.trim() ? { baseUrl: baseUrl.trim(), api, modelId: modelId.trim() } : {}) }).then(async () => { setApiKey(''); await refresh(); report('供应商配置已保存'); }).catch(error => report(errorText(error), true)).finally(() => setPending(false)); }}><Field label="供应商"><select value={provider} onChange={event => { setProvider(event.target.value); setApiKey(''); }}>{state.providers.map(item => <option key={item.id} value={item.id}>{item.name}{item.configured ? ' · 已配置' : ''}</option>)}{state.providers.length === 0 && <option value="openai">OpenAI</option>}<option value="__custom">其他兼容供应商</option></select></Field>{provider === '__custom' && <Field label="供应商 ID"><input value={custom} onChange={event => setCustom(event.target.value)} placeholder="例如 my-provider" required /></Field>}<Field label="API Key"><input type="password" autoComplete="off" spellCheck={false} value={apiKey} onChange={event => setApiKey(event.target.value)} placeholder="输入你明确配置的凭证" required /></Field><details open={provider === '__custom'}><summary>兼容接口设置</summary><Field label="Base URL"><input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://example.com/v1" type="url" /></Field><Field label="型号 ID"><input value={modelId} onChange={event => setModelId(event.target.value)} placeholder="供应商提供的实际型号" /></Field><Field label="API 协议"><select value={api} onChange={event => setApi(event.target.value)}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></Field></details><button type="submit" className="primary full" disabled={!state.current || pending || !apiKey.trim() || baseUrl.trim() !== '' && !modelId.trim() || provider === '__custom' && !custom.trim()}>{pending ? '保存中…' : '保存配置'}</button></form><div className="provider-list">{state.providers.filter(item => item.configured).map(item => <div key={item.id}><span className="status-dot" />{item.name}<small>已配置</small></div>)}</div></div>;
}

function FilePanel({ projectId, report }: { projectId: string; report(message: string, error?: boolean): void }) {
  const [path, setPath] = useState(''); const [file, setFile] = useState<JsonObject | null>(null); const [loading, setLoading] = useState(false);
  const read = async (target = path) => { setLoading(true); try { const result = await window.friendPi.request('file.read', { projectId, path: target }); setFile(typeof result === 'string' ? { path: target, content: result } : asObject(result)); setPath(target); } catch (error) { report(errorText(error), true); } finally { setLoading(false); } };
  return <div className="panel-content"><div className="panel-intro"><h2>预览项目文件</h2><p>输入相对项目的路径，或选择项目中的文件。</p></div><form className="search-row" onSubmit={event => { event.preventDefault(); if (path.trim()) void read(); }}><input aria-label="文件路径" value={path} onChange={event => setPath(event.target.value)} placeholder="README.md" /><button type="submit" disabled={loading || !path.trim()}>打开</button></form><button className="secondary" onClick={() => { void window.friendPi.request('file.pick').then(value => { const target = pickedPaths(value)[0]; if (target) void read(target); }).catch(error => report(errorText(error), true)); }}>选择文件…</button>{file ? <div className="file-preview"><div className="file-caption">{String(file.path || path)}</div>{typeof file.dataUrl === 'string' && file.dataUrl.startsWith('data:image/') ? <img alt="项目图片预览" src={file.dataUrl} /> : <pre className="code-view">{String(file.content ?? file.text ?? '')}</pre>}{file.truncated === true && <p className="hint">内容过长，当前显示截取部分。</p>}</div> : <Empty title="选择一个文件开始预览" />}</div>;
}

function DiffPanel({ projectId, report }: { projectId: string; report(message: string, error?: boolean): void }) {
  const [diff, setDiff] = useState(''); const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => { setLoading(true); try { const result = await window.friendPi.request('git.diff', { projectId }); setDiff(typeof result === 'string' ? result : String(asObject(result).diff || asObject(result).text || '')); } catch (error) { report(errorText(error), true); } finally { setLoading(false); } }, [projectId, report]);
  useEffect(() => { void refresh(); }, [refresh]);
  return <div className="panel-content"><div className="panel-intro"><h2>查看当前改动</h2><p>核对项目中的工作区 Diff。</p><button className="secondary" disabled={loading} onClick={() => void refresh()}>刷新 Diff</button></div>{diff ? <pre className="diff-view">{diff.split('\n').map((line, i) => <span key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-remove' : line.startsWith('@@') ? 'diff-range' : ''}>{line}{'\n'}</span>)}</pre> : <Empty title={loading ? '正在读取改动…' : '当前没有工作区改动'} />}</div>;
}

function PiDialog({ dialog, respond }: { dialog: DialogRequest; respond(value: JsonObject): void }) {
  const [value, setValue] = useState(dialog.prefill || dialog.options?.[0] || '');
  return <Modal title={dialog.title} onClose={() => respond({ cancelled: true })}><form onSubmit={event => { event.preventDefault(); respond(dialog.kind === 'confirm' ? { confirmed: true } : { value }); }}>{dialog.message && <p className="dialog-message">{dialog.message}</p>}{dialog.kind === 'select' ? <Field label="选择"><select value={value} onChange={event => setValue(event.target.value)}>{dialog.options?.map(option => <option value={option} key={option}>{option}</option>)}</select></Field> : dialog.kind === 'input' ? <Field label="输入"><input value={value} onChange={event => setValue(event.target.value)} /></Field> : dialog.kind === 'editor' ? <Field label="编辑内容"><textarea rows={9} value={value} onChange={event => setValue(event.target.value)} /></Field> : null}<div className="button-row right"><button type="button" onClick={() => respond({ cancelled: true })}>取消</button><button className="primary" type="submit">{dialog.kind === 'confirm' ? '允许此操作' : '确认'}</button></div></form></Modal>;
}

export default function App() {
  const [state, setState] = useState<AppState>(EMPTY); const stateRef = useRef(state); stateRef.current = state;
  const [booting, setBooting] = useState(true); const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const [selectedProject, setSelectedProject] = useState(''); const [tab, setTab] = useState<WorkspaceTab | null>(null); const [sidebar, setSidebar] = useState(() => !window.matchMedia('(max-width: 760px)').matches);
  const [navigating,setNavigating]=useState(false); const [planMode,setPlanMode]=useState(false);
  const [draft, setDraft] = useState(''); const draftRef = useRef(draft); draftRef.current = draft;
  const [draftOwner,setDraftOwner]=useState<string|undefined>();
  const [mode, setMode] = useState<'single' | 'swarm'>('single'); const [attachments, setAttachments] = useState<{ path: string }[]>([]);
  const [sending, setSending] = useState(false); const [localRunning, setLocalRunning] = useState(false); const [swarmRunning, setSwarmRunning] = useState(false);
  const [liveText, setLiveText] = useState(''); const [thinking, setThinking] = useState(''); const [tools, setTools] = useState<ToolRun[]>([]);
  const [dialogs, setDialogs] = useState<DialogRequest[]>([]); const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
  const scroll = useRef<HTMLDivElement>(null); const composer = useRef<HTMLTextAreaElement>(null); const followScroll = useRef(true);
  const lastSubmitted = useRef<{ sessionId: string; text: string; attachments: { path: string }[]; failed: boolean } | null>(null);
  const sessionId = state.current?.sessionId; const projectId = state.current?.projectId || selectedProject || state.projects[0]?.id;
  const project = state.projects.find(item => item.id === projectId); const activeSession = state.sessions.find(item => item.id === sessionId);
  const running = Boolean(state.current?.isRunning || localRunning || swarmRunning);
  const report = useCallback((message: string, error = false) => setNotice({ message, error }), []);
  const refresh = useCallback(async () => { const next = await window.friendPi.request<AppState>('app.state'); setState({ ...EMPTY, ...next }); return next; }, []);
  const invoke = useCallback(async (method: string, input: JsonObject = {}) => { try { const result = await window.friendPi.request(method, input); await refresh(); return result; } catch (error) { report(errorText(error), true); throw error; } }, [report, refresh]);
  useEffect(() => {
    if (!window.friendPi) { report('请通过 Friend-Pi 桌面客户端打开此界面。', true); setBooting(false); return; }
    void refresh().catch(error => report(errorText(error), true)).finally(() => setBooting(false));
    return window.friendPi.onEvent(event => {
      if (event.type === 'state') { setState({ ...EMPTY, ...event.data as AppState }); return; }
      if (event.sessionId && event.sessionId !== stateRef.current.current?.sessionId) return;
      const data = asObject(event.data);
      if (event.type === 'notice') {
        const message = typeof event.data === 'string' ? event.data : String(data.message || '');
        if (message) report(message, data.level === 'error');
        const submitted = lastSubmitted.current;
        if (data.level === 'error' && submitted && submitted.sessionId === stateRef.current.current?.sessionId) { submitted.failed = true; if (!draftRef.current) { setDraft(submitted.text); setAttachments(submitted.attachments); } }
      }
      if (event.type === 'dialog') setDialogs(previous => previous.some(item => item.id === data.id) ? previous : [...previous, data as unknown as DialogRequest]);
      if (String(event.type) === 'dialog.closed') setDialogs(previous => previous.filter(item => item.id !== data.id));
      if (event.type === 'plugin' && data.pluginEvent === 'swarm.changed') setSwarmRunning(asObject(data.data).status === 'running');
      if (event.type !== 'pi') return;
      if (data.type === 'agent_start') { setLocalRunning(true); setLiveText(''); setThinking(''); }
      if (data.type === 'agent_settled') { setLocalRunning(false); setLiveText(''); setThinking(''); void refresh().catch(error => report(errorText(error), true)); }
      if (['message_start', 'message_update', 'message_end'].includes(String(data.type))) {
        const message = asObject(data.message);
        if (message.role === 'assistant') { setLiveText(contentText(message.content)); setThinking(asList<JsonObject>(message.content).filter(part => part.type === 'thinking').map(part => String(part.thinking || '')).join('\n')); }
      }
      if (data.type === 'tool_execution_start') setTools(previous => [...previous.slice(-49), { id: String(data.toolCallId), name: String(data.toolName), status: 'running', input: data.args }]);
      if (data.type === 'tool_execution_update' || data.type === 'tool_execution_end') setTools(previous => previous.map(tool => tool.id === data.toolCallId ? { ...tool, status: data.type === 'tool_execution_end' ? data.isError ? 'failed' : 'completed' : 'running', output: data.result || data.partialResult, error: data.isError === true } : tool));
    });
  }, [refresh, report]);
  useEffect(() => {
    let saved:JsonObject={};try{if(sessionId)saved=asObject(JSON.parse(localStorage.getItem(`friend-pi.draft.v1:${sessionId}`)||'{}'));}catch{}
    setDraft(typeof saved.text==='string'?saved.text:'');setAttachments(asList<JsonObject>(saved.attachments).filter(item=>typeof item.path==='string').map(item=>({path:String(item.path)})));setDraftOwner(sessionId);
    setLiveText(''); setThinking(''); setTools([]); setDialogs([]); setLocalRunning(false); setSwarmRunning(false); lastSubmitted.current = null; followScroll.current=true; setPlanMode(state.current?.planMode || false); if (state.current?.projectId) setSelectedProject(state.current.projectId);
  }, [sessionId]);
  useEffect(()=>{
    if(!sessionId||draftOwner!==sessionId)return;
    try{const key=`friend-pi.draft.v1:${sessionId}`;if(draft||attachments.length)localStorage.setItem(key,JSON.stringify({text:draft,attachments}));else localStorage.removeItem(key);}catch{/* The current in-memory draft is retained if local storage is full. */}
  },[sessionId,draftOwner,draft,attachments]);
  useEffect(() => { if (followScroll.current) scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'instant' }); }, [state.current?.messages, liveText, tools, thinking]);
  useEffect(() => { const handle = (event: KeyboardEvent) => { if (event.key === 'Escape' && dialogs.length === 0) { setTab(null); composer.current?.focus(); } }; window.addEventListener('keydown', handle); return () => window.removeEventListener('keydown', handle); }, [dialogs.length]);
  const send = async () => {
    if (!sessionId || !draft.trim() || sending || running) return;
    const submitted = { sessionId, text: draft, attachments, failed: false }; setSending(true); setLocalRunning(true); lastSubmitted.current = submitted; setTools([]); setNotice(null);
    try { await window.friendPi.request('session.send', { sessionId, text: draft, mode, attachments, planMode }); if (!submitted.failed) { setDraft(''); setAttachments([]); } followScroll.current = true; }
    catch (error) { setLocalRunning(false); report(errorText(error), true); }
    finally { setSending(false); }
  };
  const selectProject = async (id:string) => {
    if(running || sending || navigating || id===projectId && state.current) return;
    setNavigating(true);
    try { await invoke('project.select',{projectId:id});setSelectedProject(id);setTab(null); }
    catch { /* Keep the current project visible. */ }
    finally {setNavigating(false);}
  };
  const openProject = () => {
    if(running || navigating)return;setNavigating(true);
    void invoke('project.open').then(async value=>{
      const chosen=asObject(value);if(chosen.cancelled || !chosen.id)return;
      await invoke('project.select',{projectId:chosen.id});setSelectedProject(String(chosen.id));setTab(null);
    }).catch(()=>{}).finally(()=>setNavigating(false));
  };
  const newSession = () => {
    if(running || navigating)return;
    if(projectId){setNavigating(true);void invoke('session.new',{projectId}).catch(()=>{}).finally(()=>setNavigating(false));}
    else openProject();
  };
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => { if (event.key.toLowerCase() === 'n' && (event.metaKey || event.ctrlKey) && !running && !document.querySelector('[role="dialog"]')) { event.preventDefault(); newSession(); } };
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  });
  const addAttachments = () => { void window.friendPi.request('file.pick').then(value => setAttachments(previous => [...new Map([...previous, ...pickedPaths(value).map(path => ({ path }))].map(item => [item.path, item])).values()])).catch(error => report(errorText(error), true)); };
  const currentPlugins = state.current?.plugins || []; const messages = state.current?.messages || [];
  useEffect(()=>{if(mode==='swarm'&&!currentPlugins.includes('swarm'))setMode('single');},[mode,currentPlugins]);
  const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant'); const showLive = liveText && lastAssistant?.text !== liveText;
  const navigateProject=(event:React.KeyboardEvent<HTMLButtonElement>,index:number)=>{
    const next=event.key==='ArrowLeft'?Math.max(0,index-1):event.key==='ArrowRight'?Math.min(state.projects.length-1,index+1):event.key==='Home'?0:event.key==='End'?state.projects.length-1:null;
    if(next===null || running || navigating)return;event.preventDefault();
    const target=state.projects[next];if(target){event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[data-project-id]')[next]?.focus();void selectProject(target.id);}
  };
  return <div className={`app friend-layout ${sidebar ? '' : 'sidebar-hidden'} ${tab ? 'workspace-open' : ''}`}>
    <header className="topbar project-topbar">
      <div className="brand topbar-brand"><span className="brand-mark">F</span><span className="brand-wordmark">Friend<span className="brand-suffix"> · Pi</span></span></div>
      <nav className="project-tabs" aria-label="项目" role="tablist">
        {state.projects.map((item,index)=><button type="button" role="tab" aria-selected={projectId===item.id} aria-controls="current-project-sessions" tabIndex={projectId===item.id?0:-1}
          data-project-id={item.id} id={`project-tab-${item.id}`} className={`project-tab ${projectId===item.id?'active':''}`} key={item.id} title={item.path}
          disabled={navigating || running && item.id!==projectId} onClick={()=>void selectProject(item.id)} onKeyDown={event=>navigateProject(event,index)}><span aria-hidden="true">▱</span><span>{item.name}</span></button>)}
        <button type="button" className="project-add" aria-label="打开新项目" title="打开新项目" onClick={openProject} disabled={running || navigating}>＋<span> 项目</span></button>
      </nav>
      <div className="module-controls" role="toolbar" aria-label="界面模块">
        <button type="button" className={sidebar?'selected':''} aria-pressed={sidebar} aria-label={sidebar?'收起会话侧栏':'展开会话侧栏'} title={sidebar?'收起会话侧栏':'展开会话侧栏'} onClick={()=>setSidebar(value=>!value)}>☰<span className="module-button-label"> 会话</span></button>
        {(['file','diff','swarm','expert','memory','topic-rebuild','providers'] as WorkspaceTab[]).map(module=><button type="button" key={module} className={tab===module?'selected':''} aria-pressed={tab===module} aria-label={labels[module]} title={labels[module]} onClick={()=>setTab(tab===module?null:module)}>
          {plugins.includes(module as PluginName)&&<span className={`capability-dot ${currentPlugins.includes(module)?'enabled':''}`} aria-hidden="true"/>}{labels[module]}
        </button>)}
      </div>
    </header>
    {sidebar&&<button type="button" className="sidebar-scrim" aria-label="关闭会话侧栏" onClick={()=>setSidebar(false)}/>}
    <aside className="sidebar" aria-label="当前项目会话" id="current-project-sessions" role="tabpanel" aria-labelledby={projectId?`project-tab-${projectId}`:undefined}>
      <div className="sidebar-project"><small>当前项目</small><strong title={project?.path}>{project?.name || '尚未打开项目'}</strong></div>
      <button className="new-chat" onClick={newSession} disabled={running || sending || navigating}>＋ 新会话 <kbd>⌘ N</kbd></button>
      <div className="sidebar-label"><span>对话</span><small>{state.sessions.filter(item=>item.projectId===projectId).length}</small></div>
      <div className="session-list current-session-list">{state.sessions.filter(item=>item.projectId===projectId).map(item=><div className={`session-row ${item.id===sessionId?'active':''}`} key={item.id}>
        <button type="button" className="session-button" aria-current={item.id===sessionId?'page':undefined} title={item.name || '新会话'} disabled={navigating || running && item.id!==sessionId} onClick={()=>{setNavigating(true);void invoke('session.open',{id:item.id}).catch(()=>{}).finally(()=>setNavigating(false));}}>{item.name || '新会话'}</button>
        <button type="button" className="rename-button" aria-label={`重命名 ${item.name || '新会话'}`} title="重命名" onClick={()=>setRename({id:item.id,name:item.name})}>···</button>
      </div>)}{!state.sessions.some(item=>item.projectId===projectId)&&<small className="no-session">这里会显示此项目的对话</small>}</div>
      <div className="sidebar-footer"><span className="status-dot"/>本地工作空间</div>
    </aside>
    <main className="main">
      <header className="conversation-heading"><div className="breadcrumb"><span>{project?.name || '工作空间'}</span><span className="breadcrumb-separator">/</span><strong>{activeSession?.name || '新会话'}</strong></div>
        <span className="session-status">{navigating?<><span className="pulse-dot"/>正在打开会话</>:running?<><span className="pulse-dot"/>{state.current?.planMode?'正在分析计划':'正在工作'}</>:<><span className="status-dot muted-dot"/>准备就绪</>}</span>
      </header>
      {notice && <div className={`notice ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}><span>{notice.message}</span><button aria-label="关闭提示" className="icon-button" onClick={() => setNotice(null)}>×</button></div>}
      <div className="conversation-stage">
        <TurnIndex messages={messages} container={scroll} sessionId={sessionId} onLocate={()=>{followScroll.current=false;}}/>
      <div className="conversation" ref={scroll} onScroll={event => { const element = event.currentTarget; followScroll.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }}>
        {booting ? <Empty title="正在打开工作空间…" /> : !messages.length && !liveText ? <div className="welcome"><div className="welcome-mark">F<span>·</span></div><h1>从一个小任务开始</h1><p>和 Friend 一起写代码，留下经验，完成长任务。</p><div className="welcome-suggestions">{['先阅读项目，告诉我整体架构', '帮我实现一个小改动，并验证结果', '找回这个项目的约束与关键决定'].map(text => <button key={text} onClick={() => { setDraft(text); composer.current?.focus(); }}>{text}<span>↗</span></button>)}</div>{!state.current && <button className="primary" onClick={state.projects.length ? newSession : openProject}>{state.projects.length ? '创建一个会话' : '打开项目开始'}</button>}</div> : <div className="messages">{messages.map((message, i) => message.role === 'toolResult' ? <details className="history-tool" key={message.id || `tool-${i}`}><summary>工具结果</summary><pre className="code-view">{message.text}</pre></details> : <article className={`chat-message ${message.role === 'user' ? 'user' : 'assistant'}`} data-message-id={messageAnchor(message,i)} key={message.id || i}><div className="message-role">{message.role === 'user' ? '你' : message.role === 'assistant' ? 'Friend' : message.role}</div><Markdown text={message.text} /></article>)}{showLive && <article className="chat-message assistant live"><div className="message-role">Friend <span className="pulse-dot" /></div><Markdown text={liveText} /></article>}{thinking && <details className="thinking-block"><summary>思考过程</summary><pre>{thinking}</pre></details>}{tools.length > 0 && <div className="tool-runs">{tools.map(tool => <details key={tool.id}><summary><span className={`tool-indicator ${tool.status}`} /><strong>{tool.name}</strong><Badge value={tool.status} /></summary><JsonView value={tool.input} />{tool.output !== undefined && <JsonView value={tool.output} />}</details>)}</div>}{running && !liveText && <div className="working-indicator"><span /><span /><span />正在处理任务</div>}</div>}
      </div></div>
      <div className="composer-wrap"><div className="composer"><textarea ref={composer} aria-label="消息" placeholder={state.current ? '描述你想完成的工作…' : '打开项目并创建会话后开始'} value={draft} disabled={!state.current} rows={3} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); } }} />{attachments.length > 0 && <div className="attachment-list">{attachments.map(item => <span key={item.path} title={item.path}>{item.path.split('/').at(-1)}<button aria-label={`移除附件 ${item.path.split('/').at(-1)}`} onClick={() => setAttachments(previous => previous.filter(file => file.path !== item.path))}>×</button></span>)}</div>}<div className="composer-toolbar"><button className="icon-button" aria-label="添加附件" title="添加文本或图片附件" disabled={!state.current || running} onClick={addAttachments}>＋</button><select aria-label="模型" className="model-select" value={state.current?.modelId || ''} disabled={!state.current || running} onChange={event => void invoke('session.configure', { sessionId, modelId: event.target.value }).catch(() => {})}><option value="" disabled>选择型号</option>{state.models.map(model => <option value={model.id} key={model.id}>{model.name} · {model.provider}</option>)}</select><select aria-label="思考等级" className="thinking-select" value={state.current?.thinkingLevel || 'off'} disabled={!state.current || running} onChange={event => void invoke('session.configure', { sessionId, thinkingLevel: event.target.value }).catch(() => {})}><option value="off">不思考</option><option value="minimal">最少</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="xhigh">最高</option></select>{running ? <button className="stop-button" aria-label="停止当前任务" onClick={() => { void invoke('session.stop', { sessionId }).then(() => { setLocalRunning(false); setSwarmRunning(false); setDialogs([]); }).catch(() => {}); }}><span />停止</button> : <button className="send-button" aria-label="发送消息" disabled={!state.current || !draft.trim() || sending} onClick={() => void send()}>↑</button>}</div></div>
        <div className="composer-controls">
          <label className={`plan-control ${planMode?'active':''}`} title="计划模式只读分析，执行模式可修改项目">
            <input type="checkbox" role="switch" aria-label="计划模式（只读分析）" checked={planMode} disabled={!state.current || running || sending} onChange={event=>setPlanMode(event.target.checked)}/>
            <span>{planMode?'计划模式':'执行模式'}</span><small>{planMode?'只读分析':'允许执行'}</small>
          </label>
          <div className="agent-mode-control" role="group" aria-label="Agent 协作方式" data-mode={mode}>
            <span className="agent-mode-thumb" aria-hidden="true"/>
            <button type="button" aria-pressed={mode==='single'} className={mode==='single'?'selected':''} disabled={!state.current || running || sending} onClick={()=>setMode('single')} title="单个 Agent 完成任务">Single</button>
            <button type="button" aria-pressed={mode==='swarm'} className={mode==='swarm'?'selected':''} disabled={!state.current || running || sending || !currentPlugins.includes('swarm')} onClick={()=>setMode('swarm')} title={currentPlugins.includes('swarm')?'由多个 Agent 协作完成任务':'启用 Swarm 插件后可选择'}>Swarm</button>
          </div>
          <span className="composer-shortcut">⌘ / Ctrl + Enter</span>
        </div>
        <p className="composer-mode-hint">{planMode?'先分析目标与方案，保持项目只读。':mode==='swarm'?'Agent 分工协作，检查并复核后整合成果。':'在当前项目内完成工作。'}</p>
      </div>
    </main>
    {tab && <aside className="workspace" aria-label={`${labels[tab]}工作台`}><header className="workspace-heading"><h2>{labels[tab]}</h2><button className="icon-button" aria-label="关闭工作台" onClick={() => setTab(null)}>×</button></header>{tab === 'providers' ? <ProviderPanel state={state} report={report} refresh={refresh} /> : !state.current ? <Empty title="先创建一个项目会话">工作台与当前项目、会话关联。</Empty> : tab === 'file' ? <FilePanel key={projectId} projectId={projectId!} report={report} /> : tab === 'diff' ? <DiffPanel key={projectId} projectId={projectId!} report={report} /> : <><div className="plugin-switch"><span>启用 {pluginLabels[tab]}</span><input type="checkbox" role="switch" aria-label={`启用 ${pluginLabels[tab]}`} checked={currentPlugins.includes(tab)} disabled={running} onChange={event => { const enabled = event.target.checked ? [...currentPlugins, tab] : currentPlugins.filter(plugin => plugin !== tab); void invoke('session.configure', { sessionId, plugins: enabled }).catch(() => {}); }} /></div>{running && <p className="boundary-hint">当前执行结束后可调整插件。</p>}{!currentPlugins.includes(tab) ? <Empty title="此插件已关闭">启用后可以管理其项目数据。</Empty> : tab === 'swarm' ? <SwarmPanel key={`${sessionId}:swarm`} sessionId={sessionId!} report={report} /> : tab === 'expert' ? <ExpertPanel key={`${sessionId}:expert`} sessionId={sessionId!} report={report} /> : tab === 'memory' ? <MemoryPanel key={`${sessionId}:memory`} sessionId={sessionId!} report={report} /> : <RebuildPanel key={`${sessionId}:rebuild`} sessionId={sessionId!} report={report} />}</>}</aside>}
    {dialogs[0] && <PiDialog key={dialogs[0].id} dialog={dialogs[0]} respond={value => { const id = dialogs[0].id; void window.friendPi.request('dialog.respond', { id, ...value }).then(() => setDialogs(previous => previous.filter(item => item.id !== id))).catch(error => { report(errorText(error), true); setDialogs(previous => previous.filter(item => item.id !== id)); }); }} />}
    {rename && <Modal title="重命名会话" onClose={() => setRename(null)}><form onSubmit={event => { event.preventDefault(); void invoke('session.rename', rename).then(() => setRename(null)).catch(() => {}); }}><Field label="会话名称"><input value={rename.name} maxLength={120} onChange={event => setRename({ ...rename, name: event.target.value })} /></Field><button className="primary full" disabled={!rename.name.trim()} type="submit">保存名称</button></form></Modal>}
  </div>;
}
