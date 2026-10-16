import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ModelRuntime,DefaultResourceLoader,SettingsManager,SessionManager,createAgentSession,createEventBus,initTheme} from '@earendil-works/pi-coding-agent';
import swarm from '../packages/swarm/src/index.js';
import expert from '../packages/expert/src/index.js';
import memory from '../packages/memory/src/index.js';
import rebuild from '../packages/topic-rebuild/src/index.js';
import {installFixtureProvider,requestPlugin} from '../packages/core/src/index.js';

test('all 15 nonempty native plugin combinations load, serve controllers and retain sole Pi history',{timeout:180000},async()=>{
 const plugins=[{id:'swarm',extension:swarm},{id:'expert',extension:expert},{id:'memory',extension:memory},{id:'topic-rebuild',extension:rebuild}];
 const previous=process.env.FRIEND_PI_DATA_DIR;initTheme('light',false);
 try{for(let mask=1;mask<16;mask++){
  const dir=mkdtempSync(join(tmpdir(),'friend-combination-')),bus=createEventBus(),selected=plugins.filter((_,index)=>mask&(1<<index));process.env.FRIEND_PI_DATA_DIR=join(dir,'data');
  let session:Awaited<ReturnType<typeof createAgentSession>>['session']|undefined;
  try{
   const runtime=await ModelRuntime.create({authPath:join(dir,'agent/auth.json'),modelsPath:join(dir,'agent/models.json'),allowModelNetwork:false});await installFixtureProvider(runtime);
   const settings=SettingsManager.inMemory({packages:[],extensions:[],compaction:{enabled:false}});
   const loader=new DefaultResourceLoader({cwd:dir,agentDir:join(dir,'agent'),settingsManager:settings,noSkills:true,noPromptTemplates:true,noThemes:true,eventBus:bus,extensionFactories:selected.map(plugin=>plugin.extension)});
   await loader.reload({resolveProjectTrust:async()=>true});
   const created=await createAgentSession({cwd:dir,agentDir:join(dir,'agent'),modelRuntime:runtime,model:runtime.getModel('friend-fixture','offline')!,settingsManager:settings,resourceLoader:loader,sessionManager:SessionManager.create(dir,join(dir,'sessions'))});session=created.session;
   assert.deepEqual(created.extensionsResult.errors,[],selected.map(plugin=>plugin.id).join('+'));await session.bindExtensions({mode:'json'});
   const call=(plugin:string,action:string,input:Record<string,unknown>={})=>requestPlugin(bus,plugin,action,input,3000,'user');
   for(const plugin of selected)assert.equal(typeof await call(plugin.id,'snapshot'),'object');
   if(mask&2){const profile=await call('expert','profile.create',{title:'组合检查',prompt:'保留用户目标',toolsMode:'allowlist',tools:[]}) as {id:string};let changes=0;const off=bus.on('friend-pi:v1:event',raw=>{if((raw as {pluginEvent?:string}).pluginEvent==='expert.changed')changes++;});await call('expert','profile.list',{query:'',limit:20});await call('expert','profile.read',{id:profile.id});assert.equal(changes,0,'directory reads must not trigger their own GUI refresh');off();const frozen=await call('expert','spawn.resolve',{expertId:profile.id}) as {prompt:string;tools:string[]};assert.equal(frozen.prompt,'保留用户目标');assert.deepEqual(frozen.tools,[]);}
   await session.prompt('组合冒烟：必须保留原始文件。请用中文确认已读取当前目标。');
   if(mask&4){await call('memory','save',{title:'组合约束',content:'保留中文字段',conditions:['仅适用于当前项目'],scope:'project',explicitRemember:true});assert.match(JSON.stringify(await call('memory','search',{query:'中文字段',taskContext:{goal:'保留中文字段'}})),/中文字段/);}
   if(mask&8)assert.equal(typeof await call('topic-rebuild','timeline'),'object');
   if(mask&1){const graph=await call('swarm','create',{goal:'组合只读检查',executionPolicy:{v:1,workspace:'shared',dirtyBaseline:'snapshot',review:'none'},tasks:[{id:'inspect',title:'检查',prompt:'只读当前项目',mode:'read',dependencies:[]}]}) as {id:string};assert.ok(graph.id);}
   assert.ok(session.sessionFile);assert.match(readFileSync(session.sessionFile,'utf8'),/组合冒烟/);
  }finally{if(session){await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});session.dispose();}bus.clear();rmSync(dir,{recursive:true,force:true});}
 }}finally{if(previous===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=previous;}
});
