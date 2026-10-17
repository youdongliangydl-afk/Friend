import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { digest, object, text, type JsonObject } from '@friend-pi/core';

export interface RoleDeliveryContract { v:1; fields:Record<string,'string'|'boolean'|'string[]'>; required:string[] }
export interface RoleDefinition {
  id:string; version:number; title:string; scope:string; responsibility:string;
  tools:string[]; writeScopes:string[]; delivery:RoleDeliveryContract;
  modelId?:string; thinkingLevel?:string; enabled:boolean; hash:string; createdAt:string;
}
/** A host-owned capability snapshot, never accepted from a tool's input. */
export interface RoleCapability {
  v?:1; revision?:number; runId?:string; stage?:string;
  canSwitchRole?:boolean; unsettledTools?:number; tools?:readonly string[]; writeScopes?:readonly string[];
  modelId?:string; thinkingLevel?:string;
}
export interface FrozenRole extends RoleDefinition {
  modelSource?:'role'|'inherited';thinkingSource?:'role'|'inherited';effectiveTools:string[]; effectiveWriteScopes:string[]; policyRevision?:number; stage?:string;
  /** Changing the hat of one session never establishes an independent review. */
  independent:false;
}

// Goal lifecycle tools only change goal metadata; the root controller enforces
// explicit create authorization and the update_goal status schema.
const readTools=['read','grep','find','ls','friend_expert','friend_goal','friend_task','friend_workflow','friend_jobs','friend_plan','friend_todo','create_goal','get_goal','update_goal'];
const workTools=[...readTools,'write','edit','bash','friend_swarm','friend_team','friend_workflow','friend_goal','friend_task','friend_jobs','friend_memory','friend_topic_rebuild','friend_plan','create_goal','get_goal','update_goal','set_goal_tasks','report_goal_progress'];
export const builtinRoles:readonly Omit<RoleDefinition,'version'|'scope'|'enabled'|'hash'|'createdAt'>[]=[
  {id:'planner',title:'规划',responsibility:'形成有依据的计划、约束与待决策项；不批准或执行自己的计划。',tools:readTools,writeScopes:[],delivery:{v:1,fields:{summary:'string',evidence:'string[]',risks:'string[]'},required:['summary','evidence','risks']}},
  {id:'researcher',title:'研究',responsibility:'读取一手材料与源码，区分事实、推断和未知项，不更改项目。',tools:readTools,writeScopes:[],delivery:{v:1,fields:{summary:'string',evidence:'string[]',risks:'string[]'},required:['summary','evidence','risks']}},
  {id:'implementer',title:'实现',responsibility:'在父任务授权范围内完成实现与客观检查，提交证据和残留问题。',tools:workTools,writeScopes:['.'],delivery:{v:1,fields:{summary:'string',evidence:'string[]',checks:'string[]'},required:['summary','evidence','checks']}},
  {id:'reviewer',title:'审查',responsibility:'只读核对目标、产物和已有客观检查，提交结构化结论；同一 Agent 换角色不算独立审核。',tools:readTools,writeScopes:[],delivery:{v:1,fields:{approved:'boolean',findings:'string',taskIds:'string[]'},required:['approved','findings']}},
  {id:'integrator',title:'整合',responsibility:'串行整合已检查、已审核的成果，重新检查最终组合，保留冲突现场。',tools:workTools,writeScopes:['.'],delivery:{v:1,fields:{summary:'string',evidence:'string[]',integrated:'boolean'},required:['summary','evidence','integrated']}},
];

function strings(value:unknown,label:string):string[] {
  if(!Array.isArray(value))throw new Error(`${label}必须是数组`);
  return [...new Set(value.map(item=>text(item,label,500)))];
}
export function normalizeWriteScopes(value:unknown):string[] {
  return strings(value,'角色写入范围').map(raw=>{
    if(isAbsolute(raw)||raw.includes('\\')||raw.split('/').includes('..'))throw new Error('角色写入范围必须是项目内相对路径');
    return raw.split('/').filter(part=>part&&part!=='.').join('/')||'.';
  }).filter((item,index,list)=>list.indexOf(item)===index);
}
function contains(parent:string,child:string):boolean {return parent==='.'||child===parent||child.startsWith(`${parent}/`);}
export function intersectWriteScopes(role:readonly string[],parent:readonly string[]):string[] {
  const scopes:string[]=[];
  for(const a of role)for(const b of parent){const scope=contains(a,b)?b:contains(b,a)?a:undefined;if(scope&&!scopes.includes(scope))scopes.push(scope);}
  return scopes.filter(scope=>!scopes.some(other=>other!==scope&&contains(other,scope)));
}
export function parseRoleContract(value:unknown):RoleDeliveryContract {
  const raw=object(value);if(raw.v!==1)throw new Error('角色交付合同版本必须为 1');
  const fields=object(raw.fields);const required=strings(raw.required,'必需交付字段');
  if(!Object.keys(fields).length||Object.keys(fields).length>30||!required.length)throw new Error('角色交付合同需要字段和必需字段');
  for(const [key,kind] of Object.entries(fields))if(!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)||!['string','boolean','string[]'].includes(String(kind)))throw new Error('角色交付字段名称或类型无效');
  if(required.some(key=>!Object.hasOwn(fields,key)))throw new Error('必需交付字段未定义');
  return {v:1,fields:{...fields} as RoleDeliveryContract['fields'],required};
}
export function roleDefinition(input:JsonObject,identity:{id:string;version:number;scope:string}):RoleDefinition {
  const body={...identity,title:text(input.title,'角色名称',120),responsibility:text(input.responsibility,'角色职责',16000),tools:strings(input.tools??[],'角色工具'),writeScopes:normalizeWriteScopes(input.writeScopes??[]),delivery:parseRoleContract(input.delivery),...(input.modelId?{modelId:text(input.modelId,'角色模型',500)}:{}),...(input.thinkingLevel?{thinkingLevel:text(input.thinkingLevel,'思考等级',100)}:{}),enabled:input.enabled!==false};
  return {...body,hash:digest(body),createdAt:new Date().toISOString()};
}
export function freezeRole(definition:RoleDefinition,cap:RoleCapability={}):FrozenRole {
  const tools=definition.tools.filter(tool=>!cap.tools||cap.tools.includes(tool));
  const scopes=intersectWriteScopes(definition.writeScopes,cap.writeScopes??['.']);
  // Arbitrary shell writes cannot be confined to a narrow path allowlist here.
  const effectiveTools=tools.filter(tool=>!(['write','edit','bash'].includes(tool)&&!scopes.length)&&!(tool==='bash'&&!scopes.includes('.')));
  return {...structuredClone(definition),modelSource:definition.modelId?'role':'inherited',thinkingSource:definition.thinkingLevel?'role':'inherited',effectiveTools,effectiveWriteScopes:scopes,...(definition.modelId||cap.modelId?{modelId:definition.modelId||cap.modelId}:{}),...(definition.thinkingLevel||cap.thinkingLevel?{thinkingLevel:definition.thinkingLevel||cap.thinkingLevel}:{}),...(cap.revision!==undefined?{policyRevision:cap.revision}:{}),...(cap.stage?{stage:cap.stage}:{}),independent:false};
}
const readExpertActions=new Set(['profile.list','profile.read','spawn.resolve','spawn.validate','snapshot','list','freeze','freeze.role','adopt.frozen','versions','use','role.snapshot','role.read','role.versions']);
const metadataTools=new Set(['friend_goal','friend_task','friend_workflow','friend_jobs','friend_plan']);
const readMetadataActions=new Set(['read','list','status','snapshot','get','versions','history','history.read','history.search','history.around']);
function within(root:string,path:string):boolean {const rel=relative(root,path);return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`);}
/** Resolves existing ancestors too, so a missing file below a symlink cannot escape. */
function actualTarget(path:string):string {
  let existing=path;const suffix:string[]=[];
  while(!existsSync(existing)){const parent=resolve(existing,'..');if(parent===existing)break;suffix.unshift(relative(parent,existing));existing=parent;}
  return resolve(realpathSync(existing),...suffix);
}
export function blockedByFrozenRole(role:FrozenRole|undefined,toolName:string,args?:unknown,projectDir?:string):boolean {
  if(!role)return false;
  if(toolName==='friend_expert'){
    if(!args||typeof args!=='object'||Array.isArray(args))return !role.effectiveTools.includes(toolName);
    const action=(args as JsonObject).action;
    // The controller independently requires the trusted phase/capability snapshot.
    if(action==='role.assign'||action==='role.switch')return false;
    if(!role.effectiveWriteScopes.length&&!readExpertActions.has(String(action)))return true;
    return !role.effectiveTools.includes(toolName);
  }
  if(!role.effectiveTools.includes(toolName))return true;
  if(toolName==='friend_todo'){
    const action=args&&typeof args==='object'&&!Array.isArray(args)?(args as JsonObject).action:undefined;
    return action!=='read'&&action!=='update';
  }
  if(!role.effectiveWriteScopes.length&&metadataTools.has(toolName)){
    const action=args&&typeof args==='object'&&!Array.isArray(args)?(args as JsonObject).action:undefined;
    return !(readMetadataActions.has(String(action))||role.id==='planner'&&toolName==='friend_plan'&&action==='submit');
  }
  return blockedByWriteScopes(role.effectiveWriteScopes,toolName,args,projectDir);
}
export function blockedByWriteScopes(scopes:readonly string[],toolName:string,args?:unknown,projectDir?:string):boolean {
  if(toolName==='bash')return !scopes.includes('.');
  if(toolName!=='write'&&toolName!=='edit')return false;
  if(!projectDir||!args||typeof args!=='object'||Array.isArray(args))return true;
  const raw=(args as JsonObject).path;if(typeof raw!=='string'||!raw.trim())return true;
  try {
    const root=realpathSync(projectDir),target=actualTarget(resolve(root,raw));
    if(!within(root,target))return true;
    return !scopes.some(scope=>{const allowed=resolve(root,scope);return within(root,actualTarget(allowed))&&within(allowed,target);});
  }catch{return true;}
}
export function assertRoleDelivery(role:FrozenRole,value:unknown):JsonObject {
  const result=object(value);
  if(Object.keys(result).some(key=>!Object.hasOwn(role.delivery.fields,key)))throw new Error('交付包含合同外字段');
  for(const key of role.delivery.required)if(!Object.hasOwn(result,key))throw new Error(`缺少角色交付字段：${key}`);
  for(const [key,value] of Object.entries(result)){
    const kind=role.delivery.fields[key];
    if(kind==='boolean'?typeof value!=='boolean':kind==='string'?typeof value!=='string'||!value.trim():!Array.isArray(value)||value.some(item=>typeof item!=='string'||!item.trim()))throw new Error(`角色交付字段类型无效：${key}`);
  }
  return structuredClone(result);
}
/** The host applies an explicitly configured role mapping; methods never do. */
export function assertRoleModel(role:FrozenRole|undefined,actual:{modelId?:string;thinkingLevel?:string}):void {
  if(role?.modelId&&role.modelId!==actual.modelId||role?.thinkingLevel&&role.thinkingLevel!==actual.thinkingLevel)throw new Error('宿主尚未应用冻结角色的模型与思考映射');
}
