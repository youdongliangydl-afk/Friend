import test from 'node:test';
import assert from 'node:assert/strict';
import {graphReachability} from '../src/reachability.js';
import {validateDAG,validateWriteRanges,type Task} from '../src/index.js';
import {validateWorkflowDefinition} from '../src/workflow.js';

const dense=()=>Array.from({length:64},(_,i)=>({id:`n${i}`,dependencies:Array.from({length:i},(_,j)=>`n${j}`)}));
test('dense 64 node DAG memoizes each ancestor set within one validation and recalculates changed definitions',()=>{
  const nodes=dense(),r=graphReachability(nodes);
  assert.equal(r.ancestors('n63').size,63);assert.equal(r.ancestors('n63'),r.ancestors('n63'));
  nodes[63].dependencies=[];assert.equal(graphReachability(nodes).ancestors('n63').size,0);
  assert.throws(()=>graphReachability([{id:'a',dependencies:['b']},{id:'b',dependencies:['a']}]).ancestors('a'),/循环/);
  assert.throws(()=>graphReachability([{id:'a',dependencies:['missing']}]).ancestors('a'),/不存在/);
});
test('dense conditional workflows keep ancestor legality and full 2016 edges',()=>{
  const nodes=dense().map(n=>({...n,title:n.id,prompt:n.id,mode:'read',codePaths:['.'],when:n.id==='n63'?{taskId:'n0',op:'exists'}:undefined}));
  const definition={v:1,title:'dense',goal:'dense',nodes};
  assert.equal(validateWorkflowDefinition(definition).nodes.length,64);
  assert.throws(()=>validateWorkflowDefinition({...definition,nodes:nodes.map(n=>n.id==='n0'?{...n,when:{taskId:'n63',op:'exists'}}:n)}),/前置成果/);
});
test('parallel write conflict validation keeps serial shared targets and rejects unrelated overlaps',()=>{
  const tasks=dense().map(n=>({...n,title:n.id,prompt:n.id,mode:'write',writeScopes:['shared.txt'],status:'pending',rework:0,resultRevision:0})) as Task[];
  validateDAG(tasks);validateWriteRanges(tasks);
  const parallel=[{...tasks[0]},{...tasks[1],dependencies:[]}];assert.throws(()=>validateWriteRanges(parallel),/范围重叠/);
  validateWriteRanges([{...parallel[0],status:'skipped'},parallel[1]]);
  validateWriteRanges([{...parallel[0],writeScopes:['a.txt']},{...parallel[1],writeScopes:['b.txt']}]);
});
