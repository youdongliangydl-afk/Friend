import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {atomicWrite,ConflictError,digest,object,parseModelJson,text,type JsonObject,type PluginContext,type RecordStore} from '@friend-pi/core';
import {checkCancelled} from './managed.js';
import type {SharedConflict,SharedDocument} from './types.js';

interface Edit {start:number;end:number;lines:string[]}
const lines=(value:string)=>value.match(/[^\n]*\n|[^\n]+$/g)||[];
/** Bounded LCS derives edits against the common version; no model call or lock is involved. */
function edits(base:string[],next:string[]):Edit[]|undefined {
  let prefix=0;while(prefix<base.length&&prefix<next.length&&base[prefix]===next[prefix])prefix++;
  let suffix=0;while(suffix<base.length-prefix&&suffix<next.length-prefix&&base[base.length-1-suffix]===next[next.length-1-suffix])suffix++;
  const a=base.slice(prefix,base.length-suffix),b=next.slice(prefix,next.length-suffix);
  if(!a.length&&!b.length)return [];
  if((a.length+1)*(b.length+1)>1000000)return;
  const width=b.length+1,table=new Uint32Array((a.length+1)*width);
  for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)table[i*width+j]=a[i]===b[j]?table[(i+1)*width+j+1]+1:Math.max(table[(i+1)*width+j],table[i*width+j+1]);
  const result:Edit[]=[];let i=0,j=0,current:Edit|undefined;
  const finish=()=>{if(current){result.push(current);current=undefined;}};
  while(i<a.length||j<b.length){
    if(i<a.length&&j<b.length&&a[i]===b[j]){finish();i++;j++;continue;}
    current??={start:prefix+i,end:prefix+i,lines:[]};
    if(j<b.length&&(i===a.length||table[i*width+j+1]>=table[(i+1)*width+j]))current.lines.push(b[j++]);
    else {i++;current.end=prefix+i;}
  }finish();return result;
}
function overlap(a:Edit,b:Edit):boolean {
  if(a.start===a.end&&b.start===b.end)return a.start===b.start;
  if(a.start===a.end)return a.start>b.start&&a.start<b.end;
  if(b.start===b.end)return b.start>a.start&&b.start<a.end;
  return a.start<b.end&&b.start<a.end;
}
export function threeWayLineMerge(baseText:string,latestText:string,proposedText:string):{content?:string;overlap:boolean;unchanged:string[];independent:string[];conflicting:string[]} {
  if(latestText===proposedText)return {content:latestText,overlap:false,unchanged:[],independent:[],conflicting:[]};
  const base=lines(baseText),a=edits(base,lines(latestText)),b=edits(base,lines(proposedText));
  if(!a||!b)return {overlap:true,unchanged:[],independent:[],conflicting:base};
  const identical=(x:Edit,y:Edit)=>x.start===y.start&&x.end===y.end&&x.lines.join('')===y.lines.join('');
  const all=[...a,...b.filter(y=>!a.some(x=>identical(x,y)))];
  const conflicting=all.filter(x=>all.some(y=>y!==x&&overlap(x,y)&&!identical(x,y)));
  const unchanged=base.filter((_line,index)=>!all.some(edit=>index>=edit.start&&index<edit.end));
  const independent=all.filter(edit=>!conflicting.includes(edit)).flatMap(edit=>edit.lines);
  if(conflicting.length)return {overlap:true,unchanged,independent,conflicting:conflicting.flatMap(edit=>[...base.slice(edit.start,edit.end),...edit.lines])};
  let cursor=0;const merged:string[]=[];for(const edit of all.sort((x,y)=>x.start-y.start||x.end-y.end)){merged.push(...base.slice(cursor,edit.start),...edit.lines);cursor=edit.end;}merged.push(...base.slice(cursor));
  return {content:merged.join(''),overlap:false,unchanged,independent,conflicting:[]};
}

export class SharedMaterials {
  constructor(private readonly store:RecordStore,private readonly changed:()=>void){}
  private key(graphId:string,name:string):string{return `shared:${graphId}:${name}`;}
  version(graphId:string,name:string,revision:number):SharedDocument|undefined {
    if(revision===0)return {graphId,name,content:'',file:'',version:0,digest:digest(''),updatedAt:''};
    const current=this.store.get<SharedDocument>(this.key(graphId,name));if(current?.revision===revision)return current.value;
    return this.store.get<SharedDocument>(`shared-version:${graphId}:${digest(name)}:${revision}`)?.value;
  }
  private retain(conflict:SharedConflict):void {this.store.put(`shared-conflict:${conflict.graphId}:${conflict.id}`,conflict);this.store.afterCommit(this.changed);}
  private save(graphId:string,name:string,content:string,expected:number,ctx:PluginContext,origin:SharedDocument['origin'],mergeSources?:SharedDocument['mergeSources']):SharedDocument {
    return this.store.transaction(()=>{
      checkCancelled(ctx.signal);const key=this.key(graphId,name),previous=this.store.get<SharedDocument>(key);
      if((previous?.revision||0)!==expected)throw new ConflictError();
      if(previous)this.store.put(`shared-version:${graphId}:${digest(name)}:${previous.revision}`,previous.value);
      const version=expected+1,file=join(ctx.dataDir,'swarm-shared',graphId,`${digest(name).slice(0,24)}.v${version}.md`);
      const document:SharedDocument={graphId,name,content,file,version,digest:digest(content),updatedAt:new Date().toISOString(),origin,...(mergeSources?{merged:true,mergeSources}: {})};
      atomicWrite(file,content);this.store.put(key,document,previous?.revision??null);this.store.put(`shared-version:${graphId}:${digest(name)}:${version}`,document,null);
      this.store.afterCommit(()=>ctx.emit('swarm.shared.changed',{v:1,graphId,name,revision:version,digest:document.digest}));this.store.afterCommit(this.changed);return document;
    });
  }
  async write(graphId:string,input:JsonObject,ctx:PluginContext):Promise<SharedDocument> {
    const name=text(input.name,'资料名称',180);if(!/^[\p{L}\p{N}_ .-]+$/u.test(name)||name==='.'||name==='..')throw new Error('共享资料名称无效');
    if(typeof input.content!=='string'||input.content.length>200000)throw new Error('共享资料内容无效或超过上限');
    const proposed=input.content,expected=input.expectedRevision===null?0:Number(input.expectedRevision??0);
    if(!Number.isInteger(expected)||expected<0)throw new Error('共享资料版本无效');
    const operationId=typeof input.operationId==='string'?text(input.operationId,'操作身份',180):randomUUID();
    const fingerprint=digest({name,expected,proposed,baseDigest:input.baseDigest});const operationKey=`shared-operation:${graphId}:${operationId}`;
    const existing=this.store.get<{fingerprint:string;document:SharedDocument}>(operationKey);if(existing){if(existing.value.fingerprint!==fingerprint)throw new Error('同一共享操作身份不能对应不同修改');return existing.value.document;}
    const origin={operationId,...(typeof input.taskId==='string'?{taskId:input.taskId}:{}),...(typeof input.attemptId==='string'?{attemptId:input.attemptId}:{})};
    const remember=(document:SharedDocument)=>{this.store.put(operationKey,{fingerprint,document},null);return document;};
    checkCancelled(ctx.signal);
    try{return this.store.transaction(()=>{const duplicate=this.store.get<{fingerprint:string;document:SharedDocument}>(operationKey);if(duplicate){if(duplicate.value.fingerprint!==fingerprint)throw new Error('同一共享操作身份不能对应不同修改');return duplicate.value.document;}return remember(this.save(graphId,name,proposed,expected,ctx,origin));});}catch(error){if(!(error instanceof ConflictError))throw error;}
    const baseRevision=Number(input.baseRevision??expected),base=Number.isInteger(baseRevision)&&baseRevision===expected?this.version(graphId,name,baseRevision):undefined;
    let latest=this.store.get<SharedDocument>(this.key(graphId,name))?.value;
    const conflict:SharedConflict={id:randomUUID(),graphId,name,status:'pending',base,latest,proposed,proposedDigest:digest(proposed),origin,ownerPid:process.pid,createdAt:new Date().toISOString()};this.retain(conflict);
    const pause=(reason:string):never=>{conflict.status=ctx.signal?.aborted?'cancelled':'paused';conflict.reason=reason;conflict.latest=this.store.get<SharedDocument>(this.key(graphId,name))?.value||conflict.latest;this.retain(conflict);throw new ConflictError(`共享资料版本冲突 ${conflict.id}：${reason}；三方材料已保留`);};
    const baseDigest=input.baseDigest??(expected===0?digest(''):undefined);
    if(!base||!latest||typeof baseDigest!=='string'||baseDigest!==base.digest)pause('缺少可验证的共同版本或摘要，需要检查后继续');
    try {
      for(let attempt=0;attempt<2;attempt++){
        checkCancelled(ctx.signal);latest=this.store.get<SharedDocument>(this.key(graphId,name))?.value;conflict.latest=latest;
        if(!latest)pause('最新资料不存在');
        const merge=threeWayLineMerge(base!.content,latest!.content,proposed);let content=merge.content;
        if(content===undefined){
          if(/必须|不得|禁止|不能|只允许|must\b|shall\b|never\b|API\b|schema\b|deadline\b|权限|接口|金额/iu.test(merge.conflicting.join('')))pause('同一约束或接口出现互相冲突的修改，不能自动选择');
          const sources=[{revision:base!.version,digest:base!.digest},{revision:latest!.version,digest:latest!.digest},{revision:-1,digest:conflict.proposedDigest}];
          const result=parseModelJson(await ctx.complete(`你是共享资料合并器，只生成文本，不调用工具或执行修改。根据共同旧版本、最新版本和修改稿做三方合并。保留有效约束、事实及各方独立修改；若事实矛盾、缺乏来源或无法判断，必须 pause，不得任选。只输出 JSON {"decision":"merge|pause","content":"合并全文","reason":"依据","sources":[{"revision":数字,"digest":"原摘要"}]}；sources必须逐项原样返回。\n${JSON.stringify({sources,base:base!.content,latest:latest!.content,proposed,origin,goal:'合并共享资料，不改变任务要求'})}`,{signal:ctx.signal,maxTokens:8192}));
          checkCancelled(ctx.signal);
          const cited=Array.isArray(result.sources)?result.sources.map(raw=>{try{const source=object(raw);return [source.revision,source.digest];}catch{return null;}}):[];
          if(result.decision!=='merge'||typeof result.content!=='string'||result.content.length>200000||!result.content.trim()||digest(cited)!==digest(sources.map(source=>[source.revision,source.digest])))pause(typeof result.reason==='string'?result.reason:'模型没有给出来源完整的可采用合并稿');
          content=result.content as string;
          const required=new Map<string,number>();for(const line of [...merge.unchanged,...merge.independent])if(line.trim())required.set(line,(required.get(line)||0)+1);
          for(const [line,count] of required){let found=0,offset=0;while((offset=content.indexOf(line,offset))>=0){found++;offset+=line.length;}if(found<count)pause('合并稿丢失原有共同内容或独立修改');}
        }
        try {
          const document=this.store.transaction(()=>{const saved=remember(this.save(graphId,name,content!,latest!.version,ctx,origin,[{revision:base!.version,digest:base!.digest},{revision:latest!.version,digest:latest!.digest},{revision:-1,digest:conflict.proposedDigest}]));conflict.status='resolved';conflict.resolvedRevision=saved.version;this.retain(conflict);return saved;});return document;
        }catch(error){if(!(error instanceof ConflictError))throw error;}
      }return pause('最新版本连续变化，已达自动合并重试上限');
    }catch(error){if(ctx.signal?.aborted)pause('合并已取消，未保存合并稿');if(conflict.status==='pending')pause(`自动合并失败：${error instanceof Error?error.message:'未知错误'}`);throw error;}
  }
}
