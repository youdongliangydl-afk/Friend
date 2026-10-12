import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import {digest,historyItems,isDerivedCapabilityInput,type SourceRef} from '@friend-pi/core';
import {expertTraceSources} from '../apps/desktop/src/expert-trace-evidence.js';

// Run the production bridge without starting a worker, writing a database or calling a provider.
// Repository tests run from their checkout root, including when this test is handed off alone.
const sdkPath=resolve('apps/desktop/src/sdk-worker.ts'),sdkSource=readFileSync(sdkPath,'utf8');
const ast=ts.createSourceFile(sdkPath,sdkSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
const declarations=ast.statements.filter((node):node is ts.FunctionDeclaration=>ts.isFunctionDeclaration(node)&&node.name?.text==='enqueueExpertTrace');
assert.equal(declarations.length,1,'Test the actual production enqueueExpertTrace declaration');
const emitted=ts.transpileModule(`(${declarations[0].getText(ast)})`,{compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext},reportDiagnostics:true});
assert.deepEqual(emitted.diagnostics?.filter(item=>item.category===ts.DiagnosticCategory.Error),[]);
const plain=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
type State='unknown'|'stopped'|'pending'|'running'|'blocked'|'repair'|'completed';
type Native={records:Record<string,unknown>[];invalidChecks:boolean;failedChecks:boolean};
function fixture(status:State='completed'){
  const requests:{action:string;input:Record<string,any>}[]=[],registered:Record<string,any>[]=[],notices:unknown[]=[],order:string[]=[],asserted:SourceRef[]=[];
  const message={role:'toolResult',toolName:'bash',toolCallId:'call',content:[{type:'text',text:'actual check output'}],isError:false,timestamp:1};
  const entries=[{type:'message',id:'user',message:{role:'user',content:'Original user goal',timestamp:0}},{type:'custom',id:'input',customType:'friend-pi.input.v1',data:{runId:'run',entryId:'user',textEnd:'Original user goal'.length,hash:digest('Original user goal')}},{type:'message',id:'result',message}];
  const source={sessionId:'session',entryId:'result',start:0,end:'actual check output'.length,hash:digest('actual check output')};
  const ref={checkId:'pi:session:result',version:1,hash:digest(message),taskId:'run',producerRunId:'run',artifacts:[]};
  const record={ref,projectId:'project',passed:true,output:{exitCode:0,text:'actual check output',trialAttribution:{v:1,decisionEntryId:'decision',adoptions:[]}},sources:[source]};
  const native:Native={records:[record],invalidChecks:false,failedChecks:false};
  const task={id:'task',runId:'run',revision:2,status,checkRefs:[]};
  const state:Record<string,any>={disposed:false,runId:'run',enabled:['expert'],session:{sessionId:'session',sessionManager:{getBranch:()=>entries},messages:[{role:'assistant',stopReason:'stop'}]},services:{snapshot:()=>({tasks:[task]})},historyItems,isDerivedCapabilityInput,object:(value:unknown)=>value&&typeof value==='object'&&!Array.isArray(value)?value:{},cancelRequested:false,lifecycleStatus:'completed',expertTraceSources,expertTraceChecks:(_branch:unknown,context:Record<string,unknown>)=>{assert.equal(context.sessionId,'session');assert.equal(context.projectId,'project');assert.equal(context.runId,'run');return native;},SourcePolicy:class {assertSource(value:SourceRef){asserted.push(plain(value));order.push('assertSource');}registerCheck(value:Record<string,unknown>){registered.push(plain(value));order.push('registerCheck');}},artifactStore:{},projectIdentity:()=> 'project',cwd:'project-dir',digest,publish:(_type:string,value:unknown)=>{notices.push(value);},publicError:(value:unknown)=>value instanceof Error?value.message:String(value),bus:{},stopping:false};
  let afterObserve:(()=>void)|undefined;
  state.requestPlugin=async(_bus:unknown,plugin:string,action:string,input:Record<string,unknown>)=>{assert.equal(plugin,'expert');requests.push({action,input:plain(input)});order.push(action);if(action==='trial.observe')afterObserve?.();return {};};
  const context=vm.createContext(state),run=vm.runInContext(emitted.outputText,context) as ()=>Promise<void>;
  return {state,task,record,native,requests,registered,notices,order,asserted,run,afterObserve(callback:()=>void){afterObserve=callback;}};
}
const request=(f:ReturnType<typeof fixture>,action:string)=>f.requests.find(item=>item.action===action)?.input;
function noLearning(f:ReturnType<typeof fixture>,outcome:string){assert.equal(request(f,'trial.observe')?.outcome,outcome);assert.equal(request(f,'taskTraceReady'),undefined);}

for(const status of ['unknown','stopped','pending','running'] as const)test(`desktop trace preserves ${status} even with a valid completed native check`,async()=>{
  const f=fixture(status);await f.run();noLearning(f,status==='stopped'?'cancelled':'unknown');assert.deepEqual(f.registered,[f.record]);assert.equal(request(f,'trial.observe')?.checks.length,1);
});

test('unknown task takes precedence over another stopped task',async()=>{
  const f=fixture('unknown');f.state.services.snapshot=()=>({tasks:[f.task,{...f.task,id:'stopped',status:'stopped'}]});await f.run();noLearning(f,'unknown');
});

for(const status of ['blocked','repair'] as const)test(`known ${status} trace remains a failed experience`,async()=>{
  const f=fixture(status);await f.run();assert.equal(request(f,'trial.observe')?.outcome,'failed');const trace=request(f,'taskTraceReady')!;assert.equal(trace.taskResult.status,'failed');assert.equal(trace.taskResult.tasks[0].status,status);assert.equal(trace.evidence.filter((item:Record<string,unknown>)=>item.kind==='check').length,1);
});

test('actual native failed check makes a settled main turn a failed experience',async()=>{
  const f=fixture();f.native.failedChecks=true;f.record.passed=false;f.record.output.exitCode=7;await f.run();assert.equal(request(f,'trial.observe')?.outcome,'failed');assert.equal(request(f,'taskTraceReady')?.taskResult.status,'failed');
});

test('invalid native receipt keeps the whole trace unknown despite another valid record',async()=>{
  const f=fixture();f.native.invalidChecks=true;await f.run();noLearning(f,'unknown');assert.deepEqual(f.registered,[f.record]);assert.equal(f.notices.length,1);
});

test('completed trace registers canonical sources/checks before trial and extraction requests',async()=>{
  const f=fixture();await f.run();assert.deepEqual(f.registered,[f.record]);assert.deepEqual(f.asserted,f.record.sources);assert.deepEqual(f.order,['assertSource','registerCheck','trial.observe','taskTraceReady']);const trial=request(f,'trial.observe')!,trace=request(f,'taskTraceReady')!;assert.equal(trial.outcome,'completed');assert.deepEqual(trial.checks,[f.record.ref]);assert.equal(trace.runId,'run');assert.equal(trace.taskResult.status,'completed');assert.deepEqual(trace.evidence.filter((item:Record<string,unknown>)=>item.kind==='check'),[{kind:'check',projectId:'project',check:f.record.ref}]);assert.ok(trace.evidence.some((item:Record<string,unknown>)=>item.kind==='pi'));assert.ok(Number.isSafeInteger(trace.taskResultVersion)&&trace.taskResultVersion>0);
});

for(const variant of ['cancelled','aborted','error'] as const)test(`desktop ${variant} turn never enqueues extraction`,async()=>{
  const f=fixture();if(variant==='cancelled')f.state.cancelRequested=true;else f.state.session.messages[0].stopReason=variant;await f.run();noLearning(f,variant==='error'?'unknown':'cancelled');
});

for(const change of ['run','session','stop','cancel'] as const)test(`desktop ${change} change during trial observation cannot queue the captured old trace`,async()=>{
  const f=fixture();f.afterObserve(()=>{if(change==='run')f.state.runId='new-run';if(change==='session')f.state.session.sessionId='new-session';if(change==='stop')f.state.stopping=true;if(change==='cancel')f.state.cancelRequested=true;});await f.run();assert.equal(request(f,'taskTraceReady'),undefined);assert.equal(request(f,'trial.observe')?.runId,'run');
});

test('check/source registration failure remains unknown and cannot queue learning',async()=>{
  const f=fixture();f.state.SourcePolicy=class {assertSource(){throw Error('source revoked');}registerCheck(){throw Error('must not register');}};await f.run();noLearning(f,'unknown');assert.deepEqual(f.registered,[]);
});

test('unverified original input boundary remains unknown and cannot queue learning',async()=>{
  const f=fixture();f.state.expertTraceSources=()=>{throw Error('original input boundary unverified');};await f.run();noLearning(f,'unknown');assert.deepEqual(f.registered,[]);
});

test('identical retained trace has a stable result version; new canonical check changes it',async()=>{
  const first=fixture(),reopened=fixture(),changed=fixture();changed.record.ref.hash='different-native-message-hash';await first.run();await reopened.run();await changed.run();const a=request(first,'taskTraceReady')!,b=request(reopened,'taskTraceReady')!,c=request(changed,'taskTraceReady')!;assert.equal(a.taskResultVersion,b.taskResultVersion);assert.deepEqual(a,b);assert.notEqual(a.taskResultVersion,c.taskResultVersion);
});

test('disabled Expert causes no registration or observation requests',async()=>{
  const f=fixture();f.state.enabled=[];await f.run();assert.deepEqual(f.requests,[]);assert.deepEqual(f.registered,[]);
});
