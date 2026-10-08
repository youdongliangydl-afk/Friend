import type {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {savedModelIds,modelReadiness} from '@friend-pi/core';
import {providerMetadata} from './provider-settings.js';
export {requireReadyModel,testConfiguredModel,registerSavedModel,invalidateProvider} from '@friend-pi/core';
export async function configuredModelMetadata(runtime:ModelRuntime,dataDir:string){const saved=new Set(savedModelIds(dataDir)),metadata=providerMetadata(runtime);return {...metadata,models:await Promise.all(metadata.models.filter(model=>saved.has(model.id)).map(async model=>{const definition=runtime.getModel(model.provider,model.id.slice(model.provider.length+1));return {...model,baseUrl:definition?.baseUrl,api:definition?.api,...await modelReadiness(runtime,dataDir,model.id)};}))};}
