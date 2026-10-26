import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { memoryDateText, memoryGist, memoryRelativeTime } from '../apps/desktop/src/renderer/memory-display.js';

type Json = Record<string, unknown>;
const record = (overrides: Json = {}): Json => ({
  id: 'm1',
  revision: 3,
  kind: 'experience',
  kindV2: 'experience',
  scope: 'project',
  status: 'active',
  enabled: true,
  title: '构建与验证命令',
  content: '仓库根目录执行 npm run build 生成全部包与桌面端产物；验证顺序固定为 npm run typecheck → npm test。不要用 tsc 直接编译单个包，esbuild 负责把 .js 导入解析到 .tsx，跳过构建步骤会让 dist 保持旧版本。测试使用 fake provider。',
  conditions: ['Node 24'],
  sources: [{ sessionId: 's1', entryId: 'e1' }],
  updatedAt: '2026-10-24T12:00:00.000Z',
  ...overrides,
});

test('memoryGist keeps whole sentences and only truncates for display', () => {
  assert.equal(memoryGist('构建使用 pnpm build。'), '构建使用 pnpm build。');
  assert.equal(memoryGist('  \n '), '');
  const long = memoryGist('第一句话说明背景。第二句话说明约束。第三句话说明执行顺序。'.repeat(4), 30);
  assert.ok(long.endsWith('…'));
  assert.ok(Array.from(long).length <= 31);
  assert.ok(!long.includes('第四句话'));
});

test('relative time stays compact while date text remains absolute', () => {
  const now = Date.parse('2026-10-26T12:00:00.000Z');
  assert.equal(memoryRelativeTime('2026-10-26T11:59:30.000Z', now), '刚刚');
  assert.equal(memoryRelativeTime('2026-10-24T12:00:00.000Z', now), '2 天前');
  assert.equal(memoryRelativeTime('2026-11-02T12:00:00.000Z', now), '1 周后');
  assert.equal(memoryRelativeTime('not-a-date', now), 'not-a-date');
  assert.match(memoryDateText('2026-10-24T12:00:00.000Z'), /^2026-10-2[34]$/u);
});

test('the compact row renders one gist, exception labels and no ISO time', async () => {
  const compiled = await build({ entryPoints: [fileURLToPath(new URL('../apps/desktop/src/renderer/memory-row.tsx', import.meta.url))], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom', 'react/jsx-runtime'] });
  const module = { exports: {} as { MemoryRow: ComponentType<Record<string, unknown>> } };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  const render = (value: Json) => renderToStaticMarkup(createElement(module.exports.MemoryRow, { record: value, pinned: false, onOpen() {}, onPin() {}, onToggle() {}, onForget() {} }));

  const active = render(record());
  assert.match(active, /构建与验证命令/u);
  assert.match(active, /仓库根目录执行 npm run build 生成全部包/u);
  assert.match(active, /经验/u);
  assert.match(active, /项目/u);
  assert.match(active, /memory-row-menu/u);
  assert.doesNotMatch(active, /2026-10-24T12:00:00\.000Z/u);
  assert.doesNotMatch(active, />生效</u);
  assert.doesNotMatch(active, /不要用 tsc/u);

  const candidate = render(record({ status: 'candidate', enabled: false }));
  assert.match(candidate, />候选</u);
  assert.doesNotMatch(candidate, />未启用</u);

  const inactive = render(record({ status: 'inactive', enabled: false }));
  assert.match(inactive, />停用</u);
});
