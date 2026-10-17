/**
 * Swarm v2 roster tests — invariants I1 (identity reserved), I2 (fixed
 * identity fields), I3 (admit only after first native entry persisted),
 * I8 (generation fence), I9 (per-object stop receipts), I10 (unknown objects
 * pause the team) and I15 (journal authority for every mutation).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CapabilityError,ConflictError,RecordStore} from '@friend-pi/core';
import {V2Store,v2Now} from '../../src/v2/store.js';
import {
  IMMUTABLE_MEMBER_FIELDS,StaleGenerationError,admitMember,assertGeneration,getMember,listMembers,
  markMemberFailed,provisionMember,stopMember,updateMember,
  type ProvisionMemberInput,
} from '../../src/v2/roster.js';

const TEAM='team-1';

function addTeam(store:RecordStore,teamId:string,status='running'):void{
  store.db.prepare('INSERT INTO swarm_v2_teams(team_id,project_id,root_session_id,workspace_root,status,autonomy_level,policy_json,revision,rework_round,failure_fingerprints_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(teamId,`project-${teamId}`,'root-session','/tmp/workspace',status,1,'{}',1,0,'[]',v2Now(),v2Now());
}

function fixture():{dir:string;store:RecordStore;v2:V2Store;addTeam:(teamId:string)=>void;close:()=>void}{
  const dir=mkdtempSync(join(tmpdir(),'swarm-v2-roster-'));
  const store=new RecordStore('swarm',dir);
  const v2=V2Store.open(store);
  addTeam(store,TEAM);
  return {
    dir,store,v2,
    addTeam:(teamId:string)=>{addTeam(store,teamId);},
    close:()=>{store.close();rmSync(dir,{recursive:true,force:true});},
  };
}

function memberInput(overrides:Partial<ProvisionMemberInput>={}):ProvisionMemberInput{
  return {teamId:TEAM,name:'alice',role:'worker',contextMode:'fresh',...overrides};
}

function code(error:unknown):unknown{return (error as {code?:unknown})?.code;}

function validationError(pattern?:RegExp):(error:unknown)=>boolean{
  return error=>error instanceof CapabilityError&&error.code==='VALIDATION_ERROR'&&(!pattern||pattern.test(error.message));
}

function admitted(f:ReturnType<typeof fixture>,name:string,generation?:number):string{
  const member=provisionMember(f.store,memberInput({name}));
  admitMember(f.store,member.memberId,{firstEntryId:`entry-${name}`,firstEntryPersisted:true,...(generation===undefined?{}:{generation})});
  return member.memberId;
}

test('provision creates a durable provisioning member with reserved identity and a journal event',()=>{
  const f=fixture();
  try{
    const member=provisionMember(f.store,memberInput({writeScopes:['src','docs'],capabilities:['claim','deliver'],modelRef:'fixture/offline'}));
    assert.equal(member.phase,'provisioning');
    assert.equal(member.status,'idle');
    assert.equal(member.generation,0);
    assert.equal(member.revision,1);
    assert.equal(member.teamId,TEAM);
    assert.equal(member.name,'alice');
    assert.equal(member.role,'worker');
    assert.equal(member.contextMode,'fresh');
    assert.equal(member.modelRef,'fixture/offline');
    assert.equal(member.memberPath,'members/alice');
    assert.deepEqual(member.writeScopes,['src','docs']);
    assert.deepEqual(member.capability,{capabilities:['claim','deliver']});
    assert.equal(member.sessionId,null);
    assert.equal(member.leaseExpiresAt,null);
    assert.ok(Date.parse(member.createdAt)>0);
    assert.deepEqual(getMember(f.store,member.memberId),member);
    const events=f.v2.events(TEAM);
    assert.equal(events.length,1);
    assert.equal(events[0].type,'member.provisioned');
    assert.equal(events[0].aggregate.kind,'member');
    assert.equal(events[0].aggregate.id,member.memberId);
    assert.equal(events[0].aggregate.revision,1);
    assert.equal(events[0].data.name,'alice');
    assert.equal(events[0].data.generation,0);
  }finally{f.close();}
});

test('duplicate names are rejected even for a different role and write nothing',()=>{
  const f=fixture();
  try{
    provisionMember(f.store,memberInput());
    assert.throws(()=>provisionMember(f.store,memberInput({role:'reviewer'})),validationError(/名称已被占用/));
    const rows=f.v2.rows<{n:number}>('SELECT COUNT(*) AS n FROM swarm_v2_members');
    assert.equal(rows[0].n,1);
    assert.equal(f.v2.events(TEAM).length,1);
  }finally{f.close();}
});

test('failed and stopped names stay reserved for the team',()=>{
  const f=fixture();
  try{
    const failed=provisionMember(f.store,memberInput({name:'failed-one'}));
    markMemberFailed(f.store,failed.memberId,'native session never started');
    assert.throws(()=>provisionMember(f.store,memberInput({name:'failed-one'})),validationError(/名称已被占用/));
    assert.equal(getMember(f.store,failed.memberId)?.phase,'failed');
    const stopped=admitted(f,'stopped-one');
    stopMember(f.store,stopped,[{id:'session',kind:'session',status:'terminated'}]);
    assert.throws(()=>provisionMember(f.store,memberInput({name:'stopped-one'})),validationError(/名称已被占用/));
  }finally{f.close();}
});

test('memberPath is unique per team; the same name/path is allowed in another team',()=>{
  const f=fixture();
  try{
    provisionMember(f.store,memberInput({name:'alice',memberPath:'members/shared'}));
    assert.throws(()=>provisionMember(f.store,memberInput({name:'bob',memberPath:'members/shared'})),validationError(/路径已被占用/));
    f.addTeam('team-2');
    const other=provisionMember(f.store,memberInput({teamId:'team-2',name:'alice',memberPath:'members/shared'}));
    assert.equal(other.teamId,'team-2');
    assert.equal(listMembers(f.store,'team-2').length,1);
  }finally{f.close();}
});

test('I3: admit rejects when the first native entry is not persisted and leaves the member provisioning',()=>{
  const f=fixture();
  try{
    const member=provisionMember(f.store,memberInput());
    assert.throws(()=>admitMember(f.store,member.memberId,{firstEntryId:'entry-1',firstEntryPersisted:false}),validationError(/I3/));
    assert.throws(()=>admitMember(f.store,member.memberId,{firstEntryId:'entry-1',firstEntryPersisted:undefined as unknown as boolean}),validationError(/I3/));
    const stored=getMember(f.store,member.memberId)!;
    assert.equal(stored.phase,'provisioning');
    assert.equal(stored.revision,1);
    assert.equal(f.v2.events(TEAM).filter(event=>event.type==='member.admitted').length,0);
  }finally{f.close();}
});

test('admit promotes provisioning -> active with idle status and journals the persisted entry',()=>{
  const f=fixture();
  try{
    const member=provisionMember(f.store,memberInput());
    const active=admitMember(f.store,member.memberId,{firstEntryId:'entry-1',firstEntryPersisted:true});
    assert.equal(active.phase,'active');
    assert.equal(active.status,'idle');
    assert.equal(active.generation,0);
    assert.equal(active.revision,2);
    const events=f.v2.events(TEAM);
    assert.deepEqual(events.map(event=>event.type),['member.provisioned','member.admitted']);
    assert.equal(events[1].aggregate.revision,2);
    assert.equal(events[1].data.firstEntryId,'entry-1');
    assert.equal(events[1].data.firstEntryPersisted,true);
  }finally{f.close();}
});

test('admit and markMemberFailed only work in provisioning; other phases are rejected',()=>{
  const f=fixture();
  try{
    const member=provisionMember(f.store,memberInput());
    admitMember(f.store,member.memberId,{firstEntryId:'entry-1',firstEntryPersisted:true});
    assert.throws(()=>admitMember(f.store,member.memberId,{firstEntryId:'entry-2',firstEntryPersisted:true}),validationError(/仅 provisioning/));
    assert.throws(()=>markMemberFailed(f.store,member.memberId,'late failure'),validationError(/仅 provisioning/));
    const failed=provisionMember(f.store,memberInput({name:'failed-one'}));
    markMemberFailed(f.store,failed.memberId,'boom');
    assert.throws(()=>admitMember(f.store,failed.memberId,{firstEntryId:'entry-1',firstEntryPersisted:true}),validationError(/仅 provisioning/));
  }finally{f.close();}
});

test('I8: generation advances on admit and late writes with an older generation are fenced as STALE_GENERATION',()=>{
  const f=fixture();
  try{
    const member=provisionMember(f.store,memberInput());
    const active=admitMember(f.store,member.memberId,{firstEntryId:'entry-1',firstEntryPersisted:true,generation:1});
    assert.equal(active.generation,1);
    assert.equal(assertGeneration(f.store,member.memberId,1).memberId,member.memberId);
    assert.throws(()=>assertGeneration(f.store,member.memberId,0),error=>{
      assert.ok(error instanceof StaleGenerationError);
      assert.ok(error instanceof CapabilityError);
      assert.equal(code(error),'STALE_GENERATION');
      assert.equal(error.expectedGeneration,0);
      assert.equal(error.actualGeneration,1);
      assert.equal((error as CapabilityError).details?.code,'STALE_GENERATION');
      return true;
    });
    assert.throws(()=>assertGeneration(f.store,member.memberId,-1),validationError(/generation/));
    assert.throws(()=>assertGeneration(f.store,'missing-member',1),validationError(/成员不存在/));
  }finally{f.close();}
});

test('markMemberFailed records the phase transition, reason and journal, and keeps the row',()=>{
  const f=fixture();
  try{
    const member=provisionMember(f.store,memberInput());
    const failed=markMemberFailed(f.store,member.memberId,'native session failed before first entry');
    assert.equal(failed.phase,'failed');
    assert.equal(failed.status,'idle');
    assert.equal(failed.revision,2);
    const events=f.v2.events(TEAM);
    assert.equal(events[1].type,'member.failed');
    assert.equal(events[1].data.reason,'native session failed before first entry');
    assert.deepEqual(listMembers(f.store,TEAM).map(item=>item.memberId),[member.memberId]);
    assert.throws(()=>markMemberFailed(f.store,member.memberId,'again'),validationError(/仅 provisioning/));
  }finally{f.close();}
});

test('I9: stop with all objects terminated completes the receipt and stops the member',()=>{
  const f=fixture();
  try{
    const memberId=admitted(f,'alice');
    const receipt=stopMember(f.store,memberId,[
      {id:'native-session-1',kind:'session',status:'terminated'},
      {id:'lease-1',kind:'lease',status:'terminated'},
    ]);
    assert.equal(receipt.status,'complete');
    assert.equal(receipt.teamId,TEAM);
    assert.equal(receipt.scopeKind,'member');
    assert.equal(receipt.scopeId,memberId);
    assert.deepEqual(receipt.objects.map(item=>item.status),['terminated','terminated']);
    const member=getMember(f.store,memberId)!;
    assert.equal(member.phase,'stopped');
    assert.equal(member.status,'stopped');
    assert.equal(member.revision,3);
    const stored=f.v2.row<{objects_json:string;status:string;scope_kind:string}>('SELECT objects_json,status,scope_kind FROM swarm_v2_stop_receipts WHERE receipt_id=?',receipt.receiptId)!;
    assert.equal(stored.status,'complete');
    assert.equal(stored.scope_kind,'member');
    assert.deepEqual(JSON.parse(stored.objects_json),receipt.objects);
    const event=f.v2.events(TEAM).at(-1)!;
    assert.equal(event.type,'member.stopped');
    assert.equal(event.data.receiptId,receipt.receiptId);
    assert.equal(event.data.teamPaused,false);
  }finally{f.close();}
});

test('I10: one unknown stop object yields an unknown receipt, an unknown member and a paused team',()=>{
  const f=fixture();
  try{
    const memberId=admitted(f,'alice');
    const receipt=stopMember(f.store,memberId,[
      {id:'native-session-1',kind:'session',status:'terminated'},
      {id:'unknown-lease',kind:'lease',status:'unknown'},
    ]);
    assert.equal(receipt.status,'unknown');
    const member=getMember(f.store,memberId)!;
    assert.equal(member.status,'unknown');
    assert.equal(member.phase,'active');
    assert.equal(member.revision,3);
    const team=f.v2.row<{status:string;revision:number}>('SELECT status,revision FROM swarm_v2_teams WHERE team_id=?',TEAM)!;
    assert.equal(team.status,'paused');
    assert.equal(team.revision,2);
    const event=f.v2.events(TEAM).at(-1)!;
    assert.equal(event.type,'member.stop_unknown');
    assert.equal(event.data.teamPaused,true);
    // A follow-up stop that proves every object terminated can still complete.
    const retry=stopMember(f.store,memberId,[{id:'unknown-lease',kind:'lease',status:'terminated'}]);
    assert.equal(retry.status,'complete');
    assert.equal(getMember(f.store,memberId)?.status,'stopped');
  }finally{f.close();}
});

test('stop validates objects, rejects duplicates and refuses to stop an already stopped member',()=>{
  const f=fixture();
  try{
    const memberId=admitted(f,'alice');
    assert.throws(()=>stopMember(f.store,memberId,{} as never),validationError(/有界数组/));
    assert.throws(()=>stopMember(f.store,memberId,[{id:'a',kind:'session',status:'booted' as never}]),validationError(/terminated 或 unknown/));
    assert.throws(()=>stopMember(f.store,memberId,[{id:'a',kind:'session',status:'terminated'},{id:'a',kind:'session',status:'terminated'}]),validationError(/重复/));
    assert.throws(()=>stopMember(f.store,memberId,[{id:'',kind:'session',status:'terminated'}]),validationError(/不能为空/));
    assert.throws(()=>stopMember(f.store,memberId,[]),validationError(/非空有界数组/));
    const completed=stopMember(f.store,memberId,[{id:'a',kind:'session',status:'terminated'}]);
    assert.equal(completed.status,'complete');
    assert.equal(completed.objects.length,1);
    assert.throws(()=>stopMember(f.store,memberId,[{id:'b',kind:'session',status:'terminated'}]),validationError(/已停止/));
  }finally{f.close();}
});

test('updateMember only mutates runtime metadata with CAS and journals the change',()=>{
  const f=fixture();
  try{
    const member=provisionMember(f.store,memberInput());
    const updated=updateMember(f.store,member.memberId,1,{writeScopes:['src/api'],sessionId:'native-session-9',leaseExpiresAt:'2099-01-01T00:00:00.000Z'});
    assert.deepEqual(updated.writeScopes,['src/api']);
    assert.equal(updated.sessionId,'native-session-9');
    assert.equal(updated.leaseExpiresAt,'2099-01-01T00:00:00.000Z');
    assert.equal(updated.revision,2);
    assert.deepEqual(getMember(f.store,member.memberId),updated);
    assert.equal(f.v2.events(TEAM).at(-1)?.type,'member.updated');
    assert.throws(()=>updateMember(f.store,member.memberId,1,{sessionId:'stale'}),ConflictError);
    assert.throws(()=>updateMember(f.store,member.memberId,0,{sessionId:'stale'}),validationError(/expectedRevision/));
  }finally{f.close();}
});

test('I2: name/role/modelRef/contextMode/memberPath/generation are immutable through updates',()=>{
  const f=fixture();
  try{
    const member=provisionMember(f.store,memberInput({modelRef:'fixture/offline'}));
    const replacements:Record<string,unknown>={name:'bob',role:'reviewer',modelRef:'other/model',contextMode:'fork',memberPath:'members/bob',generation:9};
    for(const field of IMMUTABLE_MEMBER_FIELDS){
      const patch={[field]:replacements[field]} as never;
      assert.throws(()=>updateMember(f.store,member.memberId,1,patch),validationError(new RegExp(`字段 ${field} 不可变`)),field);
    }
    assert.throws(()=>updateMember(f.store,member.memberId,1,{unknownField:true} as never),validationError(/未知成员字段/));
    assert.throws(()=>updateMember(f.store,member.memberId,1,{}),validationError(/没有可更新字段/));
    const unchanged=getMember(f.store,member.memberId)!;
    assert.deepEqual(unchanged,member);
  }finally{f.close();}
});

test('provision validates team, role, context mode, member path and bounded metadata',()=>{
  const f=fixture();
  try{
    assert.throws(()=>provisionMember(f.store,memberInput({teamId:'missing-team'})),validationError(/团队不存在/));
    assert.throws(()=>provisionMember(f.store,memberInput({role:'ruler'})),validationError(/角色无效/));
    assert.throws(()=>provisionMember(f.store,memberInput({contextMode:'sideways'})),validationError(/contextMode 无效/));
    assert.throws(()=>provisionMember(f.store,memberInput({name:'x'.repeat(121)})),validationError(/name过长/));
    assert.throws(()=>provisionMember(f.store,memberInput({writeScopes:['ok','x'.repeat(501)]})),validationError(/writeScopes/));
    assert.throws(()=>provisionMember(f.store,memberInput({capabilities:{payload:'x'.repeat(9000)}})),validationError(/capabilities 过大/));
    assert.throws(()=>provisionMember(f.store,memberInput({memberPath:'x'.repeat(301)})),validationError(/memberPath过长/));
    assert.equal(listMembers(f.store,TEAM).length,0);
    assert.equal(f.v2.events(TEAM).length,0);
    const custom=provisionMember(f.store,memberInput({name:'carol',contextMode:'seed',memberPath:'custom/carol'}));
    assert.equal(custom.memberPath,'custom/carol');
    assert.equal(custom.contextMode,'seed');
  }finally{f.close();}
});

test('listMembers is team-scoped and ordered; journal sequences are independent per team',()=>{
  const f=fixture();
  try{
    admitted(f,'first');
    admitted(f,'second');
    f.addTeam('team-2');
    provisionMember(f.store,memberInput({teamId:'team-2',name:'third'}));
    const teamOne=listMembers(f.store,TEAM);
    assert.deepEqual(teamOne.map(member=>member.name),['first','second']);
    const teamTwo=listMembers(f.store,'team-2');
    assert.deepEqual(teamTwo.map(member=>member.name),['third']);
    assert.deepEqual(f.v2.events('team-2').map(event=>event.type),['member.provisioned']);
    const seqs=f.v2.events(TEAM).map(event=>event.seq);
    assert.deepEqual(seqs,[1,2,3,4]);
    assert.deepEqual(f.v2.events(TEAM).map(event=>event.type),['member.provisioned','member.admitted','member.provisioned','member.admitted']);
  }finally{f.close();}
});

test('journal only appends: rejected mutations leave the journal and state untouched',()=>{
  const f=fixture();
  try{
    const member=provisionMember(f.store,memberInput());
    const before=f.v2.events(TEAM).length;
    assert.throws(()=>provisionMember(f.store,memberInput()),validationError(/名称已被占用/));
    assert.throws(()=>admitMember(f.store,member.memberId,{firstEntryId:'e',firstEntryPersisted:false}),validationError(/I3/));
    assert.throws(()=>markMemberFailed(f.store,'missing-member','boom'),validationError(/成员不存在/));
    assert.equal(f.v2.events(TEAM).length,before);
    assert.equal(getMember(f.store,member.memberId)?.phase,'provisioning');
  }finally{f.close();}
});
