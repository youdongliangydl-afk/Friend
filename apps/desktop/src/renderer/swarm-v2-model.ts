import {asList,asObject,errorText,type JsonObject} from './types.js';

/**
 * Swarm coordination v2 workbench projection.
 *
 * The renderer never owns v2 state: every field below comes from the controller
 * (`plugin.call` → swarm `v2.*` actions). Missing or malformed fields are shown as
 * "未知/未记录" instead of being inferred, and a gate that was not returned is
 * never reported as passed.
 */
export type SwarmV2Load = (action: string, input?: JsonObject) => Promise<unknown>;
const text=(value:unknown)=>typeof value==='string'?value:'';
const safeInt=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)?value:undefined;
const strings=(value:unknown)=>asList<unknown>(value).filter((item):item is string=>typeof item==='string'&&item.length>0);
const uniq=<T,>(values:T[])=>[...new Set(values)];

/* ------------------------------------------------------------------------- */
/* Task board: 8 live states + tombstones                                    */
/* ------------------------------------------------------------------------- */

export const SWARM_V2_BOARD_STATES=['ready','claimed','in_progress','delivered','verified','done','blocked','returned'] as const;
export type SwarmV2BoardState=typeof SWARM_V2_BOARD_STATES[number];
const TASK_STATE_META:Record<string,{label:string;tone:string}>={
 ready:{label:'待领取',tone:'badge'},claimed:{label:'已领取',tone:'badge-running'},in_progress:{label:'执行中',tone:'badge-running'},
 delivered:{label:'已交付，待验证',tone:'badge-validating'},verified:{label:'已验证，待整合',tone:'badge-completed'},done:{label:'已完成',tone:'badge-integrated'},
 blocked:{label:'阻塞',tone:'badge-blocked'},returned:{label:'已退回',tone:'badge-failed'},
 cancelled:{label:'已取消（墓碑）',tone:'badge-inactive'},deleted:{label:'已删除（墓碑）',tone:'badge-inactive'},
};
export interface SwarmV2TaskStateView {state:string;label:string;tone:string;column:SwarmV2BoardState|null;tombstone:boolean;known:boolean}
export function swarmV2TaskState(status:unknown):SwarmV2TaskStateView {
 const state=text(status),meta=TASK_STATE_META[state];
 if(!meta)return {state:'unknown',label:'状态未识别',tone:'badge-unknown',column:null,tombstone:false,known:false};
 const column=SWARM_V2_BOARD_STATES.includes(state as SwarmV2BoardState);
 return {state,label:meta.label,tone:meta.tone,column:column?state as SwarmV2BoardState:null,tombstone:state==='cancelled'||state==='deleted',known:true};
}

/** Blocked kinds come from SwarmV2BlockedReason; an unregistered kind is not translated away. */
export const SWARM_V2_BLOCKED_KINDS:Record<string,string>={dependency:'依赖未满足',budget:'预算不足',resource:'资源占用',policy:'权限或策略',human:'需要人工',unknown:'受阻'};
function blockedText(value:unknown):string {
 const reason=asObject(value),kind=text(reason.kind),cause=text(reason.cause),by=text(reason.by);
 if(!kind&&!cause)return '';
 return `${SWARM_V2_BLOCKED_KINDS[kind]||'受阻原因未登记'}${cause?`：${cause}`:''}${by?`（${by}）`:''}`;
}

export interface SwarmV2TaskCard {
 taskId:string;title:string;state:string;label:string;tone:string;mode:string;modeLabel:string;risk:string;
 dependencies:string[];writeScopes:string[];ownerMemberId:string;ownerName:string;blockedReason:string;
 reworkCount:number|undefined;resultRevision:number|undefined;currentAttemptId:string;acceptanceCount:number;tombstone:boolean;
}
export interface SwarmV2Board {
 columns:{state:SwarmV2BoardState;label:string;tasks:SwarmV2TaskCard[]}[];
 tombstones:SwarmV2TaskCard[];unknown:SwarmV2TaskCard[];counts:Record<string,number>;total:number;warnings:string[];
}
export function swarmV2Board(snapshot:unknown):SwarmV2Board {
 const root=asObject(snapshot),members=asList<JsonObject>(root.members);
 const nameOf=(memberId:string)=>text(members.find(member=>text(member.memberId)===memberId)?.name);
 const columns=SWARM_V2_BOARD_STATES.map(state=>({state,label:TASK_STATE_META[state].label,tasks:[] as SwarmV2TaskCard[]}));
 const tombstones:SwarmV2TaskCard[]=[],unknown:SwarmV2TaskCard[]=[],counts:Record<string,number>={},warnings:string[]=[],seen=new Set<string>();
 for(const raw of asList<unknown>(root.tasks)){
  const task=asObject(raw),taskId=text(task.taskId);
  if(!taskId){warnings.push('存在缺少标识的任务记录，未猜测其归属');continue;}
  if(seen.has(taskId)){warnings.push(`任务 ${taskId} 重复出现，只显示第一条记录`);continue;}
  seen.add(taskId);
  const state=swarmV2TaskState(task.status),ownerMemberId=text(task.ownerMemberId),mode=text(task.mode);
  const card:SwarmV2TaskCard={
   taskId,title:text(task.title)||taskId,state:state.state,label:state.label,tone:state.tone,mode,modeLabel:mode==='write'?'写入':mode==='read'?'只读':'模式未记录',
   risk:text(task.risk),dependencies:uniq(strings(task.dependencies)),writeScopes:uniq(strings(task.writeScopes)),ownerMemberId,ownerName:nameOf(ownerMemberId),
   blockedReason:blockedText(task.blockedReason),reworkCount:safeInt(task.reworkCount),resultRevision:safeInt(task.resultRevision),
   currentAttemptId:text(task.currentAttemptId),acceptanceCount:strings(task.acceptance).length,tombstone:state.tombstone||task.tombstone===true,
  };
  counts[state.state]=(counts[state.state]||0)+1;
  if(card.tombstone)tombstones.push(card);
  else if(!state.known)unknown.push(card);
  else columns.find(column=>column.state===state.column)!.tasks.push(card);
 }
 return {columns,tombstones,unknown,counts,total:seen.size,warnings};
}

/* ------------------------------------------------------------------------- */
/* Team summary                                                              */
/* ------------------------------------------------------------------------- */

export const SWARM_V2_TEAM_LABELS:Record<string,string>={created:'待启动',running:'运行中',paused:'已暂停',stopping:'正在停止',stopped:'已停止',completed:'已完成'};
export interface SwarmV2TeamView {
 teamId:string;projectId:string;rootSessionId:string;workspaceRoot:string;status:string;statusLabel:string;known:boolean;
 autonomyLevel:number|undefined;reworkRound:number|undefined;revision:number|undefined;failureCount:number|undefined;createdAt:string;updatedAt:string;
}
export function swarmV2TeamView(value:unknown):SwarmV2TeamView {
 const team=asObject(value),status=text(team.status);
 return {teamId:text(team.teamId),projectId:text(team.projectId),rootSessionId:text(team.rootSessionId),workspaceRoot:text(team.workspaceRoot),status,statusLabel:SWARM_V2_TEAM_LABELS[status]||'状态未识别',known:Object.keys(team).length>0,autonomyLevel:safeInt(team.autonomyLevel),reworkRound:safeInt(team.reworkRound),revision:safeInt(team.revision),failureCount:Array.isArray(team.failureFingerprints)?team.failureFingerprints.length:undefined,createdAt:text(team.createdAt),updatedAt:text(team.updatedAt)};
}

/* ------------------------------------------------------------------------- */
/* Three-layer budget: team / task / member                                  */
/* ------------------------------------------------------------------------- */

export const SWARM_V2_BUDGET_SCOPES=['team','task','member'] as const;
const SCOPE_LABELS:Record<string,string>={team:'团队',task:'任务',member:'成员'};
export interface SwarmV2BudgetBar {id:'token'|'cost'|'time';label:string;usedText:string;limitText:string;percent:number|null;over:boolean}
export interface SwarmV2BudgetRow {
 budgetId:string;scope:string;scopeLabel:string;scopeId:string;scopeName:string;paused:boolean;unknown:boolean;
 bars:SwarmV2BudgetBar[];concurrencyLimit:number|null;notes:string[];
}

/** `null` means "no limit set" (a real value); a malformed value is unknown, never zero. */
function limitOf(value:unknown):{value:number|null;known:boolean} {
 if(value===null||value===undefined)return {value:null,known:true};
 return typeof value==='number'&&Number.isSafeInteger(value)&&value>0?{value,known:true}:{value:null,known:false};
}
export function swarmV2Duration(ms:number):string {
 if(ms<1000)return `${ms} 毫秒`;
 const seconds=ms/1000;
 if(seconds<60)return `${Math.round(seconds*10)/10} 秒`;
 const minutes=Math.floor(seconds/60),rest=Math.round(seconds-minutes*60);
 return rest?`${minutes} 分 ${rest} 秒`:`${minutes} 分`;
}
function bar(id:SwarmV2BudgetBar['id'],label:string,used:number|undefined,limit:{value:number|null;known:boolean},format:(value:number)=>string):SwarmV2BudgetBar {
 const percent=used!==undefined&&limit.value!==null&&limit.value>0?Math.min(100,Math.round(used/limit.value*1000)/10):null;
 return {id,label,usedText:used===undefined?'已用 未知':`已用 ${format(used)}`,limitText:!limit.known?'上限未记录':limit.value===null?'未设上限':`上限 ${format(limit.value)}`,percent,over:used!==undefined&&limit.value!==null&&used>limit.value};
}
function budgetRow(value:unknown,nameOf:(scope:string,scopeId:string)=>string):SwarmV2BudgetRow {
 const budget=asObject(value),scope=text(budget.scope),scopeId=text(budget.scopeId),unknown=budget.unknown===true,paused=budget.paused===true,notes:string[]=[];
 if(unknown)notes.push('含未知用量：这条预算的统计不完整');
 if(paused)notes.push('已暂停新调用');
 return {
  budgetId:text(budget.budgetId),scope,scopeLabel:SCOPE_LABELS[scope]||'范围未识别',scopeId,scopeName:nameOf(scope,scopeId),paused,unknown,
  bars:[bar('token','令牌',safeInt(budget.tokenUsed),limitOf(budget.tokenLimit),value=>`${value} tok`),bar('cost','成本（微单位）',safeInt(budget.costUsed),limitOf(budget.costLimitMicros),value=>`${value} µ`),bar('time','耗时',safeInt(budget.timeUsedMs),limitOf(budget.timeLimitMs),swarmV2Duration)],
  concurrencyLimit:limitOf(budget.concurrencyLimit).value,notes,
 };
}
export interface SwarmV2Budgets {
 rows:SwarmV2BudgetRow[];layers:{scope:string;label:string;rows:SwarmV2BudgetRow[]}[];recorded:boolean;unknownCount:number;unscoped:number;
}
export function swarmV2Budgets(snapshot:unknown):SwarmV2Budgets {
 const root=asObject(snapshot),tasks=asList<JsonObject>(root.tasks),members=asList<JsonObject>(root.members),budgets=asList<unknown>(root.budgets);
 const nameOf=(scope:string,scopeId:string)=>scope==='task'?(text(tasks.find(task=>text(task.taskId)===scopeId)?.title)||scopeId||'任务未记录'):scope==='member'?(text(members.find(member=>text(member.memberId)===scopeId)?.name)||scopeId||'成员未记录'):(scopeId||'团队');
 const rank=(scope:string)=>{const index=SWARM_V2_BUDGET_SCOPES.indexOf(scope as never);return index<0?SWARM_V2_BUDGET_SCOPES.length:index;};
 const rows=budgets.map(value=>budgetRow(value,nameOf)).sort((left,right)=>rank(left.scope)-rank(right.scope)||left.scopeId.localeCompare(right.scopeId));
 return {rows,layers:SWARM_V2_BUDGET_SCOPES.map(scope=>({scope,label:SCOPE_LABELS[scope],rows:rows.filter(row=>row.scope===scope)})),recorded:budgets.length>0,unknownCount:rows.filter(row=>row.unknown).length,unscoped:rows.filter(row=>rank(row.scope)===SWARM_V2_BUDGET_SCOPES.length).length};
}

/* ------------------------------------------------------------------------- */
/* Merge gates G01–G20                                                       */
/* ------------------------------------------------------------------------- */

export const MERGE_GATE_CODES=['G01','G02','G03','G04','G05','G06','G07','G08','G09','G10','G11','G12','G13','G14','G15','G16','G17','G18','G19','G20'] as const;
export const MERGE_GATE_LABELS:Record<string,string>={
 G01:'任务已通过验证且是写任务',G02:'依赖任务已完成',G03:'没有运行中的尝试',G04:'没有未知副作用的尝试',
 G05:'依赖的写入已合并',G06:'候选工作树/分支可读',G07:'只读任务不参与合并',G08:'候选基线与目标当前一致',
 G09:'存在已应用的验证',G10:'裁决已通过',G11:'裁决未过期',G12:'裁决候选与结果版本匹配',
 G13:'变更路径都在写范围内',G14:'目标工作区干净',G15:'没有并发写者',G16:'团队与任务预算未耗尽',
 G17:'V2/V3 已记录人工批准',G18:'未触碰受保护路径',G19:'检查与裁决证据链完整',G20:'没有未知的应用回执',
};
export interface SwarmV2GateRow {code:string;label:string;passed:boolean|null;detail:string;reason:string}
export interface SwarmV2GateView {
 read:boolean;allowed:boolean;claimedAllowed:boolean;gates:SwarmV2GateRow[];failed:SwarmV2GateRow[];
 missing:string[];unexpected:SwarmV2GateRow[];candidateDigest:string;verdictId:string;note:string;
}
function gateRow(code:string,label:string|undefined,gate:JsonObject|undefined):SwarmV2GateRow {
 const passed=typeof gate?.passed==='boolean'?gate.passed:null,detail=text(gate?.detail);
 return {code,label:label||'未登记门禁',passed,detail,reason:passed===null?'门禁未返回，不能判定通过':detail||(passed?'通过，控制器未记录细节':'未通过，控制器未记录原因')};
}
/** A controller `allowed:true` claim never overrides missing gate rows. */
export function mergeGateView(decision:unknown):SwarmV2GateView {
 const value=asObject(decision),provided=asList<unknown>(value.gates).map(asObject).filter(gate=>!!text(gate.code));
 const read=provided.length>0,byCode=new Map(provided.map(gate=>[text(gate.code),gate]));
 const gates=MERGE_GATE_CODES.map(code=>gateRow(code,MERGE_GATE_LABELS[code],byCode.get(code)));
 const unexpected=provided.filter(gate=>!MERGE_GATE_CODES.includes(text(gate.code) as never)).map(gate=>gateRow(text(gate.code),'未登记门禁',gate));
 const missing=gates.filter(row=>row.passed===null).map(row=>row.code),failed=gates.filter(row=>row.passed===false);
 const allowed=read&&!missing.length&&!failed.length&&!unexpected.length,claimedAllowed=value.allowed===true,notes:string[]=[];
 if(!read)notes.push('尚未读取门禁：需要任务与候选摘要后调用 v2.gates。');
 else if(missing.length)notes.push(`门禁明细不完整：${missing.join('、')} 未返回，不据此宣称通过。`);
 else if(unexpected.length)notes.push('存在未登记的门禁代码，未把它当作通过。');
 else if(failed.length)notes.push('存在未通过门禁，整合会被拒绝。');
 else notes.push('G01–G20 全部通过。');
 if(claimedAllowed&&!allowed)notes.push('控制器声称允许，但门禁明细不支持这个结论。');
 return {read,allowed,claimedAllowed,gates,failed,missing,unexpected,candidateDigest:text(value.candidateDigest),verdictId:text(value.verdictId),note:notes.join('')};
}

/* ------------------------------------------------------------------------- */
/* Attempts, messages and journal                                            */
/* ------------------------------------------------------------------------- */

export const SWARM_V2_ATTEMPT_LABELS:Record<string,string>={prepared:'已准备',running:'执行中',unknown:'结果未知',completed:'已结束',failed:'失败'};
export interface SwarmV2AttemptRow {attemptId:string;taskId:string;taskTitle:string;memberId:string;memberName:string;status:string;label:string;number:number|undefined;startedAt:string;unknown:boolean}
export function swarmV2Attempts(snapshot:unknown):{rows:SwarmV2AttemptRow[];note:string} {
 const root=asObject(snapshot),tasks=asList<JsonObject>(root.tasks),members=asList<JsonObject>(root.members);
 const rows=asList<unknown>(root.runningAttempts).map(value=>{
  const attempt=asObject(value),status=text(attempt.status),taskId=text(attempt.taskId),memberId=text(attempt.memberId);
  return {attemptId:text(attempt.attemptId),taskId,taskTitle:text(tasks.find(task=>text(task.taskId)===taskId)?.title)||taskId,memberId,memberName:text(members.find(member=>text(member.memberId)===memberId)?.name),status,label:SWARM_V2_ATTEMPT_LABELS[status]||'状态未识别',number:safeInt(attempt.number),startedAt:text(attempt.startedAt),unknown:status==='unknown'};
 });
 return {rows,note:rows.length?'快照只包含正在运行的尝试；已结束尝试的成果在任务记录中查看，不在这里推断。':'快照未包含运行中的尝试。'};
}

export const SWARM_V2_MESSAGE_LABELS:Record<string,string>={accepted:'已保存',queued:'已排队',delivered:'已投递',incorporated:'已纳入上下文',expired:'已过期'};
export function swarmV2Messages(snapshot:unknown):{recorded:boolean;rows:{state:string;label:string;count:number|undefined}[];note:string} {
 const messages=asObject(asObject(asObject(snapshot).summary).messages),recorded=Object.keys(messages).length>0;
 return {recorded,rows:Object.entries(SWARM_V2_MESSAGE_LABELS).map(([state,label])=>({state,label,count:recorded?safeInt(messages[state]):undefined})),note:'投递状态只是记录：已纳入上下文不等于模型已理解或采纳。'};
}

export function swarmV2Events(snapshot:unknown,limit=8):{rows:{type:string;actor:string;at:string}[];total:number} {
 const events=asList<JsonObject>(asObject(snapshot).journal).map(event=>{
  const actor=asObject(event.actor);
  return {type:text(event.type)||'事件类型未记录',actor:[text(actor.kind),text(actor.id)].filter(Boolean).join('：'),at:text(event.at)};
 });
 return {rows:events.slice(-limit).reverse(),total:events.length};
}

export interface SwarmV2Summary {schemaVersion:number|undefined;silentMerge:number|undefined;baselineDigest:string;rows:{label:string;value:number|undefined}[]}
export function swarmV2Summary(snapshot:unknown):SwarmV2Summary {
 const summary=asObject(asObject(snapshot).summary);
 const countOf=(value:unknown):number|undefined=>{
  if(typeof value==='number'&&Number.isSafeInteger(value))return value;
  const entries=Object.values(asObject(value));
  return entries.length&&entries.every(item=>typeof item==='number'&&Number.isSafeInteger(item))?entries.reduce<number>((sum,item)=>sum+Number(item),0):undefined;
 };
 return {schemaVersion:safeInt(summary.schemaVersion),silentMerge:safeInt(summary.silentMerge),baselineDigest:text(summary.baselineDigest),rows:[
  {label:'团队',value:countOf(summary.teams)},{label:'成员',value:countOf(summary.members)},{label:'任务',value:countOf(summary.tasks)},
  {label:'预算',value:countOf(summary.budgets)},{label:'验证',value:countOf(summary.verifications)},{label:'裁决',value:countOf(summary.verdicts)},
  {label:'日志事件',value:countOf(summary.journalEvents)},
 ]};
}

/* ------------------------------------------------------------------------- */
/* Verdicts: sealed reviewer/verifier submissions                            */
/* ------------------------------------------------------------------------- */

export const SWARM_V2_VERDICT_KINDS=['reviewer','verifier'] as const;
export const SWARM_V2_VERDICT_BINDINGS=['exact-tip','clean-rebase-waived'] as const;
const VERDICT_KIND_LABELS:Record<string,string>={reviewer:'独立复核',verifier:'目标核验'};
const BINDING_LABELS:Record<string,string>={'exact-tip':'精确 tip','clean-rebase-waived':'干净变基豁免','stale-tip':'已过期的 tip'};
export interface SwarmV2VerdictDraft {
 verificationId:string;reviewerMemberId:string;kind:string;binding:string;approved:boolean;
 findings:string;taskIds:string;resultVersions:string;candidateDigest:string;reviewedTip:string;
}
export function swarmV2VerdictDraft(patch:Partial<SwarmV2VerdictDraft>={}):SwarmV2VerdictDraft {
 return {verificationId:'',reviewerMemberId:'',kind:'reviewer',binding:'exact-tip',approved:true,findings:'',taskIds:'',resultVersions:'',candidateDigest:'',reviewedTip:'',...patch};
}
export function swarmV2VerdictLines(value:string):string[] {return uniq(value.split(/[\n,，、;；]/u).map(item=>item.trim()).filter(Boolean));}
export function swarmV2ResultVersions(value:string):{versions:Record<string,number>;invalid:string[]} {
 const versions:Record<string,number>={},invalid:string[]=[];
 for(const line of swarmV2VerdictLines(value)){
  const match=/^([^:：]+)[:：]\s*(\d+)$/u.exec(line);
  if(!match){invalid.push(line);continue;}
  versions[match[1].trim()]=Number(match[2]);
 }
 return {versions,invalid};
}
export interface SwarmV2VerdictForm {missing:string[];ready:boolean;findings:string[];taskIds:string[];resultVersions:Record<string,number>;invalidVersions:string[];input:JsonObject}
/** Mirrors controller validation so the button never promises a submission that must fail. */
export function swarmV2VerdictForm(draft:SwarmV2VerdictDraft):SwarmV2VerdictForm {
 const findings=swarmV2VerdictLines(draft.findings),taskIds=swarmV2VerdictLines(draft.taskIds),parsed=swarmV2ResultVersions(draft.resultVersions),missing:string[]=[];
 if(!draft.verificationId.trim())missing.push('需要验证标识（verificationId）');
 if(!draft.reviewerMemberId.trim())missing.push('需要复核成员标识（reviewerMemberId）');
 if(!draft.candidateDigest.trim())missing.push('需要候选摘要（candidateDigest）');
 if(!draft.reviewedTip.trim())missing.push('需要复核 tip（reviewedTip）');
 if(!SWARM_V2_VERDICT_KINDS.includes(draft.kind as never))missing.push('复核类型只能是 reviewer 或 verifier');
 if(!SWARM_V2_VERDICT_BINDINGS.includes(draft.binding as never))missing.push('绑定方式只能是 exact-tip 或 clean-rebase-waived');
 if(!taskIds.length)missing.push('需要归因任务（taskIds），且必须包含被裁决任务');
 if(!Object.keys(parsed.versions).length)missing.push('需要结果版本（任务ID:版本），且必须包含被裁决任务');
 for(const line of parsed.invalid)missing.push(`结果版本格式应为 任务ID:版本：${line}`);
 if(draft.approved!==true&&!findings.length)missing.push('未通过的裁决需要写明问题，供定向返工');
 return {missing,ready:missing.length===0,findings,taskIds,resultVersions:parsed.versions,invalidVersions:parsed.invalid,input:{verificationId:draft.verificationId.trim(),kind:draft.kind,reviewerMemberId:draft.reviewerMemberId.trim(),approved:draft.approved===true,findings,taskIds,resultVersions:parsed.versions,candidateDigest:draft.candidateDigest.trim(),reviewedTip:draft.reviewedTip.trim(),binding:draft.binding}};
}
export interface SwarmV2VerdictView {
 read:boolean;verdictId:string;verificationId:string;kind:string;kindLabel:string;approved:boolean;sealed:boolean;
 findings:string[];taskIds:string[];binding:string;bindingLabel:string;candidateDigest:string;reviewedTip:string;
 reviewerMemberId:string;createdAt:string;resultVersions:{taskId:string;revision:number}[];
}
export function swarmV2VerdictView(value:unknown):SwarmV2VerdictView {
 const verdict=asObject(value),versions=asObject(verdict.resultVersions),kind=text(verdict.kind),binding=text(verdict.binding);
 return {read:!!text(verdict.verdictId),verdictId:text(verdict.verdictId),verificationId:text(verdict.verificationId),kind,kindLabel:VERDICT_KIND_LABELS[kind]||'类型未识别',approved:verdict.approved===true,sealed:verdict.sealed===true,findings:strings(verdict.findings),taskIds:strings(verdict.taskIds),binding,bindingLabel:BINDING_LABELS[binding]||'绑定方式未识别',candidateDigest:text(verdict.candidateDigest),reviewedTip:text(verdict.reviewedTip),reviewerMemberId:text(verdict.reviewerMemberId),createdAt:text(verdict.createdAt),resultVersions:Object.entries(versions).flatMap(([taskId,revision])=>typeof revision==='number'?[{taskId,revision}]:[])};
}

/* ------------------------------------------------------------------------- */
/* Snapshot composition                                                      */
/* ------------------------------------------------------------------------- */

export interface SwarmV2View {
 recorded:boolean;empty:boolean;reason:string;warnings:string[];
 team:SwarmV2TeamView;board:SwarmV2Board;budgets:SwarmV2Budgets;
 attempts:ReturnType<typeof swarmV2Attempts>;messages:ReturnType<typeof swarmV2Messages>;
 summary:SwarmV2Summary;events:ReturnType<typeof swarmV2Events>;
}
export function swarmV2View(snapshot:unknown):SwarmV2View {
 const root=asObject(snapshot),recorded=Object.keys(root).length>0,warnings:string[]=[];
 const team=swarmV2TeamView(root.team);
 if(recorded&&root.v!==undefined&&root.v!==2)warnings.push(`快照版本为 ${String(root.v)}，与 v2 工作台不一致`);
 if(recorded&&!team.known)warnings.push('快照未包含团队记录');
 if(safeInt(root.silentMerge)!==undefined&&Number(root.silentMerge)>0)warnings.push('静默合并计数不为 0，整合前需要核对');
 const board=swarmV2Board(root);
 return {recorded,empty:!recorded||!team.known,reason:!recorded?'尚未读取到 Swarm v2 快照':!team.known?'快照未包含团队记录，无法显示任务板与预算':'',warnings:[...warnings,...board.warnings],team,board,budgets:swarmV2Budgets(root),attempts:swarmV2Attempts(root),messages:swarmV2Messages(root),summary:swarmV2Summary(root),events:swarmV2Events(root)};
}

/* ------------------------------------------------------------------------- */
/* Injectable readers                                                        */
/* ------------------------------------------------------------------------- */

/** Team ids are controller-owned; this scheme only names a team the GUI itself creates. */
export function swarmV2TeamId(sessionId:string):string {return `team:ui:${sessionId}`;}
export async function readSwarmV2(load:SwarmV2Load,teamId?:string):Promise<{snapshot:JsonObject;error:string}> {
 try{return {snapshot:asObject(await load('v2.snapshot',teamId?{teamId}:{})),error:''};}
 catch(error){return {snapshot:{},error:errorText(error)};}
}
export async function readSwarmV2Gates(load:SwarmV2Load,input:{taskId:string;candidateDigest:string;verdictId?:string}):Promise<{decision:JsonObject;view:SwarmV2GateView;error:string}> {
 const payload:JsonObject={taskId:input.taskId,candidateDigest:input.candidateDigest};
 if(input.verdictId)payload.verdictId=input.verdictId;
 try{
  const decision=asObject(await load('v2.gates',payload));
  return {decision,view:mergeGateView(decision),error:''};
 }catch(error){return {decision:{},view:mergeGateView({}),error:errorText(error)};}
}
/** `v2.team.create` is not idempotent; an existing id is reported instead of silently reused. */
export async function createSwarmV2Team(load:SwarmV2Load,teamId:string):Promise<{teamId:string;existing:boolean;error:string}> {
 if(!teamId)return {teamId,existing:false,error:'团队标识为空'};
 try{
  await load('v2.team.create',{teamId});
  return {teamId,existing:false,error:''};
 }catch(error){
  const message=errorText(error),existing=/已存在/u.test(message);
  return {teamId,existing,error:existing?'':message};
 }
}
export async function submitSwarmV2Verdict(load:SwarmV2Load,draft:SwarmV2VerdictDraft,operationId:string):Promise<{verdict:SwarmV2VerdictView;error:string;missing:string[]}> {
 const form=swarmV2VerdictForm(draft);
 if(!form.ready)return {verdict:swarmV2VerdictView({}),error:form.missing[0],missing:form.missing};
 try{return {verdict:swarmV2VerdictView(await load('v2.verify.submit',{...form.input,operationId})),error:'',missing:[]};}
 catch(error){return {verdict:swarmV2VerdictView({}),error:errorText(error),missing:[]};}
}
