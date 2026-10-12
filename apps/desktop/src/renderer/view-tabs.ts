import type { SessionViewState,ToolPage,ViewTab } from '../session-view.js';
export function openTool(view:SessionViewState,page:ToolPage):SessionViewState {
  const existing=view.tabs.find(t=>t.kind==='tool'&&t.page===page);
  const tabs=view.tabs.filter(t=>!(t.id===view.active&&t.kind==='new'));
  const tab=existing||{id:crypto.randomUUID(),kind:'tool' as const,page};
  return {...view,tabs:existing?tabs:[...tabs,tab],active:tab.id};
}
export function toggleTerminal(view:SessionViewState):SessionViewState {
  const terminal=view.tabs.find(tab=>tab.kind==='tool'&&tab.page==='terminal');
  return terminal?.id===view.active?{...view,tabs:view.tabs.filter(tab=>tab.id!==terminal.id),active:'conversation'}:openTool(view,'terminal');
}
export function toggleTrace(view:SessionViewState):SessionViewState {
  const trace=view.tabs.find(tab=>tab.kind==='tool'&&tab.page==='trace');
  return trace?.id===view.active?{...view,tabs:view.tabs.filter(tab=>tab.id!==trace.id),active:'conversation'}:openTool(view,'trace');
}
export function addNewTab(view:SessionViewState):SessionViewState {const tab:ViewTab={id:crypto.randomUUID(),kind:'new'};return {...view,tabs:[...view.tabs,tab],active:tab.id};}
export function closeViewTab(view:SessionViewState,id:string):SessionViewState {
  const index=view.tabs.findIndex(t=>t.id===id);if(index<0)return view;
  const tabs=view.tabs.filter(t=>t.id!==id);
  return {...view,tabs,active:view.active===id?(tabs[Math.max(0,index-1)]?.id||'conversation'):view.active};
}

/** Expert presentation is temporarily hidden; old saved tool tabs must not leave an empty active page. */
export function visibleSessionView(view:SessionViewState):SessionViewState {
  const tabs=view.tabs.filter(tab=>tab.kind!=='tool'||tab.page!=='expert');
  if(tabs.length===view.tabs.length)return view;
  return {...view,tabs,active:tabs.some(tab=>tab.id===view.active)||view.active==='conversation'?view.active:'conversation'};
}
