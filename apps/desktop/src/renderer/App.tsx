import {BatchQuestionCard,type QuestionDraft} from './BatchQuestionCard.js';
import {questionOrder,type QuestionBatchDialog} from '../question-batch.js';
import {CapabilitiesPanel} from './CapabilitiesPanel.js';
import {ProjectSidebar,sidebarSessions,type SessionMoves} from './ProjectSidebar.js';
import {queueIntent,acknowledgeQueueIntent,hasQueueIntent} from './queue-intent.js';
import {PiDialog} from './PiDialog.js';
import {permissionOptions} from './composer-permissions.js';
import type {PermissionMode} from './types.js';
import {initialView,browserUrl,browserScopeNames,type SessionViewState,type ToolPage,type BrowserScope} from '../session-view.js';
import {openTool,toggleTrace,toggleTerminal,addNewTab,closeViewTab,visibleSessionView} from './view-tabs.js';
import {TerminalNotice} from './TerminalNotice.js';
import {SessionTabs,NewTabPage} from './SessionTabs.js';
import {SessionComposer,type ComposerSnapshot,type ComposerAction} from './SessionComposer.js';
import type {QueueUi} from './QueueMessages.js';
import {SessionStats} from './SessionStats.js';
import {BrowserPane} from './BrowserPane.js';
import type {BrowserSnapshot} from '../browser-host.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MemoryPanel } from './panels.js';
import { asList, asObject, contentText, errorText, pluginLabels, type AppState, type DialogRequest, type JsonObject, type PluginName, type Preferences, type WorkspaceTab } from './types.js';
import { Badge, Empty, Field, JsonView, Markdown, RichMessage, Modal } from './ui.js';
import {TurnIndex,messageAnchor} from './TurnIndex.js';
import {Icon,type IconName} from './Icons.js';
import {ResizeHandle} from './ResizeHandle.js';
import {Workbench,type WorkbenchPage,type Material} from './Workbench.js';
import {TeammateRoster,TeammateConversation} from './Teammates.js';
import {Conversation} from './Conversation.js';
import {piLiveMessage,updateToolRun,type ToolRun as TimelineToolRun} from './timeline.js';
import {ChangeDiffCache,type ChangeReviewTarget} from './change-review.js';
import {Trajectory} from './Trajectory.js';
import {composerKeyAction,insertNewline} from './composer-keys.js';
import type {FileWorkspaceCache} from './FileWorkspace.js';
import {ProviderPanel} from './ProviderPanel.js';
import {ModelPicker} from './model-picker.js';
import {PlanPreview} from './plan-preview.js';
import {TerminalPanel} from './TerminalPanel.js';
import {CustomInstructionsPanel} from './CustomInstructionsPanel.js';

const EMPTY: AppState = { projects: [], sessions: [], current: null, models: [], providers: [] };
const plugins: PluginName[] = ['swarm', 'expert', 'memory', 'topic-rebuild'];
const labels: Record<WorkspaceTab, string> = { ...pluginLabels, browser:'浏览器',file: '文件', diff: 'Diff', settings: '设置' };
interface ToolRun { id: string; name: string; status: string; input: unknown; output?: unknown; error?: boolean }
function pickedPaths(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : [];
  const result = asObject(value);
  const values = Array.isArray(value) ? value : Array.isArray(result.paths) ? result.paths : result.path ? [result.path] : [];
  return values.map(item => typeof item === 'string' ? item : String(asObject(item).path || '')).filter(Boolean);
}


interface SettingsData {preferences:Preferences;models:AppState['models'];providers:AppState['providers'];paths:{dataDir:string};piSource:string}
type SettingsPage='general'|'models'|'instructions'|'memory'|'extensions';
export function SettingsPanel({state,report,refresh,projectId,page,setPage,onClose,onBusy}:{onBusy(busy:boolean):void;page:SettingsPage;setPage(page:SettingsPage):void;onClose():void;projectId?:string;state:AppState;report(message:string,error?:boolean):void;refresh():Promise<AppState>}) {
  const defaults:Preferences={defaultModelId:'',defaultThinkingLevel:'off',defaultPlugins:[...plugins],defaultMode:'single',defaultPlanMode:false,defaultPermissionMode:'auto',defaultWorkspaceDir:'~/Documents/Friend',contextMode:'native',backgroundModelId:''};
  const [settings,setSettings]=useState<SettingsData>({preferences:state.preferences||defaults,models:state.models,providers:state.providers,paths:{dataDir:''},piSource:''});
  const [form,setForm]=useState<Preferences>(settings.preferences);const [settingsReady,setSettingsReady]=useState(false);const loadGeneration=useRef(0);const [providerBusy,setProviderBusy]=useState(false);const [saving,setSaving]=useState(false);const [scope,setScope]=useState('global');const [query,setQuery]=useState('');const [learning,setLearning]=useState<JsonObject>({});const settingsRoot=useRef<HTMLDivElement>(null);
  const load=useCallback(async()=>{const generation=++loadGeneration.current;setSettingsReady(false);const next=await window.friendPi.request<SettingsData>('settings.get',{projectId:scope==='project'?projectId:undefined});if(generation!==loadGeneration.current)return;setSettings(next);setForm(next.preferences);setSettingsReady(true);},[scope,projectId]);
  useEffect(()=>{void load().catch(error=>report(errorText(error),true));return()=>{loadGeneration.current++;};},[load,report]);
  const providerRefresh=async()=>{const next=await refresh();setSettings(await window.friendPi.request<SettingsData>('settings.get',{projectId:scope==='project'?projectId:undefined}));return next;};
  const [instructionsBusy,setInstructionsBusy]=useState(false);
  useEffect(()=>onBusy(providerBusy||saving||instructionsBusy),[providerBusy,saving,instructionsBusy,onBusy]);
  useEffect(()=>{for(const field of settingsRoot.current?.querySelector('[data-settings-general]')?.querySelectorAll<HTMLElement>('.field,.switch-row,fieldset')||[])field.hidden=!!query&&!field.textContent?.toLowerCase().includes(query.toLowerCase());},[query]);
  useEffect(()=>{void window.friendPi.request('learning.state').then(raw=>setLearning(asObject(raw))).catch(()=>{});},[]);
  const toggleCapability=async(plugin:'expert'|'memory',enabled:boolean)=>{
    if(!settingsReady||saving)return;
    setSaving(true);
    try{
      const defaultPlugins=enabled?[...new Set([...settings.preferences.defaultPlugins,plugin])]:settings.preferences.defaultPlugins.filter(item=>item!==plugin);
      const next=await window.friendPi.request<SettingsData>('settings.update',{defaultPlugins,projectId:scope==='project'?projectId:undefined});
      setSettings(next);setForm(previous=>({...previous,defaultPlugins:next.preferences.defaultPlugins}));await refresh();
      report(`${plugin==='expert'?'Expert':'记忆'}已${enabled?'启用':'停用'}；正在运行的会话将在空闲后生效`);
    }catch(error){report(errorText(error),true);}finally{setSaving(false);}
  };
  const defaultModel=settings.models.find(model=>model.id===form.defaultModelId)||(!form.defaultModelId?settings.models.find(model=>model.ready):undefined);
  const pageScroll=useRef<Partial<Record<SettingsPage,number>>>({});const pageBody=useRef<HTMLDivElement>(null);const previousPage=useRef(page);
  useEffect(()=>{previousPage.current=page;if(pageBody.current)pageBody.current.scrollTop=pageScroll.current[page]||0;},[page]);
  return <div className="settings-shell"><nav className="settings-nav" aria-label="设置分类">{([['general','常规'],['models','模型'],['instructions','自定义指令'],['memory','记忆'],['extensions','扩展']] as const).map(([id,label])=><button key={id} aria-current={page===id?'page':undefined} onClick={()=>setPage(id)}>{label}</button>)}</nav><div ref={pageBody} className="settings-body" onScroll={e=>{pageScroll.current[previousPage.current]=e.currentTarget.scrollTop;}}><div ref={settingsRoot} className="panel-content settings-panel"><div data-settings-general hidden={page!=='general'}><input aria-label="搜索设置" placeholder="搜索设置…" value={query} onChange={event=>setQuery(event.target.value)}/><Field label="设置作用域"><select value={scope} disabled={saving} onChange={event=>{setSettingsReady(false);setScope(event.target.value);}}><option value="global">全局默认</option><option value="project" disabled={!projectId}>当前项目覆盖</option></select></Field><div className="panel-intro"><h2>设置</h2><p>模型与权限默认值用于新会话；上下文策略在安全边界应用。</p></div>
    <section className="card"><h3>新会话默认值</h3><form onSubmit={event=>{event.preventDefault();if(!settingsReady||saving)return;setSaving(true);void window.friendPi.request<SettingsData>('settings.update',{...form,defaultPlugins:form.contextMode==='infinite'?[...new Set([...form.defaultPlugins,'topic-rebuild'])]:form.defaultPlugins,projectId:scope==='project'?projectId:undefined}).then(async next=>{setSettings(next);setForm(next.preferences);await refresh();report('设置已保存；模型默认值用于新会话，能力与上下文在安全边界生效');}).catch(error=>report(errorText(error),true)).finally(()=>setSaving(false));}}>
      <Field label="默认模型"><select value={form.defaultModelId||''} onChange={event=>{const id=event.target.value;const model=settings.models.find(model=>model.id===id);setForm({...form,defaultModelId:id,defaultThinkingLevel:model?.thinkingLevels?.includes(form.defaultThinkingLevel)?form.defaultThinkingLevel:model?.thinkingLevels?.[0]||'off'});}}><option value="">自动选择已验证模型</option>{settings.models.map(model=><option disabled={!model.ready} value={model.id} key={model.id}>{model.name} · {model.provider}</option>)}</select></Field>
      <Field label="默认思考等级"><select value={form.defaultThinkingLevel} onChange={event=>setForm({...form,defaultThinkingLevel:event.target.value})}>{[['off','不思考'],['minimal','最少'],['low','低'],['medium','中'],['high','高'],['xhigh','最高']].filter(([value])=>(defaultModel?.thinkingLevels||['off']).includes(value)).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></Field>
      {scope==='global'&&<Field label="临时会话默认目录"><input value={form.defaultWorkspaceDir||'~/Documents/Friend'} onChange={event=>setForm({...form,defaultWorkspaceDir:event.target.value})}/><p className="hint">新临时会话在此目录下使用独立子目录。文件页显示当前会话的文件；目录外修改需批准。</p></Field>}
      <Field label="默认权限策略"><select value={form.defaultPermissionMode||"auto"} onChange={event=>setForm({...form,defaultPermissionMode:event.target.value as PermissionMode})}>{permissionOptions.map(option=><option key={option.id} value={option.id}>{option.name}</option>)}</select></Field>
      <Field label="新会话浏览器登录范围"><select value={form.defaultBrowserScope||'app'} onChange={e=>setForm({...form,defaultBrowserScope:e.target.value as BrowserScope})}>{Object.entries(browserScopeNames).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></Field><p className="hint">仅用于新会话，已有会话的登录范围单独保存。</p>
      <label className="switch-row settings-plan"><span>新会话默认先规划</span><input type="checkbox" role="switch" checked={form.defaultPlanMode} onChange={event=>setForm({...form,defaultPlanMode:event.target.checked})}/></label>
      <label className="switch-row"><span>无限上下文</span><input type="checkbox" role="switch" checked={form.contextMode==='infinite'} onChange={event=>setForm({...form,contextMode:event.target.checked?'infinite':'native',defaultPlugins:event.target.checked?[...new Set([...form.defaultPlugins,'topic-rebuild' as const])]:form.defaultPlugins})}/></label><p className="hint">默认使用 Pi 原生压缩。开启后结合有效历史记忆选择保留内容与摘要，仅保存到会话现场。</p>
      <Field label="后台学习模型"><select value={form.backgroundModelId||''} onChange={event=>setForm({...form,backgroundModelId:event.target.value})}><option value="">继承触发会话模型</option>{settings.models.map(model=><option disabled={!model.ready} value={model.id} key={model.id}>{model.name} · {model.provider}</option>)}</select></Field>
      <button className="primary full" type="submit" disabled={saving||!settingsReady}>{saving?'保存中…':'保存默认设置'}</button>
    </form></section>
    <section className="card"><label className="switch-row"><span>启用 Expert</span><input type="checkbox" role="switch" disabled={saving||!settingsReady} checked={settings.preferences.defaultPlugins.includes('expert')} onChange={event=>void toggleCapability('expert',event.target.checked)}/></label><p className="hint">{!settingsReady?'正在读取设置…':scope==='project'?'当前项目设置':'全局默认设置'}，运行中的会话将在空闲后生效。</p></section>
    {scope==='project'&&<button disabled={saving||!settingsReady} onClick={()=>void window.friendPi.request<SettingsData>('settings.update',{projectId:projectId,reset:true}).then(next=>{setSettings(next);setForm(next.preferences);return refresh();}).catch(error=>report(String(error),true))}>恢复全局默认</button>}
    {Boolean(state.current?.pendingConfiguration)&&<p className="settings-snapshot">能力配置将在当前会话空闲后生效。</p>}
    <section className="card environment-card"><h3>本地环境</h3><Field label="数据目录"><code>{settings.paths.dataDir||'读取中…'}</code></Field><Field label="Pi 源码版本"><code>{settings.piSource||'读取中…'}</code></Field></section></div>
    <div hidden={page!=='memory'}><section className="card"><label className="switch-row"><span>启用记忆</span><input type="checkbox" role="switch" disabled={saving||!settingsReady} checked={settings.preferences.defaultPlugins.includes('memory')} onChange={event=>void toggleCapability('memory',event.target.checked)}/></label></section><section className="card"><h3>自动学习</h3><p>项目经验和个人偏好由常驻后台串行整理，前台可以同时工作。</p><p className="hint">{learning.alive?'后台服务在线':'等待后台服务'} · {learning.paused?'已暂停':'自动学习'}</p><button onClick={()=>void window.friendPi.request(learning.paused?'learning.resume':'learning.pause').then(()=>window.friendPi.request('learning.state')).then(raw=>setLearning(asObject(raw))).catch(error=>report(String(error),true))}>{learning.paused?'恢复学习':'暂停学习'}</button></section>
    {state.current?.plugins.includes('memory')&&<MemoryPanel sessionId={state.current.sessionId} report={report}/>}</div>
    <div hidden={page!=='instructions'}><CustomInstructionsPanel onBusy={setInstructionsBusy}/></div>
    <div hidden={page!=='models'}><ProviderPanel state={{...state,models:settings.models,providers:settings.providers}} report={report} refresh={providerRefresh} onBusy={setProviderBusy}/></div>
    <div hidden={page!=='extensions'}>{state.current?<CapabilitiesPanel sessionId={state.current.sessionId} report={report}/>:<Empty title="打开会话后配置 MCP 与外部工具"/>}</div>
  </div></div><footer className="settings-footer"><span>{instructionsBusy?'请先保存或取消自定义指令的修改':page==='models'?'保存并测试通过后，模型可用于对话':'Friend · Pi'}</span><button className="primary" disabled={providerBusy||saving||instructionsBusy} onClick={onClose}>{page==='models'?'完成并返回对话':'完成'}</button></footer></div>;
}


export default function App() {
  const [changeReview,setChangeReview]=useState<ChangeReviewTarget>();const changeCache=useRef(new ChangeDiffCache());
  const deferredDialogs=useRef(new Set<string>());
  const [requestedSession,setRequestedSession]=useState<string>();
  const [contextStatsTarget,setContextStatsTarget]=useState<HTMLSpanElement|null>(null);
  const [state,setState]=useState<AppState>(EMPTY),stateRef=useRef(state);stateRef.current=state;
  const [booting,setBooting]=useState(true),[notice,setNotice]=useState<{message:string;error:boolean}|null>(null);
  const [selectedProject,setSelectedProject]=useState(''),[sidebar,setSidebar]=useState(true);
  const [settingsPage,setSettingsPage]=useState<SettingsPage>('general'),[settingsBusy,setSettingsBusy]=useState(false);
  const [settingsOpen,setSettingsOpen]=useState(false),[material,setMaterial]=useState<Material>(),[historyOpen,setHistoryOpen]=useState(false),[sessionSearch,setSessionSearch]=useState('');
  const [menu,setMenu]=useState<{id:string;name:string;archived?:boolean;x:number;y:number;moves?:SessionMoves}|null>(null),[deleting,setDeleting]=useState<JsonObject|null>(null),[rename,setRename]=useState<{id:string;name:string}|null>(null);
  const [navigating,setNavigating]=useState(false),[sending,setSending]=useState(false),[localRunning,setLocalRunning]=useState(false),[swarmRunning,setSwarmRunning]=useState(false);
  const [submissionRevision,setSubmissionRevision]=useState(0);
  const [draft,setDraft]=useState(''),draftRef=useRef('');draftRef.current=draft;
  const [attachments,setAttachments]=useState<{path:string}[]>([]),attachmentsRef=useRef(attachments),[planMode,setPlanMode]=useState(false),[mode,setMode]=useState<'single'|'team'|'swarm'>('single'),[pendingModel,setPendingModel]=useState(''),[pendingThinking,setPendingThinking]=useState('off');
  attachmentsRef.current=attachments;
  const [memberRoute,setMemberRoute]=useState<{rootSessionId:string;memberId:string}|null>(null);const activeMember=memberRoute?.rootSessionId===state.current?.sessionId?memberRoute?.memberId||null:null,activeMemberRef=useRef(activeMember);activeMemberRef.current=activeMember;const rootScrollBeforeMember=useRef({top:0,following:true});
  const questionDrafts=useRef(new Map<string,QuestionDraft>());
  const [live,setLive]=useState<import('./types.js').Message|null>(null),[tools,setTools]=useState<TimelineToolRun[]>([]),[dialogs,setDialogs]=useState<DialogRequest[]>([]);
  const [terminalVersion,setTerminalVersion]=useState(0);
  const [terminalTarget,setTerminalTarget]=useState<{sessionId:string;id:string}>(),terminalOpening=useRef(false);
  const [view,setView]=useState<SessionViewState>(initialView()),viewRef=useRef(view),viewOwner=useRef(''),uiQueue=useRef<Promise<unknown>>(Promise.resolve()),uiPending=useRef(0),uiVersion=useRef(0);
  const pendingView=useRef<{id:string;ui:SessionViewState}|null>(null);
  const [browserSnapshot,setBrowserSnapshot]=useState<BrowserSnapshot>({tabs:[],downloads:[]}),[browserBlocked,setBrowserBlocked]=useState(false);
  const fileCache=useRef<FileWorkspaceCache>(new Map()),sendLock=useRef(false),allocationLock=useRef(false),migratingDraft=useRef(false),composing=useRef(false),navigationEpoch=useRef(0),liveCounter=useRef(0);
  const [layout,setLayout]=useState(()=>{try{const v=JSON.parse(localStorage.getItem('friend-pi.layout.v1')||'{}');return {sidebarWidth:Number(v.sidebarWidth)||244};}catch{return {sidebarWidth:244};}});
  const scroll=useRef<HTMLDivElement>(null),composer=useRef<HTMLTextAreaElement>(null),followScroll=useRef(true),searchInput=useRef<HTMLInputElement>(null);
  const sessionId=state.current?.sessionId,projectId=state.current?state.current.projectId:state.selectedProjectId??selectedProject;
  const project=state.projects.find(p=>p.id===projectId),activeSession=state.sessions.find(s=>s.id===sessionId);
  const workspace=state.current?.workspace||(projectId?{kind:'project' as const,projectId}:undefined),workspaceKey=state.current?.workspacePath||project?.path||'';
  const ownerKey=sessionId||'pending:'+(projectId||'temporary'),ownerRef=useRef(ownerKey);ownerRef.current=ownerKey;
  const [draftOwner,setDraftOwner]=useState(ownerKey),lastSubmitted=useRef<{sessionId?:string;owner:string;text:string;attachments:{path:string}[];accepted:boolean}|null>(null);
  const [permissionMode,setPermissionMode]=useState<PermissionMode>('auto'),[permissionExplicit,setPermissionExplicit]=useState(false),permissionExplicitRef=useRef(false);
  const sessionView=visibleSessionView(viewOwner.current===sessionId?view:state.current?.ui||initialView());viewRef.current=sessionView;
  const activeViewTab=sessionView.tabs.find(t=>t.id===sessionView.active),toolActive=sessionView.active!=='conversation';
  const browserTabs=sessionView.tabs.filter(t=>t.kind==='browser'),browserTab=toolActive&&activeViewTab?.kind==='browser'?activeViewTab:undefined;
  const [queueUi,setQueueUi]=useState<QueueUi>({});
  useEffect(()=>{setQueueUi({});},[state.current?.sessionId]);
  const running=Boolean(state.current?.isRunning||localRunning||swarmRunning),messages=state.current?.messages||[],currentPlugins=state.current?.plugins||plugins;
  useEffect(()=>{setSelectedProject(state.selectedProjectId??state.current?.projectId??'');},[state.selectedProjectId,state.current?.projectId]);
  const batchDialog=dialogs.filter((dialog):dialog is QuestionBatchDialog=>dialog.kind==='questionBatch').sort(questionOrder)[0],modalDialog=dialogs.find(dialog=>dialog.kind!=='questionBatch');
  const report=useCallback((message:string,error=false)=>setNotice({message,error}),[]);
  useEffect(()=>{const live=new Set((state.activities||[]).filter(activity=>activity.kind==='dialog'&&activity.dialog?.kind==='questionBatch').map(activity=>activity.dialog!.id));for(const key of questionDrafts.current.keys())if(!live.has(JSON.parse(key)[2]))questionDrafts.current.delete(key);},[state.activities]);
  const restoreDialogs=useCallback(()=>{deferredDialogs.current.clear();setDialogs(stateRef.current.current?.dialogs||[]);},[]);
  useEffect(()=>{if(sessionView.active==='conversation')restoreDialogs();},[sessionId,sessionView.active,restoreDialogs]);
  const applyState=useCallback((next:AppState)=>{if((next.revision||0)<(stateRef.current.revision||0))return;stateRef.current={...EMPTY,...next};setState(stateRef.current);},[]);
  const refresh=useCallback(async()=>{const next=await window.friendPi.request<AppState>('app.state');applyState(next);return next;},[applyState]);
  const invoke=useCallback(async(method:string,input:JsonObject={})=>{try{const result=await window.friendPi.request(method,input);await refresh();return result;}catch(error){report(errorText(error),true);throw error;}},[refresh,report]);
  useEffect(()=>{void refresh().catch(error=>report(errorText(error),true)).finally(()=>setBooting(false));return window.friendPi.onEvent(event=>{
    if(event.type==='state'){applyState(event.data as AppState);return;}
    if(String(event.type)==='navigation.request'){setRequestedSession(String(asObject(event.data).id));return;}
    if(String(event.type)==='terminal'){if(asObject(event.data).kind!=='output')setTerminalVersion(v=>v+1);return;}
    if(String(event.type)==='view'){if(event.sessionId===stateRef.current.current?.sessionId){if(uiPending.current)pendingView.current={id:event.sessionId||'',ui:event.data as SessionViewState};else{viewOwner.current=event.sessionId||'';setView(event.data as SessionViewState);}}return;}
    if(String(event.type)==='browser'){if(event.sessionId===stateRef.current.current?.sessionId)setBrowserSnapshot(event.data as BrowserSnapshot);return;}
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
    if(['tool_execution_update','tool_execution_end'].includes(String(data.type)))setTools(old=>updateToolRun(old,data));
  });},[refresh,report,applyState]);
  useEffect(()=>{
    if(booting||migratingDraft.current||sendLock.current&&lastSubmitted.current&&!lastSubmitted.current.accepted)return;
    let saved:JsonObject={};try{saved=asObject(JSON.parse(localStorage.getItem('friend-pi.draft.v1:'+ownerKey)||'{}'));}catch{}
    setDraft(typeof saved.text==='string'?saved.text:state.current?.sideDraft?.text||'');setAttachments(Array.isArray(saved.attachments)?asList<{path:string}>(saved.attachments):(state.current?.sideDraft?.attachments||[]).map(item=>({path:item.path})));setDraftOwner(ownerKey);
    setPlanMode(typeof saved.planMode==='boolean'?saved.planMode:state.current?.sideDraft?.planMode??state.current?.planMode??state.preferences?.defaultPlanMode??false);
    permissionExplicitRef.current=!sessionId&&(saved.permissionExplicit===true||saved.permissionExplicit===undefined&&saved.permissionMode!==undefined);setPermissionExplicit(permissionExplicitRef.current);
    setPermissionMode(!sessionId&&['ask','auto','allPermissions'].includes(String(saved.permissionMode))?saved.permissionMode as PermissionMode:state.current?.permissionMode||state.preferences?.defaultPermissionMode||'auto');
    setMode((!sessionId||!!state.current?.sideDraft)&&(saved.mode==='swarm'||saved.mode==='team'||saved.mode==='single')?saved.mode:state.current?.sideDraft?.mode||state.current?.executionMode||state.preferences?.defaultMode||'single');
    setChangeReview(undefined);setLive(null);setTools([]);setDialogs([]);setLocalRunning(false);setSwarmRunning(false);followScroll.current=true;
  },[ownerKey,booting]);
  useEffect(()=>{if(booting||draftOwner!==ownerKey)return;try{localStorage.setItem('friend-pi.draft.v1:'+ownerKey,JSON.stringify({text:draft,attachments,planMode,mode,permissionMode,permissionExplicit}));}catch{}},[draft,attachments,planMode,mode,permissionMode,permissionExplicit,draftOwner,ownerKey,booting]);
  useEffect(()=>{if(!booting&&draftOwner===ownerKey&&!sessionId&&!permissionExplicitRef.current)setPermissionMode(state.preferences?.defaultPermissionMode||'auto');},[sessionId,permissionExplicit,state.preferences?.defaultPermissionMode,ownerKey,draftOwner,booting]);
  useEffect(()=>{setDialogs((state.current?.dialogs||[]).filter(dialog=>!deferredDialogs.current.has(dialog.id)));},[state.current?.sessionId,state.current?.dialogs]);
  useEffect(()=>{if(mode!=='swarm')setMemberRoute(null);},[mode]);
  useEffect(()=>{if(!activeMember&&!toolActive&&followScroll.current)scroll.current?.scrollTo({top:scroll.current.scrollHeight,behavior:'instant'});},[messages,live,tools,toolActive,activeMember]);
  useEffect(()=>{try{localStorage.setItem('friend-pi.layout.v1',JSON.stringify(layout));}catch{}},[layout]);
  const newSession=async(targetProjectId=projectId||'')=>{
    if(navigating||sending||allocationLock.current||migratingDraft.current||sendLock.current)return;
    allocationLock.current=true;setNavigating(true);navigationEpoch.current++;
    try{const next=await window.friendPi.request<AppState>('session.new',{projectId:targetProjectId,modelId:targetProjectId===projectId?pendingModel||undefined:undefined,permissionMode:targetProjectId===projectId?permissionMode:undefined});applyState(next);const id=next.createdSessionId||next.current?.sessionId;if(next.current?.sessionId!==id)return;setDraftOwner(id||ownerKey);return id;}
    catch(error){report(errorText(error),true);}finally{allocationLock.current=false;setNavigating(false);}
  };
  const selectedModelId=state.current?.modelId||pendingModel||state.preferences?.defaultModelId||state.models.find(model=>model.ready)?.id||'';
  const selectedModel=state.models.find(model=>model.id===selectedModelId);
  useEffect(()=>{if(!sessionId&&selectedModel&&!selectedModel.thinkingLevels?.includes(pendingThinking))setPendingThinking(selectedModel.thinkingLevels?.[0]||'off');},[sessionId,selectedModelId,selectedModel?.thinkingLevels?.join('|'),pendingThinking]);
  const openModelSettings=()=>{setSettingsPage('models');setSettingsOpen(true);};
  const send=async()=>{
    if(sendLock.current||allocationLock.current||navigating||migratingDraft.current||!draftRef.current.trim()&&!attachmentsRef.current.length||activeSession?.archived||!selectedModel?.ready){if(!sendLock.current)setSubmissionRevision(old=>old+1);return;}
    sendLock.current=true;setSending(true);setNotice(null);
    const submitted={sessionId,owner:ownerKey,text:draftRef.current,attachments:[...attachments],accepted:false};lastSubmitted.current=submitted;
    const epoch=navigationEpoch.current;
    try{
      let target=sessionId;
      if(!target){const next=await window.friendPi.request<AppState>('session.new',{projectId,modelId:selectedModelId,forSend:true,permissionMode});target=next.createdSessionId||next.current?.sessionId;if(!target)throw new Error('会话尚未就绪');submitted.sessionId=target;if(epoch!==navigationEpoch.current)throw new Error('工作区已切换，原草稿已保留');applyState(next);setDraftOwner(target);if(mode!=='single'&&!next.current?.plugins.includes('swarm'))await window.friendPi.request('session.configure',{sessionId:target,plugins:[...new Set([...(next.current?.plugins||plugins),'swarm'])]});if(pendingThinking!=='off')await window.friendPi.request('session.configure',{sessionId:target,thinkingLevel:pendingThinking});}
      if(epoch!==navigationEpoch.current)throw new Error('工作区已切换，原草稿已保留');
      const queued=running||!!state.current?.queue?.items.length||!!state.current?.sideDraft||hasQueueIntent(target,{text:submitted.text,attachments:submitted.attachments,mode,planMode});
      if(!queued){setLocalRunning(true);setTools([]);setLive(null);followScroll.current=true;}
      if(queued){const payload={text:submitted.text,attachments:submitted.attachments,mode,planMode},intent=queueIntent(target,payload);await window.friendPi.request('session.queue',{sessionId:target,action:'add',...payload,intentId:intent.id,fromSideDraft:!!state.current?.sideDraft});acknowledgeQueueIntent(intent);}
      else await window.friendPi.request('session.send',{sessionId:target,text:submitted.text,mode,attachments:submitted.attachments,planMode});submitted.accepted=true;
      try{const remaining={text:draftRef.current===submitted.text?'':draftRef.current,attachments:JSON.stringify(attachmentsRef.current.map(item=>item.path))===JSON.stringify(submitted.attachments.map(item=>item.path))?[]:attachmentsRef.current,planMode,mode,permissionMode,permissionExplicit};localStorage.setItem('friend-pi.draft.v1:'+target,JSON.stringify(remaining));if(submitted.owner!==target)localStorage.removeItem('friend-pi.draft.v1:'+submitted.owner);}catch{}
      if(ownerRef.current===submitted.owner||ownerRef.current===target){if(draftRef.current===submitted.text)setDraft('');setAttachments(old=>JSON.stringify(old.map(item=>item.path))===JSON.stringify(submitted.attachments.map(item=>item.path))?[]:old);setDraftOwner(target);}
    }catch(error){setLocalRunning(false);if(ownerRef.current===submitted.owner||ownerRef.current===submitted.sessionId){if(!draftRef.current)setDraft(submitted.text);setDraftOwner(ownerRef.current);}report(errorText(error),true);}
    finally{sendLock.current=false;setSending(false);setSubmissionRevision(old=>old+1);}
  };
  const selectProject=async(id:string)=>{if(sending||sendLock.current||allocationLock.current||navigating||migratingDraft.current)return;deferredDialogs.current.clear();navigationEpoch.current++;setNavigating(true);try{await invoke('project.select',{projectId:id});restoreDialogs();setSelectedProject(id);setMaterial(undefined);}catch{}finally{setNavigating(false);}};
  const openProject=async(create=false)=>{if(navigating||sending||allocationLock.current||migratingDraft.current||sendLock.current)return;navigationEpoch.current++;setNavigating(true);try{const chosen=asObject(await invoke(create?'project.create':'project.open'));if(chosen.id){await invoke('project.select',{projectId:chosen.id});setSelectedProject(String(chosen.id));setMaterial(undefined);}}catch{}finally{setNavigating(false);}};
  const openSession=async(id:string)=>{if(navigating||sending||allocationLock.current||migratingDraft.current||sendLock.current)return;deferredDialogs.current.clear();navigationEpoch.current++;setNavigating(true);try{await invoke('session.open',{id});restoreDialogs();setMaterial(undefined);}catch{}finally{setNavigating(false);}};
  const traverseSession=async(direction:-1|1)=>{if(navigating||sending||allocationLock.current||migratingDraft.current||sendLock.current)return;deferredDialogs.current.clear();navigationEpoch.current++;setNavigating(true);try{await invoke('navigation.go',{direction});restoreDialogs();setMaterial(undefined);}catch{}finally{setNavigating(false);}};
  useEffect(()=>{if(!requestedSession||navigating||sending||sendLock.current||allocationLock.current)return;const id=requestedSession;setRequestedSession(undefined);deferredDialogs.current.clear();void openSession(id);},[requestedSession,navigating,sending,submissionRevision]);
  useEffect(()=>{const keys=(event:KeyboardEvent)=>{if(document.querySelector(':popover-open')||[...document.querySelectorAll<HTMLElement>('[role="dialog"]')].some(node=>node.getClientRects().length>0))return;if(!event.defaultPrevented&&event.metaKey&&['[',']'].includes(event.key)){event.preventDefault();void traverseSession(event.key==='['?-1:1);}if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='n'){event.preventDefault();void newSession();}if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'){event.preventDefault();setSidebar(true);searchInput.current?.focus();}if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='t'){event.preventDefault();void openNewView();}if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='w'){event.preventDefault();void closeView(sessionView.active);}if(event.ctrlKey&&event.key===String.fromCharCode(96)){event.preventDefault();void showTerminal();}};window.addEventListener('keydown',keys);return()=>window.removeEventListener('keydown',keys);});
  const ensureUiSession=async()=>{
    if(sessionId)return sessionId;if(running||sendLock.current||allocationLock.current||navigating||migratingDraft.current)return;
    allocationLock.current=true;setNavigating(true);migratingDraft.current=true;
    try{const captured={text:draftRef.current,attachments:attachmentsRef.current,planMode,mode,permissionMode,permissionExplicit};const next=await window.friendPi.request<AppState>('session.new',{projectId,modelId:pendingModel||undefined,permissionMode});const id=next.current?.sessionId;if(!id)return;localStorage.setItem('friend-pi.draft.v1:'+id,JSON.stringify(captured));setDraftOwner(id);applyState(next);viewOwner.current=id;viewRef.current=next.current?.ui||initialView();setView(viewRef.current);return id;}catch(error){report(String(error),true);}finally{allocationLock.current=false;migratingDraft.current=false;setNavigating(false);}
  };
  const writeView=async(next:SessionViewState,confirmReload=false)=>{
    const hadSession=!!sessionId;let base=viewRef.current;const id=await ensureUiSession();if(!id)return;if(!hadSession){base=viewRef.current;next={...next,browserScope:base.browserScope};}const version=++uiVersion.current;viewOwner.current=id;viewRef.current=next;setView(next);setSidebar(next.sidebar);if(!uiPending.current)pendingView.current=null;uiPending.current++;
    const work=uiQueue.current.catch(()=>{}).then(()=>window.friendPi.request<SessionViewState>('session.ui.update',{sessionId:id,base,ui:next,confirmReload}));uiQueue.current=work;
    try{const result=await work;if(stateRef.current.current?.sessionId===id&&version===uiVersion.current){viewRef.current=result;setView(result);}return result;}catch(error){report(String(error),true);if(stateRef.current.current?.sessionId===id&&version===uiVersion.current){const saved=await window.friendPi.request<SessionViewState>('session.ui.get',{sessionId:id});if(version===uiVersion.current){viewRef.current=saved;setView(saved);}}throw error;}finally{if(!--uiPending.current){const last=pendingView.current;pendingView.current=null;if(last&&last.id===stateRef.current.current?.sessionId&&last.id===viewOwner.current){viewRef.current=last.ui;setView(last.ui);}}}
  };
  const openToolView=async(page:ToolPage)=>{if(page==='terminal')return showTerminal();await writeView(openTool(viewRef.current,page));};
  const showTerminal=async()=>{
    const next=toggleTerminal(viewRef.current);
    if(next.active==='conversation'){try{await writeView(next);}catch(error){report(errorText(error),true);}return;}
    if(terminalOpening.current)return;terminalOpening.current=true;const epoch=navigationEpoch.current;
    try{
      await writeView(next);
      const id=viewOwner.current;if(!id)return;
      if(stateRef.current.current?.sessionId!==id||epoch!==navigationEpoch.current||!viewRef.current.tabs.some(tab=>tab.id===next.active&&tab.kind==='tool'&&tab.page==='terminal')||stateRef.current.sessions.find(session=>session.id===id)?.archived)return;
      const terminal=await window.friendPi.request<{id:string}>('terminal.open',{sessionId:id});
      if(stateRef.current.current?.sessionId===id&&epoch===navigationEpoch.current)setTerminalTarget({sessionId:id,id:terminal.id});
    }catch(error){report(errorText(error),true);}finally{terminalOpening.current=false;}
  };
  const openNewView=async()=>{await writeView(addNewTab(viewRef.current));};
  const closeView=async(id:string)=>{if(id==='conversation')return;await writeView(closeViewTab(viewRef.current,id));};
  const openWeb=async(url:string)=>{const normalized=browserUrl(url);const current=viewRef.current.tabs.find(t=>t.id===viewRef.current.active),tab=current?.kind==='new'?{id:current.id,kind:'browser' as const,url:normalized,title:'网页'}:{id:crypto.randomUUID(),kind:'browser' as const,url:normalized,title:'网页'};await writeView({...viewRef.current,tabs:current?.kind==='new'?viewRef.current.tabs.map(t=>t.id===current.id?tab:t):[...viewRef.current.tabs,tab],active:tab.id});};
  useEffect(()=>{const id=sessionId;setBrowserSnapshot({tabs:[],downloads:[]});if(!id){viewOwner.current='';setView(initialView());setSidebar(true);return;}viewOwner.current=id;const next=state.current?.ui||initialView();viewRef.current=next;setView(next);setSidebar(next.sidebar);void window.friendPi.request<BrowserSnapshot>('browser.list',{sessionId:id}).then(value=>{if(stateRef.current.current?.sessionId===id)setBrowserSnapshot(value);}).catch(()=>{});},[sessionId]);
  useEffect(()=>{
    const check=()=>setBrowserBlocked([...document.body.querySelectorAll<HTMLElement>('[role="dialog"],[role="menu"],:popover-open,dialog[open]'+(window.innerWidth<=760?',.sidebar':''))].some(node=>node.getClientRects().length>0&&getComputedStyle(node).visibility!=='hidden'));
    const beforeToggle=(event:Event)=>{if((event as ToggleEvent).newState==='open')setBrowserBlocked(true);requestAnimationFrame(check);};
    const observer=new MutationObserver(check);observer.observe(document.body,{subtree:true,attributes:true,childList:true});
    document.addEventListener('beforetoggle',beforeToggle,true);for(const event of ['toggle','close','cancel'])document.addEventListener(event,check,true);window.addEventListener('resize',check);check();
    return()=>{observer.disconnect();document.removeEventListener('beforetoggle',beforeToggle,true);for(const event of ['toggle','close','cancel'])document.removeEventListener(event,check,true);window.removeEventListener('resize',check);};
  },[]);
  const appendAttachments=(files:{path:string;name?:string;hash?:string}[],owner:string)=>{if(ownerRef.current===owner)setAttachments(old=>[...new Map([...old,...files].map(item=>[item.path,item])).values()]);else{let saved:JsonObject={};try{saved=asObject(JSON.parse(localStorage.getItem('friend-pi.draft.v1:'+owner)||'{}'));}catch{}localStorage.setItem('friend-pi.draft.v1:'+owner,JSON.stringify({...saved,attachments:[...new Map([...asList<{path:string}>(saved.attachments),...files].map(item=>[item.path,item])).values()]}));}};
  const addAttachments=()=>{const owner=ownerKey;void window.friendPi.request('file.pick').then(value=>appendAttachments(pickedPaths(value).map(path=>({path})),owner)).catch(error=>report(String(error),true));};
  useEffect(()=>{const open=(event:Event)=>{const detail=(event as CustomEvent<Material>).detail;if(detail.workspaceKey&&detail.workspaceKey!==workspaceKey)return;setMaterial({...detail,workspaceKey});void openToolView('file');};const add=(event:Event)=>{if(sendLock.current){report('消息正在提交，请稍后添加材料');return;}if(activeMemberRef.current){report('请返回主会话后添加材料；成员补充目前仅支持文本');return;}const detail=(event as CustomEvent<{text:string;path?:string;workspaceKey?:string}>).detail;if(detail.workspaceKey&&detail.workspaceKey!==workspaceKey)return;setDraft(old=>old+'\n'+detail.text);if(detail.path)appendAttachments([{path:detail.path}],ownerKey);};window.addEventListener('friend-pi:file-open',open);window.addEventListener('friend-pi:add-material',add);return()=>{window.removeEventListener('friend-pi:file-open',open);window.removeEventListener('friend-pi:add-material',add);};},[workspaceKey,ownerKey]);
  useEffect(()=>{const open=(event:Event)=>{const target=(event as CustomEvent<ChangeReviewTarget>).detail;if(target.sessionId!==sessionId)return;setChangeReview(target);void openToolView('diff');};window.addEventListener('friend-pi:changes-review',open);return()=>window.removeEventListener('friend-pi:changes-review',open);},[sessionId]);
  const composerAction=async(action:ComposerAction)=>{
    if(activeMemberRef.current)return;
    if(action.sessionId!==(sessionId||'')||action.epoch!==navigationEpoch.current)return;
    if(sendLock.current&&['draft','send','attach','removeAttachment','files','reference'].includes(action.type))return;
    if(action.type==='draft'){draftRef.current=String(action.value||'');setDraft(draftRef.current);}
    else if(action.type==='queueUi')setQueueUi(asObject(action.value));
    else if(action.type==='queue'){const requestOwner=sessionId,requestEpoch=navigationEpoch.current;const input=asObject(action.value);const result=await window.friendPi.request('session.queue',{sessionId,...input});if(requestOwner!==stateRef.current.current?.sessionId||requestEpoch!==navigationEpoch.current)return;if(input.action==='sidechat')setRequestedSession(String(asObject(result).sessionId));setQueueUi(old=>({editing:old.editing}));}
    else if(action.type==='send'){if(typeof action.text==='string'){draftRef.current=action.text;setDraft(action.text);}await send();}
    else if(action.type==='attach')addAttachments();
    else if(action.type==='files'){const owner=ownerKey;const files=await window.friendPi.request<{path:string;name:string}[]>('attachment.import',{sessionId,files:action.value});appendAttachments(files,owner);}
    else if(action.type==='reference'){const candidate=asObject(action.value);if(candidate.kind==='文件'&&typeof candidate.path==='string')appendAttachments([{path:candidate.path}],ownerKey);}
    else if(action.type==='attachmentChecked'){const item=asObject(action.value);setAttachments(old=>old.map(attachment=>attachment.path===item.path?{...attachment,hash:String(item.hash)}:attachment));}
    else if(action.type==='removeAttachment')setAttachments(old=>old.filter(a=>a.path!==action.value));
    else if(action.type==='plan'&&!running&&!sending)setPlanMode(action.value===true);
    else if((action.type==='mode'||action.type==='permission')&&!running&&!sending&&!navigating&&!activeSession?.archived){
      const owner=ownerKey,epoch=navigationEpoch.current;
      const input=action.type==='permission'?{permissionMode:action.value}:{executionMode:action.value};
      if(sessionId&&action.type==='mode'&&action.value!=='single'&&!currentPlugins.includes('swarm'))await window.friendPi.request('session.configure',{sessionId,plugins:[...currentPlugins,'swarm']});
      const result=sessionId?await window.friendPi.request<AppState>('session.configure',{sessionId,...input}):undefined;
      if(ownerRef.current!==owner||navigationEpoch.current!==epoch)return;
      if(result)applyState(result);
      if(action.type==='permission'){setPermissionMode(result?.current?.permissionMode||action.value as PermissionMode);permissionExplicitRef.current=true;setPermissionExplicit(true);}
      else setMode(result?.current?.executionMode||action.value as typeof mode);
    }
    else if(action.type==='model'&&!running&&!sending&&!navigating&&!activeSession?.archived){const input=asObject(action.value),owner=ownerKey,epoch=navigationEpoch.current;if(sessionId){const result=await window.friendPi.request<AppState>('session.configure',{sessionId,...input});if(ownerRef.current===owner&&navigationEpoch.current===epoch)applyState(result);}else{if(input.modelId){setPendingModel(String(input.modelId));setPendingThinking(state.models.find(m=>m.id===input.modelId)?.thinkingLevels?.[0]||'off');}if(input.thinkingLevel)setPendingThinking(String(input.thinkingLevel));}}
    else if(action.type==='settings')openModelSettings();
    else if(action.type==='stop'){const owner=sessionId;await invoke('session.stop',{sessionId});if(stateRef.current.current?.sessionId===owner){setLocalRunning(false);setSwarmRunning(false);setDialogs([]);}}
    else if(action.type==='conversation')await writeView({...viewRef.current,active:'conversation'});
    else if(action.type==='collapse')await writeView({...viewRef.current,composerCollapsed:action.value===true});
  };
  useEffect(()=>{setMemberRoute(null);},[sessionId]);
  useEffect(()=>{const open=(event:Event)=>{const target=(event as CustomEvent<{rootSessionId:string;memberId:string}>).detail;if(target.rootSessionId!==sessionId)return;navigationEpoch.current++;if(!activeMemberRef.current)rootScrollBeforeMember.current={top:scroll.current?.scrollTop||0,following:followScroll.current};setMemberRoute(target);if(viewRef.current.active!=='conversation')void writeView({...viewRef.current,active:'conversation'});};window.addEventListener('friend-pi:teammate-open',open);return()=>window.removeEventListener('friend-pi:teammate-open',open);},[sessionId]);
  const returnToRoot=()=>{navigationEpoch.current++;followScroll.current=rootScrollBeforeMember.current.following;setMemberRoute(null);requestAnimationFrame(()=>{if(scroll.current)scroll.current.scrollTop=rootScrollBeforeMember.current.following?scroll.current.scrollHeight:rootScrollBeforeMember.current.top;composer.current?.focus({preventScroll:true});});};
  const composerSnapshot:ComposerSnapshot={queue:state.current?.queue,queueUi,monitor:navigating||activeMember?undefined:state.current?.monitor,sessionId:sessionId||'',epoch:navigationEpoch.current,draft,attachments,running,sending,submissionRevision,navigating,archived:!!activeSession?.archived,planMode,permissionMode,permissionExplicit,mode,plugins:currentPlugins,models:state.models,providerNames:Object.fromEntries(state.providers.map(provider=>[provider.id,provider.name])),modelId:selectedModelId,thinkingLevel:state.current?.thinkingLevel||pendingThinking,thinkingLevels:selectedModel?.thinkingLevels||['off'],ready:!!selectedModel?.ready,floating:false,collapsed:false,status:state.current?.plan&&asObject(state.current.plan).status==='proposed'?'计划等待审批':running?'正在执行':messages.length?'查看会话与新回复':'继续当前会话',notice:notice?.message};
  useEffect(()=>window.friendPi.onEvent(event=>{if(event.sessionId!==stateRef.current.current?.sessionId)return;if(String(event.type)==='browser.shortcut'){const key=String(asObject(event.data).key);if(key==='t')void openNewView();else if(key==='w')void closeView(viewRef.current.active);else if(key==='n')void newSession();else if(key==='k'){setSidebar(true);searchInput.current?.focus();}else if(key==='l')document.querySelector<HTMLInputElement>('[aria-label="网页地址"]')?.focus();}}));
  const sidebarWidth=Math.max(180,Math.min(layout.sidebarWidth,400));
  const activeNotice=notice&&<div className={'notice '+(notice.error?'error':'')} style={{flexShrink:0,WebkitAppRegion:'no-drag'} as React.CSSProperties} role={notice.error?'alert':'status'}><span>{notice.message}</span><button aria-label="关闭提示" onClick={()=>setNotice(null)}>×</button></div>;
  return <div className={'app friend-layout session-fullscreen '+(sidebar?'':'sidebar-hidden ')+(toolActive?'full-tool-active ':'')} style={{'--sidebar-width':sidebarWidth+'px'} as React.CSSProperties}>
    <header className="topbar project-topbar"><nav className="session-navigation" aria-label="会话导航"><button aria-label="后退到上一个会话" title="后退 · ⌘[" disabled={navigating||sending||!state.navigation?.back} onClick={()=>void traverseSession(-1)}><Icon name="back" size={17}/></button><button aria-label="前进到下一个会话" title="前进 · ⌘]" disabled={navigating||sending||!state.navigation?.forward} onClick={()=>void traverseSession(1)}><Icon name="forward" size={17}/></button><button aria-label={sidebar?'收起会话侧栏':'展开会话侧栏'} aria-pressed={sidebar} onClick={()=>{const next=!sidebar;setSidebar(next);if(sessionId)void writeView({...viewRef.current,sidebar:next});}}><Icon name="sidebar" size={17}/></button></nav><div className="workspace-tabs-bar"><SessionTabs view={sessionView} onSelect={id=>{if(id==='conversation')restoreDialogs();void writeView({...viewRef.current,active:id});}} onClose={id=>void closeView(id)} onNew={()=>void openNewView()}/>
      <div className="module-controls" role="toolbar" aria-label="界面模块"><button aria-label={activeViewTab?.page==='trace'?'关闭轨迹并返回会话':'打开轨迹'} title={activeViewTab?.page==='trace'?'返回会话':'轨迹'} aria-pressed={toolActive&&activeViewTab?.page==='trace'} onClick={()=>void writeView(toggleTrace(viewRef.current))}><Icon name="trace" size={18}/></button><button aria-label={activeViewTab?.page==='terminal'?'关闭终端并返回会话':'打开终端'} title={activeViewTab?.page==='terminal'?'返回会话':'终端'} aria-pressed={toolActive&&activeViewTab?.page==='terminal'} onClick={()=>void showTerminal()}><Icon name="terminal" size={18}/></button></div></div>
    </header>
    <aside className="sidebar" aria-label="项目与会话">
      <div className="sidebar-new"><button className="new-chat" disabled={navigating||sending} onClick={()=>void newSession()}><Icon name="plus"/>新建会话<kbd>⌘N</kbd></button><button className="new-project-button" aria-label="打开项目" title="打开项目" disabled={navigating||sending} onClick={()=>void openProject()}><Icon name="folder" size={19}/></button></div>
      <label className="session-search"><Icon name="search"/><input ref={searchInput} aria-label="搜索项目与会话" placeholder="搜索项目与会话…" value={sessionSearch} onChange={event=>setSessionSearch(event.target.value)}/></label>
      <ProjectSidebar projects={state.projects} sessionOrder={state.sessionOrder} sessions={sidebarSessions(state.sessions,state.activities||[])} selectedProject={projectId||''} selectedSession={sessionId} query={sessionSearch} archived={historyOpen} disabled={navigating||sending} onProject={id=>void selectProject(id)} onSession={id=>void openSession(id)} onNewSession={id=>void newSession(id)} onToggleArchive={()=>setHistoryOpen(v=>!v)} onMenu={(item,position,moves)=>setMenu({...item,...position,moves})} onReorder={ids=>invoke('project.reorder',{ids})} onReorderSessions={(projectId,ids)=>invoke('session.reorder',{projectId,ids})}/>
      <button className="sidebar-settings" aria-label="设置" onClick={()=>setSettingsOpen(true)}><Icon name="settings"/>设置</button>
    </aside>
    {sidebar&&<ResizeHandle className="sidebar-resize" name="调整会话侧栏宽度" value={sidebarWidth} min={180} max={400} onChange={value=>setLayout(old=>({...old,sidebarWidth:value}))}/>}
    <main className="main"><header className="conversation-heading"><div className="conversation-title"><h2>{activeSession?.name||project?.name||'临时会话'}</h2><p><Icon name="folder"/><span>{workspaceKey||'无需选择项目即可开始'}</span></p></div><div className="heading-actions">{sessionId&&mode==='swarm'&&currentPlugins.includes('swarm')&&<TeammateRoster key={'teammates:'+sessionId} rootSessionId={sessionId} compact selectedMemberId={activeMember||undefined} onBack={returnToRoot}/>}<SessionStats key={'stats:'+sessionId} stats={toolActive?undefined:composerSnapshot.monitor} contextTarget={contextStatsTarget}/></div></header>
      {!toolActive&&activeNotice}
      {activeSession?.archived&&<div className="notice">当前为归档会话，只读查看。<button onClick={()=>void invoke('session.archive',{id:sessionId,archived:false}).catch(()=>{})}>恢复并继续</button></div>}
      <div hidden={!!activeMember} className="conversation-stage" role="tabpanel" id="conversation-panel" aria-labelledby="session-tab-conversation"><TurnIndex messages={messages} container={scroll} sessionId={sessionId} onLocate={()=>{followScroll.current=false;}}/>{(!!messages.length||!!live)&&<><div className="conversation-drag-margin left" aria-hidden="true"/><div className="conversation-drag-margin right" aria-hidden="true"/></>}<div className={'conversation'+(!messages.length&&!live?' conversation-empty':'')} ref={scroll} onScroll={event=>{const e=event.currentTarget;followScroll.current=e.scrollHeight-e.scrollTop-e.clientHeight<100;}}>
        {booting?<Empty title="正在打开工作空间…"/>:!messages.length&&!live?<div className="welcome"><div className="welcome-mark">F<span>·</span></div><h1>从一个小任务开始</h1><p>{project?'和 Friend 一起完成这个项目。':'直接聊天、处理附件或在独立临时工作区开始任务。'}</p><div className="welcome-suggestions">{['先阅读项目，告诉我整体架构','帮我实现一个小改动，并验证结果','找回这个项目的约束与关键决定'].map(text=><button key={text} onClick={()=>{setDraft(text);composer.current?.focus();}}>{text}<span>↗</span></button>)}</div></div>:<Conversation receipts={asList<JsonObject>(state.current?.receipts)} key={sessionId} readingKey={sessionId} workspacePath={state.current?.workspacePath} sessionId={sessionId} changeCache={changeCache.current} messages={messages} live={live} tools={tools} running={running} changes={(state.current?.changes||[]).filter(summary=>!running||summary.runId!==state.current?.runId)}/>}
        {state.current?.plan&&asObject(state.current.plan).status==='proposed'&&<div className="messages plan-tail"><PlanPreview body={String(asObject(state.current.plan).body||'')} disabled={running||sending||navigating||!!activeSession?.archived} canApprove={!!selectedModel?.ready}
          onRead={()=>{setMaterial({workspaceKey,title:'计划全文',text:String(asObject(state.current!.plan).body)});void openToolView('file');}}
          onApprove={()=>void invoke('plan.approve',{...asObject(state.current!.plan),sessionId}).then(()=>{if(stateRef.current.current?.sessionId===sessionId)setPlanMode(false);}).catch(()=>{})}
          onRevise={()=>{setDraft('请修改上述计划：');composer.current?.focus();}}
          onReject={()=>void invoke('plan.reject',{...asObject(state.current!.plan),sessionId}).then(()=>{if(stateRef.current.current?.sessionId===sessionId)setPlanMode(false);}).catch(()=>{})}/></div>}
        {batchDialog&&<div className="messages"><BatchQuestionCard key={batchDialog.generation+batchDialog.id} dialog={batchDialog} drafts={questionDrafts.current} respond={async value=>{try{await window.friendPi.request('dialog.respond',value);}catch(error){const receipt=await window.friendPi.request<{status:string}>('dialog.status',{id:batchDialog.id}).catch(()=>undefined);if(receipt?.status!=='settled')throw error;}setDialogs(old=>old.filter(dialog=>dialog.id!==batchDialog.id));await refresh();}}/></div>}
        </div></div>
      {!toolActive&&activeMember&&sessionId&&<TeammateConversation key={sessionId+activeMember} rootSessionId={sessionId} memberId={activeMember} onBack={returnToRoot} report={report} archived={!!activeSession?.archived}/>}
      {!toolActive&&<div hidden={!!activeMember} className="composer-host"><SessionComposer key={ownerKey} value={composerSnapshot} action={composerAction} inputRef={composer} contextRef={setContextStatsTarget}/></div>}
    </main>
    {sessionView.tabs.length>0&&<aside className="workspace fullscreen-workspace" aria-label="工作空间" hidden={!toolActive}>
      {toolActive&&activeViewTab?.page!=='terminal'&&activeNotice}
      {toolActive&&activeViewTab?.kind==='new'&&<NewTabPage onTool={page=>void openToolView(page)} onNavigate={openWeb}/>}<div className="workbench-content-host" hidden={toolActive&&(activeViewTab?.kind==='new'||activeViewTab?.page==='terminal'||activeViewTab?.page==='trace')}><Workbench key={sessionId||workspaceKey||'pending'} state={state} projectId={projectId||undefined} workspace={workspace} workspaceKey={workspaceKey} fileCache={fileCache.current} page={browserTab?'browser':activeViewTab?.kind==='tool'&&activeViewTab.page!=='trace'?activeViewTab.page as WorkbenchPage:'file'} onSettings={page=>{if(page)setSettingsPage(page);setSettingsOpen(true);}} changeReview={changeReview} changeCache={changeCache.current} onClearReview={()=>setChangeReview(undefined)} material={material} report={report}
        browser={browserTab&&sessionId?<BrowserPane sessionId={sessionId} tab={browserTab} snapshot={browserSnapshot} blocked={browserBlocked} ready={uiQueue.current} report={report}/>:<NewTabPage onTool={page=>void openToolView(page)} onNavigate={openWeb}/>}/></div>{toolActive&&activeViewTab?.page==='trace'&&<section className="trajectory-workspace" role="tabpanel" aria-labelledby={'session-tab-'+activeViewTab.id}><Trajectory key={sessionId||'new'} messages={messages} live={live} tools={tools} running={running} systems={state.current?.traceSystems}/></section>}</aside>}
    {sessionId&&<TerminalPanel key={sessionId} sessionId={sessionId} open={toolActive&&activeViewTab?.page==='terminal'} version={terminalVersion} target={terminalTarget?.sessionId===sessionId?terminalTarget:undefined} report={report} notice={toolActive&&activeViewTab?.page==='terminal'&&notice?<TerminalNotice {...notice} onClose={()=>setNotice(null)}/>:undefined}/>}
    {settingsOpen&&<Modal title="Friend 设置" className="application-settings" closeDisabled={settingsBusy} wide onClose={()=>{if(!settingsBusy)setSettingsOpen(false);}}><SettingsPanel state={state} onBusy={setSettingsBusy} page={settingsPage} setPage={setSettingsPage} onClose={()=>setSettingsOpen(false)} projectId={projectId||undefined} report={report} refresh={refresh}/></Modal>}
    {menu&&<div className="session-menu" role="menu" style={{left:Math.min(menu.x,window.innerWidth-170),top:menu.y}}>{menu.id===sessionId&&<><label className="session-browser-scope">浏览器登录范围<select aria-label="当前会话浏览器登录范围" value={sessionView.browserScope} onChange={e=>{const scope=e.target.value as BrowserScope;if(browserTabs.length&&!window.confirm('更改登录范围将重新加载此会话的网页，未提交的网页表单会丢失。继续？'))return;void writeView({...viewRef.current,browserScope:scope},true);setMenu(null);}}>{Object.entries(browserScopeNames).map(([id,label])=><option value={id} key={id}>{label}</option>)}</select></label></>}<button role="menuitem" disabled={!menu.moves?.up} onClick={()=>{menu.moves?.up?.();setMenu(null);}}>上移会话</button><button role="menuitem" disabled={!menu.moves?.down} onClick={()=>{menu.moves?.down?.();setMenu(null);}}>下移会话</button><button role="menuitem" onClick={()=>{setRename({id:menu.id,name:menu.name});setMenu(null);}}>重命名</button><button role="menuitem" onClick={()=>{void invoke('session.relocate',{id:menu.id}).catch(()=>{});setMenu(null);}}>重新定位原始历史</button><button role="menuitem" onClick={()=>{void invoke('session.archive',{id:menu.id,archived:!menu.archived}).catch(()=>{});setMenu(null);}}>{menu.archived?'恢复':'归档'}</button><button role="menuitem" onClick={()=>{void window.friendPi.request('session.delete.preview',{id:menu.id}).then(raw=>setDeleting(asObject(raw))).catch(error=>report(String(error),true));setMenu(null);}}>删除</button><button onClick={()=>setMenu(null)}>关闭菜单</button></div>}
    {deleting&&<Modal title="删除会话" onClose={()=>setDeleting(null)}><p>永久删除“{String(deleting.name)}”的会话历史及独占插件记录；工作文件保留。</p><div className="button-row"><button onClick={()=>setDeleting(null)}>取消</button><button className="primary" onClick={()=>void invoke('session.delete',{id:deleting.id,token:deleting.token}).then(()=>setDeleting(null)).catch(()=>{})}>确认删除</button></div></Modal>}
    {modalDialog&&<PiDialog key={modalDialog.id} dialog={modalDialog} defer={()=>{deferredDialogs.current.add(modalDialog.id);setDialogs(old=>old.filter(dialog=>dialog.id!==modalDialog.id));}} respond={value=>{const id=modalDialog.id;void window.friendPi.request('dialog.respond',{id,...value}).then(()=>setDialogs(old=>old.filter(d=>d.id!==id))).catch(error=>{report(String(error),true);setDialogs(old=>old.filter(d=>d.id!==id));});}}/>}
    {rename&&<Modal title="重命名会话" onClose={()=>setRename(null)}><form onSubmit={event=>{event.preventDefault();void invoke('session.rename',rename).then(()=>setRename(null)).catch(()=>{});}}><Field label="会话名称"><input value={rename.name} onChange={event=>setRename({...rename,name:event.target.value})}/></Field><button className="primary" disabled={!rename.name.trim()}>保存名称</button></form></Modal>}
  </div>;
}
