import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {readCustomInstructions,saveCustomInstructions,customInstructionsExtension,MAX_CUSTOM_INSTRUCTIONS,DEFAULT_CUSTOM_INSTRUCTIONS} from '../packages/core/src/custom-instructions.js';

test('built-in default instructions preserve the complete approved text',()=>{
  assert.equal(DEFAULT_CUSTOM_INSTRUCTIONS.length,519);
  assert.equal(createHash('sha256').update(DEFAULT_CUSTOM_INSTRUCTIONS,'utf8').digest('hex'),'4be0ef4a49928973a6e317f5eb53c39554afaf90b51ae4b7ec40120e8e788709');
  assert.ok(DEFAULT_CUSTOM_INSTRUCTIONS.startsWith('第一个要求：对于我给你发送的信息，保持独立思考，不默认正确'));
  assert.ok(DEFAULT_CUSTOM_INSTRUCTIONS.endsWith('- 建议：边学边做项目，不要只看教程'));
});

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

test('new executions use full defaults, verbatim replacement and default restoration without changing raw storage',()=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-instructions-hook-'));
  try {
    let handler:(event:{systemPrompt:string})=>{systemPrompt:string}|undefined;
    customInstructionsExtension(dir)({on(name:string,callback:typeof handler){if(name==='before_agent_start')handler=callback;}} as unknown as ExtensionAPI);
    const body=(prompt:string)=>prompt.match(/<friend_custom_instructions>\n([\s\S]*)\n<\/friend_custom_instructions>/)?.[1];
    const fresh=handler!({systemPrompt:'host rules'})!.systemPrompt;
    assert.ok(fresh.startsWith('host rules\n'));assert.equal(body(fresh),DEFAULT_CUSTOM_INSTRUCTIONS);
    assert.match(fresh,/当前有效版本：0/);assert.match(fresh,/内置默认指令/);
    assert.deepEqual(readCustomInstructions(dir),{text:'',revision:0});
    const custom='  首版偏好\n保留首尾空格  ';
    saveCustomInstructions(dir,{text:custom,revision:0});
    const first=handler!({systemPrompt:'host rules and tools'})!.systemPrompt;
    assert.ok(first.startsWith('host rules and tools\n'));
    assert.equal(body(first),custom);assert.ok(!first.includes(DEFAULT_CUSTOM_INSTRUCTIONS));assert.match(first,/本轮用户的明确要求优先/);
    assert.match(first,/当前有效版本：1/);assert.match(first,/历史消息或工具结果中由旧版自定义指令产生/);
    saveCustomInstructions(dir,{text:'新版偏好',revision:1});
    const next=handler!({systemPrompt:'host rules'})!.systemPrompt;
    assert.equal(body(next),'新版偏好');assert.doesNotMatch(next,/首版偏好/);assert.ok(!next.includes(DEFAULT_CUSTOM_INSTRUCTIONS));
    assert.match(next,/当前有效版本：2/);
    saveCustomInstructions(dir,{text:'   \n',revision:2});
    const cleared=handler!({systemPrompt:'host rules'})!.systemPrompt;
    assert.ok(cleared.startsWith('host rules\n'));
    assert.match(cleared,/已清空，现已恢复 Friend 默认指令/);assert.match(cleared,/当前有效版本：3/);
    assert.equal(body(cleared),DEFAULT_CUSTOM_INSTRUCTIONS);assert.doesNotMatch(cleared,/首版偏好|新版偏好/);
    assert.deepEqual(readCustomInstructions(dir),{text:'   \n',revision:3});
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('request-only reminder freezes one execution and never mutates native messages',()=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-instructions-context-'));
  try {
    const handlers:Record<string,(event:any)=>any>={};
    customInstructionsExtension(dir)({on(name:string,callback:(event:any)=>any){handlers[name]=callback;}} as unknown as ExtensionAPI);
    const native=Object.freeze([{role:'system',content:'host rules',timestamp:1},{role:'user',content:'actual task',timestamp:2},{role:'assistant',content:[{type:'toolCall',id:'read-1',name:'read',arguments:{path:'fixture.txt'}}],timestamp:3},{role:'toolResult',toolCallId:'read-1',content:[{type:'text',text:'fixture content'}],timestamp:4}]);
    const unchanged=JSON.stringify(native);
    assert.equal(handlers.context_with_system({messages:native}),undefined);
    handlers.before_agent_start({systemPrompt:'host rules'});
    const fresh=handlers.context_with_system({messages:native}).messages;
    assert.equal(fresh.length,native.length+1);assert.match(fresh.at(-1).content,/版本 0/);
    assert.equal(fresh.at(-1).content.split(DEFAULT_CUSTOM_INSTRUCTIONS).length-1,1);
    assert.match(fresh.at(-1).content,/默认答复格式检查：先给核心结论，树状结构最多三级/);
    saveCustomInstructions(dir,{text:'ACTIVE_ONLY_111',revision:0});handlers.before_agent_start({systemPrompt:'host rules'});
    saveCustomInstructions(dir,{text:'CHANGED_ONLY_222',revision:1});
    const request=handlers.context_with_system({messages:native}).messages;
    assert.equal(request.length,native.length+1);for(let index=0;index<native.length;index++)assert.equal(request[index],native[index]);
    const note=request.at(-1);assert.equal(note.role,'custom');assert.equal(note.display,false);
    assert.match(note.content,/对本次答复生效；不新增工作任务/);assert.match(note.content,/版本 1/);assert.doesNotMatch(note.content,/版本 2/);
    assert.match(note.content,/本次生效的用户指令正文：\nACTIVE_ONLY_111/);assert.doesNotMatch(note.content,/CHANGED_ONLY_222/);assert.ok(!note.content.includes(DEFAULT_CUSTOM_INSTRUCTIONS));
    assert.doesNotMatch(note.content,/默认答复格式检查|不要建立第四层/,'custom content also replaces the default-only format check');
    assert.equal(handlers.context_with_system({messages:native}).messages.length,native.length+1,'each request adds one reminder without accumulating it');
    handlers.before_agent_start({systemPrompt:'host rules'});
    assert.match(handlers.context_with_system({messages:native}).messages.at(-1).content,/本次生效的用户指令正文：\nCHANGED_ONLY_222/);
    saveCustomInstructions(dir,{text:'',revision:2});handlers.before_agent_start({systemPrompt:'host rules'});
    const cleared=handlers.context_with_system({messages:native}).messages.at(-1).content;
    assert.match(cleared,/已清空（版本 3）/);assert.match(cleared,/恢复 Friend 默认指令/);assert.doesNotMatch(cleared,/ACTIVE_ONLY_111|CHANGED_ONLY_222/);
    assert.equal(cleared.split(DEFAULT_CUSTOM_INSTRUCTIONS).length-1,1);
    assert.match(cleared,/默认答复格式检查：先给核心结论，树状结构最多三级/);
    assert.match(cleared,/回复前检查并删除这类历史标记/);assert.match(cleared,/本轮用户的明确要求优先/);
    assert.equal(JSON.stringify(native),unchanged,'request-only settings preserve messages and tool-call/result correlation');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
