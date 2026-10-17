import {useState} from 'react';
import type {QueueSnapshot,QueuedInput} from '../message-queue.js';
export interface QueueUi {menuId?:string;editing?:Record<string,string>}
export function QueueMessages({queue,ui,act,setUi}:{queue?:QueueSnapshot&{suspendedGoal?:{objective:string}};ui?:QueueUi;act(input:Record<string,unknown>):Promise<unknown>;setUi(input:QueueUi):void}){
 const editing=ui?.editing||{};const [pending,setPending]=useState(''),[error,setError]=useState('');

 if(!queue||!queue.items.length)return null;
 const operate=async(action:string,item?:QueuedInput,extra:Record<string,unknown>={})=>{setError('');setPending(item?.id||action);try{await act({action,id:item?.id,revision:item?.revision,...extra});const texts={...ui?.editing};if(item&&action==='edit')texts[item.id]=item.text;if(item&&['save','cancelEdit','remove','sidechat'].includes(action))delete texts[item.id];setUi({editing:texts});}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setPending('');}};
 return <section className="queued-messages" aria-label="排队消息">
  <div className="queue-heading"><span>{queue.items.length?`${queue.items.length} 条排队消息`:'消息队列'}{queue.paused?' · 已暂停':''}</span>{queue.paused&&<button onClick={()=>void operate('resume')} disabled={!!pending}>恢复排队</button>}</div>
  <div className="queue-list">{queue.items.map(item=>{const disabled=!!pending||!['queued','editing'].includes(item.state);return <div className={'queue-item state-'+item.state} key={item.id}>
   <div className="queue-row"><span className="queue-glyph" aria-hidden="true">↳</span>{item.attachments.slice(0,2).map(a=>a.image?<img key={a.hash+a.name} src={`data:${a.image.mimeType};base64,${a.image.data}`} alt={a.name}/>:<span key={a.hash+a.name} className="queue-attachment" title={a.name}>▤</span>)}<span className="queue-text" title={item.text}>{item.text||item.attachments.map(a=>a.name).join('、')}</span>
    {item.state==='unknown'?<span className="queue-state">发送状态待确认</span>:item.state==='dispatching'?<span className="queue-state">正在交付</span>:item.state==='moving'?<span className="queue-state">正在移入独立会话</span>:<button disabled={disabled} onClick={()=>void operate('steer',item)} title="在下一安全边界补充当前执行">↪ 引导</button>}
    <button aria-label={'删除排队消息 '+item.text} disabled={!!pending||['dispatching','moving'].includes(item.state)} onClick={()=>void operate('remove',item)}>⌫</button><button aria-label={'更多排队操作 '+item.text} aria-expanded={ui?.menuId===item.id} disabled={!!pending||['dispatching','moving'].includes(item.state)} onClick={()=>setUi({...ui,menuId:ui?.menuId===item.id?undefined:item.id})}>⋯</button>
   </div>
   {ui?.menuId===item.id&&<div className="queue-menu" role="group" aria-label="消息操作" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();setUi({editing:ui?.editing});}}}><button disabled={disabled} onClick={()=>void operate('edit',item)}>编辑消息</button><button disabled={!!pending||['dispatching','moving'].includes(item.state)} onClick={()=>void operate('sidechat',item)}>在独立会话中打开</button><button disabled={!!pending} onClick={()=>void operate(queue.paused?'resume':'pause')}>{queue.paused?'恢复排队':'关闭排队'}</button></div>}
   {item.state==='editing'&&<div className="queue-editor"><textarea rows={3} disabled={!!pending} aria-label="编辑排队消息" value={editing[item.id]??item.text} onChange={e=>setUi({...ui,editing:{...editing,[item.id]:e.target.value}})}/>{item.attachments.length>0&&<small>保留 {item.attachments.length} 个原始附件</small>}<div><button disabled={!!pending} onClick={()=>void operate('cancelEdit',item)}>取消</button><button disabled={!!pending||!(editing[item.id]??item.text).trim()&&!item.attachments.length} onClick={()=>void operate('save',item,{text:editing[item.id]??item.text})}>保存</button></div></div>}
  </div>;})}</div>{error&&<p className="queue-error" role="alert">{error}</p>}
 </section>;
}
