import {useEffect,useRef,useState} from 'react';
import type {ExternalCapabilitiesSnapshot} from '../external-capabilities.js';
import {Field,Empty} from './ui.js';
import {errorText} from './types.js';
import {capabilityCatalog,capabilityCounts,type CapabilitySection} from './capability-catalog.js';

interface Draft {name:string;type:'stdio'|'http';command:string;args:string;cwd:string;url:string;env:string;headers:string;enabled:boolean}
const blank=():Draft=>({name:'',type:'stdio',command:'',args:'',cwd:'',url:'',env:'',headers:'',enabled:false});
const states:Record<string,string>={disabled:'已停用',connecting:'连接中',connected:'已连接',failed:'连接失败',disconnected:'连接已断开','needs-auth':'需要认证',unchecked:'待检查'};
/** Each section renders exactly what its data source returned; an empty source never becomes sample data. */
const sectionView=(section:CapabilitySection)=>{const counts=capabilityCounts(section);return <section key={section.kind} className="card" aria-label={section.title}>
  <div className="card-heading"><h3>{section.title}</h3><span className="hint">{section.entries.length?`${section.entries.length} 项 · 已加载 ${counts.loaded} · 当前会话可用 ${counts.available}`:'空态'}</span></div>
  <p className="hint">{section.hint} 来源：{section.source}。</p>
  {section.entries.length?<ul className="capability-tool-list">{section.entries.map(entry=><li key={entry.id}>
    <div className="capability-service-heading"><strong>{entry.name}</strong><span>{[[entry.configured,'已配置'],[entry.loaded,'已加载'],[entry.available,'当前会话可用']].map(([value,label])=><span key={String(label)} className={'capability-state '+(value?'connected':'disabled')}>{value?'✓':'—'} {String(label)}</span>)}</span></div>
    {entry.description&&<p>{entry.description}</p>}
    {entry.reason&&<p className="hint" role="status">{entry.reason}</p>}
  </li>)}</ul>:<Empty title="暂无条目">{section.emptyReason}</Empty>}
</section>;};
export function CapabilitiesPanel({sessionId,report,plugins,defaultPlugins}:{sessionId:string;plugins?:string[];defaultPlugins?:string[];report?:(message:string,error?:boolean)=>void}){
  const [state,setState]=useState<ExternalCapabilitiesSnapshot>(),[draft,setDraft]=useState(blank),[editing,setEditing]=useState(''),[busy,setBusy]=useState(''),[error,setError]=useState(''),[key,setKey]=useState(''),[searchEnabled,setSearchEnabled]=useState(false),[remove,setRemove]=useState(''),[snapshotError,setSnapshotError]=useState(''),[references,setReferences]=useState<{items?:unknown[];error?:string;loading?:boolean}>({loading:true});
  const generation=useRef(0),mounted=useRef(true);
  const call=<T,>(action:string,input:Record<string,unknown>={})=>window.friendPi.request<T>('runtime.call',{sessionId,action:'external.call',input:{action,input}});
  useEffect(()=>{mounted.current=true;const current=++generation.current;setState(undefined);setDraft(blank());setEditing('');setBusy('');setRemove('');setSearchEnabled(false);setKey('');setError('');setSnapshotError('');void call<ExternalCapabilitiesSnapshot>('snapshot').then(value=>{if(mounted.current&&current===generation.current){setState(value);setSearchEnabled(value.web.enabled);setSnapshotError('');}}).catch(err=>{if(current===generation.current){const message=errorText(err);setSnapshotError(message);setError(message);}});return()=>{mounted.current=false;generation.current++;};},[sessionId]);
  const referenceGeneration=useRef(0);
  const loadReferences=()=>{const current=++referenceGeneration.current;setReferences({loading:true});void window.friendPi.request<{items?:unknown[]}>('reference.list',{sessionId,type:'/',query:''}).then(value=>{if(current===referenceGeneration.current)setReferences({items:Array.isArray(value.items)?value.items:[]});}).catch(err=>{if(current===referenceGeneration.current)setReferences({error:errorText(err)});});};
  useEffect(()=>{loadReferences();return()=>{referenceGeneration.current++;};},[sessionId]);
  const update=(changes:Partial<Draft>)=>setDraft(value=>({...value,...changes}));
  const run=async(name:string,operation:()=>Promise<unknown>,message?:string,onSuccess?:()=>void)=>{if(busy)return;const current=generation.current;setBusy(name);setError('');try{const result=await operation();if(current!==generation.current)return;const value=await call<ExternalCapabilitiesSnapshot>('snapshot');if(current===generation.current){setState(value);onSuccess?.();if(message)report?.(message);return result;}}catch(err){if(current===generation.current){setError(errorText(err));report?.(errorText(err),true);}}finally{if(mounted.current&&current===generation.current)setBusy('');}};
  const catalog=capabilityCatalog({plugins:plugins===undefined&&defaultPlugins===undefined?undefined:{enabled:plugins,defaults:defaultPlugins},mcp:{snapshot:state??null,error:snapshotError||undefined,loading:!state&&!snapshotError},references});
  const json=(text:string,label:string)=>{if(!text.trim())return undefined;let value:unknown;try{value=JSON.parse(text);}catch{throw new Error(label+'须为 JSON 对象');}if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(label+'须为 JSON 对象');return value;};
  return <section className="capabilities-panel" aria-label="外部能力设置">
    <div className="panel-intro"><h2>能力中心</h2><p>统一查看 Skills、Plugins、MCP 与 Slash 的三态；在下方连接和管理 MCP 服务与网页检索。</p></div>
    <h3>统一能力中心</h3><p className="hint">三态依次为：已配置（存在配置）→ 已加载（运行时已加载）→ 当前会话可用（本会话可调用）。失败项给出具体原因；没有数据源的分区保持空态，不列出示例。</p>
    {references.error&&<p className="hint" role="status">运行时清单读取失败：{references.error}<button type="button" onClick={loadReferences}>重试</button></p>}
    <div className="capability-catalog">{catalog.sections.map(sectionView)}</div>
    <h3>MCP 与外部工具</h3><p className="hint">连接你的工具服务，或让 Friend 查找和读取网页。</p>
    <div className="capabilities-toolbar"><span>当前会话的连接与工具</span><button disabled={!!busy} onClick={()=>void run('refresh',()=>call('mcp.status'))}>{busy==='refresh'?'刷新中…':'刷新状态'}</button></div>
    {error&&<p className="inline-error" role="alert">{error}</p>}
    {!state&&!error?<p role="status">正在读取配置…</p>:<>
      <div className="capability-services">{!state?.servers.length?<Empty title="尚未添加工具服务">添加一个 MCP 服务，保存后测试连接并启用。</Empty>:state.servers.map(server=><article className="card capability-service" key={server.name}>
        <div className="capability-service-heading"><div><strong>{server.name}</strong><small>{server.type==='http'?'Streamable HTTP':'本地程序'} · 最近发现 {server.tools.length} 个工具</small></div><span className={'capability-state '+server.state}>{states[server.state]||server.state}</span></div>
        <code className="capability-endpoint">{server.url||[server.command,...server.args||[]].join(' ')}</code>
        {server.testedAt&&<p className="hint">最近测试：{new Date(server.testedAt).toLocaleString()}</p>}
        <div className="capability-actions"><button disabled={!!busy} onClick={()=>void run('test:'+server.name,async()=>{const result=await call<{ok:boolean;diagnostic?:string}>('mcp.test',{name:server.name});if(!result.ok)throw new Error(result.diagnostic||'连接测试未通过');},'连接测试通过：'+server.name)}>{busy==='test:'+server.name?'测试中…':'测试连接'}</button>
          <button disabled={!!busy} onClick={()=>void run('enable:'+server.name,()=>call('mcp.enable',{name:server.name,enabled:!server.enabled,revision:state.revision}),server.enabled?'服务已停用':'服务已启用')}>{server.enabled?'停用':'启用'}</button>
          <button disabled={!!busy} onClick={()=>{setEditing(server.name);setDraft({name:server.name,type:server.type,command:server.command||'',args:server.args?.join('\n')||'',cwd:server.cwd||'',url:server.urlRedacted?'':server.url||'',env:'',headers:'',enabled:server.enabled});setError('');}}>编辑</button>
          <button disabled={!!busy} onClick={()=>setRemove(server.name)}>移除</button>
        </div>
        {remove===server.name&&<div className="capability-remove" role="group" aria-label="确认移除服务"><span>移除此服务并关闭连接？</span><button disabled={!!busy} onClick={()=>void run('remove',()=>call('mcp.remove',{name:server.name,revision:state.revision}),'服务已移除',()=>setRemove(''))}>确认移除</button><button disabled={!!busy} onClick={()=>setRemove('')}>取消</button></div>}
        {server.tools.length>0&&<details><summary>查看工具清单</summary><ul className="capability-tool-list">{server.tools.map(tool=><li key={tool.name}><strong>{tool.label}</strong><code>{tool.name}</code><p>{tool.description}</p><small>{tool.readOnly?'服务声明为只读':'调用前检查权限'}{!server.enabled?' · 服务未启用':''}</small><details><summary>输入参数</summary><pre>{JSON.stringify(tool.parameters,null,2)}</pre></details></li>)}</ul></details>}
        {server.diagnostic&&<details><summary>连接诊断</summary><pre className="capability-diagnostic">{server.diagnostic}</pre></details>}
      </article>)}</div>
      <form className="card capability-form" onSubmit={event=>{event.preventDefault();void run('save',async()=>{const config={type:draft.type,enabled:draft.enabled,...(draft.type==='stdio'?{command:draft.command,args:draft.args.split('\n').filter(Boolean),cwd:draft.cwd,env:json(draft.env,'环境变量')}:{url:draft.url.trim()||undefined,headers:json(draft.headers,'请求头')})};await call('mcp.save',{name:draft.name,config,revision:state?.revision});},'服务配置已保存',()=>{setDraft(blank());setEditing('');});}}>
        <h3>{editing?'编辑工具服务':'添加工具服务'}</h3><Field label="服务名称"><input required value={draft.name} disabled={!!busy||!!editing} onChange={event=>update({name:event.target.value})} placeholder="例如 docs-tools" pattern="[A-Za-z0-9_-]+"/></Field>
        <Field label="连接方式"><select disabled={!!busy} value={draft.type} onChange={event=>update({type:event.target.value as Draft['type']})}><option value="stdio">本地程序（stdio）</option><option value="http">服务地址（Streamable HTTP）</option></select></Field>
        {draft.type==='stdio'?<><Field label="可执行程序" hint="填写程序名称或绝对路径；每个参数单独填在下一栏。"><input required disabled={!!busy} value={draft.command} onChange={event=>update({command:event.target.value})} placeholder="例如 npx"/></Field><Field label="程序参数" hint="每行一个参数，空格会保留在该参数中。"><textarea disabled={!!busy} value={draft.args} onChange={event=>update({args:event.target.value})} rows={3} placeholder={'-y\n@your-org/mcp-server'}/></Field></>:<Field label="服务地址" hint={editing?'含认证参数的已保存地址不回显；留空保留。':undefined}><input type="url" required={!editing} disabled={!!busy} value={draft.url} onChange={event=>update({url:event.target.value})} placeholder="https://example.com/mcp"/></Field>}
        <details><summary>认证与高级设置</summary>{draft.type==='stdio'?<><Field label="运行目录" hint="留空使用当前项目目录。"><input disabled={!!busy} value={draft.cwd} onChange={event=>update({cwd:event.target.value})}/></Field><Field label="环境变量（JSON）" hint={editing?'已保存值不回显。留空保留；填写 {} 清除。':'例如 {"API_KEY":"你的凭证"}；凭证保存在私有配置中。'}><textarea disabled={!!busy} value={draft.env} onChange={event=>update({env:event.target.value})} rows={3} autoComplete="off" spellCheck={false}/></Field></>:<Field label="请求头（JSON）" hint={editing?'已保存值不回显。留空保留；填写 {} 清除。':'例如 {"Authorization":"Bearer 你的凭证"}。'}><textarea disabled={!!busy} value={draft.headers} onChange={event=>update({headers:event.target.value})} rows={3} autoComplete="off" spellCheck={false}/></Field>}</details>
        <div className="capability-actions"><button className="primary" disabled={!!busy}>{busy==='save'?'保存中…':'保存服务'}</button>{editing&&<button type="button" disabled={!!busy} onClick={()=>{setDraft(blank());setEditing('');}}>取消编辑</button>}</div><p className="hint">新服务默认停用。测试或启用可能启动你配置的程序；工具调用沿用权限确认。</p>
      </form>
      <form className="card capability-form" onSubmit={event=>{event.preventDefault();void run('web.save',()=>call('web.save',{provider:'brave',apiKey:key,enabled:searchEnabled,revision:state?.revision}),'网页检索配置已保存',()=>setKey(''));}}><h3>网页检索</h3><p>使用 Brave Search 查找资料，结果包含标题、片段和来源。</p><Field label="Brave API Key"><input type="password" autoComplete="new-password" spellCheck={false} disabled={!!busy} value={key} onChange={event=>setKey(event.target.value)} placeholder={state?.web.configured?'凭证已保存；留空保留':'粘贴 Brave Search API Key'}/></Field><label className="check"><input type="checkbox" disabled={!!busy} checked={searchEnabled} onChange={event=>setSearchEnabled(event.target.checked)}/>启用网页检索</label><div className="capability-actions"><button className="primary" disabled={!!busy}>{busy==='web.save'?'保存中…':'保存检索配置'}</button><button type="button" disabled={!!busy||!state?.web.enabled||!state?.web.configured} onClick={()=>void run('web.test',()=>call('web.test'),'网页检索连接测试通过')}>{busy==='web.test'?'测试中…':'测试连接'}</button><button type="button" onClick={()=>void window.friendPi.request('link.open',{url:state?.web.source||'https://api-dashboard.search.brave.com/app/documentation/web-search/query'}).catch(err=>setError(errorText(err)))}>官方说明 ↗</button></div>{state?.web.diagnostic&&<p className="hint" role="status">{state.web.diagnostic}{state.web.testedAt?' · '+new Date(state.web.testedAt).toLocaleString():''}</p>}</form>
      <div className="card capability-fetch"><h3>网页读取 · 已就绪</h3><p>对话中可以让 Friend 读取公网 HTTP(S) 网页。返回正文与来源；超出长度时会标明截断。</p><small>不执行网页脚本，不读取本机、私网或本地文件。</small></div>
    </>}
    {busy&&<p className="capability-busy" role="status">{busy.startsWith('test:')?'正在建立连接并读取工具清单…':'正在处理…'}</p>}
  </section>;
}
