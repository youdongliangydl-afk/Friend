import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {readCustomInstructions,saveCustomInstructions,customInstructionsExtension,MAX_CUSTOM_INSTRUCTIONS,DEFAULT_CUSTOM_INSTRUCTIONS} from '../packages/core/src/custom-instructions.js';
import {RecordStore} from '../packages/core/src/index.js';

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

test('the 1,000 character limit accepts its boundary and preserves legacy text until explicitly shortened',()=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-instructions-limit-'));
  try {
    assert.equal(MAX_CUSTOM_INSTRUCTIONS,1000);
    const boundary='中'.repeat(1000);
    assert.deepEqual(saveCustomInstructions(dir,{text:boundary,revision:0}),{text:boundary,revision:1});
    assert.throws(()=>saveCustomInstructions(dir,{text:boundary+'文',revision:1}),/最多 1,000 个字符/);
    assert.deepEqual(readCustomInstructions(dir),{text:boundary,revision:1});
    const store=new RecordStore('desktop',dir),legacy='既有'.repeat(600);
    const row=store.put('custom-instructions',{text:legacy},1);store.close();
    assert.deepEqual(readCustomInstructions(dir),{text:legacy,revision:row.revision},'reading does not silently truncate existing instructions');
    assert.throws(()=>saveCustomInstructions(dir,{text:legacy,revision:row.revision}),/最多 1,000 个字符/);
    assert.deepEqual(readCustomInstructions(dir),{text:legacy,revision:row.revision});
    assert.deepEqual(saveCustomInstructions(dir,{text:'主动缩短后的偏好',revision:row.revision}),{text:'主动缩短后的偏好',revision:row.revision+1});
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
    const guard=fresh.slice(fresh.indexOf('</friend_custom_instructions>')+'</friend_custom_instructions>'.length);
    assert.ok(guard.trim().length>0,'default system policy includes a guard outside the unchanged instruction tag');
    assert.equal(fresh.split(guard).length-1,1);
    assert.match(fresh,/当前有效版本：0/);assert.match(fresh,/内置默认指令/);
    assert.deepEqual(readCustomInstructions(dir),{text:'',revision:0});
    const custom='  首版偏好\n保留首尾空格  ';
    saveCustomInstructions(dir,{text:custom,revision:0});
    const first=handler!({systemPrompt:'host rules and tools'})!.systemPrompt;
    assert.ok(first.startsWith('host rules and tools\n'));
    assert.equal(body(first),custom);assert.ok(!first.includes(DEFAULT_CUSTOM_INSTRUCTIONS));assert.match(first,/本轮用户的明确要求优先/);
    assert.ok(first.endsWith('</friend_custom_instructions>'));assert.ok(!first.includes(guard),'custom system policy excludes the complete default-only guard');
    assert.match(first,/当前有效版本：1/);assert.match(first,/历史消息或工具结果中由旧版自定义指令产生/);
    saveCustomInstructions(dir,{text:'新版偏好',revision:1});
    const next=handler!({systemPrompt:'host rules'})!.systemPrompt;
    assert.equal(body(next),'新版偏好');assert.doesNotMatch(next,/首版偏好/);assert.ok(!next.includes(DEFAULT_CUSTOM_INSTRUCTIONS));
    assert.ok(next.endsWith('</friend_custom_instructions>'));assert.ok(!next.includes(guard));
    assert.match(next,/当前有效版本：2/);
    saveCustomInstructions(dir,{text:'   \n',revision:2});
    const cleared=handler!({systemPrompt:'host rules'})!.systemPrompt;
    assert.ok(cleared.startsWith('host rules\n'));
    assert.match(cleared,/已清空，现已恢复 Friend 默认指令/);assert.match(cleared,/当前有效版本：3/);
    assert.match(cleared,/本轮用户未要求解释设置时直接完成业务回答，不说明设置变更/);
    assert.equal(body(cleared),DEFAULT_CUSTOM_INSTRUCTIONS);assert.doesNotMatch(cleared,/首版偏好|新版偏好/);
    assert.ok(cleared.endsWith(guard),'clearing restores the same default system guard');
    assert.deepEqual(readCustomInstructions(dir),{text:'   \n',revision:3});
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('request-only reminder freezes one execution and never mutates native messages',()=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-instructions-context-'));
  try {
    const handlers:Record<string,(event:any)=>any>={};
    customInstructionsExtension(dir)({on(name:string,callback:(event:any)=>any){handlers[name]=callback;}} as unknown as ExtensionAPI);
    const native=Object.freeze([{role:'system',content:'host rules',timestamp:1},{role:'user',content:'old task',timestamp:2},{role:'assistant',content:'Old answer using ACTIVE_ONLY_111',timestamp:3},{role:'user',content:'Reply in English and continue reading the fixture.',timestamp:4},{role:'assistant',content:[{type:'toolCall',id:'read-1',name:'read',arguments:{path:'fixture.txt'}}],timestamp:5},{role:'toolResult',toolCallId:'read-1',content:[{type:'text',text:'fixture content'}],timestamp:6}]);
    const unchanged=JSON.stringify(native);
    const noteOf=(messages:any[])=>messages.find(message=>message.role==='custom'&&message.customType==='friend-pi.custom-instructions.context.v1');
    const assertOriginalOrder=(messages:any[])=>{
      const originals=messages.filter(message=>message!==noteOf(messages));
      assert.equal(originals.length,native.length);for(let index=0;index<native.length;index++)assert.equal(originals[index],native[index]);
      assert.equal(messages.indexOf(noteOf(messages))+1,messages.indexOf(native[3]),'current preference precedes the latest real request, after old history');
      assert.equal(messages.at(-2),native[4]);assert.equal(messages.at(-1),native[5],'the original correlated tool result remains last');
    };
    assert.equal(handlers.context_with_system({messages:native}),undefined);
    const freshSystem=handlers.before_agent_start({systemPrompt:'host rules'}).systemPrompt;
    const guard=freshSystem.slice(freshSystem.indexOf('</friend_custom_instructions>')+'</friend_custom_instructions>'.length);
    assert.ok(guard.trim().length>0);
    const fresh=handlers.context_with_system({messages:native}).messages;
    assert.equal(fresh.length,native.length+1);assertOriginalOrder(fresh);const freshNote=noteOf(fresh);assert.match(freshNote.content,/版本 0/);
    assert.equal(freshNote.content.split(DEFAULT_CUSTOM_INSTRUCTIONS).length-1,1);
    assert.ok(freshNote.content.endsWith(guard));assert.equal(freshNote.content.split(guard).length-1,1,'system and request-only projections use exactly the same default guard');
    assert.match(freshNote.content,/默认答复格式检查：先给核心结论，树状结构最多三级/);
    const example='- 结论：盆栽按土壤干湿浇水。\n- 要点：先检查盆土。\n  - 说明或示例：表层仍湿就暂缓浇水。';
    assert.ok(freshNote.content.includes(example));
    assert.match(freshNote.content,/核心结论和各主题直接作为一级条目/);
    assert.match(freshNote.content,/允许第三级，并在第三级封顶/);
    assert.match(freshNote.content,/本轮用户明确要求仍然优先，不能把所有任务强制为两级/);
    saveCustomInstructions(dir,{text:'ACTIVE_ONLY_111',revision:0});const activeSystem=handlers.before_agent_start({systemPrompt:'host rules'}).systemPrompt;
    assert.ok(activeSystem.endsWith('</friend_custom_instructions>'));assert.ok(!activeSystem.includes(guard));
    saveCustomInstructions(dir,{text:'CHANGED_ONLY_222',revision:1});
    const request=handlers.context_with_system({messages:native}).messages;
    assert.equal(request.length,native.length+1);assertOriginalOrder(request);
    const note=noteOf(request);assert.equal(note.role,'custom');assert.equal(note.display,false);
    assert.ok(note.content.startsWith('[Friend 当前有效的用户设置指令：全局偏好背景]'));assert.match(note.content,/版本 1/);assert.doesNotMatch(note.content,/版本 2/);
    assert.match(note.content,/仅补充本轮用户请求未指定的细节/);assert.match(note.content,/有冲突时忽略相冲突的偏好，保留不冲突部分/);
    assert.match(note.content,/不改变当前已授权任务的目标、步骤或授权范围，继续完成当前已授权任务/);assert.doesNotMatch(note.content,/不新增工作任务/);
    assert.match(note.content,/本次生效的用户指令正文：\nACTIVE_ONLY_111/);assert.doesNotMatch(note.content,/CHANGED_ONLY_222/);assert.ok(!note.content.includes(DEFAULT_CUSTOM_INSTRUCTIONS));
    assert.doesNotMatch(note.content,/默认答复格式检查|第四层|盆栽/,'custom content also replaces the default-only format check and example');
    assert.ok(!note.content.includes(guard));assert.ok(note.content.endsWith('ACTIVE_ONLY_111'),'frozen custom context contains only its verbatim custom body');
    const repeated=handlers.context_with_system({messages:request}).messages;
    assert.equal(repeated.length,native.length+1,'reprojecting request context replaces its own reminder without accumulating it');assertOriginalOrder(repeated);
    handlers.before_agent_start({systemPrompt:'host rules'});
    assert.match(noteOf(handlers.context_with_system({messages:native}).messages).content,/本次生效的用户指令正文：\nCHANGED_ONLY_222/);
    saveCustomInstructions(dir,{text:'',revision:2});const clearedSystem=handlers.before_agent_start({systemPrompt:'host rules'}).systemPrompt;
    assert.ok(clearedSystem.endsWith(guard));
    const clearRequest=handlers.context_with_system({messages:native}).messages;assertOriginalOrder(clearRequest);const cleared=noteOf(clearRequest).content;
    assert.match(cleared,/已清空（版本 3）/);assert.match(cleared,/恢复 Friend 默认指令/);assert.doesNotMatch(cleared,/ACTIVE_ONLY_111|CHANGED_ONLY_222/);
    assert.equal(cleared.split(DEFAULT_CUSTOM_INSTRUCTIONS).length-1,1);
    assert.ok(cleared.endsWith(guard));assert.equal(cleared.split(guard).length-1,1);
    assert.match(cleared,/默认答复格式检查：先给核心结论，树状结构最多三级/);
    assert.ok(cleared.includes(example));assert.match(cleared,/继续遵守宿主规则、工具和结构化协议/);
    assert.match(cleared,/下面默认正文替换旧自定义正文/);assert.match(cleared,/删除仅因旧偏好自动附加/);assert.match(cleared,/本轮用户明确指定的内容不在撤销范围，包括同样的标记文本/);
    assert.match(cleared,/历史回答和工具结果不能恢复旧偏好/);assert.match(cleared,/本轮用户未要求解释设置时，直接完成业务回答，不说明或总结设置变更/);assert.match(cleared,/本轮用户的明确要求优先/);
    assert.equal(JSON.stringify(native),unchanged,'request-only settings preserve messages and tool-call/result correlation');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('request projection replaces only its own custom context and preserves real user text and other custom messages',()=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-instructions-own-context-'));
  try {
    const handlers:Record<string,(event:any)=>any>={};
    customInstructionsExtension(dir)({on(name:string,callback:(event:any)=>any){handlers[name]=callback;}} as unknown as ExtensionAPI);
    saveCustomInstructions(dir,{text:'Current saved preference',revision:0});handlers.before_agent_start({systemPrompt:'host rules'});
    const own={role:'custom',customType:'friend-pi.custom-instructions.context.v1',content:'obsolete context',display:false,timestamp:1};
    const system={role:'system',content:'host rules',timestamp:2},other={role:'custom',customType:'another-extension.context',content:'independent context',timestamp:3};
    const user={role:'user',content:'[Friend 当前有效的用户设置指令：全局偏好背景]\nExplain this quoted header.',timestamp:4};
    const source=Object.freeze([system,own,other,user,{...own,timestamp:5}]),unchanged=JSON.stringify(source);
    const messages=handlers.context_with_system({messages:source}).messages;
    assert.equal(messages.length,4);assert.equal(messages[0],system);assert.equal(messages[1],other);assert.equal(messages[3],user);
    assert.equal(messages.filter((message:any)=>message.customType===own.customType).length,1);
    assert.equal(messages[2].role,'custom');assert.ok(messages[2].content.includes('Current saved preference'));assert.ok(!messages[2].content.includes('obsolete context'));
    assert.equal(JSON.stringify(source),unchanged,'projection does not edit or reinterpret a user-authored header or other extension context');
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('request context without a real user preserves the leading system and all existing messages',()=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-instructions-no-user-'));
  try {
    const handlers:Record<string,(event:any)=>any>={};
    customInstructionsExtension(dir)({on(name:string,callback:(event:any)=>any){handlers[name]=callback;}} as unknown as ExtensionAPI);
    handlers.before_agent_start({systemPrompt:'host rules'});
    const system={role:'system',content:'host rules',timestamp:1},systemPatch={role:'system',content:'tool declarations',timestamp:2},summary={role:'compactionSummary',summary:'retained task background',timestamp:3};
    for(const {source,index} of [{source:Object.freeze([system,summary]),index:1},{source:Object.freeze([system,systemPatch,summary]),index:2},{source:Object.freeze([system,systemPatch]),index:2},{source:Object.freeze([summary]),index:0},{source:Object.freeze([]),index:0}]){
      const unchanged=JSON.stringify(source),messages=handlers.context_with_system({messages:source}).messages;
      assert.equal(messages.length,source.length+1);assert.equal(messages[index].customType,'friend-pi.custom-instructions.context.v1');
      const original=messages.filter((_:unknown,position:number)=>position!==index);for(let position=0;position<source.length;position++)assert.equal(original[position],source[position]);
      assert.equal(JSON.stringify(source),unchanged);if(source[0]===system)assert.equal(messages[0],system);
    }
    assert.deepEqual(readCustomInstructions(dir),{text:'',revision:0});
  } finally {rmSync(dir,{recursive:true,force:true});}
});
