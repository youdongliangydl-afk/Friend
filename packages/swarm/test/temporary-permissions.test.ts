import {SharedMaterials} from '../src/shared.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync,mkdirSync,realpathSync,symlinkSync,readdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RecordStore,type PluginContext,type PermissionRequest} from '@friend-pi/core';
import {managedCommand} from '../src/managed.js';
test('temporary collaboration checks require approval before spawning and honor cancellation',async()=>{
 const root=mkdtempSync(join(tmpdir(),'friend-temporary-check-'));const marker=join(root,'marker');let prompt:PermissionRequest|undefined,started=0;const ctx={projectDir:root,policy:{temporaryWriteRoot:root,permissionMode:'allPermissions'},approvePermission:async(r:PermissionRequest)=>{prompt=r;return false;},emit:()=>{}} as unknown as PluginContext;
 try{await assert.rejects(managedCommand(process.execPath,['-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'x')`],root,undefined,ctx,'test','check',()=>{started++;}),/未批准/);assert.equal(prompt?.requireExplicit,true);assert.equal(started,0);assert.equal(existsSync(marker),false);const stop=new AbortController();ctx.approvePermission=async()=>{stop.abort();return true;};await assert.rejects(managedCommand(process.execPath,['-e','process.exit(0)'],root,stop.signal,ctx,'test','check',()=>{started++;}),/取消/);assert.equal(started,0);}finally{rmSync(root,{recursive:true,force:true});}
});

test('temporary shared outputs remain in the session and reject outside directory links',async()=>{
 const base=mkdtempSync(join(tmpdir(),'friend-temporary-shared-')),root=join(realpathSync(base),'session'),outside=join(base,'outside');mkdirSync(root);mkdirSync(outside);const store=new RecordStore('test',join(base,'data'));const ctx={projectDir:root,dataDir:join(base,'data'),policy:{temporaryWriteRoot:root},emit:()=>{}} as unknown as PluginContext;const shared=new SharedMaterials(store,()=>{});
 try{symlinkSync(outside,join(root,'swarm-shared'));await assert.rejects(shared.write('graph',{name:'note',content:'body'},ctx),/产物路径/);assert.deepEqual(readdirSync(outside),[]);assert.equal(store.list('shared:').length,0);}finally{store.close();rmSync(base,{recursive:true,force:true});}
});

test('collaboration approval cannot admit a command after its working directory is redirected',async()=>{
 const base=mkdtempSync(join(tmpdir(),'friend-temporary-cwd-')),root=realpathSync(base),cwd=join(root,'check'),outside=join(root,'outside');mkdirSync(cwd);mkdirSync(outside);let started=0;const ctx={projectDir:root,policy:{temporaryWriteRoot:root,permissionMode:'allPermissions'},approvePermission:async()=>{renameSync(cwd,cwd+'-old');symlinkSync(outside,cwd);return true;},emit:()=>{}} as unknown as PluginContext;
 try{await assert.rejects(managedCommand(process.execPath,['-e','process.exit(0)'],cwd,undefined,ctx,'test','check',()=>{started++;}),/目录已变化/);assert.equal(started,0);}finally{rmSync(base,{recursive:true,force:true});}
});

test('managed collaboration checks omit inherited credentials from the actual child',async()=>{
 const synthetic={FRIEND_CHECK_API_KEY:'synthetic-key',FRIEND_CHECK_TOKEN:'synthetic-token',FRIEND_CHECK_SECRET:'synthetic-secret',FRIEND_CHECK_PASSWORD:'synthetic-password',FRIEND_CHECK_CREDENTIAL:'synthetic-credential',FRIEND_CHECK_VISIBLE:'preserved'};
 const previous=new Map(Object.keys(synthetic).map(name=>[name,process.env[name]]));Object.assign(process.env,synthetic);
 const root=mkdtempSync(join(tmpdir(),'friend-check-environment-')),ctx={projectDir:root,emit:()=>{}} as unknown as PluginContext;
 try{
  const names=Object.keys(synthetic).filter(name=>name!=='FRIEND_CHECK_VISIBLE');
  const probe=`process.stdout.write(JSON.stringify({leaks:${JSON.stringify(names)}.filter(name=>Object.hasOwn(process.env,name)).length,ordinary:process.env.FRIEND_CHECK_VISIBLE==='preserved',path:Boolean(process.env.PATH)}))`;
  const result=await managedCommand(process.execPath,['-e',probe],root,undefined,ctx,'environment-check','check',()=>{});
  assert.equal(result.exitCode,0);assert.deepEqual(JSON.parse(result.stdout),{leaks:0,ordinary:true,path:true});assert.equal(result.stderr,'');assert.equal(process.env.FRIEND_CHECK_API_KEY,synthetic.FRIEND_CHECK_API_KEY,'parent inference environment must remain untouched');
 }finally{for(const [name,value] of previous)if(value===undefined)delete process.env[name];else process.env[name]=value;rmSync(root,{recursive:true,force:true});}
});
