import {useEffect,useRef,useState} from 'react';
import type {GitCommit,GitFile,GitFileDiff,GitLog,GitStatus} from '../git-service.js';
import type {WorkspaceRef} from './types.js';
import {Empty,Field} from './ui.js';
import {errorText} from './types.js';

const statusNames:Record<string,string>={M:'修改',A:'新增',D:'删除',R:'重命名',C:'冲突',U:'未跟踪',T:'类型变更'};
const patchClass=(line:string)=>line.startsWith('+++')||line.startsWith('---')||line.startsWith('@@')?'git-meta':line.startsWith('+')?'diff-add':line.startsWith('-')?'diff-remove':'';
/** Git 面板：只读写当前项目工作区，push/fetch 由主进程明确拒绝。 */
export function GitPanel({workspace,projectId,sessionId,report}:{workspace?:WorkspaceRef;projectId?:string;sessionId?:string;report?(message:string,error?:boolean):void}){
  const [status,setStatus]=useState<GitStatus>(),[history,setHistory]=useState<GitLog>(),[diff,setDiff]=useState<GitFileDiff>(),[selected,setSelected]=useState<{path:string;staged:boolean}>(),[message,setMessage]=useState(''),[busy,setBusy]=useState(''),[error,setError]=useState(''),[logError,setLogError]=useState('');
  const generation=useRef(0),mounted=useRef(true);
  const key=JSON.stringify([workspace??null,projectId??'',sessionId??'']);
  const call=<T,>(method:string,input:Record<string,unknown>={})=>window.friendPi.request<T>(method,{workspace,projectId,sessionId,...input});
  const load=async(current:number)=>{const [nextStatus,nextHistory]=await Promise.all([call<GitStatus>('git.status'),call<GitLog>('git.log',{limit:30}).catch(err=>{setLogError(errorText(err));return undefined;})]);if(mounted.current&&current===generation.current){setStatus(nextStatus);setHistory(nextHistory);}};
  useEffect(()=>{mounted.current=true;const current=++generation.current;setStatus(undefined);setHistory(undefined);setDiff(undefined);setSelected(undefined);setMessage('');setError('');setLogError('');void load(current).catch(err=>{if(current===generation.current)setError(errorText(err));});return()=>{mounted.current=false;generation.current++;};},[key]);
  const run=async(name:string,operation:()=>Promise<unknown>,success?:string)=>{if(busy)return;const current=generation.current;setBusy(name);setError('');try{await operation();if(current!==generation.current)return;if(success)report?.(success);}catch(err){if(current===generation.current){const text=errorText(err);setError(text);report?.(text,true);}}finally{if(mounted.current&&current===generation.current)setBusy('');}};
  const apply=async(result:{status:GitStatus})=>{setStatus(result.status);setDiff(undefined);setSelected(undefined);setHistory(await call<GitLog>('git.log',{limit:30}).catch(err=>{setLogError(errorText(err));return undefined;}));};
  const open=async(path:string,staged:boolean)=>{if(selected?.path===path&&selected.staged===staged){setSelected(undefined);setDiff(undefined);return;}const current=generation.current;setSelected({path,staged});setDiff(undefined);setError('');try{const result=await call<GitFileDiff>('git.file.diff',{path,staged});if(current===generation.current)setDiff(result);}catch(err){if(current===generation.current){setSelected(undefined);const text=errorText(err);setError(text);report?.(text,true);}}};
  const stage=(paths?:string[])=>run('stage',async()=>{await apply(await call<{status:GitStatus}>('git.stage',paths?{paths}:{all:true}));},paths?'已暂存所选文件':'已暂存全部改动');
  const unstage=(paths?:string[])=>run('unstage',async()=>{await apply(await call<{status:GitStatus}>('git.unstage',paths?{paths}:{all:true}));},paths?'已取消暂存所选文件':'已取消全部暂存');
  const commit=()=>run('commit',async()=>{const result=await call<{commit:GitCommit;status:GitStatus}>('git.commit',{message});await apply(result);setMessage('');report?.('已提交 '+result.commit.shortSha+'：'+result.commit.subject);});
  const staged=status?.files.filter(file=>file.staged)??[],unstaged=status?.files.filter(file=>file.unstaged||file.untracked)??[];
  const row=(file:GitFile,stagedView:boolean,action:React.ReactNode)=><li className={'git-row'+(selected?.path===file.path&&selected.staged===stagedView?' selected':'')} key={`${file.path}:${stagedView?'staged':'worktree'}`}>
    <span className={'git-letter '+file.letter.toLowerCase()} title={statusNames[file.letter]||file.letter}>{file.letter}</span>
    <button className="git-path" onClick={()=>void open(file.path,stagedView)} aria-label={`查看 ${file.path} 的差异`}>{file.path}{file.oldPath&&<small>← {file.oldPath}</small>}</button>
    {action}
  </li>;
  return <section className="git-panel panel-content" aria-label="Git 面板">
    <style>{`.git-panel{display:flex;flex-direction:column;gap:14px;padding:20px;max-width:920px;margin:0 auto;min-width:0}.git-panel .git-head{display:flex;justify-content:space-between;gap:12px;align-items:center;flex-wrap:wrap}.git-panel .git-head>div{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}.git-panel .git-head code{font-size:12px;color:#4d6b4a}.git-panel .git-files{list-style:none;margin:6px 0 14px;padding:0;display:flex;flex-direction:column;gap:4px}.git-panel .git-row{display:flex;align-items:center;gap:8px;min-width:0}.git-panel .git-letter{flex:none;width:20px;text-align:center;font:600 11px/1.6 monospace;border-radius:4px;background:#eef2e8;color:#4d6b4a}.git-panel .git-letter.m,.git-panel .git-letter.t{background:#fff3e3;color:#a65b18}.git-panel .git-letter.a{background:#e9f4ec;color:#1c7154}.git-panel .git-letter.d,.git-panel .git-letter.c{background:#fdecec;color:#a3342b}.git-panel .git-letter.u{background:#eef2f7;color:#5a6a7a}.git-panel .git-path{flex:1;min-width:0;text-align:left;background:none;border:0;padding:2px 0;font-size:12px;overflow-wrap:anywhere;cursor:pointer}.git-panel .git-path small{color:var(--muted,#777);margin-left:4px}.git-panel .git-row.selected .git-path{color:#2f6f5e;font-weight:600}.git-panel h4{margin:10px 0 0;font-size:12px;color:#4d6b4a}.git-panel .git-patch{max-height:420px;font-size:11px;line-height:1.55;white-space:pre}.git-panel .git-patch .git-meta{color:#7b8f7a}.git-panel .git-log{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}.git-panel .git-log li{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;padding:8px;border:1px solid #e6eedc;border-radius:8px}.git-panel .git-log code{font-size:11px;color:#4d6b4a}.git-panel .git-subject{font-weight:600;overflow-wrap:anywhere}.git-panel .git-log small{color:var(--muted,#777);margin-left:auto}`}</style>
    <div className="panel-intro"><h2>Git</h2><p>仅作用于当前项目工作区：暂存、取消暂存、提交与历史。不执行 push / fetch，禁用仓库钩子。</p></div>
    {error&&<p className="inline-error" role="alert">{error}</p>}
    {!status&&!error?<p role="status">正在读取 Git 状态…</p>:status&&<>
      <div className="card git-head">
        <div><strong>{status.detached?'分离 HEAD':status.branch||'未知分支'}</strong><code>{status.shortHead||'尚无提交'}</code>{status.detached&&<span className="badge">分离</span>}</div>
        <div><span className="hint">{status.clean?'工作区干净':`${status.staged} 已暂存 · ${status.unstaged} 未暂存 · ${status.untracked} 未跟踪`}</span><button disabled={!!busy} onClick={()=>void run('refresh',async()=>{await load(generation.current);},'Git 状态已刷新')}>{busy==='refresh'?'刷新中…':'刷新'}</button></div>
      </div>
      <section className="card">
        <div className="card-heading"><h3>改动</h3><div className="button-row"><button disabled={!!busy||!unstaged.length} onClick={()=>void stage()}>{busy==='stage'?'暂存中…':'全部暂存'}</button><button disabled={!!busy||!staged.length} onClick={()=>void unstage()}>{busy==='unstage'?'处理中…':'全部取消暂存'}</button></div></div>
        {status.clean?<Empty title="工作区干净">没有未提交的改动。</Empty>:<>
          {staged.length>0&&<><h4>已暂存 · {staged.length}</h4><ul className="git-files">{staged.map(file=>row(file,true,<button disabled={!!busy} onClick={()=>void unstage([file.path])}>取消暂存</button>))}</ul></>}
          {unstaged.length>0&&<><h4>未暂存 · {unstaged.length}</h4><ul className="git-files">{unstaged.map(file=>row(file,false,<button disabled={!!busy} onClick={()=>void stage([file.path])}>暂存</button>))}</ul></>}
        </>}
        {status.truncated&&<p className="hint">文件过多，仅显示前 {status.files.length} 项；请在终端中处理其余文件。</p>}
      </section>
      {selected&&<section className="card">
        <div className="card-heading"><h3>{selected.path} · {selected.staged?'已暂存':'未暂存'}</h3><div className="button-row"><button disabled={!diff} onClick={()=>void open(selected.path,!selected.staged)}>查看{selected.staged?'未暂存':'已暂存'}版本</button><button onClick={()=>{setSelected(undefined);setDiff(undefined);}}>收起</button></div></div>
        {!diff?<p role="status">正在读取差异…</p>:diff.untracked?<p className="hint">{diff.note||'未跟踪文件：暂存后才会出现在差异中'}</p>:<>
          <p className="hint">{diff.binary?'二进制文件':`+${diff.additions} −${diff.deletions}`}{diff.truncated?' · 已截断':''}{diff.note?' · '+diff.note:''}</p>
          {diff.patch?<pre className="diff-view git-patch">{diff.patch.split('\n').map((line,index)=><span key={index} className={patchClass(line)}>{line}{'\n'}</span>)}</pre>:<p className="hint">{diff.note||'没有可显示的差异'}</p>}
        </>}
      </section>}
      <form className="card" onSubmit={event=>{event.preventDefault();void commit();}}>
        <h3>提交</h3>
        <Field label="提交信息" hint={`${staged.length} 个文件已暂存；提交信息作为 git commit -m 的参数，换行会保留。`}><textarea rows={3} value={message} disabled={!!busy} onChange={event=>setMessage(event.target.value)} placeholder="一句话说明这次改动"/></Field>
        <div className="button-row"><button className="primary" disabled={!!busy||!message.trim()||!staged.length}>{busy==='commit'?'提交中…':'提交已暂存改动'}</button>{!staged.length&&<span className="hint">先暂存要提交的文件。</span>}{!message.trim()&&<span className="hint">填写提交信息后才能提交。</span>}</div>
      </form>
      <section className="card">
        <div className="card-heading"><h3>提交历史</h3><span className="hint">仅显示影响当前项目的提交</span></div>
        {logError&&!history?<p className="inline-error" role="alert">提交历史读取失败：{logError}</p>:!history?<p role="status">正在读取提交历史…</p>:history.emptyRepository?<Empty title="仓库还没有提交">首次提交后这里会显示历史。</Empty>:!history.commits.length?<Empty title="当前项目尚无提交">仓库里的提交都不涉及当前项目路径。</Empty>:<ol className="git-log">{history.commits.map(commit=><li key={commit.sha}><code>{commit.shortSha}</code><span className="git-subject">{commit.subject}</span>{commit.refs.map(ref=><span className="badge" key={ref}>{ref}</span>)}<small>{commit.author} · {new Date(commit.at).toLocaleString()}</small></li>)}</ol>}
        {history?.mayHaveMore&&<p className="hint">仅显示最近 30 条提交。</p>}
      </section>
    </>}
  </section>;
}
