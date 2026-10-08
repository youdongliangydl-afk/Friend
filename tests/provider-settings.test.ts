import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,statSync,readdirSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviderRuntime,providerMetadata,providerDefaultSelection,saveProviderConfiguration } from '../apps/desktop/src/provider-settings.js';
test('global provider configuration works without a project or Pi session and exposes no credentials',async()=>{
  const dataDir=mkdtempSync(join(tmpdir(),'friend-pi-global-settings-'));
  try{
    const runtime=await createProviderRuntime(dataDir);
    await saveProviderConfiguration(runtime,dataDir,{provider:'global-fixture',baseUrl:'http://127.0.0.1:65530/v1',modelId:'fixture',apiKey:'unit-local-credential'});
    const metadata=providerMetadata(runtime);assert.equal(metadata.providers.find(provider=>provider.id==='global-fixture')?.configured,true);assert.ok(metadata.models.some(model=>model.id==='global-fixture/fixture'));assert.equal(JSON.stringify(metadata).includes('unit-local-credential'),false);
    const reopened=await createProviderRuntime(dataDir);assert.equal(reopened.hasConfiguredAuth('global-fixture'),true);assert.equal(statSync(join(dataDir,'pi/auth.json')).mode&0o777,0o600);assert.equal(readdirSync(dataDir).includes('sessions'),false);
  }finally{rmSync(dataDir,{recursive:true,force:true});}
});
test('popular native preset saves only synthetic auth and preserves Pi model protocol and capabilities',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-preset-native-'));try{
    const runtime=await createProviderRuntime(dir),before=runtime.getModels('deepseek').map(model=>({id:model.id,api:model.api,compat:model.compat,thinkingLevelMap:model.thinkingLevelMap}));
    await saveProviderConfiguration(runtime,dir,{provider:'deepseek',presetId:'deepseek',apiKey:'offline-synthetic-key'});
    assert.equal(existsSync(join(dir,'pi/models.json')),false);
    assert.deepEqual(runtime.getModels('deepseek').map(model=>({id:model.id,api:model.api,compat:model.compat,thinkingLevelMap:model.thinkingLevelMap})),before);
    assert.equal(providerMetadata(runtime).providers.find(item=>item.id==='deepseek')?.supportsApiKey,true);
    assert.equal(JSON.stringify(providerMetadata(runtime)).includes('offline-synthetic-key'),false);
    for(const provider of ['google-vertex','amazon-bedrock']){
      assert.equal(providerMetadata(runtime).providers.find(item=>item.id===provider)?.supportsApiKey,false);
      await assert.rejects(saveProviderConfiguration(runtime,dir,{provider,apiKey:'offline-synthetic-key'}),error=>{assert.equal(String(error).includes('offline-synthetic-key'),false);return /专用认证/.test(String(error));});
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('pay-as-you-go presets clone native model capabilities while keeping billing endpoints separate',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-preset-metered-'));try{
    const runtime=await createProviderRuntime(dir);
    for(const [presetId,provider,source,modelId,base] of [['bailian-cn','bailian-cn','qwen-token-plan-cn','qwen3.8-max','https://dashscope.aliyuncs.com/compatible-mode/v1'],['zhipu','zhipu','zai-coding-cn','glm-5.3','https://open.bigmodel.cn/api/paas/v4']]){
      const original=runtime.getModels(source).find(model=>model.id===modelId)!;assert.ok(original);
      await saveProviderConfiguration(runtime,dir,{provider,presetId,apiKey:'offline-synthetic-key'});
      const saved=runtime.getModels(provider).find(model=>model.id===modelId)!;assert.ok(saved);assert.equal(saved.baseUrl,base);assert.deepEqual(saved.compat,original.compat);assert.deepEqual(saved.thinkingLevelMap,original.thinkingLevelMap);assert.equal(saved.contextWindow,original.contextWindow);
    }
    assert.deepEqual(providerDefaultSelection(runtime,'zhipu','zhipu/glm-5.3','off'),{defaultModelId:'zhipu/glm-5.3',defaultThinkingLevel:'low'});
    assert.equal(providerMetadata(runtime).models.find(model=>model.id==='zhipu/glm-5.3')!.thinkingLevels.includes('off'),false);
    await saveProviderConfiguration(runtime,dir,{provider:'bailian-cn',baseUrl:'http://127.0.0.1:65530/compat',api:'openai-completions',modelId:'qwen3.8-max'});
    await saveProviderConfiguration(runtime,dir,{provider:'bailian-cn',presetId:'bailian-cn',apiKey:'offline-synthetic-key'});
    assert.equal(runtime.getModels('bailian-cn')[0].baseUrl,'http://127.0.0.1:65530/compat','replacing a key preserves an existing metered-provider proxy');
    await assert.rejects(saveProviderConfiguration(runtime,dir,{provider:'zhipu',presetId:'deepseek',apiKey:'offline-synthetic-key'}),/不匹配/);
    await assert.rejects(saveProviderConfiguration(runtime,dir,{provider:'deepseek',presetId:'deepseek',defaultModelId:'zhipu/glm-5.3'}),/默认模型/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('MiniMax canonical domain update keeps native protocol and never overwrites a configured proxy',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-preset-minimax-'));try{
    const runtime=await createProviderRuntime(dir),before=runtime.getModels('minimax-cn');
    await saveProviderConfiguration(runtime,dir,{provider:'minimax-cn',presetId:'minimax-cn',apiKey:'offline-synthetic-key'});
    const updated=runtime.getModels('minimax-cn');assert.equal(updated.length,before.length);assert.equal(updated[0].baseUrl,'https://api.minimax.cn/anthropic');assert.equal(updated[0].api,'anthropic-messages');assert.deepEqual(updated[0].compat,before[0].compat);
    await saveProviderConfiguration(runtime,dir,{provider:'minimax-cn',baseUrl:'http://127.0.0.1:65530/anthropic',api:'anthropic-messages',modelId:updated[0].id});
    await saveProviderConfiguration(runtime,dir,{provider:'minimax-cn',presetId:'minimax-cn',apiKey:'offline-synthetic-key'});
    assert.equal(runtime.getModels('minimax-cn')[0].baseUrl,'http://127.0.0.1:65530/anthropic');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('Ark requires an explicit enabled model and does not fabricate account endpoint IDs',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'friend-preset-ark-'));try{
    const runtime=await createProviderRuntime(dir);
    await assert.rejects(saveProviderConfiguration(runtime,dir,{provider:'volcengine-ark',presetId:'ark',apiKey:'offline-synthetic-key'}),/型号/);
    assert.equal(existsSync(join(dir,'pi/models.json')),false);
    await saveProviderConfiguration(runtime,dir,{provider:'volcengine-ark',presetId:'ark',modelId:'enabled-fixture-model',apiKey:'offline-synthetic-key'});
    assert.equal(runtime.getModels('volcengine-ark')[0].id,'enabled-fixture-model');assert.equal(runtime.getModels('volcengine-ark')[0].baseUrl,'https://ark.cn-beijing.volces.com/api/v3');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
