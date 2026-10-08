import { mkdirSync,existsSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { object,text,atomicWrite,type JsonObject } from '@friend-pi/core';
import {providerPresets} from './provider-presets.js';
const advancedAuthProviders=new Set(['amazon-bedrock','google-vertex','azure','cloudflare-ai-gateway','cloudflare-workers-ai']);
export type ProviderRuntime=ModelRuntime;
export function providerDefaultSelection(runtime:ModelRuntime,provider:string,id:string,previousLevel:string){
  const selected=providerMetadata(runtime).models.find(model=>model.id===id&&model.provider===provider);
  if(!selected)throw new Error('默认模型不属于已保存的厂商');
  return {defaultModelId:selected.id,defaultThinkingLevel:selected.thinkingLevels.includes(previousLevel as never)?previousLevel:selected.thinkingLevels[0]||'off'};
}
export async function createProviderRuntime(dataDir:string):Promise<ModelRuntime>{
  const agentDir=join(dataDir,'pi');mkdirSync(agentDir,{recursive:true,mode:0o700});
  return await ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:join(agentDir,'models.json'),allowModelNetwork:false});
}
export function providerMetadata(runtime:ModelRuntime){return {models:runtime.getModels().map(model=>({id:`${model.provider}/${model.id}`,provider:model.provider,name:model.name,baseUrl:model.baseUrl,api:model.api,reasoning:model.reasoning,contextWindow:model.contextWindow,input:model.input,thinkingLevels:getSupportedThinkingLevels(model).map(String)})),providers:runtime.getProviders().map(provider=>({id:provider.id,name:provider.name,supportsApiKey:!!provider.auth.apiKey&&!advancedAuthProviders.has(provider.id),configured:runtime.hasConfiguredAuth(provider.id)}))};}
/** Existing credentials stay in Pi's private auth store, never in application preferences or metadata. */
export async function saveProviderConfiguration(runtime:ModelRuntime,dataDir:string,input:JsonObject):Promise<string>{
  const preset=providerPresets.find(item=>item.id===input.presetId);
  if(input.presetId&&!preset)throw new Error('未知厂商预配置');
  if(preset&&input.provider!==preset.provider)throw new Error('厂商与预配置不匹配');
  if(preset&&!preset.native&&!runtime.getModels(preset.provider).length)input={baseUrl:preset.baseUrl,api:preset.api,modelId:preset.preferredModels[0],...input};
  const provider=text(input.provider,'供应商',120);const agentDir=join(dataDir,'pi');
  if(advancedAuthProviders.has(provider))throw new Error('此厂商需要云账户或其他认证参数，请使用 Pi 专用认证流程');
  if(typeof input.defaultModelId==='string'&&input.defaultModelId&&!input.defaultModelId.startsWith(provider+'/'))throw new Error('默认模型不属于已保存的厂商');
  if(preset?.migrateBaseUrlFrom&&!input.baseUrl&&runtime.getModels(provider)[0]?.baseUrl===preset.migrateBaseUrlFrom){
    const path=join(agentDir,'models.json'),config=existsSync(path)?object(JSON.parse(readFileSync(path,'utf8'))):{},providers=object(config.providers||{});
    // Canonical domain migration only: retain the public SDK's protocol and full model metadata.
    const previous=object(providers[provider]||{});if(!previous.baseUrl){providers[provider]={...previous,baseUrl:preset.baseUrl};atomicWrite(path,JSON.stringify({...config,providers},null,2));}
  }
  if(input.baseUrl||input.modelId){
    const modelId=text(input.modelId||runtime.getModels(provider)[0]?.id,'型号',200);const baseUrl=text(input.baseUrl||runtime.getModels(provider)[0]?.baseUrl,'地址',2000);if(!['https:','http:'].includes(new URL(baseUrl).protocol))throw new Error('地址须为 HTTP(S)');
    const path=join(agentDir,'models.json');const config=existsSync(path)?object(JSON.parse(readFileSync(path,'utf8'))):{};const providers=object(config.providers||{});
    const previous=providers[provider]?object(providers[provider]):{};const priorModels=Array.isArray(previous.models)?previous.models.map(object):[];const prior=priorModels.find(model=>model.id===modelId)||{};const catalog=runtime.getModels(provider).find(model=>model.id===modelId)||runtime.getModels(preset?.catalogProvider||provider).find(model=>model.id===modelId);
    const merged={id:modelId,name:catalog?.name||modelId,reasoning:catalog?.reasoning||false,input:catalog?.input||['text'],contextWindow:catalog?.contextWindow||32768,maxTokens:catalog?.maxTokens||4096,cost:catalog?.cost||{input:0,output:0,cacheRead:0,cacheWrite:0},...(catalog?.compat?{compat:catalog.compat}:{}),...(catalog?.thinkingLevelMap?{thinkingLevelMap:catalog.thinkingLevelMap}:{}),...prior,...(typeof input.reasoning==='boolean'?{reasoning:input.reasoning}:{}),...(Array.isArray(input.input)?{input:input.input}:{}),...(typeof input.contextWindow==='number'?{contextWindow:input.contextWindow}:{})};
    providers[provider]={...previous,baseUrl,api:typeof input.api==='string'?input.api:previous.api||'openai-completions',models:[...priorModels.filter(model=>model.id!==modelId),merged]};atomicWrite(path,JSON.stringify({...config,providers},null,2));
  }
  await runtime.refresh({allowNetwork:false});if(input.apiKey){const key=text(input.apiKey,'Key',8192);await runtime.login(provider,'api_key',{prompt:async prompt=>{if(prompt.type!=='secret')throw new Error('此厂商需要额外认证参数，请使用 Pi 专用认证流程');return key;},notify:()=>{}});}await runtime.refresh({allowNetwork:false});return provider;
}
