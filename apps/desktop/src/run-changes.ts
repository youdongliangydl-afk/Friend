import { randomUUID } from 'node:crypto';
import { RecordStore } from '@friend-pi/core';
import { captureRunBaseline, workspaceDiff, parsePatch, captureToolFile, compareToolCapture, hasGitRepository, uncoveredToolPaths, type CapturedRunFile, type ChangedFile, type WorkspaceDiff } from './workspace-files.js';

export const RUN_CHANGES_TYPE = 'friend-pi.run.changes.v1';
export interface RunChangesSummary {
  v: 1; runId: string; sessionId: string; projectId: string; anchorId?: string; changeId?: string;
  startedAt: string; finishedAt: string; status: string; unavailable?: string; note?: string;
  files: { path: string; oldPath?: string; status: string; binary: boolean; additions?: number; deletions?: number; error?: string }[];
}

interface ChangeSnapshot { v: 1; sessionId: string; projectId: string; runId: string; files: Omit<ChangedFile,'lines'>[] }
interface ToolCaptures {
  sessionId:string; projectId:string; startedAt:string; fileToolsOnly:boolean;
  failure?:string; files:[string,CapturedRunFile][];
}
/** Read an announced comparison by its owning session and original summary index. Never reread current files. */
export function readRunChange(dataDir:string,sessionId:string,projectId:string,runId:string,changeId:string,index:number) {
  if(!Number.isSafeInteger(index)||index<0)throw new Error('变更文件索引无效');
  const store=new RecordStore('diff',dataDir);
  try {
    const snapshot=store.get<ChangeSnapshot>(`snapshot:${sessionId}:${changeId}`)?.value;
    if(!snapshot||snapshot.v!==1||snapshot.sessionId!==sessionId||snapshot.projectId!==projectId||snapshot.runId!==runId)return {unavailable:'该轮变更快照不可用，未使用当前文件替代'};
    const file=snapshot.files[index];if(!file)return {unavailable:'该轮没有此文件'};
    return {file:{...file,lines:parsePatch(file.patch)}};
  } finally {store.close();}
}

/** Only metadata enters Pi history. Frozen comparisons stay in the existing session-owned Diff store. */
export class RunChangesTracker {
  private runId?: string;
  private startedAt = '';
  private recorded = false;
  private generation = 0;
  private captures=new Map<string,CapturedRunFile>();
  private fileToolsOnly=false;
  private captureFailure?:string;
  private pending: Promise<void> = Promise.resolve();
  constructor(private root: string, private projectId: string, private dataDir: string,
    private sessionId: string, private append: (summary: RunChangesSummary) => void,
    private history:()=>RunChangesSummary[]=()=>[]) {}
  async begin(runId: string, reuse=false) {
    await this.pending.catch(()=>{});
    this.generation++;
    this.runId = runId; this.startedAt = new Date().toISOString(); this.recorded = false;
    let prior:ToolCaptures|undefined;
    if(reuse){const store=new RecordStore('diff',this.dataDir);try{const saved=store.get<ToolCaptures>(`captures:${this.sessionId}:${runId}`)?.value;if(saved?.sessionId===this.sessionId&&saved.projectId===this.projectId)prior=saved;}finally{store.close();}}
    const baseline=prior?.fileToolsOnly?undefined:await captureRunBaseline(this.root, this.projectId, runId, this.dataDir, this.sessionId,reuse).catch(() => undefined);
    if(baseline)this.startedAt=baseline.createdAt;
    this.fileToolsOnly=prior?.fileToolsOnly??(!baseline&&!await hasGitRepository(this.root).catch(()=>true));
    const previous=reuse?this.history().findLast(summary=>summary.runId===runId):undefined;
    this.captureFailure=prior?.failure||previous?.unavailable||(!baseline&&!this.fileToolsOnly?'Git 基线读取失败，本轮变更不可用':undefined);
    this.captures=new Map(prior?.files||[]);if(prior?.startedAt||previous?.startedAt)this.startedAt=prior?.startedAt||previous!.startedAt;
    this.saveCaptures();
  }
  private saveCaptures(){
    const store=new RecordStore('diff',this.dataDir);
    try{store.put(`captures:${this.sessionId}:${this.runId}`,{sessionId:this.sessionId,projectId:this.projectId,startedAt:this.startedAt,fileToolsOnly:this.fileToolsOnly,failure:this.captureFailure,files:[...this.captures]} satisfies ToolCaptures);}finally{store.close();}
  }
  async captureTool(name:string,input:Record<string,unknown>){
    try{
    if(!this.runId||!['write','edit'].includes(name)||typeof input.path!=='string')return;
    await this.pending.catch(()=>{});const capture=captureToolFile(this.root,input.path);if(!capture||this.captures.has(capture.path))return;
    if(this.captures.size>=500)throw new Error('本轮文件工具快照超过 500 个文件');
    const used=[...this.captures.values()].reduce((n,file)=>n+Buffer.byteLength(file.content||''),0);
    if(used+Buffer.byteLength(capture.file.content||'')>8*1024*1024)throw new Error('本轮文件工具快照超过 8 MiB');
    this.captures.set(capture.path,capture.file);this.saveCaptures();
    }catch(error){this.captureFailure='文件工具快照未完整记录，本轮变更不可用';try{this.saveCaptures();}catch{}throw error;}
  }
  async ensure(runId: string) {if(this.runId!==runId)await this.begin(runId,true);else await this.pending.catch(()=>{});}
  reopen(runId?: string) { if (this.runId === runId) {this.recorded = false;this.generation++;} }
  settle(runId: string | undefined, status: string, anchorId?: string) {
    if (!runId || runId !== this.runId || this.recorded) return this.pending;
    this.recorded = true;
    const generation=this.generation,startedAt = this.startedAt, finishedAt = new Date().toISOString();
    this.pending = this.pending.catch(()=>{}).then(async()=>{
      if(this.captureFailure){try{this.saveCaptures();}catch{}return {scope:'run' as const,files:[],unavailable:this.captureFailure};}
      let diff:WorkspaceDiff=await workspaceDiff(this.root,this.projectId,this.dataDir,'run',runId);
      if(diff.unavailable&&!this.fileToolsOnly)return diff;
      const uncovered=this.fileToolsOnly?new Set(this.captures.keys()):await uncoveredToolPaths(this.root,[...this.captures.keys()]);
      const files=[...diff.files];for(const [path,before] of this.captures)if(uncovered.has(path)&&!files.some(file=>file.path===path)){const file=await compareToolCapture(this.root,path,before);if(file)files.push(file);}
      if(this.fileToolsOnly&&this.captures.size)diff={scope:'run',files};else diff={...diff,files};
      return diff;
    })
      .catch(() => ({ files: [], unavailable: '无法读取本轮文件变化' }))
      .then(diff => {if(generation!==this.generation)return;
        const changeId=randomUUID();let budget=8*1024*1024;
        const files=diff.files.map(({lines,...file})=>{const bytes=Buffer.from(file.patch);const kept=bytes.subarray(0,budget);budget-=kept.length;return {...file,patch:kept.toString('utf8'),truncated:file.truncated||kept.length<bytes.length};});
        const store=new RecordStore('diff',this.dataDir);try{store.put(`snapshot:${this.sessionId}:${changeId}`,{v:1,sessionId:this.sessionId,projectId:this.projectId,runId,files} satisfies ChangeSnapshot,null);}finally{store.close();}
        this.append({ v: 1, runId, sessionId: this.sessionId, projectId: this.projectId,changeId,
        anchorId, startedAt, finishedAt, status, unavailable: diff.unavailable,
        note: this.fileToolsOnly?'此目录没有可用 Git 基线，仅统计文件工具修改；二进制或大文件不计行数。':'统计本轮期间的文件变化，包含同期外部编辑；二进制或大文件不计行数。',
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
