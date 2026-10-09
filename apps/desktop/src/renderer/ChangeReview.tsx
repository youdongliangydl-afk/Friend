import {useEffect,useState} from 'react';
import {FileDiffView} from './DiffView.js';
import {useChangeDiff,type ChangeDiffCache,type ChangeReviewTarget} from './change-review.js';
export function ChangeReview({target,cache,onWorkspace}:{target:ChangeReviewTarget;cache:ChangeDiffCache;onWorkspace():void}){
 const [index,setIndex]=useState(target.index),[split,setSplit]=useState(true),[wrap,setWrap]=useState(false);
 useEffect(()=>{setIndex(target.index);},[target]);
 const coordinates={...target,index},state=useChangeDiff(cache,coordinates),file=target.files[index];
 return <section className="panel-content change-review" aria-label="本轮文件变更">
  <div className="diff-controls"><label>变更文件<select aria-label="本轮变更文件" value={index} onChange={event=>setIndex(Number(event.target.value))}>{target.files.map((file,i)=><option key={file.path} value={i}>{file.path}</option>)}</select></label>
   <button aria-pressed={split} onClick={()=>setSplit(!split)}>{split?'切换行内':'切换双栏'}</button><button aria-pressed={wrap} onClick={()=>setWrap(!wrap)}>自动换行</button></div>
  <div className="change-review-heading"><strong>{file?.path}</strong><span className="change-counts">{file?.error?'统计失败':file?.binary?'二进制或大文件':typeof file?.additions==='number'&&typeof file?.deletions==='number'?<><span className="added">+{file.additions}</span><span className="removed">−{file.deletions}</span></>:'行数未记录'}</span></div>
  <FileDiffView state={state} split={split} wrap={wrap} retry={()=>void cache.load(coordinates)}/>
  <div className="button-row"><button disabled={!file||file.status==='D'} onClick={()=>window.dispatchEvent(new CustomEvent('friend-pi:file-open',{detail:{path:file.path}}))}>打开当前文件全文</button><button onClick={onWorkspace}>查看当前工作区 Diff</button></div>
  <p className="hint">结束时间 {target.finishedAt} · 这是该轮结束时的比较。</p>
 </section>;
}
