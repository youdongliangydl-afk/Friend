import { build } from 'esbuild';
import { mkdirSync,existsSync,cpSync,readFileSync,writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const base={bundle:true,platform:'node',target:'node24',format:'esm',sourcemap:true,packages:'external',tsconfig:'tsconfig.json'};
for(const name of ['core','swarm','expert','memory','topic-rebuild']){
  const source=`packages/${name}/src/index.ts`;if(!existsSync(source))throw new Error(`Missing ${source}`);
  mkdirSync(`packages/${name}/dist`,{recursive:true});await build({...base,entryPoints:[source],outfile:`packages/${name}/dist/index.js`,packages:undefined,external:['@earendil-works/*','typebox'],alias:{'@friend-pi/core':'./packages/core/src/index.ts'}});
}
await build({...base,entryPoints:['packages/swarm/src/member.ts'],outfile:'packages/swarm/dist/member.js',packages:undefined,external:['@earendil-works/*','typebox'],alias:{'@friend-pi/core':'./packages/core/src/index.ts'}});
await build({...base,entryPoints:['apps/desktop/src/sdk-worker.ts'],outfile:'apps/desktop/dist/sdk-worker.mjs'});
await build({...base,entryPoints:['apps/desktop/src/main.ts'],outfile:'apps/desktop/dist/main.mjs',format:'esm',external:['electron']});
await build({...base,entryPoints:['apps/desktop/src/preload.ts'],outfile:'apps/desktop/dist/preload.cjs',format:'cjs',external:['electron']});
await build({entryPoints:['apps/desktop/src/renderer/main.tsx'],outfile:'apps/desktop/dist/renderer/app.js',bundle:true,platform:'browser',target:'chrome140',jsx:'automatic',sourcemap:true,define:{'process.env.NODE_ENV':'"production"'}});
cpSync('apps/desktop/src/renderer/index.html','apps/desktop/dist/renderer/index.html');
let sourceCommit=null;let sourceDirty=true;
try {sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();sourceDirty=Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim());} catch {}
writeFileSync('build-info.json',JSON.stringify({schemaVersion:1,sourceCommit,sourceDirty,piCommit:JSON.parse(readFileSync('pi-source.lock.json','utf8')).commit,nodeVersion:process.version,builtAt:new Date().toISOString()},null,2)+'\n');
console.log('Built Pi packages, runtime worker and desktop.');
