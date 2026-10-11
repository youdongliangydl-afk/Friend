import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import {terminalDataAction} from './terminal-input.js';
import { asObject } from './types.js';
import {Icon} from './Icons.js';
interface Term { id:string;name:string;owner:'user'|'agent';service:boolean;state:string;authorityEpoch:number;cwd:string;seq:number;output?:string }
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
export function TerminalPanel({sessionId,open,version,target,report,notice}:{sessionId:string;open:boolean;version:number;target?:{id:string};report(message:string,error?:boolean):void;notice?:ReactNode}){
  const [terms,setTerms]=useState<Term[]>([]),[selected,setSelected]=useState(''),[busy,setBusy]=useState(false);
  const [closed,setClosed]=useState<Set<string>>(()=>new Set()),[showEnded,setShowEnded]=useState(false);
  const mounted=useRef(true),owner=useRef(sessionId),refreshVersion=useRef(0);owner.current=sessionId;
  const refresh=async()=>{
    const target=sessionId,request=++refreshVersion.current;
    try { const result=await window.friendPi.request<{terminals:Term[]}>('terminal.list',{sessionId:target});if(!mounted.current||owner.current!==target||request!==refreshVersion.current)return;setTerms(result.terminals);setSelected(old=>result.terminals.some(t=>t.id===old)?old:result.terminals.find(t=>!closed.has(t.id))?.id||''); }
    catch(error){report(String(error),true);}
  };
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{setTerms([]);setSelected('');try{setClosed(new Set(JSON.parse(localStorage.getItem('friend-pi.terminal-closed:'+sessionId)||'[]')));}catch{setClosed(new Set());}if(open)void refresh();},[sessionId]);
  useEffect(()=>{if(open)void refresh();},[open,version]);
  useEffect(()=>{if(target){setSelected(target.id);setClosed(old=>{const next=new Set(old);next.delete(target.id);return next;});void refresh();}},[target]);
  useEffect(()=>{try{localStorage.setItem('friend-pi.terminal-closed:'+sessionId,JSON.stringify([...closed]));}catch{}},[closed,sessionId]);
  const create=async()=>{if(busy)return;setBusy(true);try{const result=await window.friendPi.request<Term>('terminal.create',{sessionId});if(owner.current===sessionId){await refresh();setSelected(result.id);}}catch(error){report(String(error),true);}finally{setBusy(false);}};
  const stop=async(record:Term)=>{setBusy(true);try{const result=await window.friendPi.request<Term>('terminal.stop',{sessionId,id:record.id});if(result.state!=='exited'&&result.state!=='interrupted')throw new Error('终端清理尚未完成，请检查保留记录');setClosed(old=>new Set([...old,record.id]));await refresh();}catch(error){report(String(error),true);}finally{setBusy(false);}};
  const visible=terms.filter(t=>showEnded||!closed.has(t.id)),current=visible.find(t=>t.id===selected)||visible[0];
  return <section hidden={!open} className="terminal-panel terminal-tab-page" aria-label="内嵌终端">
    <header className="terminal-toolbar" aria-label="终端工具栏">
      <nav className="terminal-tabs" aria-label="终端标签">{visible.map(t=><div className={current?.id===t.id?'selected':''} key={t.id}><button aria-pressed={current?.id===t.id} onClick={()=>setSelected(t.id)} title={t.name}><span>{t.name}</span>{t.state!=='running'&&<small>{t.state==='interrupted'?'已中断':t.state==='exited'?'已结束':t.state}</small>}</button><button aria-label={'关闭终端 '+t.name} disabled={busy} onClick={()=>void stop(t)}>×</button></div>)}</nav>
      {current&&<span className="terminal-path" title={current.cwd}>{current.cwd}</span>}
      <div className="terminal-actions">{current&&<span className="terminal-owner">{current.owner==='agent'?'Agent 控制':'用户控制'}</span>}{current?.service&&current.owner==='user'&&current.state==='running'&&<button onClick={()=>void window.friendPi.request('terminal.release',{sessionId,id:current.id}).then(refresh).catch(error=>report(String(error),true))}>交还 Agent</button>}<button aria-label={showEnded?'隐藏已结束终端':'显示已结束终端'} title={showEnded?'隐藏已结束终端':'显示已结束终端'} aria-pressed={showEnded} onClick={()=>setShowEnded(v=>!v)}><Icon name="history" size={15}/></button><button aria-label="新建终端" title="新建终端" disabled={busy} onClick={()=>void create()}><Icon name="plus" size={17}/></button></div>
    </header>
    {open&&notice}
    {current?<TerminalView key={sessionId+':'+current.id} sessionId={sessionId} record={current} open={open} report={report}/>:<div className="terminal-empty"><p>在当前会话的工作目录运行命令。</p><button disabled={busy} onClick={()=>void create()}>{busy?'正在创建…':'新建终端'}</button></div>}
  </section>;
}
