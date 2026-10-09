import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PluginContext, HostPolicy } from '@friend-pi/core';
import { ExpertController, blockedByFrozenScope, blockedByFrozenRole, assertRoleDelivery, assertRoleModel, freezeRole, type RoleDefinition, type FrozenRole, type FrozenRun, type RoleCapability } from '../src/index.js';
import { roleDefinition } from '../src/roles.js';

function fixture(){
  const dir=mkdtempSync(join(tmpdir(),'friend-roles-')),controller=new ExpertController(dir),entries:{type:string;value:unknown}[]=[];
  const policy:HostPolicy={v:1,revision:1,runId:'run-one',stage:'task-1:checked',canSwitchRole:true,unsettledTools:0,tools:['read','grep','find','ls','write','edit','bash','friend_expert','friend_swarm','friend_plan','friend_goal','friend_task','friend_workflow','friend_jobs','friend_todo'],writeScopes:['.'],executionMode:'single',planMode:false};
  const ctx:PluginContext&{policy:RoleCapability;availableModels:{id:string;thinkingLevels:string[]}[]}={origin:'user',dataDir:dir,projectDir:dir,projectId:'p',sessionId:'s',runId:'run-one',modelId:'fixture/main',thinkingLevel:'off',policy,availableModels:[{id:'fixture/main',thinkingLevels:['off','medium']},{id:'fixture/review',thinkingLevels:['off','high']}],isIdle:()=>true,history:()=>[],readSource:()=>{throw Error('unused');},complete:async()=>'',request:async()=>undefined,emit:()=>{},notify:()=>{},appendEntry:(type,value)=>entries.push({type,value})};
  const input=(id:string)=>({id,runId:'run-one',stage:policy.stage,policyRevision:policy.revision});
  return {dir,controller,ctx,entries,input,dispose:()=>{controller.dispose();rmSync(dir,{recursive:true,force:true});}};
}
test('roles and methods are separate catalogs; a reviewer role enforces readonly even with an empty-tools method',async()=>{
  const f=fixture();try{
    assert.equal(f.controller.roleDefinitions(f.ctx).length,5);assert.equal(f.controller.definitions(f.ctx).length,5);
    const methodOnly=f.controller.freeze({expertId:'reviewer'},f.ctx);assert.equal(methodOnly.role,undefined);assert.equal(blockedByFrozenScope(methodOnly,'write'),false,'a method does not silently become a role');
    const run=f.controller.freeze({roleId:'reviewer',methodIds:['implementer']},f.ctx);assert.deepEqual(run.experts[0].tools,[]);assert.equal(blockedByFrozenScope(run,'read'),false);assert.equal(blockedByFrozenScope(run,'bash'),true);assert.equal(blockedByFrozenScope(run,'write',{path:'x'},f.dir),true);assert.equal(blockedByFrozenScope(run,'friend_swarm'),true);
    assert.equal(blockedByFrozenScope(run,'friend_expert',{action:'validation.run'}),true);assert.equal(blockedByFrozenScope(run,'friend_expert',{action:'use',input:{id:'implementer'}}),false);assert.equal(run.role!.independent,false);
    const noTools=freezeRole({...run.role!,tools:[],writeScopes:[]},f.ctx.policy);assert.equal(blockedByFrozenRole(noTools,'read'),true,'empty role allowlist grants no tools');
  }finally{f.dispose();}
});
test('planner can submit plan metadata while readonly roles cannot approve, execute or start work',()=>{
  const f=fixture();try{
    const planner=freezeRole(f.controller.roleDefinitions(f.ctx).find(role=>role.id==='planner')!,f.ctx.policy),reviewer=freezeRole(f.controller.roleDefinitions(f.ctx).find(role=>role.id==='reviewer')!,f.ctx.policy);
    assert.equal(blockedByFrozenRole(planner,'friend_plan',{action:'submit',body:'proposal'}),false);
    assert.equal(blockedByFrozenRole(planner,'friend_plan',{action:'read'}),false);
    assert.equal(blockedByFrozenRole(planner,'friend_plan',{action:'approve'}),true);
    assert.equal(blockedByFrozenRole(reviewer,'friend_plan',{action:'submit'}),true);
    for(const tool of ['friend_goal','friend_task','friend_workflow','friend_jobs']){
      assert.equal(blockedByFrozenRole(reviewer,tool,{action:'snapshot'}),false);
      for(const action of ['start','integrate','complete','create','verify'])assert.equal(blockedByFrozenRole(reviewer,tool,{action}),true);
    }
  }finally{f.dispose();}
});
test('builtin roles can maintain checklist metadata without granting task, file or verification writes',()=>{
  const f=fixture();try{
    for(const definition of f.controller.roleDefinitions(f.ctx)){
      const role=freezeRole(definition,f.ctx.policy);
      for(const action of ['read','update'])assert.equal(blockedByFrozenRole(role,'friend_todo',{action,items:[]}),false,`${role.id} can ${action} checklist metadata`);
      for(const args of [undefined,[],{}, {action:'clear'}, {action:'verify'}, {action:'start'}])assert.equal(blockedByFrozenRole(role,'friend_todo',args),true);
      if(!role.effectiveWriteScopes.length){
        assert.equal(blockedByFrozenRole(role,'friend_task',{action:'complete'}),true);
        assert.equal(blockedByFrozenRole(role,'friend_expert',{action:'validation.run'}),true);
        for(const tool of ['write','edit','bash'])assert.equal(blockedByFrozenRole(role,tool,{path:'new.ts'},f.dir),true);
      }
    }
  }finally{f.dispose();}
});
test('checklist metadata respects custom roles, host caps and adopted method allowlists',async()=>{
  const f=fixture();try{
    const reviewer=f.controller.roleDefinitions(f.ctx).find(role=>role.id==='reviewer')!;
    const custom=await f.controller.dispatch('role.create',{...reviewer,title:'Explicit read-only',tools:['read']},f.ctx) as RoleDefinition;
    const withoutHostTool=freezeRole(reviewer,{tools:['read'],writeScopes:[]});
    const withHostTool=freezeRole(reviewer,f.ctx.policy);
    for(const action of ['read','update']){
      assert.equal(blockedByFrozenRole(freezeRole(custom,f.ctx.policy),'friend_todo',{action,items:[]}),true);
      assert.equal(blockedByFrozenRole(withoutHostTool,'friend_todo',{action,items:[]}),true);
      assert.equal(blockedByFrozenScope({role:withHostTool,toolScope:['read']} as FrozenRun,'friend_todo',{action,items:[]}),true);
    }
  }finally{f.dispose();}
});
test('existing builtin role catalogs gain checklist metadata only for future runs',async()=>{
  const f=fixture();let reopened:ExpertController|undefined;try{
    const builtin=f.controller.store.get<RoleDefinition>('role:builtin:reviewer')!;
    const prior=roleDefinition({...builtin.value,tools:builtin.value.tools.filter(tool=>tool!=='friend_todo')},{id:'reviewer',version:builtin.value.version,scope:'builtin'});
    f.controller.store.put(builtin.key,prior,builtin.revision);
    await f.controller.dispatch('role.assign',{id:'reviewer'},f.ctx);
    const run=f.controller.beginRun(f.ctx);
    await f.controller.dispatch('role.create',{...prior,title:'Custom allowlist',tools:['read']},f.ctx);
    const savedPrior=f.controller.roleDefinitions(f.ctx).find(role=>role.id==='reviewer')!;
    await f.controller.dispatch('role.update',{...savedPrior,tools:['read']},f.ctx);
    f.controller.dispose();reopened=new ExpertController(f.dir);
    const upgraded=reopened.store.get<RoleDefinition>(builtin.key)!.value;
    assert.equal(upgraded.version,prior.version+1);assert.notEqual(upgraded.hash,prior.hash);assert.equal(upgraded.tools.includes('friend_todo'),true);
    assert.equal(reopened.roleDefinitions(f.ctx).find(role=>role.title==='Custom allowlist')!.tools.includes('friend_todo'),false);
    assert.deepEqual(reopened.roleDefinitions(f.ctx).find(role=>role.id==='reviewer')!.tools,['read'],'project overrides retain their explicit allowlist');
    assert.equal((reopened.snapshot(f.ctx).adoptions as FrozenRun).roles!.find(role=>role.id==='reviewer')!.tools.includes('friend_todo'),false);
    assert.equal((reopened.snapshot(f.ctx).adoptions as FrozenRun).role!.effectiveTools.includes('friend_todo'),false);
    assert.deepEqual((reopened.snapshot(f.ctx).adoptions as FrozenRun).roles,run.roles);
    reopened.dispose();reopened=new ExpertController(f.dir);
    assert.equal(reopened.store.get<RoleDefinition>(builtin.key)!.value.version,upgraded.version,'catalog migration is idempotent');
  }finally{reopened?.dispose();rmSync(f.dir,{recursive:true,force:true});}
});
test('role management is user-only, project-scoped, CAS versioned, and cannot loosen builtin reviewer',async()=>{
  const f=fixture();try{
    const prior=f.controller.roleDefinitions(f.ctx).find(role=>role.id==='reviewer')!;
    for(const action of ['role.create','role.update'])await assert.rejects(f.controller.dispatch(action,{},{...f.ctx,origin:'agent'}),/用户/);
    await assert.rejects(f.controller.dispatch('role.update',{...prior,tools:['read','write'],writeScopes:['.']},f.ctx),/硬只读/);
    const updated=await f.controller.dispatch('role.update',{...prior,title:'项目审查',responsibility:'只读审查接口和事实'},f.ctx) as RoleDefinition&{revision:number};
    assert.equal(updated.version,2);assert.notEqual(f.controller.roleDefinitions({...f.ctx,projectId:'other'}).find(role=>role.id==='reviewer')!.title,'项目审查');
    await assert.rejects(f.controller.dispatch('role.update',{...prior,title:'stale'},f.ctx),/版本/);
    assert.equal((await f.controller.dispatch('role.versions',{id:'reviewer'},f.ctx) as RoleDefinition[])[0].version,1);
    assert.equal(f.controller.definitions(f.ctx).find(method=>method.id==='reviewer')!.version,1);
  }finally{f.dispose();}
});
test('frozen roles survive contract edits and freeze.role intersects both the parent and member task caps',async()=>{
  const f=fixture();try{
    const catalog=await f.controller.dispatch('freeze',{catalog:true},f.ctx) as FrozenRun;
    const before=f.controller.roleDefinitions(f.ctx).find(role=>role.id==='implementer')!;
    await f.controller.dispatch('role.update',{...before,tools:['read'],writeScopes:[]},f.ctx);
    const role=await f.controller.dispatch('freeze.role',{catalogHash:catalog.hash,roleId:'implementer',capability:{tools:['read','write','bash'],writeScopes:['src']}},f.ctx) as FrozenRole;
    assert.equal(role.version,1);assert.deepEqual(role.effectiveTools,['read','write']);assert.deepEqual(role.effectiveWriteScopes,['src']);
    const parent={...f.ctx,policy:{...f.ctx.policy,tools:['read'],writeScopes:[]}};
    const narrowed=await f.controller.dispatch('freeze.role',{catalogHash:catalog.hash,roleId:'implementer',capability:{tools:['read','write'],writeScopes:['.']}},parent) as FrozenRole;
    assert.deepEqual(narrowed.effectiveTools,['read']);assert.deepEqual(narrowed.effectiveWriteScopes,[]);
    await assert.rejects(f.controller.dispatch('freeze.role',{catalogHash:catalog.hash,roleId:'implementer'},{...f.ctx,projectId:'other'}),/当前项目/);
  }finally{f.dispose();}
});
test('write guard rejects traversal, symlink ancestors, and shell outside a whole-project cap',()=>{
  const f=fixture(),outside=mkdtempSync(join(tmpdir(),'friend-role-outside-'));try{
    mkdirSync(join(f.dir,'src'));symlinkSync(outside,join(f.dir,'src','linked'));writeFileSync(join(outside,'existing'),'keep');
    const definition=f.controller.roleDefinitions(f.ctx).find(role=>role.id==='implementer')!,role=freezeRole(definition,{tools:['read','write','edit','bash'],writeScopes:['src']});
    assert.equal(blockedByFrozenRole(role,'write',{path:'src/new.ts'},f.dir),false);assert.equal(blockedByFrozenRole(role,'write',{path:'other.ts'},f.dir),true);
    assert.equal(blockedByFrozenRole(role,'write',{path:'src/../../escape'},f.dir),true);assert.equal(blockedByFrozenRole(role,'write',{path:'src/linked/new.ts'},f.dir),true);assert.equal(blockedByFrozenRole(role,'edit',{path:join(outside,'existing')},f.dir),true);assert.equal(blockedByFrozenRole(role,'bash',{command:'true'},f.dir),true);
    assert.equal(blockedByFrozenRole(freezeRole(definition,{writeScopes:['.']}),'bash'),false);
  }finally{f.dispose();rmSync(outside,{recursive:true,force:true});}
});
test('safe switching uses trusted host stage/run/revision; tool input cannot manufacture a safe boundary',async()=>{
  const f=fixture();try{
    await f.controller.dispatch('role.assign',{id:'reviewer'},f.ctx);f.controller.beginRun(f.ctx);
    const agent={...f.ctx,origin:'agent' as const};
    for(const input of [{...f.input('implementer'),stage:'invented'},{...f.input('implementer'),policyRevision:0},{...f.input('implementer'),runId:'old'}])await assert.rejects(f.controller.dispatch('role.switch',input,agent),/阶段|策略|身份/);
    await assert.rejects(f.controller.dispatch('role.switch',{...f.input('implementer'),canSwitchRole:true,unsettledTools:0},{...agent,policy:undefined}),/宿主/);
    await assert.rejects(f.controller.dispatch('role.switch',f.input('implementer'),{...agent,policy:{...f.ctx.policy,unsettledTools:1}}),/未收敛/);
    const switched=await f.controller.dispatch('role.switch',f.input('implementer'),agent) as {role:FrozenRole;independent:boolean};
    assert.equal(switched.role.id,'implementer');assert.equal(switched.independent,false);assert.equal(blockedByFrozenScope(f.controller.snapshot(f.ctx).adoptions as FrozenRun,'write',{path:'new.ts'},f.dir),false);
    assert.equal(f.entries.filter(entry=>entry.type==='friend-pi.expert.role').length,2);
  }finally{f.dispose();}
});
test('switching roles preserves accumulated method restrictions and a journal failure cannot grant a wider role',async()=>{
  const f=fixture();try{
    const method=await f.controller.dispatch('create',{title:'read method',prompt:'read only',tools:['read']},f.ctx) as {id:string};
    await f.controller.dispatch('role.assign',{id:'reviewer'},f.ctx);f.controller.beginRun(f.ctx);await f.controller.dispatch('use',{id:method.id},{...f.ctx,origin:'agent'});
    await f.controller.dispatch('role.switch',f.input('implementer'),{...f.ctx,origin:'agent'});
    assert.equal(blockedByFrozenScope(f.controller.snapshot(f.ctx).adoptions as FrozenRun,'write',{path:'new'},f.dir),true);
    await f.controller.dispatch('role.switch',f.input('reviewer'),{...f.ctx,origin:'agent'});
    await assert.rejects(f.controller.dispatch('role.switch',f.input('implementer'),{...f.ctx,origin:'agent',appendEntry:()=>{throw Error('journal failed');}}),/journal/);
    assert.equal((f.controller.snapshot(f.ctx).adoptions as FrozenRun).role!.id,'reviewer');
  }finally{f.dispose();}
});
test('assignment applies next run; method use cannot change role or model mapping',async()=>{
  const f=fixture();try{
    const current=f.controller.beginRun(f.ctx);await f.controller.dispatch('role.assign',{id:'reviewer',methodIds:['researcher']},f.ctx);
    assert.equal((f.controller.snapshot(f.ctx).adoptions as FrozenRun).role,undefined);assert.equal(current.role,undefined);
    const next=f.controller.beginRun({...f.ctx,runId:'run-two'});assert.equal(next.role!.id,'reviewer');assert.deepEqual(next.selectedIds,['researcher']);assert.equal(next.modelId,'fixture/main');
    await f.controller.dispatch('use',{id:'researcher',modelId:'fixture/review',tools:['write']},{...f.ctx,runId:'run-two',origin:'agent'});
    const actual=f.controller.snapshot(f.ctx).adoptions as FrozenRun;assert.equal(actual.role!.id,'reviewer');assert.equal(actual.role!.modelId,'fixture/main');assert.equal(blockedByFrozenScope(actual,'write',{path:'x'},f.dir),true);
  }finally{f.dispose();}
});
test('explicit role model mapping is validated, recorded as a requested change, and checked by the host',async()=>{
  const f=fixture();try{
    const before=f.controller.roleDefinitions(f.ctx).find(role=>role.id==='reviewer')!;
    await assert.rejects(f.controller.dispatch('role.update',{...before,modelId:'missing/model'},f.ctx),/可用模型/);
    await assert.rejects(f.controller.dispatch('role.update',{...before,modelId:'fixture/review',thinkingLevel:'medium'},f.ctx),/思考等级/);
    await f.controller.dispatch('role.update',{...before,modelId:'fixture/review',thinkingLevel:'high'},f.ctx);f.controller.beginRun(f.ctx);
    const switched=await f.controller.dispatch('role.switch',f.input('reviewer'),{...f.ctx,origin:'agent'}) as {role:FrozenRole;modelChangeRequired:boolean};assert.equal(switched.modelChangeRequired,true);assert.throws(()=>assertRoleModel(switched.role,f.ctx),/尚未应用/);assert.doesNotThrow(()=>assertRoleModel(switched.role,{modelId:'fixture/review',thinkingLevel:'high'}));assert.equal(f.ctx.modelId,'fixture/main');
  }finally{f.dispose();}
});
test('structured role delivery rejects missing fields, unknown fields and coercion',()=>{
  const f=fixture();try{const role=freezeRole(f.controller.roleDefinitions(f.ctx).find(role=>role.id==='reviewer')!);
    assert.deepEqual(assertRoleDelivery(role,{approved:false,findings:'specific missing behavior',taskIds:['task-1']}),{approved:false,findings:'specific missing behavior',taskIds:['task-1']});
    for(const value of [{approved:'false',findings:'facts'},{approved:false},{approved:true,findings:''},{approved:true,findings:'facts',unknown:1},{approved:true,findings:'facts',taskIds:[1]}])assert.throws(()=>assertRoleDelivery(role,value),/字段/);
  }finally{f.dispose();}
});
