import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,statSync,readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderRuntime,providerMetadata,saveProviderConfiguration } from '../apps/desktop/src/provider-settings.js';
test('global provider configuration works without a project or Pi session and exposes no credentials',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'friend-pi-global-settings-'));
  try{
    const runtime=await createProviderRuntime(dataDir);
    await saveProviderConfiguration(runtime,dataDir,{provider:'global-fixture',baseUrl:'http://127.0.0.1:65530/v1',modelId:'fixture',apiKey:'unit-local-credential'});
    const metadata=providerMetadata(runtime);assert.equal(metadata.providers.find(provider=>provider.id==='global-fixture')?.configured,true);assert.ok(metadata.models.some(model=>model.id==='global-fixture/fixture'));assert.equal(JSON.stringify(metadata).includes('unit-local-credential'),false);
    const reopened=await createProviderRuntime(dataDir);assert.equal(reopened.hasConfiguredAuth('global-fixture'),true);assert.equal(statSync(join(dataDir,'pi/auth.json')).mode&0o777,0o600);assert.equal(readdirSync(dataDir).includes('sessions'),false);
  }finally{rmSync(dataDir,{recursive:true,force:true});}
});
