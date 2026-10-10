import {realpathSync,readFileSync,statSync,readdirSync} from 'node:fs';
import {isAbsolute,relative,resolve} from 'node:path';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {digest} from '@friend-pi/core';
export function fileReferences(root:string,query:string){
 const slash=query.lastIndexOf('/'),directory=slash<0?'':query.slice(0,slash),term=slash<0?query:query.slice(slash+1);
 const base=directory?referencePath(root,directory):realpathSync(root),matches=readdirSync(base,{withFileTypes:true}).filter(entry=>!['.git','node_modules','.cache','.artifacts','.DS_Store'].includes(entry.name)&&entry.name.toLowerCase().includes(term.toLowerCase())).map(entry=>({name:entry.name,path:relative(root,resolve(base,entry.name))})).filter(entry=>{try{referencePath(root,entry.path);return true;}catch{return false;}}).sort((a,b)=>a.path.localeCompare(b.path,'zh-CN'));return {items:matches.slice(0,60).map(entry=>{const path=referencePath(root,entry.path),directory=statSync(path).isDirectory();return {id:'file:'+entry.path,label:entry.path+(directory?'/':''),kind:directory?'目录':'文件',path,insert:'@'+JSON.stringify(path)};}),truncated:matches.length>60};
}
export function referencePath(root:string,path:string){const actual=realpathSync(resolve(root,path)),rel=relative(realpathSync(root),actual);if(rel==='..'||rel.startsWith('../')||isAbsolute(rel))throw new Error('引用不在当前工作区内');return actual;}
export function sessionReference(path:string,label:string){
 const manager=SessionManager.open(path),entries=manager.getBranch().filter(entry=>entry.type==='message');const selected=entries.slice(-20);let content=selected.map(entry=>{if(entry.type!=='message')return '';const message=entry.message as unknown as Record<string,unknown>;const body=typeof message.content==='string'?message.content:Array.isArray(message.content)?message.content.filter(part=>part.type==='text').map(part=>part.text).join('\n'):'';return `[${entry.id}] ${message.role}: ${body}`;}).join('\n');let clipped=false;if(Buffer.byteLength(content)>48*1024){const bytes=Buffer.from(content);let start=bytes.length-48*1024;while(start<bytes.length&&(bytes[start]&0xc0)===0x80)start++;content=bytes.subarray(start).toString('utf8');clipped=true;}
 return `\n引用会话「${label}」\n原始Pi历史：${path}\n来源摘要：${digest(readFileSync(path).toString('base64'))}\n范围：最近 ${selected.length}/${entries.length} 条消息的文字部分${clipped?'，因长度限制只包含尾部48 KiB':''}；不包含图片像素或完整历史。\n${content}\n`;
}
