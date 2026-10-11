import {useId,useRef,useState} from 'react';
import type {RunChangesSummary} from '../run-changes.js';
import {ChangePreview} from './ChangePreview.js';
import {ChangeDiffCache,type ChangeReviewTarget} from './change-review.js';
export function ChangedFiles({summary,sessionId,cache,workspacePath}:{summary:RunChangesSummary;sessionId?:string;cache?:ChangeDiffCache;workspacePath?:string}){
 const [expanded,setExpanded]=useState(false),[ownCache]=useState(()=>new ChangeDiffCache());const cardRef=useRef<HTMLElement>(null),description=useId(),diffCache=cache||ownCache;
 const unavailable=summary.unavailable||('error' in summary&&summary.error?(typeof summary.error==='string'?summary.error:'本轮改动统计失败'):undefined);
 const incomplete=!!summary.truncated||!!summary.omittedFiles||(summary.fileCount!==undefined&&summary.fileCount!==summary.files.length);
 if(!summary.files.length&&!unavailable&&!incomplete)return null;
 const additions=summary.files.reduce((n,file)=>n+(file.additions||0),0),deletions=summary.files.reduce((n,file)=>n+(file.deletions||0),0),single=summary.files.length===1?summary.files[0]:undefined;
 const displayPath=(path:string)=>path.startsWith('/')||!workspacePath?path:workspacePath.replace(/[\\/]+$/,'')+'/'+path;
 const coordinates=(index:number)=>({sessionId:sessionId||summary.sessionId,runId:summary.runId,changeId:summary.changeId,index});
 const open=(index:number)=>{const detail:ChangeReviewTarget={...coordinates(index),files:summary.files,finishedAt:summary.finishedAt};window.dispatchEvent(new CustomEvent('friend-pi:changes-review',{detail}));};
 const counts=(file:RunChangesSummary['files'][number])=>file.error?<small>统计失败</small>:file.binary?<small>二进制或大文件</small>:typeof file.additions==='number'&&typeof file.deletions==='number'?<span className="change-counts"><span className="added">+{file.additions}</span><span className="removed">−{file.deletions}</span></span>:<small>行数未记录</small>;
 const header=<button className="run-changes-header" disabled={!!unavailable||!summary.files.length} aria-label={single?'查看变更：'+single.path:'查看本轮全部变更'} aria-describedby={single?description:undefined} onClick={()=>open(0)}>
  <div><strong>{unavailable?'本轮改动统计不可用':single?'已改动 '+single.path:summary.files.length?`已改动 ${summary.files.length} 个文件`:'本轮改动统计不完整'}</strong>
   <small>{summary.status==='completed'?'执行结束':summary.status==='stopped'?'已停止，保留已有变化':'执行未完成，保留已有变化'}{summary.truncated||summary.omittedFiles?' · 比较有预算边界':incomplete?' · 统计不完整':''}</small></div>
  {!unavailable&&!!summary.files.length&&(single?counts(single):<span className="change-counts"><span className="added">+{additions}</span><span className="removed">−{deletions}</span></span>)}
  {!unavailable&&!!summary.files.length&&<span className="change-review-hint">查看 Diff</span>}
 </button>;
 return <section ref={cardRef} className="run-changes" aria-label="本轮改动文件">
  {single?<ChangePreview cardRef={cardRef} cache={diffCache} coordinates={coordinates(0)} path={displayPath(single.path)} anchor={header}/>:header}<span id={description} hidden>{single?displayPath(single.path):undefined}</span>
  {unavailable?<p>{unavailable}</p>:!single&&<ul>{(expanded?summary.files:summary.files.slice(0,4)).map((file,index)=><li key={file.path}>
   <ChangePreview cardRef={cardRef} cache={diffCache} coordinates={coordinates(index)} path={displayPath(file.path)} anchor={<button className="changed-file-link" aria-label={'查看变更：'+file.path} aria-describedby={description+'-'+index} onClick={()=>open(index)}><span>{file.path}</span><span>{file.status==='D'&&<small>已删除 · </small>}{counts(file)}</span></button>}/><span id={description+'-'+index} hidden>{displayPath(file.path)}</span>
  </li>)}</ul>}
  {summary.files.length>4&&<button className="show-changed-files" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{expanded?'收起文件列表':`全部 ${summary.files.length} 个文件`}</button>}
  <p className="change-note">{summary.note}{summary.omittedFiles?` 文件共 ${summary.fileCount??summary.files.length+summary.omittedFiles} 项，其中 ${summary.omittedFiles} 项未展示。`:''}</p>
 </section>;
}
