import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,existsSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CapabilityError,RuntimeCapabilityServices,TaskLedger,RecordStore,type PluginContext,type JsonObject} from '@friend-pi/core';
import {SwarmController,type Graph,type MemberStart,type MemberLauncher} from '../src/index.js';

const task=(id='read',mode:'read'|'write'='read')=>({id,title:id,prompt:'Read the original without commands',mode,dependencies:[],writeScopes:mode==='write'?['.']:[]});
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'swarm-readonly-check-')),project=join(root,'project'),data=join(root,'data'),marker=join(root,'check-ran');mkdirSync(project);writeFileSync(join(project,'original.txt'),'original\n');
  const services=new RuntimeCapabilityServices(data),ledger=new TaskLedger(data),starts:MemberStart[]=[],processes:unknown[]=[];
  const ctx:PluginContext={origin:'user',executionMode:'swarm',dataDir:data,projectDir:project,projectId:'p',sessionId:'s',runId:'run',modelId:'fake/default',thinkingLevel:'off',agentDir:join(root,'agent'),isIdle:()=>true,history:()=>[],readSource:()=>{throw Error('unused');},complete:async()=>{throw Error('unexpected model');},request:async(plugin,action,input)=>{if(plugin==='runtime'&&action==='task.identity')return ledger.resolveIdentity(input||{},ctx);if(plugin==='runtime'&&action==='task.repair.claimBatch')return ledger.claimRepairBatch(input||{},ctx);if(plugin==='runtime')return services.dispatch(action,input||{},ctx);throw new CapabilityError('CAPABILITY_UNAVAILABLE','optional plugin absent');},emit:(name,value)=>{if(name==='swarm.process'&&(value as {kind:string}).kind==='check')processes.push(value);},notify:()=>{},appendEntry:()=>{},policy:{v:1,revision:1,stage:'main',unsettledTools:0,canSwitchRole:false,tools:['read','write','edit','bash'],writeScopes:['.'],executionMode:'swarm',planMode:false}};
  const launch:MemberLauncher=(start,output)=>{starts.push(start);assert.equal(start.reviewResult,true,'Only a model-free independent reviewer is expected');const sessionId='review-'+start.attemptId,sessionFile=join(start.sessionDir,'native.jsonl');mkdirSync(start.sessionDir,{recursive:true});writeFileSync(sessionFile,JSON.stringify({type:'session',version:3,id:sessionId,cwd:start.cwd})+'\n');setImmediate(()=>output({v:1,type:'settled',summary:JSON.stringify({approved:true,findings:'Checked original and retained objective receipts',resultVersions:start.resultVersions,candidateDigest:start.candidateDigest}),sessionId,sessionFile}));const receipt={id:start.attemptId,kind:'member' as const,status:'terminated' as const,exitCode:0};return {send(){},closed:Promise.resolve(receipt),stop:async()=>receipt};};
  const controller=new SwarmController(launch),check={command:process.execPath,args:['-e',`require('node:fs').appendFileSync(${JSON.stringify(marker)},${JSON.stringify('ran\n')})`]},command={id:'command-check',kind:'command',command:check.command,argv:check.args};
  const read=()=>new RecordStore('swarm',data);
  function retained(id:string){const store=read();try{return store.get<Graph>(`graph:p:${id}`)!;}finally{store.close();}}
  function patch(id:string,fn:(graph:Graph)=>void){const store=read();try{const row=store.get<Graph>(`graph:p:${id}`)!;fn(row.value);store.put(row.key,row.value,row.revision);}finally{store.close();}}
  return {root,project,data,marker,ctx,controller,check,command,starts,processes,retained,patch,async close(){await controller.dispose();ledger.dispose();services.dispose();rmSync(root,{recursive:true,force:true});}};
}
const denied=(error:unknown)=>error instanceof CapabilityError&&error.code==='PERMISSION_DENIED'&&/只读协作/.test(error.message);
async function wait(check:()=>boolean){const end=Date.now()+4000;while(!check()){if(Date.now()>end)throw Error('timed out');await new Promise(done=>setTimeout(done,5));}}
function zero(f:ReturnType<typeof fixture>){assert.equal(existsSync(f.marker),false);assert.deepEqual(f.processes,[]);assert.deepEqual(f.starts,[]);}

for(const origin of ['agent','plugin',undefined] as const)test(`readonly plan/create reject commands for ${origin??'missing'} host origin, regardless of input origin`,async()=>{
  const f=fixture(),ctx={...f.ctx,origin};try{for(const action of ['plan.validate','create'])await assert.rejects(f.controller.dispatch(action,{goal:'summarize original',reason:'two independent original reads',strategy:'collaboration',tasks:[task()],checks:[f.check],origin:'user'},ctx),denied);zero(f);assert.equal((f.controller.snapshot(f.ctx) as {graphs:Graph[]}).graphs.length,0);}finally{await f.close();}
});

for(const verification of ['V0','V1','V2'])test(`readonly ${verification} contract command cannot bypass plan or create`,async()=>{
  const f=fixture(),ctx={...f.ctx,origin:'agent' as const};try{for(const action of ['plan.validate','create'])await assert.rejects(f.controller.dispatch(action,{goal:'read',reason:'independent sources',tasks:[task()],checks:[],contract:{verification,checks:[f.command]}},ctx),denied);zero(f);}finally{await f.close();}
});

test('readonly agent create omits automatic npm test and preserves declarative checks and required review',async()=>{
  const f=fixture(),ctx={...f.ctx,origin:'agent' as const};try{writeFileSync(join(f.project,'package.json'),JSON.stringify({scripts:{test:'node -e "process.exit(1)"'}}));const contract={verification:'V1',checks:[{kind:'file.exists',target:'original.txt'}]};const plan=await f.controller.dispatch('plan.validate',{goal:'read',reason:'independent read and review',tasks:[task()],contract},ctx) as {checks:unknown[];contract:{verification:string}};assert.deepEqual(plan.checks,[]);assert.equal(plan.contract.verification,'V1');const graph=await f.controller.dispatch('create',{goal:'read',tasks:[task()],contract},ctx) as Graph;assert.deepEqual(graph.checks,[]);assert.equal(graph.contract!.checks[0].kind,'file.exists');assert.equal(graph.contract!.verification,'V1');zero(f);}finally{await f.close();}
});

test('append checks merged tasks and prospective contract before mutating the graph',async()=>{
  const f=fixture(),ctx={...f.ctx,origin:'agent' as const};try{const clean=await f.controller.dispatch('create',{goal:'read',tasks:[task()],checks:[]},ctx) as Graph;let before=f.retained(clean.id);await assert.rejects(f.controller.dispatch('append',{graphId:clean.id,tasks:[task('next')],contract:{verification:'V2',checks:[f.command]},origin:'user'},ctx),denied);assert.deepEqual(f.retained(clean.id),before);
    const old=await f.controller.dispatch('create',{goal:'old user checks',tasks:[task()],checks:[f.check]},f.ctx) as Graph;before=f.retained(old.id);await assert.rejects(f.controller.dispatch('append',{graphId:old.id,tasks:[task('next')],checks:[]},ctx),denied);assert.deepEqual(f.retained(old.id),before);zero(f);
  }finally{await f.close();}
});

test('changing the last write task to read cannot retain a command check or spend repair allowance',async()=>{
  const f=fixture(),ctx={...f.ctx,origin:'agent' as const};try{const graph=await f.controller.dispatch('create',{goal:'write',tasks:[task('write','write')],checks:[f.check]},ctx) as Graph,before=f.retained(graph.id);await assert.rejects(f.controller.dispatch('update_task',{graphId:graph.id,taskId:'write',mode:'read',writeScopes:[],reason:'make readonly',repair:true},ctx),denied);assert.deepEqual(f.retained(graph.id),before);zero(f);}finally{await f.close();}
});

for(const collaborationVersion of [1,undefined])test(`old ${collaborationVersion===1?'legacy':'current'} readonly graph cannot start or prepare checks as agent`,async()=>{
  const f=fixture(),ctx={...f.ctx,origin:'agent' as const};try{const graph=await f.controller.dispatch('create',{goal:'old checks',tasks:[task()],checks:[f.check],collaborationVersion},f.ctx) as Graph;await assert.rejects(f.controller.dispatch('start',{graphId:graph.id,origin:'user'},ctx),denied);f.patch(graph.id,g=>{g.tasks[0].status='completed';g.tasks[0].resultRevision=1;});for(const status of ['created','ready','integrated'] as const){f.patch(graph.id,g=>{g.status=status;});const before=f.retained(graph.id);for(const action of ['prepare','review'])await assert.rejects(f.controller.dispatch(action,{graphId:graph.id},ctx),denied);assert.deepEqual(f.retained(graph.id),before);}zero(f);}finally{await f.close();}
});

test('readonly old contract commands and workflow release are rejected without state changes',async()=>{
  const f=fixture(),ctx={...f.ctx,origin:'plugin' as const};try{const graph=await f.controller.dispatch('create',{goal:'old contract checks',workflowId:'workflow',tasks:[{...task(),workflowHeld:true}],checks:[],contract:{verification:'V2',checks:[f.command]}},f.ctx) as Graph,before=f.retained(graph.id);for(const [action,input] of [['start',{}],['update_task',{taskId:'read',gateOnly:true,workflowHeld:false}],['workflow_skip',{taskId:'read'}]] as [string,JsonObject][])await assert.rejects(f.controller.dispatch(action,{graphId:graph.id,...input},ctx),denied);assert.deepEqual(f.retained(graph.id),before);zero(f);}finally{await f.close();}
});

test('rejected readonly resume preserves UNKNOWN; user still needs explicit confirmation and stopped permission holds',async()=>{
  const f=fixture();try{const graph=await f.controller.dispatch('create',{goal:'unknown old checks',tasks:[task()],checks:[f.check]},f.ctx) as Graph;f.patch(graph.id,g=>{g.status='paused';g.tasks[0].status='unknown';});const before=f.retained(graph.id);await assert.rejects(f.controller.dispatch('resume',{graphId:graph.id,confirmUnknown:true,origin:'user'},{...f.ctx,origin:'agent'}),denied);assert.deepEqual(f.retained(graph.id),before);await assert.rejects(f.controller.dispatch('resume',{graphId:graph.id},f.ctx),/副作用未知/);assert.deepEqual(f.retained(graph.id),before);await assert.rejects(f.controller.dispatch('start',{graphId:graph.id},{...f.ctx,policy:{...f.ctx.policy!,executionStopped:true}}),/停止/);zero(f);}finally{await f.close();}
});

for(const useContract of [false,true])test(`trusted user explicitly preparing readonly ${useContract?'contract':'graph'} command checks actually executes them`,async()=>{
  const f=fixture();try{const graph=await f.controller.dispatch('create',{goal:'user requested check',tasks:[task()],checks:useContract?[]:[f.check],contract:useContract?{checks:[f.command]}:undefined},f.ctx) as Graph;f.patch(graph.id,g=>{g.tasks[0].status='completed';g.tasks[0].resultRevision=1;});await f.controller.dispatch('prepare',{graphId:graph.id},f.ctx);await wait(()=>f.retained(graph.id).value.status==='integrated');const retained=f.retained(graph.id).value;assert.equal(readFileSync(f.marker,'utf8'),'ran\n');assert.equal(retained.integration!.checks[0].exitCode,0);assert.ok(f.processes.length>0);assert.equal(retained.integration!.verification!.status,'passed');}finally{await f.close();}
});

test('agent write graph retains command checks, actual execution and independent review',async()=>{
  const f=fixture(),ctx={...f.ctx,origin:'agent' as const};try{const graph=await f.controller.dispatch('create',{goal:'write with check',tasks:[task('write','write')],checks:[f.check]},ctx) as Graph;f.patch(graph.id,g=>{g.tasks[0].status='completed';g.tasks[0].resultRevision=1;});await f.controller.dispatch('prepare',{graphId:graph.id},ctx);await wait(()=>f.retained(graph.id).value.status==='integrated');const retained=f.retained(graph.id).value;assert.equal(readFileSync(f.marker,'utf8'),'ran\n');assert.equal(retained.integration!.checks[0].exitCode,0);assert.equal(f.starts.length,1);assert.equal(f.starts[0].reviewResult,true);assert.equal(retained.contract!.verification,'V1');assert.equal(retained.integration!.review!.approved,true);}finally{await f.close();}
});

test('automatic preparation and the actual command backstop revalidate old readonly graphs',async()=>{
  const f=fixture(),ctx={...f.ctx,origin:'agent' as const};try{
    const graph=await f.controller.dispatch('create',{goal:'old automatically prepared checks',tasks:[task()],checks:[],contract:{verification:'V2',checks:[f.command]}},f.ctx) as Graph;
    f.patch(graph.id,g=>{g.status='running';g.tasks[0].status='completed';g.tasks[0].resultRevision=1;});
    const internal=f.controller as unknown as {pump(id:string,ctx:PluginContext):Promise<void>;objectiveCheck(id:string,cwd:string,check:typeof f.check,ctx:PluginContext):Promise<unknown>};
    await internal.pump(graph.id,ctx);await wait(()=>f.retained(graph.id).value.status==='paused');assert.match(f.retained(graph.id).value.error!,/只读协作/);zero(f);
    const clean=await f.controller.dispatch('create',{goal:'no persisted check, stale actual parameter',tasks:[task()],checks:[]},ctx) as Graph,before=f.retained(clean.id);
    await assert.rejects(internal.objectiveCheck(clean.id,f.project,f.check,ctx),denied);assert.deepEqual(f.retained(clean.id),before);zero(f);
  }finally{await f.close();}
});

test('trusted user command checks still require temporary-session approval',async()=>{
  const f=fixture();let approvals=0;try{const ctx={...f.ctx,policy:{...f.ctx.policy!,temporaryWriteRoot:f.project,permissionMode:'allPermissions' as const},approvePermission:async()=>{approvals++;return false;}},graph=await f.controller.dispatch('create',{goal:'user check still requires temporary approval',tasks:[task()],checks:[f.check]},ctx) as Graph;f.patch(graph.id,g=>{g.tasks[0].status='completed';g.tasks[0].resultRevision=1;});await f.controller.dispatch('prepare',{graphId:graph.id},ctx);await wait(()=>f.retained(graph.id).value.status==='paused');assert.equal(approvals,1);assert.equal(f.retained(graph.id).value.integration!.checks[0].exitCode,1);zero(f);}finally{await f.close();}
});

test('append rechecks the current contract after asynchronous identity work',async()=>{
  const f=fixture(),agent={...f.ctx,origin:'agent' as const};let release!:()=>void,entered=false;const gate=new Promise<void>(done=>{release=done;});try{
    const graph=await f.controller.dispatch('create',{goal:'concurrent contract change',tasks:[task()],checks:[]},agent) as Graph;
    const ctx={...agent,request:async(plugin:string,action:string,input?:JsonObject,timeout?:number)=>{if(plugin==='runtime'&&action==='task.identity'&&input?.title==='agent-next'){entered=true;await gate;}return agent.request(plugin,action,input,timeout);}};
    const pending=f.controller.dispatch('append',{graphId:graph.id,tasks:[task('agent-next')]},ctx);await wait(()=>entered);
    await f.controller.dispatch('append',{graphId:graph.id,tasks:[task('user-next')],contract:{checks:[f.command]}},f.ctx);const current=f.retained(graph.id);release();await assert.rejects(pending,denied);
    assert.deepEqual(f.retained(graph.id),current);assert.deepEqual(current.value.tasks.map(task=>task.id),['read','user-next']);assert.equal(current.value.contract!.checks[0].kind,'command');zero(f);
  }finally{release();await f.close();}
});

test('task revision rechecks the current command contract after asynchronous repair admission',async()=>{
  const f=fixture(),agent={...f.ctx,origin:'agent' as const};let release!:()=>void,entered=false;const gate=new Promise<void>(done=>{release=done;});try{
    const graph=await f.controller.dispatch('create',{goal:'concurrent revision and contract change',tasks:[task('write','write')],checks:[]},agent) as Graph;
    const ctx={...agent,request:async(plugin:string,action:string,input?:JsonObject,timeout?:number)=>{if(plugin==='runtime'&&action==='task.repair.claimBatch'){entered=true;await gate;}return agent.request(plugin,action,input,timeout);}};
    const pending=f.controller.dispatch('update_task',{graphId:graph.id,taskId:'write',mode:'read',writeScopes:[],reason:'make readonly',repair:true},ctx);await wait(()=>entered);
    await f.controller.dispatch('append',{graphId:graph.id,tasks:[task('user-next')],contract:{checks:[f.command]}},f.ctx);release();await assert.rejects(pending,denied);
    const retained=f.retained(graph.id).value;assert.equal(retained.tasks[0].mode,'write');assert.equal(retained.tasks[0].requirementVersions!.length,1);assert.equal(retained.reworkRound,0);assert.equal(retained.tasks[0].rework,1,'An admitted repair remains charged; policy rejection must not erase the shared allowance');assert.deepEqual(retained.tasks.map(task=>task.id),['write','user-next']);assert.equal(retained.contract!.checks[0].kind,'command');zero(f);
  }finally{release();await f.close();}
});

test('automatic rework cannot restart commands when the last write mode changes during repair admission',async()=>{
  const f=fixture(),agent={...f.ctx,origin:'agent' as const};let release!:()=>void,entered=false;const gate=new Promise<void>(done=>{release=done;});try{
    const graph=await f.controller.dispatch('create',{goal:'write result rejected by reviewer',tasks:[task('write','write')],checks:[f.check]},agent) as Graph;f.patch(graph.id,g=>{g.status='paused';g.tasks[0].status='completed';g.tasks[0].resultRevision=1;});
    const ctx={...agent,request:async(plugin:string,action:string,input?:JsonObject,timeout?:number)=>{if(plugin==='runtime'&&action==='task.repair.claimBatch'){entered=true;await gate;}return agent.request(plugin,action,input,timeout);}},internal=f.controller as unknown as {applyRework(id:string,taskIds:string[],reason:string,ctx:PluginContext):Promise<Graph>};
    const pending=internal.applyRework(graph.id,['write'],'review requested a correction',ctx);await wait(()=>entered);
    await f.controller.dispatch('update_task',{graphId:graph.id,taskId:'write',mode:'read',writeScopes:[],reason:'user narrowed task to readonly'},f.ctx);const before=f.retained(graph.id).value;release();await assert.rejects(pending,denied);
    const retained=f.retained(graph.id).value;assert.equal(retained.status,'paused');assert.equal(retained.tasks[0].mode,'read');assert.equal(retained.reworkRound,before.reworkRound);assert.deepEqual(retained.tasks[0].requirementVersions,before.tasks[0].requirementVersions);assert.equal(retained.tasks[0].rework,1);zero(f);
    const state=f.retained(graph.id);await assert.rejects(internal.applyRework(graph.id,['write'],'another automatic retry',agent),denied);assert.deepEqual(f.retained(graph.id),state);
  }finally{release();await f.close();}
});
