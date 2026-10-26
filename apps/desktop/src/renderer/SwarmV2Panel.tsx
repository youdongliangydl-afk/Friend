import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {errorText,type JsonObject} from './types.js';
import {Card,Empty,Field,JsonView} from './ui.js';
import {
 SWARM_V2_BUDGET_SCOPES,SWARM_V2_VERDICT_BINDINGS,SWARM_V2_VERDICT_KINDS,
 createSwarmV2Team,readSwarmV2,readSwarmV2Gates,submitSwarmV2Verdict,swarmV2TeamId,swarmV2VerdictDraft,swarmV2VerdictForm,swarmV2View,
 type SwarmV2Budgets,type SwarmV2GateView,type SwarmV2Load,type SwarmV2TaskCard,type SwarmV2VerdictDraft,type SwarmV2VerdictView,
} from './swarm-v2-model.js';

const teamKey=(sessionId:string)=>`friend-pi.swarm-v2.team:${sessionId}`;
function rememberedTeam(sessionId:string):string {try{return typeof localStorage==='undefined'?'':localStorage.getItem(teamKey(sessionId))||'';}catch{return '';}}
function rememberTeam(sessionId:string,teamId:string):void {try{if(typeof localStorage!=='undefined')localStorage.setItem(teamKey(sessionId),teamId);}catch{/* The panel stays usable for this mount when storage is unavailable. */}}

const count=(value:number|undefined)=>value===undefined?'未知':String(value);

function TaskCard({card}:{card:SwarmV2TaskCard}){
 return <article className="task-node">
  <div className="item-heading"><strong>{card.title}</strong><span className={`badge ${card.tone}`}>{card.label}</span></div>
  <small>{card.taskId} · {card.modeLabel}{card.risk?` · ${card.risk}`:''}{card.ownerName?` · 队友 ${card.ownerName}`:card.ownerMemberId?' · 队友资料待刷新':''}{card.reworkCount!==undefined?` · 返工 ${card.reworkCount} 轮`:''}{card.resultRevision!==undefined?` · 成果 v${card.resultRevision}`:''}</small>
  {card.dependencies.length>0&&<div className="dependencies">← {card.dependencies.join('，')}</div>}
  {card.writeScopes.length>0&&<div className="dependencies">写入范围：{card.writeScopes.join('，')}</div>}
  {card.acceptanceCount>0&&<div className="dependencies">{card.acceptanceCount} 条验收要求</div>}
  {card.blockedReason&&<p className="inline-error">{card.blockedReason}</p>}
  {card.currentAttemptId&&<small>当前尝试 {card.currentAttemptId}</small>}
 </article>;
}

function BudgetLayers({budgets}:{budgets:SwarmV2Budgets}){
 if(!budgets.recorded)return <Empty title="本轮尚未记录预算">没有预算记录时，G16 会因缺少团队预算而失败；这里不填造数字。</Empty>;
 return <>{SWARM_V2_BUDGET_SCOPES.map(scope=>{
  const layer=budgets.layers.find(item=>item.scope===scope)!;
  return <section key={scope}><div className="item-heading"><strong>{layer.label}预算</strong><small>{layer.rows.length?`${layer.rows.length} 条`:'未设置'}</small></div>
   {layer.rows.map(row=><div className="memory-center-budget" key={row.budgetId||`${row.scope}:${row.scopeId}`}>
    <div className="memory-center-budget-heading"><span>{row.scopeName}</span><small>{row.unknown?'含未知用量':''}{row.paused?' · 已暂停新调用':''}{row.concurrencyLimit!==null?` · 并发 ${row.concurrencyLimit}`:''}</small></div>
    {row.bars.map(bar=><div key={bar.id}><small>{bar.label} · {bar.usedText} / {bar.limitText}{bar.over?' · 已超出':''}{bar.percent===null?' · 未计算百分比':''}</small>{bar.percent!==null&&<div className="memory-center-budget-track"><span style={{width:`${bar.percent}%`}} className={bar.over?'is-over':''}/></div>}</div>)}
    {row.notes.map(note=><p className="hint" key={note}>{note}</p>)}
    {!row.budgetId&&<p className="hint">这条预算缺少标识，未猜测其归属。</p>}
   </div>)}
   {!layer.rows.length&&<p className="hint">没有{layer.label}预算记录。</p>}
  </section>;
 })}{budgets.unscoped>0&&<p role="status" className="inline-error">有 {budgets.unscoped} 条预算的作用范围未识别，未并入三层。</p>}</>;
}

function GateList({view}:{view:SwarmV2GateView}){
 if(!view.read)return <Empty title="尚未读取门禁">{view.note}</Empty>;
 return <><p role="status">{view.allowed?'G01–G20 全部通过：候选可以进入整合。':'当前不能整合；逐条核对下列原因。'}</p>
  <ol className="task-map">{view.gates.map(gate=><li key={gate.code} className="task-node">
   <div className="item-heading"><strong>{gate.code} · {gate.label}</strong><span className={`badge ${gate.passed===true?'badge-completed':gate.passed===false?'badge-failed':'badge-unknown'}`}>{gate.passed===true?'通过':gate.passed===false?'未通过':'未返回'}</span></div>
   <small>{gate.reason}</small>
  </li>)}</ol>
  <p className="hint">{view.note}</p>
  {view.unexpected.length>0&&<p role="alert" className="inline-error">未登记的门禁代码：{view.unexpected.map(gate=>gate.code).join('、')}（未计入通过）。</p>}
  <details><summary>控制器返回的原始门禁记录</summary><JsonView value={{allowed:view.claimedAllowed,candidateDigest:view.candidateDigest,verdictId:view.verdictId,gates:view.gates.map(gate=>({code:gate.code,passed:gate.passed,detail:gate.detail}))}}/></details></>;
}

function VerdictResult({verdict}:{verdict:SwarmV2VerdictView}){
 return <section className="task-node" aria-label="已封存裁决">
  <div className="item-heading"><strong>裁决 {verdict.verdictId.slice(0,12)}…</strong><span className={`badge ${verdict.approved?'badge-completed':'badge-failed'}`}>{verdict.approved?'通过':'未通过'}{verdict.sealed?' · 已封存':' · 未封存'}</span></div>
  <small>{verdict.kindLabel} · {verdict.bindingLabel} · {verdict.createdAt||'时间未记录'}</small>
  <small>候选 {verdict.candidateDigest||'未记录'} · 复核 tip {verdict.reviewedTip||'未记录'} · 复核成员 {verdict.reviewerMemberId||'未记录'}</small>
  <div className="dependencies">归因任务：{verdict.taskIds.join('，')||'未记录'}</div>
  <div className="dependencies">结果版本：{verdict.resultVersions.map(item=>`${item.taskId} v${item.revision}`).join('，')||'未记录'}</div>
  {verdict.findings.length>0?<ul>{verdict.findings.map(finding=><li key={finding}>{finding}</li>)}</ul>:<p className="hint">这条裁决没有附带问题说明。</p>}
 </section>;
}

export function SwarmV2Panel({sessionId,report,load}:{sessionId:string;report(message:string,error?:boolean):void;load?:SwarmV2Load}){
 const request=useCallback<SwarmV2Load>((action,input={})=>load?load(action,input):window.friendPi.request('plugin.call',{sessionId,plugin:'swarm',action,input}),[load,sessionId]);
 const [teamId,setTeamId]=useState(()=>rememberedTeam(sessionId));
 const [snapshot,setSnapshot]=useState<JsonObject>({});
 const [loading,setLoading]=useState(true);
 const [error,setError]=useState('');
 const [taskId,setTaskId]=useState('');
 const [candidateDigest,setCandidateDigest]=useState('');
 const [gateVerdictId,setGateVerdictId]=useState('');
 const [gateResult,setGateResult]=useState<{view:SwarmV2GateView;decision:JsonObject}|null>(null);
 const [gatePending,setGatePending]=useState(false);
 const [draft,setDraft]=useState<SwarmV2VerdictDraft>(()=>swarmV2VerdictDraft());
 const [submitting,setSubmitting]=useState(false);
 const [submitted,setSubmitted]=useState<SwarmV2VerdictView|null>(null);
 const generation=useRef(0);
 const view=useMemo(()=>swarmV2View(snapshot),[snapshot]);
 const form=useMemo(()=>swarmV2VerdictForm(draft),[draft]);
 const tasks=useMemo(()=>[...view.board.columns.flatMap(column=>column.tasks),...view.board.unknown],[view]);
 const read=useCallback(async(team:string)=>{
  const current=++generation.current;setLoading(true);
  const result=await readSwarmV2(request,team.trim()||undefined);
  if(current!==generation.current)return;
  setSnapshot(result.snapshot);setError(result.error);setLoading(false);
 },[request]);
 useEffect(()=>{void read(teamId);return()=>{generation.current++;};},[read,sessionId]);
 const create=async()=>{
  const next=teamId.trim()||swarmV2TeamId(sessionId);
  try{
   const result=await createSwarmV2Team(request,next);
   if(result.error){setError(result.error);setLoading(false);report(result.error,true);return;}
   rememberTeam(sessionId,next);setTeamId(next);await read(next);
   report(result.existing?'此团队的记录已存在，已重新读取':'已建立 v2 团队记录');
  }catch(caught){report(errorText(caught),true);}
 };
 const readGates=async()=>{
  if(!taskId||!candidateDigest.trim()){report('读取门禁需要任务与候选摘要',true);return;}
  setGatePending(true);
  try{
   const result=await readSwarmV2Gates(request,{taskId,candidateDigest:candidateDigest.trim(),...(gateVerdictId.trim()?{verdictId:gateVerdictId.trim()}:{})});
   if(result.error)report(result.error,true);else setGateResult({view:result.view,decision:result.decision});
  }catch(caught){report(errorText(caught),true);}
  finally{setGatePending(false);}
 };
 const operationRef=useRef<string|undefined>(undefined);
 const submit=async()=>{
  if(!form.ready){report(form.missing[0],true);return;}
  setSubmitting(true);
  // Keep one operation id across retries so a lost response is not submitted twice.
  const operationId=operationRef.current??crypto.randomUUID();operationRef.current=operationId;
  try{
   const result=await submitSwarmV2Verdict(request,draft,operationId);
   if(result.error)report(result.error,true);
   else{operationRef.current=undefined;setSubmitted(result.verdict);report('裁决已封存');}
  }catch(caught){report(errorText(caught),true);}
  finally{setSubmitting(false);}
 };
 const team=view.team;
 return <div className="swarm-v2-workbench">
  <div className="button-row"><button disabled={loading} onClick={()=>void read(teamId)}>{loading?'读取中…':'刷新 v2 快照'}</button>{team.known&&<span className={`badge ${team.status==='running'?'badge-running':'badge'}`}>{team.statusLabel}</span>}</div>
  <Field label="v2 团队标识" hint="团队标识由控制器建立；GUI 只能读取属于当前项目与会话的团队。"><input value={teamId} onChange={event=>setTeamId(event.target.value)} placeholder="team:…" /></Field>
  <div className="button-row"><button disabled={loading} onClick={()=>void create()}>{teamId.trim()?'按此标识建立团队':'为本会话建立 v2 团队'}</button>{teamId.trim()&&<button disabled={loading} onClick={()=>void read(teamId)}>按此标识读取</button>}</div>
  {loading&&!view.recorded&&<p className="hint">正在读取 Swarm v2 快照…</p>}
  {error&&<p role="alert" className="inline-error">{error}{!teamId.trim()?' 这通常表示缺少团队标识；可建立团队或粘贴已有标识。':''}</p>}
  {!loading&&!view.recorded&&<Empty title="尚未读取到 v2 快照">v2 团队由控制器建立。建立或载入团队后，这里显示任务板、三层预算、门禁与封存裁决。</Empty>}
  {view.recorded&&<>
   {view.warnings.map(warning=><p role="status" className="inline-error" key={warning}>{warning}</p>)}
   {view.empty?<Empty title="快照未包含团队记录">控制器返回了快照，但没有团队对象；不推测团队状态与预算。</Empty>:<>
    <Card title="团队">
     <p><strong>{team.teamId||'团队标识未记录'}</strong></p>
     <small>状态 {team.statusLabel} · 版本 {count(team.revision)} · 返工轮次 {count(team.reworkRound)} · 自主等级 {count(team.autonomyLevel)} · 失败指纹 {count(team.failureCount)}</small>
     {team.workspaceRoot&&<p className="path-text">{team.workspaceRoot}</p>}
     <small>建立 {team.createdAt||'未记录'} · 更新 {team.updatedAt||'未记录'}</small>
     <details><summary>快照计数、静默合并与最近事件</summary>
      <dl className="memory-center-progress-grid">{view.summary.rows.map(row=><div key={row.label}><dt>{row.label}</dt><dd>{count(row.value)}</dd></div>)}</dl>
      <p className="hint">静默合并：{count(view.summary.silentMerge)}（应为 0）· 基线 {view.summary.baselineDigest||'未记录'} · 快照 schema {count(view.summary.schemaVersion)}</p>
      {view.events.rows.length?<ul>{view.events.rows.map((event,index)=><li key={`${event.at}:${index}`}><small>{event.at||'时间未记录'} · {event.type}{event.actor?` · ${event.actor}`:''}</small></li>)}</ul>:<p className="hint">快照未包含日志事件。</p>}
      <small>共 {view.events.total} 条事件，显示最近 {view.events.rows.length} 条。</small>
     </details>
    </Card>
    <Card title="任务板 · 8 态与墓碑">
     <p className="hint">状态由控制器任务机决定；同一任务只显示最新记录。依赖与写入范围来自任务定义。</p>
     {view.board.columns.map(column=><section key={column.state}><div className="item-heading"><strong>{column.label}</strong><small>{column.tasks.length} 个</small></div>
      {column.tasks.length?column.tasks.map(card=><TaskCard card={card} key={card.taskId}/>):<p className="hint">—</p>}
     </section>)}
     {view.board.unknown.length>0&&<section><div className="item-heading"><strong>状态未识别</strong><small>{view.board.unknown.length} 个</small></div>{view.board.unknown.map(card=><TaskCard card={card} key={card.taskId}/>)}</section>}
     {view.board.tombstones.length>0&&<details><summary>已取消/已删除（墓碑）· {view.board.tombstones.length}</summary>{view.board.tombstones.map(card=><TaskCard card={card} key={card.taskId}/>)}</details>}
     <details><summary>运行中的尝试 · {view.attempts.rows.length}</summary>
      {view.attempts.rows.map(attempt=><p key={attempt.attemptId}><small>{attempt.taskTitle} · {attempt.label} · {attempt.memberName||attempt.memberId||'成员未记录'} · 开始 {attempt.startedAt||'未记录'}</small></p>)}
      <p className="hint">{view.attempts.note}</p>
     </details>
    </Card>
    <Card title="三层预算 · 团队 / 任务 / 成员"><BudgetLayers budgets={view.budgets}/></Card>
    <Card title="合并门禁 G01–G20">
     <p className="hint">门禁按控制器当前状态计算，不会因为界面请求而放行。候选摘要不在任务快照中，需要从验证记录复制。</p>
     <div className="form-row">
      <Field label="任务"><select value={taskId} onChange={event=>setTaskId(event.target.value)}><option value="">选择任务</option>{tasks.map(card=><option key={card.taskId} value={card.taskId}>{card.title} · {card.label}</option>)}</select></Field>
      <Field label="候选摘要"><input value={candidateDigest} onChange={event=>setCandidateDigest(event.target.value)} placeholder="candidateDigest" /></Field>
     </div>
     <Field label="裁决标识（可选）"><input value={gateVerdictId} onChange={event=>setGateVerdictId(event.target.value)} placeholder="verdictId" /></Field>
     <button disabled={gatePending||!taskId||!candidateDigest.trim()} onClick={()=>void readGates()}>{gatePending?'读取中…':'读取门禁'}</button>
     {gateResult&&<><GateList view={gateResult.view}/><details><summary>门禁原始响应</summary><JsonView value={gateResult.decision}/></details></>}
     {!gateResult&&<Empty title="尚未读取门禁">选择任务并填入候选摘要后读取；未读取不等于通过。</Empty>}
    </Card>
    <Card title="封存裁决入口">
     <p className="hint">裁决是结构化记录，只接受通过/未通过与问题说明；自由文本不会被当作通过依据。提交后由控制器封存并绑定候选 tip。clean-rebase 豁免需要先有一条 stale-tip 拒绝记录，否则控制器会拒绝。</p>
     <div className="form-row">
      <Field label="验证标识（verificationId）"><input value={draft.verificationId} onChange={event=>setDraft({...draft,verificationId:event.target.value})} /></Field>
      <Field label="复核成员（reviewerMemberId）"><input value={draft.reviewerMemberId} onChange={event=>setDraft({...draft,reviewerMemberId:event.target.value})} /></Field>
     </div>
     <div className="form-row">
      <Field label="类型"><select value={draft.kind} onChange={event=>setDraft({...draft,kind:event.target.value})}>{SWARM_V2_VERDICT_KINDS.map(kind=><option key={kind} value={kind}>{kind==='reviewer'?'独立复核 reviewer':'目标核验 verifier'}</option>)}</select></Field>
      <Field label="绑定方式"><select value={draft.binding} onChange={event=>setDraft({...draft,binding:event.target.value})}>{SWARM_V2_VERDICT_BINDINGS.map(binding=><option key={binding} value={binding}>{binding}</option>)}</select></Field>
     </div>
     <div className="form-row">
      <Field label="候选摘要（candidateDigest）"><input value={draft.candidateDigest} onChange={event=>setDraft({...draft,candidateDigest:event.target.value})} /></Field>
      <Field label="复核 tip（reviewedTip）"><input value={draft.reviewedTip} onChange={event=>setDraft({...draft,reviewedTip:event.target.value})} /></Field>
     </div>
     <Field label="归因任务（逗号或换行分隔，必须包含被裁决任务）"><input value={draft.taskIds} onChange={event=>setDraft({...draft,taskIds:event.target.value})} placeholder="task-1, task-2" /></Field>
     <Field label="结果版本（任务ID:版本，每行一条）"><textarea rows={2} value={draft.resultVersions} onChange={event=>setDraft({...draft,resultVersions:event.target.value})} placeholder="task-1:3" /></Field>
     <label className="check"><input type="checkbox" checked={draft.approved} onChange={event=>setDraft({...draft,approved:event.target.checked})}/>裁决通过</label>
     <Field label="问题说明（未通过时必填，每行一条）"><textarea rows={3} value={draft.findings} onChange={event=>setDraft({...draft,findings:event.target.value})} /></Field>
     {form.missing.length>0&&<ul className="hint">{form.missing.map(item=><li key={item}>{item}</li>)}</ul>}
     <button className={draft.approved?'primary full':'danger full'} disabled={submitting||!form.ready} onClick={()=>void submit()}>{submitting?'提交中…':draft.approved?'封存通过裁决':'封存未通过裁决'}</button>
     {submitted&&<VerdictResult verdict={submitted}/>}
    </Card>
    <Card title="成员消息 · 四态计数">
     {view.messages.recorded?<dl className="memory-center-progress-grid">{view.messages.rows.map(row=><div key={row.state}><dt>{row.label}</dt><dd>{count(row.count)}</dd></div>)}</dl>:<Empty title="快照未包含消息计数"/>}
     <p className="hint">{view.messages.note}</p>
    </Card>
   </>}
  </>}
 </div>;
}

/** Collapsed by default so opening the Swarm tab never issues an idle v2 read. */
export function SwarmV2Workbench({sessionId,report}:{sessionId:string;report(message:string,error?:boolean):void}){
 const [open,setOpen]=useState(false);
 return <details className="card" open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
  <summary>Coordination v2 工作台 · 任务板、三层预算、G01–G20 门禁与封存裁决</summary>
  {open&&<SwarmV2Panel key={sessionId} sessionId={sessionId} report={report}/>}
 </details>;
}
