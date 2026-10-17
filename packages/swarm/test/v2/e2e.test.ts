import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RecordStore,digest} from '@friend-pi/core';
import {V2Store} from '../../src/v2/store.js';
import {CoordinationService} from '../../src/v2/service.js';

type Fixture = {dir:string; store:RecordStore; v2:V2Store; svc:CoordinationService; close:()=>void};
function fixture():Fixture {
  const dir=mkdtempSync(join(tmpdir(),'swarm-v2-e2e-'));
  const store=new RecordStore('swarm',dir);
  const v2=V2Store.open(store);
  const svc=new CoordinationService(store);
  return {dir,store,v2,svc,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
const user={origin:'user' as const};
function bootstrap(f:Fixture, options:{teamId?:string}={}) {
  const teamId=options.teamId??'team-e2e';
  const team=f.svc.dispatch('team.create',{teamId,projectId:'p',rootSessionId:'s',workspaceRoot:f.dir},{origin:'user'}) as {teamId:string;revision:number};
  f.svc.dispatch('team.resume',{teamId,expectedRevision:1},user);
  const worker=f.svc.dispatch('member.provision',{teamId,name:'worker',role:'worker',contextMode:'fresh'},user) as {memberId:string};
  const reviewer=f.svc.dispatch('member.provision',{teamId,name:'reviewer',role:'reviewer',contextMode:'fresh'},user) as {memberId:string};
  for(const member of [worker,reviewer]) f.svc.dispatch('member.admit',{memberId:member.memberId,firstEntryId:`entry-${member.memberId}`,firstEntryPersisted:true},user);
  f.svc.dispatch('budget.create',{teamId,scope:'team',scopeId:teamId,tokenLimit:100_000},user);
  return {teamId,workerId:worker.memberId,reviewerId:reviewer.memberId};

}
function createWriteTask(f:Fixture, ctx:{teamId:string}, extra:Record<string,unknown>={}) {
  const task=f.svc.dispatch('task.create',{teamId:ctx.teamId,title:'write one file',description:'write src/a.ts exactly',mode:'write',risk:'V1',writeScopes:['src/a.ts'],acceptance:['file exists'],...extra},user) as {taskId:string;revision:number;resultRevision:number};
  f.svc.dispatch('budget.create',{teamId:ctx.teamId,scope:'task',scopeId:task.taskId,tokenLimit:10_000},user);
  return task;
}
test('I1-I18: single-task orchestration reaches done with sealed verdict and zero silent merges', () => {
  const f=fixture();
  try{
    const c=bootstrap(f);
    const task=createWriteTask(f,c);
    const scheduled=f.svc.dispatch('schedule.once',{teamId:c.teamId,maxWorkers:1,memberIdForTask:{[task.taskId]:c.workerId},reserveBudget:false},user) as {dispatched:{taskId:string;attemptId:string}[];blocked:unknown[];running:number};
    assert.equal(scheduled.dispatched.length,1); assert.equal(scheduled.running,1);
    const attemptId=scheduled.dispatched[0].attemptId;
    const delivered=f.svc.dispatch('attempt.complete',{attemptId,summary:'wrote src/a.ts',commitSha:'tip-1',candidateTip:'tip-1',artifactIds:[]},user) as {status:string};
    assert.equal(delivered.status,'completed');
    let t=f.svc.dispatch('task.get',{taskId:task.taskId},user) as {status:string;resultRevision:number;currentAttemptId:string|null};
    assert.equal(t.status,'delivered'); assert.ok(t.currentAttemptId); assert.equal(t.resultRevision,1);
    const attempt=f.v2.row<{candidate_tip:string}>('SELECT candidate_tip FROM swarm_v2_attempts WHERE attempt_id=?',attemptId)!;
    const start=f.svc.dispatch('verify.start',{teamId:c.teamId,taskId:task.taskId,candidateDigest:'cand-1',level:'V1',checks:[]},user) as {verificationId:string;status:string};
    assert.equal(start.status,'checking');
    const results=f.svc.dispatch('verify.runChecks',{teamId:c.teamId,taskId:task.taskId,verificationId:start.verificationId,checks:[{checkId:'c1',kind:'json.schema',data:{path:'src/a.ts'},requiredKeys:['path']}]},user) as {checkId:string;passed:boolean;evidenceRef:string}[];
    assert.equal(results.length,1); assert.equal(results[0].passed,true); assert.ok(results[0].evidenceRef);
    const checked=f.svc.dispatch('verify.checks',{verificationId:start.verificationId,results},user) as {status:string;checks:unknown[]};
    assert.equal(checked.status,'reviewing'); assert.equal(checked.checks.length,1);
    const verdict=f.svc.dispatch('verify.submit',{verificationId:start.verificationId,kind:'reviewer',reviewerMemberId:c.reviewerId,approved:true,findings:['scope 内只有目标文件'],taskIds:[task.taskId],resultVersions:{[task.taskId]:1},candidateDigest:'cand-1',reviewedTip:attempt.candidate_tip,sessionId:'reviewer-session'},user) as {verdictId:string;binding:string;sealed:boolean};
    assert.equal(verdict.binding,'exact-tip'); assert.equal(verdict.sealed,true);
    const applied=f.svc.dispatch('verify.apply',{verdictId:verdict.verdictId},user) as {status:string};
    assert.equal(applied.status,'passed');
    const verifiedState=f.svc.dispatch('task.get',{taskId:task.taskId},user) as {status:string};
    assert.equal(verifiedState.status,'verified');
    const gates=f.svc.dispatch('gates',{taskId:task.taskId,candidateDigest:'cand-1',verdictId:verdict.verdictId,gateInput:{targetBase:'tip-1',targetHead:'tip-1',workspaceClean:true,changedPaths:['src/a.ts']}},user) as {allowed:boolean;gates:{code:string;passed:boolean}[];failed:{code:string}[]};
    assert.equal(gates.allowed,true,JSON.stringify(gates.failed));
    assert.equal(gates.gates.length,20);
    const receipt=f.svc.dispatch('integrate',{taskId:task.taskId,candidateDigest:'cand-1',verdictId:verdict.verdictId,files:[{path:'src/a.ts',content:'hello world'}],gateInput:{targetBase:'tip-1',targetHead:'tip-1',workspaceClean:true,changedPaths:['src/a.ts']}},user) as {status:string;files:{path:string;state:string}[];verdictId:string};
    assert.equal(receipt.status,'applied'); assert.equal(receipt.files[0].path,'src/a.ts'); assert.equal(receipt.verdictId,verdict.verdictId);
    const doneState=f.svc.dispatch('task.get',{taskId:task.taskId},user) as {status:string};
    assert.equal(doneState.status,'done');
    assert.equal(f.svc.dispatch('silentMerge.assert',{teamId:c.teamId},user),0);
    const journal=f.v2.events(c.teamId,0,2000).map(event=>event.type);
    for(const type of ['team.created','member.provisioned','member.admitted','task.created','attempt.started','attempt.delivered','verification.started','verification.checked','verdict.recorded','verification.applied','task.merged','workspace.applied']) assert.ok(journal.includes(type),`missing journal ${type}`);
    const seqs=f.v2.events(c.teamId,0,2000).map(event=>event.seq);
    assert.deepEqual(seqs,[...seqs].sort((a,b)=>a-b));
    assert.equal(new Set(seqs).size,seqs.length);
    const projection=f.svc.dispatch('projection.rebuild',{teamId:c.teamId},user) as {tasks:Record<string,number>;silentMerge:number;journalEvents:number};
    assert.equal(projection.tasks.done,1); assert.equal(projection.silentMerge,0);
    assert.ok(projection.journalEvents>=journal.length-1);
  } finally { f.close(); }
});
test('silent merge is impossible: integrating without a sealed verdict is rejected and leaves task delivered', () => {
  const f=fixture();
  try{
    const c=bootstrap(f);
    const task=createWriteTask(f,c);
    const scheduled=f.svc.dispatch('schedule.once',{teamId:c.teamId,maxWorkers:1,memberIdForTask:{[task.taskId]:c.workerId},reserveBudget:false},user) as {dispatched:{attemptId:string}[]};
    f.svc.dispatch('attempt.complete',{attemptId:scheduled.dispatched[0].attemptId,summary:'done',candidateTip:'tip-x'},user);
    const receipt=f.svc.dispatch('integrate',{taskId:task.taskId,candidateDigest:'cand-x',files:[{path:'src/a.ts',content:'x'}],gateInput:{targetBase:'tip-x',targetHead:'tip-x',workspaceClean:true,changedPaths:['src/a.ts']}},user) as {status:string;verdictId:string|null};
    assert.equal(receipt.status,'rejected'); assert.equal(receipt.verdictId,null);
    const t=f.svc.dispatch('task.get',{taskId:task.taskId},user) as {status:string};
    assert.equal(t.status,'delivered');
    assert.equal(f.svc.dispatch('silentMerge.assert',{teamId:c.teamId},user),0);
    assert.equal((f.svc.dispatch('gates',{taskId:task.taskId,candidateDigest:'cand-x',gateInput:{targetBase:'tip-x',targetHead:'tip-x',workspaceClean:true,changedPaths:['src/a.ts']}},user) as {allowed:boolean}).allowed,false);
  } finally { f.close(); }
});
test('unknown side effects pause the team and stop new dispatch without replay', () => {
  const f=fixture();
  try{
    const c=bootstrap(f);
    const task=createWriteTask(f,c);
    const scheduled=f.svc.dispatch('schedule.once',{teamId:c.teamId,maxWorkers:1,memberIdForTask:{[task.taskId]:c.workerId},reserveBudget:false},user) as {dispatched:{attemptId:string}[]};
    f.svc.dispatch('attempt.fail',{attemptId:scheduled.dispatched[0].attemptId,reason:'member lost after tool call',unknown:true},user);
    const snap=f.svc.dispatch('snapshot',{teamId:c.teamId},user) as {team:{status:string};tasks:{status:string}[];summary:{attempts:Record<string,number>}};
    assert.equal(snap.team.status,'paused'); assert.equal(snap.tasks[0].status,'blocked'); assert.equal(snap.summary.attempts.unknown,1);
    const next=f.svc.dispatch('schedule.once',{teamId:c.teamId,maxWorkers:1,reserveBudget:false},user) as {dispatched:unknown[];exhausted:boolean};
    assert.equal(next.exhausted,true); assert.equal(next.dispatched.length,0);
    const attempts=f.v2.rows<{status:string}>('SELECT status FROM swarm_v2_attempts');
    assert.equal(attempts.filter(row=>row.status==='unknown').length,1);
    assert.equal(attempts.filter(row=>row.status==='running').length,0);
  } finally { f.close(); }
});
test('budget hard limit blocks new dispatch before any attempt is prepared', () => {
  const f=fixture();
  try{
    const c=bootstrap(f);
    const budget=f.svc.dispatch('budget.read',{budgetId:(f.v2.row<{budget_id:string}>("SELECT budget_id FROM swarm_v2_budgets WHERE scope='team'")!).budget_id},user) as {budgetId:string;tokenLimit:number;revision:number};
    assert.equal(budget.tokenLimit,100000);
    const task=createWriteTask(f,c);
    const entry=f.svc.dispatch('budget.reserve',{teamId:c.teamId,budgetId:budget.budgetId,attemptId:'pre-attempt',tokens:100000,costMicros:0},user) as {reservationId:string};
    f.svc.dispatch('budget.settle',{entryId:entry.reservationId,tokens:100000,costMicros:0},user);
    assert.equal((f.svc.dispatch('budget.exhausted',{budgetId:budget.budgetId},user) as {exhausted:boolean}).exhausted,true);
    const scheduled=f.svc.dispatch('schedule.once',{teamId:c.teamId,maxWorkers:1,memberIdForTask:{[task.taskId]:c.workerId}},user) as {dispatched:unknown[];blocked:{taskId:string;reason:{kind:string}}[];exhausted:boolean};
    assert.equal(scheduled.dispatched.length,0);
    assert.ok(scheduled.exhausted || scheduled.blocked[0]?.reason.kind==='budget');
    assert.equal(f.v2.rows('SELECT attempt_id FROM swarm_v2_attempts').length,0);
    assert.equal((f.svc.dispatch('task.get',{taskId:task.taskId},user) as {status:string}).status,'ready');
  } finally { f.close(); }
});
test('message envelope: four states, dedupe, FIFO and wait only for post-call arrivals', async () => {
  const f=fixture();
  try{
    const c=bootstrap(f);
    const first=f.svc.dispatch('message.send',{teamId:c.teamId,messageId:'m1',senderKind:'lead',targetId:c.workerId,type:'task_ready',deliveryMode:'trigger',body:'do task'},user) as {messageId:string;state:string;sequence:number};
    assert.equal(first.state,'accepted'); assert.equal(first.sequence,1);
    const replay=f.svc.dispatch('message.send',{teamId:c.teamId,messageId:'m1',senderKind:'lead',targetId:c.workerId,type:'task_ready',deliveryMode:'trigger',body:'do task'},user) as {sequence:number};
    assert.equal(replay.sequence,1);
    assert.throws(()=>f.svc.dispatch('message.send',{teamId:c.teamId,messageId:'m1',senderKind:'lead',targetId:c.workerId,type:'task_ready',deliveryMode:'trigger',body:'tampered'},user),/VERSION_CONFLICT|意图|不同/u);
    f.svc.dispatch('message.queue',{messageId:'m1'},user);
    const postCall=f.svc.dispatch('message.wait',{teamId:c.teamId,targetId:c.workerId,afterSequence:1,timeoutMs:10_000,pollMs:20},user) as Promise<{messages:{messageId:string}[];timedOut:boolean}>;
    setTimeout(()=>{f.svc.dispatch('message.send',{teamId:c.teamId,messageId:'m2',senderKind:'lead',targetId:c.workerId,type:'followup',deliveryMode:'queue',body:'later'},user);},30);
    const waited=await postCall;
    assert.equal(waited.timedOut,false); assert.deepEqual(waited.messages.map(m=>m.messageId),['m2']);
    f.svc.dispatch('message.deliver',{messageId:'m1'},user);
    f.svc.dispatch('message.incorporate',{messageId:'m1',nativeEntryId:'entry-1'},user);
    f.svc.dispatch('message.queue',{messageId:'m2'},user);
    f.svc.dispatch('message.deliver',{messageId:'m2'},user);
    f.svc.dispatch('message.incorporate',{messageId:'m2',nativeEntryId:'entry-2'},user);
    assert.deepEqual(f.svc.dispatch('message.assertFifo',{teamId:c.teamId,targetId:c.workerId},user),{ok:true,targetId:c.workerId,checked:2});
    const list=f.svc.dispatch('message.list',{teamId:c.teamId,targetId:c.workerId},user) as {state:string;sequence:number}[];
    assert.deepEqual(list.map(m=>[m.sequence,m.state]),[[1,'incorporated'],[2,'incorporated']]);
  } finally { f.close(); }
});
test('write scopes: independent overlapping writers rejected; dependency serialization accepted', () => {
  const f=fixture();
  try{
    const c=bootstrap(f);
    createWriteTask(f,c,{title:'first'});
    assert.throws(()=>createWriteTask(f,c,{title:'second'}),/scope|重叠|范围|写/u);
    const dependent=createWriteTask(f,c,{title:'third',dependencies:[(f.svc.dispatch('task.list',{teamId:c.teamId},user) as {taskId:string}[])[0].taskId]});
    assert.ok(dependent.taskId);
  } finally { f.close(); }
});
test('journal is append-only and projection rebuilds deterministically; CAS revision is enforced', () => {
  const f=fixture();
  try{
    const c=bootstrap(f);
    const task=createWriteTask(f,c);
    assert.throws(()=>f.svc.dispatch('task.addRequirement',{taskId:task.taskId,prompt:'new requirement',expectedRevision:99},user),/VERSION_CONFLICT|版本|revision/u);
    const updated=f.svc.dispatch('task.addRequirement',{taskId:task.taskId,prompt:'new requirement',expectedRevision:task.revision,automatic:false},user) as {requirementVersion:number;revision:number};
    assert.equal(updated.requirementVersion,2);
    const before=f.v2.events(c.teamId,0,2000);
    const projection1=f.svc.dispatch('projection.rebuild',{teamId:c.teamId},user) as {baselineDigest:string;journalEvents:number};
    const projection2=f.svc.dispatch('projection.rebuild',{teamId:c.teamId},user) as {baselineDigest:string;journalEvents:number};
    assert.equal(projection1.baselineDigest,projection2.baselineDigest);
    assert.equal(before.length,projection2.journalEvents);
  } finally { f.close(); }
});

test('controller-style project/session binding rejects cross-project or cross-session v2 access', () => {
  const f=fixture();
  try{
    const ctx={origin:'user' as const,projectId:'p',sessionId:'s',projectDir:f.dir};
    const team=f.svc.dispatch('team.create',{projectId:'evil',rootSessionId:'evil',workspaceRoot:'/tmp/evil'},ctx) as {teamId:string;projectId:string;rootSessionId:string};
    assert.equal(team.projectId,'p'); assert.equal(team.rootSessionId,'s');
    const task=f.svc.dispatch('task.create',{teamId:team.teamId,title:'bound',description:'x',mode:'read',risk:'V0',writeScopes:[],acceptance:['ok']},ctx) as {taskId:string};
    assert.throws(()=>f.svc.dispatch('task.get',{taskId:task.taskId},{...ctx,projectId:'other'}),/PERMISSION_DENIED|不属于/u);
    assert.throws(()=>f.svc.dispatch('task.get',{taskId:task.taskId},{...ctx,sessionId:'other'}),/PERMISSION_DENIED|不属于/u);
    assert.equal((f.svc.dispatch('task.get',{taskId:task.taskId},ctx) as {title:string}).title,'bound');
    assert.throws(()=>f.svc.dispatch('task.transition',{taskId:task.taskId,transition:'complete',expectedRevision:1},ctx),/PERMISSION_DENIED|必须通过/u);
  } finally { f.close(); }
});
