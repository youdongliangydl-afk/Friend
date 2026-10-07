import { randomUUID } from 'node:crypto';
import { mkdirSync,existsSync,readFileSync,realpathSync } from 'node:fs';
import { join,resolve,relative,extname } from 'node:path';
import { createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,ModelRuntime,createEventBus,initTheme,type AgentSession,type ExtensionUIContext,type ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { dataDirectory,object,text,visibleText,historyItems,requestPlugin,atomicWrite,installFixtureProvider } from '@friend-pi/core';
import type { ImageContent } from '@earendil-works/pi-ai';

const dataDir=dataDirectory();const root=resolve(process.env.FRIEND_PI_ROOT || process.cwd());const cwd=resolve(process.env.FRIEND_PI_PROJECT || process.cwd());
const agentDir=join(dataDir,'pi');mkdirSync(agentDir,{recursive:true,mode:0o700});
const plugins=['swarm','expert','memory','topic-rebuild'];
let enabled=process.env.FRIEND_PI_PLUGINS?JSON.parse(process.env.FRIEND_PI_PLUGINS) as string[]:plugins;
let session:AgentSession;let runtime:ModelRuntime;const bus=createEventBus();let runId:string|undefined;let disposed=false;let swarmRunning=false;let planMode=false;let executionMode='single';
const dialogs=new Map<string,{resolve:(value:unknown)=>void;timer:ReturnType<typeof setTimeout>}>();
function output(message:unknown){if(process.connected)process.send?.(message);}
function publish(type:string,data:unknown){output({type:'event',event:{type,sessionId:session?.sessionId,runId,data}});}
function dialog(kind:string,title:string,input:Record<string,unknown>={},timeout=60000):Promise<unknown>{
  const id=randomUUID();return new Promise(resolveResult=>{const timer=setTimeout(()=>{dialogs.delete(id);resolveResult(undefined);publish('dialog.closed',{id});},timeout);dialogs.set(id,{resolve:resolveResult,timer});publish('dialog',{id,kind,title,...input});});
}
function current(){return {sessionId:session.sessionId,messages:session.messages.map(message=>({role:message.role,text:'content' in message?visibleText(message.content):''})).filter(message=>message.role!=='system'&&message.text.trim()),isRunning:session.isStreaming||swarmRunning,planMode,modelId:session.model?`${session.model.provider}/${session.model.id}`:undefined,thinkingLevel:session.thinkingLevel,plugins:enabled,context:session.getContextUsage(),sessionFile:session.sessionFile,runId};}
function modelState(){return {models:runtime.getModels().map(model=>({id:`${model.provider}/${model.id}`,provider:model.provider,name:model.name,reasoning:model.reasoning,contextWindow:model.contextWindow,input:model.input})),providers:runtime.getProviders().map(provider=>({id:provider.id,name:provider.name,configured:runtime.hasConfiguredAuth(provider.id)}))};}
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
  runtime=await ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:join(agentDir,'models.json'),allowModelNetwork:false});
  let model=process.env.FRIEND_PI_TEST_PROVIDER==='1'?await installFixtureProvider(runtime):undefined;
  if(process.env.FRIEND_PI_MODEL)model=selectedModel(process.env.FRIEND_PI_MODEL);
  if(!model)model=(await runtime.getAvailable())[0]||runtime.getModels().find(item=>item.provider==='deepseek')||runtime.getModels()[0];
  const settings=SettingsManager.inMemory({extensions:enabled.map(name=>join(root,'packages',name,'dist','index.js')),packages:[],defaultTools:['read','bash','edit','write'],compaction:{enabled:true,...(process.env.FRIEND_PI_TEST_PROVIDER==='1'?{keepRecentTokens:512,reserveTokens:2048}:{})}});
  const loader=new DefaultResourceLoader({cwd,agentDir,settingsManager:settings,noExtensions:false,noSkills:false,noPromptTemplates:false,noThemes:true,eventBus:bus,extensionFactories:[guard()]});
  await loader.reload({resolveProjectTrust:async()=>true});
  const manager=process.env.FRIEND_PI_SESSION_FILE?SessionManager.open(process.env.FRIEND_PI_SESSION_FILE):SessionManager.create(cwd,join(dataDir,'sessions'));
  const created=await createAgentSession({cwd,agentDir,modelRuntime:runtime,model,resourceLoader:loader,settingsManager:settings,sessionManager:manager});session=created.session;
  if(created.extensionsResult.errors.length)throw new Error(created.extensionsResult.errors.map(error=>error.error).join('; '));
  session.subscribe(event=>{publish('pi',event);if(event.type==='message_end'||event.type==='agent_settled'||event.type==='compaction_end')publish('state',current());});
  bus.on('friend-pi:v1:event',raw=>{publish('plugin',raw);if(raw&&typeof raw==='object'){const event=object(raw);if(event.pluginEvent==='swarm.changed'&&event.data&&typeof event.data==='object'){const snapshot=object(event.data);swarmRunning=Array.isArray(snapshot.graphs)&&snapshot.graphs.some(rawGraph=>['running','awaiting_review'].includes(String(object(rawGraph).status)));publish('state',current());}}});
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
    if((session.isStreaming||swarmRunning)&&(nextPlan!==planMode||mode!==executionMode))throw new Error('请先停止当前执行，再切换计划或协作方式');
    if(!session.isStreaming&&!swarmRunning){planMode=nextPlan;executionMode=mode;}
    if(!session.isStreaming)runId=randomUUID();
    void session.prompt(combined,{images:attachments.flatMap(item=>item.image?[item.image]:[]),streamingBehavior:input.inputMode==='steer'?'steer':'followUp'}).then(()=>publish('state',current())).catch(error=>publish('notice',{level:'error',message:error instanceof Error?error.message:String(error)}));
    return {accepted:true,sessionId:session.sessionId,runId};
  }
  if(method==='stop'){
    for(const [id,pending] of dialogs){clearTimeout(pending.timer);pending.resolve(undefined);publish('dialog.closed',{id});}dialogs.clear();
    if(enabled.includes('swarm')){const snapshot=object(await requestPlugin(bus,'swarm','snapshot',{},1000));for(const raw of Array.isArray(snapshot.graphs)?snapshot.graphs:[]){const graph=object(raw);if(['running','awaiting_review'].includes(String(graph.status)))await requestPlugin(bus,'swarm','stop',{graphId:graph.id},5000,'user');}}
    await session.abort();return current();
  }
  if(method==='configure'){
    if(session.isStreaming||swarmRunning)throw new Error('请等待当前执行停止，再修改配置');
    if(input.modelId)await session.setModel(selectedModel(text(input.modelId)));
    if(input.thinkingLevel){const level=text(input.thinkingLevel);if(!['off','minimal','low','medium','high','xhigh'].includes(level))throw new Error('思考等级无效');session.setThinkingLevel(level as ThinkingLevel);}
    if(Array.isArray(input.plugins)){
      const next=input.plugins.map(String);if(next.some(name=>!plugins.includes(name)))throw new Error('插件无效');
      if(JSON.stringify(enabled)!==JSON.stringify(next)){enabled=next;session.settingsManager.setExtensionPaths(next.map(name=>join(root,'packages',name,'dist','index.js')));await session.reload();await bind();}
    }
    return current();
  }
  if(method==='plugin'){const plugin=text(input.plugin);if(!enabled.includes(plugin))throw new Error('插件不可用，当前会话已关闭它');return await requestPlugin(bus,plugin,text(input.action),object(input.input||{}),120000,'user');}
  if(method==='dialog.respond'){
    const pending=dialogs.get(text(input.id));if(!pending)throw new Error('交互已结束');clearTimeout(pending.timer);dialogs.delete(String(input.id));pending.resolve(input.cancelled?undefined:input.confirmed!==undefined?Boolean(input.confirmed):input.value);return {ok:true};
  }
  if(method==='provider.save'){
    if(session.isStreaming||swarmRunning)throw new Error('请先停止当前执行，再修改供应商配置');
    const provider=text(input.provider,'供应商',120);const auth=join(agentDir,'auth.json');
    if(input.baseUrl||input.modelId){
      const modelId=text(input.modelId||runtime.getModels(provider)[0]?.id,'型号',200);const baseUrl=text(input.baseUrl||runtime.getModels(provider)[0]?.baseUrl,'地址',2000);const parsed=new URL(baseUrl);if(!['https:','http:'].includes(parsed.protocol))throw new Error('地址须为 HTTP(S)');
      const path=join(agentDir,'models.json');const config=existsSync(path)?object(JSON.parse(readFileSync(path,'utf8'))):{};const providers=object(config.providers||{});
      providers[provider]={baseUrl,api:typeof input.api==='string'?input.api:'openai-completions',models:[{id:modelId,name:modelId,reasoning:false,input:['text'],contextWindow:32768,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]};
      atomicWrite(path,JSON.stringify({...config,providers},null,2));
    }
    await runtime.refresh();
    if(input.apiKey){const key=text(input.apiKey,'Key',8192);await runtime.login(provider,'api_key',{prompt:async()=>key,notify:()=>{}});}
    await runtime.refresh();const available=await runtime.getAvailable(provider);if(available[0]&&!session.isStreaming)await session.setModel(available[0]);return {...current(),...modelState()};
  }
  if(method==='rename'){session.setSessionName(text(input.name,'名称',200));return current();}
  if(method==='shutdown'){await shutdown();return {ok:true};}
  throw new Error(`未知操作：${method}`);
}
async function shutdown(){if(disposed)return;disposed=true;for(const pending of dialogs.values()){clearTimeout(pending.timer);pending.resolve(undefined);}dialogs.clear();await session?.abort();if(session)await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session?.dispose();bus.clear();}
process.on('message',raw=>{if(!raw||typeof raw!=='object')return;const request=object(raw);if(request.type!=='request')return;void handle(text(request.method),object(request.input||{})).then(result=>{output({type:'response',id:request.id,result});if(request.method==='shutdown')setImmediate(()=>process.disconnect?.());}).catch(error=>output({type:'response',id:request.id,error:error instanceof Error?error.message:String(error)}));});
process.on('disconnect',()=>{void shutdown();});
void initialize().catch(error=>{output({type:'fatal',error:error instanceof Error?error.message:String(error)});process.exitCode=1;setImmediate(()=>process.disconnect?.());});
