type SnapshotRecord=Record<string,unknown>;
interface GoalScope {id:string;sourceRunId?:string}
interface RuntimeScope {projectId:string;sessionId:string;runId?:string}
export interface GoalSideEffectIssue {graphId:string;kind:'operation'|'write'|'exit'|'running';id:string;reason:string}
const record=(value:unknown):SnapshotRecord=>value&&typeof value==='object'&&!Array.isArray(value)?value as SnapshotRecord:{};
const records=(value:unknown):SnapshotRecord[]=>Array.isArray(value)?value.map(record):[];

/** Read committed Swarm snapshot facts, without interpreting unfinished tasks as failure.
 * Explicit goal ownership wins over run identity, including after a goal changes runs.
 * Without a focused goal, inspect the whole session so clearing a goal cannot
 * discard unresolved effects. Hosts must refresh this full snapshot before cold
 * restore and on swarm.changed. All issues block completion/automatic continuation;
 * only non-running issues block user goal metadata changes or explicit resume.
 */
export function goalSideEffectIssues(snapshot:SnapshotRecord,ctx:RuntimeScope,goal?:GoalScope):GoalSideEffectIssue[]{
 const graphs=records(snapshot.graphs).filter(graph=>graph.projectId===ctx.projectId&&graph.sessionId===ctx.sessionId&&(
  goal?graph.goalId!==undefined?graph.goalId===goal.id:!!goal.sourceRunId&&graph.runId===goal.sourceRunId:true
 ));
 const issues:GoalSideEffectIssue[]=[],seen=new Set<string>();
 const add=(graphId:string,kind:GoalSideEffectIssue['kind'],id:string,reason:string)=>{const key=JSON.stringify([graphId,kind,id]);if(!seen.has(key)){seen.add(key);issues.push({graphId,kind,id,reason});}};
 for(const graph of graphs){
  const graphId=String(graph.id),tasks=records(graph.tasks),attempts=records(graph.attempts),operations=records(snapshot.operations).filter(op=>op.graphId===graph.id);
  const unsafeOperation=(op:SnapshotRecord)=>op.status==='unknown'||op.status==='dispatched'||op.connector==='file'&&op.status==='prepared';
  for(const op of operations)if(unsafeOperation(op))add(graphId,op.status==='dispatched'?'running':'operation',`${String(op.id)}:${String(op.target||'')}`,op.status==='dispatched'?'已派发操作仍在等待结果':'操作或文件应用的结果未知');
  for(const task of tasks){
   const attempt=attempts.find(item=>item.id===task.currentAttempt);
   if(task.mode==='write'&&(task.status==='unknown'||attempt?.status==='unknown'))add(graphId,'write',String(task.id),'当前写入尝试的副作用未知，退出回执不能替代成果核对');
  }
  for(const attempt of attempts){
   const exit=record(attempt.exitReceipt),task=tasks.find(item=>item.id===attempt.taskId);
   // A superseded unknown attempt with a confirmed exit is retained evidence,
   // not a permanent veto on the user's explicitly resumed task.
   if(attempt.mode==='write'&&attempt.status==='unknown'&&!task)add(graphId,'write',String(attempt.id),'未知写入尝试缺少所属任务，无法确认已核对');
   if(exit.status==='unknown')add(graphId,'exit',String(attempt.id),'成员退出回执未知');
   else if(attempt.status==='running')add(graphId,'running',String(attempt.id),'成员仍在运行');
   else if(exit.status!=='terminated'&&(attempt.status==='unknown'||attempt.childCreationStarted===true))add(graphId,'exit',String(attempt.id),'成员尚无明确退出边界');
  }
  const stop=record(graph.stopReceipt);
  for(const receipt of records(stop.objects)){
   if(receipt.status!=='unknown')continue;
   const attempt=attempts.find(item=>item.id===receipt.id),ops=operations.filter(op=>op.id===receipt.id);
   // Stop receipts are historical snapshots. Prefer a subsequently reconciled
   // operation or the actual member's later terminal receipt.
   if(attempt&&record(attempt.exitReceipt).status==='terminated')continue;
   if(ops.length&&ops.every(op=>op.status==='confirmed'||op.status==='rejected'))continue;
   add(graphId,'exit',String(receipt.id),'停止记录仍有未核对的退出或副作用');
  }
  for(const member of records(snapshot.teammates).filter(item=>item.graphId===graph.id&&item.rootSessionId===ctx.sessionId)){
   const exit=record(member.stopReceipt),attempt=attempts.find(item=>item.id===member.attemptId);
   if(attempt&&record(attempt.exitReceipt).status==='terminated'&&!['running','stopping','provisioning'].includes(String(member.state)))continue;
   if(exit.status==='unknown')add(graphId,'exit',String(member.id),'队友退出回执未知');
   else if(['running','stopping','provisioning'].includes(String(member.state)))add(graphId,'running',String(member.id),'队友仍在运行或等待退出');
   else if(member.state==='paused'&&member.sessionFile&&!member.stopReceipt)add(graphId,'exit',String(member.id),'队友尚无明确退出回执');
  }
 }
 return issues;
}
