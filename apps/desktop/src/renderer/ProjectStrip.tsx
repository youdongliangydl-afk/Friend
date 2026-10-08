import { useEffect, useRef, useState } from 'react';
import type { Project } from './types.js';
import { Icon } from './Icons.js';
export function reorderIds(ids: string[], source: string, target: string, after = false) {
  if (source === target || !ids.includes(source) || !ids.includes(target)) return ids;
  const next = ids.filter(id => id !== source);
  next.splice(next.indexOf(target) + (after ? 1 : 0), 0, source);
  return next;
}
export function ProjectStrip({ projects, selected, disabled, onSelect, onOpen, onReorder }: {
  projects: Project[]; selected?: string; disabled: boolean; onSelect(id: string): void; onOpen(): void; onReorder(ids: string[]): Promise<unknown>;
}) {
  const strip = useRef<HTMLDivElement>(null),edge=useRef(0),frame=useRef(0),latestProjects=useRef(projects);latestProjects.current=projects;
  const pointer=useRef<{source:string;x:number;y:number;startX:number;startY:number;active:boolean;id:number;element:HTMLButtonElement}|null>(null),drop=useRef<{source:string;target:string;after:boolean}|null>(null),suppressClick=useRef(false);
  const [drag, setDrag] = useState<{ source: string; target: string; after: boolean } | null>(null);
  const cancelScroll=()=>{edge.current=0;cancelAnimationFrame(frame.current);frame.current=0;};
  const cancel=()=>{cancelScroll();const p=pointer.current;pointer.current=null;drop.current=null;setDrag(null);if(p?.active)suppressClick.current=true;if(p?.element.hasPointerCapture(p.id))p.element.releasePointerCapture(p.id);};
  const updateDrop=(x:number,y:number)=>{
    const el=strip.current,p=pointer.current;if(!el||!p?.active)return;
    const bounds=el.getBoundingClientRect();if(y<bounds.top||y>bounds.bottom||x<bounds.left||x>bounds.right){drop.current=null;setDrag(null);edge.current=0;return;}
    edge.current=x<bounds.left+44?-12:x>bounds.right-44?12:0;
    const buttons=[...el.querySelectorAll<HTMLButtonElement>('[data-project-id]')];const target=buttons.find(b=>{const box=b.getBoundingClientRect();return x<box.left+box.width/2;})||buttons.at(-1);
    if(!target)return;const box=target.getBoundingClientRect();const next={source:p.source,target:target.dataset.projectId!,after:x>=box.left+box.width/2};drop.current=next;setDrag(old=>old?.source===next.source&&old.target===next.target&&old.after===next.after?old:next);
  };
  const autoScroll=()=>{const el=strip.current,p=pointer.current;if(el&&p?.active){if(edge.current)el.scrollLeft+=edge.current;updateDrop(p.x,p.y);frame.current=requestAnimationFrame(autoScroll);}else frame.current=0;};
  useEffect(()=>{const escape=(e:KeyboardEvent)=>{if(e.key==='Escape'&&pointer.current)cancel();};window.addEventListener('keydown',escape);return()=>{cancelScroll();window.removeEventListener('keydown',escape);};},[]);
  useEffect(()=>{if(pointer.current&&!projects.some(p=>p.id===pointer.current?.source))cancel();},[projects.map(p=>p.id).join(',')]);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [overflow, setOverflow] = useState(false);
  useEffect(() => {
    const element = strip.current;
    if (!element) return;
    const resized = () => setOverflow(element.scrollWidth > element.clientWidth + 1);
    const wheel = (event: WheelEvent) => {
      if (element.scrollWidth <= element.clientWidth) return;
      event.preventDefault();
      element.scrollLeft += Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    };
    const observer = new ResizeObserver(resized); observer.observe(element); resized();
    element.addEventListener('wheel', wheel, { passive: false });
    return () => { observer.disconnect(); element.removeEventListener('wheel', wheel); };
  }, [projects.length]);
  useEffect(() => { strip.current?.querySelector<HTMLElement>('[data-project-id="' + (selected || 'temporary') + '"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [selected,projects.map(p=>p.id).join(',')]);
  const commit = async (ids: string[]) => { cancelScroll();setDrag(null);try{await onReorder(ids);}catch{} };
  const move = (id: string, delta: number) => {
    const ids = projects.map(p => p.id), i = ids.indexOf(id), target = ids[i + delta];
    if (target) void commit(reorderIds(ids, id, target, delta > 0));
    setMenu(null);
  };
  return <div className="project-strip-shell">
    {overflow && <button aria-label="项目栏向左滚动" className="project-scroll" onClick={() => strip.current?.scrollBy({ left: -240, behavior: 'smooth' })}>‹</button>}
    <div role="tablist" aria-label="项目" className="project-tab-group"><button type="button" role="tab" data-project-id="temporary" aria-selected={!selected} className={'project-tab temporary-tab ' + (!selected ? 'active' : '')} disabled={disabled && !!selected} onClick={() => onSelect('')}>临时会话</button><div ref={strip} className="project-tabs">
      {projects.map((p, i) => <button key={p.id} type="button" role="tab" data-project-id={p.id} aria-selected={selected === p.id}
        draggable={false} className={'project-tab ' + (selected === p.id ? 'active ' : '') + (drag?.target === p.id ? drag.after ? 'drop-after' : 'drop-before' : '')}
        title={p.path} onClick={event => {if(suppressClick.current){suppressClick.current=false;if(event.detail!==0)return;}if (!disabled) onSelect(p.id); }}
        onPointerDown={event=>{if(event.button!==0)return;suppressClick.current=false;pointer.current={source:p.id,x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,active:false,id:event.pointerId,element:event.currentTarget};event.currentTarget.setPointerCapture(event.pointerId);}}
        onPointerMove={event=>{const point=pointer.current;if(!point||point.source!==p.id)return;point.x=event.clientX;point.y=event.clientY;if(!point.active&&Math.hypot(point.x-point.startX,point.y-point.startY)>6){point.active=true;event.currentTarget.setPointerCapture(event.pointerId);}if(point.active){event.preventDefault();updateDrop(point.x,point.y);if(!frame.current)frame.current=requestAnimationFrame(autoScroll);}}}
        onPointerUp={event=>{const point=pointer.current;if(!point)return;if(point.active){updateDrop(event.clientX,event.clientY);const target=drop.current;if(target)void commit(reorderIds(latestProjects.current.map(p=>p.id),target.source,target.target,target.after));suppressClick.current=true;}cancel();}}
        onPointerCancel={cancel} onLostPointerCapture={()=>{if(pointer.current)cancel();}} onContextMenu={event => { event.preventDefault(); setMenu({ id: p.id, x: event.clientX, y: event.clientY }); }}
        onKeyDown={event => { if (event.altKey && event.shiftKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); move(p.id, event.key === 'ArrowLeft' ? -1 : 1); } else if(['Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?projects[0]:projects.at(-1);if(next&&!disabled)onSelect(next.id);}else if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); const next = projects[i + (event.key === 'ArrowLeft' ? -1 : 1)]; if (next && !disabled) onSelect(next.id); } }}>
        <Icon name="folder" size={16}/><span>{p.name}</span>
      </button>)}
      <button type="button" className="project-add" aria-label="打开新项目" disabled={disabled} onClick={onOpen}><Icon name="plus" size={17}/><span>打开项目</span></button>
    </div></div>
    {overflow && <button aria-label="项目栏向右滚动" className="project-scroll" onClick={() => strip.current?.scrollBy({ left: 240, behavior: 'smooth' })}>›</button>}
    {menu && <div className="session-menu" role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 150), top: menu.y }}>
      <button role="menuitem" disabled={projects[0]?.id === menu.id} onClick={() => move(menu.id, -1)}>左移</button>
      <button role="menuitem" disabled={projects.at(-1)?.id === menu.id} onClick={() => move(menu.id, 1)}>右移</button>
      <button role="menuitem" onClick={() => setMenu(null)}>关闭菜单</button>
    </div>}
  </div>;
}
