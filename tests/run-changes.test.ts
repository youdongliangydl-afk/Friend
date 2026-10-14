import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,renameSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RunChangesTracker,projectRunChanges,RUN_CHANGES_TYPE,type RunChangesSummary} from '../apps/desktop/src/run-changes.js';
import {parsePatch,captureRunBaseline,workspaceDiff} from '../apps/desktop/src/workspace-files.js';
function fixture(){const root=mkdtempSync(join(tmpdir(),'friend-changes-')),data=mkdtempSync(join(tmpdir(),'friend-changes-data-'));const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'});git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@localhost');git('config','commit.gpgsign','false');writeFileSync(join(root,'tracked.txt'),'old\n');git('add','.');git('commit','-qm','baseline');return {root,data,git,close:()=>{rmSync(root,{recursive:true,force:true});rmSync(data,{recursive:true,force:true});}};}

test('adding or removing the final newline remains visible in frozen comparisons',async()=>{
 const {readRunChange}=await import('../apps/desktop/src/run-changes.js');
 for(const [before,after] of [['same','same\n'],['same\n','same']]){
  const f=fixture(),values:RunChangesSummary[]=[];
  try{writeFileSync(join(f.root,'tracked.txt'),before);f.git('add','.');f.git('commit','-qm','EOF baseline');
   const tracker=new RunChangesTracker(f.root,'p',f.data,'s',value=>values.push(value));await tracker.begin('eof');writeFileSync(join(f.root,'tracked.txt'),after);await tracker.settle('eof','completed');
   assert.deepEqual([values[0].files[0].additions,values[0].files[0].deletions],[1,1]);
   assert.match(readRunChange(f.data,'s','p','eof',values[0].changeId!,0).file!.patch,/No newline at end of file/);
  }finally{f.close();}
 }
});

test('a formerly ignored capture preserves its original comparison after cold resume and unignore',async()=>{
 const {readRunChange}=await import('../apps/desktop/src/run-changes.js');const f=fixture(),values:RunChangesSummary[]=[];
 try{writeFileSync(join(f.root,'.gitignore'),'existing.txt\n');writeFileSync(join(f.root,'existing.txt'),'alpha\nbeta\ngamma\n');f.git('add','.gitignore');f.git('commit','-qm','Ignore existing file');
  const tracker=new RunChangesTracker(f.root,'p',f.data,'s',value=>values.push(value));await tracker.begin('ignored');await tracker.captureTool('edit',{path:'existing.txt'});writeFileSync(join(f.root,'existing.txt'),'alpha\nbeta changed\ngamma\n');writeFileSync(join(f.root,'.gitignore'),'');
  const cold=new RunChangesTracker(f.root,'p',f.data,'s',value=>values.push(value));await cold.ensure('ignored');await cold.settle('ignored','completed');
  const index=values[0].files.findIndex(file=>file.path==='existing.txt'),file=values[0].files[index];assert.deepEqual([file.status,file.additions,file.deletions],['M',1,1]);
  assert.match(readRunChange(f.data,'s','p','ignored',values[0].changeId!,index).file!.patch,/-beta\n\+beta changed/);
 }finally{f.close();}
});

test('a shell-created file followed by file-tool editing remains a whole-run addition',async()=>{
 const f=fixture(),values:RunChangesSummary[]=[];
 try{const tracker=new RunChangesTracker(f.root,'p',f.data,'s',value=>values.push(value));await tracker.begin('new');writeFileSync(join(f.root,'new.txt'),'shell created\nsecond\n');await tracker.captureTool('edit',{path:'new.txt'});writeFileSync(join(f.root,'new.txt'),'edited\nsecond\n');await tracker.settle('new','completed');
  const file=values[0].files.find(file=>file.path==='new.txt')!;assert.deepEqual([file.status,file.additions,file.deletions],['A',2,0]);
 }finally{f.close();}
});
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
test('patch counts include source lines starting with ++/-- and preserve large changed tails within the total budget',async()=>{
 const f=fixture();try{writeFileSync(join(f.root,'tracked.txt'),'--counter;\nplain\n');f.git('add','.');f.git('commit','-qm','counter');await captureRunBaseline(f.root,'p','r',f.data);writeFileSync(join(f.root,'tracked.txt'),'++counter;\nnew\n');const diff=await workspaceDiff(f.root,'p',f.data,'run','r');assert.equal(diff.files[0].additions,2);assert.equal(diff.files[0].deletions,2);
  const before='old line0123456789\n'.repeat(35000),after='new line0123456789\n'.repeat(35000);writeFileSync(join(f.root,'tracked.txt'),before);await captureRunBaseline(f.root,'p','large',f.data);writeFileSync(join(f.root,'tracked.txt'),after);const large=await workspaceDiff(f.root,'p',f.data,'run','large');assert.ok(!large.files[0].truncated);assert.equal(large.files[0].lines.filter(line=>line.kind==='add').length,35000);assert.equal(large.files[0].lines.filter(line=>line.kind==='remove').length,35000);assert.equal(large.files[0].additions,35000);assert.equal(large.files[0].deletions,35000);assert.equal(readFileSync(join(f.root,'tracked.txt'),'utf8'),after);
  assert.equal(parsePatch('+++ header\n--- header\n@@ -1 +1 @@\n---old\n+++new').filter(line=>line.kind==='add').length,1);
 }finally{f.close();}
});

test('initial commit during a run in an unborn repository remains visible',async()=>{
 const root=mkdtempSync(join(tmpdir(),'friend-first-commit-')),data=mkdtempSync(join(tmpdir(),'friend-first-commit-data-'));const git=(...args:string[])=>execFileSync('git',args,{cwd:root});
 try{git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@localhost');git('config','commit.gpgsign','false');await captureRunBaseline(root,'p','r',data);writeFileSync(join(root,'new.txt'),'first\n');git('add','.');git('commit','-qm','first commit');const diff=await workspaceDiff(root,'p',data,'run','r');assert.equal(diff.files.length,1);assert.equal(diff.files[0].path,'new.txt');assert.equal(diff.files[0].additions,1);}finally{rmSync(root,{recursive:true,force:true});rmSync(data,{recursive:true,force:true});}
});

test('frozen comparison belongs to its native session/project/run and survives later file edits and deletion',async()=>{
 const {readRunChange}=await import('../apps/desktop/src/run-changes.js');const f=fixture(),values:RunChangesSummary[]=[];
 try{const tracker=new RunChangesTracker(f.root,'p',f.data,'native',value=>values.push(value));await tracker.begin('run');writeFileSync(join(f.root,'tracked.txt'),'new recorded\n');await tracker.settle('run','completed');const id=values[0].changeId!;
  writeFileSync(join(f.root,'tracked.txt'),'later edit must not leak\n');rmSync(join(f.root,'tracked.txt'));
  const diff=readRunChange(f.data,'native','p','run',id,0);assert.ok(diff.file);assert.match(diff.file.patch,/new recorded/);assert.doesNotMatch(diff.file.patch,/later edit/);assert.equal(diff.file.lines.filter(line=>line.kind==='add').length,1);assert.equal(diff.file.lines.filter(line=>line.kind==='remove').length,1);
  for(const [session,project,run] of [['other','p','run'],['native','other','run'],['native','p','other']])assert.ok(readRunChange(f.data,session,project,run,id,0).unavailable);
  assert.ok(readRunChange(f.data,'native','p','run',id,99).unavailable);assert.throws(()=>readRunChange(f.data,'native','p','run',id,-1),/索引/);
 }finally{f.close();}
});

test('a legacy non-Git baseline notice does not disable file-tool capture after cold resume',async()=>{
 const root=mkdtempSync(join(tmpdir(),'friend-non-git-cold-')),data=mkdtempSync(join(tmpdir(),'friend-non-git-cold-data-')),values:RunChangesSummary[]=[];
 try{const tracker=new RunChangesTracker(root,'p',data,'s',value=>values.push(value));await tracker.begin('r');await tracker.settle('r','completed');assert.match(values[0].unavailable||'',/Git/);
  const {RecordStore}=await import('@friend-pi/core');const store=new RecordStore('diff',data);try{const key='captures:s:r',record=store.get<Record<string,unknown>>(key)!;store.put(key,{...record.value,failure:values[0].unavailable});}finally{store.close();}
  const cold=new RunChangesTracker(root,'p',data,'s',value=>values.push(value),()=>[values[0]]);await cold.ensure('r');writeFileSync(join(root,'file.txt'),'before\n');await cold.captureTool('edit',{path:'file.txt'});writeFileSync(join(root,'file.txt'),'after\n');await cold.settle('r','completed');assert.equal(values[1].unavailable,undefined);assert.deepEqual(values[1].files.map(file=>[file.path,file.additions,file.deletions]),[['file.txt',1,1]]);
 }finally{rmSync(root,{recursive:true,force:true});rmSync(data,{recursive:true,force:true});}
});

test('DSH-style file-tool captures cover non-Git and ignored files without replacing a failed Git baseline',async()=>{
 const {readRunChange}=await import('../apps/desktop/src/run-changes.js');const root=mkdtempSync(join(tmpdir(),'friend-tool-captures-')),data=mkdtempSync(join(tmpdir(),'friend-tool-captures-data-')),values:RunChangesSummary[]=[];
 try{const tracker=new RunChangesTracker(root,'p',data,'s',value=>values.push(value));writeFileSync(join(root,'file.txt'),'before\n');await tracker.begin('r');await tracker.captureTool('edit',{path:'file.txt'});writeFileSync(join(root,'file.txt'),'after\n');await tracker.captureTool('write',{path:'new.txt'});writeFileSync(join(root,'new.txt'),'new\n');await tracker.settle('r','completed');assert.equal(values[0].unavailable,undefined);assert.equal(values[0].files.length,2);assert.match(values[0].note||'',/仅统计文件工具/);
  const diff=readRunChange(data,'s','p','r',values[0].changeId!,0);assert.match(diff.file?.patch||'',/-before/);assert.match(diff.file?.patch||'',/\+after/);
 }finally{rmSync(root,{recursive:true,force:true});rmSync(data,{recursive:true,force:true});}
 const f=fixture(),ignored:RunChangesSummary[]=[];try{writeFileSync(join(f.root,'.gitignore'),'ignored.txt\n');writeFileSync(join(f.root,'ignored.txt'),'old\n');const tracker=new RunChangesTracker(f.root,'p',f.data,'s',value=>ignored.push(value));await tracker.begin('r');await tracker.captureTool('edit',{path:'ignored.txt'});writeFileSync(join(f.root,'ignored.txt'),'new\n');await tracker.settle('r','completed');assert.deepEqual(ignored[0].files.map(file=>file.path),['ignored.txt']);assert.equal(ignored[0].files[0].additions,1);}finally{f.close();}
});

test('incomplete tool captures remain unavailable after cold resume',async()=>{
 const root=mkdtempSync(join(tmpdir(),'friend-capture-limit-')),data=mkdtempSync(join(tmpdir(),'friend-capture-limit-data-')),values:RunChangesSummary[]=[];
 try{const tracker=new RunChangesTracker(root,'p',data,'s',value=>values.push(value));await tracker.begin('r');
  for(let i=0;i<9;i++){const path=`large-${i}.txt`;writeFileSync(join(root,path),'x'.repeat(1024*1024));if(i===8)await assert.rejects(tracker.captureTool('write',{path}),/8 MiB/);else await tracker.captureTool('write',{path});writeFileSync(join(root,path),'changed\n');}
  await tracker.settle('r','interrupted');assert.match(values[0].unavailable||'',/未完整/);
  const cold=new RunChangesTracker(root,'p',data,'s',value=>values.push(value));await cold.ensure('r');await cold.settle('r','completed');assert.match(values[1].unavailable||'',/未完整/);assert.deepEqual(values[1].files,[]);
 }finally{rmSync(root,{recursive:true,force:true});rmSync(data,{recursive:true,force:true});}
});

test('Git-covered captures reverted to the run baseline do not reappear as tool changes',async()=>{
 const f=fixture(),values:RunChangesSummary[]=[];
 try{const tracker=new RunChangesTracker(f.root,'p',f.data,'s',value=>values.push(value));await tracker.begin('r');writeFileSync(join(f.root,'tracked.txt'),'shell intermediate\n');await tracker.captureTool('write',{path:'tracked.txt'});writeFileSync(join(f.root,'tracked.txt'),'old\n');await tracker.settle('r','completed');assert.equal(values[0].unavailable,undefined);assert.deepEqual(values[0].files,[]);}finally{f.close();}
});

test('file-tool comparison needs no Git executable and native failure history fences incomplete recovery',async()=>{
 const root=mkdtempSync(join(tmpdir(),'friend-without-git-')),data=mkdtempSync(join(tmpdir(),'friend-without-git-data-')),values:RunChangesSummary[]=[];const priorPath=process.env.PATH;
 try{process.env.PATH='';const tracker=new RunChangesTracker(root,'p',data,'s',value=>values.push(value));writeFileSync(join(root,'file.txt'),'before\n');await tracker.begin('r');await tracker.captureTool('write',{path:'file.txt'});writeFileSync(join(root,'file.txt'),'after\n');await tracker.settle('r','completed');assert.equal(values[0].unavailable,undefined);assert.deepEqual([values[0].files[0].additions,values[0].files[0].deletions],[1,1]);
  const previous={...values[0],unavailable:'文件工具快照未完整记录，本轮变更不可用'};const cold=new RunChangesTracker(root,'p',data,'s',value=>values.push(value),()=>[previous]);await cold.ensure('r');await cold.settle('r','completed');assert.match(values[1].unavailable||'',/未完整/);assert.deepEqual(values[1].files,[]);
 }finally{process.env.PATH=priorPath;rmSync(root,{recursive:true,force:true});rmSync(data,{recursive:true,force:true});}
});
