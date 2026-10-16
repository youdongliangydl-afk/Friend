import {SessionTabs,NewTabPage} from '../apps/desktop/src/renderer/SessionTabs.js';
import {initialView,toolNames,type ToolPage} from '../apps/desktop/src/session-view.js';
import {SessionComposer,type ComposerSnapshot} from '../apps/desktop/src/renderer/SessionComposer.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {composerKeyAction,insertNewline} from '../apps/desktop/src/renderer/composer-keys.js';
import {projectTimeline} from '../apps/desktop/src/renderer/timeline.js';
import {Conversation} from '../apps/desktop/src/renderer/Conversation.js';
import {reorderIds} from '../apps/desktop/src/renderer/ProjectSidebar.js';
import {materialPath} from '../apps/desktop/src/renderer/material-links.js';
import {pluginEventUpdate} from '../apps/desktop/src/renderer/panels.js';
import type {Message} from '../apps/desktop/src/renderer/types.js';
const assistant:Message={id:'a',role:'assistant',text:'beforeafter',parts:[{type:'text',text:'before'},{type:'thinking',thinking:'why'},{type:'toolCall',id:'one',name:'read',arguments:{path:'a'}},{type:'text',text:'after'}]};
const result:Message={id:'r',role:'toolResult',text:'contents',toolCallId:'one',toolName:'read',isError:false};
test('plugin panels refresh sessionless learning broadcasts instead of displaying another project snapshot',()=>{
 const current={memories:[{id:'sqlite-current-project'}]},foreign={memories:[{id:'other-project'}]};
 assert.equal(pluginEventUpdate('memory','current',{type:'plugin',sessionId:'current',data:{pluginEvent:'memory.changed',data:current}}),current);
 assert.equal(pluginEventUpdate('memory','current',{type:'plugin',data:{pluginEvent:'memory.changed',data:foreign}}),'refresh');
 assert.equal(pluginEventUpdate('memory','current',{type:'plugin',sessionId:'other',data:{pluginEvent:'memory.changed',data:foreign}}),undefined);
 assert.equal(pluginEventUpdate('memory','current',{type:'plugin',data:{pluginEvent:'expert.changed',data:foreign}}),undefined);
 assert.equal(pluginEventUpdate('memory','current',{type:'plugin',data:{plugin:'memory',action:'learning.completed'}}),'refresh');
 assert.equal(pluginEventUpdate('swarm','current',{type:'plugin',data:{pluginEvent:'swarm.changed',data:{graphs:[{id:'foreign'}]}}}),'refresh');
});
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

test('conversation composer keeps attachment, permission, plan, collaboration and send controls in one shell',()=>{const snapshot:ComposerSnapshot={sessionId:'ui',epoch:1,draft:'hello',attachments:[],running:false,sending:false,navigating:false,archived:false,planMode:true,permissionMode:'auto',permissionExplicit:false,mode:'single',plugins:[],models:[],modelId:'fixture',thinkingLevel:'off',thinkingLevels:['off'],ready:true,floating:false,collapsed:false,status:'准备就绪'};const html=renderToStaticMarkup(React.createElement(SessionComposer,{value:snapshot,action:async()=>{}}));for(const label of ['aria-label="添加"','aria-haspopup="menu"','文件和文件夹','设置要持续追求的目标','发送消息','权限策略：安全自动','计划模式','Agent 协作方式'])assert.ok(html.includes(label));});
test('legacy empty plugin preferences still expose all collaboration choices while busy sessions lock every mode',()=>{
 const value:ComposerSnapshot={sessionId:'legacy-ui',epoch:1,draft:'A',attachments:[],running:false,sending:false,navigating:false,archived:false,planMode:false,permissionMode:'auto',permissionExplicit:false,mode:'single',plugins:[],models:[],modelId:'fixture',thinkingLevel:'off',thinkingLevels:['off'],ready:true,floating:false,collapsed:false,status:'准备就绪'};
 const render=(snapshot:ComposerSnapshot)=>renderToStaticMarkup(React.createElement(SessionComposer,{value:snapshot,action:async()=>{}})).match(/<button\b[^>]*data-agent-mode="[^"]+"[^>]*>[\s\S]*?<\/button>/g)||[];
 for(const mode of ['single','team','swarm'] as const){
  const buttons=render({...value,mode});assert.equal(buttons.length,3);
  for(const [index,choice] of ['single','team','swarm'].entries()){const label=['个体','团队','组织'][index];assert.ok(buttons[index].includes(`data-agent-mode="${choice}"`));assert.ok(buttons[index].includes(`aria-label="${label}"`));assert.ok(buttons[index].includes(`title="${label}"`));assert.ok(buttons[index].includes(`<span>${label}</span>`));assert.doesNotMatch(buttons[index],/\bdisabled=/,`${choice} is selectable before Swarm is lazily enabled`);assert.ok(buttons[index].includes(`aria-checked="${choice===mode}"`));assert.ok(buttons[index].includes(`tabindex="${choice===mode?0:-1}"`));}
 }
 for(const busy of ['running','sending','navigating','archived'] as const)for(const button of render({...value,[busy]:true}))assert.match(button,/\bdisabled=""/,busy);
});
test('composer locks its draft during submission but permits queue input during execution',()=>{
 const value:ComposerSnapshot={sessionId:'ui',epoch:1,draft:'A',attachments:[],running:true,sending:true,navigating:false,archived:false,planMode:false,permissionMode:'auto',permissionExplicit:true,mode:'single',plugins:[],models:[],modelId:'fixture',thinkingLevel:'off',thinkingLevels:['off'],ready:true,floating:false,collapsed:false,status:'执行中'};
 for(const sending of [false,true]){
  const html=renderToStaticMarkup(React.createElement(SessionComposer,{value:{...value,sending},action:async()=>{}}));
  const textarea=html.match(/<textarea[^>]*>/)?.[0]||'';
  assert.equal(textarea.includes('disabled'),sending);
 }
});

test('conversation tab has a fixed title while tool and web tabs keep their own titles',()=>{const html=renderToStaticMarkup(React.createElement(SessionTabs,{view:{...initialView(),tabs:[{id:'web',kind:'browser',title:'Example Domain',url:'https://example.com/'}]},onSelect(){},onClose(){},onNew(){}}));assert.match(html,/>会话<\/span>/);assert.match(html,/>Example Domain<\/span>/);});


test('tool tiles and their session tabs use the same distinct accessible vector icons',()=>{
 const page=renderToStaticMarkup(React.createElement(NewTabPage,{onTool(){},onNavigate:async()=>{}}));
 const icons=new Set<string>();
 const visibleTools=Object.entries(toolNames);
 for(const [id,title] of visibleTools){
  const tile=page.match(new RegExp('<button[^>]*>(<svg[\\s\\S]*?</svg>)<span>'+title+'</span>'));
  assert.ok(tile,'tool tile exists: '+title);const svg=tile[1].slice(tile[1].lastIndexOf('<svg'));assert.match(svg,/aria-hidden="true"/);assert.ok(!icons.has(svg),'each tool has its own icon');icons.add(svg);
  const tab=renderToStaticMarkup(React.createElement(SessionTabs,{view:{...initialView(),active:id,tabs:[{id,kind:'tool',page:id as ToolPage}]},onSelect(){},onClose(){},onNew(){}}));
  const paths=[...svg.matchAll(/<path d="([^"]+)"/g)].map(match=>match[1]);for(const path of paths)assert.ok(tab.includes('d="'+path+'"'));
 }
 assert.equal(icons.size,visibleTools.length);assert.match(page,/>Expert<\/span>/);
});
