import { useState } from 'react';
import type { RunChangesSummary } from '../run-changes.js';

export function ChangedFiles({ summary }: { summary: RunChangesSummary }) {
  const [expanded, setExpanded] = useState(false);
  const additions = summary.files.reduce((n, file) => n + (file.additions || 0), 0);
  const deletions = summary.files.reduce((n, file) => n + (file.deletions || 0), 0);
  return <section className="run-changes" aria-label="本轮改动文件">
    <header><div><strong>{summary.unavailable ? '本轮改动统计不可用' : summary.files.length ? `已改动 ${summary.files.length} 个文件` : '本轮没有文件变化'}</strong>
      <small>{summary.status === 'completed' ? '执行结束' : summary.status === 'stopped' ? '已停止，保留已有变化' : '执行未完成，保留已有变化'}</small></div>
      {!summary.unavailable && summary.files.length > 0 && <span className="change-counts"><span className="added">+{additions}</span><span className="removed">−{deletions}</span>{summary.files.some(file => file.error) && <small>部分行数</small>}</span>}</header>
    {summary.unavailable ? <p>{summary.unavailable}</p> : <ul>{(expanded ? summary.files : summary.files.slice(0, 4)).map(file => <li key={file.path}>
      <button className="changed-file-link" title={'打开当前文件：' + file.path} disabled={file.status === 'D'} onClick={() => window.dispatchEvent(new CustomEvent('friend-pi:file-open', { detail: { path: file.path } }))}>{file.path}</button>
      <span>{file.status === 'D' && <small>已删除 · </small>}{file.error ? <small>统计失败</small> : file.binary ? <small>二进制或大文件</small> : <span className="change-counts"><span className="added">+{file.additions || 0}</span><span className="removed">−{file.deletions || 0}</span></span>}</span>
    </li>)}</ul>}
    {summary.files.length > 4 && <button className="show-changed-files" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? '收起文件列表' : `全部 ${summary.files.length} 个文件`}</button>}
    <p className="change-note">{summary.note}</p>
  </section>;
}
