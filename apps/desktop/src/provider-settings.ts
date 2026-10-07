import { mkdirSync,existsSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { object,text,atomicWrite,type JsonObject } from '@friend-pi/core';
export type ProviderRuntime=ModelRuntime;
export async function createProviderRuntime(dataDir:string):Promise<ModelRuntime>{
  const agentDir=join(dataDir,'pi');mkdirSync(agentDir,{recursive:true,mode:0o700});
  return await ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:join(agentDir,'models.json'),allowModelNetwork:false});
}
export function providerMetadata(runtime:ModelRuntime){return {models:runtime.getModels().map(model=>({id:`${model.provider}/${model.id}`,provider:model.provider,name:model.name,reasoning:model.reasoning,contextWindow:model.contextWindow,input:model.input,thinkingLevels:[...new Set(['off',...getSupportedThinkingLevels(model)])]})),providers:runtime.getProviders().map(provider=>({id:provider.id,name:provider.name,configured:runtime.hasConfiguredAuth(provider.id)}))};}
/** Existing credentials stay in Pi's private auth store, never in application preferences or metadata. */
export async function saveProviderConfiguration(runtime:ModelRuntime,dataDir:string,input:JsonObject):Promise<string>{
  const provider=text(input.provider,'供应商',120);const agentDir=join(dataDir,'pi');
  if(input.baseUrl||input.modelId){
    const modelId=text(input.modelId||runtime.getModels(provider)[0]?.id,'型号',200);const baseUrl=text(input.baseUrl||runtime.getModels(provider)[0]?.baseUrl,'地址',2000);if(!['https:','http:'].includes(new URL(baseUrl).protocol))throw new Error('地址须为 HTTP(S)');
    const path=join(agentDir,'models.json');const config=existsSync(path)?object(JSON.parse(readFileSync(path,'utf8'))):{};const providers=object(config.providers||{});
    const previous=providers[provider]?object(providers[provider]):{};const priorModels=Array.isArray(previous.models)?previous.models.map(object):[];const prior=priorModels.find(model=>model.id===modelId)||{};const catalog=runtime.getModels(provider).find(model=>model.id===modelId);
    const merged={id:modelId,name:catalog?.name||modelId,reasoning:catalog?.reasoning||false,input:catalog?.input||['text'],contextWindow:catalog?.contextWindow||32768,maxTokens:catalog?.maxTokens||4096,cost:catalog?.cost||{input:0,output:0,cacheRead:0,cacheWrite:0},...prior,...(typeof input.reasoning==='boolean'?{reasoning:input.reasoning}:{}),...(Array.isArray(input.input)?{input:input.input}:{}),...(typeof input.contextWindow==='number'?{contextWindow:input.contextWindow}:{})};
    providers[provider]={...previous,baseUrl,api:typeof input.api==='string'?input.api:previous.api||'openai-completions',models:[...priorModels.filter(model=>model.id!==modelId),merged]};atomicWrite(path,JSON.stringify({...config,providers},null,2));
  }
  await runtime.refresh();if(input.apiKey){const key=text(input.apiKey,'Key',8192);await runtime.login(provider,'api_key',{prompt:async()=>key,notify:()=>{}});}await runtime.refresh();return provider;
}
