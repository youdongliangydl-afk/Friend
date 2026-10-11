import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {DiffFileBrowser} from '../apps/desktop/src/renderer/DiffFileBrowser.js';
import {DiffRows,FileDiffView} from '../apps/desktop/src/renderer/DiffView.js';
import {DIFF_PAGE_LINES,diffBlockLocation,diffFileRatio,foldDiffLines,projectDiffBlocks,selectedDiffIndex} from '../apps/desktop/src/renderer/diff-model.js';
import {frozenRunMetadata} from '../apps/desktop/src/renderer/WorkspaceDiff.js';
import {parsePatch,type ChangedFile,type DiffLine} from '../apps/desktop/src/workspace-files.js';
import type {RunChangesSummary} from '../apps/desktop/src/run-changes.js';

const replacement=(gap:number):DiffLine[]=>parsePatch('@@ -1,20 +1,20 @@\n-old first\n+new first\n'+Array.from({length:gap},(_,i)=>' context '+i+'\n').join('')+'-old last\n+new last\n\\ No newline at end of file');
test('navigation uses three-line fold boundaries rather than counting patch hunk headers',()=>{
 const nearby=projectDiffBlocks(replacement(7)),separate=projectDiffBlocks(replacement(8));
 assert.equal(nearby.length,1);assert.deepEqual([nearby[0].additions,nearby[0].deletions],[2,2]);
 assert.equal(separate.length,2,'one @@ header can contain two independently folded change blocks');
 assert.deepEqual(separate.map(block=>[block.additions,block.deletions]),[[1,1],[1,1]]);
 assert.equal(projectDiffBlocks(parsePatch('@@ -1 +1 @@\n-old\n+new\n@@ -50 +50 @@\n-old2\n+new2')).length,2);
 assert.equal(projectDiffBlocks([{kind:'context',text:'unchanged',oldLine:1,newLine:1}]).length,0);
});
test('stable source anchors locate late changes across 2000-row pages in unified and split views',()=>{
 const lines:DiffLine[]=[...Array.from({length:2001},(_,i)=>({kind:'remove' as const,text:'old '+i,oldLine:i+1})),...Array.from({length:2001},(_,i)=>({kind:'add' as const,text:'new '+i,newLine:i+1})),...Array.from({length:30},(_,i)=>({kind:'context' as const,text:'context '+i,oldLine:2002+i,newLine:2002+i})),{kind:'remove',text:'old tail',oldLine:2032},{kind:'add',text:'new tail',newLine:2032}];
 const blocks=projectDiffBlocks(lines),tail=blocks[1];assert.equal(blocks.length,2);
 const collapsed=new Set<string>(),expanded=new Set(foldDiffLines(lines).filter(item=>item.kind==='fold').map(item=>item.key));
 assert.equal(diffBlockLocation(lines,tail,false,collapsed)?.page,2);
 assert.equal(diffBlockLocation(lines,tail,true,collapsed)?.page,1);
 assert.equal(diffBlockLocation(lines,tail,false,expanded)?.row,4032);
 assert.equal(diffBlockLocation(lines,tail,true,expanded)?.row,2031);
 assert.equal(DIFF_PAGE_LINES,2000);assert.deepEqual(projectDiffBlocks(lines),blocks,'context expansion does not redefine blocks');
});
test('every rendering mode retains source-line anchors and the same block choices',()=>{
 const lines=replacement(8),first=projectDiffBlocks(lines)[0];
 for(const [split,wrap] of [[false,false],[false,true],[true,false],[true,true]]){
  const html=renderToStaticMarkup(React.createElement(DiffRows,{lines,split,wrap}));
  assert.match(html,/定位当前文件改动区块/);assert.ok(html.includes(`data-diff-source-index="${first.first}"`));
  assert.match(html,/1 \/ 2/);assert.match(html,/2 \/ 2/);assert.match(html,/上一处/);assert.match(html,/下一处/);
 }
});
test('file map consumes only metadata, preserves full special paths and states, and does not touch bodies',()=>{
 const files=[{path:'src/deep/中文 & name.ts',oldPath:'src/old.ts',status:'R',binary:false,additions:3,deletions:1},{path:'assets/logo.bin',status:'M',binary:true},{path:'lost.ts',status:'M',binary:false,error:'本地不可读取'}];
 for(const file of files)Object.defineProperties(file,{patch:{get(){throw Error('map read patch');}},lines:{get(){throw Error('map read lines');}}});
 const html=renderToStaticMarkup(React.createElement(DiffFileBrowser,{files,index:0,onSelect:()=>{},children:React.createElement('p',null,'selected body only')}));
 assert.match(html,/src\/deep\/中文 &amp; name.ts/);assert.match(html,/原路径：src\/old.ts/);assert.match(html,/width:75%/);assert.match(html,/width:25%/);assert.match(html,/二进制或大文件/);assert.match(html,/读取失败/);assert.match(html,/展开文件地图|收起文件地图/);assert.match(html,/选择差异文件/);
 assert.equal(diffFileRatio({additions:undefined,deletions:1}),undefined);assert.equal(diffFileRatio({additions:-1,deletions:1}),undefined);assert.deepEqual(diffFileRatio({additions:0,deletions:0}),{additions:0,deletions:0,addedPercent:0,removedPercent:0});
});
test('missing, binary, errored and truncated content keep metadata and explain disabled block navigation',()=>{
 const base:ChangedFile={path:'a.ts',status:'M',staged:false,binary:false,patch:'',lines:[],additions:12,deletions:8};
 for(const [file,reason] of [[{...base,binary:true},'二进制或大文件仅提供元信息'],[{...base,error:'missing blob'},'文件读取失败'],[{...base,truncated:true},'比较正文超出预算'],[{...base,lines:replacement(8),truncated:true},'比较正文不完整']] as const){
  const html=renderToStaticMarkup(React.createElement(FileDiffView,{state:{phase:'ready',file},retry:()=>{}}));
  assert.ok(html.includes(reason));assert.match(html,/disabled=""/);assert.match(html,/a.ts/);assert.doesNotMatch(html,/定位当前文件改动区块/);if(!file.binary&&!file.error){assert.match(html,/\+12/);assert.match(html,/−8/);}
 }
 const missing=renderToStaticMarkup(React.createElement(FileDiffView,{state:{phase:'missing',message:'冻结正文已丢失，未用当前版本替代'},retry:()=>{}}));assert.match(missing,/历史正文不可用/);assert.match(missing,/未用当前版本替代/);
});
test('frozen map comes from summary only and previous selection cannot leak into a new owner',()=>{
 const summary:RunChangesSummary={v:1,sessionId:'s',projectId:'p',runId:'r',changeId:'c',startedAt:'start',finishedAt:'end',status:'completed',files:[{path:'a.ts',status:'M',binary:false,additions:2,deletions:1},{path:'b.bin',status:'A',binary:true}]};
 const data=frozenRunMetadata('s',summary);assert.deepEqual(data.files.map(file=>file.path),['a.ts','b.bin']);assert.ok(data.files.every(file=>file.lines.length===0&&file.patch===''));assert.match(data.note||'',/冻结快照/);
 assert.equal(selectedDiffIndex('A',{owner:'A',index:1},2),1);assert.equal(selectedDiffIndex('B',{owner:'A',index:1},2),0);assert.equal(selectedDiffIndex('B',{owner:'A',index:7},8,3),3);assert.equal(selectedDiffIndex('B',undefined,0),-1);
 assert.match(frozenRunMetadata('s',{...summary,changeId:undefined}).unavailable||'',/未使用当前工作区/);
});
