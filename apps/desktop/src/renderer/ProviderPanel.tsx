import {useEffect,useRef,useState} from 'react';
import {Field,Empty} from './ui.js';
import {errorText,type AppState,type Model} from './types.js';

interface Draft {apiKey:string;baseUrl:string;modelId:string;api:string;reasoning:boolean;images:boolean;contextWindow:number}
const blank=(provider:string):Draft=>({apiKey:'',baseUrl:'',modelId:'',api:provider==='openai'?'openai-responses':provider==='anthropic'?'anthropic-messages':'openai-completions',reasoning:false,images:false,contextWindow:128000});
export function ProviderPanel({state,report,refresh,onBusy}:{onBusy(busy:boolean):void;state:AppState;report(message:string,error?:boolean):void;refresh():Promise<AppState>}){
  const initial=state.models[0]?.provider||'openai';
  const [provider,setProvider]=useState(initial),[custom,setCustom]=useState(''),[draft,setDraft]=useState<Draft>(blank(initial));
  const drafts=useRef(new Map<string,Draft>()),[saving,setSaving]=useState(false),[testing,setTesting]=useState(''),[error,setError]=useState('');
  const busy=saving||!!testing;useEffect(()=>onBusy(busy),[busy,onBusy]);const actualProvider=provider==='__custom'?custom:provider;
  const update=(changes:Partial<Draft>)=>setDraft(value=>({...value,...changes}));
  const changeProvider=(id:string)=>{drafts.current.set(provider,draft);setProvider(id);setDraft(drafts.current.get(id)||blank(id));setError('');};
  const edit=(model:Model)=>{drafts.current.set(provider,draft);const known=state.providers.some(item=>item.id===model.provider);setProvider(known?model.provider:'__custom');if(!known)setCustom(model.provider);setDraft({apiKey:'',baseUrl:model.baseUrl||'',modelId:model.id.slice(model.provider.length+1),api:model.api||'openai-completions',reasoning:model.reasoning,images:model.input?.includes('image')||false,contextWindow:model.contextWindow});setError('');};
  const test=async(model:Model)=>{setTesting(model.id);setError('');try{await window.friendPi.request('model.test',{modelId:model.id});await refresh();report('连接测试通过：'+model.name);}catch(err){const message=errorText(err);setError(message);report(message,true);await refresh().catch(()=>{});}finally{setTesting('');}};
  return <div className="model-settings"><div className="panel-intro"><h2>你的模型</h2><p>只展示你保存的具体型号。每个型号通过连接测试后才能发送消息。</p></div>
    <div className="saved-model-list">{!state.models.length?<Empty title="尚未配置模型">填写下方型号与凭证，保存后测试连接。</Empty>:state.models.map(model=><article className="saved-model" key={model.id}><div><strong>{model.name}</strong><code>{model.id}</code><small>{model.ready?'连接测试已通过':model.connectionStatus==='failed'?'连接测试失败':'待测试连接'}{model.testedAt?' · '+new Date(model.testedAt).toLocaleString():''}</small></div><span className={'model-state '+(model.ready?'ready':'')}>{model.ready?'可用':'待验证'}</span><button disabled={busy} onClick={()=>edit(model)}>编辑</button><button disabled={busy} onClick={()=>void test(model)}>{testing===model.id?'测试中…':'测试连接'}</button></article>)}</div>
    {error&&<p role="alert" className="inline-error model-config-error">{error}</p>}
    <form className="card model-config-form" onSubmit={event=>{event.preventDefault();setSaving(true);setError('');void window.friendPi.request('provider.save',{provider:actualProvider,...draft,apiKey:draft.apiKey,baseUrl:draft.baseUrl.trim()||undefined,modelId:draft.modelId.trim(),input:draft.images?['text','image']:['text']}).then(async()=>{setDraft(value=>({...value,apiKey:''}));await refresh();report('型号已保存，请测试此型号的连接');}).catch(err=>{setError(errorText(err));report(errorText(err),true);}).finally(()=>setSaving(false));}}>
      <h3>配置型号</h3><Field label="供应商"><select value={provider} disabled={busy} onChange={e=>changeProvider(e.target.value)}>{state.providers.map(item=><option value={item.id} key={item.id}>{item.name}{item.configured?' · 凭证已配置':''}</option>)}{!state.providers.some(item=>item.id===provider)&&provider!=='__custom'&&<option value={provider}>{provider}</option>}<option value="__custom">其他兼容供应商</option></select></Field>
      {provider==='__custom'&&<Field label="供应商 ID"><input value={custom} disabled={busy} onChange={e=>setCustom(e.target.value)} required placeholder="例如 my-provider"/></Field>}
      <Field label="型号 ID"><input value={draft.modelId} disabled={busy} onChange={e=>update({modelId:e.target.value})} required placeholder="供应商提供的实际型号，例如 gpt-6.1-sol"/></Field>
      <Field label="API Key"><input type="password" autoComplete="off" spellCheck={false} value={draft.apiKey} disabled={busy} onChange={e=>update({apiKey:e.target.value})} placeholder="输入凭证；留空保留已保存凭证"/></Field>
      <Field label="Base URL"><input type="url" value={draft.baseUrl} disabled={busy} onChange={e=>update({baseUrl:e.target.value})} placeholder="留空使用此型号的默认地址" required={provider==='__custom'}/></Field>
      <details><summary>协议与模型能力</summary><Field label="API 协议"><select value={draft.api} disabled={busy} onChange={e=>update({api:e.target.value})}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></Field><label className="check"><input type="checkbox" disabled={busy} checked={draft.reasoning} onChange={e=>update({reasoning:e.target.checked})}/>支持思考</label><label className="check"><input type="checkbox" disabled={busy} checked={draft.images} onChange={e=>update({images:e.target.checked})}/>支持图片输入</label><Field label="上下文容量"><input type="number" min={4096} disabled={busy} value={draft.contextWindow} onChange={e=>update({contextWindow:Number(e.target.value)})}/></Field></details>
      <button className="primary full" disabled={busy||!actualProvider.trim()||!draft.modelId.trim()}>{saving?'保存中…':'保存型号配置'}</button>
    </form>
  </div>;
}
