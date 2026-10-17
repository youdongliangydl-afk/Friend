import {useRef,useState} from 'react';
import type {QuestionBatchDialog} from '../question-batch.js';
import {BatchQuestionCard,type QuestionDraft} from './BatchQuestionCard.js';
import {Modal} from './ui.js';

export function QuestionDialog({dialog,drafts,respond,defer}:{dialog:QuestionBatchDialog;drafts:Map<string,QuestionDraft>;respond(value:Record<string,unknown>):Promise<unknown>;defer():void}){
 const [busy,setBusy]=useState(false),lock=useRef(false);
 const pending=(value:boolean)=>{lock.current=value;setBusy(value);};
 const deferWhenIdle=()=>{if(!lock.current)defer();};
 return <Modal title="需要你确认" className="question-dialog" wide closeDisabled={busy} onClose={deferWhenIdle}>
  <BatchQuestionCard dialog={dialog} drafts={drafts} respond={respond} onDefer={deferWhenIdle} onBusy={pending}/>
 </Modal>;
}
