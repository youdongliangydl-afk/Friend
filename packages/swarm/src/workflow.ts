import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { ConflictError, RecordStore, digest, object, text, type JsonObject, type PluginContext } from '@friend-pi/core';
import { workflowCodeDigest } from './workflow-code.js';

export type WorkflowValue=null|boolean|number|string|WorkflowValue[]|{[key:string]:WorkflowValue};
export type WorkflowPredicate={taskId:string;path?:string[];op:'eq'|'ne'|'exists';value?:WorkflowValue}|{all:WorkflowPredicate[]}|{any:WorkflowPredicate[]}|{not:WorkflowPredicate};
export interface WorkflowNode {
  id:string;title:string;prompt:string;dependencies:string[];mode:'read'|'write';writeScopes:string[];
  phase?:string;expertId?:string;modelId?:string;thinkingLevel?:string;inputs?:WorkflowValue;
  codePaths:string[];when?:WorkflowPredicate;retryWhen?:WorkflowPredicate;maxRetries:number;
}
export interface WorkflowDefinition {v:1;title:string;goal:string;nodes:WorkflowNode[];parameters:WorkflowValue;maxWorkers:number}
export interface WorkflowBackend {dispatch(action:string,input:JsonObject,context:PluginContext):unknown|Promise<unknown>}
export type WorkflowNodeStatus='pending'|'running'|'completed'|'skipped'|'failed'|'unknown';
export interface WorkflowNodeState {
  id:string;status:WorkflowNodeStatus;materialized:boolean;retries:number;result?:WorkflowValue;
  launch?:{inputHash:string;dependencyHash:string;codeHash:string};
  receipt?:{inputHash:string;dependencyHash:string;resultHash:string;codeHash:string};error?:string;
}
export interface WorkflowRun {
  v:1;id:string;projectId:string;sessionId:string;definition:WorkflowDefinition;definitionRevision:number;
  status:'created'|'running'|'waiting_review'|'paused'|'stopped'|'completed'|'blocked';
  nodes:WorkflowNodeState[];graphId?:string;createdAt:string;updatedAt:string;modelId?:string;thinkingLevel?:string;
  owner?:{pid:number;runtime:string};error?:string;
}
export interface WorkflowTemplate {v:1;id:string;version:number;definition:WorkflowDefinition;hash:string;createdAt:string}
interface BackendTask {id:string;status:string;currentAttempt?:string;resultRevision?:number;rework?:number;workflowHeld?:boolean}
interface BackendAttempt {id:string;taskId:string;status:string;summary?:string;commit?:string;sessionId?:string;sessionFile?:string}
interface BackendGraph {id:string;status:string;tasks:BackendTask[];attempts:BackendAttempt[];error?:string}
const now=()=>new Date().toISOString();
const id=(value:unknown)=>{const result=text(value,'流程标识',100);if(!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(result))throw new Error('流程标识仅支持字母、数字、下划线和短横线');return result;};
const integer=(value:unknown,fallback:number,min:number,max:number,label:string)=>{const result=value===undefined?fallback:value;if(typeof result!=='number'||!Number.isInteger(result)||result<min||result>max)throw new Error(`${label}必须在 ${min}–${max} 之间`);return result;};
function plain(value:unknown,depth=0):WorkflowValue {
  if(depth>20)throw new Error('流程 JSON 嵌套过深');
  if(value===null||typeof value==='boolean'||typeof value==='string')return value;
  if(typeof value==='number'&&Number.isFinite(value))return value;
  if(Array.isArray(value))return value.map(item=>plain(item,depth+1));
  if(value&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value))){const result:Record<string,WorkflowValue>={};for(const key of Object.keys(value).sort()){if(['__proto__','constructor','prototype'].includes(key))throw new Error('流程 JSON 字段无效');result[key]=plain((value as JsonObject)[key],depth+1);}return result;}
  throw new Error('流程参数与条件仅接受 JSON 值');
}
function predicate(value:unknown,depth=0):WorkflowPredicate {
  if(depth>8)throw new Error('流程条件嵌套过深');const raw=object(value);
  if('all' in raw||'any' in raw){const key='all' in raw?'all':'any',list=raw[key];if(Object.keys(raw).length!==1||!Array.isArray(list)||list.length<1||list.length>16)throw new Error('组合条件需要 1–16 项');return {[key]:list.map(item=>predicate(item,depth+1))} as WorkflowPredicate;}
  if('not' in raw){if(Object.keys(raw).length!==1)throw new Error('not 条件字段无效');return {not:predicate(raw.not,depth+1)};}
  if(!['eq','ne','exists'].includes(String(raw.op))||Object.keys(raw).some(key=>!['taskId','path','op','value'].includes(key)))throw new Error('流程条件仅支持 eq、ne、exists');
  const path=raw.path===undefined?[]:raw.path;if(!Array.isArray(path)||path.length>16||path.some(item=>typeof item!=='string'||!item||['__proto__','constructor','prototype'].includes(item)))throw new Error('流程条件路径无效');
  if(raw.op!=='exists'&&!Object.hasOwn(raw,'value'))throw new Error('比较条件缺少 JSON value');
  return {taskId:id(raw.taskId),path:path as string[],op:raw.op as 'eq'|'ne'|'exists',...(Object.hasOwn(raw,'value')?{value:plain(raw.value)}:{})};
}
function predicateSources(value:WorkflowPredicate):string[]{if('all' in value)return value.all.flatMap(predicateSources);if('any' in value)return value.any.flatMap(predicateSources);if('not' in value)return predicateSources(value.not);return [value.taskId];}
export function evaluateWorkflowPredicate(value:WorkflowPredicate,results:Record<string,WorkflowValue>):boolean {
  if('all' in value)return value.all.every(item=>evaluateWorkflowPredicate(item,results));if('any' in value)return value.any.some(item=>evaluateWorkflowPredicate(item,results));if('not' in value)return !evaluateWorkflowPredicate(value.not,results);
  if(!Object.hasOwn(results,value.taskId)){if(value.op==='exists')return false;throw new Error(`流程条件来源 ${value.taskId} 没有有效成果`);}
  let result:unknown=results[value.taskId];
  for(const field of value.path||[]){if(result===null||typeof result!=='object'||!Object.hasOwn(result,field)){if(value.op==='exists')return false;throw new Error(`流程条件缺少成果字段 ${field}`);}result=(result as JsonObject)[field];}
  if(value.op==='exists')return result!==undefined;
  const equal=digest(plain(result))===digest(value.value);return value.op==='eq'?equal:!equal;
}
export function validateWorkflowDefinition(value:unknown):WorkflowDefinition {
  const raw=object(value);if(raw.v!==1)throw new Error('流程定义需要 v:1');
  if(!Array.isArray(raw.nodes)||raw.nodes.length<1||raw.nodes.length>64)throw new Error('流程累计节点必须在 1–64 之间');
  const nodes:WorkflowNode[]=raw.nodes.map(item=>{
    const node=object(item);if(node.mode!=='read'&&node.mode!=='write')throw new Error('流程节点 mode 必须是 read 或 write');
    const dependencies=node.dependencies??[];if(!Array.isArray(dependencies)||dependencies.some(dep=>typeof dep!=='string'))throw new Error('流程依赖无效');
    const scopes=node.writeScopes??(node.mode==='write'?['.']:[]);if(!Array.isArray(scopes)||scopes.length>32||node.mode==='write'&&!scopes.length||scopes.some(scope=>typeof scope!=='string'||isAbsolute(scope)||scope.split(/[\\/]/).includes('..')))throw new Error('流程写入范围无效');
    const paths=node.codePaths??(scopes.length?scopes:['.']);if(!Array.isArray(paths)||paths.length<1||paths.length>32||paths.some(path=>typeof path!=='string'||!path||isAbsolute(path)||path.split(/[\\/]/).includes('..')))throw new Error('流程 codePaths 必须是项目内相对路径');
    return {id:id(node.id),title:text(node.title,'节点标题',200),prompt:text(node.prompt,'节点要求',100000),dependencies:[...new Set(dependencies.map(id))],mode:node.mode,writeScopes:scopes as string[],codePaths:paths as string[],maxRetries:integer(node.maxRetries,2,0,2,'单节点重试额度'),
      ...Object.fromEntries(['phase','expertId','modelId','thinkingLevel'].filter(key=>node[key]!==undefined).map(key=>[key,text(node[key],key,200)])),
      ...(node.inputs===undefined?{}:{inputs:plain(node.inputs)}),...(node.when===undefined?{}:{when:predicate(node.when)}),...(node.retryWhen===undefined?{}:{retryWhen:predicate(node.retryWhen)})};
  });
  const byId=new Map(nodes.map(node=>[node.id,node]));if(byId.size!==nodes.length)throw new Error('流程节点标识重复');
  const visiting=new Set<string>(),visited=new Set<string>();
  function visit(node:WorkflowNode):void {if(visiting.has(node.id))throw new Error('流程依赖存在循环');if(visited.has(node.id))return;visiting.add(node.id);for(const dep of node.dependencies){const target=byId.get(dep);if(!target)throw new Error(`流程依赖 ${dep} 不存在`);visit(target);}visiting.delete(node.id);visited.add(node.id);}
  nodes.forEach(visit);
  function ancestors(node:WorkflowNode):Set<string>{const result=new Set<string>();for(const dep of node.dependencies){result.add(dep);for(const inherited of ancestors(byId.get(dep)!))result.add(inherited);}return result;}
  for(const node of nodes){const available=ancestors(node);if(node.when&&predicateSources(node.when).some(source=>!available.has(source)))throw new Error('分支条件必须引用本节点的前置成果');if(node.retryWhen&&predicateSources(node.retryWhen).some(source=>source!==node.id&&!available.has(source)))throw new Error('重试条件必须引用当前节点或前置成果');}
  const definition:WorkflowDefinition={v:1,title:text(raw.title,'流程名称',200),goal:text(raw.goal,'流程目标',100000),nodes,parameters:plain(raw.parameters??{}),maxWorkers:integer(raw.maxWorkers,4,1,16,'流程并发')};
  if(JSON.stringify(definition).length>512000)throw new Error('流程定义超过 512 KB');return definition;
}
function resultValue(summary:string|undefined):WorkflowValue {if(summary===undefined)throw new Error('已完成节点缺少真实成果');try{return plain(JSON.parse(summary));}catch{return summary;}}
function runKey(ctx:PluginContext,workflowId:string){return `run:${ctx.projectId}:${workflowId}`;}
function alive(pid:number):boolean {try{process.kill(pid,0);return true;}catch{return false;}}

/** Structured orchestration only: backend owns members, Pi sessions, checks and Git. */
export class DynamicWorkflowController {
  private readonly runtime=randomUUID();
  private readonly stores=new Map<string,RecordStore>();
  private readonly locks=new Map<string,Promise<unknown>>();
  private readonly contexts=new Map<string,PluginContext>();
  private disposed=false;
  private closing=false;
  constructor(private readonly backend:WorkflowBackend){}
  private store(ctx:PluginContext):RecordStore {if(this.disposed)throw new Error('Workflow 已关闭');let store=this.stores.get(ctx.dataDir);if(!store){store=new RecordStore('swarm-workflow',ctx.dataDir);this.stores.set(ctx.dataDir,store);}return store;}
  private get(workflowId:string,ctx:PluginContext):WorkflowRun {const record=this.store(ctx).get<WorkflowRun>(runKey(ctx,workflowId));if(!record||record.value.sessionId!==ctx.sessionId)throw new Error('流程不存在或不属于当前会话');return record.value;}
  private save(run:WorkflowRun,ctx:PluginContext):void {const key=runKey(ctx,run.id),prior=this.store(ctx).get<WorkflowRun>(key);if(prior&&digest({...prior.value,updatedAt:undefined})===digest({...run,updatedAt:undefined}))return;run.updatedAt=now();this.store(ctx).put(key,run,prior?.revision??null);ctx.emit('workflow.changed',{v:1,workflowId:run.id,status:run.status,definitionRevision:run.definitionRevision});}
  private mode(ctx:PluginContext):void {
    if(ctx.policy?.planMode)throw new Error('计划模式不能执行动态流程');
    if((ctx.executionMode??ctx.policy?.executionMode)!=='swarm'||ctx.policy&&ctx.policy.executionMode!=='swarm')throw new Error('动态流程仅在 Swarm 模式执行');
  }
  private owner(run:WorkflowRun,ctx:PluginContext):void {
    this.store(ctx).transaction(()=>{const key=runKey(ctx,run.id),prior=this.store(ctx).get<WorkflowRun>(key)!;const owner=prior.value.owner;if(owner&&owner.runtime!==this.runtime&&alive(owner.pid))throw new Error('流程由另一活跃运行时管理');run.owner={pid:process.pid,runtime:this.runtime};if(owner?.runtime!==this.runtime)this.store(ctx).put(key,{...prior.value,owner:run.owner},prior.revision);});
  }
  private async serial<T>(key:string,operation:()=>Promise<T>):Promise<T> {const previous=this.locks.get(key)||Promise.resolve();const current=previous.catch(()=>{}).then(operation);this.locks.set(key,current);try{return await current;}finally{if(this.locks.get(key)===current)this.locks.delete(key);}}
  snapshot(ctx:PluginContext):{workflows:WorkflowRun[];templates:WorkflowTemplate[];status:string} {
    const workflows=this.store(ctx).list<WorkflowRun>(`run:${ctx.projectId}:`).map(item=>item.value).filter(run=>run.sessionId===ctx.sessionId);
    const templates=this.store(ctx).list<WorkflowTemplate>(`template-current:${ctx.projectId}:`).map(item=>item.value);
    return {workflows,templates,status:workflows.some(run=>['running','waiting_review'].includes(run.status))?'running':'idle'};
  }
  async dispatch(action:string,input:JsonObject,ctx:PluginContext):Promise<unknown> {
    if(this.disposed||this.closing)throw new Error('Workflow 已关闭');
    if(action==='snapshot'||action==='list')return this.snapshot(ctx);
    if(action==='template.list')return this.snapshot(ctx).templates;
    if(action==='template.read'){const templateId=id(input.templateId),version=input.version;return version===undefined?this.store(ctx).get<WorkflowTemplate>(`template-current:${ctx.projectId}:${templateId}`)?.value:this.store(ctx).get<WorkflowTemplate>(`template:${ctx.projectId}:${templateId}:${integer(version,1,1,100000,'模板版本')}`)?.value;}
    if(action==='template.save'){
      const templateId=id(input.templateId),definition=validateWorkflowDefinition(input.definition),key=`template-current:${ctx.projectId}:${templateId}`;
      return this.store(ctx).transaction(()=>{const prior=this.store(ctx).get<WorkflowTemplate>(key);if(input.revision!==undefined&&prior?.revision!==input.revision)throw new ConflictError();const template:WorkflowTemplate={v:1,id:templateId,version:(prior?.value.version||0)+1,definition,hash:digest(definition),createdAt:now()};this.store(ctx).put(`template:${ctx.projectId}:${templateId}:${template.version}`,template,null);this.store(ctx).put(key,template,prior?.revision??null);return template;});
    }
    if(action==='create'){
      this.mode(ctx);const template=input.templateId===undefined?undefined:await this.dispatch('template.read',input,ctx) as WorkflowTemplate|undefined;if(input.templateId!==undefined&&!template)throw new Error('流程模板不存在');
      const source=object(input.definition??template?.definition);const definition=validateWorkflowDefinition({...source,...(input.parameters===undefined?{}:{parameters:input.parameters})});
      const run:WorkflowRun={v:1,id:randomUUID(),projectId:ctx.projectId,sessionId:ctx.sessionId,definition,definitionRevision:1,status:'created',nodes:definition.nodes.map(node=>({id:node.id,status:'pending',materialized:false,retries:0})),createdAt:now(),updatedAt:now()};
      this.save(run,ctx);ctx.appendEntry('friend-pi.workflow.created',{v:1,workflowId:run.id,definitionHash:digest(definition)});return run;
    }
    const workflowId=id(input.workflowId);this.contexts.set(`${ctx.dataDir}:${workflowId}`,ctx);
    return this.serial(`${ctx.dataDir}:${workflowId}`,async()=>{
      const run=this.get(workflowId,ctx);
      if(action==='status'){if(run.status==='running'||run.status==='waiting_review')await this.progress(run,ctx);return this.get(workflowId,ctx);}
      this.mode(ctx);this.owner(run,ctx);
      if(action==='start'){
        if(run.status!=='created')throw new Error('已有流程请通过 resume 接续');run.modelId=ctx.modelId;run.thinkingLevel=ctx.thinkingLevel;run.status='running';this.save(run,ctx);await this.progress(run,ctx);return this.get(workflowId,ctx);
      }
      if(action==='pause'||action==='stop'){
        if(run.status==='completed')return run;
        if(run.graphId)await this.backend.dispatch(action,{graphId:run.graphId},ctx);await this.synchronize(run,ctx);run.status=action==='pause'?'paused':'stopped';this.save(run,ctx);return run;
      }
      if(action==='resume'){
        if(!['paused','stopped','blocked'].includes(run.status))throw new Error('流程尚未暂停');await this.synchronize(run,ctx);
        const unknown=run.nodes.some(state=>state.status==='unknown');
        if(unknown&&(input.confirmUnknown!==true||ctx.origin!=='user'))throw new Error('存在副作用未知的节点；检查保留成果后必须由用户明确 confirmUnknown:true，流程不能自动重跑');
        await this.invalidateChanged(run,ctx,unknown);
        if(run.nodes.some(state=>state.status==='failed'))throw new Error('节点重试额度耗尽，不能绕过失败依赖接续');
        if(run.graphId)await this.backend.dispatch('resume',{graphId:run.graphId,...(unknown?{confirmUnknown:true}:{})},ctx);else {run.modelId=ctx.modelId;run.thinkingLevel=ctx.thinkingLevel;}
        run.status='running';run.error=undefined;this.save(run,ctx);await this.progress(run,ctx);return this.get(workflowId,ctx);
      }
      if(action==='append'||action==='revise'){
        if(action==='revise'&&['running','waiting_review','completed'].includes(run.status))throw new Error('先暂停到安全边界再调整流程');
        if(action==='append'){
          if(['waiting_review','completed'].includes(run.status))throw new Error('流程已进入最终复核或完成阶段，不能继续追加');
          if(Object.keys(input).some(key=>!['workflowId','nodes','definitionRevision'].includes(key)))throw new Error('append 只能增补节点，不能修改参数、目标或已有定义');
          const graph=await this.graph(run,ctx);if(graph&&['awaiting_review','ready','integrated','stopping'].includes(graph.status))throw new Error('Swarm 正在停止或最终复核，不能继续追加');
        }
        if(action==='append'&&(!Array.isArray(input.nodes)||!input.nodes.length))throw new Error('append 需要至少一个新节点');
        const definition=action==='append'?validateWorkflowDefinition({...run.definition,nodes:[...run.definition.nodes,...(Array.isArray(input.nodes)?input.nodes:[])]}):validateWorkflowDefinition(input.definition);
        if(run.nodes.some(state=>!definition.nodes.some(node=>node.id===state.id)))throw new Error('累计节点不能删除或更名，不能绕过失败节点');
        if(definition.goal!==run.definition.goal)throw new Error('既有流程目标不可改写，请创建新流程');
        if(input.definitionRevision!==undefined&&input.definitionRevision!==run.definitionRevision)throw new ConflictError();
        run.definition=definition;run.definitionRevision++;for(const node of definition.nodes)if(!run.nodes.some(state=>state.id===node.id))run.nodes.push({id:node.id,status:'pending',materialized:false,retries:0});
        this.save(run,ctx);if(action==='append'&&run.status==='running')await this.progress(run,ctx);return this.get(workflowId,ctx);
      }
      throw new Error(`未知 Workflow 操作：${action}`);
    });
  }
  private node(run:WorkflowRun,nodeId:string):WorkflowNode {return run.definition.nodes.find(node=>node.id===nodeId)!;}
  private async graph(run:WorkflowRun,ctx:PluginContext):Promise<BackendGraph|undefined> {
    if(!run.graphId)return undefined;const snapshot=object(await this.backend.dispatch('snapshot',{},ctx));return (Array.isArray(snapshot.graphs)?snapshot.graphs:[]).map(item=>object(item) as unknown as BackendGraph).find(graph=>graph.id===run.graphId);
  }
  private results(run:WorkflowRun):Record<string,WorkflowValue> {return Object.fromEntries(run.nodes.filter(state=>state.status==='completed'&&state.result!==undefined).map(state=>[state.id,state.result!]));}
  private inputHash(run:WorkflowRun,node:WorkflowNode):string {return digest({node,parameters:run.definition.parameters,modelId:node.modelId||run.modelId,thinkingLevel:node.thinkingLevel||run.thinkingLevel});}
  private dependencyHash(run:WorkflowRun,node:WorkflowNode):string {return digest(node.dependencies.map(dep=>{const state=run.nodes.find(item=>item.id===dep)!;return {id:dep,status:state.status,result:state.receipt?.resultHash,input:state.receipt?.inputHash};}));}
  private resultHash(task:BackendTask,attempt:BackendAttempt):string {return digest({resultRevision:task.resultRevision,attemptId:attempt.id,summary:attempt.summary,commit:attempt.commit,sessionId:attempt.sessionId,sessionFile:attempt.sessionFile});}
  private async synchronize(run:WorkflowRun,ctx:PluginContext):Promise<BackendGraph|undefined> {
    const graph=await this.graph(run,ctx);if(run.graphId&&!graph)throw new Error('原 Swarm 任务图缺失，不能创建替代历史');if(!graph)return undefined;
    for(const state of run.nodes.filter(item=>item.materialized)){
      const task=graph.tasks.find(item=>item.id===state.id);if(!task)throw new Error('已派发流程节点在 Swarm 中缺失');const attempt=graph.attempts.find(item=>item.id===task.currentAttempt);
      state.retries=Math.max(state.retries,task.rework||0);
      if(task.status==='completed'&&attempt&&state.status!=='completed'){
        if(!state.launch)throw new Error('流程节点缺少实际派发输入摘要，不能把历史成果当作新成果');
        state.result=resultValue(attempt.summary);state.status='completed';state.receipt={...state.launch,resultHash:this.resultHash(task,attempt)};state.error=undefined;
      }else if(task.status==='unknown')state.status='unknown';
      else if(task.status==='running'||task.status==='pending'){if(state.status==='completed')state.launch=undefined;state.status=task.status==='running'?'running':'pending';state.result=undefined;state.receipt=undefined;}
      else if(task.status==='skipped'){state.status='skipped';state.result=undefined;state.receipt=undefined;}
      else if(task.status==='blocked'||task.status==='cancelled') {state.status=attempt?.status==='failed'?'failed':attempt?.status==='unknown'?'unknown':'pending';state.error=graph.error;}
    }
    return graph;
  }
  private taskSpec(run:WorkflowRun,node:WorkflowNode):JsonObject {
    const prompt=node.prompt.replace(/\{\{args\.([A-Za-z0-9_.-]+)\}\}/g,(_match,path:string)=>{let value:unknown=run.definition.parameters;for(const part of path.split('.')){if(!value||typeof value!=='object'||!Object.hasOwn(value,part))throw new Error(`流程参数 ${path} 缺失`);value=(value as JsonObject)[part];}return typeof value==='string'?value:JSON.stringify(value);});
    return {id:node.id,title:node.title,prompt:node.inputs===undefined?prompt:`${prompt}\n流程输入：${JSON.stringify(node.inputs)}`,dependencies:node.dependencies.filter(dep=>run.nodes.find(state=>state.id===dep)!.materialized),mode:node.mode,writeScopes:node.writeScopes.length?node.writeScopes:['.'],expertId:node.expertId,modelId:node.modelId,thinkingLevel:node.thinkingLevel,logicalStepId:`workflow:${digest(run.definition.goal).slice(0,24)}:${node.id}`,workflowHeld:false};
  }
  private async reset(run:WorkflowRun,state:WorkflowNodeState,ctx:PluginContext,reason:string,confirmUnknown=false):Promise<void> {
    if(state.retries>=this.node(run,state.id).maxRetries){state.status='failed';state.error='节点累计重试额度耗尽';return;}
    if(state.materialized&&run.graphId){
      const graph=await this.graph(run,ctx),task=graph?.tasks.find(item=>item.id===state.id);
      const alreadyInvalidated=task?.status==='pending'&&task.workflowHeld===true&&!task.currentAttempt;
      if(!alreadyInvalidated&&Math.max(state.retries,task?.rework||0)>=this.node(run,state.id).maxRetries){state.retries=Math.max(state.retries,task?.rework||0);state.status='failed';state.error='节点累计重试额度耗尽';return;}
      await this.backend.dispatch('update_task',{graphId:run.graphId,taskId:state.id,...this.taskSpec(run,this.node(run,state.id)),reason,invalidate:true,repair:!alreadyInvalidated,...(confirmUnknown?{confirmUnknown:true}:{})},ctx);
      const updated=(await this.graph(run,ctx))?.tasks.find(item=>item.id===state.id);state.retries=Math.max(state.retries+(alreadyInvalidated?0:1),updated?.rework||0);
    }
    state.status='pending';state.result=undefined;state.receipt=undefined;state.launch=undefined;state.error=undefined;
  }
  private async invalidateChanged(run:WorkflowRun,ctx:PluginContext,confirmUnknown=false):Promise<void> {
    const graph=await this.graph(run,ctx);const invalid=new Set<string>();
    for(const state of run.nodes){const node=this.node(run,state.id);
      if(state.status==='completed'&&state.receipt){const task=graph?.tasks.find(item=>item.id===state.id),attempt=graph?.attempts.find(item=>item.id===task?.currentAttempt);
        if(state.receipt.inputHash!==this.inputHash(run,node)||state.receipt.dependencyHash!==this.dependencyHash(run,node)||state.receipt.codeHash!==workflowCodeDigest(ctx.projectDir,node.codePaths,ctx.dataDir)||!task||!attempt||state.receipt.resultHash!==this.resultHash(task,attempt))invalid.add(state.id);
      }
      if(state.status!=='completed'&&state.materialized&&state.launch&&state.launch.inputHash!==this.inputHash(run,node))invalid.add(state.id);
      if(state.status==='skipped')invalid.add(state.id);
      if(state.status==='unknown')invalid.add(state.id);
    }
    let changed=true;while(changed){changed=false;for(const node of run.definition.nodes)if(!invalid.has(node.id)&&node.dependencies.some(dep=>invalid.has(dep))){invalid.add(node.id);changed=true;}}
    for(const node of run.definition.nodes.filter(item=>invalid.has(item.id)))await this.reset(run,run.nodes.find(state=>state.id===node.id)!,ctx,'输入、依赖、成果或相关代码摘要变化，重新验证',confirmUnknown);
    this.save(run,ctx);
  }
  private async progress(run:WorkflowRun,ctx:PluginContext):Promise<void> {
    this.mode(ctx);this.owner(run,ctx);
    try{
      let graph=await this.synchronize(run,ctx);
      if(run.status==='waiting_review'){
        if(graph?.status==='integrated'){run.status='completed';this.save(run,ctx);return;}
        if(graph?.status==='paused'||graph?.status==='failed'){run.status='paused';run.error=graph.error;this.save(run,ctx);return;}
        if(graph?.status==='running'&&run.nodes.some(state=>['pending','running'].includes(state.status)))run.status='running';else {this.save(run,ctx);return;}
      }
      const needsRetry=new Set<string>();
      for(const state of run.nodes){const node=this.node(run,state.id);if(state.status==='unknown'){run.status='paused';run.error='存在中断且副作用未知的节点';this.save(run,ctx);return;}
        if(state.status==='failed'||(state.status==='completed'&&node.retryWhen&&evaluateWorkflowPredicate(node.retryWhen,this.results(run)))){
          if(graph?.tasks.some(task=>task.status==='running'))needsRetry.add(state.id);
          else {await this.reset(run,state,ctx,'节点失败或满足有限重试条件');graph=await this.graph(run,ctx);}
        }
      }
      if(run.nodes.some(state=>state.status==='failed'&&!needsRetry.has(state.id))){run.status='blocked';run.error='节点重试额度耗尽；不能绕过其依赖';this.save(run,ctx);return;}
      let changed=true;const ready:WorkflowNodeState[]=[];
      while(changed){changed=false;for(const state of run.nodes.filter(item=>item.status==='pending')){
        const node=this.node(run,state.id);if(!node.dependencies.every(dep=>!needsRetry.has(dep)&&['completed','skipped'].includes(run.nodes.find(item=>item.id===dep)!.status)))continue;
        if(node.when&&!evaluateWorkflowPredicate(node.when,this.results(run))){if(state.materialized&&run.graphId)await this.backend.dispatch('workflow_skip',{graphId:run.graphId,taskId:state.id},ctx);state.status='skipped';changed=true;}
        else if(!ready.includes(state))ready.push(state);
      }}
      if(ready.length){
        for(const state of ready)if(!state.launch){const node=this.node(run,state.id);state.launch={inputHash:this.inputHash(run,node),dependencyHash:this.dependencyHash(run,node),codeHash:workflowCodeDigest(ctx.projectDir,node.codePaths,ctx.dataDir)};}
        const tasks=ready.filter(state=>!state.materialized).map(state=>this.taskSpec(run,this.node(run,state.id)));
        if(!run.graphId){const created=object(await this.backend.dispatch('create',{goal:run.definition.goal,tasks,maxWorkers:run.definition.maxWorkers,executionStyle:'swarm',workflowId:run.id,deferPreparation:true},ctx));run.graphId=text(created.id,'Swarm 图标识');this.save(run,ctx);}
        else {
          if(tasks.length)await this.backend.dispatch('append',{graphId:run.graphId,tasks},ctx);
          for(const state of ready.filter(item=>item.materialized))if(graph?.tasks.find(task=>task.id===state.id)?.workflowHeld)await this.backend.dispatch('update_task',{graphId:run.graphId,taskId:state.id,workflowHeld:false,gateOnly:true},ctx);
        }
        for(const state of ready)state.materialized=true;
        const refreshed=await this.graph(run,ctx);await this.backend.dispatch(refreshed?.status==='paused'||refreshed?.status==='stopped'?'resume':'start',{graphId:run.graphId},ctx);graph=await this.synchronize(run,ctx);
      }else if(graph&&run.nodes.some(state=>state.materialized&&state.status==='pending')&&['paused','completed','created','stopped'].includes(graph.status)){
        await this.backend.dispatch('resume',{graphId:run.graphId},ctx);graph=await this.synchronize(run,ctx);
      }
      if(!needsRetry.size&&run.nodes.every(state=>['completed','skipped'].includes(state.status))){
        if(run.graphId){await this.backend.dispatch('prepare',{graphId:run.graphId},ctx);run.status='waiting_review';}else run.status='completed';
      }else if(!needsRetry.size&&!run.nodes.some(state=>state.materialized&&['pending','running'].includes(state.status))&&!ready.length){run.status='blocked';run.error='流程依赖或分支缺少有效成果';}
      this.save(run,ctx);
    }catch(error){
      const message=error instanceof Error?error.message:String(error);
      if(/先停止成员并等待安全边界|停止尚未到安全边界|后台尚未到安全边界/.test(message)){run.error='等待实际进程结束收据后继续推进';this.save(run,ctx);return;}
      run.status='paused';run.error=message;this.save(run,ctx);throw error;
    }
  }
  async advance(ctx:PluginContext):Promise<unknown> {
    if(this.disposed||this.closing)throw new Error('Workflow 已关闭');
    if(ctx.policy?.executionStopped)return this.snapshot(ctx);
    const active=this.snapshot(ctx).workflows.filter(run=>['running','waiting_review'].includes(run.status));
    for(const run of active)await this.serial(`${ctx.dataDir}:${run.id}`,async()=>{const current=this.get(run.id,ctx);if(['running','waiting_review'].includes(current.status))await this.progress(current,ctx);});
    return this.snapshot(ctx);
  }
  async dispose():Promise<void> {
    if(this.disposed||this.closing)return;this.closing=true;await Promise.allSettled([...this.locks.values()]);
    for(const ctx of this.contexts.values())for(const run of this.snapshot(ctx).workflows.filter(item=>item.owner?.runtime===this.runtime)){
      if(['running','waiting_review'].includes(run.status)){if(run.graphId)await Promise.resolve(this.backend.dispatch('pause',{graphId:run.graphId},ctx)).catch(()=>{});run.status='paused';run.error='流程运行时已关闭，请显式接续';}
      run.owner=undefined;this.save(run,ctx);
    }
    this.disposed=true;for(const store of this.stores.values())store.close();this.stores.clear();
  }
}
