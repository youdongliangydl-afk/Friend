import {useRef,useState} from 'react';
import type {GoalRecord} from '@friend-pi/core';
import {Modal} from './ui.js';
import {errorText,type JsonObject} from './types.js';

export type ComposerGoal=Pick<GoalRecord,'id'|'objective'|'status'|'revision'|'progress'|'nextAction'|'waitFor'|'tokenBudget'|'tokens'|'usageAvailable'|'error'|'acceptance'|'mode'>;
export const goalStatusLabels:Record<ComposerGoal['status'],string>={active:'进行中',waiting:'等待中',verifying:'验证中',completed:'已完成',paused:'已暂停',blocked:'遇到阻塞',stopped:'已停止'};
export interface GoalCommand {action:'goal.create'|'goal.update'|'goal.pause'|'goal.resume'|'goal.stop'|'goal.complete'|'goal.accept';input:JsonObject}

export function GoalDialog({goal,running,ready,archived,planMode,onAction,onClose}:{goal?:ComposerGoal;running:boolean;ready:boolean;archived:boolean;planMode:boolean;onAction(command:GoalCommand):Promise<unknown>;onClose():void}){
  const [editing,setEditing]=useState(!goal),[creating,setCreating]=useState(!goal),[objective,setObjective]=useState(goal?.objective||''),[budget,setBudget]=useState(goal?.tokenBudget?.toString()||''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const lock=useRef(false);
  const ended=goal?.status==='completed'||goal?.status==='stopped',active=goal&&['active','waiting','verifying'].includes(goal.status),accepting=goal?.status==='waiting'&&goal.waitFor==='user-acceptance';
  const tokenBudget=()=>{if(!budget.trim()){if(!creating&&goal?.tokenBudget!==undefined)throw new Error('已有预算不能清空，请填写总令牌预算。');return undefined;}const amount=Number(budget);if(!Number.isSafeInteger(amount)||amount<1)throw new Error('令牌预算必须是正整数。');return amount;};
  const run=async(action:GoalCommand['action'],input:JsonObject={})=>{if(lock.current)return;lock.current=true;setBusy(true);setError('');try{await onAction({action,input:{...input,...(action!=='goal.create'&&goal?{goalId:goal.id}:{})}});setEditing(false);setCreating(false);}catch(reason){setError(errorText(reason));}finally{lock.current=false;setBusy(false);}};
  const save=()=>{try{const amount=tokenBudget();if(!objective.trim())throw new Error('请填写目标。');void run(creating?'goal.create':'goal.update',{objective:objective.trim(),...(amount!==undefined?{tokenBudget:amount}:{})});}catch(reason){setError(errorText(reason));}};
  const resume=()=>{try{const amount=tokenBudget();if(amount!==undefined&&amount<=(goal?.tokens||0))throw new Error('接续前请将总令牌预算提高到已使用量以上。');void run('goal.resume',amount===undefined?{}:{tokenBudget:amount});}catch(reason){setError(errorText(reason));}};
  return <Modal title="目标" className="goal-dialog" onClose={onClose} closeDisabled={busy}>
    <p className="goal-intro">设定一个目标，Friend 会持续推进，直到完成、遇到阻塞或你暂停。沿用当前会话的模型、权限和协作方式。</p>
    {goal&&!creating&&<div className="goal-details">
      <span className="goal-status" role="status">{accepting?'等待你验收':goalStatusLabels[goal.status]}</span>
      {!editing&&<p className="goal-objective">{goal.objective}</p>}
      <p className="goal-usage">已使用 {goal.tokens.toLocaleString()} 令牌{goal.tokenBudget===undefined?' · 未设置预算':' / '+goal.tokenBudget.toLocaleString()}{!goal.usageAvailable&&' · 使用量不可核实'}</p>
      {goal.progress&&<p><strong>进度</strong> {goal.progress}</p>}{goal.nextAction&&!editing&&<p><strong>下一步</strong> {goal.nextAction}</p>}
      {goal.error&&<p className="goal-message">{goal.error}</p>}
    </div>}
    {editing?<form onSubmit={event=>{event.preventDefault();save();}}>
      <label>目标<textarea aria-label="目标描述" value={objective} maxLength={32000} rows={5} disabled={busy||archived} placeholder="描述希望持续完成的工作，以及怎样算完成…" onChange={event=>setObjective(event.target.value)}/></label>
      <label>总令牌预算（可选）<input aria-label="总令牌预算" type="number" min="1" step="1" value={budget} disabled={busy||archived} placeholder="留空不设预算" onChange={event=>setBudget(event.target.value)}/></label>
      <p className="hint">预算包括目标执行的累计令牌；达到预算后暂停。{!creating&&'保存修改后保持暂停，需要明确接续。'}{planMode&&'当前开启先规划，目标会保存为暂停状态。'}</p>
      <div className="button-row"><button type="submit" className="primary" disabled={busy||running||archived||!objective.trim()||creating&&!ready}>{creating?(planMode?'保存目标（先规划）':'开始目标'):'保存修改'}</button><button type="button" disabled={busy} onClick={()=>goal?(setEditing(false),setCreating(false)):onClose()}>取消</button></div>
    </form>:goal&&<>
      {['paused','blocked','stopped'].includes(goal.status)&&<label>接续时的总令牌预算<input aria-label="接续总令牌预算" type="number" min="1" step="1" value={budget} disabled={busy||archived} placeholder="留空不设预算" onChange={event=>setBudget(event.target.value)}/></label>}
      {planMode&&<p className="hint">当前开启先规划；关闭后可接续目标。</p>}
      <div className="button-row">
        {active&&<button disabled={busy||archived} onClick={()=>void run('goal.pause')}>暂停目标</button>}
        {['paused','blocked','stopped'].includes(goal.status)&&<button className="primary" disabled={busy||archived||running||!ready||planMode} onClick={resume}>接续目标</button>}
        {!active&&goal.status!=='completed'&&<button disabled={busy||archived||running} onClick={()=>{setObjective(goal.objective);setBudget(goal.tokenBudget?.toString()||'');setEditing(true);setCreating(false);setError('');}}>编辑目标</button>}
        {accepting&&goal.acceptance?<button className="primary" disabled={busy||archived||running} onClick={()=>void run('goal.accept',{expectedRevision:goal.revision,candidateDigest:goal.acceptance!.binding})}>已检查成果，确认验收</button>:goal.status!=='completed'&&active&&<button disabled={busy||archived||running||!ready||planMode||goal.status==='verifying'} onClick={()=>void run('goal.complete')}>验证完成</button>}
        {!ended&&<button disabled={busy||archived} onClick={()=>void run('goal.stop')}>停止目标</button>}
        {ended&&<button disabled={busy||archived||running} onClick={()=>{setObjective('');setBudget('');setEditing(true);setCreating(true);setError('');}}>新目标</button>}
      </div>
    </>}
    {!ready&&<p className="hint">请先在设置中配置模型并通过连接测试。</p>}
    <span className="visually-hidden" role="status">{busy?'正在更新目标…':''}</span>{error&&<p role="alert" className="goal-error">{error}</p>}
  </Modal>;
}
