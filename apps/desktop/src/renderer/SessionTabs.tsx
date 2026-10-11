import {useEffect,useRef,useState} from 'react';
import {toolNames,type SessionViewState,type ToolPage} from '../session-view.js';
import {visibleSessionView} from './view-tabs.js';
import {Icon,type IconName} from './Icons.js';
export const toolIcons:Record<ToolPage,IconName>={trace:'trace',file:'file',diff:'diff',terminal:'terminal',swarm:'swarm',expert:'expert',memory:'memory'};
export function SessionTabs({view,onSelect,onClose,onNew}:{view:SessionViewState;onSelect(id:string):void;onClose(id:string):void;onNew():void}){
  const strip=useRef<HTMLDivElement>(null);
  const visible=visibleSessionView(view),active=visible.active;
  useEffect(()=>{strip.current?.querySelector<HTMLElement>('[aria-selected=true]')?.scrollIntoView({block:'nearest',inline:'nearest'});},[active]);
  const tabs=[{id:'conversation',title:'会话',icon:'chat' as IconName},...visible.tabs.map(t=>({id:t.id,title:t.kind==='new'?'新标签页':t.kind==='tool'?toolNames[t.page!]:t.title||'网页',icon:t.kind==='tool'?toolIcons[t.page!]:'globe' as IconName}))];
  return <div className="session-tabs-shell"><div ref={strip} className="session-tabs" role="tablist" aria-label="当前会话页面" onWheel={e=>{if(strip.current&&!e.deltaX&&!e.shiftKey)strip.current.scrollLeft+=e.deltaY;}}>{tabs.map((tab,i)=><div key={tab.id} className={'view-tab '+(active===tab.id?'selected':'')}><button role="tab" id={'session-tab-'+tab.id} tabIndex={active===tab.id?0:-1} aria-selected={active===tab.id} onClick={()=>onSelect(tab.id)} onKeyDown={e=>{let next=i;if(e.key==='ArrowRight')next=(i+1)%tabs.length;else if(e.key==='ArrowLeft')next=(i+tabs.length-1)%tabs.length;else if(e.key==='Home')next=0;else if(e.key==='End')next=tabs.length-1;else return;e.preventDefault();onSelect(tabs[next].id);requestAnimationFrame(()=>strip.current?.querySelector<HTMLButtonElement>('[aria-selected=true]')?.focus());}}><Icon name={tab.icon} size={15}/><span>{tab.title}</span></button>{i>0&&<button aria-label={'关闭标签 '+tab.title} onClick={()=>onClose(tab.id)}>×</button>}</div>)}</div><button className="new-view-tab" aria-label="新标签页" onClick={onNew}><Icon name="plus"/></button></div>;
}
export function NewTabPage({onTool,onNavigate}:{onTool(page:ToolPage):void;onNavigate(url:string):Promise<unknown>}){
  const [url,setUrl]=useState(''),[error,setError]=useState('');
  return <div className="new-tab-page"><div className="new-tab-intro"><h1>在这个会话里继续工作</h1><p>打开网页，或选择一个工作工具。</p></div><form onSubmit={e=>{e.preventDefault();void onNavigate(url).catch(reason=>setError(String(reason)));}}><input aria-label="新标签页网址" placeholder="输入网址，例如 localhost:3000" value={url} onChange={e=>setUrl(e.target.value)}/><button type="submit">打开网页 ↗</button></form>{error&&<p role="alert">{error}</p>}<h2>工具</h2><div className="new-tab-tools">{Object.entries(toolNames).filter(([page])=>page!=='expert').map(([page,title])=><button key={page} onClick={()=>onTool(page as ToolPage)}><Icon name={toolIcons[page as ToolPage]}/><span>{title}</span><span>↗</span></button>)}</div></div>;
}
