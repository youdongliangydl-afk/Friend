import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CapabilityError,RecordStore,digest,type PluginContext} from '@friend-pi/core';
import {Artifacts,fileDigest} from '../src/artifacts.js';
import {SwarmStorage} from '../src/storage.js';
import type {Graph,Attempt} from '../src/types.js';

type Layout='nested-project'|'nested-data'|'same-root'|'sibling'|'workspace-root';
function fixture(layout:Layout){
 const base=mkdtempSync(join(tmpdir(),'swarm-artifact-staging-'));
 const project=layout==='nested-project'?join(base,'data','acceptance-project'):layout==='workspace-root'?join(base,'data','swarm-workspaces'):join(base,'project');
 const data=layout==='same-root'?project:layout==='nested-data'?join(project,'host-data'):join(base,'data');
 mkdirSync(project,{recursive:true});mkdirSync(data,{recursive:true});
 const store=new RecordStore('swarm',data);new SwarmStorage(store);const artifacts=new Artifacts(store,()=>{});
 const ctx:PluginContext={origin:'user',executionMode:'team',projectDir:project,dataDir:data,projectId:'project',sessionId:'session',runId:'run',isIdle:()=>true,history:()=>[],readSource:()=>{throw new Error('unexpected source read');},complete:async()=>{throw new Error('model calls are forbidden');},request:async()=>{throw new Error('external calls are forbidden');},emit:()=>{},notify:()=>{},appendEntry:()=>{}};
 const graph:Graph={schemaVersion:3,id:'graph',projectId:ctx.projectId,sessionId:ctx.sessionId,projectDir:project,goal:'stage real business inputs',executionStyle:'team',status:'created',createdAt:'',updatedAt:'',maxWorkers:1,reworkRound:0,checks:[],tasks:[{id:'writer',title:'writer',prompt:'read README and edit CSV',dependencies:[],mode:'write',writeScopes:['shared.csv'],status:'pending',currentAttempt:'attempt',rework:0,resultRevision:0}],attempts:[],contract:{version:1,goal:'stage real business inputs',risk:'low',artifacts:[{id:'csv',kind:'file',target:'shared.csv',taskId:'writer',required:true}],checks:[],verification:'V1',resources:[],permissionDigest:'fixture',acceptance:[],forbiddenEffects:[]}};
 const attempt:Attempt={id:'attempt',taskId:'writer',number:1,resultRevision:0,status:'running',cwd:project,mode:'write',writeScopes:['shared.csv'],ownerPid:process.pid,ownerRuntime:'fixture',startedAt:''};graph.attempts.push(attempt);
 writeFileSync(join(project,'README.md'),'TEAM_INPUT_README\n');writeFileSync(join(project,'shared.csv'),'stage,count\nBASE,0\n');
 return {base,project,data,ctx,store,artifacts,graph,attempt,close(){store.close();rmSync(base,{recursive:true,force:true});}};
}

for(const layout of ['nested-project','nested-data','same-root','sibling','workspace-root'] as const){
 test(`real stage and composite preserve business inputs with ${layout} and omit host state`,()=>{
  const f=fixture(layout);try{
   mkdirSync(join(f.data,'sessions'),{recursive:true});writeFileSync(join(f.data,'sessions','host.jsonl'),'host history');
   mkdirSync(join(f.data,'pi'),{recursive:true});writeFileSync(join(f.data,'pi','host-settings.json'),'host settings');
   stageAndCompose(f);
  }finally{f.close();}
 });
}

for(const aliasTarget of ['project','data'] as const){
 test(`same-root ${aliasTarget} alias still copies README and excludes host staging/state`,()=>{
  const f=fixture('same-root'),alias=join(f.base,'alias');symlinkSync(f.project,alias,'dir');
  try{
   if(aliasTarget==='project'){f.ctx.projectDir=alias;f.graph.projectDir=alias;}else f.ctx.dataDir=alias;
   stageAndCompose(f);
  }finally{f.close();}
 });
}

test('data ancestor does not exclude equally named business directories',()=>{
 const f=fixture('nested-project');try{
  for(const name of ['sessions','pi','memory-views','projections','attachments','swarm-workspaces']){
   mkdirSync(join(f.project,name));writeFileSync(join(f.project,name,'input.txt'),`business ${name}`);
  }
  const staged=f.artifacts.stage(f.graph,f.attempt,f.ctx);
  for(const name of ['sessions','pi','memory-views','projections','attachments','swarm-workspaces']){
   assert.equal(readFileSync(join(staged.cwd,name,'input.txt'),'utf8'),`business ${name}`);
   assert.equal(staged.baselines[`${name}/input.txt`],digest(`business ${name}`));
  }
 }finally{f.close();}
});

test('actual temporary staging subtree is excluded without losing nearby business inputs',()=>{
 const f=fixture('sibling');try{
  f.ctx.policy={v:1,revision:1,stage:'main',canSwitchRole:false,unsettledTools:0,tools:[],writeScopes:['.'],executionMode:'team',planMode:false,temporaryWriteRoot:f.project};
  mkdirSync(join(f.project,'swarm-workspaces','old-attempt'),{recursive:true});writeFileSync(join(f.project,'swarm-workspaces','old-attempt','host.txt'),'host staging');
  mkdirSync(join(f.project,'inputs','swarm-workspaces'),{recursive:true});writeFileSync(join(f.project,'inputs','swarm-workspaces','input.txt'),'business input');
  const staged=f.artifacts.stage(f.graph,f.attempt,f.ctx);
  assert.equal(readFileSync(join(staged.cwd,'README.md'),'utf8'),'TEAM_INPUT_README\n');
  assert.equal(readFileSync(join(staged.cwd,'inputs','swarm-workspaces','input.txt'),'utf8'),'business input');
  assert.equal(existsSync(join(staged.cwd,'swarm-workspaces')),false);assert.equal(staged.baselines['swarm-workspaces/old-attempt/host.txt'],undefined);
 }finally{f.close();}
});

test('same-root host names are excluded at the data root, while nested business names copy normally',()=>{
 const f=fixture('same-root');try{
  for(const name of ['sessions','pi','memory-views','projections','attachments','expert-evaluations','expert-migration-backups']){
   mkdirSync(join(f.data,name));writeFileSync(join(f.data,name,'host.txt'),'host state');
   mkdirSync(join(f.project,'inputs',name),{recursive:true});writeFileSync(join(f.project,'inputs',name,'input.txt'),`business ${name}`);
  }
  const staged=f.artifacts.stage(f.graph,f.attempt,f.ctx);
  for(const name of ['sessions','pi','memory-views','projections','attachments','expert-evaluations','expert-migration-backups']){
   assert.equal(existsSync(join(staged.cwd,name)),false);assert.equal(readFileSync(join(staged.cwd,'inputs',name,'input.txt'),'utf8'),`business ${name}`);
  }
 }finally{f.close();}
});

test('staging preserves the existing rejection of business symlinks',()=>{
 const f=fixture('nested-project');try{
  const external=join(f.base,'external.txt');writeFileSync(external,'outside business input');symlinkSync(external,join(f.project,'linked.txt'));
  assert.throws(()=>f.artifacts.stage(f.graph,f.attempt,f.ctx),(error:unknown)=>error instanceof CapabilityError&&error.code==='VALIDATION_ERROR'&&error.message.includes('符号链接'));
 }finally{f.close();}
});

function stageAndCompose(f:ReturnType<typeof fixture>){
 const staged=f.artifacts.stage(f.graph,f.attempt,f.ctx);
 assert.equal(readFileSync(join(staged.cwd,'README.md'),'utf8'),'TEAM_INPUT_README\n');
 assert.equal(readFileSync(join(staged.cwd,'shared.csv'),'utf8'),'stage,count\nBASE,0\n');
 assert.equal(staged.baselines['README.md'],fileDigest(join(f.project,'README.md')));assert.equal(staged.inputBaselines['shared.csv'],fileDigest(join(f.project,'shared.csv')));
 for(const name of ['plugins.sqlite','plugins.sqlite-wal','plugins.sqlite-shm','sessions','pi','host-data','swarm-workspaces'])assert.equal(existsSync(join(staged.cwd,name)),false,name);
 assert.equal(Object.keys(staged.baselines).some(path=>path.startsWith('swarm-pre-v3-')),false);
 Object.assign(f.attempt,{cwd:staged.cwd,targetBaselines:staged.baselines,inputBaselines:staged.inputBaselines,summary:'actual staged CSV edit'});
 writeFileSync(join(staged.cwd,'shared.csv'),'stage,count\nA,1\n');const collected=f.artifacts.collect(f.graph,f.attempt,f.ctx);assert.equal(collected.length,1);
 const composite=f.artifacts.composite(f.graph,f.ctx);
 assert.equal(readFileSync(join(composite,'README.md'),'utf8'),'TEAM_INPUT_README\n');assert.equal(readFileSync(join(composite,'shared.csv'),'utf8'),'stage,count\nA,1\n');
 assert.equal(existsSync(join(composite,f.ctx.projectId,f.graph.id,'artifacts')),false);
 assert.equal(readFileSync(join(f.project,'shared.csv'),'utf8'),'stage,count\nBASE,0\n');assert.equal(readFileSync(join(f.project,'README.md'),'utf8'),'TEAM_INPUT_README\n');
}
