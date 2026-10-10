import {lookup} from 'node:dns/promises';
import {request as httpRequest,type RequestOptions,type IncomingMessage,type ClientRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import {isIP} from 'node:net';

export interface ExternalNetwork {
  lookup(host:string):Promise<Array<{address:string;family:number}>>;
  request(url:URL,options:RequestOptions,callback:(response:IncomingMessage)=>void):ClientRequest;
}
const network:ExternalNetwork={lookup:host=>lookup(host,{all:true,verbatim:true}),request:(url,options,callback)=>(url.protocol==='https:'?httpsRequest:httpRequest)(url,options,callback)};

export function isPublicAddress(address:string):boolean {
  const host=address.toLowerCase().replace(/^\[|\]$/g,'');
  if(isIP(host)===4){
    const [a,b,c]=host.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0&&(c===0||c===2))||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
  }
  // Only native global-unicast IPv6; mapped IPv4 and transition addresses stay denied.
  return isIP(host)===6&&/^[23][0-9a-f]{3}:/.test(host)&&!/^2001:(?:db8|0|10|20):/.test(host)&&!host.startsWith('2002:');
}

export function publicWebUrl(value:unknown):URL {
  if(typeof value!=='string'||value.length>8192)throw new Error('请提供完整的 HTTP(S) 网页地址');
  let url:URL;try{url=new URL(value);}catch{throw new Error('网页地址无效');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('仅支持不含账号密码的 HTTP(S) 网页地址');
  const host=url.hostname.toLowerCase().replace(/^\[|\]$/g,'');
  if(host==='localhost'||host.endsWith('.localhost')||host.endsWith('.local')||host.endsWith('.internal')||isIP(host)&&!isPublicAddress(host))throw new Error('网页工具不能访问本机、私网或保留地址');
  url.hash='';return url;
}

function aborted(signal:AbortSignal):never{throw signal.reason instanceof Error?signal.reason:new Error('网页请求已取消');}
async function resolvePublic(url:URL,signal:AbortSignal,net:ExternalNetwork){
  if(signal.aborted)aborted(signal);
  const host=url.hostname.replace(/^\[|\]$/g,'');
  let abort:()=>void=()=>{};
  try{
    const addresses=isIP(host)?[{address:host,family:isIP(host)}]:await Promise.race([net.lookup(host),new Promise<never>((_resolve,reject)=>{abort=()=>reject(signal.reason||new Error('网页请求已取消'));signal.addEventListener('abort',abort,{once:true});})]);
    if(!addresses.length||addresses.some(item=>!isPublicAddress(item.address)))throw new Error('网页工具不能访问本机、私网或保留地址');
    return addresses;
  }finally{signal.removeEventListener('abort',abort);}
}

export async function readPublicText(value:string,options:{signal?:AbortSignal;maxBytes?:number;headers?:Record<string,string>;redirects?:boolean;network?:ExternalNetwork}={}){
  const signal=AbortSignal.any([AbortSignal.timeout(20_000),...(options.signal?[options.signal]:[])]),net=options.network||network,maxBytes=options.maxBytes??2_000_000;
  let url=publicWebUrl(value);
  for(let hop=0;hop<=5;hop++){
    const addresses=await resolvePublic(url,signal,net);
    const result=await new Promise<{status:number;location?:string;mediaType:string;body:string;bytes:number;truncated:boolean}>((resolve,reject)=>{
      let settled=false;const finish=(error?:Error,result?:Parameters<typeof resolve>[0])=>{if(settled)return;settled=true;error?reject(error):resolve(result!);};
      const req=net.request(url,{method:'GET',signal,headers:{'User-Agent':'Friend-Pi/0.1 (read-only web tools)',Accept:'text/html, text/plain, application/json;q=0.9','Accept-Encoding':'identity',...options.headers},
        // Pin the validated DNS result to this connection, preventing a second DNS lookup.
        lookup:(_host,lookupOptions,callback)=>{const list=typeof lookupOptions==='object'&&lookupOptions.family?addresses.filter(item=>item.family===lookupOptions.family):addresses;if(!list.length){callback(new Error('网页地址没有匹配的公网 IP'),'',4);return;}if(typeof lookupOptions==='object'&&lookupOptions.all)(callback as (...args:unknown[])=>void)(null,list);else callback(null,list[0].address,list[0].family);}},response=>{
        const status=response.statusCode||0,mediaType=String(response.headers['content-type']||'text/plain').split(';')[0].trim().toLowerCase(),location=response.headers.location;
        if(status>=300&&status<400){response.resume();finish(undefined,{status,location,mediaType,body:'',bytes:0,truncated:false});return;}
        if(status<200||status>=300){response.resume();finish(new Error(`网页请求失败（HTTP ${status}）`));return;}
        if(response.headers['content-encoding']&&response.headers['content-encoding']!=='identity'){response.resume();finish(new Error('服务器返回了不支持的压缩内容'));return;}
        if(!/^text\//.test(mediaType)&&!/(?:json|xml|javascript)$/.test(mediaType)){response.resume();finish(new Error('此地址返回二进制文件，请使用附件或文件预览'));return;}
        const chunks:Buffer[]=[];let bytes=0;
        response.on('data',(part:Buffer)=>{if(settled)return;const chunk=Buffer.from(part),available=maxBytes-bytes;chunks.push(chunk.subarray(0,available));bytes+=Math.min(chunk.length,available);if(chunk.length>available){finish(undefined,{status,mediaType,body:Buffer.concat(chunks).toString('utf8'),bytes,truncated:true});response.destroy();}});
        response.on('end',()=>finish(undefined,{status,mediaType,body:Buffer.concat(chunks).toString('utf8'),bytes,truncated:false}));
        response.on('error',error=>finish(error));
        response.on('aborted',()=>finish(new Error('网页传输中断，请重试')));
      });
      req.on('error',error=>finish(error));req.end();
    });
    if(result.status>=300&&result.status<400){
      if(options.redirects===false)throw new Error('此服务返回重定向，未转发凭证');
      if(!result.location)throw new Error('网页重定向缺少目标');
      const next=publicWebUrl(new URL(result.location,url).href);
      if(url.protocol==='https:'&&next.protocol!=='https:')throw new Error('拒绝从 HTTPS 降级到 HTTP');
      url=next;continue;
    }
    return {...result,url:url.href};
  }
  throw new Error('网页重定向次数过多');
}

function entities(value:string){return value.replace(/&(?:amp|lt|gt|quot|apos|nbsp|#\d+|#x[0-9a-f]+);/gi,entity=>{const key=entity.slice(1,-1).toLowerCase(),known:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};if(key in known)return known[key];const code=key.startsWith('#x')?parseInt(key.slice(2),16):Number(key.slice(1));return code>0&&code<=0x10ffff?String.fromCodePoint(code):entity;});}
export function webpageText(body:string,mediaType:string){
  if(!/(?:html|xhtml)/.test(mediaType))return {title:undefined,content:body};
  const title=/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1];
  // Text extraction only: never execute page scripts or load linked resources.
  const content=entities(body.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,' ').replace(/<!--[\s\S]*?-->/g,' ').replace(/<\/(?:p|div|h[1-6]|li|article|section|tr|br)\s*>|<br\b[^>]*>/gi,'\n').replace(/<[^>]*>/g,' ')).replace(/[ \t]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  return {title:title?entities(title.replace(/<[^>]*>/g,'')).trim().slice(0,500):undefined,content};
}
