import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { projectTimeline, updateToolRun } from '../apps/desktop/src/renderer/timeline.js';
import { groupToolActivity, activitySummary, type ToolActivity } from '../apps/desktop/src/renderer/tool-activity.js';
import { ToolActivity as ActivityView } from '../apps/desktop/src/renderer/ToolActivity.js';
import type { Message } from '../apps/desktop/src/renderer/types.js';
import { Conversation } from '../apps/desktop/src/renderer/Conversation.js';

const call = (id: string, name = 'read', args: unknown = { path: 'README.md' }) => ({ type: 'toolCall', id, name, arguments: args });
const assistant = (id: string, parts: Message['parts'], timestamp = 1): Message => ({ id, role: 'assistant', text: '', parts, timestamp });
const result = (id: string, isError = false): Message => ({ id: 'result-' + id, role: 'toolResult', text: 'result:' + id, toolCallId: id, isError });
const groups = (messages: Message[]) => groupToolActivity(projectTimeline(messages, null, [], false));
const activity = (items: ToolActivity['items']): ToolActivity => ({ kind: 'activity', id: 'group:first', items });

test('completed run changes remain attached when several native assistant rows become one tool group', () => {
  const messages=[{...assistant('first',[call('one')]),runId:'run'},result('one'),{...assistant('last',[call('two')],2),runId:'run'},result('two')];
  const html=renderToStaticMarkup(React.createElement(Conversation,{messages,live:null,tools:[],running:false,changes:[{v:1,runId:'run',sessionId:'s',projectId:'p',startedAt:'start',finishedAt:'finish',status:'completed',files:[{path:'result.txt',status:'A',binary:false,additions:1,deletions:0}]}]}));
  assert.equal((html.match(/aria-label="本轮改动文件"/g)||[]).length,1);
  assert.match(html,/已改动 result.txt/);
});

test('entering a running conversation after tool start keeps partial output through native handover', () => {
  const input = { command: 'slow check' }, early = [{ type: 'text', text: 'early marker' }];
  const tools = updateToolRun([], { type: 'tool_execution_update', toolCallId: 'late-entry', toolName: 'bash', args: input, partialResult: early });
  const message = assistant('native-call', [call('late-entry', 'bash', input)]);
  const pending = projectTimeline([message], null, tools, true)[0].parts[0];
  assert.equal(pending.kind, 'tool');
  if (pending.kind !== 'tool') throw Error('Expected live tool');
  assert.equal(pending.tool.status, 'running');assert.deepEqual(pending.tool.output, early);
  const ended = updateToolRun(tools, { type: 'tool_execution_end', toolCallId: 'late-entry', toolName: 'bash', result: 'final marker', isError: false });
  assert.equal(ended.length, 1);assert.deepEqual(ended[0].input, input);
  assert.equal(updateToolRun(ended, { type: 'tool_execution_update', toolCallId: 'late-entry', partialResult: 'late frame' }), ended);
  const native = projectTimeline([message, result('late-entry')], null, ended, false)[0].parts[0];
  assert.equal(native.kind === 'tool' && native.tool.status, 'completed');
  assert.equal(native.kind === 'tool' && native.tool.output, 'result:late-entry');
});

test('continuous tools and reasoning span assistant messages; text and users remain boundaries', () => {
  const rows = groups([
    assistant('a', [{ type: 'text', text: 'before' }, { type: 'thinking', thinking: 'why' }, call('one')]), result('one'),
    assistant('b', [call('two', 'bash', { command: 'pwd' }), { type: 'text', text: 'after' }, call('three')], 2), result('three'), result('two'),
    { id: 'user', role: 'user', text: 'next' }, assistant('c', [call('four')], 3), result('four'),
  ]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0].parts.map(part => part.kind), ['text', 'activity', 'text', 'activity']);
  const first = rows[0].parts[1] as ToolActivity;
  assert.deepEqual(first.items.map(item => item.kind === 'tool' ? item.tool.id : item.text), ['why', 'one', 'two']);
  assert.notEqual(first.id, first.items[0].key, 'group and child disclosure are independent');
  assert.equal(rows[1].source.id, 'user');
  assert.equal((rows[2].parts[0] as ToolActivity).items.length, 1);
});

test('stream commit and appended calls retain group/item identities and native results win', () => {
  const live = assistant('stream', [{ type: 'thinking', thinking: 'why' }, call('one')], 123);
  const before = groupToolActivity(projectTimeline([], live, [{ id: 'one', name: 'read', input: {}, status: 'running' }], true))[0].parts[0] as ToolActivity;
  const native = assistant('native', [...live.parts!, call('two')], 123);
  const after = groupToolActivity(projectTimeline([native, result('one')], null, [{ id: 'one', name: 'read', input: {}, status: 'failed' }], true))[0].parts[0] as ToolActivity;
  assert.equal(before.id, after.id);
  assert.equal(before.items[0].key, after.items[0].key);
  assert.equal(after.items[1].kind === 'tool' && after.items[1].tool.status, 'completed');
  const pending = [{ id: 'early', name: 'read', input: { path: 'a' }, status: 'running' }];
  const early = groupToolActivity(projectTimeline([], null, pending, true))[0].parts[0] as ToolActivity;
  const committed = groupToolActivity(projectTimeline([assistant('later', [call('early')]), result('early')], null, pending, true))[0].parts[0] as ToolActivity;
  assert.equal(early.id, committed.id);
  assert.equal(committed.items.length, 1);
});

test('summaries rank categories, bound live details and expose failure/interruption', () => {
  const group = groups([assistant('a', [call('read'), call('command', 'bash', { command: 'pwd' }), call('image', 'read', { path: 'image.png' })]), result('read'), result('command'), result('image', true)])[0].parts[0] as ToolActivity;
  assert.deepEqual(activitySummary(group), { title: '已读取文件，执行了命令，已读取图片', status: 'failed', count: 3 });
  const missing = groups([assistant('a', [call('missing')])])[0].parts[0] as ToolActivity;
  assert.equal(activitySummary(missing).status, 'interrupted');
  const thinking = activity([{ kind: 'thinking', key: 'why', text: 'reasoning' }]);
  assert.equal(activitySummary(thinking).title, '已完成分析');
  assert.equal(activitySummary(thinking, true).title, '正在分析');
  const current = activity([{ kind: 'tool', key: 'running', tool: { id: 'running', name: 'bash', input: { command: 'a'.repeat(300) }, status: 'running' } }]);
  assert.equal(activitySummary(current).status, 'running');
  assert.ok(activitySummary(current).title.length < 180);
});

test('equal assistant timestamps never share thinking or group disclosure state', () => {
  const rows = groups([assistant('one', [{ type: 'thinking', thinking: 'first' }, { type: 'text', text: 'first answer' }], 1), assistant('two', [{ type: 'thinking', thinking: 'second' }, { type: 'text', text: 'second answer' }], 1)]);
  const items = rows[0].parts.filter((part): part is ToolActivity => part.kind === 'activity');
  assert.equal(new Set(items.map(part => part.id)).size, 2);
  assert.notEqual(items[0].items[0].key, items[1].items[0].key);
});

test('Swarm strategy validation and inspection do not claim a teammate was called', () => {
  for (const [action, title] of [['plan.validate', '已校验协作策略'], ['snapshot', '调用了工具'], ['create', '调用了工具'], ['start', '已调用队友']]) {
    const group = activity([{ kind: 'tool', key: action, tool: { id: action, name: 'friend_swarm', input: { action }, status: 'completed' } }]);
    assert.equal(activitySummary(group).title, title);
  }
});

test('tool bodies mount only on item expansion and render image parts without base64 JSON', () => {
  const group = activity([{ kind: 'tool', key: 'image', tool: { id: 'image', name: 'read', input: { path: 'image.png' }, status: 'completed', output: [{ type: 'text', text: 'preview' }, { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }] } }]);
  const render = (expanded: Record<string, boolean>) => renderToStaticMarkup(React.createElement(ActivityView, { group, thinking: false, expanded, onToggle: () => {} }));
  assert.doesNotMatch(render({}), /<img|tool-call-body/);
  assert.doesNotMatch(render({ [group.id]: true }), /<img|tool-call-body/);
  const html = render({ [group.id]: true, image: true });
  assert.match(html, /src="data:image\/png;base64,aGVsbG8="/);
  assert.match(html, /preview/);
  assert.doesNotMatch(html, /&quot;data&quot;/);
  const custom = activity([{ kind: 'tool', key: 'custom', tool: { id: 'custom', name: 'custom_plugin', input: { action: 'inspect' }, status: 'completed', output: { custom: '<script>unsafe</script>' } } }]);
  const fallback = renderToStaticMarkup(React.createElement(ActivityView, { group: custom, thinking: false, expanded: { custom: true }, onToggle: () => {} }));
  assert.match(fallback, /custom_plugin/);
  assert.match(fallback, /&lt;script&gt;/);
});
