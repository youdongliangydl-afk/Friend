import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {terminalDataAction} from './terminal-input.js';
import { asObject } from './types.js';
interface Term { id:string;name:string;owner:'user'|'agent';service:boolean;state:string;authorityEpoch:number;cwd:string;seq:number;output?:string }
export interface TerminalLayout { dock:'bottom'|'right'|'floating';height:number;width:number;left:number;top:number }
export function readTerminalLayout():TerminalLayout {
  try { const saved=JSON.parse(localStorage.getItem('friend-pi.terminal-layout.v1')||'{}');return {dock:['bottom','right','floating'].includes(saved.dock)?saved.dock:'bottom',height:Math.max(180,Math.min(Number(saved.height)||260,window.innerHeight*.7)),width:Number(saved.width)||520,left:Number(saved.left)||300,top:Number(saved.top)||130}; }
  catch { return {dock:'bottom',height:260,width:520,left:300,top:130}; }
}
function TerminalView({sessionId,record,open,report}:{sessionId:string;record:Term;open:boolean;report(message:string,error?:boolean):void}){
  const host=useRef<HTMLDivElement>(null),view=useRef<Terminal | undefined>(undefined),fit=useRef<FitAddon | undefined>(undefined);
  const current=useRef(record);current.current=record;
  useEffect(()=>{
    if(!host.current)return;
    const terminal=new Terminal({fontFamily:'ui-monospace, SFMono-Regular, Menlo, monospace',fontSize:13,convertEol:false,cursorBlink:true,scrollback:4000,theme:{background:'#18231e',foreground:'#e6eee8',cursor:'#b8d7c0'}}),addon=new FitAddon();
    terminal.loadAddon(addon);terminal.open(host.current);view.current=terminal;fit.current=addon;
    let loaded=false;const queued:{data:string;seq:number}[]=[];
    void window.friendPi.request<Term>('terminal.read',{sessionId,id:record.id}).then(snapshot=>{terminal.write(snapshot.output||'');loaded=true;for(const data of queued)if(data.seq>snapshot.seq)terminal.write(data.data);}).catch(error=>report(String(error),true));
    const unsubscribe=window.friendPi.onEvent(event=>{
      if(String(event.type)!=='terminal')return;const data=asObject(event.data);
      if(data.id!==record.id||data.kind!=='output')return;
      if(!loaded)queued.push({data:String(data.data||''),seq:Number(data.seq)});else terminal.write(String(data.data||''));
    });
    let inputQueue=Promise.resolve(),userIntent=false;
    const intent=(event:Event)=>{if(event.isTrusted)userIntent=true;};
    const key=terminal.onKey(()=>{userIntent=true;});
    for(const name of ['paste','compositionend','beforeinput','input'])host.current.addEventListener(name,intent,true);
    const input=terminal.onData(data=>{if(!data||current.current.state!=='running')return;const action=terminalDataAction(data,userIntent);if(action==='input')userIntent=false;if(action==='ignore')return;inputQueue=inputQueue.then(()=>window.friendPi.request('terminal.'+action,{sessionId,id:record.id,data})).then(()=>{}).catch(error=>report(String(error),true));});
    const resize=()=>{if(!host.current||host.current.clientWidth<20||host.current.clientHeight<20)return;addon.fit();void window.friendPi.request('terminal.resize',{sessionId,id:record.id,cols:terminal.cols,rows:terminal.rows}).catch(()=>{});};
    const observer=new ResizeObserver(resize);observer.observe(host.current);resize();
    return()=>{for(const name of ['paste','compositionend','beforeinput','input'])host.current?.removeEventListener(name,intent,true);unsubscribe();key.dispose();input.dispose();observer.disconnect();terminal.dispose();view.current=undefined;fit.current=undefined;};
  },[record.id,sessionId]);
  useEffect(()=>{if(open){requestAnimationFrame(()=>{fit.current?.fit();view.current?.focus();});}},[open]);
  return <div className="terminal-screen" aria-label={'终端 '+record.name} ref={host}/>;
}
export function TerminalPanel({sessionId,open,version,onHide,report,onLayoutChange}:{sessionId:string;open:boolean;version:number;onHide():void;report(message:string,error?:boolean):void;onLayoutChange?(layout:TerminalLayout):void}){
  const [layout,setLayout]=useState(readTerminalLayout),[terms,setTerms]=useState<Term[]>([]),[selected,setSelected]=useState(''),[busy,setBusy]=useState(false);
  const [closed,setClosed]=useState<Set<string>>(()=>new Set()),[showEnded,setShowEnded]=useState(false);
  const mounted=useRef(true),owner=useRef(sessionId);owner.current=sessionId;
  const gesture=useRef<{x:number;y:number;layout:TerminalLayout;mode:'move'|'resize'} | undefined>(undefined);
  const refresh=async()=>{
    const target=sessionId;
    try { const result=await window.friendPi.request<{terminals:Term[]}>('terminal.list',{sessionId:target});if(!mounted.current||owner.current!==target)return;setTerms(result.terminals);setSelected(old=>result.terminals.some(t=>t.id===old)?old:result.terminals.find(t=>!closed.has(t.id))?.id||''); }
    catch(error){report(String(error),true);}
  };
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{setTerms([]);setSelected('');try{setClosed(new Set(JSON.parse(localStorage.getItem('friend-pi.terminal-closed:'+sessionId)||'[]')));}catch{setClosed(new Set());}if(open)void refresh();},[sessionId]);
  useEffect(()=>{if(open)void refresh();},[open,version]);
  useEffect(()=>{try{localStorage.setItem('friend-pi.terminal-layout.v1',JSON.stringify(layout));localStorage.setItem('friend-pi.terminal-closed:'+sessionId,JSON.stringify([...closed]));}catch{}onLayoutChange?.(layout);},[layout,closed,sessionId]);
  const create=async()=>{if(busy)return;setBusy(true);try{const result=await window.friendPi.request<Term>('terminal.create',{sessionId});if(owner.current===sessionId){await refresh();setSelected(result.id);}}catch(error){report(String(error),true);}finally{setBusy(false);}};
  const stop=async(record:Term)=>{setBusy(true);try{const result=await window.friendPi.request<Term>('terminal.stop',{sessionId,id:record.id});if(result.state!=='exited'&&result.state!=='interrupted')throw new Error('终端清理尚未完成，请检查保留记录');setClosed(old=>new Set([...old,record.id]));await refresh();}catch(error){report(String(error),true);}finally{setBusy(false);}};
  const visible=terms.filter(t=>showEnded||!closed.has(t.id)),current=visible.find(t=>t.id===selected)||visible[0];
  const begin=(event:React.PointerEvent<HTMLButtonElement>,mode:'move'|'resize')=>{if(event.button!==0)return;event.currentTarget.setPointerCapture(event.pointerId);gesture.current={x:event.clientX,y:event.clientY,layout,mode};};
  const move=(event:React.PointerEvent<HTMLButtonElement>)=>{
    const start=gesture.current;if(!start)return;event.preventDefault();const dx=event.clientX-start.x,dy=event.clientY-start.y;
    if(start.mode==='move')setLayout({...start.layout,dock:'floating',left:Math.max(12,Math.min(window.innerWidth-start.layout.width-12,start.layout.left+dx)),top:Math.max(65,Math.min(window.innerHeight-180,start.layout.top+dy))});
    else if(start.layout.dock==='bottom')setLayout({...start.layout,height:Math.max(180,Math.min(window.innerHeight*.7,start.layout.height-dy))});
    else setLayout({...start.layout,width:Math.max(360,Math.min(window.innerWidth-40,start.layout.width+(start.layout.dock==='right'?-dx:dx))),height:Math.max(180,Math.min(window.innerHeight-100,start.layout.height+dy))});
  };
  const finish=(event:React.PointerEvent<HTMLButtonElement>)=>{move(event);if(gesture.current?.mode==='move'){if(event.clientX>window.innerWidth-36)setLayout(old=>({...old,dock:'right'}));else if(event.clientY>window.innerHeight-36)setLayout(old=>({...old,dock:'bottom'}));}gesture.current=undefined;if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);};
  const handlers={onPointerMove:move,onPointerUp:finish,onPointerCancel:()=>{gesture.current=undefined;},onLostPointerCapture:()=>{gesture.current=undefined;}};
  return <section hidden={!open} className={'terminal-panel dock-'+layout.dock} aria-label="内嵌终端" style={layout.dock==='floating'?{left:layout.left,top:layout.top,width:Math.min(layout.width,window.innerWidth-24),height:layout.height}:layout.dock==='right'?{width:layout.width}:undefined}>
    <button className={'terminal-resize resize-'+layout.dock} aria-label="调整终端大小" onPointerDown={event=>begin(event,'resize')} {...handlers} onKeyDown={event=>{if(['ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();setLayout(old=>({...old,height:Math.max(180,Math.min(window.innerHeight*.7,old.height+(event.key==='ArrowUp'?20:-20)))}));}}}/>
    <header className="terminal-heading"><button className="terminal-move" aria-label="移动终端面板" onPointerDown={event=>begin(event,'move')} {...handlers}>⠿ 终端</button><select aria-label="终端停靠位置" value={layout.dock} onChange={event=>setLayout(old=>({...old,dock:event.target.value as TerminalLayout['dock']}))}><option value="bottom">底部</option><option value="right">右侧</option><option value="floating">浮窗</option></select><button aria-label="新建终端" disabled={busy} onClick={()=>void create()}>＋</button><button aria-pressed={showEnded} onClick={()=>setShowEnded(v=>!v)}>已结束</button><span className="terminal-heading-space"/><button aria-label="隐藏终端面板" onClick={onHide}>×</button></header>
    <nav className="terminal-tabs" aria-label="终端标签">{visible.map(t=><div className={current?.id===t.id?'selected':''} key={t.id}><button aria-pressed={current?.id===t.id} onClick={()=>setSelected(t.id)}>{t.name}{t.state!=='running'?' · '+(t.state==='interrupted'?'已中断':t.state==='exited'?'已结束':t.state):''}</button><button aria-label={'关闭终端 '+t.name} disabled={busy} onClick={()=>void stop(t)}>×</button></div>)}</nav>
    {current?<><div className="terminal-status"><span>{current.cwd}</span><strong>{current.owner==='agent'?'Agent 控制':'用户控制'}</strong>{current.service&&current.owner==='user'&&current.state==='running'&&<button onClick={()=>void window.friendPi.request('terminal.release',{sessionId,id:current.id}).then(refresh).catch(error=>report(String(error),true))}>交还 Agent</button>}</div><TerminalView key={sessionId+':'+current.id} sessionId={sessionId} record={current} open={open} report={report}/></>:<div className="terminal-empty"><p>在当前会话的工作目录运行命令。</p><button disabled={busy} onClick={()=>void create()}>{busy?'正在创建…':'新建终端'}</button></div>}
  </section>;
}
