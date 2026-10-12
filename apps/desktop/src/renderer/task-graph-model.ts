import {asList,asObject,type JsonObject} from './types.js';

export interface TaskGraphNode {
 id:string;title:string;status:string;mode:string;dependencies:string[];memberId?:string;memberName?:string;
 waitingReason:string;prompt:string;summary:string;error:string;writeScopes:string[];resultRevision?:number;
 detail:JsonObject;
}
export interface TaskGraph {
 key:string;id:string;kind:'swarm'|'workflow';title:string;status:string;nodes:TaskGraphNode[];
 graphId?:string;definitionRevision?:number;revision?:number;warning:string;structureKey:string;
}
const string=(value:unknown)=>typeof value==='string'?value:'';
const records=(value:unknown)=>asList<unknown>(value).map(asObject);
const settled=new Set(['completed','skipped']);

function nodesFor(definitions:JsonObject[],states:JsonObject[],backend:JsonObject|undefined,members:JsonObject[],owner:string,workflow:boolean,sourceStatus:string):{nodes:TaskGraphNode[];warnings:string[]} {
 const warnings:string[]=[],seen=new Set<string>(),tasks=records(backend?.tasks),attempts=records(backend?.attempts);
 const definitionsById=new Map(definitions.map(node=>[string(node.id),node]));
 const statesById=new Map(states.map(node=>[string(node.id),node]));
 const nodes:TaskGraphNode[]=[];
 for(const definition of definitions){
  const id=string(definition.id);if(!id||seen.has(id)){warnings.push('节点标识缺失或重复，未猜测其身份');continue;}seen.add(id);
  const state=workflow?statesById.get(id):definition,task=workflow?tasks.find(item=>item.id===id):definition;
  const attempt=task?.currentAttempt?attempts.find(item=>item.id===task.currentAttempt&&item.taskId===id):undefined;
  const memberId=string(task?.memberId)||string(attempt?.memberId)||undefined;
  const member=memberId?members.find(item=>item.id===memberId&&(!item.rootSessionId||item.rootSessionId===owner)):undefined;
  const dependencies=[...new Set(asList<unknown>(definition.dependencies).filter((dep):dep is string=>typeof dep==='string'))];
  const missing=dependencies.filter(dep=>!definitionsById.has(dep));if(missing.length)warnings.push(`“${string(definition.title)||id}”的依赖来源缺失`);
  const executionUnknown=workflow&&state?.materialized===true&&(task?.status==='unknown'||attempt?.status==='unknown');
  const status=executionUnknown?'unknown':string(state?.status)||'unavailable';
  if(executionUnknown&&state?.status!=='unknown')warnings.push(`“${string(definition.title)||id}”的流程状态待同步，执行结果需核对`);
  let waitingReason='';
  if(status==='pending'){
   const pending=dependencies.filter(dep=>!settled.has(string(statesById.get(dep)?.status)));
   const wait=asObject(task?.waiting),waitLabel:Record<string,string>={dependency:'依赖',member:'队友',concurrency:'并发名额',resource:'资源',budget:'预算',workflow:'流程条件',paused:'已暂停'};
   waitingReason=missing.length?'依赖来源待核对':typeof wait.kind==='string'&&waitLabel[wait.kind]?`${waitLabel[wait.kind]}：${string(wait.message)||'等待核对'}${wait.blockingTaskId?` · ${String(wait.blockingTaskId)}`:''}`:pending.length?'等待：'+pending.slice(0,2).map(dep=>string(definitionsById.get(dep)?.title)||dep).join('、')+(pending.length>2?` 等 ${pending.length} 项`:''):workflow&&sourceStatus==='created'?'工作流尚未启动':workflow&&state?.materialized!==true?'等待工作流派发':task?.workflowHeld===true?'等待工作流放行':'等待执行';
  }else if(status==='unknown')waitingReason='结果待核对，原现场保留';
  else if(status==='blocked')waitingReason=string(attempt?.error)||'执行受阻，查看任务详情';
  else if(status==='failed')waitingReason=string(state?.error)||string(attempt?.error)||'本次尝试失败';
  else if(status==='skipped')waitingReason=definition.when?'条件未命中，已跳过':'已跳过';
  const summary=workflow&&state?.result!==undefined?(typeof state.result==='string'?state.result:JSON.stringify(state.result,null,2)):string(attempt?.summary);
  nodes.push({id,title:string(definition.title)||id,status,mode:string(definition.mode),dependencies,memberId,memberName:member?string(member.name)||memberId:undefined,waitingReason,prompt:string(definition.prompt),summary,error:string(state?.error)||string(attempt?.error),writeScopes:asList<string>(definition.writeScopes),resultRevision:typeof task?.resultRevision==='number'?task.resultRevision:undefined,
   detail:{task,attempt,...(workflow?{workflowNode:definition,workflowState:state}:{}),checks:asObject(backend?.integration).checks,review:asObject(backend?.integration).review,verification:asObject(backend?.integration).verification,candidateDigest:asObject(backend?.integration).candidateDigest,verificationLevel:asObject(backend?.contract).verification,graphStatus:backend?.status,integratedTaskIds:backend?.integratedTaskIds,budget:backend?.budget,graphError:backend?.error}});
 }
 return {nodes,warnings};
}

/** Display projection only. A workflow and its execution graph are one logical diagram. */
export function projectTaskGraphs({sessionId,runId,graphs,flows,teammates=[]}:{sessionId:string;runId?:string;graphs:JsonObject[];flows:JsonObject[];teammates?:JsonObject[]}):TaskGraph[] {
 const owned=records(graphs).filter(graph=>(!graph.sessionId||graph.sessionId===sessionId)&&!graph.audit&&graph.executionStyle!=='team');
 const workflows=records(flows).filter(flow=>!flow.sessionId||flow.sessionId===sessionId),members=records(teammates),result:TaskGraph[]=[],claimed=new Set<string>();
 const finish=(graph:Omit<TaskGraph,'structureKey'>)=>result.push({...graph,structureKey:JSON.stringify(graph.nodes.map(node=>[node.id,node.dependencies]))});
 const flowIds=new Set<string>();
 for(const flow of workflows){
  const id=string(flow.id);if(!id||flowIds.has(id))continue;flowIds.add(id);
  const graphId=string(flow.graphId),candidates=owned.filter(graph=>graph.workflowId===id);
  let backend=graphId?owned.find(graph=>graph.id===graphId):candidates.length===1?candidates[0]:undefined;
  const warnings:string[]=[];
  if(backend&&backend.workflowId&&backend.workflowId!==id){warnings.push('工作流与执行图身份不一致，未合并成果');backend=undefined;}
  if(backend&&candidates.some(graph=>graph.id!==backend!.id)){warnings.push('工作流关联多个执行图，未猜测其他成果');}
  if(backend)claimed.add(string(backend.id));else if(graphId)warnings.push('执行图暂不可读，流程定义和已保存状态仍保留');
  const projected=nodesFor(records(asObject(flow.definition).nodes),records(flow.nodes),backend,members,sessionId,true,string(flow.status));
  finish({key:'workflow:'+id,id,kind:'workflow',title:string(asObject(flow.definition).title)||'未命名工作流',status:string(flow.status),nodes:projected.nodes,graphId:backend?string(backend.id):undefined,definitionRevision:typeof flow.definitionRevision==='number'?flow.definitionRevision:undefined,revision:typeof backend?.revision==='number'?backend.revision:undefined,warning:[...warnings,...projected.warnings].join('；')});
 }
 const seen=new Set<string>();
 for(const graph of owned){
  const id=string(graph.id);if(!id||seen.has(id)||claimed.has(id))continue;seen.add(id);
  // Workflows retain older backend runs; ordinary Swarm follows the existing current-run filter.
  if(!graph.workflowId&&runId&&graph.runId&&graph.runId!==runId)continue;
  const orphan=!!graph.workflowId,projected=nodesFor(records(graph.tasks),records(graph.tasks),graph,members,sessionId,false,string(graph.status));
  finish({key:'swarm:'+id,id,kind:orphan?'workflow':'swarm',title:orphan?'工作流执行记录 · '+(string(graph.goal)||id):string(graph.goal)||'Swarm 任务',status:string(graph.status),nodes:projected.nodes,graphId:id,revision:typeof graph.revision==='number'?graph.revision:undefined,warning:[...(orphan?['工作流来源暂不可用，仅显示真实执行记录']:[]),...projected.warnings].join('；')});
 }
 return result;
}

/** Desktop routing IDs and Pi history IDs have different authorities. */
export function projectSessionTaskGraphs(owner:{piSessionId?:string;runId?:string},data:{graphs:JsonObject[];flows:JsonObject[];teammates?:JsonObject[]}):TaskGraph[]{return owner.piSessionId?projectTaskGraphs({sessionId:owner.piSessionId,runId:owner.runId,...data}):[];}
export function projectGraphTasks(graph:JsonObject,owner:string,members:JsonObject[]=[]):TaskGraphNode[]{return graph.sessionId&&graph.sessionId!==owner?[]:nodesFor(records(graph.tasks),records(graph.tasks),graph,members,owner,false,string(graph.status)).nodes;}

export type EvidenceState='passed'|'pending'|'failed'|'unknown'|'not-required';
export function taskEvidence(node:TaskGraphNode){
 const data=node.detail,attempt=asObject(data.attempt),review=asObject(data.review),verification=asObject(data.verification),checks=records(data.checks),versions=asObject(review.resultVersions),budget=asObject(data.budget),handoff=asObject(attempt.handoffRead),frozen=asObject(attempt.frozen);
 const binding=typeof data.candidateDigest==='string'&&review.candidateDigest===data.candidateDigest&&versions[node.id]===node.resultRevision,checkBinding=typeof data.candidateDigest==='string'&&verification.candidateDigest===data.candidateDigest&&verification.status!=='stale';
 const execution:EvidenceState=node.status==='unknown'?'unknown':attempt.status==='failed'||['blocked','failed'].includes(node.status)?'failed':node.status==='skipped'?'not-required':node.status==='completed'&&attempt.status==='completed'?'passed':['running','pending'].includes(node.status)?'pending':'unknown';
 const check:EvidenceState=checks.length?checkBinding?(checks.some(c=>c.cancelled===true||c.exitCode===null)?'unknown':checks.every(c=>c.exitCode===0)?'passed':'failed'):'unknown':data.verificationLevel==='V0'?'not-required':'pending';
 const reviewed:EvidenceState=Object.keys(review).length?binding?(review.approved===true?'passed':review.approved===false?'failed':'unknown'):'unknown':data.verificationLevel==='V0'?'not-required':'pending';
 const applied:EvidenceState=data.graphStatus==='integrated'&&execution==='passed'&&asList<string>(data.integratedTaskIds).includes(node.id)?'passed':data.graphStatus==='integrated'?'unknown':'pending';
 const stages=[{label:'执行结束',state:execution},{label:'客观检查',state:check},{label:'独立复核',state:reviewed},{label:'成果应用',state:applied}];
 const basis:string[]=[],gaps:string[]=[];
 if(execution==='passed')basis.push('当前尝试已结束'+(attempt.sessionId?'，原生会话引用见记录':''));else if(execution!=='not-required')gaps.push(execution==='unknown'?'执行结果未知，保留原现场':'执行尚未成功结束');
 if(check==='passed')basis.push(`${checks.length} 项客观检查通过，绑定当前候选`);else if(check!=='not-required')gaps.push(check==='unknown'?'检查结果或当前版本绑定待核对':'客观检查尚未通过');
 if(reviewed==='passed')basis.push('独立复核通过，绑定当前成果版本');else if(reviewed!=='not-required')gaps.push(reviewed==='unknown'?'复核结果或当前成果版本绑定待核对':'独立复核尚未通过');
 if(applied==='passed')basis.push('此成果已整合');else gaps.push('成果应用尚未确认');
 if(handoff.status==='native-full-read')basis.push(`交接全文已进入当前原生工具结果 · ${records(handoff.entries).length} 段`);
 if(attempt.requiredHandoff&&handoff.status!=='native-full-read')gaps.push('必读交接全文覆盖尚未确认');
 const adopted:JsonObject[]=[...records(frozen.memoryRefs).map(ref=>({...ref,capability:'memory'})),...records(frozen.expertRefs).map(ref=>({...ref,capability:'expert'})),...records(frozen.skillRefs).map(ref=>({...ref,capability:'skill'}))];
 return {conclusion:(node.summary||node.error||node.waitingReason||'尚无已保存结论').split(/\n\s*\n/)[0].slice(0,160)+(node.summary.length>160?'…':''),basis,gaps,stages,adopted,handoff,usage:typeof budget.tokenUsed==='number'?`协作总用量：${budget.tokenUsed} tok${budget.tokenUnknown===true?'，另有未知用量':''}`:'协作用量未知'};
}

/** Native receipt stages are displayed separately; selection never implies request injection or correctness. */
export function capabilityReceiptRows(receipts:JsonObject[],runId:string|undefined){
 if(!runId)return [];
 const labels:Record<string,string>={prepared:'已选中',selected:'已选中',retrieved:'检索已返回','context-observed':'历史上下文观察（等级未提升）','injected-to-context':'已进入上下文','request-prepared':'已进入请求准备','response-observed':'响应已观察','tool-read':'工具已读取',checked:'已登记检查'};
 return receipts.flatMap(entry=>{const data=asObject(entry.data),type=string(entry.customType);if(data.runId!==runId)return [];const capability=type.startsWith('friend-pi.memory.usage')?'memory':type==='friend-pi.expert.adoption'||type==='friend-pi.expert.evidence'?'expert':undefined;if(!capability)return [];const stage=labels[string(data.stage)]||(type==='friend-pi.expert.adoption'?'采用已登记（上下文/请求待核对）':'阶段待核对'),refs=capability==='memory'?records(data.records).map(record=>({id:record.id,version:record.revision,hash:record.hash||record.contentHash})):type==='friend-pi.expert.adoption'?records(data.skills).map(skill=>({id:skill.id,version:skill.version,hash:skill.contentHash||skill.hash})):records(data.dependencies).filter(ref=>ref.capability==='expert').map(ref=>({id:ref.id,version:ref.version,hash:ref.hash}));return [{entryId:string(entry.id),capability,stage,refs,raw:entry}];});
}
