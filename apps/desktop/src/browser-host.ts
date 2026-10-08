import {WebContentsView,session,dialog,type BrowserWindow,type DownloadItem,type Rectangle,type WebContents,type Session} from 'electron';
import {join,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {browserPartition} from './browser-policy.js';
import {browserUrl,newBrowserTab,type SessionViewState,type ViewTab} from './session-view.js';

interface Context {id:string;workspacePath:string;ui:SessionViewState}
interface Entry {owner:string;tabId:string;view:WebContentsView;url:string;title:string;loading:boolean;error?:string;retired:boolean;downloads:Set<string>}
interface Download {id:string;owner:string;tabId:string;name:string;received:number;total:number;state:string;path?:string;item?:DownloadItem}
export interface BrowserSnapshot {tabs:{id:string;url:string;title:string;loading:boolean;error?:string}[];downloads:Omit<Download,'item'>[]}
export class BrowserHost {
  private entries=new Map<string,Entry>();
  private retired=new Set<Entry>();
  private sessions=new Map<Session,(event:Electron.Event,item:DownloadItem,source:WebContents)=>void>();
  private downloads=new Map<string,Download>();
  private overlay?:WebContentsView;
  private overlayOwner='';
  private overlayToken='';
  private closed=false;
  private presented='';
  private overlaySnapshot:Record<string,unknown>={};
  private composerRevision=0;
  constructor(private window:BrowserWindow,private root:string,private context:(id:string)=>Context,private save:(id:string,ui:SessionViewState)=>void,private emit:(type:string,data:unknown,id?:string)=>void){}
  private key(owner:string,id:string){return owner+':'+id;}
  snapshot(owner:string):BrowserSnapshot {return {tabs:[...this.entries.values()].filter(e=>e.owner===owner).map(e=>({id:e.tabId,url:e.url,title:e.title,loading:e.loading,error:e.error})),downloads:[...this.downloads.values()].filter(d=>d.owner===owner).map(({item,...d})=>d)};}
  private changed(owner:string){if(!this.closed)this.emit('browser',this.snapshot(owner),owner);}
  private metadata(entry:Entry,url=entry.url){
    if(entry.retired||this.closed||this.entries.get(this.key(entry.owner,entry.tabId))!==entry)return;
    try{const normalized=url==='about:blank'?url:browserUrl(url),context=this.context(entry.owner);if(!context.ui.tabs.some(t=>t.id===entry.tabId))return;entry.url=normalized;this.save(entry.owner,{...context.ui,tabs:context.ui.tabs.map(t=>t.id===entry.tabId?{...t,url:entry.url,title:entry.title}:t)});}
    catch{entry.error='网页状态无法保存，请检查地址后重试';}
    this.changed(entry.owner);
  }
  private security(view:WebContentsView,entry?:Entry){
    const contents=view.webContents;
    contents.on('will-navigate',(event,url)=>{try{if(url!=='about:blank')browserUrl(url);}catch{event.preventDefault();}});
    contents.on('will-redirect',(event,url)=>{try{if(url!=='about:blank')browserUrl(url);}catch{event.preventDefault();}});
    contents.on('before-input-event',(event,input)=>{if(input.type==='keyDown'&&(input.meta||input.control)&&['t','w','n','k','l'].includes(input.key.toLowerCase())&&!input.isComposing){event.preventDefault();this.emit('browser.shortcut',{key:input.key.toLowerCase()},entry?.owner||this.overlayOwner);}});
  }
  private attach(owner:string,tab:ViewTab,popupContents?:WebContents):Entry {
    const context=this.context(owner),partition=browserPartition(context.ui.browserScope,owner,context.workspacePath),ses=session.fromPartition(partition);
    this.watchDownloads(ses);
    const view=new WebContentsView({...(popupContents?{webContents:popupContents}:{}),webPreferences:{session:ses,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}});
    const entry:Entry={owner,tabId:tab.id,view,url:tab.url!,title:tab.title||'网页',loading:false,retired:false,downloads:new Set()};
    this.entries.set(this.key(owner,tab.id),entry);this.window.contentView.addChildView(view);view.setVisible(false);this.security(view,entry);
    const c=view.webContents;
    c.on('destroyed',()=>{
      const key=this.key(owner,entry.tabId);if(this.closed||entry.retired||this.entries.get(key)!==entry)return;
      this.entries.delete(key);entry.retired=true;this.window.contentView.removeChildView(view);
      for(const id of entry.downloads)this.downloads.get(id)?.item?.cancel();
      if(this.presented===key){this.presented='';this.overlay?.setVisible(false);}
      const ctx=this.context(owner),index=ctx.ui.tabs.findIndex(t=>t.id===entry.tabId),tabs=ctx.ui.tabs.filter(t=>t.id!==entry.tabId);
      this.save(owner,{...ctx.ui,tabs,active:ctx.ui.active===entry.tabId?(tabs[Math.max(0,index-1)]?.id||'conversation'):ctx.ui.active});this.changed(owner);
    });
    c.on('did-start-loading',()=>{entry.loading=true;entry.error=undefined;this.changed(owner);});
    c.on('did-stop-loading',()=>{entry.loading=false;this.changed(owner);});
    c.on('did-navigate',(_event,url)=>{this.metadata(entry,url);});
    c.on('did-navigate-in-page',(_event,url,main)=>{if(main){this.metadata(entry,url);}});
    c.on('page-title-updated',(_event,title)=>{entry.title=title;this.metadata(entry);});
    c.on('did-fail-load',(_event,code,description,_url,main)=>{if(main&&code!==-3){entry.loading=false;entry.error=description;this.changed(owner);}});
    c.on('render-process-gone',()=>{entry.error='网页进程已退出，请刷新重试';entry.loading=false;view.setVisible(false);this.changed(owner);});
    c.setWindowOpenHandler(details=>{
      if(this.closed||entry.retired||this.context(owner).ui.tabs.length>=100)return {action:'deny'};
      try{browserUrl(details.url);}catch{if(details.url!=='about:blank')return {action:'deny'};}
      return {action:'allow',overrideBrowserWindowOptions:{webPreferences:{session:ses,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,preload:undefined}},createWindow:options=>{
        const next=details.url==='about:blank'?{id:randomUUID(),kind:'browser' as const,url:'about:blank',title:'新网页'}:newBrowserTab(details.url);
        const ctx=this.context(owner);this.save(owner,{...ctx.ui,tabs:[...ctx.ui.tabs,next],active:details.disposition==='background-tab'?ctx.ui.active:next.id});
        // Adopt Electron's popup WebContents to retain window.opener; force guest isolation.
        const child=this.attach(owner,next,(options as Electron.BrowserWindowConstructorOptions&{webContents?:WebContents}).webContents);
        if(details.disposition==='background-tab')void child.view.webContents.loadURL(next.url!).catch(()=>{});
        this.changed(owner);return child.view.webContents;
      }};
    });
    return entry;
  }
  private ensure(owner:string,id:string){if(this.closed)throw new Error('浏览器已退出');const key=this.key(owner,id),existing=this.entries.get(key);if(existing)return existing;const tab=this.context(owner).ui.tabs.find(t=>t.id===id&&t.kind==='browser');if(!tab)throw new Error('网页标签不存在');const entry=this.attach(owner,tab);void entry.view.webContents.loadURL(tab.url!).catch(()=>{});return entry;}
  reconcile(owner:string,ui:SessionViewState,reload=false){for(const entry of [...this.entries.values()])if(entry.owner===owner&&(reload||!ui.tabs.some(t=>t.id===entry.tabId&&t.kind==='browser')))this.retire(entry);}
  private retire(entry:Entry){this.entries.delete(this.key(entry.owner,entry.tabId));entry.retired=true;entry.view.setVisible(false);this.window.contentView.removeChildView(entry.view);if(entry.downloads.size)this.retired.add(entry);else if(!entry.view.webContents.isDestroyed())entry.view.webContents.close();}
  present(owner:string,id:string,bounds?:Rectangle){
    const key=this.key(owner,id);if(!bounds){if(this.presented!==key)return;for(const e of this.entries.values())e.view.setVisible(false);this.overlay?.setVisible(false);this.presented='';return;}
    const changed=this.presented!==key;for(const entry of this.entries.values())if(this.key(entry.owner,entry.tabId)!==key)entry.view.setVisible(false);
    if(this.overlayOwner!==owner)this.overlay?.setVisible(false);const entry=this.ensure(owner,id);entry.view.setBounds(this.clamp(bounds));entry.view.setVisible(!entry.error);
    if(changed){this.presented=key;this.window.contentView.addChildView(entry.view);if(this.overlay&&this.overlayOwner===owner)this.window.contentView.addChildView(this.overlay);entry.view.webContents.focus();}
  }
  hide(){for(const entry of this.entries.values())entry.view.setVisible(false);this.overlay?.setVisible(false);this.presented='';}
  private clamp(bounds:Rectangle){const zoom=this.window.webContents.getZoomFactor(),[w,h]=this.window.getContentSize();bounds={x:bounds.x*zoom,y:bounds.y*zoom,width:bounds.width*zoom,height:bounds.height*zoom};const x=Math.max(0,Math.min(w,Math.round(Number(bounds.x)||0))),y=Math.max(0,Math.min(h,Math.round(Number(bounds.y)||0)));return {x,y,width:Math.max(0,Math.min(w-x,Math.round(Number(bounds.width)||0))),height:Math.max(0,Math.min(h-y,Math.round(Number(bounds.height)||0)))};}
  navigate(owner:string,id:string,url:string){const entry=this.ensure(owner,id);entry.error=undefined;return entry.view.webContents.loadURL(browserUrl(url));}
  action(owner:string,id:string,action:string){const entry=this.ensure(owner,id),c=entry.view.webContents;if(action==='back'){if(c.navigationHistory.canGoBack())c.navigationHistory.goBack();}else if(action==='forward'){if(c.navigationHistory.canGoForward())c.navigationHistory.goForward();}else if(action==='reload'){entry.error=undefined;if(this.presented===this.key(owner,id))entry.view.setVisible(true);c.reload();}else throw new Error('浏览器操作无效');}
  syncComposer(owner:string,snapshot:Record<string,unknown>,bounds?:Rectangle){
    if(!bounds){this.overlay?.setVisible(false);return;}
    snapshot={...snapshot,revision:++this.composerRevision};
    if(!this.overlay){
      const view=new WebContentsView({webPreferences:{preload:join(this.root,'apps/desktop/dist/composer-preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true}});this.overlay=view;view.setBackgroundColor('#00000000');this.window.contentView.addChildView(view);view.setVisible(false);
      view.webContents.on('will-navigate',event=>event.preventDefault());view.webContents.setWindowOpenHandler(()=>({action:'deny'}));this.security(view);
      void view.webContents.loadFile(join(this.root,'apps/desktop/dist/renderer/index.html'),{query:{surface:'composer'}}).then(()=>{if(!this.closed)view.webContents.send('friend-composer:snapshot',{...this.overlaySnapshot,token:this.overlayToken});}).catch(()=>{});
    }
    const ownerChanged=this.overlayOwner!==owner;
    this.overlaySnapshot=snapshot;if(ownerChanged){this.overlayToken=randomUUID();}this.overlayOwner=owner;this.overlay.setBounds(this.clamp(bounds));this.overlay.setVisible(true);
    if(ownerChanged&&this.entries.get(this.presented)?.owner===owner)this.window.contentView.addChildView(this.overlay);
    this.overlay.webContents.setZoomFactor(this.window.webContents.getZoomFactor());this.overlay.webContents.send('friend-composer:snapshot',{...snapshot,token:this.overlayToken});
  }
  readyOverlay(){return {...this.overlaySnapshot,token:this.overlayToken};}
  acceptsOverlay(event:Electron.IpcMainInvokeEvent){return !!this.overlay&&event.sender===this.overlay.webContents&&event.senderFrame===this.overlay.webContents.mainFrame;}
  overlayAction(raw:Record<string,unknown>){if(!['draft','send','attach','removeAttachment','plan','permission','mode','model','settings','stop','conversation','collapse'].includes(String(raw.type)))throw new Error('输入框操作无效');if(raw.token!==this.overlayToken||raw.sessionId!==this.overlayOwner)throw new Error('输入框所属会话已变更');this.emit('composer.action',raw,this.overlayOwner);}
  private watchDownloads(ses:Session){
    if(this.sessions.has(ses))return;
    ses.setPermissionRequestHandler((_c,_p,callback)=>callback(false));ses.setPermissionCheckHandler(()=>false);
    const listener=(_event:Electron.Event,item:DownloadItem,source:WebContents)=>{
      const entry=[...this.entries.values()].find(e=>e.view.webContents===source);if(!entry){item.cancel();return;}
      const record:Download={id:randomUUID(),owner:entry.owner,tabId:entry.tabId,name:basename(item.getFilename()),received:0,total:item.getTotalBytes(),state:'progressing',item};this.downloads.set(record.id,record);entry.downloads.add(record.id);item.setSaveDialogOptions({title:'保存下载文件',defaultPath:record.name});
      const update=()=>{record.received=item.getReceivedBytes();record.total=item.getTotalBytes();this.changed(entry.owner);};
      item.on('updated',(_event,state)=>{record.state=state;update();});
      item.once('done',(_event,state)=>{record.state=state;record.path=item.getSavePath();record.item=undefined;entry.downloads.delete(record.id);update();if(entry.retired&&!entry.downloads.size){this.retired.delete(entry);if(!entry.view.webContents.isDestroyed())entry.view.webContents.close();}});
      this.changed(entry.owner);

    };
    this.sessions.set(ses,listener);ses.on('will-download',listener);
  }
  cancelDownload(owner:string,id:string){const record=this.downloads.get(id);if(!record||record.owner!==owner)throw new Error('下载不存在');record.item?.cancel();}
  removeSession(owner:string){for(const entry of [...this.entries.values()])if(entry.owner===owner)this.retire(entry);if(this.overlayOwner===owner)this.overlay?.setVisible(false);}
  destroy(){if(this.closed)return;this.closed=true;for(const [ses,listener] of this.sessions)ses.removeListener('will-download',listener);for(const d of this.downloads.values())d.item?.cancel();for(const e of [...this.entries.values(),...this.retired])if(!e.view.webContents.isDestroyed())e.view.webContents.close();if(this.overlay&&!this.overlay.webContents.isDestroyed())this.overlay.webContents.close();this.entries.clear();this.retired.clear();}
}
