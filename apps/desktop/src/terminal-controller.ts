import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { spawn, type IPty } from 'node-pty';
import { RecordStore, text } from '@friend-pi/core';
import { processSnapshot, ownedDescendants, terminateOwned, type ProcessIdentity } from './terminal-processes.js';
export interface TerminalContext { sessionId: string; workspaceId: string; cwd: string; actor: 'user' | 'agent'; planMode?: boolean; runId?: string }
export interface TerminalRecord {
  id: string; sessionId: string; workspaceId: string; cwd: string; name: string; service: boolean; owner: 'user' | 'agent'; authorityEpoch: number;
  state: 'running' | 'stopping' | 'exited' | 'interrupted' | 'cleanup_failed'; output: string; seq: number; cols: number; rows: number; pid?: number; exitCode?: number; runId?: string;
}
interface LiveTerminal { pty: IPty; identity?: ProcessIdentity; owned: Map<number, ProcessIdentity>; stopping?: Promise<boolean> }
export class TerminalController {
  private store: RecordStore;
  private records = new Map<string,TerminalRecord>();
  private live = new Map<string,LiveTerminal>();
  private timer: ReturnType<typeof setInterval>;
  private closed=false;
  private captures=new Map<string,number>();
  constructor(dataDir: string, private emit: (event: Record<string,unknown>) => void) {
    this.store = new RecordStore('terminals',dataDir);
    for(const row of this.store.list<TerminalRecord>()) {
      const record=row.value;
      if(record.state==='running'||record.state==='stopping')record.state='interrupted';
      this.records.set(record.id,record);this.store.put(record.id,record);
    }
    this.timer=setInterval(()=>{for(const [id,live] of this.live)try{this.capture(id,live);const record=this.records.get(id);if(record)this.save(record);}catch{}},250);this.timer.unref();
  }
  private public(record:TerminalRecord,actor:'user'|'agent',includeOutput=false) {
    return {...record,output:includeOutput?record.output:undefined,pid:record.pid};
  }
  private save(record:TerminalRecord) { if(!this.closed)this.store.put(record.id,record); }
  private event(record:TerminalRecord,kind:string,extra:Record<string,unknown>={}) {
    this.emit({kind,id:record.id,sessionId:record.sessionId,owner:record.owner,authorityEpoch:record.authorityEpoch,seq:record.seq,state:record.state,...extra});
  }
  private capture(id:string,live:LiveTerminal) {
    if(!live.identity)return;
    ownedDescendants(live.identity,processSnapshot(),live.owned);
    this.emit({kind:'owned',id,identities:[...live.owned.values()]});
  }
  private target(ctx:TerminalContext,input:Record<string,unknown>) {
    const record=this.records.get(text(input.id,'终端'));
    if(!record||record.sessionId!==ctx.sessionId||record.workspaceId!==ctx.workspaceId)throw new Error('终端不属于当前会话');
    return record;
  }
  private agentAuthority(ctx:TerminalContext,record:TerminalRecord,input:Record<string,unknown>) {
    if(ctx.actor==='agent'&&(!record.service||record.owner!=='agent'||input.authorityEpoch!==record.authorityEpoch))throw new Error('终端已由用户接管，旧控制请求已失效');
  }
  async handle(method:string,input:Record<string,unknown>,ctx:TerminalContext):Promise<unknown> {
    if(ctx.actor==='agent'&&ctx.planMode&&!['list','read'].includes(method))throw new Error('计划模式只允许读取已有服务终端');
    if(method==='list')return {terminals:[...this.records.values()].filter(r=>r.sessionId===ctx.sessionId&&r.workspaceId===ctx.workspaceId&&(ctx.actor==='user'||r.service&&r.owner==='agent')).map(r=>this.public(r,ctx.actor))};
    if(method==='create') {
      if(this.live.size>=24)throw new Error('运行中的终端已达上限，请先关闭不用的终端');
      if(ctx.actor==='agent'&&typeof input.command==='string'&&input.command.length>16384)throw new Error('服务命令过长');
      const cwd=realpathSync(ctx.cwd),shell=process.env.SHELL||'/bin/zsh';
      const cols=this.dimension(input.cols,100,20,400),rows=this.dimension(input.rows,24,5,200);
      const name=typeof input.name==='string'?text(input.name,'终端名称',100):ctx.actor==='agent'?'Agent 服务':'终端';
      processSnapshot(); // Fail before spawning when process inspection is unavailable.
      const pty=spawn(shell,['-l'],{name:'xterm-256color',cols,rows,cwd,env:{...process.env,TERM:'xterm-256color'} as Record<string,string>});
      const record:TerminalRecord={id:randomUUID(),sessionId:ctx.sessionId,workspaceId:ctx.workspaceId,cwd,name,service:ctx.actor==='agent',owner:ctx.actor,authorityEpoch:1,state:'running',output:'',seq:0,cols,rows,pid:pty.pid,runId:ctx.runId};
      let identity:ProcessIdentity|undefined;
      try {identity=processSnapshot().get(pty.pid);} catch(error){try{pty.kill('SIGKILL');}catch{}throw error;}
      if(!identity){try{pty.kill('SIGKILL');}catch{}throw new Error('无法核实终端进程身份，创建已停止');}
      const live:LiveTerminal={pty,identity:identity,owned:new Map()};
      if(identity)live.owned.set(identity.pid,identity);
      this.records.set(record.id,record);this.live.set(record.id,live);this.save(record);this.capture(record.id,live);
      pty.onData(data=>{if(this.closed)return;if(Date.now()-(this.captures.get(record.id)||0)>100){this.captures.set(record.id,Date.now());try{this.capture(record.id,live);}catch{}}record.output=(record.output+data).slice(-128*1024);record.seq++;this.event(record,'output',{data});});
      pty.onExit(event=>{if(this.closed)return;record.exitCode=event.exitCode;if(record.state==='running')void this.stop(record);this.event(record,'state');});
      if(ctx.actor==='agent'&&typeof input.command==='string'&&input.command.trim()) {
        if(input.command.length>16384)throw new Error('服务命令过长');
        pty.write(input.command+'\r');
      }
      this.event(record,'state');return this.public(record,ctx.actor,true);
    }
    const record=this.target(ctx,input);
    if(method==='read'){this.agentAuthority(ctx,record,input);return this.public(record,ctx.actor,true);}
    if(method==='resize'){if(ctx.actor==='agent')throw new Error('终端尺寸由客户端管理');const live=this.live.get(record.id);if(live&&record.state==='running'){record.cols=this.dimension(input.cols,record.cols,20,400);record.rows=this.dimension(input.rows,record.rows,5,200);live.pty.resize(record.cols,record.rows);this.save(record);}return this.public(record,ctx.actor);}
    if(method==='takeover'){if(ctx.actor!=='user')throw new Error('只有用户能接管');if(record.owner!=='user'){record.owner='user';record.authorityEpoch++;this.save(record);this.event(record,'ownership');}return this.public(record,ctx.actor);}
    if(method==='release'){if(ctx.actor!=='user'||!record.service)throw new Error('仅用户可交还 Agent 服务终端');if(record.state!=='running')throw new Error('终端已经结束');record.owner='agent';record.authorityEpoch++;this.save(record);this.event(record,'ownership');return this.public(record,ctx.actor);}
    if(method==='input') {
      const data=input.data,live=this.live.get(record.id);if(typeof data!=='string'||!data.length||data.length>16384)throw new Error('终端输入无效');
      if(!live||record.state!=='running')throw new Error('终端已结束');
      if(ctx.actor==='user'&&record.owner!=='user'){record.owner='user';record.authorityEpoch++;this.save(record);this.event(record,'ownership');}
      this.agentAuthority(ctx,record,input);live.pty.write(data);return {written:true,authorityEpoch:record.authorityEpoch};
    }
    if(method==='response'){if(ctx.actor!=='user')throw new Error('协议响应仅由客户端处理');const live=this.live.get(record.id);if(live&&record.state==='running'&&typeof input.data==='string'&&/^\x1b\[[0-9;]*[RnIOc]$/.test(input.data))live.pty.write(input.data);return {responded:true};}
    if(method==='stop'){this.agentAuthority(ctx,record,input);await this.stop(record);return this.public(record,ctx.actor,true);}
    throw new Error('未知终端操作');
  }
  private dimension(value:unknown,fallback:number,min:number,max:number){return typeof value==='number'&&Number.isInteger(value)?Math.max(min,Math.min(max,value)):fallback;}
  private async stop(record:TerminalRecord):Promise<boolean> {
    const live=this.live.get(record.id);
    if(!live)return record.state==='exited'||record.state==='interrupted';
    if(live.stopping)return live.stopping;
    record.state='stopping';this.save(record);this.event(record,'state');
    live.stopping=(async()=>{let stopped=false;try{this.capture(record.id,live);stopped=!!live.identity&&await terminateOwned(live.owned.values());}catch{}record.state=stopped?'exited':'cleanup_failed';this.save(record);this.event(record,'state');if(stopped)this.live.delete(record.id);return stopped;})();
    const stopped=await live.stopping;if(!stopped)live.stopping=undefined;return stopped;
  }
  async stopAgentServices(sessionId:string,runId?:string) {
    const results=await Promise.all([...this.records.values()].filter(r=>r.sessionId===sessionId&&r.service&&r.owner==='agent'&&(!runId||r.runId===runId)).map(r=>this.stop(r)));if(!results.every(Boolean))throw new Error('服务终端清理未能核实，请检查保留记录');
  }
  async shutdown() { clearInterval(this.timer);const results=await Promise.all([...this.records.values()].filter(r=>this.live.has(r.id)).map(r=>this.stop(r)));for(const record of this.records.values())this.save(record);this.closed=true;this.store.close();return results.every(Boolean); }
}
