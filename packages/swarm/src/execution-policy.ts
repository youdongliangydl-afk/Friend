import {CapabilityError,object,type ExpertSpawnOverrides} from '@friend-pi/core';
import type {ExecutionPolicy,Graph} from './types.js';

export function executionPolicy(raw:unknown):ExecutionPolicy {
  const value=raw===undefined?{}:object(raw);
  if(Object.keys(value).some(key=>!['v','workspace','review','dirtyBaseline'].includes(key))||value.v!==undefined&&value.v!==1)throw new CapabilityError('VALIDATION_ERROR','执行策略版本或字段无效');
  const policy={v:1 as const,workspace:value.workspace??'isolated',review:value.review??'required',dirtyBaseline:value.dirtyBaseline??'reject'};
  if(!['isolated','shared'].includes(String(policy.workspace))||!['required','none'].includes(String(policy.review))||!['snapshot','reject'].includes(String(policy.dirtyBaseline)))throw new CapabilityError('VALIDATION_ERROR','执行策略取值无效');
  return policy as ExecutionPolicy;
}
export const sharedWorkspace=(graph:Graph)=>graph.executionPolicy?.workspace==='shared';
export const snapshotWorkspace=(graph:Graph)=>graph.executionPolicy?.workspace==='isolated'&&graph.executionPolicy.dirtyBaseline==='snapshot';
export const reviewNotRequested=(graph:Graph)=>graph.executionPolicy?.review==='none'&&!graph.reviewContractRequired&&graph.contract?.verification!=='V2';

export function expertOverrides(raw:unknown):ExpertSpawnOverrides|undefined {
  if(raw===undefined)return;
  const value=object(raw);
  if(Object.keys(value).some(key=>!['prompt','skillRefs','toolsMode','tools','modelId','thinkingLevel'].includes(key)))throw new CapabilityError('VALIDATION_ERROR','专家覆盖字段无效');
  for(const key of ['prompt','modelId','thinkingLevel'])if(value[key]!==undefined&&typeof value[key]!=='string')throw new CapabilityError('VALIDATION_ERROR',`专家覆盖 ${key} 无效`);
  if(value.toolsMode!==undefined&&!['inherit','allowlist'].includes(String(value.toolsMode))||value.tools!==undefined&&(!Array.isArray(value.tools)||value.tools.some(item=>typeof item!=='string')))throw new CapabilityError('VALIDATION_ERROR','专家工具覆盖无效');
  if(value.skillRefs!==undefined&&(!Array.isArray(value.skillRefs)||value.skillRefs.some(item=>!item||typeof item!=='object'||typeof item.id!=='string'||item.version!==undefined&&(!Number.isInteger(item.version)||item.version<1))))throw new CapabilityError('VALIDATION_ERROR','专家 Skill 覆盖无效');
  return structuredClone(value) as ExpertSpawnOverrides;
}
