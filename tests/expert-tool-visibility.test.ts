import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {NewTabPage,SessionTabs} from '../apps/desktop/src/renderer/SessionTabs.js';
import {Workbench} from '../apps/desktop/src/renderer/Workbench.js';
import {ChangeDiffCache} from '../apps/desktop/src/renderer/change-review.js';
import {visibleSessionView} from '../apps/desktop/src/renderer/view-tabs.js';
import {initialView,type ToolPage,type ViewTab} from '../apps/desktop/src/session-view.js';
import type {AppState} from '../apps/desktop/src/renderer/types.js';

const visibleTools:ToolPage[]=['file','diff','terminal','swarm','memory'];
const toolTabs:ViewTab[]=[...visibleTools,'expert' as const].map(page=>({id:`tool-${page}`,kind:'tool',page}));

test('new tab exposes Expert presets alongside other tools and browser entry',()=>{
 const html=renderToStaticMarkup(React.createElement(NewTabPage,{onTool(){},onNavigate:async()=>{}}));
 assert.match(html,/>Expert<\/span>/);
 for(const title of ['文件','Diff','终端','任务','Memory'])assert.ok(html.includes(`<span>${title}</span>`));
 assert.match(html,/aria-label="新标签页网址"/);assert.match(html,/>打开网页 ↗<\/button>/);
});

test('a Task detail link can activate an existing fullscreen Expert tab',()=>{
 const html=renderToStaticMarkup(React.createElement(SessionTabs,{view:{...initialView(),active:'tool-expert',tabs:[...toolTabs,{id:'web',kind:'browser',title:'Docs',url:'https://example.com/'}]},onSelect(){},onClose(){},onNew(){}}));
 assert.match(html,/>Expert<\/span>/);assert.match(html,/关闭标签 Expert/);
 for(const title of ['文件','Diff','终端','任务','Memory','Docs'])assert.ok(html.includes(`<span>${title}</span>`));
 const selected=html.match(/<button role="tab"[^>]*tabindex="0" aria-selected="true"[^>]*>[\s\S]*?<\/button>/)?.[0]||'';
 assert.match(selected,/<span>Expert<\/span>/);
 assert.equal(html.match(/aria-selected="true"/g)?.length,1);
});

test('an Expert tab preserves the selected Memory tool',()=>{
 const html=renderToStaticMarkup(React.createElement(SessionTabs,{view:{...initialView(),active:'tool-memory',tabs:toolTabs},onSelect(){},onClose(){},onNew(){}}));
 const selected=html.match(/<button role="tab"[^>]*tabindex="0" aria-selected="true"[^>]*>[\s\S]*?<\/button>/)?.[0]||'';
 assert.match(selected,/<span>Memory<\/span>/);
 assert.match(html,/>Expert<\/span>/);assert.equal(html.match(/aria-selected="true"/g)?.length,1);
});

function renderWorkbench(page:'expert'|'memory',enabled:boolean){
 const state:AppState={projects:[],sessions:[],models:[],providers:[],current:{sessionId:'visibility',projectId:'project',runId:'run',modelId:'fixture',thinkingLevel:'off',plugins:enabled?['expert','memory']:[],messages:[],isRunning:false,receipts:[{customType:'friend-pi.expert.run',data:{runId:'run',frozen:{experts:[{id:'implementer',title:'Hidden expert',prompt:'Hidden adopted body',version:1}]}}},{customType:'friend-pi.expert.adoption',data:{runId:'run',id:'implementer'}}]}};
 return renderToStaticMarkup(React.createElement(Workbench,{state,page,workspace:{kind:'project',projectId:'project'},workspaceKey:'project',fileCache:new Map(),changeCache:new ChangeDiffCache(),onClearReview(){},onSettings(){},report(){}}));
}

test('Expert workbench exposes its authoritative directory and exact adoption details',()=>{
 assert.match(renderWorkbench('expert',true),/专家库/);assert.match(renderWorkbench('expert',true),/角色合同与执行范围/);assert.match(renderWorkbench('expert',false),/当前会话未启用此能力/);
 const memory=renderWorkbench('memory',true);assert.match(memory,/本轮尚无记忆使用记录/);assert.match(memory,/记忆学习设置/);
});

test('App view projection retains Expert and other fullscreen tabs without mutation',()=>{
 const persisted={...initialView(),active:'tool-expert',tabs:toolTabs};
 const visible=visibleSessionView(persisted);
 assert.equal(visible.active,'tool-expert');assert.equal(visible.tabs.length,visibleTools.length+1);
 assert.equal(persisted.active,'tool-expert');assert.equal(persisted.tabs.length,visibleTools.length+1);
 assert.equal(visibleSessionView({...persisted,active:'tool-memory'}).active,'tool-memory');
 assert.equal(visibleSessionView(visible),visible);
});
