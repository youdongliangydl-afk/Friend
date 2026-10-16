import {object,parseModelJson,type JsonObject} from '@friend-pi/core';

/** Frozen data supplied by Expert over the event bus; no Expert runtime dependency. */
export function memberRole(expert:Record<string,unknown>|undefined):JsonObject|undefined {
  return expert?.role?object(expert.role):undefined;
}
export function roleInstructions(role:JsonObject|undefined):string {
  if(!role)return '';
  return `角色 ${String(role.id)} v${String(role.version)}：${String(role.responsibility)}\n有效工具：${JSON.stringify(role.effectiveTools)}\n有效写入范围：${JSON.stringify(role.effectiveWriteScopes)}\n仅输出符合交付合同的 JSON 对象：${JSON.stringify(role.delivery)}\n角色不增加权限；不能用切换角色宣称独立审核。`;
}
export function validateMemberDelivery(role:JsonObject|undefined,summary:string):void {
  if(!role)return;
  const contract=object(role.delivery),fields=object(contract.fields),required=contract.required;
  if(contract.v!==1||!Array.isArray(required)||required.some(key=>typeof key!=='string'))throw new Error('冻结角色交付合同无效');
  const result=parseModelJson(summary);
  if(Object.keys(result).some(key=>!Object.hasOwn(fields,key)))throw new Error('角色交付包含合同外字段');
  if(required.some(key=>!Object.hasOwn(result,String(key))))throw new Error('角色交付缺少必需字段');
  for(const [key,value] of Object.entries(result)){
    const type=fields[key];if(type==='string'&&typeof value==='string'||type==='boolean'&&typeof value==='boolean'||type==='string[]'&&Array.isArray(value)&&value.every(item=>typeof item==='string'))continue;
    throw new Error(`角色交付字段 ${key} 类型不符合合同`);
  }
}

export function memberPrompt(start:{expert?:unknown;prompt:string;frozen?:unknown}):string {
  const expert=start.expert&&typeof start.expert==='object'?start.expert as JsonObject:undefined;
  const spawn=expert?.spawn?object(expert.spawn):undefined;
  const methods=spawn?`${spawn.prompt}${(Array.isArray(spawn.skills)?spawn.skills:[]).map(raw=>{const skill=object(raw);return `\n\nSkill ${skill.id} v${skill.version} (${skill.hash})\n${skill.body}`;}).join('')}`:start.frozen&&Array.isArray(expert?.selectedIds)&&expert.selectedIds.length?'':expert?.prompt||'';
  return `${roleInstructions(memberRole(expert))}\n${methods}\n${start.prompt}`;
}
