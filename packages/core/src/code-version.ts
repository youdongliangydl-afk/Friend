import {createHash} from 'node:crypto';
import {existsSync,readdirSync,lstatSync,readFileSync,readlinkSync,realpathSync} from 'node:fs';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';

/** Evidence binds source contents, excluding dependencies and host-owned execution artifacts. */
export function projectCodeVersion(projectDir:string,dataDir:string):string{
 const root=realpathSync(projectDir),data=existsSync(dataDir)?realpathSync(dataDir):resolve(dataDir),hash=createHash('sha256');
 const ignored=new Set(['.git','node_modules','.cache','.artifacts','dist']);
 const dataRelative=relative(root,data),nestedData=!!dataRelative&&dataRelative!=='..'&&!dataRelative.startsWith('..'+sep)&&!isAbsolute(dataRelative);
 // These are host roots, never names to ignore throughout a user's project.
 const hostEntries=new Set(['plugins.sqlite','plugins.sqlite-wal','plugins.sqlite-shm','plugins.sqlite-journal','pi','sessions','swarm-sessions','swarm-workspaces','swarm-shared','swarm-views','memory-views','memory-migration-backups','projections','artifact-versions','attachments','external-capabilities.json']);
 const visit=(dir:string)=>{
  for(const name of readdirSync(dir).sort()){
   const path=join(dir,name),rel=relative(root,path);if(ignored.has(name)||nestedData&&path===data||dir===data&&(hostEntries.has(name)||/^swarm-pre-v3-[a-f0-9-]+\.sqlite$/.test(name))||/^\.pi\/(?:tasks|worktrees|subagents)(?:\/|$)/.test(rel))continue;
   const info=lstatSync(path);hash.update(rel+'\0'+String(info.mode)+'\0');
   if(info.isSymbolicLink())hash.update(readlinkSync(path));else if(info.isDirectory())visit(path);else if(info.isFile())hash.update(readFileSync(path));
  }
 };
 visit(root);return hash.digest('hex');
}
