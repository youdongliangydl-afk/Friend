import {javascript} from '@codemirror/lang-javascript';
import {json} from '@codemirror/lang-json';
import {css} from '@codemirror/lang-css';
import {html} from '@codemirror/lang-html';
import {markdown} from '@codemirror/lang-markdown';
import {classHighlighter,highlightCode} from '@lezer/highlight';
import type {DiffLine} from '../workspace-files.js';

export interface DiffToken {text:string;classes:string}
export interface DiffHighlight {left:Map<number,DiffToken[]>;right:Map<number,DiffToken[]>;language?:string}
function language(path:string){
 if(/\.[cm]?[jt]sx?$/i.test(path))return {name:/\.tsx?$/i.test(path)?'TypeScript':'JavaScript',support:javascript({typescript:/\.[cm]?tsx?$/i.test(path),jsx:/[jt]sx$/i.test(path)})};
 if(/\.json$/i.test(path))return {name:'JSON',support:json()};
 if(/\.css$/i.test(path))return {name:'CSS',support:css()};
 if(/\.html?$/i.test(path))return {name:'HTML',support:html()};
 if(/\.(?:md|markdown)$/i.test(path))return {name:'Markdown',support:markdown()};
 return undefined;
}
/** Parse each contiguous side as a document, preserving multiline lexical state. */
export function highlightDiff(lines:DiffLine[],path:string):DiffHighlight {
 const result:DiffHighlight={left:new Map(),right:new Map()},selected=language(path);if(!selected)return result;result.language=selected.name;
 for(const side of ['left','right'] as const){
  let group:{index:number;line:DiffLine}[]=[];
  const flush=()=>{
   if(!group.length)return;const code=group.map(item=>item.line.text).join('\n');
   if(code.length<=256*1024){try{let row=0;const tokens:DiffToken[][]=[[]];highlightCode(code,selected.support.language.parser.parse(code),classHighlighter,(text,classes)=>tokens[row].push({text,classes}),()=>{row++;tokens.push([]);});group.forEach((item,n)=>result[side].set(item.index,tokens[n]||[]));}catch{/* Unknown or malformed syntax remains plain, escaped React text. */}}
   group=[];
  };
  let previous:number|undefined;
  lines.forEach((line,index)=>{const number=side==='left'?line.oldLine:line.newLine;if(number===undefined)return;if(previous!==undefined&&number!==previous+1)flush();group.push({index,line});previous=number;});flush();
 }
 return result;
}
