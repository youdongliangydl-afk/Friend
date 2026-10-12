import {useEffect,useState} from 'react';
import type {CustomInstructions} from '@friend-pi/core';
import {errorText} from './types.js';

export function CustomInstructionsPanel({onBusy}:{onBusy(busy:boolean):void}) {
  const [saved,setSaved]=useState<CustomInstructions>({text:'',revision:0});
  const [draft,setDraft]=useState(''),[ready,setReady]=useState(false),[saving,setSaving]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[status,setStatus]=useState('');
  const dirty=ready&&draft!==saved.text;
  useEffect(()=>{let active=true;void window.friendPi.request<CustomInstructions>('instructions.get').then(value=>{if(active){setSaved(value);setDraft(value.text);setReady(true);}}).catch(e=>{if(active)setError(errorText(e));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);
  useEffect(()=>{onBusy(saving||dirty);return()=>onBusy(false);},[saving,dirty,onBusy]);
  async function reload() {
    setLoading(true);setError('');
    try {const value=await window.friendPi.request<CustomInstructions>('instructions.get');setSaved(value);if(!ready)setDraft(value.text);setReady(true);setStatus('已重新读取；当前草稿保留，保存可覆盖最新版本。');}
    catch(e){setError(errorText(e));}finally{setLoading(false);}
  }
  async function save() {
    if(!ready||saving||loading)return;
    setSaving(true);setError('');setStatus('');
    try {const value=await window.friendPi.request<CustomInstructions>('instructions.update',{text:draft,revision:saved.revision});setSaved(value);setDraft(value.text);setStatus(value.text.trim()?'已保存，下轮对话生效。':'已清空，下轮对话不再添加自定义指令。');}
    catch(e){setError(errorText(e));}finally{setSaving(false);}
  }
  return <section className="custom-instructions">
    <div className="panel-intro"><h2>自定义指令</h2><p>告诉 Friend 你希望它如何回答，以及需要持续遵守的偏好。</p></div>
    <p id="instructions-help" className="hint">应用于所有项目的新会话和已有会话，包括 Team / Swarm 成员。保存后从下轮对话生效，正在进行的回复及其排队续写保持原配置。本轮明确要求优先于全局偏好。</p>
    <form onSubmit={e=>{e.preventDefault();void save();}}>
      <label htmlFor="custom-instructions-text">Friend 指令</label>
      <textarea id="custom-instructions-text" aria-describedby="instructions-help instructions-count" aria-invalid={!!error} disabled={!ready||saving||loading} maxLength={32000} rows={14} value={draft} placeholder="例如：先给出核心结论，使用简洁的中文回答；不确定时明确说明。" onChange={e=>{setDraft(e.target.value);setStatus('');}}/>
      <div className="instructions-meta"><span id="instructions-count">{draft.length.toLocaleString()} / 32,000</span><span role="status">{loading?'正在读取…':saving?'正在保存…':dirty?'有未保存的修改':status||'已与保存内容同步'}</span></div>
      {error&&<p role="alert">{error} <button type="button" disabled={saving||loading} onClick={()=>void reload()}>重新读取</button></p>}
      <div className="button-row"><button type="button" disabled={!ready||saving||loading||!draft} onClick={()=>{setDraft('');setStatus('');}}>清空</button><span className="instructions-spacer"/><button type="button" disabled={!dirty||saving||loading} onClick={()=>{setDraft(saved.text);setError('');setStatus('已取消修改。');}}>取消修改</button><button className="primary" type="submit" disabled={!dirty||saving||loading}>{saving?'保存中…':'保存'}</button></div>
    </form>
    <p className="hint">留空即可停用。指令保存在当前设备，不会改写历史消息，也不会改变权限或工具规则。</p>
  </section>;
}
