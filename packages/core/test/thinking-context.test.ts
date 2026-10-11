import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionManager,type ExtensionAPI,type ExtensionContext} from '@earendil-works/pi-coding-agent';
import {makeContext,LearningBudget,RecordStore,digest,learningRequestHash} from '../src/index.js';

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


test('received length-limited model output retains response metadata and refuses replay as a known incomplete result',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'friend-pi-native-length-')),prior=process.env.FRIEND_PI_DATA_DIR;process.env.FRIEND_PI_DATA_DIR=dir;
 const store=new RecordStore('runtime',dir),budgets=new LearningBudget(store);let dispatches=0;
 try{
  const budget=budgets.create({projectId:'project',sourceRunId:'run',maxCalls:3});
  const pi={getThinkingLevel:()=> 'off',appendEntry:()=>{}} as unknown as ExtensionAPI;
  const usage={input:3,output:5,cacheRead:0,cacheWrite:0,totalTokens:8,reasoningTokens:2};
  const native={cwd:dir,model:{provider:'fixture',id:'proof'},sessionManager:SessionManager.inMemory(dir),isIdle:()=>true,ui:{notify:()=>{}},modelRegistry:{complete:async()=>{dispatches++;return {content:[{type:'text',text:'{"memories":[{"content":"unfinished'}],stopReason:'length',usage};}}} as unknown as ExtensionContext;
  const options={budgetId:budget.budgetId,operationId:'extract:0',maxTokens:123};
  await assert.rejects(makeContext(pi,native).complete('source',options),{code:'VALIDATION_ERROR'});
  const call=budgets.readCall(budget.budgetId,'extract:0')!;assert.equal(call.state,'failed');assert.deepEqual(call.response,{received:true,complete:false,stopReason:'length',maxTokens:123,usage});assert.equal(call.result,'{"memories":[{"content":"unfinished');assert.equal(call.tokens,8);
  await assert.rejects(makeContext(pi,native).complete('source',options),{code:'VALIDATION_ERROR'});await assert.rejects(makeContext(pi,native).complete('source',{...options,maxTokens:124}),{code:'VERSION_CONFLICT'});assert.equal(dispatches,1);assert.equal(budgets.read(budget.budgetId).calls,1);assert.equal(budgets.read(budget.budgetId).usageUnknown,false);
  assert.throws(()=>budgets.finish({budgetId:budget.budgetId,operationId:'extract:0',callId:call.callId,state:'failed',response:{...call.response,complete:true}}),{code:'VERSION_CONFLICT'});
 }finally{store.close();if(prior===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=prior;rmSync(dir,{recursive:true,force:true});}
});

test('native completion binds the same operation to the actual model configuration and effective request parameters',async()=>{
 const changes=['maxTokens','thinking','stage','prompt','provider','id','api','baseUrl','reasoning','contextWindow','modelMaxTokens','compat','samplingParams','samplingParamsByThinkingLevel','thinkingLevelMap','promptCache','inputLimits','anthropicBeta'] as const;
 for(const changed of changes){const dir=mkdtempSync(join(tmpdir(),'native-request-identity-')),prior=process.env.FRIEND_PI_DATA_DIR;process.env.FRIEND_PI_DATA_DIR=dir;const store=new RecordStore('runtime',dir),budgets=new LearningBudget(store);let level='low',dispatches=0;
  try{
   const budget=budgets.create({projectId:'p',sourceRunId:'run',maxCalls:4}),model={provider:'fixture',id:'proof',api:'openai-completions',baseUrl:'https://example.invalid/v1',reasoning:true,contextWindow:8192,maxTokens:2048,compat:{supportsDeveloperRole:true},samplingParams:{temperature:.2}};
   const pi={getThinkingLevel:()=>level,appendEntry:()=>{}} as unknown as ExtensionAPI,native={cwd:dir,model,sessionManager:SessionManager.inMemory(dir),isIdle:()=>true,ui:{notify:()=>{}},modelRegistry:{complete:async(_model:unknown,_context:unknown,options:unknown)=>{dispatches++;assert.equal((options as {maxTokens:number}).maxTokens,321);return {content:[{type:'text',text:'original result'}],stopReason:'stop',usage:{totalTokens:7}};}}} as unknown as ExtensionContext,options={budgetId:budget.budgetId,operationId:'same-operation',stage:'extract',maxTokens:321};
   assert.equal(await makeContext(pi,native).complete('original prompt',options),'original result');assert.equal(await makeContext(pi,native).complete('original prompt',options),'original result');
   let prompt='original prompt';const next={...options};const value=native.model as unknown as Record<string,unknown>;
   if(changed==='maxTokens')next.maxTokens=654;else if(changed==='thinking')level='high';else if(changed==='stage')next.stage='release';else if(changed==='prompt')prompt='different prompt';else if(changed==='modelMaxTokens')value.maxTokens=4096;else if(changed==='compat')value.compat={supportsDeveloperRole:false};else if(changed==='samplingParams')value.samplingParams={temperature:.7};else if(changed==='samplingParamsByThinkingLevel')value.samplingParamsByThinkingLevel={low:{temperature:.9}};else if(changed==='thinkingLevelMap')value.thinkingLevelMap={low:'medium'};else if(changed==='promptCache')value.promptCache={short:300};else if(changed==='inputLimits')value.inputLimits={maxRequestBytes:123456};else if(changed==='anthropicBeta')value.headers={'ANTHROPIC-BETA':'non-secret-feature'};else if(changed==='reasoning')value.reasoning=false;else if(changed==='contextWindow')value.contextWindow=16384;else value[changed]='different-'+String(value[changed]);
   await assert.rejects(makeContext(pi,native).complete(prompt,next),{code:'VERSION_CONFLICT'},changed);assert.equal(dispatches,1,changed);assert.equal(budgets.read(budget.budgetId).calls,1,changed);assert.match(budgets.readCall(budget.budgetId,'same-operation')!.requestHash!,/^[a-f0-9]{64}$/);
  }finally{store.close();if(prior===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=prior;rmSync(dir,{recursive:true,force:true});}
 }
});

test('request identity canonicalizes configuration order and excludes authentication keys, headers and timestamps',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'native-request-secrets-')),prior=process.env.FRIEND_PI_DATA_DIR;process.env.FRIEND_PI_DATA_DIR=dir;const store=new RecordStore('runtime',dir),budgets=new LearningBudget(store);let dispatches=0;
 try{
  const first={provider:'fixture',id:'proof',api:'openai-completions',baseUrl:'https://example.invalid/v1',compat:{thinkingFormat:'openai',supportsDeveloperRole:true,headers:{Authorization:'secret-A'},apiKey:'secret-A'},headers:{Authorization:'secret-A'},apiKey:'secret-A',createdAt:'yesterday'},second={...first,compat:{supportsDeveloperRole:true,thinkingFormat:'openai',headers:{Authorization:'secret-B'},apiKey:'secret-B'},headers:{Authorization:'secret-B'},apiKey:'secret-B',createdAt:'today'};
  assert.equal(learningRequestHash(first,'off',2048,'extract',digest('source')),learningRequestHash(second,'off',2048,'extract',digest('source')));
  assert.equal(learningRequestHash({...first,headers:{'Anthropic-Beta':'feature-a',Authorization:'secret-A'}},'off',2048,'extract',digest('source')),learningRequestHash({...second,headers:{'anthropic-beta':'feature-a',Authorization:'secret-B'}},'off',2048,'extract',digest('source')));
  assert.notEqual(learningRequestHash({...first,headers:{'anthropic-beta':'feature-a','Anthropic-Beta':'feature-b'}},'off',2048,'extract',digest('source')),learningRequestHash({...first,headers:{'Anthropic-Beta':'feature-b','anthropic-beta':'feature-a'}},'off',2048,'extract',digest('source')),'effective SDK feature value follows last case-insensitive matching header');
  const budget=budgets.create({projectId:'p',sourceRunId:'run',maxCalls:3}),pi={getThinkingLevel:()=> 'off',appendEntry:()=>{}} as unknown as ExtensionAPI,native={cwd:dir,model:first,sessionManager:SessionManager.inMemory(dir),isIdle:()=>true,ui:{notify:()=>{}},modelRegistry:{complete:async()=>{dispatches++;return {content:[{type:'text',text:'cached result'}],stopReason:'stop',usage:{totalTokens:4}};}}} as unknown as ExtensionContext,options={budgetId:budget.budgetId,operationId:'secret-independent',stage:'extract'};
  assert.equal(await makeContext(pi,native).complete('source',options),'cached result');Object.assign(native.model!,second);assert.equal(await makeContext(pi,native).complete('source',options),'cached result');assert.equal(dispatches,1);assert.doesNotMatch(JSON.stringify(store.list('learning-call:')),/secret-A|secret-B|Authorization|createdAt|example\.invalid/);
 }finally{store.close();if(prior===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=prior;rmSync(dir,{recursive:true,force:true});}
});

test('legacy dispatched and unknown operations never redispatch and legacy completed results cannot satisfy a new request identity',async()=>{
 for(const state of ['dispatched','unknown','complete'] as const){const dir=mkdtempSync(join(tmpdir(),'native-legacy-request-')),prior=process.env.FRIEND_PI_DATA_DIR;process.env.FRIEND_PI_DATA_DIR=dir;const store=new RecordStore('runtime',dir),budgets=new LearningBudget(store);let dispatches=0;
  try{const budget=budgets.create({projectId:'p',sourceRunId:'run',maxCalls:3}),legacy=budgets.begin({budgetId:budget.budgetId,operationId:'legacy',stage:'extract',promptHash:digest('source')});if(state!=='dispatched')budgets.finish({budgetId:budget.budgetId,operationId:'legacy',callId:legacy.callId,state,tokens:state==='complete'?4:undefined,result:state==='complete'?'legacy result':undefined});const pi={getThinkingLevel:()=> 'off',appendEntry:()=>{}} as unknown as ExtensionAPI,native={cwd:dir,model:{provider:'fixture',id:'proof'},sessionManager:SessionManager.inMemory(dir),isIdle:()=>true,ui:{notify:()=>{}},modelRegistry:{complete:async()=>{dispatches++;throw Error('legacy dispatch must be refused');}}} as unknown as ExtensionContext;
   await assert.rejects(makeContext(pi,native).complete('source',{budgetId:budget.budgetId,operationId:'legacy',stage:'extract'}),{code:state==='complete'?'VERSION_CONFLICT':'OPERATION_UNKNOWN'});assert.equal(dispatches,0);assert.equal(budgets.read(budget.budgetId).calls,1);assert.equal(budgets.readCall(budget.budgetId,'legacy')!.state,state);if(state==='complete')assert.equal(budgets.begin({budgetId:budget.budgetId,operationId:'legacy',stage:'extract',promptHash:digest('source')}).result,'legacy result');
  }finally{store.close();if(prior===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=prior;rmSync(dir,{recursive:true,force:true});}
 }
});

test('a new unknown operation stays unknown across changed request parameters without any second dispatch',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'native-unknown-identity-')),prior=process.env.FRIEND_PI_DATA_DIR;process.env.FRIEND_PI_DATA_DIR=dir;const store=new RecordStore('runtime',dir),budgets=new LearningBudget(store);let dispatches=0;
 try{const budget=budgets.create({projectId:'p',sourceRunId:'run',maxCalls:3}),pi={getThinkingLevel:()=> 'off',appendEntry:()=>{}} as unknown as ExtensionAPI,native={cwd:dir,model:{provider:'fixture',id:'proof'},sessionManager:SessionManager.inMemory(dir),isIdle:()=>true,ui:{notify:()=>{}},modelRegistry:{complete:async()=>{dispatches++;throw Error('unknown transport result');}}} as unknown as ExtensionContext,options={budgetId:budget.budgetId,operationId:'unknown',stage:'extract',maxTokens:10};await assert.rejects(makeContext(pi,native).complete('source',options),{code:'OPERATION_UNKNOWN'});await assert.rejects(makeContext(pi,native).complete('source',{...options,maxTokens:20}),{code:'OPERATION_UNKNOWN'});assert.equal(dispatches,1);assert.equal(budgets.read(budget.budgetId).calls,1);
 }finally{store.close();if(prior===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=prior;rmSync(dir,{recursive:true,force:true});}
});
