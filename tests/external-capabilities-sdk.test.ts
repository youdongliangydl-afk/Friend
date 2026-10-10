import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,writeFileSync,readFileSync,existsSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import type {ExternalCapabilitiesSnapshot} from '../apps/desktop/src/external-capabilities.js';

interface Frame {type:string;id?:string;error?:string;result?:unknown;state?:Record<string,unknown>;event?:{type:string;data:Record<string,unknown>}}
async function start(directory=mkdtempSync(join(tmpdir(),'friend-external-sdk-')),sessionFile?:string){
  const events:Frame[]=[],pending=new Map<string,{resolve:(value:unknown)=>void;reject:(error:Error)=>void}>();let stderr='',finished=false;
  // Source entry uses the same public worker and avoids racing the root chat's package build.
  const child=fork(resolve('apps/desktop/src/sdk-worker.ts'),[],{execPath:process.execPath,execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,PI_OFFLINE:'1',FRIEND_PI_ROOT:resolve('.'),FRIEND_PI_PROJECT:directory,FRIEND_PI_TEMPORARY_WRITE_ROOT:directory,FRIEND_PI_DATA_DIR:join(directory,'data'),FRIEND_PI_TEST_PROVIDER:'1',FRIEND_PI_PLUGINS:'[]',FRIEND_PI_SESSION_FILE:sessionFile,FRIEND_PI_PERMISSION_MODE:'auto'}});
  child.stderr?.on('data',chunk=>stderr+=String(chunk));
  let readyResolve:(frame:Frame)=>void=()=>{},readyReject:(error:Error)=>void=()=>{};const ready=new Promise<Frame>((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
  const exited=new Promise<void>(done=>child.once('exit',(code,signal)=>{finished=true;const error=new Error(`external worker exit ${code??signal}: ${stderr}`);readyReject(error);for(const request of pending.values())request.reject(error);pending.clear();done();}));
  child.on('message',(frame:Frame)=>{events.push(frame);if(frame.type==='ready')readyResolve(frame);if(frame.type==='fatal')readyReject(new Error(frame.error||stderr));if(frame.type==='response'&&frame.id){const request=pending.get(frame.id);pending.delete(frame.id);frame.error?request?.reject(new Error(frame.error)):request?.resolve(frame.result);}});
  const timer=setTimeout(()=>readyReject(new Error('external worker startup timed out: '+stderr)),20000);try{await ready;}finally{clearTimeout(timer);}
  const request=(method:string,input:Record<string,unknown>={})=>new Promise<unknown>((resolve,reject)=>{if(finished)return reject(new Error('worker exited'));const id=randomUUID(),timeout=setTimeout(()=>{pending.delete(id);reject(new Error('external worker request timed out: '+method));},20000);pending.set(id,{resolve:value=>{clearTimeout(timeout);resolve(value);},reject:error=>{clearTimeout(timeout);reject(error);}});child.send({type:'request',id,method,input});});
  const wait=async(predicate:()=>boolean)=>{const until=Date.now()+15000;while(!predicate()){if(finished||Date.now()>until)throw new Error('external worker wait timed out: '+stderr);await new Promise(done=>setTimeout(done,20));}};
  const external=(action:string,input:Record<string,unknown>={})=>request('runtime',{action:'external.call',input:{action,input}});
  return {directory,events,request,external,wait,async close(){if(!finished)await request('shutdown');await exited;assert.equal(stderr.includes('SYNTHETIC_PRIVATE_EXTERNAL_KEY'),false);}};
}
async function listen(server:Server){await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;}
async function close(server:Server){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}

test('worker external.call persists private configuration and restores it through a cold SDK session',{timeout:45000},async()=>{
  let worker=await start();const directory=worker.directory;
  try{
    await worker.external('mcp.save',{name:'fixture-config',type:'stdio',command:process.execPath,args:['server.mjs'],env:{TOKEN:'SYNTHETIC_PRIVATE_EXTERNAL_KEY'}});
    await worker.external('web.save',{provider:'brave',apiKey:'SYNTHETIC_PRIVATE_EXTERNAL_KEY',enabled:false});
    const before=await worker.external('snapshot') as ExternalCapabilitiesSnapshot;assert.equal(before.servers.length,1);assert.equal(before.web.configured,true);assert.ok(!JSON.stringify(before).includes('SYNTHETIC_PRIVATE_EXTERNAL_KEY'));
    assert.equal(statSync(join(directory,'data','external-capabilities.json')).mode&0o777,0o600);
    const state=await worker.request('state') as {sessionFile:string};await worker.close();worker=await start(directory,state.sessionFile);
    const after=await worker.external('snapshot') as ExternalCapabilitiesSnapshot;assert.deepEqual(after.servers[0].envNames,['TOKEN']);assert.equal(after.servers[0].state,'disabled');assert.equal(after.web.configured,true);assert.ok(!JSON.stringify(after).includes('SYNTHETIC_PRIVATE_EXTERNAL_KEY'));
    await worker.request('configure',{plugins:['expert']});assert.equal((await worker.external('snapshot') as ExternalCapabilitiesSnapshot).servers[0].name,'fixture-config');
    await worker.external('mcp.remove',{name:'fixture-config',revision:after.revision});assert.equal((await worker.external('snapshot') as ExternalCapabilitiesSnapshot).servers.length,0);
  }finally{await worker.close();rmSync(directory,{recursive:true,force:true});}
});

test('worker model MCP calls ask exactly once in a temporary session and Plan mode blocks them before approval',{timeout:60000},async()=>{
  const worker=await start(),directory=worker.directory,log=join(directory,'mcp-calls.txt'),fixture=join(directory,'mcp.mjs');
  writeFileSync(fixture,`import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,serverInfo:{name:'fixture',version:'1'},capabilities:{tools:{},resources:{}}};if(m.method==='resources/list')result={resources:[{uri:'fixture://item',name:'item'}]};if(m.method==='resources/templates/list')result={resourceTemplates:[]};if(m.method==='resources/read'){appendFileSync(${JSON.stringify(log)},'resource\\n');result={contents:[{uri:'fixture://item',text:'resource fixture result'}]};}if(m.method==='tools/list')result={tools:[{name:'echo',description:'Fixture echo',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]};if(m.method==='tools/call'){appendFileSync(${JSON.stringify(log)},'called\\n');result={content:[{type:'text',text:'fixture result'}]};}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  const provider=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw),messages=body.messages as Array<{role:string;content:unknown}>;const index=messages.findLastIndex(message=>message.role==='user'&&JSON.stringify(message.content).includes('EXTERNAL_CASE_')),last=JSON.stringify(messages[index]?.content||''),hasResult=messages.slice(index+1).some(message=>message.role==='tool');
    const tool=last.includes('EXTERNAL_CASE_RESOURCE')?'read_mcp_resource':last.includes('EXTERNAL_CASE_WEB_SEARCH')?'web_search':last.includes('EXTERNAL_CASE_WEB_FETCH')?'web_fetch':'mcp__fixture__echo',args=tool==='read_mcp_resource'?{server:'fixture',uri:'fixture://item'}:tool==='web_search'?{query:'offline fixture'}:tool==='web_fetch'?{url:'http://127.0.0.1/private'}:{text:'fixture'};
    res.writeHead(200,{'Content-Type':'text/event-stream'});const deltas=hasResult?[{delta:{role:'assistant',content:'Fixture completed'},finish_reason:null},{delta:{},finish_reason:'stop'}]:[{delta:{role:'assistant',tool_calls:[{index:0,id:randomUUID(),type:'function',function:{name:tool,arguments:JSON.stringify(args)}}]},finish_reason:null},{delta:{},finish_reason:'tool_calls'}];for(const choice of deltas)res.write(`data: ${JSON.stringify({id:'external-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,...choice}]})}\n\n`);res.end('data: [DONE]\n\n');});
  const base=await listen(provider);
  const respond=async(from:number,operation:Promise<unknown>,confirmed=true)=>{await worker.wait(()=>worker.events.slice(from).some(frame=>frame.event?.type==='dialog'));const dialogs=worker.events.slice(from).filter(frame=>frame.event?.type==='dialog');assert.equal(dialogs.length,1);await worker.request('dialog.respond',{id:dialogs[0].event!.data.id,confirmed});return operation;};
  const send=async(text:string,planMode:boolean,approve?:boolean)=>{const from=worker.events.length;await worker.request('send',{text,planMode,mode:'single'});if(approve!==undefined){await worker.wait(()=>worker.events.slice(from).some(frame=>frame.event?.type==='dialog'));await new Promise(done=>setTimeout(done,80));const dialogs=worker.events.slice(from).filter(frame=>frame.event?.type==='dialog');assert.equal(dialogs.length,1,'one model MCP call must produce one permission question');await worker.request('dialog.respond',{id:dialogs[0].event!.data.id,confirmed:approve});}else{await worker.wait(()=>worker.events.slice(from).some(frame=>frame.event?.type==='dialog'||frame.event?.type==='pi'&&frame.event.data.type==='agent_settled'));assert.equal(worker.events.slice(from).filter(frame=>frame.event?.type==='dialog').length,0,'read-only or Plan-blocked tools must not request extra approval');}await worker.wait(()=>worker.events.slice(from).some(frame=>frame.event?.type==='pi'&&frame.event.data.type==='agent_settled'));return worker.events.slice(from);};
  try{
    await worker.external('mcp.save',{name:'fixture',type:'stdio',command:process.execPath,args:[fixture]});
    let from=worker.events.length;const tested=await respond(from,worker.external('mcp.test',{name:'fixture'})) as {ok:boolean};assert.equal(tested.ok,true);assert.equal(existsSync(log),false);
    from=worker.events.length;await respond(from,worker.external('mcp.enable',{name:'fixture',enabled:true}));
    await worker.request('provider.save',{provider:'external-local-fixture',modelId:'fixture',baseUrl:base+'/v1',api:'openai-completions',apiKey:'test-only-local-provider'});
    await send('EXTERNAL_CASE_MCP_DENY',false,false);assert.equal(existsSync(log),false);
    await send('EXTERNAL_CASE_MCP_ALLOW',false,true);assert.equal(readFileSync(log,'utf8').trim(),'called');
    await send('EXTERNAL_CASE_RESOURCE',false,true);assert.equal(readFileSync(log,'utf8').trim(),'called\nresource');
    const plan=await send('EXTERNAL_CASE_MCP_PLAN',true);assert.equal(plan.filter(frame=>frame.event?.type==='dialog').length,0);assert.equal(readFileSync(log,'utf8').trim(),'called\nresource');
    let state=await worker.request('state') as {messages:Array<{text:string}>};assert.ok(state.messages.some(message=>message.text.includes('计划模式只允许读取')));
    const search=await send('EXTERNAL_CASE_WEB_SEARCH',true);assert.equal(search.filter(frame=>frame.event?.type==='dialog').length,0);state=await worker.request('state') as typeof state;assert.ok(state.messages.some(message=>message.text.includes('尚未启用 Brave')),'read-only Plan must reach web_search');
    const fetch=await send('EXTERNAL_CASE_WEB_FETCH',true);assert.equal(fetch.filter(frame=>frame.event?.type==='dialog').length,0);state=await worker.request('state') as typeof state;assert.ok(state.messages.some(message=>message.text.includes('不能访问本机')),'read-only Plan must reach web_fetch, where private addresses are denied');
  }finally{await worker.close();await close(provider);rmSync(directory,{recursive:true,force:true});}
});
