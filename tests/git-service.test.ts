import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync,renameSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gitCommit,gitFileDiff,gitHandlers,gitLog,gitMethods,gitService,gitStage,gitStatus,gitUnstage} from '../apps/desktop/src/git-service.js';
function fixture(initial='initial\n'){
  const root=mkdtempSync(join(tmpdir(),'friend-git-'));
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
  git('init','-q','--initial-branch=main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('config','commit.gpgsign','false');
  writeFileSync(join(root,'file.txt'),initial);git('add','.');git('commit','-qm','initial');
  return {root,git,close:()=>rmSync(root,{recursive:true,force:true})};
}
const find=(files:{path:string}[],path:string)=>files.find(file=>file.path===path) as any;
test('status reports branch, HEAD and staged/unstaged/untracked letters',async()=>{
  const f=fixture();
  try{
    writeFileSync(join(f.root,'file.txt'),'changed\n');writeFileSync(join(f.root,'new.txt'),'new\n');writeFileSync(join(f.root,'staged.txt'),'staged\n');f.git('add','staged.txt');
    const status=await gitStatus(f.root);
    assert.equal(status.branch,'main');assert.equal(status.detached,false);assert.equal(status.head,f.git('rev-parse','HEAD'));assert.equal(status.shortHead?.length,7);assert.equal(status.clean,false);
    assert.equal(find(status.files,'file.txt').letter,'M');assert.equal(find(status.files,'file.txt').staged,false);assert.equal(find(status.files,'file.txt').unstaged,true);
    assert.equal(find(status.files,'staged.txt').letter,'A');assert.equal(find(status.files,'staged.txt').staged,true);assert.equal(find(status.files,'staged.txt').unstaged,false);
    assert.equal(find(status.files,'new.txt').letter,'U');assert.equal(find(status.files,'new.txt').untracked,true);
    assert.deepEqual([status.staged,status.unstaged,status.untracked],[1,1,1]);
    assert.equal(status.projectPath,status.repoPath);
  }finally{f.close();}
});
test('staging and unstaging move only the index and keep working content intact',async()=>{
  const f=fixture();
  try{
    writeFileSync(join(f.root,'file.txt'),'changed\n');
    const staged=await gitStage(f.root,{paths:['file.txt']});
    assert.equal(staged.status.staged,1);assert.equal(staged.status.unstaged,0);assert.equal(find(staged.status.files,'file.txt').letter,'M');assert.equal(readFileSync(join(f.root,'file.txt'),'utf8'),'changed\n');
    const all=await gitStage(f.root,{all:true});assert.equal(all.status.staged,1);
    const unstaged=await gitUnstage(f.root,{paths:['file.txt']});
    assert.equal(unstaged.status.staged,0);assert.equal(unstaged.status.unstaged,1);assert.equal(f.git('diff','--cached','--name-only'),'');assert.equal(readFileSync(join(f.root,'file.txt'),'utf8'),'changed\n');
    await assert.rejects(gitUnstage(f.root,{}),/请选择要取消暂存的文件/);
    await assert.rejects(gitStage(f.root,{}),/请选择要暂存的文件/);
  }finally{f.close();}
});
test('commit records the message, updates history and refuses empty index or empty message',async()=>{
  const f=fixture();
  try{
    await assert.rejects(gitCommit(f.root,{message:'nothing'}),/没有已暂存的文件/);
    await assert.rejects(gitCommit(f.root,{message:'   '}),/请填写提交信息/);
    await assert.rejects(gitCommit(f.root,{message:'x'.repeat(20001)}),/提交信息最多/);
    writeFileSync(join(f.root,'file.txt'),'committed\n');await gitStage(f.root,{paths:['file.txt']});
    const result=await gitCommit(f.root,{message:'更新说明文件'});
    assert.equal(result.commit.subject,'更新说明文件');assert.equal(result.commit.author,'Fixture');assert.equal(result.status.staged,0);assert.equal(result.status.clean,true);
    assert.equal(f.git('log','-1','--format=%s'),'更新说明文件');
    const log=await gitLog(f.root,{limit:5});
    assert.equal(log.commits.length,2);assert.equal(log.commits[0].subject,'更新说明文件');assert.deepEqual(log.commits[0].refs,['main']);assert.equal(log.commits[0].parents.length,1);assert.equal(log.commits[1].subject,'initial');
    assert.equal(log.emptyRepository,false);assert.equal(log.detached,false);
    assert.equal(f.git('status','--porcelain'),'');
  }finally{f.close();}
});
test('file diff separates unstaged and staged patches and marks untracked files',async()=>{
  const f=fixture();
  try{
    writeFileSync(join(f.root,'file.txt'),'worktree\n');
    const unstaged=await gitFileDiff(f.root,{path:'file.txt'});
    assert.equal(unstaged.staged,false);assert.equal(unstaged.untracked,false);assert.match(unstaged.patch,/-initial/);assert.match(unstaged.patch,/\+worktree/);assert.equal(unstaged.additions,1);assert.equal(unstaged.deletions,1);
    await gitStage(f.root,{paths:['file.txt']});writeFileSync(join(f.root,'file.txt'),'both\n');
    const staged=await gitFileDiff(f.root,{path:'file.txt',staged:true});
    assert.match(staged.patch,/\+worktree/);assert.doesNotMatch(staged.patch,/\+both/);
    const worktree=await gitFileDiff(f.root,{path:'file.txt'});
    assert.match(worktree.patch,/-worktree/);assert.match(worktree.patch,/\+both/);
    writeFileSync(join(f.root,'new.txt'),'new\n');
    const untracked=await gitFileDiff(f.root,{path:'new.txt'});
    assert.equal(untracked.untracked,true);assert.equal(untracked.patch,'');assert.match(untracked.note||'',/未跟踪/);
  }finally{f.close();}
});
test('non-repository directories, path escapes and unsupported remotes fail with readable reasons',async()=>{
  const plain=mkdtempSync(join(tmpdir(),'friend-git-plain-'));
  try{
    await assert.rejects(gitStatus(plain),/不是 Git 仓库/);
    await assert.rejects(gitStage(plain,{all:true}),/不是 Git 仓库/);
    const f=fixture();
    try{
      mkdirSync(join(f.root,'sub'));writeFileSync(join(f.root,'sub','inside.txt'),'inside\n');
      for(const path of ['../outside.txt','/etc/passwd','.git/config',''])await assert.rejects(gitStage(f.root,{paths:[path]}),/只能操作项目内|Git 内部文件|文件路径无效|请选择要暂存/);
      await assert.rejects(gitStage(f.root,{paths:Array.from({length:201},(_,i)=>`f${i}.txt`)}),/最多暂存 200 个文件/);
      await assert.rejects(gitLog(f.root,{limit:0}),/提交历史条数/);await assert.rejects(gitLog(f.root,{limit:201}),/提交历史条数/);
      await assert.rejects(gitService(f.root).push(),/暂不支持 push/);await assert.rejects(gitService(f.root).fetch(),/暂不支持 fetch/);
    }finally{f.close();}
  }finally{rmSync(plain,{recursive:true,force:true});}
});
test('subdirectory workspaces only see and stage their own files',async()=>{
  const root=mkdtempSync(join(tmpdir(),'friend-git-sub-'));
  try{
    const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
    git('init','-q','--initial-branch=main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('config','commit.gpgsign','false');
    mkdirSync(join(root,'project'));writeFileSync(join(root,'outside.txt'),'outside\n');writeFileSync(join(root,'project','inside.txt'),'inside\n');git('add','.');git('commit','-qm','base');
    writeFileSync(join(root,'outside.txt'),'outside changed\n');writeFileSync(join(root,'project','inside.txt'),'inside changed\n');
    const status=await gitStatus(join(root,'project'));
    assert.deepEqual(status.files.map(file=>file.path),['inside.txt']);assert.equal(status.repoPath,realpathSync(root));assert.equal(status.projectPath,realpathSync(join(root,'project')));
    await gitStage(join(root,'project'),{all:true});
    assert.equal(git('diff','--cached','--name-only'),'project/inside.txt');
    assert.match((await gitFileDiff(join(root,'project'),{path:'inside.txt'})).note||'',/没有未暂存|没有已暂存/);
    const log=await gitLog(join(root,'project'),{limit:5});assert.equal(log.commits[0].subject,'base');
    await assert.rejects(gitStage(join(root,'project'),{paths:['../outside.txt']}),/只能操作项目内/);
    await gitUnstage(join(root,'project'),{all:true});assert.equal(git('diff','--cached','--name-only'),'');
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('a subdirectory project refuses to commit work staged outside its own tree',async()=>{
  const root=mkdtempSync(join(tmpdir(),'friend-git-scope-'));
  try{
    const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
    git('init','-q','--initial-branch=main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('config','commit.gpgsign','false');
    mkdirSync(join(root,'project'));mkdirSync(join(root,'outside'));writeFileSync(join(root,'project','a.txt'),'a\n');writeFileSync(join(root,'outside','b.txt'),'b\n');git('add','.');git('commit','-qm','base');
    writeFileSync(join(root,'project','a.txt'),'a changed\n');writeFileSync(join(root,'outside','b.txt'),'b changed\n');
    git('add','outside/b.txt');
    await gitStage(join(root,'project'),{all:true});
    assert.equal(git('diff','--cached','--name-only'),'outside/b.txt\nproject/a.txt');
    await assert.rejects(gitCommit(join(root,'project'),{message:'only project'}),/项目外的改动/);
    assert.equal(git('rev-list','--count','HEAD'),'1');
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('an empty repository reports no HEAD, then accepts a first commit and history',async()=>{
  const root=mkdtempSync(join(tmpdir(),'friend-git-empty-'));
  try{
    const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
    git('init','-q','--initial-branch=main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');
    writeFileSync(join(root,'first.txt'),'first\n');
    const before=await gitStatus(root);
    assert.equal(before.head,null);assert.equal(before.branch,'main');assert.equal(before.detached,false);assert.equal(find(before.files,'first.txt').untracked,true);
    const log=await gitLog(root,{limit:5});assert.equal(log.emptyRepository,true);assert.deepEqual(log.commits,[]);
    await gitStage(root,{paths:['first.txt']});
    const result=await gitCommit(root,{message:'初始提交'});
    assert.equal(result.commit.subject,'初始提交');assert.equal(result.status.head,result.commit.sha);
    const empty=await gitUnstage(root,{all:true});
    assert.equal(empty.status.staged,0);
    assert.equal((await gitLog(root,{limit:5})).emptyRepository,false);
    assert.equal(readFileSync(join(root,'first.txt'),'utf8'),'first\n');
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('gitHandlers registers documented methods and resolves the workspace per call',async()=>{
  const f=fixture();
  try{
    const second=fixture();
    try{
      const handlers=gitHandlers(input=>String(input.dir));
      assert.deepEqual(Object.keys(handlers).sort(),[...gitMethods].sort());
      writeFileSync(join(f.root,'file.txt'),'changed\n');
      const status=await handlers['git.status']({dir:f.root}) as {files:{path:string}[];branch:string};
      assert.equal(status.branch,'main');assert.equal(find(status.files,'file.txt').letter,'M');
      const other=await handlers['git.status']({dir:second.root}) as {clean:boolean};
      assert.equal(other.clean,true);
      const staged=await handlers['git.stage']({dir:f.root,paths:['file.txt']}) as {status:{staged:number}};
      assert.equal(staged.status.staged,1);
      const committed=await handlers['git.commit']({dir:f.root,message:'经由 handler 提交'}) as {commit:{subject:string}};
      assert.equal(committed.commit.subject,'经由 handler 提交');
      const diff=await handlers['git.file.diff']({dir:f.root,path:'file.txt'}) as {note?:string};
      assert.match(diff.note||'',/没有未暂存的改动/);
      await assert.rejects(handlers['git.push']({dir:f.root}),/暂不支持 push/);
      await assert.rejects(handlers['git.status']({dir:join(f.root,'missing')}),/不存在或不可访问/);
    }finally{second.close();}
  }finally{f.close();}
});
test('detached HEAD stays readable and never claims a branch',async()=>{
  const f=fixture();
  try{
    const head=f.git('rev-parse','HEAD');f.git('checkout','-q','--detach');f.git('checkout','-q','--detach',head);
    const status=await gitStatus(f.root);assert.equal(status.branch,'');assert.equal(status.detached,true);assert.equal(status.head,head);
    const log=await gitLog(f.root,{limit:1});assert.equal(log.detached,true);assert.equal(log.commits.length,1);
  }finally{f.close();}
});
test('renames and deletions are resolved against the project boundary',async()=>{
  const root=mkdtempSync(join(tmpdir(),'friend-git-rename-'));
  try{
    const git=(...args:string[])=>execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
    git('init','-q','--initial-branch=main');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');git('config','commit.gpgsign','false');
    mkdirSync(join(root,'project'));writeFileSync(join(root,'project','old.txt'),'content\n');git('add','.');git('commit','-qm','base');
    renameSync(join(root,'project','old.txt'),join(root,'project','new.txt'));git('add','-A');
    const status=await gitStatus(join(root,'project'));
    const row=status.files.find(file=>file.path==='new.txt')!;
    assert.equal(row.letter,'R');assert.equal(row.oldPath,'old.txt');assert.equal(status.files.length,1);
    const diff=await gitFileDiff(join(root,'project'),{path:'new.txt',staged:true});
    assert.match(diff.patch,/rename/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
