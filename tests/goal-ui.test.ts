import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import * as jsxRuntime from 'react/jsx-runtime';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import * as model from '../apps/desktop/src/renderer/goal-model.js';
import {GoalBar} from '../apps/desktop/src/renderer/GoalBar.js';
import {GoalEditor} from '../apps/desktop/src/renderer/GoalDialog.js';
import {SessionComposer,type ComposerSnapshot} from '../apps/desktop/src/renderer/SessionComposer.js';
import {errorText} from '../apps/desktop/src/renderer/types.js';
const goal:model.ComposerGoal={id:'g',revision:2,objective:'核对项目并交付成果',status:'active',timeUsedSeconds:65,updatedAt:'2026-10-17T04:00:00Z'};
const nodes=(n:any):any[]=>!n?[]:Array.isArray(n)?n.flatMap(nodes):n.props?[n,...nodes(n.props.children)]:[];
const text=(n:any):string=>typeof n==='string'?n:Array.isArray(n)?n.map(text).join(''):n?.props?text(n.props.children):'';
test('elapsed adds only active interval and freezes paused/blocked/limited Goals',()=>{
 for(const status of ['paused','blocked','usage_limited','complete'] as const)assert.equal(model.goalElapsed({...goal,status,activeSince:1000},100000),65);
 assert.equal(model.goalElapsed({...goal,activeSince:1000},11000),75);assert.equal(model.goalElapsed({...goal,activeSince:'2026-10-17T04:00:00Z'},Date.parse('2026-10-17T04:00:05Z')),70);assert.equal(model.goalElapsed({...goal,activeSince:20000},10000),65);
 assert.equal(model.formatGoalElapsed(65),'1:05');assert.equal(model.formatGoalElapsed(3661),'1:01:01');assert.equal(model.goalDraftInput('/goalkeeper'),undefined);
});
test('GoalBar exposes independent pause/edit/clear, Plan suspension and no budget UI',()=>{
 const html=renderToStaticMarkup(createElement(GoalBar,{goal,planMode:true,disabled:false,ready:true,onEdit(){},onAction:async()=>{}}));
 for(const label of ['当前目标','暂停目标','编辑目标','清除目标','1:05','计划模式，自动推进暂缓'])assert.match(html,new RegExp(label));assert.doesNotMatch(html,/预算|令牌|停止当前任务|验证完成|确认验收/);
 assert.equal(renderToStaticMarkup(createElement(GoalBar,{goal:{...goal,status:'complete'},planMode:false,disabled:false,ready:true,onEdit(){},onAction:async()=>{}})),'');
 const archived=renderToStaticMarkup(createElement(GoalBar,{goal:{...goal,status:'paused'},planMode:false,disabled:true,ready:false,onEdit(){},onAction:async()=>{}}));assert.match(archived,/aria-label="恢复目标"[^>]*disabled/);assert.equal((archived.match(/disabled=""/g)||[]).length,3);
});
function editor(){let cursor=0;const slots:any[]=[],calls:any[]=[];let response=async()=>{};const hooks={useState(initial:any){const i=cursor++;if(!(i in slots))slots[i]=initial;return [slots[i],(v:any)=>slots[i]=v];},useRef(initial:any){const i=cursor++;if(!(i in slots))slots[i]={current:initial};return slots[i];}};
 const source=transformSync(readFileSync('apps/desktop/src/renderer/GoalDialog.tsx','utf8'),{loader:'tsx',format:'cjs',jsx:'automatic'}).code;const ctx:any={module:{exports:{}},require(name:string){if(name==='react')return hooks;if(name==='react/jsx-runtime')return jsxRuntime;if(name==='./goal-model.js')return model;if(name==='./types.js')return {errorText};throw new Error(name);}};vm.runInNewContext(source,ctx);
 const props={goal:{...goal},archived:false,onClose(){},onAction:async(c:any)=>{calls.push(c);await response();}};const render=()=>{cursor=0;return ctx.module.exports.GoalEditor(props);};const button=(label:string)=>nodes(render()).find(n=>n.type==='button'&&text(n)===label);const edit=(value:string)=>nodes(render()).find(n=>n.type==='textarea').props.onChange({target:{value}});const submit=()=>nodes(render()).find(n=>n.type==='form').props.onSubmit({preventDefault(){}});return {props,render,button,edit,submit,calls,respond:(fn:()=>Promise<void>)=>response=fn};
}
test('Goal editor disables empty/unchanged saves, restores edits and saves trimmed objective with exact revision',async()=>{
 const f=editor();assert.equal(f.button('保存').props.disabled,true);f.edit('  ');assert.equal(f.button('保存').props.disabled,true);f.submit();assert.equal(f.calls.length,0);f.edit('新目标');f.button('还原').props.onClick();assert.equal(f.button('保存').props.disabled,true);f.edit('  新目标  ');f.submit();await Promise.resolve();assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])),{action:'goal.set',input:{goalId:'g',expectedRevision:2,objective:'新目标',status:'active'}});assert.doesNotMatch(text(f.render()),/预算|令牌/);
});
test('editor retains failed draft, prevents duplicate save and requires restoring concurrently changed revision',async()=>{
 const f=editor();f.edit('保留草稿');f.respond(async()=>{throw new Error('连接失败');});f.submit();f.submit();for(let i=0;i<6;i++)await Promise.resolve();assert.equal(f.calls.length,1);assert.match(text(f.render()),/连接失败/);assert.equal(nodes(f.render()).find(n=>n.type==='textarea').props.value,'保留草稿');f.props.goal={...goal,revision:3,objective:'模型更新目标'};assert.equal(f.button('保存').props.disabled,true);f.button('还原').props.onClick();assert.equal(nodes(f.render()).find(n=>n.type==='textarea').props.value,'模型更新目标');f.props.archived=true;f.edit('改动');assert.equal(f.button('保存').props.disabled,true);
});
test('composer keeps Goal visible beside queued user messages with all plugins disabled and Plan independent',()=>{
 const value:ComposerSnapshot={goal,goalDraft:true,sessionId:'s',epoch:1,draft:'新的目标',attachments:[],running:false,sending:false,navigating:false,archived:false,planMode:true,permissionMode:'auto',permissionExplicit:false,mode:'single',plugins:[],models:[],modelId:'',thinkingLevel:'off',thinkingLevels:['off'],ready:false,floating:false,collapsed:false,status:'',queue:{paused:false,items:[]}} as ComposerSnapshot;
 const html=renderToStaticMarkup(createElement(SessionComposer,{value,action:async()=>{}}));for(const label of ['当前目标','目标输入模式','计划模式（只读分析）','Agent 协作方式','发送消息'])assert.ok(html.includes(label));assert.doesNotMatch(html,/预算|令牌|验证完成/);
 const editorHtml=renderToStaticMarkup(createElement(GoalEditor,{goal,archived:false,onClose(){},onAction:async()=>{}}));assert.match(editorHtml,/<aside[^>]*aria-label="编辑目标"/);assert.match(editorHtml,/最近更新/);
});
