import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {permissionOptions} from '../apps/desktop/src/renderer/composer-permissions.js';
import {SessionComposer,permissionRail,type ComposerSnapshot} from '../apps/desktop/src/renderer/SessionComposer.js';

const base:ComposerSnapshot={sessionId:'permission',epoch:1,draft:'检查权限',attachments:[],running:false,sending:false,navigating:false,archived:false,planMode:false,permissionMode:'auto',permissionExplicit:true,mode:'single',plugins:[],models:[],modelId:'fixture',thinkingLevel:'off',thinkingLevels:['off'],ready:true,floating:false,collapsed:false,status:'准备就绪'};
const html=(value:Partial<ComposerSnapshot>)=>renderToStaticMarkup(React.createElement(SessionComposer,{value:{...base,...value},action:async()=>{}}));

test('the pure permission rail reports the mode, inherited state, danger flag and lock reason',()=>{
 const base={permissionMode:'auto' as const,permissionExplicit:true,running:false,sending:false,navigating:false,archived:false};
 assert.deepEqual(permissionRail(base),{mode:'auto',explicit:true,danger:false,lockedReason:undefined,inherited:false});
 assert.equal(permissionRail({...base,permissionMode:'allPermissions'}).danger,true);
 assert.equal(permissionRail({...base,permissionExplicit:false}).inherited,true);
 assert.equal(permissionRail({...base,permissionExplicit:true}).inherited,false);
 assert.equal(permissionRail({...base,running:true}).lockedReason,'执行中不能切换权限策略');
 assert.equal(permissionRail({...base,sending:true}).lockedReason,'消息提交中，暂不能切换权限策略');
 assert.equal(permissionRail({...base,navigating:true}).lockedReason,'正在切换会话，暂不能切换权限策略');
 assert.equal(permissionRail({...base,archived:true,running:true,sending:true}).lockedReason,'归档会话只读，不能切换权限策略');
});

test('the permission rail reuses the three existing modes and keeps the dangerous one distinguishable',()=>{
 assert.deepEqual(permissionOptions.map(option=>option.id),['ask','auto','allPermissions']);
 assert.deepEqual(permissionOptions.map(option=>option.name),['每次询问','安全自动','所有权限']);
 for(const option of permissionOptions)assert.ok(option.description.length>6,option.id);
});
test('the composer always renders the effective permission mode and marks the dangerous one',()=>{
 for(const [mode,label] of [['ask','每次询问'],['auto','安全自动'],['allPermissions','所有权限']] as const){
  const markup=html({permissionMode:mode});
  assert.ok(markup.includes('aria-label="权限策略：'+label+'"'),mode);
  assert.match(markup,/<button[^>]*class="permission-control[^"]*"[^>]*aria-label="权限策略：/);
 }
 assert.match(html({permissionMode:'allPermissions'}),/class="permission-control all-permissions"/);
 assert.doesNotMatch(html({permissionMode:'auto'}),/all-permissions/);
});
test('the permission button keeps only the shield and the mode, and the inherited default moves into its tooltip',()=>{
 const inherited=html({permissionMode:'auto',permissionExplicit:false});
 assert.doesNotMatch(inherited,/permission-hint/);
 assert.doesNotMatch(inherited,/control-chevron/);
 assert.ok(inherited.includes('title="权限策略：安全自动（沿用新会话默认权限策略）"'),'the inherited default stays available as a tooltip');
 const explicit=html({permissionMode:'auto',permissionExplicit:true});
 assert.doesNotMatch(explicit,/permission-hint/);
 assert.doesNotMatch(explicit,/control-chevron/);
 assert.ok(explicit.includes('title="权限策略：安全自动"'));
});
test('the rail stays mounted for every lifecycle state and explains why it is locked',()=>{
 for(const [patch,reason] of [
  [{running:true},'执行中不能切换权限策略'],
  [{sending:true},'消息提交中，暂不能切换权限策略'],
  [{navigating:true},'正在切换会话，暂不能切换权限策略'],
  [{archived:true},'归档会话只读，不能切换权限策略'],
 ] as [Partial<ComposerSnapshot>,string][]){
  const markup=html(patch);
  assert.ok(markup.includes('aria-label="权限策略：安全自动"'),reason);
  assert.match(markup,/class="permission-control[^"]*"[^>]*disabled=""/,reason);
  assert.ok(markup.includes('title="'+reason+'"'),reason);
 }
 const idle=html({});
 assert.doesNotMatch(idle,/class="permission-slot"[^>]*title=/);
 assert.doesNotMatch(idle,/class="permission-control[^"]*"[^>]*disabled=""/);
});
test('permission changes still travel through the composer permission action',()=>{
 const source=readFileSync('apps/desktop/src/renderer/SessionComposer.tsx','utf8');
 assert.ok(source.includes("disabled={busy} inherited={permission.inherited} onChange={async mode=>{await dispatch({type:'permission',value:mode});}}"));
 assert.ok(source.includes("mode={value.permissionMode}"));
});
