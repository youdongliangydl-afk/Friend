import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createElement,type ComponentType} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {projectTaskGraphs} from '../apps/desktop/src/renderer/task-graph-model.js';
import {centerTaskGraph,fitTaskGraph,graphMiniMap,layoutTaskGraph,zoomTaskGraph} from '../apps/desktop/src/renderer/task-graph-layout.js';

const node=(id:string,dependencies:string[]=[],extra:Record<string,unknown>={})=>({id,title:id,prompt:'Inspect '+id,mode:'read',dependencies,status:'pending',...extra});
const graph=(extra:Record<string,unknown>={})=>({id:'g',sessionId:'s',runId:'r',goal:'Current goal',status:'running',tasks:[node('a')],attempts:[],...extra});
const flow=(extra:Record<string,unknown>={})=>({id:'f',sessionId:'s',graphId:'g',status:'running',definitionRevision:2,definition:{title:'Workflow',nodes:[node('a'),node('b',['a'])]},nodes:[{id:'a',status:'running',materialized:true},{id:'b',status:'pending',materialized:false}],...extra});
const project=(graphs:Record<string,unknown>[],flows:Record<string,unknown>[]=[],teammates:Record<string,unknown>[]=[])=>(projectTaskGraphs({sessionId:'s',runId:'r',graphs,flows,teammates}));

test('workflow is drawn once, retains future nodes, and binds exact backend attempts',()=>{
 const graphs=project([graph({workflowId:'f',tasks:[node('a',[],{status:'running',currentAttempt:'current',memberId:'m'})],attempts:[{id:'old',taskId:'a',status:'completed',summary:'old result'},{id:'current',taskId:'a',status:'running',summary:'current result',memberId:'m'}]})],[flow()],[{id:'m',rootSessionId:'s',name:'Reader'}]);
 assert.equal(graphs.length,1);assert.equal(graphs[0].key,'workflow:f');assert.equal(graphs[0].nodes.length,2);
 assert.equal(graphs[0].nodes[0].summary,'current result');assert.equal(graphs[0].nodes[0].memberName,'Reader');
 assert.match(graphs[0].nodes[1].waitingReason,/等待：a/);assert.equal(graphs[0].nodes[1].memberId,undefined);
});
test('workflow definition owns dependencies, including backend-omitted skipped predecessors',()=>{
 const [g]=project([graph({workflowId:'f',tasks:[node('b',[],{currentAttempt:'b1',status:'completed'})],attempts:[{id:'b1',taskId:'b',summary:'b result'}]})],[flow({nodes:[{id:'a',status:'skipped',materialized:false},{id:'b',status:'completed',materialized:true,result:'b result'}]})]);
 assert.deepEqual(g.nodes[1].dependencies,['a']);assert.equal(g.nodes[0].status,'skipped');assert.equal(g.nodes[1].summary,'b result');
});
test('current attempt identity excludes a mismatched task and unrelated member',()=>{
 const [g]=project([graph({tasks:[node('a',[],{currentAttempt:'x',memberId:'m'})],attempts:[{id:'x',taskId:'other',summary:'foreign'}]})],[],[{id:'m',rootSessionId:'different',name:'Wrong person'}]);
 assert.equal(g.nodes[0].summary,'');assert.equal(g.nodes[0].memberName,undefined);assert.equal(g.nodes[0].memberId,'m');
});
test('snapshots stay within the session/current run and exclude Team and audit graphs',()=>{
 const graphs=project([graph({id:'foreign',sessionId:'other'}),graph({id:'old',runId:'past'}),graph({id:'team',executionStyle:'team'}),graph({id:'audit',audit:true}),graph()], [flow({sessionId:'other'})]);
 assert.deepEqual(graphs.map(g=>g.key),['swarm:g']);
});
test('workflow reverse association works when the optional graphId is not yet saved',()=>{
 const graphs=project([graph({workflowId:'f'})],[flow({graphId:undefined})]);assert.equal(graphs.length,1);assert.equal(graphs[0].graphId,'g');
});
test('orphan workflow execution is labelled and never silently becomes ordinary Swarm',()=>{
 const [g]=project([graph({workflowId:'gone',runId:'older'})]);assert.equal(g.kind,'workflow');assert.match(g.warning,/工作流来源暂不可用/);assert.match(g.title,/工作流执行记录/);
});
test('conflicting forward identity does not borrow another workflow result',()=>{
 const graphs=project([graph({workflowId:'different',attempts:[{id:'a1',taskId:'a',summary:'secret foreign result'}],tasks:[node('a',[],{currentAttempt:'a1'})]})],[flow()]);
 const g=graphs.find(item=>item.key==='workflow:f')!;assert.equal(g.graphId,undefined);assert.match(g.warning,/身份不一致/);assert.equal(g.nodes[0].summary,'');
});
test('duplicate workflow IDs and duplicate node IDs are not multiplied',()=>{
 const f=flow({definition:{nodes:[node('a'),node('a')]}}),graphs=project([], [f,f]);assert.equal(graphs.length,1);assert.equal(graphs[0].nodes.length,1);assert.match(graphs[0].warning,/重复/);
});
test('waiting reasons distinguish missing dependency, workflow admission and unknown result',()=>{
 const [swarm]=project([graph({tasks:[node('a',['missing']),node('u',[],{status:'unknown'}),node('b',[],{workflowHeld:true})]})]);
 assert.match(swarm.nodes[0].waitingReason,/来源待核对/);assert.match(swarm.warning,/来源缺失/);assert.match(swarm.nodes[1].waitingReason,/结果待核对/);assert.match(swarm.nodes[2].waitingReason,/放行/);
 const [f]=project([], [flow({graphId:undefined,status:'created',definition:{nodes:[node('new')]},nodes:[{id:'new',status:'pending',materialized:false}]})]);assert.match(f.nodes[0].waitingReason,/尚未启动/);
});
test('blocked task keeps its actual status and failed attempt explanation',()=>{
 const [g]=project([graph({tasks:[node('a',[],{status:'blocked',currentAttempt:'a2'})],attempts:[{id:'a2',taskId:'a',status:'failed',error:'Provider unavailable'}]})]);
 assert.equal(g.nodes[0].status,'blocked');assert.equal(g.nodes[0].waitingReason,'Provider unavailable');assert.equal(g.nodes[0].error,'Provider unavailable');
});
test('status/result refresh does not change the graph geometry identity',()=>{
 const [a]=project([graph()]),[b]=project([graph({revision:7,tasks:[node('a',[],{status:'completed',currentAttempt:'a1'})],attempts:[{id:'a1',taskId:'a',summary:'Done'}]})]);assert.equal(a.structureKey,b.structureKey);assert.notEqual(a.nodes[0].status,b.nodes[0].status);
});
test('malformed optional snapshot records are reported without crashing the graph',()=>{
 const graphs=project([null as unknown as Record<string,unknown>,graph({tasks:[null,node('a',['missing'])],attempts:[null]})],[null as unknown as Record<string,unknown>],[null as unknown as Record<string,unknown>]);
 assert.equal(graphs.length,1);assert.equal(graphs[0].nodes.length,1);assert.match(graphs[0].warning,/标识缺失/);
});
test('parallel branches and join use left-to-right ranks with no overlapping cards',()=>{
 const g=layoutTaskGraph([node('a'),node('b',['a']),node('c',['a']),node('d',['b','c'])]);assert.equal(g.invalid,false);const rects=new Map(g.nodes.map(n=>[n.id,n]));
 assert.equal(rects.get('b')!.rank,1);assert.equal(rects.get('c')!.rank,1);assert.equal(rects.get('d')!.rank,2);assert.equal(g.edges.length,4);
 for(const a of g.nodes)for(const b of g.nodes)if(a.id!==b.id)assert.ok(a.x+a.width<=b.x||b.x+b.width<=a.x||a.y+a.height<=b.y||b.y+b.height<=a.y);
 for(const edge of g.edges)assert.ok(rects.get(edge.from)!.x<rects.get(edge.to)!.x);
});
test('cross-rank dependencies route outside intermediate cards',()=>{
 const g=layoutTaskGraph([node('a'),node('b',['a']),node('c',['a','b'])]),edge=g.edges.find(e=>e.from==='a'&&e.to==='c')!;
 const pathNumbers=edge.path.match(/-?\d+(?:\.\d+)?/g)!.map(Number);assert.ok(pathNumbers[3]<Math.min(...g.nodes.map(n=>n.y)));assert.ok(g.width>=Math.max(...g.nodes.map(n=>n.x+n.width)));
});
test('damaged dependency cycles remain bounded and are reported without recursion',()=>{
 const g=layoutTaskGraph([node('a',['b']),node('b',['a']),node('c',['missing'])]);assert.equal(g.invalid,true);assert.ok(g.width<1000);assert.ok(g.height<1000);assert.equal(g.nodes.length,3);assert.equal(g.edges.length,0);
});
test('appended peers preserve the old order and positions',()=>{
 const a=layoutTaskGraph([node('a'),node('b')]),b=layoutTaskGraph([node('a'),node('b'),node('c')],a);
 assert.deepEqual(b.nodes.slice(0,2),a.nodes);assert.ok(b.nodes[2].y>b.nodes[1].y);
});
test('fit all includes a 64-node chain even in a narrow canvas',()=>{
 const nodes=Array.from({length:64},(_,i)=>node(String(i),i?[String(i-1)]:[])),layout=layoutTaskGraph(nodes),size={width:300,height:390},view=fitTaskGraph(layout,size);
 assert.ok(view.zoom<.1);assert.ok(view.x>=0&&view.y>=0);assert.ok(view.x+layout.width*view.zoom<=size.width);assert.ok(view.y+layout.height*view.zoom<=size.height);
 const minimum=zoomTaskGraph(view,0,{x:150,y:195},view.zoom);assert.equal(minimum.zoom,view.zoom);
});
test('zoom preserves the cursor world point and clamps only the chosen zoom',()=>{
 const view={x:-120,y:70,zoom:.8},point={x:210,y:160},next=zoomTaskGraph(view,1.6,point,.03);
 assert.equal((point.x-view.x)/view.zoom,(point.x-next.x)/next.zoom);assert.equal((point.y-view.y)/view.zoom,(point.y-next.y)/next.zoom);assert.equal(zoomTaskGraph(view,50,point,.03).zoom,2);
});
test('minimap viewport and click positioning are exact inverses',()=>{
 const layout={width:2000,height:900},size={width:600,height:400},view={x:-300,y:-80,zoom:.75},mini=graphMiniMap(layout,size,view),worldCenter={x:(size.width/2-view.x)/view.zoom,y:(size.height/2-view.y)/view.zoom};
 assert.ok(Math.abs((mini.viewport.x+mini.viewport.width/2-mini.x)/mini.scale-worldCenter.x)<1e-9);
 assert.ok(Math.abs((mini.viewport.y+mini.viewport.height/2-mini.y)/mini.scale-worldCenter.y)<1e-9);
 assert.deepEqual(centerTaskGraph(view,worldCenter,size),view);
});
test('graph component renders native accessible controls and exact nodes without invoking execution',async()=>{
 const compiled=await build({entryPoints:[fileURLToPath(new URL('../apps/desktop/src/renderer/TaskGraph.tsx',import.meta.url))],bundle:true,platform:'node',format:'cjs',write:false,external:['react','react-dom','react/jsx-runtime'],loader:{'.css':'empty'}});
 const module={exports:{} as {TaskGraphCanvas:ComponentType<{graphs:ReturnType<typeof project>;onOpenMember(id:string):void}>}};
 new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);
 let opened=0;const markup=renderToStaticMarkup(createElement(module.exports.TaskGraphCanvas,{graphs:project([graph({workflowId:'f'})],[flow()]),onOpenMember:()=>{opened++;}}));
 assert.equal((markup.match(/class="task-graph-node"/g)||[]).length,2);assert.match(markup,/选择任务依赖图/);assert.match(markup,/只读任务画布/);assert.match(markup,/适配全部/);assert.match(markup,/任务小地图/);assert.match(markup,/等待：a/);assert.equal(opened,0);assert.doesNotMatch(markup,/contenteditable|draggable="true"/);
 const empty=renderToStaticMarkup(createElement(module.exports.TaskGraphCanvas,{graphs:[],onOpenMember:()=>{opened++;}}));assert.match(empty,/本轮尚未建立任务依赖图/);assert.equal(opened,0);
});
