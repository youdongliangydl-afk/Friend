import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject, PluginContext } from '@friend-pi/core';
import { DynamicWorkflowController, evaluateWorkflowPredicate, validateWorkflowDefinition, type WorkflowBackend, type WorkflowRun, type WorkflowTemplate } from '../src/workflow.js';
import { workflowCodeDigest } from '../src/workflow-code.js';
import { SwarmController } from '../src/index.js';
import type { Graph, MemberLauncher, MemberOutput, StopObject } from '../src/types.js';

interface StubTask extends JsonObject {id:string;status:string;dependencies:string[];currentAttempt?:string;resultRevision:number;rework:number}
interface StubAttempt {id:string;taskId:string;status:string;summary?:string}
class Backend implements WorkflowBackend {
  graph:{id:string;status:string;tasks:StubTask[];attempts:StubAttempt[];error?:string}|undefined;
  calls:{action:string;input:JsonObject}[]=[];
  dispatch(action:string,input:JsonObject):unknown {
    this.calls.push({action,input:structuredClone(input)});
    if(action==='snapshot')return {graphs:this.graph?[structuredClone(this.graph)]:[]};
    if(action==='create'){this.graph={id:'real-swarm-graph',status:'created',tasks:(input.tasks as JsonObject[]).map(task=>({...task,id:String(task.id),dependencies:task.dependencies as string[],status:'pending',resultRevision:0,rework:0})),attempts:[]};return structuredClone(this.graph);}
    const graph=this.graph!;
    if(action==='append'){graph.tasks.push(...(input.tasks as JsonObject[]).map(task=>({...task,id:String(task.id),dependencies:task.dependencies as string[],status:'pending',resultRevision:0,rework:0})));graph.status='running';}
    if(action==='start'||action==='resume'){
      graph.status='running';for(const task of graph.tasks.filter(item=>item.status==='pending'&&!item.workflowHeld&&item.dependencies.every(dep=>['completed','skipped'].includes(graph.tasks.find(other=>other.id===dep)?.status||'')))){task.status='running';task.currentAttempt=`attempt-${graph.attempts.length+1}`;graph.attempts.push({id:task.currentAttempt,taskId:task.id,status:'running'});}
    }
    if(action==='pause'||action==='stop'){graph.status='paused';for(const task of graph.tasks.filter(item=>item.status==='running')){task.status='unknown';graph.attempts.find(attempt=>attempt.id===task.currentAttempt)!.status='unknown';}}
    if(action==='prepare')graph.status='awaiting_review';
    if(action==='workflow_skip')graph.tasks.find(task=>task.id===input.taskId)!.status='skipped';
    if(action==='update_task'&&input.gateOnly===true)graph.tasks.find(task=>task.id===input.taskId)!.workflowHeld=input.workflowHeld;
    if(action==='update_task'&&input.gateOnly!==true){
      const changed=new Set([String(input.taskId)]);let grew=true;while(grew){grew=false;for(const task of graph.tasks)if(!changed.has(task.id)&&task.dependencies.some(dep=>changed.has(dep))){changed.add(task.id);grew=true;}}
      for(const task of graph.tasks.filter(item=>changed.has(item.id))){if(input.repair===true&&task.rework>=2)throw new Error('累计重试额度耗尽');task.status='pending';task.currentAttempt=undefined;task.workflowHeld=true;if(input.repair===true)task.rework++;}
      Object.assign(graph.tasks.find(task=>task.id===input.taskId)!,{prompt:input.prompt});graph.status='paused';
    }
    return structuredClone(graph);
  }
  complete(taskId:string,result:unknown):void {const task=this.graph!.tasks.find(item=>item.id===taskId)!;assert.equal(task.status,'running');task.status='completed';task.resultRevision++;const attempt=this.graph!.attempts.find(item=>item.id===task.currentAttempt)!;attempt.status='completed';attempt.summary=typeof result==='string'?result:JSON.stringify(result);if(this.graph!.tasks.every(item=>item.status==='completed'))this.graph!.status='completed';}
  fail(taskId:string):void {const task=this.graph!.tasks.find(item=>item.id===taskId)!;task.status='blocked';this.graph!.attempts.find(item=>item.id===task.currentAttempt)!.status='failed';this.graph!.status='paused';this.graph!.error='provider failed';}
}
function fixture(){const root=mkdtempSync(join(tmpdir(),'friend-workflow-')),project=join(root,'project');mkdirSync(project);writeFileSync(join(project,'a.txt'),'a');writeFileSync(join(project,'b.txt'),'b');writeFileSync(join(project,'other.txt'),'unrelated');const backend=new Backend();const controller=new DynamicWorkflowController(backend);
  const context:PluginContext&{executionMode:'swarm'}={executionMode:'swarm',origin:'user',dataDir:join(root,'data'),projectDir:project,projectId:'project',sessionId:'session',modelId:'fake/default',thinkingLevel:'high',isIdle:()=>true,history:()=>[],readSource:()=>{throw new Error('unused');},complete:async()=>{throw new Error('must not execute own model');},request:async()=>{throw new Error('unused');},emit:()=>{},notify:()=>{},appendEntry:()=>{}};
  return {root,project,backend,controller,context,cleanup:async()=>{await controller.dispose();rmSync(root,{recursive:true,force:true});}};
}
const node=(id:string,dependencies:string[]=[],extra:JsonObject={})=>({id,title:id,prompt:'Inspect {{args.target}}',mode:'read',writeScopes:[],codePaths:[`${id}.txt`],dependencies,...extra});
const definition=(nodes:JsonObject[],extra:JsonObject={})=>({v:1,title:'Scoped investigation',goal:'Same objective',parameters:{target:'the implementation'},nodes,...extra});
const current=(f:ReturnType<typeof fixture>)=>f.controller.snapshot(f.context).workflows[0];
async function start(f:ReturnType<typeof fixture>,nodes:JsonObject[],extra:JsonObject={}){const run=await f.controller.dispatch('create',{definition:definition(nodes,extra)},f.context) as WorkflowRun;await f.controller.dispatch('start',{workflowId:run.id},f.context);return run.id;}

test('validates finite structured definitions and refuses Single/Team execution',async()=>{const f=fixture();try{
  assert.throws(()=>validateWorkflowDefinition(definition([node('a',['b']),node('b',['a'])])),/循环/);
  assert.throws(()=>validateWorkflowDefinition(definition([node('a'),node('a')])),/重复/);
  assert.throws(()=>validateWorkflowDefinition(definition([node('a',[],{when:'eval(code)'})])),/对象/);
  assert.throws(()=>validateWorkflowDefinition(definition([node('a')],{maxWorkers:17})),/并发/);
  assert.throws(()=>validateWorkflowDefinition(definition(Array.from({length:65},(_,i)=>node(`n${i}`)))),/累计节点/);
  assert.throws(()=>validateWorkflowDefinition(definition([node('a',[],{inputs:{unsafe:()=>true}})])),/JSON/);
  await assert.rejects(f.controller.dispatch('create',{definition:definition([node('a')])},{...f.context,executionMode:'single'} as PluginContext),/仅在 Swarm/);
  assert.equal(f.backend.calls.length,0);
}finally{await f.cleanup();}});
test('template versions are immutable snapshots and parameters are resolved without eval',async()=>{const f=fixture();try{
  const first=await f.controller.dispatch('template.save',{templateId:'audit',definition:definition([node('a')])},f.context) as WorkflowTemplate;
  await f.controller.dispatch('template.save',{templateId:'audit',definition:definition([node('b')])},f.context);
  const retained=await f.controller.dispatch('template.read',{templateId:'audit',version:1},f.context) as WorkflowTemplate;assert.equal(retained.hash,first.hash);assert.equal(retained.definition.nodes[0].id,'a');
  const run=await f.controller.dispatch('create',{templateId:'audit',version:1,parameters:{target:'specific code'}},f.context) as WorkflowRun;await f.controller.dispatch('start',{workflowId:run.id},f.context);
  assert.equal(f.backend.graph!.tasks[0].prompt,'Inspect specific code');assert.equal(f.backend.graph!.tasks[0].modelId,undefined);assert.equal(f.backend.graph!.tasks[0].thinkingLevel,undefined);assert.equal(current(f).modelId,'fake/default');assert.equal(current(f).thinkingLevel,'high');
}finally{await f.cleanup();}});
test('conditions skip an inapplicable branch, join uses real dependencies, and stages share one backend graph',async()=>{const f=fixture();try{
  await start(f,[node('a'),node('optional',['a'],{when:{taskId:'a',path:['needed'],op:'eq',value:true}}),node('b',['optional'])]);
  assert.deepEqual(f.backend.graph!.tasks.map(task=>task.id),['a']);f.backend.complete('a',{needed:false});await f.controller.advance(f.context);
  assert.equal(current(f).nodes.find(state=>state.id==='optional')!.status,'skipped');assert.deepEqual(f.backend.graph!.tasks.find(task=>task.id==='b')!.dependencies,[]);
  f.backend.complete('b',{verified:true});await f.controller.advance(f.context);assert.equal(current(f).status,'waiting_review');assert.equal(f.backend.calls.filter(call=>call.action==='create').length,1);assert.equal(f.backend.calls.some(call=>call.action==='integrate'),false);
}finally{await f.cleanup();}});
test('parallel ready nodes are batched, and result comparisons never execute expressions',async()=>{const f=fixture();try{
  await start(f,[node('a'),node('b')]);assert.equal((f.backend.calls.find(call=>call.action==='create')!.input.tasks as unknown[]).length,2);
  assert.equal(evaluateWorkflowPredicate({taskId:'a',path:['text'],op:'eq',value:'process.exit()'},{a:{text:'process.exit()'}}),true);
  assert.throws(()=>evaluateWorkflowPredicate({taskId:'a',path:['missing'],op:'eq',value:true},{a:{}}),/缺少成果字段/);
}finally{await f.cleanup();}});
test('failed nodes have one persistent repair budget, cannot be removed, and prevent downstream skipping',async()=>{const f=fixture();try{
  const workflowId=await start(f,[node('a',[],{maxRetries:1}),node('b',['a'],{when:{taskId:'a',op:'exists'}})]);f.backend.fail('a');await f.controller.advance(f.context);
  assert.equal(current(f).nodes[0].retries,1);f.backend.fail('a');await f.controller.advance(f.context);assert.equal(current(f).status,'blocked');assert.equal(f.backend.graph!.tasks.some(task=>task.id==='b'),false);
  await assert.rejects(f.controller.dispatch('revise',{workflowId,definition:definition([node('b')])},f.context),/不能删除/);
  await f.controller.dispatch('append',{workflowId,nodes:[node('extra')]},f.context);await assert.rejects(f.controller.dispatch('resume',{workflowId},f.context),/重试额度耗尽/);assert.equal(current(f).nodes[0].retries,1);
}finally{await f.cleanup();}});
test('semantic retry is bounded and completed results remain backend-owned',async()=>{const f=fixture();try{
  await start(f,[node('a',[],{maxRetries:1,retryWhen:{taskId:'a',path:['valid'],op:'eq',value:false}})]);f.backend.complete('a',{valid:false});await f.controller.advance(f.context);assert.equal(f.backend.graph!.attempts.length,2);
  f.backend.complete('a',{valid:true});await f.controller.advance(f.context);assert.equal(current(f).status,'waiting_review');assert.equal(current(f).nodes[0].retries,1);assert.equal(f.backend.graph!.attempts[0].summary,'{"valid":false}');
}finally{await f.cleanup();}});
test('unchanged successful nodes are reused; changed related bytes invalidate node and downstream',async()=>{const f=fixture();try{
  const workflowId=await start(f,[node('a'),node('b',['a'])]);f.backend.complete('a',{result:1});await f.controller.advance(f.context);f.backend.complete('b',{result:2});await f.controller.advance(f.context);await f.controller.dispatch('pause',{workflowId},f.context);
  writeFileSync(join(f.project,'other.txt'),'changed unrelated');await f.controller.dispatch('resume',{workflowId},f.context);assert.equal(f.backend.calls.filter(call=>call.action==='update_task').length,0);
  await f.controller.dispatch('pause',{workflowId},f.context);writeFileSync(join(f.project,'a.txt'),'changed input');await f.controller.dispatch('resume',{workflowId},f.context);
  assert.deepEqual(f.backend.calls.filter(call=>call.action==='update_task'&&call.input.gateOnly!==true).map(call=>call.input.taskId),['a','b']);assert.equal(current(f).nodes[0].status,'running');assert.equal(current(f).nodes[1].status,'pending');
}finally{await f.cleanup();}});
test('tampered backend result and revised input invalidate retained completion',async()=>{const f=fixture();try{
  const workflowId=await start(f,[node('a')]);f.backend.complete('a',{result:1});await f.controller.advance(f.context);await f.controller.dispatch('pause',{workflowId},f.context);
  f.backend.graph!.attempts[0].summary='{"result":99}';await f.controller.dispatch('resume',{workflowId},f.context);assert.equal(f.backend.calls.filter(call=>call.action==='update_task'&&call.input.gateOnly!==true).length,1);
  f.backend.complete('a',{result:2});await f.controller.advance(f.context);await f.controller.dispatch('pause',{workflowId},f.context);await f.controller.dispatch('revise',{workflowId,definition:definition([node('a',[],{prompt:'New requirement'})])},f.context);await f.controller.dispatch('resume',{workflowId},f.context);assert.equal(current(f).nodes[0].retries,2);
}finally{await f.cleanup();}});
test('unknown writes never restart automatically or accept agent confirmation',async()=>{const f=fixture();try{
  const workflowId=await start(f,[node('a',[],{mode:'write',writeScopes:['a.txt']})]);await f.controller.dispatch('pause',{workflowId},f.context);const attempts=f.backend.graph!.attempts.length;
  await assert.rejects(f.controller.dispatch('resume',{workflowId},f.context),/副作用未知/);
  await assert.rejects(f.controller.dispatch('resume',{workflowId,confirmUnknown:true},{...f.context,origin:'agent'}),/必须由用户/);assert.equal(f.backend.graph!.attempts.length,attempts);
  await f.controller.dispatch('resume',{workflowId,confirmUnknown:true},f.context);assert.equal(f.backend.graph!.attempts.length,attempts+1);
}finally{await f.cleanup();}});
test('independent review repairs consume the same node budget and scope checks bind the session',async()=>{const f=fixture();try{
  const workflowId=await start(f,[node('a')]);f.backend.fail('a');f.backend.graph!.tasks[0].rework=2;await f.controller.advance(f.context);assert.equal(current(f).status,'blocked');assert.equal(current(f).nodes[0].retries,2);assert.equal(f.backend.calls.some(call=>call.action==='update_task'),false);
  await assert.rejects(f.controller.dispatch('status',{workflowId},{...f.context,sessionId:'other'}),/当前会话/);
}finally{await f.cleanup();}});
test('recovering a changed branch holds previous writers until the predicate is re-evaluated',async()=>{const f=fixture();try{
  const workflowId=await start(f,[node('a'),node('b',['a'],{mode:'write',writeScopes:['b.txt'],when:{taskId:'a',path:['needed'],op:'eq',value:true}})]);
  f.backend.complete('a',{needed:true});await f.controller.advance(f.context);f.backend.complete('b',{written:true});await f.controller.advance(f.context);await f.controller.dispatch('pause',{workflowId},f.context);
  writeFileSync(join(f.project,'a.txt'),'changed branch input');await f.controller.dispatch('resume',{workflowId},f.context);
  assert.equal(f.backend.graph!.tasks.find(task=>task.id==='a')!.status,'running');assert.equal(f.backend.graph!.tasks.find(task=>task.id==='b')!.workflowHeld,true);
  f.backend.complete('a',{needed:false});await f.controller.advance(f.context);assert.equal(current(f).nodes.find(state=>state.id==='b')!.status,'skipped');assert.equal(f.backend.graph!.tasks.find(task=>task.id==='b')!.status,'skipped');assert.equal(f.backend.graph!.attempts.filter(attempt=>attempt.taskId==='b').length,1);
}finally{await f.cleanup();}});
test('re-entrant advances append a stage exactly once, and unrelated active work delays semantic retry',async()=>{const f=fixture();try{
  await start(f,[node('a',[],{maxRetries:1,retryWhen:{taskId:'a',path:['valid'],op:'eq',value:false}}),node('b'),node('final',['a'])]);
  f.backend.complete('a',{valid:false});await Promise.all([f.controller.advance(f.context),f.controller.advance(f.context)]);assert.equal(f.backend.graph!.attempts.filter(attempt=>attempt.taskId==='a').length,1);assert.equal(f.backend.graph!.tasks.some(task=>task.id==='final'),false);
  f.backend.complete('b',{done:true});await f.controller.advance(f.context);f.backend.complete('a',{valid:true});await Promise.all(Array.from({length:5},()=>f.controller.advance(f.context)));
  assert.equal(f.backend.calls.filter(call=>call.action==='append').length,1);assert.equal(f.backend.graph!.tasks.filter(task=>task.id==='final').length,1);
}finally{await f.cleanup();}});
test('launch-time code receipt prevents reuse if source changes during the member run',async()=>{const f=fixture();try{
  const workflowId=await start(f,[node('a')]);writeFileSync(join(f.project,'a.txt'),'changed while agent was running');f.backend.complete('a',{done:true});await f.controller.advance(f.context);await f.controller.dispatch('pause',{workflowId},f.context);await f.controller.dispatch('resume',{workflowId},f.context);
  assert.equal(f.backend.graph!.attempts.length,2);assert.equal(current(f).nodes[0].retries,1);
}finally{await f.cleanup();}});
test('node cap is cumulative across edits and a fresh controller retains successful receipts',async()=>{const f=fixture();let next:DynamicWorkflowController|undefined;try{
  const large=await f.controller.dispatch('create',{definition:definition(Array.from({length:64},(_,i)=>node(`n${i}`)))},f.context) as WorkflowRun;
  await assert.rejects(f.controller.dispatch('append',{workflowId:large.id,nodes:[node('extra')]},f.context),/累计节点/);
  const workflowId=await start(f,[node('a')]);f.backend.complete('a',{done:true});await f.controller.advance(f.context);await f.controller.dispatch('pause',{workflowId},f.context);await f.controller.dispose();
  next=new DynamicWorkflowController(f.backend);await next.dispatch('resume',{workflowId},f.context);assert.equal(f.backend.graph!.attempts.length,1);assert.equal(next.snapshot(f.context).workflows.find(run=>run.id===workflowId)!.nodes[0].receipt!==undefined,true);
}finally{await next?.dispose();await f.cleanup();}});
test('code fingerprints reject path escapes, distinguish missing files, and exclude runtime storage',async()=>{const f=fixture();try{
  const first=workflowCodeDigest(f.project,['a.txt'],f.context.dataDir);writeFileSync(join(f.project,'a.txt'),'new bytes');assert.notEqual(workflowCodeDigest(f.project,['a.txt'],f.context.dataDir),first);
  assert.throws(()=>workflowCodeDigest(f.project,['../outside']),/相对路径/);symlinkSync(f.root,join(f.project,'escape'));assert.throws(()=>workflowCodeDigest(f.project,['escape']),/符号链接/);
  const absent=workflowCodeDigest(f.project,['missing.txt']);writeFileSync(join(f.project,'missing.txt'),'');assert.notEqual(workflowCodeDigest(f.project,['missing.txt']),absent);
}finally{await f.cleanup();}});
test('runtime task metadata does not invalidate code while project Pi agent configuration does',async()=>{const f=fixture();try{
  const before=workflowCodeDigest(f.project,['.']);mkdirSync(join(f.project,'.pi','tasks'),{recursive:true});mkdirSync(join(f.project,'.friendData'),{recursive:true});writeFileSync(join(f.project,'.pi','tasks','run.json'),'new running metadata');writeFileSync(join(f.project,'.friendData','plugins.sqlite'),'runtime store');
  assert.equal(workflowCodeDigest(f.project,['.']),before);writeFileSync(join(f.project,'.pi','tasks','run.json'),'metadata tick');assert.equal(workflowCodeDigest(f.project,['.']),before);
  mkdirSync(join(f.project,'.pi','agents'),{recursive:true});writeFileSync(join(f.project,'.pi','agents','reviewer.md'),'changed actual agent guidance');assert.notEqual(workflowCodeDigest(f.project,['.']),before);
}finally{await f.cleanup();}});
test('real backend accepts append while original members run without changing old nodes or duplicate dispatch',async()=>{
  const f=fixture(),starts:string[]=[];const workers=new Map<string,{finish:()=>void}>();
  const launcher:MemberLauncher=(start,output)=>{
    starts.push(start.taskId);let close:(receipt:StopObject)=>void=()=>{};const closed=new Promise<StopObject>(resolve=>{close=resolve;});
    const finish=()=>{output({v:1,type:'settled',summary:start.reviewResult?JSON.stringify({approved:true,findings:'fixture review'}):JSON.stringify({task:start.taskId}),sessionId:`fixture-${start.attemptId}`});close({id:start.attemptId,kind:'member',status:'terminated',exitCode:0});};
    workers.set(start.taskId,{finish});queueMicrotask(()=>{output({v:1,type:'ready',sessionId:`fixture-${start.attemptId}`});if(start.reviewResult)finish();});
    return {send:()=>{},closed,stop:async()=>{const receipt:StopObject={id:start.attemptId,kind:'member',status:'terminated',exitCode:0};close(receipt);return receipt;}};
  };
  const backend=new SwarmController(launcher),controller=new DynamicWorkflowController(backend),ctx={...f.context,request:async()=>{throw new Error('optional plugin absent');}};
  const backendSnapshot=()=>backend.snapshot(ctx) as {graphs:Graph[]};
  const wait=async(check:()=>boolean)=>{const until=Date.now()+5000;while(!check()){if(Date.now()>until)throw new Error('fixture timed out');await new Promise(resolve=>setTimeout(resolve,5));}};
  try{
    const run=await controller.dispatch('create',{definition:definition([node('a')])},ctx) as WorkflowRun;await controller.dispatch('start',{workflowId:run.id},ctx);await wait(()=>starts.includes('a'));
    const original=structuredClone(controller.snapshot(ctx).workflows[0]);await controller.dispatch('append',{workflowId:run.id,nodes:[node('b')]},ctx);await wait(()=>starts.includes('b'));
    assert.deepEqual(controller.snapshot(ctx).workflows[0].definition.nodes[0],original.definition.nodes[0]);assert.deepEqual(controller.snapshot(ctx).workflows[0].definition.parameters,original.definition.parameters);
    await assert.rejects(controller.dispatch('append',{workflowId:run.id,nodes:[node('b')]},ctx),/重复/);await assert.rejects(controller.dispatch('append',{workflowId:run.id,nodes:[node('other')],parameters:{target:'overwrite'}},ctx),/只能增补节点/);
    await Promise.all(Array.from({length:4},()=>controller.advance(ctx)));assert.deepEqual(starts,['a','b']);
    workers.get('a')!.finish();workers.get('b')!.finish();await wait(()=>backendSnapshot().graphs.every(graph=>graph.tasks.every(task=>task.status==='completed')));await controller.advance(ctx);
    await wait(()=>starts.includes('independent-review'));await wait(()=>backendSnapshot().graphs[0].status==='integrated');await controller.advance(ctx);assert.equal(controller.snapshot(ctx).workflows[0].status,'completed');assert.equal(backendSnapshot().graphs.length,1);
    await assert.rejects(controller.dispatch('append',{workflowId:run.id,nodes:[node('other')]},ctx),/不能继续追加/);
  }finally{await controller.dispose();await backend.dispose();await f.cleanup();}
});
test('real Swarm backend coordinates staged fixture member receipts and independent review',async()=>{
  const f=fixture();const starts:string[]=[];
  const launcher:MemberLauncher=(start,output)=>{
    starts.push(start.taskId);let close:(receipt:StopObject)=>void=()=>{};const closed=new Promise<StopObject>(resolve=>{close=resolve;});
    const timer=setTimeout(()=>{output({v:1,type:'ready',sessionId:`fixture-${start.attemptId}`});const result:MemberOutput={v:1,type:'settled',summary:start.reviewResult?JSON.stringify({approved:true,findings:'Checked fixture file identities and retained results'}):JSON.stringify({needed:true,task:start.taskId}),sessionId:`fixture-${start.attemptId}`};output(result);close({id:start.attemptId,kind:'member',status:'terminated',exitCode:0});},5);
    return {send:()=>{},closed,stop:async()=>{clearTimeout(timer);const receipt:StopObject={id:start.attemptId,kind:'member',status:'terminated',exitCode:0};close(receipt);return receipt;}};
  };
  const backend=new SwarmController(launcher);const controller=new DynamicWorkflowController(backend);const ctx={...f.context,request:async()=>{throw new Error('optional plugin absent');}};
  try{
    const run=await controller.dispatch('create',{definition:definition([node('a'),node('b',['a'],{when:{taskId:'a',path:['needed'],op:'eq',value:true}})])},ctx) as WorkflowRun;await controller.dispatch('start',{workflowId:run.id},ctx);
    const until=Date.now()+5000;while(controller.snapshot(ctx).workflows[0].status!=='completed'){if(Date.now()>until)throw new Error(JSON.stringify(controller.snapshot(ctx)));await new Promise(resolve=>setTimeout(resolve,10));await controller.advance(ctx);}
    assert.deepEqual(starts,['a','b','independent-review']);const graph=backend.snapshot(ctx) as {graphs:{tasks:{status:string}[];attempts:{sessionId?:string}[];status:string}[]};assert.equal(graph.graphs.length,1);assert.equal(graph.graphs[0].status,'integrated');assert.ok(graph.graphs[0].attempts.every(attempt=>attempt.sessionId?.startsWith('fixture-')));
  }finally{await controller.dispose();await backend.dispose();await f.cleanup();}
});
