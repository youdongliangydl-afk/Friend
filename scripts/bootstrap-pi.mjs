#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(root, 'pi-source.lock.json'), 'utf8'));
const { values } = parseArgs({ options: {
  'verify-only': { type: 'boolean', default: false },
  'skip-install': { type: 'boolean', default: false },
  'skip-registry-check': { type: 'boolean', default: false },
  'reproduce': { type: 'boolean', default: false },
  help: { type: 'boolean', default: false },
} });
if (values.help) {
  console.log('Usage: node scripts/bootstrap-pi.mjs [--verify-only] [--skip-install] [--reproduce]\nPins Pi source, verifies the immutable model catalog, builds official tarballs, wires all Pi packages, and installs with lifecycle scripts disabled. --reproduce rebuilds a second independent checkout and compares every tarball.');
  process.exit(0);
}
if (lock.schemaVersion !== 1 || !/^[0-9a-f]{40}$/.test(lock.commit)) throw new Error('Unsupported Pi source lock');
if (process.versions.node !== lock.nodeVersion) throw new Error(`Use Node ${lock.nodeVersion}; found ${process.versions.node}`);
const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` };
const cache = join(root, '.cache', 'pi');
const source = join(cache, 'source');
const artifacts = resolve(root, lock.artifactManifest);

function run(command, args, cwd = root, capture = false) {
  return execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', timeout: 900_000 });
}
function npm(args, cwd = root, capture = false) { return run('npm', args, cwd, capture); }
function json(path) { return JSON.parse(readFileSync(path, 'utf8')); }
function hash(path, algorithm = 'sha256', encoding = 'hex') { return createHash(algorithm).update(readFileSync(path)).digest(encoding); }
function checkSource(directory) {
  const head = run('git', ['rev-parse', 'HEAD'], directory, true).trim();
  if (head !== lock.commit) throw new Error(`Pi checkout mismatch: expected ${lock.commit}, found ${head}`);
  const origin = run('git', ['remote', 'get-url', 'origin'], directory, true).trim();
  if (origin !== lock.repository) throw new Error(`Unexpected Pi origin: ${origin}`);
  if (run('git', ['status', '--porcelain'], directory, true).trim()) throw new Error('Pi cached source has local changes. Preserve it and use a fresh cache; bootstrap will not reset or clean it.');
  if (json(join(directory, 'nix', 'model-catalog.json')).revision !== lock.modelCatalog.revision) throw new Error('Pi source and pinned model catalog disagree');
  if (json(join(directory, 'packages', 'coding-agent', 'package.json')).version !== lock.packageVersion) throw new Error('Pi source and package version disagree');
}
function clone(directory) {
  if (!existsSync(directory)) {
    run('git', ['clone', '--filter=blob:none', '--no-checkout', lock.repository, directory]);
    run('git', ['fetch', '--no-tags', 'origin', lock.commit], directory);
    run('git', ['checkout', '--detach', lock.commit], directory);
  }
  checkSource(directory);
}
function verifyArtifactSet(path) {
  const manifest = json(path);
  if (manifest.schemaVersion !== 1 || manifest.source?.commit !== lock.commit || manifest.source?.dirty !== false) throw new Error('Pi artifacts do not bind the clean pinned source');
  if (!Array.isArray(manifest.packages) || manifest.packages.length === 0) throw new Error('Empty Pi artifact set');
  const names = new Set();
  for (const pkg of manifest.packages) {
    if (names.has(pkg.name) || pkg.version !== lock.packageVersion) throw new Error(`Unexpected Pi package identity: ${pkg.name}`);
    names.add(pkg.name);
    const tarball = resolve(dirname(path), pkg.tarball);
    const location = relative(dirname(path), tarball);
    if (location.startsWith('..') || isAbsolute(location)) throw new Error('Pi tarball escapes artifact directory');
    if (`sha512-${hash(tarball, 'sha512', 'base64')}` !== pkg.integrity) throw new Error(`Pi tarball integrity mismatch: ${pkg.name}`);
  }
  if (lock.packages.length) {
    if (manifest.packages.length !== lock.packages.length) throw new Error('Pi artifact set is incomplete');
    for (const expected of lock.packages) {
      const actual = manifest.packages.find((pkg) => pkg.name === expected.name);
      if (!actual || actual.integrity !== expected.integrity || actual.tarball !== expected.tarball) throw new Error(`Pi artifact differs from pinned bytes: ${expected.name}`);
    }
  }
  for (const name of lock.directPackages) if (!names.has(name)) throw new Error(`Missing direct Pi package: ${name}`);
  return manifest;
}

function writeBuildEvidence(manifest) {
  writeFileSync(join(cache, 'bootstrap-evidence.json'), `${JSON.stringify({
    schemaVersion: 1,
    source: manifest.source,
    sourceLockSha256: hash(join(root, 'pi-source.lock.json')),
    nodeVersion: process.versions.node,
    nodePath: process.execPath,
    nodeSha256: hash(process.execPath),
    npmVersion: lock.npmVersion,
    catalogSha256: hash(join(cache, 'models.all.json')),
    artifactManifest: relative(root, artifacts),
    artifactManifestSha256: hash(artifacts),
    packageCount: manifest.packages.length,
    verifiedAt: new Date().toISOString(),
  }, null, 2)}\n`);
}
async function catalog() {
  const path = join(cache, 'models.all.json');
  const expected = lock.modelCatalog.revision.replace(/^sha256-/, '');
  if (!existsSync(path)) {
    console.log(`Downloading immutable model catalog ${lock.modelCatalog.revision}`);
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(lock.modelCatalog.url, { signal: AbortSignal.timeout(60_000) });
        if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Downloaded model catalog SHA256 mismatch');
        JSON.parse(bytes.toString('utf8'));
        writeFileSync(`${path}.tmp`, bytes);
        renameSync(`${path}.tmp`, path);
        break;
      } catch (error) { lastError = error; if (attempt < 2) await new Promise((done) => setTimeout(done, 1000 * 2 ** attempt)); }
    }
    if (!existsSync(path)) throw lastError;
  }
  if (hash(path) !== expected) throw new Error('Cached model catalog SHA256 mismatch; no live-catalog fallback is allowed');
  return path;
}
function build(directory, outputDirectory, catalogPath) {
  if (existsSync(outputDirectory)) {
    // Preserve a failed prior build instead of deleting it or using --force.
    renameSync(outputDirectory, `${outputDirectory}.incomplete-${Date.now()}`);
  }
  console.log(`Installing pinned Pi dependencies in ${relative(root, directory)}`);
  npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], directory);
  run(process.execPath, ['packages/ai/scripts/hydrate-model-catalog.ts', catalogPath], directory);
  checkSource(directory);
  run(process.execPath, ['scripts/pack-packages.mjs', '--out', outputDirectory, '--offline-model-data'], directory);
  checkSource(directory);
  return verifyArtifactSet(join(outputDirectory, 'manifest.json'));
}
function verifyPublicDependencies() {
  const manifests = [join(root, 'package.json')];
  for (const folder of ['packages', 'apps']) {
    if (!existsSync(join(root, folder))) continue;
    for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
      const path = join(root, folder, entry.name, 'package.json');
      if (entry.isDirectory() && existsSync(path)) manifests.push(path);
    }
  }
  const checked = new Set();
  for (const path of manifests) {
    const manifest = json(path);
    for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies })) {
      if (name.startsWith('@friend-pi/') || name.startsWith('@earendil-works/') || version.startsWith('file:')) continue;
      if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw new Error(`External dependency must use an exact version: ${name}@${version}`);
      const specifier = `${name}@${version}`;
      if (checked.has(specifier)) continue;
      const actual = JSON.parse(npm(['view', specifier, 'version', '--json', '--registry=https://registry.npmjs.org'], root, true));
      if (actual !== version) throw new Error(`Public registry does not contain ${specifier}`);
      checked.add(specifier);
    }
  }
  console.log(`Verified ${checked.size} exact external dependency versions in the public registry`);
}
function verifyInstalled(manifest) {
  const installed = json(join(root, 'package-lock.json'));
  const expected = new Map(manifest.packages.map((pkg) => [pkg.name, pkg]));
  const found = new Set();
  for (const [location, pkg] of Object.entries(installed.packages ?? {})) {
    const name = location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (!expected.has(name)) continue;
    const artifact = expected.get(name);
    if (!pkg.resolved?.startsWith('file:') || pkg.integrity !== artifact.integrity) throw new Error(`Pi registry drift in consumer lockfile: ${name}`);
    const actualPath = new URL(pkg.resolved, pathToFileURL(`${root}/`));
    if (actualPath.protocol !== 'file:' || actualPath.pathname !== pathToFileURL(resolve(dirname(artifacts), artifact.tarball)).pathname) throw new Error(`Pi consumer package points outside the pinned artifact set: ${name}`);
    found.add(name);
  }
  for (const name of lock.directPackages) if (!found.has(name)) throw new Error(`Pi consumer package missing: ${name}`);
  console.log(`Verified ${found.size} installed Pi packages against the coherent artifact set`);
}

if (npm(['--version'], root, true).trim() !== lock.npmVersion) throw new Error(`Use npm ${lock.npmVersion}`);
mkdirSync(cache, { recursive: true });
if (values['verify-only']) {
  checkSource(source);
  const manifest = verifyArtifactSet(artifacts);
  await catalog();
  if (existsSync(join(root, 'package-lock.json'))) verifyInstalled(manifest);
  console.log(`Pi ${lock.commit} and every cached tarball verified`);
  process.exit(0);
}
clone(source);
const catalogPath = await catalog();
const manifest = existsSync(artifacts) ? verifyArtifactSet(artifacts) : build(source, dirname(artifacts), catalogPath);
if (values.reproduce) {
  const secondSource = join(cache, 'reproduction-source');
  const secondArtifacts = join(cache, 'reproduction-artifacts');
  clone(secondSource);
  const second = existsSync(join(secondArtifacts, 'manifest.json')) ? verifyArtifactSet(join(secondArtifacts, 'manifest.json')) : build(secondSource, secondArtifacts, catalogPath);
  const equal = manifest.packages.every((pkg) => second.packages.find((candidate) => candidate.name === pkg.name)?.integrity === pkg.integrity);
  if (!equal) throw new Error('Independent Pi builds have different bytes; do not claim bit reproducibility');
  writeFileSync(join(cache, 'reproduction-evidence.json'), `${JSON.stringify({ schemaVersion: 1, source: lock.commit, node: process.versions.node, npm: lock.npmVersion, catalog: lock.modelCatalog.revision, paths: [relative(root, artifacts), relative(root, join(secondArtifacts, 'manifest.json'))], packageCount: manifest.packages.length, identicalTarballs: true, verifiedAt: new Date().toISOString() }, null, 2)}\n`);
  console.log(`Two independent paths produced ${manifest.packages.length} byte-identical Pi tarballs`);
}
if (!existsSync(join(source, 'node_modules', 'yaml', 'package.json'))) npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], source);
run(process.execPath, ['scripts/use-local-packages.mjs', '--manifest', artifacts, '--consumer', root, ...lock.directPackages.flatMap((name) => ['--package', name])], source);
if (!values['skip-install']) {
  if (!values['skip-registry-check']) verifyPublicDependencies();
  const locked = existsSync(join(root, 'package-lock.json'));
  npm([locked ? 'ci' : 'install', '--ignore-scripts', '--no-audit', '--no-fund']);
  verifyInstalled(manifest);
  run(process.execPath, ['--input-type=module', '-e', 'import { createAgentSession } from "@earendil-works/pi-coding-agent"; if (typeof createAgentSession !== "function") throw new Error("Pi SDK missing"); console.log("Pi public SDK import passed");']);
}
writeBuildEvidence(manifest);
console.log(`Pi artifact set ready. ${values['skip-install'] ? 'Application dependency installation was skipped.' : 'Public SDK import verified.'}\nSDK entry: ${join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')}\nCLI entry: ${join(root, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js')}\nArtifact manifest: ${artifacts}`);
