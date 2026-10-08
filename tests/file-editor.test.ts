import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,statSync,readdirSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {listDirectory,readEditorFile,writeEditorFile,contentHash} from '../apps/desktop/src/file-editor.js';
import {grantHtmlPreview,revokeHtmlPreview,htmlPreviewResponse} from '../apps/desktop/src/html-preview.js';
function fixture(){const dir=mkdtempSync(join(tmpdir(),'friend-editor-')),root=join(dir,'root');mkdirSync(root);return {dir,root,close:()=>rmSync(dir,{recursive:true,force:true})};}
test('full UTF8/BOM/CRLF saves atomically with permissions; stale and repeated conflicts preserve external bytes',()=>{
 const f=fixture();try{const path=join(f.root,'中文.ts'),original='\ufeffconst x = "中文";\r\n';writeFileSync(path,original,{mode:0o755});const doc=readEditorFile(f.root,'中文.ts');assert.equal(doc.editable,true);if(!doc.editable)throw new Error('Expected editable fixture');assert.equal(doc.content,original);assert.equal(doc.hash,contentHash(original));
 assert.equal(writeEditorFile(f.root,'中文.ts',original+'// saved\r\n',doc.hash!).saved,true);assert.equal(statSync(path).mode&0o777,0o755);
 writeFileSync(path,'external');const conflict=writeEditorFile(f.root,'中文.ts','mine',doc.hash!);assert.equal(conflict.conflict,true);assert.equal(readFileSync(path,'utf8'),'external');writeFileSync(path,'external again');assert.equal(writeEditorFile(f.root,'中文.ts','mine',conflict.currentHash!).conflict,true);assert.equal(readdirSync(f.root).some(p=>p.startsWith('.friend-pi-save-')),false);
 }finally{f.close();}
});
test('folder listing is lazy and paginated; unsupported documents and symlink escapes cannot be edited',()=>{
 const f=fixture();try{mkdirSync(join(f.root,'folder'));writeFileSync(join(f.root,'folder','child'),'child');for(let i=0;i<505;i++)writeFileSync(join(f.root,'file'+i),'ok');writeFileSync(join(f.root,'a.pdf'),'%PDF');writeFileSync(join(f.dir,'outside'),'secret');symlinkSync(join(f.dir,'outside'),join(f.root,'escape'));
 const page=listDirectory(f.root);assert.equal(page.entries.length,500);assert.equal(page.nextOffset,500);assert.equal(page.entries.some(e=>e.path==='folder/child'),false);assert.equal(listDirectory(f.root,'folder').entries[0].path,'folder/child');assert.equal(readEditorFile(f.root,'a.pdf').kind,'unsupported');assert.throws(()=>readEditorFile(f.root,'escape'),/不在/);assert.throws(()=>writeEditorFile(f.root,'a.pdf','oops',contentHash('%PDF')),/不是/);
 }finally{f.close();}
});
test('HTML draft and local assets are isolated on every response and grants are revocable',async()=>{
 const f=fixture();try{mkdirSync(join(f.root,'docs'));writeFileSync(join(f.root,'docs','index.html'),'<b>disk</b>');writeFileSync(join(f.root,'docs','style.css'),'b{color:red}');writeFileSync(join(f.root,'docs','other.html'),'<script>bad()</script>');writeFileSync(join(f.root,'docs','image.svg'),'<svg/>');writeFileSync(join(f.dir,'secret.html'),'secret');symlinkSync(join(f.dir,'secret.html'),join(f.root,'docs','escape.html'));
 const grant=grantHtmlPreview(f.root,'docs/index.html','<b>draft</b>');assert.equal(await htmlPreviewResponse(grant.url).text(),'<b>draft</b>');assert.equal(readFileSync(join(f.root,'docs','index.html'),'utf8'),'<b>disk</b>');
 for(const asset of ['style.css','other.html','image.svg']){const response=htmlPreviewResponse(grant.url.replace('index.html',asset));assert.equal(response.status,200);assert.match(response.headers.get('Content-Security-Policy')!,/default-src 'none'/);assert.equal(response.headers.get('Access-Control-Allow-Origin'),'*');}
 assert.equal(htmlPreviewResponse(grant.url.replace('index.html','escape.html')).status,403);assert.equal(htmlPreviewResponse(grant.url.replace('index.html','%2E%2E%2F%2E%2E%2Fsecret.html')).status,403);revokeHtmlPreview(grant.token);assert.equal(htmlPreviewResponse(grant.url).status,403);
 }finally{f.close();}
});
