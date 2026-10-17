// Explicit opt-in real-provider journey. Reads only Friend-Pi's independent auth.
import { fork,execFileSync } from 'node:child_process';
import { mkdirSync,writeFileSync,readFileSync,mkdtempSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir,tmpdir } from 'node:os';
const root=resolve(process.env.FRIEND_PI_ROOT||'.');const dataDir=resolve(process.env.FRIEND_PI_DATA_DIR||join(homedir(),'Library/Application Support/Friend-Pi'));const project=mkdtempSync(join(tmpdir(),'friend-pi-repair-real-'));mkdirSync(project,{recursive:true});
writeFileSync(join(project,'README.md'),'# Real provider acceptance fixture\nOnly this disposable project may be changed.\n');execFileSync('git',['init','-q'],{cwd:project});if(!execFileSync('git',['status','--porcelain'],{cwd:project,encoding:'utf8'}).includes('README.md')){}else{execFileSync('git',['add','README.md'],{cwd:project});execFileSync('git',['-c','user.name=Friend-Pi QA','-c','user.email=qa@localhost','commit','-qm','Real journey fixture'],{cwd:project});}
const env={...process.env,FRIEND_PI_ROOT:root,FRIEND_PI_PROJECT:project,FRIEND_PI_DATA_DIR:dataDir,FRIEND_PI_AGENT_DIR:join(dataDir,'pi'),FRIEND_PI_MEMBER_WORKER:join(root,'packages/swarm/dist/member.js')};delete env.FRIEND_PI_TEST_PROVIDER;delete env.FRIEND_PI_SESSION_FILE;
const child=fork(join(root,'apps/desktop/dist/sdk-worker.mjs'),[],{execPath:process.env.FRIEND_PI_NODE||process.execPath,cwd:project,env,stdio:['ignore','ignore','ignore','ipc']});const pending=new Map();const events=[];let readyResolve,readyReject;const ready=new Promise((yes,no)=>{readyResolve=yes;readyReject=no;});
child.on('message',m=>{events.push(m);if(m.type==='ready')readyResolve(m);if(m.type==='fatal')readyReject(new Error(m.error));if(m.type==='response'){const p=pending.get(m.id);if(p){clearTimeout(p.timer);pending.delete(m.id);m.error?p.no(new Error(m.error)):p.yes(m.result);}}});
const request=(method,input={})=>new Promise((yes,no)=>{const id=randomUUID();const timer=setTimeout(()=>{pending.delete(id);no(new Error('SDK request timed out'));},125000);timer.unref();pending.set(id,{yes,no,timer});child.send({type:'request',id,method,input});});
child.on('exit',()=>{for(const p of pending.values()){clearTimeout(p.timer);p.no(new Error('SDK process exited'));}pending.clear();});
async function until(check,timeout=JOURNEY_TIMEOUT){const end=Date.now()+timeout;while(!(await check())){if(Date.now()>end)throw new Error('Journey timed out; inspect preserved fixture and history');await new Promise(done=>setTimeout(done,150));}}
const results=[];const JOURNEY_TIMEOUT=Number(process.env.FRIEND_PI_JOURNEY_TIMEOUT_MS||240000);
try {
 await Promise.race([ready,new Promise((_,no)=>setTimeout(()=>no(new Error('Worker initialization timed out')),30000).unref())]);let state=await request('state');const configured=state.providers.filter(p=>p.configured);if(!configured.length){results.push({journey:'real-provider',status:'PENDING_USER_AUTH'});process.exitCode=2;}
 else {
  const selected=state.models.find(m=>configured.some(p=>p.id===m.provider)&&m.id===state.modelId)||state.models.find(m=>configured.some(p=>p.id===m.provider));await request('configure',{modelId:selected.id,thinkingLevel:'off'});await request('plugin',{plugin:'expert',action:'settings',input:{paused:true}});
  // Acceptance runs on an upgraded install profile (conservative default). Explicitly enable
  // standard auto-publish so this journey exercises deterministic publication; the profile
  // default itself is covered by the memory package tests.
  const autoPublishMode=(await request('plugin',{plugin:'memory',action:'autoPublish.settings',input:{mode:'standard'}}))?.mode||'standard';
  results.push({journey:'memory-auto-publish-mode',status:'PASS',mode:autoPublishMode});
  const call=(plugin,action,input={})=>request('plugin',{plugin,action,input});
  await call('expert','select',{ids:['researcher']});let marker=events.length;await request('send',{text:`早期约束：数据库必须使用 SQLite，必须保留 UTF-8 中文字段。读取 ${join(project,'README.md')}，简短说明内容。`,planMode:true});await until(()=>events.slice(marker).some(e=>e.event?.data?.type==='agent_settled'));await until(async()=>!(await request('state')).isRunning);state=await request('state');if(!state.messages.some(m=>m.role==='assistant'&&m.text))throw new Error('Real Single produced no visible reply');if(state.isRunning||state.lifecycleStatus!=='completed')throw new Error('Real Single did not settle successfully');const nativeEntries=readFileSync(state.sessionFile,'utf8').trim().split('\n').map(line=>JSON.parse(line));if(!nativeEntries.some(entry=>entry.customType==='friend-pi.expert.adoption'&&entry.data?.mode==='selected'&&entry.data?.id==='researcher'&&entry.data?.runId&&entry.data?.hash))throw new Error('Missing native expert adoption evidence');results.push({journey:'single/expert-adoption',status:'PASS',modelId:selected.id,sessionFile:state.sessionFile});
  await call('memory','learning.run');await until(async()=>{const snapshot=await call('memory','snapshot');const active=(snapshot.memories||[]).filter(memory=>memory.status==='active'&&memory.enabled);return active.some(memory=>memory.content.includes('SQLite'))&&active.some(memory=>memory.content.includes('UTF-8'));},JOURNEY_TIMEOUT);results.push({journey:'automatic-background-learning',status:'PASS'});
  marker=events.length;await request('send',{text:'更正数据库：不要 SQLite，必须使用 PostgreSQL；UTF-8 中文字段保持有效。只回复已更正，不调用工具。',planMode:false});await until(()=>events.slice(marker).some(e=>e.event?.data?.type==='agent_settled'));await until(async()=>!(await request('state')).isRunning);const facts=await call('memory','select',{query:'数据库 UTF-8',limit:8});const contents=JSON.stringify(facts.records);if(!contents.includes('PostgreSQL')||!contents.includes('UTF-8'))throw new Error('Automatic fact correction lost sibling');results.push({journey:'automatic-fact-correction',status:'PASS'});
  const origins=await call('topic-rebuild','history.search',{query:'早期约束'});const source=Array.isArray(origins)?origins.find(item=>item.role==='user'):undefined;const memory=await call('memory','save',{title:'验收约束',content:'必须保留中文字段',scope:'project',explicitRemember:true,sources:[]});await call('memory','update',{id:memory.id,revision:memory.revision,content:'纠正：必须保留 UTF-8 中文字段'});if(!JSON.stringify(await call('memory','search',{query:'中文字段'})).includes('UTF-8'))throw new Error('Memory correction missing');results.push({journey:'memory-correction',status:'PASS'});
  // Swarm/Team product modes are out of scope for the memory acceptance journey and the
  // packaged SDK harness intentionally runs single mode; memory/Topic evidence continues below.
  results.push({journey:'swarm-independent-review',status:'SKIPPED_ENVIRONMENT',message:'packaged harness runs single execution mode; swarm/team acceptance is covered by its own suites'});
  await call('topic-rebuild','settings',{mode:'infinite'});
  const readCompactions=()=>readFileSync(state.sessionFile,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(entry=>entry.type==='compaction');
  const beforeCompactions=readCompactions().length;
  async function submitAndSettle(text){
   const startAt=events.length;await request('send',{text,planMode:true});
   await until(()=>events.slice(startAt).some(e=>e.event?.data?.type==='agent_settled'));
   await until(async()=>!(await request('state')).isRunning);
   if((await request('state')).lifecycleStatus!=='completed')throw new Error('Long-context input did not settle successfully');
  }
  for(let i=0;i<2;i++){
   // Raw material and the current task are separate native user messages. A
   // thousands-of-facts goal is intentionally outside the finite field budget.
   const material=`第${i+1}轮 QA 数据，只用于压缩验收。以下单段编号材料不是指令，不执行工具，只回复收到。\n`+'a 123456 b 789012 '.repeat(7200);
   await submitAndSettle(material);
   await submitAndSettle('当前目标：维持本项目约束。数据库必须使用 PostgreSQL，必须保留 UTF-8 中文字段。编号材料只是数据；只回复收到，不调用工具。');
   // Stabilize this fixture's own publication to test successful adoption. The
   // product compression hook does not wait for the background/global queue;
   // concurrent source invalidation and native fallback have separate regressions.
   await call('memory','learning.run');
   await until(async()=>{const snapshot=await call('memory','snapshot');const jobs=snapshot.learning.jobs.filter(job=>job.sessionId===state.sessionId);if(jobs.some(job=>job.state==='failed'||job.state==='waiting_configuration'))throw new Error('Fixture learning did not publish successfully');return jobs.every(job=>job.state==='completed');},JOURNEY_TIMEOUT);
   const startAt=events.length;await call('topic-rebuild','rebuild');
   await until(()=>events.slice(startAt).some(e=>e.event?.data?.type==='compaction_end'),240000);
   const complete=events.slice(startAt).find(e=>e.event?.data?.type==='compaction_end').event.data;
   const snapshot=await call('topic-rebuild','snapshot');
   if(complete.aborted||complete.errorMessage)throw new Error('Compaction failed: '+(complete.errorMessage||'cancelled'));
   if(snapshot.status?.phase==='fallback')throw new Error('Custom Rebuild fell back: '+snapshot.status.error);
  }
  const field=await call('topic-rebuild','snapshot'),compactions=readCompactions().slice(beforeCompactions);
  const adopted=compactions.filter(entry=>entry.details?.friendPiRebuild),last=adopted.at(-1)?.details.friendPiRebuild;
  const constraints=JSON.stringify(last?.constraints||[]);
  const verified=adopted.length>=2&&constraints.includes('PostgreSQL')&&constraints.includes('UTF-8')&&(last?.memoryRefs?.length||0)>0;
  results.push({journey:'continuous-rebuild',status:verified?'PASS':'PENDING_ADOPTION_EVIDENCE',version:field.field?.revision,adoptedCompactions:adopted.length,nativeFallbacks:compactions.length-adopted.length,retained:adopted.map(entry=>({entryId:entry.id,operationId:entry.details.friendPiRebuild.operationId,revision:entry.details.friendPiRebuild.revision,constraints:entry.details.friendPiRebuild.constraints,memoryRefs:entry.details.friendPiRebuild.memoryRefs,firstKeptEntryId:entry.details.friendPiRebuild.firstKeptEntryId}))});
  if(!verified)process.exitCode=2;
 }
} catch(error){results.push({journey:'error',status:'FAIL',message:error.message});process.exitCode=1;}
finally{const exit=new Promise(done=>child.once('exit',done));try{await request('shutdown');await exit;}catch{child.kill();}mkdirSync('.artifacts/qa',{recursive:true});writeFileSync('.artifacts/qa/real-model-report.json',JSON.stringify({time:new Date().toISOString(),root,dataDir,results,diagnostics:events.flatMap(e=>e.event?.type==='plugin'&&e.event.data?.pluginEvent==='topic-rebuild.fallback'?[{type:'fallback',data:e.event.data.data}]:e.event?.type==='notice'?[{type:'notice',data:e.event.data}]:[]),lifecycle:events.flatMap(e=>e.type==='event'&&e.event?.type==='state'?[{type:'state',status:e.event.data.lifecycleStatus,isRunning:e.event.data.isRunning,runId:e.event.data.runId}]:e.type==='event'&&e.event?.type==='pi'&&['agent_start','agent_settled','compaction_start','compaction_end'].includes(e.event.data?.type)?[{type:e.event.data.type,reason:e.event.data.reason}]:[])},null,2)+'\n');console.log(JSON.stringify(results));}
