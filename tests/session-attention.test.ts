import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {AttentionRegistry, type AttentionOwner} from '../apps/desktop/src/session-attention.js';
import {ActivityCenter} from '../apps/desktop/src/renderer/ActivityCenter.js';

const a: AttentionOwner = {sessionId: 'session-a', generation: 'worker-a', runId: 'run-a'};
const b: AttentionOwner = {sessionId: 'session-b', generation: 'worker-b', runId: 'run-b'};
const request = {id: 'permission', kind: 'confirm', title: '确认修改文件', message: '修改项目文件？'};
function fixture() {
  let time = 1000;
  const registry = new AttentionRegistry({now: () => time});
  registry.register(a.sessionId, a.generation); registry.register(b.sessionId, b.generation);
  return {registry, advance(ms: number) {time += ms;}};
}

test('pending requests retain all supported fields, whitelist data, redact secrets and return detached snapshots', () => {
  const {registry} = fixture();
  const raw = {...request, kind: 'select', options: ['批准', '拒绝'], prefill: 'draft', placeholder: '填写说明', apiKey: 'provider-private-field', message: 'authorization=Bearer example-private-token; api_key="private-value" sk-example_secret_123456789'};
  assert.equal(registry.captureDialog(a, raw), true);
  raw.options[0] = 'changed upstream';
  const snapshot = registry.snapshot(), dialog = snapshot[0].dialog!;
  assert.equal(dialog.kind, 'select'); assert.deepEqual(dialog.options, ['批准', '拒绝']);
  assert.equal(dialog.prefill, 'draft'); assert.equal(dialog.placeholder, '填写说明');
  assert.doesNotMatch(JSON.stringify(snapshot), /provider-private-field|example-private-token|private-value|sk-example_secret/);
  dialog.options![0] = 'changed renderer'; dialog.title = 'changed renderer';
  assert.equal(registry.getDialog(a, request.id)!.title, request.title);
  assert.deepEqual(registry.getDialog(a, request.id)!.options, ['批准', '拒绝']);
  const notification = registry.takeNotifications()[0];
  assert.equal(notification.sessionId, a.sessionId); assert.doesNotMatch(JSON.stringify(notification), /修改项目文件|授权|private/);
});

test('identical request ids in separate sessions remain separate and only the owning close clears one', () => {
  const {registry} = fixture();
  registry.captureDialog(a, request); registry.captureDialog(b, request);
  assert.equal(registry.snapshot().length, 2);
  assert.equal(registry.closeDialog(a, request.id), true);
  assert.equal(registry.getDialog(a, request.id), undefined);
  assert.equal(registry.getDialog(b, request.id)!.id, request.id);
  assert.deepEqual(registry.takeNotifications().map(item => item.sessionId), [b.sessionId]);
});

test('replacement worker generations reject late capture, close, retirement and run events', () => {
  const {registry} = fixture(), replacement = {...a, generation: 'worker-a-new'};
  registry.captureDialog(a, request); registry.observeState(a, {runId: a.runId, isRunning: true, lifecycleStatus: 'running'});
  assert.equal(registry.register(a.sessionId, replacement.generation), true);
  assert.equal(registry.register(a.sessionId, replacement.generation), false);
  registry.captureDialog(replacement, request);
  assert.equal(registry.captureDialog(a, {...request, id: 'late'}), false);
  assert.equal(registry.closeDialog(a, request.id), false);
  assert.equal(registry.retire(a), false);
  assert.equal(registry.observeState(a, {runId: a.runId, lifecycleStatus: 'failed'}), false);
  assert.equal(registry.snapshot().length, 1);
  assert.equal(registry.snapshot()[0].generation, replacement.generation);
  assert.equal(registry.takeNotifications().length, 1);
});

test('expired requests cannot be read, notified or recreated by duplicate events', () => {
  const {registry, advance} = fixture();
  registry.captureDialog(a, request, 100);
  advance(99); assert.ok(registry.getDialog(a, request.id));
  advance(1); assert.equal(registry.expire(), true);
  assert.equal(registry.getDialog(a, request.id), undefined);
  assert.deepEqual(registry.snapshot(), []); assert.deepEqual(registry.takeNotifications(), []);
  assert.equal(registry.captureDialog(a, request), false);
  assert.equal(registry.captureDialog(a, {...request, id: 'already-expired', expiresAt: 1000}), false);
});

test('successful response cleanup is idempotent and suppresses queued notifications', () => {
  const {registry} = fixture();
  registry.captureDialog(a, request);
  assert.equal(registry.closeDialog(a, request.id), true);
  assert.equal(registry.closeDialog(a, request.id), false);
  assert.deepEqual(registry.snapshot(), []); assert.deepEqual(registry.takeNotifications(), []);
  assert.equal(registry.captureDialog(a, request), false);
  assert.equal(registry.closeDialog(a, 'closed-before-capture'), false);
  assert.equal(registry.captureDialog(a, {...request, id: 'closed-before-capture'}), false);
});

test('stop clears only the stopped session pending requests and running activity without reporting completion', () => {
  const {registry} = fixture();
  registry.observeState(a, {runId: a.runId, isRunning: true});
  registry.captureDialog(a, request); registry.captureDialog(b, request);
  registry.observeState(a, {runId: a.runId, lifecycleStatus: 'stopped', isRunning: false});
  assert.equal(registry.getDialog(a, request.id), undefined); assert.ok(registry.getDialog(b, request.id));
  assert.deepEqual(registry.snapshot().map(item => item.sessionId), [b.sessionId]);
  assert.deepEqual(registry.takeNotifications().map(item => item.sessionId), [b.sessionId]);
  assert.equal(registry.captureDialog(a, request), false);
});

test('retirement removes pending and running activities and rejects all late messages', () => {
  const {registry} = fixture();
  registry.observeState(a, {isRunning: true}); registry.captureDialog(a, request);
  assert.equal(registry.retire(a), true); assert.equal(registry.retire(a), false);
  assert.equal(registry.captureDialog(a, request), false);
  assert.equal(registry.observeState(a, {lifecycleStatus: 'completed'}), false);
  assert.deepEqual(registry.snapshot(), []); assert.deepEqual(registry.takeNotifications(), []);
});

test('only an observed active run produces an unread terminal result, once per run and outcome', () => {
  const {registry} = fixture();
  registry.observeState(a, {runId: a.runId, lifecycleStatus: 'completed'});
  assert.deepEqual(registry.snapshot(), []); assert.deepEqual(registry.takeNotifications(), []);
  registry.observeState(a, {runId: a.runId, lifecycleStatus: 'running', isRunning: true});
  registry.observeState(a, {runId: a.runId, lifecycleStatus: 'completed', isRunning: false});
  assert.equal(registry.snapshot()[0].kind, 'completed'); assert.equal(registry.snapshot()[0].unseen, true);
  assert.equal(registry.takeNotifications().length, 1);
  registry.observeState(a, {runId: a.runId, lifecycleStatus: 'completed', isRunning: false});
  registry.observeState(a, {runId: a.runId, lifecycleStatus: 'running', isRunning: true});
  registry.observeState(a, {runId: a.runId, lifecycleStatus: 'completed', isRunning: false});
  assert.equal(registry.snapshot().length, 1); assert.deepEqual(registry.takeNotifications(), []);
});

test('a viewed foreground session consumes only its own terminal result and does not dismiss approvals', () => {
  const {registry} = fixture();
  for (const owner of [a, b]) {registry.observeState(owner, {isRunning: true}); registry.observeState(owner, {lifecycleStatus: 'failed', isRunning: false});}
  registry.observeState(a, {runId: 'next-run', isRunning: true});
  registry.captureDialog({...a, runId: 'next-run'}, request);
  registry.setView({sessionId: a.sessionId, foreground: true});
  assert.equal(registry.snapshot().filter(item => item.kind === 'failed').length, 1);
  assert.equal(registry.snapshot().find(item => item.kind === 'failed')!.sessionId, b.sessionId);
  assert.ok(registry.getDialog(a, request.id));
  assert.deepEqual(registry.takeNotifications().map(item => item.sessionId), [b.sessionId]);
});

test('current foreground notifications stay quiet, background or hidden-window notifications deliver once', () => {
  const {registry} = fixture();
  registry.setView({sessionId: a.sessionId, foreground: true});
  registry.captureDialog(a, request); registry.captureDialog(b, request);
  assert.deepEqual(registry.takeNotifications().map(item => item.sessionId), [b.sessionId]);
  assert.deepEqual(registry.takeNotifications(), []);
  registry.setView({sessionId: a.sessionId, foreground: false});
  registry.captureDialog(a, {...request, id: 'hidden-request'});
  assert.deepEqual(registry.takeNotifications().map(item => item.sessionId), [a.sessionId]);
  registry.setView({sessionId: a.sessionId, foreground: true});
  registry.observeState(a, {isRunning: true}); registry.observeState(a, {lifecycleStatus: 'completed'});
  assert.equal(registry.snapshot().some(item => item.kind === 'completed'), false);
  assert.deepEqual(registry.takeNotifications(), []);
});

test('mute suppresses queued and future notifications without replay on unmute, keeping pending work visible', () => {
  const {registry} = fixture();
  registry.captureDialog(a, request);
  registry.setView({foreground: false, muted: true});
  registry.captureDialog(b, request);
  registry.setView({foreground: false, muted: false});
  assert.equal(registry.snapshot().length, 2);
  assert.equal(registry.captureDialog(b, request), false); assert.deepEqual(registry.takeNotifications(), []);
});

test('read dismissal cannot approve or hide pending work, and old-run terminal changes cannot finish a newer run', () => {
  const {registry} = fixture();
  registry.captureDialog(a, request); assert.equal(registry.dismiss(registry.snapshot()[0].id), false);
  registry.observeState(a, {runId: 'new', isRunning: true});
  registry.captureDialog({...a, runId: 'new'}, {...request, id: 'current-run'});
  assert.equal(registry.observeState(a, {runId: 'old', lifecycleStatus: 'failed'}), false);
  assert.equal(registry.snapshot().some(item => item.kind === 'failed'), false);
  assert.equal(registry.snapshot().find(item => item.kind === 'running')!.runId, 'new');
  assert.ok(registry.getDialog({...a, runId: 'new'}, 'current-run'));
  assert.equal(registry.captureDialog(a, {...request, id: 'old-run'}), false);
  registry.observeState(a, {runId: 'new', lifecycleStatus: 'failed'});
  const terminal = registry.snapshot().find(item => item.kind === 'failed')!;
  assert.equal(registry.dismiss(terminal.id), true); assert.equal(registry.dismiss(terminal.id), false);
  assert.ok(registry.getDialog(a, request.id));
  assert.deepEqual(registry.takeNotifications().map(item => item.kind), ['dialog']);
});

test('viewing a pending dialog consumes its queued notification even if navigation changes again before delivery', () => {
  const {registry} = fixture(); registry.captureDialog(a, request);
  registry.setView({sessionId: a.sessionId, foreground: true});
  assert.equal(registry.snapshot()[0].unseen, false);
  registry.setView({sessionId: b.sessionId, foreground: true});
  assert.deepEqual(registry.takeNotifications(), []);
  assert.ok(registry.getDialog(a, request.id));
});

test('malformed requests and unknown worker identities cannot enter the public snapshot', () => {
  const {registry} = fixture();
  for (const raw of [null, {}, {...request, id: ''}, {...request, kind: 'password'}, {...request, title: null}]) assert.equal(registry.captureDialog(a, raw), false);
  assert.equal(registry.captureDialog({...a, sessionId: 'unknown'}, request), false);
  assert.deepEqual(registry.snapshot(), []);
  assert.throws(() => registry.register('', 'generation'), /身份/);
  assert.throws(() => registry.register('s', Number.NaN), /身份/);
});

test('an initial history snapshot does not clear a live pending dialog captured for another run', () => {
  const {registry} = fixture();
  registry.captureDialog(a, request);
  registry.observeState({...a, runId: 'restored-history'}, {runId: 'restored-history', lifecycleStatus: 'completed'});
  assert.ok(registry.getDialog(a, request.id));
  assert.equal(registry.snapshot()[0].runId, a.runId);
});

test('activity center shows cross-project attention, running and unread results with navigation-only actions', () => {
  const {registry} = fixture();
  registry.captureDialog(a, request); registry.observeState(b, {isRunning: true}); registry.observeState(b, {lifecycleStatus: 'failed'});
  const html = renderToStaticMarkup(React.createElement(ActivityCenter, {activities: registry.snapshot(), sessions: [
    {id: a.sessionId, name: '材料分析', projectId: 'p1', projectName: '研究项目', status: 'running'},
    {id: b.sessionId, name: '服务检查', projectId: 'p2', projectName: '开发项目', status: 'failed'},
    {id: 'session-c', name: '另外的工作', status: 'running'},
  ], onOpen() {}, onDismiss() {}}));
  for (const label of ['需要你处理', '未读结果', '正在执行', '研究项目', '开发项目', '另外的工作', '前往处理', '已读']) assert.ok(html.includes(label), label);
  assert.match(html, /aria-label="打开 材料分析 处理请求"/);
  assert.doesNotMatch(html, /允许此操作|确认修改文件.*确认修改文件|修改项目文件？/);
  assert.equal(html.match(/打开执行中的 材料分析/g), null);
});

test('activity center omits deleted sessions and disables actions during a navigation request', () => {
  const {registry} = fixture(); registry.captureDialog(a, request);
  const html = renderToStaticMarkup(React.createElement(ActivityCenter, {activities: registry.snapshot(), sessions: [{id: a.sessionId, name: '材料分析'}], pending: true, onOpen() {}, onDismiss() {}}));
  assert.match(html, /<button disabled=""/);
  const empty = renderToStaticMarkup(React.createElement(ActivityCenter, {activities: registry.snapshot(), sessions: [], onOpen() {}, onDismiss() {}}));
  assert.match(empty, /当前没有待处理任务/); assert.doesNotMatch(empty, /前往处理/);
});
