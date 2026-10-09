/** DeepSeek mailbox receipt boundary adapted to Pi public history + SQLite.
 * Copyright (c) 2026 DeepSeek. MIT; see DEEPSEEK-LICENSE. */
import {openSync,fsyncSync,closeSync} from 'node:fs';
import {RecordStore,digest} from '@friend-pi/core';
import type {AgentSession} from '@earendil-works/pi-coding-agent';
import type {MemberStart,MemberMessage,MemberOutput,Teammate} from './types.js';
import {mailboxKey,teammateKey,teamMessageText} from './teammates.js';

export class MemberInbox {
  private readonly store:RecordStore;
  private readonly admitted=new Map<string,MemberMessage>();
  constructor(private readonly start:MemberStart,private readonly session:AgentSession,private readonly output:(message:MemberOutput)=>void){this.store=new RecordStore('swarm',start.dataDir);}
  owned():boolean {const member=this.store.get<Teammate>(teammateKey(this.start.rootSessionId!,this.start.memberId!))?.value;return member?.state==='running'&&member.attemptId===this.start.attemptId&&member.generation===this.start.generation;}
  pending():MemberMessage[]{return this.store.list<MemberMessage>('teammate-message:'+this.start.rootSessionId+':').map(row=>row.value).filter(message=>message.memberId===this.start.memberId&&!message.processedAt).sort((a,b)=>(a.sequence||0)-(b.sequence||0));}
  receive(id:string,bodyDigest?:string):MemberMessage|undefined {
    if(!this.owned())return;
    const key=mailboxKey(this.start.rootSessionId!,id),row=this.store.get<MemberMessage>(key);
    if(!row||row.value.memberId!==this.start.memberId||digest(row.value.body)!==row.value.bodyDigest||bodyDigest&&bodyDigest!==row.value.bodyDigest)throw new Error('消息来源或摘要不匹配');
    if(row.value.processedAt||this.admitted.has(id))return;
    this.store.transaction(()=>{if(!this.owned())throw new Error('成员执行代次已失效');const saved=this.store.get<MemberMessage>(key)!;saved.value.receivedAt??=new Date().toISOString();saved.value.deliveredAt=saved.value.receivedAt;saved.value.attemptId=this.start.attemptId;saved.value.generation=this.start.generation;this.store.put(key,saved.value,saved.revision);});
    this.admitted.set(id,row.value);this.output({v:1,type:'received',messageId:id});return row.value;
  }
  receiveOrdered(id:string,bodyDigest?:string):MemberMessage[]{
    const target=this.store.get<MemberMessage>(mailboxKey(this.start.rootSessionId!,id))?.value;
    if(!target||target.memberId!==this.start.memberId||bodyDigest&&bodyDigest!==target.bodyDigest)throw new Error('消息来源或摘要不匹配');
    // A late/duplicated IPC frame drains the durable prefix, never changes recipient order.
    return this.pending().filter(message=>(message.sequence||0)<=(target.sequence||0)).flatMap(message=>{const admitted=this.receive(message.id,message.bodyDigest);return admitted?[admitted]:[];});
  }
  reconcile():void {
    if(!this.owned())return;
    const entries=this.session.sessionManager.getEntries();
    for(const [id,message] of this.admitted){
      const expected=teamMessageText(message),entry=entries.find(item=>item.type==='message'&&item.message.role==='user'&&(typeof item.message.content==='string'?item.message.content===expected:item.message.content.some(part=>part.type==='text'&&part.text===expected)));
      if(!entry)continue;
      this.session.sessionManager.appendCustomEntry('friend-pi.swarm.message.v2',{messageId:id,memberId:this.start.memberId,generation:this.start.generation,bodyDigest:message.bodyDigest,entryId:entry.id});
      const file=this.session.sessionFile;if(!file)throw new Error('成员原生会话尚未持久化');const fd=openSync(file,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
      this.store.transaction(()=>{if(!this.owned())return;const key=mailboxKey(this.start.rootSessionId!,id),row=this.store.get<MemberMessage>(key)!;if(row.value.processedAt)return;row.value.processedAt=new Date().toISOString();row.value.nativeEntryId=entry.id;this.store.put(key,row.value,row.revision);});
      this.admitted.delete(id);this.output({v:1,type:'context',messageId:id,nativeEntryId:entry.id});
    }
  }
  close():void{this.store.close();}
}
