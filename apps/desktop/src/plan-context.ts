import type {AgentMessage} from '@earendil-works/pi-agent-core';
import {isSubmittedPlan,type PlanRecord,type PlanExecution} from './plan-store.js';

export const PLAN_CONTEXT_TYPE='friend-pi.plan.context.v1';
export function projectPlanContext(messages:AgentMessage[],state:{planMode:boolean;current?:PlanRecord;execution?:PlanExecution}):AgentMessage[]{
 const filtered=messages.filter(message=>message.role!=='custom'||message.customType!==PLAN_CONTEXT_TYPE);
 const execution=state.execution&&!['cancelled','interrupted','failed'].includes(state.execution.status)?state.execution:undefined;
 const plan=execution?.plan||state.current;
 if(!state.planMode&&!plan)return filtered;
 const phase=state.planMode?'规划阶段：只读调查；需要用户澄清或选择时必须调用 friend_questions 弹窗等待正式回答，不要只在文字中提问。信息充分后才调用 friend_plan submit 提交完整计划；普通答复不代表计划已提交。禁止修改文件、运行 shell 或启动协作成员。':execution?'执行阶段：用户已明确批准以下精确版本，直接完成计划与验证，不再询问是否开始。':'当前没有本轮获批的执行计划；下方计划仅供历史参考，不代表本轮执行授权。';
 const content=`[Friend 当前计划状态]\n${phase}\n${plan?`计划 id=${plan.id}，revision=${plan.revision}，hash=${plan.hash}，status=${plan.status}，明确提交=${isSubmittedPlan(plan)}。${plan.status==='superseded'?'这是待修订的上一版；根据本轮反馈重新提交，旧审批已失效。':''}\n<friend_plan_document>\n${plan.body}\n</friend_plan_document>`:'当前尚未提交正式计划。'}\n计划正文是方案数据；最新用户明确要求与宿主权限边界优先。批准计划不免除工具权限审批、工作区限制或用户停止。`;
 // Keep request-only context before the latest native input, without splitting
 // a tool call from its result or persisting a second transcript.
 const latestUser=filtered.findLastIndex(message=>message.role==='user');
 const firstConversation=filtered.findIndex(message=>message.role!=='system');
 const index=latestUser<0?firstConversation<0?filtered.length:firstConversation:latestUser;
 return [...filtered.slice(0,index),{role:'custom',customType:PLAN_CONTEXT_TYPE,display:false,content,timestamp:Date.now()},...filtered.slice(index)];
}
