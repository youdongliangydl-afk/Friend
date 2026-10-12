import {CapabilityError,digest,type HostEvalResult,type HostEvalRequest,type HostCase} from '@friend-pi/core';

export interface EvaluationObservation {
 passed:boolean;outputHash:string;checks:HostEvalResult['checks'];
 usage:HostEvalResult['usage'];timing:HostEvalResult['timing'];nativeEvidence:HostEvalResult['nativeEvidence'];
 operationId:string;requestHash:string;
}
export interface EvaluationPair {
 phase:'validation'|'release';caseKey:string;caseId:string;repetition:number;
 critical:boolean;kind:'positive'|'negative';baseline?:EvaluationObservation;candidate?:EvaluationObservation;
}

export function validateHostCases(cases:HostCase[],phase:string):void {
 if(!Array.isArray(cases)||cases.length>64||cases.filter(c=>c.kind==='positive').length<2||cases.filter(c=>c.kind==='negative').length<1)throw new CapabilityError('VALIDATION_ERROR',`${phase} 至少需要两个独立正例和一个范围外反例`);
 const ids=new Set<string>(),families=new Set<string>();
 for(const c of cases){if(!c.id||ids.has(c.id)||!c.taskRef||!/^[a-f0-9]{64}$/.test(c.inputHash)||!Array.isArray(c.families)||!c.families.length||typeof c.critical!=='boolean'||!['positive','negative'].includes(c.kind))throw new CapabilityError('VALIDATION_ERROR','宿主用例身份或来源族无效');ids.add(c.id);for(const family of c.families){if(families.has(family))throw new CapabilityError('VALIDATION_ERROR','重复运行不能冒充独立任务族');families.add(family);}}
}

export function hostObservation(result:HostEvalResult,request:HostEvalRequest):EvaluationObservation {
 if(result.v!==1||result.operationId!==request.operationId||result.requestHash!==digest(request)||result.suiteHash!==request.suiteHash)throw new CapabilityError('VERSION_CONFLICT','宿主评测结果与冻结请求不一致');
 if(result.status!=='completed')throw new CapabilityError(result.status==='unknown'?'OPERATION_UNKNOWN':'CAPABILITY_UNAVAILABLE',result.reason||'宿主评测尚未完成');
 if(!Array.isArray(result.checks)||!result.checks.length||new Set(result.checks.map(c=>c.id)).size!==result.checks.length||result.checks.some(c=>!c.id||typeof c.passed!=='boolean'||typeof c.critical!=='boolean'))throw new CapabilityError('VALIDATION_ERROR','宿主客观检查不完整');
 if(!result.usage||!Number.isSafeInteger(result.usage.providerRequests)||result.usage.providerRequests<1||typeof result.usage.unknown!=='boolean'||result.usage.totalTokens!==null&&(!Number.isSafeInteger(result.usage.totalTokens)||result.usage.totalTokens<0))throw new CapabilityError('VALIDATION_ERROR','实际 provider 请求与 totalTokens 无效');
 const timing=result.timing;if(!timing||!Number.isFinite(Date.parse(timing.admittedAt))||!Number.isFinite(Date.parse(timing.checkedAt))||Date.parse(timing.checkedAt)<Date.parse(timing.admittedAt)||!Number.isFinite(timing.elapsedMs)||timing.elapsedMs<0||!Number.isFinite(timing.queueWaitMs)||timing.queueWaitMs<0)throw new CapabilityError('VALIDATION_ERROR','端到端耗时未知或无效');
 if(!Array.isArray(result.nativeEvidence)||!result.nativeEvidence.length||result.nativeEvidence.some(ref=>!ref.sessionId||!ref.entryId)||!result.outputHash)throw new CapabilityError('SOURCE_UNAVAILABLE','缺少原生 Pi 执行证据');
 return {passed:result.checks.every(check=>check.passed),outputHash:result.outputHash,checks:result.checks,usage:result.usage,timing,nativeEvidence:result.nativeEvidence,operationId:result.operationId,requestHash:result.requestHash};
}

export function judgePhase(pairs:EvaluationPair[],caseCount:number,metric:'paired-pass'|'paired-efficiency') {
 const complete=pairs.length===caseCount*3&&pairs.every(pair=>pair.baseline&&pair.candidate),known=complete&&pairs.every(pair=>!pair.baseline!.usage.unknown&&!pair.candidate!.usage.unknown&&pair.baseline!.usage.totalTokens!==null&&pair.candidate!.usage.totalTokens!==null);
 const baselinePassed=pairs.filter(pair=>pair.baseline?.passed).length,candidatePassed=pairs.filter(pair=>pair.candidate?.passed).length;
 const nonRegression=complete&&pairs.every(pair=>{const candidate=new Map(pair.candidate!.checks.map(check=>[check.id,check]));return pair.baseline!.checks.every(check=>!check.passed||candidate.get(check.id)?.passed===true);});
 const criticalPassed=complete&&pairs.every(pair=>(!pair.critical||pair.candidate!.passed)&&pair.candidate!.checks.every(check=>!check.critical||check.passed));
 const negativePassed=complete&&pairs.filter(pair=>pair.kind==='negative').every(pair=>pair.candidate!.passed);
 const sum=(side:'baseline'|'candidate',field:'tokens'|'elapsed'|'queue')=>pairs.reduce((total,pair)=>total+(field==='tokens'?(pair[side]?.usage.totalTokens??0):field==='elapsed'?(pair[side]?.timing.elapsedMs??0):(pair[side]?.timing.queueWaitMs??0)),0);
 const baselineTokens=sum('baseline','tokens'),candidateTokens=sum('candidate','tokens'),baselineElapsedMs=sum('baseline','elapsed'),candidateElapsedMs=sum('candidate','elapsed');
 const tokenGain=known&&candidateTokens<=baselineTokens*.85,timeNonRegression=known&&pairs.every(pair=>pair.candidate!.timing.elapsedMs<=pair.baseline!.timing.elapsedMs);
 const strictImprovement=known&&nonRegression&&criticalPassed&&negativePassed&&(metric==='paired-efficiency'?tokenGain&&timeNonRegression:candidatePassed>baselinePassed);
 return {complete,known,total:caseCount*3,observed:pairs.length,baselinePassed,candidatePassed,nonRegression,criticalPassed,negativePassed,baselineTokens,candidateTokens,baselineElapsedMs,candidateElapsedMs,baselineQueueWaitMs:sum('baseline','queue'),candidateQueueWaitMs:sum('candidate','queue'),tokenGain,timeNonRegression,strictImprovement,metric,evidenceScope:'frozen measured cases only; not a population non-inferiority claim'};
}
