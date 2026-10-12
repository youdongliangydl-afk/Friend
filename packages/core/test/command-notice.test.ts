import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createEventBus,SessionManager,type ExtensionAPI,type ExtensionContext} from '@earendil-works/pi-coding-agent';
import {commandNotice} from '../src/command-notice.js';
import {registerPlugin,CapabilityError} from '../src/index.js';

test('collaboration command notices summarize actual state without exposing the graph object',()=>{
  const graph={status:'running',goal:'fixture',attempts:[{internal:'RAW_GRAPH_PRIVATE_DATA'.repeat(1000)}],toJSON(){throw Error('must not serialize graph');}};
  const notice=commandNotice('swarm','start',graph);
  assert.equal(notice.level,'info');assert.match(notice.message,/Swarm 任务正在执行/);assert.match(notice.message,/队友会话或执行轨迹/);
  assert.doesNotMatch(notice.message,/RAW_GRAPH_PRIVATE_DATA|attempts|fixture|已完成/);assert.ok(notice.message.length<100);
  for(const [status,expected] of [['created','尚未启动'],['awaiting_review','等待复核'],['ready','等待整合'],['integrated','整合至工作区']])assert.ok(commandNotice('swarm','start',{status}).message.includes(expected));
  assert.match(commandNotice('swarm','start',{}).message,/执行状态尚未确认/);
});

test('paused, failed, denied and unknown results preserve readable errors and their severity',()=>{
  for(const [result,expected,level] of [
    [{status:'paused',error:'额度不足'},'额度不足','warning'],
    [{status:'failed',error:'检查失败'},'检查失败','error'],
    [{code:'PERMISSION_DENIED',error:'操作未获授权'},'操作未获授权','warning'],
    [{code:'OPERATION_UNKNOWN',error:'已发出请求，禁止重放'},'禁止重放','warning'],
    [{ok:false,error:{message:'结构化错误说明'}},'结构化错误说明','error'],
  ] as const){const notice=commandNotice('swarm','start',result);assert.ok(notice.message.includes(expected));assert.equal(notice.level,level);assert.doesNotMatch(notice.message,/已完成|请求已处理/);}
  const secret=commandNotice('swarm','start',{status:'failed',error:'模型认证 sk-fixture-secret-value 不可用'});
  assert.match(secret.message,/密钥已隐藏/);assert.doesNotMatch(secret.message,/sk-fixture/);
});

test('other object command replies use readable result summaries without changing their data',()=>{
  const result={records:[{content:'retained'}]},before=JSON.stringify(result);
  assert.match(commandNotice('memory','search',result).message,/记忆已读取当前结果/);assert.equal(JSON.stringify(result),before);
  assert.match(commandNotice('memory','list',[1,2]).message,/2 项结果/);
  assert.equal(commandNotice('expert','use',{approved:false}).level,'warning');assert.equal(commandNotice('sample','start',false).level,'error');
});

test('registered commands use readable notices while tool results and rejected commands stay unchanged',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'friend-command-notice-')),prior=process.env.FRIEND_PI_DATA_DIR;process.env.FRIEND_PI_DATA_DIR=directory;
  const bus=createEventBus(),notices:{message:string;level:string}[]=[];
  let command!:{handler(args:string,ctx:ExtensionContext):Promise<void>},tool!:any,rejection:Error|undefined;
  const result={id:'full-graph-id',status:'running',attempts:[{detail:'FULL_TOOL_DETAIL'}]};
  const pi={events:bus,on:()=>()=>{},getThinkingLevel:()=> 'off',appendEntry:()=>{},registerCommand:(_name:string,value:typeof command)=>{command=value;},registerTool:(value:any)=>{tool=value;}} as unknown as ExtensionAPI;
  const ctx={cwd:directory,sessionManager:SessionManager.inMemory(directory),isIdle:()=>true,ui:{notify:(message:string,level:string)=>notices.push({message,level})}} as unknown as ExtensionContext;
  try{
    registerPlugin(pi,'swarm',{snapshot:()=>result,dispatch:()=>{if(rejection)throw rejection;return result;}},'Swarm');
    await command.handler('start {"graphId":"full-graph-id"}',ctx);assert.equal(notices.length,1);assert.match(notices[0].message,/正在执行/);assert.doesNotMatch(notices[0].message,/FULL_TOOL_DETAIL|attempts/);
    const response=await tool.execute('call',{action:'snapshot',input:{}},undefined,undefined,ctx);assert.equal(response.details,result);assert.deepEqual(JSON.parse(response.content[0].text),result);
    rejection=new CapabilityError('PERMISSION_DENIED','权限未批准');await assert.rejects(command.handler('start {}',ctx),error=>error===rejection);assert.equal(notices.length,1,'a rejected command cannot emit a success notice');
  }finally{bus.clear();if(prior===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=prior;rmSync(directory,{recursive:true,force:true});}
});
