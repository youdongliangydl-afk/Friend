import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const at = '2026-10-26T10:00:00.000Z';
const entry = (id: string, title: string, content?: string) => ({ id, revision: 1, title, ...(content ? { content } : {}) });
const receipts = [
  { id: 'r1:prepared', customType: 'friend-pi.memory.usage', data: { runId: 'r1', stage: 'prepared', operationId: 'o1', at, directory: [entry('m2', '目录项')], records: [entry('m1', '已注入项', '完整正文第一句。完整正文第二句。')] } },
  { id: 'r1:injected', customType: 'friend-pi.memory.usage', data: { runId: 'r1', stage: 'injected-to-context', operationId: 'o1', at, records: [entry('m1', '已注入项', '完整正文第一句。完整正文第二句。')] } },
  { id: 'r1:request', customType: 'friend-pi.memory.usage', data: { runId: 'r1', stage: 'request-prepared', operationId: 'o1', at, records: [entry('m1', '已注入项')], omitted: [{ id: 'm3', reason: 'record-limit', readRef: { revision: 1 } }] } },
];

test('the run panel summarizes the current turn and keeps rows collapsed', async () => {
  const compiled = await build({ entryPoints: [fileURLToPath(new URL('../apps/desktop/src/renderer/memory-run-panel.tsx', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom', 'react/jsx-runtime'], loader: { '.css': 'empty' } });
  const module = { exports: {} as { MemoryRunPanel: ComponentType<Record<string, unknown>> } };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  const markup = renderToStaticMarkup(createElement(module.exports.MemoryRunPanel, {
    sessionId: 's1',
    receipts,
    runId: 'r1',
    onSettings() {},
    report() {},
  }));
  for (const text of ['本轮记忆', '当前轮次', '注入', '目录', '未用', '已注入项', '目录项', 'm3', '完整回执']) assert.ok(markup.includes(text), text);
  assert.match(markup, /memory-run-tag is-injected/u);
  assert.match(markup, /memory-run-tag is-catalog/u);
  assert.match(markup, /memory-run-tag is-unused/u);
  assert.doesNotMatch(markup, /memory-run-body/u);
});
