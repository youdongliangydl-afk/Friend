import test from 'node:test';
import assert from 'node:assert/strict';
import {goalSideEffectIssues} from '../apps/desktop/src/goal-side-effects.js';
const ctx={projectId:'p',sessionId:'s',runId:'new-run'},goal={id:'goal',sourceRunId:'new-run'};
const graph=(extra:Record<string,unknown>={})=>({id:'g',projectId:'p',sessionId:'s',goalId:'goal',runId:'old-run',status:'paused',tasks:[],attempts:[],...extra});
const inspect=(g:Record<string,unknown>,extra:Record<string,unknown>={})=>goalSideEffectIssues({graphs:[g],...extra},ctx,goal);

test('unknown and dispatched operations block, while only file prepared intents are uncertain',()=>{
 for(const status of ['unknown','dispatched'])assert.equal(inspect(graph(),{operations:[{id:'op',graphId:'g',connector:'external',status}]}).length,1);
 assert.equal(inspect(graph(),{operations:[{id:'op',graphId:'g',connector:'file',status:'prepared'}]}).length,1);
 for(const [connector,status] of [['external','prepared'],['external','confirmed'],['external','rejected'],['file','confirmed']])assert.deepEqual(inspect(graph(),{operations:[{id:'op',graphId:'g',connector,status}]}),[]);
});

test('current unknown writes block even after process termination, but failed closed tasks do not',()=>{
 const attempt={id:'a',taskId:'t',mode:'write',status:'unknown',exitReceipt:{status:'terminated'}};
 assert.equal(inspect(graph({tasks:[{id:'t',mode:'write',status:'unknown',currentAttempt:'a'}],attempts:[attempt]}))[0].kind,'write');
 assert.deepEqual(inspect(graph({tasks:[{id:'t',mode:'write',status:'blocked',currentAttempt:'a'}],attempts:[{...attempt,status:'failed'}]})),[]);
 assert.deepEqual(inspect(graph({tasks:[{id:'t',mode:'read',status:'unknown',currentAttempt:'a'}],attempts:[{...attempt,mode:'read'}]})),[]);
});

test('unknown or missing managed exit receipts block even when graph is paused or failed',()=>{
 for(const attempt of [{id:'a',status:'failed',exitReceipt:{status:'unknown'}},{id:'a',status:'unknown'},{id:'a',status:'failed',childCreationStarted:true}])assert.ok(inspect(graph({status:'failed',attempts:[attempt]})).some(issue=>issue.kind==='exit'));
 assert.deepEqual(inspect(graph({attempts:[{id:'a',status:'failed',childCreationStarted:false,exitReceipt:{status:'terminated'}}]})),[]);
});

test('goal matching excludes other projects, sessions and explicit goals even with the same run',()=>{
 const unsafe={operations:[{id:'op',graphId:'g',status:'unknown'}]};
 for(const extra of [{projectId:'other'},{sessionId:'other'},{goalId:'other',runId:'new-run'},{goalId:undefined,runId:'old-run'}])assert.deepEqual(inspect(graph(extra),unsafe),[]);
 assert.equal(inspect(graph({goalId:undefined,runId:'new-run'}),unsafe).length,1);
 assert.equal(inspect(graph({runId:'older-goal-run'}),unsafe).length,1);
 assert.deepEqual(inspect(graph(),{operations:[{id:'other',graphId:'foreign',status:'unknown'}]}),[]);
});

test('unrelated failed and incomplete tasks do not become a goal completion prerequisite',()=>{
 assert.deepEqual(inspect(graph({status:'failed',tasks:[{id:'failed',mode:'read',status:'blocked'},{id:'pending',mode:'write',status:'pending'},{id:'cancelled',mode:'write',status:'cancelled'}],attempts:[{id:'failed-attempt',taskId:'failed',mode:'read',status:'failed',exitReceipt:{status:'terminated'}}]})),[]);
});

test('superseded unknown attempts with known exits retain history without permanently blocking',()=>{
 assert.deepEqual(inspect(graph({tasks:[{id:'t',mode:'write',status:'completed',currentAttempt:'new'}],attempts:[{id:'old',taskId:'t',mode:'write',status:'unknown',exitReceipt:{status:'terminated'}},{id:'new',taskId:'t',mode:'write',status:'completed',exitReceipt:{status:'terminated'}}]})),[]);
});

test('stop receipts block until later canonical receipts resolve their exact object',()=>{
 const g=graph({stopReceipt:{objects:[{id:'a',kind:'member',status:'unknown'},{id:'op',kind:'activity',status:'unknown'}]}});
 assert.equal(inspect(g).length,2);
 assert.deepEqual(inspect({...g,attempts:[{id:'a',status:'failed',exitReceipt:{status:'terminated'}}]},{operations:[{id:'op',graphId:'g',status:'confirmed'}]}),[]);
 assert.equal(inspect(graph({stopReceipt:{objects:[{id:'git-1',kind:'git',status:'unknown'}]}})).length,1);
});

test('paused teammates without a receipt remain unresolved; unrelated members are excluded',()=>{
 const member={id:'m',graphId:'g',rootSessionId:'s',state:'paused',sessionFile:'/fixture/session.jsonl'};
 assert.equal(inspect(graph(),{teammates:[member]}).length,1);
 assert.deepEqual(inspect(graph(),{teammates:[{...member,stopReceipt:{status:'terminated'}},{...member,graphId:'other'},{...member,rootSessionId:'other'}]}),[]);
});

test('without a focused goal all session effects remain gated after clearing or changing runs',()=>{
 const snapshot={graphs:[graph({runId:'new-run'})],operations:[{id:'op',graphId:'g',status:'unknown'}]};
 assert.equal(goalSideEffectIssues(snapshot,ctx).length,1);assert.equal(goalSideEffectIssues(snapshot,{projectId:'p',sessionId:'s'}).length,1);assert.equal(goalSideEffectIssues(snapshot,{...ctx,runId:'different'}).length,1);assert.deepEqual(goalSideEffectIssues(snapshot,{...ctx,sessionId:'other'}),[]);
});


test('known running attempts, active members and dispatched operations only block completion',()=>{
 const issues=inspect(graph({status:'running',tasks:[{id:'t',mode:'write',status:'running',currentAttempt:'a'}],attempts:[{id:'a',taskId:'t',mode:'write',status:'running',childCreationStarted:true}]}),{
  operations:[{id:'op',graphId:'g',connector:'external',status:'dispatched'}],
  teammates:['running','stopping','provisioning'].map(state=>({id:state,graphId:'g',rootSessionId:'s',state})),
 });
 assert.equal(issues.length,5);assert.ok(issues.every(issue=>issue.kind==='running'));assert.equal(issues.some(issue=>issue.kind!=='running'),false);
});

test('explicit unknown receipts override running labels and still block metadata admission',()=>{
 const issues=inspect(graph({attempts:[{id:'a',status:'running',exitReceipt:{status:'unknown'}}]}),{
  operations:[{id:'unknown',graphId:'g',status:'unknown'},{id:'file',graphId:'g',connector:'file',status:'prepared'}],
  teammates:[{id:'m',graphId:'g',rootSessionId:'s',state:'running',stopReceipt:{status:'unknown'}}],
 });
 assert.equal(issues.length,4);assert.ok(issues.every(issue=>issue.kind!=='running'));assert.deepEqual(issues.map(issue=>issue.kind).sort(),['exit','exit','operation','operation']);
});
