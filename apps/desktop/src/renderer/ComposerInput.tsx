import {useEffect,useRef,useState,type RefObject,type TextareaHTMLAttributes} from 'react';
import {asList,asObject,errorText,type JsonObject} from './types.js';
import {Icon} from './Icons.js';
type Candidate={id:string;label:string;insert:string;kind:string;path?:string};
export interface MaterialAttachment {path:string;name?:string;hash?:string}
function bridge(){return window.friendPi||window.friendComposer;}
export function ComposerInput({inputRef,sessionId,epoch,attachments,onFiles,onReference,materialsEnabled=true,...props}:TextareaHTMLAttributes<HTMLTextAreaElement>&{inputRef:RefObject<HTMLTextAreaElement|null>;sessionId:string;epoch:number;attachments:MaterialAttachment[];materialsEnabled?:boolean;onFiles(files:{name:string;data:string}[]):Promise<unknown>;onReference(candidate:Candidate):Promise<unknown>}){
 const [query,setQuery]=useState<{start:number;end:number;type:string;query:string}|null>(null),[candidates,setCandidates]=useState<Candidate[]>([]),[active,setActive]=useState(0),[truncated,setTruncated]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');const sequence=useRef(0),ime=useRef(false);
 useEffect(()=>{const ticket=++sequence.current;setActive(0);if(!query){setCandidates([]);return;}const timer=setTimeout(()=>{void bridge().request('reference.list',{sessionId,type:query.type,query:query.query}).then(raw=>{if(sequence.current===ticket){setCandidates(asList<Candidate>(asObject(raw).items));setTruncated(asObject(raw).truncated===true);}}).catch(()=>{if(sequence.current===ticket)setCandidates([]);});},100);return()=>{clearTimeout(timer);};},[query?.query,query?.type,sessionId,epoch]);
 const detect=(value:string,caret:number)=>{if(!materialsEnabled)return;const match=/(?:^|\s)([@/])([^\n@]*?)$/.exec(value.slice(0,caret));setQuery(match?{start:caret-match[2].length-1,end:caret,type:match[1],query:match[2]}:null);};
 const choose=async(candidate:Candidate)=>{if(!query)return;const node=inputRef.current;if(!node)return;const value=String(props.value||''),next=value.slice(0,query.start)+candidate.insert+' '+value.slice(query.end);const start=query.start+candidate.insert.length+1;setQuery(null);setCandidates([]);try{await onReference(candidate);props.onChange?.({target:{value:next},currentTarget:{value:next}} as React.ChangeEvent<HTMLTextAreaElement>);requestAnimationFrame(()=>{node.focus();node.setSelectionRange(start,start);});}catch(e){setError(errorText(e));}};
 const receive=async(files:File[])=>{if(!materialsEnabled){setError('请返回主会话添加附件或引用材料');return;}if(props.disabled||busy||!files.length)return;setError('');setBusy(true);try{if(files.length+attachments.length>20||files.some(file=>file.size>10*1024*1024)||files.reduce((n,f)=>n+f.size,0)>20*1024*1024)throw new Error('附件单个最多10 MiB，一次合计20 MiB，最多20份');const converted=[];for(const file of files){const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));converted.push({name:file.name||'粘贴图片.png',data:btoa(binary)});}await onFiles(converted);}catch(e){setError(errorText(e));}finally{setBusy(false);}};
 return <div className="composer-input" onDragOver={event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();event.dataTransfer.dropEffect=props.disabled?'none':'copy';}}} onDrop={event=>{if(event.dataTransfer.files.length){event.preventDefault();void receive([...event.dataTransfer.files]);}}}>
  <textarea {...props} ref={inputRef} onBlur={event=>{setQuery(null);props.onBlur?.(event);}} onCompositionStart={event=>{ime.current=true;props.onCompositionStart?.(event);}} onCompositionEnd={event=>{ime.current=false;props.onCompositionEnd?.(event);}} onPaste={event=>{const files=[...event.clipboardData.files];if(files.length){event.preventDefault();void receive(files);}}} onChange={event=>{props.onChange?.(event);detect(event.target.value,event.target.selectionStart);}} onClick={event=>detect(event.currentTarget.value,event.currentTarget.selectionStart)} onKeyDown={event=>{if(query&&candidates.length&&!ime.current&&!event.nativeEvent.isComposing&&event.nativeEvent.keyCode!==229){if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setActive(old=>(old+(event.key==='ArrowDown'?1:-1)+candidates.length)%candidates.length);return;}if(event.key==='Enter'||event.key==='Tab'){event.preventDefault();void choose(candidates[active]);return;}if(event.key==='Escape'){event.preventDefault();setQuery(null);return;}}props.onKeyDown?.(event);}} aria-autocomplete="list" aria-expanded={!!candidates.length} aria-controls={candidates.length?'composer-references':undefined}/>
  {query&&truncated&&<small role="status">仅显示前60个匹配，请继续输入文件名。</small>}{query&&candidates.length>0&&<div className="composer-references" id="composer-references" role="listbox" aria-label={query.type==='@'?'引用材料':'命令'}>{candidates.map((item,index)=><button type="button" role="option" aria-selected={index===active} key={item.id} onMouseDown={event=>event.preventDefault()} onClick={()=>void choose(item)}><small>{item.kind}</small><span>{item.label}</span></button>)}</div>}
  {busy&&<p role="status">正在接收附件…</p>}{error&&<p className="material-error" role="alert">{error}</p>}
 </div>;
}
export function AttachmentStatus({attachment,sessionId,onChecked}:{attachment:MaterialAttachment;sessionId:string;onChecked?(hash:string):Promise<unknown>}){
 const [state,setState]=useState<JsonObject>({status:'loading'}),[attempt,setAttempt]=useState(0);
 useEffect(()=>{let active=true;setState({status:'loading'});void bridge().request('attachment.inspect',{path:attachment.path,sessionId}).then(async raw=>{if(!active)return;const result=asObject(raw);if(typeof result.hash==='string')await onChecked?.(result.hash);if(active)setState(result);}).catch(e=>{if(active)setState({status:'error',error:errorText(e)});});return()=>{active=false;};},[attachment.path,sessionId,attempt]);
 const name=attachment.name||attachment.path.split('/').at(-1)||'附件',extension=name.includes('.')?name.split('.').at(-1)!.slice(0,4).toUpperCase():'FILE';
 const loading=state.status==='loading',failed=state.status==='error',warnings=asList<string>(state.warnings);
 const summary=loading?'正在解析…':failed?'解析失败 · 查看原因':String(state.summary||'已添加');
 return <details className="attachment-status" data-state={loading?'loading':failed?'error':warnings.length?'warning':'ready'}>
  <summary aria-label={'查看附件详情 '+name}>
   <span className="attachment-file-icon" aria-hidden="true"><Icon name="file" size={20}/><span>{extension}</span></span>
   <span className="attachment-file-meta"><span className="attachment-file-title"><strong title={name}>{name}</strong>{warnings.length>0&&!loading&&!failed&&<span className="attachment-warning-count">{warnings.length} 项提示</span>}</span><span className="attachment-file-state" role="status">{loading&&<span className="attachment-spinner" aria-hidden="true"/>}<span>{summary}</span></span></span>
   <svg className="attachment-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="m5 6 3 3 3-3"/></svg>
  </summary>
  <div className="attachment-details">
   {!loading&&!failed&&state.summary!==undefined&&<p>{String(state.summary)}</p>}
   {failed&&<p className="attachment-error">{String(state.error)}</p>}
   {state.delivery!==undefined&&<p>{String(state.delivery)}</p>}
   {warnings.length>0&&<ul>{warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul>}
   <button type="button" className="attachment-recheck" disabled={loading} onClick={()=>setAttempt(old=>old+1)}>{failed?'重试解析':loading?'正在解析…':'重新检查'}</button>
  </div>
 </details>;
}
