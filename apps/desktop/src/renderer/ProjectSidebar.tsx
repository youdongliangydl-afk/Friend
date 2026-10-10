import {useEffect,useRef,useState,type KeyboardEvent,type DragEvent} from 'react';
import {Icon} from './Icons.js';
import type {AppState,SessionSummary} from './types.js';
import type {AttentionActivity} from '../session-attention.js';
import {orderedSessions} from '../session-order.js';

export function sidebarSessions(sessions:SessionSummary[],activities:Pick<AttentionActivity,'sessionId'|'kind'|'unseen'>[]):SessionSummary[]{
  return sessions.map(session=>{
    const attention=activities.filter(item=>item.sessionId===session.id);
    if(attention.some(item=>item.kind==='dialog'))return {...session,status:'awaiting_user'};
    const result=attention.find(item=>item.unseen&&(item.kind==='completed'||item.kind==='failed'));
    if(result&&!['running','awaiting_review','rebuilding','stopping'].includes(session.status||''))return {...session,status:'unread_'+result.kind};
    return session;
  });
}
export function reorderIds(ids:string[],source:string,target:string,after=false) {
  if(source===target||!ids.includes(source)||!ids.includes(target))return ids;
  const next=ids.filter(id=>id!==source);next.splice(next.indexOf(target)+(after?1:0),0,source);return next;
}
export function reorderVisibleIds(all:string[],visible:string[],source:string,target:string,after=false){
  const moved=reorderIds(visible,source,target,after);if(moved===visible)return all;
  const shown=new Set(visible);let index=0;return all.map(id=>shown.has(id)?moved[index++]:id);
}
export interface SessionMoves {up?:()=>void;down?:()=>void}
export interface ProjectSidebarProps {
  projects:AppState['projects'];sessions:AppState['sessions'];sessionOrder?:Record<string,string[]>;
  selectedProject?:string;selectedSession?:string;query?:string;archived?:boolean;disabled?:boolean;
  onProject(id:string):void;onSession(id:string):void;onNewSession(id:string):void;
  onMenu(session:SessionSummary,position:{x:number;y:number},moves?:SessionMoves):void;
  onReorder(ids:string[]):void|Promise<unknown>;
  onReorderSessions(projectId:string,ids:string[]):void|Promise<unknown>;onToggleArchive?():void;
}
const statuses:Record<string,string>={awaiting_user:'等待你处理',unread_completed:'有新回复',unread_failed:'任务失败，尚未查看',idle:'准备就绪',running:'正在执行',awaiting_review:'等待复核',rebuilding:'整理上下文',stopping:'正在停止',completed:'本轮已结束',failed:'执行失败',interrupted:'已中断',stopped:'已停止',paused:'已暂停'};
export function ProjectSidebar({projects,sessions,sessionOrder={},selectedProject='',selectedSession,query='',archived=false,disabled=false,onProject,onSession,onNewSession,onMenu,onReorder,onReorderSessions,onToggleArchive}:ProjectSidebarProps) {
  const [menu,setMenu]=useState<string>(),[pending,setPending]=useState(false),[error,setError]=useState('');
  const [drop,setDrop]=useState<{kind:'project'|'session';id:string;after:boolean}>();
  const menuRoot=useRef<HTMLDivElement>(null),menuTrigger=useRef<HTMLButtonElement|null>(null),reordering=useRef(false);
  const dragging=useRef<{kind:'project'|'session';id:string;projectId:string}|undefined>(undefined);
  const locked=disabled||pending,search=query.trim().toLocaleLowerCase(),groups=[{id:'',name:'临时会话',path:''},...projects];
  useEffect(()=>{if(menu!==undefined)menuRoot.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();},[menu]);
  useEffect(()=>{if(disabled)setMenu(undefined);},[disabled]);
  const closeMenu=()=>{setMenu(undefined);if(menu!==undefined)menuTrigger.current?.focus();};
  const commit=async(ids:string[],projectId?:string)=>{
    if(locked||reordering.current)return;
    reordering.current=true;setPending(true);setError('');closeMenu();
    try{if(projectId===undefined)await onReorder(ids);else await onReorderSessions(projectId,ids);}
    catch(reason){setError((projectId===undefined?'项目':'会话')+'顺序未保存：'+(reason instanceof Error?reason.message:String(reason)));}
    finally{reordering.current=false;setPending(false);}
  };
  const moveProject=(id:string,direction:number)=>{const ids=projects.map(project=>project.id),target=ids[ids.indexOf(id)+direction];if(target)void commit(reorderIds(ids,id,target,direction>0));};
  const endDrag=()=>{dragging.current=undefined;setDrop(undefined);};
  const after=(event:DragEvent<HTMLElement>)=>{const box=event.currentTarget.getBoundingClientRect();return event.clientY>=box.top+box.height/2;};
  const menuKeys=(event:KeyboardEvent<HTMLDivElement>)=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeMenu();return;}
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];if(!buttons.length)return;
    const current=buttons.indexOf(document.activeElement as HTMLButtonElement),index=event.key==='Home'?0:event.key==='End'?buttons.length-1:(current+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;
    event.preventDefault();buttons[index].focus();
  };
  return <nav className="project-sidebar" aria-label={archived?'项目与归档聊天':'项目与聊天'} aria-busy={pending}>
    <div className="project-sidebar-title"><span>{archived?'归档会话':'项目'}</span>{onToggleArchive&&<button type="button" className="archive-toggle" aria-label="查看归档会话" aria-pressed={archived} onClick={onToggleArchive}><Icon name="history" size={15}/></button>}</div>
    <div className="project-sidebar-groups">{groups.map(group=>{
      const groupMatches=!!search&&group.name.toLocaleLowerCase().includes(search);
      const allChats=orderedSessions(sessions.filter(session=>session.projectId===group.id),sessionOrder[group.id]);
      const chats=allChats.filter(session=>!!session.archived===archived&&(!search||groupMatches||session.name.toLocaleLowerCase().includes(search)));
      const allIds=allChats.map(session=>session.id),visibleIds=chats.map(session=>session.id),projectIndex=projects.findIndex(project=>project.id===group.id);
      const moveSession=(id:string,direction:number)=>{const target=visibleIds[visibleIds.indexOf(id)+direction];if(target)void commit(reorderVisibleIds(allIds,visibleIds,id,target,direction>0),group.id);};
      const moves=(id:string):SessionMoves=>{const index=visibleIds.indexOf(id);return {up:index>0?()=>moveSession(id,-1):undefined,down:index<visibleIds.length-1?()=>moveSession(id,1):undefined};};
      return <section key={group.id||'temporary'} className="project-sidebar-group" aria-label={group.name}>
        <div className={'project-sidebar-heading'+(selectedProject===group.id?' is-current':'')+(drop?.kind==='project'&&drop.id===group.id?drop.after?' drop-after':' drop-before':'')} onDragOver={event=>{
          if(locked||!group.id||dragging.current?.kind!=='project'||dragging.current.id===group.id)return;
          event.preventDefault();event.dataTransfer.dropEffect='move';setDrop({kind:'project',id:group.id,after:after(event)});
        }} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setDrop(undefined);}} onDrop={event=>{
          const source=dragging.current;endDrag();if(locked||!group.id||source?.kind!=='project'||source.id===group.id)return;
          event.preventDefault();void commit(reorderIds(projects.map(project=>project.id),source.id,group.id,after(event)));
        }}>
          <button type="button" className="project-sidebar-project" disabled={locked} draggable={!!group.id&&!locked} title={group.path||'临时会话'} aria-current={selectedProject===group.id?'true':undefined} onDragStart={event=>{if(locked||!group.id){event.preventDefault();return;}setMenu(undefined);dragging.current={kind:'project',id:group.id,projectId:group.id};event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-friend-project',group.id);}} onDragEnd={endDrag} onClick={()=>{setMenu(undefined);onProject(group.id);}} onKeyDown={event=>{if(group.id&&event.altKey&&event.shiftKey&&['ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();moveProject(group.id,event.key==='ArrowUp'?-1:1);}}}><Icon name={group.id?'folder':'chat'} size={17}/><span>{group.name}</span></button>
          {group.id&&<div className="project-sidebar-actions"><button type="button" className="project-sidebar-more project-sidebar-group-more" disabled={locked} aria-label={'项目 '+group.name+' 的更多操作'} aria-haspopup="menu" aria-expanded={menu===group.id} onClick={event=>{menuTrigger.current=event.currentTarget;setMenu(menu===group.id?undefined:group.id);}}>⋯</button><button type="button" className="project-sidebar-compose" disabled={locked} aria-label={'在项目 '+group.name+' 中新建会话'} title="新建会话" onClick={()=>{setMenu(undefined);onNewSession(group.id);}}><Icon name="compose" size={17}/></button></div>}
        </div>
        {menu===group.id&&<div ref={menuRoot} className="project-sidebar-menu" role="menu" aria-label={group.name+' 操作'} onKeyDown={menuKeys} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node)&&event.relatedTarget!==menuTrigger.current)setMenu(undefined);}}>
          <button type="button" role="menuitem" disabled={locked} onClick={()=>{closeMenu();onNewSession(group.id);}}>新建会话</button>
          <button type="button" role="menuitem" disabled={locked||projectIndex===0} onClick={()=>moveProject(group.id,-1)}>上移项目</button>
          <button type="button" role="menuitem" disabled={locked||projectIndex===projects.length-1} onClick={()=>moveProject(group.id,1)}>下移项目</button>
          <button type="button" role="menuitem" onClick={closeMenu}>关闭菜单</button>
        </div>}
        {chats.length?<ul className="project-sidebar-chats">{chats.map(session=>{
          const status=session.status||'idle',statusLabel=statuses[status]||status;
          return <li key={session.id} className={'project-sidebar-chat'+(selectedSession===session.id?' is-selected':'')+(drop?.kind==='session'&&drop.id===session.id?drop.after?' drop-after':' drop-before':'')} onContextMenu={event=>{if(locked)return;event.preventDefault();setMenu(undefined);onMenu(session,{x:event.clientX,y:event.clientY},moves(session.id));}} onDragOver={event=>{
            const source=dragging.current;if(locked||source?.kind!=='session'||source.projectId!==group.id||source.id===session.id)return;
            event.preventDefault();event.dataTransfer.dropEffect='move';setDrop({kind:'session',id:session.id,after:after(event)});
          }} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setDrop(undefined);}} onDrop={event=>{
            const source=dragging.current;endDrag();if(locked||source?.kind!=='session'||source.projectId!==group.id||source.id===session.id)return;
            event.preventDefault();void commit(reorderVisibleIds(allIds,visibleIds,source.id,session.id,after(event)),group.id);
          }}>
            <button type="button" className="project-sidebar-session" disabled={locked} title={session.name} aria-current={selectedSession===session.id?'page':undefined} draggable={!locked} onDragStart={event=>{if(locked){event.preventDefault();return;}setMenu(undefined);dragging.current={kind:'session',id:session.id,projectId:group.id};event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-friend-session',session.id);}} onDragEnd={endDrag} onClick={()=>{setMenu(undefined);onSession(session.id);}} onKeyDown={event=>{if(event.altKey&&event.shiftKey&&['ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();moveSession(session.id,event.key==='ArrowUp'?-1:1);}}}><span>{session.name}</span></button>
            <span className={'project-sidebar-status status-'+status} role="img" aria-label={statusLabel} title={statusLabel}/>
            <button type="button" className="project-sidebar-more" disabled={locked} aria-label={'聊天 '+session.name+' 的更多操作'} aria-haspopup="menu" onClick={event=>{setMenu(undefined);const box=event.currentTarget.getBoundingClientRect();onMenu(session,{x:box.right,y:box.bottom},moves(session.id));}}>⋯</button>
          </li>;
        })}</ul>:<p className="project-sidebar-empty">{search?'没有匹配的聊天':'暂无聊天'}</p>}
      </section>;
    })}</div>
    {error&&<p className="project-sidebar-error" role="alert">{error}</p>}
  </nav>;
}
