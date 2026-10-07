#!/usr/bin/env node
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { assertToolchain, command, copyProductionDependencies, fileHash, json, pluginNames, root, sourceIdentity, verifyInternalLinks } from './package-desktop.mjs';

const { values } = parseArgs({ options: { 'skip-build': { type: 'boolean', default: false }, 'require-clean': { type: 'boolean', default: false }, 'skip-install-test': { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } });
if (values.help) { console.log('Usage: node scripts/package-plugins.mjs [--skip-build] [--require-clean] [--skip-install-test]\nPacks four native Pi packages, extracts installable directories, and verifies each in an independent temporary Pi host with a fake provider.'); process.exit(0); }
const piLock = assertToolchain();
if (!values['skip-build']) command(process.execPath, [join(root, 'scripts/build.mjs')]);
const source = sourceIdentity(values['require-clean']);
const out = join(root, '.artifacts', 'packages'); const stage = join(out, `.staging-${Date.now()}`); mkdirSync(stage, { recursive: true });
const packages = [];
for (const name of pluginNames) {
  const original = join(root, 'packages', name); const staged = join(stage, name); mkdirSync(staged, { recursive: true });
  const manifest = json(join(original, 'package.json'));
  if (!manifest.pi?.extensions?.includes('dist/index.js')) throw new Error(`Missing native Pi extension declaration: ${name}`);
  if (Object.keys(manifest.dependencies || {}).some(pkg => pkg.startsWith('@earendil-works/'))) throw new Error(`Native package bundles host Pi dependency: ${name}`);
  for (const peer of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', 'typebox']) if (!manifest.peerDependencies?.[peer]) throw new Error(`Missing host peer ${peer} in ${name}`);
  for (const file of ['package.json', 'README.md', 'LICENSE', 'SOURCES.md']) if (existsSync(join(original, file))) copyFileSync(join(original, file), join(staged, file));
  if (!existsSync(join(staged, 'LICENSE'))) copyFileSync(join(root, 'LICENSE'), join(staged, 'LICENSE'));
  copyFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), join(staged, 'NOTICE.md')); copyFileSync(join(root, '.cache/pi/source/LICENSE'), join(staged, 'PI-LICENSE'));
  cpSync(join(original, 'dist'), join(staged, 'dist'), { recursive: true, dereference: true });
  const content = readFileSync(join(staged, 'dist/index.js'), 'utf8');
  if (/\b(?:from|import)\s*['"]@friend-pi\/core['"]/.test(content)) throw new Error(`${name} still depends on an unpublished core module; build the bundled extension`);
  // Extend only the staged packaging allowlist; source manifests remain owned by their agents.
  writeFileSync(join(staged, 'package.json'), `${JSON.stringify({ ...manifest, files: [...new Set([...(manifest.files || ['dist']), 'LICENSE', 'NOTICE.md', 'PI-LICENSE', 'SOURCES.md', 'README.md'])] }, null, 2)}\n`);
  const result = JSON.parse(command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', stage], staged, true));
  if (!Array.isArray(result) || result.length !== 1) throw new Error(`Unexpected npm pack output for ${name}`);
  const packed = join(stage, result[0].filename); const sha256 = fileHash(packed); const filename = `${result[0].filename.replace(/\.tgz$/, '')}-${sha256.slice(0, 12)}.tgz`;
  renameSync(packed, join(out, filename));
  const unpackedRoot = join(out, 'unpacked', name); mkdirSync(dirname(unpackedRoot), { recursive: true });
  if (existsSync(unpackedRoot)) renameSync(unpackedRoot, `${unpackedRoot}.previous-${Date.now()}`); mkdirSync(unpackedRoot, { recursive: true });
  command('tar', ['-xzf', join(out, filename), '-C', unpackedRoot]);
  const unpacked = join(unpackedRoot, 'package'); verifyInternalLinks(unpacked);
  if (!existsSync(join(unpacked, 'PI-LICENSE')) || !existsSync(join(unpacked, 'NOTICE.md'))) throw new Error('npm pack did not retain required license notices');
  packages.push({ name: manifest.name, plugin: name, version: manifest.version, file: relative(root, join(out, filename)), sha256, integrity: `sha512-${fileHash(join(out, filename), 'sha512', 'base64')}`, bytes: result[0].size, unpacked: relative(root, unpacked), install: ['pi', 'install', `<absolute path to ${relative(root, unpacked)}>`] });
  console.log(`${manifest.name}: ${filename}`);
}

let installation;
if (!values['skip-install-test']) {
  const host = mkdtempSync(join(tmpdir(), 'friend-pi-native-host-'));
  const closure = copyProductionDependencies(host); writeFileSync(join(host, 'package.json'), '{"private":true,"type":"module"}\n');
  const probe = String.raw`import assert from 'node:assert/strict';
import {mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createAgentSession,DefaultResourceLoader,SessionManager,SettingsManager,ModelRuntime,initTheme} from '@earendil-works/pi-coding-agent';
import {fauxProvider,fauxAssistantMessage,fauxToolCall} from '@earendil-works/pi-ai/providers/faux';
const plugin=process.argv[2],cwd=process.cwd(),agentDir=process.env.PI_CODING_AGENT_DIR;
initTheme('light',false);
const configured=JSON.parse(readFileSync(join(agentDir,'settings.json'),'utf8'));
assert.equal(configured.packages.length,1);
assert.ok(String(configured.packages[0]).includes('/plugins/'+plugin+'/package'));
const runtime=await ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:join(agentDir,'models.json'),allowModelNetwork:false});
const name='friend_'+plugin.replaceAll('-','_');
const fixture=fauxProvider({provider:'package-fixture',models:[{id:'offline',name:'Independent package test',reasoning:false,input:['text'],contextWindow:32768,maxTokens:4096}],tokensPerSecond:10000});
const respond=context=>{
  const all=context.messages.map(message=>typeof message.content==='string'?message.content:Array.isArray(message.content)?message.content.filter(part=>part.type==='text').map(part=>part.text).join(''):'').join('\n');
  if(all.includes('项目经验提取器'))return fauxAssistantMessage('{"memories":[]}');
  if(context.messages.some(message=>message.role==='toolResult'))return fauxAssistantMessage('Independent plugin tool verified.');
  return fauxAssistantMessage(fauxToolCall(name,{action:'snapshot',input:{}}),{stopReason:'toolUse'});
};
fixture.setResponses([respond,respond,respond,respond]);runtime.registerNativeProvider(fixture.provider);await runtime.setRuntimeApiKey('package-fixture','explicit-fake-key');
const settings=SettingsManager.create(cwd,agentDir);
const loader=new DefaultResourceLoader({cwd,agentDir,settingsManager:settings,noThemes:true});await loader.reload({resolveProjectTrust:async()=>true});
const created=await createAgentSession({cwd,agentDir,modelRuntime:runtime,model:fixture.getModel(),resourceLoader:loader,settingsManager:settings,sessionManager:SessionManager.create(cwd,join(agentDir,'sessions'))});
assert.deepEqual(created.extensionsResult.errors,[]);
const executed=[];const session=created.session;
session.subscribe(event=>{if(event.type==='tool_execution_end')executed.push({name:event.toolName,error:event.isError});});
await session.bindExtensions({uiContext:session.extensionRunner.getUIContext(),mode:'rpc',onError:error=>{throw new Error(error.error);}});
try{await session.prompt('Read the independent capability snapshot with '+name+'.');assert.ok(executed.some(event=>event.name===name&&!event.error));console.log(JSON.stringify({plugin,installedFromDirectory:true,piOwnsExecution:true,tool:name,success:true}));}finally{await session.dispose();}
`;
  writeFileSync(join(host, 'probe.mjs'), probe);
  const results = [];
  for (const pkg of packages) {
    const directory = join(host, 'plugins', pkg.plugin, 'package'); mkdirSync(dirname(directory), { recursive: true }); cpSync(join(root, pkg.unpacked), directory, { recursive: true, dereference: true });
    const agentDir = join(host, 'agents', pkg.plugin); const project = join(host, 'projects', pkg.plugin); mkdirSync(agentDir, { recursive: true }); mkdirSync(project, { recursive: true });
    const env = { PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: join(agentDir, 'sessions'), FRIEND_PI_DATA_DIR: join(host, 'data', pkg.plugin), FRIEND_PI_AGENT_DIR: agentDir, NODE_PATH: '', NODE_OPTIONS: '' };
    command(process.execPath, [join(host, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'), 'install', directory], project, false, env);
    const output = command(process.execPath, [join(host, 'probe.mjs'), pkg.plugin], project, true, env);
    const last = output.trim().split('\n').at(-1); const result = JSON.parse(last); if (!result.success) throw new Error(`Independent Pi package failed: ${pkg.name}`); results.push(result);
    console.log(`${pkg.name}: independent Pi directory install + fake provider tool invocation passed`);
  }
  installation = { host, outsideRepository: !host.startsWith(root), aliasFree: true, fakeProviderOnly: true, productionDependencies: closure.dependencies.length, packages: results };
}
const after = sourceIdentity(values['require-clean']);
if (installation) writeFileSync(join(out, 'installation-evidence.initial.json'), `${JSON.stringify({ schemaVersion: 1, source, sourceChangedDuringGeneration: after.treeSha256 !== source.treeSha256 || after.commit !== source.commit, piCommit: piLock.commit, packages, installation, verifiedAt: new Date().toISOString() }, null, 2)}\n`);
if (after.treeSha256 !== source.treeSha256 || after.commit !== source.commit) throw new Error('Source changed during package generation; rerun after candidate is stable');
const manifest = { schemaVersion: 1, source, piCommit: piLock.commit, nodeVersion: piLock.nodeVersion, npmVersion: piLock.npmVersion, packages, installation: installation || { status: 'NOT_RUN' }, packagedAt: new Date().toISOString() };
if (existsSync(join(out, 'manifest.json'))) renameSync(join(out, 'manifest.json'), join(out, `manifest.previous-${Date.now()}.json`));
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Plugin manifest: ${join(out, 'manifest.json')}\nInstall the extracted directories; Pi does not automatically unpack .tgz local sources.`);
