import {asList,asObject,type JsonObject} from './types.js';
export function AttachmentDelivery({receipts}:{receipts:JsonObject[]}){
 const latest=new Map<string,JsonObject>();for(const receipt of receipts){if(receipt.customType!=='friend-pi.attachments.v1')continue;const data=asObject(receipt.data);if(data.stage!=='started'&&data.stage!=='unverified')continue;for(const attachment of asList<JsonObject>(data.attachments))latest.set(String(attachment.path),{...attachment,stage:data.stage});}
 if(!latest.size)return null;
 return <details className="attachment-delivery"><summary>附件输入范围 · {latest.size} 份</summary>{[...latest.values()].map(item=><p key={String(item.path)}><strong>{String(item.name)}</strong> · {item.stage==='unverified'?'输入经扩展转换，覆盖范围未核实':item.image?'图片原件已加入对话输入':item.delivery==='reference'?'已加入文件说明，正文需分段读取':item.delivery==='inline'?`${Number(item.modelCharacters||0).toLocaleString()} 字符已加入对话输入`:'文本附件快照已加入对话输入'}</p>)}<small>解析范围与输入范围分别记录；不推断模型是否理解。分段读取范围可查看对应工具记录。</small></details>;
}
