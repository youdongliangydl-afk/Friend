import test from 'node:test';
import assert from 'node:assert/strict';
import {Compile} from 'typebox/compile';
import type {TSchema} from 'typebox';
import {createEventBus,type ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {registerPlugin} from '../src/index.js';

function registration(options?:Parameters<typeof registerPlugin>[4]){
  let tool!:{name:string;label:string;description:string;parameters:TSchema};const bus=createEventBus();
  const pi={events:bus,on:()=>()=>{},registerCommand:()=>{},registerTool:(definition:typeof tool)=>{tool=definition;}} as unknown as ExtensionAPI;
  registerPlugin(pi,'sample',{dispatch:()=>({}),snapshot:()=>({})},'compact label',options);return {tool,bus};
}
test('plugin tool protocol constrains legal actions and keeps data inside its required input object',()=>{
  const {tool,bus}=registration({toolDescription:'Copy the full id into input.graphId.',actionEnum:['create','start','snapshot']});
  try{assert.equal(tool.label,'compact label');assert.equal(tool.description,'Copy the full id into input.graphId.');const validate=Compile(tool.parameters);assert.equal(validate.Check({action:'start',input:{graphId:'full-id'}}),true);assert.equal(validate.Check({action:'snapshot',input:{}}),true);assert.equal(validate.Check({action:'status',input:{}}),false);assert.equal(validate.Check({action:'start',graphId:'misplaced',input:{}}),false);assert.equal(validate.Check({action:'start'}),false);}finally{bus.clear();}
});
test('registrations without protocol options retain their generic schema and description',()=>{
  const {tool,bus}=registration();try{assert.equal(tool.description,'compact label');const validate=Compile(tool.parameters);assert.equal(validate.Check({action:'snapshot'}),true);assert.equal(validate.Check({action:'plugin-specific',input:{key:'value'}}),true);}finally{bus.clear();}
});
