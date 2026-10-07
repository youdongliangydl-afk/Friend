import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { RecordStore, registerPlugin, digest, text, object, makeContext, type PluginContext, type JsonObject, type SourceRef } from '@friend-pi/core';

export interface ExpertDefinition { id:string; version:number; title:string; scope:string; prompt:string; tools:string[]; skills:string[]; enabled:boolean; hash:string; createdAt:string; candidateId?:string }
export interface FrozenSkill {path:string;content:string;hash:string}
export interface FrozenExpert extends ExpertDefinition {skillContents:FrozenSkill[]}
export interface FrozenRun {id:string;version:number;prompt:string;toolScope?:string[];skillPaths:string[];experts:FrozenExpert[];hash:string}
export interface ValidationCase {id:string;kind:'positive'|'negative';input:string;expected:unknown;scope:string}
export interface MethodCandidate {
  id:string;title:string;method:string;scope:string;sourceMemoryIds:string[];sources:SourceRef[];
  status:'candidate'|'queued'|'validating'|'failed'|'published'|'withdrawn';
  checks:{caseId:string;passed:boolean;baselinePassed:boolean;output:string}[];error?:string;publishedId?:string;
  validation?:{ownerPid:number;ownerRuntime:string;suiteHash:string;modelId?:string;startedAt:string};
  evaluation?:{suiteHash:string;cases:ValidationCase[];modelId?:string;at:string};
}
interface ValidationJob {key:string;id:string;ctx:PluginContext;following:boolean;resolve:(candidate:MethodCandidate)=>void;reject:(error:Error)=>void;promise:Promise<MethodCandidate>}
const now=()=>new Date().toISOString();
const alive=(pid:number)=>{try {process.kill(pid,0);return true;}catch{return false;}};
const errorText=(error:unknown)=>error instanceof Error?error.message:String(error);
const builtins=[
  ['planner','规划','将目标拆成可验收成果，明确依赖、约束和未知项。先探索已有实现；不把提案写成用户决定。'],
  ['researcher','研究','优先一手来源和实际源码。保留来源、版本与证据范围；把推断与事实分开。'],
  ['implementer','实现','完成最小行为闭包，复用已有代码。保持接口清晰，以真实产物与针对性测试说明完成范围。'],
  ['reviewer','审查','独立核对需求与产物，优先可复现缺陷。不要把模型自评或测试文件存在当作通过。'],
  ['integrator','整合','核对基线和接口，串行整合成果，重新验证最终组合。冲突时保留成果并明确阻塞。'],
];
function user(ctx:PluginContext):void {if(ctx.origin!=='user')throw new Error('此管理操作必须由用户执行');}
function candidateKey(ctx:PluginContext,id:string):string {return `candidate:${ctx.projectId}:${id}`;}
function expertKey(scope:string,id:string):string {return scope==='builtin'?`expert:${id}`:`expert:${scope}:${id}`;}
function cleanStrings(input:unknown,name:string):string[] {if(!Array.isArray(input))throw new Error(`${name}必须是数组`);return [...new Set(input.map(item=>text(item,name,500)))];}
function frozenSkill(path:string,ctx:PluginContext):FrozenSkill {
  const root=realpathSync(ctx.projectDir);const file=realpathSync(resolve(ctx.projectDir,path));const rel=relative(root,file);
  if(isAbsolute(rel)||rel.startsWith('..')||!file.toLowerCase().endsWith('.md'))throw new Error('Skill 必须是当前项目内的 Markdown 文件');
  const stat=statSync(file);if(!stat.isFile()||stat.size>65536)throw new Error('Skill 不是普通 Markdown 或超过 64 KiB');
  const content=readFileSync(file,'utf8');return {path:file,content,hash:digest(content)};
}
function frozenBody(expert:FrozenExpert):string {return `${expert.title} v${expert.version}\n${expert.prompt}${expert.skillContents.map(skill=>`\n\nSkill ${skill.path} (${skill.hash})\n${skill.content}`).join('')}`;}
export function blockedByFrozenScope(frozen:FrozenRun|undefined,toolName:string):boolean {return !!frozen?.toolScope && toolName!=='friend_expert' && !frozen.toolScope.includes(toolName);}

export class ExpertController {
  readonly store:RecordStore;
  private readonly runtime=randomUUID();
  private readonly jobs=new Map<string,ValidationJob>();
  private queue:string[]=[];
  private draining=false;
  private closed=false;
  private timer?:ReturnType<typeof setTimeout>;
  private active?:{key:string;abort:AbortController};
  constructor(dataDir?:string) {
    this.store=new RecordStore('expert',dataDir);
    this.store.transaction(()=>{for(const [id,title,prompt] of builtins){const key=`expert:${id}`;const saved=this.store.get<ExpertDefinition>(key);if(saved&&saved.value.scope!=='builtin'){this.store.put(expertKey(saved.value.scope,id),saved.value);this.store.remove(key);}if(!this.store.get(key))this.store.put(key,{id,version:1,title,scope:'builtin',prompt,tools:[],skills:[],enabled:true,hash:digest({prompt,tools:[],skills:[]}),createdAt:now()} satisfies ExpertDefinition,null);}});
    for(const row of this.store.list<MethodCandidate>('candidate:'))if(row.value.status==='validating'&&(!row.value.validation||!alive(row.value.validation.ownerPid)))this.store.put(row.key,{...row.value,status:'candidate',error:'验证进程已结束；未发布，待重新验证',validation:undefined},row.revision);
    const lease=this.store.get<{pid:number}>('validation:lease');if(lease&&!alive(lease.value.pid))this.store.remove(lease.key);
  }
  definitions(ctx?:PluginContext) {
    const rows=this.store.list<ExpertDefinition>('expert:').map(row=>({...row.value,revision:row.revision}));
    if(!ctx)return rows;
    const visible=new Map(rows.filter(item=>item.scope==='builtin').map(item=>[item.id,item]));
    for(const item of rows)if(item.scope===ctx.projectId)visible.set(item.id,item);return [...visible.values()];
  }
  private settings(ctx:PluginContext):{paused:boolean} {return this.store.get<{paused:boolean}>(`settings:${ctx.projectId}`)?.value||{paused:false};}
  snapshot(ctx:PluginContext) {return {experts:this.definitions(ctx),selection:this.store.get<{ids:string[]}>(`selection:${ctx.projectId}`)?.value.ids||[],candidates:this.store.list<MethodCandidate>(`candidate:${ctx.projectId}:`).map(row=>({...row.value,revision:row.revision})),suites:this.store.list<ValidationCase[]>(`suite:${ctx.projectId}:`).map(row=>({id:row.key.split(':').at(-1),cases:row.value,revision:row.revision})),adoptions:this.store.get(`run:${ctx.sessionId}`)?.value,validation:{...this.settings(ctx),running:!!this.active,queued:this.queue.filter(key=>key.startsWith(`candidate:${ctx.projectId}:`)).length}};}
  private changed(ctx:PluginContext):void {if(!this.closed)ctx.emit('expert.changed',this.snapshot(ctx));}
  freeze(input:JsonObject,ctx:PluginContext):FrozenRun {
    if(this.closed)throw new Error('Expert 已关闭');
    const all=this.definitions(ctx);const selected=this.store.get<{ids:string[]}>(`selection:${ctx.projectId}`)?.value.ids||[];
    const chosen=input.expertId?[text(input.expertId)]:selected.filter(id=>all.some(expert=>expert.id===id&&expert.enabled));
    const enabled=all.filter(expert=>expert.enabled);const list=chosen.length?chosen.map(id=>{const expert=enabled.find(item=>item.id===id);if(!expert)throw new Error('专家已停用或范围不匹配');return expert;}):enabled;
    const experts:FrozenExpert[]=list.map(({revision:_revision,...expert})=>({...expert,tools:[...expert.tools],skills:[...expert.skills],skillContents:expert.skills.map(path=>frozenSkill(path,ctx))}));
    const restrictions=chosen.length?experts.map(expert=>expert.tools).filter(tools=>tools.length):[];
    const toolScope=restrictions.length?restrictions[0].filter(tool=>restrictions.every(scope=>scope.includes(tool))):undefined;
    const prompt=chosen.length?experts.map(frozenBody).join('\n\n'):`可用专家方法（按需使用 friend_expert use，不是强制流程）：\n${experts.map(expert=>`${expert.id}: ${expert.title} — ${expert.prompt}`).join('\n')}`;
    return {id:chosen.join('+')||'auto',version:Math.max(1,...experts.map(expert=>expert.version)),prompt,toolScope,skillPaths:[],experts,hash:digest(experts)};
  }
  beginRun(ctx:PluginContext):FrozenRun {const snapshot=this.freeze({},ctx);this.store.put(`run:${ctx.sessionId}`,snapshot);return snapshot;}
  private definition(id:string,ctx:PluginContext) {const local=this.store.get<ExpertDefinition>(expertKey(ctx.projectId,id));return local||this.store.get<ExpertDefinition>(expertKey('builtin',id));}
  private archive(definition:ExpertDefinition,projectId:string):void {const key=`version:${projectId}:${definition.id}:${definition.version}`;if(!this.store.get(key))this.store.put(key,definition,null);}
  private updateDefinition(id:string,input:JsonObject,ctx:PluginContext,action:'update'|'toggle'|'rollback'):ExpertDefinition {
    return this.store.transaction(()=>{
      const previous=this.definition(id,ctx);if(!previous)throw new Error('专家不存在');if(previous.revision!==Number(input.revision))throw new Error('版本已变化，请刷新后重试');
      const restored=action==='rollback'?this.store.get<ExpertDefinition>(`version:${ctx.projectId}:${id}:${Number(input.version)}`)?.value:undefined;if(action==='rollback'&&!restored)throw new Error('版本不存在');
      const body=restored||previous.value;const prompt=action==='update'?text(input.prompt,'专业方法',32000):body.prompt;const tools=action==='update'?cleanStrings(input.tools||[],'工具'):body.tools;const skills=action==='update'?cleanStrings(input.skills||[],'Skill'):body.skills;skills.forEach(path=>frozenSkill(path,ctx));
      const definition:ExpertDefinition={...body,id,version:previous.value.version+1,title:action==='update'?text(input.title,'名称',120):body.title,scope:ctx.projectId,prompt,tools,skills,enabled:action==='toggle'?input.enabled===true:true,hash:digest({prompt,tools,skills}),createdAt:now()};
      this.archive(previous.value,ctx.projectId);const key=expertKey(ctx.projectId,id);const local=this.store.get(key);let row=this.store.put(key,definition,local?.revision??null);while(row.revision<=previous.revision)row=this.store.put(key,definition,row.revision);return definition;
    });
  }
  async dispatch(action:string,input:JsonObject,ctx:PluginContext):Promise<unknown> {
    if(this.closed)throw new Error('Expert 已关闭');
    if(action==='list'||action==='snapshot')return this.snapshot(ctx);
    if(action==='freeze')return this.freeze(input,ctx);
    if(['select','create','update','toggle','rollback','validation.suite','settings','candidate.withdraw'].includes(action))user(ctx);
    if(action==='select'){const ids=cleanStrings(input.ids||[],'专家标识');for(const id of ids)this.freeze({expertId:id},ctx);this.store.put(`selection:${ctx.projectId}`,{ids});return this.snapshot(ctx);}
    if(action==='settings'){if(typeof input.paused!=='boolean')throw new Error('paused 必须是布尔值');this.store.put(`settings:${ctx.projectId}`,{paused:input.paused});if(input.paused)this.interrupt(ctx.projectId);else this.kick();return this.snapshot(ctx);}
    if(action==='use'){
      const frozen=this.store.get<FrozenRun>(`run:${ctx.sessionId}`)?.value||this.beginRun(ctx);const expert=frozen.experts.find(item=>item.id===text(input.id));if(!expert)throw new Error('当前执行未冻结该专家');
      const latest=this.definition(expert.id,ctx);if(latest?.value.candidateId&&this.store.get<MethodCandidate>(candidateKey(ctx,latest.value.candidateId))?.value.status==='withdrawn')throw new Error('来源已撤回，不能再采用派生方法');
      const adoption={id:expert.id,version:expert.version,hash:expert.hash,skills:expert.skillContents.map(({path,hash})=>({path,hash})),at:now()};ctx.appendEntry('friend-pi.expert.adoption',adoption);return {...expert,prompt:frozenBody(expert),adoption};
    }
    if(action==='create'){
      const id=randomUUID();const prompt=text(input.prompt,'专业方法',32000);const tools=cleanStrings(input.tools||[],'工具');const skills=cleanStrings(input.skills||[],'Skill');skills.forEach(path=>frozenSkill(path,ctx));
      const definition:ExpertDefinition={id,version:1,title:text(input.title,'名称',120),scope:ctx.projectId,prompt,tools,skills,enabled:true,hash:digest({prompt,tools,skills}),createdAt:now()};const row=this.store.put(expertKey(ctx.projectId,id),definition,null);return {...definition,revision:row.revision};
    }
    if(action==='update'||action==='toggle'||action==='rollback'){const definition=this.updateDefinition(text(input.id),input,ctx,action);if(action==='update')return {...definition,revision:this.definition(definition.id,ctx)!.revision};return this.snapshot(ctx);}
    if(action==='versions'){const id=text(input.id);return this.store.list<ExpertDefinition>(`version:${ctx.projectId}:${id}:`).map(row=>row.value);}
    if(action==='candidate.submit'){
      if(ctx.origin!=='user'&&ctx.origin!=='plugin')throw new Error('模型不能用候选提交绕过用户管理；自动方法由有来源的 Memory 插件提交');
      const sources=Array.isArray(input.sources)?input.sources.map(raw=>{const source=object(raw);const ref={sessionId:text(source.sessionId),entryId:text(source.entryId)};ctx.readSource(ref);return ref;}):[];
      const sourceMemoryIds=cleanStrings(input.sourceMemoryIds||[],'父记忆');if(ctx.origin==='plugin'&&(!sourceMemoryIds.length||!sources.length))throw new Error('自动候选需要可回查的来源与父记忆');
      const sourceDigest=digest({title:input.title,method:input.method,scope:ctx.projectId,sourceMemoryIds,sources});const idempotencyKey=input.idempotencyKey?`delivery:${ctx.projectId}:${text(input.idempotencyKey)}`:undefined;
      if(idempotencyKey){const existing=this.store.get<{id:string;sourceDigest:string}>(idempotencyKey);if(existing){if(existing.value.sourceDigest!==sourceDigest)throw new Error('同一幂等标识对应的方法或来源已变化');return this.store.get<MethodCandidate>(candidateKey(ctx,existing.value.id))!.value;}}
      const candidate:MethodCandidate={id:randomUUID(),title:text(input.title,'名称',120),method:text(input.method,'方法',32000),scope:ctx.projectId,sourceMemoryIds,sources,status:'candidate',checks:[]};
      const created=this.store.transaction(()=>{if(idempotencyKey){const existing=this.store.get<{id:string;sourceDigest:string}>(idempotencyKey);if(existing){if(existing.value.sourceDigest!==sourceDigest)throw new Error('同一幂等标识对应的方法或来源已变化');return this.store.get<MethodCandidate>(candidateKey(ctx,existing.value.id))!.value;}}this.store.put(candidateKey(ctx,candidate.id),candidate,null);if(idempotencyKey)this.store.put(idempotencyKey,{id:candidate.id,sourceDigest},null);return candidate;});
      if(created.id!==candidate.id)return created;
      if(this.store.get(`suite:${ctx.projectId}:${ctx.projectId}`))void this.enqueue(candidate.id,ctx).catch(error=>{if(!this.closed)ctx.notify(errorText(error),'warning');});return candidate;
    }
    if(action==='validation.suite'){
      if(!Array.isArray(input.cases))throw new Error('请提供验证用例');
      const cases:ValidationCase[]=input.cases.map(raw=>{const item=object(raw);if(item.expected===undefined)throw new Error('预期 JSON 必须明确提供');return {id:text(item.id),kind:item.kind==='negative'?'negative':'positive',input:text(item.input),expected:item.expected,scope:ctx.projectId};});
      if(new Set(cases.map(item=>item.id)).size!==cases.length||new Set(cases.map(item=>item.input)).size!==cases.length||cases.filter(item=>item.kind==='positive').length<2||cases.filter(item=>item.kind==='negative').length<1)throw new Error('需要两个独立适用案例与一个范围外反例');
      this.store.put(`suite:${ctx.projectId}:${ctx.projectId}`,cases);for(const row of this.store.list<MethodCandidate>(`candidate:${ctx.projectId}:`))if(row.value.status==='candidate')void this.enqueue(row.value.id,ctx).catch(()=>{});return this.snapshot(ctx);
    }
    if(action==='validation.run')return this.enqueue(text(input.id),ctx);
    if(action==='candidate.withdraw'){this.withdraw(candidateKey(ctx,text(input.id)),ctx);return this.snapshot(ctx);}
    if(action==='invalidate'){
      if(ctx.origin!=='plugin'&&ctx.origin!=='user')throw new Error('记忆失效必须来自用户或来源插件');const ids=cleanStrings(input.ids||[],'来源标识');this.invalidate(ids,ctx);return this.snapshot(ctx);
    }
    throw new Error(`未知 Expert 操作：${action}`);
  }
  private withdraw(key:string,ctx?:PluginContext):void {
    const row=this.store.get<MethodCandidate>(key);if(!row)throw new Error('候选不存在');
    this.store.transaction(()=>{
      const latest=this.store.get<MethodCandidate>(key)!;this.store.put(key,{...latest.value,status:'withdrawn',error:'来源或候选已撤回'},latest.revision);
      if(latest.value.publishedId){const expert=this.store.get<ExpertDefinition>(expertKey(latest.value.scope,latest.value.publishedId))||this.store.get<ExpertDefinition>(`expert:${latest.value.publishedId}`);if(expert){this.archive(expert.value,latest.value.scope);this.store.put(expert.key,{...expert.value,enabled:false,version:expert.value.version+1,createdAt:now()},expert.revision);}}
    });
    if(this.active?.key===key)this.active.abort.abort();const job=this.jobs.get(key);if(job){job.reject(new Error('候选已撤回'));this.jobs.delete(key);this.queue=this.queue.filter(item=>item!==key);}if(ctx)this.changed(ctx);
  }
  invalidate(ids:string[],ctx?:PluginContext):void {if(this.closed)return;for(const row of this.store.list<MethodCandidate>('candidate:'))if((!ctx||row.value.scope===ctx.projectId)&&row.value.sourceMemoryIds.some(id=>ids.includes(id)))this.withdraw(row.key,ctx);}
  private enqueue(id:string,ctx:PluginContext):Promise<MethodCandidate> {
    const key=candidateKey(ctx,id);const existing=this.jobs.get(key);if(existing)return existing.promise;
    const row=this.store.get<MethodCandidate>(key);if(!row)return Promise.reject(new Error('候选不存在'));if(row.value.status==='withdrawn')return Promise.reject(new Error('候选已撤回'));if(row.value.status==='published')return Promise.resolve(row.value);
    if(!this.store.get(`suite:${ctx.projectId}:${row.value.scope}`))return Promise.reject(new Error('缺少用户定义的客观验证基准，候选保持待验证'));
    let resolveJob!:(candidate:MethodCandidate)=>void;let rejectJob!:(error:Error)=>void;const promise=new Promise<MethodCandidate>((resolveResult,reject)=>{resolveJob=resolveResult;rejectJob=reject;});
    const following=row.value.status==='validating'&&row.value.validation?.ownerRuntime!==this.runtime;
    this.jobs.set(key,{key,id,ctx,following,resolve:resolveJob,reject:rejectJob,promise});this.queue.push(key);if(!following)this.store.put(key,{...row.value,status:'queued',error:undefined},row.revision);this.kick();this.changed(ctx);return promise;
  }
  private kick():void {if(this.closed||this.draining)return;void this.drain();}
  private retrySoon():void {if(this.timer||this.closed||!this.queue.length)return;this.timer=setTimeout(()=>{this.timer=undefined;this.kick();},50);this.timer.unref();}
  interrupt(projectId?:string):void {if(this.active&&(!projectId||this.jobs.get(this.active.key)?.ctx.projectId===projectId))this.active.abort.abort();}
  resume(ctx:PluginContext):void {
    if(this.closed)return;
    for(const row of this.store.list<MethodCandidate>(`candidate:${ctx.projectId}:`))if(['candidate','queued'].includes(row.value.status)&&this.store.get(`suite:${ctx.projectId}:${row.value.scope}`))void this.enqueue(row.value.id,ctx).catch(error=>{if(!this.closed)ctx.notify(errorText(error),'warning');});
  }
  private lease():boolean {
    return this.store.transaction(()=>{const lease=this.store.get<{pid:number;runtime:string}>('validation:lease');if(lease&&lease.value.runtime!==this.runtime&&alive(lease.value.pid))return false;this.store.put('validation:lease',{pid:process.pid,runtime:this.runtime});return true;});
  }
  private releaseLease():void {if(this.store.get<{runtime:string}>('validation:lease')?.value.runtime===this.runtime)this.store.remove('validation:lease');}
  private async drain():Promise<void> {
    if(this.closed||this.draining)return;this.draining=true;
    try {
      while(!this.closed&&this.queue.length){
        const key=this.queue[0];const job=this.jobs.get(key);if(!job){this.queue.shift();continue;}
        const latest=this.store.get<MethodCandidate>(key);
        if(latest?.value.status==='published'){job.resolve(latest.value);this.jobs.delete(key);this.queue.shift();continue;}
        if(latest?.value.status==='withdrawn'||(job.following&&latest?.value.status==='failed')){job.reject(new Error(latest.value.error||'候选已撤回'));this.jobs.delete(key);this.queue.shift();continue;}
        if(this.settings(job.ctx).paused)break;if(!job.ctx.isIdle()||!this.lease()){this.retrySoon();break;}
        this.queue.shift();const abort=new AbortController();this.active={key,abort};
        try {const result=await this.validateNow(job,abort.signal);if(!this.closed)job.resolve(result);this.jobs.delete(key);}
        catch(error){
          if(this.closed)break;
          const current=this.store.get<MethodCandidate>(key);
          if(current?.value.status==='withdrawn'){job.reject(new Error('来源已撤回，验证作废'));this.jobs.delete(key);}
          else if(abort.signal.aborted||!job.ctx.isIdle()||this.settings(job.ctx).paused){if(current)this.store.put(key,{...current.value,status:'queued',validation:undefined},current.revision);this.queue.unshift(key);if(!this.settings(job.ctx).paused)this.retrySoon();break;}
          else {if(current)this.store.put(key,{...current.value,status:'failed',error:errorText(error),validation:undefined},current.revision);job.reject(new Error(errorText(error)));this.jobs.delete(key);}
        }finally {if(!this.closed){this.active=undefined;this.releaseLease();this.changed(job.ctx);}}
      }
    }finally {this.draining=false;}
  }
  private async validateNow(job:ValidationJob,signal:AbortSignal):Promise<MethodCandidate> {
    const saved=this.store.get<MethodCandidate>(job.key)!;const suite=this.store.get<ValidationCase[]>(`suite:${job.ctx.projectId}:${saved.value.scope}`)!;const suiteHash=digest(suite.value);
    const candidate:MethodCandidate={...saved.value,status:'validating',checks:[],validation:{ownerPid:process.pid,ownerRuntime:this.runtime,suiteHash,modelId:job.ctx.modelId,startedAt:now()}};this.store.put(job.key,candidate,saved.revision);this.changed(job.ctx);
    const ensure=()=>{if(this.closed||signal.aborted)throw new Error('验证已取消');if(!job.ctx.isIdle())throw new Error('前台优先，验证暂停');const current=this.store.get<MethodCandidate>(job.key);if(current?.value.status==='withdrawn')throw new Error('候选已撤回');if(digest(this.store.get<ValidationCase[]>(suite.key)?.value)!==suiteHash)throw new Error('客观验证基准已变化，需重新验证');for(const source of candidate.sources)job.ctx.readSource(source);return current!;};
    const equals=(value:string,expected:unknown)=>{try{return isDeepStrictEqual(JSON.parse(value.replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'')),expected);}catch{return false;}};
    for(const example of suite.value){
      ensure();const task=`仅输出JSON。任务：${example.input}`;const baseline=await job.ctx.complete(task,{signal});ensure();const output=await job.ctx.complete(`专业方法：${candidate.method}\n仅在适用范围内使用，不适用时按基础规则处理。\n${task}`,{signal});const latest=ensure();
      candidate.checks.push({caseId:example.id,passed:equals(output,example.expected),baselinePassed:equals(baseline,example.expected),output});this.store.put(job.key,candidate,latest.revision);this.changed(job.ctx);
    }
    if(candidate.checks.some(check=>!check.passed))throw new Error('客观基准未全部通过');
    const published=this.store.transaction(()=>{const current=ensure();const definition:ExpertDefinition={id:`learned-${candidate.id}`,version:1,title:candidate.title,scope:candidate.scope,prompt:candidate.method,tools:[],skills:[],enabled:true,hash:digest({prompt:candidate.method,tools:[],skills:[]}),createdAt:now(),candidateId:candidate.id};this.store.put(expertKey(candidate.scope,definition.id),definition,null);candidate.status='published';candidate.publishedId=definition.id;candidate.evaluation={suiteHash,cases:suite.value,modelId:job.ctx.modelId,at:now()};candidate.validation=undefined;this.store.put(job.key,candidate,current.revision);return definition;});job.ctx.emit('expert.published',published);return candidate;
  }
  dispose():void {
    if(this.closed)return;this.closed=true;if(this.timer)clearTimeout(this.timer);this.active?.abort.abort();
    if(this.active){const current=this.store.get<MethodCandidate>(this.active.key);if(current&&current.value.status==='validating')this.store.put(current.key,{...current.value,status:'candidate',validation:undefined,error:'会话关闭，验证取消且未发布'},current.revision);}
    for(const job of this.jobs.values())job.reject(new Error('Expert 已关闭，验证取消'));this.jobs.clear();this.queue=[];this.releaseLease();this.store.close();
  }
}

const extension:ExtensionFactory=(pi:ExtensionAPI)=>{
  const controller=new ExpertController();registerPlugin(pi,'expert',controller,'Expert：专业方法、版本、选择、验证和限域发布');
  pi.on('session_start',(_event,ctx)=>controller.resume(makeContext(pi,ctx)));
  pi.on('before_agent_start',(event,ctx)=>{controller.interrupt();const frozen=controller.beginRun(makeContext(pi,ctx));return {systemPrompt:`${event.systemPrompt}\n\n${frozen.prompt}\n专家身份不增加权限。新版本仅用于后续执行。`};});
  pi.on('tool_call',(event,ctx)=>{const frozen=controller.store.get<FrozenRun>(`run:${ctx.sessionManager.getSessionId()}`)?.value;if(blockedByFrozenScope(frozen,event.toolName))return {block:true,reason:'当前专家冻结范围不包含该工具'};});
  const off=pi.events.on('friend-pi:v1:event',raw=>{if(!raw||typeof raw!=='object')return;const event=object(raw);if(event.pluginEvent==='memory.invalidated'&&event.data&&typeof event.data==='object'){const data=object(event.data);if(Array.isArray(data.ids))controller.invalidate(data.ids.map(String));}});
  pi.on('session_shutdown',()=>off());
};
export default extension;
