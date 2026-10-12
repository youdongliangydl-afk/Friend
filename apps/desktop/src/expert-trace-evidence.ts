import {digest,isDerivedCapabilityInput,type HistoryItem,type SourceRef} from '@friend-pi/core';

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
