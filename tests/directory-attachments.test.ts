import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {directoryAttachment,inspectAttachment,captureDocumentInput,validateCapturedInput} from '../apps/desktop/src/attachment-input.js';

test('folder attachments carry a frozen directory index without reading child contents or following symlinks',async()=>{
 const root=mkdtempSync(join(tmpdir(),'friend-folder-input-'));try{const folder=join(root,'材料');mkdirSync(folder);mkdirSync(join(folder,'子目录'));writeFileSync(join(folder,'说明.txt'),'PRIVATE_CHILD_BODY_MUST_NOT_BE_INLINE');writeFileSync(join(root,'outside.txt'),'EXTERNAL_BODY_MUST_NOT_BE_READ');symlinkSync(join(root,'outside.txt'),join(folder,'链接'));
  const inspected=await inspectAttachment(folder);assert.equal(inspected.kind,'directory');assert.equal(inspected.status,'ready');assert.match(inspected.summary,/3 项/);
  const payload=await captureDocumentInput({text:'检查索引',attachments:[{path:folder,hash:inspected.hash}]});assert.equal(payload.attachments[0].hash,inspected.hash);assert.match(payload.attachments[0].text!,/说明.txt/);assert.match(payload.attachments[0].text!,/符号链接（未跟随）/);assert.doesNotMatch(payload.attachments[0].text!,/PRIVATE_CHILD_BODY|EXTERNAL_BODY/);
  rmSync(folder,{recursive:true});assert.doesNotThrow(()=>validateCapturedInput(payload),'queued input retains its original listing without rereading the source');assert.match(payload.attachments[0].text!,/子目录/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('changed folder indexes reject stale attachment hashes and empty folders are valid references',async()=>{
 const root=mkdtempSync(join(tmpdir(),'friend-folder-change-'));try{const before=await inspectAttachment(root);assert.match(before.summary,/0 项/);writeFileSync(join(root,'新增.txt'),'source');await assert.rejects(captureDocumentInput({text:'必须重新检查',attachments:[{path:root,hash:before.hash}]}),/索引已变化/);const updated=await captureDocumentInput({text:'',attachments:[{path:root}]});assert.match(updated.attachments[0].text!,/新增.txt/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('large directories stop at the bound and explicitly report a partial index',()=>{
 const root=mkdtempSync(join(tmpdir(),'friend-folder-bounded-'));try{for(let i=0;i<220;i++)writeFileSync(join(root,'item-'+i+'.txt'),'body');const result=directoryAttachment(root);assert.equal(result.coverage.status,'partial');assert.equal(result.coverage.readUnits,200);assert.ok(result.sourceBytes<=64*1024);assert.match(result.text,/仅包含部分条目/);assert.ok(result.warnings.some(value=>value.includes('未列出全部')));
 }finally{rmSync(root,{recursive:true,force:true});}
});
