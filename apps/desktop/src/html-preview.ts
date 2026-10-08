import { randomUUID } from 'node:crypto';
import { dirname, extname, join, relative } from 'node:path';
import { readFileSync, realpathSync } from 'node:fs';
import { projectFile } from './workspace-files.js';
const grants = new Map<string, { root: string; path: string; content?: string }>();
export function grantHtmlPreview(root: string, path: string, content?: string) {
  root=realpathSync(root);
  const actual = projectFile(root, path);
  if (!/\.html?$/i.test(actual)) throw new Error('请选择 HTML 文件');
  const token = randomUUID(); grants.set(token, { root, path: relative(root, actual), content });
  return { token, url: 'friend-preview://' + token + '/' + relative(root, actual).split('/').map(encodeURIComponent).join('/') };
}
export function revokeHtmlPreview(token: string) { grants.delete(token); }
export function htmlPreviewResponse(url: string) {
  try {
    const parsed = new URL(url), grant = grants.get(parsed.hostname);
    if (!grant) return new Response('预览授权已失效', { status: 403 });
    const path = decodeURIComponent(parsed.pathname).replace(/^\/+/, ''), actual = projectFile(grant.root, path);
    const isDocument = path === grant.path;
    const extension = extname(actual).toLowerCase();
    const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2' };
    if (!mime[extension]) return new Response('该资源类型不可预览', { status: 403 });
    const body = isDocument && grant.content !== undefined ? Buffer.from(grant.content) : readFileSync(actual);
    const headers: Record<string, string> = { 'Content-Type': mime[extension], 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    headers['Content-Security-Policy'] = "default-src 'none'; script-src 'unsafe-inline' friend-preview:; style-src 'unsafe-inline' friend-preview:; img-src data: friend-preview:; font-src friend-preview:; connect-src friend-preview:; form-action 'none'; frame-src 'none'; base-uri 'none'";
    return new Response(body, { headers });
  } catch { return new Response('文件不在预览工作区内或已不可用', { status: 403 }); }
}
