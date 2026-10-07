import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,existsSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {RecordStore,digest,type PluginContext} from '@friend-pi/core';
import {SwarmController,type Graph,type MemberLauncher,type MemberOutput,type MemberStart,type StopObject} from '../src/index.js';
import {SharedMaterials,threeWayLineMerge} from '../src/shared.js';

function fixture(git=false){
  const root=mkdtempSync(join(tmpdir(),'swarm-evolution-')),project=join(root,'project');mkdirSync(project);writeFileSync(join(project,'original.txt'),'original\n');
  if(git){execFileSync('git',['init'],{cwd:project,stdio:'ignore'});execFileSync('git',['add','.'],{cwd:project});execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','-m','baseline'],{cwd:project,stdio:'ignore'});}
  const events:{name:string;data:unknown}[]=[];const ctx:PluginContext={origin:'user',dataDir:join(root,'data'),projectDir:project,projectId:'p',sessionId:'s',modelId:'fixture/test',isIdle:()=>true,history:()=>[],readSource:()=>{throw Error('unused');},complete:async()=>{throw Error('unexpected model merge');},request:async()=>{throw Error('optional plugin absent');},emit:(name,data)=>events.push({name,data}),notify:()=>{},appendEntry:()=>{}};
  return {root,project,ctx,events,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}
const spec=(id:string,dependencies:string[]=[])=>({id,title:id,prompt:`original ${id}`,mode:'read',dependencies,writeScopes:['.']});
const state=(controller:SwarmController,ctx:PluginContext)=>(controller.snapshot(ctx) as {graphs:Graph[];sharedConflicts:{status:string;proposed:string;reason?:string}[]}).graphs[0];
async function wait(check:()=>boolean,timeout=10000){const began=Date.now();while(!check()){if(Date.now()-began>timeout)throw Error('Timed out');await new Promise(done=>setTimeout(done,5));}}
function completing(review:(start:MemberStart)=>Record<string,unknown>){
  const starts:MemberStart[]=[];
  const launcher:MemberLauncher=(start,output,exit)=>{
    starts.push(start);let ended=false;let resolveClose!:(value:StopObject)=>void;const closed=new Promise<StopObject>(done=>{resolveClose=done;});
    const finish=()=>{if(ended)return;ended=true;resolveClose({id:start.attemptId,kind:'member',status:'terminated',exitCode:0});exit(0);};
    const timer=setTimeout(()=>{output({v:1,type:'ready',sessionId:start.attemptId});output({v:1,type:'settled',summary:start.reviewResult?JSON.stringify(review(start)):`result ${start.taskId}`});setTimeout(finish,10);},5);
    return {closed,send:()=>{},stop:()=>{clearTimeout(timer);finish();return closed;}};
  };return {launcher,starts};
}

test('stop waits for objective process and descendant termination before its stopped receipt',async()=>{
  const f=fixture(),worker=completing(()=>({approved:true,findings:'checked'})),controller=new SwarmController(worker.launcher);
  const marker=join(f.project,'started'),late=join(f.project,'late'),childLate=join(f.project,'child-late');
  const descendant=`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(childLate)},'bad'),600)`;
  const script=`require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(late)},'bad'),600)`;
  try{
    const graph=await controller.dispatch('create',{goal:'cancel checks',tasks:[spec('a')],checks:[{command:process.execPath,args:['-e',script]}]},f.ctx) as Graph;await controller.dispatch('start',{graphId:graph.id},f.ctx);await wait(()=>existsSync(marker));
    const stopped=await controller.dispatch('stop',{graphId:graph.id},f.ctx) as Graph;assert.equal(stopped.status,'stopped');assert.ok(stopped.stopReceipt?.objects.some(object=>object.kind==='check'&&object.status==='terminated'));assert.equal(worker.starts.filter(start=>start.reviewResult).length,0);
    await new Promise(done=>setTimeout(done,750));assert.equal(existsSync(late),false);assert.equal(existsSync(childLate),false);assert.equal(state(controller,f.ctx).status,'stopped');
    assert.ok(f.events.some(event=>event.name==='swarm.changed'&&(event.data as {graphs:Graph[]}).graphs[0]?.status==='stopping'));
  }finally{await controller.dispose();f.cleanup();}
});

test('stop cancels an outstanding independent reviewer without adopting a late approval',async()=>{
  const f=fixture();let reviewOutput:((output:MemberOutput)=>void)|undefined,reviewClose!:(value:StopObject)=>void;
  const launcher:MemberLauncher=(start,output,exit)=>{
    if(start.reviewResult){reviewOutput=output;const closed=new Promise<StopObject>(done=>{reviewClose=done;});return {send:()=>{},closed,stop:async()=>{await new Promise(done=>setTimeout(done,30));const receipt:StopObject={id:start.attemptId,kind:'member',status:'terminated',exitCode:0};reviewClose(receipt);exit(0);return receipt;}};}
    const closed=Promise.resolve<StopObject>({id:start.attemptId,kind:'member',status:'terminated',exitCode:0});setTimeout(()=>output({v:1,type:'settled',summary:'done'}),0);return {send:()=>{},closed,stop:()=>closed};
  };const controller=new SwarmController(launcher);
  try{const graph=await controller.dispatch('create',{goal:'review cancel',tasks:[spec('a')]},f.ctx) as Graph;await controller.dispatch('start',{graphId:graph.id},f.ctx);await wait(()=>!!reviewOutput);const stopped=await controller.dispatch('stop',{graphId:graph.id},f.ctx) as Graph;assert.equal(stopped.status,'stopped');reviewOutput!({v:1,type:'settled',summary:'{"approved":true,"findings":"late"}'});await new Promise(done=>setTimeout(done,20));assert.equal(state(controller,f.ctx).status,'stopped');assert.equal(state(controller,f.ctx).integration?.review,undefined);}finally{await controller.dispose();f.cleanup();}
});

test('targeted rejection invalidates only its dependency closure and preserves original requirements',async()=>{
  const f=fixture();let reviews=0;const worker=completing(()=>++reviews===1?{approved:false,findings:'a needs correction',taskIds:['a']}:{approved:true,findings:'corrected evidence'}),controller=new SwarmController(worker.launcher);
  try{const graph=await controller.dispatch('create',{goal:'targeted',tasks:[spec('a'),spec('b'),spec('c',['a']),spec('d',['c'])]},f.ctx) as Graph;await controller.dispatch('start',{graphId:graph.id},f.ctx);await wait(()=>state(controller,f.ctx).status==='integrated');const result=state(controller,f.ctx);assert.equal(result.attempts.filter(attempt=>attempt.taskId==='b').length,1);for(const id of ['a','c','d'])assert.equal(result.attempts.filter(attempt=>attempt.taskId===id).length,2);assert.equal(result.tasks[0].prompt,'original a');assert.equal(result.tasks[0].originalPrompt,'original a');assert.equal(result.tasks[0].requirementVersions?.length,2);assert.deepEqual(result.attempts.filter(attempt=>attempt.taskId==='a').map(attempt=>attempt.requirementVersion),[1,2]);}finally{await controller.dispose();f.cleanup();}
});

test('unattributed review rejection pauses without replaying any member',async()=>{
  const f=fixture(),worker=completing(()=>({approved:false,findings:'ambiguous integration finding'})),controller=new SwarmController(worker.launcher);
  try{const graph=await controller.dispatch('create',{goal:'ambiguous',tasks:[spec('a'),spec('b')]},f.ctx) as Graph;await controller.dispatch('start',{graphId:graph.id},f.ctx);await wait(()=>state(controller,f.ctx).status==='paused');assert.equal(state(controller,f.ctx).reworkRound,0);assert.equal(state(controller,f.ctx).attempts.length,2);assert.match(state(controller,f.ctx).error!,/未明确/);}finally{await controller.dispose();f.cleanup();}
});

test('an invalid explicit expert fails before member launch; errors are not converted to basic roles',async()=>{
  const f=fixture(),worker=completing(()=>({approved:true,findings:'checked'})),controller=new SwarmController(worker.launcher);f.ctx.request=async()=>({hash:'catalog',experts:[{id:'valid',title:'valid',prompt:'method',tools:[],skills:[],skillContents:[],version:1,hash:'v1'}],selectionMode:'auto',selectedIds:[]});
  try{const graph=await controller.dispatch('create',{goal:'explicit error',tasks:[{...spec('a'),expertId:'missing'}]},f.ctx) as Graph;await assert.rejects(controller.dispatch('start',{graphId:graph.id},f.ctx),/明确专家/);assert.equal(worker.starts.length,0);assert.equal(state(controller,f.ctx).status,'created');f.ctx.request=async()=>{throw Error('Expert 冻结响应损坏');};await assert.rejects(controller.dispatch('start',{graphId:graph.id},f.ctx),/损坏/);}finally{await controller.dispose();f.cleanup();}
});

test('shared events expose committed revisions to another connection; notification failure does not undo a save',async()=>{
  const f=fixture(),controller=new SwarmController();const graph=await controller.dispatch('create',{goal:'committed events',tasks:[spec('a')]},f.ctx) as Graph;const second=new RecordStore('swarm',f.ctx.dataDir);const seen:number[]=[];
  f.ctx.emit=(name,data)=>{if(name==='swarm.shared.changed'){const event=data as {revision:number;digest:string};const row=second.get<{digest:string}>(`shared:${graph.id}:notes`)!;assert.equal(row.revision,event.revision);assert.equal(row.value.digest,event.digest);seen.push(row.revision);throw Error('lost observer');}};
  try{const saved=await controller.dispatch('shared.write',{graphId:graph.id,name:'notes',content:'v1',expectedRevision:0},f.ctx) as {version:number};assert.equal(saved.version,1);assert.deepEqual(seen,[1]);assert.equal(second.get(`shared:${graph.id}:notes`)?.revision,1);}finally{second.close();await controller.dispose();f.cleanup();}
});

test('shared competing nonoverlap edits automatically merge from a verified common version and survive retry',async()=>{
  const f=fixture(),first=new SwarmController(),second=new SwarmController();
  try{const graph=await first.dispatch('create',{goal:'merge shared',tasks:[spec('a')]},f.ctx) as Graph;const base='alpha\nbeta\ngamma\n';await first.dispatch('shared.write',{graphId:graph.id,name:'notes',content:base,expectedRevision:0},f.ctx);await second.dispatch('shared.write',{graphId:graph.id,name:'notes',content:'alpha A\nbeta\ngamma\n',expectedRevision:1},f.ctx);
    const input={graphId:graph.id,name:'notes',content:'alpha\nbeta\ngamma B\n',expectedRevision:1,baseRevision:1,baseDigest:digest(base),operationId:'merge-one'};const merged=await first.dispatch('shared.write',input,f.ctx) as {content:string;version:number;merged:boolean;file:string};assert.equal(merged.content,'alpha A\nbeta\ngamma B\n');assert.equal(merged.version,3);assert.equal(merged.merged,true);assert.equal(readFileSync(merged.file,'utf8'),merged.content);assert.deepEqual(await first.dispatch('shared.write',input,f.ctx),merged);assert.equal((await first.dispatch('shared.readVersion',{graphId:graph.id,name:'notes',revision:1},f.ctx) as {content:string}).content,base);
  }finally{await first.dispose();await second.dispose();f.cleanup();}
});

test('a conflicting constraint or missing base is retained and never picked by model guessing',async()=>{
  const f=fixture(),controller=new SwarmController();
  try{const graph=await controller.dispatch('create',{goal:'constraints',tasks:[spec('a')]},f.ctx) as Graph;const base='必须保留 30 天\n';await controller.dispatch('shared.write',{graphId:graph.id,name:'policy',content:base,expectedRevision:0},f.ctx);await controller.dispatch('shared.write',{graphId:graph.id,name:'policy',content:'必须保留 60 天\n',expectedRevision:1},f.ctx);
    await assert.rejects(controller.dispatch('shared.write',{graphId:graph.id,name:'policy',content:'必须保留 90 天\n',expectedRevision:1,baseDigest:digest(base)},f.ctx),/约束/);const conflicts=await controller.dispatch('shared.conflicts',{graphId:graph.id},f.ctx) as {status:string;proposed:string}[];assert.equal(conflicts[0].status,'paused');assert.equal(conflicts[0].proposed,'必须保留 90 天\n');assert.equal((await controller.dispatch('shared.read',{graphId:graph.id,name:'policy'},f.ctx) as {content:string}).content,'必须保留 60 天\n');
    await assert.rejects(controller.dispatch('shared.write',{graphId:graph.id,name:'policy',content:'old draft',expectedRevision:1},f.ctx),/共同版本/);
  }finally{await controller.dispose();f.cleanup();}
});

test('shared overlap model merge uses all three digests; unresolved, cancelled or repeatedly racing merges remain retained',async()=>{
  const f=fixture(),controller=new SwarmController();let calls=0;
  try{const graph=await controller.dispatch('create',{goal:'soft overlap',tasks:[spec('a')]},f.ctx) as Graph;const base='Summary: base\n';await controller.dispatch('shared.write',{graphId:graph.id,name:'summary',content:base,expectedRevision:0},f.ctx);await controller.dispatch('shared.write',{graphId:graph.id,name:'summary',content:'Summary: A\n',expectedRevision:1},f.ctx);
    f.ctx.complete=async prompt=>{calls++;const value=JSON.parse(prompt.slice(prompt.indexOf('\n')+1));return JSON.stringify({decision:'merge',content:'Summary: A and B\n',reason:'combine descriptive contributions',sources:value.sources});};
    const result=await controller.dispatch('shared.write',{graphId:graph.id,name:'summary',content:'Summary: B\n',expectedRevision:1,baseDigest:digest(base)},f.ctx) as {content:string};assert.equal(result.content,'Summary: A and B\n');assert.equal(calls,1);
    f.ctx.complete=async()=>JSON.stringify({decision:'pause',reason:'facts conflict'});await assert.rejects(controller.dispatch('shared.write',{graphId:graph.id,name:'summary',content:'Summary: C\n',expectedRevision:1,baseDigest:digest(base)},f.ctx),/facts conflict/);
    const abort=new AbortController();let entered=false;f.ctx.complete=async(_prompt,{signal}={})=>{entered=true;await new Promise<void>(done=>signal?.addEventListener('abort',()=>done(),{once:true}));return '{}';};const pending=controller.dispatch('shared.write',{graphId:graph.id,name:'summary',content:'Summary: D\n',expectedRevision:1,baseDigest:digest(base)},{...f.ctx,signal:abort.signal});await wait(()=>entered);abort.abort();await assert.rejects(pending,/取消/);const conflicts=await controller.dispatch('shared.conflicts',{graphId:graph.id},f.ctx) as {status:string}[];assert.ok(conflicts.some(conflict=>conflict.status==='cancelled'));
  }finally{await controller.dispose();f.cleanup();}
});

test('three-way merging preserves additions, removals, empty documents and rejects overlapping replacements',()=>{
  assert.equal(threeWayLineMerge('a\nb\nc\n','a\nb\n','A\nb\nc\n').content,'A\nb\n');assert.equal(threeWayLineMerge('','a\n','a\n').content,'a\n');assert.equal(threeWayLineMerge('a\n','a\n','').content,'');assert.equal(threeWayLineMerge('a\n','A\n','B\n').overlap,true);
});

test('failed commit never emits a shared version and retry cannot expose its uncommitted file',async()=>{
  const f=fixture(),store=new RecordStore('swarm',f.ctx.dataDir),materials=new SharedMaterials(store,()=>{});const original=store.db.exec.bind(store.db);let fail=true;store.db.exec=(sql:string)=>{if(sql==='COMMIT'&&fail){fail=false;throw Error('injected commit failure');}return original(sql);};
  try{await assert.rejects(materials.write('g',{name:'notes',content:'uncommitted',expectedRevision:0},f.ctx),/commit failure/);assert.equal(materials.version('g','notes',1),undefined);assert.equal(f.events.some(event=>event.name==='swarm.shared.changed'),false);const saved=await materials.write('g',{name:'notes',content:'committed',expectedRevision:0},f.ctx);assert.equal(saved.version,1);assert.equal(materials.version('g','notes',1)?.content,'committed');assert.equal(readFileSync(saved.file,'utf8'),'committed');assert.equal(f.events.filter(event=>event.name==='swarm.shared.changed').length,1);}finally{store.close();f.cleanup();}
});

test('shared model merge stops after two lost CAS attempts and retains every side of the conflict',async()=>{
  const f=fixture(),first=new SwarmController(),other=new SwarmController();let calls=0;
  try{const graph=await first.dispatch('create',{goal:'bounded shared merge',tasks:[spec('a')]},f.ctx) as Graph;const base='Summary: base\n';await first.dispatch('shared.write',{graphId:graph.id,name:'notes',content:base,expectedRevision:0},f.ctx);await other.dispatch('shared.write',{graphId:graph.id,name:'notes',content:'Summary: A\n',expectedRevision:1},f.ctx);
    f.ctx.complete=async prompt=>{const source=JSON.parse(prompt.slice(prompt.indexOf('\n')+1));calls++;const latest=await other.dispatch('shared.read',{graphId:graph.id,name:'notes'},f.ctx) as {revision:number};await other.dispatch('shared.write',{graphId:graph.id,name:'notes',content:`Summary: racing ${calls}\n`,expectedRevision:latest.revision},f.ctx);return JSON.stringify({decision:'merge',content:'Summary: A and B\n',reason:'combine narrative',sources:source.sources});};
    await assert.rejects(first.dispatch('shared.write',{graphId:graph.id,name:'notes',content:'Summary: B\n',expectedRevision:1,baseDigest:digest(base)},f.ctx),/重试上限/);assert.equal(calls,2);const conflicts=await first.dispatch('shared.conflicts',{graphId:graph.id},f.ctx) as {status:string;proposed:string;base:{content:string};latest:{content:string}}[];assert.equal(conflicts[0].status,'paused');assert.equal(conflicts[0].proposed,'Summary: B\n');assert.equal(conflicts[0].base.content,base);assert.equal((await first.dispatch('shared.read',{graphId:graph.id,name:'notes'},f.ctx) as {content:string}).content,'Summary: racing 2\n');
  }finally{await first.dispose();await other.dispose();f.cleanup();}
});

test('stop during worktree creation cancels its owned process and retains the intended isolation path',async()=>{
  const f=fixture(true),worker=completing(()=>({approved:true,findings:'checked'})),controller=new SwarmController(worker.launcher);const bin=join(f.root,'bin'),marker=join(f.root,'isolation-started'),late=join(f.root,'isolation-late'),realGit=execFileSync('which',['git'],{encoding:'utf8'}).trim();mkdirSync(bin);
  const wrapper=`#!${process.execPath}\nconst args=process.argv.slice(2);if(args[0]==='worktree'&&args[1]==='add'){require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(late)},'bad'),600);}else{const result=require('node:child_process').spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(result.status??1);}\n`;writeFileSync(join(bin,'git'),wrapper,{mode:0o755});const previous=process.env.PATH;process.env.PATH=`${bin}:${previous||''}`;
  try{const graph=await controller.dispatch('create',{goal:'cancel isolation',tasks:[{...spec('a'),mode:'write'}]},f.ctx) as Graph;await controller.dispatch('start',{graphId:graph.id},f.ctx);await wait(()=>existsSync(marker));const stopped=await controller.dispatch('stop',{graphId:graph.id},f.ctx) as Graph;assert.equal(stopped.status,'stopped');assert.equal(stopped.attempts[0].status,'unknown');assert.notEqual(stopped.attempts[0].cwd,f.project);assert.ok(stopped.attempts[0].cwd.includes(stopped.attempts[0].id));assert.equal(worker.starts.length,0);await new Promise(done=>setTimeout(done,750));assert.equal(existsSync(late),false);assert.equal(readFileSync(join(f.project,'original.txt'),'utf8'),'original\n');}finally{if(previous===undefined)delete process.env.PATH;else process.env.PATH=previous;await controller.dispose();f.cleanup();}
});

test('cold interrupted stop becomes unknown paused and a live foreign owner cannot be reported stopped',async()=>{
  const f=fixture(),first=new SwarmController();
  try{const graph=await first.dispatch('create',{goal:'recover stop',tasks:[spec('a')]},f.ctx) as Graph;const store=new RecordStore('swarm',f.ctx.dataDir),row=store.get<Graph>(`graph:p:${graph.id}`)!;row.value.status='stopping';row.value.executionOwner={pid:2147483647,runtime:'vanished'};store.put(row.key,row.value,row.revision);store.close();const recovered=new SwarmController();try{const value=state(recovered,f.ctx);assert.equal(value.status,'paused');assert.equal(value.stopReceipt?.objects[0].status,'unknown');const live=new RecordStore('swarm',f.ctx.dataDir),current=live.get<Graph>(`graph:p:${graph.id}`)!;current.value.status='running';current.value.stopReceipt=undefined;current.value.executionOwner={pid:process.pid,runtime:'other-runtime'};live.put(current.key,current.value,current.revision);live.close();await assert.rejects(recovered.dispatch('stop',{graphId:graph.id},f.ctx),/另一个存活运行时/);assert.equal(state(recovered,f.ctx).status,'running');}finally{await recovered.dispose();}}finally{await first.dispose();f.cleanup();}
});

test('an unresolved shared constraint pauses the active graph and waits for member termination',async()=>{
  const f=fixture();let starts=0,finish!:(receipt:StopObject)=>void;
  const launcher:MemberLauncher=(start,output,exit)=>{starts++;const closed=new Promise<StopObject>(done=>{finish=done;});setTimeout(()=>output({v:1,type:'ready',sessionId:start.attemptId}),0);return {closed,send:()=>{},stop:async()=>{const receipt:StopObject={id:start.attemptId,kind:'member',status:'terminated',exitCode:0};finish(receipt);exit(0);return receipt;}};};const controller=new SwarmController(launcher);
  try{const graph=await controller.dispatch('create',{goal:'shared constraint stop',tasks:[spec('a')]},f.ctx) as Graph;const base='必须使用 Node 24\n';await controller.dispatch('shared.write',{graphId:graph.id,name:'policy',content:base,expectedRevision:0},f.ctx);await controller.dispatch('shared.write',{graphId:graph.id,name:'policy',content:'必须使用 Node 22\n',expectedRevision:1},f.ctx);await controller.dispatch('start',{graphId:graph.id},f.ctx);await wait(()=>starts===1);
    await assert.rejects(controller.dispatch('shared.write',{graphId:graph.id,name:'policy',content:'必须使用 Node 20\n',expectedRevision:1,baseDigest:digest(base)},{...f.ctx,origin:'plugin'}),/约束/);await wait(()=>state(controller,f.ctx).status==='paused');assert.equal(state(controller,f.ctx).attempts[0].status,'unknown');assert.ok(state(controller,f.ctx).stopReceipt?.objects.every(receipt=>receipt.status==='terminated'));assert.match(state(controller,f.ctx).error!,/版本冲突/);assert.equal((await controller.dispatch('shared.read',{graphId:graph.id,name:'policy'},f.ctx) as {content:string}).content,'必须使用 Node 22\n');
  }finally{await controller.dispose();f.cleanup();}
});
