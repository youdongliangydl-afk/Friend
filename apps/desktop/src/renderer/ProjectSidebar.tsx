import {useEffect,useRef,useState,type KeyboardEvent} from 'react';
import {Icon} from './Icons.js';
import type {AppState,SessionSummary} from './types.js';
import type {AttentionActivity} from '../session-attention.js';

export function sidebarSessions(sessions:SessionSummary[],activities:Pick<AttentionActivity,'sessionId'|'kind'|'unseen'>[]):SessionSummary[]{
  return sessions.map(session=>{
    const attention=activities.filter(item=>item.sessionId===session.id);
    if(attention.some(item=>item.kind==='dialog'))return {...session,status:'awaiting_user'};
    const result=attention.find(item=>item.unseen&&(item.kind==='completed'||item.kind==='failed'));
    if(result&&!['running','rebuilding','stopping'].includes(session.status||''))return {...session,status:'unread_'+result.kind};
    return session;
  });
}


export function reorderIds(ids:string[],source:string,target:string,after=false) {
  if(source===target||!ids.includes(source)||!ids.includes(target))return ids;
  const next=ids.filter(id=>id!==source);
  next.splice(next.indexOf(target)+(after?1:0),0,source);
  return next;
}

export interface ProjectSidebarProps {
  projects:AppState['projects'];sessions:AppState['sessions'];
  selectedProject?:string;selectedSession?:string;query?:string;archived?:boolean;disabled?:boolean;
  onProject(id:string):void;onSession(id:string):void;
  onMenu(session:SessionSummary,position:{x:number;y:number}):void;
  onOpenProject():void;onReorder(ids:string[]):void|Promise<unknown>;
}
const statuses:Record<string,string>={awaiting_user:'等待你处理',unread_completed:'有新回复',unread_failed:'任务失败，尚未查看',idle:'准备就绪',running:'正在执行',awaiting_review:'等待复核',rebuilding:'整理上下文',stopping:'正在停止',completed:'本轮已结束',failed:'执行失败',interrupted:'已中断',stopped:'已停止',paused:'已暂停'};

export function ProjectSidebar({projects,sessions,selectedProject='',selectedSession,query='',archived=false,disabled=false,onProject,onSession,onMenu,onOpenProject,onReorder}:ProjectSidebarProps) {
  const [menu,setMenu]=useState<string>(),[pending,setPending]=useState(false),[error,setError]=useState('');
  const [drop,setDrop]=useState<{id:string;after:boolean}>();
  const menuRoot=useRef<HTMLDivElement>(null),menuTrigger=useRef<HTMLButtonElement|null>(null),reordering=useRef(false);
  const dragging=useRef('');
  const locked=disabled||pending,search=query.trim().toLocaleLowerCase();
  const groups=[{id:'',name:'临时会话',path:''},...projects];
  useEffect(()=>{if(menu!==undefined)menuRoot.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();},[menu]);
  useEffect(()=>{if(disabled)setMenu(undefined);},[disabled]);
  const closeMenu=()=>{setMenu(undefined);if(menu!==undefined)menuTrigger.current?.focus();};
  const commit=async(ids:string[])=>{
    if(locked||reordering.current)return;
    reordering.current=true;setPending(true);setError('');closeMenu();
    try{await onReorder(ids);}
    catch(reason){setError('项目顺序未保存：'+(reason instanceof Error?reason.message:String(reason)));}
    finally{reordering.current=false;setPending(false);}
  };
  const move=(id:string,direction:number)=>{
    const ids=projects.map(project=>project.id),target=ids[ids.indexOf(id)+direction];
    if(target)void commit(reorderIds(ids,id,target,direction>0));
  };
  const menuKeys=(event:KeyboardEvent<HTMLDivElement>)=>{
    if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeMenu();return;}
    if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    const buttons=[...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')];
    if(!buttons.length)return;
    const current=buttons.indexOf(document.activeElement as HTMLButtonElement),index=event.key==='Home'?0:event.key==='End'?buttons.length-1:(current+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;
    event.preventDefault();buttons[index].focus();
  };
  return <nav className="project-sidebar" aria-label={archived?'项目与归档聊天':'项目与聊天'} aria-busy={pending}>
    <div className="project-sidebar-title">项目</div>
    <div className="project-sidebar-groups">{groups.map(group=>{
      const groupMatches=!!search&&group.name.toLocaleLowerCase().includes(search);
      const chats=sessions.filter(session=>session.projectId===group.id&&!!session.archived===archived&&(!search||groupMatches||session.name.toLocaleLowerCase().includes(search))).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id));
      const projectIndex=projects.findIndex(project=>project.id===group.id);
      return <section key={group.id||'temporary'} className="project-sidebar-group" aria-label={group.name}>
        <div className={'project-sidebar-heading'+(selectedProject===group.id?' is-current':'')+(drop?.id===group.id?drop.after?' drop-after':' drop-before':'')} onDragOver={event=>{
          if(locked||!group.id||!dragging.current||dragging.current===group.id)return;
          event.preventDefault();event.dataTransfer.dropEffect='move';const box=event.currentTarget.getBoundingClientRect();setDrop({id:group.id,after:event.clientY>=box.top+box.height/2});
        }} onDragLeave={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node))setDrop(undefined);}} onDrop={event=>{
          const source=dragging.current;dragging.current='';setDrop(undefined);
          if(locked||!group.id||!source||source===group.id)return;
          event.preventDefault();const box=event.currentTarget.getBoundingClientRect();void commit(reorderIds(projects.map(project=>project.id),source,group.id,event.clientY>=box.top+box.height/2));
        }}>
          <button type="button" className="project-sidebar-project" disabled={locked} draggable={!!group.id&&!locked} title={group.path||'临时会话'} aria-current={selectedProject===group.id?'true':undefined} onDragStart={event=>{if(locked||!group.id){event.preventDefault();return;}setMenu(undefined);dragging.current=group.id;event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('application/x-friend-project',group.id);}} onDragEnd={()=>{dragging.current='';setDrop(undefined);}} onClick={()=>{setMenu(undefined);onProject(group.id);}} onKeyDown={event=>{
            if(group.id&&event.altKey&&event.shiftKey&&['ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();move(group.id,event.key==='ArrowUp'?-1:1);}
          }}><Icon name={group.id?'folder':'chat'} size={17}/><span>{group.name}</span></button>
          {group.id&&<button type="button" className="project-sidebar-more project-sidebar-group-more" disabled={locked} aria-label={'项目 '+group.name+' 的更多操作'} aria-haspopup="menu" aria-expanded={menu===group.id} onClick={event=>{menuTrigger.current=event.currentTarget;setMenu(menu===group.id?undefined:group.id);}}>⋯</button>}
        </div>
        {menu===group.id&&<div ref={menuRoot} className="project-sidebar-menu" role="menu" aria-label={group.name+' 排序'} onKeyDown={menuKeys} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node)&&event.relatedTarget!==menuTrigger.current)setMenu(undefined);}}>
          <button type="button" role="menuitem" disabled={locked||projectIndex===0} onClick={()=>move(group.id,-1)}>上移项目</button>
          <button type="button" role="menuitem" disabled={locked||projectIndex===projects.length-1} onClick={()=>move(group.id,1)}>下移项目</button>
          <button type="button" role="menuitem" onClick={closeMenu}>关闭菜单</button>
        </div>}
        {chats.length?<ul className="project-sidebar-chats">{chats.map(session=>{
          const status=session.status||'idle',statusLabel=statuses[status]||status;
          return <li key={session.id} className={'project-sidebar-chat'+(selectedSession===session.id?' is-selected':'')} onContextMenu={event=>{if(locked)return;event.preventDefault();setMenu(undefined);onMenu(session,{x:event.clientX,y:event.clientY});}}>
            <button type="button" className="project-sidebar-session" disabled={locked} title={session.name} aria-current={selectedSession===session.id?'page':undefined} onClick={()=>{setMenu(undefined);onSession(session.id);}}><span>{session.name}</span></button>
            <span className={'project-sidebar-status status-'+status} role="img" aria-label={statusLabel} title={statusLabel}/>
            <button type="button" className="project-sidebar-more" disabled={locked} aria-label={'聊天 '+session.name+' 的更多操作'} aria-haspopup="menu" onClick={event=>{setMenu(undefined);const box=event.currentTarget.getBoundingClientRect();onMenu(session,{x:box.right,y:box.bottom});}}>⋯</button>
          </li>;
        })}</ul>:<p className="project-sidebar-empty">{search?'没有匹配的聊天':'暂无聊天'}</p>}
      </section>;
    })}</div>
    {error&&<p className="project-sidebar-error" role="alert">{error}</p>}
    <button type="button" className="project-sidebar-open" disabled={locked} onClick={onOpenProject}><Icon name="plus" size={16}/><span>打开项目</span></button>
  </nav>;
}
