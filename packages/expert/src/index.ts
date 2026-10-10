import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { RecordStore, registerPlugin, digest, text, object, makeContext, parseModelJson, acquireLearningLease, renewLearningLease, releaseLearningLease, learningHostAvailable, isDerivedCapabilityInput, visibleText, type PluginContext, type JsonObject, type SourceRef } from '@friend-pi/core';
import { builtinRoles, roleDefinition, freezeRole, blockedByFrozenRole, blockedByWriteScopes, assertRoleModel, assertRoleDelivery, intersectWriteScopes, normalizeWriteScopes, type RoleDefinition, type FrozenRole, type RoleCapability } from './roles.js';
import {SkillCatalog, integer, mutationOrigin, evidenceRefs, type FrozenSkillVersion} from './skills.js';
import {ExpertLearningService,peekExpertLearningJob,wakeExpertLearningJobs,type ExpertLearningJob} from './learning.js';
export {SkillCatalog,type SkillVersion,type SkillHead,type ExpertVersion,type FrozenAdoption,type EvidenceRef} from './skills.js';
export {peekExpertLearningJob,wakeExpertLearningJobs,type ExpertLearningJob} from './learning.js';
export { freezeRole, blockedByFrozenRole, assertRoleModel, assertRoleDelivery, intersectWriteScopes, type RoleDefinition, type FrozenRole, type RoleCapability, type RoleDeliveryContract } from './roles.js';

export interface ExpertDefinition { id:string; version:number; title:string; scope:string; prompt:string; tools:string[]; skills:string[]; enabled:boolean; hash:string; createdAt:string; candidateId?:string }
export interface FrozenSkill {path:string;content:string;hash:string}
export interface FrozenExpert extends ExpertDefinition {skillContents:FrozenSkill[];frozenSkills?:FrozenSkillVersion[]}
export interface FrozenRun {id:string;version:number;prompt:string;toolScope?:string[];effectiveWriteScopes?:string[];availableSkills?:FrozenSkillVersion[];skillPaths:string[];experts:FrozenExpert[];methods?:FrozenExpert[];roles?:RoleDefinition[];role?:FrozenRole;hash:string;runId?:string;modelId?:string;thinkingLevel?:string;selectionMode:'auto'|'explicit';selectedIds:string[];adoptedIds?:string[];adoptions?:unknown[]}
export interface ValidationCase {id:string;kind:'positive'|'negative';input:string;expected:unknown;scope:string}
export interface MethodCandidate {
  id:string;title:string;method:string;scope:string;sourceMemoryIds:string[];sources:SourceRef[];
  status:'candidate'|'queued'|'validating'|'failed'|'published'|'withdrawn'|'trial';
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
export function blockedByFrozenScope(frozen:FrozenRun|undefined,toolName:string,args?:unknown,projectDir?:string):boolean {return blockedByFrozenRole(frozen?.role,toolName,args,projectDir)||frozen?.effectiveWriteScopes!==undefined&&blockedByWriteScopes(frozen.effectiveWriteScopes,toolName,args,projectDir)||!!frozen?.toolScope && toolName!=='friend_expert' && !frozen.toolScope.includes(toolName);}
/** An empty expert tools list means no additional restriction, never a grant. */
export function adoptedToolScope(experts:readonly FrozenExpert[],ids:readonly string[],previous?:readonly string[]):string[]|undefined {
  const scopes=experts.filter(expert=>ids.includes(expert.id)).map(expert=>expert.tools).filter(tools=>tools.length);
  if(previous)scopes.unshift([...previous]);
  return scopes.length?[...new Set(scopes[0])].filter(tool=>scopes.every(scope=>scope.includes(tool))):undefined;
}

export class ExpertController {
  readonly store:RecordStore;
  readonly skillCatalog:SkillCatalog;
  readonly learning:ExpertLearningService;
  private readonly runtime=randomUUID();
  private readonly jobs=new Map<string,ValidationJob>();
  private queue:string[]=[];
  private draining=false;
  private closed=false;
  private timer?:ReturnType<typeof setTimeout>;
  private active?:{key:string;abort:AbortController};
  private nativeContext?:PluginContext;
  private nativeTimer?:ReturnType<typeof setTimeout>;
  private nativeRunning?:Promise<unknown>;
  private nativeAbort?:AbortController;
  private readonly preparedReceipts=new Map<string,import('@friend-pi/core').EvidenceReceipt[]>();
  constructor(dataDir?:string) {
    this.store=new RecordStore('expert',dataDir);
    this.store.transaction(()=>{for(const [id,title,prompt] of builtins){const key=`expert:${id}`;const saved=this.store.get<ExpertDefinition>(key);if(saved&&saved.value.scope!=='builtin'){this.store.put(expertKey(saved.value.scope,id),saved.value);this.store.remove(key);}if(!this.store.get(key))this.store.put(key,{id,version:1,title,scope:'builtin',prompt,tools:[],skills:[],enabled:true,hash:digest({prompt,tools:[],skills:[]}),createdAt:now()} satisfies ExpertDefinition,null);}});
    this.store.transaction(()=>{for(const role of builtinRoles){
      const key=`role:builtin:${role.id}`,saved=this.store.get<RoleDefinition>(key);
      if(!saved)this.store.put(key,roleDefinition({...role},{id:role.id,version:1,scope:'builtin'}),null);
      else if(saved.value.scope==='builtin'&&!saved.value.tools.includes('friend_todo'))this.store.put(key,roleDefinition({...saved.value,tools:[...saved.value.tools,'friend_todo']},{id:role.id,version:saved.value.version+1,scope:'builtin'}),saved.revision);
    }});
    for(const row of this.store.list<MethodCandidate>('candidate:'))if(row.value.status==='validating'&&(!row.value.validation||!alive(row.value.validation.ownerPid)))this.store.put(row.key,{...row.value,status:'candidate',error:'验证进程已结束；未发布，待重新验证',validation:undefined},row.revision);
    const lease=this.store.get<{pid:number}>('validation:lease');if(lease&&!alive(lease.value.pid))this.store.remove(lease.key);
    this.skillCatalog=new SkillCatalog(this.store);
    this.learning=new ExpertLearningService(this.store,this.skillCatalog);
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
  private migrate(ctx:PluginContext){for(const definition of this.definitions(ctx))this.skillCatalog.policy.publishDependency({capability:'expert',id:definition.id,projectId:definition.scope==='builtin'?'builtin':ctx.projectId,version:definition.version,hash:definition.hash,valid:definition.enabled});this.skillCatalog.migrate(this.definitions(ctx),this.store.list<MethodCandidate>(`candidate:${ctx.projectId}:`).map(row=>row.value),ctx);}
  snapshot(ctx:PluginContext) {this.migrate(ctx);return {projection:this.skillCatalog.projection(ctx),...this.skillCatalog.snapshot(ctx),learning:this.learning.snapshot(ctx),experts:this.definitions(ctx),roles:this.roleDefinitions(ctx),roleSelection:this.roleSelection(ctx),selection:this.store.get<{ids:string[]}>(`selection:${ctx.projectId}`)?.value.ids||[],candidates:this.store.list<MethodCandidate>(`candidate:${ctx.projectId}:`).map(row=>({...row.value,revision:row.revision})),suites:this.store.list<ValidationCase[]>(`suite:${ctx.projectId}:`).map(row=>({id:row.key.split(':').at(-1),cases:row.value,revision:row.revision})),adoptions:this.store.get(`run:${ctx.sessionId}`)?.value,validation:{...this.settings(ctx),running:!!this.active,queued:this.queue.filter(key=>key.startsWith(`candidate:${ctx.projectId}:`)).length}};}
  private changed(ctx:PluginContext):void {this.store.afterCommit(()=>{if(!this.closed)try{ctx.emit('expert.changed',this.snapshot(ctx));}catch{/* Persistence is authoritative; clients can refresh. */}});}
  freeze(input:JsonObject,ctx:PluginContext):FrozenRun {
    if(this.closed)throw new Error('Expert 已关闭');
    this.migrate(ctx);
    const all=this.definitions(ctx);const selected=this.store.get<{ids:string[]}>(`selection:${ctx.projectId}`)?.value.ids||[];
    const roleSelection=this.roleSelection(ctx);
    const chosen=input.methodIds!==undefined?cleanStrings(input.methodIds,'方法标识'):input.expertId?[text(input.expertId)]:roleSelection?.methodIds??selected.filter(id=>all.some(expert=>expert.id===id&&expert.enabled));
    const enabled=all.filter(expert=>expert.enabled);const picked=chosen.map(id=>{const expert=enabled.find(item=>item.id===id);if(!expert)throw new Error('专家已停用或范围不匹配');return expert;});const list=input.catalog===true?enabled:chosen.length?picked:enabled;
    const skillRefs=input.skillRefs===undefined?undefined:(()=>{mutationOrigin(ctx,true);if(typeof input.expertId!=='string'||chosen.length!==1||chosen[0]!==input.expertId||!Array.isArray(input.skillRefs)||!input.skillRefs.length||input.skillRefs.length>16)throw new Error('固定 Skill 版本需要唯一 expertId 和 1 至 16 项 skillRefs');return input.skillRefs.map(raw=>{const ref=object(raw);return {id:text(ref.id),version:integer(ref.version,'version')};});})();
    const experts:FrozenExpert[]=list.map(({revision:_revision,...expert})=>{const frozenSkills=this.skillCatalog.freezeSkills(expert.id,ctx,expert.id===input.expertId?skillRefs:undefined,chosen.includes(expert.id));return {...expert,tools:[...expert.tools],skills:[...expert.skills],frozenSkills,skillContents:frozenSkills.filter(skill=>!skill.legacy||skill.legacy.path).map(skill=>({path:skill.legacy?.path||`skill:${skill.id}:${skill.version}`,content:skill.body,hash:skill.contentHash}))};});
    const restrictions=chosen.length?experts.filter(expert=>chosen.includes(expert.id)).map(expert=>expert.tools).filter(tools=>tools.length):[];
    const toolScope=restrictions.length?restrictions[0].filter(tool=>restrictions.every(scope=>scope.includes(tool))):undefined;
    let prompt=chosen.length?experts.filter(expert=>chosen.includes(expert.id)).map(frozenBody).join('\n\n'):`可用专家方法目录（正文按需使用 friend_expert use；目录不代表实际采用）：\n${experts.slice(0,8).map(expert=>`${expert.id}: ${expert.title}`).join('\n')}${experts.length>8?`\n另有 ${experts.length-8} 项可通过 catalog.search 查询。`:''}`;
    const roles=this.roleDefinitions(ctx).filter(role=>role.enabled).map(({revision:_revision,...role})=>role);
    const roleId=input.roleId!==undefined?text(input.roleId,'角色标识'):roleSelection?.id;
    const definition=roleId?roles.find(role=>role.id===roleId):undefined;
    if(roleId&&!definition)throw new Error('角色已停用或范围不匹配');
    const role=definition?this.freezeDefinition(definition,ctx):undefined;
    if(role)prompt=`${rolePrompt(role)}\n\n${prompt}`;
    const availableSkills=this.skillCatalog.directory(ctx).flatMap(item=>this.skillCatalog.resolve(item.id,item.version,ctx).map(v=>({...v,statusAtFreeze:this.skillCatalog.head(v.id,ctx).status,sourceEpoch:this.skillCatalog.head(v.id,ctx).sourceEpoch})));
    return {availableSkills,id:chosen.join('+')||'auto',version:Math.max(1,...experts.map(expert=>expert.version)),prompt,toolScope,skillPaths:[],experts,methods:structuredClone(experts),roles:structuredClone(roles),...(role?{role}:{}),hash:digest({experts,roles,role,availableSkills}),selectionMode:chosen.length?'explicit':'auto',selectedIds:[...chosen],adoptedIds:[...chosen]};
  }
  validateDelivery(ctx:PluginContext){const run=this.store.get<FrozenRun>(`run:${ctx.sessionId}`)?.value;if(!run?.role)return;const source=ctx.history().filter(item=>item.role==='assistant').at(-1);let approved=false,error:string|undefined;try{assertRoleDelivery(run.role,parseModelJson(source?.text||''));approved=true;}catch(cause){error=errorText(cause);}const receipt={v:1,runId:run.runId,roleId:run.role.id,roleVersion:run.role.version,approved,error,source:source?{sessionId:ctx.sessionId,entryId:source.id,hash:digest(source.text)}:undefined};ctx.appendEntry('friend-pi.expert.delivery',receipt);ctx.emit('expert.role.delivery',receipt);if(error)ctx.notify(`角色交付未通过：${error}`,'error');return receipt;}
  beginRun(ctx:PluginContext):FrozenRun&{runId:string} {
    const prior=this.store.get<FrozenRun>(`run:${ctx.sessionId}`)?.value;if(ctx.runId&&ctx.policy?.runId===ctx.runId&&prior?.runId===ctx.runId){const role=prior.role?{...prior.role,...(prior.role.modelSource==='inherited'?{modelId:ctx.modelId}:{}),...(prior.role.thinkingSource==='inherited'?{thinkingLevel:ctx.thinkingLevel}:{})}:undefined;const snapshot={...prior,role,runId:ctx.runId,modelId:ctx.modelId,thinkingLevel:ctx.thinkingLevel};this.store.put(`run:${ctx.sessionId}`,snapshot);ctx.appendEntry('friend-pi.expert.continuation',{v:1,runId:ctx.runId,hash:prior.hash,roleId:role?.id,modelId:ctx.modelId,thinkingLevel:ctx.thinkingLevel});return snapshot;}
    const snapshot={...this.freeze({},ctx),runId:ctx.runId||randomUUID(),modelId:ctx.modelId,thinkingLevel:ctx.thinkingLevel,adoptions:[] as unknown[]};
    this.store.put(`run:${ctx.sessionId}`,snapshot);
    if(snapshot.selectionMode==='explicit'){const prompts:string[]=[];for(const expert of snapshot.experts){const adopted=this.skillCatalog.adopt({expertId:expert.id,runId:snapshot.runId,catalogHash:snapshot.hash},{...ctx,runId:snapshot.runId}) as {prompt:string};prompts.push(adopted.prompt);}Object.assign(snapshot,this.store.get<FrozenRun>(`run:${ctx.sessionId}`)!.value);snapshot.prompt=[snapshot.role?rolePrompt(snapshot.role):'',...prompts].filter(Boolean).join('\n\n');}
    ctx.appendEntry('friend-pi.expert.run',{v:1,runId:snapshot.runId,sessionId:ctx.sessionId,modelId:ctx.modelId,thinkingLevel:ctx.thinkingLevel,frozen:snapshot,at:now()});
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
      if(action==='toggle'&&typeof input.enabled!=='boolean')throw new Error('enabled 必须是布尔值');const previous=this.definition(id,ctx);if(!previous)throw new Error('专家不存在');if(previous.revision!==integer(input.revision,'revision'))throw new Error('版本已变化，请刷新后重试');
      const restored=action==='rollback'?this.store.get<ExpertDefinition>(`version:${ctx.projectId}:${id}:${integer(input.version,'version')}`)?.value:undefined;if(action==='rollback'&&!restored)throw new Error('版本不存在');
      const body=restored||previous.value;const prompt=action==='update'?text(input.prompt,'专业方法',32000):body.prompt;const tools=action==='update'?cleanStrings(input.tools??[],'工具'):body.tools;const skills=action==='update'?cleanStrings(input.skills??[],'Skill'):body.skills;skills.forEach(path=>frozenSkill(path,ctx));
      const definition:ExpertDefinition={...body,id,version:previous.value.version+1,title:action==='update'?text(input.title,'名称',120):body.title,scope:ctx.projectId,prompt,tools,skills,enabled:action==='toggle'?input.enabled===true:true,hash:digest({prompt,tools,skills}),createdAt:now()};
      this.archive(previous.value,ctx.projectId);const key=expertKey(ctx.projectId,id);const local=this.store.get(key);let row=this.store.put(key,definition,local?.revision??null);while(row.revision<=previous.revision)row=this.store.put(key,definition,row.revision);return definition;
    });
  }
  async dispatch(action:string,input:JsonObject,ctx:PluginContext):Promise<unknown> {
    if(this.closed)throw new Error('Expert 已关闭');
    this.migrate(ctx);
    if(action==='catalog.search')return this.skillCatalog.search(input,ctx);
    if(action==='expert.read'){const expert=this.skillCatalog.experts(ctx).find(e=>e.id===text(input.id));if(!expert)throw new Error('专家不存在');if(input.version!==undefined&&input.version!==expert.version){const previous=this.store.get(`expert.version:${expert.projectId||'builtin'}:${expert.id}:${integer(input.version,'version')}`);if(!previous)throw new Error('专家版本不存在');return previous.value;}return expert;}
    if(action==='skill.read')return this.skillCatalog.read(text(input.id),integer(input.version,'version'),ctx);
    if(action==='skill.versions')return this.skillCatalog.heads(ctx).filter(h=>h.id===text(input.id)).flatMap(h=>this.store.list(`skill.version:${h.projectId||'builtin'}:${h.id}:`).map(row=>{const v=object(row.value);return {id:v.id,version:v.version,hash:v.contentHash,status:h.status};}));
    if(action==='candidate.submit'&&input.skillBody!==undefined){const result=this.skillCatalog.submit(input,ctx);this.skillCatalog.rebuildIndex();this.changed(ctx);return result;}
    if(action==='trial.configure'){const result=this.skillCatalog.configureTrial(input,ctx);this.skillCatalog.rebuildIndex();this.changed(ctx);return result;}
    if(action==='trial.observe'){const result=this.skillCatalog.observeTrials(input,ctx);this.changed(ctx);return result;}
    if(action==='trial.result'){const result=this.skillCatalog.trialResult(input,ctx);this.changed(ctx);return result;}
    if(action==='skill.update'||action==='skill.toggle'||action==='skill.rollback'){const result=this.skillCatalog.update(input,ctx,action);this.skillCatalog.rebuildIndex();this.changed(ctx);return result;}
    if(action==='candidate.withdraw'&&input.expectedRevision!==undefined){const result=this.skillCatalog.withdraw(input,ctx);this.changed(ctx);return result;}
    if(action==='source.invalidate'){const result=this.skillCatalog.invalidate(input,ctx);this.learning.invalidate(ctx);this.changed(ctx);return result;}
    if(action==='projection.rebuild'){mutationOrigin(ctx);return this.skillCatalog.projection(ctx);}
    if(action==='use'&&(input.expertId!==undefined||input.catalogHash!==undefined||ctx.findJournalEntry)){const current=this.store.get<FrozenRun>(`run:${ctx.sessionId}`)?.value;const result=this.skillCatalog.adopt({...input,runId:input.runId??current?.runId,catalogHash:input.catalogHash??current?.hash},ctx);this.changed(ctx);return result;}
    if(action==='adopt.frozen'&&input.memberId!==undefined)return this.skillCatalog.prepareMember(input,ctx);
    if(action==='adopt.confirm')return this.skillCatalog.confirmMember(input,ctx);
    if(['taskTraceReady','learning.enqueue','learning.settings','jobs.read','validation.manifest','validation.schedule','validation.read'].includes(action))return this.learning.dispatch(action,input,ctx);
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
    if(action==='select'){const ids=cleanStrings(input.ids??[],'专家标识');for(const id of ids)this.freeze({expertId:id},ctx);this.store.put(`selection:${ctx.projectId}`,{ids});return this.snapshot(ctx);}
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
      const id=randomUUID();const prompt=text(input.prompt,'专业方法',32000);const tools=cleanStrings(input.tools??[],'工具');const skills=cleanStrings(input.skills??[],'Skill');skills.forEach(path=>frozenSkill(path,ctx));
      const definition:ExpertDefinition={id,version:1,title:text(input.title,'名称',120),scope:ctx.projectId,prompt,tools,skills,enabled:true,hash:digest({prompt,tools,skills}),createdAt:now()};const row=this.store.put(expertKey(ctx.projectId,id),definition,null);this.skillCatalog.importLegacy(definition,ctx);this.skillCatalog.rebuildIndex();return {...definition,revision:row.revision};
    }
    if(action==='update'||action==='toggle'||action==='rollback'){const definition=this.updateDefinition(text(input.id),input,ctx,action);this.skillCatalog.importLegacy(definition,ctx);this.skillCatalog.rebuildIndex();if(action==='update')return {...definition,revision:this.definition(definition.id,ctx)!.revision};return this.snapshot(ctx);}
    if(action==='versions'){const id=text(input.id);return this.store.list<ExpertDefinition>(`version:${ctx.projectId}:${id}:`).map(row=>row.value);}
    if(action==='candidate.submit'){
      if(ctx.origin!=='user'&&ctx.origin!=='plugin')throw new Error('模型不能用候选提交绕过用户管理；自动方法由有来源的 Memory 插件提交');
      const sources=Array.isArray(input.sources)?input.sources.map(raw=>{
        const source=object(raw);const ref:SourceRef={sessionId:text(source.sessionId),entryId:text(source.entryId)};
        for(const key of ['start','end'] as const)if(source[key]!==undefined){if(typeof source[key]!=='number'||!Number.isInteger(source[key])||Number(source[key])<0)throw new Error('方法来源片段范围无效');ref[key]=source[key] as number;}
        if(source.hash!==undefined)ref.hash=text(source.hash,'来源摘要',128);if(source.factId!==undefined)ref.factId=text(source.factId,'来源事实标识',180);
        ctx.readSource(ref);return ref;
      }):[];
      const sourceMemoryIds=cleanStrings(input.sourceMemoryIds??[],'父记忆');if(ctx.origin==='plugin'&&!sources.length)throw new Error('自动候选需要可回查的来源');
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
      if(ctx.origin!=='plugin'&&ctx.origin!=='user')throw new Error('记忆失效必须来自用户或来源插件');const ids=cleanStrings(input.ids??[],'来源标识');this.invalidate(ids,ctx);return this.snapshot(ctx);
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
    if(row.value.status==='trial')return Promise.resolve(row.value);
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
        if(latest?.value.status==='published'||latest?.value.status==='trial'){job.resolve(latest.value);this.jobs.delete(key);this.queue.shift();continue;}
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
    this.store.transaction(()=>{const current=ensure();candidate.status='trial';candidate.error='旧单套验证仅提供局部证据；需要独立 validation/release 严格增益才可晋升';candidate.evaluation={suiteHash,cases:suite.value,modelId:job.ctx.modelId,at:now()};candidate.validation=undefined;this.store.put(job.key,candidate,current.revision);});return candidate;
  }
  dispose():void|Promise<void> {
    if(this.closed)return;this.closed=true;if(this.timer)clearTimeout(this.timer);this.active?.abort.abort();
    if(this.nativeTimer)clearTimeout(this.nativeTimer);this.nativeAbort?.abort('application.quit');
    if(this.active){const current=this.store.get<MethodCandidate>(this.active.key);if(current&&current.value.status==='validating')this.store.put(current.key,{...current.value,status:'candidate',validation:undefined,error:'会话关闭，验证取消且未发布'},current.revision);}
    for(const job of this.jobs.values())job.reject(new Error('Expert 已关闭，验证取消'));this.jobs.clear();this.queue=[];this.releaseLease();if(this.nativeRunning)return this.nativeRunning.catch(()=>{}).then(()=>this.store.close());this.store.close();
  }
  executeLearningJob(id:string,ctx:PluginContext,options:Parameters<ExpertLearningService['execute']>[2]={}){return this.learning.execute(id,ctx,options);}
  private adoptedVersions(run:FrozenRun):FrozenSkillVersion[]{const versions=new Map<string,FrozenSkillVersion>();for(const expert of run.experts)if(run.selectedIds.includes(expert.id))for(const v of expert.frozenSkills||[])versions.set(`${v.id}:${v.version}`,v);for(const raw of run.adoptions||[]){const adoption=object(raw);if(adoption.journalStatus==='failed'||adoption.journalStatus==='pending')continue;if(Array.isArray(adoption.skills))for(const ref of adoption.skills){const skill=object(ref);if(typeof skill.id!=='string')continue;const v=run.availableSkills?.find(v=>v.id===skill.id&&v.version===skill.version);if(v)versions.set(`${v.id}:${v.version}`,v);}if(typeof adoption.id==='string'&&adoption.mode==='use')for(const v of run.experts.find(e=>e.id===adoption.id)?.frozenSkills||[])versions.set(`${v.id}:${v.version}`,v);}return [...versions.values()];}
  assertAdopted(ctx:PluginContext){const run=this.store.get<FrozenRun>(`run:${ctx.sessionId}`)?.value;if(!run)return;for(const skill of this.adoptedVersions(run)){if(this.skillCatalog.head(skill.id,ctx).status==='withdrawn')throw new Error('采用方法来源已撤回，等待重新核验');this.skillCatalog.policy.assert(this.skillCatalog.checkEvidence(skill,ctx));}}
  observePrepared(payload:unknown,ctx:PluginContext){const run=this.store.get<FrozenRun>(`run:${ctx.sessionId}`)?.value;if(!run?.runId)return [];this.assertAdopted(ctx);const strings:string[]=[],seen=new Set<object>();const visit=(value:unknown)=>{if(typeof value==='string')strings.push(value);else if(value&&typeof value==='object'&&!seen.has(value)){seen.add(value);for(const child of Array.isArray(value)?value:Object.values(value))visit(child);}};visit(payload);const values=strings.join('\n'),receipts:import('@friend-pi/core').EvidenceReceipt[]=[];for(const skill of this.adoptedVersions(run)){if(!values.includes(skill.body))continue;const refs=evidenceRefs(skill.evidence),receipt:import('@friend-pi/core').EvidenceReceipt={v:1,receiptId:randomUUID(),projectId:ctx.projectId,sessionId:ctx.sessionId,runId:run.runId,stage:'request-prepared',sources:refs.sources,artifacts:refs.artifacts,dependencies:[...refs.dependencies,{capability:'expert',id:skill.id,version:skill.version,hash:skill.contentHash,relation:'adopted'}],observer:{kind:ctx.memberId?'member':'foreground',runId:run.runId,modelId:ctx.modelId},contentHash:skill.contentHash,fullLength:skill.body.length,visibleRanges:[[0,skill.body.length]],at:now()};ctx.appendEntry('friend-pi.expert.evidence',{...receipt,providerPayloadHash:digest(payload),boundary:'expert-before-provider-hook'});receipts.push(receipt);}this.preparedReceipts.set(ctx.sessionId,receipts);return receipts;}
  observeResponse(ctx:PluginContext,status:number){if(status<200||status>=300)return;for(const receipt of this.preparedReceipts.get(ctx.sessionId)||[])ctx.appendEntry('friend-pi.expert.evidence',{...receipt,receiptId:randomUUID(),stage:'response-observed',at:now()});this.preparedReceipts.delete(ctx.sessionId);}
  /** Native packages use the same public host lease and one-request job service as desktop. */
  async executeNativeLearning(ctx:PluginContext){
    if(this.closed||this.nativeRunning||!ctx.isIdle()||process.env.FRIEND_PI_DESKTOP_MANAGED==='1'||process.env.FRIEND_PI_LEARNING_ROLE==='producer'||learningHostAvailable(ctx.dataDir))return {};
    const job=this.store.list<ExpertLearningJob>('job:').map(row=>row.value).filter(job=>job.projectId===ctx.projectId&&job.sessionId===ctx.sessionId&&['queued','retryable'].includes(job.state)&&(!job.nextAttemptAt||job.nextAttemptAt<=Date.now())).sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt))[0];if(!job)return {};
    let lease=acquireLearningLease(this.store,`native-expert:${this.runtime}`);if(!lease)return {};this.nativeAbort=new AbortController();const abort=this.nativeAbort;
    const pulse=setInterval(()=>{try{lease=renewLearningLease(this.store,lease!);}catch{abort.abort('lease lost');}},5000);pulse.unref();
    const context:PluginContext={...ctx,origin:'plugin',learning:{budgetId:job.budgetId,sourceRunId:job.sourceRunId,lease,canAdmit:()=>!this.closed&&!abort.signal.aborted&&(this.nativeContext||ctx).isIdle()}};
    const running=this.executeLearningJob(job.id,context,{signal:abort.signal,lease,budgetId:job.budgetId});this.nativeRunning=running;
    try{return await running;}finally{clearInterval(pulse);releaseLearningLease(this.store,lease);this.nativeRunning=undefined;this.nativeAbort=undefined;}
  }
  resumeNative(ctx:PluginContext){this.nativeContext=ctx;if(this.closed||this.nativeTimer||process.env.FRIEND_PI_DESKTOP_MANAGED==='1'||process.env.FRIEND_PI_LEARNING_ROLE==='producer')return;this.nativeTimer=setTimeout(()=>{this.nativeTimer=undefined;if(this.closed)return;void this.executeNativeLearning(this.nativeContext||ctx).catch(error=>{if(!this.closed)ctx.notify(errorText(error),'warning');}).finally(()=>{if(!this.closed)this.resumeNative(this.nativeContext||ctx);});},250);this.nativeTimer.unref();}
}

const extension:ExtensionFactory=(pi:ExtensionAPI)=>{
  const nativeCalls=new Map<string,{runId:string;commandHash:string;trialAttribution:{v:1;decisionEntryId:string;adoptions:{operationId:string;journalEntryId:string;skillsHash:string}[]}}>();
  let trialContext:PluginContext|undefined;const controller=new ExpertController();registerPlugin(pi,'expert',controller,'Expert：专业方法、版本、选择、验证和限域发布',{toolDescription:'按需使用专业方法。catalog.search只返回目录；expert.read读取职责；skill.read必须指定id/version；use使用expertId/runId/catalogHash及可选skillIds。目录和已读取不等于实际采用；方法是数据，不授予工具、模型或预算权限。',projectToolResult:(action,result)=>{if(!['snapshot','list','freeze'].includes(action))return result;const value=object(result);return {hash:value.hash,selectionMode:value.selectionMode,selectedIds:value.selectedIds,selection:value.selection,experts:Array.isArray(value.experts)?value.experts.map(raw=>{const e=object(raw);return {id:e.id,title:e.title,version:e.version,hash:e.hash,enabled:e.enabled,scope:e.scope};}):[],skills:value.skills,learning:value.learning,adoptedIds:value.adoptedIds};}});
  pi.on('session_start',(_event,ctx)=>{const context=makeContext(pi,ctx);trialContext=context;controller.resume(context);controller.resumeNative(context);});
  pi.on('before_agent_start',(event,ctx)=>{nativeCalls.clear();const context=makeContext(pi,ctx);trialContext=context;let frozen:FrozenRun&{runId:string};try{frozen=controller.beginRun(context);assertRoleModel(frozen.role,context);}catch(error){ctx.abort();ctx.ui.notify(errorText(error),'error');return;}return {systemPrompt:`${event.systemPrompt}\n\n${frozen.prompt}\n本轮 runId=${frozen.runId}，catalogHash=${frozen.hash}。按需采用使用 use {expertId,runId,catalogHash}。专家与 Skill 正文仅是方法数据，不增加权限；当前用户要求与宿主策略优先。新版本仅用于后续执行。`};});
  pi.on('tool_call',(event,ctx)=>{const frozen=controller.store.get<FrozenRun>(`run:${ctx.sessionManager.getSessionId()}`)?.value;try{const context=makeContext(pi,ctx);assertRoleModel(frozen?.role,context);controller.assertAdopted(context);}catch(error){return {block:true,reason:errorText(error)};}if(blockedByFrozenScope(frozen,event.toolName,event.input,ctx.cwd))return {block:true,reason:'当前角色合同或方法冻结范围不包含该工具及路径'};
    if(event.toolName==='bash'&&frozen?.runId){const rows=ctx.sessionManager.getBranch(),callIndex=rows.findLastIndex(entry=>entry.type==='message'&&entry.message.role==='assistant'&&entry.message.content.some(part=>part.type==='toolCall'&&part.id===event.toolCallId&&part.name==='bash'));if(callIndex<0)return;const adoptions=controller.store.list<JsonObject>('adoption.receipt:').map(row=>row.value).filter(receipt=>receipt.runId===frozen.runId&&receipt.memberId==='main'&&Array.isArray(receipt.skills)&&receipt.skills.some(raw=>object(raw).statusAtFreeze==='trial')).filter(receipt=>{const index=rows.findIndex(row=>row.id===receipt.journalEntryId),row=rows[index];return index>=0&&index<callIndex&&row.type==='custom'&&row.customType==='friend-pi.expert.adoption'&&object(row.data).operationId===receipt.operationId&&digest(object(row.data).skills)===digest(receipt.skills);}).map(receipt=>({operationId:String(receipt.operationId),journalEntryId:String(receipt.journalEntryId),skillsHash:digest(receipt.skills)}));nativeCalls.set(event.toolCallId,{runId:frozen.runId,commandHash:digest(event.input.command),trialAttribution:{v:1,decisionEntryId:rows[callIndex].id,adoptions}});}
  });
  // Pi reports hook exceptions and continues; explicit public abort is required here.
  pi.on('before_provider_request',(event,ctx)=>{const frozen=controller.store.get<FrozenRun>(`run:${ctx.sessionManager.getSessionId()}`)?.value;try{const context=makeContext(pi,ctx);assertRoleModel(frozen?.role,context);controller.observePrepared(event.payload,context);}catch(error){ctx.abort();ctx.ui.notify(errorText(error),'error');}});
  pi.on('after_provider_response',(event,ctx)=>controller.observeResponse(makeContext(pi,ctx),event.status));
  pi.on('tool_result',(event,ctx)=>{const call=nativeCalls.get(event.toolCallId);nativeCalls.delete(event.toolCallId);if(event.toolName!=='bash'||!call||!event.structuredContent||typeof event.structuredContent!=='object')return;const result=object(event.structuredContent),run=controller.store.get<FrozenRun>(`run:${ctx.sessionManager.getSessionId()}`)?.value;if(!run?.runId||call.runId!==run.runId||typeof result.exit_code!=='number'||!Number.isSafeInteger(result.exit_code))return;pi.appendEntry('friend-pi.expert.native-check.v1',{v:1,...call,toolCallId:event.toolCallId,exitCode:result.exit_code,outputHash:digest(visibleText(event.content)),boundary:'native-pi-tool-result-structured-exit-code'});});
  pi.on('agent_settled',(_event,ctx)=>{
    const context=makeContext(pi,ctx,'plugin');controller.validateDelivery(context);if(process.env.FRIEND_PI_DESKTOP_MANAGED==='1')return;const lastAssistant=ctx.sessionManager.getBranch().findLast(entry=>entry.type==='message'&&entry.message.role==='assistant');if(lastAssistant?.type==='message'&&lastAssistant.message.role==='assistant'&&['aborted','error'].includes(lastAssistant.message.stopReason))return;
    const frozen=controller.store.get<FrozenRun>(`run:${context.sessionId}`)?.value,runId=frozen?.runId;if(!runId)return;const history=context.history(),lastUser=history.findLastIndex(item=>item.role==='user'),items=history.slice(Math.max(0,lastUser)).filter(item=>item.text&&['user','assistant','toolResult'].includes(item.role||'')&&!isDerivedCapabilityInput(item)),sources=items.map(item=>({sessionId:context.sessionId,entryId:item.id,start:0,end:item.text.length,hash:digest(item.text)}));
    const raw=ctx.sessionManager.getBranch(),failedTool=raw.some(entry=>entry.type==='message'&&entry.message.role==='toolResult'&&entry.message.isError&&sources.some(source=>source.entryId===entry.id)),correction=/(?:纠正|更正|之前.{0,12}(?:错误|不对)|you were wrong|correction)/iu.test(history[lastUser]?.userText??history[lastUser]?.text??'');
    const evidence:import('./skills.js').EvidenceRef[]=sources.map(source=>({kind:'pi',projectId:context.projectId,source}));let invalidChecks=false;
    for(const [toolIndex,entry] of raw.entries()){
      if(entry.type!=='message'||entry.message.role!=='toolResult'||entry.message.toolName!=='bash'||!sources.some(source=>source.entryId===entry.id))continue;
      const nativeMessage=entry.message,receiptIndex=raw.findLastIndex(row=>row.type==='custom'&&row.customType==='friend-pi.expert.native-check.v1'&&object(row.data).runId===runId&&object(row.data).toolCallId===nativeMessage.toolCallId&&object(row.data).outputHash===digest(visibleText(nativeMessage.content))),receipt=raw[receiptIndex],observed=receipt?.type==='custom'?object(receipt.data):undefined,exitCode=observed?.exitCode,attribution=observed?.trialAttribution&&typeof observed.trialAttribution==='object'&&!Array.isArray(observed.trialAttribution)?object(observed.trialAttribution):{},decisionIndex=raw.findIndex(row=>row.id===attribution.decisionEntryId),decision=raw[decisionIndex];
      const call=decision?.type==='message'&&decision.message.role==='assistant'?decision.message.content.find(part=>part.type==='toolCall'&&part.id===nativeMessage.toolCallId&&part.name==='bash'):undefined;
      if(typeof exitCode!=='number'||!Number.isSafeInteger(exitCode)||Boolean(nativeMessage.isError)!==(exitCode!==0)||attribution.v!==1||!Array.isArray(attribution.adoptions)||attribution.adoptions.some(ref=>!ref||typeof ref!=='object'||Array.isArray(ref))||decisionIndex<0||decisionIndex>=receiptIndex||receiptIndex>=toolIndex||call?.type!=='toolCall'||digest(object(call.arguments).command)!==observed?.commandHash){invalidChecks=true;continue;}
      const adoptions=attribution.adoptions.map(object),valid=adoptions.every(adoption=>{const index=raw.findIndex(row=>row.id===adoption.journalEntryId),canonical=raw[index];return index>=0&&index<decisionIndex&&canonical.type==='custom'&&canonical.customType==='friend-pi.expert.adoption'&&object(canonical.data).runId===runId&&object(canonical.data).memberId==='main'&&object(canonical.data).operationId===adoption.operationId&&digest(object(canonical.data).skills)===adoption.skillsHash;});
      if(!valid){invalidChecks=true;continue;}
      const check={checkId:`pi:${context.sessionId}:${entry.id}`,version:1,hash:digest(entry.message),taskId:runId,producerRunId:runId,artifacts:[]};controller.skillCatalog.policy.registerCheck({ref:check,projectId:context.projectId,passed:exitCode===0,output:{text:visibleText(nativeMessage.content),exitCode,toolError:entry.message.isError,trialAttribution:attribution,boundary:'native-pi-tool-result-structured-exit-code'},sources:sources.filter(source=>source.entryId===entry.id)});evidence.push({kind:'check',projectId:context.projectId,check});
    }
    const checks=evidence.flatMap(e=>e.kind==='check'?[e.check]:[]);try{controller.skillCatalog.observeTrials({runId,checks,outcome:invalidChecks?'unknown':failedTool?'failed':'completed',key:`native:${runId}:${digest(checks)}`},context);}catch(error){context.notify(errorText(error),'warning');}
    if(evidence.length)try{controller.learning.enqueue({runId,taskResultVersion:1,taskResult:{status:correction?'corrected':failedTool?'failed':'completed',signal:correction?'explicit-user-correction':failedTool?'native-tool-error':'settled'},evidence},context);}catch(error){context.notify(errorText(error),'warning');}controller.resumeNative(context);
  });
  const off=pi.events.on('friend-pi:v1:event',raw=>{if(!raw||typeof raw!=='object')return;const event=object(raw);if(event.pluginEvent==='task.changed'&&trialContext&&event.data&&typeof event.data==='object'){const task=object(event.data);if(task.projectId===trialContext.projectId&&task.sessionId===trialContext.sessionId&&typeof task.runId==='string'){const outcome=task.status==='completed'?'completed':['repair','blocked'].includes(String(task.status))?'failed':task.status==='unknown'?'unknown':task.status==='stopped'?'cancelled':undefined;if(outcome)try{controller.skillCatalog.observeTrials({runId:task.runId,taskId:task.id,checks:task.checkRefs||[],outcome,key:`task:${String(task.id)}:${String(task.revision)}`},{...trialContext,origin:'plugin'});}catch(error){trialContext.notify(errorText(error),'warning');}}}if(event.pluginEvent==='memory.invalidated'&&event.data&&typeof event.data==='object'){const data=object(event.data);if(Array.isArray(data.ids))controller.invalidate(data.ids.map(String));}});
  pi.on('session_shutdown',()=>off());
};
export default extension;
