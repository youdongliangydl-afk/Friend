import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, realpathSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { SessionManager, getAgentDir, ModelRuntime } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {getSupportedThinkingLevels} from '@earendil-works/pi-ai';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import {requireReadyModel,savedModelIds} from './model-readiness.js';
export {guardDesktopModelRequests,requireReadyModel,testConfiguredModel,registerSavedModel,invalidateProvider,savedModelIds,modelReadiness} from './model-readiness.js';
const desktopVerificationRuntimes=new WeakMap<object,Promise<ModelRuntime>>();

export type JsonObject = Record<string, unknown>;
export type ExecutionMode = 'single' | 'team' | 'swarm';
export {parsePermissionMode,permissionDecision,destructiveCommand,readOnlyCommand,toolPermissionRequest,temporaryPermission,temporaryPermissionMatches,assertTemporaryArtifactPath,permissionPath} from './permissions.js';
import {permissionDecision,temporaryPermission,temporaryPermissionMatches,type PermissionMode,type PermissionRequest} from './permissions.js';
export type {PermissionMode,PermissionRequest} from './permissions.js';
export interface HostPolicy {
  v:1; revision:number; runId?:string; stage:string; canSwitchRole:boolean; unsettledTools:number;
  tools:string[]; writeScopes:string[]; executionMode:ExecutionMode; planMode:boolean;
  modelId?:string; thinkingLevel?:string; goalId?:string;executionStopped?:boolean;executionWaitReason?:string;permissionMode?:PermissionMode;temporaryWriteRoot?:string;
}
export interface SourceRef { sessionId: string; entryId: string; label?: string;start?:number;end?:number;hash?:string;factId?:string }
export interface HistoryItem { id: string; parentId: string | null; type: string; timestamp: string; role?: string; text: string;userText?:string }
export interface Bus { emit(channel: string, data: unknown): void; on(channel: string, handler: (data: unknown) => void): () => void }
export interface PluginContext {
  origin?: 'user' | 'agent' | 'plugin';
  dataDir: string; agentDir?: string; projectDir: string; projectId: string; sessionId: string; sessionFile?: string;
  signal?: AbortSignal; modelId?: string; thinkingLevel?: string;runId?:string; isIdle(): boolean;
  executionMode?:ExecutionMode; policy?:HostPolicy; availableModels?:{id:string;thinkingLevels:string[]}[];
  approvePermission?(request:PermissionRequest):Promise<boolean>;
  history(): HistoryItem[]; readSource(source: SourceRef): HistoryItem;
  complete(prompt: string, options?: { signal?: AbortSignal; maxTokens?: number }): Promise<string>;
  applyModel?(modelId:string,thinkingLevel?:string):Promise<void>;
  request(plugin: string, action: string, input?: JsonObject, timeoutMs?: number): Promise<unknown>;
  emit(event: string, data: unknown): void; notify(message: string, level?: 'info'|'warning'|'error'): void;
  appendEntry(type: string, data: unknown): void;
}
export interface PluginController {
  dispatch(action: string, input: JsonObject, context: PluginContext): unknown | Promise<unknown>;
  snapshot(context: PluginContext): unknown;
  dispose?(): void | Promise<void>;
}
export interface StoredDocument<T> { key: string; revision: number; value: T }

export class ConflictError extends Error { constructor(message = '版本已变化，请刷新后重试') { super(message); this.name = 'ConflictError'; } }
export function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('参数必须是对象');
  return value as JsonObject;
}
export function text(value: unknown, name = '内容', max = 200000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${name}无效`);
  return value.trim();
}
export function projectIdentity(path: string): string { return createHash('sha256').update(realpathSync(resolve(path))).digest('hex').slice(0, 24); }
export function digest(value: unknown): string { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex'); }
export function dataDirectory(): string { const dir = resolve(process.env.FRIEND_PI_DATA_DIR || join(homedir(), '.local', 'share', 'friend-pi')); mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; }
/** Pi's extension context does not expose the SDK's agentDir. SDK hosts advertise their
 * actual directory; native Pi uses its public getAgentDir (including its native override).
 * This carries only the path, never authentication material or private runtime fields. */
export function agentDirectory(): string { return resolve(process.env.FRIEND_PI_AGENT_DIR || getAgentDir()); }
export function atomicWrite(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600 }); renameSync(temporary, path);
}

/** Small namespace-owned durable records. SQLite serializes compare-and-swap writes across Pi processes. */
export class RecordStore {
  readonly db: DatabaseSync;
  private committed: (()=>void)[]=[];
  constructor(readonly namespace: string, readonly dataDir = dataDirectory()) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, 'plugins.sqlite'));
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS documents(namespace TEXT NOT NULL,key TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(namespace,key))');
  }
  get<T>(key: string): StoredDocument<T> | undefined {
    const row = this.db.prepare('SELECT key,revision,json FROM documents WHERE namespace=? AND key=?').get(this.namespace,key);
    return row ? { key: String(row.key), revision: Number(row.revision), value: JSON.parse(String(row.json)) as T } : undefined;
  }
  list<T>(prefix = ''): StoredDocument<T>[] {
    return this.db.prepare('SELECT key,revision,json FROM documents WHERE namespace=? AND substr(key,1,?)=? ORDER BY key').all(this.namespace,prefix.length,prefix).map(row => ({ key: String(row.key), revision: Number(row.revision), value: JSON.parse(String(row.json)) as T }));
  }
  put<T>(key: string, value: T, expectedRevision?: number | null): StoredDocument<T> {
    return this.transaction(() => {
      const previous = this.get<T>(key);
      if (expectedRevision === null ? !!previous : expectedRevision !== undefined && previous?.revision !== expectedRevision) throw new ConflictError();
      const revision = (previous?.revision || 0) + 1;
      this.db.prepare('INSERT INTO documents(namespace,key,revision,json) VALUES(?,?,?,?) ON CONFLICT(namespace,key) DO UPDATE SET revision=excluded.revision,json=excluded.json').run(this.namespace,key,revision,JSON.stringify(value));
      return {key,revision,value};
    });
  }
  remove(key: string): void { this.db.prepare('DELETE FROM documents WHERE namespace=? AND key=?').run(this.namespace,key); }
  afterCommit(fn:()=>void):void {if(this.db.isTransaction)this.committed.push(fn);else {try{fn();}catch {/* Persistence succeeded; refresh notifications cannot roll it back. */}}}
  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    const offset=this.committed.length;
    let value:T;
    try { value=fn(); this.db.exec('COMMIT'); } catch (error) { this.committed.splice(offset);this.db.exec('ROLLBACK'); throw error; }
    const callbacks=this.committed.splice(offset);for(const callback of callbacks){try{callback();}catch {/* Durable state is authoritative; consumers refresh on restart. */}}
    return value;
  }
  close(): void { this.db.close(); }
}

export function visibleText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => typeof part === 'object' && part !== null && 'type' in part && part.type === 'text' && 'text' in part ? String(part.text) : '').filter(Boolean).join('\n');
  return '';
}
export function historyItems(entries: readonly unknown[]): HistoryItem[] {
  const automatic=new Map<string,string>();for(const raw of entries){const entry=object(raw);if(entry.type==='custom'&&entry.customType==='friend-pi.runtime-wake.input'&&entry.data){const data=object(entry.data);automatic.set(String(data.entryId),String(data.hash));}}
  const boundaries=new Map<string,{textEnd:number;hash:string}>();for(const raw of entries){const entry=object(raw);if(entry.type==='custom'&&entry.customType==='friend-pi.input.v1'&&entry.data){const data=object(entry.data);boundaries.set(String(data.entryId),data as unknown as {textEnd:number;hash:string});}}
  return entries.map(raw => {
    const entry = object(raw); const message = entry.message && typeof entry.message === 'object' ? object(entry.message) : undefined;
    const value=message?visibleText(message.content):entry.type==='compaction'||entry.type==='branch_summary'?String(entry.summary||''):entry.type==='custom_message'?visibleText(entry.content):'';const boundary=boundaries.get(String(entry.id));const userText=boundary&&digest(value.slice(0,boundary.textEnd))===boundary.hash?value.slice(0,boundary.textEnd):undefined;
    return { id: String(entry.id), parentId: entry.parentId ? String(entry.parentId) : null, type: String(entry.type), timestamp: String(entry.timestamp || ''), role: automatic.get(String(entry.id))===digest(value)?'custom':message?.role ? String(message.role) : undefined, text:value,userText };
  });
}
/** Source offsets use UTF-16, matching Pi's JavaScript text. Old whole-entry refs remain readable. */
export function readSourceSpan(item:HistoryItem,ref:SourceRef):string {
  const start=ref.start??0,end=ref.end??item.text.length;
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end<start||end>item.text.length)throw new Error('来源片段范围已不可用');
  const value=item.text.slice(start,end);if(ref.hash&&digest(value)!==ref.hash)throw new Error('来源片段摘要不匹配');return value;
}
export function sourceFactRefs(item:HistoryItem,sessionId:string):SourceRef[] {
  const result:SourceRef[]=[];
  const chunks=(item.userText??item.text).matchAll(/[^。！？!?;；\n]+[。！？!?;；\n]?/gu);
  for(const chunk of chunks){const base=chunk.index!,parts=chunk[0].split(/(?<=[,，])(?=\s*(?:必须|不得|不要|保留|只允许|不能|must\b|keep\b|never\b))/iu);let offset=base;
    for(const part of parts){const leading=part.length-part.trimStart().length;const value=part.trim();if(value){const start=offset+leading,end=start+value.length,hash=digest(value);result.push({sessionId,entryId:item.id,start,end,hash,factId:digest([item.id,start,end,hash]).slice(0,32)});}offset+=part.length;}}
  return result;
}
export function isSessionDeleted(dataDir:string,sessionId:string):boolean {const store=new RecordStore('sessions',dataDir);try{return !!store.get(`tombstone:${sessionId}`);}finally{store.close();}}
export function learningHostAvailable(dataDir:string):boolean {
  const store=new RecordStore('runtime',dataDir);try{const host=store.get<{pid:number;expiresAt:number}>('learning-host')?.value;if(!host||host.expiresAt<Date.now())return false;try{process.kill(host.pid,0);return true;}catch{return false;}}finally{store.close();}
}
const REQUEST = 'friend-pi:v1:request';
const RESPONSE = 'friend-pi:v1:response';
interface PluginPending {resolve(value:unknown):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}
const pluginRouters=new WeakMap<Bus,{pending:Map<string,PluginPending>;off():void}>();
export function requestPlugin(bus:Bus,plugin:string,action:string,input:JsonObject={},timeoutMs=120000,origin:'user'|'plugin'='plugin'):Promise<unknown>{
 let router=pluginRouters.get(bus);
 if(!router){const pending=new Map<string,PluginPending>();const off=bus.on(RESPONSE,raw=>{if(!raw||typeof raw!=='object')return;const response=object(raw),call=pending.get(String(response.id));if(!call)return;pending.delete(String(response.id));clearTimeout(call.timer);if(!pending.size){off();pluginRouters.delete(bus);}response.error?call.reject(new Error(String(response.error))):call.resolve(response.result);});router={pending,off};pluginRouters.set(bus,router);}
 const active=router,id=randomUUID();return new Promise((resolveResult,reject)=>{const release=()=>{active.pending.delete(id);if(!active.pending.size){active.off();pluginRouters.delete(bus);}};const timer=setTimeout(()=>{release();reject(new Error(`${plugin} 不可用或操作超时`));},timeoutMs);active.pending.set(id,{resolve:resolveResult,reject,timer});try{bus.emit(REQUEST,{v:1,id,plugin,action,input,origin});}catch(error){clearTimeout(timer);release();reject(error instanceof Error?error:new Error(String(error)));}});
}
export function makeContext(pi: ExtensionAPI, ctx: ExtensionContext, origin: 'user'|'agent'|'plugin' = 'agent'): PluginContext {
  const model = ctx.model;
  const thinkingLevel = pi.getThinkingLevel();
  const agentDir = agentDirectory();
  const dataDir = dataDirectory(); const sessionId = ctx.sessionManager.getSessionId(); const sessionFile = ctx.sessionManager.getSessionFile();
  let policy:HostPolicy|undefined;
  // A host answers through its own Pi bus. Native packages remain independent
  // when no desktop host is present; no module singleton carries authority.
  pi.events?.emit('friend-pi:v1:policy',{v:1,sessionId,reply:(value:HostPolicy)=>{policy=value;}});
  const availableModels=(ctx.modelRegistry?.getAvailable?.()||[]).filter(item=>process.env.FRIEND_PI_DESKTOP_MANAGED!=='1'||savedModelIds(dataDir).includes(`${item.provider}/${item.id}`)).map(item=>({id:`${item.provider}/${item.id}`,thinkingLevels:getSupportedThinkingLevels(item)}));
  if (sessionFile) {
    const registry = new RecordStore('sessions',dataDir); registry.put(sessionId,{path: sessionFile,projectDir:ctx.cwd}); registry.close();
  }
  return {
    origin, dataDir, agentDir, projectDir:ctx.cwd, projectId:projectIdentity(ctx.cwd), sessionId, sessionFile, signal:ctx.signal,
    modelId:model ? `${model.provider}/${model.id}` : undefined,thinkingLevel,runId:process.env.FRIEND_PI_RUN_ID,
    policy,executionMode:policy?.executionMode,availableModels,
    applyModel:async(modelId,level)=>{
      if(!policy?.canSwitchRole||policy.unsettledTools)throw new Error('型号切换未到宿主安全阶段');
      const slash=modelId.indexOf('/'),target=ctx.modelRegistry.find(modelId.slice(0,slash),modelId.slice(slash+1));
      if(!target||!availableModels.some(item=>item.id===modelId))throw new Error('角色型号不可用');
      if(process.env.FRIEND_PI_DESKTOP_MANAGED==='1'){let verifying=desktopVerificationRuntimes.get(ctx.modelRegistry);if(!verifying){verifying=ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:join(agentDir,'models.json'),allowModelNetwork:false}).then(async runtime=>{if(process.env.FRIEND_PI_TEST_PROVIDER==='1')await installFixtureProvider(runtime);return runtime;});desktopVerificationRuntimes.set(ctx.modelRegistry,verifying);}await requireReadyModel(await verifying,dataDir,modelId);}
      if(level&&!getSupportedThinkingLevels(target).includes(level as never))throw new Error('角色思考等级不可用');
      if(!await pi.setModel(target))throw new Error('角色型号切换失败');if(level)pi.setThinkingLevel(level as never);
    },
    isIdle:() => ctx.isIdle(), history:() => historyItems(ctx.sessionManager.getBranch()),
    readSource: source => {
      if(isSessionDeleted(dataDir,source.sessionId))throw new Error('来源会话已删除');
      let entries: readonly unknown[];
      if (source.sessionId === sessionId) entries = ctx.sessionManager.getEntries();
      else {
        const registry = new RecordStore('sessions',dataDir); const saved = registry.get<{path:string;projectDir:string}>(source.sessionId); registry.close();
        let personalSource=false;if(saved&&projectIdentity(saved.value.projectDir)!==projectIdentity(ctx.cwd)){const memories=new RecordStore('memory',dataDir);try{if(memories.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_records'").get())personalSource=(origin==='user'&&memories.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_versions'").get()?memories.db.prepare("SELECT json FROM memory_versions WHERE json_extract(json,'$.scope')='personal'").all():memories.db.prepare("SELECT json FROM memory_records WHERE scope='personal' AND status='active' AND enabled=1").all()).some(row=>{const record=JSON.parse(String(row.json));return Array.isArray(record.sources)&&record.sources.some((ref:SourceRef)=>ref.sessionId===source.sessionId&&ref.entryId===source.entryId&&ref.start===source.start&&ref.end===source.end&&ref.hash===source.hash);});}finally{memories.close();}}
        if (!saved || !personalSource&&projectIdentity(saved.value.projectDir) !== projectIdentity(ctx.cwd) || !existsSync(saved.value.path)) throw new Error('来源不存在或不属于当前项目及有效个人记忆');
        entries = SessionManager.open(saved.value.path).getEntries();
      }
      const item = historyItems(entries).find(entry => entry.id === source.entryId); if (!item) throw new Error('来源已不可用');readSourceSpan(item,source); return item;
    },
    complete:async (prompt, options = {}) => {
      if (!model) throw new Error('请先配置模型');
      let executionModel=model;
      if(process.env.FRIEND_PI_DESKTOP_MANAGED==='1'){let verifying=desktopVerificationRuntimes.get(ctx.modelRegistry);if(!verifying){verifying=(async()=>{const runtime=await ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:join(agentDir,'models.json'),allowModelNetwork:false});if(process.env.FRIEND_PI_TEST_PROVIDER==='1')await installFixtureProvider(runtime);return runtime;})();desktopVerificationRuntimes.set(ctx.modelRegistry,verifying);}executionModel=await requireReadyModel(await verifying,dataDir,`${model.provider}/${model.id}`);await ctx.modelRegistry.refresh({allowNetwork:false});}
      const result = await ctx.modelRegistry.complete(executionModel, {messages:[{role:'user',content:[{type:'text',text:prompt}],timestamp:Date.now()}]}, {signal: options.signal, maxTokens:options.maxTokens || 2048,...(thinkingLevel!=='off'?{reasoning:thinkingLevel}:{})});
      if (result.stopReason === 'error' || result.stopReason === 'aborted') throw new Error(result.errorMessage || '模型调用未完成');
      return visibleText(result.content);
    },
    approvePermission:async request=>{
      if(ctx.signal?.aborted)return false;
      request=temporaryPermission(request,policy?.temporaryWriteRoot,ctx.cwd);
      const mode=policy?.permissionMode||'auto',decision=permissionDecision(mode,request);
      const approved=decision==='allow'||await ctx.ui.confirm('确认'+request.operation,request.message);
      if(ctx.signal?.aborted||!temporaryPermissionMatches(request,policy?.temporaryWriteRoot,ctx.cwd))return false;
      pi.appendEntry('friend-pi.permission.decision',{v:1,mode,operation:request.operation,messageHash:digest(request.message),approved,source:decision==='allow'?'automatic':'user',policyRevision:policy?.revision});return approved;
    },
    request:(plugin,action,input,timeout) => requestPlugin(pi.events,plugin,action,input,timeout),
    emit:(event,data) => pi.events.emit('friend-pi:v1:event',{pluginEvent:event,sessionId,data}),
    notify:(message,level='info') => ctx.ui.notify(message,level),
    appendEntry:(type,data) => pi.appendEntry(type,data),
  };
}

export interface PluginRegistrationOptions {toolDescription?:string;actionEnum?:readonly string[]}
/** Connect a native Pi extension and desktop requests to the same controller. */
export function registerPlugin(pi: ExtensionAPI, name: string, controller: PluginController, description: string, options:PluginRegistrationOptions={}): void {
  if(options.actionEnum&&!options.actionEnum.length)throw new Error('插件动作枚举不能为空');
  let current: ExtensionContext | undefined;
  const call = async (action: string, input: JsonObject, ctx: ExtensionContext, origin: 'user'|'agent'|'plugin' = 'agent') => {
    const context = makeContext(pi,ctx,origin); const result = action === 'snapshot' ? controller.snapshot(context) : await controller.dispatch(action,input,context);
    if(!new Set(['snapshot','list','read','search','get','status','result','logs','versions','member.list','member.history','role.snapshot','role.read','role.versions','template.list','template.read','shared.readVersion','shared.conflicts','invalidation.snapshot','history.search','history.read','history.around']).has(action))context.emit(`${name}.changed`,controller.snapshot(context)); return result;
  };
  pi.on('session_start',(_event,ctx) => { current = ctx; makeContext(pi,ctx); });
  pi.on('before_agent_start',(_event,ctx) => { current = ctx; });
  const off = pi.events.on(REQUEST, raw => {
    if (!raw || typeof raw !== 'object') return;
    const request = object(raw); if (request.v !== 1 || request.plugin !== name) return;
    void (async () => {
      try { if (!current) throw new Error('会话尚未就绪'); const result = await call(text(request.action),object(request.input || {}),current,request.origin === 'user' ? 'user' : 'plugin'); pi.events.emit(RESPONSE,{id:request.id,result}); }
      catch (error) { pi.events.emit(RESPONSE,{id:request.id,error:error instanceof Error ? error.message : String(error)}); }
    })();
  });
  pi.registerTool({
    name:`friend_${name.replaceAll('-','_')}`,label:description,description:options.toolDescription||description,
    parameters:Type.Object({action:options.actionEnum?Type.Union(options.actionEnum.map(action=>Type.Literal(action))):Type.String(),input:options.actionEnum?Type.Record(Type.String(),Type.Unknown()):Type.Optional(Type.Record(Type.String(),Type.Unknown()))},options.actionEnum?{additionalProperties:false}:{}),
    async execute(_id,params,_signal,_update,ctx) { const result = await call(params.action,params.input || {},ctx); return {content:[{type:'text',text:JSON.stringify(result)}],details:result}; },
  });
  pi.registerCommand(name,{description,handler:async(args,ctx) => {
    const space = args.indexOf(' '); const action = args ? (space < 0 ? args : args.slice(0,space)) : 'snapshot'; const rest = space < 0 ? '' : args.slice(space+1);
    const input = rest.trim().startsWith('{') ? object(JSON.parse(rest)) : rest ? {text:rest} : {};
    const result = await call(action,input,ctx,'user'); ctx.ui.notify(JSON.stringify(result,null,2),'info');
  }});
  pi.on('session_shutdown',async() => { current = undefined; off(); await controller.dispose?.(); });
}

export function parseModelJson(value: string): JsonObject {
  const trimmed=value.trim();
  try { return object(JSON.parse(trimmed)); }
  catch(error) { if(!(error instanceof SyntaxError))throw error; }
  // Only an unambiguous Markdown block is a fallback. Do not guess objects from prose,
  // evaluate JavaScript, or change field types that the caller still has to validate.
  const lines=trimmed.split(/\r?\n/);const fences:{index:number;language:string}[]=[];
  for(let index=0;index<lines.length;index++){const match=/^[ \t]*```(.*?)[ \t]*$/.exec(lines[index]);if(match)fences.push({index,language:match[1].trim()});}
  if(fences.length!==2||!['','json'].includes(fences[0].language.toLowerCase())||fences[1].language!=='')throw new Error('模型结果需要完整 JSON 对象或恰好一个 JSON 代码块');
  return object(JSON.parse(lines.slice(fences[0].index+1,fences[1].index).join('\n').trim()));
}

/** Explicit test-only provider. Never registered for an ordinary launch. */
export async function installFixtureProvider(runtime:ModelRuntime) {
  const fixture=fauxProvider({api:'friend-fixture-api',provider:'friend-fixture',models:[{id:'offline',name:'离线验证模型（非真实服务）',reasoning:false,input:['text','image'],contextWindow:32768,maxTokens:4096},{id:'alternate',name:'离线替代模型（非真实服务）',reasoning:false,input:['text','image'],contextWindow:32768,maxTokens:4096}],tokensPerSecond:300});
  const respond: Parameters<typeof fixture.setResponses>[0][number] = (context,options) => {
    fixture.appendResponses([respond]);
    const messages=context.messages;const content=messages.map(message=>message.role==='system'?JSON.stringify(message):visibleText(message.content)).join('\n');
    const hasResult=messages.some(message=>message.role==='toolResult');
    const latestUser=visibleText([...messages].reverse().find(message=>message.role==='user')?.content);
    if(latestUser.includes('QA_TOOL_GROUPS')){
      const recent=messages.slice(messages.findLastIndex(message=>message.role==='user'));
      const results=recent.filter(message=>message.role==='toolResult');
      if(!results.length)return fauxAssistantMessage([{type:'text',text:'先检查项目，再查看图片；工具过程可按组展开。'},{type:'thinking',thinking:'连续的工具与思考应合为一组，正文保持原顺序。'},{type:'toolCall',id:'qa-group-read-'+randomUUID(),name:'read',arguments:{path:'README.md'}},{type:'toolCall',id:'qa-group-command-'+randomUUID(),name:'bash',arguments:{command:'pwd'}}],{stopReason:'toolUse'});
      if(results.length===2)return fauxAssistantMessage([{type:'toolCall',id:'qa-group-image-'+randomUUID(),name:'read',arguments:{path:'qa-preview.png'}},{type:'toolCall',id:'qa-group-failed-'+randomUUID(),name:'read',arguments:{path:'qa-missing-file.txt'}}],{stopReason:'toolUse'});
      return fauxAssistantMessage('工具分组验证完成。图片可在详情中预览，缺失文件的失败状态应保留。');
    }
    if(messages.some(message=>message.role==='system'&&message.toolsAdded?.some(tool=>tool.name==='swarm_review_result'))){
      if(!messages.some(message=>message.role==='toolResult'&&message.toolName==='swarm_review_result'))return fauxAssistantMessage(fauxToolCall('swarm_review_result',content.includes('QA_PERSISTENT_TEAM')&&/"id":"writer"[^}]*"resultRevision":1/.test(content)?{approved:false,findings:'离线验收：第一版需定向返工，用于验证受影响任务和重新复核',taskIds:['writer']}:{approved:true,findings:'离线测试复核，不代表真实模型质量'}),{stopReason:'toolUse'});
      return fauxAssistantMessage('离线复核说明文字；结构化工具提交才是验收结果。');
    }
    if(content.includes('QA_CONFIRM')&&!hasResult)return fauxAssistantMessage(fauxToolCall('bash',{command:'rm -f fixture-confirm.txt'}),{stopReason:'toolUse'});
    if(latestUser.includes('QA_HOLD'))return new Promise(resolveHold=>{let timer:ReturnType<typeof setTimeout>;const finish=(aborted:boolean)=>{clearTimeout(timer);options?.signal?.removeEventListener('abort',abort);resolveHold(fauxAssistantMessage(aborted?'QA_WAIT_ABORTED':'QA_WAIT_COMPLETED：只读等待完成。',{stopReason:aborted?'aborted':'stop'}));};const abort=()=>finish(true);if(options?.signal?.aborted){finish(true);return;}timer=setTimeout(()=>finish(false),30000);options?.signal?.addEventListener('abort',abort,{once:true});});
    if(latestUser.includes('QA_SLOW'))return fauxAssistantMessage('正在进行可中止的离线流式验证。'.repeat(300));
    if(content.includes('FRIEND_PI_REBUILD_JSON')){
      try{const entries=JSON.parse(content.slice(content.lastIndexOf('原始条目：')+'原始条目：'.length)) as {id:string;role:string;text:string}[];const user=[...entries].reverse().find(item=>item.role==='user')||entries.at(-1);if(user)return fauxAssistantMessage(JSON.stringify({goal:{text:user.text.slice(0,400),sourceEntryIds:[user.id]},constraints:[],decisions:[],unfinished:[],topics:[]}));}catch{}
    }
    if(content.includes('只返回JSON，结构为'))return fauxAssistantMessage(JSON.stringify({v:1,title:'离线工作流',goal:'只读检查项目',maxWorkers:4,nodes:[{id:'inspect',title:'读取',prompt:'只读说明当前项目',dependencies:[],mode:'read'},{id:'summarize',title:'汇总',prompt:'汇总读取成果',dependencies:['inspect'],mode:'read'}]}));
    if(content.includes('你是项目经验提取器'))return fauxAssistantMessage('{"memories":[]}');
    if(content.includes('提炼一个文本方法候选'))return fauxAssistantMessage('{"method":null}');
    if(content.includes('仅输出JSON。任务'))return fauxAssistantMessage('{"result":true}');
    if(content.includes('把目标拆为可交付成果任务'))return fauxAssistantMessage(JSON.stringify({tasks:[{id:'task-1',title:'执行离线验证',prompt:'QA_WRITE',dependencies:[],mode:'write',writeScopes:['.']}]}));
    if(content.includes('请用 friend_swarm create/start')){
      const results=messages.filter(message=>message.role==='toolResult'&&message.toolName==='friend_swarm');
      if(!results.length)return fauxAssistantMessage(fauxToolCall('friend_swarm',{action:'create',input:content.includes('QA_PERSISTENT_TEAM')?{goal:'QA_PERSISTENT_TEAM 持续团队界面验收',tasks:[{id:'writer',title:'文档队友',prompt:'QA_WRITE',dependencies:[],mode:'write',writeScopes:['.']},{id:'reader',title:'阅读队友',prompt:'QA_TIMELINE',dependencies:[],mode:'read',writeScopes:['.']},{id:'sleeper',title:'分析队友',prompt:'QA_SLOW',dependencies:[],mode:'read',writeScopes:['.']}]}:{goal:'离线 Swarm SDK 验证',tasks:[{id:'implementation',title:'执行',prompt:'QA_WRITE',dependencies:[],mode:'write',writeScopes:['.']},{id:'inspect',title:'检查',prompt:'只读说明当前项目',dependencies:[],mode:'read',writeScopes:['.']}]}}),{stopReason:'toolUse'});
      try{const result=JSON.parse(visibleText(results.at(-1)!.content));if(result.id&&result.status==='created')return fauxAssistantMessage(fauxToolCall('friend_swarm',{action:'start',input:{graphId:result.id}}),{stopReason:'toolUse'});}catch{}
      return fauxAssistantMessage('离线 Swarm 已派发。成员执行和复核状态以任务图为准。');
    }
    if(content.includes('QA_TERMINAL')&&!hasResult)return fauxAssistantMessage(fauxToolCall('friend_terminal',{action:'create',name:'QA Agent service',command:"printf '%s%s\\n' 'AGENT_' 'SERVICE_OK'"}),{stopReason:'toolUse'});
    if(content.includes('QA_TIMELINE')&&!hasResult)return fauxAssistantMessage([{type:'text',text:'先读取 README，再列目录。'},{type:'thinking',thinking:'只读检查当前工作目录。'},{type:'toolCall',id:'qa-read',name:'read',arguments:{path:'README.md'}},{type:'text',text:'然后列出目录。'},{type:'toolCall',id:'qa-ls',name:'ls',arguments:{path:'.'}}],{stopReason:'toolUse'});
    if(content.includes('QA_TIMELINE'))return fauxAssistantMessage('只读检查完成。\n\n'+Array.from({length:20},(_,i)=>'第 '+(i+1)+' 项：工具记录应随会话正文一起滚动。').join('\n\n'));
    if(content.includes('QA_GOAL')&&content.includes('当前长期目标')){const goals=messages.filter(message=>message.role==='toolResult'&&message.toolName==='friend_goal');let prior;try{prior=JSON.parse(visibleText(goals.at(-1)?.content));}catch{}if(['completed','blocked','stopped','paused'].includes(prior?.status))return fauxAssistantMessage('目标完成，已保留实际检查说明。');return fauxAssistantMessage(fauxToolCall('friend_goal',{action:prior?.progress?'complete':'update',input:prior?.progress?{}:{progress:'实际只读分析已完成，无项目写入。'}}),{stopReason:'toolUse'});}
    if(content.includes('QA_PLAN_SUBMIT')){if(!messages.some(message=>message.role==='toolResult'&&message.toolName==='friend_plan'))return fauxAssistantMessage(fauxToolCall('friend_plan',{action:'submit',body:'Read README.md and verify the documented UTF-8 constraint. Change no files.'}),{stopReason:'toolUse'});return fauxAssistantMessage('The complete plan was submitted. Please approve it.');}
    if(content.includes('QA_OUTSIDE_FILE_URL')&&!hasResult)return fauxAssistantMessage(fauxToolCall('write',{path:'@'+pathToFileURL(resolve(process.env.FRIEND_PI_PROJECT||process.cwd(),'../outside url.txt')).href,content:'URL scope fixture.\n'}),{stopReason:'toolUse'});
    if(content.includes('QA_OUTSIDE_WRITE')&&!hasResult)return fauxAssistantMessage(fauxToolCall('write',{path:'../outside-result.txt',content:'Explicitly approved fixture output.\n'}),{stopReason:'toolUse'});
    if(content.includes('QA_WRITE')&&!hasResult)return fauxAssistantMessage(fauxToolCall('write',{path:'fixture-result.txt',content:'Friend-Pi SDK tool execution verified.\n'}),{stopReason:'toolUse'});
    if(/APPROVE|approved|独立复核|独立审查/.test(content))return fauxAssistantMessage('{"approved":true,"findings":"离线测试复核，不代表真实模型质量"}');
    if(/仅输出JSON|仅输出 JSON/.test(content))return fauxAssistantMessage('{"result":true,"memories":[],"items":[],"summary":"离线验证工作现场，保留来源与当前目标","goals":[],"constraints":[],"decisions":[],"unfinished":[]}');
    return fauxAssistantMessage('离线验证已完成。此回答来自明确启用的测试 Provider，不是来自真实模型。');
  };
  fixture.setResponses([respond]);runtime.registerNativeProvider(fixture.provider);await runtime.setRuntimeApiKey('friend-fixture','fixture');return fixture.getModel('offline');
}

export {ContinuationCoordinator,TaskLedger,GoalLedger} from './runtime.js';
export type {TaskRecord,GoalRecord,AcceptanceCheck,CheckEvidence,WakeFrame} from './runtime.js';
