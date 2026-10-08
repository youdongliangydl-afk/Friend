import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { statusLabels } from './types.js';
import {materialPath} from './material-links.js';
import type {WorkspaceRef} from './types.js';
import type {Message} from './types.js';

export function Badge({ value }: { value: string }) { return <span className={`badge badge-${value}`}>{statusLabels[value] || value}</span>; }
export function Empty({ title, children }: { title: string; children?: ReactNode }) { return <div className="empty small"><div className="empty-mark">·</div><strong>{title}</strong>{children && <p>{children}</p>}</div>; }
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
export function Card({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) { return <section className="card"><div className="card-heading"><h3>{title}</h3>{actions}</div>{children}</section>; }
export function JsonView({ value }: { value: unknown }) { return <pre className="code-view">{typeof value === 'string' ? value : JSON.stringify(value, null, 2)}</pre>; }

export function TextDiff({ before, after }: { before: string; after: string }) {
  if (before === after) return <p className="hint">内容相同。</p>;
  const previous = before.split('\n'); const current = after.split('\n');
  const lines: { value: string; type: string }[] = [];
  if (previous.length > 500 || current.length > 500) {
    previous.forEach(value => lines.push({ value, type: 'diff-remove' }));
    current.forEach(value => lines.push({ value, type: 'diff-add' }));
  } else {
    const scores = Array.from({ length: previous.length + 1 }, () => new Uint16Array(current.length + 1));
    for (let i = previous.length - 1; i >= 0; i--) for (let j = current.length - 1; j >= 0; j--) scores[i][j] = previous[i] === current[j] ? scores[i + 1][j + 1] + 1 : Math.max(scores[i + 1][j], scores[i][j + 1]);
    let i = 0; let j = 0;
    while (i < previous.length || j < current.length) {
      if (i < previous.length && j < current.length && previous[i] === current[j]) { lines.push({ value: previous[i++], type: '' }); j++; }
      else if (j < current.length && (i === previous.length || scores[i][j + 1] >= scores[i + 1][j])) lines.push({ value: current[j++], type: 'diff-add' });
      else lines.push({ value: previous[i++], type: 'diff-remove' });
    }
  }
  return <pre className="diff-view">{lines.map((line, i) => <span key={i} className={line.type}>{line.type === 'diff-add' ? '+ ' : line.type === 'diff-remove' ? '- ' : '  '}{line.value}{'\n'}</span>)}</pre>;
}

function LocalImage({url,alt,basePath,workspace}:{url:string;alt:string;basePath?:string;workspace?:WorkspaceRef}){
  const [src,setSrc]=useState('');const target=materialPath(url,basePath);
  useEffect(()=>{let active=true;setSrc('');if(workspace&&target)void window.friendPi.request<{dataUrl?:string}>('file.read',{workspace,path:target.path}).then(result=>{if(active)setSrc(result.dataUrl||'');}).catch(()=>{});return()=>{active=false;};},[url,basePath,JSON.stringify(workspace)]);
  return src?<img src={src} alt={alt}/>:<span>{alt}（图片不可用）</span>;
}
function Inline({ text,basePath,workspace }: { text: string;basePath?:string;workspace?:WorkspaceRef }) {
  const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|!?\[[^\]\n]*\]\([^\s)]+\))/g);
  return <>{parts.map((part, i) => {const link=/^(!?)\[([^\]]*)\]\(([^)]+)\)$/.exec(part);if(link){const url=link[3];if(link[1])return <LocalImage key={i} url={url} alt={link[2]} basePath={basePath} workspace={workspace}/>;return <a key={i} href={/^https?:\/\//i.test(url)?url:'#'} onClick={event=>{event.preventDefault();if(/^https?:\/\//i.test(url))void window.friendPi.request('link.open',{url});else {const target=materialPath(url,basePath);if(target)window.dispatchEvent(new CustomEvent('friend-pi:file-open',{detail:target}));}}}>{link[2]}</a>;}return part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part;})}</>;
}
/** Render a small safe Markdown subset. Model/user content never becomes HTML. */
export function Markdown({ text,basePath,workspace }: { text: string;basePath?:string;workspace?:WorkspaceRef }) {
  const blocks = text.split(/(```[\s\S]*?(?:```|$))/g);
  return <div className="markdown">{blocks.map((block, index) => {
    if (block.startsWith('```')) { const newline = block.indexOf('\n'); return <pre key={index}><code>{block.slice(newline < 0 ? 3 : newline + 1).replace(/```$/, '')}</code></pre>; }
    return <div key={index}>{block.split(/\n\s*\n/).filter(Boolean).map((paragraph, i) => {
      const heading = /^(#{1,6})\s+([^\n]+)(?:\n([\s\S]*))?$/.exec(paragraph);
      if (heading) return <div key={i}><h3><Inline basePath={basePath} workspace={workspace} text={heading[2]} /></h3>{heading[3]&&<Markdown basePath={basePath} workspace={workspace} text={heading[3]}/>}</div>;
      const lines = paragraph.split('\n');if(lines.every(line=>/^>\s?/.test(line)))return <blockquote key={i}><Markdown basePath={basePath} workspace={workspace} text={lines.map(line=>line.replace(/^>\s?/, '')).join('\n')}/></blockquote>;
      if(lines.length>=2&&/^\s*\|?\s*:?-{3}/.test(lines[1])){const cells=(line:string)=>line.trim().replace(/^\||\|$/g,'').split('|').map(x=>x.trim());return <div className="table-scroll" key={i}><table><thead><tr>{cells(lines[0]).map((cell,j)=><th key={j}><Inline basePath={basePath} workspace={workspace} text={cell}/></th>)}</tr></thead><tbody>{lines.slice(2).map((line,j)=><tr key={j}>{cells(line).map((cell,k)=><td key={k}><Inline basePath={basePath} workspace={workspace} text={cell}/></td>)}</tr>)}</tbody></table></div>;}
      if(lines.every(line=>/^\s*\d+[.)]\s+/.test(line)))return <ol key={i}>{lines.map((line,j)=><li key={j}><Inline basePath={basePath} workspace={workspace} text={line.replace(/^\s*\d+[.)]\s+/,'')}/></li>)}</ol>;
      if (lines.every(line => /^\s*[-*]\s+/.test(line))) return <ul key={i}>{lines.map((line, j) => <li key={j}><Inline basePath={basePath} workspace={workspace} text={line.replace(/^\s*[-*]\s+/, '')} /></li>)}</ul>;
      return <p key={i}><Inline basePath={basePath} workspace={workspace} text={paragraph} /></p>;
    })}</div>;
  })}</div>;
}
export function RichMessage({message}:{message:Message}){return <>{message.role==='user'?<p className="user-original">{message.userText??message.text}</p>:<Markdown text={message.text}/>} {(message.parts||[]).map((part,index)=>part.type==='thinking'?<details className="thinking-block" key={index}><summary>思考过程</summary><pre>{String(part.thinking||'')}</pre></details>:part.type==='toolCall'?<details className="history-tool" key={index}><summary>{String(part.name)} · {String(part.id)}</summary><JsonView value={part.arguments}/></details>:part.type==='image'&&/^image\/(png|jpeg|gif|webp)$/.test(String(part.mimeType))?<img className="message-image" key={index} src={`data:${part.mimeType};base64,${part.data}`} alt="原始消息附件"/>:null)}</>;}

export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const element = ref.current;
    (element?.querySelector<HTMLElement>('input, textarea, select') || element?.querySelector<HTMLElement>('button'))?.focus();
    return () => previous?.focus();
  }, []);
  return createPortal(<div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}><section ref={ref} className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    if (event.key === 'Tab') {
      const controls = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]') || [])].filter(control=>control.getClientRects().length>0);
      const first = controls[0]; const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}><div className="modal-heading"><h2 id={titleId}>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭弹窗">×</button></div>{children}</section></div>, document.body);
}
