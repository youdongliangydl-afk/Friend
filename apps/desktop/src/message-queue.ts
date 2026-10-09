import {readFileSync,realpathSync} from 'node:fs';
import {basename,extname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {RecordStore,object,text,digest,type JsonObject} from '@friend-pi/core';
import type {ImageContent} from '@earendil-works/pi-ai';
export interface InputAttachment {path:string;name:string;hash:string;text?:string;image?:ImageContent}
export interface InputPayload {text:string;attachments:InputAttachment[];mode:'single'|'team'|'swarm';planMode:boolean}
export interface QueuedInput extends InputPayload {id:string;revision:number;state:'queued'|'editing'|'dispatching'|'unknown'|'moving';createdAt:string;runId?:string;submitted?:boolean;targetId?:string;leafId?:string}
export interface QueueSnapshot {paused:boolean;items:QueuedInput[]}
export function captureInput(input:JsonObject):InputPayload{
 const body=typeof input.text==='string'?input.text:'';
 const paths=Array.isArray(input.attachments)?input.attachments:[];if(paths.length>20)throw new Error('单条消息最多 20 个附件');let total=0;
 const attachments:InputAttachment[]=paths.map(raw=>{const path=realpathSync(text(object(raw).path)),bytes=readFileSync(path);total+=bytes.length;if(bytes.length>10*1024*1024||total>20*1024*1024)throw new Error('附件过大：单个最多 10 MiB，合计最多 20 MiB');const mime:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'},base={path,name:basename(path),hash:digest(bytes.toString('base64'))};if(mime[extname(path).toLowerCase()])return {...base,image:{type:'image' as const,data:bytes.toString('base64'),mimeType:mime[extname(path).toLowerCase()]}};if(bytes.includes(0))throw new Error('附件不是可读取的文本或图片');return {...base,text:`\n附件 ${path}：\n${bytes.toString('utf8')}`};});
 if(!body.trim()&&!attachments.length)throw new Error('消息不能为空');if(Buffer.byteLength(body+attachments.map(item=>item.text||'').join(''))>128*1024)throw new Error('消息与文本附件过大，请分批发送');
 return {text:body,attachments,mode:['team','swarm'].includes(String(input.mode))?input.mode as 'team'|'swarm':'single',planMode:input.planMode===true};
}
/** Only unsent payloads live here. Pi remains the owner of delivered messages. */
export class MessageQueue {
 readonly store:RecordStore;
 constructor(readonly sessionId:string,dataDir:string){this.store=new RecordStore('input-queue',dataDir);}
 private key(){return `queue:${this.sessionId}`;}
 snapshot():QueueSnapshot{return this.store.get<QueueSnapshot>(this.key())?.value||{paused:false,items:[]};}
 private put(next:QueueSnapshot){this.store.put(this.key(),next);return next;}
 recover(){const old=this.snapshot();if(old.items.length)this.put({paused:true,items:old.items.map(item=>({...item,state:['dispatching','moving'].includes(item.state)?'unknown':item.state==='editing'?'queued':item.state,revision:item.revision+1}))});}
 add(payload:InputPayload){const value={...payload,id:randomUUID(),revision:1,state:'queued' as const,createdAt:new Date().toISOString()};const old=this.snapshot();if(old.items.length>=50||Buffer.byteLength(JSON.stringify([...old.items,value]))>32*1024*1024)throw new Error('排队消息最多 50 条');this.put({...old,items:[...old.items,value]});return value;}
 read(id:string){const item=this.snapshot().items.find(item=>item.id===id);if(!item)throw new Error('排队消息已发送或移除');return item;}
 change(id:string,revision:number,update:(item:QueuedInput)=>QueuedInput|null){const old=this.snapshot(),item=this.read(id);if(item.revision!==revision)throw new Error('排队消息已变化，请重试');const next=update(item);return this.put({...old,items:old.items.flatMap(row=>row.id===id?next?[{...next,revision:row.revision+1}]:[]:[row])});}
 pause(paused:boolean){return this.put({...this.snapshot(),paused});}
 edit(id:string,revision:number,body?:string){return this.change(id,revision,item=>{if(!['queued','editing'].includes(item.state))throw new Error('消息正在交付，不能编辑');if(body!==undefined&&(!body.trim()&&!item.attachments.length||Buffer.byteLength(body+item.attachments.map(a=>a.text||'').join(''))>128*1024))throw new Error('消息为空或过大');return {...item,...(body===undefined?{}:{text:body}),state:body===undefined?'editing':'queued'};});}
 cancelEdit(id:string,revision:number){return this.change(id,revision,item=>{if(item.state!=='editing')throw new Error('消息不在编辑中');return {...item,state:'queued'};});}
 remove(id:string,revision:number){return this.change(id,revision,item=>{if(['dispatching','moving'].includes(item.state))throw new Error('消息正在交付，不能删除');return null;});}
 claim(id:string,revision:number,runId:string){this.change(id,revision,item=>{if(item.state!=='queued')throw new Error('消息当前不能发送');return {...item,state:'dispatching',runId};});return this.read(id);}
 delivered(id:string,runId?:string){const item=this.snapshot().items.find(item=>item.id===id);if(item&&['dispatching','unknown'].includes(item.state)&&item.runId===runId)this.change(id,item.revision,()=>null);}
 handoff(id:string){const item=this.read(id);if(item.state!=='dispatching')throw new Error('消息交付已取消');this.change(id,item.revision,row=>({...row,submitted:true}));}
 failed(id:string){const item=this.snapshot().items.find(item=>item.id===id);if(item?.state==='dispatching'&&!item.submitted)this.change(id,item.revision,row=>({...row,state:'queued',runId:undefined}));else if(item&&item.state!=='queued')this.unknown(id);this.pause(true);}
 unknown(id:string){const item=this.snapshot().items.find(item=>item.id===id);if(item)this.change(id,item.revision,row=>({...row,state:'unknown'}));this.pause(true);}
 moving(id:string,revision:number,targetId:string,leafId?:string){this.change(id,revision,item=>{if(item.state!=='queued')throw new Error('消息当前不能移出');return {...item,state:'moving',targetId,leafId};});return this.read(id);}
 moved(id:string,targetId:string){const item=this.read(id);if(!['moving','unknown'].includes(item.state)||item.targetId!==targetId)throw new Error('侧边草稿交接身份不匹配');return this.change(id,item.revision,()=>null);}
 release(id:string,targetId:string){const item=this.read(id);if(item.state!=='moving'||item.targetId!==targetId)throw new Error('侧边草稿交接身份已变化');return this.change(id,item.revision,row=>({...row,state:'queued',targetId:undefined}));}
 dispose(){this.store.close();}
}
