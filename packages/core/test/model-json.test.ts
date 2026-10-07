import test from 'node:test';
import assert from 'node:assert/strict';
import {parseModelJson} from '../src/index.js';

test('model JSON first parses a complete object strictly and rejects complete non-objects',()=>{
  assert.deepEqual(parseModelJson(' \n {"approved":true,"findings":"已核查","count":2,"items":[1]} \n '),{approved:true,findings:'已核查',count:2,items:[1]});
  for(const value of ['null','true','3','[]','"a string"',JSON.stringify('```json\n{"approved":true}\n```')])assert.throws(()=>parseModelJson(value),/对象/);
});
test('exactly one JSON or unlabelled fenced object allows surrounding explanation',()=>{
  assert.deepEqual(parseModelJson('Verification complete.\n\n```json\n{"approved":true,"findings":"Tests passed"}\n```\n\nNo blocking issue.'),{approved:true,findings:'Tests passed'});
  assert.deepEqual(parseModelJson('说明\r\n```\r\n{"approved":false}\r\n```\r\n结束'),{approved:false});
  assert.deepEqual(parseModelJson('```JSON\n{"text":"literal ``` and {braces} remain string data"}\n```'),{text:'literal ``` and {braces} remain string data'});
});
test('multiple blocks and unsupported languages are rejected as ambiguous',()=>{
  for(const value of ['```json\n{"approved":true}\n```\n```json\n{"approved":false}\n```','```json\n{"approved":true}\n```\n```\n{"approved":false}\n```','```javascript\n{"approved":true}\n```','```json\n{"approved":true}\n```\n```text\nexplanation\n```'])assert.throws(()=>parseModelJson(value),/恰好一个/);
});
test('broken JSON, missing fences and fenced non-objects never become a result',()=>{
  for(const value of ['Verification complete.\n```json\n{"approved":true,}\n```','```json\n{"approved":true}\n','```json\n[1,2]\n```','```json\nnull\n```','The result is {"approved":true} with extra prose.'])assert.throws(()=>parseModelJson(value));
});
test('JSON field types are preserved and JavaScript expressions are never evaluated',()=>{
  const result=parseModelJson('Result follows.\n```json\n{"approved":"true","findings":123}\n```');assert.equal(result.approved,'true');assert.equal(result.findings,123);
  assert.throws(()=>parseModelJson('```json\n{approved:true}\n```'));
  assert.throws(()=>parseModelJson('```json\n({"approved":true})\n```'));
});
