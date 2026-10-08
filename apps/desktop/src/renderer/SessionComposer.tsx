import {useEffect,useRef,useState,type RefObject} from 'react';
import {Icon} from './Icons.js';
import {ModelPicker} from './model-picker.js';
import {composerKeyAction,insertNewline} from './composer-keys.js';
import type {Model,JsonObject} from './types.js';
export interface ComposerSnapshot {sessionId:string;epoch:number;draft:string;attachments:{path:string}[];running:boolean;sending:boolean;navigating:boolean;archived:boolean;planMode:boolean;mode:'single'|'team'|'swarm';plugins:string[];models:Model[];modelId:string;thinkingLevel:string;thinkingLevels:string[];ready:boolean;floating:boolean;collapsed:boolean;status:string;notice?:string}
export interface ComposerAction {type:string;value?:unknown;text?:string;sessionId?:string;epoch?:number;token?:string}
export function SessionComposer({value,action,inputRef}:{value:ComposerSnapshot;action(input:ComposerAction):Promise<unknown>;inputRef?:RefObject<HTMLTextAreaElement|null>}){
  const own=useRef<HTMLTextAreaElement>(null),ref=inputRef||own,composing=useRef(false),draft=useRef(value.draft);draft.current=value.draft;
  const busy=value.running||value.sending||value.navigating||value.archived;
  const dispatch=(input:ComposerAction)=>action({...input,sessionId:value.sessionId,epoch:value.epoch});
  return <div className={'composer-wrap '+(value.floating?'floating-composer':'')}>
    {value.floating&&<div className="floating-heading"><button className="floating-status" onClick={()=>void dispatch({type:'conversation'})}>{value.notice||value.status} <span>↗ 会话</span></button><button aria-label={value.collapsed?'展开输入框':'收起输入框'} onClick={()=>void dispatch({type:'collapse',value:!value.collapsed})}>{value.collapsed?'⌃':'⌄'}</button></div>}
    <div className="composer" hidden={value.floating&&value.collapsed}><textarea ref={ref} aria-label="消息" value={value.draft} placeholder="描述你想完成的工作…" disabled={value.archived||value.navigating} rows={3}
      onChange={event=>{draft.current=event.target.value;void dispatch({type:'draft',value:event.target.value});}}
      onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}}
      onKeyDown={event=>{const result=composerKeyAction(event.nativeEvent,composing.current);if(result==='none')return;event.preventDefault();if(result==='send')void dispatch({type:'send',text:draft.current});else{const next=insertNewline(draft.current,event.currentTarget.selectionStart,event.currentTarget.selectionEnd);draft.current=next.value;void dispatch({type:'draft',value:next.value});requestAnimationFrame(()=>ref.current?.setSelectionRange(next.caret,next.caret));}}}/>
      {value.attachments.length>0&&<div className="attachment-list">{value.attachments.map(a=><span key={a.path}>{a.path.split('/').at(-1)}<button aria-label={'移除附件 '+a.path} disabled={busy} onClick={()=>void dispatch({type:'removeAttachment',value:a.path})}>×</button></span>)}</div>}
      <div className="composer-toolbar"><button className="attachment-button" aria-label="添加附件" disabled={value.running||value.archived} onClick={()=>void dispatch({type:'attach'})}><Icon name="plus"/></button>{!value.floating&&<><span className="permission-hint"><Icon name="shield"/><span>关键操作确认</span></span>
        <label className={'plan-control '+(value.planMode?'active':'')}><span>先规划</span><input type="checkbox" role="switch" aria-label="计划模式（只读分析）" checked={value.planMode} disabled={busy} onChange={e=>void dispatch({type:'plan',value:e.target.checked})}/></label>
        <div className="agent-mode-control" role="group" aria-label="Agent 协作方式" data-mode={value.mode}><span className="agent-mode-thumb"/>{(['single','team','swarm'] as const).map(mode=><button key={mode} aria-label={mode==='single'?'Single':mode==='team'?'Team':'Swarm'} aria-pressed={value.mode===mode} className={value.mode===mode?'selected':''} disabled={busy||mode!=='single'&&!value.plugins.includes('swarm')} onClick={()=>void dispatch({type:'mode',value:mode})}><Icon name={mode==='single'?'single':'swarm'}/><span>{mode==='single'?'Single':mode==='team'?'Team':'Swarm'}</span></button>)}</div>
        <ModelPicker models={value.models} modelId={value.modelId} thinkingLevel={value.thinkingLevel} thinkingLevels={value.thinkingLevels} disabled={busy} onConfigure={()=>void dispatch({type:'settings'})} onChange={input=>dispatch({type:'model',value:input})}/></>}
        {value.running?<button className="stop-button" aria-label="停止当前任务" onClick={()=>void dispatch({type:'stop'})}>停止</button>:<button className="send-button" aria-label="发送消息" title="Enter 发送；⌘ Enter 换行" disabled={busy||!value.draft.trim()||!value.ready} onClick={()=>void dispatch({type:'send',text:draft.current})}><Icon name="send"/></button>}
      </div>
    </div>
  </div>;
}
interface OverlayBridge {action(input:ComposerAction):Promise<unknown>;onSnapshot(handler:(value:ComposerSnapshot&{token:string;revision:number})=>void):()=>void}
declare global {interface Window {friendComposer:OverlayBridge}}
export function ComposerSurface(){
  const [snapshot,setSnapshot]=useState<(ComposerSnapshot&{token:string;revision:number})|null>(null),latest=useRef(snapshot);latest.current=snapshot;
  const localDraft=useRef<string|null>(null),pending=useRef(false),revision=useRef(0);
  useEffect(()=>{document.body.classList.add('composer-surface');return window.friendComposer.onSnapshot(next=>{if(next.revision<revision.current)return;revision.current=next.revision;if(next.sessionId!==latest.current?.sessionId){localDraft.current=null;pending.current=false;}if(localDraft.current===next.draft)pending.current=false;setSnapshot(pending.current?{...next,draft:localDraft.current||''}:next);});},[]);
  const action=async(input:ComposerAction)=>{if(!latest.current)return;if(input.type==='send')pending.current=false;if(input.type==='draft'){localDraft.current=String(input.value);pending.current=true;try{localStorage.setItem('friend-pi.draft.v1:'+latest.current.sessionId,JSON.stringify({text:localDraft.current,attachments:latest.current.attachments,planMode:latest.current.planMode,mode:latest.current.mode}));}catch{}setSnapshot({...latest.current,draft:localDraft.current});}return window.friendComposer.action({...input,token:latest.current.token});};
  return snapshot?<div className="overlay-composer-theme friend-layout"><SessionComposer value={snapshot} action={action}/></div>:null;
}
