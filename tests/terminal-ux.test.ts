import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {TerminalNotice} from '../apps/desktop/src/renderer/TerminalNotice.js';

test('terminal connection warning is a collapsed explanation with retained diagnostics',()=>{
  const html=renderToStaticMarkup(React.createElement(TerminalNotice,{message:'MCP servers need attention: fixture: failed: fetch failed',error:false,onClose(){}}));
  assert.match(html,/扩展服务连接异常/);assert.match(html,/不影响本地终端/);assert.match(html,/fixture: failed: fetch failed/);assert.match(html,/<details>/);assert.doesNotMatch(html,/<details open/);assert.match(html,/aria-label="关闭提示"/);
});
test('terminal operation failures remain expanded alerts',()=>{
  const html=renderToStaticMarkup(React.createElement(TerminalNotice,{message:'终端清理尚未完成，请检查保留记录',error:true,onClose(){}}));
  assert.match(html,/role="alert"/);assert.match(html,/<details open=""/);assert.match(html,/终端清理尚未完成/);
});
test('terminal notices retain untrusted text without interpreting HTML',()=>{
  const html=renderToStaticMarkup(React.createElement(TerminalNotice,{message:'<img src=x onerror=alert(1)>',error:false,onClose(){}}));
  assert.doesNotMatch(html,/<img/);assert.match(html,/&lt;img/);assert.match(html,/role="status"/);
});
