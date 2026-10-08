import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {copyDesktopBuild} from '../scripts/package-desktop.mjs';

test('delivery includes both trusted UI preload bridges and renderer surface',()=>{
  const target=mkdtempSync(join(tmpdir(),'friend-desktop-copy-'));
  try{
    copyDesktopBuild(join(process.cwd(),'apps/desktop/dist'),target);
    assert.match(readFileSync(join(target,'composer-preload.cjs'),'utf8'),/friend-composer:ready/);
    assert.match(readFileSync(join(target,'preload.cjs'),'utf8'),/friend-pi:request/);
    assert.match(readFileSync(join(target,'renderer/index.html'),'utf8'),/script/);
  }finally{rmSync(target,{recursive:true,force:true});}
});
