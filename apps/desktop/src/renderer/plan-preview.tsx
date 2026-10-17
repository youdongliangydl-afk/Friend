import {useRef,useState} from 'react';
import {errorText} from './types.js';
export function PlanPreview({body,disabled,canApprove=true,requiresResubmission=false,onRead,onApprove,onRevise,onReject}:{body:string;disabled:boolean;canApprove?:boolean;requiresResubmission?:boolean;onRead():void;onApprove():void|Promise<unknown>;onRevise():void|Promise<unknown>;onReject():void|Promise<unknown>}) {
  const lock=useRef(false),[pending,setPending]=useState(false),[error,setError]=useState('');
  const perform=async(action:()=>void|Promise<unknown>)=>{if(lock.current)return;lock.current=true;setPending(true);setError('');try{await action();}catch(error){setError(errorText(error));}finally{lock.current=false;setPending(false);}};
  const excerpt=body.replace(/^\s{0,3}#{1,6}\s+/gm,'').replace(/[*`]/g,'').split('\n').filter(line=>line.trim()).join('\n').trim().slice(0,400);
  return <section className="plan-approval card" aria-label="就绪计划">
    <button type="button" className="plan-preview" onClick={onRead} aria-label="查看计划全文">
      <span className="plan-preview-heading"><strong>{requiresResubmission?'旧计划需重新提交':'计划已就绪'}</strong><span>查看全文 ↗</span></span>
      <span className="plan-preview-excerpt">{excerpt||'点击查看完整计划。'}</span>
    </button>
    {error&&<p role="alert">{error}</p>}
    <div className="button-row"><button className="primary" disabled={disabled||pending||!canApprove||requiresResubmission} onClick={()=>void perform(onApprove)}>{pending?'正在提交…':'批准并执行'}</button><button disabled={disabled||pending} onClick={()=>void perform(onRevise)}>要求修改</button><button disabled={disabled||pending} onClick={()=>void perform(onReject)}>退出计划</button></div>
  </section>;
}
