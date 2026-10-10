import {useRef} from 'react';
import type {AttentionActivity} from '../session-attention.js';
import {Icon} from './Icons.js';

export interface ActivitySession {id: string; name: string; projectId?: string; projectName?: string; status?: string; archived?: boolean}
export interface ActivityCenterProps {
  activities: AttentionActivity[]; sessions: ActivitySession[]; pending?: boolean;
  onOpen(sessionId: string): void; onDismiss(activityId: string): void;
}
const statuses: Record<string, string> = {running: '执行中', awaiting_review: '等待复核', rebuilding: '整理上下文', stopping: '正在停止'};

export function ActivityCenter({activities, sessions, onOpen, onDismiss, pending = false}: ActivityCenterProps) {
  const root = useRef<HTMLDetailsElement>(null);
  const known = new Map(sessions.map(session => [session.id, session]));
  const visible = activities.filter(activity => known.has(activity.sessionId));
  const dialogs = visible.filter(activity => activity.kind === 'dialog');
  const results = visible.filter(activity => activity.unseen && (activity.kind === 'completed' || activity.kind === 'failed'));
  const waiting = new Set(dialogs.map(activity => activity.sessionId));
  const running = new Map(visible.filter(activity => activity.kind === 'running' && !waiting.has(activity.sessionId)).map(activity => [activity.sessionId, activity.status]));
  for (const session of sessions) if (!session.archived && statuses[session.status || ''] && !waiting.has(session.id) && !running.has(session.id)) running.set(session.id, session.status!);
  const count = dialogs.length + results.length;
  const open = (sessionId: string) => { if (pending) return; if (root.current) root.current.open = false; onOpen(sessionId); };
  const identity = (sessionId: string) => {
    const session = known.get(sessionId)!;
    return <><strong>{session.name}</strong><small>{session.projectName || (session.projectId ? '项目会话' : '临时会话')}</small></>;
  };
  return <details ref={root} className="activity-center" onKeyDown={event => {if (event.key === 'Escape' && root.current?.open) {event.stopPropagation(); root.current.open = false; root.current.querySelector('summary')?.focus();}}}>
    <summary aria-label={`任务中心，${dialogs.length} 项需处理，${running.size} 个执行中，${results.length} 项未读结果`}><Icon name="workbench" size={16}/><span>任务中心</span>{count > 0 && <span className="activity-center-count">{count}</span>}<span className="activity-center-chevron" aria-hidden="true">⌄</span></summary>
    <section className="activity-center-body" aria-label="跨会话任务">
      <header><strong>所有项目的任务</strong><span role="status" aria-live="polite">{dialogs.length ? `${dialogs.length} 项需处理` : running.size ? `${running.size} 个执行中` : results.length ? `${results.length} 项未读结果` : '当前没有待处理任务'}</span></header>
      {dialogs.length > 0 && <section className="activity-center-group"><h3>需要你处理</h3><ul>{dialogs.map(activity => <li key={activity.id} className="activity-center-row needs-attention"><button disabled={pending} className="activity-center-open" aria-label={`打开 ${known.get(activity.sessionId)!.name} 处理请求`} onClick={() => open(activity.sessionId)}><span className="activity-center-identity">{identity(activity.sessionId)}<span className="activity-center-detail">{activity.title}</span></span><span className="activity-center-state">前往处理</span></button></li>)}</ul><p className="activity-center-note">打开对应会话查看并决定，切换会话不会批准操作。</p></section>}
      {running.size > 0 && <section className="activity-center-group"><h3>正在执行</h3><ul>{[...running].map(([sessionId, status]) => <li key={sessionId} className="activity-center-row"><button disabled={pending} className="activity-center-open" aria-label={`打开执行中的 ${known.get(sessionId)!.name}`} onClick={() => open(sessionId)}><span className="activity-center-identity">{identity(sessionId)}</span><span className="activity-center-state">{statuses[status] || '执行中'}</span></button></li>)}</ul></section>}
      {results.length > 0 && <section className="activity-center-group"><h3>未读结果</h3><ul>{results.map(activity => <li key={activity.id} className={'activity-center-row result-' + activity.kind}><button disabled={pending} className="activity-center-open" aria-label={`查看 ${known.get(activity.sessionId)!.name} 的${activity.title}`} onClick={() => open(activity.sessionId)}><span className="activity-center-identity">{identity(activity.sessionId)}</span><span className="activity-center-state">{activity.title}</span></button><button disabled={pending} className="activity-center-dismiss" aria-label={`将 ${known.get(activity.sessionId)!.name} 的结果标为已读`} onClick={() => onDismiss(activity.id)}>已读</button></li>)}</ul></section>}
      {!dialogs.length && !running.size && !results.length && <p className="activity-center-empty">任务执行、等待处理和新结果会显示在这里。</p>}
    </section>
  </details>;
}
