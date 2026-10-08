import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {composerKeyAction,insertNewline} from '../apps/desktop/src/renderer/composer-keys.js';
import {projectTimeline} from '../apps/desktop/src/renderer/timeline.js';
import {Conversation} from '../apps/desktop/src/renderer/Conversation.js';
import {reorderIds} from '../apps/desktop/src/renderer/ProjectStrip.js';
import {materialPath} from '../apps/desktop/src/renderer/material-links.js';
import type {Message} from '../apps/desktop/src/renderer/types.js';
const assistant:Message={id:'a',role:'assistant',text:'beforeafter',parts:[{type:'text',text:'before'},{type:'thinking',thinking:'why'},{type:'toolCall',id:'one',name:'read',arguments:{path:'a'}},{type:'text',text:'after'}]};
const result:Message={id:'r',role:'toolResult',text:'contents',toolCallId:'one',toolName:'read',isError:false};
test('composer Enter sends and modifier Enter inserts a newline, including inherited DOM properties',()=>{
  assert.equal(composerKeyAction({key:'Enter'},false),'send');
  for(const key of ['metaKey','ctrlKey','shiftKey','altKey'])assert.equal(composerKeyAction(Object.create({key:'Enter',[key]:true}),false),'newline');
  for(const event of [{key:'Enter',isComposing:true},{key:'Enter',keyCode:229},{key:'Enter',repeat:true}])assert.equal(composerKeyAction(event,false),'none');
  assert.equal(composerKeyAction({key:'Enter'},true),'none');assert.deepEqual(insertNewline('abcd',1,3),{value:'a\nd',caret:2});
});
test('native ordered parts and tool result merge occupy exactly the call location',()=>{
 const rows=projectTimeline([assistant,result],null,[{id:'one',name:'read',status:'failed',input:{},error:true}],false);
 assert.equal(rows.length,1);assert.deepEqual(rows[0].parts.map(p=>p.kind),['text','thinking','tool','text']);
 const tool=rows[0].parts[2];assert.equal(tool.kind,'tool');if(tool.kind==='tool'){assert.equal(tool.tool.status,'completed');assert.equal(tool.tool.error,false);}
 const html=renderToStaticMarkup(React.createElement(Conversation,{messages:[assistant,result],live:null,tools:[],running:false}));assert.equal(html.match(/data-tool-call-id="one"/g)?.length,1);
});
test('parallel result order cannot reorder tools and settled missing results are interrupted',()=>{
 const two={...assistant,parts:[{type:'toolCall',id:'one',name:'read'},{type:'toolCall',id:'two',name:'ls'}]};
 const rows=projectTimeline([two,{...result,toolCallId:'two'},result],null,[],false);assert.deepEqual(rows[0].parts.map(p=>p.kind==='tool'&&p.tool.id),['one','two']);
 const part=projectTimeline([assistant],null,[{id:'one',name:'read',input:{},status:'running'}],false)[0].parts[2];assert.equal(part.kind==='tool'&&part.tool.status,'interrupted');
});
test('live to native ID handover deduplicates while identical timestamps do not discard distinct messages',()=>{
 assert.equal(projectTimeline([assistant],assistant,[],true).length,1);
 assert.equal(projectTimeline([{...assistant,timestamp:1},{...assistant,id:'b',parts:[{type:'text',text:'another'}],timestamp:1}],null,[],false).length,2);
});
test('project reorder is an exact stable move and selected identity is independent',()=>{assert.deepEqual(reorderIds(['a','b','c'],'a','c',true),['b','c','a']);assert.deepEqual(reorderIds(['a','b','c'],'c','a'),['c','a','b']);assert.deepEqual(reorderIds(['a','b'],'x','a'),['a','b']);});
test('material links preserve absolute paths and resolve Unicode relative links safely',()=>{
 assert.deepEqual(materialPath('../%E4%B8%AD%20%E6%96%87.ts:3','docs/readme.md'),{path:'docs/../中 文.ts',line:3});
 assert.deepEqual(materialPath('/Users/me/a.ts:2'),{path:'/Users/me/a.ts',line:2});assert.equal(materialPath('javascript:alert(1)'),undefined);assert.equal(materialPath('%zz'),undefined);assert.equal(materialPath('#header','README.md'),undefined);
});

test('terminal protocol replies remain responses after copy/modifier intent; actual data uses user input',async()=>{const {terminalDataAction}=await import('../apps/desktop/src/renderer/terminal-input.js');for(const reply of ['\x1b[1;2R','\x1b[0n','\x1b[I','\x1b[O'])for(const intent of [false,true])assert.equal(terminalDataAction(reply,intent),'response');assert.equal(terminalDataAction('text',true),'input');assert.equal(terminalDataAction('text',false),'ignore');assert.deepEqual(materialPath('README.md:20'),{path:'README.md',line:20});});
