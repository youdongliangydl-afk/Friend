import {useEffect,useMemo,useRef,useState,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import type {Message} from './types.js';
import {Icon} from './Icons.js';

export function messageAnchor(message:Message,index:number):string{return message.id || `message-${index}`;}
const compact=(value:string)=>value.trim().replace(/\s+/g,' ');

/** Only source IDs are bookmarked; preview text comes from the current Pi history snapshot. */
export function TurnIndex({messages,container,sessionId,onLocate}:{messages:Message[];container:RefObject<HTMLDivElement|null>;sessionId?:string;onLocate():void}) {
  const entries=useMemo(()=>messages.flatMap((message,index)=>{
    if(message.role!=='user')return [];
    return [{message,id:messageAnchor(message,index)}];
  }),[messages]);
  const [active,setActive]=useState<string>();
  const [bookmarks,setBookmarks]=useState<string[]>([]);
  const [preview,setPreview]=useState<{id:string;left:number;top:number;width:number}|null>(null);
  const closeTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const bubble=useRef<HTMLDivElement>(null);
  const cancelClose=()=>{if(closeTimer.current){clearTimeout(closeTimer.current);closeTimer.current=undefined;}};
  const closeSoon=()=>{cancelClose();closeTimer.current=setTimeout(()=>setPreview(null),140);};
  useEffect(()=>{
    let saved:string[]=[];try{const raw=JSON.parse(localStorage.getItem(`friend-pi.turn-bookmarks.v1:${sessionId}`)||'[]');if(Array.isArray(raw))saved=raw.filter((id):id is string=>typeof id==='string');}catch{}
    setBookmarks(saved);setPreview(null);setActive(undefined);
  },[sessionId]);
  useEffect(()=>()=>cancelClose(),[]);
  useEffect(()=>{
    const root=container.current;if(!root||!entries.length||!('IntersectionObserver' in window))return;
    const ids=new Set(entries.map(entry=>entry.id));const visible=new Map<string,number>();
    const observer=new IntersectionObserver(records=>{
      for(const record of records){const id=(record.target as HTMLElement).dataset.messageId;if(!id)continue;if(record.isIntersecting)visible.set(id,record.boundingClientRect.top);else visible.delete(id);}
      const current=[...visible].sort((a,b)=>a[1]-b[1])[0]?.[0];if(current)setActive(current);
    },{root,threshold:.15});
    for(const target of root.querySelectorAll<HTMLElement>('[data-message-id]'))if(ids.has(target.dataset.messageId||''))observer.observe(target);
    return ()=>observer.disconnect();
  },[entries,container,sessionId]);
  useEffect(()=>{const clear=()=>setPreview(null);window.addEventListener('resize',clear);return()=>window.removeEventListener('resize',clear);},[]);
  if(!entries.length)return null;
  const show=(id:string,target:HTMLElement)=>{
    cancelClose();const bounds=target.getBoundingClientRect();const left=bounds.right+13;const width=Math.max(190,Math.min(395,window.innerWidth-left-16));
    setPreview({id,left,top:Math.max(12,Math.min(bounds.top-18,window.innerHeight-148)),width});
  };
  const selected=entries.find(entry=>entry.id===preview?.id);
  const toggleBookmark=(id:string)=>{
    const next=bookmarks.includes(id)?bookmarks.filter(item=>item!==id):[...bookmarks,id];setBookmarks(next);
    try{localStorage.setItem(`friend-pi.turn-bookmarks.v1:${sessionId}`,JSON.stringify(next));}catch{}
  };
  return <><nav className="turn-index" aria-label="会话轮次定位"><div className="turn-index-list">{entries.map((entry,index)=><button type="button"
    className={`turn-index-button ${active===entry.id?'is-active':''} ${bookmarks.includes(entry.id)?'is-bookmarked':''}`} key={entry.id}
    data-turn-anchor={entry.id} aria-label={`定位第 ${index+1} 轮：${compact(entry.message.text).slice(0,80)}`} aria-current={active===entry.id?'location':undefined}
    aria-describedby={preview?.id===entry.id?'turn-preview-bubble':undefined}
    onMouseEnter={event=>show(entry.id,event.currentTarget)} onMouseLeave={closeSoon} onFocus={event=>show(entry.id,event.currentTarget)}
    onBlur={event=>{if(!bubble.current?.contains(event.relatedTarget as Node|null))closeSoon();}}
    onKeyDown={event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setPreview(null);return;}
      if(event.key==='ArrowRight'){event.preventDefault();bubble.current?.querySelector<HTMLButtonElement>('button')?.focus();return;}
      if(event.key.toLowerCase()==='b'&&!event.metaKey&&!event.ctrlKey){event.preventDefault();toggleBookmark(entry.id);return;}
      const target=event.key==='ArrowUp'?Math.max(0,index-1):event.key==='ArrowDown'?Math.min(entries.length-1,index+1):event.key==='Home'?0:event.key==='End'?entries.length-1:null;
      if(target===null)return;event.preventDefault();event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[target]?.focus();
    }}
    onClick={()=>{
      const target=[...(container.current?.querySelectorAll<HTMLElement>('[data-message-id]')||[])].find(element=>element.dataset.messageId===entry.id);
      if(!target)return;onLocate();setActive(entry.id);target.scrollIntoView({block:'center',inline:'nearest',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
    }}><span className="turn-index-line" aria-hidden="true"/></button>)}</div></nav>
    {preview&&selected&&createPortal(<div ref={bubble} id="turn-preview-bubble" className="turn-preview-bubble" role="region" aria-label="轮次预览"
      style={{left:preview.left,top:preview.top,width:preview.width}} onMouseEnter={cancelClose} onMouseLeave={closeSoon} onFocus={cancelClose}
      onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();const target=[...document.querySelectorAll<HTMLButtonElement>('[data-turn-anchor]')].find(element=>element.dataset.turnAnchor===preview.id);target?.focus();setPreview(null);}}}
      onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))closeSoon();}}>
      <div className="turn-preview-heading"><p>{selected.message.userText??selected.message.text}</p><button type="button" className={`bookmark-button ${bookmarks.includes(selected.id)?'selected':''}`}
        aria-label={bookmarks.includes(selected.id)?'取消轮次书签':'收藏这一轮'} aria-pressed={bookmarks.includes(selected.id)} title={bookmarks.includes(selected.id)?'取消书签':'添加书签'} onClick={()=>toggleBookmark(selected.id)}><Icon name="bookmark" size={16}/></button></div>
    </div>,document.body)}
  </>;
}
