import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import {createElement} from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import {asObject,errorText} from '../apps/desktop/src/renderer/types.js';

const source=readFileSync('apps/desktop/src/renderer/App.tsx','utf8');
const action=source.slice(source.indexOf('  const composerAction=async(action:ComposerAction)=>{'),source.indexOf('  useEffect(()=>{setMemberRoute',source.indexOf('  const composerAction=async')));
function appFixture({empty=false}={}){
  const requests:{method:string;input:any}[]=[],draft='保留当前消息',attachments=[{path:'/project/材料.txt'}];
  const current={sessionId:'s',plugins:['memory'],runtime:{goal:{id:'g',status:'paused'}},thinkingLevel:'low'};
  const ctx:any={asObject,errorText,activeMemberRef:{current:null},sessionId:empty?undefined:'s',navigationEpoch:{current:3},sendLock:{current:false},goalActionLock:{current:false},navigating:false,sending:false,running:false,activeSession:{archived:false},selectedModel:{ready:true},selectedModelId:'provider/model',pendingThinking:'max',planMode:true,permissionMode:'ask',mode:'team',draft,attachments,state:{current:empty?null:current},stateRef:{current:{current:empty?null:current}},
    applyState(next:any){ctx.stateRef.current=next;},setMode(value:any){ctx.mode=value;},setPlanMode(value:any){ctx.planMode=value;},setPermissionMode(value:any){ctx.permissionMode=value;},refresh:async()=>{},
    ensureUiSession:async()=>{ctx.stateRef.current={current:{...current,thinkingLevel:'off'}};return 's';},
    window:{friendPi:{request:async(method:string,input:any)=>{requests.push({method,input});return method==='session.configure'?ctx.stateRef.current:{};}}}};
  vm.createContext(ctx);vm.runInContext(stripTypeScriptTypes(action+'\nglobalThis.act=composerAction;'),ctx);
  const run=(operation:string,input:any={})=>ctx.act({type:'goal',sessionId:empty?'':'s',epoch:3,value:{action:operation,input}});
  return {ctx,requests,run};
}

test('starting a Goal synchronizes pending configuration before execution and retains the message draft',async()=>{
  for(const empty of [false,true]){const f=appFixture({empty});await f.run('goal.create',{objective:'持续只读核查',tokenBudget:1000});
    assert.deepEqual(f.requests.map(request=>request.method),['session.configure','session.configure','runtime.call']);
    const config=f.requests[1].input;assert.equal(config.planMode,true);assert.equal(config.executionMode,'team');assert.equal(config.permissionMode,'ask');assert.equal(config.modelId,'provider/model');assert.equal(config.thinkingLevel,empty?'max':'low');
    assert.equal(f.requests[2].input.sessionId,'s');assert.equal(f.requests[2].input.action,'goal.create');assert.equal(f.requests[2].input.input.tokenBudget,1000);
    assert.equal(f.ctx.draft,'保留当前消息');assert.equal(f.ctx.attachments[0].path,'/project/材料.txt');assert.equal(f.ctx.goalActionLock.current,false);
  }
});

test('a Goal request cancels after navigation during configuration and cannot operate on a replaced goal',async()=>{
  const f=appFixture();f.ctx.window.friendPi.request=async(method:string,input:any)=>{f.requests.push({method,input});f.ctx.navigationEpoch.current++;return f.ctx.stateRef.current;};
  await assert.rejects(f.run('goal.create',{objective:'Must not run'}),/会话已切换/);assert.equal(f.requests.some(r=>r.method==='runtime.call'),false);assert.equal(f.ctx.goalActionLock.current,false);
  const replaced=appFixture();await assert.rejects(replaced.run('goal.pause',{goalId:'old-goal'}),/当前目标已变化/);assert.equal(replaced.requests.length,0);
  await assert.rejects(replaced.ctx.act({type:'goal',sessionId:'other',epoch:3,value:{action:'goal.pause',input:{goalId:'g'}}}),/会话已切换/);
});

test('Goal submission locks synchronously and blocks editing or creating during an active execution',async()=>{
  const f=appFixture();let release!:(value:unknown)=>void;f.ctx.window.friendPi.request=async(method:string,input:any)=>{f.requests.push({method,input});return new Promise(done=>release=done);};
  const first=f.run('goal.pause',{goalId:'g'});await assert.rejects(f.run('goal.pause',{goalId:'g'}),/操作正在进行/);assert.equal(f.requests.length,1);release({});await first;
  f.ctx.running=true;for(const operation of ['goal.create','goal.update','goal.resume','goal.complete','goal.accept'])await assert.rejects(f.run(operation,{goalId:'g'}),/请先暂停/);
  assert.equal(f.requests.length,1);
});
test('opening Goal in an empty chat allocates its owner before mounting the editor',async()=>{
  const f=appFixture({empty:true});f.ctx.viewRef={current:{active:'conversation'}};f.ctx.setGoalOpen=(value:unknown)=>{f.ctx.openGoal=value;};
  await f.ctx.act({type:'goal.open',sessionId:'',epoch:3});assert.equal(f.ctx.openGoal.sessionId,'s');assert.equal(f.ctx.openGoal.epoch,3);assert.equal(f.ctx.stateRef.current.current.sessionId,'s');assert.equal(f.requests.length,0);
});

test('allocating an empty composer preserves its chosen thinking level and draft before Goal opens',async()=>{
  const ensureSource=source.slice(source.indexOf('  const ensureUiSession=async()=>{'),source.indexOf('  const writeView=async'));
  for(const thinkingLevel of ['off','medium']){
    const requests:{method:string;input:any}[]=[],saved=new Map<string,string>(),draft='未发送的独立草稿',attachments=[{path:'/fixture/folder'}];
    const ctx:any={sessionId:undefined,running:false,sendLock:{current:false},allocationLock:{current:false},navigating:false,migratingDraft:{current:false},beginNavigation(){ctx.navigating=true;},finishNavigation(){ctx.navigating=false;},draftRef:{current:draft},attachmentsRef:{current:attachments},planMode:true,mode:'team',permissionMode:'ask',permissionExplicit:true,pendingModel:'qa/thinker',pendingThinking:thinkingLevel,projectId:'fixture',localStorage:{setItem:(key:string,value:string)=>saved.set(key,value)},migratedComposerOwner:{current:''},setDraftOwner(value:string){ctx.owner=value;},applyState(next:any){ctx.current=next.current;},viewOwner:{current:''},viewRef:{current:{}},initialView:()=>({active:'conversation'}),setView(){},report(message:string){assert.fail(message);},window:{friendPi:{async request(method:string,input:any){requests.push({method,input});return {current:{sessionId:'native-new',thinkingLevel:method==='session.configure'?input.thinkingLevel:'high'}};}}}};
    vm.createContext(ctx);vm.runInContext(stripTypeScriptTypes(ensureSource+'\nglobalThis.ensure=ensureUiSession;'),ctx);
    assert.equal(await ctx.ensure(),'native-new');assert.equal(ctx.current.thinkingLevel,thinkingLevel);assert.deepEqual(requests.map(request=>request.method),['session.new','session.configure']);assert.equal(requests[1].input.sessionId,'native-new');
    const captured=JSON.parse(saved.get('friend-pi.draft.v1:native-new')!);assert.equal(captured.text,draft);assert.deepEqual(captured.attachments,attachments);assert.equal(captured.planMode,true);assert.equal(captured.mode,'team');assert.equal(ctx.owner,'native-new');assert.equal(ctx.navigating,false);
  }
});

const dialogSource=transformSync(readFileSync('apps/desktop/src/renderer/GoalDialog.tsx','utf8'),{loader:'tsx',format:'cjs',jsx:'automatic',target:'node24'}).code;
const flatten=(node:any):any[]=>!node?[]:Array.isArray(node)?node.flatMap(flatten):node.props?[node,...flatten(node.props.children)]:[];
const label=(node:any):string=>typeof node==='string'?node:Array.isArray(node)?node.map(label).join(''):node?.props?label(node.props.children):'';
function dialogFixture(goal?:any){let cursor=0;const slots:any[]=[],commands:any[]=[];let respond=async()=>{};
  const hooks={useState(initial:any){const index=cursor++;if(!(index in slots))slots[index]=initial;return [slots[index],(value:any)=>{slots[index]=typeof value==='function'?value(slots[index]):value;}];},useRef(initial:any){const index=cursor++;if(!(index in slots))slots[index]={current:initial};return slots[index];}};
  const ctx:any={module:{exports:{}},require(name:string){if(name==='react')return hooks;if(name==='react/jsx-runtime')return jsxRuntime;if(name==='./types.js')return {errorText};if(name==='./ui.js')return {Modal:(props:any)=>createElement('section',props)};throw new Error(name);}};vm.runInNewContext(dialogSource,ctx);
  const props={goal,running:false,ready:true,archived:false,planMode:false,onClose(){},async onAction(command:any){commands.push(command);await respond();}};
  const render=()=>{cursor=0;return ctx.module.exports.GoalDialog(props);};
  const button=(name:string)=>{const node=flatten(render()).find(n=>n.type==='button'&&label(n)===name);assert.ok(node,name);return node;};
  const input=(name:string)=>{const node=flatten(render()).find(n=>n.props['aria-label']===name);assert.ok(node,name);return node;};
  return {render,button,input,commands,props,respond(value:()=>Promise<void>){respond=value;}};
}

test('Goal editor sends an optional explicit budget once and exposes plan-mode save semantics',async()=>{
  const f=dialogFixture();f.props.planMode=true;f.input('目标描述').props.onChange({target:{value:'读取说明并核对结论'}});f.input('总令牌预算').props.onChange({target:{value:'5000'}});
  assert.equal(f.button('保存目标（先规划）').props.disabled,false);let release!:()=>void;f.respond(()=>new Promise(done=>release=done));
  const submit=()=>flatten(f.render()).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});submit();submit();
  assert.equal(f.commands.length,1);assert.equal(f.commands[0].action,'goal.create');assert.equal(f.commands[0].input.objective,'读取说明并核对结论');assert.equal(f.commands[0].input.tokenBudget,5000);release();await Promise.resolve();
});

test('exhausted budget requires a larger explicit budget and cannot be cleared by the Goal UI',async()=>{
  const f=dialogFixture({id:'g',objective:'Inspect',status:'paused',tokens:1000,tokenBudget:1000,usageAvailable:true});
  f.button('接续目标').props.onClick();assert.equal(f.commands.length,0);assert.match(label(f.render()),/已使用量以上/);
  f.input('接续总令牌预算').props.onChange({target:{value:''}});f.button('接续目标').props.onClick();assert.equal(f.commands.length,0);assert.match(label(f.render()),/已有预算不能清空/);
  f.input('接续总令牌预算').props.onChange({target:{value:'2000'}});f.button('接续目标').props.onClick();await Promise.resolve();assert.equal(f.commands[0].action,'goal.resume');assert.equal(f.commands[0].input.tokenBudget,2000);assert.equal(f.commands[0].input.goalId,'g');
});
test('a failed Goal creation keeps the objective and budget visible for correction',async()=>{
  const f=dialogFixture();f.input('目标描述').props.onChange({target:{value:'保留失败后的目标'}});f.input('总令牌预算').props.onChange({target:{value:'9000'}});f.respond(async()=>{throw new Error('连接暂时失败');});
  flatten(f.render()).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});for(let i=0;i<8;i++)await Promise.resolve();
  assert.equal(f.input('目标描述').props.value,'保留失败后的目标');assert.equal(f.input('总令牌预算').props.value,'9000');assert.match(label(f.render()),/连接暂时失败/);assert.equal(f.button('开始目标').props.disabled,false);
});

test('Goal verification and candidate acceptance remain distinct user actions',()=>{
  const f=dialogFixture({id:'g',objective:'Inspect',status:'waiting',revision:7,waitFor:'user-acceptance',tokens:4,usageAvailable:true,acceptance:{binding:'actual-candidate'}});
  f.button('已检查成果，确认验收').props.onClick();assert.equal(f.commands[0].action,'goal.accept');assert.equal(f.commands[0].input.expectedRevision,7);assert.equal(f.commands[0].input.candidateDigest,'actual-candidate');
  assert.equal(flatten(f.render()).some(n=>n.type==='button'&&label(n)==='验证完成'),false);
});
test('pausing or stopping an acceptance wait removes the acceptance action until fresh verification',()=>{
  for(const status of ['paused','stopped']){const f=dialogFixture({id:'g',objective:'Inspect',status,revision:8,waitFor:'user-acceptance',tokens:4,usageAvailable:true,acceptance:{binding:'old-candidate'}});assert.equal(flatten(f.render()).some(n=>n.type==='button'&&label(n)==='已检查成果，确认验收'),false);assert.doesNotMatch(label(f.render()),/等待你验收/);assert.equal(f.button('接续目标').props.disabled,false);}
});
