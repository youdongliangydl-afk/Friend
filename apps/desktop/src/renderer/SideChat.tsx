import {queueIntent,acknowledgeQueueIntent,hasQueueIntent} from './queue-intent.js';
import {useCallback,useEffect,useRef,useState} from 'react';
import {PiDialog} from './PiDialog.js';
import type {DialogRequest} from './types.js';
import {Conversation} from './Conversation.js';
import {SessionComposer,type ComposerSnapshot,type ComposerAction} from './SessionComposer.js';
import {asObject,asList,errorText,type AppState,type Message} from './types.js';
import {piLiveMessage,updateToolRun,type ToolRun} from './timeline.js';
export function SideChat({id,onClose,onOpen,onSettings,report}:{id:string;onClose():void;onOpen(id:string):void;onSettings():void;report(message:string,error?:boolean):void}){
 const [dialogs,setDialogs]=useState<DialogRequest[]>([]),[state,setState]=useState<AppState|null>(null),[draft,setDraft]=useState(''),[attachments,setAttachments]=useState<{path:string}[]>([]),[planMode,setPlanMode]=useState(false),[mode,setMode]=useState<'single'|'team'|'swarm'>('single');
 const [live,setLive]=useState<Message|null>(null),[tools,setTools]=useState<ToolRun[]>([]),[sending,setSending]=useState(false),[queueUi,setQueueUi]=useState({}),historyRef=useRef<HTMLDivElement>(null),following=useRef(true),lock=useRef(false),draftRef=useRef(draft),attachmentRef=useRef(attachments);draftRef.current=draft;attachmentRef.current=attachments;
 const saveDraft=(body=draftRef.current,files=attachmentRef.current)=>localStorage.setItem('friend-pi.draft.v1:'+id,JSON.stringify({text:body,attachments:files,mode,planMode}));
 const refresh=useCallback(async()=>{const value=await window.friendPi.request<AppState>('session.sidechat.read',{sessionId:id});setState(value);return value;},[id]);
 useEffect(()=>{let active=true;void refresh().then(next=>{if(!active)return;const local=localStorage.getItem('friend-pi.draft.v1:'+id),saved=local?asObject(JSON.parse(local)):next.current?.sideDraft;setDraft(typeof saved?.text==='string'?saved.text:'');setAttachments(asList<{path:string}>(saved?.attachments));setPlanMode(saved?.planMode===true);const selected=String(saved?.mode||next.current?.executionMode||'single');setMode(selected==='team'||selected==='swarm'?selected:'single');}).catch(e=>report(errorText(e),true));const off=window.friendPi.onEvent(event=>{if(event.sessionId!==id)return;const data=asObject(event.data);if(event.type==='dialog')setDialogs(old=>old.some(row=>row.id===data.id)?old:[...old,data as unknown as DialogRequest]);if(String(event.type)==='dialog.closed')setDialogs(old=>old.filter(row=>row.id!==data.id));if(event.type==='notice')report(String(data.message||''),data.level==='error');if(String(event.type)==='sidechat.state')setState(event.data as AppState);if(String(event.type)==='stream')setLive(piLiveMessage(asObject(asObject(data.event).message),String(data.streamId||'side-live')));if(event.type==='pi'){if(data.type==='agent_start')setLive(null);if(data.type==='agent_settled'){setLive(null);void refresh();}if(data.type==='tool_execution_start')setTools(old=>[...old,{id:String(data.toolCallId),name:String(data.toolName),status:'running',input:data.args}]);if(['tool_execution_update','tool_execution_end'].includes(String(data.type)))setTools(old=>updateToolRun(old,data));}});return()=>{active=false;off();};},[id,refresh,report]);
 useEffect(()=>{if(following.current&&historyRef.current)historyRef.current.scrollTop=historyRef.current.scrollHeight;},[state?.current?.messages,live]);
 const action=async(input:ComposerAction)=>{
  if(lock.current&&['draft','send','attach','removeAttachment'].includes(input.type))return;
  if(input.type==='send'){
   if(lock.current)return;lock.current=true;setSending(true);const body=input.text??draftRef.current,files=[...attachmentRef.current];
   try{
    if(state?.current?.isRunning||state?.current?.queue?.items.length||!!state?.current?.sideDraft||hasQueueIntent(id,{text:body,attachments:files,mode,planMode})){const payload={text:body,attachments:files,mode,planMode},intent=queueIntent(id,payload);await window.friendPi.request('session.queue',{sessionId:id,action:'add',...payload,intentId:intent.id,fromSideDraft:!!state?.current?.sideDraft});acknowledgeQueueIntent(intent);}
    else await window.friendPi.request('session.send',{sessionId:id,text:body,attachments:files,mode,planMode});
    const nextBody=draftRef.current===body?'':draftRef.current,nextFiles=JSON.stringify(attachmentRef.current)===JSON.stringify(files)?[]:attachmentRef.current;
    draftRef.current=nextBody;attachmentRef.current=nextFiles;setDraft(nextBody);setAttachments(nextFiles);saveDraft(nextBody,nextFiles);await refresh();
   }catch(error){report(errorText(error),true);}finally{lock.current=false;setSending(false);}return;
  }
  try{
   if(input.type==='draft'){const body=String(input.value||'');draftRef.current=body;setDraft(body);saveDraft(body);}
   else if(input.type==='queueUi')setQueueUi(asObject(input.value));
   else if(input.type==='queue'){const result=await window.friendPi.request('session.queue',{sessionId:id,...asObject(input.value)});if(asObject(input.value).action==='sidechat')onOpen(String(asObject(result).sessionId));await refresh();}
   else if(input.type==='stop'){await window.friendPi.request('session.stop',{sessionId:id});await refresh();}
   else if(input.type==='attach'){const picked=asList<{path:string}>(await window.friendPi.request('file.pick'));const files=[...new Map([...attachmentRef.current,...picked].map(file=>[file.path,{path:file.path}])).values()];attachmentRef.current=files;setAttachments(files);saveDraft(undefined,files);}
   else if(input.type==='removeAttachment'){const files=attachmentRef.current.filter(file=>file.path!==input.value);attachmentRef.current=files;setAttachments(files);saveDraft(undefined,files);}
   else if(input.type==='plan'){setPlanMode(input.value===true);localStorage.setItem('friend-pi.draft.v1:'+id,JSON.stringify({text:draftRef.current,attachments:attachmentRef.current,mode,planMode:input.value===true}));}
   else if(input.type==='mode'||input.type==='permission'||input.type==='model'){
    const patch=input.type==='mode'?{executionMode:input.value}:input.type==='permission'?{permissionMode:input.value}:asObject(input.value);
    await window.friendPi.request('session.configure',{sessionId:id,...patch});const next=await refresh();if(input.type==='mode'){const selected=next.current?.executionMode||'single';setMode(selected);localStorage.setItem('friend-pi.draft.v1:'+id,JSON.stringify({text:draftRef.current,attachments:attachmentRef.current,mode:selected,planMode}));}
   }
   else if(input.type==='settings')onSettings();
  }catch(error){report(errorText(error),true);}
 };
 const current=state?.current,value:ComposerSnapshot|undefined=current&&state?{sessionId:id,epoch:0,draft,attachments,running:current.isRunning,sending,navigating:false,archived:false,planMode,permissionMode:current.permissionMode||'auto',permissionExplicit:true,mode,plugins:current.plugins,models:state.models,modelId:current.modelId,thinkingLevel:current.thinkingLevel,thinkingLevels:current.thinkingLevels||['off'],ready:!!state.models.find(model=>model.id===current.modelId)?.ready,floating:false,collapsed:false,status:'侧边聊天',queue:current.queue,queueUi}:undefined;
 return <section className="side-chat" aria-label="侧边聊天"><header><div><strong>侧边聊天</strong><small>继承已提交上下文 · 独立执行</small></div><button aria-label="关闭侧边聊天" onClick={onClose}>×</button></header><div className="side-chat-history" ref={historyRef} onScroll={e=>{const element=e.currentTarget;following.current=element.scrollHeight-element.scrollTop-element.clientHeight<100;}}>{current?<Conversation messages={current.messages} live={live} tools={tools} running={current.isRunning} readingKey={id}/>:<p>正在打开侧边聊天…</p>}</div>{value&&<SessionComposer value={value} action={action}/>} {dialogs[0]&&<PiDialog key={dialogs[0].id} dialog={dialogs[0]} respond={input=>{const dialogId=dialogs[0].id;void window.friendPi.request('dialog.respond',{id:dialogId,...input}).then(()=>setDialogs(old=>old.filter(row=>row.id!==dialogId))).catch(e=>report(errorText(e),true));}}/>}</section>;
}
