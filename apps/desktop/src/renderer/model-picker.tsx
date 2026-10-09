import {useEffect, useId, useLayoutEffect, useRef, useState} from 'react';
import {errorText,type Model} from './types.js';

const thinkingNames:Record<string,string>={off:'不思考',minimal:'最少',low:'低',medium:'中',high:'高',xhigh:'最高',max:'Max',ultra:'Ultra'};

export function ModelPicker({models,modelId,thinkingLevel,thinkingLevels,disabled,onChange,onConfigure}:{
  models:Model[];modelId?:string;thinkingLevel?:string;thinkingLevels:string[];disabled:boolean;
  onChange(input:{modelId?:string;thinkingLevel?:string}):Promise<unknown>;onConfigure():void;
}) {
  const id=useId(),trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null),modelButton=useRef<HTMLButtonElement>(null),slider=useRef<HTMLInputElement>(null),focusModel=useRef(false);
  const [open,setOpen]=useState(false),[view,setView]=useState<'effort'|'models'>('effort'),[pending,setPending]=useState(false),[error,setError]=useState('');
  const [preview,setPreview]=useState(thinkingLevel||thinkingLevels[0]||'off'),value=useRef(preview),gesture=useRef<'pointer'|'keyboard'|'reset'|false>(false),version=useRef(0);value.current=preview;
  useEffect(()=>{version.current++;gesture.current=false;setPreview(thinkingLevel||thinkingLevels[0]||'off');},[modelId,thinkingLevel,thinkingLevels.join('|'),disabled]);
  const model=models.find(item=>item.id===modelId),level=thinkingLevel||'off';
  const close=(restore=true)=>{gesture.current=false;value.current=thinkingLevel||thinkingLevels[0]||'off';setPreview(value.current);panel.current?.hidePopover();// Native popover restores focus only while it owns focus; late responses never steal it.
    };
  useEffect(()=>{if(disabled)close(false);},[disabled]);
  useEffect(()=>{
    const hide=(event:Event)=>{if(event.target instanceof Node&&panel.current?.contains(event.target))return;panel.current?.hidePopover();};
    window.addEventListener('resize',hide);window.addEventListener('scroll',hide,true);
    return()=>{window.removeEventListener('resize',hide);window.removeEventListener('scroll',hide,true);};
  },[]);
  const position=(surface=view)=>{
    const anchor=trigger.current?.getBoundingClientRect(),popup=panel.current;if(!anchor||!popup)return;
    const width=Math.min(280,window.innerWidth-24),above=anchor.top-20,below=window.innerHeight-anchor.bottom-20,useAbove=above>=Math.min(surface==='effort'?150:330,below),height=Math.max(40,useAbove?above:below);
    popup.style.width=`${width}px`;popup.style.left=`${Math.max(12,Math.min(anchor.right-width,window.innerWidth-width-12))}px`;
    popup.style.bottom=useAbove?`${window.innerHeight-anchor.top+8}px`:'auto';popup.style.top=useAbove?'auto':`${anchor.bottom+8}px`;popup.style.maxHeight=`${height}px`;
  };
  useLayoutEffect(()=>{if(!open||!panel.current?.matches(':popover-open'))return;position();
    const focus=view==='models'?(panel.current.querySelector<HTMLButtonElement>('[aria-pressed=true]:not(:disabled)')||panel.current.querySelector<HTMLButtonElement>('.model-picker-list button:not(:disabled)')):focusModel.current||slider.current?.disabled?modelButton.current:slider.current;
    focusModel.current=false;(focus?.disabled?panel.current:focus)?.focus();
  },[open,view]);
  const returnToEffort=()=>{focusModel.current=true;setView('effort');};
  const choose=async(input:{modelId?:string;thinkingLevel?:string})=>{
    setPending(true);setError('');
    try{await onChange(input);close();}catch(reason){setError(errorText(reason));}finally{setPending(false);}
  };
  const commit=async()=>{if(!gesture.current)return;gesture.current=false;const next=value.current;if(disabled||pending||next===level)return;const generation=version.current;setPending(true);try{await onChange({thinkingLevel:next});}catch(reason){if(generation===version.current){setPreview(level);setError(errorText(reason));}}finally{setPending(false);}};
  const cancel=()=>{gesture.current=false;setPreview(level);value.current=level;};
  if(!models.some(item=>item.ready))return <div className="model-empty-control"><span>{models.length?'模型尚未通过连接测试':'请先配置模型'}</span><button type="button" disabled={disabled} onClick={onConfigure}>配置模型 ↗</button></div>;
  return <div className="composer-model-controls">
    <button ref={trigger} type="button" className="model-picker-trigger" disabled={disabled||pending}
      aria-label={`模型与思考强度：${model?.name||modelId?.split('/').at(-1)||'请先配置模型'}，${thinkingNames[level]||level}`}
      aria-haspopup="dialog" aria-expanded={open} popoverTarget={id} title="选择模型与思考强度">
      <span className="model-picker-name">{model?.name||modelId?.split('/').at(-1)||'请先配置模型'}</span>
      <span className="model-picker-level">{thinkingNames[level]||level}</span><span aria-hidden="true">⌄</span>
    </button>
    <div ref={panel} id={id} popover="auto" role="dialog" tabIndex={-1} aria-label={view==='effort'?'选择强度':'选择模型'} className={'model-picker-popover '+(view==='effort'?'model-strength-popover':'model-list-popover')}
      onBeforeToggle={event=>{if(event.newState==='open'){position('effort');focusModel.current=false;setView('effort');setError('');}}}
      onToggle={event=>{const visible=event.newState==='open';setOpen(visible);if(!visible)cancel();}}
      onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(view==='models')returnToEffort();else close();}}}>
      {view==='effort'?<div className="model-strength-card"><div className="model-effort"><svg aria-hidden="true" width="17" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"><path d="m13 2-9 12h7l-1 8 10-13h-7z"/></svg><strong>{thinkingNames[preview]||preview}</strong><button type="button" aria-label="重置思考强度" disabled={pending||disabled||!model?.ready||thinkingLevels.length<=1||level===thinkingLevels[0]} onClick={()=>{const reset=thinkingLevels[0]||'off';setPreview(reset);value.current=reset;gesture.current='reset';void commit();}}><svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 10a8 8 0 1 1 1 8M4 4v6h6"/></svg></button></div>
        <button ref={modelButton} type="button" className="model-name-button" aria-label="选择模型" disabled={pending||disabled} onClick={()=>{cancel();setError('');setView('models');}}>{model?.name||'选择已验证模型'}<span aria-hidden="true">›</span></button>
        <input ref={slider} className="model-effort-slider" type="range" aria-label="思考强度" aria-busy={pending} aria-valuetext={thinkingNames[preview]||preview} min={0} max={Math.max(1,thinkingLevels.length-1)} step={1} value={Math.max(0,thinkingLevels.indexOf(preview))} disabled={disabled||!model?.ready||thinkingLevels.length<=1}
          style={{'--effort-progress':(Math.max(0,thinkingLevels.indexOf(preview))/Math.max(1,thinkingLevels.length-1)*100)+'%'} as React.CSSProperties}
          onPointerDown={e=>{if(pending){e.preventDefault();return;}gesture.current='pointer';e.currentTarget.setPointerCapture(e.pointerId);}} onPointerUp={()=>void commit()} onPointerCancel={cancel} onLostPointerCapture={()=>{if(gesture.current)cancel();}}
          onKeyDown={e=>{const adjusting=['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(e.key);if(pending&&adjusting){e.preventDefault();return;}if(e.key==='Escape'&&gesture.current){e.preventDefault();e.stopPropagation();cancel();}else if(adjusting)gesture.current='keyboard';}} onKeyUp={e=>{if(gesture.current==='keyboard'&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(e.key))void commit();}} onBlur={()=>{if(gesture.current==='keyboard')void commit();}} onChange={e=>{if(pending)return;const next=thinkingLevels[Number(e.target.value)];value.current=next;setPreview(next);}}/>
        {thinkingLevels.length===1&&<p className="hint">当前模型不支持调整思考强度。</p>}
      </div>:<>
        <div className="model-picker-heading"><span>选择模型</span><button type="button" aria-label="返回强度选择" onClick={returnToEffort}>‹</button></div>
        <div className="model-picker-list" role="group" aria-label="已配置模型">{models.map(item=>
          <button type="button" key={item.id} aria-pressed={item.id===modelId} disabled={pending||!item.ready} onClick={()=>void choose({modelId:item.id})}>
            <span>{item.name}{!item.ready&&<small>待测试连接</small>}</span><span aria-hidden="true">{item.id===modelId?'✓':''}</span>
          </button>)}</div>
        <button type="button" className="model-picker-settings" disabled={pending} onClick={()=>{close(false);onConfigure();}}>配置模型与供应商 ↗</button>
      </>}
      {pending&&<p role="status">正在应用…</p>}{error&&<p role="alert" className="model-picker-error">{error}</p>}
    </div>
  </div>;
}
