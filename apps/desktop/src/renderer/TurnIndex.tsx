import {useEffect,useMemo,useState,type RefObject} from 'react';
import type {Message} from './types.js';

export function messageAnchor(message:Message,index:number):string {return message.id || `message-${index}`;}

/** Locate the displayed Pi user turns; conversation content remains owned by Pi. */
export function TurnIndex({messages,container,sessionId,onLocate}:{messages:Message[];container:RefObject<HTMLDivElement|null>;sessionId?:string;onLocate():void}) {
  const entries=useMemo(()=>messages.map((message,index)=>({message,id:messageAnchor(message,index)})).filter(entry=>entry.message.role==='user'),[messages]);
  const [visible,setVisible]=useState<ReadonlySet<string>>(()=>new Set());
  useEffect(()=>{
    setVisible(new Set());const root=container.current;
    if(!root || !entries.length || !('IntersectionObserver' in window)) return;
    const ids=new Set(entries.map(entry=>entry.id));const active=new Set<string>();
    const observer=new IntersectionObserver(records=>{
      for(const record of records){const id=(record.target as HTMLElement).dataset.messageId;if(!id)continue;if(record.isIntersecting)active.add(id);else active.delete(id);}
      setVisible(new Set(active));
    },{root,threshold:.2});
    for(const element of root.querySelectorAll<HTMLElement>('[data-message-id]')) if(ids.has(element.dataset.messageId || ''))observer.observe(element);
    return ()=>observer.disconnect();
  },[entries,container,sessionId]);
  if(!entries.length)return null;
  return <nav className="turn-index" aria-label="会话轮次定位"><span className="turn-index-heading">轮次</span><div className="turn-index-list">{entries.map((entry,index)=>{
    const preview=entry.message.text.trim().replace(/\s+/g,' ').slice(0,90) || '用户消息';
    return <button type="button" className={`turn-index-button ${visible.has(entry.id)?'is-visible':''}`} key={entry.id}
      data-turn-anchor={entry.id} aria-label={`定位第 ${index+1} 轮：${preview}`} aria-current={visible.has(entry.id)?'location':undefined} title={`第 ${index+1} 轮 · ${preview}`}
      onKeyDown={event=>{
        const target=event.key==='ArrowUp'?Math.max(0,index-1):event.key==='ArrowDown'?Math.min(entries.length-1,index+1):event.key==='Home'?0:event.key==='End'?entries.length-1:null;
        if(target===null)return;event.preventDefault();event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[target]?.focus();
      }}
      onClick={()=>{
        const target=[...(container.current?.querySelectorAll<HTMLElement>('[data-message-id]')||[])].find(element=>element.dataset.messageId===entry.id);
        if(!target)return;onLocate();target.scrollIntoView({block:'center',inline:'nearest',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
      }}><span>{index+1}</span><span className="turn-preview" aria-hidden="true">{preview}</span></button>;
  })}</div></nav>;
}
