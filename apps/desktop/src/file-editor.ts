import { accessSync, chmodSync, constants, lstatSync, openSync, closeSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync, readdirSync, realpathSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, relative, extname } from 'node:path';
import { projectFile, previewFile } from './workspace-files.js';
const EDIT_LIMIT = 2 * 1024 * 1024;
export function contentHash(bytes: Uint8Array | string) { return createHash('sha256').update(bytes).digest('hex'); }
export function listDirectory(root: string, directory = '', offset = 0) {
  const base = realpathSync(root), actual = directory ? projectFile(base, directory) : base;
  if (!lstatSync(actual).isDirectory()) throw new Error('请选择目录');
  const rows = readdirSync(actual, { withFileTypes: true }).filter(entry => !['.git', 'node_modules', '.cache', '.artifacts', '.DS_Store'].includes(entry.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-CN'));
  const start = Math.max(0, Math.floor(offset)), entries = rows.slice(start, start + 500).map(entry => ({
    path: relative(base, join(actual, entry.name)), name: entry.name, kind: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file'
  }));
  return { directory, entries, nextOffset: start + 500 < rows.length ? start + 500 : undefined, total: rows.length };
}
export function readEditorFile(root: string, path: string) {
  const actual = projectFile(root, path), stat = lstatSync(actual);
  if (!stat.isFile()) throw new Error('请选择文件');
  const preview = previewFile(root, path);
  if(['.pdf','.doc','.docx','.xls','.xlsx','.ppt','.pptx','.zip'].includes(extname(actual).toLowerCase()))return {path,kind:'unsupported',editable:false as const,reason:'此格式请使用系统应用打开'};
  if (preview.kind === 'image' || stat.size > EDIT_LIMIT) return { ...preview, editable: false as const };
  const bytes = readFileSync(actual);
  let content: string;
  try { if (bytes.includes(0)) throw new Error(); content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return { ...preview, editable: false as const }; }
  return { ...preview, content, hash: contentHash(bytes), editable: true as const, nextOffset: undefined, truncated: false, startLine: 1 };
}
export function writeEditorFile(root: string, path: string, content: string, expectedHash: string) {
  if (typeof content !== 'string' || Buffer.byteLength(content) > EDIT_LIMIT) throw new Error('编辑内容超过 2 MiB，请使用外部编辑器');
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('文件版本无效，请重新读取');
  const actual = projectFile(root, path), stat = lstatSync(actual);
  if (!stat.isFile()) throw new Error('只允许保存已有普通文件');
  accessSync(actual, constants.W_OK);
  const current = readEditorFile(root, path);
  if (!current.editable) throw new Error('该文件不是可完整编辑的 UTF-8 文本');
  if (current.hash !== expectedHash) return { conflict: true, currentHash: current.hash, currentContent: current.content };
  const temp = join(dirname(actual), '.friend-pi-save-' + randomUUID());
  try {
    writeFileSync(temp, content, { flag: 'wx', mode: stat.mode & 0o777 });
    chmodSync(temp, stat.mode & 0o777);
    const fd = openSync(temp, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
    const next = lstatSync(actual);
    if (projectFile(root, path) !== actual || next.dev !== stat.dev || next.ino !== stat.ino || contentHash(readFileSync(actual)) !== expectedHash)
      return { conflict: true, currentHash: contentHash(readFileSync(actual)), currentContent: readFileSync(actual, 'utf8') };
    renameSync(temp, actual);
    return { saved: true, hash: contentHash(content), path, size: Buffer.byteLength(content) };
  } finally { try { unlinkSync(temp); } catch {} }
}
