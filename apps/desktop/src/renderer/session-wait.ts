import type {AttentionActivity} from '../session-attention.js';
/** "在等你" three waiting states plus the running indicator derived from one session snapshot. */
export type SessionWaitKind = 'confirm' | 'review' | 'question' | 'running';
export interface SessionWait { kind: SessionWaitKind; label: string; detail: string; tone: { background: string; color: string } }
export type WaitSession = { id: string; status?: string; planStatus?: string };
export type WaitActivity = Pick<AttentionActivity, 'sessionId' | 'kind' | 'status' | 'dialog'>;
export const sessionWaitLabels: Record<SessionWaitKind, string> = { confirm: '待确认', review: '待审核', question: '待回答', running: '进行中' };
export const sessionWaitDetails: Record<SessionWaitKind, string> = { confirm: '权限或确认卡等待你处理', review: '计划已提交，等待你批准', question: '提问卡等待你回答', running: '当前回合正在执行' };
/** Presentation tones stay semantic so the sidebar can style without owning the derivation. */
export const sessionWaitColors: Record<SessionWaitKind, { background: string; color: string }> = {
  confirm: { background: '#f9ede5', color: '#a97058' },
  review: { background: '#f5f1dc', color: '#a59462' },
  question: { background: '#e8eef7', color: '#7189b7' },
  running: { background: '#eaf3e5', color: '#7a9b66' },
};
const runningStatuses = ['running', 'awaiting_review', 'rebuilding', 'stopping'];
/** Cards that block the user: permission/confirm first, every other dialog asks for an answer. */
const dialogWaits: Record<string, SessionWaitKind> = { confirm: 'confirm', input: 'question', select: 'question', editor: 'question', questionBatch: 'question' };
const wait = (kind: SessionWaitKind): SessionWait => ({ kind, label: sessionWaitLabels[kind], detail: sessionWaitDetails[kind], tone: sessionWaitColors[kind] });
/** Priority: confirm > question > review > running. */
export function sessionWait(session: WaitSession, activities: WaitActivity[]): SessionWait | undefined {
  const own = activities.filter(activity => activity.sessionId === session.id);
  const cards = new Set(own.filter(activity => activity.kind === 'dialog').map(activity => dialogWaits[String(activity.dialog?.kind)]));
  if (cards.has('confirm')) return wait('confirm');
  if (cards.has('question')) return wait('question');
  // Plan approval lives in the session plan record; awaiting_review is a Swarm graph state, not a plan.
  if (session.planStatus === 'proposed') return wait('review');
  if (own.some(activity => activity.kind === 'running') || runningStatuses.includes(session.status || '')) return wait('running');
  // A projected snapshot may only say awaiting_user; without card details confirm is the safe reading.
  if (session.status === 'awaiting_user') return wait('confirm');
  return undefined;
}
export function sessionWaits(sessions: WaitSession[], activities: WaitActivity[]): Record<string, SessionWait> {
  const waits: Record<string, SessionWait> = {};
  for (const session of sessions) { const value = sessionWait(session, activities); if (value) waits[session.id] = value; }
  return waits;
}
