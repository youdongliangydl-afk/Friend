import {SwarmController as Controller} from '../src/index.js';
import type {JsonObject,PluginContext} from '@friend-pi/core';
/** Compatibility fixtures intentionally exercise stored v1 graphs and their original receipt semantics. */
export class SwarmController extends Controller {
  override dispatch(action:string,input:JsonObject,ctx:PluginContext):Promise<unknown>{return super.dispatch(action,action==='create'||action==='team.delegate'?{...input,collaborationVersion:1}:input,ctx);}
}

import {RecordStore} from '@friend-pi/core';
import type {Graph} from '../src/types.js';
/** Stored v2 compatibility fixtures predate task contracts and candidate receipts. */
export class V2SwarmController extends Controller {override async dispatch(action:string,input:JsonObject,ctx:PluginContext):Promise<unknown>{const result=await super.dispatch(action,input,ctx);if(action!=='create')return result;const graph=result as Graph,store=new RecordStore('swarm',ctx.dataDir);try{const row=store.get<Graph>(`graph:${ctx.projectId}:${graph.id}`)!;delete row.value.schemaVersion;delete row.value.contract;delete row.value.budget;delete row.value.sourceFence;store.put(row.key,row.value,row.revision);return row.value;}finally{store.close();}}}
