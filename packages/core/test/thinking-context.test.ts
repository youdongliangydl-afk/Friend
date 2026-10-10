import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionManager,type ExtensionAPI,type ExtensionContext} from '@earendil-works/pi-coding-agent';
import {makeContext,LearningBudget,RecordStore} from '../src/index.js';

test('plugin context freezes the public Pi thinking level when it is captured',()=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-pi-thinking-context-'));const prior=process.env.FRIEND_PI_DATA_DIR;process.env.FRIEND_PI_DATA_DIR=dir;let level='off';
  try {
    const pi={getThinkingLevel:()=>level,appendEntry:()=>{}} as unknown as ExtensionAPI;
    const ctx={cwd:dir,sessionManager:SessionManager.inMemory(dir),isIdle:()=>true,ui:{notify:()=>{}}} as unknown as ExtensionContext;
    const captured=makeContext(pi,ctx);assert.equal(captured.thinkingLevel,'off');level='high';assert.equal(captured.thinkingLevel,'off');assert.equal(makeContext(pi,ctx).thinkingLevel,'high');
  }finally{if(prior===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=prior;rmSync(dir,{recursive:true,force:true});}
});

test('plugin model calls use the captured thinking level rather than a later foreground selection',async()=>{const dir=mkdtempSync(join(tmpdir(),'friend-pi-thinking-call-'));const prior=process.env.FRIEND_PI_DATA_DIR;process.env.FRIEND_PI_DATA_DIR=dir;let level='low';let observed:unknown;try{const pi={getThinkingLevel:()=>level,appendEntry:()=>{}} as unknown as ExtensionAPI;const ctx={cwd:dir,model:{provider:'fixture',id:'proof'},sessionManager:SessionManager.inMemory(dir),isIdle:()=>true,ui:{notify:()=>{}},modelRegistry:{complete:async(_model:unknown,_context:unknown,options:unknown)=>{observed=options;return {content:[{type:'text',text:'OK'}],stopReason:'stop'};}}} as unknown as ExtensionContext;const captured=makeContext(pi,ctx);level='high';assert.equal(await captured.complete('fixture'), 'OK');assert.equal((observed as {reasoning:string}).reasoning,'low');}finally{if(prior===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=prior;rmSync(dir,{recursive:true,force:true});}});

test('native host preserves typed unknown for rejected, error and aborted calls and refuses their replay',async()=>{
 for(const terminal of ['throw','error','aborted']){
  const dir=mkdtempSync(join(tmpdir(),'friend-pi-native-unknown-')),prior=process.env.FRIEND_PI_DATA_DIR;process.env.FRIEND_PI_DATA_DIR=dir;
  const store=new RecordStore('runtime',dir),budgets=new LearningBudget(store);let dispatches=0,accounted=0;
  try{
   const budget=budgets.create({projectId:'project',sourceRunId:'run',maxCalls:3});
   const pi={getThinkingLevel:()=> 'off',appendEntry:()=>{}} as unknown as ExtensionAPI;
   const native={cwd:dir,model:{provider:'fixture',id:'proof'},sessionManager:SessionManager.inMemory(dir),isIdle:()=>true,ui:{notify:()=>{}},modelRegistry:{complete:async()=>{dispatches++;if(terminal==='throw')throw new TypeError('transport disconnected');return {content:[],stopReason:terminal,usage:{totalTokens:7}};}}} as unknown as ExtensionContext;
   const ctx=makeContext(pi,native),options={budgetId:budget.budgetId,operationId:'extract:0',onUsage:()=>{accounted++;}};
   await assert.rejects(ctx.complete('source',options),{code:'OPERATION_UNKNOWN'});assert.equal(budgets.readCall(budget.budgetId,'extract:0')?.state,'unknown');
   await assert.rejects(makeContext(pi,native).complete('source',options),{code:'OPERATION_UNKNOWN'});assert.equal(dispatches,1);assert.equal(accounted,1);assert.equal(budgets.read(budget.budgetId).calls,1);
  }finally{store.close();if(prior===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=prior;rmSync(dir,{recursive:true,force:true});}
 }
});

test('post-dispatch persistence failure keeps the original dispatched call and typed unknown',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'friend-pi-receipt-fault-')),prior=process.env.FRIEND_PI_DATA_DIR;process.env.FRIEND_PI_DATA_DIR=dir;
 const store=new RecordStore('runtime',dir),budgets=new LearningBudget(store),finish=LearningBudget.prototype.finish;let dispatches=0;
 try{
  const budget=budgets.create({projectId:'project',sourceRunId:'run',maxCalls:3});
  LearningBudget.prototype.finish=function(input){if(input.budgetId===budget.budgetId)throw new Error('SQLITE_BUSY fault injection');return finish.call(this,input);};
  const pi={getThinkingLevel:()=> 'off',appendEntry:()=>{}} as unknown as ExtensionAPI;
  const native={cwd:dir,model:{provider:'fixture',id:'proof'},sessionManager:SessionManager.inMemory(dir),isIdle:()=>true,ui:{notify:()=>{}},modelRegistry:{complete:async()=>{dispatches++;return {content:[{type:'text',text:'confirmed response'}],stopReason:'stop',usage:{totalTokens:7}};}}} as unknown as ExtensionContext;
  const options={budgetId:budget.budgetId,operationId:'extract:0'},ctx=makeContext(pi,native);
  await assert.rejects(ctx.complete('source',options),{code:'OPERATION_UNKNOWN'});assert.equal(budgets.readCall(budget.budgetId,'extract:0')?.state,'dispatched');
  await assert.rejects(makeContext(pi,native).complete('source',options),{code:'OPERATION_UNKNOWN'});assert.equal(dispatches,1);assert.equal(budgets.read(budget.budgetId).calls,1);
 }finally{LearningBudget.prototype.finish=finish;store.close();if(prior===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=prior;rmSync(dir,{recursive:true,force:true});}
});
