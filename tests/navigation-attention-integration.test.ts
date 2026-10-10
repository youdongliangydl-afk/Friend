import * as sessionNavigation from '../apps/desktop/src/session-navigation.js';
import * as sessionOrder from '../apps/desktop/src/session-order.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {RecordStore, object, text, digest, projectIdentity, isSessionDeleted, parsePermissionMode} from '../packages/core/src/index.js';
import * as modelReadiness from '../apps/desktop/src/model-readiness.js';
import * as workspaceRefs from '../apps/desktop/src/workspaces.js';
import * as fileEditor from '../apps/desktop/src/file-editor.js';
import * as htmlPreview from '../apps/desktop/src/html-preview.js';
import * as workspace from '../apps/desktop/src/workspace-files.js';
import * as runChanges from '../apps/desktop/src/run-changes.js';
import * as sessionView from '../apps/desktop/src/session-view.js';
import * as attachmentInput from '../apps/desktop/src/attachment-input.js';
import * as materialReferences from '../apps/desktop/src/material-references.js';
import * as documentReader from '../apps/desktop/src/document-reader.js';
import {AttentionRegistry} from '../apps/desktop/src/session-attention.js';

// Reuse the existing production-main harness without exporting or changing another test's owned scope.
const lifecycle = fs.readFileSync(path.resolve('tests/desktop-lifecycle.test.ts'), 'utf8');
const begin = lifecycle.indexOf('const root=path.resolve'), end = lifecycle.indexOf('\nfunction ownedGraph');
assert.ok(begin >= 0 && end > begin, 'desktop lifecycle fixture boundaries changed');
let harness = lifecycle.slice(begin, end);
harness = harness.replace('function fixture(){', `function fixture(){
  const notifications:any[]=[];
  class FixtureNotification extends EventEmitter {static isSupported(){return true;} constructor(public options:any){super();} show(){notifications.push(this);}}
`);
harness = harness.replace('BrowserWindow:class{},ipcMain:', 'BrowserWindow:class{},Notification:FixtureNotification,ipcMain:');
harness = harness.replace('throw new Error(`Unrecognized production dependency: ${specifier}`);', `
      if(specifier==='./session-attention.js')return {AttentionRegistry:class extends AttentionRegistry {constructor(){super({now:()=>now});}}};
      if(specifier==='./attachment-input.js')return attachmentInput;
      if(specifier==='./material-references.js')return materialReferences;
      if(specifier==='./document-reader.js')return documentReader;
      if(specifier.startsWith('node:'))return nodeRequire(specifier);
      throw new Error('Unrecognized production dependency: '+specifier);`);
harness = harness.replace('setBrowserHost:value=>{browserHost=value;},startWorker', 'setWindow:value=>{window=value;},state,attention,publishState,selectCurrent,setBrowserHost:value=>{browserHost=value;},startWorker');
harness = harness.replace('return {directory,project,dataDir,modelRuntime,api,children,', 'return {notifications,directory,project,dataDir,modelRuntime,api,children,');
const scope: Record<string, unknown> = {console, Buffer, URL, queueMicrotask, assert, fs, path, tmpdir, EventEmitter, randomUUID, fileURLToPath, vm, transformSync, SessionManager,
  RecordStore, object, text, digest, projectIdentity, isSessionDeleted, parsePermissionMode, modelReadiness, workspaceRefs, fileEditor, htmlPreview, workspace, runChanges, sessionView, sessionNavigation, sessionOrder,
  attachmentInput, materialReferences, documentReader, AttentionRegistry, nodeRequire: createRequire(import.meta.url)};
vm.runInNewContext(transformSync(harness + '\nglobalThis.navigationFixture=fixture;', {loader: 'ts', format: 'cjs', target: 'node24'}).code, scope);
const fixture = scope.navigationFixture as () => any;

function emitState(child: any, patch: Record<string, unknown>) {
  child.state = {...child.state, ...patch};
  child.emit('message', {type: 'event', event: {type: 'state', sessionId: child.state.sessionId, runId: child.state.runId, data: child.state}});
}
function emitDialog(child: any, id = 'request', runId = 'active-run', expiresAt = 10_000) {
  child.emit('message', {type: 'event', event: {type: 'dialog', sessionId: child.state.sessionId, runId,
    data: {id, kind: 'confirm', title: '确认项目操作', message: '检查后允许本次操作？', expiresAt}}});
}
function finishStarting(f: any, child: any, record: any) {
  const native = record.path ? {id: record.piSessionId, file: record.path} : f.history('new session native source');
  child.state = {sessionId: native.id, sessionFile: native.file, isRunning: false, lifecycleStatus: 'idle', plugins: [], thinkingLevels: ['off']};
  child.emit('message', {type: 'ready', state: child.state, models: [], providers: []});
}
function windowFixture(f: any) {
  const events: any[] = [];
  const window = {isDestroyed: () => false, isVisible: () => true, isFocused: () => false, show() {}, focus() {}, webContents: {send(_channel: string, event: unknown) {events.push(event);}}};
  f.api.setWindow(window); return {events, window};
}
test('a selected project provides file references before creating its first session',async()=>{
  const f=fixture();try{fs.writeFileSync(path.join(f.project,'pending-material.csv'),'name,value\na,1\n');await f.api.handle('project.select',{projectId:'fixture'});
    const result=await f.api.handle('reference.list',{sessionId:'',type:'@',query:'pending-material'});assert.equal(result.items.length,1);assert.equal(result.items[0].path,fs.realpathSync(path.join(f.project,'pending-material.csv')));assert.equal(f.api.workers.size,0);
  }finally{f.cleanup();}
});

test('late session.open readiness cannot replace a later selected ready session', async () => {
  const f = fixture();
  try {
    const a = f.record('late-open-a'), b = f.record('ready-b'); await f.ready(b);
    const opening = f.api.handle('session.open', {id: a.id}); await f.flush();
    const childA = f.children.at(-1);
    await f.api.handle('session.open', {id: b.id});
    finishStarting(f, childA, a); await opening;
    assert.equal(f.api.state().current.sessionId, b.id);
    assert.equal(f.api.workers.has(a.id), true, 'old startup may finish without selecting its session');
  } finally {f.cleanup();}
});
test('archive auto-selection cannot replace a later explicitly opened session',async()=>{
  const f=fixture();try{const a=f.record('archive-a'),b=f.record('selected-b');await f.ready(a);await f.ready(b);
    const c=f.record('slow-c');c.updatedAt='2099-01-01T00:00:00Z';f.api.store.put('session:'+c.id,c);await f.api.handle('session.open',{id:a.id});
    const archiving=f.api.handle('session.archive',{id:a.id,archived:true});await f.flush();const childC=f.children.at(-1);assert.equal(childC.options.env.FRIEND_PI_DESKTOP_SESSION_ID,c.id);
    await f.api.handle('session.open',{id:b.id});finishStarting(f,childC,c);await archiving;assert.equal(f.api.state().current.sessionId,b.id);assert.equal(f.api.store.get('session:'+a.id).value.archived,true);
  }finally{f.cleanup();}
});

test('session.new returns its fixed created identity when another selection wins before worker readiness', async () => {
  const f = fixture();
  try {
    const b = f.record('ready-b'); await f.ready(b);
    const creating = f.api.handle('session.new', {projectId: 'fixture'}); await f.flush();
    const a = f.api.store.list('session:').map((row: any) => row.value).find((record: any) => record.id !== b.id), childA = f.children.at(-1);
    assert.ok(a); await f.api.handle('session.open', {id: b.id});
    finishStarting(f, childA, a); const result = await creating;
    assert.equal(result.createdSessionId, a.id);
    assert.equal(result.current.sessionId, b.id);
    assert.equal(f.api.state().current.sessionId, b.id);
  } finally {f.cleanup();}
});

test('native dialog ids map to their desktop owner, survive the first idle state and reappear after returning from another project', async () => {
  const f = fixture();
  try {
    const a = f.record('desktop-a'), b = f.record('desktop-b'), childA = await f.ready(a), childB = await f.ready(b);
    const projectB = path.join(f.directory, 'other-project'); fs.mkdirSync(projectB);
    f.api.store.put('project:other', {id: 'other', path: projectB, name: 'Other'});
    const storedB = f.api.store.get('session:' + b.id).value; storedB.projectId = 'other'; f.api.store.put('session:' + b.id, storedB);
    await f.api.handle('session.open', {id: a.id});
    emitDialog(childA);
    emitState(childA, {runId: 'restored-history', lifecycleStatus: 'completed', isRunning: false});
    assert.equal(f.api.state().activities.find((activity: any) => activity.kind === 'dialog').sessionId, a.id);
    assert.notEqual(a.id, a.piSessionId);
    await f.api.handle('session.open', {id: b.id});
    assert.equal(f.api.state().current.dialogs.length, 0);
    assert.ok(f.api.state().activities.some((activity: any) => activity.sessionId === a.id && activity.kind === 'dialog'));
    await f.api.handle('session.open', {id: a.id});
    const current = f.api.state().current;
    assert.equal(current.dialogs[0].id, 'request'); assert.equal(current.dialogs[0].expiresAt, 10_000);
    await f.api.handle('dialog.respond', {id: 'request', confirmed: true});
    assert.equal(childA.commands.filter((command: any) => command.method === 'dialog.respond').length, 1);
    assert.equal(childB.commands.some((command: any) => command.method === 'dialog.respond'), false);
    assert.equal(f.api.state().activities.some((activity: any) => activity.kind === 'dialog'), false);
  } finally {f.cleanup();}
});

test('a late close from a retired SDK cannot clear the replacement worker pending dialog', async () => {
  const f = fixture();
  try {
    const a = f.record('generation-a'), oldChild = await f.ready(a);
    emitDialog(oldChild, 'same-dialog-id');
    const oldWorker = f.api.workers.get(a.id); f.api.retireWorker(oldWorker, Error('explicit reload'));
    const child = await f.ready(a); emitDialog(child, 'same-dialog-id');
    assert.notEqual(oldWorker.generation, f.api.workers.get(a.id).generation);
    oldChild.emit('message', {type: 'event', event: {type: 'dialog.closed', data: {id: 'same-dialog-id'}}});
    assert.equal(f.api.state().activities.filter((activity: any) => activity.kind === 'dialog').length, 1);
    await f.api.handle('dialog.respond', {id: 'same-dialog-id', confirmed: true});
    assert.equal(oldChild.commands.some((command: any) => command.method === 'dialog.respond'), false);
    assert.equal(child.commands.filter((command: any) => command.method === 'dialog.respond').length, 1);
  } finally {f.cleanup();}
});

test('expired approval snapshots cannot dispatch a late permission response', async () => {
  const f = fixture();
  try {
    const a = f.record('expires-a'), child = await f.ready(a); emitDialog(child, 'expires', 'run', 1000);
    await f.tick(1000);
    assert.equal(f.api.state().activities.some((activity: any) => activity.kind === 'dialog'), false);
    await assert.rejects(f.api.handle('dialog.respond', {id: 'expires', confirmed: true}), /过期|失效/);
    assert.equal(child.commands.some((command: any) => command.method === 'dialog.respond'), false);
  } finally {f.cleanup();}
});

test('failed response admission keeps the still-live pending request available for reconciliation', async () => {
  const f = fixture();
  try {
    const a = f.record('response-a'), child = await f.ready(a); emitDialog(child);
    const send = child.send;
    child.send = (message: any, callback?: Function) => {
      if (message.method !== 'dialog.respond') return send(message, callback);
      child.commands.push(message); callback?.(); queueMicrotask(() => child.emit('message', {type: 'response', id: message.id, error: 'fixture admission failed'})); return true;
    };
    await assert.rejects(f.api.handle('dialog.respond', {id: 'request', confirmed: true}), /fixture admission failed/);
    assert.equal(f.api.state().activities.some((activity: any) => activity.kind === 'dialog'), true);
  } finally {f.cleanup();}
});

test('notification clicks request renderer navigation instead of changing a host selection during submission', async () => {
  const f = fixture();
  try {
    const {events} = windowFixture(f), a = f.record('notify-a'), b = f.record('notify-b'), childA = await f.ready(a); await f.ready(b);
    await f.api.handle('session.open', {id: b.id}); emitDialog(childA);
    assert.equal(f.notifications.length, 1); f.notifications[0].emit('click'); await f.flush();
    assert.equal(f.api.state().current.sessionId, b.id);
    const navigation = events.find(event => event.type === 'navigation.request');
    assert.ok(navigation); assert.equal(navigation.data.sessionId || navigation.data.id, a.id);
  } finally {f.cleanup();}
});

test('pure attachment first send names the session without rejecting an already accepted dispatch', async () => {
  const f = fixture();
  try {
    modelReadiness.registerSavedModel(f.dataDir, 'main-fixture/unit'); await modelReadiness.testConfiguredModel(f.modelRuntime, f.dataDir, 'main-fixture/unit');
    const a = {...f.record('attachment-a'), name: '新会话'}; f.api.store.put('session:' + a.id, a);
    const child = await f.ready(a); child.state.modelId = 'main-fixture/unit';
    const attachment = path.join(f.project, '报告.txt'); fs.writeFileSync(attachment, '原始附件内容');
    await f.api.handle('session.send', {sessionId: a.id, text: '', attachments: [{path: attachment, name: '报告.txt'}]});
    const sends = child.commands.filter((command: any) => command.method === 'send');
    assert.equal(sends.length, 1); assert.equal(sends[0].input.text, '');
    assert.equal(f.api.store.get('session:' + a.id).value.name, '报告.txt');
  } finally {f.cleanup();}
});

test('an unexpected background SDK exit leaves one unread interrupted result instead of silently dropping execution', async () => {
  const f = fixture();
  try {
    windowFixture(f); const a = f.record('crash-a'), b = f.record('view-b'), childA = await f.ready(a); await f.ready(b);
    await f.api.handle('session.open', {id: b.id}); emitState(childA, {runId: 'crashing-run', isRunning: true, lifecycleStatus: 'running'});
    childA.emit('message', {type: 'fatal', error: 'fixture runtime ended'}); await f.flush();
    const result = f.api.state().activities.find((activity: any) => activity.sessionId === a.id && activity.kind === 'failed');
    assert.ok(result); assert.equal(result.status, 'interrupted'); assert.equal(result.unseen, true);
    assert.equal(f.api.state().current.sessionId, b.id);
  } finally {f.cleanup();}
});
