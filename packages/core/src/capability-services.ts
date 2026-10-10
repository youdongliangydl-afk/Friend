import {randomUUID,createHash} from 'node:crypto';
import {existsSync,readFileSync,realpathSync} from 'node:fs';
import {digest,readSourceSpan,type RecordStore,type SourceRef,type JsonObject,type HistoryItem} from './index.js';

export type ErrorCode='VALIDATION_ERROR'|'VERSION_CONFLICT'|'PERMISSION_DENIED'|'SOURCE_UNAVAILABLE'|'CAPABILITY_UNAVAILABLE'|'BUDGET_EXHAUSTED'|'OPERATION_UNKNOWN'|'CANCELLED';
export class CapabilityError extends Error {
 constructor(readonly code:ErrorCode,message:string,readonly details?:JsonObject){super(message);this.name='CapabilityError';}
}
export function normalizeCapabilityError(error:unknown):{error:string;code:ErrorCode;details?:JsonObject}{
 if(error instanceof CapabilityError)return {error:error.message,code:error.code,details:error.details};
 const message=error instanceof Error?error.message:String(error);
 return {error:message,code:error instanceof Error&&error.name==='ConflictError'?'VERSION_CONFLICT':error instanceof Error&&error.name==='AbortError'?'CANCELLED':'VALIDATION_ERROR'};
}
export interface ArtifactRef {artifactId:string;version:number;sha256:string;mediaType:string;ranges?:{unit:'utf16'|'bytes'|'sheet-range'|'page';value:string}[]}
export interface CapabilityDependency {capability:'memory'|'expert';id:string;version:number;hash:string;relation:'derived-from'|'adopted'}
export interface EvidenceReceipt {
 v:1;receiptId:string;projectId:string;sessionId:string;runId:string;attemptId?:string;operationId?:string;
 stage:'saved'|'selected'|'injected-to-context'|'request-prepared'|'response-observed'|'tool-read'|'checked';
 sources:SourceRef[];artifacts?:ArtifactRef[];dependencies:CapabilityDependency[];
 observer?:{kind:'foreground'|'member'|'learning-worker'|'parser';runId:string;jobId?:string;modelId?:string};
 contentHash:string;fullLength?:number;visibleRanges?:[number,number][];omittedReason?:string;at:string;
}
export interface LearningLeaseToken {ownerRuntime:string;epoch:number;expiresAt:number}
/** Pi initializes absent provider usage to zero; a nonempty inference must not turn that into exact billing. */
export function modelTokenUsage(usage:unknown):number|undefined {const tokens=usage&&typeof usage==='object'&&'totalTokens' in usage?usage.totalTokens:undefined;return typeof tokens==='number'&&Number.isSafeInteger(tokens)&&tokens>0?tokens:undefined;}
export interface SourceFence {
 v:1;id:string;projectId:string;sourceEpoch:number;policyEpoch:number;expiresAt:number;
 sources:SourceRef[];artifacts:ArtifactRef[];dependencies:CapabilityDependency[];
 states:{key:string;epoch:number}[];
}
interface PolicyState {epoch:number;valid:boolean;reason?:string}
interface DependencyState extends PolicyState {projectId:string;capability:'memory'|'expert';id:string;version:number;hash:string}
export interface RegisteredArtifact {ref:ArtifactRef;projectId:string;path:string;observations:EvidenceReceipt[];valid:boolean;text?:string;owners?:string[]}
export interface CheckRef {checkId:string;version:number;hash:string;taskId:string;producerRunId:string;artifacts:ArtifactRef[]}
export interface RegisteredCheck {ref:CheckRef;projectId:string;passed:boolean;output:unknown;sources:SourceRef[]}
function get<T>(store:RecordStore,namespace:string,key:string):T|undefined {const row=store.db.prepare('SELECT json FROM documents WHERE namespace=? AND key=?').get(namespace,key);return row?JSON.parse(String(row.json)) as T:undefined;}
function put(store:RecordStore,namespace:string,key:string,value:unknown){store.db.prepare('INSERT INTO documents(namespace,key,revision,json) VALUES(?,?,1,?) ON CONFLICT(namespace,key) DO UPDATE SET revision=documents.revision+1,json=excluded.json').run(namespace,key,JSON.stringify(value));}
function rows<T>(store:RecordStore,namespace:string,prefix:string):{key:string;value:T}[]{return store.db.prepare('SELECT key,json FROM documents WHERE namespace=? AND substr(key,1,?)=?').all(namespace,prefix.length,prefix).map(row=>({key:String(row.key),value:JSON.parse(String(row.json)) as T}));}
const policyNS='source-policy';
const sourceKey=(source:SourceRef)=>`source:${digest([source.sessionId,source.entryId,source.start??null,source.end??null,source.hash??null])}`;
const depKey=(ref:Pick<CapabilityDependency,'capability'|'id'|'version'|'hash'>,projectId:string)=>`dependency:${digest([projectId,ref.capability,ref.id,ref.version,ref.hash])}`;
const sessionKey=(sessionId:string)=>`session:${sessionId}`;
const entryKey=(source:SourceRef)=>`entry:${digest([source.sessionId,source.entryId])}`;
function sourceOverlap(a:SourceRef,b:SourceRef){return a.sessionId===b.sessionId&&a.entryId===b.entryId&&(a.start??0)<(b.end??Infinity)&&(b.start??0)<(a.end??Infinity);}
function requireRef(source:SourceRef){if(!source||typeof source.sessionId!=='string'||!source.sessionId||typeof source.entryId!=='string'||!source.entryId||source.start!==undefined&&(!Number.isSafeInteger(source.start)||source.start<0)||source.end!==undefined&&(!Number.isSafeInteger(source.end)||source.end<(source.start??0)))throw new CapabilityError('VALIDATION_ERROR','来源引用无效');}
function artifactKey(ref:ArtifactRef){if(!ref||typeof ref.artifactId!=='string'||!ref.artifactId||!Number.isSafeInteger(ref.version)||ref.version<1||!/^[a-f0-9]{64}$/.test(ref.sha256))throw new CapabilityError('VALIDATION_ERROR','产物版本引用无效');return `artifact:${digest([ref.artifactId,ref.version])}`;}

/** Public validity metadata is checked on the caller's SQLite connection, beside its business write. */
export class SourcePolicy {
 constructor(readonly store:RecordStore){}
 private state(key:string):PolicyState {return get<PolicyState>(this.store,policyNS,key)||{epoch:0,valid:true};}
 private nextEpoch(){const epoch=(get<number>(this.store,policyNS,'epoch')||0)+1;put(this.store,policyNS,'epoch',epoch);return epoch;}
 private dependency(ref:CapabilityDependency,projectId:string){return get<DependencyState>(this.store,policyNS,depKey(ref,projectId))||get<DependencyState>(this.store,policyNS,depKey(ref,'builtin'))||(ref.capability==='memory'?get<DependencyState>(this.store,policyNS,depKey(ref,'personal')):undefined);}
 assertSource(source:SourceRef):void {requireRef(source);if(rows<{source:SourceRef;reason:string}>(this.store,policyNS,`revocation:${source.sessionId}:`).some(row=>sourceOverlap(row.value.source,source)))throw new CapabilityError('SOURCE_UNAVAILABLE','来源片段已撤回');for(const key of [sessionKey(source.sessionId),entryKey(source),sourceKey(source)])if(!this.state(key).valid||get(this.store,'sessions',`tombstone:${source.sessionId}`))throw new CapabilityError('SOURCE_UNAVAILABLE','来源已撤回或禁止学习');}
 capture(input:{projectId:string;sources:SourceRef[];artifacts?:ArtifactRef[];dependencies?:CapabilityDependency[]}):SourceFence {
  if(typeof input.projectId!=='string'||!input.projectId||!Array.isArray(input.sources))throw new CapabilityError('VALIDATION_ERROR','来源围栏参数无效');
  return this.store.transaction(()=>{
   const states=new Map<string,number>();for(const source of input.sources){this.assertSource(source);for(const key of [sessionKey(source.sessionId),entryKey(source),sourceKey(source)]){const state=this.state(key);if(!state.valid||get(this.store,'sessions',`tombstone:${source.sessionId}`))throw new CapabilityError('SOURCE_UNAVAILABLE',state.reason||'来源已撤回');states.set(key,state.epoch);}}
   const artifacts=input.artifacts||[],dependencies=input.dependencies||[];
   for(const ref of artifacts){const record=this.artifact(ref,input.projectId);states.set(artifactKey(ref),this.state(artifactKey(record.ref)).epoch);}
   for(const ref of dependencies){const record=this.dependency(ref,input.projectId);if(!record?.valid)throw new CapabilityError('SOURCE_UNAVAILABLE','依赖版本不可用',{id:ref.id});states.set(depKey(ref,record.projectId),record.epoch);}
   const fence:SourceFence={v:1,id:randomUUID(),projectId:input.projectId,sourceEpoch:get<number>(this.store,policyNS,'epoch')||0,policyEpoch:get<number>(this.store,policyNS,'policyEpoch')||0,expiresAt:Date.now()+2*60*60*1000,sources:structuredClone(input.sources),artifacts:structuredClone(artifacts),dependencies:structuredClone(dependencies),states:[...states].map(([key,epoch])=>({key,epoch}))};
   put(this.store,policyNS,`fence:${fence.id}`,{hash:digest(fence)});return fence;
  });
 }
 assert(fence:SourceFence,lease?:LearningLeaseToken):void {
  if(!fence||fence.v!==1||fence.expiresAt<Date.now()||get<{hash:string}>(this.store,policyNS,`fence:${fence.id}`)?.hash!==digest(fence))throw new CapabilityError('VERSION_CONFLICT','来源围栏已过期或不匹配');
  if((get<number>(this.store,policyNS,'policyEpoch')||0)!==fence.policyEpoch)throw new CapabilityError('SOURCE_UNAVAILABLE','来源策略已变化');
  for(const entry of fence.states){const state=this.state(entry.key);if(!state.valid||state.epoch!==entry.epoch)throw new CapabilityError('SOURCE_UNAVAILABLE',state.reason||'来源或依赖版本已变化');}
  for(const source of fence.sources)this.assertSource(source);
  for(const ref of fence.artifacts)this.artifact(ref,fence.projectId);
  for(const ref of fence.dependencies)if(!this.dependency(ref,fence.projectId)?.valid)throw new CapabilityError('SOURCE_UNAVAILABLE','依赖版本已撤回');
  if(lease)assertLearningLease(this.store,lease);
 }
 commit<T>(fence:SourceFence,lease:LearningLeaseToken|undefined,write:()=>T):T {return this.store.transaction(()=>{this.assert(fence,lease);const result=write();if(result&&typeof (result as {then?:unknown}).then==='function')throw new CapabilityError('VALIDATION_ERROR','提交围栏只允许同步短事务');return result;});}
 publishDependency(input:{capability:'memory'|'expert';id:string;projectId:string;version:number;hash:string;valid:boolean;epoch?:number}):void {
  if(!['memory','expert'].includes(input.capability)||!input.id||!input.projectId||!Number.isSafeInteger(input.version)||input.version<1||!input.hash||typeof input.valid!=='boolean')throw new CapabilityError('VALIDATION_ERROR','能力版本元数据无效');
  this.store.transaction(()=>{const key=depKey(input,input.projectId),old=get<DependencyState>(this.store,policyNS,key);if(old&&old.valid===input.valid)return;const epoch=this.nextEpoch();put(this.store,policyNS,key,{...input,epoch});});
 }
 invalidate(input:{projectId?:string;sources?:SourceRef[];refs?:SourceRef[];sessionId?:string;dependencies?:CapabilityDependency[];reason:string;key:string}):{epoch:number} {
  if(!input.key||!input.reason)throw new CapabilityError('VALIDATION_ERROR','撤回需要操作身份和原因');
  return this.store.transaction(()=>{
   const operation=`invalidate:${input.key}`,hash=digest(input),old=get<{hash:string;epoch:number}>(this.store,policyNS,operation);if(old){if(old.hash!==hash)throw new CapabilityError('VERSION_CONFLICT','撤回幂等键已用于不同内容');return {epoch:old.epoch};}
   const epoch=this.nextEpoch(),state={epoch,valid:false,reason:input.reason};if(input.sessionId)put(this.store,policyNS,sessionKey(input.sessionId),state);
   for(const source of input.sources||input.refs||[]){requireRef(source);put(this.store,policyNS,`revocation:${source.sessionId}:${digest(source)}`,{source,reason:input.reason,epoch});put(this.store,policyNS,source.start===undefined&&source.end===undefined&&!source.hash?entryKey(source):sourceKey(source),state);}
   for(const ref of input.dependencies||[]){if(!input.projectId)throw new CapabilityError('VALIDATION_ERROR','能力撤回需要项目');const key=depKey(ref,input.projectId),old=get<DependencyState>(this.store,policyNS,key);put(this.store,policyNS,key,{...old,...ref,projectId:input.projectId,...state});}
   put(this.store,policyNS,operation,{hash,epoch});return {epoch};
  });
 }
 setPersonalSourceGrants(ownerId:string,sources:SourceRef[],active:boolean):void {this.store.transaction(()=>{for(const source of sources)requireRef(source);put(this.store,policyNS,`personal:${ownerId}`,{sources:structuredClone(sources),active});});}
 canReadPersonalSource(source:SourceRef):boolean {try{this.assertSource(source);}catch{return false;}if(get(this.store,'sessions',`tombstone:${source.sessionId}`))return false;return rows<{sources:SourceRef[];active:boolean}>(this.store,policyNS,'personal:').some(row=>row.value.active&&row.value.sources.some(ref=>digest([ref.sessionId,ref.entryId,ref.start??null,ref.end??null,ref.hash??null])===digest([source.sessionId,source.entryId,source.start??null,source.end??null,source.hash??null]))&&[sessionKey(source.sessionId),entryKey(source),sourceKey(source)].every(key=>this.state(key).valid));}
 registerArtifact(record:RegisteredArtifact):void {
  const key=artifactKey(record.ref);if(!record.projectId||!existsSync(record.path)||createHash('sha256').update(readFileSync(record.path)).digest('hex')!==record.ref.sha256)throw new CapabilityError('SOURCE_UNAVAILABLE','产物内容摘要不匹配');const path=realpathSync(record.path);
  this.store.transaction(()=>{const old=get<RegisteredArtifact>(this.store,'artifacts',key);if(old&&(old.projectId!==record.projectId||old.ref.sha256!==record.ref.sha256||old.text!==record.text||old.path!==path))throw new CapabilityError('VERSION_CONFLICT','产物内容版本不可覆盖');const observations=new Map((old?.observations||[]).map(receipt=>[receipt.receiptId,receipt]));for(const receipt of record.observations){const prior=observations.get(receipt.receiptId);if(prior&&digest(prior)!==digest(receipt))throw new CapabilityError('VERSION_CONFLICT','观察收据身份不可覆盖');observations.set(receipt.receiptId,receipt);}if(!old||old.valid!==record.valid)put(this.store,policyNS,key,{epoch:this.nextEpoch(),valid:record.valid});put(this.store,'artifacts',key,{...record,path,observations:[...observations.values()],owners:[...new Set([...(old?.owners||[]),...(record.owners||[])])]});});
 }

 artifact(ref:ArtifactRef,projectId:string):RegisteredArtifact {const record=get<RegisteredArtifact>(this.store,'artifacts',artifactKey(ref));if(!record?.valid||record.projectId!==projectId||record.ref.sha256!==ref.sha256||!this.state(artifactKey(ref)).valid||record.owners?.length&&record.owners.every(session=>get(this.store,'sessions',`tombstone:${session}`)||!this.state(sessionKey(session)).valid))throw new CapabilityError('SOURCE_UNAVAILABLE','产物版本未登记或已撤回');return record;}
 assertArtifactObservation(ref:ArtifactRef,receiptId:string,observer:NonNullable<EvidenceReceipt['observer']>):void {
  const record=get<RegisteredArtifact>(this.store,'artifacts',artifactKey(ref)),receipt=record?.observations.find(item=>item.receiptId===receiptId),observed=receipt?.artifacts?.find(item=>item.artifactId===ref.artifactId&&item.version===ref.version&&item.sha256===ref.sha256);
  if(!record?.valid||record.ref.sha256!==ref.sha256||!receipt||!['injected-to-context','request-prepared','response-observed','tool-read'].includes(receipt.stage)||digest(receipt.observer)!==digest(observer)||!observed||!receipt.visibleRanges?.length)throw new CapabilityError('SOURCE_UNAVAILABLE','产物观察收据不匹配或没有实际可见范围');
  if(get(this.store,'sessions',`tombstone:${receipt.sessionId}`)||!this.state(sessionKey(receipt.sessionId)).valid)throw new CapabilityError('SOURCE_UNAVAILABLE','观察来源会话已撤回');for(const source of receipt.sources)this.assertSource(source);
  const requested=ref.ranges||[],ranges=observed.ranges||receipt.visibleRanges.map(([start,end])=>({unit:'utf16' as const,value:`${start}:${end}`}));if(!requested.length||requested.some(range=>!ranges.some(visible=>{if(range.unit!==visible.unit)return false;if(range.value===visible.value)return true;if(!['utf16','bytes'].includes(range.unit))return false;const a=/^(\d+):(\d+)$/.exec(range.value),b=/^(\d+):(\d+)$/.exec(visible.value);return !!a&&!!b&&Number(a[1])<=Number(a[2])&&Number(b[1])<=Number(a[1])&&Number(a[2])<=Number(b[2]);})))throw new CapabilityError('SOURCE_UNAVAILABLE','请求范围超出实际观察范围');
 }

 registerCheck(record:RegisteredCheck):void {this.store.transaction(()=>{const key=`check:${digest([record.ref.checkId,record.ref.version])}`,old=get<RegisteredCheck>(this.store,'checks',key);if(old&&digest(old)!==digest(record))throw new CapabilityError('VERSION_CONFLICT','客观检查版本不可覆盖');put(this.store,'checks',key,record);});}
 readCheck(ref:CheckRef,projectId:string):RegisteredCheck {const record=get<RegisteredCheck>(this.store,'checks',`check:${digest([ref.checkId,ref.version])}`);if(!record||record.projectId!==projectId||digest(record.ref)!==digest(ref))throw new CapabilityError('SOURCE_UNAVAILABLE','客观检查没有有效宿主收据');for(const source of record.sources)this.assertSource(source);for(const artifact of ref.artifacts)this.artifact(artifact,projectId);return record;}
 observations(input:{projectId:string;sessionId:string;runId?:string}):{artifact:ArtifactRef;receipt:EvidenceReceipt}[]{const found:{artifact:ArtifactRef;receipt:EvidenceReceipt}[]=[];for(const {value} of rows<RegisteredArtifact>(this.store,'artifacts','artifact:')){if(!value.valid||value.projectId!==input.projectId)continue;for(const receipt of value.observations){if(receipt.sessionId!==input.sessionId||input.runId&&receipt.runId!==input.runId||!receipt.observer||receipt.observer.kind==='parser')continue;for(const artifact of receipt.artifacts||[]){try{this.assertArtifactObservation(artifact,receipt.receiptId,receipt.observer);found.push({artifact:structuredClone(artifact),receipt:structuredClone(receipt)});}catch{/* Unavailable observations do not become new learning evidence. */}}}}return found;}

}

export async function readRegisteredArtifact(store:RecordStore,projectId:string,ref:ArtifactRef,options:{observationReceiptId?:string;cursor?:number;maxChars?:number}={}):Promise<{artifact:ArtifactRef;text:string;fullLength:number;visibleRanges:[number,number][];nextCursor?:number;receipt?:EvidenceReceipt}> {
 const policy=new SourcePolicy(store),record=policy.artifact(ref,projectId),bytes=readFileSync(record.path);if(createHash('sha256').update(bytes).digest('hex')!==ref.sha256)throw new CapabilityError('SOURCE_UNAVAILABLE','产物文件已改变');
 const content=record.text??(/^text\//.test(ref.mediaType)?bytes.toString('utf8'):undefined);if(content===undefined)throw new CapabilityError('CAPABILITY_UNAVAILABLE','该产物没有登记可读取的正文');
 const ranges=ref.ranges?.length?ref.ranges.map(range=>{const match=range.unit==='utf16'?/^(\d+):(\d+)$/.exec(range.value):undefined;if(!match||Number(match[1])>Number(match[2])||Number(match[2])>content.length)throw new CapabilityError('CAPABILITY_UNAVAILABLE','该登记范围不能映射为正文 UTF-16 片段');return [Number(match[1]),Number(match[2])] as [number,number];}).sort((a,b)=>a[0]-b[0]):[[0,content.length] as [number,number]];
 const start=options.cursor??ranges[0][0],limit=options.maxChars??8000,range=ranges.find(([a,b])=>start>=a&&start<b||start===b&&a===b);if(!Number.isSafeInteger(start)||!range||!Number.isSafeInteger(limit)||limit<1||limit>8000)throw new CapabilityError('VALIDATION_ERROR','产物分页范围无效或超出登记片段');const end=Math.min(range[1],start+limit),next=end<range[1]?end:ranges.find(([a])=>a>=end&&a>start)?.[0],receipt=options.observationReceiptId?record.observations.find(item=>item.receiptId===options.observationReceiptId):undefined;

 if(options.observationReceiptId){if(!receipt?.observer)throw new CapabilityError('SOURCE_UNAVAILABLE','产物观察收据不可用');policy.assertArtifactObservation(ref,options.observationReceiptId,receipt.observer);}return {artifact:record.ref,text:content.slice(start,end),fullLength:content.length,visibleRanges:[[start,end]],...(next!==undefined?{nextCursor:next}:{}),receipt};
}

interface LearningHostRecord extends LearningLeaseToken {pid:number;instance:string}
function pidAlive(pid:number){try{process.kill(pid,0);return true;}catch{return false;}}
export function acquireLearningLease(store:RecordStore,ownerRuntime:string,ttlMs=15000):LearningLeaseToken|undefined {
 return store.transaction(()=>{const old=get<LearningHostRecord>(store,'runtime','learning-host');if(old&&old.ownerRuntime!==ownerRuntime&&old.expiresAt>Date.now()&&pidAlive(old.pid))return undefined;if(old&&old.ownerRuntime!==ownerRuntime&&pidAlive(old.pid))return undefined;const epoch=old?.ownerRuntime===ownerRuntime?old.epoch:(get<number>(store,'runtime','learning-host-epoch')||0)+1;put(store,'runtime','learning-host-epoch',epoch);const token={ownerRuntime,epoch,expiresAt:Date.now()+ttlMs};put(store,'runtime','learning-host',{...token,pid:process.pid,instance:ownerRuntime});return token;});
}
export function assertLearningLease(store:RecordStore,token:LearningLeaseToken):void {const old=get<LearningHostRecord>(store,'runtime','learning-host');if(!old||old.ownerRuntime!==token.ownerRuntime||old.epoch!==token.epoch||old.expiresAt<=Date.now()||!pidAlive(old.pid))throw new CapabilityError('VERSION_CONFLICT','后台宿主租约已失效');}
export function renewLearningLease(store:RecordStore,token:LearningLeaseToken,ttlMs=15000):LearningLeaseToken {return store.transaction(()=>{assertLearningLease(store,token);const next={...token,expiresAt:Date.now()+ttlMs};put(store,'runtime','learning-host',{...next,pid:process.pid,instance:token.ownerRuntime});return next;});}
export function releaseLearningLease(store:RecordStore,token:LearningLeaseToken):void {store.transaction(()=>{const old=get<LearningHostRecord>(store,'runtime','learning-host');if(old?.ownerRuntime===token.ownerRuntime&&old.epoch===token.epoch)store.db.prepare("DELETE FROM documents WHERE namespace='runtime' AND key='learning-host'").run();});}

export interface LearningBudgetRecord {budgetId:string;projectId:string;sourceRunId:string;maxCalls:number;tokenLimit?:number;calls:number;tokens:number;usageUnknown:boolean}
export class LearningBudget {
 constructor(readonly store:RecordStore){}
 create(input:{budgetId?:string;projectId:string;sourceRunId:string;maxCalls:number;tokenLimit?:number}):LearningBudgetRecord {if(!input.projectId||!input.sourceRunId||!Number.isSafeInteger(input.maxCalls)||input.maxCalls<1||input.tokenLimit!==undefined&&(!Number.isSafeInteger(input.tokenLimit)||input.tokenLimit<1))throw new CapabilityError('VALIDATION_ERROR','后台预算无效');return this.store.transaction(()=>{const budgetId=input.budgetId||randomUUID(),key=`learning-budget:${budgetId}`,old=get<LearningBudgetRecord>(this.store,'runtime',key);if(old){if(old.projectId!==input.projectId||old.sourceRunId!==input.sourceRunId||old.maxCalls!==input.maxCalls||old.tokenLimit!==input.tokenLimit)throw new CapabilityError('VERSION_CONFLICT','预算身份已经用于不同配置');return old;}const result={...input,budgetId,calls:0,tokens:0,usageUnknown:false};put(this.store,'runtime',key,result);return result;});}
 read(budgetId:string):LearningBudgetRecord {const record=get<LearningBudgetRecord>(this.store,'runtime',`learning-budget:${budgetId}`);if(!record)throw new CapabilityError('BUDGET_EXHAUSTED','未登记独立后台预算');return record;}
 readCall(budgetId:string,operationId:string):{callId:string;state:'dispatched'|'complete'|'failed'|'unknown';result?:string;tokens?:number;stage?:string;requestHash?:string;response?:JsonObject}|undefined {return get(this.store,'runtime',`learning-call:${budgetId}:${operationId}`);}
 begin(input:{budgetId:string;operationId:string;callId?:string;stage?:string;promptHash:string;requestHash?:string}):{callId:string;result?:string} {return this.store.transaction(()=>{
  if(input.requestHash!==undefined&&(typeof input.requestHash!=='string'||!/^[a-f0-9]{64}$/.test(input.requestHash)))throw new CapabilityError('VALIDATION_ERROR','后台请求身份摘要无效');
  const key=`learning-call:${input.budgetId}:${input.operationId}`,old=get<{hash:string;requestHash?:string;callId:string;state:string;result?:string;response?:JsonObject}>(this.store,'runtime',key),hash=input.requestHash===undefined?digest({stage:input.stage,promptHash:input.promptHash}):digest({v:2,stage:input.stage,promptHash:input.promptHash,requestHash:input.requestHash});
  if(old){
   if(old.requestHash===undefined&&['dispatched','unknown'].includes(old.state))throw new CapabilityError('OPERATION_UNKNOWN','旧后台调用缺少完整请求身份且结果未确认，禁止自动重放',{callId:old.callId});
   if(old.requestHash!==input.requestHash||old.hash!==hash)throw new CapabilityError('VERSION_CONFLICT','调用幂等键与实际模型配置或请求参数不匹配');
   if(old.state==='complete')return {callId:old.callId,result:old.result};
   if(old.state==='failed'&&old.response?.stopReason==='length')throw new CapabilityError('VALIDATION_ERROR','模型响应已接收但达到输出上限，原调用不重放',{callId:old.callId,response:old.response});
   throw new CapabilityError('OPERATION_UNKNOWN','原后台调用尚未确认，禁止自动重放',{callId:old.callId});
  }
  const budget=this.read(input.budgetId);if(budget.calls>=budget.maxCalls||budget.tokenLimit!==undefined&&(budget.usageUnknown||budget.tokens>=budget.tokenLimit))throw new CapabilityError('BUDGET_EXHAUSTED','后台预算已耗尽或真实用量未知');const callId=input.callId||randomUUID();put(this.store,'runtime',key,{...input,callId,hash,state:'dispatched'});put(this.store,'runtime',`learning-budget:${input.budgetId}`,{...budget,calls:budget.calls+1});return {callId};
 });}

 finish(input:{budgetId:string;operationId:string;callId:string;result?:string;tokens?:number;state:'complete'|'failed'|'unknown';response?:JsonObject}):void {this.store.transaction(()=>{
  const key=`learning-call:${input.budgetId}:${input.operationId}`,old=get<JsonObject>(this.store,'runtime',key);if(!old||old.callId!==input.callId)throw new CapabilityError('VERSION_CONFLICT','后台调用身份已变化');
  const known=(tokens:unknown):tokens is number=>typeof tokens==='number'&&Number.isSafeInteger(tokens)&&tokens>=0;
  if(input.tokens!==undefined&&!known(input.tokens))throw new CapabilityError('VALIDATION_ERROR','后台实际用量无效');
  if((old.state==='complete'||old.state==='failed')&&old.state!==input.state||old.response!==undefined&&input.response!==undefined&&digest(old.response)!==digest(input.response)||old.result!==undefined&&input.result!==undefined&&old.result!==input.result||known(old.tokens)&&known(input.tokens)&&old.tokens!==input.tokens)throw new CapabilityError('VERSION_CONFLICT','已确认调用结果或用量不可覆盖');
  const tokens=known(input.tokens)?input.tokens:known(old.tokens)?old.tokens:undefined,budget=this.read(input.budgetId);put(this.store,'runtime',key,{...old,...input,result:input.result??old.result,tokens});
  const usageUnknown=rows<{state:string;tokens?:number}>(this.store,'runtime',`learning-call:${input.budgetId}:`).some(row=>row.value.state==='dispatched'||row.value.state==='unknown'||!known(row.value.tokens));
  put(this.store,'runtime',`learning-budget:${input.budgetId}`,{...budget,tokens:budget.tokens+(tokens??0)-(known(old.tokens)?old.tokens:0),usageUnknown});
 });}

}

export function restrictedSourceItem(item:HistoryItem,source:SourceRef):HistoryItem {const value=readSourceSpan(item,source),start=source.start??0,end=source.end??item.text.length,masked=' '.repeat(start)+value+' '.repeat(item.text.length-end);return {...item,text:masked,userText:item.userText!==undefined&&end<=item.userText.length?masked.slice(0,item.userText.length):undefined};}

/** Older packaged cores lack this connection function and therefore cannot mutate upgraded state. */
export function requireSchemaWriter(store:RecordStore,namespace:'memory'|'expert'|'swarm',version=3,tables:string[]=[]):void {
 if(!Number.isSafeInteger(version)||version<1||version>3||tables.some(table=>!/^[a-z][a-z0-9_]*$/.test(table)))throw new CapabilityError('VALIDATION_ERROR','数据写入版本围栏无效');
 store.transaction(()=>{for(const action of ['INSERT','UPDATE','DELETE']){const row=action==='DELETE'?'OLD':'NEW',name=`friend_${namespace}_writer_${action.toLowerCase()}`;store.db.exec(`CREATE TRIGGER IF NOT EXISTS ${name} BEFORE ${action} ON documents WHEN ${row}.namespace='${namespace}' BEGIN SELECT CASE WHEN friend_pi_writer_version()<${version} THEN RAISE(ABORT,'Friend data requires a newer writer') END; END;`);}for(const table of tables){if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))continue;for(const action of ['INSERT','UPDATE','DELETE'])store.db.exec(`CREATE TRIGGER IF NOT EXISTS friend_${table}_writer_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT CASE WHEN friend_pi_writer_version()<${version} THEN RAISE(ABORT,'Friend data requires a newer writer') END; END;`);}put(store,'schema-policy',namespace,{minWriter:version,at:new Date().toISOString()});});
}
