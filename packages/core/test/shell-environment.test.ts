import {test} from 'node:test';
import assert from 'node:assert/strict';
import {shellEnvironment} from '../src/shell-environment.js';
test('command environments omit credentials without mutating inference host settings',()=>{
 const env={DEEPSEEK_API_KEY:'synthetic',apiKey:'synthetic',ACCESS_TOKEN:'synthetic',CLIENT_SECRET:'synthetic',PASSWORD:'synthetic',CREDENTIAL_FILE:'synthetic',PATH:'/bin',HOME:'/test',PI_SESSION_FILE:'/test/native.jsonl',FRIEND_PI_RUN_ID:'run'};
 assert.deepEqual(shellEnvironment(env),{PATH:'/bin',HOME:'/test',PI_SESSION_FILE:'/test/native.jsonl',FRIEND_PI_RUN_ID:'run'});assert.equal(env.DEEPSEEK_API_KEY,'synthetic');
});
