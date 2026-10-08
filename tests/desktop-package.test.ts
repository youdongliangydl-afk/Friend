import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const {copyDesktopBuild,desktopBuildFiles}=await import(new URL('../scripts/package-desktop.mjs',import.meta.url).href);

test('delivery includes both trusted UI preload bridges and renderer surface',()=>{
  const target=mkdtempSync(join(tmpdir(),'friend-desktop-copy-'));
  try{
    const source=join(target,'source'),delivery=join(target,'delivery');mkdirSync(join(source,'renderer'),{recursive:true});
    for(const file of desktopBuildFiles)writeFileSync(join(source,file),file);
    writeFileSync(join(source,'renderer/index.html'),'<script src="client.js"></script>');
    copyDesktopBuild(source,delivery);
    assert.equal(readFileSync(join(delivery,'composer-preload.cjs'),'utf8'),'composer-preload.cjs');
    assert.equal(readFileSync(join(delivery,'preload.cjs'),'utf8'),'preload.cjs');
    assert.match(readFileSync(join(delivery,'renderer/index.html'),'utf8'),/script/);
  }finally{rmSync(target,{recursive:true,force:true});}
});
