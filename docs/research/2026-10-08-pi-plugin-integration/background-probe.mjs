import {mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,ModelRuntime,createEventBus,initTheme} from '@earendil-works/pi-coding-agent';
import {fauxProvider} from '@earendil-works/pi-ai/providers/faux';
const base=resolve('.cache/research/pi-plugin-integration/2026-10-08');
const cwd=join(base,'background-fixture-project'),agentDir=join(base,'background-fixture-agent');
mkdirSync(cwd,{recursive:true});mkdirSync(agentDir,{recursive:true});
process.env.PI_CODING_AGENT_DIR=agentDir;process.env.PI_OFFLINE='1';process.env.PI_BG_DISABLE_UPDATE_CHECK='1';process.env.PI_BG_FEATURES='process';process.env.PI_BG_DOCK_SHORTCUT='off';
for(const key of Object.keys(process.env))if(/(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET)/i.test(key))delete process.env[key];
initTheme('light',false);
const bus=createEventBus(),lifecycleErrors=[],notices=[],terminal=[];
const fixture=fauxProvider({provider:'integration-fixture',models:[{id:'offline',name:'Offline integration fixture',reasoning:false,input:['text'],contextWindow:32768,maxTokens:4096}]});
const runtime=await ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:join(agentDir,'models.json'),allowModelNetwork:false});
runtime.registerNativeProvider(fixture.provider);
const settings=SettingsManager.inMemory({extensions:[join(base,'background/package/dist/extensions/background-tasks.js')],packages:[],defaultTools:[]});
const loader=new DefaultResourceLoader({cwd,agentDir,settingsManager:settings,noThemes:true,noSkills:true,noPromptTemplates:true,eventBus:bus});
await loader.reload({resolveProjectTrust:async()=>true});
const loaded=loader.getExtensions();
const result={node:process.version,pi:'1.0.4',extension:'pi-background-tasks@2.6.9',features:'process',modelCalls:0,guiAcceptance:'NOT_RUN',loadErrors:loaded.errors,extensions:loaded.extensions.map(e=>({path:e.path,tools:[...e.tools.keys()],commands:[...e.commands.keys()]}))};
let session;
function request(operation,payload={}){return new Promise((yes,no)=>{const id=randomUUID();const off=bus.on('pi-background-tasks:response:v1',response=>{if(response.request_id===id){clearTimeout(timer);off();yes(response);}});const timer=setTimeout(()=>{off();no(new Error('EventBus timeout: '+operation));},5000);bus.emit('pi-background-tasks:request:v1',{schema_version:'pi-background-tasks.extension-request.v1',request_id:id,operation,payload});});}
try{
 if(loaded.errors.length)throw new Error('Extension loading failed');
 const created=await createAgentSession({cwd,agentDir,modelRuntime:runtime,model:fixture.getModel(),resourceLoader:loader,settingsManager:settings,sessionManager:SessionManager.create(cwd,join(agentDir,'sessions'))});
 session=created.session;
 const ui={...session.extensionRunner.getUIContext(),notify:(message,level)=>notices.push({message,level}),setStatus:()=>{},custom:async()=>{throw new Error('Desktop does not support terminal custom UI');}};
 await session.bindExtensions({uiContext:ui,mode:'rpc',abortHandler:()=>void session.abort(),shutdownHandler:()=>{},onError:error=>lifecycleErrors.push(error.error)});
 result.bindErrors=[...lifecycleErrors];
 bus.on('pi-background-tasks:terminal:v1',event=>terminal.push(event));
 result.capabilities=await request('capabilities');
 result.run=await request('run',{name:'Offline smoke fixture',command:process.execPath+" -e 'setTimeout(()=>console.log(\"FRIEND_BG_FIXTURE_OK\"),180)'",isAgent:false,timeoutSeconds:5,notifyOnCompletion:false,triggerOnCompletion:false});
 const taskId=result.run?.result?.task?.id??result.run?.result?.id;
 result.taskId=taskId;
 if(!taskId)throw new Error('Missing task id');
 const end=Date.now()+5000;
 while(!terminal.length&&Date.now()<end)await new Promise(done=>setTimeout(done,50));
 result.terminal=terminal;result.status=await request('status',{taskId});result.logs=await request('logs',{taskId,maxBytes:1000});
 const longCommand=process.execPath+" -e 'setTimeout(()=>console.log(\"LATE_OUTPUT\"),15000)'";
 result.killRun=await request('run',{name:'Cancel fixture',command:longCommand,isAgent:false,timeoutSeconds:20,notifyOnCompletion:false,triggerOnCompletion:false});
 result.kill=await request('kill',{taskId:result.killRun.result.id});
 result.afterKill=await request('status',{taskId:result.killRun.result.id});
 result.quitRun=await request('run',{name:'Quit fixture',command:longCommand,isAgent:false,timeoutSeconds:20,notifyOnCompletion:false,triggerOnCompletion:false});
 result.lifecycleErrors=lifecycleErrors;
}catch(error){result.error=String(error);}finally{
 if(session){await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();result.shutdownErrors=lifecycleErrors;const pid=result.quitRun?.result?.pid;if(pid){try{process.kill(pid,0);result.quitChildStillAlive=true;}catch(error){result.quitChildStillAlive=error.code!=='ESRCH';}}}
 bus.clear();writeFileSync(join(base,'background-probe.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({loadErrors:result.loadErrors,bindErrors:result.bindErrors,capabilities:result.capabilities?.ok,run:result.run?.ok,status:result.status?.result?.tasks?.[0]?.status,logHasMarker:result.logs?.result?.text?.includes('FRIEND_BG_FIXTURE_OK'),killStatus:result.afterKill?.result?.tasks?.[0]?.status,quitChildStillAlive:result.quitChildStillAlive,shutdownErrors:result.shutdownErrors,error:result.error}));
}
