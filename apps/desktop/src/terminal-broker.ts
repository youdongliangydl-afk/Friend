import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { terminateOwned, type ProcessIdentity } from './terminal-processes.js';
import type { TerminalContext } from './terminal-controller.js';
export class TerminalBroker {
  private child?:ChildProcess;private ready?:Promise<void>;private closing=false;
  private pending=new Map<string,{resolve(value:unknown):void;reject(error:Error):void;timer:ReturnType<typeof setTimeout>}>();
  private owned=new Map<number,ProcessIdentity>();
  private cleanup:Promise<boolean>=Promise.resolve(true);
  constructor(private root:string,private node:string,private dataDir:string,private emit:(event:Record<string,unknown>)=>void){}
  private start():Promise<void>{
    if(this.ready)return this.ready;
    this.ready=(async()=>{
      if(!await this.cleanup)throw new Error('上次终端进程清理未完成，保留记录供检查');
      if(this.closing)throw new Error('终端正在退出');
      const owned=new Map<number,ProcessIdentity>();this.owned=owned;
      const env={...process.env,FRIEND_PI_DATA_DIR:this.dataDir,PATH:dirname(this.node)+':'+(process.env.PATH||'')};
      for(const key of ['ELECTRON_RUN_AS_NODE','npm_config_target','npm_config_runtime','npm_config_disturl','NODE_OPTIONS'])delete (env as Record<string,unknown>)[key];
      const child=fork(join(this.root,'apps/desktop/dist/terminal-host.mjs'),[],{execPath:this.node,execArgv:[],cwd:this.root,detached:true,stdio:['ignore','ignore','pipe','ipc'],env});this.child=child;
      await new Promise<void>((yes,no)=>{
        const timeout=setTimeout(()=>{no(new Error('终端宿主初始化超时'));child.kill('SIGTERM');},15000);
        child.on('message',(message:any)=>{
          if(message.type==='ready'){clearTimeout(timeout);yes();}
          else if(message.type==='response'){const request=this.pending.get(message.id);if(request){clearTimeout(request.timer);this.pending.delete(message.id);message.error?request.reject(new Error(message.error)):request.resolve(message.result);}}
          else if(message.type==='event'){if(message.event.kind==='owned')for(const identity of message.event.identities)owned.set(identity.pid,identity);else this.emit(message.event);}
        });
        child.on('error',error=>{clearTimeout(timeout);if(this.child===child){this.child=undefined;this.ready=undefined;}this.cleanup=terminateOwned(owned.values()).catch(()=>false);no(error);});
        child.on('exit',()=>{
          clearTimeout(timeout);no(new Error('终端宿主已退出'));
          for(const request of this.pending.values()){clearTimeout(request.timer);request.reject(new Error('终端连接已中断，记录保留'));}this.pending.clear();
          if(this.child===child){this.child=undefined;this.ready=undefined;}
          this.cleanup=terminateOwned(owned.values()).catch(()=>false);this.emit({kind:'disconnected'});
        });
        child.stderr?.on('data',data=>{if(!String(data).includes('ExperimentalWarning'))this.emit({kind:'notice',message:'终端宿主发生错误，请检查运行环境'});});
      });
    })();return this.ready;
  }
  private send(child:ChildProcess,method:string,input:Record<string,unknown>,context:TerminalContext):Promise<unknown>{
    const id=randomUUID();
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('终端操作超时，未自动重放'));},20000);this.pending.set(id,{resolve,reject,timer});child.send({type:'request',id,method,input,context},error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(error);}});});
  }
  async request(method:string,input:Record<string,unknown>,context:TerminalContext):Promise<unknown>{
    if(this.closing)throw new Error('终端正在退出');
    await this.start();const child=this.child;
    if(this.closing||!child?.connected)throw new Error('终端连接已中断');
    return this.send(child,method,input,context);
  }
  async hasRunning(context:TerminalContext){if(!await this.cleanup)throw new Error('终端清理未完成');if(!this.child){if(!await terminateOwned(this.owned.values()))throw new Error('终端清理未完成');return false;}const result=await this.request('list',{},context) as {terminals:{state:string}[]};return result.terminals.some(t=>['running','stopping','cleanup_failed'].includes(t.state));}
  async stopAgentServices(context:TerminalContext){if(this.child)await this.request('stopAgentServices',{},context);}
  async shutdown(){
    this.closing=true;const child=this.child;
    if(child){
      const exited=new Promise<void>(yes=>child.once('exit',()=>yes()));
      try{await this.send(child,'shutdown',{}, {actor:'user',sessionId:'',workspaceId:'',cwd:this.root});}catch{}
      if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
      await Promise.race([exited,new Promise<void>(yes=>setTimeout(yes,4000))]);
      if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await Promise.race([exited,new Promise<void>(yes=>setTimeout(yes,1000))]);}
    }
    const cleaned=await this.cleanup;const verified=await terminateOwned(this.owned.values()).catch(()=>false);
    if(!cleaned||!verified)throw new Error('终端进程清理未能核实');
  }
}
