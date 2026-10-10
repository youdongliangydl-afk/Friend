import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join,posix} from 'node:path';
import {tmpdir} from 'node:os';
const execute=promisify(execFile);
export const DOCUMENT_LIMITS={fileBytes:64*1024*1024,expandedBytes:128*1024*1024,entryBytes:16*1024*1024,entries:10_000,units:2_000,cells:1_000_000,textBytes:64*1024*1024} as const;
interface Entry {name:string;size:number}
function entries(bytes:Buffer):Map<string,Entry>{
  let end=-1;for(let p=bytes.length-22;p>=Math.max(0,bytes.length-65557);p--)if(bytes.readUInt32LE(p)===0x06054b50&&p+22+bytes.readUInt16LE(p+20)===bytes.length){end=p;break;}
  if(end<0)throw new Error('Office 文件不是完整的 ZIP 文档');
  const count=bytes.readUInt16LE(end+10),size=bytes.readUInt32LE(end+12),start=bytes.readUInt32LE(end+16);
  if(bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6)||count!==bytes.readUInt16LE(end+8))throw new Error('不支持分卷 Office 文档');
  if(count===65535||size===0xffffffff||start===0xffffffff)throw new Error('文档使用 ZIP64，超出当前读取范围');
  if(count>DOCUMENT_LIMITS.entries||start+size>end)throw new Error('Office ZIP 目录超出资源上限或已损坏');
  const result=new Map<string,Entry>();let p=start,total=0;
  for(let i=0;i<count;i++){
    if(p+46>start+size||bytes.readUInt32LE(p)!==0x02014b50)throw new Error('Office ZIP 目录损坏');
    const flags=bytes.readUInt16LE(p+8),method=bytes.readUInt16LE(p+10),expanded=bytes.readUInt32LE(p+24),length=bytes.readUInt16LE(p+28),extra=bytes.readUInt16LE(p+30),comment=bytes.readUInt16LE(p+32),next=p+46+length+extra+comment;
    if(next>start+size||expanded===0xffffffff)throw new Error('Office ZIP 条目损坏或超出资源上限');
    const name=new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(p+46,p+46+length));
    if(!name||name.includes('\0')||name.includes('\\')||name.startsWith('/')||name.split('/').includes('..')||result.has(name))throw new Error('Office ZIP 包含不安全或重复的条目路径');
    if(flags&1)throw new Error('文档已加密，请先解除密码保护');if(![0,8].includes(method))throw new Error('不支持此 Office ZIP 压缩方式');
    total+=expanded;if(total>DOCUMENT_LIMITS.expandedBytes)throw new Error('文档解压内容超过 128 MiB 上限');result.set(name,{name,size:expanded});p=next;
  }
  if(p!==start+size)throw new Error('Office ZIP 目录大小不匹配');return result;
}
export interface DocumentArchive {names:string[];read(name:string):Promise<Buffer>;has(name:string):boolean}
export async function withDocumentArchive<T>(bytes:Buffer,read:(archive:DocumentArchive)=>Promise<T>):Promise<T>{
  const index=entries(bytes),directory=await mkdtemp(join(tmpdir(),'friend-document-')),path=join(directory,'source.zip');
  try{
    await writeFile(path,bytes,{mode:0o600});const cache=new Map<string,Buffer>();
    return await read({names:[...index.keys()],has:name=>index.has(name),read:async name=>{
      const entry=index.get(name);if(!entry)throw new Error('Office 文档缺少 '+name);if(entry.size>DOCUMENT_LIMITS.entryBytes)throw new Error('文档单个 XML 条目超过 16 MiB 上限');
      if(/[\[\]*?\\]/.test(name))throw new Error('Office 文档条目名称含不支持的匹配字符');if(cache.has(name))return cache.get(name)!;
      const {stdout}=await execute('/usr/bin/unzip',['-p',path,name],{encoding:'buffer',maxBuffer:Math.max(1024,entry.size+1),timeout:15_000});
      if(stdout.length!==entry.size)throw new Error('Office 文档条目解压大小不匹配');cache.set(name,stdout);return stdout;
    }});
  }finally{await rm(directory,{recursive:true,force:true});}
}
export function relationshipTarget(from:string,target:string){
  if(/^[a-z][a-z\d+.-]*:/i.test(target)||target.includes('\\')||target.includes('\0'))throw new Error('文档关系指向不支持的外部资源');
  const resolved=posix.normalize(target.startsWith('/')?target.slice(1):posix.join(posix.dirname(from),target));if(resolved.startsWith('../')||resolved==='..')throw new Error('文档关系路径超出 ZIP 文档');return resolved;
}
