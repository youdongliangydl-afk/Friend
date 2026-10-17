import {useRef,useState} from 'react';
import {errorText,type JsonObject} from './types.js';
import {goalBinding,goalCanSave,type ComposerGoal} from './goal-model.js';
export type {ComposerGoal} from './goal-model.js';
export {goalStatusLabels} from './goal-model.js';
export interface GoalCommand {action:'goal.set'|'goal.clear';input:JsonObject}
/** The editor stays beside the conversation so messages and Goal are visible together. */
export function GoalEditor({goal,archived,onAction,onClose}:{goal:ComposerGoal;archived:boolean;onAction(command:GoalCommand):Promise<unknown>;onClose():void}){
 const [objective,setObjective]=useState(goal.objective),[busy,setBusy]=useState(false),[error,setError]=useState('');const lock=useRef(false);
 // The opened revision remains bound while editing. A concurrent model update must be reviewed.
 const opened=useRef(goal);const stale=opened.current.id!==goal.id||opened.current.revision!==goal.revision;
 const restore=()=>{opened.current=goal;setObjective(goal.objective);setError('');};
 const save=async()=>{if(lock.current||archived||stale||!goalCanSave(objective,opened.current))return;lock.current=true;setBusy(true);setError('');try{await onAction({action:'goal.set',input:{...goalBinding(opened.current),objective:objective.trim(),status:'active'}});onClose();}catch(e){setError(errorText(e));}finally{lock.current=false;setBusy(false);}};
 const updated=goal.updatedAt?new Date(goal.updatedAt).toLocaleString():'';
 return <aside className="goal-editor" aria-label="编辑目标"><header><h2>目标</h2><button type="button" aria-label="关闭目标编辑栏" disabled={busy} onClick={onClose}>×</button></header><p className="hint">Friend 会持续推进这个目标，直到完成或你暂停。</p><form onSubmit={event=>{event.preventDefault();void save();}}><label>目标<textarea autoFocus aria-label="目标描述" rows={12} maxLength={32000} value={objective} disabled={busy||archived} onChange={e=>setObjective(e.target.value)}/></label><p className="goal-updated">最近更新：{updated||'暂无记录'}</p>{stale&&<p role="status">目标已更新。可还原到最新内容后继续编辑。</p>}<div className="button-row"><button type="button" onClick={restore} disabled={busy||archived||!stale&&objective===goal.objective}>还原</button><button type="submit" className="primary" disabled={busy||archived||stale||!goalCanSave(objective,opened.current)}>保存</button></div>{error&&<p role="alert" className="goal-error">{error}</p>}</form></aside>;
}
