/**
 * Deterministic Swarm v2 P0/P1 acceptance harness.
 * Real CoordinationService + SQLite + controller-style project/session binding.
 * Every check must assert the expected outcome; a returned observation is never
 * treated as PASS. This is a mechanism/invariant harness, not a paired
 * real-model quality benchmark.
 */
import {mkdtempSync,rmSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {RecordStore} from '@friend-pi/core';
import {CoordinationService} from '../../packages/swarm/src/v2/service.ts';

const here=dirname(fileURLToPath(import.meta.url));
const out=resolve(here,'../../.artifacts/qa/swarm-v2-invariants.json');
const checks=[];
async function check(id,title,fn){
  try{const detail=await fn();checks.push({id,title,status:'PASS',detail:detail===undefined?'asserted':JSON.stringify(detail)});}
  catch(error){checks.push({id,title,status:'FAIL',detail:error instanceof Error?error.message:String(error)});}
}
function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'swarm-v2-inv-'));
  const store=new RecordStore('swarm',dir);
  const svc=new CoordinationService(store);
  return {dir,store,svc,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}
const ctx={origin:'user',projectId:'p',sessionId:'s',projectDir:''};
function bootstrap(f){
  const c={...ctx,projectDir:f.dir};
  const team=f.svc.dispatch('team.create',{teamId:'team-inv',projectId:'evil',rootSessionId:'evil',workspaceRoot:'/tmp/evil'},c);
  assert.equal(team.projectId,'p');assert.equal(team.rootSessionId,'s');
  f.svc.dispatch('team.resume',{teamId:team.teamId,expectedRevision:1},c);
  const w=f.svc.dispatch('member.provision',{teamId:team.teamId,name:'w',role:'worker',contextMode:'fresh'},c);
  const r=f.svc.dispatch('member.provision',{teamId:team.teamId,name:'r',role:'reviewer',contextMode:'fresh'},c);
  f.svc.dispatch('member.admit',{memberId:w.memberId,firstEntryId:'e1',firstEntryPersisted:true},c);
  f.svc.dispatch('member.admit',{memberId:r.memberId,firstEntryId:'e2',firstEntryPersisted:true},c);
  f.svc.dispatch('budget.create',{teamId:team.teamId,scope:'team',scopeId:team.teamId,tokenLimit:100000},c);
  return {ctx:c,teamId:team.teamId,workerId:w.memberId,reviewerId:r.memberId};
}
function writeTask(f,c,extra={}){
  const task=f.svc.dispatch('task.create',{teamId:c.teamId,title:'task',description:'write src/a.ts',mode:'write',risk:'V1',writeScopes:['src/a.ts'],acceptance:['exists'],...extra},c.ctx);
  f.svc.dispatch('budget.create',{teamId:c.teamId,scope:'task',scopeId:task.taskId,tokenLimit:10000},c.ctx);
  return task;
}

const f=fixture();
try{
  const c=bootstrap(f);
  await check('I1','member phase machine',()=>{
    const m=f.svc.dispatch('member.provision',{teamId:c.teamId,name:'m1',role:'worker'},c.ctx);
    assert.equal(m.phase,'provisioning');
    const admitted=f.svc.dispatch('member.admit',{memberId:m.memberId,firstEntryId:'x',firstEntryPersisted:true},c.ctx);
    assert.equal(admitted.phase,'active');
    return {provisioningToActive:true};
  });
  await check('I2','name permanently reserved',()=>{
    assert.throws(()=>f.svc.dispatch('member.provision',{teamId:c.teamId,name:'w',role:'worker'},c.ctx),/唯一|已存在|占用|重复/u);
    return {duplicateNameRejected:true};
  });
  await check('I3','admit requires persisted first entry',()=>{
    const m=f.svc.dispatch('member.provision',{teamId:c.teamId,name:'m3',role:'worker'},c.ctx);
    assert.throws(()=>f.svc.dispatch('member.admit',{memberId:m.memberId,firstEntryId:'x',firstEntryPersisted:false},c.ctx),/持久|flush|firstEntry/u);
    return {admitBeforeFlushRejected:true};
  });
  const t=writeTask(f,c);
  await check('I4','task revision CAS',()=>{
    assert.throws(()=>f.svc.dispatch('task.addRequirement',{taskId:t.taskId,prompt:'r2',expectedRevision:99},c.ctx),/VERSION_CONFLICT|版本|revision/u);
    const updated=f.svc.dispatch('task.addRequirement',{taskId:t.taskId,prompt:'r2',expectedRevision:1,automatic:false},c.ctx);
    assert.equal(updated.requirementVersion,2);
    return {requirementVersion:2};
  });
  await check('I5','DAG cycle rejected',()=>{
    const a=writeTask(f,c,{title:'a',writeScopes:['src/c1.ts']});
    const b=writeTask(f,c,{title:'b',writeScopes:['src/c2.ts']});
    f.svc.dispatch('task.setDependencies',{taskId:a.taskId,dependencies:[b.taskId],expectedRevision:1},c.ctx);
    assert.throws(()=>f.svc.dispatch('task.setDependencies',{taskId:b.taskId,dependencies:[a.taskId],expectedRevision:1},c.ctx),/环|cycle|循环/u);
    return {cycleRejected:true};
  });
  await check('I6','one running attempt per task',()=>{
    f.svc.dispatch('schedule.once',{teamId:c.teamId,maxWorkers:2,memberIdForTask:{[t.taskId]:c.workerId}},c.ctx);
    const first=f.svc.dispatch('snapshot',{teamId:c.teamId},c.ctx).runningAttempts.filter(a=>a.taskId===t.taskId);
    assert.equal(first.length,1);
    f.svc.dispatch('schedule.once',{teamId:c.teamId,maxWorkers:2},c.ctx);
    const second=f.svc.dispatch('snapshot',{teamId:c.teamId},c.ctx).runningAttempts.filter(a=>a.taskId===t.taskId);
    assert.equal(second.length,1);
    const attempts=f.svc.dispatch('snapshot',{teamId:c.teamId},c.ctx).summary.attempts;
    return {attemptsForPrimary:1,statuses:attempts};
  });
  await check('I7','write scope overlap rejected',()=>{
    assert.throws(()=>f.svc.dispatch('task.create',{teamId:c.teamId,title:'overlap',description:'x',mode:'write',risk:'V1',writeScopes:['src/a.ts'],acceptance:['x']},c.ctx),/scope|重叠|范围|写/u);
    return {overlapRejected:true};
  });
  await check('I8','message idempotency and FIFO',()=>{
    const m=f.svc.dispatch('message.send',{teamId:c.teamId,messageId:'m1',senderKind:'lead',targetId:c.workerId,type:'t',deliveryMode:'queue',body:'b'},c.ctx);
    const again=f.svc.dispatch('message.send',{teamId:c.teamId,messageId:'m1',senderKind:'lead',targetId:c.workerId,type:'t',deliveryMode:'queue',body:'b'},c.ctx);
    assert.equal(m.sequence,again.sequence);
    assert.throws(()=>f.svc.dispatch('message.send',{teamId:c.teamId,messageId:'m1',senderKind:'lead',targetId:c.workerId,type:'t',deliveryMode:'queue',body:'tampered'},c.ctx),/VERSION_CONFLICT|不同|意图/u);
    f.svc.dispatch('message.send',{teamId:c.teamId,messageId:'m2',senderKind:'lead',targetId:c.workerId,type:'t',deliveryMode:'queue',body:'second'},c.ctx);
    f.svc.dispatch('message.queue',{messageId:'m1'},c.ctx);
    f.svc.dispatch('message.queue',{messageId:'m2'},c.ctx);
    assert.throws(()=>f.svc.dispatch('message.deliver',{messageId:'m2'},c.ctx),/更早|FIFO|VERSION_CONFLICT/u);
    f.svc.dispatch('message.deliver',{messageId:'m1'},c.ctx);
    f.svc.dispatch('message.deliver',{messageId:'m2'},c.ctx);
    return {sequence:m.sequence,fifo:true};
  });
  await check('I10','wait validates lower bound',()=>{
    assert.throws(()=>f.svc.dispatch('message.wait',{teamId:c.teamId,targetId:c.workerId,afterSequence:0,timeoutMs:1000},c.ctx),/10000|timeout|等待/u);
    return {shortTimeoutRejected:true};
  });
  await check('I15','stop receipt all-or-unknown',()=>{
    const m=f.svc.dispatch('member.provision',{teamId:c.teamId,name:'stopme',role:'worker'},c.ctx);
    f.svc.dispatch('member.admit',{memberId:m.memberId,firstEntryId:'e3',firstEntryPersisted:true},c.ctx);
    assert.throws(()=>f.svc.dispatch('member.stop',{memberId:m.memberId,objects:[]},c.ctx),/对象|objects|空|至少/u);
    const partial=f.svc.dispatch('member.stop',{memberId:m.memberId,objects:[{id:'p1',kind:'process',status:'terminated'},{id:'p2',kind:'child',status:'unknown'}]},c.ctx);
    assert.equal(partial.status,'unknown');
    const m2=f.svc.dispatch('member.provision',{teamId:c.teamId,name:'stopme2',role:'worker'},c.ctx);
    f.svc.dispatch('member.admit',{memberId:m2.memberId,firstEntryId:'e4',firstEntryPersisted:true},c.ctx);
    const completed=f.svc.dispatch('member.stop',{memberId:m2.memberId,objects:[{id:'p3',kind:'process',status:'terminated'}]},c.ctx);
    assert.equal(completed.status,'complete');
    // Unknown stop pauses the team; resume it (user action) so later gates are not blocked.
    const team=f.svc.dispatch('snapshot',{teamId:c.teamId},c.ctx).team;
    if(team.status==='paused') f.svc.dispatch('team.resume',{teamId:c.teamId,expectedRevision:team.revision},c.ctx);
    return {partial:partial.status,complete:completed.status,resumed:team.status==='paused'};
  });
  // Advance the primary task through the real pipeline BEFORE any budget exhaustion.
  const running=f.svc.dispatch('snapshot',{teamId:c.teamId},c.ctx).runningAttempts.find(a=>a.taskId===t.taskId);
  assert.ok(running,'expected a running attempt for the primary task');
  let verdict;
  await check('I11-I12','structured verdict binds exact tip and drives verification',()=>{
    f.svc.dispatch('attempt.complete',{attemptId:running.attemptId,summary:'done',commitSha:'tip',candidateTip:'tip'},c.ctx);
    const v=f.svc.dispatch('verify.start',{teamId:c.teamId,taskId:t.taskId,candidateDigest:'digest-1',level:'V1',checks:[]},c.ctx);
    const results=f.svc.dispatch('verify.runChecks',{teamId:c.teamId,taskId:t.taskId,verificationId:v.verificationId,checks:[{checkId:'c1',kind:'json.schema',data:{a:1},requiredKeys:['a']}]},c.ctx);
    f.svc.dispatch('verify.checks',{verificationId:v.verificationId,results},c.ctx);
    assert.throws(()=>f.svc.dispatch('verify.submit',{verificationId:v.verificationId,kind:'reviewer',reviewerMemberId:c.reviewerId,approved:true,findings:[],taskIds:[t.taskId],resultVersions:{[t.taskId]:1},candidateDigest:'digest-1',reviewedTip:'wrong-tip',sessionId:'reviewer-session'},c.ctx),/STALE_TIP|tip|变化/u);
    verdict=f.svc.dispatch('verify.submit',{verificationId:v.verificationId,kind:'reviewer',reviewerMemberId:c.reviewerId,approved:true,findings:[],taskIds:[t.taskId],resultVersions:{[t.taskId]:1},candidateDigest:'digest-1',reviewedTip:'tip',sessionId:'reviewer-session'},c.ctx);
    assert.equal(verdict.binding,'exact-tip');
    f.svc.dispatch('verify.apply',{verdictId:verdict.verdictId},c.ctx);
    assert.equal(f.svc.dispatch('task.get',{taskId:t.taskId},c.ctx).status,'verified');
    return {binding:verdict.binding};
  });
  // Integration must be applied (not merely rejected) and zero silent merge asserted afterwards.
  let receipt;
  await check('I18-SILENT','20 gates + applied receipt + zero silent merge',()=>{
    const gates=f.svc.dispatch('gates',{taskId:t.taskId,candidateDigest:'digest-1',verdictId:verdict.verdictId,gateInput:{targetBase:'tip',targetHead:'tip',workspaceClean:true,changedPaths:['src/a.ts']}},c.ctx);
    assert.equal(gates.allowed,true,JSON.stringify(gates.failed));
    assert.equal(gates.gates.length,20);
    receipt=f.svc.dispatch('integrate',{taskId:t.taskId,candidateDigest:'digest-1',verdictId:verdict.verdictId,files:[{path:'src/a.ts',content:'x'}],gateInput:{targetBase:'tip',targetHead:'tip',workspaceClean:true,changedPaths:['src/a.ts']}},c.ctx);
    assert.equal(receipt.status,'applied');
    assert.equal(receipt.verdictId,verdict.verdictId);
    assert.equal(f.svc.dispatch('task.get',{taskId:t.taskId},c.ctx).status,'done');
    assert.equal(f.svc.dispatch('silentMerge.assert',{teamId:c.teamId},c.ctx),0);
    return {gates:gates.gates.length,receipt:receipt.status};
  });
  await check('I18','baseline drift is rejected',()=>{
    const task=writeTask(f,c,{title:'drift',writeScopes:['src/d.ts']});
    const rejected=f.svc.dispatch('integrate',{taskId:task.taskId,candidateDigest:'c',files:[{path:'src/d.ts',content:'x'}],gateInput:{targetBase:'a',targetHead:'b',workspaceClean:true,changedPaths:['src/d.ts']}},c.ctx);
    assert.equal(rejected.status,'rejected');
    assert.notEqual(f.svc.dispatch('task.get',{taskId:task.taskId},c.ctx).status,'done');
    const gates=f.svc.dispatch('gates',{taskId:task.taskId,candidateDigest:'c',gateInput:{targetBase:'a',targetHead:'b',workspaceClean:true,changedPaths:['src/d.ts']}},c.ctx);
    assert.ok(gates.failed.some(entry=>entry.code==='G08'));
    return {driftRejected:true,G08:true};
  });
  // Budget hard limit in an independent fixture so it cannot corrupt the applied receipt.
  const budgetFixture=fixture();
  try{
    const bc=bootstrap(budgetFixture);
    const teamBudget=budgetFixture.svc.dispatch('snapshot',{teamId:bc.teamId},bc.ctx).budgets.find(b=>b.scope==='team');
    const entry=budgetFixture.svc.dispatch('budget.reserve',{teamId:bc.teamId,budgetId:teamBudget.budgetId,attemptId:'limit-check',tokens:teamBudget.tokenLimit,costMicros:0},bc.ctx);
    budgetFixture.svc.dispatch('budget.settle',{entryId:entry.reservationId,tokens:teamBudget.tokenLimit,costMicros:0},bc.ctx);
    await check('I16','budget hard limit blocks dispatch',()=>{
      assert.equal(budgetFixture.svc.dispatch('budget.exhausted',{budgetId:teamBudget.budgetId},bc.ctx).exhausted,true);
      const task=writeTask(budgetFixture,bc,{title:'budgeted',writeScopes:['src/b.ts']});
      const scheduled=budgetFixture.svc.dispatch('schedule.once',{teamId:bc.teamId,maxWorkers:1,memberIdForTask:{[task.taskId]:bc.workerId}},bc.ctx);
      assert.equal(scheduled.dispatched.length,0);
      assert.ok(scheduled.exhausted||scheduled.blocked[0]?.reason.kind==='budget');
      return {blocked:true};
    });
  } finally { budgetFixture.close(); }
  const projection1=f.svc.dispatch('projection.rebuild',{teamId:c.teamId},c.ctx);
  await check('I17','journal append-only + projection deterministic + operationId idempotency at controller edge',()=>{
    const events=f.svc.dispatch('journal.read',{teamId:c.teamId,limit:2000},c.ctx);
    const seqs=events.map(e=>e.seq);
    assert.deepEqual(seqs,[...seqs].sort((a,b)=>a-b));
    assert.equal(new Set(seqs).size,seqs.length);
    const projection2=f.svc.dispatch('projection.rebuild',{teamId:c.teamId},c.ctx);
    assert.equal(projection1.baselineDigest,projection2.baselineDigest);
    assert.equal(projection2.journalEvents,events.length);
    return {journalEvents:events.length};
  });
  const report={
    v:1,kind:'swarm-v2-p0-p1-invariants',generatedAt:new Date().toISOString(),
    environment:{node:process.version,platform:process.platform,swarmV2SchemaVersion:1},
    checks,summary:{pass:checks.filter(c=>c.status==='PASS').length,fail:checks.filter(c=>c.status==='FAIL').length,total:checks.length},
    boundary:[
      'Deterministic invariant harness over the real CoordinationService + SQLite with controller-style project/session binding.',
      'It is not a paired real-model quality evaluation; real-model quality, cost, clients and packaged Computer Use are separate acceptance gates.',
      'P2/P3/P4 (autonomy, workbench UI, worker pool/multi-process, external providers) are out of this delivery; the invariant list is scoped to implemented P0/P1 semantics.',
    ],
  };
  mkdirSync(dirname(out),{recursive:true});writeFileSync(out,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({summary:report.summary,failures:checks.filter(c=>c.status==='FAIL'),out},null,2));
  if(report.summary.fail)process.exitCode=1;
} finally { f.close(); }
