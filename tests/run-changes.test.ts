import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,renameSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RunChangesTracker,projectRunChanges,RUN_CHANGES_TYPE,type RunChangesSummary} from '../apps/desktop/src/run-changes.js';
import {parsePatch,captureRunBaseline,workspaceDiff} from '../apps/desktop/src/workspace-files.js';
function fixture(){const root=mkdtempSync(join(tmpdir(),'friend-changes-')),data=mkdtempSync(join(tmpdir(),'friend-changes-data-'));const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'});git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@localhost');git('config','commit.gpgsign','false');writeFileSync(join(root,'tracked.txt'),'old\n');git('add','.');git('commit','-qm','baseline');return {root,data,git,close:()=>{rmSync(root,{recursive:true,force:true});rmSync(data,{recursive:true,force:true});}};}
test('run summary isolates dirty baseline and includes committed changes, binary, deletion and empty files',async()=>{
 const f=fixture(),summaries:RunChangesSummary[]=[];try{
  writeFileSync(join(f.root,'dirty.txt'),'preexisting\n');const tracker=new RunChangesTracker(f.root,'p',f.data,'s',summary=>summaries.push(summary));await tracker.begin('one');
  writeFileSync(join(f.root,'tracked.txt'),'new\n');writeFileSync(join(f.root,'image.png'),Buffer.from([1,0,2]));writeFileSync(join(f.root,'empty.txt'),'');f.git('add','.');f.git('commit','-qm','changes during run');
  await tracker.settle('one','completed','a');assert.equal(summaries.length,1);assert.equal(summaries[0].files.length,3);assert.ok(!summaries[0].files.some(file=>file.path==='dirty.txt'));assert.equal(summaries[0].files.find(file=>file.path==='image.png')?.binary,true);assert.equal(summaries[0].files.find(file=>file.path==='tracked.txt')?.additions,1);
  await tracker.begin('two');rmSync(join(f.root,'tracked.txt'));await tracker.settle('two','stopped','b');assert.equal(summaries[1].files[0].status,'D');assert.equal(summaries[1].files[0].deletions,1);
  assert.equal(projectRunChanges(summaries.map(data=>({type:'custom',customType:RUN_CHANGES_TYPE,data}))).length,2);
 }finally{f.close();}
});
test('staged rename baseline reversal reports both restored and removed paths without touching the index',async()=>{
 const f=fixture();try{f.git('mv','tracked.txt','renamed.txt');await captureRunBaseline(f.root,'p','r',f.data,'s');renameSync(join(f.root,'renamed.txt'),join(f.root,'tracked.txt'));const index=f.git('diff','--cached');const diff=await workspaceDiff(f.root,'p',f.data,'run','r');assert.deepEqual(diff.files.map(file=>file.path).sort(),['renamed.txt','tracked.txt']);assert.equal(f.git('diff','--cached'),index);}finally{f.close();}
});
test('reopen invalidates a pending snapshot, and cold resume retains original baseline',async()=>{
 const f=fixture(),summaries:RunChangesSummary[]=[];try{const tracker=new RunChangesTracker(f.root,'p',f.data,'s',value=>summaries.push(value));await tracker.begin('r');for(let i=0;i<15;i++)writeFileSync(join(f.root,'file-'+i),'first\n');const old=tracker.settle('r','completed','old');tracker.reopen('r');for(let i=0;i<14;i++)rmSync(join(f.root,'file-'+i));writeFileSync(join(f.root,'file-14'),'second\n');const next=tracker.settle('r','stopped','new');await Promise.all([old,next]);assert.equal(summaries.length,1);assert.equal(summaries[0].anchorId,'new');assert.equal(summaries[0].files.length,1);
  const cold=new RunChangesTracker(f.root,'p',f.data,'s',value=>summaries.push(value));await cold.ensure('r');writeFileSync(join(f.root,'tracked.txt'),'resumed\n');await cold.settle('r','completed','cold');assert.equal(summaries[1].files.length,2);assert.equal(summaries[1].startedAt,summaries[0].startedAt);
 }finally{f.close();}
});
test('missing git/baseline is unavailable, never a zero-change claim',async()=>{
 const root=mkdtempSync(join(tmpdir(),'friend-no-git-')),data=mkdtempSync(join(tmpdir(),'friend-no-git-data-')),values:RunChangesSummary[]=[];try{const tracker=new RunChangesTracker(root,'p',data,'s',value=>values.push(value));await tracker.begin('r');await tracker.settle('r','failed');assert.match(values[0].unavailable||'',/Git/);assert.deepEqual(values[0].files,[]);}finally{rmSync(root,{recursive:true,force:true});rmSync(data,{recursive:true,force:true});}
});
test('patch counts include source lines starting with ++/-- and full text before truncation',async()=>{
 const f=fixture();try{writeFileSync(join(f.root,'tracked.txt'),'--counter;\nplain\n');f.git('add','.');f.git('commit','-qm','counter');await captureRunBaseline(f.root,'p','r',f.data);writeFileSync(join(f.root,'tracked.txt'),'++counter;\nnew\n');const diff=await workspaceDiff(f.root,'p',f.data,'run','r');assert.equal(diff.files[0].additions,2);assert.equal(diff.files[0].deletions,2);
  const before='old line0123456789\n'.repeat(35000),after='new line0123456789\n'.repeat(35000);writeFileSync(join(f.root,'tracked.txt'),before);await captureRunBaseline(f.root,'p','large',f.data);writeFileSync(join(f.root,'tracked.txt'),after);const large=await workspaceDiff(f.root,'p',f.data,'run','large');assert.equal(large.files[0].truncated,true);assert.equal(large.files[0].additions,35000);assert.equal(large.files[0].deletions,35000);assert.equal(readFileSync(join(f.root,'tracked.txt'),'utf8'),after);
  assert.equal(parsePatch('+++ header\n--- header\n@@ -1 +1 @@\n---old\n+++new').filter(line=>line.kind==='add').length,1);
 }finally{f.close();}
});

test('initial commit during a run in an unborn repository remains visible',async()=>{
 const root=mkdtempSync(join(tmpdir(),'friend-first-commit-')),data=mkdtempSync(join(tmpdir(),'friend-first-commit-data-'));const git=(...args:string[])=>execFileSync('git',args,{cwd:root});
 try{git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@localhost');git('config','commit.gpgsign','false');await captureRunBaseline(root,'p','r',data);writeFileSync(join(root,'new.txt'),'first\n');git('add','.');git('commit','-qm','first commit');const diff=await workspaceDiff(root,'p',data,'run','r');assert.equal(diff.files.length,1);assert.equal(diff.files[0].path,'new.txt');assert.equal(diff.files[0].additions,1);}finally{rmSync(root,{recursive:true,force:true});rmSync(data,{recursive:true,force:true});}
});
