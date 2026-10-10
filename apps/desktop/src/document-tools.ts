import {isAbsolute,relative,resolve} from 'node:path';
import {realpathSync} from 'node:fs';
import {Type} from 'typebox';
import type {ExtensionFactory} from '@earendil-works/pi-coding-agent';
import {readDocument,paginateDocument,documentManifest} from './document-reader.js';
export function documentTools(cwd:string,attachments:Map<string,string>,read:typeof readDocument=readDocument):ExtensionFactory{return pi=>{
 pi.registerTool({name:'read_document',label:'读取文档',description:'读取用户提供的 PDF、Word DOCX、PowerPoint PPTX、Excel XLSX 或 CSV。返回真实解析覆盖、内容摘要标识和分页范围。大文档必须逐页读取；解析成功不代表正文已全部进入模型上下文。XLSX包含隐藏工作表，公式显示缓存值而不重新计算。',parameters:Type.Object({path:Type.String(),sectionId:Type.Optional(Type.String()),offset:Type.Optional(Type.Number({minimum:0})),limit:Type.Optional(Type.Number({minimum:1,maximum:64000}))}),async execute(_id,args,signal){
  if(signal?.aborted)throw new Error('读取已取消');const path=realpathSync(resolve(cwd,args.path)),root=realpathSync(cwd),rel=relative(root,path),owned=rel!=='..'&&!rel.startsWith('../')&&!isAbsolute(rel);if(!owned&&!attachments.has(path))throw new Error('只能读取本工作区或用户明确添加的附件');
  const document=await read(path),expected=attachments.get(path);if(expected!==undefined&&expected!==document.hash&&expected!==document.legacyHash)throw new Error('附件内容已经变化，请用户重新添加后读取');if(signal?.aborted)throw new Error('读取已取消');const page=paginateDocument(document,{sectionId:args.sectionId,offset:args.offset||0,limit:args.limit||32000,includeRows:false});const manifest=documentManifest(document),sectionIndex=manifest.sections.findIndex(section=>section.id===page.sectionId);const result={manifest,page,nextSectionId:manifest.sections[sectionIndex+1]?.id};return {content:[{type:'text',text:JSON.stringify(result)}],details:{path,hash:document.hash,sectionId:args.sectionId,offset:args.offset||0,coverage:document.coverage}};
 }});
};}
