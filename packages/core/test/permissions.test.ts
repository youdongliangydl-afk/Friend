import test from 'node:test';
import assert from 'node:assert/strict';
import {parsePermissionMode,permissionDecision,readOnlyCommand,toolPermissionRequest} from '../src/permissions.js';
test('permissions ask for mutations, auto permits eligible operations, all permits requested operations',()=>{
  const safe=toolPermissionRequest('write',{path:'result.txt'})!,command=toolPermissionRequest('bash',{command:'node server.mjs'})!;
  assert.equal(permissionDecision('ask',safe),'ask');assert.equal(permissionDecision('auto',safe),'allow');assert.equal(permissionDecision('auto',command),'ask');assert.equal(permissionDecision('allPermissions',command),'allow');
  assert.equal(toolPermissionRequest('read',{path:'a'}),undefined);assert.equal(toolPermissionRequest('swarm_shared',{action:'read'}),undefined);assert.equal(permissionDecision('ask',toolPermissionRequest('swarm_shared',{action:'write',name:'notes'})!),'ask');assert.throws(()=>parsePermissionMode('admin'));
});
test('shell approval classification rejects expansion, redirects and concealed executable options',()=>{
  for(const command of ['pwd','ls -la','git status --short','rg TODO src','node --version'])assert.equal(readOnlyCommand(command),true,command);
  for(const command of ['echo $(touch marker)','echo hi > marker','rg --pre=hook file',"rg --p''re=hook file",'rg --p\\re=hook file',"git diff --e''xt-diff",'rg $OPTIONS file','cat <(touch marker)','node -e "process.exit(0)"'])assert.equal(readOnlyCommand(command),false,command);
});
