import {useRef,type UIEvent} from 'react';
import type {JsonObject} from './types.js';
import type {ChangeDiffState} from './change-review.js';
type SplitRow={left?:JsonObject;right?:JsonObject;meta?:JsonObject};
function pairedRows(lines:JsonObject[]){
 const rows:SplitRow[]=[];
 for(let i=0;i<lines.length;){
  const line=lines[i];
  if(line.kind==='meta'){rows.push({meta:line});i++;}
  else if(line.kind==='context'){rows.push({left:line,right:line});i++;}
  else{
   const removed:JsonObject[]=[],added:JsonObject[]=[];
   while(i<lines.length&&['remove','add'].includes(String(lines[i].kind)))(lines[i].kind==='remove'?removed:added).push(lines[i++]);
   for(let j=0;j<Math.max(removed.length,added.length);j++)rows.push({left:removed[j],right:added[j]});
  }
 }
 return rows;
}
function Cell({line,side}:{line?:JsonObject;side:'left'|'right'}){
 return <pre className={line?`diff-${line.kind}`:'diff-empty'}><small>{String(line?.[side==='left'?'oldLine':'newLine']??'')}</small><code>{String(line?.text??'')||'\u00a0'}</code></pre>;
}
/** DSH SplitColumns adaptation: clip each side and synchronize browser-clamped scroll offsets. */
function SplitColumns({rows}:{rows:SplitRow[]}){
 const columns=useRef<Record<'left'|'right',HTMLDivElement|null>>({left:null,right:null});
 const offsets=useRef({left:{scrollLeft:0,scrollTop:0},right:{scrollLeft:0,scrollTop:0}});
 const follow=(side:'left'|'right')=>(event:UIEvent<HTMLDivElement>)=>{
  const peer=side==='left'?'right':'left',other=columns.current[peer];if(!other)return;
  for(const axis of ['scrollLeft','scrollTop'] as const){
   const value=event.currentTarget[axis];if(offsets.current[side][axis]===value)continue;
   offsets.current[side][axis]=value;other[axis]=value;offsets.current[peer][axis]=other[axis];
  }
 };
 return <div className="diff-split-columns">{(['left','right'] as const).map(side=><div className="diff-split-column" data-diff-side={side} key={side} ref={element=>{columns.current[side]=element;}} onScroll={follow(side)}>
  {rows.map((row,i)=>row.meta?<pre className="diff-split-meta" key={i}>{String(row.meta.text)}</pre>:<Cell key={i} line={row[side]} side={side}/>)}
 </div>)}</div>;
}
export function DiffRows({lines,split,wrap=false}:{lines:JsonObject[];split:boolean;wrap?:boolean}){
 if(!split)return <pre className="diff-lines">{lines.map((line,i)=><span className={`diff-${line.kind}`} key={i}><small>{String(line.oldLine??'')}</small><small>{String(line.newLine??'')}</small><code>{line.kind==='add'?'+':line.kind==='remove'?'-':' '}{String(line.text)}{'\n'}</code></span>)}</pre>;
 const rows=pairedRows(lines);
 if(!wrap)return <SplitColumns rows={rows}/>;
 return <div className="diff-split-table">{rows.map((row,i)=>row.meta?<pre className="diff-split-meta" key={i}>{String(row.meta.text)}</pre>:<div className="diff-split-row" key={i}>{(['left','right'] as const).map(side=><Cell key={side} line={row[side]} side={side}/>)}</div>)}</div>;
}

export function FileDiffView({state,split=false,wrap=false,preview=false,retry}:{state:ChangeDiffState|undefined;split?:boolean;wrap?:boolean;preview?:boolean;retry():void}){
 if(!state||state.phase==='loading')return <p role="status">读取本轮变更…</p>;
 if(state.phase==='missing')return <p>{state.message}</p>;
 if(state.phase==='error')return <p role="alert">{state.message} <button onClick={retry}>重试</button></p>;
 const file=state.file;
 if(file.error)return <p role="alert">{file.error}</p>;
 if(file.binary)return <p>二进制或大文件，仅提供变更信息</p>;
 const lines=file.lines.filter(line=>line.kind!=='meta'||!preview&&line.text.startsWith('@@')).slice(0,5000);
 const additions=lines.some(line=>line.kind==='add'),removals=lines.some(line=>line.kind==='remove');
 return <div className={'file-diff-view '+(wrap?'wrap':'nowrap')}>
  {!preview&&<p className="diff-file-note">{file.status==='A'?'本轮新建的文件':file.status==='D'?'本轮删除的文件':'本轮开始 → 本轮结束'}</p>}
  {file.patch.startsWith('diff 比较超时')&&<p className="diff-file-note">比较超时，按整文件替换展示。</p>}
  {!lines.length?<p>此文件没有文本行变化</p>:<DiffRows lines={lines as unknown as JsonObject[]} split={split&&additions&&removals} wrap={wrap}/>}
  {(file.truncated||file.lines.length>5000)&&<p>比较内容已截取；最多显示 5,000 行。</p>}
 </div>;
}
