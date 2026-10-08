import {useEffect, useId, useRef, useState} from 'react';
import {errorText,type Model} from './types.js';

const thinkingNames:Record<string,string>={off:'不思考',minimal:'最少',low:'低',medium:'中',high:'高',xhigh:'最高',max:'Max',ultra:'Ultra'};

export function ModelPicker({models,modelId,thinkingLevel,thinkingLevels,disabled,onChange,onConfigure}:{
  models:Model[];modelId?:string;thinkingLevel?:string;thinkingLevels:string[];disabled:boolean;
  onChange(input:{modelId?:string;thinkingLevel?:string}):Promise<unknown>;onConfigure():void;
}) {
  const id=useId(),trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null),search=useRef<HTMLInputElement>(null);
  const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[pending,setPending]=useState(false),[error,setError]=useState('');
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
  const position=()=>{
    const anchor=trigger.current?.getBoundingClientRect(),popup=panel.current;if(!anchor||!popup)return;
    const width=Math.min(340,window.innerWidth-24),above=anchor.top-20,below=window.innerHeight-anchor.bottom-20,useAbove=above>=Math.min(360,below),height=Math.max(40,useAbove?above:below);
    popup.style.width=`${width}px`;popup.style.left=`${Math.max(12,Math.min(anchor.right-width,window.innerWidth-width-12))}px`;
    popup.style.bottom=useAbove?`${window.innerHeight-anchor.top+8}px`:'auto';popup.style.top=useAbove?'auto':`${anchor.bottom+8}px`;popup.style.maxHeight=`${height}px`;
  };
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
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label="模型与思考强度" className="model-picker-popover"
      onBeforeToggle={event=>{if(event.newState==='open'){position();setError('');setQuery('');}}}
      onToggle={event=>{const visible=event.newState==='open';setOpen(visible);if(visible)search.current?.focus();else cancel();}}
      onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}}}>
      <div className="model-picker-heading"><strong>选择模型</strong><button type="button" aria-label="关闭模型选择" onClick={()=>close()}>×</button></div>
      <input ref={search} type="search" aria-label="搜索模型" placeholder="搜索模型或供应商…" value={query} onChange={event=>setQuery(event.target.value)}/>
      <div className="model-picker-list" role="group" aria-label="可用模型">{models.filter(item=>`${item.name} ${item.provider} ${item.id}`.toLowerCase().includes(query.toLowerCase())).map(item=>
        <button type="button" key={item.id} aria-pressed={item.id===modelId} disabled={pending||!item.ready} onClick={()=>void choose({modelId:item.id})}>
          <span><strong>{item.name}</strong><small>{item.provider} · {item.ready?'已验证':'待测试连接'}</small></span><span aria-hidden="true">{item.id===modelId?'✓':''}</span>
        </button>)}{!models.length&&<p className="hint">保存型号并通过连接测试后才能发送消息。</p>}</div>
      <div className="compact-model-card popover-effort-card"><div className="model-effort"><span aria-hidden="true">ϟ</span><strong>{thinkingNames[preview]||preview}</strong><button type="button" aria-label="重置思考强度" disabled={pending||disabled||!model?.ready||thinkingLevels.length<=1||level===thinkingLevels[0]} onClick={()=>{const reset=thinkingLevels[0]||'off';setPreview(reset);value.current=reset;gesture.current='reset';void commit();}}>↶</button></div><div className="effort-model-name">{model?.name||'选择已验证模型'}</div>
        <input className="model-effort-slider" type="range" aria-label="思考强度" aria-valuetext={thinkingNames[preview]||preview} min={0} max={Math.max(1,thinkingLevels.length-1)} step={1} value={Math.max(0,thinkingLevels.indexOf(preview))} disabled={pending||disabled||!model?.ready||thinkingLevels.length<=1}
          style={{'--effort-progress':(Math.max(0,thinkingLevels.indexOf(preview))/Math.max(1,thinkingLevels.length-1)*100)+'%'} as React.CSSProperties}
          onPointerDown={e=>{gesture.current='pointer';e.currentTarget.setPointerCapture(e.pointerId);}} onPointerUp={()=>void commit()} onPointerCancel={cancel} onLostPointerCapture={()=>{if(gesture.current)cancel();}}
          onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();cancel();}else if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(e.key))gesture.current='keyboard';}} onKeyUp={e=>{if(gesture.current==='keyboard'&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(e.key))void commit();}} onBlur={()=>{if(gesture.current==='keyboard')void commit();}} onChange={e=>{const next=thinkingLevels[Number(e.target.value)];value.current=next;setPreview(next);}}/>
        {thinkingLevels.length===1&&<p className="hint">当前模型不支持调整思考强度。</p>}
      </div>
      {pending&&<p role="status">正在应用…</p>}{error&&<p role="alert" className="model-picker-error">{error}</p>}
      <button type="button" className="model-picker-settings" disabled={pending} onClick={()=>{close(false);onConfigure();}}>配置模型与供应商 ↗</button>
    </div>
  </div>;
}
