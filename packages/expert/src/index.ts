import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { RecordStore, registerPlugin, digest, text, object, makeContext, parseModelJson, type PluginContext, type JsonObject, type SourceRef } from '@friend-pi/core';
import { builtinRoles, roleDefinition, freezeRole, blockedByFrozenRole, assertRoleModel, assertRoleDelivery, intersectWriteScopes, normalizeWriteScopes, type RoleDefinition, type FrozenRole, type RoleCapability } from './roles.js';
export { freezeRole, blockedByFrozenRole, assertRoleModel, assertRoleDelivery, intersectWriteScopes, type RoleDefinition, type FrozenRole, type RoleCapability, type RoleDeliveryContract } from './roles.js';

export interface ExpertDefinition { id:string; version:number; title:string; scope:string; prompt:string; tools:string[]; skills:string[]; enabled:boolean; hash:string; createdAt:string; candidateId?:string }
export interface FrozenSkill {path:string;content:string;hash:string}
export interface FrozenExpert extends ExpertDefinition {skillContents:FrozenSkill[]}
export interface FrozenRun {id:string;version:number;prompt:string;toolScope?:string[];skillPaths:string[];experts:FrozenExpert[];methods?:FrozenExpert[];roles?:RoleDefinition[];role?:FrozenRole;hash:string;runId?:string;modelId?:string;thinkingLevel?:string;selectionMode:'auto'|'explicit';selectedIds:string[];adoptedIds?:string[];adoptions?:unknown[]}
export interface ValidationCase {id:string;kind:'positive'|'negative';input:string;expected:unknown;scope:string}
export interface MethodCandidate {
  id:string;title:string;method:string;scope:string;sourceMemoryIds:string[];sources:SourceRef[];
  status:'candidate'|'queued'|'validating'|'failed'|'published'|'withdrawn';
  checks:{caseId:string;passed:boolean;baselinePassed:boolean;output:string}[];error?:string;publishedId?:string;
  validation?:{ownerPid:number;ownerRuntime:string;suiteHash:string;modelId?:string;startedAt:string};
  evaluation?:{suiteHash:string;cases:ValidationCase[];modelId?:string;at:string};
}
interface ValidationJob {key:string;id:string;ctx:PluginContext;following:boolean;resolve:(candidate:MethodCandidate)=>void;reject:(error:Error)=>void;promise:Promise<MethodCandidate>}
const now=()=>new Date().toISOString();
const alive=(pid:number)=>{try {process.kill(pid,0);return true;}catch{return false;}};
const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);
const builtins=[
  ['planner','规划','将目标拆成可验收成果，明确依赖、约束和未知项。先探索已有实现；不把提案写成用户决定。'],
  ['researcher','研究','优先一手来源和实际源码。保留来源、版本与证据范围；把推断与事实分开。'],
  ['implementer','实现','完成最小行为闭包，复用已有代码。保持接口清晰，以真实产物与针对性测试说明完成范围。'],
  ['reviewer','审查','独立核对需求与产物，优先可复现缺陷。不要把模型自评或测试文件存在当作通过。'],
  ['integrator','整合','核对基线和接口，串行整合成果，重新验证最终组合。冲突时保留成果并明确阻塞。'],
];
function user(ctx:PluginContext):void {if(ctx.origin!=='user')throw new Error('此管理操作必须由用户执行');}
function candidateKey(ctx:PluginContext,id:string):string {return `candidate:${ctx.projectId}:${id}`;}
function expertKey(scope:string,id:string):string {return scope==='builtin'?`expert:${id}`:`expert:${scope}:${id}`;}
function cleanStrings(input:unknown,name:string):string[] {if(!Array.isArray(input))throw new Error(`${name}必须是数组`);return [...new Set(input.map(item=>text(item,name,500)))];}
function frozenSkill(path:string,ctx:PluginContext):FrozenSkill {
  const root=realpathSync(ctx.projectDir);const file=realpathSync(resolve(ctx.projectDir,path));const rel=relative(root,file);
  if(isAbsolute(rel)||rel.startsWith('..')||!file.toLowerCase().endsWith('.md'))throw new Error('Skill 必须是当前项目内的 Markdown 文件');
  const stat=statSync(file);if(!stat.isFile()||stat.size>65536)throw new Error('Skill 不是普通 Markdown 或超过 64 KiB');
  const content=readFileSync(file,'utf8');return {path:file,content,hash:digest(content)};
}
function frozenBody(expert:FrozenExpert):string {return `${expert.title} v${expert.version}\n${expert.prompt}${expert.skillContents.map(skill=>`\n\nSkill ${skill.path} (${skill.hash})\n${skill.content}`).join('')}`;}
function rolePrompt(role:FrozenRole):string {return `角色 ${role.id} v${role.version}（${role.title}）\n${role.responsibility}\n有效工具：${role.effectiveTools.join(', ')||'无'}\n有效写入范围：${role.effectiveWriteScopes.join(', ')||'无'}\n交付合同：${JSON.stringify(role.delivery)}\n这是角色快照；仅在宿主核验安全阶段后成功的 friend_expert role.switch 才能以返回的新合同替代当前职责与角色范围，已采用方法的范围限制继续有效。角色不增加父任务权限；同一 Agent 切换角色不构成独立审核。方法不得更改模型或角色合同。`;}
export function blockedByFrozenScope(frozen:FrozenRun|undefined,toolName:string,args?:unknown,projectDir?:string):boolean {return blockedByFrozenRole(frozen?.role,toolName,args,projectDir)||!!frozen?.toolScope && toolName!=='friend_expert' && !frozen.toolScope.includes(toolName);}
/** An empty expert tools list means no additional restriction, never a grant. */
export function adoptedToolScope(experts:readonly FrozenExpert[],ids:readonly string[],previous?:readonly string[]):string[]|undefined {
  const scopes=experts.filter(expert=>ids.includes(expert.id)).map(expert=>expert.tools).filter(tools=>tools.length);
  if(previous)scopes.unshift([...previous]);
  return scopes.length?[...new Set(scopes[0])].filter(tool=>scopes.every(scope=>scope.includes(tool))):undefined;
}

export class ExpertController {
  readonly store:RecordStore;
  private readonly runtime=randomUUID();
  private readonly jobs=new Map<string,ValidationJob>();
  private queue:string[]=[];
  private draining=false;
  private closed=false;
  private timer?:ReturnType<typeof setTimeout>;
  private active?:{key:string;abort:AbortController};
  constructor(dataDir?:string) {
    this.store=new RecordStore('expert',dataDir);
    this.store.transaction(()=>{for(const [id,title,prompt] of builtins){const key=`expert:${id}`;const saved=this.store.get<ExpertDefinition>(key);if(saved&&saved.value.scope!=='builtin'){this.store.put(expertKey(saved.value.scope,id),saved.value);this.store.remove(key);}if(!this.store.get(key))this.store.put(key,{id,version:1,title,scope:'builtin',prompt,tools:[],skills:[],enabled:true,hash:digest({prompt,tools:[],skills:[]}),createdAt:now()} satisfies ExpertDefinition,null);}});
    this.store.transaction(()=>{for(const role of builtinRoles){const key=`role:builtin:${role.id}`;if(!this.store.get(key))this.store.put(key,roleDefinition({...role},{id:role.id,version:1,scope:'builtin'}),null);}});
    for(const row of this.store.list<MethodCandidate>('candidate:'))if(row.value.status==='validating'&&(!row.value.validation||!alive(row.value.validation.ownerPid)))this.store.put(row.key,{...row.value,status:'candidate',error:'验证进程已结束；未发布，待重新验证',validation:undefined},row.revision);
    const lease=this.store.get<{pid:number}>('validation:lease');if(lease&&!alive(lease.value.pid))this.store.remove(lease.key);
  }
  definitions(ctx?:PluginContext) {
    const rows=this.store.list<ExpertDefinition>('expert:').map(row=>({...row.value,revision:row.revision}));
    if(!ctx)return rows;
    const visible=new Map(rows.filter(item=>item.scope==='builtin').map(item=>[item.id,item]));
    for(const item of rows)if(item.scope===ctx.projectId)visible.set(item.id,item);return [...visible.values()];
  }
  roleDefinitions(ctx:PluginContext) {
    const rows=this.store.list<RoleDefinition>('role:').map(row=>({...row.value,revision:row.revision}));
    const visible=new Map(rows.filter(role=>role.scope==='builtin').map(role=>[role.id,role]));
    for(const role of rows)if(role.scope===ctx.projectId)visible.set(role.id,role);return [...visible.values()];
  }
  private roleSelection(ctx:PluginContext) {return this.store.get<{id:string;methodIds?:string[]}>(`role-selection:${ctx.projectId}:${ctx.sessionId}`)?.value;}
  private policy(ctx:PluginContext):RoleCapability|undefined {return (ctx as PluginContext&{policy?:RoleCapability}).policy;}
  private freezeDefinition(definition:RoleDefinition,ctx:PluginContext):FrozenRole {
    const modelId=definition.modelId||ctx.modelId,thinkingLevel=definition.thinkingLevel||ctx.thinkingLevel;
    const available=(ctx as PluginContext&{availableModels?:{id:string;thinkingLevels?:string[]}[]}).availableModels;
    if(definition.modelId){const model=available?.find(model=>model.id===definition.modelId);if(!model)throw new Error('角色指定模型不在宿主公布的可用模型中');if(thinkingLevel&&model.thinkingLevels&&!model.thinkingLevels.includes(thinkingLevel))throw new Error('角色指定思考等级不适用于该模型');}
    return freezeRole(definition,{...this.policy(ctx),modelId,thinkingLevel});
  }
  private safeRolePhase(input:JsonObject,ctx:PluginContext,run?:FrozenRun):RoleCapability {
    const policy=this.policy(ctx);
    if(!policy||policy.v!==1||!Number.isSafeInteger(policy.revision)||!policy.stage||policy.canSwitchRole!==true||policy.unsettledTools!==0)throw new Error('宿主尚未确认角色切换的安全阶段，未收敛工具必须先结束');
    if(input.stage!==policy.stage||input.policyRevision!==policy.revision)throw new Error('角色切换阶段或宿主策略版本已变化');
    if(run&&(!run.runId||input.runId!==run.runId||ctx.runId&&ctx.runId!==run.runId||policy.runId&&policy.runId!==run.runId))throw new Error('角色切换执行身份已变化');
    return policy;
  }
  private async dispatchRole(action:string,input:JsonObject,ctx:PluginContext):Promise<unknown> {
    if(action==='role.snapshot'){const run=this.store.get<FrozenRun>(`run:${ctx.sessionId}`)?.value,policy=this.policy(ctx);return {roles:this.roleDefinitions(ctx),selection:this.roleSelection(ctx),current:run?.role,phase:policy?{v:policy.v,policyRevision:policy.revision,stage:policy.stage,runId:run?.runId,canSwitchRole:policy.canSwitchRole,unsettledTools:policy.unsettledTools}:undefined};}
    if(action==='role.read'){
      const run=this.store.get<FrozenRun>(`run:${ctx.sessionId}`)?.value;
      if(input.id===undefined)return {role:run?.role,roles:run?.roles||this.roleDefinitions(ctx)};
      const role=(run?.roles||this.roleDefinitions(ctx)).find(role=>role.id===text(input.id,'角色标识'));if(!role)throw new Error('角色不存在');return role;
    }
    if(action==='role.versions')return this.store.list<RoleDefinition>(`role-version:${ctx.projectId}:${text(input.id)}:`).map(row=>row.value);
    if(action==='role.create'||action==='role.update'){
      user(ctx);
      const definition=this.store.transaction(()=>{
        const id=action==='role.create'?randomUUID():text(input.id,'角色标识');
        const previous=action==='role.update'?this.store.get<RoleDefinition>(`role:${ctx.projectId}:${id}`)||this.store.get<RoleDefinition>(`role:builtin:${id}`):undefined;
        if(action==='role.update'&&(!previous||!Number.isSafeInteger(input.revision)||previous.revision!==input.revision))throw new Error('角色版本已变化，请刷新后重试');
        const definition=roleDefinition(input,{id,version:(previous?.value.version||0)+1,scope:ctx.projectId});
        if(id==='reviewer'&&(definition.writeScopes.length||definition.tools.some(tool=>!builtinRoles.find(role=>role.id==='reviewer')!.tools.includes(tool))))throw new Error('内建 reviewer 必须保持硬只读合同');
        if(definition.modelId)this.freezeDefinition(definition,ctx);
        if(previous){const key=`role-version:${ctx.projectId}:${id}:${previous.value.version}`;if(!this.store.get(key))this.store.put(key,previous.value,null);}
        const key=`role:${ctx.projectId}:${id}`,local=this.store.get<RoleDefinition>(key);let saved=this.store.put(key,definition,local?.revision??null);
        while(previous&&saved.revision<=previous.revision)saved=this.store.put(key,definition,saved.revision);
        return {...definition,revision:saved.revision};
      });
      this.changed(ctx);return definition;
    }
    if(action==='role.assign'){
      const run=this.store.get<FrozenRun>(`run:${ctx.sessionId}`)?.value;
      if(ctx.origin!=='user'||!ctx.isIdle())this.safeRolePhase(input,ctx,run);
      const id=text(input.id,'角色标识'),definition=this.roleDefinitions(ctx).find(role=>role.id===id&&role.enabled);if(!definition)throw new Error('角色已停用或范围不匹配');
      const role=this.freezeDefinition(definition,ctx);
      const methodIds=input.methodIds===undefined?undefined:cleanStrings(input.methodIds,'方法标识');
      if(methodIds)for(const methodId of methodIds)if(!this.definitions(ctx).some(method=>method.id===methodId&&method.enabled))throw new Error('方法已停用或范围不匹配');
      this.store.put(`role-selection:${ctx.projectId}:${ctx.sessionId}`,{id,...(methodIds?{methodIds}:{})});
      this.changed(ctx);return {role,methodIds,nextRun:true};
    }
    if(action==='role.switch'){
      const row=this.store.get<FrozenRun>(`run:${ctx.sessionId}`);if(!row?.value.runId)throw new Error('尚无本轮执行，先分配下一轮角色');
      this.safeRolePhase(input,ctx,row.value);
      const id=text(input.id,'角色标识'),definition=row.value.roles?.find(role=>role.id===id&&role.enabled);if(!definition)throw new Error('角色不在本轮冻结目录中');
      const role=this.freezeDefinition(definition,ctx);
      const receipt={v:1,runId:row.value.runId,sessionId:ctx.sessionId,kind:'switch',from:row.value.role?.id,role,actualModelId:ctx.modelId,actualThinkingLevel:ctx.thinkingLevel,modelChangeRequired:role.modelId!==ctx.modelId||role.thinkingLevel!==ctx.thinkingLevel,independent:false,at:now()};
      if(ctx.applyModel&&(role.modelId!==ctx.modelId||role.thinkingLevel!==ctx.thinkingLevel)){const target=role.modelId||ctx.modelId;if(!target)throw new Error('角色型号不可用');await ctx.applyModel(target,role.thinkingLevel);this.safeRolePhase(input,ctx,row.value);if(this.store.get<FrozenRun>(row.key)?.revision!==row.revision)throw new Error('角色版本已变化');}
      // Journal before granting a potentially wider role; failure leaves the prior guard intact.
      ctx.appendEntry('friend-pi.expert.role',{...receipt,status:'requested'});
      this.store.put(row.key,{...row.value,role,prompt:`${rolePrompt(role)}\n\n${row.value.experts.filter(method=>(row.value.adoptedIds||row.value.selectedIds).includes(method.id)).map(frozenBody).join('\n\n')}`},row.revision);
      ctx.emit('expert.role.changed',receipt);this.changed(ctx);
      return {...receipt,prompt:rolePrompt(role),methodToolScope:row.value.toolScope};
    }
    throw new Error(`未知 Expert 角色操作：${action}`);
  }
  private settings(ctx:PluginContext):{paused:boolean} {return this.store.get<{paused:boolean}>(`settings:${ctx.projectId}`)?.value||{paused:false};}
  snapshot(ctx:PluginContext) {return {experts:this.definitions(ctx),roles:this.roleDefinitions(ctx),roleSelection:this.roleSelection(ctx),selection:this.store.get<{ids:string[]}>(`selection:${ctx.projectId}`)?.value.ids||[],candidates:this.store.list<MethodCandidate>(`candidate:${ctx.projectId}:`).map(row=>({...row.value,revision:row.revision})),suites:this.store.list<ValidationCase[]>(`suite:${ctx.projectId}:`).map(row=>({id:row.key.split(':').at(-1),cases:row.value,revision:row.revision})),adoptions:this.store.get(`run:${ctx.sessionId}`)?.value,validation:{...this.settings(ctx),running:!!this.active,queued:this.queue.filter(key=>key.startsWith(`candidate:${ctx.projectId}:`)).length}};}
  private changed(ctx:PluginContext):void {if(!this.closed)try{ctx.emit('expert.changed',this.snapshot(ctx));}catch{/* A refresh notification cannot invalidate a persisted method or adoption. */}}
  freeze(input:JsonObject,ctx:PluginContext):FrozenRun {
    if(this.closed)throw new Error('Expert 已关闭');
    const all=this.definitions(ctx);const selected=this.store.get<{ids:string[]}>(`selection:${ctx.projectId}`)?.value.ids||[];
    const roleSelection=this.roleSelection(ctx);
    const chosen=input.methodIds!==undefined?cleanStrings(input.methodIds,'方法标识'):input.expertId?[text(input.expertId)]:roleSelection?.methodIds??selected.filter(id=>all.some(expert=>expert.id===id&&expert.enabled));
    const enabled=all.filter(expert=>expert.enabled);const picked=chosen.map(id=>{const expert=enabled.find(item=>item.id===id);if(!expert)throw new Error('专家已停用或范围不匹配');return expert;});const list=input.catalog===true?enabled:chosen.length?picked:enabled;
    const experts:FrozenExpert[]=list.map(({revision:_revision,...expert})=>({...expert,tools:[...expert.tools],skills:[...expert.skills],skillContents:expert.skills.map(path=>frozenSkill(path,ctx))}));
    const restrictions=chosen.length?experts.filter(expert=>chosen.includes(expert.id)).map(expert=>expert.tools).filter(tools=>tools.length):[];
    const toolScope=restrictions.length?restrictions[0].filter(tool=>restrictions.every(scope=>scope.includes(tool))):undefined;
    let prompt=chosen.length?experts.filter(expert=>chosen.includes(expert.id)).map(frozenBody).join('\n\n'):`可用专家方法（按需使用 friend_expert use，不是强制流程）：\n${experts.map(expert=>`${expert.id}: ${expert.title} — ${expert.prompt}`).join('\n')}`;
    const roles=this.roleDefinitions(ctx).filter(role=>role.enabled).map(({revision:_revision,...role})=>role);
    const roleId=input.roleId!==undefined?text(input.roleId,'角色标识'):roleSelection?.id;
    const definition=roleId?roles.find(role=>role.id===roleId):undefined;
    if(roleId&&!definition)throw new Error('角色已停用或范围不匹配');
    const role=definition?this.freezeDefinition(definition,ctx):undefined;
    if(role)prompt=`${rolePrompt(role)}\n\n${prompt}`;
    return {id:chosen.join('+')||'auto',version:Math.max(1,...experts.map(expert=>expert.version)),prompt,toolScope,skillPaths:[],experts,methods:structuredClone(experts),roles:structuredClone(roles),...(role?{role}:{}),hash:digest({experts,roles,role}),selectionMode:chosen.length?'explicit':'auto',selectedIds:[...chosen],adoptedIds:[...chosen]};
  }
  validateDelivery(ctx:PluginContext){const run=this.store.get<FrozenRun>(`run:${ctx.sessionId}`)?.value;if(!run?.role)return;const source=ctx.history().filter(item=>item.role==='assistant').at(-1);let approved=false,error:string|undefined;try{assertRoleDelivery(run.role,parseModelJson(source?.text||''));approved=true;}catch(cause){error=errorText(cause);}const receipt={v:1,runId:run.runId,roleId:run.role.id,roleVersion:run.role.version,approved,error,source:source?{sessionId:ctx.sessionId,entryId:source.id,hash:digest(source.text)}:undefined};ctx.appendEntry('friend-pi.expert.delivery',receipt);ctx.emit('expert.role.delivery',receipt);if(error)ctx.notify(`角色交付未通过：${error}`,'error');return receipt;}
  beginRun(ctx:PluginContext):FrozenRun&{runId:string} {
    const prior=this.store.get<FrozenRun>(`run:${ctx.sessionId}`)?.value;if(ctx.runId&&ctx.policy?.runId===ctx.runId&&prior?.runId===ctx.runId){const role=prior.role?{...prior.role,...(prior.role.modelSource==='inherited'?{modelId:ctx.modelId}:{}),...(prior.role.thinkingSource==='inherited'?{thinkingLevel:ctx.thinkingLevel}:{})}:undefined;const snapshot={...prior,role,runId:ctx.runId,modelId:ctx.modelId,thinkingLevel:ctx.thinkingLevel};this.store.put(`run:${ctx.sessionId}`,snapshot);ctx.appendEntry('friend-pi.expert.continuation',{v:1,runId:ctx.runId,hash:prior.hash,roleId:role?.id,modelId:ctx.modelId,thinkingLevel:ctx.thinkingLevel});return snapshot;}
    const snapshot={...this.freeze({},ctx),runId:ctx.runId||randomUUID(),modelId:ctx.modelId,thinkingLevel:ctx.thinkingLevel,adoptions:[] as unknown[]};
    // Native Pi history preserves each actual execution snapshot. The mutable SQLite pointer
    // is only the current tool-scope/adoption lookup; it never replaces earlier evidence.
    ctx.appendEntry('friend-pi.expert.run',{v:1,runId:snapshot.runId,sessionId:ctx.sessionId,modelId:ctx.modelId,thinkingLevel:ctx.thinkingLevel,frozen:snapshot,at:now()});
    if(snapshot.selectionMode==='explicit')for(const expert of snapshot.experts){const receipt=this.adoption(expert,snapshot,ctx,'selected');snapshot.adoptions.push(receipt);ctx.appendEntry('friend-pi.expert.adoption',receipt);}
    if(snapshot.role)ctx.appendEntry('friend-pi.expert.role',{v:1,runId:snapshot.runId,sessionId:ctx.sessionId,kind:'assigned',role:snapshot.role,actualModelId:ctx.modelId,actualThinkingLevel:ctx.thinkingLevel,at:now()});
    this.store.put(`run:${ctx.sessionId}`,snapshot);return snapshot;
  }
  private adoption(expert:FrozenExpert,run:FrozenRun&{runId:string},ctx:PluginContext,mode:'selected'|'use') {
    return {v:1,runId:run.runId,mode,id:expert.id,version:expert.version,hash:expert.hash,snapshotHash:run.hash,modelId:run.modelId,thinkingLevel:run.thinkingLevel,skills:expert.skillContents.map(({path,hash})=>({path,hash})),at:now()};
  }
  private definition(id:string,ctx:PluginContext) {const local=this.store.get<ExpertDefinition>(expertKey(ctx.projectId,id));return local||this.store.get<ExpertDefinition>(expertKey('builtin',id));}
  private archive(definition:ExpertDefinition,projectId:string):void {const key=`version:${projectId}:${definition.id}:${definition.version}`;if(!this.store.get(key))this.store.put(key,definition,null);}
  private updateDefinition(id:string,input:JsonObject,ctx:PluginContext,action:'update'|'toggle'|'rollback'):ExpertDefinition {
    return this.store.transaction(()=>{
      const previous=this.definition(id,ctx);if(!previous)throw new Error('专家不存在');if(previous.revision!==Number(input.revision))throw new Error('版本已变化，请刷新后重试');
      const restored=action==='rollback'?this.store.get<ExpertDefinition>(`version:${ctx.projectId}:${id}:${Number(input.version)}`)?.value:undefined;if(action==='rollback'&&!restored)throw new Error('版本不存在');
      const body=restored||previous.value;const prompt=action==='update'?text(input.prompt,'专业方法',32000):body.prompt;const tools=action==='update'?cleanStrings(input.tools||[],'工具'):body.tools;const skills=action==='update'?cleanStrings(input.skills||[],'Skill'):body.skills;skills.forEach(path=>frozenSkill(path,ctx));
      const definition:ExpertDefinition={...body,id,version:previous.value.version+1,title:action==='update'?text(input.title,'名称',120):body.title,scope:ctx.projectId,prompt,tools,skills,enabled:action==='toggle'?input.enabled===true:true,hash:digest({prompt,tools,skills}),createdAt:now()};
      this.archive(previous.value,ctx.projectId);const key=expertKey(ctx.projectId,id);const local=this.store.get(key);let row=this.store.put(key,definition,local?.revision??null);while(row.revision<=previous.revision)row=this.store.put(key,definition,row.revision);return definition;
    });
  }
  async dispatch(action:string,input:JsonObject,ctx:PluginContext):Promise<unknown> {
    if(this.closed)throw new Error('Expert 已关闭');
    if(action.startsWith('role.'))return this.dispatchRole(action,input,ctx);
    if(action==='list'||action==='snapshot')return this.snapshot(ctx);
    if(action==='freeze'){const frozen=this.freeze(input,ctx);if(input.catalog===true)this.store.put(`catalog:${ctx.projectId}:${frozen.hash}`,frozen);return frozen;}
    if(action==='freeze.role'){
      const hash=text(input.catalogHash),catalog=this.store.get<FrozenRun>(`catalog:${ctx.projectId}:${hash}`)?.value;
      if(!catalog||catalog.hash!==hash)throw new Error('角色冻结目录不存在或不属于当前项目');
      const definition=catalog.roles?.find(role=>role.id===text(input.roleId)&&role.enabled);if(!definition)throw new Error('角色不在本次冻结目录中');
      const raw=input.capability===undefined?{}:object(input.capability),parent=this.policy(ctx);
      const requestedTools=raw.tools===undefined?undefined:cleanStrings(raw.tools,'成员工具范围');
      const tools=requestedTools?.filter(tool=>!parent?.tools||parent.tools.includes(tool))??parent?.tools;
      const writeScopes=raw.writeScopes===undefined?parent?.writeScopes:intersectWriteScopes(normalizeWriteScopes(raw.writeScopes),parent?.writeScopes??['.']);
      const context={...ctx,modelId:raw.modelId===undefined?ctx.modelId:text(raw.modelId,'成员模型'),thinkingLevel:raw.thinkingLevel===undefined?ctx.thinkingLevel:text(raw.thinkingLevel,'成员思考等级')};
      const frozen=this.freezeDefinition(definition,context);
      return freezeRole(frozen,{...parent,tools,writeScopes,modelId:frozen.modelId,thinkingLevel:frozen.thinkingLevel});
    }
    if(action==='adopt.frozen'){
      const hash=text(input.catalogHash);const catalog=this.store.get<FrozenRun>(`catalog:${ctx.projectId}:${hash}`)?.value;
      if(!catalog||catalog.hash!==hash)throw new Error('成员冻结目录不存在或不属于当前项目');
      const expert=catalog.experts.find(item=>item.id===text(input.id));if(!expert)throw new Error('专家不在本次成员冻结目录中');
      if(expert.candidateId&&this.store.get<MethodCandidate>(candidateKey(ctx,expert.candidateId))?.value.status==='withdrawn')throw new Error('来源已撤回，不能再采用派生方法');
      return {...expert,prompt:frozenBody(expert),adoption:{v:1,id:expert.id,version:expert.version,hash:expert.hash,snapshotHash:catalog.hash,mode:'use',skills:expert.skillContents.map(({path,hash})=>({path,hash})),at:now()}};
    }
    if(['select','create','update','toggle','rollback','validation.suite','settings','candidate.withdraw'].includes(action))user(ctx);
    if(action==='select'){const ids=cleanStrings(input.ids||[],'专家标识');for(const id of ids)this.freeze({expertId:id},ctx);this.store.put(`selection:${ctx.projectId}`,{ids});return this.snapshot(ctx);}
    if(action==='settings'){if(typeof input.paused!=='boolean')throw new Error('paused 必须是布尔值');this.store.put(`settings:${ctx.projectId}`,{paused:input.paused});if(input.paused)this.interrupt(ctx.projectId);else this.kick();return this.snapshot(ctx);}
    if(action==='use'){
      const id=text(input.id);const result=this.store.transaction(()=>{
        const row=this.store.get<FrozenRun>(`run:${ctx.sessionId}`);const frozen=row?.value;
        if(!frozen?.runId)throw new Error('当前会话尚无实际执行身份，请先启动任务');
        if(typeof input.runId==='string'&&input.runId!==frozen.runId)throw new Error('执行身份已变化，不能采用旧运行的方法');
        const expert=frozen.experts.find(item=>item.id===id);if(!expert)throw new Error('当前执行未冻结该专家');
        if(expert.candidateId&&this.store.get<MethodCandidate>(candidateKey(ctx,expert.candidateId))?.value.status==='withdrawn')throw new Error('来源已撤回，不能再采用派生方法');
        const existing=(frozen.adoptions||[]).find(raw=>raw&&typeof raw==='object'&&'id' in raw&&raw.id===id&&'mode' in raw&&raw.mode==='use');
        if(existing&&object(existing).journalStatus==='failed')throw new Error('上次采用的原生记录保存失败；范围保持收紧，请开始新运行后再采用');
        const adoptedIds=[...new Set([...(frozen.adoptedIds||frozen.selectedIds),id])];
        const adoption=existing||{...this.adoption(expert,frozen as FrozenRun&{runId:string},ctx,'use'),journalStatus:'pending'};
        const effective={...frozen,adoptedIds,toolScope:adoptedToolScope(frozen.experts,adoptedIds,frozen.toolScope),adoptions:existing?frozen.adoptions:[...(frozen.adoptions||[]),adoption]};
        this.store.put(row!.key,effective,row!.revision);
        return {...expert,prompt:frozenBody(expert),adoption:object(adoption),toolScope:effective.toolScope,runId:frozen.runId,needsJournal:!existing};
      });
      if(result.needsJournal){
        const receipt={...result.adoption,journalStatus:'written'};let failure:unknown;
        try{ctx.appendEntry('friend-pi.expert.adoption',receipt);}catch(error){receipt.journalStatus='failed';failure=error;}
        this.store.transaction(()=>{const row=this.store.get<FrozenRun>(`run:${ctx.sessionId}`);if(row?.value.runId===result.runId)this.store.put(row.key,{...row.value,adoptions:row.value.adoptions?.map(raw=>raw&&typeof raw==='object'&&'id' in raw&&raw.id===id&&'mode' in raw&&raw.mode==='use'?receipt:raw)},row.revision);});result.adoption=receipt;
        this.changed(ctx);if(failure)throw new Error(`采用记录未能保存，方法未返回；工具范围保持收紧：${errorText(failure)}`);
      }else this.changed(ctx);
      const {needsJournal:_needsJournal,...response}=result;return response;
    }
    if(action==='create'){
      const id=randomUUID();const prompt=text(input.prompt,'专业方法',32000);const tools=cleanStrings(input.tools||[],'工具');const skills=cleanStrings(input.skills||[],'Skill');skills.forEach(path=>frozenSkill(path,ctx));
      const definition:ExpertDefinition={id,version:1,title:text(input.title,'名称',120),scope:ctx.projectId,prompt,tools,skills,enabled:true,hash:digest({prompt,tools,skills}),createdAt:now()};const row=this.store.put(expertKey(ctx.projectId,id),definition,null);return {...definition,revision:row.revision};
    }
    if(action==='update'||action==='toggle'||action==='rollback'){const definition=this.updateDefinition(text(input.id),input,ctx,action);if(action==='update')return {...definition,revision:this.definition(definition.id,ctx)!.revision};return this.snapshot(ctx);}
    if(action==='versions'){const id=text(input.id);return this.store.list<ExpertDefinition>(`version:${ctx.projectId}:${id}:`).map(row=>row.value);}
    if(action==='candidate.submit'){
      if(ctx.origin!=='user'&&ctx.origin!=='plugin')throw new Error('模型不能用候选提交绕过用户管理；自动方法由有来源的 Memory 插件提交');
      const sources=Array.isArray(input.sources)?input.sources.map(raw=>{
        const source=object(raw);const ref:SourceRef={sessionId:text(source.sessionId),entryId:text(source.entryId)};
        for(const key of ['start','end'] as const)if(source[key]!==undefined){if(typeof source[key]!=='number'||!Number.isInteger(source[key])||Number(source[key])<0)throw new Error('方法来源片段范围无效');ref[key]=source[key] as number;}
        if(source.hash!==undefined)ref.hash=text(source.hash,'来源摘要',128);if(source.factId!==undefined)ref.factId=text(source.factId,'来源事实标识',180);
        ctx.readSource(ref);return ref;
      }):[];
      const sourceMemoryIds=cleanStrings(input.sourceMemoryIds||[],'父记忆');if(ctx.origin==='plugin'&&(!sourceMemoryIds.length||!sources.length))throw new Error('自动候选需要可回查的来源与父记忆');
      const sourceDigest=digest({title:input.title,method:input.method,scope:ctx.projectId,sourceMemoryIds,sources});const idempotencyKey=input.idempotencyKey?`delivery:${ctx.projectId}:${text(input.idempotencyKey)}`:undefined;
      if(idempotencyKey){const existing=this.store.get<{id:string;sourceDigest:string}>(idempotencyKey);if(existing){if(existing.value.sourceDigest!==sourceDigest)throw new Error('同一幂等标识对应的方法或来源已变化');return this.store.get<MethodCandidate>(candidateKey(ctx,existing.value.id))!.value;}}
      const candidate:MethodCandidate={id:randomUUID(),title:text(input.title,'名称',120),method:text(input.method,'方法',32000),scope:ctx.projectId,sourceMemoryIds,sources,status:'candidate',checks:[]};
      const created=this.store.transaction(()=>{if(idempotencyKey){const existing=this.store.get<{id:string;sourceDigest:string}>(idempotencyKey);if(existing){if(existing.value.sourceDigest!==sourceDigest)throw new Error('同一幂等标识对应的方法或来源已变化');return this.store.get<MethodCandidate>(candidateKey(ctx,existing.value.id))!.value;}}this.store.put(candidateKey(ctx,candidate.id),candidate,null);if(idempotencyKey)this.store.put(idempotencyKey,{id:candidate.id,sourceDigest},null);return candidate;});
      if(created.id!==candidate.id)return created;
      if(this.store.get(`suite:${ctx.projectId}:${ctx.projectId}`))void this.enqueue(candidate.id,ctx).catch(error=>{if(!this.closed)ctx.notify(errorText(error),'warning');});return candidate;
    }
    if(action==='validation.suite'){
      if(!Array.isArray(input.cases))throw new Error('请提供验证用例');
      const cases:ValidationCase[]=input.cases.map(raw=>{const item=object(raw);if(item.expected===undefined)throw new Error('预期 JSON 必须明确提供');return {id:text(item.id),kind:item.kind==='negative'?'negative':'positive',input:text(item.input),expected:item.expected,scope:ctx.projectId};});
      if(new Set(cases.map(item=>item.id)).size!==cases.length||new Set(cases.map(item=>item.input)).size!==cases.length||cases.filter(item=>item.kind==='positive').length<2||cases.filter(item=>item.kind==='negative').length<1)throw new Error('需要两个独立适用案例与一个范围外反例');
      this.store.put(`suite:${ctx.projectId}:${ctx.projectId}`,cases);for(const row of this.store.list<MethodCandidate>(`candidate:${ctx.projectId}:`))if(row.value.status==='candidate')void this.enqueue(row.value.id,ctx).catch(()=>{});return this.snapshot(ctx);
    }
    if(action==='validation.run')return this.enqueue(text(input.id),ctx);
    if(action==='candidate.withdraw'){this.withdraw(candidateKey(ctx,text(input.id)),ctx);return this.snapshot(ctx);}
    if(action==='invalidate'){
      if(ctx.origin!=='plugin'&&ctx.origin!=='user')throw new Error('记忆失效必须来自用户或来源插件');const ids=cleanStrings(input.ids||[],'来源标识');this.invalidate(ids,ctx);return this.snapshot(ctx);
    }
    throw new Error(`未知 Expert 操作：${action}`);
  }
  private withdraw(key:string,ctx?:PluginContext):void {
    const row=this.store.get<MethodCandidate>(key);if(!row)throw new Error('候选不存在');
    this.store.transaction(()=>{
      const latest=this.store.get<MethodCandidate>(key)!;this.store.put(key,{...latest.value,status:'withdrawn',error:'来源或候选已撤回'},latest.revision);
      if(latest.value.publishedId){const expert=this.store.get<ExpertDefinition>(expertKey(latest.value.scope,latest.value.publishedId))||this.store.get<ExpertDefinition>(`expert:${latest.value.publishedId}`);if(expert){this.archive(expert.value,latest.value.scope);this.store.put(expert.key,{...expert.value,enabled:false,version:expert.value.version+1,createdAt:now()},expert.revision);}}
    });
    if(this.active?.key===key)this.active.abort.abort();const job=this.jobs.get(key);if(job){job.reject(new Error('候选已撤回'));this.jobs.delete(key);this.queue=this.queue.filter(item=>item!==key);}if(ctx)this.changed(ctx);
  }
  invalidate(ids:string[],ctx?:PluginContext):void {if(this.closed)return;for(const row of this.store.list<MethodCandidate>('candidate:'))if((!ctx||row.value.scope===ctx.projectId)&&row.value.sourceMemoryIds.some(id=>ids.includes(id)))this.withdraw(row.key,ctx);}
  private enqueue(id:string,ctx:PluginContext):Promise<MethodCandidate> {
    const key=candidateKey(ctx,id);const existing=this.jobs.get(key);if(existing)return existing.promise;
    const row=this.store.get<MethodCandidate>(key);if(!row)return Promise.reject(new Error('候选不存在'));if(row.value.status==='withdrawn')return Promise.reject(new Error('候选已撤回'));if(row.value.status==='published')return Promise.resolve(row.value);
    if(!this.store.get(`suite:${ctx.projectId}:${row.value.scope}`))return Promise.reject(new Error('缺少用户定义的客观验证基准，候选保持待验证'));
    let resolveJob!:(candidate:MethodCandidate)=>void;let rejectJob!:(error:Error)=>void;const promise=new Promise<MethodCandidate>((resolveResult,reject)=>{resolveJob=resolveResult;rejectJob=reject;});
    const following=row.value.status==='validating'&&row.value.validation?.ownerRuntime!==this.runtime;
    this.jobs.set(key,{key,id,ctx,following,resolve:resolveJob,reject:rejectJob,promise});this.queue.push(key);if(!following)this.store.put(key,{...row.value,status:'queued',error:undefined},row.revision);this.kick();this.changed(ctx);return promise;
  }
  private kick():void {if(this.closed||this.draining)return;void this.drain();}
  private retrySoon():void {if(this.timer||this.closed||!this.queue.length)return;this.timer=setTimeout(()=>{this.timer=undefined;this.kick();},50);this.timer.unref();}
  interrupt(projectId?:string):void {if(this.active&&(!projectId||this.jobs.get(this.active.key)?.ctx.projectId===projectId))this.active.abort.abort();}
  resume(ctx:PluginContext):void {
    if(this.closed)return;
    for(const row of this.store.list<MethodCandidate>(`candidate:${ctx.projectId}:`))if(['candidate','queued'].includes(row.value.status)&&this.store.get(`suite:${ctx.projectId}:${row.value.scope}`))void this.enqueue(row.value.id,ctx).catch(error=>{if(!this.closed)ctx.notify(errorText(error),'warning');});
  }
  private lease():boolean {
    return this.store.transaction(()=>{const lease=this.store.get<{pid:number;runtime:string}>('validation:lease');if(lease&&lease.value.runtime!==this.runtime&&alive(lease.value.pid))return false;this.store.put('validation:lease',{pid:process.pid,runtime:this.runtime});return true;});
  }
  private releaseLease():void {if(this.store.get<{runtime:string}>('validation:lease')?.value.runtime===this.runtime)this.store.remove('validation:lease');}
  private async drain():Promise<void> {
    if(this.closed||this.draining)return;this.draining=true;
    try {
      while(!this.closed&&this.queue.length){
        const key=this.queue[0];const job=this.jobs.get(key);if(!job){this.queue.shift();continue;}
        const latest=this.store.get<MethodCandidate>(key);
        if(latest?.value.status==='published'){job.resolve(latest.value);this.jobs.delete(key);this.queue.shift();continue;}
        if(latest?.value.status==='withdrawn'||(job.following&&latest?.value.status==='failed')){job.reject(new Error(latest.value.error||'候选已撤回'));this.jobs.delete(key);this.queue.shift();continue;}
        if(this.settings(job.ctx).paused)break;if(!job.ctx.isIdle()||!this.lease()){this.retrySoon();break;}
        this.queue.shift();const abort=new AbortController();this.active={key,abort};
        try {const result=await this.validateNow(job,abort.signal);if(!this.closed)job.resolve(result);this.jobs.delete(key);}
        catch(error){
          if(this.closed)break;
          const current=this.store.get<MethodCandidate>(key);
          if(current?.value.status==='withdrawn'){job.reject(new Error('来源已撤回，验证作废'));this.jobs.delete(key);}
          else if(abort.signal.aborted||!job.ctx.isIdle()||this.settings(job.ctx).paused){if(current)this.store.put(key,{...current.value,status:'queued',validation:undefined},current.revision);this.queue.unshift(key);if(!this.settings(job.ctx).paused)this.retrySoon();break;}
          else {if(current)this.store.put(key,{...current.value,status:'failed',error:errorText(error),validation:undefined},current.revision);job.reject(new Error(errorText(error)));this.jobs.delete(key);}
        }finally {if(!this.closed){this.active=undefined;this.releaseLease();this.changed(job.ctx);}}
      }
    }finally {this.draining=false;}
  }
  private async validateNow(job:ValidationJob,signal:AbortSignal):Promise<MethodCandidate> {
    const saved=this.store.get<MethodCandidate>(job.key)!;const suite=this.store.get<ValidationCase[]>(`suite:${job.ctx.projectId}:${saved.value.scope}`)!;const suiteHash=digest(suite.value);
    const candidate:MethodCandidate={...saved.value,status:'validating',checks:[],validation:{ownerPid:process.pid,ownerRuntime:this.runtime,suiteHash,modelId:job.ctx.modelId,startedAt:now()}};this.store.put(job.key,candidate,saved.revision);this.changed(job.ctx);
    const ensure=()=>{if(this.closed||signal.aborted)throw new Error('验证已取消');if(!job.ctx.isIdle())throw new Error('前台优先，验证暂停');const current=this.store.get<MethodCandidate>(job.key);if(current?.value.status==='withdrawn')throw new Error('候选已撤回');if(digest(this.store.get<ValidationCase[]>(suite.key)?.value)!==suiteHash)throw new Error('客观验证基准已变化，需重新验证');for(const source of candidate.sources)job.ctx.readSource(source);return current!;};
    const equals=(value:string,expected:unknown)=>{try{return isDeepStrictEqual(JSON.parse(value.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'')),expected);}catch{return false;}};
    for(const example of suite.value){
      ensure();const task=`仅输出JSON。任务：${example.input}`;const baseline=await job.ctx.complete(task,{signal});ensure();const output=await job.ctx.complete(`专业方法：${candidate.method}\n仅在适用范围内使用，不适用时按基础规则处理。\n${task}`,{signal});const latest=ensure();
      candidate.checks.push({caseId:example.id,passed:equals(output,example.expected),baselinePassed:equals(baseline,example.expected),output});this.store.put(job.key,candidate,latest.revision);this.changed(job.ctx);
    }
    if(candidate.checks.some(check=>!check.passed))throw new Error('客观基准未全部通过');
    const published=this.store.transaction(()=>{const current=ensure();const definition:ExpertDefinition={id:`learned-${candidate.id}`,version:1,title:candidate.title,scope:candidate.scope,prompt:candidate.method,tools:[],skills:[],enabled:true,hash:digest({prompt:candidate.method,tools:[],skills:[]}),createdAt:now(),candidateId:candidate.id};this.store.put(expertKey(candidate.scope,definition.id),definition,null);candidate.status='published';candidate.publishedId=definition.id;candidate.evaluation={suiteHash,cases:suite.value,modelId:job.ctx.modelId,at:now()};candidate.validation=undefined;this.store.put(job.key,candidate,current.revision);return definition;});job.ctx.emit('expert.published',published);return candidate;
  }
  dispose():void {
    if(this.closed)return;this.closed=true;if(this.timer)clearTimeout(this.timer);this.active?.abort.abort();
    if(this.active){const current=this.store.get<MethodCandidate>(this.active.key);if(current&&current.value.status==='validating')this.store.put(current.key,{...current.value,status:'candidate',validation:undefined,error:'会话关闭，验证取消且未发布'},current.revision);}
    for(const job of this.jobs.values())job.reject(new Error('Expert 已关闭，验证取消'));this.jobs.clear();this.queue=[];this.releaseLease();this.store.close();
  }
}

const extension:ExtensionFactory=(pi:ExtensionAPI)=>{
  const controller=new ExpertController();registerPlugin(pi,'expert',controller,'Expert：专业方法、版本、选择、验证和限域发布');
  pi.on('session_start',(_event,ctx)=>controller.resume(makeContext(pi,ctx)));
  pi.on('before_agent_start',(event,ctx)=>{controller.interrupt();const context=makeContext(pi,ctx),frozen=controller.beginRun(context);try{assertRoleModel(frozen.role,context);}catch(error){ctx.abort();ctx.ui.notify(errorText(error),'error');}return {systemPrompt:`${event.systemPrompt}\n\n${frozen.prompt}\n专家身份不增加权限。新版本仅用于后续执行。`};});
  pi.on('tool_call',(event,ctx)=>{const frozen=controller.store.get<FrozenRun>(`run:${ctx.sessionManager.getSessionId()}`)?.value;try{assertRoleModel(frozen?.role,makeContext(pi,ctx));}catch(error){return {block:true,reason:errorText(error)};}if(blockedByFrozenScope(frozen,event.toolName,event.input,ctx.cwd))return {block:true,reason:'当前角色合同或方法冻结范围不包含该工具及路径'};});
  // Pi reports hook exceptions and continues; explicit public abort is required here.
  pi.on('before_provider_request',(_event,ctx)=>{const frozen=controller.store.get<FrozenRun>(`run:${ctx.sessionManager.getSessionId()}`)?.value;try{assertRoleModel(frozen?.role,makeContext(pi,ctx));}catch(error){ctx.abort();ctx.ui.notify(errorText(error),'error');}});
  pi.on('agent_settled',(_event,ctx)=>{controller.validateDelivery(makeContext(pi,ctx,'plugin'));});
  const off=pi.events.on('friend-pi:v1:event',raw=>{if(!raw||typeof raw!=='object')return;const event=object(raw);if(event.pluginEvent==='memory.invalidated'&&event.data&&typeof event.data==='object'){const data=object(event.data);if(Array.isArray(data.ids))controller.invalidate(data.ids.map(String));}});
  pi.on('session_shutdown',()=>off());
};
export default extension;
