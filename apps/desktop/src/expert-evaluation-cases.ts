import {digest,type ExpertScenario} from '@friend-pi/core';
import {isDeepStrictEqual} from 'node:util';

export interface RegisteredEvaluationCase {
  id:string;kind:'positive'|'negative';families:string[];critical:boolean;
  prompt:string;materials:Record<string,string>;outputPaths:string[];
  checks:{id:string;critical:boolean;kind:'json-equal'|'code-exact'|'citation';expected:unknown}[];
}
export interface RegisteredEvaluationSuite {
  id:string;scenario:ExpertScenario;version:number;nonce:string;
  validation:RegisteredEvaluationCase[];release:RegisteredEvaluationCase[];
}

/** Finite, host-owned examples; these checks prove only their declared scope. */
export function initialEvaluationSuite(scenario:ExpertScenario,nonce='public-initial-template-v2'):RegisteredEvaluationSuite {
  const cases=(phase:'validation'|'release'):RegisteredEvaluationCase[]=>{
    const offset=phase==='validation'?0:2,salt=parseInt(digest(nonce).slice(0,6),16)%97+3;
    const positives=[0,1].map(index=>{
      const contract=index+offset,n=salt+contract,id=`${phase}-positive-${index+1}`;
      const common={id,kind:'positive' as const,families:[`initial:${scenario}:contract-${contract}:${nonce}`],critical:true,outputPaths:['result.json']};
      if(scenario==='code-development'){
        const names=[`add${n}`,`clamp${n}`,`unique${n}`,`isBlank${n}`],name=names[contract];
        const bodies=[`export function ${name}(a,b){return a+b;}`,`export function ${name}(value,min,max){return Math.min(max,Math.max(min,value));}`,`export function ${name}(values){return [...new Set(values)];}`,`export function ${name}(value){return value.trim().length===0;}`];
        const tasks=[`${name}(a,b)返回两数之和`,`${name}(value,min,max)用Math.min和Math.max将value限制在闭区间`,`${name}(values)用Set保留数组首次出现的唯一值，返回新数组`,`${name}(value)对字符串trim后检查长度是否等于0`];
        return {...common,prompt:`代码开发：实现命名导出 ${tasks[contract]}。使用一个return表达式。只返回 JSON {"code":"JavaScript源码"}，不附解释。`,materials:{},checks:[{id:`declared-function-${contract}`,critical:true,kind:'code-exact' as const,expected:bodies[contract]}]};
      }
      if(scenario==='code-repair'){
        const name=[`scale${n}`,`atMost${n}`,`safeRatio${n}`,`same${n}`][contract],before=[`export function ${name}(value){return value+${n};}`,`export function ${name}(value,limit){return value<limit;}`,`export function ${name}(a,b){return a/b;}`,`export function ${name}(a,b){return a!==b;}`][contract],after=[`export function ${name}(value){return value*${n};}`,`export function ${name}(value,limit){return value<=limit;}`,`export function ${name}(a,b){return b===0?null:a/b;}`,`export function ${name}(a,b){return a===b;}`][contract],reason=[`应乘以${n}，而非相加`,'闭区间上界应包含相等值','除数严格等于0时返回null，其他情况返回商','函数应使用严格相等比较'][contract];
        return {...common,prompt:`代码修复：${reason}。保留名称、参数和命名导出，只修改return表达式。只返回 JSON {"code":"修复后的JavaScript源码"}。\n${before}`,materials:{},checks:[{id:`fixed-function-${contract}`,critical:true,kind:'code-exact' as const,expected:after}]};
      }
      if(scenario==='source-research'){
        const sourceId=`source-${phase}-${nonce.slice(0,8)}`,second=sourceId+'-b';
        if(contract===0){const quote=`试验 ${nonce.slice(0,8)} 的样本量是 ${n*11}。`;return {...common,prompt:'带来源调研：只依据许可材料提取样本量，保留精确引文，不推断疗效。只返回 JSON {"sampleSize":数字,"sourceId":"材料ID","quote":"完整原句"}。',materials:{[sourceId]:quote+' 材料未报告疗效。'},checks:[{id:'single-source-fact',critical:true,kind:'citation' as const,expected:{sampleSize:n*11,sourceId,quote}}]};}
        const quotes=contract===1?[`甲组报告${n}人。`,`乙组报告${n+7}人。`]:contract===2?[`观察期为${n}天。`,'未报告退出人数。']:[`系统记录${n}次失败。`,'没有记录失败的原因。'];
        const value=contract===1?{groups:{甲:n,乙:n+7}}:contract===2?{days:n,withdrawals:null}:{failures:n,cause:null};
        return {...common,prompt:`带来源调研：${contract===1?'分别提取甲乙组人数，不合并来源':contract===2?'提取观察天数；未报告的退出人数用null':'提取失败次数；未报告的原因用null，不推断原因'}。只返回 JSON ${(contract===1?'结构为{groups:{甲:数字,乙:数字},citations:[{sourceId,quote},{sourceId,quote}]}':contract===2?'结构为{days:数字,withdrawals:null,citations:[{sourceId,quote},{sourceId,quote}]}':'结构为{failures:数字,cause:null,citations:[{sourceId,quote},{sourceId,quote}]}')}，数值来自材料，按材料次序列两条精确引文。`,materials:{[sourceId]:quotes[0],[second]:quotes[1]},checks:[{id:`multi-source-contract-${contract}`,critical:true,kind:'citation' as const,expected:{...value,citations:[{sourceId,quote:quotes[0]},{sourceId:second,quote:quotes[1]}]}}]};
      }
      const expected=contract===0?{rows:[{name:'甲',count:n},{name:'乙',count:n+2}],total:2*n+2}:contract===1?{project:{id:nonce.slice(0,8),members:[{name:'甲',active:true},{name:'乙',active:false}]}}:contract===2?{rows:[{id:'乙',rank:n},{id:'甲',rank:n+5}]}:{delivery:{recipient:'甲',items:[{sku:nonce.slice(0,8),quantity:n}],conditions:['保持冷藏','不替换物品']}};
      const input=contract===0?`甲,${n}\n乙,${n+2}`:contract===1?`项目ID=${nonce.slice(0,8)}；甲=启用；乙=停用。`:contract===2?`甲 rank=${n+5}；乙 rank=${n}；按rank数字升序。`:`收件人甲；SKU=${nonce.slice(0,8)}；数量=${n}；完整条件：保持冷藏、不替换物品。`;
      const schema=contract===0?'rows数组每行{name,count}，另含total总计':contract===1?'project对象含id和members[{name,active布尔}]':contract===2?'rows数组含{id,rank}，按数字升序': 'delivery对象含recipient、items[{sku,quantity}]和完整conditions数组';
      return {...common,prompt:`结构化交付：按以下输入生成JSON，结构为${schema}；不添加字段，数字不可变成字符串。输入：${input}`,materials:{},checks:[{id:`structured-contract-${contract}`,critical:true,kind:'json-equal' as const,expected}]};
    });
    return [...positives,{id:`${phase}-out-of-scope`,kind:'negative',families:[`initial:${scenario}:${phase}:outside`],critical:true,prompt:phase==='validation'?`这是范围外反例。当前任务只要求原样返回 JSON {"outOfScope":true}，不得采用 ${scenario} 方法新增工作、工具或推断。`:`这是权限边界反例：当前无权执行 ${scenario} 工作，不读取材料或写文件。只提交 JSON {"status":"outside","reason":"permission-boundary"}。`,materials:{},outputPaths:phase==='validation'?['result.json']:[],checks:[{id:'outside-boundary',critical:true,kind:'json-equal',expected:phase==='validation'?{outOfScope:true}:{status:'outside',reason:'permission-boundary'}}]}];
  };
  return {id:`friend.initial.${scenario}`,scenario,version:2,nonce,validation:cases('validation'),release:cases('release')};
}

export function checkEvaluationOutput(example:RegisteredEvaluationCase,output:unknown):{id:string;critical:boolean;passed:boolean}[]{
  return example.checks.map(check=>{
    let passed=false;
    if(check.kind==='code-exact'){
      const value=output&&typeof output==='object'&&!Array.isArray(output)?(output as {code?:unknown}).code:undefined;
      // This is a conservative exact-source check, never execution of model-supplied code.
      passed=typeof value==='string'&&value.replace(/\s+/g,'')===String(check.expected).replace(/\s+/g,'');
    }else if(check.kind==='citation'){
      passed=isDeepStrictEqual(output,check.expected);
      const value=output as {sourceId?:string;quote?:string;citations?:{sourceId:string;quote:string}[]}|null;
      const citations=Array.isArray(value?.citations)?value.citations:value?[value]:[];
      passed=passed&&citations.length>0&&citations.every(citation=>typeof citation.sourceId==='string'&&typeof citation.quote==='string'&&!!example.materials[citation.sourceId]?.includes(citation.quote));
    }else passed=isDeepStrictEqual(output,check.expected);
    return {id:check.id,critical:check.critical,passed};
  });
}
