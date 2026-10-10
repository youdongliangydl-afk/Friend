import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {execFile,execFileSync} from 'node:child_process';
import {promisify} from 'node:util';
import {readDocument,renderPdfPage,parseCsv,paginateDocument,documentManifest,createDocumentReader,DOCUMENT_LIMITS} from '../apps/desktop/src/document-reader.js';
import {parseXml,officeText} from '../apps/desktop/src/document-xml.js';
import {captureDocumentInput,inspectAttachment,type DeliveredAttachment} from '../apps/desktop/src/attachment-input.js';
import {documentTools} from '../apps/desktop/src/document-tools.js';
import {captureInput} from '../apps/desktop/src/message-queue.js';
function crc32(bytes:Buffer){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function zip(entries:Record<string,string|Buffer>){
  const locals:Buffer[]=[],directory:Buffer[]=[];let offset=0;
  for(const [path,content] of Object.entries(entries)){
    const name=Buffer.from(path),bytes=typeof content==='string'?Buffer.from(content):content,crc=crc32(bytes),local=Buffer.alloc(30),central=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(0x800,6);local.writeUInt32LE(crc,14);local.writeUInt32LE(bytes.length,18);local.writeUInt32LE(bytes.length,22);local.writeUInt16LE(name.length,26);
    central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0x800,8);central.writeUInt32LE(crc,16);central.writeUInt32LE(bytes.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(name.length,28);central.writeUInt32LE(offset,42);
    locals.push(local,name,bytes);directory.push(central,name);offset+=local.length+name.length+bytes.length;
  }
  const table=Buffer.concat(directory),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(directory.length/2,8);end.writeUInt16LE(directory.length/2,10);end.writeUInt32LE(table.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,table,end]);
}
function fixture(){const root=mkdtempSync(join(tmpdir(),'friend-document-test-'));return {root,file:(name:string,content:string|Buffer)=>{const path=join(root,name);writeFileSync(path,content);return path;},close:()=>rmSync(root,{recursive:true,force:true})};}
const rels=(rows:[string,string][])=>'<Relationships>'+rows.map(([id,target])=>`<Relationship Id="${id}" Target="${target}"/>`).join('')+'</Relationships>';
function workbook(){return zip({
  'xl/workbook.xml':'<workbook xmlns:r="r"><sheets><sheet name="公开" sheetId="1" r:id="r1"/><sheet name="隐藏" sheetId="2" state="hidden" r:id="r2"/><sheet name="深度隐藏" sheetId="3" state="veryHidden" r:id="r3"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':rels([['r1','worksheets/sheet1.xml'],['r2','worksheets/sheet2.xml'],['r3','worksheets/sheet3.xml']]),
  'xl/sharedStrings.xml':'<sst><si><r><t>中</t></r><r><t>文&amp;标题</t></r><rPh><t>不应重复的拼音</t></rPh></si></sst>',
  'xl/worksheets/sheet1.xml':'<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>12.50</v></c><c r="C1"><f>SUM(B1,1)</f><v>13.5</v></c><c r="D1"><f>B1*2</f></c><c r="E1" s="1"/></row><row r="3"><c r="A3" t="inlineStr"><is><t>尾行</t></is></c></row></sheetData></worksheet>',
  'xl/worksheets/sheet2.xml':'<worksheet><sheetData><row r="2" hidden="1"><c r="A2" t="b"><v>1</v></c><c r="B2" t="e"><v>#DIV/0!</v></c></row></sheetData></worksheet>',
  'xl/worksheets/sheet3.xml':'<worksheet><sheetData><row r="1048576"><c r="XFD1048576" t="inlineStr"><is><t>最后一个有效单元格</t></is></c></row></sheetData></worksheet>'
});}
test('XLSX reads all sheets, hidden rows, sparse final cell, rich strings, formulas and saved caches without recalculation',async()=>{
  const f=fixture();try{const bytes=workbook(),path=f.file('all.xlsx',bytes),result=await readDocument(path);assert.equal(result.kind,'xlsx');assert.equal(result.hash,createHash('sha256').update(bytes).digest('hex'));assert.equal(result.sections.length,3);assert.equal(result.coverage.cells,8);assert.equal(result.coverage.hiddenSheets,2);assert.equal(result.coverage.formulaCells,2);assert.equal(result.coverage.uncachedFormulaCells,1);assert.equal(result.sections[1].hidden,'hidden');assert.equal(result.sections[2].hidden,'veryHidden');assert.match(result.text,/最后一个有效单元格/);assert.match(result.text,/SUM\(B1,1\)/);assert.match(result.text,/缺失，未计算/);assert.doesNotMatch(result.text,/不应重复/);assert.equal(result.sections[0].rows![0].cells[0].value,'中文&标题');assert.equal(result.sections[0].rows![0].cells[2].cachedValue,'13.5');assert.deepEqual(result.sections[2].columns,['XFD']);assert.equal(result.sections[2].rows![0].row,1048576);assert.deepEqual(readFileSync(path),bytes);
    const manifest=documentManifest(result);assert.equal('text' in manifest,false);assert.equal('rows' in manifest.sections[0],false);assert.equal(manifest.sections[0].rowCount,2);const page=paginateDocument(result,{sectionId:'sheet-1',maxRows:1,limit:10});assert.equal(page.rows?.length,1);assert.equal(page.nextRowOffset,1);assert.equal(page.text.length,10);assert.equal(page.nextOffset,10);assert.equal(paginateDocument(result,{sectionId:'sheet-3'}).hidden,'veryHidden');
  }finally{f.close();}
});
test('DOCX preserves paragraphs, table cells, header and footnotes while identifying unparsed embedded images',async()=>{
  const f=fixture();try{const path=f.file('report.docx',zip({
    'word/document.xml':'<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>第一段&amp;实体</w:t><w:tab/><w:t>后半</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>姓名</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>小明</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>末段</w:t></w:r></w:p></w:body></w:document>',
    'word/header1.xml':'<w:hdr xmlns:w="w"><w:p><w:r><w:t>页眉信息</w:t></w:r></w:p></w:hdr>',
    'word/footnotes.xml':'<w:footnotes xmlns:w="w"><w:footnote w:id="-1"><w:p><w:r><w:t>分隔符</w:t></w:r></w:p></w:footnote><w:footnote w:id="2"><w:p><w:r><w:t>脚注原文</w:t></w:r></w:p></w:footnote></w:footnotes>',
    'word/media/image1.png':Buffer.from([1,2,3])}));const result=await readDocument(path);assert.match(result.text,/第一段&实体\t后半/);assert.match(result.text,/姓名\t小明/);assert.match(result.text,/末段/);assert.match(result.text,/页眉信息/);assert.match(result.text,/脚注原文/);assert.doesNotMatch(result.text,/分隔符/);assert.equal(result.coverage.status,'partial');assert.equal(result.coverage.nonTextUnits,1);assert.equal(result.sections.length,3);
  }finally{f.close();}
});
test('DOCX imported altChunk content cannot be silently reported as complete',async()=>{
  const f=fixture();try{for(const part of ['word/document.xml','word/header1.xml','word/footnotes.xml']){
    const parts={'word/document.xml':'<document><body><p><t>visible</t></p></body></document>',[part]:'<document><p><t>visible</t></p><altChunk id="import"/></document>','word/import.htm':'<p>required imported body</p>'};
    await assert.rejects(readDocument(f.file('import.docx',zip(parts))),/altChunk.*无法完整读取/);
  }}finally{f.close();}
});
test('XLSX decodes escaped strings once across shared, inline and formula cached text',async()=>{
  const f=fixture();try{const result=await readDocument(f.file('escaped.xlsx',zip({
    'xl/workbook.xml':'<workbook xmlns:r="r"><sheets><sheet name="data" r:id="s"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':rels([['s','worksheets/sheet1.xml']]),
    'xl/sharedStrings.xml':'<sst><si><t>line1_x000D_line2 literal _x005F_x000D_</t></si></sst>',
    'xl/worksheets/sheet1.xml':'<worksheet><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t>_xD83D__xDE00_ _x005F_x0041_</t></is></c><c r="C1" t="str"><f>"cached"</f><v>A_x000A_B</v></c></row></sheetData></worksheet>'
  })));const cells=result.sections[0].rows![0].cells;assert.equal(cells[0].value,'line1\rline2 literal _x000D_');assert.equal(cells[1].value,'😀 _x0041_');assert.equal(cells[2].cachedValue,'A\nB');
  }finally{f.close();}
});
test('PPTX follows presentation order, reads tables and slide notes, and never fetches external relations',async()=>{
  const f=fixture();try{const result=await readDocument(f.file('deck.pptx',zip({
    'ppt/presentation.xml':'<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst><p:sldId id="8" r:id="slideB"/><p:sldId id="3" r:id="slideA"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels':rels([['slideB','slides/slide9.xml'],['slideA','slides/slide2.xml']]),
    'ppt/slides/slide9.xml':'<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><a:p><a:r><a:t>第一页</a:t></a:r></a:p><a:tbl><a:tr><a:tc><a:p><a:r><a:t>指标</a:t></a:r></a:p></a:tc><a:tc><a:p><a:r><a:t>42</a:t></a:r></a:p></a:tc></a:tr></a:tbl></p:cSld></p:sld>',
    'ppt/slides/slide2.xml':'<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>第二页</a:t></a:r></a:p></p:sld>',
    'ppt/slides/_rels/slide9.xml.rels':'<Relationships><Relationship Id="notes" Target="../notesSlides/notesSlide1.xml"/><Relationship Id="link" Target="https://example.invalid/secret" TargetMode="External"/></Relationships>',
    'ppt/notesSlides/notesSlide1.xml':'<p:notes xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>必须保留的演讲备注</a:t></a:r></a:p></p:notes>'
  })));assert.equal(result.sections.length,2);assert.match(result.sections[0].text,/第一页/);assert.match(result.sections[0].text,/指标\t42/);assert.match(result.sections[0].text,/必须保留的演讲备注/);assert.match(result.sections[1].text,/第二页/);
  }finally{f.close();}
});
test('CSV handles BOM, escaped quotes, CRLF, quoted multiline fields and trailing empty cells',async()=>{
  const source='\ufeffname,note,tail\r\n"小明","第一行\r\n第二行含""引号""",\r\n';assert.deepEqual(parseCsv(source),[['name','note','tail'],['小明','第一行\r\n第二行含"引号"','']]);assert.deepEqual(parseCsv('""'),[['']]);assert.deepEqual(parseCsv(''),[]);assert.throws(()=>parseCsv('"broken'),/未闭合/);assert.throws(()=>parseCsv('bad"quote'),/位置/);assert.throws(()=>parseCsv('"value"extra'),/无效/);
  const f=fixture();try{const result=await readDocument(f.file('table.csv',source));assert.equal(result.coverage.cells,6);assert.equal(result.sections[0].rows![1].cells[1].value,'第一行\r\n第二行含"引号"');}finally{f.close();}
});
test('CSV enforces its cell budget while collecting fields, including one wide row',()=>{
  assert.throws(()=>parseCsv(','.repeat(DOCUMENT_LIMITS.cells)),/单元格超过/);
  assert.throws(()=>parseCsv('a,b\n'.repeat(DOCUMENT_LIMITS.cells/2+1)),/单元格超过/);
});
test('document reader refuses named pipes without waiting for a writer',{skip:process.platform==='win32',timeout:5000},async()=>{
  const f=fixture();try{const pipe=join(f.root,'not-a-file.pdf');execFileSync('/usr/bin/mkfifo',[pipe],{timeout:2000});
    const code="const {readDocument}=await import('./apps/desktop/src/document-reader.ts');try{await readDocument(process.argv[1]);process.exitCode=2;}catch(error){if(error.message!=='请选择普通文件')throw error;process.stdout.write('refused non-regular file');}";
    const result=await promisify(execFile)(process.execPath,['--import','tsx','--input-type=module','--eval',code,pipe],{cwd:process.cwd(),encoding:'utf8',timeout:3000,killSignal:'SIGKILL',maxBuffer:8192});assert.equal(result.stdout,'refused non-regular file');
  }finally{f.close();}
});
test('XML supports entities and CDATA, rejects DTD, malformed nesting and unbounded nesting',()=>{
  assert.equal(officeText(parseXml('<r><t><![CDATA[<raw>]]>&#x4e2d;&#25991;&amp;</t></r>')),'<raw>中文&');assert.throws(()=>parseXml('<!DOCTYPE x [<!ENTITY stolen SYSTEM "file:///etc/passwd">]><r/>'),/不允许/);assert.throws(()=>parseXml('<a><b></a>'),/不匹配/);assert.throws(()=>parseXml('<a>'.repeat(257)+'</a>'.repeat(257)),/256/);assert.throws(()=>parseXml('<r><t>&notDefined;</t></r>'),/实体/);
  assert.throws(()=>parseXml('<r><t>&#x12ZZ;</t></r>'),/实体/);assert.throws(()=>parseXml('<r><t>&toString;</t></r>'),/实体/);
});
test('repeated XLSX shared strings hit the extracted-text limit before materializing an oversized result',async()=>{
  const f=fixture();try{const cells=Array.from({length:1800},(_,index)=>`<row r="${index+1}"><c r="A${index+1}" t="s"><v>0</v></c></row>`).join('');const path=f.file('expanding.xlsx',zip({'xl/workbook.xml':'<workbook xmlns:r="r"><sheets><sheet name="data" r:id="s"/></sheets></workbook>','xl/_rels/workbook.xml.rels':rels([['s','worksheets/sheet1.xml']]),'xl/sharedStrings.xml':'<sst><si><t>'+'x'.repeat(40000)+'</t></si></sst>','xl/worksheets/sheet1.xml':'<worksheet><sheetData>'+cells+'</sheetData></worksheet>'}));await assert.rejects(readDocument(path),/文字超过 64 MiB/);}finally{f.close();}
});
test('Office rejects traversal, duplicate metadata, corrupt CRC, encryption, large expansion and missing sheet relations',async()=>{
  const f=fixture();try{
    await assert.rejects(readDocument(f.file('unsafe.docx',zip({'../escape.xml':'x','word/document.xml':'<document/>'}))),/不安全/);
    const corrupt=zip({'word/document.xml':'<document/>'}),localContent=30+Buffer.byteLength('word/document.xml');corrupt[localContent]^=1;await assert.rejects(readDocument(f.file('corrupt.docx',corrupt)));
    const encrypted=zip({'word/document.xml':'<document/>'}),start=encrypted.readUInt32LE(encrypted.length-6);encrypted.writeUInt16LE(0x801,start+8);await assert.rejects(readDocument(f.file('encrypted.docx',encrypted)),/加密/);
    const huge=zip({'word/document.xml':'<document/>'}),directory=huge.readUInt32LE(huge.length-6);huge.writeUInt32LE(DOCUMENT_LIMITS.expandedBytes+1,directory+24);await assert.rejects(readDocument(f.file('huge.docx',huge)),/128 MiB/);
    await assert.rejects(readDocument(f.file('missing.xlsx',zip({'xl/workbook.xml':'<workbook xmlns:r="r"><sheets><sheet name="bad" r:id="missing"/></sheets></workbook>'}))),/关系缺失/);
    await assert.rejects(readDocument(f.file('empty.docx','')),/不是现代/);await assert.rejects(readDocument(f.file('old.doc','old')),/旧版/);
  }finally{f.close();}
});
test('text paging preserves all characters and model-facing pages can omit table data',async()=>{
  const f=fixture();try{const doc=await readDocument(f.file('text.txt','A😀BC中文'.repeat(80)));for(const limit of [1,2,3]){let offset=0,text='';while(true){const page=paginateDocument(doc,{offset,limit});text+=page.text;if(page.nextOffset===undefined)break;assert.ok(page.nextOffset>offset);offset=page.nextOffset;}assert.equal(text,doc.sections[0].text);assert.equal(text.includes('\uFFFD'),false);}assert.throws(()=>paginateDocument(doc,{offset:-1}),/范围/);assert.throws(()=>paginateDocument(doc,{offset:2}),/Unicode/);assert.throws(()=>paginateDocument(doc,{sectionId:'absent'}),/不存在/);
    const table=await readDocument(f.file('all.xlsx',workbook()));const page=paginateDocument(table,{sectionId:'sheet-1',includeRows:false});assert.equal(page.rows,undefined);assert.match(page.text,/中文/);assert.equal(documentManifest(table).coverage.cells,8);
  }finally{f.close();}
});
test('attachment preflight independently reports complete inline and deferred input; changed or failed files reject capture',async()=>{
  const f=fixture();try{const small=f.file('small.xlsx',workbook()),large=f.file('large.csv','column\n'+'"正文😀'+'x'.repeat(110000)+'"\n'),inspected=await inspectAttachment(small);const payload=await captureDocumentInput({text:'核对两份材料',attachments:[{path:small,hash:inspected.hash},{path:large}]});const attachments=payload.attachments as DeliveredAttachment[];
    assert.equal(attachments.length,2);assert.equal(attachments[0].delivery,'inline');assert.equal(attachments[0].modelCharacters,(await readDocument(small)).text.length);assert.match(attachments[0].text!,/最后一个有效单元格/);assert.equal(attachments[1].delivery,'reference');assert.equal(attachments[1].modelCharacters,0);assert.doesNotMatch(attachments[1].text!,/xxxxx/);assert.match(attachments[1].text!,/read_document/);assert.match(attachments[1].text!,/解析成功不代表已阅读/);
    writeFileSync(small,workbook().subarray(0,100));await assert.rejects(captureDocumentInput({text:'不应开始',attachments:[{path:small,hash:inspected.hash}]}));const ordinary=f.file('small.txt','original');const old=await inspectAttachment(ordinary);writeFileSync(ordinary,'changed');await assert.rejects(captureDocumentInput({text:'reject stale input',attachments:[{path:ordinary,hash:old.hash}]}),/已经?变化|已变化/);
    await assert.rejects(captureDocumentInput({text:'any',attachments:[{path:f.file('broken.docx','not a zip')}]}),/不是现代/);
  }finally{f.close();}
});
test('each document cache checks current source hashes, freezes nested data, refreshes LRU order and clears independently',async()=>{
  const f=fixture();try{const reader=createDocumentReader(),other=createDocumentReader(),paths=Array.from({length:5},(_,i)=>f.file('cache-'+i+'.txt','content '+i));const a=await reader.read(paths[0]);assert.equal(await reader.read(paths[0]),a);assert.notEqual(await other.read(paths[0]),a);assert.throws(()=>a.sections.push({id:'stolen',title:'bad',text:'mutated'}),TypeError);assert.throws(()=>{a.sections[0].text='bad';},TypeError);
    const b=await reader.read(paths[1]);await reader.read(paths[2]);await reader.read(paths[3]);assert.equal(await reader.read(paths[0]),a);await reader.read(paths[4]);assert.equal(await reader.read(paths[0]),a);assert.notEqual(await reader.read(paths[1]),b);
    writeFileSync(paths[0],'new content');const changed=await reader.read(paths[0]);assert.notEqual(changed,a);assert.notEqual(changed.hash,a.hash);assert.match(changed.text,/new content/);reader.clear();assert.notEqual(await reader.read(paths[0]),changed);
  }finally{f.close();}
});
test('document cache evicts when retained extracted text exceeds 32 MiB',async()=>{
  const f=fixture();try{const reader=createDocumentReader(),a=f.file('large-a.txt','a'.repeat(17*1024*1024)),b=f.file('large-b.txt','b'.repeat(17*1024*1024)),first=await reader.read(a);await reader.read(b);assert.notEqual(await reader.read(a),first);reader.clear();}finally{f.close();}
});
test('read_document limits model output to one text range, keeps hidden sheet content, and rejects unauthorized or changed attachments',async()=>{
  const f=fixture(),outside=fixture();try{const path=f.file('all.xlsx',workbook()),external=outside.file('external.txt','private external attachment'),externalSource=await readDocument(external),allowed=new Map([[realpathSync(external),externalSource.hash]]);let tool:any;
    await documentTools(f.root,allowed)({registerTool:(registered:unknown)=>{tool=registered;}} as any);assert.equal(tool.name,'read_document');const result=await tool.execute('read',{path:'all.xlsx',sectionId:'sheet-3',limit:64000});const page=JSON.parse(result.content[0].text);const section=page.page||page;assert.match(section.text,/最后一个有效单元格/);assert.equal(section.rows,undefined);assert.equal(section.hidden,'veryHidden');assert.equal(result.details.coverage.hiddenSheets,2);assert.equal(result.content.length,1);
    const first=JSON.parse((await tool.execute('read',{path:'all.xlsx'})).content[0].text);assert.equal(first.manifest.sections.length,3);assert.equal(first.manifest.sections[1].hidden,'hidden');assert.equal(first.manifest.sections[2].hidden,'veryHidden');assert.equal(first.nextSectionId,'sheet-2');
    const original=await readDocument(path);for(const source of original.sections){let offset=0,joined='';while(true){const response=JSON.parse((await tool.execute('read',{path:'all.xlsx',sectionId:source.id,offset,limit:9})).content[0].text);assert.equal(response.page.rows,undefined);joined+=response.page.text;if(response.page.nextOffset===undefined)break;offset=response.page.nextOffset;}assert.equal(joined,source.text);}
    await tool.execute('read',{path:external});writeFileSync(external,'changed after preflight');await assert.rejects(tool.execute('read',{path:external}),/已经变化/);await assert.rejects(tool.execute('read',{path:outside.file('not-added.txt','not authorized')}),/只能读取/);const controller=new AbortController();controller.abort();await assert.rejects(tool.execute('read',{path:'all.xlsx'},controller.signal),/取消/);
  }finally{f.close();outside.close();}
});
test('legacy frozen attachment hashes authorize unchanged bytes without weakening changed-source rejection',async()=>{
  const f=fixture(),outside=fixture();try{const path=outside.file('legacy.txt','original legacy bytes'),old=captureInput({text:'read',attachments:[{path}]}).attachments[0];let tool:any;
    documentTools(f.root,new Map([[realpathSync(path),old.hash]]))({registerTool:(registered:unknown)=>{tool=registered;}} as any);
    const result=JSON.parse((await tool.execute('legacy',{path})).content[0].text);assert.match(result.page.text,/original legacy bytes/);assert.notEqual(result.manifest.hash,old.hash);assert.equal('legacyHash' in result.manifest,false);
    writeFileSync(path,'changed legacy bytes');await assert.rejects(tool.execute('changed',{path}),/已经变化/);
  }finally{f.close();outside.close();}
});
function pdf(pages:string[]){
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];const kids:string[]=[];
  for(const text of pages){const pageId=objects.length+1,contentId=pageId+1,stream=text?`BT /F1 18 Tf 30 150 Td (${text.replace(/[\\()]/g,'\\$&')}) Tj ET`:'';kids.push(pageId+' 0 R');objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`,`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);}
  objects[1]=`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;let output='%PDF-1.4\n',offsets=[0];for(const [index,object] of objects.entries()){offsets.push(Buffer.byteLength(output));output+=(index+1)+' 0 obj\n'+object+'\nendobj\n';}const start=Buffer.byteLength(output);output+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;return output;
}
test('PDFKit visits every page, labels non-text pages and renders a real PNG without Python or a model',{skip:process.platform!=='darwin'},async()=>{
  const f=fixture();try{const path=f.file('two-pages.pdf',pdf(['First page text',''])),result=await readDocument(path);assert.equal(result.kind,'pdf');assert.equal(result.sections.length,2);assert.match(result.sections[0].text,/First page text/);assert.equal(result.sections[1].text,'');assert.equal(result.coverage.status,'partial');assert.deepEqual(result.coverage.emptyUnits,['page-2']);assert.match(result.warnings.join(' '),/未执行 OCR/);
    const image=await renderPdfPage(path,0);assert.equal(image.hash,result.hash);assert.ok(image.width>0&&image.width<=1400);assert.ok(image.height>0&&image.height<=1800);assert.deepEqual(Buffer.from(image.dataUrl.split(',')[1],'base64').subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));await assert.rejects(renderPdfPage(path,99),/页码/);
  }finally{f.close();}
});
