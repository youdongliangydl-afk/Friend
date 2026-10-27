import test from 'node:test';
import assert from 'node:assert/strict';
import {createBus,executionBackend} from '../src/index.js';

test('host bus isolates handlers: a throwing or rejecting one cannot break the others',async()=>{
  const bus=createBus();const seen:string[]=[];
  const errors:string[]=[];const priorError=console.error;console.error=(...args:unknown[])=>{errors.push(args.map(String).join(' '));};
  try {
    bus.on('c',()=>{throw new Error('throwing-handler');});
    bus.on('c',async()=>{throw new Error('rejecting-handler');});
    bus.on('c',data=>{seen.push(String(data));});
    bus.on('other',()=>{seen.push('wrong-channel');});
    bus.emit('c','payload');
    await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(seen,['payload']);
    assert.equal(errors.filter(line=>line.includes('throwing-handler')).length,1);
    assert.equal(errors.filter(line=>line.includes('rejecting-handler')).length,1);
  } finally {console.error=priorError;}
});

test('host bus unsubscribes cleanly and clear() detaches every listener',()=>{
  const bus=createBus();const seen:string[]=[];let cleared=0;
  const off=bus.on('a',()=>{seen.push('a');});
  bus.on('b',()=>{cleared++;});
  bus.emit('a',1);
  off();
  bus.emit('a',2);
  assert.deepEqual(seen,['a']);
  bus.clear?.();
  bus.emit('b',1);
  assert.equal(cleared,0);
});

test('bus instances are independent, so two sessions never share channels',()=>{
  const first=createBus(),second=createBus();let hits=0;
  first.on('friend-pi:v1:event',()=>{hits++;});
  second.emit('friend-pi:v1:event',{v:1});
  assert.equal(hits,0);
  first.emit('friend-pi:v1:event',{v:1});
  assert.equal(hits,1);
});

test('execution backend defaults to pi and rejects unknown values instead of silently falling back',()=>{
  assert.equal(executionBackend(undefined),'pi');
  assert.equal(executionBackend(''),'pi');
  assert.equal(executionBackend('  '),'pi');
  assert.equal(executionBackend('pi'),'pi');
  assert.equal(executionBackend('DURABLE'),'durable');
  assert.equal(executionBackend(' durable '),'durable');
  assert.throws(()=>executionBackend('durabl'),/FRIEND_PI_EXEC/);
  assert.throws(()=>executionBackend('1'),/FRIEND_PI_EXEC/);
});
