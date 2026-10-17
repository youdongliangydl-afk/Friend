export interface ComposerGoal {
 id:string; objective:string; revision:number;
 status:'active'|'paused'|'blocked'|'usage_limited'|'complete';
 timeUsedSeconds?:number; activeSince?:string|number|null; updatedAt?:string|number;
 progress?:string; nextAction?:string;
}
export interface GoalSubmission {objective:string;replace?:boolean;expectedGoalId?:string;expectedRevision?:number}
export const goalStatusLabels:Record<ComposerGoal['status'],string>={active:'进行中',paused:'已暂停',blocked:'遇到阻塞',usage_limited:'用量受限',complete:'已完成'};
export const unfinishedGoal=(goal?:ComposerGoal|null):goal is ComposerGoal=>!!goal&&goal.status!=='complete';
export function goalElapsed(goal:ComposerGoal,now=Date.now()):number {
 const since=typeof goal.activeSince==='number'?goal.activeSince:goal.activeSince?Date.parse(goal.activeSince):NaN;
 return Math.max(0,Math.floor((goal.timeUsedSeconds||0)+(goal.status==='active'&&Number.isFinite(since)?Math.max(0,now-since)/1000:0)));
}
export function formatGoalElapsed(seconds:number):string {const n=Math.max(0,Math.floor(seconds));return n>=3600?`${Math.floor(n/3600)}:${String(Math.floor(n/60)%60).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`:`${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`;}
export const goalBinding=(goal:ComposerGoal)=>({goalId:goal.id,expectedRevision:goal.revision});
export function goalDraftInput(text:string):{text:string;goalDraft:boolean}|undefined {const match=text.match(/^\s*\/goal(?:\s+([\s\S]*))?$/);return match?{text:match[1]||'',goalDraft:true}:undefined;}
export const goalCanSave=(objective:string,goal:ComposerGoal)=>!!objective.trim()&&objective.trim().length<=4000&&objective.trim()!==goal.objective.trim();
