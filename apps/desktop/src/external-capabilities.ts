import {randomUUID} from 'node:crypto';
import {chmodSync,closeSync,existsSync,lstatSync,mkdirSync,openSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createMcpExtension,type ExtensionAPI,type ExtensionContext,type ExtensionCommandContext,type ExtensionFactory,type McpServerConfig,type ToolDefinition} from '@earendil-works/pi-coding-agent';
import {Type} from 'typebox';
import {publicWebUrl,readPublicText,webpageText,type ExternalNetwork} from './external-capabilities-network.js';

type Json=Record<string,unknown>;
type ServerState='disabled'|'connecting'|'connected'|'failed'|'disconnected'|'needs-auth'|'unchecked';
interface Server {name:string;config:McpServerConfig}
interface Stored {v:1;revision:number;servers:Server[];web:{provider:'brave';enabled:boolean;apiKey?:string}}
export interface ExternalTool {name:string;label:string;description:string;parameters:unknown;readOnly:boolean;available:boolean}
export interface ExternalCapabilitiesSnapshot {
  v:1;revision:number;
  servers:Array<{name:string;type:'stdio'|'http';enabled:boolean;command?:string;args?:string[];cwd?:string;url?:string;urlRedacted?:boolean;envNames:string[];headerNames:string[];state:ServerState;diagnostic?:string;testedAt?:string;tools:ExternalTool[]}>;
  web:{provider:'brave';enabled:boolean;configured:boolean;fetchAvailable:true;source:string;testedAt?:string;diagnostic?:string};
}
interface Options {
  dataDir:string;cwd:string;
  confirm?:(request:{operation:string;message:string;autoEligible:boolean;requireExplicit?:boolean})=>Promise<boolean>;
  publish?:(snapshot:ExternalCapabilitiesSnapshot)=>void;
  network?:ExternalNetwork;
}
const record=(value:unknown):Json=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('配置应为对象');return value as Json;};
function string(value:unknown,label:string,max=8192){if(typeof value!=='string'||!value.trim()||value.length>max||value.includes('\0'))throw new Error(`${label}无效`);return value.trim();}
const braveSource='https://api-dashboard.search.brave.com/app/documentation/web-search/query';
export const nativeMcpResourceTools:readonly string[]=['list_mcp_resources','list_mcp_resource_templates','read_mcp_resource'];
const resourceTools=new Set(nativeMcpResourceTools);
function nameOf(value:unknown){const name=string(value,'服务名称',64);if(!/^[A-Za-z0-9_-]+$/.test(name))throw new Error('服务名称仅支持字母、数字、下划线和连字符');return name;}
function secretMap(value:unknown,prior:Record<string,string>|undefined,label:string){
  if(value===undefined)return prior;
  const entries=Object.entries(record(value));if(entries.length>64)throw new Error(`${label}最多 64 项`);
  const result:Record<string,string>={};
  for(const [key,raw] of entries){if(!/^[A-Za-z0-9_-]{1,128}$/.test(key)||typeof raw!=='string'||raw.length>8192||/[\r\n\0]/.test(raw)||raw.startsWith('!'))throw new Error(`${label}字段无效；不支持执行命令取凭证`);result[key]=raw===''&&prior?.[key]?prior[key]:raw;}
  return result;
}
function serverConfig(input:Json,previous?:McpServerConfig):McpServerConfig {
  const type=input.type||('url' in (previous||{})?'http':'stdio'),enabled=input.enabled===undefined?previous?.enabled===true:input.enabled===true;
  const timeout=input.timeout===undefined?previous?.timeout??10:Number(input.timeout);
  if(!Number.isInteger(timeout)||timeout<1||timeout>60)throw new Error('连接超时须为 1 至 60 秒');
  if(type==='http'){
    const url=new URL(string(input.url??(previous&&'url' in previous?previous.url:undefined),'MCP 地址'));
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('MCP 地址须为不含账号密码的 HTTP(S) 地址');
    return {type:'http',url:url.href,enabled,timeout,exposure:'direct',headers:secretMap(input.headers,previous&&'url' in previous?previous.headers:undefined,'请求头')};
  }
  if(type!=='stdio')throw new Error('仅支持 stdio 与 Streamable HTTP');
  const command=string(input.command??(previous&&'command' in previous?previous.command:undefined),'可执行程序'),rawArgs=input.args??(previous&&'command' in previous?previous.args:[])??[];
  if(!Array.isArray(rawArgs)||rawArgs.length>128||rawArgs.some(value=>typeof value!=='string'||value.length>8192||value.includes('\0')))throw new Error('程序参数须为字符串数组');
  const cwd=input.cwd===undefined?(previous&&'command' in previous?previous.cwd:undefined):input.cwd===''?undefined:string(input.cwd,'运行目录');
  return {type:'stdio',command,args:rawArgs as string[],cwd,enabled,timeout,exposure:'direct',env:secretMap(input.env,previous&&'command' in previous?previous.env:undefined,'环境变量')};
}
function empty():Stored{return {v:1,revision:0,servers:[],web:{provider:'brave',enabled:false}};}

export function createExternalCapabilities(options:Options){
  const path=join(resolve(options.dataDir),'external-capabilities.json');
  let pi:ExtensionAPI|undefined,context:ExtensionContext|undefined,disposed=false;
  let nativeCommand:((args:string,ctx:ExtensionCommandContext)=>Promise<void>)|undefined;
  let settings=empty(),webTest:{testedAt?:string;diagnostic?:string}={};
  const statuses=new Map<string,{state:ServerState;diagnostic?:string;testedAt?:string}>(),registered=new Map<string,string>(),definitions=new Map<string,ToolDefinition>(),testing=new Set<string>(),connectionChanges=new Set<Promise<unknown>>();
  let shutdown=new AbortController(),serial:Promise<unknown>=Promise.resolve();
  function load():Stored {
    if(!existsSync(path))return empty();
    const stat=lstatSync(path);if(stat.isSymbolicLink()||!stat.isFile()||(stat.mode&0o077)!==0)throw new Error('外部能力配置须为当前用户可读写的私有普通文件');
    let saved:Json;try{saved=record(JSON.parse(readFileSync(path,'utf8')));}catch{throw new Error('外部能力配置无法读取，原文件已保留');}
    if(saved.v!==1||!Number.isSafeInteger(saved.revision)||!Array.isArray(saved.servers)||saved.servers.length>64)throw new Error('外部能力配置损坏，原文件已保留');
    const names=new Set<string>();const servers=saved.servers.map(raw=>{const item=record(raw),name=nameOf(item.name),key=name.replaceAll('-','_');if(names.has(key))throw new Error('外部能力配置含重名服务');names.add(key);return {name,config:serverConfig(record(item.config))};});
    const web=record(saved.web);if(web.provider!=='brave'||typeof web.enabled!=='boolean'||web.apiKey!==undefined&&typeof web.apiKey!=='string')throw new Error('网页检索配置损坏，原文件已保留');
    return {v:1,revision:saved.revision as number,servers,web:{provider:'brave',enabled:web.enabled,apiKey:web.apiKey as string|undefined}};
  }
  function secrets(){return [settings.web.apiKey,...settings.servers.flatMap(server=>[...Object.values('url' in server.config?server.config.headers||{}:server.config.env||{}),...('url' in server.config?[...new URL(server.config.url).searchParams.values()]:[])])].flatMap(value=>typeof value==='string'?[value,...[...value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map(match=>process.env[match[1]]||'')]:[]).filter(value=>value.length>=4).sort((a,b)=>b.length-a.length);}
  function redact(value:string){let text=value;for(const secret of secrets())for(const form of new Set([JSON.stringify(secret).slice(1,-1),secret]))text=text.split(form).join('[凭证已隐藏]');return text.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi,'[凭证已隐藏]').replace(/sk-[A-Za-z0-9_-]{8,}/g,'[凭证已隐藏]');}
  function publicError(error:unknown){return new Error(redact(error instanceof Error?error.message:String(error)));}
  function redactValues<T>(value:T):T {
    if(typeof value==='string')return redact(value) as T;
    if(Array.isArray(value))return value.map(item=>redactValues(item)) as T;
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,redactValues(item)])) as T;
    return value;
  }
  function safeSchema<T>(value:T,annotation=false):T {
    if(typeof value==='string'){const clean=redact(value);if(annotation)return clean as T;if(clean!==value&&!['text','image','object','array','string','number','integer','boolean','null'].includes(value))throw new Error('MCP 工具参数结构含已配置凭证，已阻止公开');return value;}
    if(Array.isArray(value))return value.map(item=>safeSchema(item,annotation)) as T;
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>{safeIdentifier(key);return [key,
      ['properties','$defs','definitions','patternProperties','dependentSchemas'].includes(key)&&item&&typeof item==='object'
        ?Object.fromEntries(Object.entries(item).map(([name,schema])=>{safeIdentifier(name);return [name,safeSchema(schema)];}))
        :safeSchema(item,annotation||['description','title','$comment','examples'].includes(key))];})) as T;
    return value;
  }
  function safeIdentifier(value:string){if(redact(value)!==value&&!['type','text','image','content','details','data','mimeType'].includes(value))throw new Error('MCP 工具名称或参数键含已配置凭证，已阻止公开');}
  function safeResult<T extends Awaited<ReturnType<ToolDefinition['execute']>>>(result:T):T {
    let structuredContent=redactValues(result.structuredContent);
    const native=result.structuredContent as Json|undefined;
    if(native&&Array.isArray(native.content))structuredContent={...structuredContent as Json,content:native.content.map(raw=>{const part=record(raw);return {...redactValues(part),type:part.type,...(['image','audio'].includes(String(part.type))?{data:part.data,mimeType:part.mimeType}:{})};})} as typeof structuredContent;
    return {...result,content:result.content.map(part=>part.type==='text'?{...part,text:redact(part.text)}:part),details:redactValues(result.details),
      ...(result.structuredContent===undefined?{}:{structuredContent})};
  }
  function snapshot():ExternalCapabilitiesSnapshot {
    return {v:1,revision:settings.revision,servers:settings.servers.map(server=>{
      const config=server.config,status=statuses.get(server.name),namespace=`mcp__${server.name.replaceAll('-','_')}`;
      const tools=[...definitions.values()].filter(tool=>tool.namespace?.name===namespace).map(tool=>({name:tool.name,label:redact(tool.label),description:redact(tool.description),parameters:tool.parameters,readOnly:tool.annotations?.readOnlyHint===true,available:config.enabled===true&&tool.exposure!=='hidden'}));
      const url='url' in config?new URL(config.url):undefined;if(url)for(const key of url.searchParams.keys())url.searchParams.set(key,'[已隐藏]');
      return {name:server.name,type:'url' in config?'http':'stdio',enabled:config.enabled===true,...('url' in config?{url:url!.href,urlRedacted:!!url!.search}:{command:redact(config.command),args:config.args?.map(redact),cwd:config.cwd}),envNames:'command' in config?Object.keys(config.env||{}):[],headerNames:'url' in config?Object.keys(config.headers||{}):[],state:config.enabled===true?status?.state||'unchecked':'disabled',diagnostic:status?.diagnostic?redact(status.diagnostic):undefined,testedAt:status?.testedAt,tools};
    }),web:{provider:'brave',enabled:settings.web.enabled,configured:!!settings.web.apiKey,fetchAvailable:true,source:braveSource,...webTest}};
  }
  function publish(){if(!disposed)options.publish?.(snapshot());}
  function check(){if(disposed)throw new Error('外部能力已关闭');}
  function sync(){
    if(!pi||disposed)return;
    const names=new Set(settings.servers.map(server=>server.name));
    for(const name of registered.keys())if(!names.has(name)){pi.unregisterMcpServer(name);registered.delete(name);statuses.delete(name);}
    for(const {name,config} of settings.servers){const identity=JSON.stringify(config);if(registered.get(name)!==identity){pi.registerMcpServer(name,config);registered.set(name,identity);statuses.set(name,{state:config.enabled===true?'connecting':'disabled'});}}
  }
  function refresh(){settings=load();sync();return snapshot();}
  function mutate(input:Json,change:(latest:Stored)=>void){
    check();mkdirSync(options.dataDir,{recursive:true,mode:0o700});const lock=path+'.lock';let handle:number;
    try{handle=openSync(lock,'wx',0o600);}catch{throw new Error('另一会话正在保存配置，请刷新后重试');}
    const temporary=path+'.'+randomUUID()+'.tmp';
    try{const latest=load();if(input.revision!==undefined&&input.revision!==latest.revision)throw new Error('配置已在其他会话更新，请刷新后重试');change(latest);latest.revision++;writeFileSync(temporary,JSON.stringify(latest,null,2)+'\n',{mode:0o600,flag:'wx'});renameSync(temporary,path);chmodSync(path,0o600);settings=latest;sync();publish();return snapshot();}
    finally{closeSync(handle);unlinkSync(lock);if(existsSync(temporary))unlinkSync(temporary);}
  }
  async function confirm(operation:string,message:string){
    check();const request={operation,message:redact(message),autoEligible:false};
    const approved=options.confirm?await options.confirm(request):context?.hasUI?await context.ui.confirm(operation,request.message):false;
    check();if(!approved)throw new Error('用户未批准此操作');
  }
  async function native(args=''){
    if(!nativeCommand||!context)throw new Error('会话尚未准备好，请稍后重试');
    const notices:string[]=[];
    // /mcp is a public Pi command. Run its documented non-TUI path; no model turn is started.
    const unavailable=async():Promise<never>=>{throw new Error('MCP 状态检查不能切换或重载会话');};
    const ctx:ExtensionCommandContext={...context,mode:'rpc',hasUI:false,ui:{...context.ui,notify:(message:string)=>{notices.push(redact(message));}},getSystemPromptOptions:()=>({cwd:options.cwd}),waitForIdle:unavailable,newSession:unavailable,fork:unavailable,navigateTree:unavailable,switchSession:unavailable,reload:unavailable};
    await nativeCommand(args,ctx);return notices.join('\n');
  }
  async function readStatus(){
    const diagnostic=await native();
    for(const {name,config} of settings.servers){const line=diagnostic.split('\n').find(line=>line.startsWith(name+': '));if(!line)continue;
      // shortcut: Pi 1.0.4 exposes status through /mcp text; replace this parser when Pi adds a public status snapshot.
      const state:ServerState=line.includes(': connected')?'connected':line.includes(': needs sign-in')?'needs-auth':line.includes(': failed')?'failed':line.includes(': disconnected')?'disconnected':line.includes(': disabled')?'disabled':'connecting';
      const lines=diagnostic.split('\n'),start=lines.indexOf(line);let end=start+1;while(end<lines.length&&/^\s/.test(lines[end]))end++;
      statuses.set(name,{...statuses.get(name),state,diagnostic:redact(lines.slice(start,end).join('\n'))});
      if(config.enabled!==true&&testing.has(name))statuses.get(name)!.state=state;
    }
    publish();return diagnostic;
  }
  async function testServer(name:string){
    if(testing.has(name))throw new Error('此服务正在测试');const server=settings.servers.find(server=>server.name===name);if(!server)throw new Error('MCP 服务不存在');
    await confirm('测试 MCP 连接','连接此服务并读取工具清单。'+('command' in server.config?'\n程序：'+server.config.command+' '+(server.config.args||[]).join(' '):'\n地址：'+server.config.url));
    if(!pi||!context)throw new Error('请先打开会话再测试连接');
    testing.add(name);statuses.set(name,{state:'connecting'});publish();
    try{
      const wasEnabled=server.config.enabled===true;
      if(!wasEnabled)pi.registerMcpServer(name,{...server.config,enabled:true});else await native('reconnect '+name);
      const deadline=Date.now()+Math.min(65_000,((server.config.timeout||10)+5)*1000);
      while(Date.now()<deadline){check();await readStatus();const status=statuses.get(name);if(status&&['connected','failed','disconnected','needs-auth'].includes(status.state)){status.testedAt=new Date().toISOString();publish();return {ok:status.state==='connected',state:status.state,diagnostic:status.diagnostic,testedAt:status.testedAt,tools:snapshot().servers.find(server=>server.name===name)?.tools||[]};}await delay(100,undefined,{signal:shutdown.signal});}
      throw new Error('MCP 连接测试超时，请检查程序、地址或认证');
    }finally{testing.delete(name);if(pi&&!disposed){settings=load();const current=settings.servers.find(server=>server.name===name);if(current)pi.registerMcpServer(name,current.config);else pi.unregisterMcpServer(name);await Promise.allSettled([...connectionChanges]);}publish();}
  }
  async function webFetch(input:Json,signal?:AbortSignal){
    const maxChars=input.maxChars===undefined?20_000:Number(input.maxChars);if(!Number.isSafeInteger(maxChars)||maxChars<100||maxChars>100_000)throw new Error('网页文本上限须为 100 至 100000 字符');
    const result=await readPublicText(string(input.url,'网页地址'),{signal:AbortSignal.any([shutdown.signal,...(signal?[signal]:[])]),network:options.network}),text=webpageText(result.body,result.mediaType);
    return {url:result.url,source:{url:result.url,title:text.title},title:text.title,content:text.content.slice(0,maxChars),mediaType:result.mediaType,truncated:result.truncated||text.content.length>maxChars,bytes:result.bytes,fetchedAt:new Date().toISOString()};
  }
  async function webSearch(input:Json,signal?:AbortSignal){
    settings=load();const key=settings.web.apiKey;if(!settings.web.enabled||!key)throw new Error('尚未启用 Brave 网页检索，请在外部能力中保存 API Key 并启用');
    const query=string(input.query,'检索词',2000),count=input.count===undefined?5:Number(input.count);if(!Number.isInteger(count)||count<1||count>10)throw new Error('检索结果数量须为 1 至 10');
    const url=new URL('https://api.search.brave.com/res/v1/web/search');url.searchParams.set('q',query);url.searchParams.set('count',String(count));
    const response=await readPublicText(url.href,{signal:AbortSignal.any([shutdown.signal,...(signal?[signal]:[])]),maxBytes:1_000_000,redirects:false,headers:{'X-Subscription-Token':key,Accept:'application/json'},network:options.network});
    if(response.truncated)throw new Error('检索响应超过大小上限');
    let body:Json;try{body=record(JSON.parse(response.body));}catch{throw new Error('检索服务返回格式无效');}
    const web=body.web&&typeof body.web==='object'?record(body.web):{},results=Array.isArray(web.results)?web.results:[];
    const sources=results.slice(0,count).flatMap(raw=>{try{const item=record(raw),url=publicWebUrl(string(item.url,'来源地址')).href;if(redact(url)!==url)return [];return [{url,title:typeof item.title==='string'?redact(item.title).slice(0,500):url,snippet:typeof item.description==='string'?redact(webpageText(item.description,'text/html').content).slice(0,4000):''}];}catch{return [];}});
    return {provider:'brave',query,sources,truncated:results.length>count,searchedAt:new Date().toISOString()};
  }
  const extensionFactory:ExtensionFactory=api=>{
    pi=api;registered.clear();definitions.clear();if(shutdown.signal.aborted)shutdown=new AbortController();
    api.on('before_agent_start',()=>{refresh();});
    const cleanContext=<T extends ExtensionContext>(ctx:T):T=>({...ctx,ui:{...ctx.ui,notify:(message:string,level?:'info'|'warning'|'error')=>ctx.ui.notify(redact(message),level)}});
    const proxy=new Proxy(api,{get(target,key){
      if(key==='on')return (event:string,handler:(event:unknown,ctx:ExtensionContext)=>unknown)=>Reflect.apply(target.on,target,[event,(data:unknown,ctx:ExtensionContext)=>{const result=handler(data,cleanContext(ctx));if(event==='mcp_servers_change'&&result instanceof Promise){connectionChanges.add(result);void result.finally(()=>connectionChanges.delete(result)).catch(()=>{});}return result;}]);
      if(key==='registerTool')return (tool:ToolDefinition)=>{
        safeIdentifier(tool.name);if(tool.namespace)safeIdentifier(tool.namespace.name);
        const safe:ToolDefinition={...tool,label:redact(tool.label),description:redact(tool.description),parameters:safeSchema(tool.parameters),
          ...(tool.promptSnippet===undefined?{}:{promptSnippet:redact(tool.promptSnippet)}),...(tool.promptGuidelines?{promptGuidelines:tool.promptGuidelines.map(redact)}:{}),
          ...(tool.outputSchema?{outputSchema:safeSchema(tool.outputSchema)}:{}),...(tool.namespace?{namespace:{...tool.namespace,...(tool.namespace.description?{description:redact(tool.namespace.description)}:{}),...(tool.namespace.instructions?{instructions:redact(tool.namespace.instructions)}:{})}}:{}),
          execute:async(id,input,signal,onUpdate,ctx)=>{try{return safeResult(await tool.execute(id,input,signal,onUpdate?value=>onUpdate(safeResult(value)):undefined,ctx));}catch(error){throw publicError(error);}}};
        definitions.set(tool.name,safe);target.registerTool(safe);publish();
      };
      if(key==='registerCommand')return (name:string,command:Parameters<ExtensionAPI['registerCommand']>[1])=>{if(name==='mcp')nativeCommand=command.handler;target.registerCommand(name,{...command,handler:(args,ctx)=>command.handler(args,cleanContext(ctx))});};
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    // Native server logs can contain arbitrary credential echoes; keep only redacted status diagnostics.
    createMcpExtension({loadConfig:()=>({servers:[],errors:[],autoEnableCodemode:false}),logPath:process.platform==='win32'?'NUL':'/dev/null'})(proxy);
    settings=load();sync();
    api.on('session_start',(_event,ctx)=>{context=ctx;void readStatus().catch(error=>{for(const server of settings.servers)if(server.config.enabled)statuses.set(server.name,{state:'failed',diagnostic:redact(String(error))});publish();});});
    api.on('tool_call',async(event,ctx)=>{
      const resource=resourceTools.has(event.toolName);if(!resource&&!event.toolName.startsWith('mcp__'))return;refresh();
      const namespace=definitions.get(event.toolName)?.namespace?.name,serverName=resource?(event.input as Json).server:undefined;
      const selected=()=>settings.servers.filter(server=>resource?(serverName===undefined?server.config.enabled:server.name===serverName):namespace===`mcp__${server.name.replaceAll('-','_')}`);
      const servers=selected();if(!servers.length||servers.some(server=>!server.config.enabled)||definitions.get(event.toolName)?.exposure==='hidden')return {block:true,reason:'MCP 服务已停用或移除'};
      const identity=JSON.stringify(servers),message=redact(event.toolName+'\n'+JSON.stringify(event.input).slice(0,8000));
      const approved=options.confirm?await options.confirm({operation:'调用 MCP 工具',message,autoEligible:false}):ctx.hasUI?await ctx.ui.confirm('调用 MCP 工具',message):false;
      refresh();await Promise.allSettled([...connectionChanges]);if(disposed||!approved||definitions.get(event.toolName)?.namespace?.name!==namespace||definitions.get(event.toolName)?.exposure==='hidden'||JSON.stringify(selected())!==identity)return {block:true,reason:'MCP 工具未获批准或配置已变化'};
    });
    api.on('session_shutdown',()=>{context=undefined;shutdown.abort();});
    for(const [name,label,description,parameters,execute] of [
      ['web_fetch','读取网页','读取公网 HTTP(S) 网页文本并返回来源 URL；不执行脚本，不访问本机或私网。截断会明确标注。',Type.Object({url:Type.String(),maxChars:Type.Optional(Type.Integer({minimum:100,maximum:100000}))}),webFetch],
      ['web_search','网页检索','使用用户明确配置的 Brave Search 检索网页，返回标题、片段和来源 URL。未配置时报告不可用。',Type.Object({query:Type.String(),count:Type.Optional(Type.Integer({minimum:1,maximum:10}))}),webSearch],
    ] as const)api.registerTool({name,label,description,promptSnippet:description,parameters,annotations:{readOnlyHint:true},execute:async(_id,input,signal)=>{try{const result=await execute(input,signal);return {content:[{type:'text',text:JSON.stringify(result)}],details:result};}catch(error){throw publicError(error);}}});
  };
  async function dispatch(action:string,input:Json){
    check();refresh();
    if(action==='snapshot')return snapshot();
    if(action==='mcp.status'){await readStatus();return snapshot();}
    if(action==='mcp.test')return testServer(nameOf(input.name));
    if(action==='mcp.save'){
      const name=nameOf(input.name),prior=settings.servers.find(server=>server.name===name),config=serverConfig(input.config?record(input.config):input,prior?.config);
      if(config.enabled===true)await confirm('启用 MCP 服务','此服务将连接并向模型提供工具。'+('url' in config?'\n地址：'+config.url:'\n程序：'+config.command+' '+(config.args||[]).join(' ')));
      return mutate(input,latest=>{if(latest.servers.some(server=>server.name!==name&&server.name.replaceAll('-','_')===name.replaceAll('-','_')))throw new Error('服务名称与已有工具命名空间冲突');if(!prior&&latest.servers.length>=64)throw new Error('最多配置 64 个 MCP 服务');latest.servers=[...latest.servers.filter(server=>server.name!==name),{name,config}];});
    }
    if(action==='mcp.enable'){
      const name=nameOf(input.name),server=settings.servers.find(server=>server.name===name);if(!server)throw new Error('MCP 服务不存在');if(input.enabled===true)await confirm('启用 MCP 服务','此服务将连接并向模型提供工具。'+('url' in server.config?'\n地址：'+server.config.url:'\n程序：'+server.config.command));
      return mutate(input,latest=>{const target=latest.servers.find(server=>server.name===name);if(!target)throw new Error('MCP 服务不存在');target.config.enabled=input.enabled===true;});
    }
    if(action==='mcp.remove'){const name=nameOf(input.name);return mutate(input,latest=>{latest.servers=latest.servers.filter(server=>server.name!==name);});}
    if(action==='web.save'){
      if(input.provider!==undefined&&input.provider!=='brave')throw new Error('当前支持 Brave Search');
      return mutate(input,latest=>{if(input.clearKey===true)delete latest.web.apiKey;else if(typeof input.apiKey==='string'&&input.apiKey.trim()){const key=string(input.apiKey,'API Key',1024);if(!/^[\x21-\x7e]+$/.test(key))throw new Error('API Key 格式无效');latest.web.apiKey=key;}if(input.enabled!==undefined)latest.web.enabled=input.enabled===true;if(latest.web.enabled&&!latest.web.apiKey)throw new Error('请先保存 Brave API Key');webTest={};});
    }
    if(action==='web.fetch')return webFetch(input);
    if(action==='web.search')return webSearch(input);
    if(action==='web.test'){
      try{const result=await webSearch({query:'Brave Search API documentation',count:1});webTest={testedAt:new Date().toISOString(),diagnostic:'连接测试通过'};publish();return {ok:true,...webTest,sourceCount:result.sources.length};}catch(error){webTest={testedAt:new Date().toISOString(),diagnostic:publicError(error).message};publish();throw publicError(error);}
    }
    throw new Error('未知外部能力操作');
  }
  settings=load();
  return {extensionFactory,snapshot,call(action:string,input:Json={}){const task=serial.then(()=>dispatch(action,input));serial=task.catch(()=>{});return task.catch(error=>{throw publicError(error);});},async dispose(){if(disposed)return;disposed=true;shutdown.abort();if(pi)for(const name of registered.keys())pi.unregisterMcpServer(name);registered.clear();await Promise.allSettled([...connectionChanges]);context=undefined;}};
}
