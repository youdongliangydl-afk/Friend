import {pathToFileURL} from 'node:url';
import {mkdtempSync,mkdirSync,symlinkSync,rmSync,writeFileSync,realpathSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePermissionMode,permissionDecision,readOnlyCommand,toolPermissionRequest,temporaryPermission,temporaryPermissionMatches,assertTemporaryArtifactPath} from '../src/permissions.js';
test('permissions ask for mutations, auto permits eligible operations, all permits requested operations',()=>{
  const safe=toolPermissionRequest('write',{path:'result.txt'})!,command=toolPermissionRequest('bash',{command:'node server.mjs'})!;
  assert.equal(permissionDecision('ask',safe),'ask');assert.equal(permissionDecision('auto',safe),'allow');assert.equal(permissionDecision('auto',command),'ask');assert.equal(permissionDecision('allPermissions',command),'allow');
  assert.equal(toolPermissionRequest('read',{path:'a'}),undefined);assert.equal(toolPermissionRequest('swarm_shared',{action:'read'}),undefined);assert.equal(permissionDecision('ask',toolPermissionRequest('swarm_shared',{action:'write',name:'notes'})!),'ask');assert.throws(()=>parsePermissionMode('admin'));
});
test('shell approval classification rejects expansion, redirects and concealed executable options',()=>{
  for(const command of ['pwd','ls -la','git status --short','rg TODO src','node --version'])assert.equal(readOnlyCommand(command),true,command);
  for(const command of ['echo $(touch marker)','echo hi > marker','rg --pre=hook file',"rg --p''re=hook file",'rg --p\\re=hook file',"git diff --e''xt-diff",'rg $OPTIONS file','cat <(touch marker)','node -e "process.exit(0)"'])assert.equal(readOnlyCommand(command),false,command);
});

test('Swarm strategy validation is read-only in temporary sessions and cannot approve execution',()=>{
 assert.equal(toolPermissionRequest('friend_swarm',{action:'plan.validate',strategy:'direct',tasks:[]},true),undefined);
 assert.equal(toolPermissionRequest('friend_swarm',{action:'plan.validate',strategy:'collaboration',tasks:[{mode:'write'}],checks:[{command:'npm',args:['test']}]},true),undefined);
 const root=mkdtempSync(join(tmpdir(),'friend-swarm-plan-permission-'));try{
  for(const action of ['create','start','append','prepare','resume']){const request=toolPermissionRequest('friend_swarm',{action},true);assert.ok(request);assert.equal(temporaryPermission(request,root).requireExplicit,true,action);}
  assert.ok(toolPermissionRequest('friend_memory',{action:'plan.validate'},true));
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('temporary scope canonicalizes Pi path spelling, missing parents, siblings and symlinks',()=>{
 const base=mkdtempSync(join(tmpdir(),'friend-scope-')),root=join(realpathSync(base),'session'),outside=join(base,'session-sibling');mkdirSync(root);mkdirSync(outside);symlinkSync(outside,join(root,'link'));symlinkSync(join(outside,'new.txt'),join(root,'dangling'));writeFileSync(join(outside,'existing.txt'),'before');try{
 for(const path of ['../session-sibling/existing.txt','@../session-sibling/new.txt','@'+join(outside,'absolute.txt'),join(outside,'missing/child.txt'),'link/missing/child.txt','dangling',pathToFileURL(join(outside,'encoded space.txt')).href,'@'+pathToFileURL(join(outside,'url.txt')).href,'file://localhost'+join(outside,'localhost.txt'),'~/outside-scope.txt',join(root,'link/existing.txt')]){const request=temporaryPermission(toolPermissionRequest('write',{path})!,root);assert.equal(request.requireExplicit,true,path);for(const mode of ['ask','auto','allPermissions'] as const)assert.equal(permissionDecision(mode,request),'ask');}
 for(const path of ['result.txt','@result.txt','new/中文.md',join(root,'inside.txt')]){const request=temporaryPermission(toolPermissionRequest('edit',{path})!,root);assert.equal(permissionDecision('auto',request),'allow',path);}
 assert.equal(permissionDecision('allPermissions',temporaryPermission(toolPermissionRequest('custom_extension',{},true)!,root)),'ask');
 assert.equal(permissionDecision('allPermissions',temporaryPermission(toolPermissionRequest('bash',{command:'node script.js'})!,root)),'ask');
 const bound=temporaryPermission(toolPermissionRequest('write',{path:'inside.txt'})!,root);assertTemporaryArtifactPath(join(root,'exports/output.md'),root);const unicodeRoot=join(realpathSync(base),'临时　产物');mkdirSync(unicodeRoot);assertTemporaryArtifactPath(join(unicodeRoot,'output.md'),unicodeRoot);assert.throws(()=>assertTemporaryArtifactPath(join(root,'link/escaped.md'),root),/超出/);
 renameSync(root,root+'-old');symlinkSync(outside,root);assert.equal(temporaryPermissionMatches(bound,root),false);assert.equal(permissionDecision('allPermissions',temporaryPermission(toolPermissionRequest('write',{path:'redirected.txt'})!,root)),'ask');
 assert.equal(permissionDecision('allPermissions',{operation:'x',message:'x',autoEligible:true,requireExplicit:true}),'ask');
 }finally{rmSync(base,{recursive:true,force:true});}
});
