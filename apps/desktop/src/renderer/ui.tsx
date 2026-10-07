import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { statusLabels } from './types.js';

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

function Inline({ text }: { text: string }) {
  const parts = text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g);
  return <>{parts.map((part, i) => part.startsWith('`') && part.endsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part)}</>;
}
/** Render a small safe Markdown subset. Model/user content never becomes HTML. */
export function Markdown({ text }: { text: string }) {
  const blocks = text.split(/(```[\s\S]*?(?:```|$))/g);
  return <div className="markdown">{blocks.map((block, index) => {
    if (block.startsWith('```')) { const newline = block.indexOf('\n'); return <pre key={index}><code>{block.slice(newline < 0 ? 3 : newline + 1).replace(/```$/, '')}</code></pre>; }
    return <div key={index}>{block.split(/\n\s*\n/).filter(Boolean).map((paragraph, i) => {
      const heading = /^(#{1,4})\s+(.+)$/.exec(paragraph);
      if (heading) return <h3 key={i}><Inline text={heading[2]} /></h3>;
      const lines = paragraph.split('\n');
      if (lines.every(line => /^\s*[-*]\s+/.test(line))) return <ul key={i}>{lines.map((line, j) => <li key={j}><Inline text={line.replace(/^\s*[-*]\s+/, '')} /></li>)}</ul>;
      return <p key={i}><Inline text={paragraph} /></p>;
    })}</div>;
  })}</div>;
}

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
      const controls = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]') || [])];
      const first = controls[0]; const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  }}><div className="modal-heading"><h2 id={titleId}>{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭弹窗">×</button></div>{children}</section></div>, document.body);
}
