import {useEffect,useRef,useState} from 'react';
import type {WorkspaceRef} from './types.js';
import type {DiffRef,DiffScope,WorkspaceDiff as DiffData} from '../workspace-files.js';
import type {RunChangesSummary} from '../run-changes.js';
import type {ChangeDiffCache} from './change-review.js';
import {DiffControls,DiffFileHeader,FileDiffView,type DiffMode} from './DiffView.js';
import {DIFF_SCOPES,LatestDiffLoader,type DiffLoadState} from './diff-model.js';
import {budgetWorkspaceDiff,diffBytes,DIFF_PATCH_BUDGET,fitChangedFile} from '../diff-budget.js';

/** The “previous run” view reads only announced frozen comparisons. */
export async function frozenRunDiff(cache:ChangeDiffCache,sessionId:string|undefined,summary:RunChangesSummary|undefined):Promise<DiffData>{
 if(!sessionId||!summary)return {scope:'run',files:[],unavailable:'当前会话尚无上一轮结束时的变更快照。'};
 if(summary.unavailable||!summary.changeId)return {scope:'run',files:[],unavailable:summary.unavailable||'此历史记录未保存变更快照，未使用当前工作区替代。'};
 const placeholders=summary.files.slice(0,500).map(file=>({...file,staged:false,patch:'',lines:[],truncated:true,contextComplete:false,contextNote:'聚合比较达到预算边界，未读取此文件正文；统计保留。'})),files:DiffData['files']=[];
 let unread=0,bodyBudgetReached=false,remaining=DIFF_PATCH_BUDGET-4096-placeholders.reduce((bytes,file)=>bytes+diffBytes(JSON.stringify(file))+1,0);
 for(let index=0;index<Math.min(summary.files.length,500);index++){
  const placeholder=placeholders[index],reserved=diffBytes(JSON.stringify(placeholder))+1;
  if(bodyBudgetReached||remaining<1024){unread++;files.push(placeholder);continue;}
  const coordinates={sessionId,runId:summary.runId,changeId:summary.changeId,index},cached=cache.get(coordinates);
  try{const result=cached?.phase==='ready'?{file:cached.file}:await window.friendPi.request<{file?:DiffData['files'][number];unavailable?:string}>('session.changes.read',{...coordinates,maxBytes:Math.max(1024,remaining+reserved-256)});
   if(!result.file){unread++;files.push({...placeholder,contextNote:result.unavailable||'此历史文件正文不可用，未使用当前文件替代。'});continue;}
   const file=fitChangedFile(result.file,remaining+reserved,true),size=diffBytes(JSON.stringify(file))+1;
   if(size>remaining+reserved){unread++;files.push(placeholder);bodyBudgetReached=true;continue;}remaining-=size-reserved;files.push(file);
   // Stop expanding more old blobs once an ordered body cannot fit; individual review still has its own budget.
   if(file.truncated&&!file.lines.length)bodyBudgetReached=true;
  }catch{unread++;files.push({...placeholder,contextNote:'历史比较读取失败，未使用当前文件替代。'});}
 }
 return budgetWorkspaceDiff({scope:'run',files,fileCount:summary.fileCount??summary.files.length,omittedFiles:(summary.omittedFiles||0)+Math.max(0,summary.files.length-500),truncated:summary.truncated||unread>0,note:`冻结快照 · ${summary.finishedAt} · run ${summary.runId}。${summary.note||''}${unread?' 部分历史正文不可用或超出预算；未用当前文件替代。':''}`});
}
export function WorkspaceDiff({projectId,workspace,workspaceKey,sessionId,changes,cache}:{projectId?:string;workspace:WorkspaceRef;workspaceKey:string;sessionId?:string;changes?:RunChangesSummary[];cache:ChangeDiffCache}){
 const [scope,setScope]=useState<DiffScope>('workspace'),[mode,setMode]=useState<DiffMode>('split'),[wrap,setWrap]=useState(false),[refs,setRefs]=useState<DiffRef[]>([]),[selected,setSelected]=useState<{ref:string;refSha:string}>(),[revision,setRevision]=useState(0),[request,setRequest]=useState<DiffLoadState<DiffData>>({pending:true});
 const loader=useRef<LatestDiffLoader<DiffData>|null>(null);if(!loader.current)loader.current=new LatestDiffLoader(setRequest);
 const latest=changes?.at(-1),historyIdentity=scope==='run'?JSON.stringify([sessionId,latest?.runId,latest?.changeId]):'',identity=JSON.stringify([workspaceKey,workspace,projectId,scope,historyIdentity,selected?.ref,selected?.refSha,revision]);
 useEffect(()=>{const current=loader.current!;void current.load(identity,()=>scope==='run'?frozenRunDiff(cache,sessionId,latest):window.friendPi.request<DiffData>('git.diff',{projectId,workspace,scope,ref:selected?.ref,refSha:selected?.refSha}));return()=>current.invalidate();},[identity,cache]);
 useEffect(()=>{if(request.value?.refs)setRefs(request.value.refs);},[request.value]);
 const data=request.value,refresh=()=>{const current=refs.find(ref=>ref.name===selected?.ref);if(current)setSelected({ref:current.name,refSha:current.sha});setRevision(value=>value+1);};
 const choice=selected&&refs.some(ref=>ref.name===selected.ref&&ref.sha===selected.refSha)?JSON.stringify([selected.ref,selected.refSha]):'';
 return <section className="friend-diff-panel friend-workspace-diff" aria-label="文件差异">
  <div className="friend-diff-drag-rail" aria-hidden="true"/>
  <div className="friend-diff-toolbar"><label>对比范围<select aria-label="Diff 范围" value={scope} onChange={event=>setScope(event.target.value as DiffScope)}>{DIFF_SCOPES.map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label>
   {scope==='branch'&&<select className="friend-diff-branch" aria-label="对比分支及 SHA" disabled={request.pending} value={choice} onChange={event=>{if(!event.target.value){setSelected(undefined);return;}const [ref,refSha]=JSON.parse(event.target.value) as string[];setSelected({ref,refSha});}}><option value="">选择本仓库分支 / SHA</option>{refs.map(ref=><option key={ref.name} value={JSON.stringify([ref.name,ref.sha])}>{ref.label} · {ref.sha.slice(0,12)}</option>)}</select>}
   <DiffControls mode={mode} onMode={setMode} wrap={wrap} onWrap={setWrap}/><button disabled={request.pending} onClick={refresh}>刷新</button>
  </div>
  {request.pending?<p className="friend-diff-empty" role="status">读取比较…</p>:request.error?<p role="alert" className="friend-diff-note">{request.error} <button onClick={refresh}>重试</button></p>:data&&<>
   {data.comparison&&<p className="friend-diff-comparison">{data.comparison.ref&&<>分支 {data.comparison.ref} @ {data.comparison.refSha}<br/></>}{data.comparison.baseSha?'base '+data.comparison.baseSha:data.comparison.rootCommit?'空树（根提交）':'HEAD 基线'} → {data.comparison.headSha||'尚无 HEAD'}</p>}
   {data.note&&<p className="friend-diff-comparison">{data.note}</p>}
   {data.refsTruncated&&<p className="friend-diff-note">分支列表达到 512 项 / 512 KiB 上限；仅可选择已显示并验证的分支。</p>}
   {data.truncated&&<p className="friend-diff-note" role="alert">展示有预算边界：{data.fileCount??data.files.length} 个文件，省略 {data.omittedFiles||0} 个；上下文或正文的具体限制见各文件提示。</p>}
   {data.unavailable?<p className="friend-diff-empty">{data.unavailable}</p>:!data.files.length?<p className="friend-diff-empty">此范围没有改动</p>:data.files.map((file,index)=><details className="friend-diff-file" open key={`${identity}:${index}:${file.path}`}><summary><DiffFileHeader file={file}/></summary><FileDiffView state={{phase:'ready',file}} split={mode==='split'} wrap={wrap} hideHeader retry={refresh}/><div className="friend-diff-footer"><button disabled={file.status==='D'} onClick={()=>window.dispatchEvent(new CustomEvent('friend-pi:file-open',{detail:{path:file.path}}))}>打开当前文件</button>{scope==='run'&&<span>比较正文为冻结历史；打开文件显示当前版本。</span>}</div></details>)}
  </>}
 </section>;
}
