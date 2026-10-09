/** DSH 4878cda behavior adaptation: 500ms dwell, 200ms pointer grace, 100ms fade, shared lazy comparison. */
import {useEffect,useId,useLayoutEffect,useRef,useState,type ReactNode,type RefObject} from 'react';
import {createPortal} from 'react-dom';
import {FileDiffView} from './DiffView.js';
import {changePreviewPosition} from './change-preview-position.js';
import {useChangeDiff,type ChangeCoordinates,type ChangeDiffCache} from './change-review.js';
function PreviewContent({cache,coordinates,path}:{cache:ChangeDiffCache;coordinates:ChangeCoordinates;path:string}){
 const state=useChangeDiff(cache,coordinates);
 return <><div className="change-preview-path">{path}</div><FileDiffView state={state} preview retry={()=>void cache.load(coordinates)}/></>;
}
export function ChangePreview({anchor,cardRef,cache,coordinates,path}:{anchor:ReactNode;cardRef:RefObject<HTMLElement|null>;cache:ChangeDiffCache;coordinates:ChangeCoordinates;path:string}){
 const [phase,setPhase]=useState<'closed'|'open'|'closing'>('closed'),[position,setPosition]=useState<ReturnType<typeof changePreviewPosition>|null>(null);
 const phaseRef=useRef(phase);phaseRef.current=phase;
 const anchorRef=useRef<HTMLSpanElement>(null),popupRef=useRef<HTMLDivElement>(null),openTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),closeTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),fadeTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 const id=useId();
 const cancelClose=()=>{clearTimeout(closeTimer.current);clearTimeout(fadeTimer.current);};
 const hide=()=>{clearTimeout(openTimer.current);cancelClose();if(phaseRef.current==='closed')return;setPhase('closing');fadeTimer.current=setTimeout(()=>setPhase('closed'),100);};
 const enter=()=>{cancelClose();if(phaseRef.current!=='closed'){setPhase('open');return;}clearTimeout(openTimer.current);openTimer.current=setTimeout(()=>setPhase('open'),500);};
 const leave=()=>{clearTimeout(openTimer.current);if(phaseRef.current==='closed')return;cancelClose();closeTimer.current=setTimeout(()=>{setPhase('closing');fadeTimer.current=setTimeout(()=>setPhase('closed'),100);},200);};
 useEffect(()=>()=>{clearTimeout(openTimer.current);clearTimeout(closeTimer.current);clearTimeout(fadeTimer.current);},[]);
 useEffect(()=>{if(phase==='closed')return;const escape=(event:KeyboardEvent)=>{if(event.key==='Escape')hide();};window.addEventListener('keydown',escape);return()=>window.removeEventListener('keydown',escape);},[phase]);
 useLayoutEffect(()=>{
  if(phase==='closed'){setPosition(null);return;}
  const place=()=>{const anchor=anchorRef.current,popup=popupRef.current,bounds=cardRef.current;if(!anchor||!popup||!bounds)return;
   const topMargin=document.querySelector('.app.session-fullscreen')?20:Math.max(8,(document.querySelector('.topbar')?.getBoundingClientRect().bottom||0)+20);
   setPosition(changePreviewPosition(anchor.getBoundingClientRect(),bounds.getBoundingClientRect(),popup.offsetHeight,{width:window.innerWidth,height:window.innerHeight},topMargin));};
  place();const observer=new ResizeObserver(place);for(const element of [anchorRef.current,popupRef.current,cardRef.current])if(element)observer.observe(element);
  window.addEventListener('resize',place);window.addEventListener('scroll',place,true);
  return()=>{observer.disconnect();window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
 },[phase,cardRef]);
 return <span className="change-preview-anchor" ref={anchorRef} onPointerEnter={enter} onPointerLeave={leave} onPointerDownCapture={event=>{if(anchorRef.current?.contains(event.target as Node))hide();}} onClickCapture={event=>{if(anchorRef.current?.contains(event.target as Node))hide();}}>
  {anchor}
  {phase!=='closed'&&createPortal(<div id={id} ref={popupRef} role="region" aria-label={'变更浮窗预览：'+path} className={'change-preview-popup '+phase} style={position?{...position,visibility:'visible'}:{left:0,top:0,maxHeight:420,visibility:'hidden'}} onPointerEnter={enter} onPointerLeave={leave}>
   <PreviewContent cache={cache} coordinates={coordinates} path={path}/>
  </div>,document.body)}
 </span>;
}
