import test from 'node:test';
import assert from 'node:assert/strict';
import type {Graph} from '../src/types.js';
import {projectSwarmToolResult} from '../src/tool-result.js';

const expert={id:'frozen-expert',prompt:'expert execution instructions '.repeat(220)};
function graph(id:string,status:'integrated'|'failed'|'paused',attemptStatus:'completed'|'failed'|'unknown'):Graph {
  const attemptId=`${id}-attempt`,memberId=`${id}-member`,taskId=`${id}-task`;
  return {id,projectId:'project',projectDir:'/project',sessionId:'root',goal:'Verify positive odd sum',status,createdAt:'created',updatedAt:'updated',maxWorkers:2,reworkRound:0,expertCatalog:{experts:[expert]},modelId:'configured/model',checks:[{command:'node',args:['verify.mjs']}],
    tasks:[{id:taskId,title:'Implement safe integer filtering',prompt:'Preserve input; ignore unsafe integers',mode:'write',writeScopes:['sum.mjs'],dependencies:[],status:attemptStatus==='completed'?'completed':attemptStatus==='failed'?'blocked':'unknown',memberId,currentAttempt:attemptId,rework:0,resultRevision:1}],
    attempts:[{id:attemptId,taskId,memberId,number:1,resultRevision:1,status:attemptStatus,cwd:`/retained/${id}`,mode:'write',writeScopes:['sum.mjs'],ownerPid:123,ownerRuntime:'runtime',startedAt:'started',finishedAt:'finished',expert,sessionId:`${id}-native`,sessionFile:`/sessions/${id}.jsonl`,summary:attemptStatus==='completed'?'Implemented filter and reduce, preserving the input':undefined,error:attemptStatus==='failed'?'Provider connection failed':attemptStatus==='unknown'?'Stopped; inspect worktree before explicit resume':undefined,commit:attemptStatus==='completed'?'member-commit':undefined}],
    integration:status==='integrated'?{cwd:'/retained/integration',head:'integration-commit',checks:[{command:'node',args:['verify.mjs'],exitCode:0,output:'PASS positive odd sum',at:'checked'}],review:{attemptId:'review-attempt',approved:true,findings:'Read implementation; all checks passed',at:'reviewed',sessionId:'review-native',sessionFile:'/sessions/review.jsonl',resultVersions:{[taskId]:1}}}:undefined,
    reviewAttempts:[{attemptId:'review-attempt',cwd:'/retained/integration',status:status==='integrated'?'completed':'unknown',startedAt:'started',sessionFile:'/sessions/review.jsonl'}],
    error:status==='integrated'?undefined:'Actual task outcome requires inspection',
    stopReceipt:attemptStatus==='unknown'?{operationId:'stop-operation',requestedAt:'requested',finishedAt:'finished',objects:[{id:attemptId,kind:'member',status:'terminated',exitCode:0}],unknownAttemptIds:[attemptId]}:undefined,
    auditEvidence:{expertCatalog:'business evidence must survive',attempts:[{expert:'business result'}]},
  };
}

test('large Swarm snapshots retain completion and failure evidence without duplicate execution context',()=>{
  const graphs=[graph('done','integrated','completed'),graph('failed','failed','failed'),graph('interrupted','paused','unknown')];
  const raw={graphs,members:graphs.flatMap(graph=>graph.attempts.map(attempt=>({...attempt,graphId:graph.id}))),teammates:[{id:'done-member',state:'idle',generation:2,sessionId:'done-native'}],messages:[{id:'receipt',body:'Preserve input',nativeEntryId:'native-entry',processedAt:'processed'}],shared:[{name:'policy',content:JSON.stringify({expertCatalog:'user material'})}],usage:{tokens:99},status:'idle'};
  const original=structuredClone(raw),projected=projectSwarmToolResult('snapshot',raw) as typeof raw;
  assert.ok(JSON.stringify(projected).length<JSON.stringify(raw).length/3,'repeated catalogs should not dominate every model poll');
  assert.equal(Object.hasOwn(projected,'members'),false);
  assert.deepEqual(projected.graphs.map(graph=>[graph.id,graph.status,graph.tasks[0].status,graph.attempts[0].status]),[['done','integrated','completed','completed'],['failed','failed','blocked','failed'],['interrupted','paused','unknown','unknown']]);
  assert.equal(projected.graphs[0].integration?.checks[0].output,'PASS positive odd sum');
  assert.equal(projected.graphs[0].integration?.review?.sessionFile,'/sessions/review.jsonl');
  assert.equal(projected.graphs[0].attempts[0].summary,graphs[0].attempts[0].summary);
  assert.equal(projected.graphs[1].attempts[0].error,'Provider connection failed');
  assert.equal(projected.graphs[2].attempts[0].cwd,'/retained/interrupted');
  assert.equal(projected.graphs[2].attempts[0].sessionFile,'/sessions/interrupted.jsonl');
  assert.deepEqual(projected.graphs[2].stopReceipt,graphs[2].stopReceipt);
  assert.deepEqual(projected.graphs[2].auditEvidence,graphs[2].auditEvidence);
  assert.deepEqual(projected.messages,raw.messages);assert.deepEqual(projected.shared,raw.shared);assert.deepEqual(projected.usage,raw.usage);assert.deepEqual(projected.teammates,raw.teammates);
  assert.ok(projected.graphs.every(graph=>!Object.hasOwn(graph,'expertCatalog')&&graph.attempts.every(attempt=>!Object.hasOwn(attempt,'expert'))));
  assert.deepEqual(raw,original,'controller/GUI records must remain complete and unchanged');
});

test('graph action results and history retain source references and complete summaries',()=>{
  const raw=graph('done','integrated','completed');
  for(const action of ['create','start','pause','stop','resume','prepare','review','integrate','rework','configure','append','update_task','workflow_skip']){
    const projected=projectSwarmToolResult(action,raw) as Graph;
    assert.equal(projected.id,raw.id);assert.deepEqual(projected.tasks,raw.tasks);assert.deepEqual(projected.integration,raw.integration);assert.deepEqual(projected.reviewAttempts,raw.reviewAttempts);
    assert.equal(Object.hasOwn(projected,'expertCatalog'),false);assert.equal(Object.hasOwn(projected.attempts[0],'expert'),false);
    assert.equal(projected.attempts[0].sessionFile,raw.attempts[0].sessionFile);
  }
  const history=projectSwarmToolResult('history',{graphs:[raw],readOnly:true}) as {graphs:Graph[];readOnly:boolean};
  assert.equal(history.readOnly,true);assert.equal(history.graphs[0].id,raw.id);assert.equal(Object.hasOwn(history.graphs[0],'expertCatalog'),false);
});

test('explicit material and native history reads preserve arbitrary payload keys',()=>{
  const payload={id:'document',tasks:[],attempts:[{expert}],expertCatalog:expert,entries:[{message:{content:[{type:'text',text:'native result'}]}}]};
  for(const action of ['shared.read','shared.readVersion','shared.conflicts','shared.write','member.history','member.list','member.send','audit','confirm'])assert.equal(projectSwarmToolResult(action,payload),payload);
  assert.equal(projectSwarmToolResult('snapshot',payload),payload);
  assert.equal(projectSwarmToolResult('shared.read',null),null);
});
