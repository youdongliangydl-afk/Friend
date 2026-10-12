import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Hash actual relevant bytes, rather than mtimes or a model's description of code. */
export function workflowCodeDigest(projectDir:string, paths:string[], dataDir?:string):string {
  const root=realpathSync(projectDir), excluded=dataDir&&existsSync(dataDir)?realpathSync(dataDir):undefined;
  const hash=createHash('sha256');let files=0,bytes=0;
  const visited=new Set<string>();
  const ignored=new Set(['.git','node_modules','.cache','.artifacts','dist','.friendData']);
  const hostEntries=new Set(['plugins.sqlite','plugins.sqlite-wal','plugins.sqlite-shm','plugins.sqlite-journal','pi','sessions','swarm-sessions','swarm-workspaces','swarm-shared','swarm-views','memory-views','memory-migration-backups','projections','artifact-versions','attachments','external-capabilities.json']);
  const inside=(path:string)=>path===root||path.startsWith(root+sep);
  function visit(path:string):void {
    const logical=relative(root,path);
    const parts=logical.split(sep);
    if(parts.includes('.friendData')||parts.some((part,index)=>part==='.pi'&&['tasks','worktrees','subagents'].includes(parts[index+1])))return;
    if(!existsSync(path)){hash.update(`missing:${logical}\n`);return;}
    const physical=realpathSync(path);
    if(!inside(physical))throw new Error('流程代码摘要不能读取项目之外的符号链接');
    if(excluded&&excluded!==root&&inside(excluded)&&(physical===excluded||physical.startsWith(excluded+sep)))return;
    if(excluded===root){const first=relative(root,physical).split(sep)[0];if(hostEntries.has(first)||/^swarm-pre-v[34]-[a-f0-9-]+\.sqlite$/.test(first))return;}
    if(visited.has(physical))return;visited.add(physical);
    const info=lstatSync(physical);
    if(info.isDirectory()){
      for(const name of readdirSync(physical).sort())if(!ignored.has(name))visit(join(physical,name));
      return;
    }
    if(!info.isFile())throw new Error('流程代码摘要只支持普通文件或目录');
    if(++files>8192||(bytes+=info.size)>64*1024*1024)throw new Error('流程代码摘要范围过大，请指定相关 codePaths');
    hash.update(`file:${logical}\0`);hash.update(readFileSync(physical));hash.update('\0');
  }
  for(const path of [...new Set(paths)].sort()){
    if(isAbsolute(path)||path.split(/[\\/]/).includes('..'))throw new Error('codePaths 必须是项目内相对路径');
    const absolute=resolve(root,path);if(!inside(absolute))throw new Error('codePaths 超出项目');
    visit(absolute);
  }
  return hash.digest('hex');
}
