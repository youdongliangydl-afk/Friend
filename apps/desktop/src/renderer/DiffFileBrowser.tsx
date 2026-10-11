import {useState,type ReactNode} from 'react';
import type {ChangedFile} from '../workspace-files.js';
import {diffFileRatio,diffFileStatus} from './diff-model.js';

export type DiffFileMetadata=Pick<ChangedFile,'path'|'oldPath'|'status'|'binary'|'additions'|'deletions'|'error'>;
/** This map consumes metadata only; selecting a file is the caller's sole body-read trigger. */
export function DiffFileBrowser({files,index,onSelect,children}:{files:readonly DiffFileMetadata[];index:number;onSelect(index:number):void;children:ReactNode}){
 const [collapsed,setCollapsed]=useState(false);
 return <div className="friend-diff-browser">
  <label className="friend-diff-mobile-file">文件 · {files.length}<select aria-label="选择差异文件" value={index} onChange={event=>onSelect(Number(event.target.value))}>{files.map((file,i)=><option key={`${i}:${file.path}`} value={i}>{file.path} · {diffFileStatus(file)}{file.binary?' · 二进制 / 大文件':file.error?' · 读取失败':''}</option>)}</select></label>
  <div className={`friend-diff-browser-layout${collapsed?' map-collapsed':''}`}>
   <aside className="friend-diff-map" aria-label="全部差异文件">
    <div className="friend-diff-map-heading">{!collapsed&&<strong>文件 · {files.length}</strong>}<button type="button" aria-label={collapsed?'展开文件地图':'收起文件地图'} aria-expanded={!collapsed} onClick={()=>setCollapsed(value=>!value)}>{collapsed?'›':'‹'}</button></div>
    {!collapsed&&<div className="friend-diff-map-list">{files.map((file,i)=>{const ratio=diffFileRatio(file);return <button type="button" key={`${i}:${file.path}`} className="friend-diff-map-file" aria-current={index===i?'true':undefined} onClick={()=>onSelect(i)}>
     <span className="friend-diff-map-path">{file.path}</span>{file.oldPath&&<small>原路径：{file.oldPath}</small>}
     <span className="friend-diff-map-facts"><span>{diffFileStatus(file)}</span>{ratio?<span><span className="added">+{ratio.additions}</span> <span className="removed">−{ratio.deletions}</span></span>:<span>行数未记录</span>}</span>
     {ratio&&<span className="friend-diff-map-ratio" role="img" aria-label={`增加 ${ratio.additions} 行，删除 ${ratio.deletions} 行`}><i className="added" style={{width:ratio.addedPercent+'%'}}/><i className="removed" style={{width:ratio.removedPercent+'%'}}/></span>}
     {(file.binary||file.error)&&<small>{file.error?'读取失败': '二进制或大文件 · 仅元信息'}</small>}
    </button>;})}</div>}
   </aside>
   <div className="friend-diff-selected-file">{children}</div>
  </div>
 </div>;
}
