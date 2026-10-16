import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ExpertController,type ExpertProfile} from '../src/index.ts';
import {digest,type PluginContext,type ResolvedExpertSpawn,type JsonObject,type HostPolicy} from '../../core/src/index.ts';

const policy=(tools:string[],writeScopes:string[]=['.']):HostPolicy=>({v:1,revision:1,stage:'execute',canSwitchRole:false,unsettledTools:0,tools,writeScopes,executionMode:'single',planMode:false});

function fixture(){
 const dataDir=mkdtempSync(join(tmpdir(),'friend-expert-profile-')),controller=new ExpertController(dataDir);
 let calls=0;
 const ctx:PluginContext={origin:'user',dataDir,projectDir:dataDir,projectId:'p',sessionId:'s',modelId:'fake/a',thinkingLevel:'off',availableTools:['read','write','edit','bash'],availableModels:[{id:'fake/a',thinkingLevels:['off','low']},{id:'fake/b',thinkingLevels:['off','high']}],isIdle:()=>true,history:()=>[],readSource:()=>{throw new Error('missing');},complete:async()=>{calls++;return '{}';},request:async()=>undefined,emit:()=>{},notify:()=>{},appendEntry:()=>{}};
 const create=(input:JsonObject)=>controller.dispatch('profile.create',input,ctx) as Promise<ExpertProfile>;
 const resolve=(expertId:string,overrides?:JsonObject,context=ctx)=>controller.dispatch('spawn.resolve',{expertId,...(overrides?{overrides}:{})},context) as Promise<ResolvedExpertSpawn>;
 return {controller,ctx,create,resolve,calls:()=>calls,dispose:()=>{controller.dispose();rmSync(dataDir,{recursive:true,force:true});}};
}

test('profile defaults are five templates; unlimited user profiles paginate and expose authorized metadata',async()=>{
 const f=fixture();try{
  const initial=await f.controller.dispatch('profile.list',{},f.ctx) as any;
  assert.equal(initial.total,5);assert.equal(initial.items.length,5);assert.ok(initial.skills.length>=15);
  assert.ok(initial.skills.every((skill:any)=>typeof skill.version==='number'&&typeof skill.hash==='string'&&!('body' in skill)));
  assert.deepEqual(initial.availableModels,f.ctx.availableModels);assert.deepEqual(initial.availableTools,f.ctx.availableTools);
  for(let i=0;i<9;i++)await f.create({title:`Additional ${i}`,prompt:`Prompt ${i}`});
  let cursor:string|undefined;const ids:string[]=[];
  do{const page=await f.controller.dispatch('profile.list',{limit:3,...(cursor?{cursor}:{})},f.ctx) as any;assert.equal(page.total,14);ids.push(...page.items.map((item:any)=>item.id));cursor=page.nextCursor;}while(cursor);
  assert.equal(new Set(ids).size,14);
  const page=await f.controller.dispatch('profile.list',{query:'Additional',limit:2},f.ctx) as any;
  assert.equal(page.total,9);assert.equal(page.items.length,2);
  await f.create({title:'Additional new',prompt:''});
  await assert.rejects(f.controller.dispatch('profile.list',{query:'Additional',limit:2,cursor:page.nextCursor},f.ctx),/目录或查询已变化/);
  const capped=await f.controller.dispatch('profile.list',{}, {...f.ctx,policy:policy(['read'])}) as any;assert.deepEqual(capped.availableTools,['read']);
  assert.equal(f.calls(),0);
 }finally{f.dispose();}
});

test('two immediately usable profiles freeze different prompts, skills, tools and model mappings with per-spawn priority',async()=>{
 const f=fixture();try{
  const a=await f.create({title:'Reader',prompt:'  Read exactly.\n',skillRefs:[{id:'seed.researcher.1',version:1}],tools:['read'],modelId:'fake/a',thinkingLevel:'low'});
  const b=await f.create({title:'Writer',prompt:'Write exactly.',skillRefs:[{id:'seed.implementer.1',version:1}],tools:['read','write'],modelId:'fake/b',thinkingLevel:'high'});
  assert.equal(a.validationKind,'user-configured');assert.equal(a.source,'user');assert.equal(f.calls(),0);
  const ra=await f.resolve(a.id),rb=await f.resolve(b.id);
  assert.equal(ra.prompt,'  Read exactly.\n');assert.equal(rb.prompt,'Write exactly.');assert.notEqual(ra.skills[0].id,rb.skills[0].id);assert.deepEqual(ra.tools,['read']);assert.deepEqual(rb.tools,['read','write']);assert.equal(rb.modelId,'fake/b');assert.equal(rb.thinkingLevel,'high');
  const override=await f.resolve(a.id,{prompt:'Transient',skillRefs:[],tools:[],modelId:'fake/b',thinkingLevel:'high'},{...f.ctx,origin:'agent'});
  assert.equal(override.prompt,'Transient');assert.deepEqual(override.skills,[]);assert.deepEqual(override.tools,[]);assert.equal(override.toolsMode,'allowlist');assert.equal(override.modelId,'fake/b');
  assert.deepEqual(await f.controller.dispatch('profile.read',{id:a.id},f.ctx),a);
  const updated=await f.controller.dispatch('profile.update',{id:a.id,expectedRevision:a.revision,prompt:'Updated preset'},f.ctx) as ExpertProfile;
  assert.equal(updated.version,2);assert.equal(ra.prompt,'  Read exactly.\n');assert.deepEqual(await f.controller.dispatch('spawn.validate',{hash:ra.hash},f.ctx),ra);
  const copy=await f.controller.dispatch('profile.copy',{id:a.id,title:'Copy'},f.ctx) as ExpertProfile;assert.notEqual(copy.id,a.id);assert.equal(copy.version,1);assert.equal(copy.prompt,'Updated preset');
  const reset=await f.controller.dispatch('profile.update',{id:copy.id,expectedRevision:copy.revision,modelId:null,thinkingLevel:null,toolsMode:'inherit',tools:[]},f.ctx) as ExpertProfile;
  assert.equal(reset.modelId,undefined);assert.equal(reset.thinkingLevel,undefined);assert.deepEqual((await f.resolve(copy.id)).tools,f.ctx.availableTools);assert.equal((await f.resolve(copy.id)).thinkingLevel,'off');
 }finally{f.dispose();}
});

test('host/task authority caps inherit and allowlist, while unavailable explicit resources reject',async()=>{
 const f=fixture();try{
  const profile=await f.create({title:'Scope',prompt:'Do work',tools:['read','write','bash']});
  const cap={...f.ctx,policy:policy(['read','write','bash'],['src'])};
  const resolved=await f.resolve(profile.id,undefined,cap);assert.deepEqual(resolved.tools,['read','write']);assert.deepEqual(resolved.writeScopes,['src']);
  assert.deepEqual((await f.resolve(profile.id,{toolsMode:'inherit'},{...cap,policy:policy(['read'],[])})).tools,['read']);
  assert.deepEqual((await f.resolve(profile.id,{tools:[]})).tools,[]);
  for(const overrides of [{tools:['unavailable']},{modelId:'fake/missing'},{skillRefs:[{id:'missing'}]},{skillRefs:[{id:'seed.planner.1',version:900}]},{modelId:'fake/a',thinkingLevel:'high'}])await assert.rejects(f.resolve(profile.id,overrides));
  await assert.rejects(f.resolve(profile.id,{writeScopes:['.']}),/未知/);
  await assert.rejects(f.resolve(profile.id,{toolsMode:'inherit',tools:['write']}),/inherit/);
  const inherited=await f.create({title:'Host default',prompt:''});assert.deepEqual((await f.resolve(inherited.id,undefined,{...f.ctx,availableTools:undefined,policy:undefined})).tools,[]);
 }finally{f.dispose();}
});

test('only users mutate profiles; CAS, toggles and project isolation preserve legacy records',async()=>{
 const f=fixture();try{
  const profile=await f.create({title:'Private',prompt:'Private prompt'}),before=f.controller.definitions(f.ctx),roles=f.controller.roleDefinitions(f.ctx);
  for(const origin of ['agent','plugin'] as const)for(const action of ['profile.create','profile.copy','profile.update','profile.toggle'])await assert.rejects(f.controller.dispatch(action,{id:profile.id,expectedRevision:profile.revision,title:'Forbidden',prompt:'Bad',enabled:false},{...f.ctx,origin}),/用户/);
  assert.equal((await f.resolve(profile.id,undefined,{...f.ctx,origin:'agent'})).prompt,'Private prompt');
  const disabled=await f.controller.dispatch('profile.toggle',{id:profile.id,expectedRevision:profile.revision,enabled:false},f.ctx) as ExpertProfile;
  await assert.rejects(f.resolve(profile.id),/停用/);
  await assert.rejects(f.controller.dispatch('profile.update',{id:profile.id,expectedRevision:profile.revision,prompt:'Stale'},f.ctx),/版本/);
  await f.controller.dispatch('profile.toggle',{id:profile.id,expectedRevision:disabled.revision,enabled:true},f.ctx);assert.equal((await f.resolve(profile.id)).prompt,'Private prompt');
  await assert.rejects(f.controller.dispatch('profile.read',{id:profile.id},{...f.ctx,projectId:'other'}),/不存在/);
  await f.controller.dispatch('profile.update',{id:'planner',expectedRevision:before.find(x=>x.id==='planner')!.revision,title:'My planner'},f.ctx);
  assert.deepEqual(f.controller.definitions(f.ctx),before);assert.deepEqual(f.controller.roleDefinitions(f.ctx),roles);
  assert.equal((await f.controller.dispatch('profile.read',{id:'role:planner'},f.ctx) as ExpertProfile).source,'role');
 }finally{f.dispose();}
});

test('manual Skills are immediately selectable; frozen versions survive edits but source revocation still denies use',async()=>{
 const f=fixture();try{
  let sourceAvailable=true;const sourceText='User supplied method source.';f.ctx.readSource=()=>{if(!sourceAvailable)throw new Error('source gone');return {id:'e',parentId:null,type:'message',timestamp:new Date().toISOString(),text:sourceText};};
  const skill=await f.controller.dispatch('candidate.submit',{key:'manual-skill',skillBody:{title:'Manual',applicability:'Reading',body:'Read the supplied document.'},evidence:[{kind:'pi',projectId:f.ctx.projectId,source:{sessionId:'s',entryId:'e',hash:digest(sourceText)}}]},f.ctx) as any;
  const profile=await f.create({title:'Manual expert',prompt:'Manual prompt',skillRefs:[{id:skill.id}],tools:['read']});
  const frozen=await f.resolve(profile.id);assert.equal(frozen.skills[0].version,1);assert.equal(frozen.skills[0].body,'Read the supplied document.');
  const metadata=await f.controller.dispatch('profile.list',{},f.ctx) as any;assert.ok(metadata.skills.some((s:any)=>s.id===skill.id&&s.kind==='manual'&&s.available));
  await f.controller.dispatch('skill.update',{id:skill.id,expectedRevision:skill.revision,body:'Read the updated document.',key:'edit-manual'},f.ctx);
  assert.equal((await f.resolve(profile.id)).skills[0].version,2);assert.deepEqual(await f.controller.dispatch('spawn.validate',{hash:frozen.hash},f.ctx),frozen);
  sourceAvailable=false;await assert.rejects(f.resolve(profile.id),/source gone/);await assert.rejects(f.controller.dispatch('spawn.validate',{hash:frozen.hash},f.ctx),/source gone/);
  assert.equal(f.calls(),0);
 }finally{f.dispose();}
});


test('legacy custom roles and definitions remain selectable through the unified profile directory',async()=>{
 const f=fixture();try{
  const legacy=await f.controller.dispatch('create',{title:'Legacy method',prompt:'Legacy prompt',tools:['read'],skills:[]},f.ctx) as {id:string};
  const role=await f.controller.dispatch('role.create',{title:'Custom role',responsibility:'Inspect project sources',tools:['read'],writeScopes:[],delivery:{v:1,fields:{summary:'string'},required:['summary']}},f.ctx) as {id:string};
  const list=await f.controller.dispatch('profile.list',{query:'Custom role'},f.ctx) as any;assert.equal(list.total,1);assert.equal(list.items[0].id,role.id);
  assert.equal((await f.resolve(role.id)).prompt,'Inspect project sources');assert.deepEqual((await f.resolve(role.id)).writeScopes,[]);
  assert.equal((await f.resolve(legacy.id)).prompt,'Legacy prompt');
 }finally{f.dispose();}
});


test('frozen Skill disable and snapshot integrity failures reject validation',async()=>{
 const f=fixture();try{
  const profile=await f.create({title:'Frozen source',prompt:'Check',skillRefs:[{id:'seed.researcher.1',version:1}]});
  const frozen=await f.resolve(profile.id),key=`spawn:${f.ctx.projectId}:${frozen.hash}`,row=f.controller.store.get<any>(key)!;
  f.controller.store.put(key,{...row.value,snapshot:{...row.value.snapshot,prompt:'tampered'}},row.revision);
  await assert.rejects(f.controller.dispatch('spawn.validate',{hash:frozen.hash},f.ctx),/摘要/);
  const restored=await f.resolve(profile.id),head=f.controller.skillCatalog.head('seed.researcher.1',f.ctx);
  await f.controller.dispatch('skill.toggle',{id:head.id,expectedRevision:head.revision,enabled:false,key:'disable-frozen'},f.ctx);
  await assert.rejects(f.controller.dispatch('spawn.validate',{hash:restored.hash},f.ctx),/停用或撤回/);
  await assert.rejects(f.resolve(profile.id),/停用或撤回/);
 }finally{f.dispose();}
});


test('profile selection prefers an effective manual head over stable without changing pinned or legacy adoption',async()=>{
 const f=fixture();try{
  const id='seed.researcher.1',profile=await f.create({title:'User research',prompt:'Review sources',skillRefs:[{id}]}),before=await f.resolve(profile.id),head=f.controller.skillCatalog.head(id,f.ctx);
  const edited=await f.controller.dispatch('skill.update',{id,expectedRevision:head.revision,body:'Use the newly edited research instructions.',key:'manual-over-stable'},f.ctx) as {version:number};
  assert.equal(edited.version,2);assert.equal(f.controller.skillCatalog.head(id,f.ctx).stable?.version,1);
  const current=await f.resolve(profile.id);assert.equal(current.skills[0].version,2);assert.equal(current.skills[0].body,'Use the newly edited research instructions.');
  const metadata=await f.controller.dispatch('profile.list',{},f.ctx) as any,selected=metadata.skills.find((skill:any)=>skill.id===id);
  assert.equal(selected.version,2);assert.equal(selected.kind,'manual');assert.equal(selected.available,true);assert.equal(selected.validationKind,undefined);
  const pinned=await f.resolve(profile.id,{skillRefs:[{id,version:1}]});assert.equal(pinned.skills[0].version,1);assert.equal(pinned.skills[0].body,before.skills[0].body);
  assert.deepEqual(await f.controller.dispatch('spawn.validate',{hash:before.hash},f.ctx),before);
  const legacy=f.controller.beginRun(f.ctx).experts.find(expert=>expert.id==='researcher')!.frozenSkills!.find(skill=>skill.id===id)!;assert.equal(legacy.version,1);assert.equal(legacy.body,before.skills[0].body);
  assert.equal(f.calls(),0);
 }finally{f.dispose();}
});
