export type IconName='friend'|'hand'|'smart'|'unlock'|'chat'|'folder'|'sidebar'|'file'|'diff'|'swarm'|'team'|'expert'|'memory'|'context'|'settings'|'history'|'search'|'bookmark'|'send'|'shield'|'plan'|'single'|'plus'|'workbench'|'terminal'|'globe'|'back'|'forward'|'compose'|'trace'|'goal'|'git';
const paths:Record<Exclude<IconName,'friend'>,string[]>={
  goal:['M12 3a9 9 0 1 0 9 9','M12 7a5 5 0 1 0 5 5','M12 12l9-9M16 3h5v5'],
  terminal:['M3 4h18v16H3z','M7 8l3 4-3 4M13 16h4'],git:['M6 4a2 2 0 1 0 0 4a2 2 0 1 0 0-4','M6 8v8a2 2 0 0 0 2 2h4','M18 12a2 2 0 1 0 0 4a2 2 0 1 0 0-4','M18 16V8a4 4 0 0 0-4-4h-2'],globe:['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18','M3 12h18M12 3c-5 5-5 13 0 18M12 3c5 5 5 13 0 18'],
  back:['M15 5l-7 7 7 7','M8 12h13'],forward:['M9 5l7 7-7 7','M16 12H3'],compose:['M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7','M15 3l6 6M9 15l2-6 9-9 4 4-9 9z'],trace:['M4 5h3v3H4zM4 16h3v3H4z','M11 6h10M11 17h10M5.5 8v8'],
  hand:['M7 12V5a2 2 0 0 1 4 0v6M11 9V4a2 2 0 0 1 4 0v7M15 10V7a2 2 0 0 1 4 0v9c0 4-3 6-7 6-3 0-5-1-7-4l-2-4a2 2 0 0 1 3-2l2 2'],smart:['M12 3l2 6 6 3-6 2-2 7-2-7-7-2 7-3z'],unlock:['M8 11V7a4 4 0 0 1 8 0','M5 11h14v10H5z','M12 15v2'],
  chat:['M4 4h16v12H9l-5 4z'],team:['M12 4a3 3 0 1 0 0 6a3 3 0 1 0 0-6','M5 7a2 2 0 1 0 0 4a2 2 0 1 0 0-4','M19 7a2 2 0 1 0 0 4a2 2 0 1 0 0-4','M7 21v-3a5 5 0 0 1 10 0v3M2 20v-4a3 3 0 0 1 5-2M22 20v-4a3 3 0 0 0-5-2'],
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
