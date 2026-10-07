export type IconName='friend'|'folder'|'sidebar'|'file'|'diff'|'swarm'|'expert'|'memory'|'context'|'settings'|'history'|'search'|'bookmark'|'send'|'shield'|'plan'|'single'|'plus'|'workbench';
const paths:Record<Exclude<IconName,'friend'>,string[]>={
  folder:['M3 6h6l2 2h10v11H3z'],sidebar:['M4 4h16v16H4z','M9 4v16'],file:['M6 3h8l4 4v14H6z','M14 3v5h5','M9 12h6M9 16h6'],
  diff:['M7 3H4v18h3M17 3h3v18h-3','M9 7h6M12 4v6M9 16h6'],swarm:['M12 3a2 2 0 1 0 0 4a2 2 0 1 0 0-4','M5 16a2 2 0 1 0 0 4a2 2 0 1 0 0-4','M19 16a2 2 0 1 0 0 4a2 2 0 1 0 0-4','M12 7v5M5 16v-4h14v4'],
  expert:['M12 3l3 6 6 3-6 3-3 6-3-6-6-3 6-3z'],memory:['M8 4H6a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h2M16 4h2a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3h-2','M12 3v18M7 8h5M12 15h5'],
  context:['M3 7l9-4 9 4-9 4z','M3 12l9 4 9-4M3 17l9 4 9-4'],settings:['M4 7h16M4 17h16','M8 4v6M16 14v6'],history:['M12 3a9 9 0 1 0 9 9a9 9 0 0 0-9-9','M12 7v5l3 2'],search:['M10 3a7 7 0 1 0 0 14a7 7 0 0 0 0-14','M15 15l6 6'],
  bookmark:['M6 3h12v18l-6-4-6 4z'],send:['M3 11l18-8-8 18-3-8z','M10 13l11-10'],shield:['M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6z','M8 12l3 3 5-6'],plan:['M8 15a6 6 0 1 1 8 0l-1 3H9z','M9 21h6'],single:['M12 3a4 4 0 1 0 0 8a4 4 0 1 0 0-8','M5 21v-3a7 7 0 0 1 14 0v3'],plus:['M12 5v14M5 12h14'],workbench:['M4 4h16v16H4z','M15 4v16'],
};
export function Icon({name,size=18}:{name:IconName;size?:number}) {
  if(name==='friend')return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false" className="ui-icon friend-icon"><path fill="currentColor" d="M4 20V7a4 4 0 0 1 4-4h13v5H9v4h9v4H9v4z"/></svg>;
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className="ui-icon">{paths[name].map((path,index)=><path d={path} key={index}/>)}</svg>;
}
