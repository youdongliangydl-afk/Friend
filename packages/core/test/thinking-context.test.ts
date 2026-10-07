import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SessionManager,type ExtensionAPI,type ExtensionContext} from '@earendil-works/pi-coding-agent';
import {makeContext} from '../src/index.js';

test('plugin context freezes the public Pi thinking level when it is captured',()=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-pi-thinking-context-'));const prior=process.env.FRIEND_PI_DATA_DIR;process.env.FRIEND_PI_DATA_DIR=dir;let level='off';
  try {
    const pi={getThinkingLevel:()=>level,appendEntry:()=>{}} as unknown as ExtensionAPI;
    const ctx={cwd:dir,sessionManager:SessionManager.inMemory(dir),isIdle:()=>true,ui:{notify:()=>{}}} as unknown as ExtensionContext;
    const captured=makeContext(pi,ctx);assert.equal(captured.thinkingLevel,'off');level='high';assert.equal(captured.thinkingLevel,'off');assert.equal(makeContext(pi,ctx).thinkingLevel,'high');
  }finally{if(prior===undefined)delete process.env.FRIEND_PI_DATA_DIR;else process.env.FRIEND_PI_DATA_DIR=prior;rmSync(dir,{recursive:true,force:true});}
});
