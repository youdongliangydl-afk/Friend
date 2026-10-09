/** TeamAction interaction adapted from DeepSeek Harness 5badb15009ae1756c3afe0ae0cef1faafc290ccc.
 * Copyright (c) 2026 DeepSeek. MIT; packaged DEEPSEEK-LICENSE. */
import {useCallback,useEffect,useRef,useState} from 'react';
import {asList,asObject,errorText,type JsonObject,type Message} from './types.js';
import {Conversation} from './Conversation.js';
import {piLiveMessage,type ToolRun} from './timeline.js';
import {composerKeyAction,insertNewline} from './composer-keys.js';
export interface TeammateView {id:string;name:string;description:string;state:string;generation:number;cwd?:string;reason?:string;modelId?:string;discussion?:boolean;attemptId?:string}
const states:Record<string,string>={idle:'待命',running:'执行中',stopping:'正在停止',paused:'已暂停',failed:'失败'};
function call(rootSessionId:string,action:string,input:JsonObject={}){return window.friendPi.request('plugin.call',{sessionId:rootSessionId,plugin:'swarm',action:'member.'+action,input});}
function useTeammates(rootSessionId:string){
  const [members,setMembers]=useState<TeammateView[]>([]);
  useEffect(()=>{let active=true;void call(rootSessionId,'list').then(raw=>{if(active)setMembers(asList<TeammateView>(asObject(raw).teammates));}).catch(()=>{});
    const off=window.friendPi.onEvent(event=>{if(event.sessionId!==rootSessionId||event.type!=='plugin')return;const data=asObject(event.data);if(data.pluginEvent==='swarm.changed')setMembers(asList<TeammateView>(asObject(data.data).teammates));});return()=>{active=false;off();};},[rootSessionId]);return members;
}
export function openTeammate(rootSessionId:string,memberId:string){window.dispatchEvent(new CustomEvent('friend-pi:teammate-open',{detail:{rootSessionId,memberId}}));}
export function TeammateRoster({rootSessionId,compact=false}:{rootSessionId:string;compact?:boolean}){
  const members=useTeammates(rootSessionId),[open,setOpen]=useState(false);
  if(!members.length)return compact?null:<p className="hint">任务启动后，队友会出现在这里。</p>;
  const rows=<div className="teammate-roster" role="list" aria-label="当前会话队友">{members.map(member=><button type="button" role="listitem" key={member.id} onClick={()=>{setOpen(false);openTeammate(rootSessionId,member.id);}} aria-label={'查看队友 '+member.name+' 的会话'}><span className={'teammate-dot '+member.state}/><span><strong>{member.name}</strong><small>{states[member.state]||member.state}</small></span><span aria-hidden="true">↗</span></button>)}</div>;
  return compact?<div className="teammate-entry"><button className="teammate-trigger" aria-expanded={open} onClick={()=>setOpen(value=>!value)}>队友 <span>{members.length}</span></button>{open&&<div className="teammate-popover" onKeyDown={event=>{if(event.key==='Escape')setOpen(false);}}>{rows}</div>}</div>:rows;
}
export function TeammateConversation({rootSessionId,memberId,onBack,report,archived=false}:{rootSessionId:string;memberId:string;onBack():void;report(message:string,error?:boolean):void;archived?:boolean}){
  const key=rootSessionId+':'+memberId;
  const [member,setMember]=useState<TeammateView|null>(null),[messages,setMessages]=useState<Message[]>([]),[inbox,setInbox]=useState<JsonObject[]>([]),[live,setLive]=useState<Message|null>(null),[tools,setTools]=useState<ToolRun[]>([]),[sending,setSending]=useState(false);
  const [draft,setDraft]=useState(()=>localStorage.getItem('friend-pi.member-draft:'+key)||''),draftRef=useRef(draft);draftRef.current=draft;
  const liveRef=useRef<Message|null>(null),streamSequence=useRef(0),sendLock=useRef(false),restoredScroll=useRef(false);
  const sendRecord=useRef<{id:string;body:string}|null>(null);
  const active=useRef(true),version=useRef(0),memberRef=useRef(member),scroll=useRef<HTMLDivElement>(null),composing=useRef(false);memberRef.current=member;
  const refresh=useCallback(async()=>{const request=++version.current,raw=asObject(await call(rootSessionId,'history',{memberId}));if(!active.current||request!==version.current)return;const next=raw.member as TeammateView;if(memberRef.current&&next.generation<memberRef.current.generation)return;memberRef.current=next;setMember(next);const native=asList<Message>(raw.messages);setMessages(native);if(liveRef.current&&native.some(message=>message.timestamp===liveRef.current?.timestamp&&message.text===liveRef.current?.text)){liveRef.current=null;setLive(null);}setInbox(asList<JsonObject>(raw.inbox));},[rootSessionId,memberId]);
  useEffect(()=>{active.current=true;void refresh().catch(error=>report(errorText(error),true));return()=>{active.current=false;version.current++;};},[refresh,report]);
  useEffect(()=>{localStorage.setItem('friend-pi.member-draft:'+key,draft);},[key,draft]);
  useEffect(()=>{if(!restoredScroll.current&&messages.length&&scroll.current){scroll.current.scrollTop=Number(sessionStorage.getItem('friend-pi.member-scroll:'+key)||0);restoredScroll.current=true;}},[key,messages]);
  useEffect(()=>window.friendPi.onEvent(event=>{
    if(event.sessionId!==rootSessionId||event.type!=='plugin')return;const data=asObject(event.data),frame=asObject(data.data);
    if(data.pluginEvent==='swarm.changed'){const next=asList<TeammateView>(frame.teammates).find(item=>item.id===memberId);if(next){const prior=memberRef.current;memberRef.current=next;setMember(next);if(prior?.generation!==next.generation){version.current++;liveRef.current=null;setLive(null);setTools([]);void refresh().catch(error=>report(errorText(error),true));}if(next.state!=='running'){liveRef.current=null;setLive(null);void refresh().catch(error=>report(errorText(error),true));}}return;}
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
    <header className="member-heading"><button onClick={onBack}>← 返回主会话</button><div><h2>{member?.name||'正在打开队友会话'}</h2><p>{member?.description}</p></div><span className="member-state">{states[member?.state||'']||'载入中'}</span></header>
    {member?.cwd&&<p className="member-workspace">工作区：{member.cwd}</p>}{member?.reason&&<div className="notice" role="status">{member.reason}{member.state==='paused'&&!archived&&<button onClick={()=>void resume()}>检查后接续</button>}</div>}
    <div className="conversation member-transcript" ref={scroll} onScroll={event=>sessionStorage.setItem('friend-pi.member-scroll:'+key,String(event.currentTarget.scrollTop))}><Conversation messages={messages} live={live} tools={tools} running={member?.state==='running'}/>{inbox.filter(message=>!message.nativeEntryId).map(message=><article className="member-pending-message" key={String(message.id)}><strong>{String(message.from)} · {message.receivedAt?'成员已收件':'已保存，等待处理'}</strong><p>{String(message.body)}</p></article>)}{!messages.length&&!live&&<p className="member-empty">队友尚未开始任务。查看会话不会启动模型。</p>}</div>
    <div className="member-message-receipts" aria-live="polite">{inbox.slice(-3).map(message=><span key={String(message.id)}>{message.nativeEntryId?'已进入上下文':message.receivedAt?'成员已收件':'已保存'} · {String(message.from)}</span>)}</div>
    <div className="member-composer"><label htmlFor={'member-input-'+memberId}>发给队友：{member?.name||'…'} · 补充要求</label><textarea id={'member-input-'+memberId} value={draft} rows={3} disabled={archived||!member} placeholder="补充约束或询问进展；新任务由主 Agent 安排" onChange={event=>setDraft(event.target.value)} onCompositionStart={()=>{composing.current=true;}} onCompositionEnd={()=>{composing.current=false;}} onKeyDown={event=>{const action=composerKeyAction(event.nativeEvent,composing.current);if(action==='none')return;event.preventDefault();if(action==='send')void send();else{const next=insertNewline(draftRef.current,event.currentTarget.selectionStart,event.currentTarget.selectionEnd);setDraft(next.value);}}}/><div className="member-composer-actions"><small>{member?.state==='running'&&!member.discussion?'补充当前任务约束，权限保持冻结。':'已完成成果只读讨论，改动将重新检查与复核。'}</small>{member?.state==='running'&&<button disabled={archived} onClick={()=>void interrupt()}>停止该成员</button>}<button className="primary" disabled={sending||archived||!member||!draft.trim()} onClick={()=>void send()}>{sending?'保存中…':'发送补充'}</button></div></div>
  </section>;
}
