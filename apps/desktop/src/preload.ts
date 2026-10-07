import { contextBridge,ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('friendPi',{
  request:(method:string,input:unknown={})=>ipcRenderer.invoke('friend-pi:request',method,input),
  onEvent:(handler:(event:unknown)=>void)=>{const listener=(_event:Electron.IpcRendererEvent,value:unknown)=>handler(value);ipcRenderer.on('friend-pi:event',listener);return ()=>ipcRenderer.removeListener('friend-pi:event',listener);},
});
