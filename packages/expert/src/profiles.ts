import { randomUUID } from 'node:crypto';
import { CapabilityError, digest, object, text, type ExpertSkillSelection, type ExpertSpawnOverrides, type JsonObject, type PluginContext, type RecordStore, type ResolvedExpertSpawn } from '@friend-pi/core';
import { integer, mutationOrigin, SkillCatalog, type SkillVersion, type SkillHead } from './skills.js';
import { intersectWriteScopes, type RoleDefinition } from './roles.js';
import type { ExpertDefinition } from './index.js';

export interface ExpertProfile {
  v:1; id:string; version:number; revision:number; title:string; prompt:string;
  skillRefs:ExpertSkillSelection[]; toolsMode:'inherit'|'allowlist'; tools:string[];
  modelId?:string; thinkingLevel?:string; enabled:boolean; hash:string;
  source:'user'|'legacy'|'template'|'role'; validationKind?:'user-configured';
  writeScopes?:string[];
}
type Legacy = ExpertDefinition & {revision:number};
type Role = RoleDefinition & {revision:number};
const fail=(message:string):never=>{throw new CapabilityError('VALIDATION_ERROR',message);};
const strings=(value:unknown,label:string):string[]=>{
  if(!Array.isArray(value)||value.length>1024) return fail(`${label}必须是至多 1024 项的数组`);
  return [...new Set(value.map(item=>text(item,label,500)))];
};
function prompt(value:unknown):string {
  if(typeof value!=='string'||value.length>65536)return fail('prompt 必须是至多 65536 字符的文本');
  return value; // Exact bytes are part of the spawn snapshot; do not trim.
}
function refs(value:unknown):ExpertSkillSelection[]{
  if(!Array.isArray(value)||value.length>64)return fail('skillRefs 必须是至多 64 项的数组');
  const result=value.map(raw=>{const ref=object(raw);return {id:text(ref.id,'Skill ID'),...(ref.version===undefined?{}:{version:integer(ref.version,'Skill version')})};});
  if(new Set(result.map(ref=>ref.id)).size!==result.length)return fail('skillRefs 不得重复同一 Skill');
  return result;
}
const overrideKeys=new Set(['prompt','skillRefs','toolsMode','tools','modelId','thinkingLevel']);
export function parseSpawnOverrides(input:unknown):ExpertSpawnOverrides {
  const value=object(input);
  if(Object.keys(value).some(key=>!overrideKeys.has(key)))return fail('未知 spawn override 字段');
  const result:ExpertSpawnOverrides={};
  if(value.prompt!==undefined)result.prompt=prompt(value.prompt);
  if(value.skillRefs!==undefined)result.skillRefs=refs(value.skillRefs);
  if(value.toolsMode!==undefined){if(value.toolsMode!=='inherit'&&value.toolsMode!=='allowlist')return fail('toolsMode 必须是 inherit 或 allowlist');result.toolsMode=value.toolsMode;}
  if(value.tools!==undefined)result.tools=strings(value.tools,'tools');
  for(const field of ['modelId','thinkingLevel'] as const)if(value[field]!==undefined)result[field]=text(value[field],field,500);
  if(result.toolsMode==='inherit'&&result.tools?.length)return fail('inherit 不接受非空 tools；选择 allowlist 或省略 toolsMode');
  return result;
}

/** User configuration has its own namespace: no mutation of growth records or Pi transcripts. */
export class ProfileCatalog {
  constructor(readonly store:RecordStore,readonly skills:SkillCatalog,readonly definitions:(ctx:PluginContext)=>Legacy[],readonly roles:(ctx:PluginContext)=>Role[]){}
  private key(ctx:PluginContext,id:string){return `profile:${ctx.projectId}:${id}`;}
  all(ctx:PluginContext,includeBuiltinRoles=false):ExpertProfile[]{
    const experts=this.skills.experts(ctx),result=new Map<string,ExpertProfile>();
    for(const definition of this.definitions(ctx)){
      const e=experts.find(item=>item.id===definition.id);
      result.set(definition.id,{v:1,id:definition.id,version:definition.version,revision:definition.revision,title:definition.title,prompt:definition.prompt,skillRefs:e?.defaultSkillRefs.map(ref=>({id:ref.id}))||[],toolsMode:definition.tools.length?'allowlist':'inherit',tools:[...definition.tools],enabled:definition.enabled,hash:definition.hash,source:definition.scope==='builtin'?'template':'legacy'});
    }
    for(const role of this.roles(ctx)){
      if(role.scope==='builtin'&&result.has(role.id)&&!includeBuiltinRoles)continue;
      const id=result.has(role.id)?`role:${role.id}`:role.id;
      result.set(id,{v:1,id,version:role.version,revision:role.revision,title:role.title,prompt:role.responsibility,skillRefs:[],toolsMode:'allowlist',tools:[...role.tools],writeScopes:[...role.writeScopes],modelId:role.modelId,thinkingLevel:role.thinkingLevel,enabled:role.enabled,hash:role.hash,source:'role'});
    }
    for(const row of this.store.list<ExpertProfile>(`profile:${ctx.projectId}:`))result.set(row.value.id,{...row.value,revision:row.revision});
    return [...result.values()].sort((a,b)=>a.id.localeCompare(b.id));
  }
  read(id:string,ctx:PluginContext):ExpertProfile {
    const result=this.all(ctx,true).find(item=>item.id===id);if(!result)throw new CapabilityError('SOURCE_UNAVAILABLE','专家预设不存在');return result;
  }
  private preferredSkillVersion(head:SkillHead,ctx:PluginContext):number {
    const current=this.skills.version(head.id,head.version,ctx),status=this.skills.statusForVersion(current,ctx);
    // A user's explicit edit is usable immediately in profiles. Learned candidates
    // still resolve the stable pointer; legacy adoption has its own unchanged rules.
    return current.kind==='manual'&&!['disabled','withdrawn'].includes(status)?head.version:this.skills.stableOf(head,ctx)?.version??head.version;
  }
  list(input:JsonObject,ctx:PluginContext){
    const query=input.query===undefined?'':typeof input.query==='string'?input.query.trim().toLowerCase():fail('query 必须是文本');
    const all=this.all(ctx).filter(item=>!query||`${item.id}\n${item.title}\n${item.prompt}`.toLowerCase().includes(query));
    const limit=input.limit===undefined?20:integer(input.limit,'limit',1,100);
    const signature=digest({projectId:ctx.projectId,query,items:all.map(item=>[item.id,item.version,item.revision,item.hash])});
    let offset=0;
    if(input.cursor!==undefined){try{const cursor=object(JSON.parse(Buffer.from(text(input.cursor,'cursor',2048),'base64url').toString()));if(cursor.signature!==signature)throw new Error();offset=integer(cursor.offset,'cursor offset',0,all.length);}catch{throw new CapabilityError('VERSION_CONFLICT','目录或查询已变化，请重新分页');}}
    const availableTools=[...(ctx.availableTools??ctx.policy?.tools??[])].filter(tool=>!ctx.policy?.tools||ctx.policy.tools.includes(tool));
    const skills=this.skills.heads(ctx).flatMap(head=>{
      const stable=this.skills.stableOf(head,ctx);
      try{const skill=this.skills.version(head.id,this.preferredSkillVersion(head,ctx),ctx),status=this.skills.statusForVersion(skill,ctx);let available=status==='validated'||status==='trial'||skill.kind==='manual'&&!['disabled','withdrawn'].includes(status);
        try{this.skills.resolve(skill.id,skill.version,ctx);}catch{available=false;}
        return [{id:skill.id,version:skill.version,hash:skill.contentHash,title:skill.title,description:skill.description,kind:skill.kind,status,validationKind:stable?.version===skill.version?stable.validationKind:head.validationKind,enabled:head.enabled!==false&&status!=='disabled',available}];
      }catch{return [];}
    });
    const end=offset+limit;return {items:all.slice(offset,end),total:all.length,availableTools,availableModels:structuredClone(ctx.availableModels??[]),skills,...(end<all.length?{nextCursor:Buffer.from(JSON.stringify({signature,offset:end})).toString('base64url')}:{})};
  }
  mutate(action:string,input:JsonObject,ctx:PluginContext):ExpertProfile {
    mutationOrigin(ctx,true);
    return this.store.transaction(()=>{
      const previous=action==='profile.create'?undefined:this.read(text(input.id,'id'),ctx);
      if(action==='profile.update'||action==='profile.toggle'){
        if(integer(input.expectedRevision,'expectedRevision')!==previous!.revision)throw new CapabilityError('VERSION_CONFLICT','预设版本已变化，请刷新后重试');
      }
      const copy=action==='profile.copy',id=!previous||copy?randomUUID():previous.id;
      const patch=action==='profile.toggle'?{}:Object.fromEntries(Object.entries(input).filter(([key])=>overrideKeys.has(key)));
      // A stored inherit profile keeps an empty list; changing only its mode is supported.
      const overrides=parseSpawnOverrides(Object.fromEntries(Object.entries(patch).filter(([key,value])=>value!==null||!['modelId','thinkingLevel'].includes(key))));
      const toolsMode=overrides.toolsMode??(overrides.tools!==undefined?'allowlist':previous?.toolsMode??'inherit');
      const fields={title:text(input.title??(copy?`${previous!.title} 副本`:previous?.title),'title',120),prompt:overrides.prompt??previous?.prompt??'',skillRefs:overrides.skillRefs??previous?.skillRefs??[],toolsMode,tools:toolsMode==='inherit'?[]:overrides.tools??previous?.tools??[],modelId:patch.modelId===null?undefined:overrides.modelId??previous?.modelId,thinkingLevel:patch.thinkingLevel===null?undefined:overrides.thinkingLevel??previous?.thinkingLevel};
      if(input.enabled!==undefined&&typeof input.enabled!=='boolean')return fail('enabled 必须是布尔值');
      if(action==='profile.toggle'&&typeof input.enabled!=='boolean')return fail('enabled 必须是布尔值');
      const enabled=input.enabled===undefined?(copy?true:previous?.enabled??true):input.enabled;
      const profile:ExpertProfile={v:1,id,version:!previous||copy?1:previous.version+1,revision:1,...fields,enabled,source:'user',validationKind:'user-configured',...(previous?.writeScopes?{writeScopes:[...previous.writeScopes]}:{}),hash:''};
      profile.hash=digest({...profile,hash:undefined,revision:undefined});
      if(previous&&!copy&&!this.store.get(`profile.version:${ctx.projectId}:${id}:${previous.version}`))this.store.put(`profile.version:${ctx.projectId}:${id}:${previous.version}`,previous,null);
      const local=this.store.get(this.key(ctx,id));let saved=this.store.put(this.key(ctx,id),profile,local?.revision??null);
      while(previous&&!copy&&saved.revision<=previous.revision)saved=this.store.put(saved.key,profile,saved.revision);
      return {...profile,revision:saved.revision};
    });
  }
  resolve(input:JsonObject,ctx:PluginContext):ResolvedExpertSpawn {
    const preset=this.read(text(input.expertId,'expertId'),ctx);if(!preset.enabled)throw new CapabilityError('SOURCE_UNAVAILABLE','专家预设已停用');
    const overrides=input.overrides===undefined?{}:parseSpawnOverrides(input.overrides);
    const selected=overrides.skillRefs??preset.skillRefs,versions=new Map<string,SkillVersion>();
    for(const ref of selected){
      const head=this.skills.head(ref.id,ctx),version=ref.version??this.preferredSkillVersion(head,ctx);
      for(const skill of this.skills.resolve(ref.id,version,ctx)){
        const status=this.skills.statusForVersion(skill,ctx);
        if(status!=='validated'&&status!=='trial'&&skill.kind!=='manual')throw new CapabilityError('SOURCE_UNAVAILABLE','成长 Skill 尚不可使用');
        if(digest(skill.body)!==skill.contentHash)throw new CapabilityError('VERSION_CONFLICT','Skill 正文摘要不一致');
        versions.set(`${skill.id}:${skill.version}`,skill);
      }
    }
    const modelId=overrides.modelId??preset.modelId??ctx.modelId,thinkingLevel=overrides.thinkingLevel??preset.thinkingLevel??ctx.thinkingLevel;
    const explicitModel=overrides.modelId??preset.modelId,model=ctx.availableModels?.find(item=>item.id===modelId);
    if(explicitModel&&!model)throw new CapabilityError('SOURCE_UNAVAILABLE','明确指定模型不可用');
    if(thinkingLevel&&model&&!model.thinkingLevels.includes(thinkingLevel))throw new CapabilityError('VALIDATION_ERROR','思考等级不适用于指定模型');
    if((overrides.thinkingLevel??preset.thinkingLevel)&&!model)throw new CapabilityError('SOURCE_UNAVAILABLE','无法核实思考等级对应的可用模型');
    const available=ctx.availableTools??ctx.policy?.tools??[],authorized=available.filter(tool=>!ctx.policy?.tools||ctx.policy.tools.includes(tool));
    const toolsMode=overrides.toolsMode??(overrides.tools!==undefined?'allowlist':preset.toolsMode),requested=overrides.tools??preset.tools;
    if(toolsMode==='allowlist'&&requested.some(tool=>!available.includes(tool)))throw new CapabilityError('SOURCE_UNAVAILABLE','明确指定工具不可用');
    let tools=toolsMode==='inherit'?[...authorized]:requested.filter(tool=>authorized.includes(tool));
    let writeScopes=preset.writeScopes?intersectWriteScopes(preset.writeScopes,ctx.policy?.writeScopes??['.']):[...(ctx.policy?.writeScopes??(ctx.availableTools?['.']:[]))];
    for(const skill of versions.values()){
      if(skill.restrictions?.tools)tools=tools.filter(tool=>skill.restrictions!.tools!.includes(tool));
      if(skill.restrictions?.writeScopes)writeScopes=intersectWriteScopes(writeScopes,skill.restrictions.writeScopes);
    }
    tools=tools.filter(tool=>!(tool==='bash'&&!writeScopes.includes('.'))&&!(['write','edit'].includes(tool)&&!writeScopes.length));
    const body={v:1 as const,id:preset.id,title:preset.title,version:preset.version,prompt:overrides.prompt??preset.prompt,skills:[...versions.values()].map(skill=>({id:skill.id,version:skill.version,hash:skill.contentHash,body:skill.body,title:skill.title})),toolsMode,tools,modelId,thinkingLevel,writeScopes};
    const snapshot:ResolvedExpertSpawn={...body,hash:digest(body)};
    this.store.put(`spawn:${ctx.projectId}:${snapshot.hash}`,{snapshot,skills:[...versions.values()]});
    this.skills.policy.publishDependency({capability:'expert',id:`spawn:${snapshot.hash}`,projectId:ctx.projectId,version:1,hash:snapshot.hash,valid:true});
    return structuredClone(snapshot);
  }
  validate(hash:string,ctx:PluginContext):ResolvedExpertSpawn {
    const record=this.store.get<{snapshot:ResolvedExpertSpawn;skills:SkillVersion[]}>(`spawn:${ctx.projectId}:${hash}`)?.value;
    if(!record)throw new CapabilityError('SOURCE_UNAVAILABLE','冻结预设不存在');
    const {hash:storedHash,...body}=record.snapshot;
    if(storedHash!==hash||digest(body)!==hash)throw new CapabilityError('VERSION_CONFLICT','冻结预设摘要不一致');
    for(const skill of record.skills){if(digest(skill.body)!==skill.contentHash||!record.snapshot.skills.some(item=>item.id===skill.id&&item.version===skill.version&&item.hash===skill.contentHash&&item.body===skill.body))throw new CapabilityError('VERSION_CONFLICT','冻结 Skill 摘要不一致');if(['disabled','withdrawn'].includes(this.skills.statusForVersion(skill,ctx)))throw new CapabilityError('SOURCE_UNAVAILABLE','冻结 Skill 已停用或撤回');this.skills.policy.assert(this.skills.checkEvidence(skill,ctx));}
    return structuredClone(record.snapshot);
  }
}
