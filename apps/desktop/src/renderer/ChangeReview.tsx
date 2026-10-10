import {useEffect,useState} from 'react';
import {DiffControls,DiffFileHeader,FileDiffView,type DiffMode} from './DiffView.js';
import {useChangeDiff,type ChangeDiffCache,type ChangeReviewTarget} from './change-review.js';
export function ChangeReview({target,cache,onWorkspace}:{target:ChangeReviewTarget;cache:ChangeDiffCache;onWorkspace():void}){
 const [index,setIndex]=useState(target.index),[mode,setMode]=useState<DiffMode>('split'),[wrap,setWrap]=useState(false);
 useEffect(()=>{setIndex(target.index);},[target]);
 const coordinates={...target,index},state=useChangeDiff(cache,coordinates),file=target.files[index];
 return <section className="friend-change-review change-review" aria-label="本轮文件变更">
  <div className="friend-diff-drag-rail" aria-hidden="true"/>
  <div className="friend-diff-toolbar"><label>冻结变更<select aria-label="本轮变更文件" value={index} onChange={event=>setIndex(Number(event.target.value))}>{target.files.map((file,i)=><option key={file.path} value={i}>{file.path}</option>)}</select></label>
   <DiffControls mode={mode} onMode={setMode} wrap={wrap} onWrap={setWrap}/></div>
  {file&&<DiffFileHeader file={file}/>}
  <FileDiffView state={state} split={mode==='split'} wrap={wrap} hideHeader retry={()=>void cache.load(coordinates)}/>
  <div className="button-row"><button disabled={!file||file.status==='D'} onClick={()=>window.dispatchEvent(new CustomEvent('friend-pi:file-open',{detail:{path:file.path}}))}>打开当前文件全文</button><button onClick={onWorkspace}>查看当前工作区 Diff</button></div>
  <p className="hint">结束时间 {target.finishedAt} · 这是该轮结束时的比较。</p>
 </section>;
}
