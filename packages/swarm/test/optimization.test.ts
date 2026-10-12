import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,existsSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {CapabilityError,RuntimeCapabilityServices,TaskLedger,RecordStore,digest,type PluginContext} from '@friend-pi/core';
import {SwarmController,type Graph,type MemberStart,type MemberLauncher} from '../src/index.js';
import {prepareHandoff,readHandoff,HandoffReadCoverage} from '../src/handoff.js';
import {SwarmStorage} from '../src/storage.js';

const task=(id:string,mode:'read'|'write'='read',dependencies:string[]=[])=>({id,title:id,prompt:id,mode,dependencies,writeScopes:mode==='write'?[`${id}.txt`]:[]});
function fixture(){const root=mkdtempSync(join(tmpdir(),'swarm-opt-')),project=join(root,'project'),data=join(root,'data');mkdirSync(project);writeFileSync(join(project,'original.txt'),'original');const services=new RuntimeCapabilityServices(data),ledger=new TaskLedger(data);const starts:MemberStart[]=[];
  const ctx:PluginContext={origin:'user',executionMode:'swarm',dataDir:data,projectDir:project,projectId:'p',sessionId:'s',runId:'run',modelId:'fake/default',thinkingLevel:'off',agentDir:join(root,'agent'),isIdle:()=>true,history:()=>[],readSource:()=>{throw new Error('unused');},complete:async()=>{throw new Error('unexpected model');},request:async(plugin,action,input)=>{if(plugin==='runtime'&&action==='task.identity')return ledger.resolveIdentity(input||{},ctx);if(plugin==='runtime')return services.dispatch(action,input||{},ctx);throw new CapabilityError('CAPABILITY_UNAVAILABLE','optional plugin absent');},emit:()=>{},notify:()=>{},appendEntry:()=>{},policy:{v:1,revision:1,stage:'main',unsettledTools:0,canSwitchRole:false,tools:['read','write','edit','bash'],writeScopes:['.'],executionMode:'swarm',planMode:false}};
  const launch:MemberLauncher=(start,_output,exited)=>{starts.push(start);return {send(){},async stop(){exited(0);return {id:start.attemptId,kind:'member' as const,status:'terminated' as const,exitCode:0};}};};
  const controller=new SwarmController(launch);return {root,project,ctx,starts,controller,services,async close(){await controller.dispose();ledger.dispose();services.dispose();rmSync(root,{recursive:true,force:true});}};
}
async function wait(check:()=>boolean,timeout=3000){const at=Date.now();while(!check()){if(Date.now()-at>timeout)throw new Error('timed out');await new Promise(r=>setTimeout(r,5));}}
const graph=(f:ReturnType<typeof fixture>)=>(f.controller.snapshot(f.ctx) as {graphs:Graph[]}).graphs[0];

test('plan validation is read only, validates permissions/dependencies and keeps direct completion inside selected Swarm',async()=>{const f=fixture();try{
  const before=readFileSync(join(f.ctx.dataDir,'plugins.sqlite'));
  const result=await f.controller.dispatch('plan.validate',{goal:'small readonly question',strategy:'direct',tasks:[],reason:'one direct answer; no delegation needed',risk:'low',checks:[]},f.ctx) as {valid:boolean;mode:string;strategy:string;budget:{estimatesKnown:boolean}};
  assert.equal(result.valid,true);assert.equal(result.mode,'swarm');assert.equal(result.strategy,'direct');assert.equal(result.budget.estimatesKnown,false);assert.deepEqual(f.starts,[]);assert.deepEqual(before,readFileSync(join(f.ctx.dataDir,'plugins.sqlite')));
  const records=new RecordStore('swarm',f.ctx.dataDir);assert.equal(records.list('graph:').length,0);records.close();
  await assert.rejects(f.controller.dispatch('plan.validate',{goal:'x',reason:'x',tasks:[task('a','write'),{...task('b','write'),writeScopes:['a.txt']}]},f.ctx),/范围重叠/);
  await assert.rejects(f.controller.dispatch('plan.validate',{goal:'x',reason:'x',tasks:[task('a','read',['missing'])]},f.ctx),/不存在/);
  await assert.rejects(f.controller.dispatch('create',{goal:'x'}, {...f.ctx,executionMode:'single',policy:{...f.ctx.policy!,executionMode:'single'}}),/不能启动/);
}finally{await f.close();}});

test('safe busy resource waits locally, independent ready task launches, and original order retries after release',async()=>{const f=fixture();const held=f.services.dispatch('resource.reserve',{graphId:'other',taskId:'other',attemptId:'old',generation:1,resources:[{kind:'path',key:'a.txt',access:'write'}]},f.ctx) as {reservationId:string};try{
  const g=await f.controller.dispatch('create',{goal:'local wait',tasks:[task('a','write'),task('b'),task('c','read',['a'])],maxWorkers:2,deferPreparation:true},f.ctx) as Graph;
  await f.controller.dispatch('start',{graphId:g.id},f.ctx);await wait(()=>f.starts.length===1);
  assert.equal(f.starts[0].taskId,'b');assert.equal(graph(f).status,'running');assert.equal(graph(f).tasks[0].waiting?.kind,'resource');assert.equal(graph(f).tasks[2].waiting?.kind,'dependency');assert.equal(graph(f).attempts.some(a=>a.taskId==='a'),false);
  f.services.dispatch('resource.release',{reservationId:held.reservationId},f.ctx);await wait(()=>f.starts.length===2);assert.equal(f.starts[1].taskId,'a');assert.equal(graph(f).tasks[0].waiting,undefined);assert.equal(graph(f).tasks[2].status,'pending');
}finally{await f.close();}});

test('unknown resource state and untrusted conflict never turn into local waiting',async()=>{for(const error of [new CapabilityError('OPERATION_UNKNOWN','unknown lease',{waitSafe:true}),new CapabilityError('VERSION_CONFLICT','unclassified conflict')]){const f=fixture();const request=f.ctx.request;f.ctx.request=async(plugin,action,input,timeout)=>{if(plugin==='runtime'&&action==='resource.reserve')throw error;return request(plugin,action,input,timeout);};try{const g=await f.controller.dispatch('create',{goal:'unknown must pause',tasks:[task('a','write'),task('b')]},f.ctx) as Graph;await f.controller.dispatch('start',{graphId:g.id},f.ctx);await wait(()=>graph(f).status==='paused');assert.equal(f.starts.length,0);assert.equal(graph(f).pauseReason?.code,error.code);}finally{await f.close();}}});

test('resume preview is read only and stale bindings cannot change task state',async()=>{const f=fixture();try{
  const g=await f.controller.dispatch('create',{goal:'preview',tasks:[task('a')]},f.ctx) as Graph;
  const store=new RecordStore('swarm',f.ctx.dataDir);const before=store.get(`graph:p:${g.id}`),preview=await f.controller.dispatch('resume.preview',{graphId:g.id},f.ctx) as {binding:string;nodes:{decision:string}[]};assert.equal(preview.nodes[0].decision,'redo');assert.deepEqual(store.get(`graph:p:${g.id}`),before);
  await f.controller.dispatch('configure',{graphId:g.id,maxWorkers:2},f.ctx);await assert.rejects(f.controller.dispatch('resume',{graphId:g.id,previewBinding:preview.binding},f.ctx),e=>e instanceof CapabilityError&&e.code==='VERSION_CONFLICT');assert.equal(f.starts.length,0);assert.equal(graph(f).status,'created');store.close();
}finally{await f.close();}});
test('cold recovery preview reports vanished owners without persisting startup recovery or consuming retry state',async()=>{const f=fixture(),cold=new SwarmController();try{
  const g=await f.controller.dispatch('create',{goal:'cold preview',tasks:[task('a')]},f.ctx) as Graph,store=new RecordStore('swarm',f.ctx.dataDir),record=store.get<Graph>(`graph:p:${g.id}`)!;record.value.status='running';record.value.tasks[0].status='running';record.value.tasks[0].currentAttempt='interrupted';record.value.attempts=[{id:'interrupted',taskId:'a',status:'running',ownerPid:2147483646,number:1,resultRevision:1,cwd:f.project,mode:'read',ownerRuntime:'lost',startedAt:new Date().toISOString(),writeScopes:[]}];store.put(record.key,record.value,record.revision);const before=store.get(record.key);
  const preview=await cold.dispatch('resume.preview',{graphId:g.id,expectedRevision:before!.revision},f.ctx) as {nodes:{decision:string;reasons:string[]}[]};assert.equal(preview.nodes[0].decision,'check');assert.match(preview.nodes[0].reasons.join(','),/副作用未知/);assert.deepEqual(store.get(record.key),before);store.close();
}finally{await cold.dispose();await f.close();}});

test('oversized structured handoff preserves full constraints and exact refs; all contiguous bytes are required across reopen',()=>{const root=mkdtempSync(join(tmpdir(),'swarm-handoff-'));let store=new RecordStore('swarm',root);try{
  new SwarmStorage(store);const constraints=['C'.repeat(9000)+'CONSTRAINT_TAIL'],g={id:'g',goal:'goal',tasks:[],attempts:[],sourceFence:{sources:[{sessionId:'source',entryId:'entry',hash:'source-hash'}]},contract:{acceptance:['accept'],forbiddenEffects:['forbidden']}} as unknown as Graph,t={...task('a'),constraints,unresolved:['question'],status:'pending',resultRevision:0} as Graph['tasks'][number];g.tasks=[t];const a={id:'attempt',taskId:'a',frozen:{memoryRefs:[{capability:'memory',id:'m',version:7,hash:'mh',relation:'adopted'}],expertRefs:[],skillRefs:[{id:'skill',version:2,hash:'sh'}]}} as unknown as Graph['attempts'][number];
  const handoff=prepareHandoff(store,g,t,a,[]);assert.ok(handoff.required);assert.ok(handoff.prompt.length<8000);assert.match(handoff.prompt,/未截断/);store.close();store=new RecordStore('swarm',root);const coverage=new HandoffReadCoverage(handoff.required!);
  const tail=readHandoff(store,'g',handoff.required!,8000);assert.throws(()=>coverage.accept(tail),/连续覆盖/);assert.equal(coverage.complete,false);
  let body='';while(!coverage.complete){const read=readHandoff(store,'g',handoff.required!,coverage.next());coverage.accept(read);body+=read.content;}
  assert.equal(digest(body),handoff.required!.hash);const parsed=JSON.parse(body);assert.deepEqual(parsed.constraints,[...constraints,'accept','forbidden']);assert.equal(parsed.memoryRefs[0].version,7);assert.equal(parsed.skillRefs[0].version,2);assert.equal(parsed.sources[0].entryId,'entry');assert.throws(()=>readHandoff(store,'g',{...handoff.required!,hash:'bad'},0),/摘要/);
}finally{store.close();rmSync(root,{recursive:true,force:true});}});

test('v4 upgrade snapshots v3 durable state once and fences older writers from new handoff/wait fields',()=>{const root=mkdtempSync(join(tmpdir(),'swarm-writer-')),store=new RecordStore('swarm',root);let legacy:DatabaseSync|undefined;try{
  store.db.exec('CREATE TABLE swarm_schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL,source_digest TEXT NOT NULL); INSERT INTO swarm_schema_migrations VALUES(3,\'old\',\'v3\')');store.put('graph:p:g',{waiting:{kind:'resource'}});new SwarmStorage(store);assert.equal(readdirSync(root).filter(name=>name.startsWith('swarm-pre-v4-')).length,1);new SwarmStorage(store);assert.equal(readdirSync(root).filter(name=>name.startsWith('swarm-pre-v4-')).length,1);
  legacy=new DatabaseSync(join(root,'plugins.sqlite'));legacy.function('friend_pi_writer_version',()=>3);assert.throws(()=>legacy!.prepare("UPDATE documents SET json='{}' WHERE namespace='swarm'").run(),/newer writer/);assert.equal(store.get<{waiting:{kind:string}}>('graph:p:g')!.value.waiting.kind,'resource');
}finally{legacy?.close();store.close();rmSync(root,{recursive:true,force:true});}});
test('controlled handoff ranges preserve a Unicode character at the default boundary',()=>{const root=mkdtempSync(join(tmpdir(),'swarm-handoff-unicode-')),store=new RecordStore('swarm',root);try{
  const content='A'.repeat(7999)+'😀TAIL',ref={id:'unicode',version:1 as const,hash:digest(content),length:content.length,mustRead:true as const};store.put('handoff:g:unicode:1',{ref,content},null);const coverage=new HandoffReadCoverage(ref),first=readHandoff(store,'g',ref,0);assert.equal(first.end,7999);coverage.accept(first);const rest=readHandoff(store,'g',ref,coverage.next());assert.equal(rest.content,'😀TAIL');coverage.accept(rest);assert.equal(coverage.complete,true);assert.equal(first.content+rest.content,content);
}finally{store.close();rmSync(root,{recursive:true,force:true});}});
