import type {TaskGraphNode} from './task-graph-model.js';

export interface GraphRect {id:string;x:number;y:number;width:number;height:number;rank:number}
export interface TaskGraphLayout {nodes:GraphRect[];edges:{from:string;to:string;path:string}[];width:number;height:number;invalid:boolean}
export interface GraphViewport {x:number;y:number;zoom:number}
export interface ViewSize {width:number;height:number}
export const GRAPH_CARD_WIDTH=248,GRAPH_CARD_HEIGHT=128;

/** Stable Kahn ranks and predecessor-centre order, adapted from Wind flowModel.ts (58aed730). */
export function layoutTaskGraph(nodes:Pick<TaskGraphNode,'id'|'dependencies'>[],previous?:TaskGraphLayout):TaskGraphLayout {
 const order=new Map(nodes.map((node,index)=>[node.id,index])),ids=new Set(order.keys()),incoming=new Map(nodes.map(node=>[node.id,[...new Set(node.dependencies.filter(dep=>ids.has(dep)&&dep!==node.id))]]));
 const outgoing=new Map(nodes.map(node=>[node.id,[] as string[]])),counts=new Map([...incoming].map(([id,deps])=>[id,deps.length])),ranks=new Map(nodes.map(node=>[node.id,0]));
 for(const [id,deps] of incoming)for(const dep of deps)outgoing.get(dep)!.push(id);
 const queue=nodes.filter(node=>counts.get(node.id)===0).map(node=>node.id);
 for(let i=0;i<queue.length;i++)for(const target of outgoing.get(queue[i])!){ranks.set(target,Math.max(ranks.get(target)!,ranks.get(queue[i])!+1));counts.set(target,counts.get(target)!-1);if(!counts.get(target))queue.push(target);}
 const invalid=queue.length!==nodes.length||nodes.some(node=>node.dependencies.some(dep=>!ids.has(dep)||dep===node.id));
 const cyclic=new Set(nodes.filter(node=>counts.get(node.id)!>0).map(node=>node.id));
 const edges=[...incoming].flatMap(([to,deps])=>deps.filter(from=>!cyclic.has(from)&&!cyclic.has(to)).map(from=>({from,to}))),longSources=[...new Set(edges.filter(edge=>ranks.get(edge.to)!>ranks.get(edge.from)!+1).map(edge=>edge.from))];
 const margin=36,routeBand=longSources.length?longSources.length*12+24:0,prior=new Map(previous?.nodes.map(node=>[node.id,node])),centres=new Map<string,number>(),placed:GraphRect[]=[];
 for(const rank of [...new Set(ranks.values())].sort((a,b)=>a-b)){
  const weight=(id:string)=>{const parents=incoming.get(id)!.flatMap(dep=>centres.has(dep)?[centres.get(dep)!]:[]);return parents.length?parents.reduce((a,b)=>a+b,0)/parents.length:order.get(id)!*(GRAPH_CARD_HEIGHT+32);};
  const layer=nodes.filter(node=>ranks.get(node.id)===rank).sort((a,b)=>{const pa=prior.get(a.id),pb=prior.get(b.id);return pa?.rank===rank&&pb?.rank===rank?pa.y-pb.y:pa?.rank===rank?-1:pb?.rank===rank?1:weight(a.id)-weight(b.id)||order.get(a.id)!-order.get(b.id)!;});
  layer.forEach((node,row)=>{const rect={id:node.id,x:margin+rank*(GRAPH_CARD_WIDTH+96),y:margin+routeBand+row*(GRAPH_CARD_HEIGHT+32),width:GRAPH_CARD_WIDTH,height:GRAPH_CARD_HEIGHT,rank};placed.push(rect);centres.set(node.id,rect.y+rect.height/2);});
 }
 const byId=new Map(placed.map(node=>[node.id,node]));
 return {nodes:placed,edges:edges.map(edge=>{const a=byId.get(edge.from)!,b=byId.get(edge.to)!,sx=a.x+a.width,sy=a.y+a.height/2,tx=b.x,ty=b.y+b.height/2;
  const path=b.rank>a.rank+1?`M${sx},${sy} H${sx+28} V${margin+longSources.indexOf(edge.from)*12} H${tx-28} V${ty} H${tx}`:`M${sx},${sy} H${sx+48} V${ty} H${tx}`;return {...edge,path};}),width:Math.max(300,...placed.map(node=>node.x+node.width+margin)),height:Math.max(220,...placed.map(node=>node.y+node.height+margin)),invalid};
}
export function fitTaskGraph(layout:Pick<TaskGraphLayout,'width'|'height'>,size:ViewSize):GraphViewport {
 const zoom=Math.max(0.0001,Math.min(1,Math.max(1,size.width-48)/layout.width,Math.max(1,size.height-48)/layout.height));
 return {zoom,x:(size.width-layout.width*zoom)/2,y:(size.height-layout.height*zoom)/2};
}
/** Keep the world point under the cursor fixed while zooming. */
export function zoomTaskGraph(view:GraphViewport,requested:number,anchor:{x:number;y:number},minimum:number):GraphViewport {
 const zoom=Math.max(Math.max(0.0001,Math.min(.1,minimum)),Math.min(2,Number.isFinite(requested)?requested:view.zoom));
 return {zoom,x:anchor.x-(anchor.x-view.x)/view.zoom*zoom,y:anchor.y-(anchor.y-view.y)/view.zoom*zoom};
}
export function centerTaskGraph(view:GraphViewport,world:{x:number;y:number},size:ViewSize):GraphViewport {return {...view,x:size.width/2-world.x*view.zoom,y:size.height/2-world.y*view.zoom};}
export function graphMiniMap(layout:Pick<TaskGraphLayout,'width'|'height'>,size:ViewSize,view:GraphViewport,width=160,height=100){
 const scale=Math.min((width-8)/layout.width,(height-8)/layout.height),x=(width-layout.width*scale)/2,y=(height-layout.height*scale)/2;
 return {scale,x,y,viewport:{x:x-view.x/view.zoom*scale,y:y-view.y/view.zoom*scale,width:size.width/view.zoom*scale,height:size.height/view.zoom*scale}};
}
