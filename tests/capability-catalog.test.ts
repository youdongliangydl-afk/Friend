import test from 'node:test';
import assert from 'node:assert/strict';
import type {ExternalCapabilitiesSnapshot} from '../apps/desktop/src/external-capabilities.js';
import {capabilityCatalog,capabilityCounts,capabilityProblems,mcpSection,pluginSection,referenceEntries} from '../apps/desktop/src/renderer/capability-catalog.js';
type Server=ExternalCapabilitiesSnapshot['servers'][number];
const tool:Server['tools'][number]={name:'mcp__docs__read',label:'读取',description:'',parameters:{},readOnly:true,available:true};
const server=(changes:Partial<Server>={}):Server=>({name:'docs',type:'stdio',enabled:true,command:'npx',args:[],envNames:[],headerNames:[],state:'connected',tools:[tool],...changes});
const snapshot=(servers:Server[]):ExternalCapabilitiesSnapshot=>({v:1,revision:1,servers,web:{provider:'brave',enabled:false,configured:false,fetchAvailable:true,source:'https://api-dashboard.search.brave.com/app/documentation/web-search/query'}});
const section=(value:ReturnType<typeof capabilityCatalog>,kind:string)=>value.sections.find(item=>item.kind===kind)!;
test('reference list normalisation trusts ids and skips unknown entries without inventing names',()=>{
  const parsed=referenceEntries([{id:'skill:review',label:'review · 代码审查要点',kind:'Skill',insert:'/skill:review'},{id:'command:compact',label:'compact · 压缩上下文',kind:'命令',insert:'/compact'},{id:'command:swarm',label:'swarm',kind:'命令',insert:'/swarm'},{id:'command:swarm',label:'重复不应重复计数',kind:'命令',insert:'/swarm'},{id:'unknown',label:'x',kind:'未知',insert:'x'},{label:'没有 id'}]);
  assert.deepEqual(parsed.skills.map(item=>[item.name,item.description]),[['review','代码审查要点']]);
  assert.deepEqual(parsed.slash.map(item=>[item.name,item.description]),[['compact','压缩上下文'],['swarm','']]);
  assert.equal(parsed.slash[1].description,'');
  assert.deepEqual(referenceEntries(undefined),{skills:[],slash:[]});
});
test('Skills and Slash sections state their source and explain empty or failed reads instead of listing examples',()=>{
  const empty=capabilityCatalog({references:{loading:true}});
  assert.match(section(empty,'skill').emptyReason||'',/正在读取/);
  const loaded=capabilityCatalog({references:{items:[{id:'command:compact',label:'compact · 压缩上下文',kind:'命令',insert:'/compact'}]}});
  assert.equal(section(loaded,'slash').entries.length,1);
  assert.equal(section(loaded,'skill').emptyReason?.includes('/skill'),true);
  assert.equal(section(loaded,'slash').source,'Pi 扩展命令注册表');
  const failed=capabilityCatalog({references:{error:'会话运行时已退出'}});
  assert.deepEqual(section(failed,'skill').entries,[]);
  assert.match(section(failed,'skill').emptyReason||'',/无法读取.*会话运行时已退出/);
  assert.match(section(failed,'slash').emptyReason||'',/无法读取/);
});
test('plugin states separate default configuration from session enablement and runtime readiness',()=>{
  const onlyDefaults=pluginSection({enabled:[],defaults:['memory']});
  assert.deepEqual(onlyDefaults.entries.map(entry=>[entry.name,entry.configured,entry.loaded,entry.available]),[['Memory',true,false,false]]);
  assert.match(onlyDefaults.entries[0].reason||'',/默认启用/);
  const notReady=pluginSection({enabled:['swarm','expert'],defaults:['swarm'],runtimeReady:false});
  assert.deepEqual(notReady.entries.map(entry=>[entry.name,entry.configured,entry.loaded,entry.available]),[['Swarm',true,true,false],['Expert',true,true,false]]);
  assert.match(notReady.entries[0].reason||'',/运行时未就绪/);
  const ready=pluginSection({enabled:['swarm','custom-plugin'],defaults:['memory']});
  assert.deepEqual(ready.entries.map(entry=>[entry.name,entry.loaded,entry.available]),[['Swarm',true,true],['custom-plugin',true,true],['Memory',false,false]]);
  assert.match(ready.entries[1].description,/未登记说明/);
  const absent=pluginSection(undefined);
  assert.deepEqual(absent.entries,[]);
  assert.match(absent.emptyReason||'',/不猜测/);
  assert.match(pluginSection({enabled:[],defaults:[]}).emptyReason||'',/都没有启用插件/);
});
test('MCP three states follow enabled, connection and tool availability with per-server reasons',()=>{
  const catalog=capabilityCatalog({mcp:{snapshot:snapshot([
    server({name:'ready'}),
    server({name:'no-tools',tools:[]}),
    server({name:'hidden-tools',tools:[{name:'t',label:'t',description:'',parameters:{},readOnly:false,available:false}]}),
    server({name:'failed',state:'failed',diagnostic:'spawn npx ENOENT'}),
    server({name:'auth',state:'needs-auth',enabled:true,diagnostic:'401'}),
    server({name:'off',enabled:false,state:'disabled'}),
    server({name:'connecting',state:'connecting'}),
  ])}});
  const entries=new Map(section(catalog,'mcp').entries.map(entry=>[entry.name,entry]));
  assert.deepEqual(['ready','no-tools','hidden-tools','failed','auth','off','connecting'].map(name=>{const entry=entries.get(name)!;return [name,entry.configured,entry.loaded,entry.available];}),[
    ['ready',true,true,true],['no-tools',true,true,false],['hidden-tools',true,true,false],['failed',true,false,false],['auth',true,false,false],['off',true,false,false],['connecting',true,false,false],
  ]);
  assert.match(entries.get('no-tools')!.reason||'',/没有提供可用工具/);
  assert.match(entries.get('failed')!.reason||'',/连接失败.*ENOENT/);
  assert.match(entries.get('auth')!.reason||'',/需要认证.*401/);
  assert.match(entries.get('off')!.reason||'',/已停用/);
  assert.match(entries.get('connecting')!.reason||'',/正在连接/);
  assert.equal(entries.get('ready')!.reason,undefined);
  assert.match(entries.get('no-tools')!.description,/0 个工具/);
});
test('an unreadable or empty MCP config is an honest empty state, never a fabricated service',()=>{
  assert.deepEqual(mcpSection({error:'配置文件损坏'}).entries,[]);
  assert.match(mcpSection({error:'配置文件损坏'}).emptyReason||'',/无法读取 MCP 配置.*配置文件损坏/);
  assert.deepEqual(mcpSection({snapshot:snapshot([])}).entries,[]);
  assert.match(mcpSection({snapshot:snapshot([])}).emptyReason||'',/尚未保存任何 MCP 服务/);
  assert.match(mcpSection({loading:true}).emptyReason||'',/正在读取/);
  assert.match(mcpSection(undefined).emptyReason||'',/尚未读取/);
});
test('the catalog keeps Skills, Plugins, MCP and Slash ordered, counts each state and reports only explicit problems',()=>{
  const catalog=capabilityCatalog({
    plugins:{enabled:['swarm'],defaults:['swarm','memory'],runtimeReady:true},
    mcp:{snapshot:snapshot([server(),server({name:'off',enabled:false,state:'disabled'})])},
    references:{items:[{id:'skill:a',label:'a · 甲',kind:'Skill',insert:'/skill:a'},{id:'command:b',label:'b · 乙',kind:'命令',insert:'/b'}]},
  });
  assert.deepEqual(catalog.sections.map(item=>item.kind),['skill','plugin','mcp','slash']);
  assert.deepEqual(capabilityCounts(section(catalog,'plugin')),{entries:2,configured:2,loaded:1,available:1});
  assert.deepEqual(catalog.counts.skill,{entries:1,configured:1,loaded:1,available:1});
  assert.deepEqual(capabilityCounts(section(catalog,'mcp')),{entries:2,configured:2,loaded:1,available:1});
  const problems=capabilityProblems(catalog);
  assert.deepEqual(problems.map(problem=>problem.name).sort(),['Memory','off']);
  assert.ok(problems.every(problem=>problem.reason.length>0));
  const bare=capabilityCatalog();
  assert.equal(bare.sections.every(item=>item.entries.length===0&&!!item.emptyReason),true);
  assert.deepEqual(capabilityProblems(bare),[]);
});
