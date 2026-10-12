import {digest,isDerivedCapabilityInput,visibleText,type HistoryItem,type SourceRef,type RegisteredCheck} from '@friend-pi/core';

/** Retain each complete native input/result; sentence splitting inflates JSON snapshots. */
export function expertTraceSources(items:HistoryItem[],sessionId:string,unverifiedUserEntries:ReadonlySet<string>=new Set()):SourceRef[] {
  return items.flatMap(item=>{
    if(!['user','toolResult'].includes(item.role||'')||isDerivedCapabilityInput(item))return [];
    const body=item.role==='user'?item.userText:item.text;
    if(typeof body!=='string'||!item.text.startsWith(body)||item.role==='user'&&unverifiedUserEntries.has(item.id))throw new Error('本轮用户输入边界未核实，原史已保留，未自动学习');
    if(!body)return [];
    return [{sessionId,entryId:item.id,start:0,end:body.length,hash:digest(body)}];
  });
}

const record=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const nativeCheckType='friend-pi.expert.native-check.v1';

/** Only the native structured-result receipt can attest an exit code; stdout is not a check. */
export function expertTraceChecks(entries:readonly unknown[],scope:{sessionId:string;projectId:string;runId:string;sources:SourceRef[]}):{records:RegisteredCheck[];invalidChecks:boolean;failedChecks:boolean} {
  const raw=entries.map(record),records:RegisteredCheck[]=[],sources=scope.sources.filter(source=>source.sessionId===scope.sessionId);
  let invalidChecks=false,failedChecks=false;
  const marker=raw.findLastIndex(entry=>entry.type==='custom'&&entry.customType==='friend-pi.input.v1'&&record(entry.data).runId===scope.runId);
  const sourceUser=raw.findIndex(entry=>entry.type==='message'&&record(entry.message).role==='user'&&sources.some(source=>source.entryId===entry.id));
  const start=marker>=0?raw.findIndex(entry=>entry.id===record(raw[marker].data).entryId):sourceUser;
  const next=marker>=0?raw.findIndex((entry,index)=>index>marker&&entry.type==='custom'&&entry.customType==='friend-pi.input.v1'&&record(entry.data).runId!==scope.runId):-1;
  for(const [toolIndex,entry] of raw.entries()) {
    const message=record(entry.message);
    if(entry.type!=='message'||message.role!=='toolResult'||message.toolName!=='bash'||start>=0&&toolIndex<start||next>=0&&toolIndex>=next)continue;
    const receipts=raw.flatMap((row,index)=>row.type==='custom'&&row.customType===nativeCheckType&&record(row.data).runId===scope.runId&&record(row.data).toolCallId===message.toolCallId?[{index,data:record(row.data)}]:[]);
    const referenced=sources.filter(source=>source.entryId===entry.id),inWindow=start>=0&&toolIndex>=start;
    if(!referenced.length&&!receipts.length&&!inWindow)continue;
    if(message.isError===true)failedChecks=true;
    const body=visibleText(message.content),verified=referenced.filter(source=>source.start===0&&source.end===body.length&&source.hash===digest(body));
    if(!verified.length||verified.length!==referenced.length||receipts.length!==1||typeof entry.id!=='string'||typeof message.toolCallId!=='string'){invalidChecks=true;continue;}
    const receipt=receipts[0],observed=receipt.data,exitCode=observed.exitCode,attribution=record(observed.trialAttribution);
    const decisionIndex=raw.findIndex(row=>row.id===attribution.decisionEntryId),decision=raw[decisionIndex],assistant=record(decision?.message);
    const calls=Array.isArray(assistant.content)?assistant.content.map(record).filter(part=>part.type==='toolCall'&&part.id===message.toolCallId&&part.name==='bash'):[];
    const command=record(calls[0]?.arguments).command;
    if(observed.v!==1||observed.boundary!=='native-pi-tool-result-structured-exit-code'||observed.outputHash!==digest(body)||typeof exitCode!=='number'||!Number.isSafeInteger(exitCode)||Boolean(message.isError)!==(exitCode!==0)||attribution.v!==1||!Array.isArray(attribution.adoptions)||attribution.adoptions.some(value=>!value||typeof value!=='object'||Array.isArray(value))||decision?.type!=='message'||assistant.role!=='assistant'||decisionIndex<0||start>=0&&decisionIndex<start||decisionIndex>=receipt.index||receipt.index>=toolIndex||calls.length!==1||typeof command!=='string'||!command||digest(command)!==observed.commandHash){invalidChecks=true;continue;}
    // Public Pi currently journals structured exit via the extension receipt, not ToolResultMessage.
    if(message.structuredContent!==undefined&&record(message.structuredContent).exit_code!==exitCode){invalidChecks=true;continue;}
    const adoptions=attribution.adoptions.map(record),seen=new Set<string>();
    const valid=adoptions.every(adoption=>{
      if(typeof adoption.journalEntryId!=='string'||typeof adoption.operationId!=='string'||!adoption.operationId||typeof adoption.skillsHash!=='string'||seen.has(adoption.operationId))return false;
      seen.add(adoption.operationId);
      const index=raw.findIndex(row=>row.id===adoption.journalEntryId),canonical=raw[index],data=record(canonical?.data);
      return index>=0&&index<decisionIndex&&canonical.type==='custom'&&canonical.customType==='friend-pi.expert.adoption'&&data.runId===scope.runId&&data.memberId==='main'&&data.operationId===adoption.operationId&&Array.isArray(data.skills)&&data.skills.some(skill=>record(skill).statusAtFreeze==='trial')&&digest(data.skills)===adoption.skillsHash;
    });
    if(!valid){invalidChecks=true;continue;}
    if(exitCode!==0)failedChecks=true;
    records.push({ref:{checkId:`pi:${scope.sessionId}:${entry.id}`,version:1,hash:digest(message),taskId:scope.runId,producerRunId:scope.runId,artifacts:[]},projectId:scope.projectId,passed:exitCode===0,output:{text:body,exitCode,toolError:message.isError,trialAttribution:attribution,boundary:'native-pi-tool-result-structured-exit-code'},sources:verified});
  }
  return {records,invalidChecks,failedChecks};
}
