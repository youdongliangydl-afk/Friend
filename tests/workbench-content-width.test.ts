import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {transformSync} from 'esbuild';
import * as jsxRuntime from 'react/jsx-runtime';

type HandleProps={onPointerDown(event:unknown):void;onPointerMove(event:unknown):void;onKeyDown(event:unknown):void};

/** Runs the production ResizeHandle with a deterministic useRef so pointer travel can be replayed. */
function handle(props:Record<string,unknown>):HandleProps{
  const refs:unknown[]=[];let index=0;
  const hooks={useRef(initial:unknown){const id=index++;if(!refs[id])refs[id]={current:initial};return refs[id];}};
  const module={exports:{} as {ResizeHandle:(props:Record<string,unknown>)=>{props:HandleProps}}};
  const context=vm.createContext({module,exports:module.exports,require:(name:string)=>{
    if(name==='react')return hooks;
    if(name==='react/jsx-runtime')return jsxRuntime;
    throw new Error('Unexpected component import: '+name);
  }});
  vm.runInContext(transformSync(readFileSync('apps/desktop/src/renderer/ResizeHandle.tsx','utf8'),{loader:'tsx',format:'cjs',jsx:'automatic',target:'node24'}).code,context);
  return module.exports.ResizeHandle(props).props;
}
const capture=()=>{const changes:number[]=[];return {changes,onChange:(value:number)=>changes.push(value)};};
const pointer={button:0,preventDefault(){},currentTarget:{setPointerCapture(){},releasePointerCapture(){}}};

test('the content column edge follows the cursor because pointer travel is scaled for the centred column',()=>{
  const {changes,onChange}=capture();
  const props=handle({name:'调整内容宽度',value:1000,min:640,max:2400,reverse:true,scale:2,className:'content-resize',onChange});
  props.onPointerDown({...pointer,clientX:500});
  props.onPointerMove({clientX:460});
  assert.deepEqual(changes,[1080],'a 40px left drag widens a centred column by 80px so the grabbed edge stays under the cursor');
  props.onPointerMove({clientX:540});
  assert.deepEqual(changes,[1080,920]);
});
test('the content column edge stays inside its allowed width range',()=>{
  const {changes,onChange}=capture();
  const props=handle({name:'调整内容宽度',value:660,min:640,max:2400,reverse:true,scale:2,className:'content-resize',onChange});
  props.onPointerDown({...pointer,clientX:500});
  props.onPointerMove({clientX:2000});
  assert.deepEqual(changes,[640],'never narrower than the minimum');
  const wide=capture();
  const bounded=handle({name:'调整内容宽度',value:2380,min:640,max:2400,reverse:true,scale:2,className:'content-resize',onChange:wide.onChange});
  bounded.onPointerDown({...pointer,clientX:500});
  bounded.onPointerMove({clientX:0});
  assert.deepEqual(wide.changes,[2400],'never wider than the maximum');
});
test('the content column edge stays operable from the keyboard in fixed steps',()=>{
  const {changes,onChange}=capture();
  const props=handle({name:'调整内容宽度',value:1000,min:640,max:2400,reverse:true,scale:2,className:'content-resize',onChange});
  props.onKeyDown({key:'ArrowLeft',preventDefault(){}});
  props.onKeyDown({key:'ArrowRight',preventDefault(){}});
  props.onKeyDown({key:'Home',preventDefault(){}});
  props.onKeyDown({key:'End',preventDefault(){}});
  assert.deepEqual(changes,[1010,990,640,2400]);
});
test('the workbench content column fills the workspace by default and exposes a draggable left edge',()=>{
  const css=readFileSync('apps/desktop/src/renderer/session-fullscreen.css','utf8');
  assert.match(css,/\.workbench-content-column\{[^}]*max-width:var\(--content-width,1240px\)/);
  assert.match(css,/\.workbench-content-column\{[^}]*margin-inline:auto/);
  assert.match(css,/\.workbench-content-column\{[^}]*width:100%/);
  assert.match(css,/\.content-resize\{[^}]*position:absolute[^}]*left:0/);
});
test('the app publishes the content width, renders the edge handle and keeps it within its range',()=>{
  const app=readFileSync('apps/desktop/src/renderer/App.tsx','utf8');
  assert.match(app,/--content-width':contentWidth\+'px'/);
  assert.match(app,/contentWidth:Number\(v\.contentWidth\)\|\|1240/);
  assert.match(app,/Math\.max\(640,Math\.min\(layout\.contentWidth,2400\)\)/);
  assert.match(app,/className="content-resize" name="调整内容宽度" value=\{contentWidth\} min=\{640\} max=\{2400\} reverse scale=\{2\}/);
});
test('the Git panel no longer caps its own width so it uses the whole content column',()=>{
  const git=readFileSync('apps/desktop/src/renderer/GitPanel.tsx','utf8');
  assert.doesNotMatch(git,/max-width:920px/);
  assert.doesNotMatch(git,/margin:0 auto/);
  assert.match(git,/\.git-panel\{[^}]*width:100%/);
});
