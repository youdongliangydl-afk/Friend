#!/usr/bin/env node
import { execFileSync, fork } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const pluginNames = ['swarm', 'expert', 'memory', 'topic-rebuild'];
export function fileHash(path, algorithm = 'sha256', encoding = 'hex') { return createHash(algorithm).update(readFileSync(path)).digest(encoding); }
export function json(path) { return JSON.parse(readFileSync(path, 'utf8')); }
export function command(program, args, cwd = root, capture = false, extraEnv = {}) {
  return execFileSync(program, args, { cwd, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', timeout: 300_000, env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH || ''}`, ...extraEnv } });
}
export function assertToolchain() {
  const lock = json(join(root, 'pi-source.lock.json'));
  if (process.versions.node !== lock.nodeVersion) throw new Error(`Packaging requires Node ${lock.nodeVersion}`);
  if (command('npm', ['--version'], root, true).trim() !== lock.npmVersion) throw new Error(`Packaging requires npm ${lock.npmVersion}`);
  command(process.execPath, [join(root, 'scripts/bootstrap-pi.mjs'), '--verify-only']);
  return lock;
}
export function sourceIdentity(requireClean = false) {
  let commit = null;
  try { commit = command('git', ['rev-parse', '--verify', 'HEAD'], root, true).trim(); } catch { /* An initial development checkout can be uncommitted. */ }
  const dirty = Boolean(command('git', ['status', '--porcelain'], root, true).trim());
  const files = command('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], root, true).split('\0').filter(Boolean).sort();
  const digest = createHash('sha256');
  for (const path of files) { const absolute = join(root, path); if (!existsSync(absolute) || !lstatSync(absolute).isFile()) continue; digest.update(`${path}\0${fileHash(absolute)}\n`); }
  if (requireClean && (!commit || dirty)) throw new Error('Final packaging requires a committed clean candidate');
  return { commit, dirty, treeSha256: digest.digest('hex') };
}
export function treeHash(directory) {
  const digest = createHash('sha256'); const files = [];
  function visit(path) {
    for (const name of readdirSync(path).sort()) {
      const absolute = join(path, name); const stat = lstatSync(absolute); const relativePath = relative(directory, absolute).replaceAll('\\', '/');
      const type = stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : 'file';
      const value = type === 'link' ? readlinkSync(absolute) : type === 'file' ? fileHash(absolute) : '';
      const record = `${type}\0${relativePath}\0${stat.mode & 0o777}\0${value}\n`;
      digest.update(record); files.push({ path: relativePath, type, mode: stat.mode & 0o777, ...(type === 'file' ? { sha256: value, bytes: stat.size } : type === 'link' ? { target: value } : {}) });
      if (type === 'dir') visit(absolute);
    }
  }
  visit(directory); return { algorithm: 'sha256-tree-v1', sha256: digest.digest('hex'), files };
}
export function verifyInternalLinks(directory) {
  function visit(path) {
    for (const name of readdirSync(path)) {
      const absolute = join(path, name); const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        const actual = realpathSync(absolute); const rel = relative(realpathSync(directory), actual);
        if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Packaged link escapes artifact: ${relative(directory, absolute)}`);
      } else if (stat.isDirectory()) visit(absolute);
    }
  }
  visit(directory);
}
export function copyProductionDependencies(destination) {
  const locked = json(join(root, 'package-lock.json')); const piLock = json(join(root, 'pi-source.lock.json'));
  const artifacts = json(join(root, piLock.artifactManifest)); const knownPi = new Map(artifacts.packages.map(pkg => [pkg.name, pkg]));
  const rows = Object.entries(locked.packages).filter(([path, pkg]) => path.startsWith('node_modules/') && !pkg.dev && !pkg.link).sort(([left], [right]) => left.length - right.length || left.localeCompare(right));
  const copied = []; const omittedOptional = []; const roots = [];
  for (const [path, pkg] of rows) {
    const source = join(root, path); const target = join(destination, path);
    if (!existsSync(source)) { if (pkg.optional) { omittedOptional.push(path); continue; } throw new Error(`Missing production dependency ${path}`); }
    if (lstatSync(source).isSymbolicLink()) throw new Error(`Production dependency is an external workspace link: ${path}`);
    const manifest = json(join(source, 'package.json'));
    if (manifest.version !== pkg.version) throw new Error(`Installed dependency differs from lock: ${path}`);
    if (!roots.some(parent => path.startsWith(`${parent}/`))) { mkdirSync(dirname(target), { recursive: true }); cpSync(source, target, { recursive: true, dereference: false, verbatimSymlinks: true }); roots.push(path); }
    const canonicalPi = knownPi.get(manifest.name);
    if (canonicalPi) {
      if (!pkg.resolved?.startsWith('file:') || pkg.integrity !== canonicalPi.integrity) throw new Error(`Pi closure drift: ${manifest.name}`);
      const tarball = resolve(dirname(join(root, piLock.artifactManifest)), canonicalPi.tarball);
      if (`sha512-${fileHash(tarball, 'sha512', 'base64')}` !== canonicalPi.integrity) throw new Error(`Pi tarball changed: ${manifest.name}`);
      command('tar', ['-xzf', tarball, '--strip-components=1', '-C', target]);
    }
    copied.push({ path, name: manifest.name, version: manifest.version, license: manifest.license || 'see retained package notices', integrity: pkg.integrity, resolved: canonicalPi ? canonicalPi.tarball : pkg.resolved, noticePaths: readdirSync(source).filter(name => /^(?:licen[cs]e|notice|copying)(?:[._-].*)?$/i.test(name)).map(name => `${path}/${name}`) });
  }
  for (const direct of piLock.directPackages) if (!copied.some(pkg => pkg.name === direct)) throw new Error(`Direct SDK missing from production closure: ${direct}`);
  verifyInternalLinks(join(destination, 'node_modules'));
  return { dependencies: copied, omittedOptional };
}
function copyOwnPackage(name, destination) {
  const source = join(root, 'packages', name); mkdirSync(destination, { recursive: true });
  for (const file of ['package.json', 'README.md', 'LICENSE', 'SOURCES.md']) if (existsSync(join(source, file))) copyFileSync(join(source, file), join(destination, file));
  cpSync(join(source, 'dist'), join(destination, 'dist'), { recursive: true, dereference: true });
  if (!existsSync(join(destination, 'LICENSE'))) copyFileSync(join(root, 'LICENSE'), join(destination, 'LICENSE'));
}
function copyNotices(appRoot, nodeRoot, closure) {
  const notices = join(appRoot, 'third-party-licenses'); mkdirSync(notices, { recursive: true });
  for (const [name, source] of [['pi', join(root, '.cache/pi/source/LICENSE')], ['node', join(nodeRoot, 'LICENSE')], ['electron', join(root, 'node_modules/electron/dist/LICENSE')], ['react', join(root, 'node_modules/react/LICENSE')], ['react-dom', join(root, 'node_modules/react-dom/LICENSE')], ['scheduler', join(root, 'node_modules/scheduler/LICENSE')]]) { mkdirSync(join(notices, name), { recursive: true }); copyFileSync(source, join(notices, name, 'LICENSE')); }
  mkdirSync(join(notices,'pi-background-tasks'),{recursive:true});for(const file of ['LICENSE','SOURCE.json','ADAPTATIONS.md','THIRD_PARTY_NOTICES.md'])copyFileSync(join(root,'third-party/pi-background-tasks',file),join(notices,'pi-background-tasks',file));
  copyFileSync(join(root, 'node_modules/electron/dist/LICENSES.chromium.html'), join(notices, 'electron', 'LICENSES.chromium.html'));
  writeFileSync(join(notices, 'dependencies.json'), `${JSON.stringify(closure, null, 2)}\n`);
  copyFileSync(join(root, 'THIRD_PARTY_NOTICES.md'), join(notices, 'NOTICE.md'));
}

async function verifyWorker(node, appRoot, piCommit) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'friend-pi-packaged-worker-')); const project = join(fixtureRoot, 'project'); const data = join(fixtureRoot, 'data'); mkdirSync(project, { recursive: true });
  const child = fork(join(appRoot, 'apps/desktop/dist/sdk-worker.mjs'), [], { execPath: node, cwd: project, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, PATH: `${dirname(node)}:/usr/bin:/bin:/usr/sbin:/sbin`, FRIEND_PI_ROOT: appRoot, FRIEND_PI_PROJECT: project, FRIEND_PI_DATA_DIR: data, FRIEND_PI_AGENT_DIR: join(data, 'pi'), FRIEND_PI_MEMBER_WORKER: join(appRoot, 'packages/swarm/dist/member.js'), FRIEND_PI_TEST_PROVIDER: '1', FRIEND_PI_MODEL: 'friend-fixture/offline', FRIEND_PI_PLUGINS: JSON.stringify(pluginNames), FRIEND_PI_SESSION_FILE: '', NODE_PATH: '', NODE_OPTIONS: '' } });
  const pending = new Map(); let resolveReady; let rejectReady; let resolveSettled; let diagnostic = '';
  const ready = new Promise((resolveResult, reject) => { resolveReady = resolveResult; rejectReady = reject; });
  const settled = new Promise(resolveResult => { resolveSettled = resolveResult; });
  const timeout = setTimeout(() => rejectReady(new Error(`Packaged worker initialization timed out: ${diagnostic}`)), 30_000);
  child.stderr?.on('data', value => { diagnostic = (diagnostic + String(value)).slice(-4000); });
  child.on('message', raw => {
    if (raw.type === 'ready') resolveReady(raw);
    if (raw.type === 'fatal') rejectReady(new Error(String(raw.error)));
    if (raw.type === 'response') { const request = pending.get(raw.id); if (request) { clearTimeout(request.timer); pending.delete(raw.id); if (raw.error) request.reject(new Error(raw.error)); else request.resolve(raw.result); } }
    if (raw.type === 'event' && raw.event?.type === 'pi' && raw.event.data?.type === 'agent_settled') resolveSettled();
  });
  child.on('exit', () => { rejectReady(new Error(`Packaged worker exited: ${diagnostic}`)); for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Packaged worker exited')); } pending.clear(); });
  function request(method, input = {}) { const id = randomUUID(); return new Promise((resolveResult, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Packaged ${method} timed out`)); }, 30_000); pending.set(id, { resolve: resolveResult, reject, timer }); child.send({ type: 'request', id, method, input }); }); }
  try {
    const initialized = await ready; clearTimeout(timeout);
    if (initialized.piSource !== piCommit || initialized.state.modelId !== 'friend-fixture/offline') throw new Error('Packaged worker selected an unexpected Pi or provider');
    for (const plugin of pluginNames) await request('plugin', { plugin, action: 'snapshot', input: {} });
    await request('send', { text: 'Packaging fixture: describe this empty temporary project.', mode: 'single' });
    await Promise.race([settled, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Packaged fake-provider agent never settled')), 30_000); timer.unref(); })]);
    const state = await request('state');
    if (state.isRunning || !state.messages?.some(message => message.role === 'assistant')) throw new Error('Packaged worker did not finish through the Pi lifecycle');
    if (!state.sessionFile || !realpathSync(state.sessionFile).startsWith(realpathSync(data))) throw new Error('Packaged worker history escaped its isolated fixture directory');
    return { success: true, outsideRepository: true, fakeProviderOnly: true, plugins: pluginNames, nativeSessionHistory: true, sessionFile: state.sessionFile };
  } finally {
    clearTimeout(timeout);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Fixture closed')); } pending.clear();
    if (child.connected) child.send({ type: 'request', id: randomUUID(), method: 'shutdown', input: {} });
    await new Promise(done => { if (child.exitCode !== null) { done(); return; } child.once('exit', done); setTimeout(() => { child.kill(); done(); }, 2000).unref(); });
  }
}

async function verifyLearningHost(node,appRoot){
 const data=mkdtempSync(join(tmpdir(),'friend-pi-packaged-learning-'));const child=fork(join(appRoot,'apps/desktop/dist/learning-worker.mjs'),[],{execPath:node,cwd:tmpdir(),stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,FRIEND_PI_ROOT:appRoot,FRIEND_PI_DATA_DIR:data,FRIEND_PI_LEARNING_ROLE:'host',FRIEND_PI_TEST_PROVIDER:'1',NODE_PATH:'',NODE_OPTIONS:''}});let diagnostic='';const pending=new Map();let resolveReady,rejectReady;const ready=new Promise((yes,no)=>{resolveReady=yes;rejectReady=no;});let exited=false;const exit=new Promise(yes=>child.once('exit',code=>{exited=true;yes(code);rejectReady(new Error('Packaged learning host exited: '+diagnostic));}));child.stderr?.on('data',value=>{diagnostic=(diagnostic+String(value)).slice(-3000);});child.on('message',raw=>{if(raw.type==='ready')resolveReady();if(raw.type==='response'){const operation=pending.get(raw.id);if(operation){clearTimeout(operation.timer);pending.delete(raw.id);raw.error?operation.no(new Error(String(raw.error))):operation.yes(raw.result);}}});const request=method=>new Promise((yes,no)=>{const id=randomUUID();const timer=setTimeout(()=>{pending.delete(id);no(new Error('Packaged learning host '+method+' timed out'));},15000);pending.set(id,{yes,no,timer});child.send({type:'request',id,method,input:{}});});let timeout;try{await Promise.race([ready,new Promise((_,no)=>{timeout=setTimeout(()=>no(new Error('Packaged learning host not ready: '+diagnostic)),15000);})]);clearTimeout(timeout);const core=await import(pathToFileURL(join(appRoot,'node_modules/@friend-pi/core/dist/index.js')).href);const registry=new core.RecordStore('runtime',data);try{if(registry.get('learning-host')?.value.pid!==child.pid)throw new Error('Packaged host did not publish its own lease');await request('pause');await request('resume');await request('shutdown');const code=await Promise.race([exit,new Promise((_,no)=>setTimeout(()=>no(new Error('Packaged host did not exit')),5000).unref())]);if(code!==0||registry.get('learning-host'))throw new Error('Packaged learning host shutdown/lease failed');return {success:true,outsideRepository:true,isolatedFakeProvider:true,pauseResume:true,leaseReleased:true};}finally{registry.close();}}finally{clearTimeout(timeout);for(const operation of pending.values()){clearTimeout(operation.timer);operation.no(new Error('Fixture closed'));}if(!exited)child.kill();await Promise.race([exit,new Promise(yes=>setTimeout(yes,1000))]);rmSync(data,{recursive:true,force:true});}}

async function main() {
  const { values } = parseArgs({ options: { 'skip-build': { type: 'boolean', default: false }, 'require-clean': { type: 'boolean', default: false }, 'no-zip': { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } });
  if (values.help) { console.log('Usage: node scripts/package-desktop.mjs [--skip-build] [--require-clean] [--no-zip]\nProduces a self-contained macOS arm64 application with a local ad-hoc outer signature. No Developer ID or notarization. Final delivery must use --require-clean and verify this exact candidate.'); return; }
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This first release packages macOS arm64 only');
  const piLock = assertToolchain();
  if (!values['skip-build']) command(process.execPath, [join(root, 'scripts/build.mjs')]);
  const source = sourceIdentity(values['require-clean']); const appMetadata = json(join(root, 'package.json')); const buildInfo = json(join(root, 'build-info.json'));
  if (buildInfo.piCommit !== piLock.commit || buildInfo.sourceCommit !== source.commit) throw new Error('Build information differs from packaging source; rebuild the candidate');
  if (values['require-clean'] && buildInfo.sourceDirty) throw new Error('Build was made from a dirty candidate; rebuild after committing');
  const out = join(root, '.artifacts', 'mac'); mkdirSync(out, { recursive: true });
  const finalApp = join(out, 'Friend-Pi.app');
  if (existsSync(finalApp) && command('ps', ['-axo', 'command'], root, true).split('\n').some(line => line.includes(`${finalApp}/Contents/`))) throw new Error('Quit the running delivery application before replacing its artifact');
  const stage = join(out, `.staging-${randomUUID()}`); const stagedApp = join(stage, 'Friend-Pi.app');
  mkdirSync(stage, { recursive: true });
  console.log('Copying Electron, runtime and the locked production dependency closure…');
  cpSync(join(root, 'node_modules/electron/dist/Electron.app'), stagedApp, { recursive: true, dereference: false, verbatimSymlinks: true });
  const resources = join(stagedApp, 'Contents', 'Resources'); const appRoot = join(resources, 'app'); const runtime = join(resources, 'runtime'); mkdirSync(appRoot, { recursive: true }); mkdirSync(runtime, { recursive: true });
  if (existsSync(join(resources, 'default_app.asar'))) rmSync(join(resources, 'default_app.asar'));
  const targetDesktop = join(appRoot, 'apps/desktop/dist'); mkdirSync(targetDesktop, { recursive: true });
  for (const file of ['main.mjs', 'main.mjs.map', 'preload.cjs', 'preload.cjs.map', 'sdk-worker.mjs', 'sdk-worker.mjs.map','learning-worker.mjs','learning-worker.mjs.map']) copyFileSync(join(root, 'apps/desktop/dist', file), join(targetDesktop, file));
  cpSync(join(root, 'apps/desktop/dist/renderer'), join(targetDesktop, 'renderer'), { recursive: true });
  for (const name of ['core', ...pluginNames]) copyOwnPackage(name, join(appRoot, 'packages', name));
  const closure = copyProductionDependencies(appRoot);
  copyOwnPackage('core', join(appRoot, 'node_modules/@friend-pi/core'));
  for (const name of pluginNames) copyOwnPackage(name, join(appRoot, 'node_modules/@friend-pi', name));
  for (const file of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'pi-source.lock.json', 'build-info.json']) copyFileSync(join(root, file), join(appRoot, file));
  mkdirSync(join(appRoot, 'docs'), { recursive: true }); for (const file of ['sources.json', 'packaging.md']) copyFileSync(join(root, 'docs', file), join(appRoot, 'docs', file));
  if (existsSync(join(root, 'README.md'))) copyFileSync(join(root, 'README.md'), join(appRoot, 'README.md'));
  copyFileSync(join(root, 'package-lock.json'), join(appRoot, 'SOURCE_DEPENDENCY_LOCK.json'));
  cpSync(dirname(join(root, piLock.artifactManifest)), dirname(join(appRoot, piLock.artifactManifest)), { recursive: true });
  writeFileSync(join(appRoot, 'package.json'), `${JSON.stringify({ name: 'friend-pi-desktop', version: appMetadata.version, private: true, type: 'module', main: 'apps/desktop/dist/main.mjs', engines: { node: piLock.nodeVersion }, dependencies: { ...appMetadata.dependencies, '@friend-pi/core': 'file:./packages/core' } }, null, 2)}\n`);
  const nodeRoot = resolve(dirname(process.execPath), '..'); const bundledNode = join(runtime, 'node'); copyFileSync(process.execPath, bundledNode); chmodSync(bundledNode, 0o755);
  copyFileSync(join(nodeRoot, 'LICENSE'), join(runtime, 'NODE-LICENSE'));
  cpSync(join(nodeRoot, 'lib/node_modules/npm'), join(runtime, 'lib/node_modules/npm'), { recursive: true, dereference: false, verbatimSymlinks: true });
  symlinkSync('lib/node_modules/npm/bin/npm-cli.js', join(runtime, 'npm')); symlinkSync('lib/node_modules/npm/bin/npx-cli.js', join(runtime, 'npx'));
  if (command(bundledNode, ['--version'], tmpdir(), true).trim() !== `v${piLock.nodeVersion}`) throw new Error('Bundled Node version mismatch');
  if (command(bundledNode, [join(runtime, 'lib/node_modules/npm/bin/npm-cli.js'), '--version'], tmpdir(), true).trim() !== piLock.npmVersion) throw new Error('Bundled npm version mismatch');
  copyNotices(appRoot, nodeRoot, closure);
  const plist = join(stagedApp, 'Contents/Info.plist');
  for (const [key, value] of Object.entries({ CFBundleName: 'Friend-Pi', CFBundleDisplayName: 'Friend-Pi', CFBundleIdentifier: 'local.friendpi.desktop', CFBundleExecutable: 'Friend-Pi', CFBundleShortVersionString: appMetadata.version, CFBundleVersion: appMetadata.version })) command('/usr/bin/plutil', ['-replace', key, '-string', value, plist]);
  renameSync(join(stagedApp, 'Contents/MacOS/Electron'), join(stagedApp, 'Contents/MacOS/Friend-Pi'));
  // ARM64 requires a loadable code signature. Replace only the outer local seal;
  // preserve upstream nested framework signatures and never use --deep signing.
  try { command('/usr/bin/codesign', ['--remove-signature', stagedApp], root, true); } catch (error) { if (!String(error.stderr || '').includes('not signed')) throw error; }
  command('/usr/bin/codesign', ['--force', '--sign', '-', stagedApp], root, true);
  command('/usr/bin/codesign', ['--verify', '--strict', stagedApp], root, true);
  const electronVersion = json(join(root, 'node_modules/electron/package.json')).version;
  const nativeVersion = command(join(stagedApp, 'Contents/MacOS/Friend-Pi'), ['--version'], tmpdir(), true, { ELECTRON_RUN_AS_NODE: undefined }).trim();
  if (nativeVersion !== `v${electronVersion}`) throw new Error(`Packaged native Electron cannot execute: ${nativeVersion}`);
  verifyInternalLinks(stagedApp);
  const sdkUrl = pathToFileURL(join(appRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')).href;
  const coreUrl = pathToFileURL(join(appRoot, 'node_modules/@friend-pi/core/dist/index.js')).href;
  command(bundledNode, ['--input-type=module', '-e', `import {createAgentSession} from ${JSON.stringify(sdkUrl)}; import {RecordStore} from ${JSON.stringify(coreUrl)}; if(typeof createAgentSession!=='function'||typeof RecordStore!=='function')throw new Error('SDK closure incomplete');console.log('Packaged SDK and core import from outside checkout passed');`], tmpdir());
  const cliVersion = command(bundledNode, [join(appRoot, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'), '--version'], tmpdir(), true).trim();
  if (cliVersion !== piLock.packageVersion) throw new Error('Bundled CLI version mismatch');
  const learningSmoke=await verifyLearningHost(bundledNode,appRoot);console.log('Packaged independent learning host startup, pause/resume and shutdown passed outside checkout');const workerSmoke = await verifyWorker(bundledNode, appRoot, piLock.commit); console.log('Packaged SDK worker fork, four plugins and fake-provider lifecycle passed outside checkout');
  writeFileSync(join(stage, 'inspection.json'), `${JSON.stringify({ schemaVersion: 1, source, buildInfo, piCommit: piLock.commit, stagedApp, fakeProviderOnly: true, checks: { internalSymlinks: true, bundledSdkImport: true, bundledPiCliVersion: cliVersion, packagedSdkFork: workerSmoke,packagedLearningHost:learningSmoke, actualGUI: 'NOT_RUN' }, inspectedAt: new Date().toISOString() }, null, 2)}\n`);
  for (const file of [join(targetDesktop, 'main.mjs'), join(targetDesktop, 'sdk-worker.mjs'),join(targetDesktop,'learning-worker.mjs')]) if (readFileSync(file, 'utf8').includes(root)) throw new Error('Packaged entry contains a development checkout path');
  const after = sourceIdentity(values['require-clean']); if (source.treeSha256 !== after.treeSha256 || source.commit !== after.commit) throw new Error('Source changed during packaging; stage retained, rerun after the candidate is stable');
  const digested = treeHash(stagedApp);
  writeFileSync(join(stage, 'files.json'), `${JSON.stringify(digested.files, null, 2)}\n`);
  const timestamp = Date.now(); if (existsSync(finalApp)) renameSync(finalApp, join(out, `Friend-Pi.previous-${timestamp}.app`)); renameSync(stagedApp, finalApp);
  let archive;
  if (!values['no-zip']) { const target = join(out, 'Friend-Pi-mac-arm64.zip'); if (existsSync(target)) renameSync(target, join(out, `Friend-Pi.previous-${timestamp}.zip`)); command('/usr/bin/ditto', ['-c', '-k', '--keepParent', finalApp, target]); archive = { file: relative(root, target), sha256: fileHash(target) }; }
  const delivery = { schemaVersion: 1, kind: 'local-adhoc-macos-arm64', source, buildInfo, buildInfoSha256: fileHash(join(finalApp, 'Contents/Resources/app/build-info.json')), piCommit: piLock.commit, piArtifactManifestSha256: fileHash(join(root, piLock.artifactManifest)), dependencyLockSha256: fileHash(join(root, 'package-lock.json')), nodeVersion: piLock.nodeVersion, nodeSha256: fileHash(join(finalApp, 'Contents/Resources/runtime/node')), npmVersion: piLock.npmVersion, electronVersion, app: relative(root, finalApp), signing: { identity: 'adhoc', developerId: false, notarized: false, distributionSigning: false, nestedFrameworksResigned: false, verified: true }, artifactHashAlgorithm: digested.algorithm, artifactSha256: digested.sha256, archive, checks: { internalSymlinks: true, noDevelopmentEntryPaths: true, bundledSdkImport: true, bundledPiCliVersion: cliVersion, nativeElectronVersion: nativeVersion, codesignVerified: true, packagedSdkFork: workerSmoke,packagedLearningHost:learningSmoke, actualGUI: 'NOT_RUN', realModel: 'NOT_RUN' }, packagedAt: new Date().toISOString() };
  if (existsSync(join(out, 'delivery-manifest.json'))) renameSync(join(out, 'delivery-manifest.json'), join(out, `delivery-manifest.previous-${timestamp}.json`));
  writeFileSync(join(out, 'delivery-manifest.json'), `${JSON.stringify(delivery, null, 2)}\n`); renameSync(join(stage, 'files.json'), join(out, 'files.json'));
  const alias = join(root, '.artifacts/delivery-manifest.json');
  if (existsSync(alias) && (!lstatSync(alias).isSymbolicLink() || readlinkSync(alias) !== 'mac/delivery-manifest.json')) renameSync(alias, join(root, `.artifacts/delivery-manifest.previous-${timestamp}.json`));
  if (!existsSync(alias)) symlinkSync('mac/delivery-manifest.json', alias);
  console.log(`Application: ${finalApp}\nSHA256 tree: ${digested.sha256}\nManifest: ${join(out, 'delivery-manifest.json')}\nGUI and real-model acceptance are separate checks for this exact artifact.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
