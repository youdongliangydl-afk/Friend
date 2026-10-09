import {useMemo,useState,type SyntheticEvent} from 'react';
import {Badge,JsonView} from './ui.js';
import {projectTrajectory,searchTrajectory,groupTrajectory,traceDuration,type TraceRow,type TraceEntry} from './trace-projection.js';
import type {Message} from './types.js';
import type {ToolRun} from './timeline.js';
import type {TraceSystem} from '../message-projection.js';
const labels={input:'输入',context:'上下文',model:'模型',tool:'工具'};
function rowId(id:string){return 'trace-'+encodeURIComponent(id);}
function updated<T>(previous:Set<T>,id:T,collapsed:boolean){if(previous.has(id)===collapsed)return previous;const next=new Set(previous);if(collapsed)next.add(id);else next.delete(id);return next;}
export function Trajectory({messages,live,tools,running,systems=[]}:{messages:Message[];live:Message|null;tools:ToolRun[];running:boolean;systems?:TraceSystem[]}){
 const [query,setQuery]=useState(''),[actualDuration,setActualDuration]=useState(false);
 const [collapsedTurns,setCollapsedTurns]=useState(new Set<number>()),[collapsedCalls,setCollapsedCalls]=useState(new Set<string>());
 const rows=useMemo(()=>projectTrajectory(messages,live,tools,running,systems),[messages,live,tools,running,systems]);
 const filtered=useMemo(()=>searchTrajectory(rows,query),[rows,query]),allTurns=useMemo(()=>groupTrajectory(rows),[rows]);
 const turns=useMemo(()=>{const matches=new Set(filtered.map(row=>row.id));return allTurns.map(turn=>({...turn,entries:turn.entries.flatMap((entry):TraceEntry[]=>entry.kind==='row'?matches.has(entry.row.id)?[entry]:[]:entry.rows.some(row=>matches.has(row.id))?[{...entry,rows:entry.rows.filter(row=>matches.has(row.id))}]:[])})).filter(turn=>turn.entries.length);},[allTurns,filtered]);
 const turnIds=allTurns.filter(turn=>turn.round>0).map(turn=>turn.round),callIds=allTurns.flatMap(turn=>turn.entries.flatMap(entry=>entry.kind==='calls'?[entry.id]:[]));
 const allTurnsCollapsed=turnIds.length>0&&turnIds.every(id=>collapsedTurns.has(id)),allCallsCollapsed=callIds.length>0&&callIds.every(id=>collapsedCalls.has(id));
 const starts=rows.map(row=>row.timestamp).filter((time):time is number=>time!==undefined&&Number.isFinite(time));
 const ends=rows.map(row=>row.timestamp===undefined?undefined:row.timestamp+(row.durationMs||0)).filter((time):time is number=>time!==undefined&&Number.isFinite(time));
 const locate=(row:TraceRow)=>{
  const element=document.getElementById(rowId(row.id)) as HTMLDetailsElement|null;if(!element)return;
  setCollapsedTurns(previous=>updated(previous,row.round,false));
  const call=turns.flatMap(turn=>turn.entries).find(entry=>entry.kind==='calls'&&entry.rows.some(item=>item.id===row.id));
  if(call?.kind==='calls')setCollapsedCalls(previous=>updated(previous,call.id,false));
  element.open=true;for(let parent=element.parentElement;parent;parent=parent.parentElement)if(parent instanceof HTMLDetailsElement)parent.open=true;
  element.scrollIntoView({block:'center',behavior:'instant'});element.querySelector('summary')?.focus();
 };
 const rowView=(row:TraceRow)=><details id={rowId(row.id)} className={'trace-row '+row.kind} key={row.id}>
  <summary><span className="trace-round">{row.round?`第 ${row.round} 轮`:'初始'}</span><span className={'trace-kind '+row.kind}>{labels[row.kind]}</span><strong>{row.label}</strong><span className="trace-preview">{row.text.replace(/\s+/g,' ').slice(0,180)||(row.input===undefined?'查看原生记录':JSON.stringify(row.input)?.slice(0,180))}</span>{row.status&&<Badge value={row.status}/>}<small>{row.kind==='tool'||row.kind==='model'?traceDuration(row.durationMs):''}</small></summary>
  <div className="trace-detail">{row.text&&<pre>{row.text}</pre>}{row.input!==undefined&&<><h4>输入</h4><JsonView value={row.input}/></>}{row.output!==undefined&&<><h4>输出</h4><JsonView value={row.output}/></>}{row.metadata!==undefined&&<><h4>记录信息</h4><JsonView value={row.metadata}/></>}</div>
 </details>;
 const searching=Boolean(query.trim());
 const onFold=<T,>(event:SyntheticEvent<HTMLDetailsElement>,id:T,set:(fn:(value:Set<T>)=>Set<T>)=>void)=>{if(event.target!==event.currentTarget||searching)return;const collapsed=!event.currentTarget.open;set(previous=>updated(previous,id,collapsed));};
 const entriesView=(entries:TraceEntry[])=>entries.map(entry=>entry.kind==='row'?rowView(entry.row):<details className="trace-call-group" key={entry.id} open={searching||!collapsedCalls.has(entry.id)} onToggle={event=>onFold(event,entry.id,setCollapsedCalls)}>
  <summary>工具调用 · {entry.rows.length} 项</summary>{entry.rows.map(rowView)}
 </details>);
 return <section className="trajectory" aria-label="会话轨迹">
  <div className="trace-toolbar"><div className="trace-metrics"><span>记录跨度 {starts.length?traceDuration(Math.max(...ends)-Math.min(...starts)):'未记录'}</span><span>{Math.max(0,...rows.map(row=>row.round))} 轮</span><span>{rows.filter(row=>row.kind==='tool').length} 次工具调用</span></div>
   <label className="trace-search">搜索轨迹<input type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="模型、工具、输入或输出"/></label></div>
  <div className="trace-scale" role="toolbar" aria-label="轨迹展示与折叠">
   <button aria-label="使用实际耗时" aria-pressed={actualDuration} onClick={()=>setActualDuration(!actualDuration)}>时长</button>
   <button aria-label={allTurnsCollapsed?'展开全部轮次':'折叠全部轮次'} aria-pressed={allTurnsCollapsed} onClick={()=>setCollapsedTurns(previous=>{let next=previous;for(const id of turnIds)next=updated(next,id,!allTurnsCollapsed);return next;})}>轮次</button>
   <button aria-label={allCallsCollapsed?'展开全部调用':'折叠全部调用'} aria-pressed={allCallsCollapsed} onClick={()=>setCollapsedCalls(previous=>{let next=previous;for(const id of callIds)next=updated(next,id,!allCallsCollapsed);return next;})}>调用</button>
   <small>点击色块定位详情 · {actualDuration?'按记录耗时展示；缺失时使用最小宽度':'等宽展示'}</small>
  </div>
  <div className="trace-overview" aria-label="输入、模型和工具概览">{(['input','model','tool'] as const).map(track=><div className="trace-track" key={track}><span>{labels[track]}</span><div>{filtered.map(row=><div key={row.id} style={{flex:actualDuration?Math.max(1,row.durationMs||0):1}}>
   {(row.kind===track||track==='input'&&row.kind==='context')&&<button className={'trace-block '+row.kind+(row.status==='failed'?' failed':'')} aria-label={`${labels[row.kind]}：${row.label}，第 ${row.round} 轮`} title={row.label+' · '+traceDuration(row.durationMs)} onClick={()=>locate(row)}/>}</div>)}</div></div>)}</div>
  <p className="trace-hint">主会话原生记录与已保存的系统上下文；不代表提供商最终请求或成员的完整独立历史。</p>
  <div className="trace-rows">{turns.map(turn=>turn.round===0?<div key="initial">{entriesView(turn.entries)}</div>:<details className="trace-turn" key={turn.round} open={searching||!collapsedTurns.has(turn.round)} onToggle={event=>onFold(event,turn.round,setCollapsedTurns)}>
   <summary>第 {turn.round} 轮 <span>{turn.entries.find(entry=>entry.kind==='row'&&entry.row.kind==='input')?.kind==='row'?turn.entries.flatMap(entry=>entry.kind==='row'&&entry.row.kind==='input'?[entry.row.text]:[])[0]?.slice(0,120):''}</span></summary>{entriesView(turn.entries)}
  </details>)}{!filtered.length&&<p className="trace-empty">{query?'没有匹配的轨迹。请尝试工具名或输入输出中的词语。':'发送消息后，可在这里查看执行轨迹。'}</p>}</div>
 </section>;
}
