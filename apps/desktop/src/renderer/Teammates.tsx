/** TeamAction interaction adapted from DeepSeek Harness 5badb15009ae1756c3afe0ae0cef1faafc290ccc.
 * Copyright (c) 2026 DeepSeek. MIT; packaged DEEPSEEK-LICENSE. */
import {useCallback,useEffect,useLayoutEffect,useRef,useState} from 'react';
import {asList,asObject,errorText,type JsonObject,type Message} from './types.js';
import {Conversation} from './Conversation.js';
import {piLiveMessage,type ToolRun} from './timeline.js';
import {SessionComposer} from './SessionComposer.js';
export interface TeammateView {id:string;name:string;description:string;state:string;generation:number;cwd?:string;reason?:string;modelId?:string;discussion?:boolean;attemptId?:string}
const states:Record<string,string>={idle:'待命',running:'执行中',stopping:'正在停止',paused:'已暂停',failed:'失败'};
function call(rootSessionId:string,action:string,input:JsonObject={}){return window.friendPi.request('plugin.call',{sessionId:rootSessionId,plugin:'swarm',action:'member.'+action,input});}
function useTeammates(rootSessionId:string){
  const [members,setMembers]=useState<TeammateView[]>([]);
  useEffect(()=>{let active=true;void call(rootSessionId,'list').then(raw=>{if(active)setMembers(asList<TeammateView>(asObject(raw).teammates));}).catch(()=>{});
    const off=window.friendPi.onEvent(event=>{if(event.sessionId!==rootSessionId||event.type!=='plugin')return;const data=asObject(event.data);if(data.pluginEvent==='swarm.changed')setMembers(asList<TeammateView>(asObject(data.data).teammates));});return()=>{active=false;off();};},[rootSessionId]);return members;
}
export function openTeammate(rootSessionId:string,memberId:string){window.dispatchEvent(new CustomEvent('friend-pi:teammate-open',{detail:{rootSessionId,memberId}}));}
export function TeammateRoster({rootSessionId,compact=false,selectedMemberId,onBack}:{rootSessionId:string;compact?:boolean;selectedMemberId?:string;onBack?():void}){
  const members=useTeammates(rootSessionId),[open,setOpen]=useState(false);
  const selected=members.find(member=>member.id===selectedMemberId);
  if(!members.length&&!selectedMemberId)return compact?null:<p className="hint">任务启动后，队友会出现在这里。</p>;
  const rows=<div className="teammate-roster" role="list" aria-label="当前会话队友">{members.map(member=><button type="button" role="listitem" key={member.id} onClick={()=>{setOpen(false);openTeammate(rootSessionId,member.id);}} aria-label={'查看队友 '+member.name+' 的会话'}><span className={'teammate-dot '+member.state}/><span><strong>{member.name}</strong><small>{states[member.state]||member.state}</small></span><span aria-hidden="true">↗</span></button>)}</div>;
  return compact?<div className="teammate-navigation" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();if(open)setOpen(false);else onBack?.();}}}>{selectedMemberId&&<button key={selectedMemberId} autoFocus className="member-back" onClick={onBack}>← 返回主会话</button>}<div className="teammate-entry"><button className="teammate-trigger" aria-expanded={open} aria-label={selectedMemberId?'切换队友，当前 '+(selected?.name||'载入中'):undefined} onClick={()=>setOpen(value=>!value)}>{selectedMemberId?selected?.name||'载入中':'队友'}{!selectedMemberId&&<span>{members.length}</span>}</button>{open&&<div className="teammate-popover" onKeyDown={event=>{if(event.key==='Escape'){event.stopPropagation();setOpen(false);}}}>{rows}</div>}</div>{selectedMemberId&&<span className="session-status">{states[selected?.state||'']||'载入中'}</span>}</div>:rows;
}
export function TeammateConversation({rootSessionId,memberId,onBack,report,archived=false}:{rootSessionId:string;memberId:string;onBack():void;report(message:string,error?:boolean):void;archived?:boolean}){
  const key=rootSessionId+':'+memberId;
  const [member,setMember]=useState<TeammateView|null>(null),[messages,setMessages]=useState<Message[]>([]),[inbox,setInbox]=useState<JsonObject[]>([]),[live,setLive]=useState<Message|null>(null),[tools,setTools]=useState<ToolRun[]>([]),[sending,setSending]=useState(false),[loaded,setLoaded]=useState(false);
  const [draft,setDraft]=useState(()=>localStorage.getItem('friend-pi.member-draft:'+key)||''),draftRef=useRef(draft);draftRef.current=draft;
  const liveRef=useRef<Message|null>(null),streamSequence=useRef(0),sendLock=useRef(false),restoredScroll=useRef(false);
  const sendRecord=useRef<{id:string;body:string}|null>(null);
  const expansionStorage='friend-pi.member-expanded:'+JSON.stringify([rootSessionId,memberId]);
  const expansions=useRef<Record<string,boolean>>((()=>{try{return asObject(JSON.parse(sessionStorage.getItem(expansionStorage)||'{}')) as Record<string,boolean>;}catch{return {};}})());
  const detailKey=(detail:HTMLDetailsElement)=>detail.getAttribute('data-tool-group-id')||(detail.hasAttribute('data-tool-call-id')?'tool:'+detail.getAttribute('data-tool-call-id'):detail.getAttribute('data-thought-part'))||'';
  const active=useRef(true),version=useRef(0),memberRef=useRef(member),scroll=useRef<HTMLDivElement>(null);memberRef.current=member;
  const refresh=useCallback(async()=>{const request=++version.current,raw=asObject(await call(rootSessionId,'history',{memberId}));if(!active.current||request!==version.current)return;const next=raw.member as TeammateView;if(memberRef.current&&next.generation<memberRef.current.generation)return;memberRef.current=next;setMember(next);const native=asList<Message>(raw.messages);setMessages(native);setLoaded(true);if(liveRef.current&&native.some(message=>message.timestamp===liveRef.current?.timestamp&&message.text===liveRef.current?.text)){liveRef.current=null;setLive(null);}setInbox(asList<JsonObject>(raw.inbox));},[rootSessionId,memberId]);
  useEffect(()=>{active.current=true;void refresh().catch(error=>report(errorText(error),true));return()=>{active.current=false;version.current++;};},[refresh,report]);
  useEffect(()=>{localStorage.setItem('friend-pi.member-draft:'+key,draft);},[key,draft]);
  useEffect(()=>{const transcript=scroll.current;if(!transcript)return;const save=(event:Event)=>{if(!(event.target instanceof HTMLDetailsElement)||!restoredScroll.current)return;const id=detailKey(event.target);expansions.current[id]=event.target.open;sessionStorage.setItem(expansionStorage,JSON.stringify(expansions.current));};transcript.addEventListener('toggle',save,true);return()=>transcript.removeEventListener('toggle',save,true);},[expansionStorage]);
  useLayoutEffect(()=>{if(!loaded||restoredScroll.current||!scroll.current)return;scroll.current.scrollTop=Number(sessionStorage.getItem('friend-pi.member-scroll:'+key)||0);restoredScroll.current=true;},[key,loaded,messages]);
  useEffect(()=>window.friendPi.onEvent(event=>{
    if(event.sessionId!==rootSessionId||event.type!=='plugin')return;const data=asObject(event.data),frame=asObject(data.data);
    if(data.pluginEvent==='swarm.changed'){const next=asList<TeammateView>(frame.teammates).find(item=>item.id===memberId);if(next){const prior=memberRef.current;memberRef.current=next;setMember(next);if(prior?.generation!==next.generation){version.current++;liveRef.current=null;setLive(null);setTools([]);void refresh().catch(error=>report(errorText(error),true));}if(next.state!=='running'&&(!prior||prior.state!==next.state)){liveRef.current=null;setLive(null);void refresh().catch(error=>report(errorText(error),true));}}return;}
    if(data.pluginEvent!=='swarm.member-event'||frame.memberId!==memberId||frame.generation!==memberRef.current?.generation||frame.attemptId!==memberRef.current?.attemptId||memberRef.current?.state!=='running')return;
    const native=asObject(frame.event),message=asObject(native.message);
    if(['message_start','message_update','message_end'].includes(String(native.type))&&message.role==='assistant'){const same=native.type!=='message_start'&&liveRef.current?.timestamp===message.timestamp;const id=same?liveRef.current!.id!:'member-live:'+frame.attemptId+':'+(++streamSequence.current);const next=piLiveMessage(message,id);next.senderLabel=memberRef.current?.name;liveRef.current=next;setLive(next);}
    if(native.type==='message_end')void refresh().catch(()=>{});
    if(native.type==='agent_settled'){liveRef.current=null;setLive(null);setTools([]);void refresh().catch(error=>report(errorText(error),true));}
    if(native.type==='tool_execution_start')setTools(old=>[...old.filter(tool=>tool.id!==native.toolCallId),{id:String(native.toolCallId),name:String(native.toolName),status:'running',input:native.args}]);
    if(native.type==='tool_execution_end')setTools(old=>old.map(tool=>tool.id===native.toolCallId?{...tool,status:native.isError?'failed':'completed',output:native.result,error:native.isError===true}:tool));
  }),[rootSessionId,memberId,refresh,report]);
  const send=async()=>{const body=draftRef.current;if(sendLock.current||!body.trim()||archived)return;sendLock.current=true;setSending(true);const generation=memberRef.current?.generation;
    const storage='friend-pi.member-send:'+key;
    if(!sendRecord.current){try{sendRecord.current=JSON.parse(localStorage.getItem(storage)||'null');}catch{}}
    if(sendRecord.current?.body!==body)sendRecord.current={id:crypto.randomUUID(),body};localStorage.setItem(storage,JSON.stringify(sendRecord.current));
    try{await call(rootSessionId,'send',{memberId,generation,body,messageId:sendRecord.current!.id});sendRecord.current=null;localStorage.removeItem(storage);if(localStorage.getItem('friend-pi.member-draft:'+key)===body)localStorage.removeItem('friend-pi.member-draft:'+key);if(active.current&&draftRef.current===body)setDraft('');if(active.current)await refresh();}catch(error){if(active.current)report(errorText(error),true);}finally{sendLock.current=false;if(active.current)setSending(false);}};
  const interrupt=async()=>{try{await call(rootSessionId,'interrupt',{memberId,generation:memberRef.current?.generation});await refresh();}catch(error){report(errorText(error),true);}};
  const resume=async()=>{if(!window.confirm('已检查该成员保留的工作树和会话，允许启动新的受控尝试？'))return;try{await call(rootSessionId,'resume',{memberId,confirmUnknown:true});await refresh();}catch(error){report(errorText(error),true);}};
  return <section className="member-conversation" aria-label={'队友会话 '+(member?.name||'载入中')} onKeyDown={event=>{if(event.key==='Escape'&&!event.nativeEvent.isComposing)onBack();}}>
    {member?.reason&&<div className="notice" role="status"><span>{member.reason}</span>{member.state==='paused'&&!archived&&<button onClick={()=>void resume()}>检查后接续</button>}</div>}
    <div className="conversation member-transcript" ref={scroll} onScroll={event=>{if(restoredScroll.current)sessionStorage.setItem('friend-pi.member-scroll:'+key,String(event.currentTarget.scrollTop));}}><Conversation key={key} initialExpanded={expansions.current} messages={messages} live={live} tools={tools} running={member?.state==='running'}/>{inbox.filter(message=>!message.nativeEntryId).map(message=><article className="member-pending-message" key={String(message.id)}><strong>{String(message.from)} · {message.receivedAt?'成员已收件':'已保存，等待处理'}</strong><p>{String(message.body)}</p></article>)}{!messages.length&&!live&&<p className="member-empty">{loaded?'队友尚未开始任务。查看会话不会启动模型。':'正在载入原生会话…'}</p>}</div>
    <SessionComposer recipient={member?.name||'队友'} value={{sessionId:rootSessionId,epoch:member?.generation||0,draft,attachments:[],running:member?.state==='running',sending,navigating:false,archived,planMode:false,permissionMode:'ask',permissionExplicit:false,mode:'swarm',plugins:[],models:[],modelId:'',thinkingLevel:'',thinkingLevels:[],ready:!!member,floating:false,collapsed:false,status:''}} action={async input=>{if(input.type==='draft'){draftRef.current=String(input.value);setDraft(draftRef.current);}else if(input.type==='send'){draftRef.current=input.text??draftRef.current;await send();}else if(input.type==='stop')await interrupt();}}/>
  </section>;
}
