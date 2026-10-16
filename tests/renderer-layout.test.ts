import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';

/** Real Chromium layout regression. Desktop acceptance is a separate Computer Use journey. */
test('strength saves keep the popover geometry and navigation exposes only the target session draft',{skip:process.platform!=='darwin',timeout:30000},async()=>{
  const root=mkdtempSync(join(tmpdir(),'friend-renderer-layout-'));
  try{
    const dist=resolve('apps/desktop/dist/renderer'),require=createRequire(import.meta.url),electron=require('electron') as string;
    const geometryCode=String.raw`new Promise(resolve=>{
      const panel=document.querySelector('.model-picker-popover'),slider=document.querySelector('.model-effort-slider');
      const samples=[];const begin=performance.now();
      const sample=()=>{const a=panel.getBoundingClientRect(),b=slider.getBoundingClientRect();samples.push({y:a.y,height:a.height,sliderY:b.y,level:document.querySelector('.model-strength-card strong').textContent});if(performance.now()-begin<650)setTimeout(sample,10);else resolve(samples);};
      sample();slider.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(slider,'1');slider.dispatchEvent(new Event('input',{bubbles:true}));slider.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowRight',bubbles:true}));
    })`;
    const navigationCode=String.raw`new Promise(resolve=>{
      const samples=[];const begin=performance.now();
      const sample=()=>{const heading=document.querySelector('.conversation-title h2').textContent,input=document.querySelector('textarea[aria-label="消息"]');const sidebar=document.querySelector('.sidebar');samples.push({heading,draft:input.value,busy:sidebar.getAttribute('aria-busy'),opacity:getComputedStyle(sidebar.querySelector('.new-chat')).opacity});if(performance.now()-begin<650)setTimeout(sample,10);else resolve(samples);};
      sample();[...document.querySelectorAll('.project-sidebar button')].find(button=>button.textContent==='Layout B').click();
    })`;
    const script=String.raw`
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
app.setPath('userData',${JSON.stringify(join(root,'profile'))});
app.whenReady().then(async()=>{
  const window=new BrowserWindow({width:1100,height:800,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
  const run=code=>window.webContents.executeJavaScript(code);
  const until=code=>run('new Promise((yes,no)=>{const start=Date.now();const timer=setInterval(()=>{if('+code+'){clearInterval(timer);yes(true);}else if(Date.now()-start>5000){clearInterval(timer);no(new Error("renderer wait timed out"));}},10);})');
  try{
    await window.loadFile(${JSON.stringify(join(root,'index.html'))});
    await until('document.querySelector(".conversation-title h2")?.textContent==="Layout A"');
    await run('document.querySelector(".model-picker-trigger").click()');
    await until('document.querySelector(".model-picker-popover")?.matches(":popover-open")');
    const geometry=await run(${JSON.stringify(geometryCode)});
    await run('document.querySelector(".model-picker-popover").hidePopover()');
    const navigation=await run(${JSON.stringify(navigationCode)});
    fs.writeFileSync(${JSON.stringify(join(root,'result.json'))},JSON.stringify({geometry,navigation,calls:await run('window.layoutCalls')}));
    window.destroy();app.exit(0);
  }catch(error){console.error(error.stack);window.destroy();app.exit(1);}
});`;
    const fixture=String.raw`
const listeners=[];window.layoutCalls=[];
const current=id=>({sessionId:id,projectId:'p',messages:[{id:'message-'+id,role:'user',text:'history '+id}],isRunning:false,plugins:[],modelId:'layout/model',thinkingLevel:'off',thinkingLevels:['off','low','high'],executionMode:'single',permissionMode:'auto'});
let snapshot={revision:1,selectedProjectId:'p',navigation:{back:true,forward:false},projects:[{id:'p',name:'Layout project',path:'/layout'}],sessions:[{id:'a',projectId:'p',name:'Layout A',updatedAt:'2026-10-17',path:'/a'},{id:'b',projectId:'p',name:'Layout B',updatedAt:'2026-10-17',path:'/b'}],current:current('a'),providers:[{id:'layout',name:'Layout',configured:true}],models:[{id:'layout/model',provider:'layout',name:'Layout model',reasoning:true,contextWindow:32000,ready:true,thinkingLevels:['off','low','high']}]};
localStorage.clear();for(const id of ['a','b'])localStorage.setItem('friend-pi.draft.v1:'+id,JSON.stringify({text:'draft '+id,attachments:[],mode:'single',planMode:false}));
window.friendPi={onEvent(callback){listeners.push(callback);return()=>{};},async request(method,input){window.layoutCalls.push(method);
  if(method==='app.state')return structuredClone(snapshot);
  if(method==='browser.list')return {tabs:[],downloads:[]};
  if(method==='session.configure'){await new Promise(done=>setTimeout(done,250));snapshot={...snapshot,revision:snapshot.revision+1,current:{...snapshot.current,...input}};listeners.forEach(callback=>callback({type:'state',data:structuredClone(snapshot)}));return structuredClone(snapshot);}
  if(method==='session.open'){snapshot={...snapshot,revision:snapshot.revision+1,current:current(input.id)};listeners.forEach(callback=>callback({type:'state',data:structuredClone(snapshot)}));await new Promise(done=>setTimeout(done,250));return structuredClone(snapshot);}
  return {};
}};`;
    writeFileSync(join(root,'index.html'),`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(join(dist,'app.css'))}"></head><body><div id="root"></div><script>${fixture}</script><script src="${pathToFileURL(join(dist,'app.js'))}"></script></body></html>`);
    writeFileSync(join(root,'runner.cjs'),script);
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>['HOME','PATH','TMPDIR','USER','LOGNAME','LANG','LC_ALL'].includes(key)));
    await promisify(execFile)(electron,[join(root,'runner.cjs')],{env,timeout:25000,maxBuffer:100000});
    const result=JSON.parse(readFileSync(join(root,'result.json'),'utf8'));
    assert.ok(result.geometry.length>10);assert.ok(result.geometry.some((sample:any)=>sample.level==='低'),'the test must actually commit a different strength');
    for(const key of ['y','height','sliderY']){const values=result.geometry.map((sample:any)=>sample[key]);assert.ok(Math.max(...values)-Math.min(...values)<0.5,`${key} moved while applying strength`);}
    assert.ok(result.navigation.some((frame:any)=>frame.busy==='true'),'must sample pending navigation');
    for(const frame of result.navigation){assert.equal(frame.draft,frame.heading==='Layout B'?'draft b':'draft a');if(frame.busy==='true'){assert.equal(frame.heading,'Layout A');assert.equal(frame.opacity,'1');}}
    assert.equal(result.navigation.at(-1).heading,'Layout B');assert.equal(result.calls.filter((method:string)=>method==='app.state').length,1);
  }finally{rmSync(root,{recursive:true,force:true});}
});
