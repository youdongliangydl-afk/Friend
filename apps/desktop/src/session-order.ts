export interface OrderedSession {id:string;projectId:string;updatedAt:string}

export function orderedSessions<T extends OrderedSession>(sessions:readonly T[],order:readonly string[]=[]):T[] {
  const ranks=new Map(order.map((id,index)=>[id,index]));
  return [...sessions].sort((a,b)=>{
    const ar=ranks.get(a.id),br=ranks.get(b.id);
    // New sessions stay at the top; saved positions do not follow activity timestamps.
    if(ar===undefined&&br!==undefined)return -1;
    if(br===undefined&&ar!==undefined)return 1;
    return ar!==undefined&&br!==undefined?ar-br:b.updatedAt.localeCompare(a.updatedAt)||a.id.localeCompare(b.id);
  });
}

export function validateSessionOrder(sessions:readonly OrderedSession[],projectId:unknown,ids:unknown):string[] {
  if(typeof projectId!=='string')throw new Error('会话项目无效');
  const scoped=sessions.filter(session=>session.projectId===projectId);
  if(!Array.isArray(ids)||ids.length!==scoped.length||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!scoped.some(session=>session.id===id)))throw new Error('会话列表已变化，请重试排序');
  return [...ids];
}
