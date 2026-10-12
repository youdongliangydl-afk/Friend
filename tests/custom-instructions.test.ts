import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {readCustomInstructions,saveCustomInstructions,customInstructionsExtension,MAX_CUSTOM_INSTRUCTIONS} from '../packages/core/src/custom-instructions.js';

test('global instructions persist verbatim, reject stale writers and clear without resetting revision',()=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-instructions-'));
  try {
    assert.deepEqual(readCustomInstructions(dir),{text:'',revision:0});
    const text='  先给结论\n保留 Markdown **格式**\n';
    assert.deepEqual(saveCustomInstructions(dir,{text,revision:0}),{text,revision:1});
    assert.deepEqual(readCustomInstructions(dir),{text,revision:1});
    assert.throws(()=>saveCustomInstructions(dir,{text:'过期覆盖',revision:0}),/其他窗口更新/);
    for(const input of [{text:42,revision:1},{text:'a'.repeat(MAX_CUSTOM_INSTRUCTIONS+1),revision:1},{text:'a\0b',revision:1},{text:'x',revision:-1},{text:'x',revision:1.5},{text:'x',revision:'1'}])assert.throws(()=>saveCustomInstructions(dir,input));
    assert.equal(readCustomInstructions(dir).text,text,'invalid updates preserve the last saved value');
    assert.deepEqual(saveCustomInstructions(dir,{text:'',revision:1}),{text:'',revision:2});
    assert.throws(()=>saveCustomInstructions(dir,{text:'stale resurrection',revision:1}),/其他窗口更新/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('the same extension reloads instructions each new execution and preserves the Pi prompt',()=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-instructions-hook-'));
  try {
    let handler:(event:{systemPrompt:string})=>{systemPrompt:string}|undefined;
    customInstructionsExtension(dir)({on(name:string,callback:typeof handler){if(name==='before_agent_start')handler=callback;}} as unknown as ExtensionAPI);
    assert.equal(handler!({systemPrompt:'host rules'}),undefined);
    saveCustomInstructions(dir,{text:'首版偏好',revision:0});
    const first=handler!({systemPrompt:'host rules and tools'})!.systemPrompt;
    assert.ok(first.startsWith('host rules and tools\n'));
    assert.match(first,/首版偏好/);assert.match(first,/本轮用户的明确要求优先/);
    assert.match(first,/当前有效版本：1/);assert.match(first,/历史消息或工具结果中由旧版自定义指令产生/);
    saveCustomInstructions(dir,{text:'新版偏好',revision:1});
    const next=handler!({systemPrompt:'host rules'})!.systemPrompt;
    assert.match(next,/新版偏好/);assert.doesNotMatch(next,/首版偏好/);
    assert.match(next,/当前有效版本：2/);
    saveCustomInstructions(dir,{text:'   \n',revision:2});
    const cleared=handler!({systemPrompt:'host rules'})!.systemPrompt;
    assert.ok(cleared.startsWith('host rules\n'));
    assert.match(cleared,/当前未设置全局自定义指令/);assert.match(cleared,/版本 3/);
    assert.doesNotMatch(cleared,/<friend_custom_instructions>|首版偏好|新版偏好/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('request-only reminder freezes one execution and never mutates native messages',()=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-instructions-context-'));
  try {
    const handlers:Record<string,(event:any)=>any>={};
    customInstructionsExtension(dir)({on(name:string,callback:(event:any)=>any){handlers[name]=callback;}} as unknown as ExtensionAPI);
    const native=[{role:'system',content:'host rules',timestamp:1},{role:'user',content:'actual task',timestamp:2}];
    handlers.before_agent_start({systemPrompt:'host rules'});
    assert.equal(handlers.context_with_system({messages:native}),undefined);
    saveCustomInstructions(dir,{text:'当前偏好',revision:0});handlers.before_agent_start({systemPrompt:'host rules'});
    saveCustomInstructions(dir,{text:'执行中修改',revision:1});
    const request=handlers.context_with_system({messages:native}).messages;
    assert.equal(native.length,2);assert.equal(request.length,3);assert.equal(request[0],native[0]);assert.equal(request[1],native[1]);
    assert.equal(request[2].role,'custom');assert.equal(request[2].display,false);
    assert.match(request[2].content,/对本次答复生效；不新增工作任务/);assert.match(request[2].content,/版本 1/);assert.doesNotMatch(request[2].content,/版本 2/);
    assert.match(request[2].content,/本次生效的用户指令正文：\n当前偏好/);assert.doesNotMatch(request[2].content,/执行中修改/);
    assert.equal(handlers.context_with_system({messages:native}).messages.length,3,'each request adds one reminder without accumulating it');
    saveCustomInstructions(dir,{text:'',revision:2});handlers.before_agent_start({systemPrompt:'host rules'});
    const cleared=handlers.context_with_system({messages:native}).messages[2].content;
    assert.match(cleared,/已清空（版本 3）/);assert.doesNotMatch(cleared,/<friend_custom_instructions>|当前偏好|执行中修改/);
    assert.match(cleared,/回复前检查并删除这类历史标记/);assert.match(cleared,/本轮用户的明确要求优先/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
