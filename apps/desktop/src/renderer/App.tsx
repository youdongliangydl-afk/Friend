import {ComposerPermissions,permissionOptions} from './composer-permissions.js';
import type {PermissionMode} from './types.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ExpertPanel, MemoryPanel, RebuildPanel, SwarmPanel } from './panels.js';
import { asList, asObject, contentText, errorText, pluginLabels, type AppState, type DialogRequest, type JsonObject, type PluginName, type Preferences, type WorkspaceTab } from './types.js';
import { Badge, Empty, Field, JsonView, Markdown, RichMessage, Modal } from './ui.js';
import {TurnIndex,messageAnchor} from './TurnIndex.js';
import {Icon,type IconName} from './Icons.js';
import {ResizeHandle} from './ResizeHandle.js';
import {Workbench,type WorkbenchPage,type Material} from './Workbench.js';
import {Conversation} from './Conversation.js';
import {piLiveMessage,type ToolRun as TimelineToolRun} from './timeline.js';
import {composerKeyAction,insertNewline} from './composer-keys.js';
import {ProjectStrip} from './ProjectStrip.js';
import type {FileWorkspaceCache} from './FileWorkspace.js';
import {ProviderPanel} from './ProviderPanel.js';
import {ModelPicker} from './model-picker.js';
import {PlanPreview} from './plan-preview.js';
import {TerminalPanel,readTerminalLayout,type TerminalLayout} from './TerminalPanel.js';

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
type SettingsPage='general'|'models'|'memory'|'extensions';
function SettingsPanel({state,report,refresh,projectId,page,setPage,onClose,onBusy}:{onBusy(busy:boolean):void;page:SettingsPage;setPage(page:SettingsPage):void;onClose():void;projectId?:string;state:AppState;report(message:string,error?:boolean):void;refresh():Promise<AppState>}) {
  const defaults:Preferences={defaultModelId:'',defaultThinkingLevel:'off',defaultPlugins:[...plugins],defaultMode:'single',defaultPlanMode:false,defaultPermissionMode:'auto',contextMode:'native',backgroundModelId:''};
  const [settings,setSettings]=useState<SettingsData>({preferences:state.preferences||defaults,models:state.models,providers:state.providers,paths:{dataDir:''},piSource:''});
  const [form,setForm]=useState<Preferences>(settings.preferences);const [providerBusy,setProviderBusy]=useState(false);const [saving,setSaving]=useState(false);const [scope,setScope]=useState('global');const [query,setQuery]=useState('');const [learning,setLearning]=useState<JsonObject>({});const settingsRoot=useRef<HTMLDivElement>(null);
  const load=useCallback(async()=>{const next=await window.friendPi.request<SettingsData>('settings.get',{projectId:scope==='project'?projectId:undefined});setSettings(next);setForm(next.preferences);},[scope,projectId]);
  useEffect(()=>{void load().catch(error=>report(errorText(error),true));},[load,report]);
  const providerRefresh=async()=>{const next=await refresh();setSettings(await window.friendPi.request<SettingsData>('settings.get',{projectId:scope==='project'?projectId:undefined}));return next;};
  useEffect(()=>onBusy(providerBusy||saving),[providerBusy,saving,onBusy]);
  useEffect(()=>{for(const field of settingsRoot.current?.querySelector('[data-settings-general]')?.querySelectorAll<HTMLElement>('.field,.switch-row,fieldset')||[])field.hidden=!!query&&!field.textContent?.toLowerCase().includes(query.toLowerCase());},[query]);
  useEffect(()=>{void window.friendPi.request('learning.state').then(raw=>setLearning(asObject(raw))).catch(()=>{});},[]);
  const defaultModel=settings.models.find(model=>model.id===form.defaultModelId)||(!form.defaultModelId?settings.models.find(model=>model.ready):undefined);
  const pageScroll=useRef<Partial<Record<SettingsPage,number>>>({});const pageBody=useRef<HTMLDivElement>(null);const previousPage=useRef(page);
  useEffect(()=>{previousPage.current=page;if(pageBody.current)pageBody.current.scrollTop=pageScroll.current[page]||0;},[page]);
  return <div className="settings-shell"><nav className="settings-nav" aria-label="设置分类">{([['general','常规'],['models','模型'],['memory','记忆'],['extensions','扩展']] as const).map(([id,label])=><button key={id} aria-current={page===id?'page':undefined} onClick={()=>setPage(id)}>{label}</button>)}</nav><div ref={pageBody} className="settings-body" onScroll={e=>{pageScroll.current[previousPage.current]=e.currentTarget.scrollTop;}}><div ref={settingsRoot} className="panel-content settings-panel"><div data-settings-general hidden={page!=='general'}><input aria-label="搜索设置" placeholder="搜索设置…" value={query} onChange={event=>setQuery(event.target.value)}/><Field label="设置作用域"><select value={scope} onChange={event=>setScope(event.target.value)}><option value="global">全局默认</option><option value="project" disabled={!projectId}>当前项目覆盖</option></select></Field><div className="panel-intro"><h2>设置</h2><p>模型与协作默认值用于新会话；插件与上下文策略在安全边界应用。</p></div>
    <section className="card"><h3>新会话默认值</h3><form onSubmit={event=>{event.preventDefault();setSaving(true);void window.friendPi.request<SettingsData>('settings.update',{...form,projectId:scope==='project'?projectId:undefined}).then(async next=>{setSettings(next);setForm(next.preferences);await refresh();report('设置已保存；模型默认值用于新会话，能力与上下文在安全边界生效');}).catch(error=>report(errorText(error),true)).finally(()=>setSaving(false));}}>
      <Field label="默认模型"><select value={form.defaultModelId||''} onChange={event=>{const id=event.target.value;const model=settings.models.find(model=>model.id===id);setForm({...form,defaultModelId:id,defaultThinkingLevel:model?.thinkingLevels?.includes(form.defaultThinkingLevel)?form.defaultThinkingLevel:model?.thinkingLevels?.[0]||'off'});}}><option value="">自动选择已验证模型</option>{settings.models.map(model=><option disabled={!model.ready} value={model.id} key={model.id}>{model.name} · {model.provider}</option>)}</select></Field>
      <Field label="默认思考等级"><select value={form.defaultThinkingLevel} onChange={event=>setForm({...form,defaultThinkingLevel:event.target.value})}>{[['off','不思考'],['minimal','最少'],['low','低'],['medium','中'],['high','高'],['xhigh','最高']].filter(([value])=>(defaultModel?.thinkingLevels||['off']).includes(value)).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></Field>
      <Field label="默认权限策略"><select value={form.defaultPermissionMode||"auto"} onChange={event=>setForm({...form,defaultPermissionMode:event.target.value as PermissionMode})}>{permissionOptions.map(option=><option key={option.id} value={option.id}>{option.name}</option>)}</select></Field>
      <Field label="默认 Agent 方式"><select value={form.defaultMode} onChange={event=>setForm({...form,defaultMode:event.target.value as Preferences['defaultMode']})}><option value="single">Single</option><option value="team">Team</option><option value="swarm">Swarm</option></select></Field>
      <label className="switch-row settings-plan"><span>新会话默认先规划</span><input type="checkbox" role="switch" checked={form.defaultPlanMode} onChange={event=>setForm({...form,defaultPlanMode:event.target.checked})}/></label>
      <fieldset className="default-plugins"><legend>默认启用能力</legend>{plugins.map(plugin=><label className="check" key={plugin}><input type="checkbox" checked={form.defaultPlugins.includes(plugin)} onChange={event=>setForm({...form,defaultPlugins:event.target.checked?[...form.defaultPlugins,plugin]:form.defaultPlugins.filter(item=>item!==plugin)})}/>{pluginLabels[plugin]}</label>)}</fieldset>
      <label className="switch-row"><span>无限上下文</span><input type="checkbox" role="switch" checked={form.contextMode==='infinite'} onChange={event=>setForm({...form,contextMode:event.target.checked?'infinite':'native'})}/></label><p className="hint">默认使用 Pi 原生压缩。开启后结合有效历史记忆选择保留内容与摘要，仅保存到会话现场。</p>
      <Field label="后台学习模型"><select value={form.backgroundModelId||''} onChange={event=>setForm({...form,backgroundModelId:event.target.value})}><option value="">继承触发会话模型</option>{settings.models.map(model=><option disabled={!model.ready} value={model.id} key={model.id}>{model.name} · {model.provider}</option>)}</select></Field>
      <button className="primary full" type="submit" disabled={saving}>{saving?'保存中…':'保存默认设置'}</button>
    </form></section>
    {scope==='project'&&<button onClick={()=>void window.friendPi.request<SettingsData>('settings.update',{projectId:projectId,reset:true}).then(next=>{setSettings(next);setForm(next.preferences);return refresh();}).catch(error=>report(String(error),true))}>恢复全局默认</button>}
    {state.current&&<p className="settings-snapshot">当前快照：{state.current.modelId} · {state.current.thinkingLevel} · {state.current.plugins.join(' / ')}{Boolean(state.current.pendingConfiguration)&&' · 配置等待空闲生效'}</p>}
    <section className="card environment-card"><h3>本地环境</h3><Field label="数据目录"><code>{settings.paths.dataDir||'读取中…'}</code></Field><Field label="Pi 源码版本"><code>{settings.piSource||'读取中…'}</code></Field></section></div>
    <div hidden={page!=='memory'}><section className="card"><h3>自动学习</h3><p>项目经验和个人偏好由常驻后台串行整理，前台可以同时工作。</p><p className="hint">{learning.alive?'后台服务在线':'等待后台服务'} · {learning.paused?'已暂停':'自动学习'}</p><button onClick={()=>void window.friendPi.request(learning.paused?'learning.resume':'learning.pause').then(()=>window.friendPi.request('learning.state')).then(raw=>setLearning(asObject(raw))).catch(error=>report(String(error),true))}>{learning.paused?'恢复学习':'暂停学习'}</button></section>
    {state.current?.plugins.includes('memory')&&<MemoryPanel sessionId={state.current.sessionId} report={report}/>}</div>
    <div hidden={page!=='models'}><ProviderPanel state={{...state,models:settings.models,providers:settings.providers}} report={report} refresh={providerRefresh} onBusy={setProviderBusy}/></div>
    <div hidden={page!=='extensions'}><div className="panel-intro"><h2>扩展与协作</h2><p>在常规设置中选择默认启用的能力。</p></div>{state.current?<>{state.current.plugins.includes('swarm')&&<details><summary>Swarm 任务与协作管理</summary><SwarmPanel sessionId={state.current.sessionId} report={report}/></details>}{state.current.plugins.includes('expert')&&<details><summary>专家库与版本管理</summary><ExpertPanel sessionId={state.current.sessionId} report={report}/></details>}{state.current.plugins.includes('topic-rebuild')&&<details><summary>上下文高级诊断</summary><RebuildPanel sessionId={state.current.sessionId} report={report}/></details>}</>:<Empty title="打开会话后查看扩展详情"/>}</div>
  </div></div><footer className="settings-footer"><span>{page==='models'?'保存并测试通过后，模型可用于对话':'Friend · Pi'}</span><button className="primary" disabled={providerBusy||saving} onClick={onClose}>{page==='models'?'完成并返回对话':'完成'}</button></footer></div>;
}

function PiDialog({ dialog, respond }: { dialog: DialogRequest; respond(value: JsonObject): void }) {
  const [value, setValue] = useState(dialog.prefill || dialog.options?.[0] || '');
  return <Modal title={dialog.title} onClose={() => respond({ cancelled: true })}><form onSubmit={event => { event.preventDefault(); respond(dialog.kind === 'confirm' ? { confirmed: true } : { value }); }}>{dialog.message && <p className="dialog-message">{dialog.message}</p>}{dialog.kind === 'select' ? <Field label="选择"><select value={value} onChange={event => setValue(event.target.value)}>{dialog.options?.map(option => <option value={option} key={option}>{option}</option>)}</select></Field> : dialog.kind === 'input' ? <Field label="输入"><input value={value} onChange={event => setValue(event.target.value)} /></Field> : dialog.kind === 'editor' ? <Field label="编辑内容"><textarea rows={9} value={value} onChange={event => setValue(event.target.value)} /></Field> : null}<div className="button-row right"><button type="button" onClick={() => respond({ cancelled: true })}>取消</button><button className="primary" type="submit">{dialog.kind === 'confirm' ? '允许此操作' : '确认'}</button></div></form></Modal>;
}

export default function App() {
  const [state,setState]=useState<AppState>(EMPTY),stateRef=useRef(state);stateRef.current=state;
  const [booting,setBooting]=useState(true),[notice,setNotice]=useState<{message:string;error:boolean}|null>(null);
  const [selectedProject,setSelectedProject]=useState(''),[tab,setTab]=useState<WorkspaceTab|null>(null),[sidebar,setSidebar]=useState(true);
  const [settingsPage,setSettingsPage]=useState<SettingsPage>('general'),[settingsBusy,setSettingsBusy]=useState(false);
  const [settingsOpen,setSettingsOpen]=useState(false),[material,setMaterial]=useState<Material>(),[historyOpen,setHistoryOpen]=useState(false),[sessionSearch,setSessionSearch]=useState('');
  const [menu,setMenu]=useState<{id:string;name:string;archived?:boolean;x:number;y:number}|null>(null),[deleting,setDeleting]=useState<JsonObject|null>(null),[rename,setRename]=useState<{id:string;name:string}|null>(null),[promoting,setPromoting]=useState(false);
  const [navigating,setNavigating]=useState(false),[sending,setSending]=useState(false),[localRunning,setLocalRunning]=useState(false),[swarmRunning,setSwarmRunning]=useState(false);
  const [draft,setDraft]=useState(''),draftRef=useRef('');draftRef.current=draft;
  const [attachments,setAttachments]=useState<{path:string}[]>([]),attachmentsRef=useRef(attachments),[planMode,setPlanMode]=useState(false),[mode,setMode]=useState<'single'|'team'|'swarm'>('single'),[pendingModel,setPendingModel]=useState(''),[pendingThinking,setPendingThinking]=useState('off');
  attachmentsRef.current=attachments;
  const [live,setLive]=useState<import('./types.js').Message|null>(null),[tools,setTools]=useState<TimelineToolRun[]>([]),[dialogs,setDialogs]=useState<DialogRequest[]>([]);
  const [terminalLayout,setTerminalLayout]=useState<TerminalLayout>(readTerminalLayout);
  const [terminalOpen,setTerminalOpen]=useState(false),[terminalVersion,setTerminalVersion]=useState(0),[expandedWorkbench,setExpandedWorkbench]=useState(false);
  const fileCache=useRef<FileWorkspaceCache>(new Map()),sendLock=useRef(false),migratingDraft=useRef(false),composing=useRef(false),navigationEpoch=useRef(0),liveCounter=useRef(0);
  const [layout,setLayout]=useState(()=>{try{const v=JSON.parse(localStorage.getItem('friend-pi.layout.v1')||'{}');return {sidebarWidth:Number(v.sidebarWidth)||244,workspaceWidth:Number(v.workspaceWidth)||Math.max(400,(window.innerWidth-270)/2)};}catch{return {sidebarWidth:244,workspaceWidth:500};}});
  const [viewportWidth,setViewportWidth]=useState(window.innerWidth),scroll=useRef<HTMLDivElement>(null),composer=useRef<HTMLTextAreaElement>(null),followScroll=useRef(true),searchInput=useRef<HTMLInputElement>(null);
  const sessionId=state.current?.sessionId,projectId=state.current?state.current.projectId:selectedProject;
  const project=state.projects.find(p=>p.id===projectId),activeSession=state.sessions.find(s=>s.id===sessionId);
  const workspace=state.current?.workspace||(projectId?{kind:'project' as const,projectId}:undefined),workspaceKey=state.current?.workspacePath||project?.path||'';
  const ownerKey=sessionId||'pending:'+(projectId||'temporary'),ownerRef=useRef(ownerKey);ownerRef.current=ownerKey;
  const [draftOwner,setDraftOwner]=useState(ownerKey),lastSubmitted=useRef<{sessionId?:string;owner:string;text:string;attachments:{path:string}[];accepted:boolean}|null>(null);
  const [permissionMode,setPermissionMode]=useState<PermissionMode>('auto'),[permissionExplicit,setPermissionExplicit]=useState(false),permissionExplicitRef=useRef(false);
  const running=Boolean(state.current?.isRunning||localRunning||swarmRunning),messages=state.current?.messages||[],currentPlugins=state.current?.plugins||plugins;
  useEffect(()=>{if(state.current)setSelectedProject(state.current.projectId);},[state.current?.sessionId,state.current?.projectId]);
  const report=useCallback((message:string,error=false)=>setNotice({message,error}),[]);
  const refresh=useCallback(async()=>{const next=await window.friendPi.request<AppState>('app.state');setState({...EMPTY,...next});return next;},[]);
  const invoke=useCallback(async(method:string,input:JsonObject={})=>{try{const result=await window.friendPi.request(method,input);await refresh();return result;}catch(error){report(errorText(error),true);throw error;}},[refresh,report]);
  useEffect(()=>{void refresh().catch(error=>report(errorText(error),true)).finally(()=>setBooting(false));return window.friendPi.onEvent(event=>{
    if(event.type==='state'){setState({...EMPTY,...event.data as AppState});return;}
    if(String(event.type)==='terminal'){if(asObject(event.data).kind!=='output')setTerminalVersion(v=>v+1);return;}
    if(event.sessionId&&event.sessionId!==stateRef.current.current?.sessionId)return;
    const data=asObject(event.data);
    if(event.type==='notice'){const message=typeof event.data==='string'?event.data:String(data.message||'');if(message)report(message,data.level==='error');}
    if(event.type==='dialog')setDialogs(old=>old.some(d=>d.id===data.id)?old:[...old,data as unknown as DialogRequest]);
    if(String(event.type)==='dialog.closed')setDialogs(old=>old.filter(d=>d.id!==data.id));
    if(event.type==='plugin'&&data.pluginEvent==='swarm.changed')setSwarmRunning(asObject(data.data).status==='running');
    if(String(event.type)==='stream'){
      const streamEvent=asObject(data.event),message=asObject(streamEvent.message);
      if(message.role==='assistant')setLive(piLiveMessage(message,String(data.streamId||'live-'+(++liveCounter.current))));
    }
    if(String(event.type)==='stream.committed')setLive(old=>old&&old.id===data.streamId?{...old,id:String(data.entryId)}:old);
    if(event.type!=='pi')return;
    if(data.type==='agent_start'){setLocalRunning(true);setLive(null);}
    if(data.type==='agent_settled'){setLocalRunning(false);setLive(null);void refresh().catch(()=>{});}
    if(data.type==='tool_execution_start')setTools(old=>[...old.filter(t=>t.id!==data.toolCallId),{id:String(data.toolCallId),name:String(data.toolName),status:'running',input:data.args}]);
    if(['tool_execution_update','tool_execution_end'].includes(String(data.type)))setTools(old=>old.map(t=>t.id===data.toolCallId?{...t,status:data.type==='tool_execution_end'?data.isError?'failed':'completed':'running',output:data.result??data.partialResult,error:data.isError===true}:t));
  });},[refresh,report]);
  useEffect(()=>{
    if(booting||migratingDraft.current||sendLock.current&&lastSubmitted.current&&!lastSubmitted.current.accepted)return;
    let saved:JsonObject={};try{saved=asObject(JSON.parse(localStorage.getItem('friend-pi.draft.v1:'+ownerKey)||'{}'));}catch{}
    setDraft(typeof saved.text==='string'?saved.text:'');setAttachments(asList<{path:string}>(saved.attachments));setDraftOwner(ownerKey);
    setPlanMode(typeof saved.planMode==='boolean'?saved.planMode:state.current?.planMode??state.preferences?.defaultPlanMode??false);
    permissionExplicitRef.current=!sessionId&&(saved.permissionExplicit===true||saved.permissionExplicit===undefined&&saved.permissionMode!==undefined);setPermissionExplicit(permissionExplicitRef.current);
    setPermissionMode(!sessionId&&['ask','auto','allPermissions'].includes(String(saved.permissionMode))?saved.permissionMode as PermissionMode:state.current?.permissionMode||state.preferences?.defaultPermissionMode||'auto');
    setMode(!sessionId&&(saved.mode==='swarm'||saved.mode==='team'||saved.mode==='single')?saved.mode:state.current?.executionMode||state.preferences?.defaultMode||'single');
    setLive(null);setTools([]);setDialogs([]);setLocalRunning(false);setSwarmRunning(false);followScroll.current=true;
  },[ownerKey,booting]);
  useEffect(()=>{if(booting||draftOwner!==ownerKey)return;try{localStorage.setItem('friend-pi.draft.v1:'+ownerKey,JSON.stringify({text:draft,attachments,planMode,mode,permissionMode,permissionExplicit}));}catch{}},[draft,attachments,planMode,mode,permissionMode,permissionExplicit,draftOwner,ownerKey,booting]);
  useEffect(()=>{if(!booting&&draftOwner===ownerKey&&!sessionId&&!permissionExplicitRef.current)setPermissionMode(state.preferences?.defaultPermissionMode||'auto');},[sessionId,permissionExplicit,state.preferences?.defaultPermissionMode,ownerKey,draftOwner,booting]);
  useEffect(()=>{if(followScroll.current)scroll.current?.scrollTo({top:scroll.current.scrollHeight,behavior:'instant'});},[messages,live,tools]);
  useEffect(()=>{try{localStorage.setItem('friend-pi.layout.v1',JSON.stringify(layout));}catch{}},[layout]);
  useEffect(()=>{const onResize=()=>setViewportWidth(window.innerWidth);window.addEventListener('resize',onResize);return()=>window.removeEventListener('resize',onResize);},[]);
  const newSession=async()=>{
    if(running||navigating||sendLock.current)return;
    setNavigating(true);navigationEpoch.current++;
    try{const next=await window.friendPi.request<AppState>('session.new',{projectId,modelId:pendingModel||undefined,permissionMode});setState({...EMPTY,...next});setDraftOwner(next.current?.sessionId||ownerKey);return next.current?.sessionId;}
    catch(error){report(errorText(error),true);}finally{setNavigating(false);}
  };
  const selectedModelId=state.current?.modelId||pendingModel||state.preferences?.defaultModelId||state.models.find(model=>model.ready)?.id||'';
  const selectedModel=state.models.find(model=>model.id===selectedModelId);
  useEffect(()=>{if(!sessionId&&selectedModel&&!selectedModel.thinkingLevels?.includes(pendingThinking))setPendingThinking(selectedModel.thinkingLevels?.[0]||'off');},[sessionId,selectedModelId,selectedModel?.thinkingLevels?.join('|'),pendingThinking]);
  const openModelSettings=()=>{setSettingsPage('models');setSettingsOpen(true);};
  const send=async()=>{
    if(sendLock.current||running||!draftRef.current.trim()||activeSession?.archived||!selectedModel?.ready)return;
    sendLock.current=true;setSending(true);setNotice(null);
    const submitted={sessionId,owner:ownerKey,text:draftRef.current,attachments:[...attachments],accepted:false};lastSubmitted.current=submitted;
    const epoch=navigationEpoch.current;
    try{
      let target=sessionId;
      if(!target){const next=await window.friendPi.request<AppState>('session.new',{projectId,modelId:selectedModelId,forSend:true,permissionMode});target=next.current?.sessionId;if(!target)throw new Error('会话尚未就绪');submitted.sessionId=target;if(epoch!==navigationEpoch.current)throw new Error('工作区已切换，原草稿已保留');setState({...EMPTY,...next});setDraftOwner(target);if(pendingThinking!=='off')await window.friendPi.request('session.configure',{sessionId:target,thinkingLevel:pendingThinking});}
      if(epoch!==navigationEpoch.current)throw new Error('工作区已切换，原草稿已保留');
      setLocalRunning(true);setTools([]);setLive(null);followScroll.current=true;
      await window.friendPi.request('session.send',{sessionId:target,text:submitted.text,mode,attachments:submitted.attachments,planMode});submitted.accepted=true;
      try{const remaining={text:draftRef.current===submitted.text?'':draftRef.current,attachments:JSON.stringify(attachmentsRef.current)===JSON.stringify(submitted.attachments)?[]:attachmentsRef.current,planMode,mode,permissionMode,permissionExplicit};localStorage.setItem('friend-pi.draft.v1:'+target,JSON.stringify(remaining));if(submitted.owner!==target)localStorage.removeItem('friend-pi.draft.v1:'+submitted.owner);}catch{}
      if(ownerRef.current===submitted.owner||ownerRef.current===target){if(draftRef.current===submitted.text)setDraft('');setAttachments(old=>JSON.stringify(old)===JSON.stringify(submitted.attachments)?[]:old);setDraftOwner(target);}
    }catch(error){setLocalRunning(false);if(ownerRef.current===submitted.owner||ownerRef.current===submitted.sessionId){if(!draftRef.current)setDraft(submitted.text);setDraftOwner(ownerRef.current);}report(errorText(error),true);}
    finally{sendLock.current=false;setSending(false);}
  };
  const selectProject=async(id:string)=>{if(running||sending||navigating)return;navigationEpoch.current++;setNavigating(true);try{await invoke('project.select',{projectId:id});setSelectedProject(id);setMaterial(undefined);}catch{}finally{setNavigating(false);}};
  const openProject=async()=>{if(running||navigating||sendLock.current)return;navigationEpoch.current++;setNavigating(true);try{const chosen=asObject(await invoke('project.open'));if(chosen.id){await invoke('project.select',{projectId:chosen.id});setSelectedProject(String(chosen.id));setMaterial(undefined);}}catch{}finally{setNavigating(false);}};
  const openSession=async(id:string)=>{if(running||navigating||sendLock.current)return;navigationEpoch.current++;setNavigating(true);try{await invoke('session.open',{id});setMaterial(undefined);}catch{}finally{setNavigating(false);}};
  useEffect(()=>{const keys=(event:KeyboardEvent)=>{if(document.querySelector(':popover-open')||[...document.querySelectorAll<HTMLElement>('[role="dialog"]')].some(node=>node.getClientRects().length>0))return;if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='n'){event.preventDefault();void newSession();}if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();setSidebar(true);searchInput.current?.focus();}if(event.key==='Escape'){setTab(null);setExpandedWorkbench(false);}if(event.ctrlKey&&event.key===String.fromCharCode(96)){event.preventDefault();void showTerminal();}};window.addEventListener('keydown',keys);return()=>window.removeEventListener('keydown',keys);});
  const showTerminal=async()=>{if(!sessionId){if(running||sendLock.current||navigating)return;setNavigating(true);migratingDraft.current=true;try{const captured={text:draftRef.current,attachments,planMode,mode,permissionMode,permissionExplicit};const next=await window.friendPi.request<AppState>('session.new',{projectId,modelId:pendingModel||undefined,permissionMode});const id=next.current?.sessionId;if(!id)return;localStorage.setItem('friend-pi.draft.v1:'+id,JSON.stringify(captured));setDraft(captured.text);setAttachments(captured.attachments);setPlanMode(captured.planMode);setMode(captured.mode);setPermissionMode(captured.permissionMode);setDraftOwner(id);setState({...EMPTY,...next});}catch(error){report(errorText(error),true);return;}finally{migratingDraft.current=false;setNavigating(false);}}setTerminalOpen(true);};
  const addAttachments=()=>void window.friendPi.request('file.pick').then(value=>setAttachments(old=>[...new Map([...old,...pickedPaths(value).map(path=>({path}))].map(item=>[item.path,item])).values()])).catch(error=>report(String(error),true));
  useEffect(()=>{const open=(event:Event)=>{setMaterial({...((event as CustomEvent<Material>).detail),workspaceKey});setTab('file');};const add=(event:Event)=>setDraft(old=>old+'\n'+(event as CustomEvent<{text:string}>).detail.text);window.addEventListener('friend-pi:file-open',open);window.addEventListener('friend-pi:add-material',add);return()=>{window.removeEventListener('friend-pi:file-open',open);window.removeEventListener('friend-pi:add-material',add);};},[workspaceKey]);
  const currentSessions=state.sessions.filter(item=>item.projectId===projectId&&Boolean(item.archived)===historyOpen).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  const sidebarWidth=Math.max(180,Math.min(layout.sidebarWidth,400)),workspaceWidth=Math.max(300,Math.min(layout.workspaceWidth,viewportWidth-(sidebar?sidebarWidth:0)-360));
  const lifecycleLabel:Record<string,string>={idle:'准备就绪',running:'执行中',completed:'本轮已结束',stopped:'已停止',failed:'失败',interrupted:'已中断',paused:'暂停',awaiting_review:'等待复核',rebuilding:'整理上下文'};
  return <div className={'app friend-layout '+(sidebar?'':'sidebar-hidden ')+(tab?'workspace-open ':'')+(expandedWorkbench?'workbench-expanded ':'')+(terminalOpen?'terminal-'+terminalLayout.dock:'')} style={{'--sidebar-width':sidebarWidth+'px','--workspace-width':workspaceWidth+'px','--terminal-height':terminalLayout.height+'px','--terminal-width':terminalLayout.width+'px'} as React.CSSProperties}>
    <header className="topbar project-topbar"><ProjectStrip projects={state.projects} selected={projectId} disabled={running||navigating||sending} onSelect={id=>void selectProject(id)} onOpen={()=>void openProject()} onReorder={ids=>invoke('project.reorder',{ids})}/>
      <div className="module-controls" role="toolbar" aria-label="界面模块"><button aria-label="内嵌终端" aria-pressed={terminalOpen} onClick={()=>void showTerminal()}>⌁</button><button aria-label={sidebar?'收起会话侧栏':'展开会话侧栏'} onClick={()=>setSidebar(v=>!v)}><Icon name="sidebar"/></button><button aria-label={tab?'收起右侧工作台':'展开右侧工作台'} onClick={()=>setTab(tab?null:'file')}><Icon name="workbench"/></button></div>
    </header>
    <aside className="sidebar" aria-label="当前项目会话"><div className="brand sidebar-brand"><Icon name="friend" size={32}/><span>Friend</span><small>Pi</small></div>
      <div className="sidebar-new"><button className="new-chat" disabled={running||navigating||sending} onClick={()=>void newSession()}><Icon name="plus"/>新建会话<kbd>⌘N</kbd></button><button className="history-button" aria-label="查看归档会话" aria-pressed={historyOpen} onClick={()=>setHistoryOpen(v=>!v)}><Icon name="history"/></button></div>
      <label className="session-search"><Icon name="search"/><input ref={searchInput} aria-label="搜索会话" placeholder="搜索会话…" value={sessionSearch} onChange={event=>setSessionSearch(event.target.value)}/></label><div className="sidebar-label"><span>{historyOpen?'已归档':'近期'}</span><small>{currentSessions.length} 个</small></div>
      <div className="current-session-list">{currentSessions.filter(s=>s.name.toLowerCase().includes(sessionSearch.toLowerCase())).map(item=><div className={'session-row '+(item.id===sessionId?'active':'')} key={item.id} onContextMenu={event=>{event.preventDefault();setMenu({...item,x:event.clientX,y:event.clientY});}}>
        <button className="session-button" aria-current={item.id===sessionId?'page':undefined} disabled={navigating||running&&item.id!==sessionId} onClick={()=>void openSession(item.id)}><span className={'session-lifecycle status-'+item.status}>{item.status==='completed'?'✓':'○'}</span><span className="session-card-text"><strong>{item.name}</strong><small>{lifecycleLabel[item.status||'idle']||item.status} · {state.models.find(m=>m.id===item.modelId)?.name||item.modelId?.split('/').at(-1)||'新会话'}</small></span></button>
        <button className="rename-button" aria-label={(item.archived?'删除':'归档')+' '+item.name} disabled={running&&item.id===sessionId} onClick={()=>item.archived?void window.friendPi.request('session.delete.preview',{id:item.id}).then(raw=>setDeleting(asObject(raw))).catch(error=>report(String(error),true)):void invoke('session.archive',{id:item.id,archived:true}).catch(()=>{})}>{item.archived?'×':'↧'}</button>
      </div>)}{!currentSessions.length&&<div className="session-empty">创建第一个会话开始工作</div>}</div><button className="sidebar-settings" aria-label="设置" onClick={()=>setSettingsOpen(true)}><Icon name="settings"/>设置</button>
    </aside>
    {sidebar&&<ResizeHandle className="sidebar-resize" name="调整会话侧栏宽度" value={sidebarWidth} min={180} max={400} onChange={value=>setLayout(old=>({...old,sidebarWidth:value}))}/>}
    <main className="main"><header className="conversation-heading"><div className="conversation-title"><h2>{activeSession?.name||project?.name||'临时会话'}</h2><p><Icon name="folder"/><span>{workspaceKey||'无需选择项目即可开始'}</span></p></div><div className="heading-actions">{state.current?.workspace?.kind==='temporary'&&<button disabled={running||navigating} onClick={()=>setPromoting(true)}>登记为项目</button>}<span className="session-status">{navigating?'正在打开会话':running?'正在工作':'准备就绪'}</span></div></header>
      {notice&&<div className={'notice '+(notice.error?'error':'')} role={notice.error?'alert':'status'}><span>{notice.message}</span><button aria-label="关闭提示" onClick={()=>setNotice(null)}>×</button></div>}
      {activeSession?.archived&&<div className="notice">当前为归档会话，只读查看。<button onClick={()=>void invoke('session.archive',{id:sessionId,archived:false}).catch(()=>{})}>恢复并继续</button></div>}
      <div className="conversation-stage"><TurnIndex messages={messages} container={scroll} sessionId={sessionId} onLocate={()=>{followScroll.current=false;}}/><div className="conversation" ref={scroll} onScroll={event=>{const e=event.currentTarget;followScroll.current=e.scrollHeight-e.scrollTop-e.clientHeight<100;}}>
        {booting?<Empty title="正在打开工作空间…"/>:!messages.length&&!live?<div className="welcome"><div className="welcome-mark">F<span>·</span></div><h1>从一个小任务开始</h1><p>{project?'和 Friend 一起完成这个项目。':'直接聊天、处理附件或在独立临时工作区开始任务。'}</p><div className="welcome-suggestions">{['先阅读项目，告诉我整体架构','帮我实现一个小改动，并验证结果','找回这个项目的约束与关键决定'].map(text=><button key={text} onClick={()=>{setDraft(text);composer.current?.focus();}}>{text}<span>↗</span></button>)}</div></div>:<Conversation messages={messages} live={live} tools={tools} running={running}/>}
        {state.current?.plan&&asObject(state.current.plan).status==='proposed'&&<div className="messages plan-tail"><PlanPreview body={String(asObject(state.current.plan).body||'')} disabled={running||sending||navigating||!!activeSession?.archived} canApprove={!!selectedModel?.ready}
          onRead={()=>{setMaterial({workspaceKey,title:'计划全文',text:String(asObject(state.current!.plan).body)});setTab('file');}}
          onApprove={()=>void invoke('plan.approve',{...asObject(state.current!.plan),sessionId}).then(()=>setPlanMode(false)).catch(()=>{})}
          onRevise={()=>{setDraft('请修改上述计划：');composer.current?.focus();}}
          onReject={()=>void invoke('plan.reject',{...asObject(state.current!.plan),sessionId}).then(()=>setPlanMode(false)).catch(()=>{})}/></div>}
        </div></div>
      <div className="composer-wrap"><div className="composer"><textarea ref={composer} aria-label="消息" value={draft} placeholder="描述你想完成的工作…" disabled={!!activeSession?.archived||navigating} rows={3} onChange={event=>setDraft(event.target.value)} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onKeyDown={event=>{
        const action=composerKeyAction(event.nativeEvent,composing.current);if(action==='none')return;event.preventDefault();if(action==='send')void send();else{const result=insertNewline(draftRef.current,event.currentTarget.selectionStart,event.currentTarget.selectionEnd);setDraft(result.value);requestAnimationFrame(()=>composer.current?.setSelectionRange(result.caret,result.caret));}
      }}/>{attachments.length>0&&<div className="attachment-list">{attachments.map(a=><span key={a.path}>{a.path.split('/').at(-1)}<button aria-label={'移除附件 '+a.path} onClick={()=>setAttachments(old=>old.filter(x=>x.path!==a.path))}>×</button></span>)}</div>}
      <div className="composer-toolbar"><button className="attachment-button" aria-label="添加附件" disabled={running||activeSession?.archived} onClick={addAttachments}><Icon name="plus"/></button><ComposerPermissions key={ownerKey} mode={permissionMode} disabled={running||sending||navigating||!!activeSession?.archived} onChange={async next=>{const owner=ownerKey,epoch=navigationEpoch.current;const result=sessionId?await window.friendPi.request<AppState>("session.configure",{sessionId,permissionMode:next}).catch(error=>{report(errorText(error),true);throw error;}):undefined;if(ownerRef.current===owner&&navigationEpoch.current===epoch){if(result)setState({...EMPTY,...result});setPermissionMode(result?.current?.permissionMode||next);permissionExplicitRef.current=true;setPermissionExplicit(true);}}}/>
        <button type="button" className={'plan-control '+(planMode?'active':'')} role="switch" aria-label="计划模式（只读分析）" aria-checked={planMode} title="先只读探索并提交计划，批准后执行" disabled={running||sending||navigating||!!activeSession?.archived} onClick={()=>setPlanMode(value=>!value)}><Icon name="plan" size={16}/><span>先规划</span><span className="plan-switch" aria-hidden="true"/></button>
        <div className="agent-mode-control" role="radiogroup" aria-label="Agent 协作方式" data-mode={mode}><span className="agent-mode-thumb"/>{(['single','team','swarm'] as const).map(m=><button key={m} type="button" role="radio" data-agent-mode={m} aria-label={(m==='single'?'Single，单人协作':m==='team'?'Team，团队协作':'Swarm，高级协作')} title={m==='single'?'Single · 单人协作':m==='team'?'Team · 团队协作':'Swarm · 高级协作'} aria-checked={mode===m} tabIndex={mode===m?0:-1} className={mode===m?'selected':''} disabled={running||sending||navigating||!!activeSession?.archived||m!=='single'&&!currentPlugins.includes('swarm')} onClick={()=>{const owner=ownerKey,epoch=navigationEpoch.current;if(sessionId)void window.friendPi.request<AppState>('session.configure',{sessionId,executionMode:m}).then(result=>{if(ownerRef.current===owner&&navigationEpoch.current===epoch){setState({...EMPTY,...result});setMode(result.current?.executionMode||m);}}).catch(error=>report(errorText(error),true));else setMode(m);}} onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();const available=(['single','team','swarm'] as const).filter(item=>item==='single'||currentPlugins.includes('swarm')),index=available.indexOf(m),next=event.key==='Home'?available[0]:event.key==='End'?available.at(-1):available[(index+(['ArrowLeft','ArrowUp'].includes(event.key)?-1:1)+available.length)%available.length];if(next){const target=event.currentTarget.parentElement?.querySelector<HTMLButtonElement>('[data-agent-mode="'+next+'"]');target?.focus();target?.click();}}}><Icon name={m==='single'?'single':m==='team'?'team':'swarm'} size={16}/><span>{m==='single'?'单人协作':m==='team'?'团队协作':'高级协作'}</span></button>)}</div>
        <ModelPicker key={ownerKey} models={state.models} modelId={selectedModelId} thinkingLevel={state.current?.thinkingLevel||pendingThinking} thinkingLevels={selectedModel?.thinkingLevels||['off']} disabled={running||sending||navigating||!!activeSession?.archived} onConfigure={openModelSettings} onChange={async input=>{if(sessionId)await invoke('session.configure',{sessionId,...input});else {if(input.modelId){setPendingModel(input.modelId);setPendingThinking(state.models.find(model=>model.id===input.modelId)?.thinkingLevels?.[0]||'off');}if(input.thinkingLevel)setPendingThinking(input.thinkingLevel);}}}/>

        {running?<button className="stop-button" aria-label="停止当前任务" onClick={()=>void invoke('session.stop',{sessionId}).then(()=>{setLocalRunning(false);setSwarmRunning(false);setDialogs([]);}).catch(()=>{})}>停止</button>:<button className="send-button" aria-label="发送消息" title="Enter 发送；⌘ Enter 换行" disabled={activeSession?.archived||!draft.trim()||sending||navigating||!selectedModel?.ready} onClick={()=>void send()}><Icon name="send"/></button>}
      </div></div></div>
    </main>
    {tab&&<ResizeHandle className="workspace-resize" name="调整工作台宽度" value={workspaceWidth} min={300} max={Math.max(400,viewportWidth-(sidebar?sidebarWidth:0)-360)} reverse onChange={value=>setLayout(old=>({...old,workspaceWidth:value}))}/>}
    {tab&&<aside className="workspace" aria-label="工作台"><button className="expand-workbench" aria-label={expandedWorkbench?'恢复工作台大小':'放大工作台'} onClick={()=>setExpandedWorkbench(v=>!v)}>{expandedWorkbench?'还原':'放大'}</button><Workbench state={state} projectId={projectId||undefined} workspace={workspace} workspaceKey={workspaceKey} fileCache={fileCache.current} page={tab as WorkbenchPage} onPage={setTab} onClose={()=>{setTab(null);setExpandedWorkbench(false);}} onSettings={()=>setSettingsOpen(true)} material={material} report={report}/></aside>}
    {sessionId&&<TerminalPanel key={sessionId} sessionId={sessionId} open={terminalOpen} version={terminalVersion} onHide={()=>setTerminalOpen(false)} onLayoutChange={setTerminalLayout} report={report}/>}
    {settingsOpen&&<Modal title="Friend 设置" className="application-settings" closeDisabled={settingsBusy} wide onClose={()=>{if(!settingsBusy)setSettingsOpen(false);}}><SettingsPanel state={state} onBusy={setSettingsBusy} page={settingsPage} setPage={setSettingsPage} onClose={()=>setSettingsOpen(false)} projectId={projectId||undefined} report={report} refresh={refresh}/></Modal>}
    {promoting&&<Modal title="登记为新项目" onClose={()=>setPromoting(false)}><p>沿用当前工作目录、文件和会话历史。</p><form onSubmit={event=>{event.preventDefault();const name=new FormData(event.currentTarget).get('name');void invoke('session.promote',{id:sessionId,name}).then(()=>setPromoting(false)).catch(()=>{});}}><Field label="项目名称"><input name="name" defaultValue={activeSession?.name==='新会话'?'新项目':activeSession?.name} required maxLength={100}/></Field><button type="submit" className="primary">登记项目</button></form></Modal>}
    {menu&&<div className="session-menu" role="menu" style={{left:Math.min(menu.x,window.innerWidth-170),top:menu.y}}><button role="menuitem" onClick={()=>{setRename({id:menu.id,name:menu.name});setMenu(null);}}>重命名</button><button role="menuitem" onClick={()=>{void invoke('session.relocate',{id:menu.id}).catch(()=>{});setMenu(null);}}>重新定位原始历史</button><button role="menuitem" onClick={()=>{void invoke('session.archive',{id:menu.id,archived:!menu.archived}).catch(()=>{});setMenu(null);}}>{menu.archived?'恢复':'归档'}</button><button role="menuitem" onClick={()=>{void window.friendPi.request('session.delete.preview',{id:menu.id}).then(raw=>setDeleting(asObject(raw))).catch(error=>report(String(error),true));setMenu(null);}}>删除</button><button onClick={()=>setMenu(null)}>关闭菜单</button></div>}
    {deleting&&<Modal title="删除会话" onClose={()=>setDeleting(null)}><p>永久删除“{String(deleting.name)}”的会话历史及独占插件记录；工作文件保留。</p><div className="button-row"><button onClick={()=>setDeleting(null)}>取消</button><button className="primary" onClick={()=>void invoke('session.delete',{id:deleting.id,token:deleting.token}).then(()=>setDeleting(null)).catch(()=>{})}>确认删除</button></div></Modal>}
    {dialogs[0]&&<PiDialog key={dialogs[0].id} dialog={dialogs[0]} respond={value=>{const id=dialogs[0].id;void window.friendPi.request('dialog.respond',{id,...value}).then(()=>setDialogs(old=>old.filter(d=>d.id!==id))).catch(error=>{report(String(error),true);setDialogs(old=>old.filter(d=>d.id!==id));});}}/>}
    {rename&&<Modal title="重命名会话" onClose={()=>setRename(null)}><form onSubmit={event=>{event.preventDefault();void invoke('session.rename',rename).then(()=>setRename(null)).catch(()=>{});}}><Field label="会话名称"><input value={rename.name} onChange={event=>setRename({...rename,name:event.target.value})}/></Field><button className="primary" disabled={!rename.name.trim()}>保存名称</button></form></Modal>}
  </div>;
}
