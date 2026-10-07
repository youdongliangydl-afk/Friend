import { randomUUID } from 'node:crypto';
import { mkdirSync,existsSync,readFileSync,realpathSync } from 'node:fs';
import { join,resolve,relative,extname } from 'node:path';
import { createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,ModelRuntime,createEventBus,initTheme,type AgentSession,type ExtensionUIContext,type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { dataDirectory,object,text,visibleText,historyItems,requestPlugin,atomicWrite,installFixtureProvider } from '@friend-pi/core';
import type { ImageContent } from '@earendil-works/pi-ai';
import { createProviderRuntime,providerMetadata,saveProviderConfiguration } from './provider-settings.js';

const dataDir=dataDirectory();const root=resolve(process.env.FRIEND_PI_ROOT || process.cwd());const cwd=resolve(process.env.FRIEND_PI_PROJECT || process.cwd());
const agentDir=join(dataDir,'pi');mkdirSync(agentDir,{recursive:true,mode:0o700});
// Advertise the actual SDK directory before loading native plugins. Their public
// ExtensionContext has no SDK agentDir field, and inherited shell Pi paths may differ.
process.env.FRIEND_PI_AGENT_DIR=agentDir;
const plugins=['swarm','expert','memory','topic-rebuild'];
let enabled=process.env.FRIEND_PI_PLUGINS?JSON.parse(process.env.FRIEND_PI_PLUGINS) as string[]:plugins;
let session:AgentSession;let runtime:ModelRuntime;const bus=createEventBus();let runId:string|undefined;let disposed=false;let swarmRunning=false;let planMode=process.env.FRIEND_PI_PLAN_MODE==='1';let executionMode=process.env.FRIEND_PI_MODE==='swarm'?'swarm':'single';let lifecycleStatus=process.env.FRIEND_PI_STATUS||'idle';let cancelRequested=false;const activeGraphIds=new Set<string>();const runGraphIds=new Set<string>();const baselineGraphIds=new Set<string>();const pendingSwarmGraphIds=new Set<string>();const swarmGraphs=new Map<string,Record<string,unknown>>();let runStartedAt=0;let foregroundOpen=false;let authorityNotice='';let statusBeforeCompaction:string|undefined;let settledRunId:string|undefined;
const dialogs=new Map<string,{resolve:(value:unknown)=>void;timer:ReturnType<typeof setTimeout>}>();
function output(message:unknown){if(process.connected)process.send?.(message);}
function publish(type:string,data:unknown){output({type:'event',event:{type,sessionId:session?.sessionId,runId,data}});}
function dialog(kind:string,title:string,input:Record<string,unknown>={},timeout=60000):Promise<unknown>{
  const id=randomUUID();return new Promise(resolveResult=>{const timer=setTimeout(()=>{dialogs.delete(id);resolveResult(undefined);publish('dialog.closed',{id});},timeout);dialogs.set(id,{resolve:resolveResult,timer});publish('dialog',{id,kind,title,...input});});
}
const busyGraphStatuses=new Set(['running','awaiting_review','ready']);
const swarmExecutionActions=new Set(['start','resume','prepare','review','integrate']);
function swarmBusy(){return swarmRunning||pendingSwarmGraphIds.size>0;}
function current(){return {sessionId:session.sessionId,messages:historyItems(session.sessionManager.getBranch()).filter(item=>item.type==='message'&&item.role!=='system'&&item.text.trim()).map(item=>({id:item.id,role:item.role,text:item.text})),lifecycleStatus,isRunning:!session.isIdle||swarmBusy(),planMode,executionMode,modelId:session.model?`${session.model.provider}/${session.model.id}`:undefined,thinkingLevel:session.thinkingLevel,plugins:enabled,context:session.getContextUsage(),sessionFile:session.sessionFile,runId};}
function swarmAuthority():{status:string;message?:string}|undefined {
  const required=executionMode==='swarm'&&!planMode&&!!runId;
  const ids=new Set([...activeGraphIds,...(required?runGraphIds:[])]);
  const graphs=[...ids].map(id=>swarmGraphs.get(id));
  if(swarmBusy())return {status:graphs.some(graph=>graph?.status==='awaiting_review')?'awaiting_review':'running'};
  if(!ids.size)return required?{status:'failed',message:'Swarm 本轮没有实际任务图和成员执行，不能认定协作已完成。请检查工具过程后显式继续。'}:undefined;
  if(graphs.some(graph=>!graph))return {status:'failed',message:'Swarm 本轮任务图记录缺失，无法确认成果已整合。'};
  if(graphs.some(graph=>graph!.status==='failed'))return {status:'failed',message:'Swarm 本轮存在失败任务图；成果尚未全部整合，请查看任务图。'};
  if(graphs.some(graph=>graph!.status==='paused'))return {status:graphs.some(graph=>Array.isArray(graph!.tasks)&&graph!.tasks.some(task=>object(task).status==='unknown'))?'interrupted':'paused',message:'Swarm 本轮任务图已暂停；请检查保留成果和工具副作用后显式接续。'};
  if(graphs.some(graph=>graph!.status==='stopped'))return {status:'stopped'};
  if(graphs.every(graph=>graph!.status==='integrated'))return {status:'completed'};
  return {status:'failed',message:'Swarm 本轮任务图尚未启动或完成整合，不能认定协作已完成。请查看任务图并显式启动或接续。'};
}
function publishAuthorityNotice(authority=swarmAuthority()){
  if(!authority?.message)return;
  const fingerprint=JSON.stringify([runId,authority.status,authority.message,[...runGraphIds,...activeGraphIds].map(id=>[id,swarmGraphs.get(id)?.status])]);
  if(fingerprint===authorityNotice)return;authorityNotice=fingerprint;
  publish('notice',{level:authority.status==='failed'?'error':'warning',message:authority.message});
}
function settledStatus(){
  const last=[...session.messages].reverse().find(message=>message.role==='assistant');
  return cancelRequested?'stopped':swarmAuthority()?.status|| (last?.stopReason==='error'?'failed':last?.stopReason==='aborted'?'stopped':'completed');
}
function modelState(){return providerMetadata(runtime);}
function selectedModel(id:string){const slash=id.indexOf('/');const model=runtime.getModel(id.slice(0,slash),id.slice(slash+1));if(slash<1||!model)throw new Error('型号不可用，请重新选择');return model;}
function guard():ExtensionFactory{return pi=>{
  pi.on('before_agent_start',event=>{
    const instructions=planMode?'当前是计划模式。只读取项目与历史，给出目标、步骤、依赖和验证方式；不要修改文件、运行 shell 或启动协作成员。用户明确切换执行后再实施。':executionMode==='swarm'?'请用 friend_swarm create/start 工具自主拆分并执行以下目标，跟踪任务并独立复核；不要只给方案。':'';
    return instructions?{systemPrompt:`${event.systemPrompt}\n\n${instructions}`}:undefined;
  });
  pi.on('tool_call',async(event,ctx)=>{
    const input=object(event.input);
    if(planMode){
      const readActions=new Set(['snapshot','search','read','get','versions','history.search','history.read','history.around']);
      if(event.toolName!=='read'&&!(event.toolName.startsWith('friend_')&&readActions.has(String(input.action))))return {block:true,reason:'计划模式只允许读取和历史回查；切换到执行模式后再修改文件或启动成员。'};
    }
    if(event.toolName==='bash'&&typeof input.command==='string'&&/(?:^|[;&|\s])(?:sudo|rm|rmdir|dd|mkfs|shutdown|reboot)(?:\s|$)|\bgit\s+(?:reset\s+--hard|clean\b|push\b|branch\s+-[dD])|\b(?:npm|pnpm|yarn)\s+publish\b/i.test(input.command)){
      if(!await ctx.ui.confirm('确认关键操作',input.command))return {block:true,reason:'用户未批准该操作'};
    }
  });
};}
async function bind(){
  const base=session.extensionRunner.getUIContext();
  const ui:ExtensionUIContext={...base,
    select:async(title,options,opts)=>await dialog('select',title,{options},opts?.timeout) as string|undefined,
    confirm:async(title,message,opts)=>Boolean(await dialog('confirm',title,{message},opts?.timeout)),
    input:async(title,placeholder,opts)=>await dialog('input',title,{placeholder},opts?.timeout) as string|undefined,
    editor:async(title,prefill)=>await dialog('editor',title,{prefill}) as string|undefined,
    notify:(message,level)=>publish('notice',{message,level}),
    setStatus:(key,value)=>publish('notice',{message:value||'',key}),
    setWorkingMessage:message=>publish('notice',{message}),
    custom:async()=>{throw new Error('终端专属界面不能在桌面客户端显示');},
  };
  await session.bindExtensions({uiContext:ui,mode:'rpc',abortHandler:()=>void session.abort(),shutdownHandler:()=>void shutdown(),onError:error=>publish('notice',{level:'error',message:error.error})});
}
async function initialize(){
  initTheme('light',false);
  runtime=await createProviderRuntime(dataDir);
  let model=process.env.FRIEND_PI_TEST_PROVIDER==='1'?await installFixtureProvider(runtime):undefined;
  if(process.env.FRIEND_PI_MODEL)model=selectedModel(process.env.FRIEND_PI_MODEL);
  if(!model)model=(await runtime.getAvailable())[0]||runtime.getModels().find(item=>item.provider==='deepseek')||runtime.getModels()[0];
  const settings=SettingsManager.inMemory({extensions:enabled.map(name=>join(root,'packages',name,'dist','index.js')),packages:[],defaultTools:['read','bash','edit','write'],compaction:{enabled:true,...(process.env.FRIEND_PI_TEST_PROVIDER==='1'?{keepRecentTokens:512,reserveTokens:2048}:{})}});
  const loader=new DefaultResourceLoader({cwd,agentDir,settingsManager:settings,noExtensions:false,noSkills:false,noPromptTemplates:false,noThemes:true,eventBus:bus,extensionFactories:[guard()]});
  await loader.reload({resolveProjectTrust:async()=>true});
  const manager=process.env.FRIEND_PI_SESSION_FILE?SessionManager.open(process.env.FRIEND_PI_SESSION_FILE):SessionManager.create(cwd,join(dataDir,'sessions'));
  const created=await createAgentSession({cwd,agentDir,modelRuntime:runtime,model,resourceLoader:loader,settingsManager:settings,sessionManager:manager});session=created.session;
  if(created.extensionsResult.errors.length)throw new Error(created.extensionsResult.errors.map(error=>error.error).join('; '));
  session.subscribe(event=>{
    publish('pi',event);
    if(event.type==='agent_settled'&&!disposed){
      settledRunId=runId;lifecycleStatus=settledStatus();
      foregroundOpen=swarmBusy();
      if(swarmAuthority()?.message)publishAuthorityNotice();
      else if(lifecycleStatus==='failed'){
        const last=[...session.messages].reverse().find(message=>message.role==='assistant');
        publish('notice',{level:'error',message:publicError(last?.errorMessage||'模型执行未完成')});
      }
    }
    if(event.type==='compaction_start'&&event.reason==='manual'){
      statusBeforeCompaction=lifecycleStatus;lifecycleStatus='rebuilding';
    }
    if(event.type==='compaction_end'&&statusBeforeCompaction){
      // Pi may execute deferred compaction after its public agent_settled event.
      // Never restore a captured "running" status over that completed run.
      lifecycleStatus=runId&&settledRunId===runId?settledStatus():statusBeforeCompaction;
      statusBeforeCompaction=undefined;
    }
    if(['message_end','agent_settled','compaction_start','compaction_end'].includes(event.type))publish('state',current());
  });
  bus.on('friend-pi:v1:event',raw=>{
    publish('plugin',raw);
    if(!raw||typeof raw!=='object')return;
    const event=object(raw);
    if(event.pluginEvent!=='swarm.changed'||!event.data||typeof event.data!=='object')return;
    const snapshot=object(event.data);
    const graphs=Array.isArray(snapshot.graphs)?snapshot.graphs.map(object):[];
    for(const graph of graphs){
      const id=String(graph.id);swarmGraphs.set(id,graph);
      // A snapshot is not evidence of execution. Relate new graphs to the open
      // foreground run, and old graphs only to an actual execution transition.
      if(foregroundOpen&&!baselineGraphIds.has(id)&&Date.parse(String(graph.createdAt))>=runStartedAt)runGraphIds.add(id);
      if(busyGraphStatuses.has(String(graph.status))&&(activeGraphIds.has(id)||pendingSwarmGraphIds.has(id)||foregroundOpen&&Date.parse(String(graph.updatedAt))>=runStartedAt))activeGraphIds.add(id);
    }
    swarmRunning=[...activeGraphIds].some(id=>busyGraphStatuses.has(String(swarmGraphs.get(id)?.status)));
    if(!disposed){
      const authority=swarmAuthority();
      if(swarmBusy())lifecycleStatus=authority?.status||'running';
      else if(!session.isStreaming&&activeGraphIds.size){lifecycleStatus=authority?.status||lifecycleStatus;foregroundOpen=false;publishAuthorityNotice(authority);}
    }
    publish('state',current());
  });
  await bind();output({type:'ready',state:current(),...modelState(),piSource:JSON.parse(readFileSync(join(root,'pi-source.lock.json'),'utf8')).commit});
}
function readAttachment(path:string):{text?:string;image?:ImageContent}{
  const absolute=realpathSync(path);const bytes=readFileSync(absolute);if(bytes.length>10*1024*1024)throw new Error('附件超过 10 MiB，请缩小后再发送');
  const extension=extname(absolute).toLowerCase();const mime:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'};
  if(mime[extension]){if(!session.model?.input.includes('image'))throw new Error('当前型号不支持图片');return {image:{type:'image',data:bytes.toString('base64'),mimeType:mime[extension]}};}
  if(bytes.includes(0))throw new Error('附件不是可读取的文本或图片');return {text:`\n附件 ${absolute}：\n${bytes.toString('utf8')}`};
}
async function handle(method:string,input:Record<string,unknown>):Promise<unknown>{
  if(method==='state')return {...current(),...modelState()};
  if(method==='send'){
    const prompt=text(input.text,'消息');const attachments=Array.isArray(input.attachments)?input.attachments.map(raw=>readAttachment(text(object(raw).path))):[];
    const combined=prompt+attachments.map(item=>item.text||'').join('');if(Buffer.byteLength(combined)>128*1024)throw new Error('消息与文本附件过大，请分批发送');
    if(!session.model||!runtime.hasConfiguredAuth(session.model.provider))throw new Error('请先在模型设置配置供应商');
    const mode=input.mode==='swarm'?'swarm':'single';if(mode==='swarm'&&!enabled.includes('swarm'))throw new Error('Swarm 插件已关闭');
    const nextPlan=input.planMode===true;
    if((!session.isIdle||swarmBusy())&&(nextPlan!==planMode||mode!==executionMode))throw new Error('请先停止当前执行，再切换计划或协作方式');
    if(session.isIdle&&!swarmBusy()){
      // Capture IDs before opening the run, so historical/manual unstarted graphs
      // cannot satisfy (or invalidate) this run's completion authority.
      const snapshot=enabled.includes('swarm')?object(await requestPlugin(bus,'swarm','snapshot',{},1000)):{};
      baselineGraphIds.clear();for(const graph of Array.isArray(snapshot.graphs)?snapshot.graphs:[])baselineGraphIds.add(String(object(graph).id));
      planMode=nextPlan;executionMode=mode;runId=randomUUID();runStartedAt=Date.now();foregroundOpen=true;
      activeGraphIds.clear();runGraphIds.clear();cancelRequested=false;authorityNotice='';
    }
    lifecycleStatus='running';
    void session.prompt(combined,{images:attachments.flatMap(item=>item.image?[item.image]:[]),streamingBehavior:input.inputMode==='steer'?'steer':'followUp'}).then(()=>publish('state',current())).catch(error=>{foregroundOpen=swarmBusy();lifecycleStatus='failed';publish('notice',{level:'error',message:publicError(error)});publish('state',current());});
    return {accepted:true,sessionId:session.sessionId,runId};
  }
  if(method==='stop'){
    if(!session.isIdle||swarmBusy()){cancelRequested=true;lifecycleStatus='stopped';}
    for(const [id,pending] of dialogs){clearTimeout(pending.timer);pending.resolve(undefined);publish('dialog.closed',{id});}dialogs.clear();
    if(enabled.includes('swarm')){const snapshot=object(await requestPlugin(bus,'swarm','snapshot',{},1000));for(const raw of Array.isArray(snapshot.graphs)?snapshot.graphs:[]){const graph=object(raw);if((activeGraphIds.has(String(graph.id))||pendingSwarmGraphIds.has(String(graph.id)))&&busyGraphStatuses.has(String(graph.status)))await requestPlugin(bus,'swarm','stop',{graphId:graph.id},5000,'user');}}
    statusBeforeCompaction=undefined;session.abortCompaction();await session.abort();return current();
  }
  if(method==='configure'){
    if(!session.isIdle||swarmBusy())throw new Error('请等待当前执行停止，再修改配置');
    if(input.modelId)await session.setModel(selectedModel(text(input.modelId)));
    if(input.thinkingLevel){const level=text(input.thinkingLevel);if(!['off','minimal','low','medium','high','xhigh'].includes(level))throw new Error('思考等级无效');session.setThinkingLevel(level as ThinkingLevel);}
    if(Array.isArray(input.plugins)){
      const next=input.plugins.map(String);if(next.some(name=>!plugins.includes(name)))throw new Error('插件无效');
      if(JSON.stringify(enabled)!==JSON.stringify(next)){enabled=next;session.settingsManager.setExtensionPaths(next.map(name=>join(root,'packages',name,'dist','index.js')));await session.reload();await bind();}
    }
    return current();
  }
  if(method==='plugin'){
    const plugin=text(input.plugin);if(!enabled.includes(plugin))throw new Error('插件不可用，当前会话已关闭它');const action=text(input.action);const args=object(input.input||{});
    const graphId=plugin==='swarm'&&swarmExecutionActions.has(action)&&typeof args.graphId==='string'?args.graphId:undefined;
    if(graphId)pendingSwarmGraphIds.add(graphId);
    try{return await requestPlugin(bus,plugin,action,args,120000,'user');}
    finally{if(graphId){pendingSwarmGraphIds.delete(graphId);swarmRunning=[...activeGraphIds].some(id=>busyGraphStatuses.has(String(swarmGraphs.get(id)?.status)));if(!session.isStreaming&&activeGraphIds.has(graphId)){lifecycleStatus=settledStatus();publishAuthorityNotice();}publish('state',current());}}
  }
  if(method==='dialog.respond'){
    const pending=dialogs.get(text(input.id));if(!pending)throw new Error('交互已结束');clearTimeout(pending.timer);dialogs.delete(String(input.id));pending.resolve(input.cancelled?undefined:input.confirmed!==undefined?Boolean(input.confirmed):input.value);return {ok:true};
  }
  if(method==='provider.save'||method==='provider.refresh'){
    if(!session.isIdle||swarmBusy())throw new Error('请先停止当前执行，再修改供应商配置');
    const provider=method==='provider.save'?await saveProviderConfiguration(runtime,dataDir,input):typeof input.provider==='string'?input.provider:undefined;await runtime.refresh();
    if(method==='provider.save'&&provider){const available=await runtime.getAvailable(provider);if(available[0])await session.setModel(available[0]);}else if(session.model){const latest=runtime.getModel(session.model.provider,session.model.id);if(latest)await session.setModel(latest);}
    return {...current(),...modelState()};
  }
  if(method==='rename'){session.setSessionName(text(input.name,'名称',200));return current();}
  if(method==='shutdown'){await shutdown();return {ok:true};}
  throw new Error(`未知操作：${method}`);
}
function publicError(error:unknown):string{return (error instanceof Error?error.message:String(error)).replace(/sk-[A-Za-z0-9_-]{8,}/g,'[密钥已隐藏]');}
async function shutdown(){if(disposed)return;if(session&&!session.isIdle||swarmBusy())lifecycleStatus='interrupted';disposed=true;for(const pending of dialogs.values()){clearTimeout(pending.timer);pending.resolve(undefined);}dialogs.clear();session?.abortCompaction();await session?.abort();if(session)await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session?.dispose();bus.clear();}
process.on('message',raw=>{if(!raw||typeof raw!=='object')return;const request=object(raw);if(request.type!=='request')return;void handle(text(request.method),object(request.input||{})).then(result=>{output({type:'response',id:request.id,result});if(request.method==='shutdown')setImmediate(()=>process.disconnect?.());}).catch(error=>output({type:'response',id:request.id,error:publicError(error)}));});
process.on('disconnect',()=>{void shutdown();});
void initialize().catch(error=>{output({type:'fatal',error:publicError(error)});process.exitCode=1;setImmediate(()=>process.disconnect?.());});
