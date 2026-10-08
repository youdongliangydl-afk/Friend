import { useCallback, useEffect, useRef, useState } from 'react';
import { ExpertPanel, MemoryPanel, RebuildPanel, SwarmPanel } from './panels.js';
import { asList, asObject, contentText, errorText, pluginLabels, type AppState, type DialogRequest, type JsonObject, type PluginName, type Preferences, type WorkspaceTab } from './types.js';
import { Badge, Empty, Field, JsonView, Markdown, RichMessage, Modal } from './ui.js';
import {TurnIndex,messageAnchor} from './TurnIndex.js';
import {Icon,type IconName} from './Icons.js';
import {ResizeHandle} from './ResizeHandle.js';
import {Workbench,type WorkbenchPage,type Material} from './Workbench.js';
import {ModelPicker} from './model-picker.js';
import {PlanPreview} from './plan-preview.js';
import {ProviderPanel} from './provider-panel.js';

const EMPTY: AppState = { projects: [], sessions: [], current: null, models: [], providers: [] };
const plugins: PluginName[] = ['swarm', 'expert', 'memory', 'topic-rebuild'];
const labels: Record<WorkspaceTab, string> = { ...pluginLabels, file: '文件', diff: 'Diff', settings: '设置' };
interface ToolRun { id: string; name: string; status: string; input: unknown; output?: unknown; error?: boolean }
function pickedPaths(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  const result = asObject(value);
  const values = Array.isArray(value) ? value : Array.isArray(result.paths) ? result.paths : result.path ? [result.path] : [];
  return values.map(item => typeof item === 'string' ? item : String(asObject(item).path || '')).filter(Boolean);
}


interface SettingsData {preferences:Preferences;models:AppState['models'];providers:AppState['providers'];paths:{dataDir:string};piSource:string}
function SettingsPanel({state,report,refresh,projectId}:{projectId?:string;state:AppState;report(message:string,error?:boolean):void;refresh():Promise<AppState>}) {
  const defaults:Preferences={defaultModelId:'',defaultThinkingLevel:'off',defaultPlugins:[...plugins],defaultMode:'single',defaultPlanMode:false,contextMode:'native',backgroundModelId:''};
  const [settings,setSettings]=useState<SettingsData>({preferences:state.preferences||defaults,models:state.models,providers:state.providers,paths:{dataDir:''},piSource:''});
  const [form,setForm]=useState<Preferences>(settings.preferences);const [saving,setSaving]=useState(false);const [scope,setScope]=useState('global');const [query,setQuery]=useState('');const [learning,setLearning]=useState<JsonObject>({});const settingsRoot=useRef<HTMLDivElement>(null);
  const load=useCallback(async()=>{const next=await window.friendPi.request<SettingsData>('settings.get',{projectId:scope==='project'?projectId:undefined});setSettings(next);setForm(next.preferences);},[scope,projectId]);
  useEffect(()=>{void load().catch(error=>report(errorText(error),true));},[load,report]);
  const providerRefresh=async()=>{const next=await refresh();await load();return next;};
  useEffect(()=>{for(const field of settingsRoot.current?.querySelectorAll<HTMLElement>('.field,.switch-row,fieldset')||[])field.hidden=!!query&&!field.textContent?.toLowerCase().includes(query.toLowerCase());},[query]);
  useEffect(()=>{void window.friendPi.request('learning.state').then(raw=>setLearning(asObject(raw))).catch(()=>{});},[]);
  const defaultModel=settings.models.find(model=>model.id===form.defaultModelId)||(!form.defaultModelId?settings.models.find(model=>settings.providers.some(provider=>provider.id===model.provider&&provider.configured)):undefined);
  return <div ref={settingsRoot} className="panel-content settings-panel"><input aria-label="搜索设置" placeholder="搜索设置…" value={query} onChange={event=>setQuery(event.target.value)}/><Field label="设置作用域"><select value={scope} onChange={event=>setScope(event.target.value)}><option value="global">全局默认</option><option value="project" disabled={!projectId}>当前项目覆盖</option></select></Field><div className="panel-intro"><h2>设置</h2><p>模型与协作默认值用于新会话；插件与上下文策略在安全边界应用。</p></div>
    <ProviderPanel state={{...state,models:settings.models,providers:settings.providers,preferences:settings.preferences}} report={report} refresh={providerRefresh}/>
    <section className="card"><h3>新会话默认值</h3><form onSubmit={event=>{event.preventDefault();setSaving(true);void window.friendPi.request<SettingsData>('settings.update',{...form,projectId:scope==='project'?projectId:undefined}).then(async next=>{setSettings(next);setForm(next.preferences);await refresh();report('设置已保存；模型默认值用于新会话，能力与上下文在安全边界生效');}).catch(error=>report(errorText(error),true)).finally(()=>setSaving(false));}}>
      <Field label="默认模型"><select value={form.defaultModelId||''} onChange={event=>{const id=event.target.value;const model=settings.models.find(model=>model.id===id);setForm({...form,defaultModelId:id,defaultThinkingLevel:model?.thinkingLevels?.includes(form.defaultThinkingLevel)?form.defaultThinkingLevel:model?.thinkingLevels?.[0]||'off'});}}><option value="">自动选择已配置模型</option>{settings.models.filter(model=>settings.providers.some(provider=>provider.id===model.provider&&provider.configured)).map(model=><option value={model.id} key={model.id}>{model.name} · {model.provider}</option>)}</select></Field>
      <Field label="默认思考等级"><select value={form.defaultThinkingLevel} onChange={event=>setForm({...form,defaultThinkingLevel:event.target.value})}>{[['off','不思考'],['minimal','最少'],['low','低'],['medium','中'],['high','高'],['xhigh','最高'],['max','Max']].filter(([value])=>(defaultModel?.thinkingLevels||['off']).includes(value)).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></Field>
      <Field label="默认 Agent 方式"><select value={form.defaultMode} onChange={event=>setForm({...form,defaultMode:event.target.value as Preferences['defaultMode']})}><option value="single">Single</option><option value="team">Team</option><option value="swarm">Swarm</option></select></Field>
      <label className="switch-row settings-plan"><span>新会话默认先规划</span><input type="checkbox" role="switch" checked={form.defaultPlanMode} onChange={event=>setForm({...form,defaultPlanMode:event.target.checked})}/></label>
      <fieldset className="default-plugins"><legend>默认启用能力</legend>{plugins.map(plugin=><label className="check" key={plugin}><input type="checkbox" checked={form.defaultPlugins.includes(plugin)} onChange={event=>setForm({...form,defaultPlugins:event.target.checked?[...form.defaultPlugins,plugin]:form.defaultPlugins.filter(item=>item!==plugin)})}/>{pluginLabels[plugin]}</label>)}</fieldset>
      <label className="switch-row"><span>无限上下文</span><input type="checkbox" role="switch" checked={form.contextMode==='infinite'} onChange={event=>setForm({...form,contextMode:event.target.checked?'infinite':'native'})}/></label><p className="hint">默认使用 Pi 原生压缩。开启后结合有效历史记忆选择保留内容与摘要，仅保存到会话现场。</p>
      <Field label="后台学习模型"><select value={form.backgroundModelId||''} onChange={event=>setForm({...form,backgroundModelId:event.target.value})}><option value="">继承触发会话模型</option>{settings.models.filter(model=>settings.providers.some(provider=>provider.id===model.provider&&provider.configured)).map(model=><option value={model.id} key={model.id}>{model.name} · {model.provider}</option>)}</select></Field>
      <button className="primary full" type="submit" disabled={saving}>{saving?'保存中…':'保存默认设置'}</button>
    </form></section>
    {scope==='project'&&<button onClick={()=>void window.friendPi.request<SettingsData>('settings.update',{projectId:projectId,reset:true}).then(next=>{setSettings(next);setForm(next.preferences);return refresh();}).catch(error=>report(String(error),true))}>恢复全局默认</button>}
    {state.current&&<p className="settings-snapshot">当前快照：{state.current.modelId} · {state.current.thinkingLevel} · {state.current.plugins.join(' / ')}{Boolean(state.current.pendingConfiguration)&&' · 配置等待空闲生效'}</p>}
    <section className="card"><h3>自动学习</h3><p>项目经验和个人偏好由常驻后台串行整理，前台可以同时工作。</p><p className="hint">{learning.alive?'后台服务在线':'等待后台服务'} · {learning.paused?'已暂停':'自动学习'}</p><button onClick={()=>void window.friendPi.request(learning.paused?'learning.resume':'learning.pause').then(()=>window.friendPi.request('learning.state')).then(raw=>setLearning(asObject(raw))).catch(error=>report(String(error),true))}>{learning.paused?'恢复学习':'暂停学习'}</button></section>
    <section className="card environment-card"><h3>本地环境</h3><Field label="数据目录"><code>{settings.paths.dataDir||'读取中…'}</code></Field><Field label="Pi 源码版本"><code>{settings.piSource||'读取中…'}</code></Field></section>
  </div>;
}

function PiDialog({ dialog, respond }: { dialog: DialogRequest; respond(value: JsonObject): void }) {
  const [value, setValue] = useState(dialog.prefill || dialog.options?.[0] || '');
  return <Modal title={dialog.title} onClose={() => respond({ cancelled: true })}><form onSubmit={event => { event.preventDefault(); respond(dialog.kind === 'confirm' ? { confirmed: true } : { value }); }}>{dialog.message && <p className="dialog-message">{dialog.message}</p>}{dialog.kind === 'select' ? <Field label="选择"><select value={value} onChange={event => setValue(event.target.value)}>{dialog.options?.map(option => <option value={option} key={option}>{option}</option>)}</select></Field> : dialog.kind === 'input' ? <Field label="输入"><input value={value} onChange={event => setValue(event.target.value)} /></Field> : dialog.kind === 'editor' ? <Field label="编辑内容"><textarea rows={9} value={value} onChange={event => setValue(event.target.value)} /></Field> : null}<div className="button-row right"><button type="button" onClick={() => respond({ cancelled: true })}>取消</button><button className="primary" type="submit">{dialog.kind === 'confirm' ? '允许此操作' : '确认'}</button></div></form></Modal>;
}

export default function App() {
  const [state, setState] = useState<AppState>(EMPTY); const stateRef = useRef(state); stateRef.current = state;
  const [booting, setBooting] = useState(true); const [notice, setNotice] = useState<{ message: string; error: boolean } | null>(null);
  const [selectedProject, setSelectedProject] = useState(''); const [tab, setTab] = useState<WorkspaceTab | null>(null); const [sidebar, setSidebar] = useState(() => !window.matchMedia('(max-width: 760px)').matches);
  const [settingsOpen,setSettingsOpen]=useState(false);const [material,setMaterial]=useState<Material>();const [menu,setMenu]=useState<{id:string;name:string;archived?:boolean;x:number;y:number}|null>(null);const [deleting,setDeleting]=useState<JsonObject|null>(null);
  const [sessionSearch,setSessionSearch]=useState('');const searchInput=useRef<HTMLInputElement>(null);const [historyOpen,setHistoryOpen]=useState(false);
  const [layout,setLayout]=useState(()=>{try{const value=JSON.parse(localStorage.getItem('friend-pi.layout.v1')||'{}');return {sidebarWidth:Math.min(400,Math.max(180,Number(value.sidebarWidth)||244)),workspaceWidth:Math.min(600,Math.max(300,Number(value.workspaceWidth)||400))};}catch{return {sidebarWidth:244,workspaceWidth:400};}});
  const [viewportWidth,setViewportWidth]=useState(window.innerWidth);
  const [navigating,setNavigating]=useState(false); const [planMode,setPlanMode]=useState(false);
  const [draft, setDraft] = useState(''); const draftRef = useRef(draft); draftRef.current = draft;
  const [draftOwner,setDraftOwner]=useState<string|undefined>();
  const [mode, setMode] = useState<'single' | 'team' | 'swarm'>('single'); const [attachments, setAttachments] = useState<{ path: string }[]>([]);
  const [sending, setSending] = useState(false); const [localRunning, setLocalRunning] = useState(false); const [swarmRunning, setSwarmRunning] = useState(false);
  const [liveText, setLiveText] = useState(''); const [thinking, setThinking] = useState(''); const [tools, setTools] = useState<ToolRun[]>([]);
  const [dialogs, setDialogs] = useState<DialogRequest[]>([]); const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
  const scroll = useRef<HTMLDivElement>(null); const composer = useRef<HTMLTextAreaElement>(null); const followScroll = useRef(true);
  const lastSubmitted = useRef<{ sessionId: string; text: string; attachments: { path: string }[]; failed: boolean;accepted:boolean } | null>(null);
  const sessionId = state.current?.sessionId; const projectId = state.current?.projectId || selectedProject || state.projects[0]?.id;
  const project = state.projects.find(item => item.id === projectId); const activeSession = state.sessions.find(item => item.id === sessionId);
  const running = Boolean(state.current?.isRunning || localRunning || swarmRunning);
  const navigationBusy=Boolean(state.current?.navigationLocked||localRunning||swarmRunning);
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
        if (data.level === 'error' && submitted && !submitted.accepted && submitted.sessionId === stateRef.current.current?.sessionId) { submitted.failed = true; if (!draftRef.current) { setDraft(submitted.text); setAttachments(submitted.attachments); } }
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
    setLiveText(''); setThinking(''); setTools([]); setDialogs([]); setLocalRunning(false); setSwarmRunning(false); lastSubmitted.current = null; followScroll.current=true;
    setPlanMode(typeof saved.planMode==='boolean'?saved.planMode:state.current?.planMode??state.preferences?.defaultPlanMode??false);
    setMode(saved.mode==='single'||saved.mode==='team'||saved.mode==='swarm'?saved.mode:state.current?.executionMode||state.preferences?.defaultMode||'single');
    if (state.current?.projectId) setSelectedProject(state.current.projectId);
  }, [sessionId]);
  useEffect(()=>{
    if(!sessionId||draftOwner!==sessionId)return;
    // Pending composer intent belongs to the draft, even before text is entered.
    try{localStorage.setItem(`friend-pi.draft.v1:${sessionId}`,JSON.stringify({text:draft,attachments,planMode,mode}));}catch{/* The current in-memory draft is retained if local storage is full. */}
  },[sessionId,draftOwner,draft,attachments,planMode,mode]);
  useEffect(() => { if (followScroll.current) scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'instant' }); }, [state.current?.messages, state.current?.plan, liveText, tools, thinking]);
  useEffect(() => { const handle = (event: KeyboardEvent) => { if (event.key === 'Escape' && dialogs.length === 0) { setTab(null); composer.current?.focus(); } }; window.addEventListener('keydown', handle); return () => window.removeEventListener('keydown', handle); }, [dialogs.length]);
  const send = async () => {
    if (!sessionId || !draft.trim() || sending || running) return;
    const submitted = { sessionId, text: draft, attachments, failed: false,accepted:false }; setSending(true); setLocalRunning(true); lastSubmitted.current = submitted; setTools([]); setNotice(null);
    try { await window.friendPi.request('session.send', { sessionId, text: draft, mode, attachments, planMode }); submitted.accepted=true;if (!submitted.failed) { setDraft(''); setAttachments([]); } followScroll.current = true; }
    catch (error) { setLocalRunning(false); report(errorText(error), true); }
    finally { setSending(false); }
  };
  const selectProject = async (id:string) => {
    if(navigationBusy || sending || navigating || id===projectId && state.current) return;
    setNavigating(true);
    try { await invoke('project.select',{projectId:id});setSelectedProject(id);setTab(null); }
    catch { /* Keep the current project visible. */ }
    finally {setNavigating(false);}
  };
  const openProject = () => {
    if(navigationBusy || navigating)return;setNavigating(true);
    void invoke('project.open').then(async value=>{
      const chosen=asObject(value);if(chosen.cancelled || !chosen.id)return;
      await invoke('project.select',{projectId:chosen.id});setSelectedProject(String(chosen.id));setTab(null);
    }).catch(()=>{}).finally(()=>setNavigating(false));
  };
  const newSession = () => {
    if(navigationBusy || navigating)return;
    if(projectId){setNavigating(true);void invoke('session.new',{projectId}).catch(()=>{}).finally(()=>setNavigating(false));}
    else openProject();
  };
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => { if (event.key.toLowerCase() === 'n' && (event.metaKey || event.ctrlKey) && !navigationBusy && !document.querySelector('[role="dialog"]')) { event.preventDefault(); newSession(); } };
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  });
  useEffect(()=>{try{localStorage.setItem('friend-pi.layout.v1',JSON.stringify(layout));}catch{}},[layout]);
  useEffect(()=>{const resized=()=>setViewportWidth(window.innerWidth);window.addEventListener('resize',resized);return()=>window.removeEventListener('resize',resized);},[]);
  useEffect(()=>setSessionSearch(''),[projectId]);
  useEffect(()=>{const shortcut=(event:KeyboardEvent)=>{if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'&&!document.querySelector('[role=dialog]')){event.preventDefault();setSidebar(true);requestAnimationFrame(()=>searchInput.current?.focus());}};window.addEventListener('keydown',shortcut);return()=>window.removeEventListener('keydown',shortcut);},[]);
  const addAttachments = () => { void window.friendPi.request('file.pick').then(value => setAttachments(previous => [...new Map([...previous, ...pickedPaths(value).map(path => ({ path }))].map(item => [item.path, item])).values()])).catch(error => report(errorText(error), true)); };
  useEffect(()=>{const open=(event:Event)=>{setMaterial((event as CustomEvent<Material>).detail);setTab('file');};const add=(event:Event)=>setDraft(old=>old+'\n'+(event as CustomEvent<{text:string}>).detail.text);window.addEventListener('friend-pi:file-open',open);window.addEventListener('friend-pi:add-material',add);return()=>{window.removeEventListener('friend-pi:file-open',open);window.removeEventListener('friend-pi:add-material',add);};},[]);
  const currentPlugins = state.current?.plugins || []; const messages = state.current?.messages || [];

  const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant'); const showLive = liveText && lastAssistant?.text !== liveText;
  const navigateProject=(event:React.KeyboardEvent<HTMLButtonElement>,index:number)=>{
    const next=event.key==='ArrowLeft'?Math.max(0,index-1):event.key==='ArrowRight'?Math.min(state.projects.length-1,index+1):event.key==='Home'?0:event.key==='End'?state.projects.length-1:null;
    if(next===null || navigationBusy || navigating)return;event.preventDefault();
    const target=state.projects[next];if(target){event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[data-project-id]')[next]?.focus();void selectProject(target.id);}
  };
  const currentSessions=state.sessions.filter(item=>item.projectId===projectId&&Boolean(item.archived)===historyOpen).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  const matchingSessions=currentSessions.filter(item=>item.name.toLowerCase().includes(sessionSearch.toLowerCase()));
  const openSession=(id:string)=>{if(navigationBusy||navigating)return;setNavigating(true);void invoke('session.open',{id}).catch(()=>{}).finally(()=>setNavigating(false));};
  const sidebarWidth=Math.min(layout.sidebarWidth,Math.max(180,viewportWidth-360));
  const workspaceWidth=Math.min(layout.workspaceWidth,Math.max(300,viewportWidth-(sidebar?sidebarWidth:0)-384));
  const moduleIcons:Record<Exclude<WorkspaceTab,'settings'>,IconName>={file:'file',diff:'diff',swarm:'swarm',expert:'expert',memory:'memory','topic-rebuild':'context'};
  const modelLabel=(id?:string)=>state.models.find(model=>model.id===id)?.name||id?.split('/').at(-1)||'尚未选择模型';
  const lifecycleLabel:Record<string,string>={idle:'准备就绪',running:'执行中',completed:'本轮已结束',stopped:'已停止',failed:'失败',interrupted:'已中断',paused:'暂停',awaiting_review:'等待复核',rebuilding:'整理上下文'};
  return <div className={`app friend-layout ${sidebar ? '' : 'sidebar-hidden'} ${tab ? 'workspace-open' : ''}`} style={{'--sidebar-width':`${sidebarWidth}px`,'--workspace-width':`${workspaceWidth}px`} as React.CSSProperties}>
    <header className="topbar project-topbar">
      <nav className="project-tabs" aria-label="项目" role="tablist">
        {state.projects.map((item,index)=><button type="button" role="tab" aria-selected={projectId===item.id} aria-controls="current-project-sessions" tabIndex={projectId===item.id?0:-1}
          data-project-id={item.id} id={`project-tab-${item.id}`} className={`project-tab ${projectId===item.id?'active':''}`} key={item.id} title={item.path}
          disabled={navigating || navigationBusy && item.id!==projectId} onClick={()=>void selectProject(item.id)} onKeyDown={event=>navigateProject(event,index)}><Icon name="folder" size={16}/><span>{item.name}</span></button>)}
        <button type="button" className="project-add" aria-label="打开新项目" title="打开新项目" onClick={openProject} disabled={navigationBusy || navigating}><Icon name="plus" size={17}/><span>打开项目</span></button>
      </nav>
      <div className="module-controls" role="toolbar" aria-label="界面模块">
        <button type="button" className={sidebar?'selected':''} aria-pressed={sidebar} aria-label={sidebar?'收起会话侧栏':'展开会话侧栏'} title={sidebar?'收起会话侧栏':'展开会话侧栏'} onClick={()=>setSidebar(value=>!value)}><Icon name="sidebar"/></button>
        <button type="button" className={tab?'selected':''} aria-pressed={Boolean(tab)} aria-label={tab?'收起右侧工作台':'展开右侧工作台'} title="右侧工作台" onClick={()=>setTab(tab?null:'file')}><Icon name="workbench"/></button>
      </div>
    </header>
    {sidebar&&<button type="button" className="sidebar-scrim" aria-label="关闭会话侧栏" onClick={()=>setSidebar(false)}/>}
    <aside className="sidebar" aria-label="当前项目会话" id="current-project-sessions" role="tabpanel" aria-labelledby={projectId?`project-tab-${projectId}`:undefined}>
      <div className="brand sidebar-brand"><Icon name="friend" size={32}/><span>Friend</span><small>Pi</small></div>
      <div className="sidebar-new"><button className="new-chat" onClick={newSession} disabled={navigationBusy||sending||navigating}><Icon name="plus"/>新建会话<kbd>⌘N</kbd></button><button type="button" className="history-button" aria-label={historyOpen?"查看近期会话":"查看归档会话"} title={historyOpen?"查看近期会话":"查看归档会话"} aria-pressed={historyOpen} onClick={()=>setHistoryOpen(value=>!value)}><Icon name="history"/></button></div>
      <label className="session-search"><Icon name="search" size={16}/><input ref={searchInput} aria-label="搜索会话" placeholder="搜索会话…" value={sessionSearch} onChange={event=>setSessionSearch(event.target.value)}/><kbd>⌘K</kbd></label>
      <div className="sidebar-label"><span>{historyOpen?"已归档":"近期"}</span><small className="session-count">{currentSessions.length} 个</small></div>
      <div className="session-list current-session-list">{matchingSessions.map(item=><div className={`session-row ${item.id===sessionId?'active':''}`} key={item.id} onContextMenu={event=>{event.preventDefault();setMenu({...item,x:Math.min(event.clientX,window.innerWidth-170),y:Math.min(event.clientY,window.innerHeight-180)});}}>
        <button type="button" className="session-button" aria-current={item.id===sessionId?'page':undefined} title={`${item.name||'新会话'} · ${lifecycleLabel[item.status||'idle']||item.status}`} disabled={navigating||navigationBusy&&item.id!==sessionId} onClick={()=>openSession(item.id)}>
          <span className={`session-lifecycle status-${item.status||'idle'}`} aria-label={lifecycleLabel[item.status||'idle']||item.status}>{item.status==='completed'?'✓':item.status==='failed'?'!':item.status==='running'?'◌':item.status==='stopped'||item.status==='paused'?'Ⅱ':item.status==='interrupted'?'↯':item.status==='awaiting_review'?'◷':'○'}</span>
          <span className="session-card-text"><strong>{item.name||'新会话'}</strong><small>会话 · {modelLabel(item.modelId)}</small></span>
        </button>
        <button type="button" className="rename-button" aria-label={`${item.archived?'删除':'归档'} ${item.name||'新会话'}`} title={item.archived?'删除':'归档'} disabled={running&&item.id===sessionId} onClick={()=>{if(item.archived)void window.friendPi.request('session.delete.preview',{id:item.id}).then(raw=>setDeleting(asObject(raw))).catch(error=>report(String(error),true));else void invoke('session.archive',{id:item.id,archived:true}).catch(()=>{});}}>{item.archived?'×':'↧'}</button>
      </div>)}{!matchingSessions.length&&<div className="session-empty"><Icon name="context" size={23}/><p>{sessionSearch?'没有找到匹配会话':'创建第一个会话开始工作'}</p></div>}</div>
      <button type="button" className={`sidebar-settings ${settingsOpen?'selected':''}`} aria-label="设置" onClick={()=>setSettingsOpen(true)}><Icon name="settings"/>设置</button>
    </aside>
    {sidebar&&<ResizeHandle className="sidebar-resize" name="调整会话侧栏宽度" value={sidebarWidth} min={180} max={Math.min(400,Math.max(180,viewportWidth-360-(tab&&viewportWidth>1200?workspaceWidth+24:0)))} onChange={value=>setLayout(previous=>({...previous,sidebarWidth:value}))}/>}
    <main className="main">
      <header className="conversation-heading"><div className="conversation-title"><h2>{activeSession?.name||project?.name||'新会话'}</h2><p title={project?.path}><Icon name="folder" size={15}/><span>{project?.path||'打开一个项目开始工作'}</span></p></div>
        <div className="heading-actions"><span className="session-status">{navigating?'正在打开会话':running?'正在工作':'准备就绪'}</span></div>
      </header>
      {notice && <div className={`notice ${notice.error ? 'error' : ''}`} role={notice.error ? 'alert' : 'status'}><span>{notice.message}</span><button aria-label="关闭提示" className="icon-button" onClick={() => setNotice(null)}>×</button></div>}

      {activeSession?.archived&&<div className="notice">当前为归档会话，只读查看。<button onClick={()=>void invoke('session.archive',{id:sessionId,archived:false}).catch(()=>{})}>恢复并继续</button></div>}
      <div className="conversation-stage">
        <TurnIndex messages={messages} container={scroll} sessionId={sessionId} onLocate={()=>{followScroll.current=false;}}/>
      <div className="conversation" ref={scroll} onScroll={event => { const element = event.currentTarget; followScroll.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }}>
        {booting ? <Empty title="正在打开工作空间…" /> : !messages.length && !liveText ? <div className="welcome"><div className="welcome-mark">F<span>·</span></div><h1>从一个小任务开始</h1><p>和 Friend 一起写代码，留下经验，完成长任务。</p><div className="welcome-suggestions">{['先阅读项目，告诉我整体架构', '帮我实现一个小改动，并验证结果', '找回这个项目的约束与关键决定'].map(text => <button key={text} onClick={() => { setDraft(text); composer.current?.focus(); }}>{text}<span>↗</span></button>)}</div>{!state.current && <button className="primary" onClick={state.projects.length ? newSession : openProject}>{state.projects.length ? '创建一个会话' : '打开项目开始'}</button>}</div> : <div className="messages">{messages.map((message, i) => message.role === 'toolResult' ? <details className="history-tool" key={message.id || `tool-${i}`}><summary>{message.toolName||'工具结果'} · {message.isError?'失败':'已返回'} · {message.toolCallId}</summary><RichMessage message={message}/></details> : <article className={`chat-message ${message.role === 'user' ? 'user' : 'assistant'}`} data-message-id={messageAnchor(message,i)} key={message.id || i}><div className="message-role">{message.role === 'user' ? '你' : message.role === 'assistant' ? 'Friend' : message.role==='automatic'?'自动接续':message.role}</div><RichMessage message={message} /></article>)}{showLive && <article className="chat-message assistant live"><div className="message-role">Friend <span className="pulse-dot" /></div><Markdown text={liveText} /></article>}{thinking && <details className="thinking-block"><summary>思考过程</summary><pre>{thinking}</pre></details>}{tools.length > 0 && <div className="tool-runs">{tools.map(tool => <details key={tool.id}><summary><span className={`tool-indicator ${tool.status}`} /><strong>{tool.name}</strong><Badge value={tool.status} /></summary><JsonView value={tool.input} />{tool.output !== undefined && <JsonView value={tool.output} />}</details>)}</div>}{running && !liveText && <div className="working-indicator"><span /><span /><span />正在处理任务</div>}</div>}
        {state.current?.plan&&asObject(state.current.plan).status==='proposed'&&<div className="messages plan-tail"><PlanPreview body={String(asObject(state.current.plan).body||'')} disabled={running||sending||!!activeSession?.archived}
          onRead={()=>{setMaterial({title:'计划全文',text:String(asObject(state.current!.plan).body)});setTab('file');}}
          onApprove={()=>void invoke('plan.approve',{...asObject(state.current!.plan),sessionId}).catch(()=>{})}
          onRevise={()=>{setDraft('请修改上述计划：');composer.current?.focus();}}
          onReject={()=>void invoke('plan.reject',{...asObject(state.current!.plan),sessionId}).catch(()=>{})}/></div>}
      </div></div>
      <div className="composer-wrap"><div className="composer"><textarea ref={composer} aria-label="消息" placeholder={state.current?'描述你想完成的工作…':'打开项目并创建会话后开始'} value={draft} disabled={!state.current||activeSession?.archived} rows={3} onChange={event=>setDraft(event.target.value)} onKeyDown={event=>{if(event.nativeEvent.isComposing)return;if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();void send();}}}/>
        {attachments.length>0&&<div className="attachment-list">{attachments.map(item=><span key={item.path} title={item.path}>{item.path.split('/').at(-1)}<button aria-label={`移除附件 ${item.path.split('/').at(-1)}`} onClick={()=>setAttachments(previous=>previous.filter(file=>file.path!==item.path))}>×</button></span>)}</div>}
        <div className="composer-toolbar">
          <button type="button" className="attachment-button" aria-label="添加附件" title="添加文本或图片附件" disabled={!state.current||running||activeSession?.archived} onClick={addAttachments}><Icon name="plus"/></button>
          <span className="permission-hint" title="当前采用 Pi 高信任执行；检测到关键删除或 Git 操作时会请求确认。"><Icon name="shield" size={16}/><span>关键操作确认</span></span>
          <label className={`plan-control ${planMode?'active':''}`} title="先规划：只读分析，切换到执行后才修改项目"><Icon name="plan" size={16}/><span>先规划</span><input type="checkbox" role="switch" aria-label="计划模式（只读分析）" checked={planMode} disabled={!state.current||running||sending} onChange={event=>setPlanMode(event.target.checked)}/></label>
          <div className="agent-mode-control" role="group" aria-label="Agent 协作方式" data-mode={mode}><span className="agent-mode-thumb" aria-hidden="true"/>
            <button type="button" aria-label="Single" aria-pressed={mode==='single'} className={mode==='single'?'selected':''} disabled={!state.current||running||sending} onClick={()=>void invoke('session.configure',{sessionId,executionMode:'single'}).then(()=>setMode('single')).catch(()=>{})} title="Single：单个 Agent 完成任务"><Icon name="single" size={17}/><span>Single</span></button>
            <button type="button" aria-label="Team" aria-pressed={mode==='team'} className={mode==='team'?'selected':''} disabled={!state.current||running||sending||!currentPlugins.includes('swarm')} onClick={()=>void invoke('session.configure',{sessionId,executionMode:'team'}).then(()=>setMode('team')).catch(()=>{})} title="Team：主 Agent 委派，成员成果返回后由主 Agent 整合"><Icon name="swarm" size={17}/><span>Team</span></button>
            <button type="button" aria-label="Swarm" aria-pressed={mode==='swarm'} className={mode==='swarm'?'selected':''} disabled={!state.current||running||sending||!currentPlugins.includes('swarm')} onClick={()=>void invoke('session.configure',{sessionId,executionMode:'swarm'}).then(()=>setMode('swarm')).catch(()=>{})} title="Swarm：多个 Agent 分工协作"><Icon name="swarm" size={17}/><span>Swarm</span></button>
          </div>
          <ModelPicker key={sessionId} models={state.models.filter(model=>state.providers.some(provider=>provider.id===model.provider&&provider.configured))} modelId={state.current?.modelId} thinkingLevel={state.current?.thinkingLevel} thinkingLevels={state.current?.thinkingLevels||['off']}
            disabled={!state.current||running||sending||!!activeSession?.archived} onChange={input=>invoke('session.configure',{sessionId,...input})} onConfigure={()=>setSettingsOpen(true)}/>
          {running?<button type="button" className="stop-button" aria-label="停止当前任务" onClick={()=>{void invoke('session.stop',{sessionId}).then(()=>{setLocalRunning(false);setSwarmRunning(false);setDialogs([]);}).catch(()=>{});}}><span/>停止</button>:<button type="button" className="send-button" aria-label="发送消息" title="⌘ / Ctrl + Enter 发送" disabled={!state.current||activeSession?.archived||!draft.trim()||sending} onClick={()=>void send()}><Icon name="send" size={19}/></button>}
        </div>
      </div></div>
    </main>
    {tab&&<ResizeHandle className="workspace-resize" name="调整工作台宽度" value={workspaceWidth} min={300} max={600} reverse onChange={value=>setLayout(previous=>({...previous,workspaceWidth:value}))}/>}
    {tab&&<aside className="workspace" aria-label="工作台"><Workbench state={state} projectId={projectId} page={tab as WorkbenchPage} onPage={setTab} onClose={()=>setTab(null)} onSettings={()=>setSettingsOpen(true)} material={material} report={report}/></aside>}
    {settingsOpen&&<Modal title="设置" wide onClose={()=>setSettingsOpen(false)}><SettingsPanel state={state} projectId={projectId} report={report} refresh={refresh}/>{sessionId&&<><details><summary>Swarm 任务与协作管理</summary>{currentPlugins.includes('swarm')&&<SwarmPanel sessionId={sessionId} report={report}/>}</details><details><summary>专家库与版本管理</summary>{currentPlugins.includes('expert')&&<ExpertPanel sessionId={sessionId} report={report}/>}</details><details><summary>记忆库与学习详情</summary>{currentPlugins.includes('memory')&&<MemoryPanel sessionId={sessionId} report={report}/>}</details><details><summary>上下文高级诊断</summary>{currentPlugins.includes('topic-rebuild')&&<RebuildPanel sessionId={sessionId} report={report}/>}</details></>}</Modal>}
    {menu&&<div className="session-menu" role="menu" style={{left:menu.x,top:menu.y}} onKeyDown={event=>{if(event.key==='Escape')setMenu(null);}}><button role="menuitem" onClick={()=>{setRename({id:menu.id,name:menu.name});setMenu(null);}}>重命名</button><button role="menuitem" onClick={()=>{void invoke('session.relocate',{id:menu.id}).catch(()=>{});setMenu(null);}}>重新定位原始历史</button><button role="menuitem" onClick={()=>{void invoke('session.archive',{id:menu.id,archived:!menu.archived}).catch(()=>{});setMenu(null);}}>{menu.archived?'恢复':'归档'}</button><button role="menuitem" onClick={()=>{void window.friendPi.request('session.delete.preview',{id:menu.id}).then(raw=>setDeleting(asObject(raw))).catch(error=>report(String(error),true));setMenu(null);}}>删除</button><button role="menuitem" onClick={()=>setMenu(null)}>关闭菜单</button></div>}
    {deleting&&<Modal title="删除会话" onClose={()=>setDeleting(null)}><p>永久删除“{String(deleting.name)}”及其由 Friend-Pi 保管的原始会话历史。外部重定位原史保留。项目代码、原附件和 Git 成果保留。仅依赖此原史的记忆停止自动采用。</p><div className="button-row"><button onClick={()=>setDeleting(null)}>取消</button><button className="primary" onClick={()=>{void invoke('session.delete',{id:deleting.id,token:deleting.token}).then(()=>{for(const key of Object.keys(localStorage))if(key.includes(String(deleting.id)))localStorage.removeItem(key);setDeleting(null);}).catch(()=>{});}}>确认删除</button></div></Modal>}
    {dialogs[0] && <PiDialog key={dialogs[0].id} dialog={dialogs[0]} respond={value => { const id = dialogs[0].id; void window.friendPi.request('dialog.respond', { id, ...value }).then(() => setDialogs(previous => previous.filter(item => item.id !== id))).catch(error => { report(errorText(error), true); setDialogs(previous => previous.filter(item => item.id !== id)); }); }} />}
    {rename && <Modal title="重命名会话" onClose={() => setRename(null)}><form onSubmit={event => { event.preventDefault(); void invoke('session.rename', rename).then(() => setRename(null)).catch(() => {}); }}><Field label="会话名称"><input value={rename.name} maxLength={120} onChange={event => setRename({ ...rename, name: event.target.value })} /></Field><button className="primary full" disabled={!rename.name.trim()} type="submit">保存名称</button></form></Modal>}
  </div>;
}
