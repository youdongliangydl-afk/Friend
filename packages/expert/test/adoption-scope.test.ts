import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ExpertController,blockedByFrozenScope,type FrozenRun} from '../src/index.js';
import type {PluginContext} from '@friend-pi/core';

test('automatic adoption immediately narrows scope, freezes versions, and is idempotent within its run',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'expert-scope-')),controller=new ExpertController(dir),entries:{type:string;value:unknown}[]=[];
  const ctx:PluginContext={origin:'user',dataDir:dir,projectId:'p',projectDir:dir,sessionId:'s',runId:'run-one',isIdle:()=>true,history:()=>[],readSource:()=>{throw Error('unused');},request:async()=>undefined,complete:async()=>'',emit:()=>{},notify:()=>{},appendEntry:(type,value)=>entries.push({type,value})};
  try{
    const readOnly=await controller.dispatch('create',{title:'readonly',prompt:'Read source only',tools:['read','grep'],skills:[]},ctx) as {id:string;revision:number};
    const first=controller.beginRun(ctx);assert.equal(first.selectionMode,'auto');assert.equal(blockedByFrozenScope(first,'bash'),false);
    await controller.dispatch('use',{id:readOnly.id,runId:'run-one'},{...ctx,origin:'agent'});
    const actual=controller.snapshot(ctx).adoptions as FrozenRun;assert.equal(blockedByFrozenScope(actual,'bash'),true);assert.equal(blockedByFrozenScope(actual,'read'),false);assert.deepEqual(actual.adoptedIds,[readOnly.id]);assert.equal(actual.hash,first.hash);
    await controller.dispatch('use',{id:readOnly.id},{...ctx,origin:'agent'});assert.equal(entries.filter(entry=>entry.type==='friend-pi.expert.adoption').length,1);
    await controller.dispatch('update',{id:readOnly.id,revision:readOnly.revision,title:'v2',prompt:'new method',tools:['read','bash'],skills:[]},ctx);
    assert.equal((controller.snapshot(ctx).adoptions as FrozenRun).experts.find(expert=>expert.id===readOnly.id)!.version,1);assert.equal(blockedByFrozenScope(controller.snapshot(ctx).adoptions as FrozenRun,'bash'),true);
    await controller.dispatch('select',{ids:[readOnly.id]},ctx);const next=controller.beginRun({...ctx,runId:'run-two'});assert.equal(next.experts[0].version,2);assert.equal(blockedByFrozenScope(next,'bash'),false);
    await assert.rejects(controller.dispatch('use',{id:readOnly.id,runId:'run-one'},ctx),/身份/);
  }finally{controller.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('multiple adopted experts intersect scope, empty intersections deny all execution tools, and member catalogs remain frozen',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'expert-intersection-')),controller=new ExpertController(dir);
  const ctx:PluginContext={origin:'user',dataDir:dir,projectId:'p',projectDir:dir,sessionId:'s',isIdle:()=>true,history:()=>[],readSource:()=>{throw Error('unused');},request:async()=>undefined,complete:async()=>'',emit:()=>{},notify:()=>{},appendEntry:()=>{}};
  try{
    const a=await controller.dispatch('create',{title:'a',prompt:'a',tools:['read'],skills:[]},ctx) as {id:string;revision:number};const b=await controller.dispatch('create',{title:'b',prompt:'b',tools:['grep'],skills:[]},ctx) as {id:string};
    const catalog=await controller.dispatch('freeze',{catalog:true},ctx) as FrozenRun;controller.beginRun(ctx);await controller.dispatch('use',{id:a.id},ctx);await controller.dispatch('use',{id:b.id},ctx);
    const run=controller.snapshot(ctx).adoptions as FrozenRun;assert.deepEqual(run.toolScope,[]);assert.equal(blockedByFrozenScope(run,'read'),true);assert.equal(blockedByFrozenScope(run,'friend_expert'),false);
    await controller.dispatch('update',{id:a.id,revision:a.revision,title:'new',prompt:'new',tools:['bash'],skills:[]},ctx);
    const adopted=await controller.dispatch('adopt.frozen',{catalogHash:catalog.hash,id:a.id},ctx) as {version:number;tools:string[]};assert.equal(adopted.version,1);assert.deepEqual(adopted.tools,['read']);
    await assert.rejects(controller.dispatch('freeze',{expertId:'missing'},ctx),/停用或范围/);
    await assert.rejects(controller.dispatch('adopt.frozen',{catalogHash:catalog.hash,id:a.id},{...ctx,projectId:'other'}),/当前项目/);
  }finally{controller.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('a failed native adoption journal cannot report success or return a method and never widens scope',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'expert-journal-')),controller=new ExpertController(dir);
  const ctx:PluginContext={origin:'user',dataDir:dir,projectId:'p',projectDir:dir,sessionId:'s',isIdle:()=>true,history:()=>[],readSource:()=>{throw Error('unused');},request:async()=>undefined,complete:async()=>'',emit:()=>{},notify:()=>{},appendEntry:type=>{if(type==='friend-pi.expert.adoption')throw Error('injected journal failure');}};
  try{const method=await controller.dispatch('create',{title:'read',prompt:'read only',tools:['read'],skills:[]},ctx) as {id:string};controller.beginRun(ctx);await assert.rejects(controller.dispatch('use',{id:method.id},ctx),/记录未能保存/);const run=controller.snapshot(ctx).adoptions as FrozenRun;assert.equal(blockedByFrozenScope(run,'bash'),true);assert.equal((run.adoptions![0] as {journalStatus:string}).journalStatus,'failed');await assert.rejects(controller.dispatch('use',{id:method.id},ctx),/开始新运行/);}finally{controller.dispose();rmSync(dir,{recursive:true,force:true});}
});
