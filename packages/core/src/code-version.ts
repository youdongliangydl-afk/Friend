import {createHash} from 'node:crypto';
import {readdirSync,lstatSync,readFileSync,readlinkSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';

/** Evidence binds source contents, excluding dependencies and host-owned execution artifacts. */
export function projectCodeVersion(projectDir:string,dataDir:string):string{
 const root=resolve(projectDir),data=resolve(dataDir),hash=createHash('sha256');
 const ignored=new Set(['.git','node_modules','.cache','.artifacts','dist']);
 const visit=(dir:string)=>{
  for(const name of readdirSync(dir).sort()){
   const path=join(dir,name),rel=relative(root,path);if(ignored.has(name)||path===data||path.startsWith(data+'/')||/^\.pi\/(?:tasks|worktrees|subagents)(?:\/|$)/.test(rel))continue;
   const info=lstatSync(path);hash.update(rel+'\0'+String(info.mode)+'\0');
   if(info.isSymbolicLink())hash.update(readlinkSync(path));else if(info.isDirectory())visit(path);else if(info.isFile())hash.update(readFileSync(path));
  }
 };
 visit(root);return hash.digest('hex');
}
