import {useState} from 'react';
import {DiffControls,DiffFileHeader,FileDiffView,type DiffMode} from './DiffView.js';
import {useChangeDiff,type ChangeDiffCache,type ChangeReviewTarget} from './change-review.js';
import {DiffFileBrowser} from './DiffFileBrowser.js';
import {selectedDiffIndex} from './diff-model.js';
function SelectedReviewBody({target,index,cache,mode,wrap}:{target:ChangeReviewTarget;index:number;cache:ChangeDiffCache;mode:DiffMode;wrap:boolean}){
 const coordinates={...target,index},state=useChangeDiff(cache,coordinates),file=target.files[index],bound=state?.phase==='ready'&&state.file.path!==file.path?{phase:'missing' as const,message:'历史文件身份不匹配，未显示其他文件正文。'}:state;
 return <><DiffFileHeader file={file}/><FileDiffView state={bound} split={mode==='split'} wrap={wrap} hideHeader retry={()=>void cache.load(coordinates)}/></>;
}
export function ChangeReview({target,cache,onWorkspace}:{target:ChangeReviewTarget;cache:ChangeDiffCache;onWorkspace():void}){
 const [selection,setSelection]=useState<{owner:string;index:number}>(),[mode,setMode]=useState<DiffMode>('split'),[wrap,setWrap]=useState(false);
 const identity=JSON.stringify([target.sessionId,target.runId,target.changeId,target.index]),index=selectedDiffIndex(identity,selection,target.files.length,target.index);
 const file=target.files[index];
 return <section className="friend-change-review change-review" aria-label="本轮文件变更">
  <div className="friend-diff-drag-rail" aria-hidden="true"/>
  <div className="friend-diff-toolbar"><span>冻结变更 · {target.files.length} 个文件</span>
   <DiffControls mode={mode} onMode={setMode} wrap={wrap} onWrap={setWrap}/></div>
  {file?<DiffFileBrowser key={identity} files={target.files} index={index} onSelect={index=>setSelection({owner:identity,index})}><div key={`${identity}:${index}`}><SelectedReviewBody target={target} index={index} cache={cache} mode={mode} wrap={wrap}/></div></DiffFileBrowser>:<p>此快照没有可查看的文件元信息。</p>}
  <div className="button-row"><button disabled={!file||file.status==='D'} onClick={()=>window.dispatchEvent(new CustomEvent('friend-pi:file-open',{detail:{path:file.path}}))}>打开当前文件全文</button><button onClick={onWorkspace}>查看当前工作区 Diff</button></div>
  <p className="hint">结束时间 {target.finishedAt} · 这是该轮结束时的比较。</p>
 </section>;
}
