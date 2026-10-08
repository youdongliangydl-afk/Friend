import { TerminalController, type TerminalContext } from './terminal-controller.js';
import { object } from '@friend-pi/core';
const send=(message:unknown)=>{if(process.connected)process.send?.(message);};
const controller=new TerminalController(process.env.FRIEND_PI_DATA_DIR||'',event=>send({type:'event',event}));
let closing=false;
process.on('message',async raw=>{
  const message=object(raw);if(message.type!=='request')return;
  try {
    let result:unknown;
    if(message.method==='shutdown'){closing=true;result={stopped:await controller.shutdown()};}
    else if(closing)throw new Error('终端宿主正在退出');
    else if(message.method==='stopAgentServices'){const ctx=object(message.context);await controller.stopAgentServices(String(ctx.sessionId),typeof ctx.runId==='string'?ctx.runId:undefined);result={stopped:true};}
    else result=await controller.handle(String(message.method),object(message.input||{}),object(message.context) as unknown as TerminalContext);
    send({type:'response',id:message.id,result});
    if(message.method==='shutdown')setImmediate(()=>process.exit(0));
  }catch(error){send({type:'response',id:message.id,error:error instanceof Error?error.message:String(error)});}
});
process.on('disconnect',()=>{if(!closing){closing=true;void controller.shutdown().finally(()=>process.exit(0));}});
process.on('SIGTERM',()=>{if(!closing){closing=true;void controller.shutdown().finally(()=>process.exit(0));}});
send({type:'ready'});
