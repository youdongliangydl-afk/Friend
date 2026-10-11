import {useEffect,useId,useLayoutEffect,useMemo,useRef,useState,type PointerEvent as ReactPointerEvent} from 'react';
import {Empty,JsonView,Markdown} from './ui.js';
import {statusLabels} from './types.js';
import type {TaskGraph,TaskGraphNode} from './task-graph-model.js';
import {centerTaskGraph,fitTaskGraph,graphMiniMap,layoutTaskGraph,zoomTaskGraph,type GraphViewport,type TaskGraphLayout} from './task-graph-layout.js';

const label=(status:string)=>({unknown:'结果待核对',unavailable:'状态待核对',skipped:'已跳过',waiting_review:'等待复核'}[status]||statusLabels[status]||status||'状态待核对');
const color=(status:string)=>status==='completed'?'#4b8068':status==='running'?'#659f89':['failed','blocked','unknown'].includes(status)?'#bd8c58':'#b8c8bc';

export function TaskGraphCanvas({graphs,onOpenMember,loading=false,error}:{graphs:TaskGraph[];onOpenMember(memberId:string):void;loading?:boolean;error?:string}){
 const [choice,setChoice]=useState(''),[selection,setSelection]=useState<{key:string;id:string}>(),[view,setView]=useState<GraphViewport>({x:0,y:0,zoom:1}),[size,setSize]=useState({width:0,height:0}),[dragging,setDragging]=useState(false);
 const graph=graphs.find(item=>item.key===choice)||graphs[0],selected=graph&&selection?.key===graph.key?graph.nodes.find(node=>node.id===selection.id):undefined;
 const layouts=useRef(new Map<string,{structure:string;layout:TaskGraphLayout}>());
 const layout=useMemo(()=>{if(!graph)return layoutTaskGraph([]);const saved=layouts.current.get(graph.key);if(saved?.structure===graph.structureKey)return saved.layout;const next=layoutTaskGraph(graph.nodes,saved?.layout);layouts.current.set(graph.key,{structure:graph.structureKey,layout:next});return next;},[graph?.key,graph?.structureKey]);
 const stage=useRef<HTMLDivElement>(null),detail=useRef<HTMLElement>(null),manual=useRef(false),viewRef=useRef(view);viewRef.current=view;
 const previous=useRef<{key:string;layout:TaskGraphLayout;size:{width:number;height:number}}|undefined>(undefined);
 const pan=useRef<{id:number;x:number;y:number;view:GraphViewport}|undefined>(undefined),miniDrag=useRef<number|undefined>(undefined),buttons=useRef(new Map<string,HTMLButtonElement>());
 const marker=useId().replace(/[^\w-]/g,'');
 const fit=()=>{manual.current=false;setView(fitTaskGraph(layout,size));};
 const zoom=(factor:number,anchor={x:size.width/2,y:size.height/2})=>{manual.current=true;setView(current=>zoomTaskGraph(current,current.zoom*factor,anchor,fitTaskGraph(layout,size).zoom));};
 useEffect(()=>{if(graph&&choice!==graph.key)setChoice(graph.key);},[graph?.key,choice]);
 useLayoutEffect(()=>{const element=stage.current;if(!element)return;const measure=()=>setSize(old=>old.width===element.clientWidth&&old.height===element.clientHeight?old:{width:element.clientWidth,height:element.clientHeight});measure();const observer=new ResizeObserver(measure);observer.observe(element);return()=>observer.disconnect();},[graph?.key]);
 useLayoutEffect(()=>{
  if(!graph||!size.width||!size.height)return;const prior=previous.current;
  if(prior?.key!==graph.key){manual.current=false;setView(fitTaskGraph(layout,size));}
  else if(!manual.current)setView(fitTaskGraph(layout,size));
  else if(prior.size.width!==size.width||prior.size.height!==size.height)setView(current=>({...current,x:current.x+(size.width-prior.size.width)/2,y:current.y+(size.height-prior.size.height)/2}));
  else if(prior.layout!==layout&&selected){const old=prior.layout.nodes.find(node=>node.id===selected.id),next=layout.nodes.find(node=>node.id===selected.id);if(old&&next)setView(current=>({...current,x:current.x+(old.x-next.x)*current.zoom,y:current.y+(old.y-next.y)*current.zoom}));}
  previous.current={key:graph.key,layout,size};
 },[graph?.key,layout,size.width,size.height]);
 useEffect(()=>{const element=stage.current;if(!element)return;const wheel=(event:WheelEvent)=>{if((event.target as Element).closest('.task-graph-controls,.task-graph-minimap'))return;event.preventDefault();manual.current=true;const multiplier=event.deltaMode===1?16:event.deltaMode===2?element.clientHeight:1;
   if(event.ctrlKey||event.metaKey){const bounds=element.getBoundingClientRect(),delta=Math.max(-80,Math.min(80,event.deltaY*multiplier));setView(current=>zoomTaskGraph(current,current.zoom*Math.exp(-delta*.006),{x:event.clientX-bounds.left,y:event.clientY-bounds.top},fitTaskGraph(layout,{width:element.clientWidth,height:element.clientHeight}).zoom));}
   else setView(current=>({...current,x:current.x-event.deltaX*multiplier,y:current.y-event.deltaY*multiplier}));};element.addEventListener('wheel',wheel,{passive:false});return()=>element.removeEventListener('wheel',wheel);},[graph?.key,layout]);
 const select=(node:TaskGraphNode,focusDetail=false)=>{manual.current=true;setSelection({key:graph.key,id:node.id});if(focusDetail)requestAnimationFrame(()=>detail.current?.focus({preventScroll:true}));};
 const closeDetail=()=>{const id=selected?.id;setSelection(undefined);requestAnimationFrame(()=>{if(id)buttons.current.get(id)?.focus({preventScroll:true});});};
 const ensureVisible=(id:string)=>{const rect=layout.nodes.find(node=>node.id===id);if(!rect)return;const current=viewRef.current;if(rect.x*current.zoom+current.x<0||rect.y*current.zoom+current.y<0||(rect.x+rect.width)*current.zoom+current.x>size.width||(rect.y+rect.height)*current.zoom+current.y>size.height){manual.current=true;setView(centerTaskGraph(current,{x:rect.x+rect.width/2,y:rect.y+rect.height/2},size));}};
 const mini=graphMiniMap(layout,size,view),miniPoint=(event:ReactPointerEvent<SVGSVGElement>)=>{const bounds=event.currentTarget.getBoundingClientRect();manual.current=true;setView(current=>centerTaskGraph(current,{x:((event.clientX-bounds.left)*160/bounds.width-mini.x)/mini.scale,y:((event.clientY-bounds.top)*100/bounds.height-mini.y)/mini.scale},size));};
 if(!graph)return <div className="friend-task-graph"><Empty title={loading?'正在读取任务依赖图…':'本轮尚未建立任务依赖图'}/>{error&&<p role="alert">{error}</p>}</div>;
 const byId=new Map(graph.nodes.map(node=>[node.id,node]));
 return <section className="friend-task-graph" aria-label="任务卡片依赖图">
  <header className="task-graph-heading"><div><h3>任务依赖图</h3><p>{graph.kind==='workflow'?'工作流':'Swarm'} · {label(graph.status)} · {graph.nodes.length} 个任务{loading?' · 更新中':''}</p></div><label>当前图<select aria-label="选择任务依赖图" value={graph.key} onChange={event=>{setChoice(event.target.value);setSelection(undefined);}}>{graphs.map(item=><option key={item.key} value={item.key}>{item.title}</option>)}</select></label></header>
  {(graph.warning||layout.invalid||error)&&<p className="task-graph-warning" role="status">{[graph.warning,layout.invalid?'部分依赖来源异常，未推测或修改任务关系':'',error?`刷新失败，保留上次图：${error}`:''].filter(Boolean).join('；')}</p>}
  <div className={'task-graph-body'+(selected?' has-detail':'')}>
   <div className={'task-graph-stage'+(dragging?' is-panning':'')} ref={stage} tabIndex={0} role="region" aria-label="只读任务画布" aria-describedby={'task-graph-help-'+marker}
    onPointerDown={event=>{if(event.button!==0||pan.current||(event.target as Element).closest('button,.task-graph-minimap'))return;event.currentTarget.setPointerCapture(event.pointerId);pan.current={id:event.pointerId,x:event.clientX,y:event.clientY,view:viewRef.current};}}
    onPointerMove={event=>{const start=pan.current;if(!start||start.id!==event.pointerId)return;const dx=event.clientX-start.x,dy=event.clientY-start.y;if(Math.abs(dx)+Math.abs(dy)<4&&!dragging)return;manual.current=true;setDragging(true);setView({...start.view,x:start.view.x+dx,y:start.view.y+dy});}}
    onPointerUp={()=>{pan.current=undefined;setDragging(false);}} onPointerCancel={()=>{pan.current=undefined;setDragging(false);}} onLostPointerCapture={()=>{pan.current=undefined;setDragging(false);}}
    onKeyDown={event=>{if(event.target!==event.currentTarget||event.ctrlKey||event.metaKey||event.nativeEvent.isComposing)return;if(event.key==='Escape'&&selected){event.preventDefault();closeDetail();return;}if(!['+','=','-','0','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();if(event.key==='0')fit();else if(['+','=','-'].includes(event.key))zoom(event.key==='-'?1/1.25:1.25);else {manual.current=true;setView(current=>({...current,x:current.x+(event.key==='ArrowLeft'?64:event.key==='ArrowRight'?-64:0),y:current.y+(event.key==='ArrowUp'?64:event.key==='ArrowDown'?-64:0)}));}}}>
    <div className="task-graph-world" style={{width:layout.width,height:layout.height,transform:`translate(${view.x}px,${view.y}px) scale(${view.zoom})`}}>
     <svg className="task-graph-edges" width={layout.width} height={layout.height} aria-hidden="true"><defs><marker id={marker} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#839b8c"/></marker></defs>{layout.edges.map(edge=><path key={edge.from+'\0'+edge.to} d={edge.path} markerEnd={`url(#${marker})`} className={selected?(edge.from===selected.id||edge.to===selected.id?'is-related':'is-muted'):''}/>)}</svg>
     {layout.nodes.map(rect=>{const node=byId.get(rect.id)!;return <button className={'task-graph-node'+(selected?.id===node.id?' selected':'')} type="button" key={node.id} style={{left:rect.x,top:rect.y,width:rect.width,height:rect.height}} ref={element=>{if(element)buttons.current.set(node.id,element);else buttons.current.delete(node.id);}} onFocus={()=>ensureVisible(node.id)} onClick={()=>select(node)} onKeyDown={event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select(node,true);}}} aria-label={`${node.title}，${label(node.status)}，${node.memberName||'尚未分配队友'}${node.waitingReason?'，'+node.waitingReason:''}`} aria-pressed={selected?.id===node.id}>
      <strong title={node.title}>{node.title}</strong><span className="task-graph-node-meta"><i style={{background:color(node.status)}}/>{label(node.status)}<small>{node.mode==='write'?'写入':node.mode==='read'?'只读':''}</small></span><span className="task-graph-node-member">{node.memberName|| (node.memberId?'队友资料待刷新':'尚未分配队友')}</span>{node.waitingReason&&<span className="task-graph-node-wait" title={node.waitingReason}>{node.waitingReason}</span>}
     </button>;})}
    </div>
    <div className="task-graph-controls" role="toolbar" aria-label="画布视图控制"><button aria-label="缩小画布" onClick={()=>zoom(1/1.25)}>−</button><output aria-label="画布缩放比例">{Math.round(view.zoom*1000)/10}%</output><button aria-label="放大画布" onClick={()=>zoom(1.25)}>＋</button><button onClick={fit}>适配全部</button></div>
    <svg className="task-graph-minimap" viewBox="0 0 160 100" role="img" aria-label="任务小地图，点击或拖动定位画布" tabIndex={0}
     onPointerDown={event=>{event.stopPropagation();miniDrag.current=event.pointerId;event.currentTarget.setPointerCapture(event.pointerId);miniPoint(event);}} onPointerMove={event=>{if(miniDrag.current===event.pointerId)miniPoint(event);}} onPointerUp={()=>{miniDrag.current=undefined;}} onPointerCancel={()=>{miniDrag.current=undefined;}}
     onKeyDown={event=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();manual.current=true;setView(current=>({...current,x:current.x+(event.key==='ArrowLeft'?64:event.key==='ArrowRight'?-64:0),y:current.y+(event.key==='ArrowUp'?64:event.key==='ArrowDown'?-64:0)}));}}>
     <rect width="160" height="100" fill="#f7faf6"/>{layout.nodes.map(node=><rect key={node.id} x={mini.x+node.x*mini.scale} y={mini.y+node.y*mini.scale} width={node.width*mini.scale} height={node.height*mini.scale} fill={color(byId.get(node.id)!.status)}/>)}<rect className="task-graph-minimap-view" {...mini.viewport}/>
    </svg>
   </div>
   {selected&&<aside className="task-graph-detail" ref={detail} tabIndex={-1} aria-label={'任务详情 '+selected.title} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeDetail();}}}>
    <header><h3>{selected.title}</h3><button aria-label="关闭任务详情" onClick={closeDetail}>×</button></header><p className="task-graph-detail-status">{label(selected.status)} · {selected.mode==='write'?'写入任务':selected.mode==='read'?'只读任务':'执行范围待核对'}</p>{selected.waitingReason&&<p>{selected.waitingReason}</p>}
    {selected.memberId&&<button onClick={()=>onOpenMember(selected.memberId!)}>打开{selected.memberName||'队友'}会话 ↗</button>}
    <h4>任务要求</h4><Markdown text={selected.prompt||'尚无可读任务要求'}/><h4>前置任务</h4><p>{selected.dependencies.map(id=>byId.get(id)?.title||id).join('、')||'无'}</p>
    {selected.writeScopes.length>0&&<><h4>写入范围</h4><p>{selected.writeScopes.join('、')}</p></>}
    <h4>{selected.status==='unknown'?'已保存成果（需核对）':'当前成果'}{selected.resultRevision?` · v${selected.resultRevision}`:''}</h4><Markdown text={selected.summary||selected.error||'尚未形成已保存成果；查看不会启动执行。'}/>
    <details><summary>任务与当前尝试记录</summary><JsonView value={Object.fromEntries(Object.entries(selected.detail).filter(([key])=>!['checks','review'].includes(key)))}/></details>
    {(selected.detail.checks!==undefined||selected.detail.review!==undefined)&&<details><summary>整图检查与复核</summary><JsonView value={{checks:selected.detail.checks,review:selected.detail.review}}/></details>}
   </aside>}
  </div>
  <p className="task-graph-help" id={'task-graph-help-'+marker}>拖动空白处或双指移动平移 · Ctrl/⌘＋滚轮缩放 · 画布聚焦后方向键平移、＋/− 缩放、0 适配 · 点击任务查看详情</p>
 </section>;
}
