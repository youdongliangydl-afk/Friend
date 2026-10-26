import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createElement,type ComponentType} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {
 MERGE_GATE_CODES,createSwarmV2Team,mergeGateView,readSwarmV2,readSwarmV2Gates,submitSwarmV2Verdict,
 swarmV2Board,swarmV2Budgets,swarmV2Messages,swarmV2Summary,swarmV2TeamId,swarmV2TaskState,swarmV2VerdictDraft,
 swarmV2VerdictForm,swarmV2VerdictView,swarmV2View,
} from '../apps/desktop/src/renderer/swarm-v2-model.js';

const team={teamId:'team:ui:s',projectId:'p',rootSessionId:'s',workspaceRoot:'/repo',status:'running',autonomyLevel:2,policy:{},revision:3,reworkRound:1,failureFingerprints:['f1'],createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:05:00.000Z'};
const task=(taskId:string,status:string,extra:Record<string,unknown>={})=>({taskId,teamId:'team:ui:s',revision:1,title:taskId,description:'',mode:'write',risk:'V1',status,ownerMemberId:null,currentAttemptId:null,logicalStepId:taskId,resultRevision:0,resultArtifactIds:[],reworkCount:0,requirementVersion:1,acceptance:['ok'],checksRef:null,workspacePolicy:'worktree',dependencies:[],writeScopes:[],blockedReason:null,createdBy:'user',createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',deletedAt:null,tombstone:false,...extra});
const budget=(budgetId:string,scope:string,scopeId:string,extra:Record<string,unknown>={})=>({budgetId,teamId:'team:ui:s',scope,scopeId,tokenLimit:null,tokenUsed:0,tokenReserved:0,costLimitMicros:null,costUsed:0,timeLimitMs:null,timeUsedMs:0,concurrencyLimit:null,unknown:false,paused:false,revision:1,createdAt:'2026-01-01T00:00:00.000Z',updatedAt:'2026-01-01T00:00:00.000Z',...extra});
const snapshot=(extra:Record<string,unknown>={})=>({v:2,schemaVersion:3,team,members:[{memberId:'m1',name:'Writer',role:'worker',phase:'active',status:'running',writeScopes:['src']}],tasks:[],runningAttempts:[],budgets:[],summary:{schemaVersion:3,teams:1,members:1,tasks:{ready:1,claimed:0,in_progress:0,delivered:0,verified:0,done:0,blocked:0,returned:0,cancelled:0,deleted:0},attempts:{prepared:0,running:1,unknown:0,completed:2,failed:0},messages:{accepted:1,queued:0,delivered:1,incorporated:2,expired:0},budgets:1,verifications:2,verdicts:1,journalEvents:7,silentMerge:0,baselineDigest:'base'},journal:[{type:'team.created',actor:{kind:'lead',id:'lead'},at:'2026-01-01T00:00:00.000Z'}],silentMerge:0,...extra});

test('v2 board maps the eight live task states, keeps tombstones out and never guesses an unknown status',()=>{
 const states=['ready','claimed','in_progress','delivered','verified','done','blocked','returned'];
 for(const state of states){
  const view=swarmV2TaskState(state);
  assert.equal(view.known,true);assert.equal(view.column,state);assert.equal(view.tombstone,false);assert.doesNotMatch(view.label,/未识别/);
 }
 const cancelled=swarmV2TaskState('cancelled');assert.equal(cancelled.column,null);assert.equal(cancelled.tombstone,true);assert.match(cancelled.label,/墓碑/);
 const weird=swarmV2TaskState('paused');assert.equal(weird.known,false);assert.equal(weird.column,null);assert.equal(weird.label,'状态未识别');
 const board=swarmV2Board(snapshot({tasks:[...states.map(state=>task('t-'+state,state)),task('t-cancelled','cancelled'),task('t-deleted','deleted',{tombstone:true}),task('t-weird','paused')]}));
 assert.deepEqual(board.columns.map(column=>column.state),states);
 assert.equal(board.tombstones.length,2);assert.equal(board.unknown.length,1);assert.equal(board.total,11);
 assert.equal(board.columns.find(column=>column.state==='blocked')!.label,'阻塞');
 assert.equal(board.counts.unknown,1);
});

test('v2 task cards carry dependencies, write scopes, owner and blocked reasons from the controller record',()=>{
 const board=swarmV2Board(snapshot({tasks:[
  task('t1','in_progress',{ownerMemberId:'m1',dependencies:['t0','t0'],writeScopes:['src/a.ts','src/a.ts'],blockedReason:{kind:'budget',cause:'团队令牌耗尽'},reworkCount:2,resultRevision:3,currentAttemptId:'a1',acceptance:['a','b']}),
  task('t1','done',{title:'重复记录'}),
  task('','ready'),
 ]}));
 const card=board.columns.find(column=>column.state==='in_progress')!.tasks[0];
 assert.deepEqual(card.dependencies,['t0']);assert.deepEqual(card.writeScopes,['src/a.ts']);
 assert.equal(card.ownerName,'Writer');assert.equal(card.ownerMemberId,'m1');assert.equal(card.modeLabel,'写入');
 assert.match(card.blockedReason,/预算不足：团队令牌耗尽/);assert.equal(card.reworkCount,2);assert.equal(card.acceptanceCount,2);
 assert.equal(board.total,1);assert.ok(board.warnings.some(warning=>warning.includes('重复')));assert.ok(board.warnings.some(warning=>warning.includes('缺少标识')));
 const missingOwner=swarmV2Board(snapshot({tasks:[task('t2','ready',{ownerMemberId:'gone'})]}));
 assert.equal(missingOwner.columns.find(column=>column.state==='ready')!.tasks[0].ownerName,'');
});

test('budget layers keep unknown limits and unknown usage honest instead of printing zero',()=>{
 const budgets=swarmV2Budgets(snapshot({
  tasks:[task('t1','delivered')],
  budgets:[
   budget('b-team','team','team:ui:s',{tokenUsed:120,costUsed:0,timeUsedMs:30000,concurrencyLimit:4,unknown:true}),
   budget('b-task','task','t1',{tokenLimit:1000,tokenUsed:2000,costLimitMicros:500000,costUsed:100000,timeLimitMs:90000,timeUsedMs:1000,paused:true}),
   budget('b-member','member','m1',{tokenLimit:'many',tokenUsed:'lots'}),
  ],
 }));
 const teamRow=budgets.layers.find(layer=>layer.scope==='team')!.rows[0];
 assert.equal(teamRow.bars[0].percent,null);assert.equal(teamRow.bars[0].limitText,'未设上限');assert.equal(teamRow.bars[0].usedText,'已用 120 tok');
 assert.equal(teamRow.unknown,true);assert.match(teamRow.notes.join(''),/含未知用量/);assert.equal(teamRow.concurrencyLimit,4);
 const taskRow=budgets.layers.find(layer=>layer.scope==='task')!.rows[0];
 assert.equal(taskRow.scopeName,'t1');assert.equal(taskRow.bars[0].percent,100);assert.equal(taskRow.bars[0].over,true);
 assert.equal(taskRow.bars[2].limitText,'上限 1 分 30 秒');assert.match(taskRow.notes.join(''),/已暂停新调用/);
 const memberRow=budgets.layers.find(layer=>layer.scope==='member')!.rows[0];
 assert.equal(memberRow.bars[0].limitText,'上限未记录');assert.equal(memberRow.bars[0].usedText,'已用 未知');assert.equal(memberRow.bars[0].percent,null);
 assert.equal(budgets.unknownCount,1);assert.equal(budgets.unscoped,0);
 const empty=swarmV2Budgets(snapshot());
 assert.equal(empty.recorded,false);assert.equal(empty.rows.length,0);assert.deepEqual(empty.layers.map(layer=>layer.scope),['team','task','member']);
});

test('merge gates explain every failure and never turn a missing gate row into a pass',()=>{
 const full=(allowed=false,override:Record<string,{passed:boolean;detail:string}>={})=>({allowed,candidateDigest:'cand',verdictId:'v1',gates:MERGE_GATE_CODES.map((code,index)=>({code,passed:override[code]?.passed??index!==12,detail:override[code]?.detail??(code==='G13'?'越界路径：src/secret':`detail ${code}`)}))});
 const failed=mergeGateView(full());
 assert.equal(failed.read,true);assert.equal(failed.gates.length,20);assert.equal(failed.failed.length,1);
 assert.equal(failed.failed[0].code,'G13');assert.match(failed.failed[0].reason,/越界路径/);assert.equal(failed.allowed,false);assert.equal(failed.claimedAllowed,false);
 const passed=mergeGateView(full(true,{G13:{passed:true,detail:'全部在写范围内'}}));
 assert.equal(passed.allowed,true);assert.equal(passed.failed.length,0);assert.match(passed.note,/全部通过/);
 const partial=mergeGateView({allowed:true,candidateDigest:'cand',gates:[{code:'G01',passed:true,detail:'写任务 verified'}]});
 assert.equal(partial.allowed,false);assert.equal(partial.missing.length,19);assert.equal(partial.claimedAllowed,true);
 assert.equal(partial.gates.find(gate=>gate.code==='G02')!.passed,null);assert.match(partial.gates.find(gate=>gate.code==='G02')!.reason,/门禁未返回/);
 assert.match(partial.note,/控制器声称允许/);
 const unexpected=mergeGateView({gates:[...MERGE_GATE_CODES.map(code=>({code,passed:true,detail:'ok'})),{code:'G21',passed:true,detail:'extra'}]});
 assert.equal(unexpected.unexpected.length,1);assert.equal(unexpected.allowed,false);assert.match(unexpected.note,/未登记/);
 const blank=mergeGateView(undefined);
 assert.equal(blank.read,false);assert.equal(blank.allowed,false);assert.equal(blank.gates.length,20);assert.match(blank.note,/尚未读取门禁/);
});

test('messages and snapshot composition report recorded counts and an honest empty reason',()=>{
 const view=swarmV2View(snapshot());
 assert.equal(view.recorded,true);assert.equal(view.empty,false);assert.equal(view.reason,'');
 assert.equal(view.team.teamId,'team:ui:s');assert.equal(view.team.statusLabel,'运行中');assert.equal(view.team.failureCount,1);
 assert.deepEqual(view.messages.rows.map(row=>row.state),['accepted','queued','delivered','incorporated','expired']);
 assert.deepEqual(view.messages.rows.map(row=>row.label),['已保存','已排队','已投递','已纳入上下文','已过期']);
 assert.equal(view.messages.rows[3].count,2);assert.equal(view.messages.rows[1].count,0);assert.match(view.messages.note,/不等于模型已理解或采纳/);
 assert.equal(view.summary.rows.find(row=>row.label==='任务')!.value,1);assert.equal(view.summary.rows.find(row=>row.label==='日志事件')!.value,7);
 assert.equal(view.summary.silentMerge,0);assert.equal(view.events.rows[0].type,'team.created');
 const missing=swarmV2Messages({summary:{}});
 assert.equal(missing.recorded,false);assert.equal(missing.rows[0].count,undefined);
 const blank=swarmV2View({});
 assert.equal(blank.recorded,false);assert.equal(blank.empty,true);assert.match(blank.reason,/尚未读取/);
 const noTeam=swarmV2View({v:2,tasks:[]});
 assert.equal(noTeam.empty,true);assert.match(noTeam.reason,/未包含团队记录/);
 const wrongVersion=swarmV2View({v:1,team});
 assert.ok(wrongVersion.warnings.some(warning=>warning.includes('版本')));
 assert.equal(swarmV2Summary({summary:{tasks:{ready:2,done:3}}}).rows.find(row=>row.label==='任务')!.value,5);
});

test('sealed verdict form mirrors controller requirements and keeps findings/taskIds deduplicated',()=>{
 const blank=swarmV2VerdictForm(swarmV2VerdictDraft());
 assert.equal(blank.ready,false);assert.ok(blank.missing.length>=6);
 const draft=swarmV2VerdictDraft({verificationId:'ver-1',reviewerMemberId:'m2',candidateDigest:'cand',reviewedTip:'tip',taskIds:'t1, t1\nt2',resultVersions:'t1:3\nt2:1',findings:'越界修改\n缺少测试'});
 const form=swarmV2VerdictForm(draft);
 assert.equal(form.ready,true);assert.deepEqual(form.taskIds,['t1','t2']);assert.deepEqual(form.findings,['越界修改','缺少测试']);
 assert.deepEqual(form.resultVersions,{t1:3,t2:1});assert.equal(form.input.approved,true);assert.equal(form.input.binding,'exact-tip');assert.equal(form.input.kind,'reviewer');
 const rejected=swarmV2VerdictForm({...draft,approved:false,findings:''});
 assert.equal(rejected.ready,false);assert.ok(rejected.missing.some(item=>item.includes('未通过')));
 const noTasks=swarmV2VerdictForm({...draft,taskIds:''});assert.ok(noTasks.missing.some(item=>item.includes('归因任务')));
 const badVersions=swarmV2VerdictForm({...draft,resultVersions:'t1 = 3'});
 assert.equal(badVersions.ready,false);assert.ok(badVersions.missing.some(item=>item.includes('结果版本格式')));
 const verdict=swarmV2VerdictView({verdictId:'v1',verificationId:'ver-1',kind:'reviewer',approved:true,sealed:true,findings:['ok'],taskIds:['t1'],binding:'exact-tip',candidateDigest:'cand',reviewedTip:'tip',reviewerMemberId:'m2',resultVersions:{t1:3},createdAt:'2026-01-01T00:00:00.000Z'});
 assert.equal(verdict.read,true);assert.equal(verdict.kindLabel,'独立复核');assert.equal(verdict.bindingLabel,'精确 tip');assert.deepEqual(verdict.resultVersions,[{taskId:'t1',revision:3}]);
 assert.equal(swarmV2VerdictView({}).read,false);
});

test('v2 readers call the documented actions, bind the team id and surface controller errors verbatim',async()=>{
 const calls:{action:string;input:Record<string,unknown>}[]=[];
 const load=async(action:string,input:Record<string,unknown>={})=>{calls.push({action,input});return snapshot();};
 const read=await readSwarmV2(load,'team:ui:s');
 assert.deepEqual(calls[0],{action:'v2.snapshot',input:{teamId:'team:ui:s'}});assert.equal(read.error,'');
 await readSwarmV2(load);
 assert.deepEqual(calls.at(-1),{action:'v2.snapshot',input:{}});
 const failed=await readSwarmV2(async()=>{throw new Error('团队不属于当前项目/会话');},'team:other');
 assert.equal(failed.error,'团队不属于当前项目/会话');assert.deepEqual(failed.snapshot,{});
 await readSwarmV2Gates(load,{taskId:'t1',candidateDigest:'cand'});
 assert.deepEqual(calls.at(-1),{action:'v2.gates',input:{taskId:'t1',candidateDigest:'cand'}});
 await readSwarmV2Gates(load,{taskId:'t1',candidateDigest:'cand',verdictId:'v1'});
 assert.deepEqual(calls.at(-1)!.input,{taskId:'t1',candidateDigest:'cand',verdictId:'v1'});
 const created=await createSwarmV2Team(load,swarmV2TeamId('s'));
 assert.equal(created.existing,false);assert.deepEqual(calls.at(-1),{action:'v2.team.create',input:{teamId:'team:ui:s'}});
 const existing=await createSwarmV2Team(async()=>{throw new Error('团队编号已存在');},'team:ui:s');
 assert.equal(existing.existing,true);assert.equal(existing.error,'');
 const unavailable=await createSwarmV2Team(async()=>{throw new Error('Swarm v2 已被宿主关闭');},'team:ui:s');
 assert.equal(unavailable.existing,false);assert.match(unavailable.error,/已被宿主关闭/);
 assert.match((await createSwarmV2Team(load,'')).error,/团队标识为空/);
});

test('verdict submission refuses an incomplete draft and reuses the operation id only when ready',async()=>{
 const calls:{action:string;input:Record<string,unknown>}[]=[];
 const load=async(action:string,input:Record<string,unknown>={})=>{calls.push({action,input});return {verdictId:'v1',sealed:true,approved:true};};
 const incomplete=await submitSwarmV2Verdict(load,swarmV2VerdictDraft(),'op-1');
 assert.equal(calls.length,0);assert.ok(incomplete.error);assert.ok(incomplete.missing.length>0);assert.equal(incomplete.verdict.read,false);
 const draft=swarmV2VerdictDraft({verificationId:'ver-1',reviewerMemberId:'m2',candidateDigest:'cand',reviewedTip:'tip',taskIds:'t1',resultVersions:'t1:3'});
 const submitted=await submitSwarmV2Verdict(load,draft,'op-1');
 assert.deepEqual(calls[0].action,'v2.verify.submit');assert.equal(calls[0].input.operationId,'op-1');assert.equal(submitted.error,'');assert.equal(submitted.verdict.sealed,true);
 const rejected=await submitSwarmV2Verdict(async()=>{throw new Error('复核 tip 已变化，旧裁决不能封存');},draft,'op-1');
 assert.match(rejected.error,/旧裁决不能封存/);
});

test('the v2 workbench stays collapsed until opened so the Swarm tab issues no idle v2 read',async()=>{
 const compiled=await build({entryPoints:[fileURLToPath(new URL('../apps/desktop/src/renderer/SwarmV2Panel.tsx',import.meta.url))],bundle:true,platform:'node',format:'cjs',write:false,external:['react','react-dom','react/jsx-runtime'],loader:{'.css':'empty'}});
 const module={exports:{} as {SwarmV2Workbench:ComponentType<{sessionId:string;report(message:string,error?:boolean):void}>}};
 new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
 const markup=renderToStaticMarkup(createElement(module.exports.SwarmV2Workbench,{sessionId:'s',report:()=>{}}));
 assert.match(markup,/Coordination v2 工作台/);assert.match(markup,/G01–G20/);
 assert.doesNotMatch(markup,/正在读取 Swarm v2 快照/);assert.doesNotMatch(markup,/v2 团队标识/);
});
