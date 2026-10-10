import type {RunChangesSummary} from '../run-changes.js';
export function Deliverables({summary,sessionId,workspacePath}:{summary:RunChangesSummary;sessionId?:string;workspacePath?:string}){
 const files=summary.files.filter(file=>/\.(pdf|docx|pptx|xlsx|csv|tsv|md|html?|png|jpe?g|webp|svg|mp3|mp4)$/i.test(file.path)&&!['D','deleted'].includes(file.status));if(!files.length)return null;
 const owner=sessionId||summary.sessionId;
 return <section className="deliverables-card" aria-label="本轮文件成果"><strong>文件成果</strong><small>来自本轮改动记录 · 预览当前文件</small>{files.map(file=><div key={file.path}><span title={file.path}>{file.path.split('/').at(-1)}</span><button onClick={()=>window.dispatchEvent(new CustomEvent('friend-pi:file-open',{detail:{path:file.path,workspaceKey:workspacePath,sessionId:owner}}))}>查看</button><button onClick={()=>void window.friendPi.request('file.open',{sessionId:owner,path:file.path})}>系统打开</button></div>)}</section>;
}
