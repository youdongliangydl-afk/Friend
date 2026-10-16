import type {Graph} from './types.js';

const graphActions=new Set(['create','start','pause','stop','resume','prepare','review','integrate','rework','configure','append','update_task','workflow_skip','citations.bind']);

function projectGraph(graph:Graph):unknown {
  const {expertCatalog,attempts,...retained}=graph;
  return {...retained,attempts:attempts.map(({expert,...attempt})=>attempt)};
}

/** Model content needs coordination evidence, not repeated member execution context. */
export function projectSwarmToolResult(action:string,result:unknown):unknown {
  if(!result||typeof result!=='object')return result;
  if(action==='snapshot'||action==='history'||action==='stop.members'){
    const snapshot=result as {graphs?:Graph[];members?:unknown};
    if(!Array.isArray(snapshot.graphs))return result;
    const {members,...retained}=snapshot;
    return {...retained,graphs:snapshot.graphs.map(projectGraph)};
  }
  if(graphActions.has(action))return projectGraph(result as Graph);
  return result;
}
