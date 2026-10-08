import type { WorkspaceRef } from '../workspaces.js';
export type { WorkspaceRef };
export interface Project { id: string; path: string; name: string }
export interface SessionSummary { id: string; projectId: string; name: string; path: string; updatedAt: string;status?:string;modelId?:string;archived?:boolean }
export interface Message { role: string; text: string; id?: string;userText?:string;parts?:JsonObject[];toolCallId?:string;toolName?:string;isError?:boolean;runId?:string;timestamp?:number }
export interface Model { id: string; provider: string; name: string; reasoning: boolean; contextWindow: number;thinkingLevels?:string[];input?:string[] }
export interface Preferences {defaultModelId:string;defaultThinkingLevel:string;defaultPlugins:PluginName[];defaultMode:'single'|'swarm';defaultPlanMode:boolean;contextMode:'native'|'infinite';backgroundModelId:string}
export interface AppState {
  projects: Project[];
  sessions: SessionSummary[];
  current: { sessionId: string; projectId: string; workspace?:WorkspaceRef;workspacePath?:string; messages: Message[]; isRunning: boolean; modelId: string; thinkingLevel: string;thinkingLevels?:string[]; plugins: string[];runId?:string;receipts?:JsonObject[];pendingConfiguration?:JsonObject;plan?:JsonObject; planMode?: boolean;executionMode?:'single'|'swarm' } | null;
  models: Model[];
  providers: { id: string; name: string; configured: boolean }[];
  preferences?:Preferences;
}
export interface BridgeEvent { type: 'state' | 'pi' | 'plugin' | 'dialog' | 'notice'; sessionId?: string; data: unknown }
export interface FriendBridge { request<T = unknown>(method: string, input?: Record<string, unknown>): Promise<T>; onEvent(callback: (event: BridgeEvent) => void): () => void }
declare global { interface Window { friendPi: FriendBridge } }
export type PluginName = 'swarm' | 'expert' | 'memory' | 'topic-rebuild';
export type WorkspaceTab = PluginName | 'file' | 'diff' | 'settings';
export type JsonObject = Record<string, unknown>;
export interface DialogRequest { id: string; kind: 'confirm' | 'input' | 'select' | 'editor'; title: string; message?: string; options?: string[]; prefill?: string }
export function asObject(value: unknown): JsonObject { return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}; }
export function asList<T>(value: unknown): T[] { return Array.isArray(value) ? value as T[] : []; }
export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function contentText(value: unknown): string { return typeof value === 'string' ? value : asList<JsonObject>(value).filter(part => part.type === 'text').map(part => String(part.text || '')).join('\n'); }
export const pluginLabels: Record<PluginName, string> = { swarm: 'Swarm', expert: 'Expert', memory: 'Memory', 'topic-rebuild': '上下文' };
export const statusLabels: Record<string, string> = { interrupted:'已中断',created: '待启动', running: '执行中', paused: '已暂停', awaiting_review: '待复核', ready: '可整合', integrated: '已整合', failed: '失败', stopping:'正在停止', stopped: '已停止', pending: '待领取', completed: '已完成', unknown: '需接续', blocked: '阻塞', cancelled: '已取消', active: '生效', inactive: '已停用', candidate: '候选', validating: '验证中', published: '已发布', withdrawn: '已撤回', invalidated: '来源已失效', queued: '等待中' };
