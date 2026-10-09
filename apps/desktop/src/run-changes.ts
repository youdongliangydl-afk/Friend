import { captureRunBaseline, workspaceDiff } from './workspace-files.js';

export const RUN_CHANGES_TYPE = 'friend-pi.run.changes.v1';
export interface RunChangesSummary {
  v: 1; runId: string; sessionId: string; projectId: string; anchorId?: string;
  startedAt: string; finishedAt: string; status: string; unavailable?: string; note?: string;
  files: { path: string; oldPath?: string; status: string; binary: boolean; additions?: number; deletions?: number; error?: string }[];
}

/** Only metadata is saved in Pi history. The existing Diff baseline owns file contents. */
export class RunChangesTracker {
  private runId?: string;
  private startedAt = '';
  private recorded = false;
  private generation = 0;
  private pending: Promise<void> = Promise.resolve();
  constructor(private root: string, private projectId: string, private dataDir: string,
    private sessionId: string, private append: (summary: RunChangesSummary) => void) {}
  async begin(runId: string, reuse=false) {
    await this.pending.catch(()=>{});
    this.generation++;
    this.runId = runId; this.startedAt = new Date().toISOString(); this.recorded = false;
    const baseline=await captureRunBaseline(this.root, this.projectId, runId, this.dataDir, this.sessionId,reuse).catch(() => undefined);
    if(baseline)this.startedAt=baseline.createdAt;
  }
  async ensure(runId: string) {if(this.runId!==runId)await this.begin(runId,true);else await this.pending.catch(()=>{});}
  reopen(runId?: string) { if (this.runId === runId) {this.recorded = false;this.generation++;} }
  settle(runId: string | undefined, status: string, anchorId?: string) {
    if (!runId || runId !== this.runId || this.recorded) return this.pending;
    this.recorded = true;
    const generation=this.generation,startedAt = this.startedAt, finishedAt = new Date().toISOString();
    this.pending = this.pending.catch(()=>{}).then(()=>workspaceDiff(this.root, this.projectId, this.dataDir, 'run', runId))
      .catch(() => ({ files: [], unavailable: '无法读取本轮文件变化' }))
      .then(diff => {if(generation!==this.generation)return;this.append({ v: 1, runId, sessionId: this.sessionId, projectId: this.projectId,
        anchorId, startedAt, finishedAt, status, unavailable: diff.unavailable,
        note: '统计本轮期间的文件变化，包含同期外部编辑；二进制或大文件不计行数。',
        files: diff.files.map(({ path, oldPath, status, binary, additions, deletions, error }) =>
          ({ path, oldPath, status, binary, additions, deletions, error })) });});
    return this.pending;
  }
  flush() { return this.pending; }
}

export function projectRunChanges(entries: readonly unknown[]): RunChangesSummary[] {
  const summaries = new Map<string, RunChangesSummary>();
  for (const raw of entries) {
    const entry = raw as { type?: string; customType?: string; data?: RunChangesSummary };
    if (entry.type === 'custom' && entry.customType === RUN_CHANGES_TYPE && entry.data?.v === 1 &&
      typeof entry.data.runId === 'string' && Array.isArray(entry.data.files)) summaries.set(entry.data.runId, entry.data);
  }
  return [...summaries.values()];
}
