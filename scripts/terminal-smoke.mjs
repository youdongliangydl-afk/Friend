import {fork,execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync,realpathSync} from 'node:fs';
import {join,dirname} from 'node:path';import {tmpdir} from 'node:os';
export async function verifyTerminalHost(node,appRoot){
 const directory=mkdtempSync(join(tmpdir(),'friend-terminal-smoke-')),pending=new Map(),identities=new Map();
 const child=fork(join(appRoot,'apps/desktop/dist/terminal-host.mjs'),[],{execPath:node,execArgv:[],cwd:directory,stdio:['ignore','ignore','pipe','ipc'],env:{...process.env,PATH:dirname(node)+':'+process.env.PATH,FRIEND_PI_DATA_DIR:join(directory,'data'),SHELL:process.platform==='darwin'?'/bin/zsh':'/bin/sh',ZDOTDIR:directory,NODE_OPTIONS:'',NODE_PATH:'',ELECTRON_RUN_AS_NODE:undefined}});
 let exited=false,diagnostic='',resolveReady,rejectReady;
 const ready=new Promise((yes,no)=>{resolveReady=yes;rejectReady=no;});
 const exit=new Promise(yes=>child.once('exit',code=>{exited=true;for(const r of pending.values()){clearTimeout(r.timer);r.no(new Error('Host exited: '+diagnostic));}pending.clear();rejectReady(new Error('Host exited: '+diagnostic));yes(code);}));
 child.stderr.on('data',bytes=>diagnostic=(diagnostic+String(bytes)).slice(-3000));child.on('error',rejectReady);
 child.on('message',message=>{if(message.type==='ready')resolveReady();if(message.type==='event'&&message.event.kind==='owned')for(const identity of message.event.identities)identities.set(identity.pid,identity);if(message.type==='response'){const r=pending.get(message.id);if(r){clearTimeout(r.timer);pending.delete(message.id);message.error?r.no(new Error(message.error)):r.yes(message.result);}}});
 const rpc=(method,input={},context=user)=>new Promise((yes,no)=>{const id=randomUUID(),timer=setTimeout(()=>{pending.delete(id);no(new Error('RPC timeout '+method));},10000);pending.set(id,{yes,no,timer});child.send({type:'request',id,method,input,context});});
 const user={actor:'user',sessionId:'smoke',workspaceId:'fixture',cwd:directory},agent={...user,actor:'agent'},plan={...agent,planMode:true};
 const until=async(fn)=>{const deadline=Date.now()+8000;while(!await fn()){if(Date.now()>deadline)throw new Error('PTY output timeout: '+diagnostic);await new Promise(yes=>setTimeout(yes,50));}};
 const reject=async(method,input,ctx,reason)=>{try{await rpc(method,input,ctx);}catch(error){if(String(error).includes(reason))return;throw error;}throw new Error('Unauthorized operation allowed '+method);};
 let timer;
 try{
  await Promise.race([ready,new Promise((_,no)=>{timer=setTimeout(()=>no(new Error('Host ready timeout '+diagnostic)),10000);})]);clearTimeout(timer);
  const suffix=randomUUID().replaceAll('-',''),marker='FRIEND_PTY_'+suffix;
  const terminal=await rpc('create',{command:"pwd -P; printf '%s%s\\n' 'FRIEND_PTY_' '"+suffix+"'"},agent),id=terminal.id;let epoch=terminal.authorityEpoch;
  await until(async()=>{const result=await rpc('read',{id,authorityEpoch:epoch},agent);return result.output.includes(marker)&&result.output.includes(realpathSync(directory));});
  const size=await rpc('resize',{id,cols:110,rows:28});if(size.cols!==110||size.rows!==28||size.owner!=='agent')throw new Error('Resize or ownership failed');
  await rpc('response',{id,data:'\x1b[1;1R'});if((await rpc('read',{id})).owner!=='agent')throw new Error('Protocol response took over');
  await rpc('list',{},plan);await rpc('read',{id,authorityEpoch:epoch},plan);for(const method of ['create','input','stop'])await reject(method,{id,data:'\r',authorityEpoch:epoch},plan,'计划模式');
  await reject('read',{id},{...user,sessionId:'foreign'},'不属于');
  await rpc('input',{id,data:' '});const taken=await rpc('read',{id});if(taken.owner!=='user'||taken.authorityEpoch<=epoch)throw new Error('Input did not take over');
  for(const method of ['read','input','stop'])await reject(method,{id,data:'\r',authorityEpoch:epoch},agent,'接管');
  const released=await rpc('release',{id});epoch=released.authorityEpoch;if(released.owner!=='agent'||epoch<=taken.authorityEpoch)throw new Error('Handback failed');await rpc('read',{id,authorityEpoch:epoch},agent);
  const stopped=await rpc('stop',{id,authorityEpoch:epoch},agent);if(stopped.state!=='exited')throw new Error('PTY cleanup failed');
  const rows=execFileSync('/bin/ps',['-axo','pid=,stat='],{encoding:'utf8'}).split('\n');if(rows.some(row=>{const fields=row.trim().split(/\s+/);return Number(fields[0])===terminal.pid&&!fields[1]?.startsWith('Z');}))throw new Error('PTY shell survived stop');
  const closed=await rpc('shutdown');if(!closed.stopped)throw new Error('Shutdown cleanup unverified');await Promise.race([exit,new Promise((_,no)=>setTimeout(()=>no(new Error('Host exit timeout')),3000).unref())]);
  return {success:true,outsideRepository:true,nativeNode24Pty:true,readWriteResize:true,protocolDoesNotTakeover:true,takeoverAndEpochFence:true,planReadOnly:true,foreignSessionRejected:true,processCleanup:true,credentialsUsed:false};
 }finally{
  clearTimeout(timer);if(!exited){try{await rpc('shutdown');}catch{}if(!exited)child.kill('SIGTERM');await Promise.race([exit,new Promise(yes=>setTimeout(yes,1000))]);if(!exited){child.kill('SIGKILL');await Promise.race([exit,new Promise(yes=>setTimeout(yes,1000))]);}if(!exited)throw new Error('Host did not exit after cleanup');}
  for(const r of pending.values()){clearTimeout(r.timer);r.no(new Error('Fixture closed'));}pending.clear();
  // A process identity snapshot prevents accidentally killing a reused PID.
  const snapshot=execFileSync('/bin/ps',['-axo','pid=,lstart=,stat='],{encoding:'utf8'}).split('\n');
  for(const identity of identities.values()){const row=snapshot.find(row=>Number(row.trim().split(/\s+/)[0])===identity.pid);if(row){const fields=row.trim().split(/\s+/);if(fields.slice(1,6).join(' ')===identity.born&&!fields[6]?.startsWith('Z')){try{process.kill(identity.pid,'SIGKILL');}catch{}}}}
  const deadline=Date.now()+2000;while(true){const rows=execFileSync('/bin/ps',['-axo','pid=,lstart=,stat='],{encoding:'utf8'}).split('\n');const alive=[...identities.values()].some(identity=>rows.some(row=>{const f=row.trim().split(/\s+/);return Number(f[0])===identity.pid&&f.slice(1,6).join(' ')===identity.born&&!f[6]?.startsWith('Z');}));if(!alive)break;if(Date.now()>deadline)throw new Error('Terminal fixture descendants survived');await new Promise(yes=>setTimeout(yes,50));}
  rmSync(directory,{recursive:true,force:true});
 }
}
