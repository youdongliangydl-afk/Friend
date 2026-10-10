import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {open,realpath,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {basename,extname,join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {withDocumentArchive,relationshipTarget,DOCUMENT_LIMITS,type DocumentArchive} from './document-archive.js';
import {parseXml,children,descendants,nameIs,attribute,xmlText,officeText,type XmlNode} from './document-xml.js';
const execute=promisify(execFile);
export {DOCUMENT_LIMITS};
export type DocumentKind='pdf'|'docx'|'pptx'|'xlsx'|'csv'|'text';
export interface DocumentCell {ref:string;column:number;value:string;formula?:string;cachedValue?:string}
export interface DocumentRow {row:number;cells:DocumentCell[]}
export interface DocumentSection {id:string;title:string;text:string;hidden?:'hidden'|'veryHidden';rows?:DocumentRow[];columns?:string[]}
export interface DocumentCoverage {status:'complete'|'partial';scope:string;readUnits:number;totalUnits:number;unit:string;emptyUnits?:string[];nonTextUnits?:number;cells?:number;formulaCells?:number;uncachedFormulaCells?:number;hiddenSheets?:number}
export interface ReadDocument {kind:DocumentKind;hash:string;legacyHash:string;sourceBytes:number;title:string;text:string;sections:DocumentSection[];coverage:DocumentCoverage;warnings:string[]}
export interface DocumentManifest extends Omit<ReadDocument,'text'|'sections'|'legacyHash'> {textLength:number;sections:(Omit<DocumentSection,'text'|'rows'>&{textLength:number;rowCount:number})[]}
export interface DocumentPage {hash:string;kind:DocumentKind;sectionId:string;title:string;text:string;offset:number;nextOffset?:number;totalCharacters:number;rows?:DocumentRow[];columns?:string[];rowOffset:number;nextRowOffset?:number;totalRows:number;hidden?:'hidden'|'veryHidden';rowsOmitted?:string}
const wordKinds=new Set(['docx','pptx','xlsx']);
export function isDocumentPath(path:string){return /\.(pdf|docx|pptx|xlsx|csv)$/i.test(path);}
function requireUnits(count:number){if(count>DOCUMENT_LIMITS.units)throw new Error('文档超过 2000 页、幻灯片或工作表上限');}
function requireTextBytes(count:number){if(count>DOCUMENT_LIMITS.textBytes)throw new Error('解析后的文档文字超过 64 MiB 上限；未按预览截断冒充完整读取');}
function columnLabel(column:number){let value='';for(let n=column;n>0;n=Math.floor((n-1)/26))value=String.fromCharCode(65+(n-1)%26)+value;return value;}
function cellPosition(ref:string){const match=/^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(ref);if(!match)throw new Error('工作表包含无效单元格地址 '+ref);const column=[...match[1]].reduce((n,ch)=>n*26+ch.charCodeAt(0)-64,0),row=Number(match[2]);if(column>16384||row>1048576)throw new Error('单元格地址超出 Excel 范围');return {column,row};}
function renderRows(rows:DocumentRow[]){return rows.map(row=>row.cells.map(cell=>`${cell.ref}: ${cell.value}${cell.formula!==undefined?` [公式: ${cell.formula}; 缓存: ${cell.cachedValue??'缺失，未计算'}]`:''}`).join('\t')).join('\n');}
async function xml(archive:DocumentArchive,path:string){return parseXml(await archive.read(path));}
async function relationships(archive:DocumentArchive,from:string){
  const path=from.replace(/([^/]+)$/,'_rels/$1.rels'),result=new Map<string,string>();if(!archive.has(path))return result;
  for(const node of descendants(await xml(archive,path),'Relationship')){const id=attribute(node,'Id'),target=attribute(node,'Target');if(id&&target&&attribute(node,'TargetMode')!=='External'){if(result.has(id))throw new Error('Office 文档关系 ID 重复');result.set(id,relationshipTarget(from,target));}}
  return result;
}
function prose(node:XmlNode):string {
  if(nameIs(node,'tbl'))return descendants(node,'tr').map(row=>children(row,'tc').map(cell=>prose(cell)).join('\t')).join('\n');
  if(nameIs(node,'p'))return officeText(node);return children(node).map(prose).filter(text=>text!=='').join('\n');
}
async function readDocx(archive:DocumentArchive){
  const main='word/document.xml';if(!archive.has(main))throw new Error('DOCX 缺少正文');
  const paths=[main,...archive.names.filter(path=>/^word\/(?:header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/.test(path)).sort()];requireUnits(paths.length);
  const sections:DocumentSection[]=[];let textBytes=0;for(const [index,path] of paths.entries()){
    const root=await xml(archive,path);if(descendants(root,'altChunk').length)throw new Error('DOCX 含尚未转换的导入正文（altChunk），无法完整读取；请用 Word 打开并另存后重试');let text:string;
    if(/\/(?:footnotes|endnotes)\.xml$/.test(path))text=children(root).filter(node=>Number(attribute(node,'id'))>=0).map(prose).join('\n');else text=prose(root);
    textBytes+=Buffer.byteLength(text);requireTextBytes(textBytes);sections.push({id:'part-'+index,title:index===0?'正文':basename(path),text});
  }
  return sections;
}
async function readPptx(archive:DocumentArchive){
  const main='ppt/presentation.xml';if(!archive.has(main))throw new Error('PPTX 缺少幻灯片目录');const root=await xml(archive,main),rels=await relationships(archive,main),slides=descendants(root,'sldId');requireUnits(slides.length);
  const sections:DocumentSection[]=[];let textBytes=0;for(const [index,slide] of slides.entries()){
    const relation=Object.entries(slide.attributes).find(([key])=>key.includes(':')&&key.endsWith(':id'))?.[1]??attribute(slide,'id'),path=relation?rels.get(relation):undefined;if(!path)throw new Error('PPTX 幻灯片关系缺失');
    let text=prose(await xml(archive,path));const slideRels=await relationships(archive,path),notes=[...slideRels.values()].filter(target=>/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(target));
    for(const note of notes){const noteText=prose(await xml(archive,note));if(noteText)text+='\n\n[演讲备注]\n'+noteText;}
    textBytes+=Buffer.byteLength(text);requireTextBytes(textBytes);sections.push({id:'slide-'+(index+1),title:'幻灯片 '+(index+1),text});
  }
  return sections;
}
async function readXlsx(archive:DocumentArchive){
  const main='xl/workbook.xml';if(!archive.has(main))throw new Error('XLSX 缺少工作簿目录');const workbook=await xml(archive,main),rels=await relationships(archive,main),sheets=descendants(workbook,'sheet');requireUnits(sheets.length);
  const unescape=(value:string)=>value.replace(/_x([0-9a-fA-F]{4})_/g,(_match,hex:string)=>String.fromCharCode(parseInt(hex,16)));
  const shared=archive.has('xl/sharedStrings.xml')?children(await xml(archive,'xl/sharedStrings.xml'),'si').map(node=>unescape(officeText(node))):[];
  const sections:DocumentSection[]=[],warnings:string[]=[];let cells=0,formulaCells=0,uncachedFormulaCells=0,hiddenSheets=0,textBytes=0;
  for(const [index,sheet] of sheets.entries()){
    const relation=Object.entries(sheet.attributes).find(([key])=>key.includes(':')&&key.endsWith(':id'))?.[1]??attribute(sheet,'id'),path=relation?rels.get(relation):undefined;if(!path)throw new Error('XLSX 工作表关系缺失');
    if(!/^xl\/worksheets\//.test(path))throw new Error('工作簿包含当前不能完整读取的图表页或特殊工作表');
    const title=attribute(sheet,'name')||'工作表 '+(index+1),sheetXml=await xml(archive,path),hidden=attribute(sheet,'state'),rows=new Map<number,DocumentRow>(),columns=new Set<number>(),refs=new Set<string>(),sharedFormulas=new Map<string,string>();
    const data=descendants(sheetXml,'sheetData')[0];if(!data)throw new Error('工作表缺少单元格数据区域');
    for(const cell of descendants(data,'c')){
      const ref=attribute(cell,'r');if(!ref)throw new Error('工作表单元格缺少地址，不能证明读取完整');if(refs.has(ref))throw new Error('工作表包含重复单元格 '+ref);refs.add(ref);
      const f=children(cell,'f')[0],v=children(cell,'v')[0],inline=children(cell,'is')[0];if(!f&&!v&&!inline)continue;
      if(++cells>DOCUMENT_LIMITS.cells)throw new Error('工作簿有效单元格超过 100 万上限');const position=cellPosition(ref),type=attribute(cell,'t'),saved=v?xmlText(v):undefined,raw=f&&saved===''&&type!=='str'?undefined:saved;let value=raw??'';
      if(type==='s'){if(raw===undefined||!/^\d+$/.test(raw)||Number(raw)>=shared.length)throw new Error('工作表共享字符串索引无效');value=shared[Number(raw)];}
      else if(type==='inlineStr')value=inline?unescape(officeText(inline)):'';else if(type==='str')value=unescape(value);else if(type==='b')value=raw==='1'?'TRUE':raw==='0'?'FALSE':raw??'';
      let formula:string|undefined;if(f){formulaCells++;formula=xmlText(f);const sharedId=attribute(f,'si');if(attribute(f,'t')==='shared'&&sharedId){if(formula)sharedFormulas.set(sharedId,formula);else formula=`共享公式 #${sharedId}（主公式：${sharedFormulas.get(sharedId)??'见本工作表主单元格'}；此地址未重算）`;}
        if(raw===undefined){uncachedFormulaCells++;value='（公式无缓存，未计算）';}}
      const entry:DocumentCell={ref,column:position.column,value,...(formula!==undefined?{formula,...(raw!==undefined?{cachedValue:value}:{})}:{})};
      textBytes+=Buffer.byteLength(ref)+Buffer.byteLength(value)+2+(formula===undefined?0:Buffer.byteLength(formula)+Buffer.byteLength(entry.cachedValue??'缺失，未计算')+40);requireTextBytes(textBytes);
      if(!rows.has(position.row))rows.set(position.row,{row:position.row,cells:[]});rows.get(position.row)!.cells.push(entry);columns.add(position.column);
    }
    const ordered=[...rows.values()].sort((a,b)=>a.row-b.row);for(const row of ordered)row.cells.sort((a,b)=>a.column-b.column);
    const state=hidden==='hidden'||hidden==='veryHidden'?hidden:undefined;if(state)hiddenSheets++;
    sections.push({id:'sheet-'+(index+1),title,text:renderRows(ordered),...(state?{hidden:state}:{}),rows:ordered,columns:[...columns].sort((a,b)=>a-b).map(columnLabel)});
  }
  if(uncachedFormulaCells)warnings.push(`${uncachedFormulaCells} 个公式没有保存的结果；保留公式，未执行计算。`);
  warnings.push('保留单元格原始值、公式与已保存缓存；未计算公式，也未还原数字格式、图表或图片。');
  return {sections,warnings,cells,formulaCells,uncachedFormulaCells,hiddenSheets};
}
export function parseCsv(source:string):string[][]{
  if(source.startsWith('\ufeff'))source=source.slice(1);const rows:string[][]=[];let row:string[]=[],field='',quoted=false,closed=false,cells=0;
  const addField=()=>{if(++cells>DOCUMENT_LIMITS.cells)throw new Error('CSV 单元格超过 100 万上限');row.push(field);field='';closed=false;};
  for(let i=0;i<source.length;i++){
    const ch=source[i];if(quoted){if(ch==='"'){if(source[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=ch;continue;}
    if(ch==='"'){if(field||closed)throw new Error('CSV 引号位置无效');quoted=true;continue;}
    if(closed&&ch!==','&&ch!=='\r'&&ch!=='\n')throw new Error('CSV 引号结束后含无效字符');
    if(ch===',')addField();else if(ch==='\r'||ch==='\n'){if(ch==='\r'&&source[i+1]==='\n')i++;addField();rows.push(row);row=[];}else field+=ch;
    if(rows.length>DOCUMENT_LIMITS.cells)throw new Error('CSV 超过 100 万行上限');
  }
  if(quoted)throw new Error('CSV 引号未闭合');if(field||closed||row.length){addField();rows.push(row);}return rows;
}
const PDF_SCRIPT=String.raw`ObjC.import('Foundation');ObjC.import('PDFKit');ObjC.import('AppKit');
function run(args){var document=$.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(args[0]));var count=Number(document.pageCount);if(document.isLocked)throw new Error('PDF 已加密，请先解除密码保护');if(!count||count>2000)throw new Error('PDF 无法打开或超过 2000 页上限');
 if(args[1]==='image'){var number=Number(args[2]);if(number<0||number>=count)throw new Error('PDF 页码超出范围');var page=document.pageAtIndex(number);var image=page.thumbnailOfSizeForBox($.NSMakeSize(1400,1800),$.kPDFDisplayBoxMediaBox);var bitmap=$.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);var png=bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG,$({}));return JSON.stringify({data:ObjC.unwrap(png.base64EncodedStringWithOptions(0)),width:Number(bitmap.pixelsWide),height:Number(bitmap.pixelsHigh)});}
 var pages=[],length=0;for(var index=0;index<count;index++){var value=document.pageAtIndex(index).string;var text=value?ObjC.unwrap(value):'';text=text||'';length+=text.length;if(length>32000000)throw new Error('PDF 文字超过读取资源上限');pages.push(text);}return JSON.stringify({pages:pages});}`;
async function pdfOperation(bytes:Buffer,operation:'text'|'image',page=0){
  if(process.platform!=='darwin')throw new Error('当前系统不提供 PDFKit；此版本的 PDF 解析仅支持 macOS');const directory=await mkdtemp(join(tmpdir(),'friend-pdf-')),path=join(directory,'source.pdf');
  try{await writeFile(path,bytes,{mode:0o600});const {stdout}=await execute('/usr/bin/osascript',['-l','JavaScript','-e',PDF_SCRIPT,path,operation,String(page)],{encoding:'utf8',maxBuffer:DOCUMENT_LIMITS.textBytes,timeout:60_000});return JSON.parse(stdout) as {pages?:string[];data?:string;width?:number;height?:number};}
  catch(error){const message=String((error as {stderr?:string}).stderr|| (error as Error).message);throw new Error('PDF 读取失败：'+message.replace(/\/var\/folders\/[^\s]+/g,'[临时文档]').slice(0,500));}
  finally{await rm(directory,{recursive:true,force:true});}
}
async function sourceBytes(path:string){
  const file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);try{const info=await file.stat();if(!info.isFile())throw new Error('请选择普通文件');if(info.size>DOCUMENT_LIMITS.fileBytes)throw new Error('文档超过 64 MiB 读取上限');const chunks:Buffer[]=[];let total=0;
    while(true){const chunk=Buffer.alloc(Math.min(65536,DOCUMENT_LIMITS.fileBytes-total+1)),{bytesRead}=await file.read(chunk,0,chunk.length,null);if(!bytesRead)break;total+=bytesRead;if(total>DOCUMENT_LIMITS.fileBytes)throw new Error('文档超过 64 MiB 读取上限');chunks.push(chunk.subarray(0,bytesRead));}return Buffer.concat(chunks,total);
  }finally{await file.close();}
}
async function parseDocument(path:string,bytes:Buffer):Promise<ReadDocument>{
  const hash=createHash('sha256').update(bytes).digest('hex'),extension=extname(path).slice(1).toLowerCase();
  if(['doc','ppt','xls'].includes(extension))throw new Error('暂不支持旧版 Office 格式，请另存为 DOCX、PPTX 或 XLSX');
  const kind:DocumentKind=['pdf','docx','pptx','xlsx','csv'].includes(extension)?extension as DocumentKind:'text';
  let sections:DocumentSection[]=[],warnings:string[]=[],coverage:DocumentCoverage={status:'complete',scope:'完整文本',readUnits:1,totalUnits:1,unit:'段'};
  if(kind==='pdf'){
    if(!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))throw new Error('文件内容不是 PDF');const pages=(await pdfOperation(bytes,'text')).pages!;
    sections=pages.map((text,index)=>({id:'page-'+(index+1),title:'第 '+(index+1)+' 页',text}));const empty=sections.filter(section=>!section.text.trim()).map(section=>section.id);
    coverage={status:empty.length?'partial':'complete',scope:'逐页文字层（未 OCR，未识别图像内容）',readUnits:pages.length,totalUnits:pages.length,unit:'页',emptyUnits:empty};
    warnings.push('仅提取 PDF 文字层；图片、图表与扫描文字未识别，预览画面不代表模型已读取。');if(empty.length)warnings.push(`${empty.length} 页未提取到文字，可能是扫描页或空白页；未执行 OCR。`);
  }else if(wordKinds.has(kind)){
    if(bytes.length<4||bytes.readUInt32LE(0)!==0x04034b50)throw new Error('文件内容不是现代 Office ZIP 文档');
    await withDocumentArchive(bytes,async archive=>{
      const media=archive.names.filter(name=>/\/(?:media|embeddings)\//.test(name)&&!name.endsWith('/')).length;
      if(kind==='xlsx'){const result=await readXlsx(archive);sections=result.sections;warnings=result.warnings;coverage={status:'complete',scope:'全部工作表（含隐藏表）的全部有效单元格、公式及已保存缓存',readUnits:sections.length,totalUnits:sections.length,unit:'工作表',cells:result.cells,formulaCells:result.formulaCells,uncachedFormulaCells:result.uncachedFormulaCells,hiddenSheets:result.hiddenSheets,nonTextUnits:media};}
      else{sections=kind==='docx'?await readDocx(archive):await readPptx(archive);coverage={status:media?'partial':'complete',scope:kind==='docx'?'正文、段落、表格及页眉页脚/脚注/批注文字':'全部幻灯片及演讲备注文字与表格',readUnits:sections.length,totalUnits:sections.length,unit:kind==='pptx'?'幻灯片':'文档部分',nonTextUnits:media};warnings.push('此预览按内容组织，不保留 Office 原始版式。');}
      if(media)warnings.push(`${media} 个内嵌图片或对象未做 OCR/语义识别；解析范围仅覆盖文字与单元格数据。`);
    });
  }else{
    let source:string;try{if(bytes.includes(0))throw new Error();source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new Error('不是有效 UTF-8 文本；请转换编码后再试');}
    if(kind==='csv'){const values=parseCsv(source);let cells=0;const rows=values.map((row,index)=>({row:index+1,cells:row.map((value,column)=>{if(++cells>DOCUMENT_LIMITS.cells)throw new Error('CSV 单元格超过 100 万上限');return {ref:columnLabel(column+1)+(index+1),column:column+1,value};})}));const count=values.reduce((max,row)=>Math.max(max,row.length),0);sections=[{id:'csv',title:basename(path),text:renderRows(rows),rows,columns:Array.from({length:count},(_,index)=>columnLabel(index+1))}];coverage={status:'complete',scope:'全部 CSV 行与字段（保留引号内换行）',readUnits:rows.length,totalUnits:rows.length,unit:'行',cells};}
    else sections=[{id:'text',title:basename(path),text:source}];
  }
  requireUnits(kind==='csv'?1:sections.length);const text=sections.map(section=>`## ${section.title}${section.hidden?'（'+section.hidden+'）':''}\n${section.text}`).join('\n\n');
  requireTextBytes(Buffer.byteLength(text));
  // Older frozen queue payloads and started receipts hashed base64, not raw bytes.
  const legacyHash=createHash('sha256').update(bytes.toString('base64')).digest('hex');
  return {kind,hash,legacyHash,sourceBytes:bytes.length,title:basename(path),text,sections,coverage,warnings};
}
export async function readDocument(path:string):Promise<ReadDocument>{return parseDocument(path,await sourceBytes(path));}
function immutable<T>(value:T):T{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))immutable(child);Object.freeze(value);}return value;}
/** Each host owns its cache; every hit is bound to freshly hashed source bytes. */
export function createDocumentReader(){
  const cache=new Map<string,{document:ReadDocument;bytes:number}>();let retained=0;
  return {
    async read(path:string):Promise<ReadDocument>{
      const canonical=await realpath(path),bytes=await sourceBytes(canonical),hash=createHash('sha256').update(bytes).digest('hex'),entry=cache.get(canonical);
      if(entry?.document.hash===hash){cache.delete(canonical);cache.set(canonical,entry);return entry.document;}
      if(entry){cache.delete(canonical);retained-=entry.bytes;}
      const document=immutable(await parseDocument(canonical,bytes)),size=Buffer.byteLength(document.text);
      if(size<=32*1024*1024){while(cache.size>=4||retained+size>32*1024*1024){const oldest=cache.entries().next().value;if(!oldest)break;cache.delete(oldest[0]);retained-=oldest[1].bytes;}cache.set(canonical,{document,bytes:size});retained+=size;}
      return document;
    },
    clear(){cache.clear();retained=0;}
  };
}
export function documentManifest(document:ReadDocument):DocumentManifest{return {kind:document.kind,hash:document.hash,sourceBytes:document.sourceBytes,title:document.title,textLength:document.text.length,coverage:document.coverage,warnings:document.warnings,sections:document.sections.map(({text,rows,...section})=>({...section,textLength:text.length,rowCount:rows?.length||0}))};}
export function paginateDocument(document:ReadDocument,input:{sectionId?:string;offset?:number;limit?:number;rowOffset?:number;maxRows?:number;includeRows?:boolean}={}):DocumentPage{
  const section=document.sections.find(section=>section.id===(input.sectionId??document.sections[0]?.id));if(!section)throw new Error('文档章节不存在');
  const integer=(n:number|undefined,fallback:number,max:number)=>n===undefined?fallback:Number.isInteger(n)&&n>=0&&n<=max?n:(()=>{throw new Error('文档分页范围无效');})();
  const offset=integer(input.offset,0,section.text.length),limit=Math.max(1,integer(input.limit,12000,65536)),rowOffset=integer(input.rowOffset,0,section.rows?.length||0),maxRows=Math.max(1,integer(input.maxRows,40,200));
  if(offset>0&&/[\uDC00-\uDFFF]/.test(section.text[offset]||'')&&/[\uD800-\uDBFF]/.test(section.text[offset-1]))throw new Error('文档分页起点不能切开 Unicode 字符，请使用上一段的 nextOffset');
  let end=Math.min(section.text.length,offset+limit);if(end<section.text.length&&/[\uD800-\uDBFF]/.test(section.text[end-1]||'')){if(end-1===offset)end++;else end--;}
  const selected:DocumentRow[]=[];let bytes=0,rowsOmitted='';for(const row of input.includeRows===false?[]:section.rows?.slice(rowOffset,rowOffset+maxRows)||[]){const size=Buffer.byteLength(JSON.stringify(row));if(bytes+size>256*1024){if(!selected.length)rowsOmitted='单行表格预览超过 256 KiB，使用保留地址的文字分页。';break;}selected.push(row);bytes+=size;}
  return {hash:document.hash,kind:document.kind,sectionId:section.id,title:section.title,text:section.text.slice(offset,end),offset,...(end<section.text.length?{nextOffset:end}:{}),totalCharacters:section.text.length,rowOffset,totalRows:section.rows?.length||0,...(section.rows&&input.includeRows!==false&&!rowsOmitted?{rows:selected,columns:section.columns,...(rowOffset+selected.length<section.rows.length?{nextRowOffset:rowOffset+selected.length}:{})}:{}),...(rowsOmitted?{rowsOmitted}:{}),...(section.hidden?{hidden:section.hidden}:{})};
}
export async function renderPdfPage(path:string,pageIndex=0){
  if(!Number.isInteger(pageIndex)||pageIndex<0||pageIndex>=DOCUMENT_LIMITS.units)throw new Error('PDF 页码无效');const bytes=await sourceBytes(path);if(!bytes.subarray(0,1024).includes(Buffer.from('%PDF-')))throw new Error('文件内容不是 PDF');
  const result=await pdfOperation(bytes,'image',pageIndex);if(!result.data)throw new Error('PDF 页面渲染失败');return {dataUrl:'data:image/png;base64,'+result.data,width:result.width!,height:result.height!,hash:createHash('sha256').update(bytes).digest('hex'),pageIndex};
}
