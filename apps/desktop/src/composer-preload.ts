import {contextBridge,ipcRenderer} from 'electron';
contextBridge.exposeInMainWorld('friendComposer',{
  action:(input:unknown)=>ipcRenderer.invoke('friend-composer:action',input),
  onSnapshot:(handler:(snapshot:unknown)=>void)=>{const listener=(_event:Electron.IpcRendererEvent,value:unknown)=>handler(value);ipcRenderer.on('friend-composer:snapshot',listener);void ipcRenderer.invoke('friend-composer:ready').then(value=>{if(value)handler(value);}).catch(()=>{});return ()=>ipcRenderer.removeListener('friend-composer:snapshot',listener);},
});
