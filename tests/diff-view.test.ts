import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {DiffRows,FileDiffView} from '../apps/desktop/src/renderer/DiffView.js';
import {DIFF_SCOPES,expandDiffItems,foldDiffLines,LatestDiffLoader,splitDiffRows,type DiffLoadState} from '../apps/desktop/src/renderer/diff-model.js';
import {highlightDiff} from '../apps/desktop/src/renderer/diff-language.js';
import {ChangeDiffCache} from '../apps/desktop/src/renderer/change-review.js';
import {frozenRunDiff} from '../apps/desktop/src/renderer/WorkspaceDiff.js';
import {parsePatch,textFileDiff,type ChangedFile,type DiffLine} from '../apps/desktop/src/workspace-files.js';
import type {RunChangesSummary} from '../apps/desktop/src/run-changes.js';
const file=(patch:string,path='file.ts'):ChangedFile=>({path,patch,lines:parsePatch(patch),status:'M',staged:false,binary:false,additions:1,deletions:1,contextComplete:true});
const render=(value:ChangedFile,split=true)=>renderToStaticMarkup(React.createElement(FileDiffView,{state:{phase:'ready',file:value},split,retry:()=>{}}));

test('pure additions and deletions retain both split panes, correct gutters and empty counterparts',()=>{
 for(const patch of ['@@ -0,0 +1,2 @@\n+const a = 1;\n+const b = 2;','@@ -7,2 +0,0 @@\n-const a = 1;\n-const b = 2;']){
  const html=render(file(patch));assert.match(html,/data-diff-mode="split"/);assert.match(html,/data-diff-side="left"/);assert.match(html,/data-diff-side="right"/);assert.equal((html.match(/aria-label="无对应行"/g)||[]).length,2);assert.match(html,/friend-diff-number/);assert.match(html,/tok-keyword/);
 }
 const rows=splitDiffRows(foldDiffLines(parsePatch('@@ -4,2 +4,1 @@\n-old\n-old two\n+new')));assert.equal(rows[1].left?.line.oldLine,4);assert.equal(rows[1].right?.line.newLine,4);assert.equal(rows[2].left?.line.oldLine,5);assert.equal(rows[2].right,undefined);
});
test('real context folds expand to exactly the saved lines; hunk gaps never acquire invented context',()=>{
 const before=Array.from({length:30},(_,i)=>'line '+i+'\n').join(''),after=before.replace('line 15\n','changed\n'),value=textFileDiff('a.txt',before,after),folded=foldDiffLines(value.lines),folds=folded.filter(item=>item.kind==='fold');
 assert.equal(folds.length,2);const expanded=expandDiffItems(folded,new Set(folds.map(item=>item.key)));assert.equal(expanded.filter(item=>item.kind==='line'&&item.value.line.kind==='context').length,29);assert.match(render({...file(value.patch,'a.txt'),...value}),/展开 \d+ 行未修改内容/);
 const sparse=file('@@ -4 +4 @@\n-old\n+new\n@@ -40 +40 @@\n-old tail\n+new tail','old.txt');assert.equal(foldDiffLines(sparse.lines).filter(item=>item.kind==='fold').length,0);assert.equal(sparse.lines.at(-1)?.newLine,40);
});
test('multiline syntax uses contiguous per-side text and unknown languages are escaped plain text',()=>{
 const lines=parsePatch('@@ -1,3 +1,3 @@\n /* start\n-old inner\n+new inner\n end */'),highlight=highlightDiff(lines,'source.ts');assert.ok(highlight.left.get(2)?.some(token=>token.classes.includes('tok-comment')));assert.ok(highlight.right.get(3)?.some(token=>token.classes.includes('tok-comment')));
 const unknown=file('@@ -1 +1 @@\n-<script>alert("old")</script>\n+<img src=x onerror=alert(1)>','source.unknown'),html=render(unknown,false);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img|<script|tok-/);assert.equal(highlightDiff(unknown.lines,unknown.path).language,undefined);
});
test('large row sets are explicitly paginated instead of silently clipping the tail',()=>{
 const lines:DiffLine[]=Array.from({length:2003},(_,i)=>({kind:'add',text:`value ${i}`,newLine:i+1}));const html=renderToStaticMarkup(React.createElement(DiffRows,{lines,split:true}));assert.match(html,/第 1 \/ 2 页/);assert.match(html,/所有改动均可分页读取/);assert.match(html,/下一页/);
});
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
test('actual workspace loader fences A→B responses and A cannot clear B pending',async()=>{
 const states:DiffLoadState<string>[]=[],loader=new LatestDiffLoader<string>(state=>states.push(state)),a=deferred<string>(),b=deferred<string>();const loadA=loader.load('workspace-A:branch:refA:shaA',()=>a.promise),loadB=loader.load('workspace-B:staged',()=>b.promise);
 a.resolve('A stale');await loadA;assert.deepEqual(states.at(-1),{pending:true});b.resolve('B');await loadB;assert.deepEqual(states.at(-1),{pending:false,value:'B'});
 const c=deferred<string>(),d=deferred<string>(),loadC=loader.load('C',()=>c.promise),loadD=loader.load('D',()=>d.promise);d.resolve('D');await loadD;c.reject(new Error('late C'));await loadC;assert.deepEqual(states.at(-1),{pending:false,value:'D'});loader.invalidate();
});
test('six scope labels are complete and previous-run loading reads only frozen coordinates',async()=>{
 assert.deepEqual(DIFF_SCOPES.map(value=>value[0]),['run','workspace','unstaged','staged','committed','branch']);const previous=globalThis.window,requests:unknown[]=[],saved=file('@@ -1 +1 @@\n-before\n+frozen','a.txt');
 Object.assign(globalThis,{window:{friendPi:{request:async(method:string,input:unknown)=>{requests.push([method,input]);assert.equal(method,'session.changes.read');return {file:saved};}}}});
 try{const cache=new ChangeDiffCache(),summary:RunChangesSummary={v:1,sessionId:'s',projectId:'p',runId:'r',changeId:'c',startedAt:'start',finishedAt:'end',status:'completed',files:[saved]};const data=await frozenRunDiff(cache,'s',summary);assert.equal(data.files[0],saved);assert.match(data.note||'',/冻结/);assert.equal(requests.length,1);const missing=await frozenRunDiff(cache,'s',{...summary,changeId:undefined});assert.match(missing.unavailable||'',/未使用当前/);assert.equal(requests.length,1);}finally{if(previous)Object.assign(globalThis,{window:previous});else delete (globalThis as {window?:unknown}).window;}
});
test('legacy snapshots explicitly mark unavailable full context instead of pretending expandable history',()=>{
 const value=file('@@ -8 +8 @@\n-old\n+new','a.txt');delete value.contextComplete;assert.match(render(value),/未保存的历史正文不可展开/);assert.doesNotMatch(render(value),/展开 \d+ 行/);
});
