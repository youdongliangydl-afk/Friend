/** Per-validation memoization. Never retain a graph after its definition can change. */
export function graphReachability(nodes:readonly {id:string;dependencies:readonly string[]}[]) {
  const byId=new Map(nodes.map(node=>[node.id,node])),cache=new Map<string,ReadonlySet<string>>(),visiting=new Set<string>();
  if(byId.size!==nodes.length)throw new Error('任务标识重复');
  const ancestors=(id:string):ReadonlySet<string>=>{
    const known=cache.get(id);if(known)return known;
    const node=byId.get(id);if(!node)throw new Error(`依赖任务不存在：${id}`);
    if(visiting.has(id))throw new Error('任务依赖形成循环');
    visiting.add(id);const result=new Set<string>();
    for(const dep of node.dependencies){result.add(dep);for(const upstream of ancestors(dep))result.add(upstream);}
    visiting.delete(id);cache.set(id,result);return result;
  };
  return {ancestors,depends:(id:string,dependency:string)=>ancestors(id).has(dependency)};
}
