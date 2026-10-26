import {useMemo} from 'react';
import {Card,Empty} from './ui.js';
import {memoryInjectionView,memoryReceiptStages,memorySourceText,type MemoryInjectionEntry,type MemoryInjectionTurn} from './memory-receipts.js';

/**
 * "What did this turn inject?" — reads the native memory-usage receipts the
 * desktop already exposes. Clicking a record shows its revision, hash, stages and
 * source entries; a catalog pointer is never presented as injected body.
 */
function ReceiptEntry({entry}:{entry:MemoryInjectionEntry}){
 const stages=memoryReceiptStages(entry.stages);
 return <details className="memory-diagnostic-details">
  <summary>{entry.title||entry.id} · v{entry.revision===undefined?'未记录':entry.revision} · {entry.label}</summary>
  <p className="hint">{entry.reason}</p>
  <p className="hint">阶段：{stages.length?stages.map(stage=>stage.label).join(' → '):'未记录'}{entry.catalog?' · 也在目录中':''}</p>
  {entry.hash&&<small>内容摘要 {entry.hash}</small>}
  {entry.conditions.length>0&&<p>适用条件：{entry.conditions.join('；')}</p>}
  <p className="hint">来源：{entry.sources.length?entry.sources.map(memorySourceText).join('；'):'来源未记录'}</p>
  {entry.content&&<p className="memory-summary">{entry.content}</p>}
 </details>;
}
function ReceiptGroup({title,entries,empty}:{title:string;entries:MemoryInjectionEntry[];empty:string}){
 return <section>
  <div className="item-heading"><strong>{title}</strong><small>{entries.length} 条</small></div>
  {entries.length?entries.map(entry=><ReceiptEntry entry={entry} key={entry.key}/>):<p className="hint">{empty}</p>}
 </section>;
}
function ReceiptTurn({turn}:{turn:MemoryInjectionTurn}){
 return <section className="memory-learning-batch">
  <div className="memory-diagnostic-heading"><strong>{turn.current?'本轮':turn.label}</strong>{turn.current&&<span className="badge badge-active">当前</span>}<small>{turn.receipts} 条回执 · {turn.operations.length} 次召回{turn.at?` · ${turn.at}`:''}</small></div>
  <p className="memory-diagnostic-caption">{turn.budget}</p>
  {turn.note&&<p className="memory-diagnostic-caption">{turn.note}</p>}
  <ReceiptGroup title="正文注入" entries={turn.injected} empty="本轮没有观察到正文进入上下文的回执。"/>
  <ReceiptGroup title="目录指针" entries={turn.catalog} empty="本轮没有仅目录可见的记录。"/>
  <ReceiptGroup title="未使用" entries={turn.unused} empty="没有选中但未注入的记录。"/>
  {turn.unknown.length>0&&<ReceiptGroup title="阶段未记录" entries={turn.unknown} empty=""/>}
 </section>;
}
export function MemoryReceiptsBody({receipts,runId}:{receipts:unknown;runId?:string}){
 const view=useMemo(()=>memoryInjectionView(receipts,runId),[receipts,runId]);
 if(!view.recorded)return <Empty title="尚无记忆注入回执">{view.reason}</Empty>;
 const turns=[...view.turns].sort((left,right)=>Number(right.current)-Number(left.current));
 return <div className="memory-receipts">
  <p className="hint">共 {view.receiptCount} 条回执（跨轮合计：正文注入 {view.counts.injected} 条 · 目录指针 {view.counts.catalog} 条 · 未使用 {view.counts.unused} 条{view.counts.unknown?` · 阶段未记录 ${view.counts.unknown} 条`:''}）。</p>
  {view.warnings.map(warning=><p role="status" className="memory-diagnostic-caption" key={warning}>{warning}</p>)}
  {turns.map(turn=><ReceiptTurn turn={turn} key={turn.runId||'unrecorded'}/>)}
  <p className="hint">注入回执只证明记录被送入上下文或请求，不证明模型采用，也不证明答案正确。</p>
 </div>;
}
export function MemoryReceipts({receipts,runId,title='本轮注入了哪些记忆'}:{receipts:unknown;runId?:string;title?:string}){
 return <Card title={title}><MemoryReceiptsBody receipts={receipts} runId={runId}/></Card>;
}
