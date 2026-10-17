import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {appendFileSync,existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {projectCodeVersion} from '../src/code-version.js';
import {CapabilityError,GoalLedger,RecordStore,TaskLedger,type PluginContext} from '../src/index.js';
import {ProcessJobs} from '../../../apps/desktop/src/process-jobs.js';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';

const emptyHash=createHash('sha256').digest('hex');
type Layout='nested-project'|'nested-data'|'same-root'|'sibling';
function fixture(layout:Layout){
 const base=mkdtempSync(join(tmpdir(),'friend-code-version-'));
 const project=layout==='nested-project'?join(base,'data','projects','single'):join(base,'project');
 const data=layout==='nested-data'?join(project,'host-data'):layout==='same-root'?project:join(base,'data');
 mkdirSync(project,{recursive:true});mkdirSync(data,{recursive:true});
 const store=new RecordStore('host-test',data);
 return {base,project,data,store,close(){store.close();rmSync(base,{recursive:true,force:true});}};
}

for(const layout of ['nested-project','nested-data','same-root','sibling'] as const){
 test(`project contents remain bound with ${layout}, while host SQLite writes do not change the version`,()=>{
  const f=fixture(layout);try{
   writeFileSync(join(f.project,'result.txt'),'SINGLE_OK\n');
   const version=projectCodeVersion(f.project,f.data);assert.notEqual(version,emptyHash);
   f.store.put('background-learning',{state:'running'});
   f.store.db.exec('PRAGMA wal_checkpoint(FULL)');
   assert.equal(projectCodeVersion(f.project,f.data),version);
   appendFileSync(join(f.project,'result.txt'),'GUI_POSTCHECK_EDIT\n');
   assert.notEqual(projectCodeVersion(f.project,f.data),version);
  }finally{f.close();}
 });
}

test('host projection names are excluded only at the actual data root; user .pi contents remain bound',()=>{
 const f=fixture('nested-project');try{
  for(const name of ['sessions','memory-views','projections','attachments','.pi']){
   mkdirSync(join(f.project,name),{recursive:true});writeFileSync(join(f.project,name,'source.txt'),'before');
  }
  let version=projectCodeVersion(f.project,f.data);
  for(const name of ['sessions','memory-views','projections','attachments','.pi']){
   appendFileSync(join(f.project,name,'source.txt'),'after');
   const changed=projectCodeVersion(f.project,f.data);assert.notEqual(changed,version,name);version=changed;
  }
  mkdirSync(join(f.project,'.pi','tasks'),{recursive:true});
  const taskVersion=projectCodeVersion(f.project,f.data);
  writeFileSync(join(f.project,'.pi','tasks','output.txt'),'host output');
  assert.equal(projectCodeVersion(f.project,f.data),taskVersion);
 }finally{f.close();}
});

test('same-root host projections and native history do not invalidate business files',()=>{
 const f=fixture('same-root');try{
  writeFileSync(join(f.project,'result.txt'),'SINGLE_OK\n');
  const version=projectCodeVersion(f.project,f.data);
  for(const name of ['pi','sessions','swarm-sessions','swarm-workspaces','swarm-shared','swarm-views','memory-views','memory-migration-backups','expert-migration-backups','expert-evaluations','projections','artifact-versions','attachments']){
   mkdirSync(join(f.data,name),{recursive:true});writeFileSync(join(f.data,name,'host.txt'),'host output');
  }
  writeFileSync(join(f.data,'external-capabilities.json'),'{}');
  writeFileSync(join(f.data,'swarm-pre-v3-1234abcd.sqlite'),'migration backup');
  writeFileSync(join(f.data,'swarm-pre-v4-1234abcd.sqlite'),'migration backup');
  assert.equal(projectCodeVersion(f.project,f.data),version);
  mkdirSync(join(f.project,'deliverables'));writeFileSync(join(f.project,'deliverables','result.txt'),'actual result');
  assert.notEqual(projectCodeVersion(f.project,f.data),version);
 }finally{f.close();}
});

test('first host .pi parent creation is stable while its user files and directories remain bound',()=>{
 const f=fixture('nested-project');try{
  writeFileSync(join(f.project,'result.txt'),'SINGLE_OK\n');const version=projectCodeVersion(f.project,f.data);
  mkdirSync(join(f.project,'.pi','tasks','first-check'),{recursive:true});writeFileSync(join(f.project,'.pi','tasks','first-check','stdout.log'),'host output');
  assert.equal(projectCodeVersion(f.project,f.data),version);
  writeFileSync(join(f.project,'.pi','user.txt'),'before');let userVersion=projectCodeVersion(f.project,f.data);assert.notEqual(userVersion,version);
  appendFileSync(join(f.project,'.pi','user.txt'),'after');const changed=projectCodeVersion(f.project,f.data);assert.notEqual(changed,userVersion);userVersion=changed;
  mkdirSync(join(f.project,'.pi','user-directory'));assert.notEqual(projectCodeVersion(f.project,f.data),userVersion);
 }finally{f.close();}
});

test('first real ProcessJobs check can create its .pi host parent during TaskLedger verification',async()=>{
 const f=fixture('nested-project'),goals=new GoalLedger(f.data),tasks=new TaskLedger(f.data),jobs=new ProcessJobs(f.data,()=>{},()=>{});
 const hooks=new Map<string,((event:unknown,ctx:unknown)=>Promise<unknown>)[]>();
 const native={cwd:f.project,sessionManager:{getSessionId:()=> 'code-version-first-process-check'},modelRegistry:{getAll:()=>[]},hasUI:false,ui:{}};
 const ctx:PluginContext={origin:'user',executionMode:'single',dataDir:f.data,projectDir:f.project,projectId:'project',sessionId:'code-version-first-process-check',runId:'run',isIdle:()=>true,history:()=>[],readSource:()=>{throw new Error('unexpected source read');},complete:async()=>{throw new Error('model calls are forbidden');},request:async()=>{throw new Error('external calls are forbidden');},emit:()=>{},notify:()=>{},appendEntry:()=>{}};
 try{
  writeFileSync(join(f.project,'result.txt'),'SINGLE_OK\n');
  writeFileSync(join(f.project,'check.mjs'),"import {readFileSync} from 'node:fs';\nif(readFileSync('result.txt','utf8')!=='SINGLE_OK\\n')throw new Error('SINGLE_OUTPUT_MISMATCH');\nconsole.log('SINGLE_OUTPUT_OK');\n");
  await jobs.extension()({on:(name:string,handler:(event:unknown,ctx:unknown)=>Promise<unknown>)=>{const handlers=hooks.get(name)||[];handlers.push(handler);hooks.set(name,handlers);}} as unknown as ExtensionAPI);
  assert.equal(existsSync(join(f.project,'.pi')),false);
  const goal=goals.create({objective:'check actual result through the production process backend'},ctx,1);goals.noteWrite(ctx,'write');
  const task=tasks.create({title:'first process check',mode:'write',checks:[{command:process.execPath,args:['check.mjs']}]},ctx,goal.id),before=projectCodeVersion(f.project,f.data);
  const checked=await tasks.verify(task.id,{result:'production process check passed'},ctx,async check=>{
   for(const handler of hooks.get('session_start')||[])await handler({reason:'startup'},native);
   assert.equal(existsSync(join(f.project,'.pi','tasks')),true);
   const result=await jobs.check(check,ctx,1);assert.equal(result.exitCode,0);assert.match(result.output,/SINGLE_OUTPUT_OK/);return result;
  },1);
  assert.equal(checked.status,'completed');assert.equal(projectCodeVersion(f.project,f.data),before);
  goals.update({progress:'actual process check passed'},ctx);const completed=await goals.finish(ctx,tasks,async()=>{throw new Error('Single must not start a reviewer');},true);
  assert.equal(completed.status,'complete');assert.equal(goals.current(ctx),undefined);assert.equal(goals.getLastCompleted(ctx)?.id,goal.id);
 }finally{
  try{for(const handler of hooks.get('session_shutdown')||[])await handler({reason:'shutdown'},native);}finally{
   jobs.dispose();goals.dispose();tasks.dispose();
   // The real backend persists final notification metadata after publishing completion.
   process.once('beforeExit',()=>f.close());
  }
 }
});

for(const git of [false,true]){
 test(`Single rejects a changed nested ${git?'Git':'non-Git'} result, then accepts only a fresh real check`,async()=>{
  const f=fixture('nested-project');if(git){const init=spawnSync('git',['init','--quiet',f.project],{encoding:'utf8'});assert.equal(init.status,0,init.stderr);}
  try{await singleAcceptance(f,true);}finally{f.close();}
 });
}

test('Single accepts a same-root candidate despite its own SQLite and native receipt writes',async()=>{
 const f=fixture('same-root');try{await singleAcceptance(f,false);}finally{f.close();}
});

for(const aliasTarget of ['project','data'] as const){
 test(`Single recognizes the same host root through a ${aliasTarget} directory symlink`,async()=>{
  const f=fixture('same-root'),alias=join(f.base,'root-alias');symlinkSync(f.project,alias,'dir');
  try{await singleAcceptance({...f,...(aliasTarget==='project'?{project:alias}:{data:alias})},false);}finally{f.close();}
 });
}

for(const linkName of ['linked.txt','.pi'])test(`canonical roots still bind ${linkName} symlink spelling without following target contents`,()=>{
 const f=fixture('sibling');try{
  const external=join(f.base,'external');mkdirSync(external);writeFileSync(join(external,'one.txt'),'before');writeFileSync(join(external,'two.txt'),'before');
  const link=join(f.project,linkName);symlinkSync(join(external,'one.txt'),link);
  const version=projectCodeVersion(f.project,f.data);writeFileSync(join(external,'one.txt'),'after');
  assert.equal(projectCodeVersion(f.project,f.data),version);
  unlinkSync(link);symlinkSync(join(external,'two.txt'),link);
  assert.notEqual(projectCodeVersion(f.project,f.data),version);
 }finally{f.close();}
});

async function singleAcceptance(f:ReturnType<typeof fixture>,changeAfterCheck:boolean){
 const goals=new GoalLedger(f.data),tasks=new TaskLedger(f.data),sessionDir=join(f.data,'sessions');mkdirSync(sessionDir,{recursive:true});
 const ctx:PluginContext={origin:'user',executionMode:'single',dataDir:f.data,projectDir:f.project,projectId:'project',sessionId:'session',runId:'run',isIdle:()=>true,history:()=>[],readSource:()=>{throw new Error('unexpected source read');},complete:async()=>{throw new Error('model calls are forbidden');},request:async()=>{throw new Error('external calls are forbidden');},emit:()=>{},notify:()=>{},appendEntry:(type,data)=>appendFileSync(join(sessionDir,'receipts.jsonl'),JSON.stringify({type,data})+'\n')};
 try{
  writeFileSync(join(f.project,'result.txt'),'SINGLE_OK\n');
  writeFileSync(join(f.project,'check.mjs'),"import {readFileSync} from 'node:fs';\nif(!readFileSync('result.txt','utf8').startsWith('SINGLE_OK\\n'))throw new Error('SINGLE_OUTPUT_MISMATCH');\nconsole.log('SINGLE_OUTPUT_OK');\n");
  const goal=goals.create({objective:'write and check a result'},ctx,1);goals.noteWrite(ctx,'write');
  const task=tasks.create({title:'check actual result',mode:'write',checks:[{command:process.execPath,args:['check.mjs']}]},ctx,goal.id);
  const verify=async(writeEpoch:number)=>tasks.verify(task.id,{result:'actual Node file check passed'},ctx,async check=>{
   const result=spawnSync(check.command,check.args,{cwd:f.project,encoding:'utf8',timeout:5000});
   assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/SINGLE_OUTPUT_OK/);
   return {...check,exitCode:result.status,output:result.stdout+result.stderr};
  },writeEpoch);
  await verify(1);goals.update({progress:'result is ready'},ctx);
  const noAudit=async()=>{throw new Error('Single must not start a reviewer');};
  const checked=tasks.read(task.id,ctx).verificationCodeVersion;assert.ok(checked);assert.notEqual(checked,emptyHash);
  f.store.put('background-learning',{state:'complete'});assert.equal(projectCodeVersion(f.project,f.data),checked);
  if(changeAfterCheck){
   appendFileSync(join(f.project,'result.txt'),'GUI_POSTCHECK_EDIT\n');
   assert.notEqual(projectCodeVersion(f.project,f.data),checked);
   assert.equal(tasks.read(task.id,ctx).verificationCodeVersion,checked,'old evidence remains attached to its actual candidate');
   goals.noteWrite(ctx,'second-write');await verify(goals.current(ctx)!.writeEpoch!);
   assert.notEqual(tasks.read(task.id,ctx).verificationCodeVersion,checked);
   assert.equal(tasks.read(task.id,ctx).verificationCodeVersion,projectCodeVersion(f.project,f.data));
   goals.update({progress:'changed result rechecked'},ctx);
  }
  const completed=await goals.finish(ctx,tasks,noAudit,true);assert.equal(completed.status,'complete');
  assert.equal(goals.current(ctx),undefined);assert.equal(goals.getLastCompleted(ctx)?.id,goal.id);
  assert.throws(()=>goals.accept({goalId:goal.id},ctx,tasks,true),{code:'VERSION_CONFLICT'});
 }finally{goals.dispose();tasks.dispose();}
}
