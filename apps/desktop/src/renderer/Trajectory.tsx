import { useMemo, useState } from 'react';
import { Badge, JsonView } from './ui.js';
import { projectTrajectory, searchTrajectory, traceDuration, type TraceRow } from './trace-projection.js';
import type { Message } from './types.js';
import type { ToolRun } from './timeline.js';
import type { TraceSystem } from '../message-projection.js';
const labels = { input: '输入', context: '上下文', model: '模型', tool: '工具' };
function rowId(id: string) { return 'trace-' + encodeURIComponent(id); }
export function Trajectory({ messages, live, tools, running, systems = [] }: { messages: Message[]; live: Message | null; tools: ToolRun[]; running: boolean; systems?: TraceSystem[] }) {
  const [query, setQuery] = useState(''), [scale, setScale] = useState('call');
  const rows = useMemo(() => projectTrajectory(messages, live, tools, running, systems), [messages, live, tools, running, systems]);
  const filtered = useMemo(() => searchTrajectory(rows, query), [rows, query]);
  const starts = rows.map(row => row.timestamp).filter((time): time is number => time !== undefined && Number.isFinite(time));
  const ends = rows.map(row => row.timestamp === undefined ? undefined : row.timestamp + (row.durationMs || 0)).filter((time): time is number => time !== undefined && Number.isFinite(time));
  const roundCounts=new Map<number,number>();for(const row of filtered)roundCounts.set(row.round,(roundCounts.get(row.round)||0)+1);
  const locate = (row: TraceRow) => { const element = document.getElementById(rowId(row.id)) as HTMLDetailsElement | null; if (element) { element.open = true; element.scrollIntoView({ block: 'center', behavior: 'instant' }); element.querySelector('summary')?.focus(); } };
  return <section className="trajectory" aria-label="会话轨迹">
    <div className="trace-toolbar"><div className="trace-metrics"><span>记录跨度 {starts.length ? traceDuration(Math.max(...ends) - Math.min(...starts)) : '未记录'}</span><span>{Math.max(0, ...rows.map(row => row.round))} 轮</span><span>{rows.filter(row => row.kind === 'tool').length} 次工具调用</span></div>
      <label className="trace-search">搜索轨迹<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="模型、工具、输入或输出"/></label></div>
    <div className="trace-scale" role="group" aria-label="轨迹概览尺度">{[['time', '时长'], ['round', '轮次'], ['call', '调用']].map(([id, label]) => <button key={id} aria-pressed={scale === id} onClick={() => setScale(id)}>{label}</button>)}<small>点击色块定位详情 · 时长缺失的记录按最小宽度显示</small></div>
    <div className="trace-overview" aria-label="输入、模型和工具概览">{(['input', 'model', 'tool'] as const).map(track => <div className="trace-track" key={track}><span>{labels[track]}</span><div>{filtered.map(row => <div key={row.id} style={{ flex: scale === 'time' ? Math.max(1, (row.durationMs || 0) / 100) : scale === 'round' ? 1 / roundCounts.get(row.round)! : 1 }}>
      {(row.kind === track || track === 'input' && row.kind === 'context') && <button className={'trace-block ' + row.kind + (row.status === 'failed' ? ' failed' : '')} aria-label={`${labels[row.kind]}：${row.label}，第 ${row.round} 轮`} title={row.label + ' · ' + traceDuration(row.durationMs)} onClick={() => locate(row)}/>}</div>)}</div></div>)}</div>
    <p className="trace-hint">主会话原生记录与已保存的系统上下文；不代表提供商最终请求或成员的完整独立历史。</p>
    <div className="trace-rows">{filtered.map(row => <details id={rowId(row.id)} className={'trace-row ' + row.kind} key={row.id}><summary><span className="trace-round">{row.round ? `第 ${row.round} 轮` : '初始'}</span><span className={'trace-kind ' + row.kind}>{labels[row.kind]}</span><strong>{row.label}</strong><span className="trace-preview">{row.text.replace(/\s+/g, ' ').slice(0, 180) || (row.input === undefined ? '查看原生记录' : JSON.stringify(row.input)?.slice(0, 180))}</span>{row.status && <Badge value={row.status}/>}<small>{row.kind === 'tool' || row.kind === 'model' ? traceDuration(row.durationMs) : ''}</small></summary>
      <div className="trace-detail">{row.text && <pre>{row.text}</pre>}{row.input !== undefined && <><h4>输入</h4><JsonView value={row.input}/></>}{row.output !== undefined && <><h4>输出</h4><JsonView value={row.output}/></>}{row.metadata !== undefined && <><h4>记录信息</h4><JsonView value={row.metadata}/></>}</div></details>)}
      {!filtered.length && <p className="trace-empty">{query ? '没有匹配的轨迹。请尝试工具名或输入输出中的词语。' : '发送消息后，可在这里查看执行轨迹。'}</p>}</div>
  </section>;
}
