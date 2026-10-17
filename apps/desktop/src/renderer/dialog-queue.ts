import {questionOrder} from '../question-batch.js';
import type {DialogRequest} from './types.js';

/** One foreground request at a time; an open management form keeps its draft. */
export function nextDialog(dialogs:DialogRequest[],managementOpen=false):DialogRequest|undefined {
 if(managementOpen)return;
 const confirmation=dialogs.find(dialog=>dialog.kind==='confirm');if(confirmation)return confirmation;
 const legacy=dialogs.find(dialog=>dialog.kind!=='questionBatch');if(legacy)return legacy;
 return dialogs.filter(dialog=>dialog.kind==='questionBatch').sort(questionOrder)[0];
}
