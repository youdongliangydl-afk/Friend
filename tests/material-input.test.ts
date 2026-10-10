import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative} from 'node:path';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {digest} from '../packages/core/src/index.js';
import {importAttachments} from '../apps/desktop/src/attachment-input.js';
import {fileReferences, referencePath, sessionReference} from '../apps/desktop/src/material-references.js';

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'friend-material-input-')));
  const root = join(directory, 'workspace'), data = join(directory, 'data'); mkdirSync(root); mkdirSync(data);
  return {directory, root, data, close() {rmSync(directory, {recursive: true, force: true});}};
}

test('raw dropped bytes keep their original contents in a private directory and cannot escape with a supplied name', () => {
  const f = fixture();
  try {
    const bytes = Buffer.from([0, 1, 255, 13, 10]);
    const files = importAttachments(f.data, [{name: '../../outside/附件\u0000.bin', data: bytes.toString('base64')}, {name: '..\\outside.bin', data: 'dGV4dA=='}]);
    for (const file of files) {
      assert.equal(relative(join(f.data, 'attachments'), file.path).startsWith('..'), false);
      assert.equal(statSync(file.path).mode & 0o777, 0o600);
      assert.equal(statSync(join(file.path, '..')).mode & 0o777, 0o700);
    }
    assert.deepEqual(readFileSync(files[0].path), bytes); assert.equal(files[0].name, '附件_.bin');
    assert.equal(readFileSync(files[1].path, 'utf8'), 'text');
    assert.equal(existsSync(join(f.directory, 'outside')), false);
  } finally {f.close();}
});

test('invalid raw import batches fail validation before writing any attachment directory', () => {
  const f = fixture();
  try {
    for (const data of ['A', 'AA=', 'AAAA===', 'AA-A', 'AAAA\n', 'AAAA AA==', '!!!!']) assert.throws(() => importAttachments(f.data, [{name: 'invalid', data}]), /附件/);
    assert.throws(() => importAttachments(f.data, [{name: 'valid', data: 'dGV4dA=='}, {name: 'bad', data: '$invalid'}]), /附件/);
    assert.throws(() => importAttachments(f.data, Array.from({length: 21}, () => ({name: 'a', data: ''}))), /20/);
    assert.throws(() => importAttachments(f.data, {}), /20/);
    assert.deepEqual(readdirSync(f.data), []);
  } finally {f.close();}
});

test('a legal 10 MiB raw file succeeds without recursive regex failure and bytes beyond the limit are rejected', () => {
  const f = fixture();
  try {
    const bytes = Buffer.alloc(10 * 1024 * 1024, 0x31);
    const [file] = importAttachments(f.data, [{name: 'large.bin', data: bytes.toString('base64')}]);
    assert.equal(statSync(file.path).size, bytes.length); assert.deepEqual(readFileSync(file.path), bytes);
    assert.throws(() => importAttachments(f.data, [{name: 'too-large.bin', data: Buffer.alloc(bytes.length + 1).toString('base64')}]), /附件/);
  } finally {f.close();}
});

test('raw batch total limit is checked across all files before any write', () => {
  const f = fixture();
  try {
    const data = Buffer.alloc(8 * 1024 * 1024, 0x32).toString('base64');
    assert.throws(() => importAttachments(f.data, Array.from({length: 3}, (_, index) => ({name: 'file-' + index, data}))), /20 MiB/);
    assert.deepEqual(readdirSync(f.data), []);
  } finally {f.close();}
});

test('workspace references preserve Unicode paths and reject parent, sibling-prefix and symlink escapes', () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, '资料')); const inside = join(f.root, '资料', '预算 表.txt'); writeFileSync(inside, 'inside');
    const outside = join(f.directory, 'outside.txt'); writeFileSync(outside, 'outside');
    const sibling = f.root + '-sibling'; mkdirSync(sibling); writeFileSync(join(sibling, 'private.txt'), 'private');
    symlinkSync(outside, join(f.root, 'linked-secret.txt'));
    assert.equal(referencePath(f.root, '资料/预算 表.txt'), inside);
    assert.equal(referencePath(f.root, inside), inside);
    for (const path of ['../outside.txt', outside, join(sibling, 'private.txt'), 'linked-secret.txt']) assert.throws(() => referencePath(f.root, path), /当前工作区/);
    assert.throws(() => fileReferences(f.root, '../'), /当前(?:项目|工作区)/);
    const nested = fileReferences(f.root, '资料/预算');
    assert.equal(nested.items[0].path, inside); assert.equal(nested.items[0].insert, '@' + JSON.stringify(inside));
  } finally {f.close();}
});

test('reference candidates never silently turn an outside-workspace symlink into an attachable file', () => {
  const f = fixture();
  try {
    const outside = join(f.directory, 'outside.txt'); writeFileSync(outside, 'private outside material');
    symlinkSync(outside, join(f.root, 'linked-secret.txt'));
    const candidates = fileReferences(f.root, 'linked');
    assert.equal(candidates.items.some(item => item.kind === '文件' && item.path === join(f.root, 'linked-secret.txt')), false);
  } finally {f.close();}
});

test('reference menus disclose their own 60-result truncation even below the directory pagination limit', () => {
  const f = fixture();
  try {
    for (let index = 0; index < 65; index++) writeFileSync(join(f.root, `material-${index.toString().padStart(3, '0')}.txt`), 'material');
    const candidates = fileReferences(f.root, 'material');
    assert.equal(candidates.items.length, 60); assert.equal(candidates.truncated, true);
  } finally {f.close();}
});

test('an exact reference query finds the 501st directory entry while broad results still disclose the 60-item menu limit', () => {
  const f = fixture();
  try {
    for (let index = 0; index < 501; index++) writeFileSync(join(f.root, `material-${index.toString().padStart(3, '0')}.txt`), 'material');
    const exact = fileReferences(f.root, 'material-500.txt');
    assert.equal(exact.items.length, 1); assert.equal(exact.items[0].path, join(f.root, 'material-500.txt'));
    assert.equal(exact.truncated, false);
    const broad = fileReferences(f.root, 'material-');
    assert.equal(broad.items.length, 60); assert.equal(broad.truncated, true);
  } finally {f.close();}
});

test('native session references name the exact source digest and disclose their last-20-message text-only scope', () => {
  const f = fixture();
  try {
    const manager = SessionManager.create(f.root, join(f.directory, 'sessions'));
    for (let index = 0; index < 24; index++) manager.appendMessage({role: 'user', content: 'source-message-' + index.toString().padStart(2, '0'), timestamp: 1000 + index});
    const path = manager.getSessionFile()!, raw = readFileSync(path);
    const reference = sessionReference(path, '原始材料');
    assert.match(reference, /最近 20\/24 条消息的文字部分/); assert.match(reference, /不包含图片像素或完整历史/);
    assert.ok(reference.includes(path)); assert.ok(reference.includes(digest(raw.toString('base64'))));
    assert.equal(reference.includes('source-message-00'), false); assert.equal(reference.includes('source-message-03'), false);
    assert.ok(reference.includes('source-message-04')); assert.ok(reference.includes('source-message-23'));
    const nativeId = manager.getBranch().find(entry => entry.type === 'message')!.id;
    assert.equal(reference.includes('[' + nativeId + ']'), false);
    assert.deepEqual(readFileSync(path), raw, 'reference generation must not edit native history');
  } finally {f.close();}
});

test('session reference material contains original text but excludes pixels, thinking and tool argument objects', () => {
  const f = fixture();
  try {
    const manager = SessionManager.create(f.root, join(f.directory, 'sessions'));
    manager.appendMessage({role: 'user', content: [{type: 'text', text: 'original user requirement'}, {type: 'image', data: 'private-pixel-data', mimeType: 'image/png'}], timestamp: 1});
    manager.appendMessage({role: 'assistant', content: [{type: 'thinking', thinking: 'private reasoning'}, {type: 'text', text: 'visible assistant answer'}, {type: 'toolCall', id: 'tool-one', name: 'read', arguments: {privateArgument: 'raw tool input'}}], timestamp: 2} as never);
    manager.appendMessage({role: 'toolResult', toolCallId: 'tool-one', toolName: 'read', content: [{type: 'text', text: 'visible tool result'}], isError: false, timestamp: 3});
    const reference = sessionReference(manager.getSessionFile()!, '材料');
    for (const text of ['original user requirement', 'visible assistant answer', 'visible tool result']) assert.ok(reference.includes(text));
    assert.doesNotMatch(reference, /private-pixel-data|private reasoning|raw tool input|privateArgument/);
    assert.match(reference, /最近 3\/3 条消息的文字部分/);
  } finally {f.close();}
});

test('clipped Chinese session material keeps valid Unicode and explicitly declares the reduced source scope', () => {
  const f = fixture();
  try {
    const manager = SessionManager.create(f.root, join(f.directory, 'sessions'));
    manager.appendMessage({role: 'user', content: '中文预算材料'.repeat(12_000) + '末尾完成!', timestamp: 1});
    const reference = sessionReference(manager.getSessionFile()!, '长材料');
    assert.match(reference, /因长度限制只包含尾部48 KiB/); assert.ok(reference.includes('末尾完成!'));
    assert.equal(reference.includes('\ufffd'), false, 'byte clipping must not split a UTF-8 character');
  } finally {f.close();}
});
