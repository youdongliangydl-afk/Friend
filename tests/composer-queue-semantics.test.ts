import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {composerKeyAction,composerSubmitIntent,insertNewline} from '../apps/desktop/src/renderer/composer-keys.js';
import {SessionComposer,type ComposerSnapshot} from '../apps/desktop/src/renderer/SessionComposer.js';

const base:ComposerSnapshot={sessionId:'queue',epoch:1,draft:'继续分析',attachments:[],running:false,sending:false,navigating:false,archived:false,planMode:false,permissionMode:'auto',permissionExplicit:true,mode:'single',plugins:[],models:[],modelId:'fixture',thinkingLevel:'off',thinkingLevels:['off'],ready:true,floating:false,collapsed:false,status:'准备就绪'};
const html=(value:Partial<ComposerSnapshot>)=>renderToStaticMarkup(React.createElement(SessionComposer,{value:{...base,...value},action:async()=>{}}));
const buttons=(markup:string,label:string):string[]=>Array.from(markup.match(new RegExp('<button[^>]*aria-label="'+label+'"[^>]*>','g'))||[]);

test('idle Enter sends, running Enter queues, ⌘Enter appends followUp and ⌘⇧Enter steers',()=>{
 for(const key of ['metaKey','ctrlKey'] as const)assert.equal(composerSubmitIntent({key:'Enter',[key]:true},{running:true,hasContent:true}),'followUp');
 for(const key of ['metaKey','ctrlKey'] as const)assert.equal(composerSubmitIntent({key:'Enter',[key]:true,shiftKey:true},{running:true,hasContent:true}),'steer');
 assert.equal(composerSubmitIntent({key:'Enter'},{running:true,hasContent:true}),'queue');
 assert.equal(composerSubmitIntent({key:'Enter'},{running:false,hasContent:true}),'send');
 assert.equal(composerSubmitIntent({key:'Enter',metaKey:true},{running:false,hasContent:true}),'send');
 assert.equal(composerSubmitIntent({key:'Enter'},{running:true,hasContent:true,member:true}),'send');
 assert.equal(composerSubmitIntent({key:'Enter',metaKey:true},{running:true,hasContent:true,member:true}),'send');
});
test('the queue keys never fire during IME composition, repeats or empty input, while Shift Enter still breaks the line',()=>{
 for(const event of [{key:'Enter',isComposing:true},{key:'Enter',keyCode:229},{key:'Enter',repeat:true},{key:'Escape'}])assert.equal(composerSubmitIntent(event as any,{running:true,hasContent:true}),'none');
 assert.equal(composerSubmitIntent({key:'Enter'},{running:true,hasContent:true,composing:true}),'none');
 for(const event of [{key:'Enter'},{key:'Enter',metaKey:true},{key:'Enter',metaKey:true,shiftKey:true}])assert.equal(composerSubmitIntent(event,{running:true,hasContent:false}),'none');
 assert.equal(composerSubmitIntent({key:'Enter',shiftKey:true},{running:true,hasContent:false}),'newline');
 assert.equal(composerSubmitIntent({key:'Enter',altKey:true},{running:true,hasContent:true}),'newline');
 assert.equal(composerSubmitIntent({key:'Enter',shiftKey:true,metaKey:true},{running:true,hasContent:false}),'none');
});
test('the legacy key mapping keeps its published contract for plain and modifier Enter',()=>{
 assert.equal(composerKeyAction({key:'Enter'},false),'send');
 for(const key of ['metaKey','ctrlKey','shiftKey','altKey'] as const)assert.equal(composerKeyAction({key:'Enter',[key]:true},false),'newline');
 assert.deepEqual(insertNewline('abcd',1,3),{value:'a\nd',caret:2});
});
test('the running composer exposes a queue, followUp and steer control with the queue hint',()=>{
 const markup=html({running:true});
 for(const label of ['排队消息','追加到当前回合','插入纠偏'])assert.equal(buttons(markup,label).length,1,label);
 assert.match(buttons(markup,'排队消息')[0],/title="Enter 排队/);
 assert.match(buttons(markup,'追加到当前回合')[0],/⌘ Enter/);
 assert.match(buttons(markup,'插入纠偏')[0],/⌘⇧ Enter/);
 assert.match(markup,/aria-label="队列操作说明"[\s\S]*?Enter 排队 · ⌘ Enter 追加 · ⌘⇧ Enter 纠偏/);
 assert.equal(buttons(markup,'发送消息').length,0);
});
test('running composer controls stay disabled for empty, goal-draft, sending or archived input',()=>{
 for(const patch of [{draft:''},{goalDraft:true},{sending:true},{archived:true}] as Partial<ComposerSnapshot>[]){
  const markup=html({running:true,...patch});
  for(const label of ['排队消息','追加到当前回合','插入纠偏'])assert.match(buttons(markup,label)[0],/\bdisabled=""/,label);
 }
 const idle=html({running:false});
 for(const label of ['排队消息','追加到当前回合','插入纠偏'])assert.equal(buttons(idle,label).length,0);
 assert.equal(buttons(idle,'发送消息').length,1);
});
test('member composers keep their addendum send control without the main queue actions',()=>{
 const markup=renderToStaticMarkup(React.createElement(SessionComposer,{value:{...base,running:true},recipient:'成员 A',action:async()=>{}}));
 assert.equal(buttons(markup,'发送补充').length,1);
 for(const label of ['排队消息','追加到当前回合','插入纠偏'])assert.equal(buttons(markup,label).length,0);
});

function surfaceAction(){
 const source=readFileSync('apps/desktop/src/renderer/SessionComposer.tsx','utf8');
 const start=source.indexOf('  const action=async(input:ComposerAction)=>{'),end=source.indexOf('  return snapshot?',start);
 assert.ok(start>=0&&end>start,'production overlay action boundaries changed');
 const bridge:any[]=[],initial={sessionId:'native',epoch:1,revision:1,submissionRevision:0,draft:'继续',attachments:[],sending:false,ready:true,archived:false,navigating:false,permissionMode:'auto',token:'bound'};
 const ctx:any={latest:{current:initial},localDraft:{current:null},localQueueUi:{current:null},pending:{current:false},revision:{current:1},submitting:{current:null},localStorage:{setItem(){}},setSnapshot(next:any){ctx.latest.current=next;},window:{friendComposer:{action:async(input:any)=>{bridge.push(input);return {ok:true};}}}};
 vm.createContext(ctx);vm.runInContext(stripTypeScriptTypes(source.slice(start,end)+'\nglobalThis.action=action;'),ctx);
 return {ctx,bridge};
}
test('overlay followUp and steer intents cross the bridge without pretending a submission is pending',async()=>{
 const f=surfaceAction();
 for(const intent of ['followUp','steer','queue'] as const){
  f.ctx.submitting.current=null;await f.ctx.action({type:'send',sessionId:'native',epoch:1,text:'继续',intent});
  assert.equal(f.bridge.at(-1).intent,intent);assert.equal(f.ctx.submitting.current,null,intent);assert.equal(f.ctx.latest.current.sending,false,intent);
 }
 await f.ctx.action({type:'send',sessionId:'native',epoch:1,text:'继续'});
 assert.equal(f.ctx.submitting.current!==null,true);assert.equal(f.ctx.latest.current.sending,true);
});
