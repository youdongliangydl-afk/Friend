type NoticeLevel='info'|'warning'|'error';
const states:Record<string,[string,NoticeLevel]>={
  created:['已创建，尚未启动','info'],running:['正在执行','info'],stopping:['正在停止','warning'],
  paused:['已暂停','warning'],completed:['执行已结束','info'],awaiting_review:['等待复核','info'],
  ready:['等待整合','info'],integrated:['成果已整合至工作区','info'],stopped:['已停止','warning'],
  failed:['执行失败','error'],blocked:['执行受阻','warning'],rejected:['请求被拒绝','warning'],
  unknown:['执行结果待确认，尚未确认完成','warning'],operation_unknown:['执行结果待确认，尚未确认完成','warning'],
  cancelled:['操作已取消','warning'],waiting_configuration:['等待配置，尚未执行','warning'],
};
const publicText=(value:string)=>value.replace(/sk-[A-Za-z0-9_-]{8,}/g,'[密钥已隐藏]');

/** Human command feedback only; controller results and model tool details stay intact. */
export function commandNotice(name:string,action:string,result:unknown):{message:string;level:NoticeLevel}{
  const collaboration=['swarm','team','workflow'].includes(name);
  const label:Record<string,string>={swarm:'Swarm 任务',team:'Team 任务',workflow:'工作流',memory:'记忆',expert:'专业方法'};
  const title=label[name]||'操作';
  const hint=collaboration?'可在队友会话或执行轨迹中查看详情。':'可在执行轨迹中查看详情。';
  if(typeof result==='string')return {message:publicText(result),level:'info'};
  const value=result&&typeof result==='object'&&!Array.isArray(result)?result as Record<string,unknown>:{};
  const rawError=value.error;
  const error=typeof rawError==='string'?rawError:rawError&&typeof rawError==='object'&&'message' in rawError&&typeof rawError.message==='string'?rawError.message:'';
  const status=String(value.status||value.state||(value.code==='OPERATION_UNKNOWN'?'unknown':value.code==='PERMISSION_DENIED'?'blocked':''));
  const state=states[status];
  if(rawError||value.ok===false||value.success===false||result===false){
    const failed=state&&state[1]!=='info'?state:['请求未完成','error'] as const;
    return {message:`${title}${failed[0]}。${error?publicText(error)+'。':''}${hint}`,level:failed[1]};
  }
  if(value.approved===false||value.blocked===true||value.cancelled===true){
    return {message:`${title}${value.cancelled?'操作已取消':value.blocked?'执行受阻':'请求被拒绝'}。${hint}`,level:'warning'};
  }
  if(state){const feedback=status==='running'&&['start','resume'].includes(action)?'已启动':state[0];return {message:`${title}${feedback}。${hint}`,level:state[1]};}
  if(Array.isArray(result))return {message:`已读取 ${result.length} 项结果。${hint}`,level:'info'};
  const reading=['snapshot','list','read','search','get','status','result','logs','versions','member.list','member.history'].includes(action);
  return {message:`${title}${reading?'已读取当前结果':action==='start'||action==='resume'?'启动请求已处理，执行状态尚未确认':'请求已处理'}。${hint}`,level:'info'};
}
