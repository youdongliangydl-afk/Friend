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

test('the reading column edge follows the cursor because pointer travel is scaled for the centred column',()=>{
  const {changes,onChange}=capture();
  const props=handle({name:'调整会话正文宽度',value:780,min:520,max:1600,scale:2,className:'reading-resize',onChange});
  props.onPointerDown({...pointer,clientX:900});
  props.onPointerMove({clientX:940});
  assert.deepEqual(changes,[860],'a 40px right drag widens the centred column by 80px so the grabbed edge stays under the cursor');
  props.onPointerMove({clientX:860});
  assert.deepEqual(changes,[860,700]);
});
test('the reading column edge stays inside its allowed width range',()=>{
  const {changes,onChange}=capture();
  const props=handle({name:'调整会话正文宽度',value:540,min:520,max:1600,scale:2,className:'reading-resize',onChange});
  props.onPointerDown({...pointer,clientX:900});
  props.onPointerMove({clientX:0});
  assert.deepEqual(changes,[520],'never narrower than the minimum');
  const wide=capture();
  const bounded=handle({name:'调整会话正文宽度',value:1580,min:520,max:1600,scale:2,className:'reading-resize',onChange:wide.onChange});
  bounded.onPointerDown({...pointer,clientX:900});
  bounded.onPointerMove({clientX:2000});
  assert.deepEqual(wide.changes,[1600],'never wider than the maximum');
});
test('the reading column edge stays operable from the keyboard in fixed steps',()=>{
  const {changes,onChange}=capture();
  const props=handle({name:'调整会话正文宽度',value:780,min:520,max:1600,scale:2,className:'reading-resize',onChange});
  props.onKeyDown({key:'ArrowLeft',preventDefault(){}});
  props.onKeyDown({key:'ArrowRight',preventDefault(){}});
  props.onKeyDown({key:'Home',preventDefault(){}});
  props.onKeyDown({key:'End',preventDefault(){}});
  assert.deepEqual(changes,[770,790,520,1600]);
});
test('the message column follows the published reading width instead of a fixed 780px cap',()=>{
  const css=readFileSync('apps/desktop/src/renderer/layout.css','utf8');
  assert.match(css,/\.friend-layout \.messages\{max-width:var\(--reading-column,780px\)\}/);
  assert.match(css,/\.conversation-stage\{[^}]*--reading-column:var\(--reading-width,780px\)/);
  assert.match(css,/\.conversation-drag-margin\.left\{[^}]*var\(--reading-column,780px\)/);
  assert.match(css,/\.conversation-drag-margin\.right\{[^}]*var\(--reading-column,780px\)/);
  assert.doesNotMatch(css,/calc\(\(100% - 780px/,'the drag rails must follow the adjustable column, not a hard coded width');
});
test('the reading edge handle sits on the right border of the message column',()=>{
  const css=readFileSync('apps/desktop/src/renderer/layout.css','utf8');
  assert.match(css,/\.reading-resize\{[^}]*position:absolute[^}]*top:0[^}]*bottom:0/);
  assert.match(css,/\.reading-resize\{[^}]*cursor:col-resize/);
  assert.match(css,/\.reading-resize\{[^}]*left:calc\(var\(--conversation-left-padding\)/);
});
test('the app publishes the reading width, renders the edge handle and keeps it within its range',()=>{
  const app=readFileSync('apps/desktop/src/renderer/App.tsx','utf8');
  assert.match(app,/--reading-width':readingWidth\+'px'/);
  assert.match(app,/readingWidth:Number\(v\.readingWidth\)\|\|780/);
  assert.match(app,/Math\.max\(520,Math\.min\(layout\.readingWidth,1600\)\)/);
  assert.match(app,/className="reading-resize" name="调整会话正文宽度" value=\{readingWidth\} min=\{520\} max=\{1600\} scale=\{2\}/);
});
