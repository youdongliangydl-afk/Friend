import test from 'node:test';
import assert from 'node:assert/strict';
import {digest} from '@friend-pi/core';
import {judgePhase,type EvaluationPair,type EvaluationObservation} from '../src/evaluation.js';

function observation(elapsedMs:number,tokens:number):EvaluationObservation {
 return {passed:true,outputHash:digest('fixture'),checks:[{id:'objective',passed:true,critical:true}],usage:{totalTokens:tokens,providerRequests:1,unknown:false},timing:{admittedAt:new Date(0).toISOString(),checkedAt:new Date(elapsedMs).toISOString(),queueWaitMs:10,elapsedMs},nativeEvidence:[{sessionId:'fixture',entryId:'fixture'}],operationId:'fixture',requestHash:digest('fixture')};
}
function pairs(times:number[]):EvaluationPair[]{return times.map((elapsed,index)=>({phase:'validation',caseKey:digest(index),caseId:`case-${Math.floor(index/3)}`,repetition:index%3,kind:index<6?'positive':'negative',critical:true,baseline:observation(100,100),candidate:observation(elapsed,80)}));}

test('efficiency compares end-to-end elapsed totals within each phase and preserves slower pair detail',()=>{
 const samples=pairs([200,80,80,80,80,80,80,80,80]),result=judgePhase(samples,3,'paired-efficiency');
 assert.equal(result.baselineElapsedMs,900);assert.equal(result.candidateElapsedMs,840);
 assert.equal(result.timeNonRegression,true);assert.equal(result.strictImprovement,true);
 assert.equal(samples[0].candidate!.timing.elapsedMs,200);assert.equal(result.candidateQueueWaitMs,90);
});

test('an aggregate phase time regression or one baseline-passing check regression still rejects efficiency',()=>{
 assert.equal(judgePhase(pairs([300,80,80,80,80,80,80,80,80]),3,'paired-efficiency').timeNonRegression,false);
 const samples=pairs(Array(9).fill(80));samples[0].candidate!.checks[0].passed=false;samples[0].candidate!.passed=false;
 const result=judgePhase(samples,3,'paired-efficiency');assert.equal(result.timeNonRegression,true);assert.equal(result.nonRegression,false);assert.equal(result.strictImprovement,false);
});
