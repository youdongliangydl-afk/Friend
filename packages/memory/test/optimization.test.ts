import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryController,peekLearningJob,type MemoryRecord,type LearningJob} from '../src/index.js';
import {RecordStore,LearningBudget,CapabilityError,digest,readSourceSpan,type HistoryItem,type PluginContext} from '../../core/src/index.js';
function fixture(){
 const dir=mkdtempSync(join(tmpdir(),'memory-optimization-')),items:HistoryItem[]=[{id:'user1',parentId:null,type:'message',role:'user',timestamp:new Date().toISOString(),text:'开始独立测试。'}],previous=process.env.FRIEND_PI_LEARNING_ROLE;process.env.FRIEND_PI_LEARNING_ROLE='producer';let controller=new MemoryController(),calls=0;
 const ctx:PluginContext={origin:'user',dataDir:dir,projectDir:dir,projectId:'p',sessionId:'s',runId:'r',modelId:'fixture/offline',isIdle:()=>false,history:()=>items,readSource:source=>{const item=items.find(item=>item.id===source.entryId);if(!item)throw new CapabilityError('SOURCE_UNAVAILABLE','来源不存在');readSourceSpan(item,source);return item;},complete:async()=>{calls++;return '{"memories":[]}';},request:async()=>{throw new Error('not installed');},emit:()=>{},notify:()=>{},appendEntry:()=>{}};
 return {dir,items,ctx,get c(){return controller;},calls:()=>calls,reply(proposals:unknown[]){ctx.complete=async()=>{calls++;return JSON.stringify({memories:proposals});};},cold:async()=>{await controller.dispose();controller=new MemoryController();},close:async()=>{await controller.dispose();if(previous===undefined)delete process.env.FRIEND_PI_LEARNING_ROLE;else process.env.FRIEND_PI_LEARNING_ROLE=previous;rmSync(dir,{recursive:true,force:true});}};
}
const proposal=(content:string,extra:Record<string,unknown>={})=>({kind:'fact',title:content,content,sourceEntryIds:['user1'],sourceQuotes:{user1:content},...extra});
async function drain(f:ReturnType<typeof fixture>){for(let i=0;i<40;i++){const job=peekLearningJob(f.dir);if(!job)return;await f.c.executeLearningJob(job.id,f.ctx);}throw new Error('job did not settle');}
const jobs=(f:ReturnType<typeof fixture>)=>(f.c.snapshot(f.ctx).learning as {jobs:(LearningJob&{progress:any;budget:any})[]}).jobs;
const save=(f:ReturnType<typeof fixture>,input:Record<string,unknown>)=>f.c.dispatch('save',{explicitRemember:true,...input},f.ctx) as Promise<MemoryRecord>;

test('25 saved proposals continue from stable IDs after cold restart, in 12-record rounds and one extraction',async()=>{
 const f=fixture();try{const values=Array.from({length:25},(_,i)=>`Distinct fact number ${i}.`);f.items[0].text=values.join('\n');f.reply(values.map(value=>proposal(value)));await f.c.settled(f.ctx);const id=peekLearningJob(f.dir)!.id;
  await f.c.executeLearningJob(id,f.ctx);const initial=jobs(f)[0],ids=initial.proposalLedger!.map(item=>item.id),budgetId=initial.budgetId;
  await f.c.executeLearningJob(id,f.ctx);assert.equal(jobs(f)[0].proposalLedger!.filter(item=>item.state==='validated').length,12);await f.c.executeLearningJob(id,f.ctx);assert.equal(jobs(f)[0].progress.published,12);assert.equal(jobs(f)[0].progress.continuing,true);
  await f.cold();await drain(f);const final=jobs(f)[0];assert.equal(final.state,'completed');assert.equal(final.budgetId,budgetId);assert.deepEqual(final.proposalLedger!.map(item=>item.id),ids);assert.equal(final.progress.published,25);assert.equal(final.progress.sourceFullyProcessed,true);assert.equal(f.calls(),1);assert.equal((f.c.snapshot(f.ctx).memories as MemoryRecord[]).length,25);
 }finally{await f.close();}
});

test('bad fields and fabricated quotes are isolated; later independent proposals publish without another extraction',async()=>{
 const f=fixture();try{f.items[0].text='Good first fact.\nGood second fact.';f.reply([{kind:'made-up'},proposal('Fabricated fact.'),proposal('Good first fact.'),proposal('Good second fact.')]);await f.c.settled(f.ctx);await drain(f);const job=jobs(f)[0];assert.equal(job.progress.rejected,2);assert.equal(job.progress.published,2);assert.ok(job.proposalLedger!.filter(item=>item.state==='rejected').every(item=>item.reason&&item.original));assert.equal(f.calls(),1);assert.equal(job.state,'completed');
 }finally{await f.close();}
});

test('a 13-proposal correction group occupies one round, is committed together, and defers an independent proposal',async()=>{
 const f=fixture();try{const old=await save(f,{title:'project data database original',content:'project data database SQLite'}),child=await save(f,{content:'derived old database guidance',parentIds:[old.id]});const values=Array.from({length:13},(_,i)=>`更正 project data database case${i} PostgreSQL.`),other='Independent surviving fact.';f.items[0].text=[...values,other].join('\n');f.reply([...values.map((value,i)=>proposal(value,{title:`new table case ${i}`,supersedesMemoryIds:[old.id]})),proposal(other)]);await f.c.settled(f.ctx);const id=peekLearningJob(f.dir)!.id;await f.c.executeLearningJob(id,f.ctx);await f.c.executeLearningJob(id,f.ctx);const validated=jobs(f)[0];assert.equal(validated.proposalLedger!.filter(item=>item.state==='validated').length,13);assert.equal(validated.proposalLedger!.at(-1)!.state,'pending');assert.equal((await f.c.dispatch('read',{id:old.id},f.ctx) as MemoryRecord).status,'active');
  await f.c.executeLearningJob(id,f.ctx);assert.equal(jobs(f)[0].progress.published,13);assert.equal((await f.c.dispatch('read',{id:old.id},f.ctx) as MemoryRecord).status,'inactive');assert.equal((await f.c.dispatch('read',{id:child.id},f.ctx) as MemoryRecord).status,'invalidated');await drain(f);assert.equal(jobs(f)[0].progress.published,14);assert.equal(f.calls(),1);
 }finally{await f.close();}
});

test('bad correction fails publication without retiring the old fact; a separate valid proposal still publishes',async()=>{
 const f=fixture();try{const old=await save(f,{title:'project database',content:'project database SQLite'});f.items[0].text='更正 project database PostgreSQL.\nIndependent valid fact.';f.reply([proposal('更正 project database MySQL.',{kind:'experience',title:'project database',sourceQuotes:{user1:'更正 project database PostgreSQL.'},supersedesMemoryIds:[old.id]}),proposal('Independent valid fact.')]);await f.c.settled(f.ctx);const id=peekLearningJob(f.dir)!.id;await f.c.executeLearningJob(id,f.ctx);await f.c.executeLearningJob(id,f.ctx);assert.equal(jobs(f)[0].proposalLedger![0].state,'validated');assert.equal((await f.c.dispatch('read',{id:old.id},f.ctx) as MemoryRecord).revision,1);await drain(f);assert.equal(jobs(f)[0].proposalLedger![0].state,'rejected');assert.equal(jobs(f)[0].progress.published,1);const preserved=await f.c.dispatch('read',{id:old.id},f.ctx) as MemoryRecord;assert.equal(preserved.status,'active');assert.equal(preserved.enabled,true);assert.equal(preserved.revision,1);assert.equal(f.calls(),1);
 }finally{await f.close();}
});

test('all six provider calls exhausted still permits deterministic validation/publication; compact is optional',async()=>{
 const f=fixture();try{for(let i=0;i<3;i++)await save(f,{content:`Existing compact fact ${i}.`,subject:'compact'});f.items[0].text='Already extracted valid fact.';f.reply([proposal(f.items[0].text)]);await f.c.settled(f.ctx);const id=peekLearningJob(f.dir)!.id;await f.c.executeLearningJob(id,f.ctx);const original=jobs(f)[0],store=new RecordStore('runtime',f.dir),budgets=new LearningBudget(store);try{for(let i=0;i<6;i++){const call=budgets.begin({budgetId:original.budgetId!,operationId:`exhaust-${i}`,promptHash:digest(i)});budgets.finish({budgetId:original.budgetId!,operationId:`exhaust-${i}`,callId:call.callId,state:'complete',tokens:1,result:'done'});}}finally{store.close();}
  await f.cold();await drain(f);const final=jobs(f)[0];assert.equal(final.state,'completed');assert.equal(final.progress.published,1);assert.equal(final.budget.calls,6);assert.equal(final.budget.maxCalls,6);assert.match(final.diagnostics!.compactSkipped!,/预算/);assert.equal(final.budgetId,original.budgetId);assert.equal(f.calls(),1);
  await assert.rejects(f.c.executeLearningJob(id,f.ctx,{budgetId:'different-budget'}),{code:'VERSION_CONFLICT'});
 }finally{await f.close();}
});

test('source withdrawal after extraction stops the job and preserves stable proposal identities',async()=>{
 const f=fixture();try{f.items[0].text='A source fact.';f.reply([proposal(f.items[0].text)]);await f.c.settled(f.ctx);const id=peekLearningJob(f.dir)!.id;await f.c.executeLearningJob(id,f.ctx);const ids=jobs(f)[0].proposalLedger!.map(item=>item.id);await f.c.dispatch('source.deleted',{sessionId:'s'},f.ctx);await f.cold();assert.equal(peekLearningJob(f.dir),undefined);const job=jobs(f)[0];assert.equal(job.state,'invalidated');assert.deepEqual(job.proposalLedger!.map(item=>item.id),ids);assert.equal(job.progress.published,0);assert.equal(f.calls(),1);
 }finally{await f.close();}
});

test('long queries protect exact code paths and error codes before unknown filler words; CJK remains searchable',async()=>{
 const f=fixture();try{const target=await save(f,{title:'锁竞争解决',content:'src/storage/database.ts 抛出 ERR_SQLITE_BUSY，需要检查事务。'});await save(f,{title:'普通记录',content:'查看配置说明。'});const query=Array.from({length:60},(_,i)=>`unknown${i}`).join(' ')+' src/storage/database.ts ERR_SQLITE_BUSY 数据库锁竞争';const explained=await f.c.dispatch('search.explain',{query,match:'any'},f.ctx) as any;assert.ok(explained.terms.includes('err_sqlite_busy'));assert.ok(explained.terms.includes('database'));assert.equal(f.c.search({query,match:'any'},f.ctx)[0].id,target.id);assert.equal(f.c.search({query:'锁竞争'},f.ctx)[0].id,target.id);
 }finally{await f.close();}
});

test('applicable explicit long-term preferences take priority, conditions stay whole, and unrelated preferences stay directory-only',async()=>{
 const f=fixture();try{const relevant=await save(f,{title:'项目工作',content:'项目工作应保持验证。'}),preference=await save(f,{kind:'preference',scope:'personal',content:'今后回答保持简洁中文。'}),unrelated=await save(f,{kind:'preference',scope:'personal',content:'我更喜欢淡口的面食。'}),conditional=await save(f,{kind:'preference',scope:'personal',content:'今后输出完整部署说明。',conditions:['仅测试环境']});const selected=f.c.select({query:'项目工作'},f.ctx) as any;assert.equal(selected.records[0].id,preference.id);assert.ok(selected.records.some((record:MemoryRecord)=>record.id===relevant.id));assert.ok(!selected.records.some((record:MemoryRecord)=>[unrelated.id,conditional.id].includes(record.id)));assert.ok(selected.omitted.some((item:any)=>item.id===conditional.id&&item.reason==='preference-applicability-unknown'));const tiny=f.c.select({query:'仅测试环境 部署',budget:10},f.ctx) as any;assert.equal(tiny.records.length,0);assert.ok(tiny.omitted.some((item:any)=>item.id===conditional.id&&item.reason==='body-budget'&&item.conditionsComplete&&item.readRef.revision===conditional.revision));
 }finally{await f.close();}
});

test('impact preview is read-only, binds candidate and descendants, rejects stale input and commits the unchanged preview',async()=>{
 const f=fixture();try{const record=await save(f,{content:'Original precise fact.'}),child=await save(f,{content:'Derived precise fact.',parentIds:[record.id]});const patch={content:'Corrected precise fact.'};const before=readFileSync(join(f.dir,'plugins.sqlite')),preview=await f.c.dispatch('impact.preview',{action:'update',id:record.id,patch},f.ctx) as any;assert.deepEqual(readFileSync(join(f.dir,'plugins.sqlite')),before);assert.equal(preview.affected.length,2);assert.ok(preview.affected.some((item:any)=>item.id===child.id));await assert.rejects(f.c.dispatch('update',{id:record.id,revision:1,patch:{content:'Different fact.'},previewToken:preview.previewToken},f.ctx),{code:'VERSION_CONFLICT'});const changed=await f.c.dispatch('update',{id:record.id,revision:1,patch,previewToken:preview.previewToken},f.ctx) as MemoryRecord;assert.equal(changed.content,patch.content);const forgetting=await f.c.dispatch('impact.preview',{action:'forget',id:record.id},f.ctx) as any;await f.c.dispatch('update',{id:record.id,revision:changed.revision,title:'Changed title'},f.ctx);await assert.rejects(f.c.dispatch('forget',{id:record.id,revision:changed.revision,previewToken:forgetting.previewToken},f.ctx),{code:'VERSION_CONFLICT'});await assert.rejects(f.c.dispatch('impact.preview',{action:'forget',id:record.id},{...f.ctx,origin:'agent'}),{code:'PERMISSION_DENIED'});
 }finally{await f.close();}
});

test('durable proposal migration takes a backup and fences writer-three clients while preserving read access',async()=>{
 const f=fixture();try{f.items[0].text='Migration stable fact.';f.reply([proposal(f.items[0].text)]);await f.c.settled(f.ctx);const id=peekLearningJob(f.dir)!.id;await f.c.executeLearningJob(id,f.ctx);const {DatabaseSync}=await import('node:sqlite'),{readdirSync}=await import('node:fs');const old=new DatabaseSync(join(f.dir,'plugins.sqlite'));try{old.function('friend_pi_writer_version',{deterministic:true},()=>3);const row=old.prepare('SELECT json FROM memory_jobs WHERE id=?').get(id)!;assert.ok(JSON.parse(String(row.json)).proposalLedger[0].original);assert.throws(()=>old.prepare('UPDATE memory_jobs SET json=? WHERE id=?').run(row.json,id),/requires a newer writer/);assert.throws(()=>old.prepare("INSERT INTO documents(namespace,key,revision,json) VALUES('memory','old-client',1,'{}')").run(),/requires a newer writer/);}finally{old.close();}assert.ok(readdirSync(join(f.dir,'memory-migration-backups')).some(file=>file.startsWith('before-v3-')));await f.cold();await drain(f);assert.equal(f.calls(),1);assert.equal(jobs(f)[0].progress.published,1);
 }finally{await f.close();}
});

test('forget scrubs original proposal payloads in current state and managed backups, keeping only rejection identity',async()=>{
 const f=fixture();try{const secretBody='FORGET_PROPOSAL_UNIQUE_CONTENT_42.';f.items[0].text=secretBody;f.reply([proposal(secretBody)]);await f.c.settled(f.ctx);await drain(f);const record=(f.c.snapshot(f.ctx).memories as MemoryRecord[])[0],ledgerId=jobs(f)[0].proposalLedger![0].id,store=new RecordStore('memory',f.dir),backup=join(f.dir,'memory-migration-backups','ledger-snapshot.sqlite');store.db.prepare('VACUUM INTO ?').run(backup);store.close();await f.c.dispatch('forget',{id:record.id,revision:record.revision},f.ctx);const after=jobs(f)[0].proposalLedger![0];assert.equal(after.id,ledgerId);assert.equal(after.state,'rejected');assert.ok(!JSON.stringify(after.original).includes(secretBody));const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(backup);try{assert.ok(!String(db.prepare('SELECT json FROM memory_jobs').get()!.json).includes(secretBody));}finally{db.close();}await f.cold();assert.equal(peekLearningJob(f.dir),undefined);assert.equal(f.calls(),1);
 }finally{await f.close();}
});

test('model original-source tracing rejects unregistered references and a forgotten source',async()=>{
 const f=fixture();try{f.items[0].text='Registered fact.\nOther native text.';const source={sessionId:'s',entryId:'user1',start:0,end:16,hash:digest('Registered fact.')},record=await save(f,{content:'Registered fact.',sources:[source]});const model={...f.ctx,origin:'agent' as const};assert.equal((await f.c.dispatch('source.read',{source},model) as any).text,'Registered fact.');await assert.rejects(f.c.dispatch('source.read',{source:{sessionId:'s',entryId:'user1',start:17,end:f.items[0].text.length}},model),{code:'SOURCE_UNAVAILABLE'});await f.c.dispatch('forget',{id:record.id,revision:record.revision},f.ctx);await assert.rejects(f.c.dispatch('source.read',{source},model),{code:'SOURCE_UNAVAILABLE'});
 }finally{await f.close();}
});

test('a changed descendant or changed source invalidates a previously read-only impact preview',async()=>{
 const f=fixture();try{f.items[0].text='Original sourced fact.';const record=await save(f,{content:f.items[0].text,sources:[{sessionId:'s',entryId:'user1'}]}),child=await save(f,{content:'Derived body.',parentIds:[record.id]}),patch={content:'Corrected body.'},preview=await f.c.dispatch('impact.preview',{action:'update',id:record.id,patch},f.ctx) as any;await f.c.dispatch('update',{id:child.id,revision:child.revision,title:'Changed child'},f.ctx);await assert.rejects(f.c.dispatch('update',{id:record.id,revision:record.revision,patch,previewToken:preview.previewToken},f.ctx),{code:'VERSION_CONFLICT'});const refreshed=await f.c.dispatch('impact.preview',{action:'update',id:record.id,patch},f.ctx) as any;f.items[0].text='Native source bytes changed.';await assert.rejects(f.c.dispatch('update',{id:record.id,revision:record.revision,patch,previewToken:refreshed.previewToken},f.ctx),{code:'VERSION_CONFLICT'});
 }finally{await f.close();}
});

test('a preference stated only for this task stays a candidate; explicit future scope can publish it',async()=>{
 const f=fixture();try{f.items[0].text='这次我偏好中文回答。';f.reply([proposal(f.items[0].text,{kind:'preference'})]);await f.c.settled(f.ctx);await drain(f);assert.equal((f.c.snapshot(f.ctx).memories as MemoryRecord[]).length,0);f.items.push({id:'later',parentId:'user1',type:'message',role:'user',timestamp:new Date().toISOString(),text:'今后默认偏好中文回答。'});f.reply([proposal('今后默认偏好中文回答。',{kind:'preference',sourceEntryIds:['later'],sourceQuotes:{later:'今后默认偏好中文回答。'}})]);await f.c.settled(f.ctx);await drain(f);assert.equal((f.c.snapshot(f.ctx).memories as MemoryRecord[]).filter(item=>item.status==='active').length,1);
 }finally{await f.close();}
});


test('held candidates cannot bypass effective-source tracing through read or read.range',async()=>{
 const f=fixture();try{f.items[0].text='Quoted source fact.';f.reply([proposal('Unsupported affirmative claim.',{sourceQuotes:{user1:f.items[0].text}})]);await f.c.settled(f.ctx);await drain(f);const record=(f.c.snapshot(f.ctx).candidates as MemoryRecord[])[0],agent={...f.ctx,origin:'agent' as const};assert.ok(record);await assert.rejects(f.c.dispatch('read',{id:record.id,source:true},agent),{code:'SOURCE_UNAVAILABLE'});await assert.rejects(f.c.dispatch('read.range',{id:record.id,revision:record.revision},agent),{code:'SOURCE_UNAVAILABLE'});assert.equal((await f.c.dispatch('read',{id:record.id},f.ctx) as MemoryRecord).status,'candidate');
 }finally{await f.close();}
});
