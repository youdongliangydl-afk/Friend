import {useEffect,useRef,useState} from 'react';
import type {CustomInstructions} from '@friend-pi/core';
import {errorText} from './types.js';

type InstructionsSettings=CustomInstructions&{defaultText:string};
const MAX_INSTRUCTIONS_LENGTH=1_000;

export function CustomInstructionsPanel({onBusy,active=true}:{onBusy(busy:boolean):void;active?:boolean}) {
  const [saved,setSaved]=useState<InstructionsSettings>({text:'',revision:0,defaultText:''});
  const [draft,setDraft]=useState(''),[ready,setReady]=useState(false),[saving,setSaving]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[status,setStatus]=useState('');
  const dirty=ready&&draft!==saved.text;
  const tooLong=draft.length>MAX_INSTRUCTIONS_LENGTH,defaultPreview=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{if(active&&defaultPreview.current)defaultPreview.current.open=false;},[active]);
  useEffect(()=>{let active=true;void window.friendPi.request<InstructionsSettings>('instructions.get').then(value=>{if(active){setSaved(value);setDraft(value.text);setReady(true);}}).catch(e=>{if(active)setError(errorText(e));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);
  useEffect(()=>{onBusy(saving||dirty);return()=>onBusy(false);},[saving,dirty,onBusy]);
  async function reload() {
    setLoading(true);setError('');
    try {const value=await window.friendPi.request<InstructionsSettings>('instructions.get');setSaved(value);if(!ready)setDraft(value.text);setReady(true);setStatus('已重新读取；当前草稿保留，保存可覆盖最新版本。');}
    catch(e){setError(errorText(e));}finally{setLoading(false);}
  }
  async function save() {
    if(!ready||saving||loading||tooLong)return;
    setSaving(true);setError('');setStatus('');
    try {const value=await window.friendPi.request<InstructionsSettings>('instructions.update',{text:draft,revision:saved.revision});setSaved(value);setDraft(value.text);setStatus(value.text.trim()?'已保存，下轮对话生效。':'已恢复默认指令，下轮对话生效。');}
    catch(e){setError(errorText(e));}finally{setSaving(false);}
  }
  return <section className="custom-instructions">
    <div className="panel-intro"><h2>自定义指令</h2><p>告诉 Friend 你希望它如何回答，以及需要持续遵守的偏好。</p></div>
    <p id="instructions-help" className="hint">应用于所有项目的新会话和已有会话，包括 Team / Swarm 成员。保存后从下轮对话生效，正在进行的回复及其排队续写保持原配置。本轮明确要求优先于全局偏好。</p>
    {ready&&<p className="hint">{saved.text.trim()?'当前使用自定义指令，完整替换默认指令。':'当前使用默认指令。'}填写并保存后将完整替换默认指令；留空保存可恢复默认。</p>}
    {ready&&<details ref={defaultPreview}><summary>查看默认指令</summary><pre style={{whiteSpace:'pre-wrap',font:'inherit'}}>{saved.defaultText}</pre></details>}
    <form onSubmit={e=>{e.preventDefault();void save();}}>
      <label htmlFor="custom-instructions-text">Friend 指令</label>
      <textarea id="custom-instructions-text" aria-describedby={`instructions-help instructions-count${tooLong?' instructions-limit':''}`} aria-invalid={!!error||tooLong} disabled={!ready||saving||loading} maxLength={MAX_INSTRUCTIONS_LENGTH} rows={14} value={draft} placeholder="留空使用默认指令；填写内容将完整替换默认指令。" onChange={e=>{setDraft(e.target.value);setStatus('');}}/>
      <div className="instructions-meta"><span id="instructions-count">{draft.length.toLocaleString()} / {MAX_INSTRUCTIONS_LENGTH.toLocaleString()}</span><span role="status">{loading?'正在读取…':saving?'正在保存…':dirty?'有未保存的修改':status||'已与保存内容同步'}</span></div>
      {tooLong&&<p id="instructions-limit" role="alert">最多 {MAX_INSTRUCTIONS_LENGTH.toLocaleString()} 个字符；原内容已完整保留，请缩短后保存。</p>}
      {error&&<p role="alert">{error} <button type="button" disabled={saving||loading} onClick={()=>void reload()}>重新读取</button></p>}
      <div className="button-row"><button type="button" disabled={!ready||saving||loading||!draft} onClick={()=>{setDraft('');setStatus('');}}>恢复默认</button><span className="instructions-spacer"/><button type="button" disabled={!dirty||saving||loading} onClick={()=>{setDraft(saved.text);setError('');setStatus('已取消修改。');}}>取消修改</button><button className="primary" type="submit" disabled={!dirty||saving||loading||tooLong}>{saving?'保存中…':'保存'}</button></div>
    </form>
    <p className="hint">指令保存在当前设备，不会改写历史消息，也不会改变权限或工具规则。</p>
  </section>;
}
