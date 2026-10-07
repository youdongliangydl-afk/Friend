import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionManager,type ExtensionAPI,type ExtensionContext} from '@earendil-works/pi-coding-agent';
import {agentDirectory,makeContext} from '../src/index.js';

test('SDK host agent directory is explicit, immutable in its context and independent of plugin data storage',()=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-pi-agent-directory-'));const priorData=process.env.FRIEND_PI_DATA_DIR;const priorAgent=process.env.FRIEND_PI_AGENT_DIR;const priorNative=process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.FRIEND_PI_DATA_DIR=join(dir,'plugin-records');process.env.PI_CODING_AGENT_DIR=join(dir,'native-host');process.env.FRIEND_PI_AGENT_DIR=join(dir,'sdk-host');
    const pi={getThinkingLevel:()=> 'off',appendEntry:()=>{}} as unknown as ExtensionAPI;const ctx={cwd:dir,sessionManager:SessionManager.inMemory(dir),isIdle:()=>true,ui:{notify:()=>{}}} as unknown as ExtensionContext;
    const captured=makeContext(pi,ctx);assert.equal(captured.agentDir,join(dir,'sdk-host'));assert.notEqual(captured.agentDir,captured.dataDir);
    process.env.FRIEND_PI_AGENT_DIR=join(dir,'later-host');assert.equal(captured.agentDir,join(dir,'sdk-host'));assert.equal(agentDirectory(),join(dir,'later-host'));
    delete process.env.FRIEND_PI_AGENT_DIR;assert.equal(agentDirectory(),join(dir,'native-host'),'native Pi must honor its own public directory override');assert.equal(makeContext(pi,ctx).agentDir,join(dir,'native-host'));
  }finally{if(priorData===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=priorData;if(priorAgent===undefined)delete process.env.FRIEND_PI_AGENT_DIR;else process.env.FRIEND_PI_AGENT_DIR=priorAgent;if(priorNative===undefined)delete process.env.PI_CODING_AGENT_DIR;else process.env.PI_CODING_AGENT_DIR=priorNative;rmSync(dir,{recursive:true,force:true});}
});
