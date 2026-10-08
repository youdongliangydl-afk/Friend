import { useEffect, useRef, useState } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, StateEffect } from '@codemirror/state';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { markdown } from '@codemirror/lang-markdown';
import type { WorkspaceRef, JsonObject } from './types.js';
import { asList, asObject } from './types.js';
import { Markdown, Empty, Modal } from './ui.js';
import type { Material } from './Workbench.js';

interface Entry { path: string; name: string; kind: string }
interface Document extends JsonObject { path: string; content: string; original: string; hash: string; editable: boolean; kind: string; state?: EditorState; changedOutside?: boolean }
export interface FileWorkspaceState { directories: Map<string, Entry[]>; expanded: Set<string>; documents: Document[]; selected: string; preview: boolean; next: Map<string, number>; consumedMaterial?:Material }
export type FileWorkspaceCache = Map<string, FileWorkspaceState>;
function language(path: string) {
  if (/\.[cm]?[jt]sx?$/.test(path)) return javascript({ typescript: /\.tsx?$/.test(path), jsx: /[jt]sx$/.test(path) });
  if (/\.json$/.test(path)) return json();
  if (/\.css$/.test(path)) return css();
  if (/\.html?$/.test(path)) return html();
  if (/\.md$/.test(path)) return markdown();
  return [];
}
function CodeEditor({ doc, onChange, onSave, line }: { doc: Document; onChange(): void; onSave(): void; line?: number }) {
  const host = useRef<HTMLDivElement>(null),editor=useRef<EditorView|undefined>(undefined), callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  useEffect(() => {
    if (!host.current) return;
    const extensions = [basicSetup, language(doc.path), EditorState.lineSeparator.of(doc.content.includes('\r\n') ? '\r\n' : '\n'),
      EditorView.updateListener.of(update => { if (update.docChanged) { doc.content = update.state.sliceDoc(); doc.state = update.state; callbacks.current.onChange(); } }),
      EditorView.theme({ '&': { height: '100%', fontSize: '13px' }, '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' } })];
    const view = new EditorView({ state: doc.state ? doc.state.update({effects:StateEffect.reconfigure.of(extensions)}).state : EditorState.create({ doc: doc.content, extensions }), parent: host.current });
    editor.current=view;
    const keys = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopPropagation(); callbacks.current.onSave(); } };
    host.current.addEventListener('keydown', keys);
    if (line) { const target = view.state.doc.line(Math.min(line, view.state.doc.lines)); view.dispatch({ effects: EditorView.scrollIntoView(target.from, { y: 'center' }), selection: { anchor: target.from } }); }
    return () => { doc.state = view.state; host.current?.removeEventListener('keydown', keys); view.destroy();editor.current=undefined; };
  }, [doc]);
  useEffect(()=>{const view=editor.current;if(view&&line){const target=view.state.doc.line(Math.max(1,Math.min(line,view.state.doc.lines)));view.dispatch({effects:EditorView.scrollIntoView(target.from,{y:'center'}),selection:{anchor:target.from}});}},[line,doc]);
  return <div className="code-editor" ref={host} aria-label={'编辑文件 ' + doc.path}/>;
}
function HtmlPreview({ doc, workspace, report }: { doc: Document; workspace: WorkspaceRef; report(message: string, error?: boolean): void }) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    let active = true, token = '';
    void window.friendPi.request<JsonObject>('file.preview', { workspace, path: doc.path, content: doc.content }).then(result => {
      token = String(result.token);
      if (active) setUrl(String(result.url)); else void window.friendPi.request('file.preview.revoke', { token }).catch(() => {});
    }).catch(error => report(String(error), true));
    return () => { active = false; if (token) void window.friendPi.request('file.preview.revoke', { token }).catch(() => {}); };
  }, [doc.path, doc.content, JSON.stringify(workspace)]);
  return url ? <iframe className="html-preview" title={'网页预览 ' + doc.path} src={url} sandbox="allow-scripts"/> : <Empty title="正在准备网页预览…"/>;
}
export function FileWorkspace({ workspace, workspaceKey, cache, material, report }: {
  workspace: WorkspaceRef; workspaceKey: string; cache: FileWorkspaceCache; material?: Material; report(message: string, error?: boolean): void;
}) {
  if (!cache.has(workspaceKey)) cache.set(workspaceKey, { directories: new Map(), expanded: new Set(['']), documents: [], selected: '', preview: false, next: new Map() });
  const state = cache.get(workspaceKey)!;
  const [, redraw] = useState(0), [query, setQuery] = useState(''),[location,setLocation]=useState<{path:string;line?:number}>(), [saving, setSaving] = useState(false);
  const [search,setSearch]=useState<Entry[]>([]),[searchTruncated,setSearchTruncated]=useState(false);
  useEffect(()=>{let active=true;const timer=setTimeout(()=>{if(query.trim())void window.friendPi.request('file.search',{workspace,query}).then(raw=>{if(active){const result=asObject(raw);setSearch(asList<Entry>(result.entries));setSearchTruncated(result.truncated===true);}}).catch(error=>report(String(error),true));else setSearch([]);},160);return()=>{active=false;clearTimeout(timer);};},[query,workspaceKey]);
  const [closeDoc, setCloseDoc] = useState<Document | null>(null), [conflict, setConflict] = useState<{ doc: Document; hash: string; content: string } | null>(null);
  const owner = useRef(workspaceKey),mounted=useRef(true),saveLock=useRef(false),saveEpoch=useRef(0),loadEpoch=useRef(0),closeIntent=useRef<Document|null>(null); owner.current = workspaceKey;closeIntent.current=closeDoc;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const update = () => {if(mounted.current)redraw(n => n + 1);};
  const loadDirectory = async (path: string, offset = 0) => {
    try {
      const result = asObject(await window.friendPi.request('file.tree', { workspace, directory: path, offset }));
      state.directories.set(path, offset ? [...(state.directories.get(path) || []), ...asList<Entry>(result.entries)] : asList<Entry>(result.entries));
      if (typeof result.nextOffset === 'number') state.next.set(path, result.nextOffset); else state.next.delete(path);
      if (owner.current === workspaceKey) update();
    } catch (error) { if (owner.current === workspaceKey) report(String(error), true); }
  };
  const load = async (path: string,line?:number) => {const intent=++loadEpoch.current;
    const existing = state.documents.find(d => d.path === path||(d.aliases as string[]|undefined)?.includes(path));
    if (existing) { state.selected = existing.path;setLocation({path:existing.path,line}); update(); return; }
    try {
      const result = asObject(await window.friendPi.request('file.read', { workspace, path, edit: true }));
      const canonical=String(result.path||path);const duplicate=state.documents.find(d=>d.path===canonical);if(duplicate){duplicate.aliases=[...new Set([...(duplicate.aliases as string[]||[]),path])];if(intent===loadEpoch.current){state.selected=canonical;setLocation({path:canonical,line});update();}return;}
      const doc = { ...result, path:canonical,aliases:[path], content: String(result.content || ''), original: String(result.content || ''), hash: String(result.hash || ''), editable: result.editable === true, kind: String(result.kind) } as Document;
      if (!state.documents.some(d => d.path === path)) state.documents.push(doc);
      if(intent===loadEpoch.current){state.selected = canonical;setLocation({path:canonical,line});}
      if (owner.current === workspaceKey) update();
    } catch (error) { if (owner.current === workspaceKey) report(String(error), true); }
  };
  useEffect(() => { if (!state.directories.has('')) void loadDirectory(''); update(); }, [workspaceKey]);
  useEffect(() => {
    if (material?.workspaceKey && material.workspaceKey !== workspaceKey) return;
    if(!material||state.consumedMaterial===material)return;state.consumedMaterial=material;
    if (material?.path) void load(material.path,material.line);
    else if (material?.text !== undefined) {
      const path = 'virtual://'+ (material.title || '材料'), prior = state.documents.findIndex(d => d.path === path);
      const doc = { path, content: material.text, original: material.text, hash: '', editable: false, kind: 'markdown', virtual: true } as Document;
      if (prior >= 0) state.documents[prior] = doc; else state.documents.push(doc);
      state.selected = path; state.preview = true; update();
    }
  }, [material, workspaceKey]);
  const selected = state.documents.find(doc => doc.path === state.selected);
  const save = async (doc: Document, expectedHash = doc.hash) => {
    if (!doc.editable || saveLock.current) return false;
    saveLock.current=true;saveEpoch.current++;setSaving(true);
    const submittedContent = doc.content;
    try {
      const result = asObject(await window.friendPi.request('file.write', { workspace, path: doc.path, content: submittedContent, expectedHash }));
      if (result.conflict) { if(mounted.current)setConflict({ doc, hash: String(result.currentHash), content: String(result.currentContent) }); return false; }
      doc.hash = String(result.hash); doc.original = submittedContent; doc.changedOutside = false;
      update(); return true;
    } catch (error) { if(mounted.current)report(String(error), true); return false; }
    finally { saveLock.current=false;saveEpoch.current++;if(mounted.current)setSaving(false); }
  };
  const remove = (doc: Document) => {
    state.documents = state.documents.filter(item => item !== doc);
    if (state.selected === doc.path) state.selected = state.documents.at(-1)?.path || '';
    setCloseDoc(null); update();
  };
  const reload = (doc: Document, content: string, hash: string) => {
    const replacement = { ...doc, content, original: content, hash, state: undefined, changedOutside: false };
    state.documents = state.documents.map(item => item === doc ? replacement : item); setConflict(null);setCloseDoc(null); update();
  };
  useEffect(() => {
    if (!selected?.editable) return;
    let active = true, busy = false;
    const check = async () => {
      if (busy||saveLock.current) return; busy = true;const hash=selected.hash,epoch=saveEpoch.current;
      try {
        const latest = asObject(await window.friendPi.request('file.read', { workspace, path: selected.path, edit: true }));
        if (!active||hash!==selected.hash||epoch!==saveEpoch.current||saveLock.current || latest.hash === selected.hash || !latest.editable) return;
        if (selected.content !== selected.original) { selected.changedOutside = true; update(); }
        else reload(selected, String(latest.content), String(latest.hash));
      } catch { /* Save reports missing/permission errors without discarding the draft. */ }
      finally { busy = false; }
    };
    const timer = setInterval(() => void check(), 3000);
    window.addEventListener('focus', check);
    return () => { active = false; clearInterval(timer); window.removeEventListener('focus', check); };
  }, [selected, workspaceKey]);
  const tree = (directory: string, depth = 0): React.ReactNode => (state.directories.get(directory) || []).filter(entry => !query || entry.kind === 'directory' || entry.path.toLowerCase().includes(query.toLowerCase())).map(entry =>
    <div key={entry.path}><button className={'tree-entry ' + (state.selected === entry.path ? 'selected' : '')} style={{ paddingLeft: 10 + depth * 14 }} title={entry.path}
      aria-expanded={entry.kind === 'directory' ? state.expanded.has(entry.path) : undefined}
      onClick={() => { if (entry.kind === 'directory') { if (state.expanded.has(entry.path)) state.expanded.delete(entry.path); else { state.expanded.add(entry.path); if (!state.directories.has(entry.path)) void loadDirectory(entry.path); } update(); } else void load(entry.path); }}>
      <span>{entry.kind === 'directory' ? state.expanded.has(entry.path) ? '▾' : '▸' : '·'}</span>{entry.name}
    </button>{entry.kind === 'directory' && state.expanded.has(entry.path) && <>{tree(entry.path, depth + 1)}{state.next.has(entry.path) && <button onClick={() => void loadDirectory(entry.path, state.next.get(entry.path))}>更多文件…</button>}</>}</div>);
  return <div className="editable-workspace">
    <div className="file-workspace-toolbar"><input aria-label="查找项目文件" placeholder="查找项目文件…" value={query} onChange={event => setQuery(event.target.value)}/><button aria-label="刷新目录" onClick={() => { state.directories.clear();state.expanded=new Set(['']);state.next.clear(); void loadDirectory(''); }}>↻</button></div>
    <div className="file-workspace-body"><details className="directory-browser" open><summary>项目文件</summary><div className="directory-scroll">{query.trim()?<>{search.map(entry=><button key={entry.path} className="tree-entry" onClick={()=>void load(entry.path)}>{entry.path}</button>)}{searchTruncated&&<p>搜索已达 2000 项上限，请展开目录定位。</p>}</>:tree('')}{!query.trim()&&state.next.has('') && <button onClick={() => void loadDirectory('', state.next.get(''))}>更多文件…</button>}</div></details>
    <div className="file-document"><div className="material-tabs" role="tablist">{state.documents.map(doc => <div className="editor-tab" key={doc.path}>
      <button role="tab" aria-selected={state.selected === doc.path} title={doc.path} onClick={() => { state.selected = doc.path; update(); }}>{doc.path.split('/').at(-1)}{doc.content !== doc.original ? ' ●' : ''}</button>
      <button aria-label={'关闭文件 ' + doc.path} onClick={() => doc.content !== doc.original ? setCloseDoc(doc) : remove(doc)}>×</button></div>)}</div>
      {selected ? <><div className="file-caption">{selected.path}</div><div className="editor-actions">
        {selected.editable && <button disabled={saving || selected.content === selected.original} onClick={() => void save(selected)}>{saving ? '保存中…' : '保存 ⌘S'}</button>}
        {['markdown', 'image'].includes(selected.kind) || /\.html?$/.test(selected.path) ? <button aria-pressed={state.preview} onClick={() => { state.preview = !state.preview; update(); }}>{state.preview ? '源码' : '预览'}</button> : null}
        {!selected.virtual && <button onClick={() => void window.friendPi.request('file.open', { workspace, path: selected.path }).catch(error => report(String(error), true))}>系统打开</button>}
      </div>{selected.changedOutside && <div className="notice">文件已在外部修改，保存前会核对版本。</div>}
        <div className="document-surface">{selected.kind === 'image' ? <img src={String(selected.dataUrl)} alt={selected.path}/> :
          state.preview && /\.html?$/.test(selected.path) ? <HtmlPreview doc={selected} workspace={workspace} report={report}/> :
          (state.preview || !selected.editable) && selected.kind === 'markdown' ? <Markdown text={selected.content} basePath={selected.virtual?undefined:selected.path} workspace={workspace}/> :
          selected.editable ? <CodeEditor doc={selected} onChange={update} onSave={() => void save(selected)} line={location?.path===selected.path?location.line:undefined}/> :
          selected.content ? <pre>{selected.content}</pre> : <Empty title={String(selected.reason || '此格式请使用系统应用打开')}/>}</div>
        {typeof selected.nextOffset==='number'&&<button onClick={()=>void window.friendPi.request('file.read',{workspace,path:selected.path,offset:selected.nextOffset}).then(raw=>{const result=asObject(raw);selected.content+=String(result.content||'');selected.original=selected.content;selected.nextOffset=result.nextOffset;update();}).catch(error=>report(String(error),true))}>读取下一段</button>}
        <button className="add-file-context" onClick={() => window.dispatchEvent(new CustomEvent('friend-pi:add-material', { detail: { text: selected.virtual ? selected.content : '参考文件：' + selected.path } }))}>添加到输入框</button>
      </> : <Empty title="选择文件开始编辑或预览"/>}
    </div></div>
    {closeDoc && <Modal title="文件尚未保存" onClose={() => setCloseDoc(null)}><p>{closeDoc.path}</p><div className="button-row"><button onClick={() => setCloseDoc(null)}>取消</button><button onClick={() => remove(closeDoc)}>放弃修改并关闭</button><button className="primary" disabled={saving} onClick={() => void save(closeDoc).then(saved => { if (saved&&mounted.current&&closeIntent.current===closeDoc&&closeDoc.content===closeDoc.original) remove(closeDoc); })}>保存并关闭</button></div></Modal>}
    {conflict && <Modal title="文件已在外部修改" wide onClose={() => setConflict(null)}><p>选择重新载入外部版本，或确认用当前编辑内容覆盖。再次发生外部修改时仍会重新核对。</p><div className="conflict-preview"><pre>{conflict.content.slice(0,12000)}</pre></div><div className="button-row"><button onClick={() => setConflict(null)}>取消</button><button onClick={() => reload(conflict.doc, conflict.content, conflict.hash)}>重新载入外部版本</button><button className="primary" onClick={() => void save(conflict.doc, conflict.hash).then(saved => { if (saved&&mounted.current){setConflict(null);if(closeIntent.current===conflict.doc&&conflict.doc.content===conflict.doc.original)remove(conflict.doc);} })}>确认覆盖此版本</button></div></Modal>}
  </div>;
}
