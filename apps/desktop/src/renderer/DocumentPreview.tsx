import {useEffect,useRef,useState} from 'react';
import type {WorkspaceRef} from './types.js';
import type {DocumentManifest,DocumentPage} from '../document-reader.js';
interface Props {workspace:WorkspaceRef;path:string;report?(message:string,error?:boolean):void}
export function DocumentPreview({workspace,path,report}:Props){
  const [document,setDocument]=useState<DocumentManifest>(),[page,setPage]=useState<DocumentPage>(),[sectionId,setSectionId]=useState(''),[error,setError]=useState(''),[loading,setLoading]=useState(true),[picture,setPicture]=useState(''),[view,setView]=useState<'content'|'page'>('content');
  const epoch=useRef(0),requestEpoch=useRef(0),identity=JSON.stringify(workspace);
  useEffect(()=>{const ticket=++epoch.current;requestEpoch.current++;setDocument(undefined);setPage(undefined);setSectionId('');setError('');setPicture('');setView('content');setLoading(true);
    void window.friendPi.request<DocumentManifest>('document.read',{workspace,path}).then(result=>{if(epoch.current!==ticket)return;setDocument(result);setSectionId(result.sections[0]?.id||'');setLoading(false);}).catch(reason=>{if(epoch.current===ticket){setError(String(reason));setLoading(false);}});
    return()=>{epoch.current++;requestEpoch.current++;};
  },[path,identity]);
  const load=async(id:string,offset=0,rowOffset=0)=>{
    const ticket=++requestEpoch.current;setLoading(true);setError('');
    try{const result=await window.friendPi.request<DocumentPage>('document.section',{workspace,path,sectionId:id,offset,rowOffset,limit:12000,maxRows:40,expectedHash:document?.hash});if(requestEpoch.current!==ticket)return;if(document?.hash&&result.hash!==document.hash)throw new Error('文件已变更，请重新打开预览');setPage(result);}
    catch(reason){if(requestEpoch.current===ticket){setError(String(reason));report?.(String(reason),true);}}finally{if(requestEpoch.current===ticket)setLoading(false);}
  };
  useEffect(()=>{if(document&&sectionId&&view==='content'){setPage(undefined);setPicture('');void load(sectionId);}},[document?.hash,sectionId,view]);
  useEffect(()=>{
    if(view!=='page'||document?.kind!=='pdf'||!sectionId)return;const ticket=++requestEpoch.current;setLoading(true);setError('');setPicture('');
    const pageIndex=document.sections.findIndex(section=>section.id===sectionId);
    void window.friendPi.request<{dataUrl:string;hash:string}>('document.pdf.page',{workspace,path,pageIndex,expectedHash:document.hash}).then(result=>{if(requestEpoch.current!==ticket)return;if(result.hash!==document.hash)throw new Error('文件已变更，请重新打开预览');setPicture(result.dataUrl);}).catch(reason=>{if(requestEpoch.current===ticket)setError(String(reason));}).finally(()=>{if(requestEpoch.current===ticket)setLoading(false);});
    return()=>{requestEpoch.current++;};
  },[view,document?.hash,sectionId]);
  if(!document)return <div className="document-preview" role="status">{error?<p className="document-preview-error">{error}</p>:<p>正在解析文档…</p>}</div>;
  const selected=document.sections.find(section=>section.id===sectionId),columns=page?.columns||[],wide=columns.length>80;
  return <section className="document-preview" aria-label={'文档预览 '+document.title}>
    <div className="document-preview-status"><strong>{document.title}</strong><span>解析覆盖 {document.coverage.readUnits}/{document.coverage.totalUnits} {document.coverage.unit}{document.coverage.cells!==undefined?' · '+document.coverage.cells+' 个单元格':''}{document.coverage.hiddenSheets?' · 含 '+document.coverage.hiddenSheets+' 个隐藏表':''}</span><small>{document.coverage.scope}。当前展示为分页预览，不表示模型已收到或读完。</small></div>
    {document.warnings.length>0&&<details className="document-preview-warnings"><summary>解析说明 · {document.warnings.length} 项{document.coverage.status==='partial'?' · 含未识别内容':''}</summary><ul>{document.warnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul></details>}
    <div className="document-preview-controls"><label>查看<select aria-label="选择文档章节" value={sectionId} onChange={event=>setSectionId(event.target.value)}>{document.sections.map(section=><option key={section.id} value={section.id}>{section.title}{section.hidden?'（隐藏）':''}</option>)}</select></label>{selected?.hidden&&<span className="document-hidden-badge">{selected.hidden==='veryHidden'?'深度隐藏表':'隐藏表'} · 已纳入解析</span>}{document.kind==='pdf'&&<div role="group" aria-label="PDF 预览方式"><button aria-pressed={view==='content'} onClick={()=>setView('content')}>文字内容</button><button aria-pressed={view==='page'} onClick={()=>setView('page')}>原始页面</button></div>}</div>
    {error&&<p className="document-preview-error" role="alert">{error}</p>}
    {loading&&<p className="document-preview-loading" role="status">正在读取…</p>}
    {view==='page'&&document.kind==='pdf'?picture&&<img className="document-pdf-page" src={picture} alt={selected?.title+' 的原始 PDF 页面'}/>:page&&<>
      {page.rows&&!wide?<div className="document-table-scroll"><table><thead><tr><th scope="col">行</th>{columns.map(column=><th scope="col" key={column}>{column}</th>)}</tr></thead><tbody>{page.rows.map(row=><tr key={row.row}><th scope="row">{row.row}</th>{columns.map(column=>{const cell=row.cells.find(cell=>cell.ref.replace(/\d+$/,'')===column);return <td key={column} title={cell?.formula!==undefined?'公式：'+cell.formula+'；缓存：'+(cell.cachedValue??'缺失，未计算'):undefined}>{cell?.value}{cell?.formula!==undefined&&<small className="document-cell-formula">={cell.formula}</small>}</td>;})}</tr>)}</tbody></table>{page.rows.length===0&&<p>此工作表没有有效单元格。</p>}</div>:<pre className="document-extracted-text">{page.text||'此节没有可提取的文字；请查看解析说明。'}</pre>}
      {wide&&<p className="document-preview-note">工作表超过 80 列，当前使用保留单元格地址的文字预览。</p>}
      {page.rowsOmitted&&<p className="document-preview-note">{page.rowsOmitted}</p>}
      <div className="document-preview-pagination"><span>{page.rows&&!wide?'预览行 '+(page.totalRows?page.rowOffset+1:0)+'–'+(page.rowOffset+(page.rows?.length||0))+' / '+page.totalRows:'预览字符 '+(page.totalCharacters?page.offset+1:0)+'–'+(page.offset+page.text.length)+' / '+page.totalCharacters}</span>{(page.rows&&!wide?page.rowOffset>0:page.offset>0)&&<button disabled={loading} onClick={()=>void load(sectionId,0,0)}>回到开头</button>}{(page.rows&&!wide?page.nextRowOffset!==undefined:page.nextOffset!==undefined)&&<button disabled={loading} onClick={()=>void load(sectionId,page.rows&&!wide?0:page.nextOffset,page.rows&&!wide?page.nextRowOffset:0)}>下一段</button>}</div>
    </>}
  </section>;
}
