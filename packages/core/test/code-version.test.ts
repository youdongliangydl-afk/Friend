import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {appendFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync,unlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {projectCodeVersion} from '../src/code-version.js';
import {CapabilityError,GoalLedger,RecordStore,TaskLedger,type PluginContext} from '../src/index.js';

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
  for(const name of ['pi','sessions','swarm-sessions','swarm-workspaces','swarm-shared','swarm-views','memory-views','memory-migration-backups','projections','artifact-versions','attachments']){
   mkdirSync(join(f.data,name),{recursive:true});writeFileSync(join(f.data,name,'host.txt'),'host output');
  }
  writeFileSync(join(f.data,'external-capabilities.json'),'{}');
  writeFileSync(join(f.data,'swarm-pre-v3-1234abcd.sqlite'),'migration backup');
  assert.equal(projectCodeVersion(f.project,f.data),version);
  mkdirSync(join(f.project,'deliverables'));writeFileSync(join(f.project,'deliverables','result.txt'),'actual result');
  assert.notEqual(projectCodeVersion(f.project,f.data),version);
 }finally{f.close();}
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

test('canonical roots still bind internal symlink spelling without following target contents',()=>{
 const f=fixture('sibling');try{
  const external=join(f.base,'external');mkdirSync(external);writeFileSync(join(external,'one.txt'),'before');writeFileSync(join(external,'two.txt'),'before');
  const link=join(f.project,'linked.txt');symlinkSync(join(external,'one.txt'),link);
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
  let waiting=await goals.finish(ctx,tasks,noAudit,true);assert.equal(waiting.waitFor,'user-acceptance');assert.notEqual(waiting.acceptance!.codeVersion,emptyHash);
  const oldInput={goalId:goal.id,expectedRevision:waiting.revision,candidateDigest:waiting.acceptance!.binding};
  f.store.put('background-learning',{state:'complete'});assert.equal(projectCodeVersion(f.project,f.data),waiting.acceptance!.codeVersion);
  if(changeAfterCheck){
   appendFileSync(join(f.project,'result.txt'),'GUI_POSTCHECK_EDIT\n');
   assert.throws(()=>goals.accept(oldInput,ctx,tasks,true),(error:unknown)=>error instanceof CapabilityError&&error.code==='VERSION_CONFLICT');
   assert.equal(goals.read(goal.id,ctx).status,'waiting');
   const resumed=goals.resume({goalId:goal.id},ctx,2);assert.equal(resumed.acceptance,undefined);
   await verify(resumed.writeEpoch!);goals.update({progress:'changed result rechecked'},ctx);
   waiting=await goals.finish(ctx,tasks,noAudit,true);assert.notEqual(waiting.acceptance!.binding,oldInput.candidateDigest);
   assert.throws(()=>goals.accept(oldInput,ctx,tasks,true));
   assert.equal(readFileSync(join(f.project,'result.txt'),'utf8'),'SINGLE_OK\nGUI_POSTCHECK_EDIT\n');
  }
  assert.equal(goals.accept({goalId:goal.id,expectedRevision:waiting.revision,candidateDigest:waiting.acceptance!.binding},ctx,tasks,true).status,'completed');
 }finally{goals.dispose();tasks.dispose();}
}
