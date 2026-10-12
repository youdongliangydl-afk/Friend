import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Markdown} from '../apps/desktop/src/renderer/ui.js';

const render=(text:string)=>renderToStaticMarkup(React.createElement(Markdown,{text}));

test('Markdown preserves three list levels and returns siblings to their original parent',()=>{
  const html=render('- 核心结论\n  - 第一个要点\n    - 说明或示例\n  - 第二个要点\n- 另一结论');
  assert.match(html,/<ul><li>核心结论<ul><li>第一个要点<ul><li>说明或示例<\/li><\/ul><\/li><li>第二个要点<\/li><\/ul><\/li><li>另一结论<\/li><\/ul>/);
});

test('Markdown retains ordered starts, mixed nested list kinds and tab indentation',()=>{
  const html=render('3. 开始\n\t- 子项\n\t  1. 操作一\n\t  2) 操作二\n\t- 下一子项\n4. 结束\n- 无序同级');
  assert.match(html,/<ol start="3"><li>开始<ul><li>子项<ol><li>操作一<\/li><li>操作二<\/li><\/ol><\/li><li>下一子项<\/li><\/ul><\/li><li>结束<\/li><\/ol><ul><li>无序同级<\/li><\/ul>/);
  assert.match(render('1. 第一项\n2) 第二项'),/<ol><li>第一项<\/li><li>第二项<\/li><\/ol>/);
});

test('nested list content keeps Inline formatting and escapes untrusted HTML and links',()=>{
  const html=render('- **结论**\n  - `code` [文档](https://example.com)\n  - <img src=x onerror=evil> [坏链接](javascript:evil)');
  assert.match(html,/<strong>结论<\/strong><ul><li><code>code<\/code> <a href="https:\/\/example.com">文档<\/a>/);
  assert.match(html,/&lt;img src=x onerror=evil&gt; <a href="#">坏链接<\/a>/);
  assert.doesNotMatch(html,/<img|href="javascript:/);
});

test('ordinary paragraphs and fenced code keep the existing safe Markdown fallback',()=>{
  const paragraph=render('说明文字\n- 这行仍属于普通段落');
  assert.match(paragraph,/<p>说明文字\n- 这行仍属于普通段落<\/p>/);assert.doesNotMatch(paragraph,/<ul|<ol/);
  const code=render('```text\n- 原始代码\n  - 不解析嵌套\n```');
  assert.match(code,/<pre><code>- 原始代码\n  - 不解析嵌套\n<\/code><\/pre>/);assert.doesNotMatch(code,/<ul|<ol/);
});
