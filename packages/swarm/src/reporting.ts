import {CapabilityError,digest,object,text,readSourceSpan,type PluginContext,type SourceRef} from '@friend-pi/core';
import {sourceRefs} from './contracts.js';
import type {Graph} from './types.js';

export interface ClaimCitation {id:string;claim:string;sources:SourceRef[];sourceDigests:string[];status:'source_bound'}
/** Source binding proves traceability, never that a cited source entails the claim. */
export function claimCitations(raw:unknown,ctx:PluginContext):ClaimCitation[] {
  if(raw===undefined)return [];
  if(!Array.isArray(raw)||raw.length>256)throw new CapabilityError('VALIDATION_ERROR','claims需要最多256条声明');
  const claims=raw.map(value=>{const item=object(value),sources=sourceRefs(item.sources);if(!sources.length)throw new CapabilityError('SOURCE_UNAVAILABLE','每条声明需要已注册来源');const sourceDigests=sources.map(ref=>{const source=ctx.readSource(ref);const hash=digest(readSourceSpan(source,ref));ref.hash=hash;return hash;});return {id:text(item.id,'claim.id',100),claim:text(item.claim,'claim',20000),sources,sourceDigests,status:'source_bound' as const};});
  if(new Set(claims.map(c=>c.id)).size!==claims.length)throw new CapabilityError('VALIDATION_ERROR','claim.id重复');return claims;
}
export function observedSummary(graph:Graph,at=Date.now()) {
  const executions=[...graph.attempts,...(graph.reviewAttempts||[])];
  const starts=executions.map(a=>Date.parse(a.startedAt)).filter(Number.isFinite),active=executions.some(a=>a.status==='running');
  const finishes=executions.map(a=>a.finishedAt?Date.parse(a.finishedAt):NaN).filter(Number.isFinite);
  const complete=executions.length>0&&executions.every(a=>!!a.finishedAt);
  return {v:1,kind:'observed' as const,attempts:graph.attempts.length,elapsedMs:starts.length?Math.max(0,(active?at:finishes.length?Math.max(...finishes):Math.max(...starts))-Math.min(...starts)):null,
    memberElapsedMs:graph.attempts.reduce((sum,a)=>sum+(a.finishedAt?Math.max(0,Date.parse(a.finishedAt)-Date.parse(a.startedAt)):0),0),timeComplete:complete,
    tokens:graph.budget?.tokenUsed??null,tokenUnknown:!graph.budget||graph.budget.tokenUnknown||graph.attempts.some(a=>!a.usageObserved),estimatedSavings:null};
}
