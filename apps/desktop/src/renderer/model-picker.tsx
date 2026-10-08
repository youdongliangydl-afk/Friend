import {useEffect, useId, useRef, useState} from 'react';
import type {Model} from './types.js';

const thinkingNames:Record<string,string>={off:'不思考',minimal:'最少',low:'低',medium:'中',high:'高',xhigh:'最高',max:'Max',ultra:'Ultra'};

export function ModelPicker({models,modelId,thinkingLevel,thinkingLevels,disabled,onChange,onConfigure}:{
  models:Model[];modelId?:string;thinkingLevel?:string;thinkingLevels:string[];disabled:boolean;
  onChange(input:{modelId?:string;thinkingLevel?:string}):Promise<unknown>;onConfigure():void;
}) {
  const id=useId(),trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null),search=useRef<HTMLInputElement>(null);
  const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[pending,setPending]=useState(false),[error,setError]=useState('');
  const model=models.find(item=>item.id===modelId),level=thinkingLevel||'off';
  const close=()=>{panel.current?.hidePopover();requestAnimationFrame(()=>trigger.current?.focus());};
  useEffect(()=>{if(disabled)panel.current?.hidePopover();},[disabled]);
  useEffect(()=>{
    const hide=(event:Event)=>{if(event.target instanceof Node&&panel.current?.contains(event.target))return;panel.current?.hidePopover();};
    window.addEventListener('resize',hide);window.addEventListener('scroll',hide,true);
    return()=>{window.removeEventListener('resize',hide);window.removeEventListener('scroll',hide,true);};
  },[]);
  const position=()=>{
    const anchor=trigger.current?.getBoundingClientRect(),popup=panel.current;if(!anchor||!popup)return;
    const width=Math.min(340,window.innerWidth-24),height=Math.max(100,anchor.top-20);
    popup.style.width=`${width}px`;popup.style.left=`${Math.max(12,Math.min(anchor.right-width,window.innerWidth-width-12))}px`;
    popup.style.bottom=`${window.innerHeight-anchor.top+8}px`;popup.style.maxHeight=`${height}px`;
  };
  const choose=async(input:{modelId?:string;thinkingLevel?:string})=>{
    setPending(true);setError('');
    try{await onChange(input);close();}catch(reason){setError(reason instanceof Error?reason.message:String(reason));}finally{setPending(false);}
  };
  return <div className="composer-model-controls">
    <button ref={trigger} type="button" className="model-picker-trigger" disabled={disabled||pending}
      aria-label={`模型与思考强度：${model?.name||modelId?.split('/').at(-1)||'选择模型'}，${thinkingNames[level]||level}`}
      aria-haspopup="dialog" aria-expanded={open} popoverTarget={id} title="选择模型与思考强度">
      <span className="model-picker-name">{model?.name||modelId?.split('/').at(-1)||'选择模型'}</span>
      <span className="model-picker-level">{thinkingNames[level]||level}</span><span aria-hidden="true">⌄</span>
    </button>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label="模型与思考强度" className="model-picker-popover"
      onBeforeToggle={event=>{if(event.newState==='open'){position();setError('');setQuery('');}}}
      onToggle={event=>{const visible=event.newState==='open';setOpen(visible);if(visible)search.current?.focus();}}
      onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}}}>
      <div className="model-picker-heading"><strong>选择模型</strong><button type="button" aria-label="关闭模型选择" onClick={close}>×</button></div>
      <input ref={search} type="search" aria-label="搜索模型" placeholder="搜索模型或供应商…" value={query} onChange={event=>setQuery(event.target.value)}/>
      <div className="model-picker-list" role="group" aria-label="可用模型">{models.filter(item=>`${item.name} ${item.provider} ${item.id}`.toLowerCase().includes(query.toLowerCase())).map(item=>
        <button type="button" key={item.id} aria-pressed={item.id===modelId} disabled={pending} onClick={()=>void choose({modelId:item.id})}>
          <span><strong>{item.name}</strong><small>{item.provider}</small></span><span aria-hidden="true">{item.id===modelId?'✓':''}</span>
        </button>)}{!models.length&&<p className="hint">配置供应商后即可选择模型。</p>}</div>
      <div className="thinking-picker"><strong>思考强度</strong><div role="group" aria-label="思考强度">{thinkingLevels.map(value=>
        <button type="button" key={value} aria-pressed={value===level} disabled={pending} onClick={()=>void choose({thinkingLevel:value})}>{thinkingNames[value]||value}</button>)}</div>
        {thinkingLevels.length===1&&thinkingLevels[0]==='off'&&<p className="hint">当前模型不支持调整思考强度。</p>}
      </div>
      {pending&&<p role="status">正在应用…</p>}{error&&<p role="alert" className="model-picker-error">{error}</p>}
      <button type="button" className="model-picker-settings" disabled={pending} onClick={()=>{close();onConfigure();}}>配置模型与供应商 ↗</button>
    </div>
  </div>;
}
