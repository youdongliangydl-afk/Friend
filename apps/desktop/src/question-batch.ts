export interface QuestionOption {id:string;label:string}
export interface BatchQuestion {id:string;type:'single'|'multiple'|'text';title:string;description?:string;required:boolean;options?:QuestionOption[];allowOther?:boolean}
export interface QuestionBatch {v:1;title:string;questions:BatchQuestion[]}
export interface QuestionAnswer {questionId:string;optionIds?:string[];text?:string;other?:string;skipped?:true}
export interface QuestionBatchDialog extends QuestionBatch {id:string;kind:'questionBatch';generation:string;runId?:string;toolCallId:string;createdAt:number;sequence:number}
export interface QuestionBatchResult extends QuestionBatch {status:'answered'|'cancelled'|'interrupted';answers?:QuestionAnswer[]}
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
function string(value:unknown,name:string,max=800){if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`${name}无效`);return value.trim();}
export function questionBatch(value:unknown):QuestionBatch {
 const raw=object(value);if(raw.v!==1||!Array.isArray(raw.questions)||!raw.questions.length||raw.questions.length>12)throw new Error('问题组版本或数量无效（每组1至12题）');
 const ids=new Set<string>();const questions=raw.questions.map(value=>{const q=object(value),id=string(q.id,'题目ID',100);if(['__proto__','constructor','prototype'].includes(id))throw new Error('题目ID无效');if(ids.has(id))throw new Error('题目ID重复');ids.add(id);
  if(!['single','multiple','text'].includes(String(q.type))||typeof q.required!=='boolean')throw new Error('题型或必答标记无效');
  const result:BatchQuestion={id,type:q.type as BatchQuestion['type'],title:string(q.title,'题面'),required:q.required};
  if(q.description!==undefined)result.description=string(q.description,'题目说明',4000);
  if(q.type!=='text'){if(!Array.isArray(q.options)||q.options.length<1||q.options.length>20)throw new Error('选项数量无效');const optionIds=new Set<string>();result.options=q.options.map(value=>{const option=object(value),id=string(option.id,'选项ID',100);if(optionIds.has(id))throw new Error('选项ID重复');optionIds.add(id);return {id,label:string(option.label,'选项')};});result.allowOther=q.allowOther===true;}
  return result;
 });return {v:1,title:string(raw.title,'问题组标题',200),questions};
}
export function questionAnswerError(q:BatchQuestion,answer?:QuestionAnswer):string|undefined {
 const selected=answer?.optionIds||[],text=answer?.text?.trim(),other=answer?.other?.trim();
 if(answer?.skipped){if(q.required)return '此题必答';if(selected.length||text||other)return '跳过的题目不能同时包含答案';return;}
 if(q.type==='text'){if(selected.length||other)return '文本题答案无效';if(q.required&&!text)return '请填写此题';}
 else {if(text||new Set(selected).size!==selected.length||selected.some(id=>!q.options?.some(option=>option.id===id)))return '请选择有效选项';if(other&&!q.allowOther)return '此题不支持其他答案';if(q.type==='single'&&selected.length+(other?1:0)>1)return '此题只能选择一项';if(q.required&&!selected.length&&!other)return '请选择一项或填写其他答案';}
 if((text?.length||0)>16000||(other?.length||0)>16000)return '答案过长';
}
export function questionAnswers(batch:QuestionBatch,value:unknown):QuestionAnswer[]{
 if(!Array.isArray(value))throw new Error('答案格式无效');const answers=new Map<string,QuestionAnswer>();
 for(const valueItem of value){const item=object(valueItem);if(typeof item.questionId!=='string'||answers.has(item.questionId)||!batch.questions.some(q=>q.id===item.questionId))throw new Error('答案题目ID无效或重复');
  if(item.optionIds!==undefined&&(!Array.isArray(item.optionIds)||!item.optionIds.every(id=>typeof id==='string'))||item.text!==undefined&&typeof item.text!=='string'||item.other!==undefined&&typeof item.other!=='string'||item.skipped!==undefined&&item.skipped!==true)throw new Error('答案字段无效');
  answers.set(item.questionId,{questionId:item.questionId,...(item.optionIds?{optionIds:[...item.optionIds as string[]]}:{}),...(typeof item.text==='string'?{text:item.text.trim()}:{}),...(typeof item.other==='string'?{other:item.other.trim()}:{}),...(item.skipped?{skipped:true as const}:{})});
 }
 return batch.questions.map(q=>{const answer=answers.get(q.id);const error=questionAnswerError(q,answer);if(error)throw new Error(`${q.title}：${error}`);return answer&&((answer.optionIds?.length||0)>0||answer.text||answer.other)?answer:{questionId:q.id,skipped:true};});
}
export function questionAnswerText(q:BatchQuestion,answer?:QuestionAnswer):string {if(!answer||answer.skipped)return '已跳过';return [ ...(answer.optionIds||[]).map(id=>q.options?.find(option=>option.id===id)?.label||id),answer.text,answer.other?'其他：'+answer.other:undefined].filter(Boolean).join('；')||'已跳过';}

export const questionOrder=(a:Pick<QuestionBatchDialog,'sequence'>,b:Pick<QuestionBatchDialog,'sequence'>)=>a.sequence-b.sequence;
