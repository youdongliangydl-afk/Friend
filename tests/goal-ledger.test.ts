import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GoalLedger,TaskLedger,ContinuationCoordinator,type PluginContext} from '../packages/core/src/index.js';

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'friend-goal-')),projectDir=join(root,'project'),dataDir=join(root,'data');mkdirSync(projectDir);
 const ctx:PluginContext={origin:'user',projectId:'p',sessionId:'s',runId:'run-1',projectDir,dataDir,executionMode:'single',isIdle:()=>true,history:()=>[],readSource:()=>{throw Error('unexpected source');},complete:async()=>{throw Error('unexpected model');},request:async()=>{throw Error('unexpected bus');},emit:()=>{},notify:()=>{},appendEntry:()=>{}};
 const goals=new GoalLedger(dataDir),tasks=new TaskLedger(dataDir);
 return {goals,tasks,ctx,close(){goals.dispose();tasks.dispose();rmSync(root,{recursive:true,force:true});}};
}
function noAudit():Promise<{approved:boolean;findings:string}>{throw Error('Goal completion must not call a model auditor');}
function legacy(f:ReturnType<typeof fixture>,status:string,extra:Record<string,unknown>={}){
 const goal=f.goals.create({objective:'original'},f.ctx,0);
 const record={...goal,schemaVersion:undefined,timeUsedSeconds:undefined,activeSince:'2000-01-01T00:00:00.000Z',status,tokenBudget:1,...extra};
 f.goals.store.put(`goal:p:${goal.id}`,record);return record;
}

test('only explicit user intent creates goals, with bounded objectives and no token budget input',()=>{
 const f=fixture();try{
  assert.throws(()=>f.goals.create({objective:'ordinary task'},{...f.ctx,origin:'agent'},0),/明确请求/);
  assert.throws(()=>f.goals.create({objective:' '},f.ctx,0));assert.throws(()=>f.goals.create({objective:'x'.repeat(4001)},f.ctx,0));
  const goal=f.goals.create({objective:'requested',userRequested:true,tokenBudget:-1},{...f.ctx,origin:'agent'},0);
  assert.equal(goal.status,'active');assert.equal('tokenBudget' in goal,false);
  f.goals.setState('paused',f.ctx);assert.throws(()=>f.goals.create({objective:'replacement'},f.ctx,0),/未完成/);
  assert.throws(()=>f.goals.set({objective:'expanded'},{...f.ctx,origin:'agent'},0),/只有用户/);
 }finally{f.close();}
});

test('set edits an active goal in place; replacement and clear preserve history and enforce CAS',()=>{
 const f=fixture();try{
  const original=f.goals.set({objective:'one'},f.ctx,0),task=f.tasks.create({title:'still running'},f.ctx,original.id);f.tasks.start(task.id,f.ctx);
  const edited=f.goals.set({goalId:original.id,expectedRevision:original.revision,objective:'two'},f.ctx,0);
  assert.equal(edited.id,original.id);assert.equal(edited.status,'active');
  for(const input of [{goalId:'stale'},{expectedRevision:original.revision}]){
   assert.throws(()=>f.goals.set({...input,objective:'stale'},f.ctx,0),{code:'VERSION_CONFLICT'});
   assert.throws(()=>f.goals.clear(f.ctx,input),{code:'VERSION_CONFLICT'});
   assert.throws(()=>f.goals.setState('paused',f.ctx,undefined,input),{code:'VERSION_CONFLICT'});
  }
  assert.throws(()=>f.goals.set({replace:true,objective:' '},f.ctx,0));assert.equal(f.goals.current(f.ctx)!.id,original.id);
  const replacement=f.goals.set({goalId:edited.id,expectedRevision:edited.revision,replace:true,objective:'three'},f.ctx,1);
  assert.notEqual(replacement.id,original.id);assert.equal(f.goals.read(original.id,f.ctx).status,'paused');assert.equal(f.tasks.read(task.id,f.ctx).status,'running');
  f.goals.clear(f.ctx,{goalId:replacement.id,expectedRevision:replacement.revision});assert.equal(f.goals.current(f.ctx),undefined);assert.equal(f.goals.list(f.ctx).length,2);assert.equal(f.tasks.read(task.id,f.ctx).status,'running');
 }finally{f.close();}
});

test('goals, focus, mutations and completed pointers are isolated by session and project',async()=>{
 const f=fixture();try{
  const a=f.goals.create({objective:'session A'},f.ctx,0),other={...f.ctx,sessionId:'other'};
  assert.equal(f.goals.current(other),undefined);assert.deepEqual(f.goals.list(other),[]);assert.throws(()=>f.goals.read(a.id,other),/原会话/);assert.throws(()=>f.goals.resume({goalId:a.id},other,1),/原会话/);
  f.goals.store.put('focus:other',a.id);assert.equal(f.goals.current(other),undefined);
  assert.equal(f.goals.current({...f.ctx,projectId:'different'}),undefined);
  await f.goals.finish(f.ctx,f.tasks,noAudit,true,{summary:'done'});assert.equal(f.goals.getLastCompleted(other),undefined);assert.equal(f.goals.getLastCompleted(f.ctx)!.id,a.id);
 }finally{f.close();}
});

for(const [status,waitFor,expected] of [['waiting','user-acceptance','paused'],['verifying',undefined,'paused'],['stopped',undefined,'paused'],['waiting','job-1','active'],['waiting',undefined,'paused'],['completed',undefined,'complete']] as const){
 test(`legacy ${status}/${waitFor||'-'} migrates to ${expected} without destroying evidence`,()=>{
  const f=fixture();try{
   const acceptance={binding:'old',taskVersion:'t',codeVersion:'c',goalVersion:'g',requestedAt:'then'},audit={approved:false,findings:'old evidence'};
   const old=legacy(f,status,{waitFor,acceptance,audit}),goal=f.goals.read(old.id,f.ctx);
   assert.equal(goal.status,expected);assert.equal(goal.schemaVersion,2);assert.deepEqual(goal.acceptance,acceptance);assert.deepEqual(goal.audit,audit);assert.equal(goal.waitFor,waitFor);assert.equal(goal.timeUsedSeconds,0);assert.equal(goal.activeSince,undefined);
   assert.equal(goal.revision,old.revision);assert.equal(f.goals.read(old.id,f.ctx).revision,old.revision);
   if(expected==='complete'){assert.equal(f.goals.current(f.ctx),undefined);assert.equal(f.goals.getLastCompleted(f.ctx)!.id,old.id);}else assert.equal(f.goals.current(f.ctx)!.status,expected);
   if(expected==='paused'){assert.equal(f.goals.restore(f.ctx,1,true),false);assert.throws(()=>f.goals.accept({},f.ctx,f.tasks,true),/恢复目标/);}
  }finally{f.close();}
 });
}

test('legacy budgets, unknown usage and arbitrarily high usage never suspend or gate resume',()=>{
 const f=fixture();try{
  legacy(f,'paused',{tokens:10,tokenBudget:1});let goal=f.goals.resume({},f.ctx,1);assert.equal(goal.status,'active');
  goal=f.goals.account(f.ctx,undefined)!;assert.equal(goal.status,'active');assert.equal(goal.usageAvailable,false);
  goal=f.goals.account(f.ctx,1e12)!;assert.equal(goal.status,'active');assert.equal(goal.tokens,1e12+10);
  goal=f.goals.update({tokenBudget:0},f.ctx);assert.equal(goal.status,'active');
 }finally{f.close();}
});

for(const mode of ['single','team','swarm'] as const){
 test(`${mode} completion uses the main agent summary, clears focus and does not gate on tasks or write checks`,async()=>{
  const f=fixture();try{
   f.ctx.executionMode=mode;const goal=f.goals.create({objective:'research or implementation'},f.ctx,0);f.tasks.create({title:'optional outstanding task',mode:'write'},f.ctx,goal.id);f.goals.noteWrite(f.ctx);
   const completed=await f.goals.finish(f.ctx,f.tasks,noAudit,true,{summary:'Delivered the requested result.'});
   assert.equal(completed.status,'complete');assert.equal(f.goals.current(f.ctx),undefined);assert.equal(f.goals.getLastCompleted(f.ctx)!.id,goal.id);assert.equal((completed.audit as {kind:string}).kind,'agent-completion');
   assert.equal(f.goals.create({objective:'new goal'},f.ctx,1).status,'active');
  }finally{f.close();}
 });
}

test('completion still requires active state, safe effects and the current version',async()=>{
 const f=fixture();try{
  const goal=f.goals.create({objective:'inspect'},f.ctx,0);
  f.goals.update({progress:'actual findings'},f.ctx);
  await assert.rejects(f.goals.finish(f.ctx,f.tasks,noAudit,false),/尚未收敛/);
  await assert.rejects(f.goals.finish(f.ctx,f.tasks,noAudit,true,{goalId:'old'}),{code:'VERSION_CONFLICT'});
  await assert.rejects(f.goals.finish(f.ctx,f.tasks,noAudit,true,{expectedRevision:goal.revision}),{code:'VERSION_CONFLICT'});
  f.goals.setState('paused',f.ctx);await assert.rejects(f.goals.finish(f.ctx,f.tasks,noAudit,true),/显式接续/);
  f.goals.resume({},f.ctx,1);const done=await f.goals.finish(f.ctx,f.tasks,noAudit,true);assert.equal(done.status,'complete');assert.equal(f.tasks.list(f.ctx,done.id).length,0);
 }finally{f.close();}
});

test('resume and bindRun adopt current settings without changing historical task ownership',()=>{
 const f=fixture();try{
  const goal=f.goals.create({objective:'work'},f.ctx,0),task=f.tasks.create({title:'old run'},f.ctx,goal.id);f.goals.setState('paused',f.ctx);
  f.ctx.executionMode='team';f.ctx.modelId='new-model';f.ctx.thinkingLevel='high';f.ctx.runId='run-2';
  const resumed=f.goals.resume({goalId:goal.id},f.ctx,1);assert.equal(resumed.mode,'team');assert.equal(resumed.modelId,'new-model');assert.equal(resumed.sourceRunId,'run-2');
  f.ctx.runId='run-3';assert.equal(f.goals.bindRun(f.ctx)!.sourceRunId,'run-3');assert.equal(f.tasks.read(task.id,f.ctx).runId,'run-1');
 }finally{f.close();}
});

test('elapsed time accrues only while active, settles on pause/finish and ignores offline wall time',async t=>{
 t.mock.timers.enable({apis:['Date'],now:100000});const f=fixture();try{
  const goal=f.goals.create({objective:'timed'},f.ctx,0);t.mock.timers.tick(5000);assert.equal(f.goals.setState('paused',f.ctx)!.timeUsedSeconds,5);
  t.mock.timers.tick(50000);f.goals.resume({},f.ctx,1);t.mock.timers.tick(3000);f.goals.checkpoint(f.ctx,true);assert.equal(f.goals.current(f.ctx)!.timeUsedSeconds,8);
  f.goals.dispose();t.mock.timers.tick(900000);const reopened=new GoalLedger(f.ctx.dataDir);
  try{assert.equal(reopened.current(f.ctx)!.timeUsedSeconds,8);assert.equal(reopened.current(f.ctx)!.activeSince,undefined);assert.equal(reopened.restore(f.ctx,2,true),true);t.mock.timers.tick(2000);const done=await reopened.finish(f.ctx,f.tasks,noAudit,true,{summary:'timed result'});assert.equal(done.timeUsedSeconds,10);assert.equal(done.activeSince,undefined);assert.equal(reopened.read(goal.id,f.ctx).timeUsedSeconds,10);}finally{reopened.dispose();}
 }finally{f.tasks.dispose();rmSync(join(f.ctx.projectDir,'..'),{recursive:true,force:true});t.mock.timers.reset();}
});

test('goal cancellation removes only matching wake frames and preserves revision bindings',()=>{
 const f=fixture(),coordinator=new ContinuationCoordinator(f.ctx.sessionId,f.ctx.dataDir);try{
  coordinator.enqueue('goal','continue',{goalId:'g',goalRevision:4});coordinator.enqueue('other-goal','continue',{goalId:'other',goalRevision:1});coordinator.enqueue('job','job done',{runId:'r'});
  assert.equal(coordinator.pending().find(frame=>frame.id==='goal')!.goalRevision,4);coordinator.cancelGoal('g');assert.equal(coordinator.generation(),0);assert.deepEqual(coordinator.pending().map(frame=>frame.id).sort(),['job','other-goal']);
 }finally{coordinator.dispose();f.close();}
});

test('a tool-first main Agent completion needs no additional summary field',async()=>{const f=fixture();try{f.goals.create({objective:'do requested work'},f.ctx,0);const done=await f.goals.finish(f.ctx,f.tasks,noAudit,true);assert.equal(done.status,'complete');assert.equal((done.audit as {judgedBy:string}).judgedBy,'main-agent');assert.match((done.audit as {findings:string}).findings,/依据保留在 Pi 原生会话/);}finally{f.close();}});


test('Plan mode leaves Goal intent active and suppresses restore without mutating persistent state',()=>{
 const f=fixture();try{
  f.ctx.policy={v:1,revision:1,stage:'main',canSwitchRole:true,unsettledTools:0,tools:[],writeScopes:['.'],executionMode:'single',planMode:true};
  let goal=f.goals.create({objective:'goal under Plan'},f.ctx,0);assert.equal(goal.status,'active');
  const originalRevision=goal.revision;
  assert.equal(f.goals.restore(f.ctx,1,false),false);assert.equal(f.goals.current(f.ctx)!.status,'active');assert.equal(f.goals.current(f.ctx)!.revision,originalRevision);
  f.goals.setState('paused',f.ctx);goal=f.goals.set({objective:'edited under Plan'},f.ctx,1);assert.equal(goal.status,'active');
  f.goals.setState('paused',f.ctx);goal=f.goals.resume({},f.ctx,2);assert.equal(goal.status,'active');
  f.goals.checkpoint(f.ctx,true);const checkpoint=f.goals.current(f.ctx)!;assert.equal(f.goals.restore(f.ctx,3,true),false);assert.equal(f.goals.current(f.ctx)!.revision,checkpoint.revision);assert.equal(f.goals.current(f.ctx)!.status,'active');
  goal=f.goals.set({objective:'explicitly paused',status:'paused'},f.ctx,3);assert.equal(goal.status,'paused');
  goal=f.goals.set({replace:true,objective:'replacement under Plan'},f.ctx,4);assert.equal(goal.status,'active');
 }finally{f.close();}
});

test('saving a paused or blocked goal objective defaults to active unless pause is explicit',()=>{
 const f=fixture();try{
  const goal=f.goals.create({objective:'initial'},f.ctx,0);
  for(const status of ['paused','blocked','usage_limited'] as const){f.goals.setState(status,f.ctx);const saved=f.goals.set({goalId:goal.id,objective:'edited'},f.ctx,1);assert.equal(saved.status,'active');assert.equal(saved.id,goal.id);}
  assert.equal(f.goals.set({objective:'keep paused',status:'paused'},f.ctx,1).status,'paused');
 }finally{f.close();}
});

for(const [label,extra,expected] of [
 ['audit rejection',{audit:{approved:false,findings:'review rejected'},error:'review rejected'},'paused'],
 ['audit unavailable',{error:'独立审核不可用：没有配置审核模型'},'paused'],
 ['execution unknown',{audit:{approved:false,findings:'review rejected'},error:'执行对象状态未知，需要人工核对'},'blocked'],
 ['later execution failure',{audit:{approved:false,findings:'review rejected'},error:'步骤阻塞：编译失败'},'blocked'],
 ['current audit record',{schemaVersion:2,audit:{approved:false,findings:'review rejected'},error:'review rejected'},'blocked'],
] as const){
 test(`legacy blocked migration preserves ${label} evidence and yields ${expected}`,()=>{
  const f=fixture();try{const old=legacy(f,'blocked',extra),goal=f.goals.read(old.id,f.ctx);assert.equal(goal.status,expected);assert.deepEqual(goal.audit,old.audit);assert.equal(goal.error,old.error);assert.equal(goal.activeSince,undefined);assert.equal(f.goals.restore(f.ctx,1,true),false);}finally{f.close();}
 });
}
