export interface SessionRoute {projectId:string;sessionId:string|null}
interface NavigationEntry {id:number;route:SessionRoute}

export class SessionNavigation {
  private serial=0;
  private entries:NavigationEntry[]=[];
  private cursor=-1;
  constructor(route:SessionRoute){this.visit(route);}
  visit(route:SessionRoute){
    const current=this.entries[this.cursor]?.route;
    if(current?.projectId===route.projectId&&current.sessionId===route.sessionId)return;
    this.entries=this.entries.slice(0,this.cursor+1);
    this.entries.push({id:++this.serial,route:{...route}});
    if(this.entries.length>100)this.entries.shift();
    this.cursor=this.entries.length-1;
  }
  target(direction:-1|1,available:(route:SessionRoute)=>boolean){
    for(let index=this.cursor+direction;index>=0&&index<this.entries.length;index+=direction){const entry=this.entries[index];if(available(entry.route))return entry;}
  }
  commit(target:NavigationEntry){
    const index=this.entries.findIndex(entry=>entry.id===target.id);
    if(index<0)return false;
    this.cursor=index;return true;
  }
}
