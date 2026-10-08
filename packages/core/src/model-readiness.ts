import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicWrite, digest, visibleText } from './index.js';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import {createAssistantMessageEventStream,type AssistantMessage,type Model,type Api,type Context} from '@earendil-works/pi-ai';


interface Receipt { revision:number; status:'untested'|'testing'|'passed'|'failed'; fingerprint?:string; operation?:string; testedAt?:string }
interface Ledger { version:1; models:Record<string,Receipt> }
const ledgerPath=(dataDir:string)=>join(dataDir,'pi','model-readiness.json');
function read(dataDir:string):Ledger {
  const path=ledgerPath(dataDir);
  if(existsSync(path))return JSON.parse(readFileSync(path,'utf8')) as Ledger;
  // Migrate only concrete definitions explicitly saved in Pi's configuration.
  // A credential or ambient environment alone never imports the vendor catalogue.
  const models:Ledger['models']={};const configPath=join(dataDir,'pi','models.json');
  const config=existsSync(configPath)?JSON.parse(readFileSync(configPath,'utf8')):{};
  for(const [provider,value] of Object.entries(config.providers||{}))for(const model of (value as {models?:{id:string}[]}).models||[])if(typeof model.id==='string')models[provider+'/'+model.id]={revision:1,status:'untested'};
  const ledger:Ledger={version:1,models};write(dataDir,ledger);return ledger;
}
function write(dataDir:string,ledger:Ledger){atomicWrite(ledgerPath(dataDir),JSON.stringify(ledger,null,2));}
function canonical(value:unknown):unknown {if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));return value;}
function resolveModel(runtime:ModelRuntime,id:string){const slash=id.indexOf('/');return slash>0?runtime.getModel(id.slice(0,slash),id.slice(slash+1)):undefined;}
async function fingerprint(runtime:ModelRuntime,id:string):Promise<string|undefined>{const model=resolveModel(runtime,id);if(!model)return;try{const auth=await runtime.getAuth(model);if(!auth)return;return digest(canonical({model,auth}));}catch{return undefined;}}
export function registerSavedModel(dataDir:string,id:string){const ledger=read(dataDir);if(!ledger.models[id]){ledger.models[id]={revision:1,status:'untested'};write(dataDir,ledger);}}
/** Invalidate before any credential/configuration mutation; failed saves stay unverified. */
export function invalidateProvider(dataDir:string,provider:string,modelId?:string){const ledger=read(dataDir);for(const [id,receipt] of Object.entries(ledger.models))if(id.startsWith(provider+'/'))ledger.models[id]={revision:receipt.revision+1,status:'untested'};if(modelId&&!ledger.models[provider+'/'+modelId])ledger.models[provider+'/'+modelId]={revision:1,status:'untested'};write(dataDir,ledger);}
export async function modelReadiness(runtime:ModelRuntime,dataDir:string,id:string){const stamp=await fingerprint(runtime,id),receipt=read(dataDir).models[id];if(!receipt)return;const ready=receipt.status==='passed'&&!!stamp&&receipt.fingerprint===stamp;return {ready,connectionStatus:ready?'passed':receipt.status==='passed'||receipt.status==='testing'?'untested':receipt.status,testedAt:ready?receipt.testedAt:undefined};}
export function savedModelIds(dataDir:string){return Object.keys(read(dataDir).models);}
export async function requireReadyModel(runtime:ModelRuntime,dataDir:string,id:string){
  if(process.env.FRIEND_PI_DESKTOP_MANAGED==='1'&&process.env.FRIEND_PI_DESKTOP_MODEL_UNAVAILABLE==='1')throw new Error('历史型号不可用，请重新配置并通过连接测试');
  await runtime.refresh({allowNetwork:false});const stamp=await fingerprint(runtime,id),receipt=read(dataDir).models[id];
  if(!receipt||receipt.status!=='passed'||!receipt.fingerprint||receipt.fingerprint!==stamp)throw new Error('请在设置 → 模型中保存此型号并通过连接测试，再发送消息');
  const model=resolveModel(runtime,id);if(!model)throw new Error('已配置的型号不可用，请重新配置');return model;
}
const guarded=new WeakSet<ModelRuntime>();
/** Intercept public request APIs, including native compaction and cache warming,
 * without modifying Pi's loop or history. Standalone consumers opt out by default. */
export function guardDesktopModelRequests(runtime:ModelRuntime,dataDir:string){
  if(process.env.FRIEND_PI_DESKTOP_MANAGED!=='1'||guarded.has(runtime))return;
  guarded.add(runtime);
  for(const method of ['stream','streamSimple'] as const){
    const original=runtime[method].bind(runtime);
    Object.defineProperty(runtime,method,{value:(model:Model<Api>,context:Context,options:Record<string,unknown>|undefined)=>{
      const output=createAssistantMessageEventStream();
      void (async()=>{try{const verified=await requireReadyModel(runtime,dataDir,`${model.provider}/${model.id}`);const stream=original(verified,context,options);for await(const event of stream)output.push(event);output.end(await stream.result());}catch{const error:AssistantMessage={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),stopReason:'error',errorMessage:'模型未通过当前配置的连接测试，请重新配置并测试',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};output.push({type:'error',reason:'error',error});output.end(error);}})();return output;
    }});
  }
}
export async function testConfiguredModel(runtime:ModelRuntime,dataDir:string,id:string,timeoutMs=20000){
  await runtime.refresh({allowNetwork:false});const ledger=read(dataDir),previous=ledger.models[id];if(!previous)throw new Error('请先保存此型号的配置');
  const model=resolveModel(runtime,id);if(!model)throw new Error('型号尚未配置');
  const operation=randomUUID(),revision=previous.revision;ledger.models[id]={revision,status:'testing',operation};write(dataDir,ledger);
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('模型连接测试超时，请检查地址和网络'));},timeoutMs);});
    const stamp=await Promise.race([fingerprint(runtime,id),timeout]);if(!stamp)throw new Error('模型连接测试失败，请检查凭证');const started=read(dataDir).models[id];if(started?.operation!==operation||started.revision!==revision)throw new Error('配置在测试期间发生变化，请重新测试');
    const response=await Promise.race([runtime.complete(model,{messages:[{role:'user',content:[{type:'text',text:'Reply only OK.'}],timestamp:Date.now()}]},{maxTokens:16,signal:controller.signal}),timeout]);
    if(response.stopReason==='error'||response.stopReason==='aborted'||!visibleText(response.content).trim())throw new Error('模型连接测试失败，请检查型号、凭证和接口协议');
    await runtime.refresh({allowNetwork:false});const finalStamp=await Promise.race([fingerprint(runtime,id),timeout]),latest=read(dataDir),current=latest.models[id];
    if(current?.revision!==revision||current.operation!==operation||stamp!==finalStamp)throw new Error('配置在测试期间发生变化，请重新测试');
    latest.models[id]={revision,status:'passed',fingerprint:stamp,testedAt:new Date().toISOString()};write(dataDir,latest);return {ok:true,modelId:id};
  } catch(error) {
    const latest=read(dataDir);if(latest.models[id]?.operation===operation){latest.models[id]={revision,status:'failed'};write(dataDir,latest);}
    // Provider errors can echo secrets, request headers or credential-bearing URLs.
    if(error instanceof Error&&/^(模型连接测试|配置在测试期间)/.test(error.message))throw error;
    throw new Error('模型连接测试失败，请检查型号、凭证、接口协议和网络');
  } finally {clearTimeout(timer);}
}
