import {useRef,useState} from 'react';
import type {PermissionMode} from './types.js';
import {Icon} from './Icons.js';
export const permissionOptions=[
  {id:'ask',name:'每次询问',description:'每次需要权限时都由你决定',icon:'hand'},
  {id:'auto',name:'安全自动',description:'只自动允许应用判定的低风险操作',icon:'smart'},
  {id:'allPermissions',name:'所有权限',description:'自动批准所有 Friend 可授予的权限',icon:'unlock'},
] as const;
export function ComposerPermissions({mode,disabled,onChange}:{mode:PermissionMode;disabled:boolean;onChange(mode:PermissionMode):Promise<void>}){
  const trigger=useRef<HTMLButtonElement>(null),menu=useRef<HTMLDivElement>(null);const [busy,setBusy]=useState(false);
  const selected=permissionOptions.find(option=>option.id===mode)!;
  const choose=async(next:PermissionMode)=>{if(disabled||busy)return;setBusy(true);try{await onChange(next);if(menu.current?.matches(':popover-open')){menu.current.hidePopover();requestAnimationFrame(()=>trigger.current?.focus());}}finally{setBusy(false);}};
  return <>
    <button ref={trigger} type="button" className={'permission-control '+(mode==='allPermissions'?'all-permissions':'')} aria-label={'权限策略：'+selected.name} disabled={disabled||busy} popoverTarget="composer-permission-menu" onClick={event=>{const rect=event.currentTarget.getBoundingClientRect();if(menu.current){menu.current.style.left=Math.max(12,Math.min(window.innerWidth-315,rect.left))+'px';menu.current.style.bottom=(window.innerHeight-rect.top+8)+'px';}}}><Icon name="shield" size={16}/><span>{selected.name}</span><span className="control-chevron" aria-hidden="true">⌄</span></button>
    <div ref={menu} id="composer-permission-menu" popover="auto" role="menu" aria-label="执行权限策略" className="permission-menu" onToggle={event=>{if(event.newState==='open')menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();}} onKeyDown={event=>{if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;event.preventDefault();const items=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitemradio]')],index=items.indexOf(document.activeElement as HTMLButtonElement),next=event.key==='Home'?0:event.key==='End'?items.length-1:(index+(event.key==='ArrowUp'?-1:1)+items.length)%items.length;items[next]?.focus();}}>
      {permissionOptions.map(option=><button type="button" key={option.id} role="menuitemradio" aria-checked={mode===option.id} disabled={busy||disabled} onClick={()=>void choose(option.id).catch(()=>{})}><Icon name={option.icon} size={18}/><span><strong>{option.name}</strong><small>{option.description}</small></span><span aria-hidden="true">{mode===option.id?'✓':''}</span></button>)}
    </div>
  </>;
}
