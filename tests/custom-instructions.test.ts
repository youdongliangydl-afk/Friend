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
    customInstructionsExtension(dir)({on(name:string,callback:typeof handler){assert.equal(name,'before_agent_start');handler=callback;}} as unknown as ExtensionAPI);
    assert.equal(handler!({systemPrompt:'host rules'}),undefined);
    saveCustomInstructions(dir,{text:'首版偏好',revision:0});
    const first=handler!({systemPrompt:'host rules and tools'})!.systemPrompt;
    assert.ok(first.startsWith('host rules and tools\n'));
    assert.match(first,/首版偏好/);assert.match(first,/本轮用户的明确要求优先/);
    saveCustomInstructions(dir,{text:'新版偏好',revision:1});
    const next=handler!({systemPrompt:'host rules'})!.systemPrompt;
    assert.match(next,/新版偏好/);assert.doesNotMatch(next,/首版偏好/);
    saveCustomInstructions(dir,{text:'   \n',revision:2});
    assert.equal(handler!({systemPrompt:'host rules'}),undefined);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
