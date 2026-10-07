import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, realpathSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { SessionManager, getAgentDir } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

export type JsonObject = Record<string, unknown>;
export interface SourceRef { sessionId: string; entryId: string; label?: string }
export interface HistoryItem { id: string; parentId: string | null; type: string; timestamp: string; role?: string; text: string }
export interface Bus { emit(channel: string, data: unknown): void; on(channel: string, handler: (data: unknown) => void): () => void }
export interface PluginContext {
  origin?: 'user' | 'agent' | 'plugin';
  dataDir: string; agentDir?: string; projectDir: string; projectId: string; sessionId: string; sessionFile?: string;
  signal?: AbortSignal; modelId?: string; thinkingLevel?: string; isIdle(): boolean;
  history(): HistoryItem[]; readSource(source: SourceRef): HistoryItem;
  complete(prompt: string, options?: { signal?: AbortSignal; maxTokens?: number }): Promise<string>;
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
  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); }
}

export function visibleText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(part => typeof part === 'object' && part !== null && 'type' in part && part.type === 'text' && 'text' in part ? String(part.text) : '').filter(Boolean).join('\n');
  return '';
}
export function historyItems(entries: readonly unknown[]): HistoryItem[] {
  return entries.map(raw => {
    const entry = object(raw); const message = entry.message && typeof entry.message === 'object' ? object(entry.message) : undefined;
    return { id: String(entry.id), parentId: entry.parentId ? String(entry.parentId) : null, type: String(entry.type), timestamp: String(entry.timestamp || ''), role: message?.role ? String(message.role) : undefined, text: message ? visibleText(message.content) : entry.type === 'compaction' || entry.type === 'branch_summary' ? String(entry.summary || '') : entry.type === 'custom_message' ? visibleText(entry.content) : '' };
  });
}
const REQUEST = 'friend-pi:v1:request';
const RESPONSE = 'friend-pi:v1:response';
export function requestPlugin(bus: Bus, plugin: string, action: string, input: JsonObject = {}, timeoutMs = 120000, origin: 'user'|'plugin' = 'plugin'): Promise<unknown> {
  const id = randomUUID();
  return new Promise((resolveResult,reject) => {
    const off = bus.on(RESPONSE, raw => {
      if (!raw || typeof raw !== 'object' || !('id' in raw) || raw.id !== id) return;
      clearTimeout(timer); off(); const response = object(raw);
      if (response.error) reject(new Error(String(response.error))); else resolveResult(response.result);
    });
    const timer = setTimeout(() => { off(); reject(new Error(`${plugin} 不可用或操作超时`)); }, timeoutMs);
    bus.emit(REQUEST, { v: 1, id, plugin, action, input, origin });
  });
}
export function makeContext(pi: ExtensionAPI, ctx: ExtensionContext, origin: 'user'|'agent'|'plugin' = 'agent'): PluginContext {
  const model = ctx.model;
  const thinkingLevel = pi.getThinkingLevel();
  const agentDir = agentDirectory();
  const dataDir = dataDirectory(); const sessionId = ctx.sessionManager.getSessionId(); const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile) {
    const registry = new RecordStore('sessions',dataDir); registry.put(sessionId,{path: sessionFile,projectDir:ctx.cwd}); registry.close();
  }
  return {
    origin, dataDir, agentDir, projectDir:ctx.cwd, projectId:projectIdentity(ctx.cwd), sessionId, sessionFile, signal:ctx.signal,
    modelId:model ? `${model.provider}/${model.id}` : undefined,thinkingLevel,
    isIdle:() => ctx.isIdle(), history:() => historyItems(ctx.sessionManager.getBranch()),
    readSource: source => {
      let entries: readonly unknown[];
      if (source.sessionId === sessionId) entries = ctx.sessionManager.getEntries();
      else {
        const registry = new RecordStore('sessions',dataDir); const saved = registry.get<{path:string;projectDir:string}>(source.sessionId); registry.close();
        if (!saved || projectIdentity(saved.value.projectDir) !== projectIdentity(ctx.cwd) || !existsSync(saved.value.path)) throw new Error('来源不存在或不属于当前项目');
        entries = SessionManager.open(saved.value.path).getEntries();
      }
      const item = historyItems(entries).find(entry => entry.id === source.entryId); if (!item) throw new Error('来源已不可用'); return item;
    },
    complete:async (prompt, options = {}) => {
      if (!model) throw new Error('请先配置模型');
      const result = await ctx.modelRegistry.complete(model, {messages:[{role:'user',content:[{type:'text',text:prompt}],timestamp:Date.now()}]}, {signal: options.signal, maxTokens:options.maxTokens || 2048});
      if (result.stopReason === 'error' || result.stopReason === 'aborted') throw new Error(result.errorMessage || '模型调用未完成');
      return visibleText(result.content);
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
    context.emit(`${name}.changed`,controller.snapshot(context)); return result;
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
  const fixture=fauxProvider({provider:'friend-fixture',models:[{id:'offline',name:'离线验证模型（非真实服务）',reasoning:false,input:['text','image'],contextWindow:32768,maxTokens:4096}],tokensPerSecond:300});
  const respond: Parameters<typeof fixture.setResponses>[0][number] = (context) => {
    fixture.appendResponses([respond]);
    const messages=context.messages;const content=messages.map(message=>message.role==='system'?JSON.stringify(message):visibleText(message.content)).join('\n');
    const hasResult=messages.some(message=>message.role==='toolResult');
    if(messages.some(message=>message.role==='system'&&message.toolsAdded?.some(tool=>tool.name==='swarm_review_result'))){
      if(!messages.some(message=>message.role==='toolResult'&&message.toolName==='swarm_review_result'))return fauxAssistantMessage(fauxToolCall('swarm_review_result',{approved:true,findings:'离线测试复核，不代表真实模型质量'}),{stopReason:'toolUse'});
      return fauxAssistantMessage('离线复核说明文字；结构化工具提交才是验收结果。');
    }
    if(content.includes('QA_CONFIRM')&&!hasResult)return fauxAssistantMessage(fauxToolCall('bash',{command:'rm -f fixture-confirm.txt'}),{stopReason:'toolUse'});
    if(content.includes('QA_SLOW'))return fauxAssistantMessage('正在进行可中止的离线流式验证。'.repeat(300));
    if(content.includes('FRIEND_PI_REBUILD_JSON')){
      try{const entries=JSON.parse(content.slice(content.lastIndexOf('原始条目：')+'原始条目：'.length)) as {id:string;role:string;text:string}[];const user=[...entries].reverse().find(item=>item.role==='user')||entries.at(-1);if(user)return fauxAssistantMessage(JSON.stringify({goal:{text:user.text.slice(0,400),sourceEntryIds:[user.id]},constraints:[],decisions:[],unfinished:[],topics:[]}));}catch{}
    }
    if(content.includes('你是项目经验提取器'))return fauxAssistantMessage('{"memories":[]}');
    if(content.includes('提炼一个文本方法候选'))return fauxAssistantMessage('{"method":null}');
    if(content.includes('仅输出JSON。任务'))return fauxAssistantMessage('{"result":true}');
    if(content.includes('把目标拆为可交付成果任务'))return fauxAssistantMessage(JSON.stringify({tasks:[{id:'task-1',title:'执行离线验证',prompt:'QA_WRITE',dependencies:[],mode:'write',writeScopes:['.']}]}));
    if(content.includes('请用 friend_swarm create/start')){
      const results=messages.filter(message=>message.role==='toolResult'&&message.toolName==='friend_swarm');
      if(!results.length)return fauxAssistantMessage(fauxToolCall('friend_swarm',{action:'create',input:{goal:'离线 Swarm SDK 验证',tasks:[{id:'implementation',title:'执行',prompt:'QA_WRITE',dependencies:[],mode:'write',writeScopes:['.']},{id:'inspect',title:'检查',prompt:'只读说明当前项目',dependencies:[],mode:'read',writeScopes:['.']}]}}),{stopReason:'toolUse'});
      try{const result=JSON.parse(visibleText(results.at(-1)!.content));if(result.id&&result.status==='created')return fauxAssistantMessage(fauxToolCall('friend_swarm',{action:'start',input:{graphId:result.id}}),{stopReason:'toolUse'});}catch{}
      return fauxAssistantMessage('离线 Swarm 已派发。成员执行和复核状态以任务图为准。');
    }
    if(content.includes('QA_WRITE')&&!hasResult)return fauxAssistantMessage(fauxToolCall('write',{path:'fixture-result.txt',content:'Friend-Pi SDK tool execution verified.\n'}),{stopReason:'toolUse'});
    if(/APPROVE|approved|独立复核|独立审查/.test(content))return fauxAssistantMessage('{"approved":true,"findings":"离线测试复核，不代表真实模型质量"}');
    if(/仅输出JSON|仅输出 JSON/.test(content))return fauxAssistantMessage('{"result":true,"memories":[],"items":[],"summary":"离线验证工作现场，保留来源与当前目标","goals":[],"constraints":[],"decisions":[],"unfinished":[]}');
    return fauxAssistantMessage('离线验证已完成。此回答来自明确启用的测试 Provider，不是来自真实模型。');
  };
  fixture.setResponses([respond]);runtime.registerNativeProvider(fixture.provider);await runtime.setRuntimeApiKey('friend-fixture','fixture');return fixture.getModel();
}
