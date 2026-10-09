import {useEffect,useLayoutEffect,useRef,useState,type CSSProperties} from 'react';
import {createPortal} from 'react-dom';
import type {SessionMonitor} from '../session-monitor.js';
import {Icon} from './Icons.js';
import {cachePercent,compactTokens,decodeSpeed,statsDuration,statsPanelPosition} from './stats-format.js';
type Panel='time'|'usage'|'context';
export function SessionStats({stats,contextTarget}:{stats?:SessionMonitor;contextTarget:HTMLElement|null}){
 const [open,setOpen]=useState<Panel|null>(null),[position,setPosition]=useState<CSSProperties|null>(null),[tooltip,setTooltip]=useState(false);
 const root=useRef<HTMLDivElement>(null),panel=useRef<HTMLDivElement>(null),triggers=useRef<Partial<Record<Panel,HTMLButtonElement|null>>>({}),hover=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 const context=stats?.context,contextKnown=context?.tokens!==null&&context?.tokens!==undefined&&context.percent!==null;
 const hasTime=!!stats&&(stats.llmMs>0||stats.toolMs>0||stats.ttftSteps>0||stats.decodeMs>0),hasUsage=!!stats&&stats.tokens.total>0;
 const available=open==='context'?contextKnown:open==='time'?hasTime:open==='usage'?hasUsage:false;
 useEffect(()=>{if(open&&!available)setOpen(null);},[open,available]);
 useEffect(()=>{if(!contextKnown){clearTimeout(hover.current);setTooltip(false);}},[contextKnown]);
 useEffect(()=>()=>clearTimeout(hover.current),[]);
 useEffect(()=>{
  if(!open)return;
  const outside=(event:PointerEvent)=>{if(!triggers.current[open]?.contains(event.target as Node)&&!panel.current?.contains(event.target as Node))setOpen(null);};
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){setOpen(null);triggers.current[open]?.focus();}};
  document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
  return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape);};
 },[open]);
 useLayoutEffect(()=>{
  if(!open||!available){setPosition(null);return;}
  const place=()=>{const anchor=triggers.current[open],surface=panel.current;if(!anchor||!surface)return;const margin=document.querySelector('.app.session-fullscreen')?12:Math.max(12,(document.querySelector('.topbar')?.getBoundingClientRect().bottom||0)+12);const rect=anchor.getBoundingClientRect(),bounds={left:rect.left,right:rect.right,top:rect.top,bottom:open==='context'?rect.bottom:root.current?.getBoundingClientRect().bottom||rect.bottom};setPosition(statsPanelPosition(bounds,{width:surface.offsetWidth,height:surface.offsetHeight},{width:window.innerWidth,height:window.innerHeight},margin,open==='context'?'above':'below'));};
  place();const observer=new ResizeObserver(place);if(panel.current)observer.observe(panel.current);if(root.current)observer.observe(root.current);const composer=contextTarget?.closest('.composer');if(composer)observer.observe(composer);
  window.addEventListener('resize',place);window.addEventListener('scroll',place,true);return()=>{observer.disconnect();window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);};
 },[open,available,stats,contextTarget]);
 if(!stats||!stats.steps&&!hasUsage&&!contextKnown)return null;
 const speed=decodeSpeed(stats.decodeTokens,stats.decodeMs),prompt=stats.tokens.input+stats.tokens.cacheRead+stats.tokens.cacheWrite,hit=cachePercent(stats.tokens.cacheRead,prompt);
 const counts=`${stats.turns} 轮 ${stats.steps} 步`,timeLabel=counts+(speed?' · '+speed:''),usageLabel=compactTokens(stats.tokens.total)+' tok'+(hit===null?'':' · 缓存命中 '+hit+'%');
 const toggle=(kind:Panel)=>{clearTimeout(hover.current);setTooltip(false);setPosition(null);setOpen(open===kind?null:kind);};
 const button=(kind:Panel,label:string,icon:'history'|'context')=><button ref={element=>{triggers.current[kind]=element;}} className="session-stat-pill" aria-label={label} aria-haspopup="dialog" aria-expanded={open===kind} onClick={()=>toggle(kind)}><Icon name={icon} size={14}/><span>{label}</span></button>;
 const exact=(n:number)=>n.toLocaleString('zh-CN');
 return <div ref={root} className="session-stats session-stats-heading" aria-label="会话监控">
  {stats.steps>0&&(hasTime?button('time',timeLabel,'history'):<span className="session-stat-pill"><Icon name="history" size={14}/>{timeLabel}</span>)}
  {hasUsage&&button('usage',usageLabel,'context')}
  {contextKnown&&contextTarget&&createPortal(<span className="session-context-anchor" onPointerEnter={()=>{if(open!=='context')hover.current=setTimeout(()=>setTooltip(true),200);}} onPointerLeave={()=>{clearTimeout(hover.current);setTooltip(false);}}>
   <button ref={element=>{triggers.current.context=element;}} className="session-stat-pill" aria-label={'上下文占用 '+context!.percent+'%'} aria-haspopup="dialog" aria-expanded={open==='context'} onClick={()=>toggle('context')} onFocus={()=>setTooltip(true)} onBlur={()=>setTooltip(false)}>
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5" className="context-ring-track"/><circle cx="7" cy="7" r="5" className="context-ring-fill" strokeDasharray={`${31.416*context!.percent!/100} 31.416`} transform="rotate(-90 7 7)"/></svg>{context!.percent}%
   </button>{tooltip&&open!=='context'&&<span role="tooltip" className="context-stat-tooltip">上下文占用 {context!.percent}%</span>}
  </span>,contextTarget)}
  {open&&available&&createPortal(<div ref={panel} className="session-stat-dialog" role="dialog" aria-label={open==='time'?'会话性能统计':open==='usage'?'会话 Token 用量':'当前上下文占用'} style={position||{visibility:'hidden',left:0,top:0}}>
   <div className="session-stat-heading"><strong>{open==='time'?'会话性能统计':open==='usage'?'会话 Token 用量':'当前上下文占用'}</strong><button aria-label="关闭统计详情" onClick={()=>{setOpen(null);triggers.current[open]?.focus();}}>×</button></div>
   {open==='time'?<><dl>
    {stats.llmMs>0&&<><dt>模型累计耗时</dt><dd>{statsDuration(stats.llmMs)}</dd></>}{stats.toolMs>0&&<><dt>工具累计耗时</dt><dd>{statsDuration(stats.toolMs)}</dd></>}
    {stats.ttftSteps>0&&<><dt>平均首 Token 时间</dt><dd>{statsDuration(stats.ttftMs/stats.ttftSteps)}</dd></>}{speed&&<><dt>输出速度（TPS）</dt><dd>{speed}</dd></>}
   </dl><p>会话累计 · {counts}。{stats.legacySteps>0&&'部分历史步骤未记录首 Token 计时。'}</p></>:open==='usage'?<><div className="stat-exact-total">{exact(stats.tokens.total)} tok</div><dl>
    {hit!==null&&<><dt>缓存命中</dt><dd>{hit}%</dd></>}<dt>未缓存输入</dt><dd>{exact(stats.tokens.input)} tok</dd><dt>缓存读取</dt><dd>{exact(stats.tokens.cacheRead)} tok</dd>{stats.tokens.cacheWrite>0&&<><dt>缓存写入</dt><dd>{exact(stats.tokens.cacheWrite)} tok</dd></>}<dt>输出</dt><dd>{exact(stats.tokens.output)} tok</dd>
   </dl><p>当前会话完整历史累计，包含已记录的压缩和工具用量；不含独立成员会话。</p></>:<><div className="stat-exact-total">{context!.percent}%</div><div className="context-stat-bar" role="meter" aria-label="上下文占用" aria-valuemin={0} aria-valuemax={100} aria-valuenow={context!.percent!}><span style={{width:context!.percent+'%'}}/></div><dl><dt>估算已用</dt><dd>~{exact(context!.tokens!)} tok</dd><dt>上下文容量</dt><dd>{exact(context!.contextWindow)} tok</dd></dl><p>当前上下文估算，会随模型切换和上下文压缩更新。</p></>}
  </div>,document.body)}
 </div>;
}
