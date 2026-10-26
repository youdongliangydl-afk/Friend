import type {ExternalCapabilitiesSnapshot} from '../external-capabilities.js';
export type CapabilityKind='skill'|'plugin'|'mcp'|'slash';
/** Three states are independent: a capability may be configured yet not loaded, loaded yet unusable. */
export interface CapabilityEntry {id:string;kind:CapabilityKind;name:string;description:string;source:string;configured:boolean;loaded:boolean;available:boolean;reason?:string}
export interface CapabilitySection {kind:CapabilityKind;title:string;hint:string;source:string;entries:CapabilityEntry[];emptyReason?:string}
export interface CapabilityCounts {entries:number;configured:number;loaded:number;available:number}
export interface CapabilityCatalog {sections:CapabilitySection[];counts:Record<CapabilityKind,CapabilityCounts>}
export interface CapabilityInput {
  plugins?:{enabled?:unknown;defaults?:unknown;runtimeReady?:boolean};
  mcp?:{snapshot?:ExternalCapabilitiesSnapshot|null;error?:string;loading?:boolean};
  references?:{items?:unknown;error?:string;loading?:boolean};
}
/** Static product metadata only: runtime enablement is never inferred from this table. */
export const pluginCatalog:Record<string,{name:string;description:string}>={
  swarm:{name:'Swarm',description:'任务依赖图、成员预算与门禁裁决'},
  expert:{name:'Expert',description:'按任务采用专家方法与技能，并冻结采用正文'},
  memory:{name:'Memory',description:'项目经验与个人偏好的记忆选择与注入'},
  'topic-rebuild':{name:'上下文（Topic & ReBuild）',description:'长会话历史的重建、保留与压缩'},
};
const titles:Record<CapabilityKind,string>={skill:'Skills',plugin:'Plugins',mcp:'MCP',slash:'Slash 命令'};
const hints:Record<CapabilityKind,string>={
  skill:'Pi 资源加载器在当前会话发现的技能；可用 /skill:<名称> 调用。',
  plugin:'会话运行时实际生效的插件启用列表；默认设置只影响新会话。',
  mcp:'外部能力配置与 Pi 的 MCP 连接状态；连接失败时显示服务自己的诊断。',
  slash:'Pi 会话命令注册表返回的 slash 命令；只列出运行时真实注册的命令。',
};
const sources:Record<CapabilityKind,string>={
  skill:'Pi 资源加载器（会话命令清单）',
  plugin:'会话启用列表 + 默认设置',
  mcp:'external-capabilities 快照',
  slash:'Pi 扩展命令注册表',
};
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const strings=(value:unknown):string[]=>Array.isArray(value)?[...new Set(value.filter((item):item is string=>typeof item==='string'&&!!item.trim()).map(item=>item.trim()))]:[];
function splitLabel(label:string,insert:string){
  const separator=label.indexOf(' · ');
  const fallback=insert.replace(/^\/(?:skill:)?/,'');
  return separator<0?[label||fallback,''] as const:[label.slice(0,separator)||fallback,label.slice(separator+3)] as const;
}
export interface ReferenceItem {id:string;name:string;description:string;insert:string}
/** Normalises the Pi `/` reference list: `command:`/`skill:` ids are the only trusted discriminators. */
export function referenceEntries(raw:unknown):{skills:ReferenceItem[];slash:ReferenceItem[]}{
  const skills:ReferenceItem[]=[],slash:ReferenceItem[]=[],seen=new Set<string>();
  for(const value of Array.isArray(raw)?raw:[]){
    const item=object(value),id=typeof item.id==='string'?item.id:'',insert=typeof item.insert==='string'?item.insert:'',label=typeof item.label==='string'?item.label:'';
    if(!id||seen.has(id))continue;
    const kind=id.startsWith('skill:')||item.kind==='Skill'||insert.startsWith('/skill:')?'skill':id.startsWith('command:')||item.kind==='命令'||/^\/[^/]/.test(insert)?'slash':undefined;
    if(!kind)continue;
    seen.add(id);const [name,description]=splitLabel(label,insert);
    (kind==='skill'?skills:slash).push({id,name,description,insert});
  }
  return {skills:skills.slice(0,200),slash:slash.slice(0,200)};
}
function referenceSection(kind:'skill'|'slash',items:ReferenceItem[],input:CapabilityInput['references']):CapabilitySection{
  const entries=items.map(item=>({id:item.id,kind,name:item.name,description:item.description,source:sources[kind],configured:true,loaded:true,available:true}));
  const label=kind==='skill'?'技能':'slash 命令';
  const emptyReason=input?.error?`无法读取${label}清单：${input.error}`
    :input?.loading||!input?'正在读取当前会话的 Pi 清单…'
    :kind==='skill'?'Pi 资源加载器在当前会话没有返回技能（/skill:<名称> 来自 Pi 扩展目录或插件提供的目录）；没有数据源时不列举示例。'
    :'当前会话没有注册 slash 命令（Pi 命令注册表返回为空）。';
  return {kind,title:titles[kind],hint:hints[kind],source:sources[kind],entries,...(entries.length?{}:{emptyReason})};
}
export function pluginSection(input:CapabilityInput['plugins']):CapabilitySection{
  if(!input||input.enabled===undefined&&input.defaults===undefined)return {kind:'plugin',title:titles.plugin,hint:hints.plugin,source:sources.plugin,entries:[],emptyReason:'未提供当前会话的插件启用列表（接入方需传入 plugins）；此处不猜测插件状态。'};
  const enabled=strings(input.enabled),defaults=strings(input.defaults),runtimeReady=input.runtimeReady!==false;
  const entries=[...new Set([...enabled,...defaults])].map(name=>{
    const meta=pluginCatalog[name],loaded=enabled.includes(name),available=loaded&&runtimeReady;
    const reason=!loaded?defaults.includes(name)?'已配置为默认启用，但当前会话未启用。':'当前会话未启用此插件。'
      :!runtimeReady?'会话运行时未就绪，暂不可调用。':undefined;
    return {id:'plugin:'+name,kind:'plugin' as const,name:meta?.name||name,description:meta?.description||'运行时列出但未登记说明的插件。',source:sources.plugin,configured:true,loaded,available,...(reason?{reason}:{})};
  });
  return {kind:'plugin',title:titles.plugin,hint:hints.plugin,source:sources.plugin,entries,...(entries.length?{}:{emptyReason:'当前会话与默认设置都没有启用插件。'})};
}
function serverReason(server:ExternalCapabilitiesSnapshot['servers'][number]):string|undefined{
  const diagnostic=server.diagnostic?`：${server.diagnostic}`:'';
  if(!server.enabled)return '服务已停用，未建立连接。';
  if(server.state==='failed')return `连接失败${diagnostic||'，请查看服务诊断。'}`;
  if(server.state==='needs-auth')return `需要认证${diagnostic||'，服务要求登录后才能列出工具。'}`;
  if(server.state==='connecting')return '正在连接…';
  if(server.state==='unchecked')return '尚未检查连接，状态未知。';
  if(server.state==='disconnected')return `连接已断开${diagnostic}`;
  if(server.state==='connected'&&!server.tools.length)return '已连接，但服务没有提供可用工具。';
  if(server.state==='connected'&&!server.tools.some(tool=>tool.available))return '已连接，但工具当前不可用（服务声明或工具已隐藏）。';
  return undefined;
}
export function mcpSection(input:CapabilityInput['mcp']):CapabilitySection{
  const empty=(reason:string):CapabilitySection=>({kind:'mcp',title:titles.mcp,hint:hints.mcp,source:sources.mcp,entries:[],emptyReason:reason});
  if(input?.error)return empty(`无法读取 MCP 配置：${input.error}`);
  if(!input?.snapshot)return empty(input?.loading?'正在读取外部能力配置…':'尚未读取 MCP 配置。');
  const entries=input.snapshot.servers.map(server=>{
    const loaded=server.enabled&&server.state==='connected',available=loaded&&server.tools.some(tool=>tool.available),reason=serverReason(server);
    return {id:'mcp:'+server.name,kind:'mcp' as const,name:server.name,description:`${server.type==='http'?'Streamable HTTP':'本地程序'} · ${server.tools.length} 个工具${server.enabled?'':' · 已停用'}`,source:sources.mcp,configured:true,loaded,available,...(reason?{reason}:{})};
  });
  return {kind:'mcp',title:titles.mcp,hint:hints.mcp,source:sources.mcp,entries,...(entries.length?{}:{emptyReason:'尚未保存任何 MCP 服务；在下方添加服务并测试连接后才会出现条目。'})};
}
export function capabilityCounts(section:CapabilitySection):CapabilityCounts{
  return {entries:section.entries.length,configured:section.entries.filter(entry=>entry.configured).length,loaded:section.entries.filter(entry=>entry.loaded).length,available:section.entries.filter(entry=>entry.available).length};
}
export function capabilityCatalog(input:CapabilityInput={}):CapabilityCatalog{
  const references=referenceEntries(input.references?.items);
  const sections=[referenceSection('skill',references.skills,input.references),pluginSection(input.plugins),mcpSection(input.mcp),referenceSection('slash',references.slash,input.references)];
  return {sections,counts:Object.fromEntries(sections.map(section=>[section.kind,capabilityCounts(section)])) as Record<CapabilityKind,CapabilityCounts>};
}
/** A failed or unavailable entry always carries its own reason; nothing is filled in optimistically. */
export function capabilityProblems(catalog:CapabilityCatalog){return catalog.sections.flatMap(section=>section.entries.filter(entry=>!entry.available&&entry.reason).map(entry=>({kind:section.kind,id:entry.id,name:entry.name,reason:entry.reason!})));}
