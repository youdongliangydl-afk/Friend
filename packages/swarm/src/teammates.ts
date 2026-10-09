/** Adapted from DeepSeek Harness Agent Teams roster/mailbox at 5badb15009ae1756c3afe0ae0cef1faafc290ccc.
 * Copyright (c) 2026 DeepSeek. MIT; see DEEPSEEK-LICENSE and SOURCES.md.
 * Friend adaptation: SQLite admission/inbox, Pi-owned history and attempt-generation fences. */
import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync,realpathSync} from 'node:fs';
import {relative,isAbsolute,join} from 'node:path';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {RecordStore,ConflictError,digest,text,type PluginContext,type JsonObject} from '@friend-pi/core';
import type {MemberMessage,Task,Teammate} from './types.js';

const now=()=>new Date().toISOString();
export const teammateKey=(root:string,id:string)=>'teammate:'+root+':'+id;
export const mailboxKey=(root:string,id:string)=>'teammate-message:'+root+':'+id;
export function teamMessageText(message:MemberMessage):string {
  return 'Team message '+message.id+' from '+message.from+' [swarm-message:'+message.id+']\n'+message.body;
}
export function nativeBranch(file:string):unknown[] {
  if(!existsSync(file))return [];
  // Read through an in-memory Pi manager so viewing never rewrites/migrates the source log.
  const source=readFileSync(file,'utf8'),lines=source.split('\n'),entries:unknown[]=[];
  for(let i=0;i<lines.length;i++){if(!lines[i].trim())continue;try{entries.push(JSON.parse(lines[i]));}catch{if(i!==lines.length-1||source.endsWith('\n'))throw new Error('成员原生会话损坏，保留现场');}}
  const manager=SessionManager.inMemory(undefined,undefined,entries as NonNullable<Parameters<typeof SessionManager.inMemory>[2]>);
  return manager.getBranch();
}
function entryText(entry:unknown):string {
  const item=entry as {type?:string;message?:{role?:string;content?:unknown}};
  if(item.type!=='message'||item.message?.role!=='user')return '';
  const content=item.message.content;
  return typeof content==='string'?content:Array.isArray(content)?content.filter(part=>part.type==='text').map(part=>part.text).join('\n'):'';
}
export class TeammateStore {
  private readonly dispatchTails=new Map<string,Promise<void>>();
  constructor(private readonly store:RecordStore){}
  list(ctx:PluginContext):Teammate[]{return this.store.list<Teammate>('teammate:'+ctx.sessionId+':').map(row=>row.value).filter(item=>item.projectId===ctx.projectId);}
  get(id:string,ctx:PluginContext):Teammate {
    const value=this.store.get<Teammate>(teammateKey(ctx.sessionId,id))?.value;
    if(!value||value.projectId!==ctx.projectId||value.rootSessionId!==ctx.sessionId)throw new Error('队友不存在或不属于当前会话');
    return value;
  }
  update(id:string,ctx:PluginContext,change:(member:Teammate)=>void):Teammate {
    return this.store.transaction(()=>{const key=teammateKey(ctx.sessionId,id),row=this.store.get<Teammate>(key);if(!row)throw new Error('队友不存在');const value=this.get(id,ctx);change(value);value.updatedAt=now();this.store.put(key,value,row.revision);return value;});
  }
  create(input:JsonObject,ctx:PluginContext):Teammate {
    const name=text(input.name,'队友名称',80),key=typeof input.key==='string'?input.key:undefined;
    return this.store.transaction(()=>{
      if(this.list(ctx).some(member=>member.name===name))throw new ConflictError('队友名称已存在，请复用该成员');
      const member:Teammate={id:randomUUID(),projectId:ctx.projectId,rootSessionId:ctx.sessionId,name,description:typeof input.description==='string'?text(input.description,'职责',2000):name,key,state:'idle',generation:0,nextSequence:0,createdAt:now(),updatedAt:now()};
      this.store.put(teammateKey(ctx.sessionId,member.id),member,null);return member;
    });
  }
  forTask(task:Task,ctx:PluginContext):Teammate {
    if(task.memberId)return this.get(task.memberId,ctx);
    let name=task.memberName||task.title.slice(0,60);const existing=this.list(ctx).find(member=>task.memberName?member.name===name:member.key===task.id);if(existing)return existing;if(this.list(ctx).some(member=>member.name===name))name=name.slice(0,50)+' ('+task.id.slice(0,24)+')';return this.create({name,description:task.title,key:task.id},ctx);
  }
  acquire(id:string,attemptId:string,graphId:string,taskId:string,ctx:PluginContext,runtime:string,discussion=false):Teammate {
    return this.update(id,ctx,member=>{
      if(member.state!=='idle')throw new ConflictError('队友正在执行或需要明确接续');
      member.generation++;member.state='running';member.attemptId=attemptId;member.graphId=graphId;member.taskId=taskId;member.ownerPid=process.pid;member.ownerRuntime=runtime;member.discussion=discussion;member.reason=undefined;
    });
  }
  owns(member:Teammate,attemptId:string,generation:number|undefined):boolean {return member.attemptId===attemptId&&member.generation===generation&&member.state==='running';}
  release(id:string,attemptId:string,ctx:PluginContext,state:Teammate['state']='idle',reason?:string):void {
    this.update(id,ctx,member=>{if(member.attemptId!==attemptId)return;member.state=state;member.reason=reason;if(state==='idle'){member.attemptId=undefined;member.discussion=false;member.ownerPid=undefined;member.ownerRuntime=undefined;}});
  }
  messages(id:string,ctx:PluginContext):MemberMessage[]{this.get(id,ctx);return this.store.list<MemberMessage>('teammate-message:'+ctx.sessionId+':').map(row=>row.value).filter(message=>message.memberId===id).sort((a,b)=>(a.sequence||0)-(b.sequence||0));}
  enqueue(id:string,input:JsonObject,ctx:PluginContext,from:string,senderMemberId?:string):MemberMessage {
    const body=text(input.body,'补充要求',65536),messageId=input.messageId?text(input.messageId,'消息标识',100):randomUUID();
    return this.store.transaction(()=>{
      const prior=this.store.get<MemberMessage>(mailboxKey(ctx.sessionId,messageId));
      if(prior){if(prior.value.memberId!==id||prior.value.body!==body||prior.value.from!==from)throw new ConflictError('同一消息标识的内容或收件人已变化');return prior.value;}
      const member=this.get(id,ctx),pending=this.messages(id,ctx).filter(message=>!message.processedAt);if(pending.length>=64)throw new Error('成员待处理消息已满');
      if(input.generation!==undefined&&input.generation!==member.generation)throw new ConflictError('队友执行代次已变化，请刷新后发送');
      const sequence=member.nextSequence+1;this.update(id,ctx,value=>{value.nextSequence=sequence;});
      const message:MemberMessage={id:messageId,graphId:member.graphId||'',from,to:id,memberId:id,senderMemberId,body,bodyDigest:digest(body),kind:member.state==='running'&&!member.discussion?'constraint':'discussion',sequence,createdAt:now()};
      this.store.put(mailboxKey(ctx.sessionId,messageId),message,null);return message;
    });
  }
  history(id:string,ctx:PluginContext):{member:Teammate;entries:unknown[];messages:MemberMessage[]} {
    const member=this.get(id,ctx);return {member,entries:member.sessionFile&&existsSync(member.sessionFile)?nativeBranch(this.trustedFile(member,ctx)):[],messages:this.messages(id,ctx)};
  }
  trustedFile(member:Teammate,ctx:PluginContext):string {
    const file=member.sessionFile;if(!file||!existsSync(file))throw new Error('成员会话尚未持久保存或文件已丢失');
    const rel=relative(realpathSync(join(ctx.dataDir,'swarm-sessions',ctx.projectId,ctx.sessionId,member.id)),realpathSync(file));if(rel.startsWith('..')||isAbsolute(rel))throw new Error('成员会话路径不属于本客户端数据目录');return file;
  }
  recover(id:string,ctx:PluginContext):void {
    const member=this.get(id,ctx);if(!member.sessionFile||!existsSync(member.sessionFile))return;
    const entries=nativeBranch(this.trustedFile(member,ctx));
    for(const message of this.messages(id,ctx)){
      if(message.processedAt)continue;const entry=entries.find(item=>entryText(item)===teamMessageText(message)) as {id?:string}|undefined;
      if(entry?.id)this.store.transaction(()=>{const key=mailboxKey(ctx.sessionId,message.id),saved=this.store.get<MemberMessage>(key)!;saved.value.processedAt=now();saved.value.nativeEntryId=entry.id;saved.value.receivedAt??=now();saved.value.deliveredAt??=saved.value.receivedAt;this.store.put(key,saved.value,saved.revision);});
    }
  }
  async serialize<T>(id:string,operation:()=>Promise<T>):Promise<T> {
    // Upstream target-local dispatch tail; durable sequence owns order across restarts.
    const prior=this.dispatchTails.get(id)||Promise.resolve(),run=prior.then(operation,operation),tail=run.then(()=>undefined,()=>undefined);this.dispatchTails.set(id,tail);
    try{return await run;}finally{if(this.dispatchTails.get(id)===tail)this.dispatchTails.delete(id);}
  }
}
