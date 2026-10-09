import {SwarmController as Controller} from '../src/index.js';
import type {JsonObject,PluginContext} from '@friend-pi/core';
/** Compatibility fixtures intentionally exercise stored v1 graphs and their original receipt semantics. */
export class SwarmController extends Controller {
  override dispatch(action:string,input:JsonObject,ctx:PluginContext):Promise<unknown>{return super.dispatch(action,action==='create'?{...input,collaborationVersion:1}:input,ctx);}
}
