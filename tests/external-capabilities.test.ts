import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync,readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer,request as httpRequest,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager,initTheme} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
import {createExternalCapabilities} from '../apps/desktop/src/external-capabilities.js';
import {isPublicAddress,publicWebUrl,readPublicText,webpageText,type ExternalNetwork} from '../apps/desktop/src/external-capabilities-network.js';

const temp=()=>mkdtempSync(join(tmpdir(),'friend-external-'));
async function listen(server:Server){await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;}
async function close(server:Server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
function fixtureNetwork(base:string):ExternalNetwork{return {lookup:async()=>[{address:'93.184.216.34',family:4}],request:(url,options,callback)=>httpRequest(new URL(url.pathname+url.search,base),{...options,lookup:undefined},callback)};}

test('web URL admission rejects local files, private IPs, alternate IPv4 spellings and credentials',()=>{
  for(const url of ['file:///etc/passwd','ftp://example.com','http://localhost/','http://127.1/','http://2130706433/','http://0x7f000001/','http://10.1.1.1/','http://[::1]/','http://[::ffff:127.0.0.1]/','http://user:secret@example.com/'])assert.throws(()=>publicWebUrl(url));
  for(const address of ['0.0.0.0','169.254.169.254','100.64.1.1','172.31.3.2','192.168.1.2','198.18.1.1','203.0.113.1','::ffff:8.8.8.8','2001:db8::1','fc00::1'])assert.equal(isPublicAddress(address),false,address);
  assert.equal(isPublicAddress('8.8.8.8'),true);assert.equal(isPublicAddress('2606:4700:4700::1111'),true);
  assert.equal(publicWebUrl('https://example.com/a#fragment').href,'https://example.com/a');
});

test('web reads pin DNS, check every redirect, bound bytes and honor cancellation',async()=>{
  const server=createServer((req,res)=>{if(req.url==='/redirect'){res.writeHead(302,{location:'http://127.0.0.1/private'}).end();return;}if(req.url==='/slow'){res.writeHead(200,{'content-type':'text/plain'});res.write('pending');return;}res.writeHead(200,{'content-type':'text/html'});res.end('<title>A &amp; B</title><script>NEVER_EXECUTE()</script><p>Hello</p>'+('x'.repeat(2000)));});
  const base=await listen(server),network=fixtureNetwork(base);
  try{
    const result=await readPublicText('https://public.example/page',{network,maxBytes:150});assert.equal(result.bytes,150);assert.equal(result.truncated,true);assert.equal(result.url,'https://public.example/page');assert.equal(webpageText(result.body,result.mediaType).title,'A & B');assert.ok(!webpageText(result.body,result.mediaType).content.includes('NEVER_EXECUTE'));
    await assert.rejects(readPublicText('https://public.example/redirect',{network}),/本机|私网/);
    const abort=new AbortController(),pending=readPublicText('https://public.example/slow',{network,signal:abort.signal});setTimeout(()=>abort.abort(),30);await assert.rejects(pending);
    let requested=false;await assert.rejects(readPublicText('https://public.example/page',{network:{lookup:async()=>[{address:'127.0.0.1',family:4}],request:()=>{requested=true;throw new Error('must not send');}}}),/本机|私网/);assert.equal(requested,false);
  }finally{await close(server);}
});

test('web reader refuses binary responses, redirects of authenticated queries, and interrupted bodies',async()=>{
  const server=createServer((req,res)=>{if(req.url==='/binary'){res.writeHead(200,{'content-type':'application/pdf'}).end('binary');return;}if(req.url==='/redirect'){res.writeHead(302,{location:'https://other.example/'}).end();return;}res.writeHead(200,{'content-type':'text/plain','content-length':'500'});res.write('incomplete');setTimeout(()=>res.destroy(),10);}),base=await listen(server),network=fixtureNetwork(base);
  try{await assert.rejects(readPublicText('https://public.example/binary',{network}),/二进制/);await assert.rejects(readPublicText('https://public.example/redirect',{network,redirects:false}),/未转发凭证/);await assert.rejects(readPublicText('https://public.example/broken',{network}),/中断|aborted/);}finally{await close(server);}
});

test('MCP CRUD protects secrets, persists safely, rejects namespace clashes and stale revisions',async()=>{
  const dir=temp(),external=createExternalCapabilities({dataDir:dir,cwd:dir,confirm:async()=>true});
  try{
    await external.call('mcp.save',{name:'docs-tools',type:'stdio',command:process.execPath,args:['server.mjs'],env:{TOKEN:'synthetic-private-token'}});
    let snapshot=external.snapshot();assert.equal(snapshot.servers[0].enabled,false);assert.equal(snapshot.servers[0].state,'disabled');assert.deepEqual(snapshot.servers[0].envNames,['TOKEN']);assert.ok(!JSON.stringify(snapshot).includes('synthetic-private-token'));
    assert.equal(statSync(join(dir,'external-capabilities.json')).mode&0o777,0o600);
    await assert.rejects(external.call('mcp.save',{name:'docs_tools',type:'stdio',command:process.execPath}),/命名空间/);
    await external.call('web.save',{apiKey:'synthetic-brave-secret',enabled:true,revision:snapshot.revision});snapshot=external.snapshot();assert.equal(snapshot.web.configured,true);assert.ok(!JSON.stringify(snapshot).includes('synthetic-brave-secret'));
    await assert.rejects(external.call('mcp.enable',{name:'docs-tools',enabled:true,revision:1}),/其他会话/);
    const resumed=createExternalCapabilities({dataDir:dir,cwd:dir});assert.equal(resumed.snapshot().servers.length,1);assert.equal(resumed.snapshot().web.configured,true);await resumed.dispose();
    await external.call('mcp.remove',{name:'docs-tools',revision:snapshot.revision});assert.equal(external.snapshot().servers.length,0);
    await assert.rejects(external.call('mcp.save',{name:'bad',type:'stdio',command:'x',env:{TOKEN:'!print_secret'}}),/不支持执行命令/);
  }finally{await external.dispose();rmSync(dir,{recursive:true,force:true});}
});

test('Brave search sends credentials only to the fixed provider and returns sources without keys',async()=>{
  const requests:Array<{url?:string;token?:string}>=[],server=createServer((req,res)=>{requests.push({url:req.url,token:req.headers['x-subscription-token'] as string});res.setHeader('content-type','application/json');res.end(JSON.stringify({web:{results:[{title:'Documentation',url:'https://docs.example/a',description:'<b>Primary</b> source'}]}}));}),base=await listen(server),dir=temp(),external=createExternalCapabilities({dataDir:dir,cwd:dir,network:fixtureNetwork(base)});
  try{
    await assert.rejects(external.call('web.search',{query:'test'}),/尚未启用/);assert.equal(requests.length,0);
    await external.call('web.save',{apiKey:'synthetic-brave-key',enabled:true});const result=await external.call('web.search',{query:'MCP specs',count:2}) as {sources:Array<{url:string;snippet:string}>};
    assert.equal(requests[0].token,'synthetic-brave-key');assert.match(requests[0].url!,/^\/res\/v1\/web\/search\?q=MCP\+specs&count=2/);assert.equal(result.sources[0].url,'https://docs.example/a');assert.equal(result.sources[0].snippet,'Primary source');assert.ok(!JSON.stringify(result).includes('synthetic-brave-key'));
    await external.call('web.test');assert.equal(external.snapshot().web.diagnostic,'连接测试通过');
    await external.call('web.save',{enabled:false});await assert.rejects(external.call('web.search',{query:'test'}),/尚未启用/);
  }finally{await external.dispose();await close(server);rmSync(dir,{recursive:true,force:true});}
});

test('MCP URL authentication parameters are write-only, and malformed private files never echo their contents',async()=>{
  const dir=temp(),external=createExternalCapabilities({dataDir:dir,cwd:dir});
  try{
    await external.call('mcp.save',{name:'query-auth',type:'http',url:'https://tools.example/mcp?token=synthetic-query-secret'});
    const publicState=external.snapshot();assert.equal(publicState.servers[0].urlRedacted,true);assert.ok(!JSON.stringify(publicState).includes('synthetic-query-secret'));
    await external.call('mcp.save',{name:'query-auth',config:{type:'http'},revision:publicState.revision});assert.ok(readFileSync(join(dir,'external-capabilities.json'),'utf8').includes('synthetic-query-secret'));
    writeFileSync(join(dir,'external-capabilities.json'),'{"secret":"DO_NOT_ECHO_MALFORMED_PRIVATE_CONTENT"',{mode:0o600});
    await assert.rejects(external.call('snapshot'),error=>error instanceof Error&&!error.message.includes('DO_NOT_ECHO')&&error.message.includes('原文件已保留'));
  }finally{await external.dispose();rmSync(dir,{recursive:true,force:true});}
});

const stdioFixture=`import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};
if(m.method==='initialize')result={protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
if(m.method==='tools/list')result={tools:process.argv.includes('--empty')?[]:[{name:'echo',description:'Fixture echo',annotations:{readOnlyHint:true},inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]};
if(m.method==='tools/call'){appendFileSync(process.env.CALL_LOG,'called\\n');result={content:[{type:'text',text:m.params.arguments.text}],structuredContent:{echo:m.params.arguments.text}};}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`;

async function sessionFor(dir:string,external:ReturnType<typeof createExternalCapabilities>){
  const agentDir=join(dir,'pi');mkdirSync(agentDir,{recursive:true});const previous=process.env.PI_CODING_AGENT_DIR;process.env.PI_CODING_AGENT_DIR=agentDir;
  const runtime=await ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:join(agentDir,'models.json'),allowModelNetwork:false});
  const fixture=fauxProvider({api:'external-fixture-api',provider:'external-fixture',models:[{id:'offline',name:'Offline external fixture',reasoning:false,input:['text'],contextWindow:32768,maxTokens:4096}],tokensPerSecond:10000});runtime.registerNativeProvider(fixture.provider);await runtime.setRuntimeApiKey('external-fixture','fixture');
  const settings=SettingsManager.inMemory({packages:[],extensions:[],defaultTools:[]}),loader=new DefaultResourceLoader({cwd:dir,agentDir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,extensionFactories:[external.extensionFactory]});
  await loader.reload({resolveProjectTrust:async()=>true});initTheme('light',false);
  const {session}=await createAgentSession({cwd:dir,agentDir,resourceLoader:loader,settingsManager:settings,modelRuntime:runtime,model:fixture.getModel('offline'),sessionManager:SessionManager.inMemory(dir),noTools:'builtin'});
  await session.bindExtensions({mode:'rpc'});
  return {session,fixture,async close(){await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});await external.dispose();session.dispose();if(previous===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=previous;}};
}

test('native Pi MCP stdio test discovers tools without invoking them; tool execution obeys approval',async()=>{
  const dir=temp(),file=join(dir,'mcp.mjs'),log=join(dir,'calls.txt');writeFileSync(file,stdioFixture);let allowTools=false;
  const external=createExternalCapabilities({dataDir:dir,cwd:dir,confirm:async request=>request.operation!=='调用 MCP 工具'||allowTools});
  await external.call('mcp.save',{name:'fixture',type:'stdio',command:process.execPath,args:[file],env:{CALL_LOG:log,TOKEN:'fixture-secret-not-visible'}});
  const harness=await sessionFor(dir,external);
  try{
    const result=await external.call('mcp.test',{name:'fixture'}) as {ok:boolean;tools:unknown[]};assert.equal(result.ok,true);assert.equal(result.tools.length,1);assert.equal(existsSync(log),false);assert.equal(external.snapshot().servers[0].enabled,false);
    await external.call('mcp.enable',{name:'fixture',enabled:true});await external.call('mcp.test',{name:'fixture'});
    harness.fixture.setResponses([fauxAssistantMessage(fauxToolCall('mcp__fixture__echo',{text:'approval check'}),{stopReason:'toolUse'}),fauxAssistantMessage('done')]);await harness.session.prompt('invoke tool');assert.equal(existsSync(log),false,'denied MCP tool must not execute');
    allowTools=true;harness.fixture.setResponses([fauxAssistantMessage(fauxToolCall('mcp__fixture__echo',{text:'approved'}),{stopReason:'toolUse'}),fauxAssistantMessage('done')]);await harness.session.prompt('invoke approved tool');assert.equal(readFileSync(log,'utf8').trim(),'called');
    assert.ok(harness.session.messages.some(message=>message.role==='toolResult'&&message.toolName==='mcp__fixture__echo'));
    await external.call('mcp.enable',{name:'fixture',enabled:false});assert.equal(external.snapshot().servers[0].state,'disabled');
  }finally{await harness.close();rmSync(dir,{recursive:true,force:true});}
});

test('native Pi MCP tool namespace keeps enabled a__b distinct from disabled a',async()=>{
  const dir=temp(),file=join(dir,'namespace.mjs'),log=join(dir,'calls.txt');writeFileSync(file,stdioFixture);let approvals=0;
  const external=createExternalCapabilities({dataDir:dir,cwd:dir,confirm:async request=>{if(request.operation==='调用 MCP 工具')approvals++;return true;}});
  await external.call('mcp.save',{name:'a',type:'stdio',command:process.execPath,args:[file],env:{CALL_LOG:log}});
  await external.call('mcp.save',{name:'a__b',type:'stdio',command:process.execPath,args:[file],env:{CALL_LOG:log},enabled:true});
  const harness=await sessionFor(dir,external);
  try{
    assert.equal((await external.call('mcp.test',{name:'a__b'}) as {ok:boolean}).ok,true);
    const tool=external.snapshot().servers.find(server=>server.name==='a__b')!.tools[0];
    assert.equal(tool.name,'mcp__a__b__echo');assert.equal(external.snapshot().servers.find(server=>server.name==='a')!.state,'disabled');
    harness.fixture.setResponses([fauxAssistantMessage(fauxToolCall(tool.name,{text:'namespace exact match'}),{stopReason:'toolUse'}),fauxAssistantMessage('done')]);await harness.session.prompt('invoke nested-looking server name');
    assert.equal(readFileSync(log,'utf8').trim(),'called');assert.equal(approvals,1);
  }finally{await harness.close();rmSync(dir,{recursive:true,force:true});}
});

test('native Pi hashed 64-character tool names resolve through their exact namespace',async()=>{
  const dir=temp(),file=join(dir,'hashed.mjs'),log=join(dir,'calls.txt'),name='x'.repeat(54);writeFileSync(file,stdioFixture);let approvals=0;
  const external=createExternalCapabilities({dataDir:dir,cwd:dir,confirm:async request=>{if(request.operation==='调用 MCP 工具')approvals++;return true;}});
  await external.call('mcp.save',{name,type:'stdio',command:process.execPath,args:[file],env:{CALL_LOG:log},enabled:true});const harness=await sessionFor(dir,external);
  try{
    assert.equal((await external.call('mcp.test',{name}) as {ok:boolean}).ok,true);
    // The name is supplied by the actual Pi MCP adapter, including its length/hash policy.
    const tool=external.snapshot().servers.find(server=>server.name===name)!.tools[0];
    assert.equal(tool.name.length,64);assert.match(tool.name,/_[0-9a-f]{8}$/);assert.equal(tool.name.startsWith(`mcp__${name}__`),false);assert.ok(harness.session.getAllTools().some(item=>item.name===tool.name));
    harness.fixture.setResponses([fauxAssistantMessage(fauxToolCall(tool.name,{text:'native hashed name'}),{stopReason:'toolUse'}),fauxAssistantMessage('done')]);await harness.session.prompt('invoke native hashed tool name');
    assert.equal(readFileSync(log,'utf8').trim(),'called');assert.equal(approvals,1);
  }finally{await harness.close();rmSync(dir,{recursive:true,force:true});}
});

test('native MCP distinguishes a connected zero-tool server from a failed command',async()=>{
  const dir=temp(),file=join(dir,'mcp.mjs');writeFileSync(file,stdioFixture);const external=createExternalCapabilities({dataDir:dir,cwd:dir,confirm:async()=>true});
  await external.call('mcp.save',{name:'empty',type:'stdio',command:process.execPath,args:[file,'--empty']});await external.call('mcp.save',{name:'missing',type:'stdio',command:join(dir,'does-not-exist')});
  const harness=await sessionFor(dir,external);
  try{const empty=await external.call('mcp.test',{name:'empty'}) as {ok:boolean;tools:unknown[]};assert.equal(empty.ok,true);assert.deepEqual(empty.tools,[]);const failed=await external.call('mcp.test',{name:'missing'}) as {ok:boolean;state:string};assert.equal(failed.ok,false);assert.equal(failed.state,'failed');}
  finally{await harness.close();rmSync(dir,{recursive:true,force:true});}
});

test('native MCP failure stderr is redacted in test receipts and published diagnostics',async()=>{
  const dir=temp(),file=join(dir,'failure.mjs');writeFileSync(file,"process.stderr.write(process.env.TOKEN);process.exit(2);");const snapshots:unknown[]=[],external=createExternalCapabilities({dataDir:dir,cwd:dir,confirm:async()=>true,publish:value=>snapshots.push(value)});
  await external.call('mcp.save',{name:'failure',type:'stdio',command:process.execPath,args:[file],env:{TOKEN:'synthetic-stderr-private-token'}});const harness=await sessionFor(dir,external);
  try{const result=await external.call('mcp.test',{name:'failure'}) as {ok:boolean;diagnostic:string};assert.equal(result.ok,false);assert.ok(!JSON.stringify(result).includes('synthetic-stderr-private-token'));assert.ok(!JSON.stringify(snapshots).includes('synthetic-stderr-private-token'));}
  finally{await harness.close();rmSync(dir,{recursive:true,force:true});}
});

test('Pi extension reload preserves MCP registrations and renews the web cancellation lifetime',async()=>{
  const dir=temp(),file=join(dir,'reload.mjs');writeFileSync(file,stdioFixture);const server=createServer((_req,res)=>res.writeHead(200,{'content-type':'text/plain'}).end('web after extension reload')),base=await listen(server);
  const external=createExternalCapabilities({dataDir:dir,cwd:dir,confirm:async()=>true,network:fixtureNetwork(base)});await external.call('mcp.save',{name:'reload',type:'stdio',command:process.execPath,args:[file,'--empty'],enabled:true});const harness=await sessionFor(dir,external);
  try{assert.equal((await external.call('mcp.test',{name:'reload'}) as {ok:boolean}).ok,true);await harness.session.reload();await harness.session.bindExtensions({mode:'rpc'});assert.equal((await external.call('mcp.test',{name:'reload'}) as {ok:boolean}).ok,true);assert.equal((await external.call('web.fetch',{url:'https://public.example/reload'}) as {content:string}).content,'web after extension reload');}
  finally{await harness.close();await close(server);rmSync(dir,{recursive:true,force:true});}
});

test('native MCP Streamable HTTP discovers schemas and restores a disabled configuration after test',async()=>{
  let calls=0;const server=createServer((req,res)=>{if(req.method!=='POST'){res.writeHead(405).end();return;}let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{const message=JSON.parse(body);if(message.id===undefined){res.writeHead(202).end();return;}let result={};if(message.method==='initialize')result={protocolVersion:message.params.protocolVersion,serverInfo:{name:'http-fixture',version:'1'},capabilities:{tools:{}}};if(message.method==='tools/list')result={tools:[{name:'read',description:'HTTP fixture',inputSchema:{type:'object',properties:{}}}]};if(message.method==='tools/call')calls++;res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));});}),base=await listen(server),dir=temp(),external=createExternalCapabilities({dataDir:dir,cwd:dir,confirm:async()=>true});
  await external.call('mcp.save',{name:'http',type:'http',url:base+'/mcp',headers:{Authorization:'Bearer fake-http-token'}});const harness=await sessionFor(dir,external);
  try{const result=await external.call('mcp.test',{name:'http'}) as {ok:boolean;tools:unknown[]};assert.equal(result.ok,true);assert.equal(result.tools.length,1);assert.equal(calls,0);assert.equal(external.snapshot().servers[0].enabled,false);assert.ok(!JSON.stringify(external.snapshot()).includes('fake-http-token'));}
  finally{await harness.close();await close(server);rmSync(dir,{recursive:true,force:true});}
});
