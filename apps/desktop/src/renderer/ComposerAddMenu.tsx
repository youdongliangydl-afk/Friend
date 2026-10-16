import {useEffect,useId,useRef,useState} from 'react';
import {Icon} from './Icons.js';

export function ComposerAddMenu({disabled,onFiles,onGoal}:{disabled:boolean;onFiles():void;onGoal():void}){
  const id=useId(),trigger=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null),[open,setOpen]=useState(false);
  const position=()=>{const rect=trigger.current?.getBoundingClientRect(),popup=menu.current;if(!rect||!popup)return;
    popup.style.width=Math.min(360,window.innerWidth-24)+'px';popup.style.left=Math.max(12,Math.min(rect.left,window.innerWidth-372))+'px';
    const above=rect.top-20,below=window.innerHeight-rect.bottom-20,useAbove=above>=Math.min(140,below);
    popup.style.bottom=useAbove?window.innerHeight-rect.top+8+'px':'auto';popup.style.top=useAbove?'auto':rect.bottom+8+'px';popup.style.maxHeight=Math.max(40,useAbove?above:below)+'px';
  };
  useEffect(()=>{if(disabled)menu.current?.hidePopover();},[disabled]);
  useEffect(()=>{const close=(event:Event)=>{if(event.target instanceof Node&&menu.current?.contains(event.target))return;menu.current?.hidePopover();};window.addEventListener('resize',close);window.addEventListener('scroll',close,true);return()=>{window.removeEventListener('resize',close);window.removeEventListener('scroll',close,true);};},[]);
  const choose=(callback:()=>void)=>{menu.current?.hidePopover();callback();};
  return <div className="composer-add-control">
    <button ref={trigger} type="button" className="attachment-button" aria-label="添加" title="添加文件、文件夹或目标" aria-haspopup="menu" aria-expanded={open} popoverTarget={id} disabled={disabled}><Icon name="plus"/></button>
    <div ref={menu} id={id} popover="auto" role="menu" aria-label="添加" className="composer-add-menu"
      onBeforeToggle={event=>{if(event.newState==='open')position();}}
      onToggle={event=>{const visible=event.newState==='open';setOpen(visible);if(visible)menu.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus();}}
      onKeyDown={event=>{if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();const items=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)')],index=items.indexOf(document.activeElement as HTMLButtonElement),next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowUp'?-1:1)+items.length)%items.length;items[next]?.focus();}}>
      <p>添加</p>
      <button type="button" role="menuitem" disabled={disabled} onClick={()=>choose(onFiles)}><Icon name="file"/><span><strong>文件和文件夹</strong><small>添加到当前消息</small></span></button>
      <button type="button" role="menuitem" disabled={disabled} onClick={()=>choose(onGoal)}><Icon name="goal"/><span><strong>目标</strong><small>设置要持续追求的目标</small></span></button>
    </div>
  </div>;
}
