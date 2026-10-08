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
  const strip = useRef<HTMLDivElement>(null),edge=useRef(0),frame=useRef(0);
  const cancelScroll=()=>{edge.current=0;cancelAnimationFrame(frame.current);frame.current=0;};
  const autoScroll=()=>{const el=strip.current;if(el&&edge.current)el.scrollLeft+=edge.current;frame.current=requestAnimationFrame(autoScroll);};
  useEffect(()=>cancelScroll,[]);
  const [drag, setDrag] = useState<{ source: string; target: string; after: boolean } | null>(null);
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
    <div role="tablist" aria-label="项目" className="project-tab-group"><button type="button" role="tab" data-project-id="temporary" aria-selected={!selected} className={'project-tab temporary-tab ' + (!selected ? 'active' : '')} disabled={disabled && !!selected} onClick={() => onSelect('')}>临时会话</button><div ref={strip} className="project-tabs" onDragOver={event=>{event.preventDefault();const bounds=event.currentTarget.getBoundingClientRect();edge.current=event.clientX<bounds.left+44?-12:event.clientX>bounds.right-44?12:0;if(!frame.current)frame.current=requestAnimationFrame(autoScroll);}} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))cancelScroll();}}>
      {projects.map((p, i) => <button key={p.id} type="button" role="tab" data-project-id={p.id} aria-selected={selected === p.id}
        draggable className={'project-tab ' + (selected === p.id ? 'active ' : '') + (drag?.target === p.id ? drag.after ? 'drop-after' : 'drop-before' : '')}
        title={p.path} onClick={() => { if (!disabled) onSelect(p.id); }}
        onDragStart={event => { event.dataTransfer.setData('text/plain', p.id); event.dataTransfer.effectAllowed = 'move'; setDrag({ source: p.id, target: p.id, after: false }); }}
        onDragOver={event => {
          event.preventDefault(); const box = event.currentTarget.getBoundingClientRect();
          const source = drag?.source; if (source) setDrag({ source, target: p.id, after: event.clientX > box.left + box.width / 2 });
          
        }}
        onDrop={event => { event.preventDefault(); if (drag) void commit(reorderIds(projects.map(x => x.id), drag.source, p.id, drag.after)); }}
        onDragEnd={() => {cancelScroll();setDrag(null);}} onContextMenu={event => { event.preventDefault(); setMenu({ id: p.id, x: event.clientX, y: event.clientY }); }}
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
