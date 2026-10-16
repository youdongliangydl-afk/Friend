import {mkdirSync,readFileSync,realpathSync,statSync,writeFileSync,opendirSync,lstatSync} from 'node:fs';
import {basename,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {digest,object,type JsonObject} from '@friend-pi/core';
import {captureInput,type InputPayload,type InputAttachment} from './message-queue.js';
import {readDocument} from './document-reader.js';
export const inlineDocumentBytes=96*1024;
/** A folder is an explicit, bounded index. Child contents and symlink targets are never read here. */
export function directoryAttachment(path:string){
 path=realpathSync(path);const directory=opendirSync(path),entries:{name:string;kind:string;bytes?:number;modified?:number}[]=[];let truncated=false,size=0;
 try{for(let entry=directory.readSync();entry;entry=directory.readSync()){
   if(entries.length>=200){truncated=true;break;}const kind=entry.isSymbolicLink()?'符号链接（未跟随）':entry.isDirectory()?'文件夹':entry.isFile()?'文件':'其他';
   const info=entry.isFile()?lstatSync(join(path,entry.name)):undefined,row={name:entry.name,kind,...(info?{bytes:info.size,modified:info.mtimeMs}:{})};size+=Buffer.byteLength(JSON.stringify(row));if(size>60*1024){truncated=true;break;}entries.push(row);
 }}finally{directory.closeSync();}
 entries.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
 const text=`文件夹引用：${path}\n仅提供顶层目录索引，未读取文件正文、展开子目录或跟随符号链接。请按需读取具体文件。${truncated?'\n目录较大，索引仅包含部分条目。':''}\n`+entries.map(entry=>JSON.stringify(entry)).join('\n');
 return {path,name:basename(path),kind:'directory',status:'ready',hash:digest(text),text,sourceBytes:Buffer.byteLength(text),summary:`文件夹 · ${entries.length} 项顶层条目${truncated?'（部分）':''}`,coverage:{status:truncated?'partial':'complete',scope:'仅顶层目录索引，不包含文件正文或子目录内容',readUnits:entries.length,totalUnits:entries.length+(truncated?1:0),unit:truncated?'项（总数至少）':'项'},warnings:['文件正文按需读取；子目录未展开，符号链接未跟随。',...(truncated?['索引达到条目或大小上限，未列出全部条目。']:[])]};
}
export function importAttachments(dataDir:string,raw:unknown){
 if(!Array.isArray(raw)||raw.length>20)throw new Error('一次最多添加20个附件');
 let total=0;const files=raw.map(value=>{const item=object(value),name=basename(String(item.name||'附件')).replace(/[\x00-\x1f]/g,'_'),data=String(item.data||'');if(!name||data.length>14*1024*1024||data.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(data))throw new Error('附件内容无效');const bytes=Buffer.from(data,'base64');if(bytes.toString('base64')!==data)throw new Error('附件编码无效');total+=bytes.length;if(bytes.length>10*1024*1024||total>20*1024*1024)throw new Error('附件单个最多10 MiB，合计最多20 MiB');return {name,bytes};});
 const directory=join(dataDir,'attachments',randomUUID());mkdirSync(directory,{recursive:true,mode:0o700});
 return files.map(({name,bytes},index)=>{const path=join(directory,`${index}-${name}`);writeFileSync(path,bytes,{mode:0o600,flag:'wx'});return {path,name};});
}
export async function inspectAttachment(path:string,read:typeof readDocument=readDocument){
 path=realpathSync(path);if(statSync(path).isDirectory()){const {text,sourceBytes,...snapshot}=directoryAttachment(path);return {...snapshot,delivery:'目录索引会纳入输入，文件正文按需读取'};}if(!statSync(path).isFile()||statSync(path).size>10*1024*1024)throw new Error('附件不是文件或超过10 MiB');
 if(/\.(png|jpe?g|gif|webp)$/i.test(path))return {path,name:basename(path),kind:'image',hash:digest(readFileSync(path).toString('base64')),status:'ready',summary:'图片原件 · 需要支持图片的型号'};
 const document=await read(path);return {path,name:basename(path),kind:document.kind,hash:document.hash,status:'ready',coverage:document.coverage,warnings:document.warnings,characters:document.text.length,summary:`已解析 ${document.coverage.readUnits}/${document.coverage.totalUnits} ${document.coverage.unit} · ${document.text.length.toLocaleString()} 字符`,delivery:Buffer.byteLength(document.text)<=inlineDocumentBytes?'可直接纳入输入':'正文较长，模型通过 read_document 分页读取'};
}
export interface DeliveredAttachment extends InputAttachment {directory?:boolean;sourceBytes?:number;delivery?:'inline'|'reference';coverage?:unknown;modelCharacters?:number;warnings?:string[]}
/** Validate frozen payloads without replacing their bytes with the current file. */
export function validateCapturedInput(input:InputPayload){
 if(input.attachments.length>20)throw new Error('单条消息最多20个附件');let total=0;
 for(const attachment of input.attachments as DeliveredAttachment[]){
  if(attachment.sourceBytes===undefined&&attachment.delivery)throw new Error('历史附件大小未记录，请移除后重新添加');
  const bytes=attachment.sourceBytes??(attachment.image?Buffer.from(attachment.image.data,'base64').length:Buffer.byteLength(attachment.text||''));
  total+=bytes;if(!Number.isSafeInteger(bytes)||bytes<0||bytes>10*1024*1024||total>20*1024*1024)throw new Error('附件单个最多10 MiB，合计最多20 MiB');
 }
 if(!input.text.trim()&&!input.attachments.length)throw new Error('消息不能为空');
 if(Buffer.byteLength(input.text+input.attachments.map(attachment=>attachment.text||'').join(''))>128*1024)throw new Error('消息与附件说明超过128 KiB，请分批发送');
}
export async function captureDocumentInput(input:JsonObject,read:typeof readDocument=readDocument):Promise<InputPayload>{
 const paths=Array.isArray(input.attachments)?input.attachments:[];if(paths.length>20)throw new Error('单条消息最多20个附件');
 const body=typeof input.text==='string'?input.text:'';let total=0,used=Buffer.byteLength(body);const attachments:DeliveredAttachment[]=[];
 for(const raw of paths){const item=object(raw),path=realpathSync(String(item.path||'')),stat=statSync(path);
  if(stat.isDirectory()){const snapshot=directoryAttachment(path);if(item.hash&&item.hash!==snapshot.hash)throw new Error(`文件夹索引已变化，请重新检查：${basename(path)}`);used+=snapshot.sourceBytes;total+=snapshot.sourceBytes;attachments.push({path,name:snapshot.name,hash:snapshot.hash,text:snapshot.text,sourceBytes:snapshot.sourceBytes,directory:true,delivery:'inline',coverage:snapshot.coverage,modelCharacters:snapshot.text.length,warnings:snapshot.warnings});continue;}
  const bytes=stat.size;total+=bytes;if(bytes>10*1024*1024||total>20*1024*1024)throw new Error('附件单个最多10 MiB，合计最多20 MiB');
  if(/\.(png|jpe?g|gif|webp)$/i.test(path)){const attachment=captureInput({text:'.',attachments:[{path}]}).attachments[0];if(item.hash&&item.hash!==attachment.hash)throw new Error(`附件已变化，请重新检查：${basename(path)}`);attachments.push({...attachment,sourceBytes:Buffer.from(attachment.image!.data,'base64').length});continue;}
  const document=await read(path);if(item.hash&&item.hash!==document.hash)throw new Error(`附件已变化，请重新检查：${basename(path)}`);
  const header=`\n附件 ${path}\n内容摘要标识 ${document.hash}；解析范围 ${document.coverage.readUnits}/${document.coverage.totalUnits} ${document.coverage.unit}。范围：${document.coverage.scope}。\n${document.warnings.length?'解析说明：'+document.warnings.join('；')+'\n':''}`;
  const full=header+document.text;const inline=used+Buffer.byteLength(full)<=inlineDocumentBytes;
  const content=inline?full:header+`正文尚未纳入本次输入。请调用 read_document 分页读取；路径必须使用上方原路径。共 ${document.sections.length} 节、${document.text.length} 字符。解析成功不代表已阅读。\n`;
  used+=Buffer.byteLength(content);attachments.push({path,name:basename(path),hash:document.hash,sourceBytes:document.sourceBytes,text:content,delivery:inline?'inline':'reference',coverage:document.coverage,modelCharacters:inline?document.text.length:0,warnings:document.warnings});
 }
 if(!body.trim()&&!attachments.length)throw new Error('消息不能为空');if(used>128*1024)throw new Error('消息与附件说明超过128 KiB，请分批发送');
 const payload:InputPayload={text:body,attachments,mode:input.mode==='team'||input.mode==='swarm'?input.mode:'single',planMode:input.planMode===true};validateCapturedInput(payload);return payload;
}
