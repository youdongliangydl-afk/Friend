
export type LayoutMode = 'standard' | 'fullscreen';
export type BrowserScope = 'app' | 'project' | 'session';
export type ToolPage = 'file' | 'diff' | 'terminal' | 'swarm' | 'expert' | 'memory';
export interface ViewTab { id: string; kind: 'new' | 'tool' | 'browser'; page?: ToolPage; url?: string; title?: string }
export interface SessionViewState { version: 1; mode: LayoutMode; tabs: ViewTab[]; active: string; sidebar: boolean; composerCollapsed: boolean; browserScope: BrowserScope; normalPage?: ToolPage|'browser'|null; normalTerminal?: boolean }
export const toolNames: Record<ToolPage,string> = {file:'文件',diff:'Diff',terminal:'终端',swarm:'任务',expert:'Expert',memory:'Memory'};
export const browserScopeNames: Record<BrowserScope,string> = {app:'整个 Friend 共用',project:'按项目隔离',session:'按会话隔离'};
export function initialView(defaults: {defaultLayoutMode?: LayoutMode; defaultBrowserScope?: BrowserScope} = {}): SessionViewState {
  return {version:1,mode:defaults.defaultLayoutMode||'standard',browserScope:defaults.defaultBrowserScope||'app',tabs:[],active:'conversation',sidebar:true,composerCollapsed:false,normalPage:null,normalTerminal:false};
}
export function browserUrl(input: string): string {
  const value=input.trim();
  if(!value||value.length>8192)throw new Error('请输入有效网址');
  const url=new URL(/^[a-z][a-z\d+.-]*:/i.test(value)&&!/^localhost:\d/i.test(value)?value:(/^(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/i.test(value)?'http://':'https://')+value);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('仅支持不含密码的 HTTP / HTTPS 网址');
  return url.href;
}
export function validateView(raw: unknown): SessionViewState {
  if(!raw||typeof raw!=='object')throw new Error('会话界面状态无效');
  const v=raw as SessionViewState;
  if(v.version!==1||!['standard','fullscreen'].includes(v.mode)||!['app','project','session'].includes(v.browserScope)||typeof v.sidebar!=='boolean'||typeof v.composerCollapsed!=='boolean'||!Array.isArray(v.tabs)||v.tabs.length>100)throw new Error('会话界面状态无效');
  const ids=new Set<string>(),tools=new Set<string>();
  const tabs=v.tabs.map(tab=>{
    if(!tab||typeof tab.id!=='string'||! /^[\w-]{1,100}$/.test(tab.id)||ids.has(tab.id)||tab.id==='conversation'||!['new','tool','browser'].includes(tab.kind))throw new Error('标签无效或重复');
    ids.add(tab.id);
    if(tab.kind==='tool'){if(!tab.page||!Object.hasOwn(toolNames,tab.page)||tools.has(tab.page))throw new Error('工具标签无效或重复');tools.add(tab.page);return {id:tab.id,kind:tab.kind,page:tab.page};}
    if(tab.kind==='browser')return {id:tab.id,kind:tab.kind,url:tab.url==='about:blank'?'about:blank':browserUrl(String(tab.url||'')),title:String(tab.title||'网页').slice(0,200)};
    return {id:tab.id,kind:tab.kind};
  });
  if(v.active!=='conversation'&&!ids.has(v.active))throw new Error('选中的标签不存在');
  if(v.normalPage!==undefined&&v.normalPage!==null&&v.normalPage!=='browser'&&!Object.hasOwn(toolNames,v.normalPage)||v.normalTerminal!==undefined&&typeof v.normalTerminal!=='boolean')throw new Error('普通布局状态无效');
  return {version:1,mode:v.mode,browserScope:v.browserScope,sidebar:v.sidebar,composerCollapsed:v.composerCollapsed,active:v.active,tabs,normalPage:v.normalPage||null,normalTerminal:v.normalTerminal===true};
}
export function newBrowserTab(url: string): ViewTab { return {id:crypto.randomUUID(),kind:'browser',url:browserUrl(url),title:'网页'}; }
