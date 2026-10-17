import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {submissionSettled} from '../apps/desktop/src/renderer/submission-state.js';

function between(source: string, start: string, end: string): string {
  const offset = source.indexOf(start), finish = source.indexOf(end, offset);
  assert.ok(offset >= 0 && finish > offset, 'production callback boundaries changed');
  return source.slice(offset, finish);
}
function surfaceFixture() {
  const source = readFileSync('apps/desktop/src/renderer/SessionComposer.tsx', 'utf8');
  const callbackStart = source.indexOf('onSnapshot(next=>{') + 'onSnapshot('.length;
  const callback = source.slice(callbackStart, source.indexOf(');},[]);', callbackStart));
  const action = between(source, '  const action=async(input:ComposerAction)=>{', '  return snapshot?');
  const storage = new Map<string, string>(), requests: any[] = [], renders: any[] = [];
  const initial = {sessionId: 'current', epoch: 2, revision: 1, submissionRevision: 0, draft: 'current draft', attachments: [], sending: false, ready: true, archived: false, navigating: false, token: 'current-token'};
  const ctx: any = {latest: {current: initial}, localDraft: {current: null}, localQueueUi: {current: null}, pending: {current: false}, revision: {current: 1}, submitting: {current: null},
    localStorage: {setItem(key: string, value: string) {storage.set(key, value);}}, setSnapshot(next: any) {renders.push(next); ctx.latest.current = next;},
    window: {friendComposer: {action: async (input: any) => {requests.push(input); return {ok: true};}}}};
  vm.createContext(ctx); vm.runInContext(stripTypeScriptTypes('globalThis.receiveSnapshot=' + callback + ';\n' + action + '\nglobalThis.action=action;'), ctx);
  return {ctx, storage, requests, renders, initial};
}

test('stale composer session or epoch cannot change local draft, storage, queue UI or forward an IPC action', async () => {
  const f = surfaceFixture();
  for (const identity of [{sessionId: 'old', epoch: 2}, {sessionId: 'current', epoch: 1}, {}]) for (const type of ['draft', 'send', 'files', 'reference', 'attachmentChecked', 'queueUi']) {
    await f.ctx.action({type, value: type === 'draft' ? 'stale input' : {path: '/stale', hash: 'stale'}, text: 'stale input', ...identity});
  }
  assert.equal(f.ctx.latest.current, f.initial); assert.equal(f.ctx.localDraft.current, null); assert.equal(f.ctx.localQueueUi.current, null);
  assert.equal(f.ctx.pending.current, false); assert.equal(f.ctx.submitting.current, null);
  assert.equal(f.storage.size, 0); assert.equal(f.renders.length, 0); assert.equal(f.requests.length, 0);
  await f.ctx.action({type: 'draft', value: 'accepted current input', sessionId: 'current', epoch: 2});
  assert.equal(f.ctx.latest.current.draft, 'accepted current input');
  assert.equal(JSON.parse(f.storage.get('friend-pi.draft.v1:current')!).text, 'accepted current input');
  assert.equal(f.requests[0].token, 'current-token');
});

test('a captured old composer callback cannot write into the new session after its snapshot switches owners', async () => {
  const f = surfaceFixture(), captured = {sessionId: 'current', epoch: 2};
  f.ctx.receiveSnapshot({...f.initial, sessionId: 'new-session', epoch: 3, revision: 2, draft: 'new session input', token: 'new-token'});
  const renders = f.renders.length;
  await f.ctx.action({...captured, type: 'draft', value: 'late old session text'});
  await f.ctx.action({...captured, type: 'attachmentChecked', value: {path: '/old', hash: 'old'}});
  assert.equal(f.ctx.latest.current.draft, 'new session input'); assert.equal(f.renders.length, renders);
  assert.equal(f.storage.size, 0); assert.equal(f.requests.length, 0);
  await f.ctx.action({sessionId: 'new-session', epoch: 3, type: 'draft', value: 'new edit'});
  assert.equal(f.storage.has('friend-pi.draft.v1:current'), false);
  assert.equal(JSON.parse(f.storage.get('friend-pi.draft.v1:new-session')!).text, 'new edit');
  assert.equal(f.requests[0].token, 'new-token');
});

function appFixture() {
  const source = readFileSync('apps/desktop/src/renderer/App.tsx', 'utf8');
  const send = between(source, '  const send=async(goalInput?:GoalSubmission)=>{', '  const selectProject=');
  const action = between(source, '  const composerAction=async(action:ComposerAction)=>{', '  useEffect(()=>{setMemberRoute');
  const storage = new Map<string, string>(), requests: any[] = [], errors: string[] = [];
  let release!: () => void; const acknowledgement = new Promise<void>(done => {release = done;});
  const attachments = [{path: '/project/original.csv'}];
  const ctx: any = {errorText: String, submissionSettled, asObject: (value: any) => value && typeof value === 'object' ? value : {}, hasQueueIntent: () => false,
    localStorage: {getItem: (key: string) => storage.get(key) || null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key)},
    goalDraftRef:{current:false},setGoalDraft(){},setGoalReplacement(){},sendLock: {current: false}, allocationLock: {current: false}, migratingDraft: {current: false}, navigating: false, draftRef: {current: 'analyze attached data'}, attachmentsRef: {current: attachments},
    activeSession: {archived: false}, activeMemberRef: {current: null}, selectedModel: {ready: true}, setSending() {}, setSubmissionRevision() {}, setNotice() {}, sessionId: 'native', ownerKey: 'native', attachments,
    lastSubmitted: {current: null}, navigationEpoch: {current: 4}, running: false, state: {current: {sessionId: 'native', runId: 'prior-run', isRunning: false, lifecycleStatus: 'completed', queue: {items: []}}}, setLocalRunning() {}, setTools() {}, setLive() {}, followScroll: {},
    mode: 'single', planMode: false, permissionMode: 'auto', permissionExplicit: true, ownerRef: {current: 'native'}, setDraft(value: string) {ctx.draftRef.current = value;},
    setAttachments(value: any) {const next = typeof value === 'function' ? value(ctx.attachmentsRef.current) : value; ctx.attachments = next; ctx.attachmentsRef.current = next;}, setDraftOwner() {},
    report(error: string) {errors.push(error);}, window: {friendPi: {request: async (method: string, input: any) => {requests.push({method, input}); await acknowledgement; return {accepted: true};}}}};
  ctx.stateRef = {current: ctx.state};
  vm.createContext(ctx); vm.runInContext(stripTypeScriptTypes(send + action + '\nglobalThis.send=send;globalThis.action=composerAction;'), ctx);
  return {ctx, storage, requests, errors, release};
}

test('attachment inspection adds only a hash during an App submission and its ACK clears the sent paths', async () => {
  const f = appFixture(), sending = f.ctx.send();
  assert.equal(f.ctx.sendLock.current, true); assert.equal(f.requests.length, 1);
  await f.ctx.action({type: 'attachmentChecked', sessionId: 'native', epoch: 4, value: {path: '/project/original.csv', hash: 'source-sha', name: 'must-not-overwrite', text: 'must-not-inject'}});
  assert.equal(f.ctx.attachmentsRef.current.length, 1); assert.equal(f.ctx.attachmentsRef.current[0].hash, 'source-sha');
  assert.equal(f.ctx.attachmentsRef.current[0].name, undefined); assert.equal(f.ctx.attachmentsRef.current[0].text, undefined);
  await f.ctx.action({type: 'attachmentChecked', sessionId: 'native', epoch: 4, value: {path: '/project/unknown.csv', hash: 'unknown'}});
  assert.equal(f.ctx.attachmentsRef.current.length, 1);
  await f.ctx.action({type: 'files', sessionId: 'native', epoch: 4, value: [{name: 'late', data: 'dGV4dA=='}]});
  await f.ctx.action({type: 'reference', sessionId: 'native', epoch: 4, value: {kind: '文件', path: '/late'}});
  assert.equal(f.requests.length, 1, 'new material actions remain locked while inspection metadata may settle');
  f.release(); await sending;
  assert.equal(f.errors.length, 0); assert.equal(f.ctx.draftRef.current, ''); assert.equal(f.ctx.attachmentsRef.current.length, 0);
  assert.equal(JSON.parse(f.storage.get('friend-pi.draft.v1:native')!).attachments.length, 0);
  assert.equal(f.requests[0].input.attachments[0].path, '/project/original.csv');
});

test('Goal send delivers one native prompt with attachments and the atomic Goal intent, then clears only its draft',async()=>{
 const f=appFixture();f.ctx.goalDraftRef.current=true;const sending=f.ctx.send({objective:'analyze attached data',replace:true,expectedGoalId:'g',expectedRevision:7});assert.equal(f.requests.length,1);assert.equal(f.requests[0].method,'session.send');assert.equal(f.requests[0].input.text,'analyze attached data');assert.equal(f.requests[0].input.goal.objective,'analyze attached data');assert.equal(f.requests[0].input.goal.expectedRevision,7);assert.equal(f.requests[0].input.attachments[0].path,'/project/original.csv');f.release();await sending;assert.equal(f.ctx.goalDraftRef.current,false);assert.equal(f.requests.length,1);assert.equal(JSON.parse(f.storage.get('friend-pi.draft.v1:native')!).goalDraft,false);
});

test('running and queued Goal creation stays a draft instead of sending a separate Goal wake or silently losing its intent',async()=>{
 for(const queued of [false,true]){const f=appFixture();f.ctx.goalDraftRef.current=true;if(queued)f.ctx.state.current.queue.items=[{id:'queued'}];else f.ctx.running=true;await f.ctx.send({objective:'new goal'});assert.equal(f.requests.length,0);assert.equal(f.ctx.draftRef.current,'analyze attached data');assert.equal(f.ctx.goalDraftRef.current,true);}
});

test('an obsolete App attachment inspection cannot hash a new session or a newer navigation epoch', async () => {
  const f = appFixture();
  for (const identity of [{sessionId: 'old', epoch: 4}, {sessionId: 'native', epoch: 3}]) await f.ctx.action({type: 'attachmentChecked', ...identity, value: {path: '/project/original.csv', hash: 'obsolete'}});
  assert.equal(f.ctx.attachmentsRef.current[0].hash, undefined); assert.equal(f.storage.size, 0); assert.equal(f.requests.length, 0);
});

test('opening a branch draft retains its frozen mode and plan instead of the root configuration', () => {
  const source=readFileSync('apps/desktop/src/renderer/App.tsx','utf8');
  const body=between(source,'    let saved:JsonObject={};',"    migratedComposerOwner.current='';");
  const values:any={},ctx:any={ownerKey:'branch',sessionId:'branch',state:{current:{sideDraft:{text:'frozen',attachments:[{path:'/frozen.csv'}],mode:'team',planMode:true},executionMode:'single',planMode:false},preferences:{}},asObject:(value:any)=>value||{},asList:(value:any)=>value||[],localStorage:{getItem:()=>null},permissionExplicitRef:{current:false},migratedComposerOwner:{current:''}};
  for(const name of ['GoalDraft','GoalReplacement','GoalOpen','Draft','Attachments','DraftOwner','PlanMode','PermissionExplicit','PermissionMode','Mode'])ctx['set'+name]=(value:any)=>{values[name]=value;};
  vm.createContext(ctx);vm.runInContext(stripTypeScriptTypes(body),ctx);
  assert.equal(values.Draft,'frozen');assert.equal(values.Mode,'team');assert.equal(values.PlanMode,true);assert.equal(values.Attachments[0].path,'/frozen.csv');
});

test('the actual BrowserHost overlay action admits material events only for the bound session and token', () => {
  const source = readFileSync('apps/desktop/src/browser-host.ts', 'utf8');
  const method = between(source, '  overlayAction(raw:', '  private watchDownloads').replace('overlayAction(', 'function overlayAction(');
  const emitted: any[] = [], host = {overlayToken: 'bound-token', overlayOwner: 'owner', emit: (...args: any[]) => emitted.push(args)};
  const scope: any = {}; vm.createContext(scope); vm.runInContext(stripTypeScriptTypes(method + '\nglobalThis.action=overlayAction;'), scope);
  for (const type of ['files', 'reference', 'attachmentChecked']) {
    scope.action.call(host, {type, sessionId: 'owner', token: 'bound-token', epoch: 1, value: {path: '/material'}});
    assert.throws(() => scope.action.call(host, {type, sessionId: 'old-owner', token: 'bound-token'}), /所属会话/);
    assert.throws(() => scope.action.call(host, {type, sessionId: 'owner', token: 'old-token'}), /所属会话/);
  }
  assert.equal(emitted.length, 3); assert.ok(emitted.every(args => args[0] === 'composer.action' && args[2] === 'owner'));
  assert.throws(() => scope.action.call(host, {type: 'arbitrary-tool', sessionId: 'owner', token: 'bound-token'}), /操作无效/);
});

test('manual sidebar navigation reopens deferred approval after admission and keeps it deferred during submission',async()=>{
 const source=readFileSync('apps/desktop/src/renderer/App.tsx','utf8');
 for(const name of ['openSession','selectProject']){
  const marker='  const '+name+'=async',offset=source.indexOf(marker),end=source.indexOf('\n',offset);assert.ok(offset>=0&&end>offset);
  const callback=source.slice(offset,end),deferred=new Set(['pending-approval']),calls:any[]=[];
  const context:any={navigating:false,sending:true,notice:null,setNotice(value:any){context.notice=typeof value==='function'?value(context.notice):value;},allocationLock:{current:false},migratingDraft:{current:false},sendLock:{current:false},navigationEpoch:{current:0},deferredDialogs:{current:deferred},stateRef:{current:{current:{dialogs:[{id:'pending-approval'}]}}},setDialogs(value:any){context.restored=value;},sessionId:"source",beginNavigation(){},finishNavigation(){},report(){},setSelectedProject(){},setMaterial(){},navigate:async(method:string)=>{calls.push({method,deferred:deferred.size});}};
  vm.createContext(context);context.useCallback=(callback:any)=>callback;const restore=between(source,'  const restoreDialogs=','  useEffect(()=>{if(sessionView.active');vm.runInContext(stripTypeScriptTypes(restore+callback+'\nglobalThis.runNavigation='+name+';'),context);
  await context.runNavigation('target');assert.equal(deferred.size,1);assert.equal(calls.length,0);
  context.sending=false;await context.runNavigation('target');assert.equal(deferred.size,0);assert.equal(calls.length,1);assert.equal(calls[0].deferred,0);assert.equal(context.navigationEpoch.current,1);assert.equal(context.restored[0].id,'pending-approval');
 }
});
