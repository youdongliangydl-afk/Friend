export type AttentionGeneration = string | number;
export interface AttentionOwner { sessionId: string; generation: AttentionGeneration; runId?: string }
export interface AttentionDialog {
  id: string; kind: 'confirm' | 'input' | 'select' | 'editor'; title: string;
  message?: string; options?: string[]; prefill?: string; placeholder?: string;
}
export interface AttentionActivity extends AttentionOwner {
  id: string; kind: 'dialog' | 'running' | 'completed' | 'failed';
  title: string; status: string; createdAt: number; updatedAt: number;
  unseen: boolean; expiresAt?: number; dialog?: AttentionDialog;
}
export interface AttentionNotification {
  id: string; activityId: string; sessionId: string; runId?: string;
  kind: 'dialog' | 'completed' | 'failed'; title: string; body: string;
}
export interface AttentionView { sessionId?: string; foreground: boolean; muted?: boolean }
export interface AttentionRunState { runId?: string; isRunning?: boolean; lifecycleStatus?: string }
interface WorkerState { generation: AttentionGeneration; runId?: string; active: boolean }
const runningStatuses = new Set(['running', 'awaiting_review', 'rebuilding', 'stopping']);
const dialogKinds = new Set(['confirm', 'input', 'select', 'editor']);
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const key = (owner: AttentionOwner, kind: string, id = '') => JSON.stringify([owner.sessionId, owner.generation, kind, id]);

function safeText(value: string): string {
  return value.replace(/\b(?:sk-|pk-|ghp_|github_pat_)[A-Za-z0-9_-]{8,}\b/g, '[隐藏凭据]')
    .replace(/((?:api[ _-]?key|token|password|secret|authorization)["']?\s*[=:：]\s*["']?)(?:Bearer\s+)?[^\s,;，；"'}]+/gi, '$1[隐藏凭据]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [隐藏凭据]')
    .replace(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[隐藏凭据]');
}
function dialogRequest(value: unknown): AttentionDialog | undefined {
  const raw = object(value);
  if (typeof raw.id !== 'string' || !raw.id || raw.id.length > 200 || !dialogKinds.has(String(raw.kind)) || typeof raw.title !== 'string') return;
  const request: AttentionDialog = {id: raw.id, kind: raw.kind as AttentionDialog['kind'], title: safeText(raw.title)};
  for (const field of ['message', 'prefill', 'placeholder'] as const) if (typeof raw[field] === 'string') request[field] = safeText(raw[field]);
  if (Array.isArray(raw.options) && raw.options.every(option => typeof option === 'string')) request.options = raw.options.map(option => safeText(option));
  return request;
}
function copy(activity: AttentionActivity): AttentionActivity {
  return {...activity, ...(activity.dialog ? {dialog: {...activity.dialog, ...(activity.dialog.options ? {options: [...activity.dialog.options]} : {})}} : {})};
}

/** The host owns this live index; Pi remains the authority for execution and history. */
export class AttentionRegistry {
  private workers = new Map<string, WorkerState>();
  private activities = new Map<string, AttentionActivity>();
  private announced = new Set<string>();
  private notifications: AttentionNotification[] = [];
  private view: AttentionView = {foreground: false};
  private readonly now: () => number;
  constructor(options: {now?: () => number} = {}) { this.now = options.now || Date.now; }

  register(sessionId: string, generation: AttentionGeneration): boolean {
    if (!sessionId || typeof generation !== 'string' && typeof generation !== 'number' || typeof generation === 'number' && !Number.isFinite(generation) || generation === '') throw new Error('会话运行时身份无效');
    const prior = this.workers.get(sessionId);
    if (prior?.generation === generation) return false;
    if (prior) this.retire({sessionId, generation: prior.generation});
    this.workers.set(sessionId, {generation, active: false});
    return true;
  }
  private owns(owner: AttentionOwner): boolean { return this.workers.get(owner.sessionId)?.generation === owner.generation; }
  private viewed(sessionId: string): boolean { return this.view.foreground && this.view.sessionId === sessionId; }
  private announce(activity: AttentionActivity): void {
    if (activity.kind === 'running' || this.announced.has(activity.id)) return;
    this.announced.add(activity.id);
    if (this.view.muted || this.viewed(activity.sessionId)) return;
    this.notifications.push({id: activity.id, activityId: activity.id, sessionId: activity.sessionId, runId: activity.runId, kind: activity.kind,
      title: activity.kind === 'dialog' ? 'Friend 需要你处理' : activity.kind === 'failed' ? 'Friend 任务遇到问题' : 'Friend 本轮执行结束',
      body: '打开对应会话查看详情。'});
  }

  setView(view: AttentionView): boolean {
    this.view = {...view};
    this.notifications = this.notifications.filter(item => !view.muted && !this.viewed(item.sessionId));
    let changed = this.expire();
    if (view.foreground && view.sessionId) for (const [id, activity] of this.activities) {
      if (activity.sessionId === view.sessionId && (activity.kind === 'completed' || activity.kind === 'failed')) { this.activities.delete(id); changed = true; }
      else if (activity.sessionId === view.sessionId && activity.unseen) { activity.unseen = false; changed = true; }
    }
    return changed;
  }
  captureDialog(owner: AttentionOwner, raw: unknown, ttlMs = 60_000): boolean {
    this.expire();
    if (!this.owns(owner)) return false;
    const worker = this.workers.get(owner.sessionId)!;
    if (owner.runId !== undefined && worker.runId !== undefined && owner.runId !== worker.runId) return false;
    const request = dialogRequest(raw);
    if (!request) return false;
    const id = key(owner, 'dialog', request.id);
    if (this.activities.has(id) || this.announced.has(id)) return false;
    const now = this.now(), supplied = object(raw).expiresAt;
    const expiresAt = typeof supplied === 'number' && Number.isFinite(supplied) ? supplied : now + (Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 60_000);
    if (expiresAt <= now) return false;
    const activity: AttentionActivity = {...owner, id, kind: 'dialog', title: request.title, status: 'waiting', createdAt: now, updatedAt: now, unseen: !this.viewed(owner.sessionId), expiresAt, dialog: request};
    this.activities.set(id, activity); this.announce(activity); return true;
  }
  getDialog(owner: AttentionOwner, id: string): AttentionDialog | undefined {
    this.expire();
    if (!this.owns(owner)) return;
    const activity = this.activities.get(key(owner, 'dialog', id));
    return activity ? copy(activity).dialog : undefined;
  }
  closeDialog(owner: AttentionOwner, id: string): boolean {
    if (!this.owns(owner)) return false;
    const activityId = key(owner, 'dialog', id);
    this.announced.add(activityId);
    return this.activities.delete(activityId);
  }
  clearDialogs(owner: AttentionOwner): boolean {
    if (!this.owns(owner)) return false;
    let changed = false;
    for (const [id, activity] of this.activities) if (activity.sessionId === owner.sessionId && activity.generation === owner.generation && activity.kind === 'dialog' && (owner.runId === undefined || activity.runId === owner.runId)) { this.activities.delete(id); changed = true; }
    return changed;
  }
  retire(owner: AttentionOwner): boolean {
    if (!this.owns(owner)) return false;
    for (const [id, activity] of this.activities) if (activity.sessionId === owner.sessionId && activity.generation === owner.generation && (activity.kind === 'dialog' || activity.kind === 'running')) this.activities.delete(id);
    this.workers.delete(owner.sessionId); return true;
  }

  observeState(owner: AttentionOwner, state: AttentionRunState): boolean {
    if (!this.owns(owner)) return false;
    const worker = this.workers.get(owner.sessionId)!, runId = state.runId || owner.runId;
    const status = state.lifecycleStatus || (state.isRunning ? 'running' : 'idle');
    const active = state.isRunning === true || runningStatuses.has(status);
    const priorActive = worker.active, priorRun = worker.runId;
    if (!active && worker.runId !== undefined && runId !== worker.runId) return false;
    worker.active = active; worker.runId = runId;
    let changed = this.expire();
    const id = key(owner, 'running', runId);
    for (const [oldId, activity] of this.activities) if (activity.sessionId === owner.sessionId && activity.generation === owner.generation && activity.kind === 'running' && (!active || oldId !== id)) { this.activities.delete(oldId); changed = true; }
    if (active) {
      const prior = this.activities.get(id);
      if (!prior || prior.status !== status) {
        const time = this.now(); this.activities.set(id, {...owner, runId, id, kind: 'running', title: '正在执行', status, createdAt: prior?.createdAt ?? time, updatedAt: time, unseen: false}); changed = true;
      }
      return changed;
    }
    if (['stopped', 'failed', 'interrupted', 'completed'].includes(status)) changed = this.clearDialogs({...owner, runId}) || changed;
    const terminal = status === 'completed' ? 'completed' : status === 'failed' || status === 'interrupted' ? 'failed' : undefined;
    // A restored historical terminal snapshot is not a new completion.
    if (terminal && priorActive && runId === priorRun) {
      const terminalId = key(owner, terminal, runId);
      if (!this.announced.has(terminalId)) {
        const now = this.now(), activity: AttentionActivity = {...owner, runId, id: terminalId, kind: terminal, title: terminal === 'completed' ? '本轮执行结束' : status === 'interrupted' ? '执行已中断' : '执行失败', status, createdAt: now, updatedAt: now, unseen: !this.viewed(owner.sessionId)};
        if (activity.unseen) this.activities.set(terminalId, activity);
        this.announce(activity); changed = true;
      }
    }
    return changed;
  }
  dismiss(id: string): boolean {
    const activity = this.activities.get(id);
    return !!activity && (activity.kind === 'completed' || activity.kind === 'failed') && this.activities.delete(id);
  }
  expire(): boolean {
    let changed = false; const now = this.now();
    for (const [id, activity] of this.activities) if (activity.kind === 'dialog' && activity.expiresAt! <= now) { this.activities.delete(id); changed = true; }
    return changed;
  }
  snapshot(): AttentionActivity[] {
    this.expire();
    const priority = {dialog: 0, running: 1, failed: 2, completed: 3};
    return [...this.activities.values()].sort((a, b) => priority[a.kind] - priority[b.kind] || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).map(copy);
  }
  takeNotifications(): AttentionNotification[] {
    this.expire();
    const notifications = this.notifications; this.notifications = [];
    return notifications.filter(item => !this.view.muted && !this.viewed(item.sessionId) && this.activities.has(item.activityId)).map(item => ({...item}));
  }
}
