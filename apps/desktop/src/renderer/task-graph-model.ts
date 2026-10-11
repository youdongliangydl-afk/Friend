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
  const status=string(state?.status)||'unavailable';
  let waitingReason='';
  if(status==='pending'){
   const pending=dependencies.filter(dep=>!settled.has(string(statesById.get(dep)?.status)));
   waitingReason=missing.length?'依赖来源待核对':pending.length?'等待：'+pending.slice(0,2).map(dep=>string(definitionsById.get(dep)?.title)||dep).join('、')+(pending.length>2?` 等 ${pending.length} 项`:''):workflow&&sourceStatus==='created'?'工作流尚未启动':workflow&&state?.materialized!==true?'等待工作流派发':task?.workflowHeld===true?'等待工作流放行':'等待执行';
  }else if(status==='unknown')waitingReason='结果待核对，原现场保留';
  else if(status==='blocked')waitingReason=string(attempt?.error)||'执行受阻，查看任务详情';
  else if(status==='failed')waitingReason=string(state?.error)||string(attempt?.error)||'本次尝试失败';
  else if(status==='skipped')waitingReason=definition.when?'条件未命中，已跳过':'已跳过';
  const summary=workflow&&state?.result!==undefined?(typeof state.result==='string'?state.result:JSON.stringify(state.result,null,2)):string(attempt?.summary);
  nodes.push({id,title:string(definition.title)||id,status,mode:string(definition.mode),dependencies,memberId,memberName:member?string(member.name)||memberId:undefined,waitingReason,prompt:string(definition.prompt),summary,error:string(state?.error)||string(attempt?.error),writeScopes:asList<string>(definition.writeScopes),resultRevision:typeof task?.resultRevision==='number'?task.resultRevision:undefined,
   detail:{task,attempt,...(workflow?{workflowNode:definition,workflowState:state}:{}),checks:asObject(backend?.integration).checks,review:asObject(backend?.integration).review,graphError:backend?.error}});
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
