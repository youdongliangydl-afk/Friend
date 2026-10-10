import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import {ProjectSidebar,reorderIds,sidebarSessions,type ProjectSidebarProps} from '../apps/desktop/src/renderer/ProjectSidebar.js';

const projects=[{id:'b',name:'设计项目',path:'/design'},{id:'a',name:'开发项目',path:'/code'},{id:'empty',name:'空项目',path:'/empty'}];
const sessions=[
  {id:'old',projectId:'a',name:'旧聊天',path:'/old.jsonl',updatedAt:'2026-10-09T00:00:00Z',status:'completed'},
  {id:'temporary',projectId:'',name:'临时分析',path:'/temporary.jsonl',updatedAt:'2026-10-10T00:00:00Z'},
  {id:'recent',projectId:'a',name:'新聊天',path:'/recent.jsonl',updatedAt:'2026-10-10T00:00:00Z',status:'running'},
  {id:'design',projectId:'b',name:'界面草稿',path:'/design.jsonl',updatedAt:'2026-10-10T00:00:00Z'},
  {id:'archived',projectId:'a',name:'归档聊天',path:'/archive.jsonl',updatedAt:'2026-10-11T00:00:00Z',archived:true},
];
function render(overrides:Partial<ProjectSidebarProps>={}) {
  return renderToStaticMarkup(React.createElement(ProjectSidebar,{projects,sessions,onProject(){},onSession(){},onMenu(){},onOpenProject(){},onReorder(){},...overrides}));
}

test('sidebar keeps project order, groups every project, and sorts nested chats by recency',()=>{
  const html=render({selectedProject:'a',selectedSession:'recent'});
  assert.ok(html.indexOf('aria-label="临时会话"')<html.indexOf('aria-label="设计项目"'));
  assert.ok(html.indexOf('aria-label="设计项目"')<html.indexOf('aria-label="开发项目"'));
  assert.ok(html.indexOf('aria-label="开发项目"')<html.indexOf('aria-label="空项目"'));
  assert.ok(html.indexOf('title="新聊天"')<html.indexOf('title="旧聊天"'));
  assert.match(html,/<section[^>]*aria-label="空项目"[\s\S]*?暂无聊天/);
  assert.match(html,/aria-current="page"[^>]*><span>新聊天/);
  assert.match(html,/role="img" aria-label="正在执行"/);
  assert.doesNotMatch(html,/归档聊天|session-card|session-lifecycle/);
});

test('global search matches project names or chat names and archive filtering applies to every group',()=>{
  const searched=render({query:'新聊天'});
  assert.match(searched,/title="新聊天"/);assert.doesNotMatch(searched,/title="旧聊天"|title="界面草稿"/);
  assert.match(searched,/aria-label="空项目"/);assert.match(searched,/没有匹配的聊天/);
  const project=render({query:'开发项目'});
  assert.match(project,/title="新聊天"/);assert.match(project,/title="旧聊天"/);assert.doesNotMatch(project,/title="界面草稿"/);
  const archive=render({archived:true});assert.match(archive,/title="归档聊天"/);assert.doesNotMatch(archive,/title="新聊天"|title="临时分析"/);
});

test('disabled navigation also disables project menus, chat menus and opening a project',()=>{
  const html=render({disabled:true});
  const buttons=html.match(/<button\b[^>]*>/g)||[];assert.ok(buttons.length>10);assert.ok(buttons.every(button=>button.includes('disabled=""')));
  assert.match(html,/aria-label="聊天 新聊天 的更多操作" aria-haspopup="menu"/);
  assert.match(html,/aria-label="项目 开发项目 的更多操作" aria-haspopup="menu"/);
});

test('project reorder moves one known project without mutating input or including temporary chats',()=>{
  const ids=['b','a','empty'];
  assert.deepEqual(reorderIds(ids,'a','b'),['a','b','empty']);
  assert.deepEqual(reorderIds(ids,'b','a',true),['a','b','empty']);
  assert.deepEqual(reorderIds(ids,'empty','b'),['empty','b','a']);
  assert.deepEqual(ids,['b','a','empty']);
  for(const [source,target] of [['a','a'],['','a'],['a','missing']])assert.equal(reorderIds(ids,source,target),ids);
});

function interactive(overrides:Partial<ProjectSidebarProps>={}) {
  let cursor=0;const slots:any[]=[],calls:{type:string;value:unknown}[]=[];
  const hooks={useState(initial:unknown){const index=cursor++;if(!(index in slots))slots[index]=initial;return [slots[index],(value:any)=>{slots[index]=typeof value==='function'?value(slots[index]):value;}];},useRef(initial:unknown){const index=cursor++;if(!(index in slots))slots[index]={current:initial};return slots[index];},useEffect(){}};
  const jsx=(type:unknown,props:any)=>({type,props}),context:any={module:{exports:{}},require(name:string){if(name==='react')return hooks;if(name==='react/jsx-runtime')return {jsx,jsxs:jsx};if(name==='./Icons.js')return {Icon(){}};throw Error(name);}};
  const source=readFileSync('apps/desktop/src/renderer/ProjectSidebar.tsx','utf8');
  vm.runInNewContext(transformSync(source,{loader:'tsx',format:'cjs',jsx:'automatic',target:'node24'}).code,context);
  const props:ProjectSidebarProps={projects,sessions,onProject:id=>calls.push({type:'project',value:id}),onSession:id=>calls.push({type:'session',value:id}),onMenu:(session,position)=>calls.push({type:'menu',value:{id:session.id,position:{...position}}}),onOpenProject:()=>calls.push({type:'open',value:true}),onReorder:ids=>{calls.push({type:'reorder',value:Array.from(ids)});},...overrides};
  const render=()=>{cursor=0;return context.module.exports.ProjectSidebar(props);};
  const nodes=(root:any):any[]=>!root?[]:Array.isArray(root)?root.flatMap(nodes):typeof root==='object'?[root,...nodes(root.props?.children)]:[];
  const find=(match:(props:any)=>boolean)=>{const node=nodes(render()).find(node=>node.type==='button'&&match(node.props));assert.ok(node,'requested control exists');return node.props;};
  return {calls,find,nodes,render};
}

test('project keyboard reorder and chat actions call their own controller without selecting another target',()=>{
  const f=interactive();let prevented=false;
  f.find(props=>props.title==='/code').onKeyDown({key:'ArrowUp',altKey:true,shiftKey:true,preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.deepEqual(f.calls,[{type:'reorder',value:['a','b','empty']}]);
  const chats=interactive();chats.find(props=>props.title==='新聊天').onClick();
  chats.find(props=>props['aria-label']==='聊天 新聊天 的更多操作').onClick({currentTarget:{getBoundingClientRect:()=>({right:222,bottom:110})}});
  assert.deepEqual(chats.calls,[{type:'session',value:'recent'},{type:'menu',value:{id:'recent',position:{x:222,y:110}}}]);
  const locked=interactive({disabled:true});locked.find(props=>props.title==='/code').onKeyDown({key:'ArrowUp',altKey:true,shiftKey:true,preventDefault(){}});assert.equal(locked.calls.length,0);
  const menu=interactive();let focused=false;
  menu.find(props=>props['aria-label']==='项目 设计项目 的更多操作').onClick({currentTarget:{focus(){focused=true;}}});
  menu.find(props=>props.role==='menuitem'&&props.children==='下移项目').onClick();
  assert.equal(focused,true);assert.deepEqual(menu.calls,[{type:'reorder',value:['a','b','empty']}]);
});

test('only a project header drag can reorder projects and keeps chat actions separate',()=>{
  const f=interactive(),drag=f.find(props=>props.title==='/design');
  assert.equal(drag.draggable,true);assert.equal(f.find(props=>props.title==='临时会话').draggable,false);assert.equal(f.find(props=>props.title==='新聊天').draggable,undefined);
  const transfer={effectAllowed:'',dropEffect:'',setData(){}};
  drag.onDragStart({dataTransfer:transfer});
  const group=f.nodes(f.render()).find(node=>node.type==='section'&&node.props['aria-label']==='空项目');
  const heading=group.props.children[0];let prevented=false;
  heading.props.onDrop({dataTransfer:transfer,clientY:140,currentTarget:{getBoundingClientRect:()=>({top:100,height:30})},preventDefault(){prevented=true;}});
  assert.equal(prevented,true);assert.equal(transfer.effectAllowed,'move');assert.deepEqual(f.calls,[{type:'reorder',value:['a','empty','b']}]);
});

test('sidebar attention shows approval before running and unread results without mutating sessions',()=>{
 const original=sessions.map(session=>({...session})),projected=sidebarSessions(original,[{sessionId:'recent',kind:'dialog',unseen:false},{sessionId:'old',kind:'completed',unseen:true},{sessionId:'design',kind:'failed',unseen:true},{sessionId:'deleted',kind:'dialog',unseen:false}]);
 assert.equal(projected.find(session=>session.id==='recent')?.status,'awaiting_user');assert.equal(projected.find(session=>session.id==='old')?.status,'unread_completed');assert.equal(projected.find(session=>session.id==='design')?.status,'unread_failed');assert.equal(original.find(session=>session.id==='recent')?.status,'running');
 for(const status of ['running','awaiting_review','rebuilding','stopping']){
  const active=[{...original.find(session=>session.id==='recent')!,status}];
  for(const kind of ['completed','failed'] as const)assert.equal(sidebarSessions(active,[{sessionId:'recent',kind,unseen:true}])[0].status,status);
 }
});
