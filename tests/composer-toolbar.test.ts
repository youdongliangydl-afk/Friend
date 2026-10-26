import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const composer=readFileSync('apps/desktop/src/renderer/SessionComposer.tsx','utf8');
const addMenu=readFileSync('apps/desktop/src/renderer/ComposerAddMenu.tsx','utf8');

test('the add menu carries files, goal and planning so the toolbar keeps only the essentials',()=>{
  assert.match(addMenu,/<strong>文件和文件夹<\/strong>/);
  assert.match(addMenu,/<strong>目标<\/strong>/);
  assert.match(addMenu,/<strong>先规划<\/strong>/);
  assert.match(addMenu,/onClick=\{\(\)=>choose\(onPlan\)\}/);
  assert.match(addMenu,/onPlan\(\):void/);
});
test('the composer toolbar no longer renders separate goal and plan buttons',()=>{
  assert.doesNotMatch(composer,/aria-label="目标输入模式"/,'the goal entry point moved into the add menu');
  assert.doesNotMatch(composer,/className=\{'plan-control '\+\(value\.planMode\?'active':''\)\}/,'the plan switch moved into the add menu');
  assert.match(composer,/className="plan-control active"[^>]*aria-checked=\{true\}/,'plan mode still shows an active marker that can be switched off');
  assert.match(composer,/onClick=\{\(\)=>void dispatch\(\{type:'plan',value:false\}\)\}/);
});
test('the composer shows no hint line under the input box',()=>{
  assert.doesNotMatch(composer,/composer-hint/);
  assert.doesNotMatch(readFileSync('apps/desktop/src/renderer/style.css','utf8'),/composer-hint/);
  assert.doesNotMatch(readFileSync('apps/desktop/src/renderer/readability.css','utf8'),/composer-hint/);
});
test('the right-side composer buttons collapse into one state-dependent action',()=>{
  assert.match(composer,/aria-label="停止当前任务"/);
  assert.match(composer,/aria-label=\{value\.running\?'发送并排队':'发送消息'\}/);
  assert.doesNotMatch(composer,/aria-label="排队消息"/);
  assert.doesNotMatch(composer,/aria-label="追加到当前回合"/);
  assert.doesNotMatch(composer,/aria-label="插入纠偏"/);
});
test('the unselected collaboration modes stay icon-only while the selected one shows its label',()=>{
  const css=readFileSync('apps/desktop/src/renderer/layout.css','utf8');
  assert.match(css,/\.agent-mode-control button\{[^}]*width:26px/);
  assert.match(css,/\.agent-mode-control button\.selected\{width:62px/);
  assert.match(css,/\.agent-mode-thumb\{[^}]*width:62px/);
  assert.match(css,/\.friend-layout \.stop-button\.stop-circle\{[^}]*border-radius:50%/);
});
test('the permission button drops its chevron and the visible default label',()=>{
  const permissions=readFileSync('apps/desktop/src/renderer/composer-permissions.tsx','utf8');
  assert.doesNotMatch(permissions,/control-chevron/);
  assert.doesNotMatch(composer,/permission-hint/);
  const css=readFileSync('apps/desktop/src/renderer/layout.css','utf8');
  assert.doesNotMatch(css,/permission-hint/);
  assert.doesNotMatch(css,/control-chevron/);
});
test('the readme documents the new composer layout and the adjustable reading column',()=>{
  const readme=readFileSync('README.md','utf8');
  assert.match(readme,/对话正文列默认 780 像素宽/);
  assert.match(readme,/「\+」菜单里放\*\*文件和文件夹\*\*、\*\*目标\*\*、\*\*先规划\*\*/);
});
