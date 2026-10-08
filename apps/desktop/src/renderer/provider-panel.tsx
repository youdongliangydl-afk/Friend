import {useState} from 'react';
import {providerPresets} from '../provider-presets.js';
import {Field} from './ui.js';
import {errorText,type AppState} from './types.js';

export function ProviderPanel({state,report,refresh}:{state:AppState;report(message:string,error?:boolean):void;refresh():Promise<AppState>}) {
  const initial=providerPresets.find(item=>item.provider===state.current?.modelId?.split('/')[0])||providerPresets[0];
  const preferred=(id:string)=>{const preset=providerPresets.find(item=>item.id===id),provider=preset?.provider||id;const list=state.models.filter(item=>item.provider===provider);const saved=list.find(item=>item.id===state.preferences?.defaultModelId);return saved?.id.slice(provider.length+1)||preset?.preferredModels.find(key=>list.some(item=>item.id===`${preset.provider}/${key}`))||list[0]?.id.split('/').slice(1).join('/')||preset?.preferredModels[0]||'';};
  const initialModel=state.models.find(item=>item.id===`${initial.provider}/${preferred(initial.id)}`);
  const [choice,setChoice]=useState(initial.id),[custom,setCustom]=useState(''),[apiKey,setApiKey]=useState('');
  const [modelId,setModelId]=useState(preferred(initial.id)),[baseUrl,setBaseUrl]=useState(initialModel?.baseUrl||initial.baseUrl),[api,setApi]=useState(initialModel?.api||initial.api);
  const [override,setOverride]=useState(false),[pending,setPending]=useState(false),[testing,setTesting]=useState(''),[makeDefault,setMakeDefault]=useState(true);
  const [reasoning,setReasoning]=useState(false),[images,setImages]=useState(false),[contextWindow,setContextWindow]=useState(32768);
  const preset=providerPresets.find(item=>item.id===choice),provider=choice==='__custom'?custom:preset?.provider||choice;
  const native=preset?.native??choice!=='__custom',models=state.models.filter(item=>item.provider===provider);
  const customConnection=!native||override,selectedModel=models.find(item=>item.id===`${provider}/${modelId}`);
  const choose=(id:string)=>{const next=providerPresets.find(item=>item.id===id),first=state.models.find(item=>item.id===`${next?.provider||id}/${preferred(id)}`);setChoice(id);setApiKey('');setOverride(false);setModelId(preferred(id));setBaseUrl(first?.baseUrl===next?.migrateBaseUrlFrom?next!.baseUrl:first?.baseUrl||next?.baseUrl||'');setApi(first?.api||next?.api||'openai-completions');setReasoning(false);setImages(false);setContextWindow(32768);};
  const submit=async()=>{setPending(true);try{
    await window.friendPi.request('provider.save',{provider,apiKey,...(preset?{presetId:preset.id}:{}),...(customConnection?{baseUrl,api,modelId,...(choice==='__custom'?{reasoning,input:images?['text','image']:['text'],contextWindow}:{})}:{}),...(makeDefault&&modelId?{defaultModelId:`${provider}/${modelId}`}:{})});
    setApiKey('');await refresh();report('模型配置已保存'+(makeDefault?'，新会话将使用所选模型':''));
  }catch(error){report(errorText(error),true);}finally{setPending(false);}};
  return <section className="provider-setup"><div className="panel-intro"><h2>配置模型</h2><p>选择厂商并填写 API Key，公开接口参数已预填。</p></div>
    <form className="card" onSubmit={event=>{event.preventDefault();void submit();}}>
      <Field label="模型厂商"><select aria-label="模型厂商" value={choice} disabled={pending} onChange={event=>choose(event.target.value)}>
        <optgroup label="热门厂商">{providerPresets.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>
        <optgroup label="更多 Pi 厂商">{state.providers.filter(item=>item.supportsApiKey!==false&&!providerPresets.some(preset=>preset.provider===item.id)).map(item=><option key={item.id} value={item.id}>{item.name}{item.configured?' · 已配置':''}</option>)}</optgroup>
        <option value="__custom">自定义兼容接口</option>
      </select></Field>
      {choice==='__custom'&&<Field label="供应商 ID"><input value={custom} onChange={event=>setCustom(event.target.value)} required placeholder="例如 my-provider"/></Field>}
      {preset?.note&&<p className="hint provider-note">{preset.note}</p>}
      <Field label="API Key"><input type="password" autoComplete="off" spellCheck={false} disabled={pending} value={apiKey} onChange={event=>setApiKey(event.target.value)} placeholder={state.providers.some(item=>item.id===provider&&item.configured)?'留空保留已保存凭证':'粘贴该厂商的 API Key'}/></Field>
      {native&&models.length>0?<Field label="默认模型"><select aria-label="默认配置模型" value={modelId} disabled={pending} onChange={event=>setModelId(event.target.value)}>{models.map(item=><option value={item.id.slice(provider.length+1)} key={item.id}>{item.name}</option>)}</select></Field>:<Field label={preset?.requiresModel?'Model ID / 推理接入点 ID':'默认模型'}><input aria-label="配置型号" value={modelId} disabled={pending} onChange={event=>setModelId(event.target.value)} required placeholder={preset?.requiresModel?'已开通的模型 ID 或 ep-…':'实际模型 ID'}/></Field>}
      <label className="check"><input type="checkbox" checked={makeDefault} disabled={pending} onChange={event=>setMakeDefault(event.target.checked)}/>设为新会话默认模型</label>
      <details key={choice} className="provider-advanced" open={choice==='__custom'}><summary>高级连接设置</summary>
        {native&&<label className="check"><input type="checkbox" checked={override} onChange={event=>setOverride(event.target.checked)}/>自定义接入地址</label>}
        <Field label="Base URL"><input aria-label="配置 Base URL" value={selectedModel?.baseUrl&&!customConnection&&selectedModel.baseUrl!==preset?.migrateBaseUrlFrom?selectedModel.baseUrl:baseUrl} disabled={!customConnection||pending} onChange={event=>setBaseUrl(event.target.value)} type="url" required={customConnection}/></Field>
        <Field label="API 协议"><select aria-label="配置 API 协议" value={selectedModel?.api&&!customConnection?selectedModel.api:api} disabled={!customConnection||pending} onChange={event=>setApi(event.target.value)}><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option><option value="google-generative-ai">Google Gemini</option></select></Field>
        {choice==='__custom'&&<><label className="check"><input type="checkbox" checked={reasoning} onChange={event=>setReasoning(event.target.checked)}/>支持思考</label><label className="check"><input type="checkbox" checked={images} onChange={event=>setImages(event.target.checked)}/>支持图片输入</label><Field label="上下文容量"><input type="number" min={4096} value={contextWindow} onChange={event=>setContextWindow(Number(event.target.value))}/></Field></>}
        {preset&&<p className="hint">预配置来源：<a href={preset.source} target="_blank" rel="noreferrer">厂商官方文档 ↗</a></p>}
      </details>
      <button type="submit" className="primary full" disabled={pending||!provider.trim()||!modelId.trim()||customConnection&&!baseUrl.trim()||!apiKey.trim()&&!state.providers.some(item=>item.id===provider&&item.configured)}>{pending?'保存中…':'保存模型配置'}</button>
    </form>
    <div className="provider-list">{state.providers.filter(item=>item.configured).map(item=><div key={item.id}><span className="status-dot"/>{providerPresets.find(preset=>preset.provider===item.id)?.name||item.name}<small>已配置</small><button disabled={!!testing} onClick={()=>{const id=item.id===provider&&modelId?`${provider}/${modelId}`:state.models.find(model=>model.provider===item.id)?.id;if(!id)return;setTesting(item.id);void window.friendPi.request('model.test',{modelId:id}).then(()=>report('模型连接测试通过')).catch(error=>report(errorText(error),true)).finally(()=>setTesting(''));}}>{testing===item.id?'测试中…':'测试连接'}</button></div>)}</div>
  </section>;
}
