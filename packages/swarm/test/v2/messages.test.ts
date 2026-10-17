/**
 * Swarm v2 message-envelope tests — invariants I1 (dedupe by messageId+body),
 * I2 (per-target monotonic sequence/FIFO), I3 (accepted->queued->delivered->
 * incorporated only), I8 (bounded body/provenance), I9 (wait only observes
 * post-call changes) and I10 (expiry / terminal ordering).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CapabilityError,ConflictError,RecordStore,digest} from '@friend-pi/core';
import {V2Store,v2Now} from '../../src/v2/store.js';
import {
  MAX_MESSAGE_BODY,assertFifo,assertMessageLifecycle,deliverMessage,expireMessages,getMessage,incorporateMessage,
  listMessages,queueMessage,sendMessage,waitForMessages,
  type SendMessageInput,
} from '../../src/v2/messages.js';

const TEAM='team-1';
const TARGET='member-a';

function addTeam(store:RecordStore,teamId:string):void{
  store.db.prepare('INSERT INTO swarm_v2_teams(team_id,project_id,root_session_id,workspace_root,status,autonomy_level,policy_json,revision,rework_round,failure_fingerprints_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(teamId,`project-${teamId}`,'root-session','/tmp/workspace','running',1,'{}',1,0,'[]',v2Now(),v2Now());
}

function addMember(store:RecordStore,teamId:string,name:string,status='idle'):string{
  const memberId=`member-${name}`,at=v2Now();
  store.db.prepare('INSERT INTO swarm_v2_members(member_id,team_id,name,member_path,role,context_mode,model_ref,generation,phase,status,session_id,session_file,capability_json,write_scopes_json,lease_expires_at,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(memberId,teamId,name,`members/${name}`,'worker','fresh',null,0,'active',status,null,null,'{}','[]',null,1,at,at);
  return memberId;
}

function fixture():{dir:string;store:RecordStore;v2:V2Store;addTeam:(teamId:string)=>void;close:()=>void}{
  const dir=mkdtempSync(join(tmpdir(),'swarm-v2-messages-'));
  const store=new RecordStore('swarm',dir);
  const v2=V2Store.open(store);
  addTeam(store,TEAM);
  return {
    dir,store,v2,
    addTeam:(teamId:string)=>{addTeam(store,teamId);},
    close:()=>{store.close();rmSync(dir,{recursive:true,force:true});},
  };
}

function messageInput(overrides:Partial<SendMessageInput>={}):SendMessageInput{
  return {teamId:TEAM,sender:{kind:'lead',id:'lead-1'},targetId:TARGET,type:'instruction',deliveryMode:'queue',body:'请先读取 README。',...overrides};
}

function send(store:RecordStore,overrides:Partial<SendMessageInput>={}):ReturnType<typeof sendMessage>{
  return sendMessage(store,messageInput(overrides));
}

function sleep(ms:number):Promise<void>{return new Promise(resolve=>setTimeout(resolve,ms));}

function code(error:unknown):unknown{return (error as {code?:unknown})?.code;}

function validationError(pattern?:RegExp):(error:unknown)=>boolean{
  return error=>error instanceof CapabilityError&&error.code==='VALIDATION_ERROR'&&(!pattern||pattern.test(error.message));
}

function delivered(store:RecordStore,messageId:string):void{
  queueMessage(store,messageId);
  deliverMessage(store,messageId);
}

test('sendMessage stores an accepted envelope with digests, target sequence and a journal event',()=>{
  const f=fixture();
  try{
    const message=send(f.store,{messageId:'msg-1',provenance:{instructionTrust:'user',source:'controller'},expiresAt:'2099-01-01T00:00:00.000Z'});
    assert.equal(message.messageId,'msg-1');
    assert.equal(message.state,'accepted');
    assert.equal(message.sequence,1);
    assert.equal(message.teamId,TEAM);
    assert.equal(message.senderKind,'lead');
    assert.equal(message.senderId,'lead-1');
    assert.equal(message.senderGeneration,null);
    assert.equal(message.targetKind,'member');
    assert.equal(message.targetId,TARGET);
    assert.equal(message.type,'instruction');
    assert.equal(message.deliveryMode,'queue');
    assert.equal(message.body,'请先读取 README。');
    assert.equal(message.bodyDigest,digest('请先读取 README。'));
    assert.equal(message.bodyLength,message.body.length);
    assert.deepEqual(message.provenance,{instructionTrust:'user',source:'controller'});
    assert.equal(message.queuedAt,null);
    assert.equal(message.deliveredAt,null);
    assert.equal(message.incorporatedAt,null);
    assert.equal(message.nativeEntryId,null);
    assert.equal(message.expiresAt,'2099-01-01T00:00:00.000Z');
    assert.ok(Date.parse(message.acceptedAt)>0);
    assert.equal(assertMessageLifecycle(message),true);
    assert.deepEqual(getMessage(f.store,'msg-1'),message);
    const events=f.v2.events(TEAM);
    assert.equal(events.length,1);
    assert.equal(events[0].type,'message.accepted');
    assert.deepEqual(events[0].aggregate,{kind:'message',id:'msg-1',revision:1});
    assert.deepEqual(events[0].actor,{kind:'lead',id:'lead-1',generation:undefined});
    assert.equal(events[0].data.sequence,1);
    assert.equal(events[0].data.bodyDigest,message.bodyDigest);
  }finally{f.close();}
});

test('sequence is monotonic and unique per target, independent across targets and teams',()=>{
  const f=fixture();
  try{
    f.addTeam('team-2');
    const first=send(f.store,{messageId:'a-1'});
    const second=send(f.store,{messageId:'a-2',body:'第二条'});
    const other=send(f.store,{messageId:'b-1',targetId:'member-b'});
    const third=send(f.store,{messageId:'a-3',body:'第三条'});
    assert.deepEqual([first.sequence,second.sequence,other.sequence,third.sequence],[1,2,1,3]);
    const otherTeam=sendMessage(f.store,messageInput({teamId:'team-2',messageId:'t2-1'}));
    assert.equal(otherTeam.sequence,1);
    const sequences=f.v2.rows<{target_id:string;sequence:number}>('SELECT target_id,sequence FROM swarm_v2_messages WHERE team_id=? ORDER BY target_id,sequence',TEAM);
    assert.deepEqual(sequences.map(row=>`${row.target_id}:${row.sequence}`),['member-a:1','member-a:2','member-a:3','member-b:1']);
  }finally{f.close();}
});

test('messageId replay with the same payload is idempotent and writes no second row or event',()=>{
  const f=fixture();
  try{
    const first=send(f.store,{messageId:'dup-1',body:'幂等消息'});
    const eventsBefore=f.v2.events(TEAM).length;
    const replay=send(f.store,{messageId:'dup-1',body:'幂等消息'});
    assert.deepEqual(replay,first);
    assert.equal(f.v2.rows<{n:number}>('SELECT COUNT(*) AS n FROM swarm_v2_messages')[0].n,1);
    assert.equal(f.v2.events(TEAM).length,eventsBefore);
    // Replay returns the stored message even after it advanced state.
    queueMessage(f.store,'dup-1');
    assert.equal(send(f.store,{messageId:'dup-1',body:'幂等消息'}).state,'queued');
    assert.equal(f.v2.events(TEAM).length,eventsBefore+1);
  }finally{f.close();}
});

test('messageId reuse with a different body, target, type, provenance or expiry is a VERSION_CONFLICT',()=>{
  const f=fixture();
  try{
    f.addTeam('team-2');
    const original=send(f.store,{messageId:'reuse-1',provenance:{a:1},expiresAt:'2099-01-01T00:00:00.000Z'});
    const eventsBefore=f.v2.events(TEAM).length;
    assert.throws(()=>send(f.store,{messageId:'reuse-1',body:'不同正文',provenance:{a:1},expiresAt:'2099-01-01T00:00:00.000Z'}),ConflictError);
    assert.throws(()=>send(f.store,{messageId:'reuse-1',targetId:'member-z',provenance:{a:1},expiresAt:'2099-01-01T00:00:00.000Z'}),ConflictError);
    assert.throws(()=>send(f.store,{messageId:'reuse-1',type:'question',provenance:{a:1},expiresAt:'2099-01-01T00:00:00.000Z'}),ConflictError);
    assert.throws(()=>send(f.store,{messageId:'reuse-1',provenance:{a:2},expiresAt:'2099-01-01T00:00:00.000Z'}),ConflictError);
    assert.throws(()=>send(f.store,{messageId:'reuse-1',expiresAt:'2098-01-01T00:00:00.000Z'}),ConflictError);
    assert.throws(()=>sendMessage(f.store,messageInput({teamId:'team-2',messageId:'reuse-1'})),ConflictError);
    assert.equal(f.v2.events(TEAM).length,eventsBefore);
    assert.deepEqual(getMessage(f.store,'reuse-1'),original);
  }finally{f.close();}
});

test('bounded body/provenance and envelope validation reject invalid senders and targets',()=>{
  const f=fixture();
  try{
    assert.throws(()=>send(f.store,{body:'x'.repeat(MAX_MESSAGE_BODY+1)}),validationError(/body过长/));
    assert.throws(()=>send(f.store,{body:'   '}),validationError(/body不能为空/));
    assert.throws(()=>send(f.store,{provenance:['not','an','object'] as never}),validationError(/参数必须是对象/));
    assert.throws(()=>send(f.store,{provenance:{payload:'x'.repeat(9000)}}),validationError(/provenance 超过/));
    assert.throws(()=>send(f.store,{deliveryMode:'later' as never}),validationError(/deliveryMode 无效/));
    assert.throws(()=>send(f.store,{expiresAt:'not-a-time'}),validationError(/有效时间/));
    assert.throws(()=>send(f.store,{sender:{kind:''}}),validationError(/sender\.kind/));
    assert.throws(()=>send(f.store,{sender:{kind:'lead',generation:-1}}),validationError(/sender\.generation/));
    assert.throws(()=>send(f.store,{sender:null as never}),validationError(/参数必须是对象/));
    assert.throws(()=>send(f.store,{targetId:''}),validationError(/targetId/));
    assert.throws(()=>send(f.store,{type:'x'.repeat(101)}),validationError(/type过长/));
    assert.throws(()=>send(f.store,{teamId:'missing-team'}),validationError(/团队不存在/));
    assert.equal(getMessage(f.store,'missing-message'),undefined);
  }finally{f.close();}
});

test('queueMessage moves accepted -> queued idempotently and journals the transition',()=>{
  const f=fixture();
  try{
    const message=send(f.store,{messageId:'queue-1'});
    const queued=queueMessage(f.store,message.messageId);
    assert.equal(queued.state,'queued');
    assert.ok(queued.queuedAt&&Date.parse(queued.queuedAt)>0);
    assert.equal(queued.deliveredAt,null);
    assert.equal(assertMessageLifecycle(queued),true);
    const events=f.v2.events(TEAM);
    assert.deepEqual(events.map(event=>event.type),['message.accepted','message.queued']);
    assert.equal(events[1].aggregate.id,'queue-1');
    const replay=queueMessage(f.store,message.messageId);
    assert.equal(replay.state,'queued');
    assert.equal(replay.queuedAt,queued.queuedAt);
    assert.equal(f.v2.events(TEAM).length,2);
    assert.throws(()=>queueMessage(f.store,'missing-message'),validationError(/消息不存在/));
  }finally{f.close();}
});

test('deliverMessage requires queued state, records deliveredAt and replays idempotently',()=>{
  const f=fixture();
  try{
    const message=send(f.store,{messageId:'deliver-1'});
    assert.throws(()=>deliverMessage(f.store,message.messageId),validationError(/先入队/));
    const queued=queueMessage(f.store,message.messageId);
    const delivered=deliverMessage(f.store,message.messageId);
    assert.equal(delivered.state,'delivered');
    assert.ok(delivered.deliveredAt&&delivered.queuedAt);
    assert.ok(delivered.deliveredAt>=queued.queuedAt!);
    assert.equal(delivered.incorporatedAt,null);
    assert.equal(assertMessageLifecycle(delivered),true);
    assert.equal(f.v2.events(TEAM).at(-1)?.type,'message.delivered');
    const eventsBefore=f.v2.events(TEAM).length;
    const replay=deliverMessage(f.store,message.messageId);
    assert.equal(replay.deliveredAt,delivered.deliveredAt);
    assert.equal(f.v2.events(TEAM).length,eventsBefore);
  }finally{f.close();}
});

test('incorporateMessage pins the native entry, is idempotent for the same entry and conflicts on a different one',()=>{
  const f=fixture();
  try{
    const message=send(f.store,{messageId:'incorporate-1'});
    assert.throws(()=>incorporateMessage(f.store,message.messageId,'native-entry-1'),validationError(/先投递/));
    delivered(f.store,message.messageId);
    const incorporated=incorporateMessage(f.store,message.messageId,'native-entry-1');
    assert.equal(incorporated.state,'incorporated');
    assert.equal(incorporated.nativeEntryId,'native-entry-1');
    assert.ok(incorporated.incorporatedAt&&incorporated.deliveredAt&&incorporated.queuedAt);
    assert.equal(assertMessageLifecycle(incorporated),true);
    assert.equal(f.v2.events(TEAM).at(-1)?.type,'message.incorporated');
    const replay=incorporateMessage(f.store,message.messageId,'native-entry-1');
    assert.equal(replay.incorporatedAt,incorporated.incorporatedAt);
    assert.throws(()=>incorporateMessage(f.store,message.messageId,'native-entry-2'),ConflictError);
    assert.equal(getMessage(f.store,message.messageId)?.nativeEntryId,'native-entry-1');
  }finally{f.close();}
});

test('illegal lifecycle transitions are rejected at every stage',()=>{
  const f=fixture();
  try{
    const accepted=send(f.store,{messageId:'illegal-1'});
    assert.throws(()=>deliverMessage(f.store,accepted.messageId),validationError(/先入队/));
    assert.throws(()=>incorporateMessage(f.store,accepted.messageId,'native-1'),validationError(/先投递/));
    delivered(f.store,accepted.messageId);
    assert.throws(()=>queueMessage(f.store,accepted.messageId),validationError(/不允许入队/));
    incorporateMessage(f.store,accepted.messageId,'native-1');
    assert.throws(()=>queueMessage(f.store,accepted.messageId),validationError(/不允许入队/));
    assert.throws(()=>deliverMessage(f.store,accepted.messageId),validationError(/不允许投递/));
    const expiring=send(f.store,{messageId:'illegal-2',expiresAt:new Date(Date.now()-1000).toISOString()});
    assert.deepEqual(expireMessages(f.store,TEAM).map(message=>message.messageId),['illegal-2']);
    assert.throws(()=>queueMessage(f.store,expiring.messageId),validationError(/不允许入队/));
    assert.throws(()=>deliverMessage(f.store,expiring.messageId),validationError(/不允许投递/));
    assert.throws(()=>incorporateMessage(f.store,expiring.messageId,'native-2'),validationError(/不能并入|先投递/));
  }finally{f.close();}
});

test('expireMessages expires only due non-incorporated messages, is idempotent and journals each expiry',()=>{
  const f=fixture();
  try{
    const past=new Date(Date.now()-60_000).toISOString();
    const future=new Date(Date.now()+3_600_000).toISOString();
    send(f.store,{messageId:'exp-accepted',targetId:'member-x',expiresAt:past});
    send(f.store,{messageId:'exp-queued',targetId:'member-y',expiresAt:past});
    queueMessage(f.store,'exp-queued');
    send(f.store,{messageId:'exp-delivered',targetId:'member-z',expiresAt:past});
    delivered(f.store,'exp-delivered');
    send(f.store,{messageId:'exp-future',expiresAt:future});
    send(f.store,{messageId:'exp-none'});
    const expired=expireMessages(f.store,TEAM);
    assert.deepEqual(expired.map(message=>message.messageId),['exp-accepted','exp-queued','exp-delivered']);
    assert.deepEqual(expired.map(message=>message.state),['expired','expired','expired']);
    for(const message of expired) assert.equal(assertMessageLifecycle(message),true);
    assert.equal(getMessage(f.store,'exp-accepted')?.state,'expired');
    assert.deepEqual(getMessage(f.store,'exp-future')?.state,'accepted');
    assert.deepEqual(getMessage(f.store,'exp-none')?.state,'accepted');
    assert.deepEqual(f.v2.events(TEAM).filter(event=>event.type==='message.expired').map(event=>event.data.messageId),['exp-accepted','exp-queued','exp-delivered']);
    assert.deepEqual(expireMessages(f.store,TEAM),[]);
  }finally{f.close();}
});

test('expireMessages accepts an explicit clock override',()=>{
  const f=fixture();
  try{
    send(f.store,{messageId:'override-1',expiresAt:'2026-10-18T00:00:00.000Z'});
    send(f.store,{messageId:'override-2'});
    assert.deepEqual(expireMessages(f.store,TEAM),[]);
    const expired=expireMessages(f.store,TEAM,'2026-10-19T00:00:00.000Z');
    assert.deepEqual(expired.map(message=>message.messageId),['override-1']);
    assert.equal(getMessage(f.store,'override-2')?.state,'accepted');
  }finally{f.close();}
});

test('listMessages paginates by ascending sequence, per target and per team',()=>{
  const f=fixture();
  try{
    f.addTeam('team-2');
    for(let index=1;index<=5;index++) send(f.store,{messageId:`page-${index}`,body:`msg-${index}`});
    assert.deepEqual(listMessages(f.store,TEAM).map(message=>message.sequence),[1,2,3,4,5]);
    assert.deepEqual(listMessages(f.store,TEAM,{limit:2}).map(message=>message.sequence),[1,2]);
    assert.deepEqual(listMessages(f.store,TEAM,{targetId:TARGET,afterSequence:2,limit:2}).map(message=>message.sequence),[3,4]);
    assert.deepEqual(listMessages(f.store,TEAM,{targetId:TARGET,afterSequence:4}).map(message=>message.sequence),[5]);
    assert.deepEqual(listMessages(f.store,TEAM,{targetId:TARGET,afterSequence:5}),[]);
    assert.throws(()=>listMessages(f.store,TEAM,{afterSequence:1}),validationError(/跨目标分页需要 targetId/));
    assert.deepEqual(listMessages(f.store,TEAM).map(message=>message.sequence),[1,2,3,4,5],'no cursor still allows targetless listing');
    assert.deepEqual(listMessages(f.store,TEAM,{targetId:'member-z'}),[]);
    assert.deepEqual(listMessages(f.store,TEAM,{targetId:TARGET,afterSequence:3}).map(message=>message.messageId),['page-4','page-5']);
    sendMessage(f.store,messageInput({teamId:'team-2',messageId:'other-team'}));
    assert.deepEqual(listMessages(f.store,'team-2').map(message=>message.messageId),['other-team']);
    assert.equal(listMessages(f.store,TEAM).length,5);
    assert.throws(()=>listMessages(f.store,TEAM,{limit:0}),validationError(/limit/));
    assert.throws(()=>listMessages(f.store,TEAM,{limit:201}),validationError(/limit/));
    assert.throws(()=>listMessages(f.store,TEAM,{afterSequence:-1}),validationError(/afterSequence/));
  }finally{f.close();}
});

test('waitForMessages only observes messages created after the call',async()=>{
  const f=fixture();
  try{
    send(f.store,{messageId:'preexisting-1'});
    send(f.store,{messageId:'preexisting-2',body:'已有第二条'});
    const waiting=waitForMessages(f.store,TEAM,{afterSequence:0,timeoutMs:10_000,pollMs:10});
    await sleep(30);
    const fresh=send(f.store,{messageId:'fresh-1',targetId:'member-b',body:'等待期间的新消息'});
    const result=await waiting;
    assert.equal(result.timedOut,false);
    assert.deepEqual(result.messages.map(message=>message.messageId),['fresh-1']);
    assert.equal(result.messages[0].sequence,fresh.sequence);
  }finally{f.close();}
});

test('waitForMessages filters post-call arrivals by afterSequence',async()=>{
  const f=fixture();
  try{
    const waiting=waitForMessages(f.store,TEAM,{targetId:'member-c',afterSequence:2,timeoutMs:10_000,pollMs:10});
    await sleep(20);
    send(f.store,{messageId:'target-c-1',targetId:'member-c',body:'一'});
    send(f.store,{messageId:'target-c-2',targetId:'member-c',body:'二'});
    send(f.store,{messageId:'target-c-3',targetId:'member-c',body:'三'});
    const result=await waiting;
    assert.equal(result.timedOut,false);
    assert.deepEqual(result.messages.map(message=>message.messageId),['target-c-3']);
    assert.ok(result.messages.every(message=>message.sequence>2));
  }finally{f.close();}
});

test('waitForMessages times out within the 10s..1h contract and returns no messages',async()=>{
  const f=fixture();
  try{
    const began=Date.now();
    const result=await waitForMessages(f.store,TEAM,{afterSequence:0,timeoutMs:10_000,pollMs:25});
    assert.equal(result.timedOut,true);
    assert.deepEqual(result.messages,[]);
    assert.ok(Date.now()-began>=9_900,`timed out after ${Date.now()-began}ms`);
  }finally{f.close();}
});

test('waitForMessages validates timeout, poll interval and cursor bounds',async()=>{
  const f=fixture();
  try{
    await assert.rejects(waitForMessages(f.store,TEAM,{timeoutMs:9_999}),validationError(/timeoutMs/));
    await assert.rejects(waitForMessages(f.store,TEAM,{timeoutMs:3_600_001}),validationError(/timeoutMs/));
    await assert.rejects(waitForMessages(f.store,TEAM,{timeoutMs:10_000,pollMs:0}),validationError(/pollMs/));
    await assert.rejects(waitForMessages(f.store,TEAM,{timeoutMs:10_000,pollMs:1_001}),validationError(/pollMs/));
    await assert.rejects(waitForMessages(f.store,TEAM,{timeoutMs:10_000,afterSequence:-1}),validationError(/afterSequence/));
    await assert.rejects(waitForMessages(f.store,'missing-team',{timeoutMs:10_000}),validationError(/团队不存在/));
  }finally{f.close();}
});

test('assertFifo verifies delivery/incorporation order matches sequence and detects tampering',()=>{
  const f=fixture();
  try{
    const first=send(f.store,{messageId:'fifo-1'});
    const second=send(f.store,{messageId:'fifo-2',body:'二'});
    const third=send(f.store,{messageId:'fifo-3',body:'三'});
    for(const message of [first,second,third]){
      queueMessage(f.store,message.messageId);
      deliverMessage(f.store,message.messageId);
      incorporateMessage(f.store,message.messageId,`native-${message.messageId}`);
    }
    assert.deepEqual(assertFifo(f.store,TEAM,TARGET),{ok:true,targetId:TARGET,checked:3});
    f.store.db.prepare("UPDATE swarm_v2_messages SET delivered_at='2000-01-01T00:00:00.000Z' WHERE message_id=?").run(third.messageId);
    assert.throws(()=>assertFifo(f.store,TEAM,TARGET),validationError(/FIFO 违例/));
    assert.equal(assertFifo(f.store,TEAM,'member-empty').checked,0);
  }finally{f.close();}
});

test('assertMessageLifecycle validates every state and rejects corrupted envelopes',()=>{
  const f=fixture();
  try{
    const accepted=send(f.store,{messageId:'life-1'});
    assert.equal(assertMessageLifecycle(accepted),true);
    assert.throws(()=>assertMessageLifecycle({...accepted,queuedAt:new Date().toISOString()}),validationError(/accepted 状态下 queuedAt 必须为空/));
    assert.throws(()=>assertMessageLifecycle({...accepted,bodyDigest:'bad'}),validationError(/bodyDigest/));
    assert.throws(()=>assertMessageLifecycle({...accepted,bodyLength:0}),validationError(/bodyLength/));
    const queued=queueMessage(f.store,'life-1');
    assert.equal(assertMessageLifecycle(queued),true);
    assert.throws(()=>assertMessageLifecycle({...queued,deliveredAt:new Date().toISOString()}),validationError(/queued 状态下 deliveredAt 必须为空/));
    const deliveredMessage=deliverMessage(f.store,'life-1');
    assert.equal(assertMessageLifecycle(deliveredMessage),true);
    assert.throws(()=>assertMessageLifecycle({...deliveredMessage,incorporatedAt:new Date().toISOString()}),validationError(/delivered 状态下 incorporatedAt 必须为空/));
    const incorporated=incorporateMessage(f.store,'life-1','native-life-1');
    assert.equal(assertMessageLifecycle(incorporated),true);
    assert.throws(()=>assertMessageLifecycle({...incorporated,nativeEntryId:null}),validationError(/incorporated 状态下 nativeEntryId 不能为空/));
    assert.throws(()=>assertMessageLifecycle({...incorporated,queuedAt:null}),validationError(/queuedAt 不能为空/));
    const expiring=send(f.store,{messageId:'life-2',expiresAt:new Date(Date.now()-1000).toISOString()});
    const [expired]=expireMessages(f.store,TEAM);
    assert.equal(expired.messageId,expiring.messageId);
    assert.equal(assertMessageLifecycle(expired),true);
    assert.throws(()=>assertMessageLifecycle({...expired,expiresAt:null}),validationError(/expiresAt/));
    assert.throws(()=>assertMessageLifecycle({...expired,state:'booted' as never}),validationError(/未知状态/));
  }finally{f.close();}
});

test('trigger-mode messages stay queued while their target member is running',()=>{
  const f=fixture();
  try{
    const busy=addMember(f.store,TEAM,'busy','running');
    const message=send(f.store,{messageId:'trigger-1',targetId:busy,deliveryMode:'trigger'});
    assert.equal(message.deliveryMode,'trigger');
    assert.equal(message.state,'accepted');
    const queued=queueMessage(f.store,message.messageId);
    assert.equal(queued.state,'queued');
    assert.equal(queued.deliveredAt,null);
    assert.equal(deliverMessage(f.store,message.messageId).state,'delivered');
  }finally{f.close();}
});

test('sender, target and provenance metadata round-trip and are journalled with the sender actor',()=>{
  const f=fixture();
  try{
    const member=addMember(f.store,TEAM,'worker');
    const message=send(f.store,{messageId:'meta-1',sender:{kind:'member',id:'member-x',generation:3},targetId:member,targetKind:'member',type:'question',deliveryMode:'queue',body:'问题',provenance:{instructionTrust:'lead',handoff:false}});
    assert.equal(message.senderKind,'member');
    assert.equal(message.senderId,'member-x');
    assert.equal(message.senderGeneration,3);
    assert.equal(message.targetKind,'member');
    assert.equal(message.targetId,member);
    assert.deepEqual(message.provenance,{handoff:false,instructionTrust:'lead'});
    assert.deepEqual(getMessage(f.store,'meta-1'),message);
    const event=f.v2.events(TEAM)[0];
    assert.deepEqual(event.actor,{kind:'member',id:'member-x',generation:3});
    assert.equal(event.data.targetId,member);
    assert.equal(event.data.targetKind,'member');
    assert.equal(event.data.type,'question');
    assert.equal(event.data.deliveryMode,'queue');
  }finally{f.close();}
});

test('journal stays monotonic and the projection counts message states',()=>{
  const f=fixture();
  try{
    send(f.store,{messageId:'state-1',targetId:'member-s1'});
    queueMessage(f.store,'state-1');
    send(f.store,{messageId:'state-2',body:'二',targetId:'member-s2'});
    delivered(f.store,'state-2');
    send(f.store,{messageId:'state-3',body:'三',targetId:'member-s3'});
    const events=f.v2.events(TEAM);
    assert.deepEqual(events.map(event=>event.seq),[1,2,3,4,5,6]);
    assert.deepEqual(events.map(event=>event.type),['message.accepted','message.queued','message.accepted','message.queued','message.delivered','message.accepted']);
    const projection=f.v2.projection(TEAM);
    assert.ok(projection);
    assert.deepEqual(projection.json.messages,{accepted:1,queued:1,delivered:1,incorporated:0,expired:0});
    assert.equal(projection.json.journalEvents,6);
  }finally{f.close();}
});

test('a messageId is global: reusing it in another team is a VERSION_CONFLICT',()=>{
  const f=fixture();
  try{
    f.addTeam('team-2');
    const message=send(f.store,{messageId:'shared-1'});
    assert.throws(()=>sendMessage(f.store,messageInput({teamId:'team-2',messageId:'shared-1'})),ConflictError);
    assert.equal(getMessage(f.store,message.messageId)?.teamId,TEAM);
    assert.deepEqual(listMessages(f.store,'team-2'),[]);
  }finally{f.close();}
});

test('deliverMessage enforces per-target FIFO and never skips an earlier undelivered message',()=>{
  const f=fixture();
  try{
    const first=send(f.store,{messageId:'fifo-a1'});
    const second=send(f.store,{messageId:'fifo-a2',body:'第二条'});
    queueMessage(f.store,first.messageId);
    queueMessage(f.store,second.messageId);
    assert.throws(()=>deliverMessage(f.store,second.messageId),error=>{
      assert.ok(error instanceof CapabilityError);
      assert.equal(code(error),'VERSION_CONFLICT');
      assert.match(error.message,/存在更早的未投递消息/);
      return true;
    });
    assert.equal(getMessage(f.store,second.messageId)?.state,'queued');
    assert.equal(f.v2.events(TEAM).filter(event=>event.type==='message.delivered').length,0,'a rejected delivery journals nothing');
    assert.equal(deliverMessage(f.store,first.messageId).state,'delivered');
    assert.equal(deliverMessage(f.store,second.messageId).state,'delivered');
    assert.deepEqual(assertFifo(f.store,TEAM,TARGET),{ok:true,targetId:TARGET,checked:2});
  }finally{f.close();}
});

test('FIFO delivery blocks on earlier accepted/queued messages of the same target only',()=>{
  const f=fixture();
  try{
    // An earlier message that was never even queued still blocks its successor.
    send(f.store,{messageId:'edge-accepted',targetId:'member-c'});
    const blocked=send(f.store,{messageId:'edge-blocked',targetId:'member-c',body:'二'});
    queueMessage(f.store,blocked.messageId);
    assert.throws(()=>deliverMessage(f.store,blocked.messageId),error=>code(error)==='VERSION_CONFLICT');
    // A different target has its own FIFO and is unaffected.
    const otherFirst=send(f.store,{messageId:'edge-other-first',targetId:'member-d'});
    queueMessage(f.store,otherFirst.messageId);
    const otherSecond=send(f.store,{messageId:'edge-other-second',targetId:'member-e',body:'二'});
    queueMessage(f.store,otherSecond.messageId);
    assert.equal(deliverMessage(f.store,otherSecond.messageId).state,'delivered');
    // An earlier message that expired no longer blocks delivery.
    send(f.store,{messageId:'edge-expired',targetId:'member-f',expiresAt:new Date(Date.now()-1000).toISOString()});
    const afterExpiry=send(f.store,{messageId:'edge-after-expiry',targetId:'member-f',body:'二'});
    queueMessage(f.store,afterExpiry.messageId);
    assert.deepEqual(expireMessages(f.store,TEAM).map(message=>message.messageId),['edge-expired']);
    assert.equal(deliverMessage(f.store,afterExpiry.messageId).state,'delivered');
  }finally{f.close();}
});

test('targetless cursor pagination and waits are rejected; target-scoped cursors work',async()=>{
  const f=fixture();
  try{
    for(let index=1;index<=3;index++) send(f.store,{messageId:`cursor-${index}`,body:`消息${index}`});
    assert.throws(()=>listMessages(f.store,TEAM,{afterSequence:1}),validationError(/跨目标分页需要 targetId/));
    assert.deepEqual(listMessages(f.store,TEAM,{targetId:TARGET,afterSequence:1}).map(message=>message.messageId),['cursor-2','cursor-3']);
    assert.deepEqual(listMessages(f.store,TEAM).map(message=>message.messageId),['cursor-1','cursor-2','cursor-3']);
    await assert.rejects(waitForMessages(f.store,TEAM,{afterSequence:1,timeoutMs:10_000}),validationError(/跨目标分页需要 targetId/));
    // Target-scoped wait with a cursor observes only that target's future messages.
    const waiting=waitForMessages(f.store,TEAM,{targetId:TARGET,afterSequence:3,timeoutMs:10_000,pollMs:10});
    await sleep(20);
    send(f.store,{messageId:'other-target-new',targetId:'member-b',body:'别的目标'});
    send(f.store,{messageId:'target-new',targetId:TARGET,body:'本目标新消息'});
    const result=await waiting;
    assert.equal(result.timedOut,false);
    assert.deepEqual(result.messages.map(message=>message.messageId),['target-new']);
    assert.deepEqual(assertMessageLifecycle(result.messages[0]),true);
  }finally{f.close();}
});
