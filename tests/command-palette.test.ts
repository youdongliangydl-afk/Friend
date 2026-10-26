import test from 'node:test';
import assert from 'node:assert/strict';
import {commandRegistry,filterCommands,movePaletteSelection,paletteEnterTarget,palettePanels,paletteSettings,subsequenceMatch,type PaletteCommand} from '../apps/desktop/src/renderer/command-palette.js';

const registry=commandRegistry();
const ids=(commands:PaletteCommand[])=>commands.map(command=>command.id);

test('the palette registry covers panels, settings and session actions with stable ids',()=>{
 assert.deepEqual(ids(registry).slice(0,2),['panel:conversation','panel:browser']);
 assert.deepEqual(ids(registry).slice(2,10),['panel:trace','panel:file','panel:diff','panel:git','panel:terminal','panel:swarm','panel:expert','panel:memory']);
 assert.deepEqual(ids(registry).slice(10,15),['settings:general','settings:models','settings:instructions','settings:memory','settings:extensions']);
 assert.deepEqual(ids(registry).slice(15),['session:new','session:search']);
 assert.equal(new Set(ids(registry)).size,registry.length);
 for(const command of registry)assert.ok(['面板','设置','会话'].includes(command.group),command.id);
 for(const panel of palettePanels)assert.ok(registry.some(command=>command.id==='panel:'+panel.id),panel.id);
 for(const page of paletteSettings)assert.ok(registry.some(command=>command.id==='settings:'+page.id),page.id);
 assert.equal(registry.find(command=>command.id==='panel:diff')?.title,'打开Diff面板');
 assert.equal(registry.find(command=>command.id==='settings:models')?.title,'模型设置');
});
test('session actions follow the session snapshot: stop is only runnable while running and archive becomes restore',()=>{
 assert.equal(registry.some(command=>command.id.startsWith('session:')&&['session:stop','session:archive','session:rename'].includes(command.id)),false);
 const idle=commandRegistry({session:{id:'s'}});
 assert.equal(idle.find(command=>command.id==='session:stop')?.disabled,true);
 assert.equal(idle.find(command=>command.id==='session:archive')?.title,'归档当前会话');
 assert.equal(idle.find(command=>command.id==='session:search')?.hint,'⌘F');
 const active=commandRegistry({session:{id:'s',archived:true,running:true},searchShortcut:'⌘⇧F'});
 assert.equal(active.find(command=>command.id==='session:stop')?.disabled,undefined);
 assert.equal(active.find(command=>command.id==='session:archive')?.title,'恢复当前会话');
 assert.equal(active.find(command=>command.id==='session:search')?.hint,'⌘⇧F');
 assert.equal(active.find(command=>command.id==='session:rename')?.title,'重命名当前会话');
});
test('an empty query keeps registry order while a query ranks exact titles before keyword matches',()=>{
 assert.deepEqual(ids(filterCommands(registry,'')),ids(registry));
 assert.equal(filterCommands(registry,'',3).length,3);
 assert.equal(filterCommands(registry,'模型设置')[0].id,'settings:models');
 assert.deepEqual(ids(filterCommands(registry,'模型')),['settings:models']);
 const memory=ids(filterCommands(registry,'memory'));
 assert.equal(memory[0],'panel:memory');assert.ok(memory.includes('settings:memory'));
 assert.deepEqual(ids(filterCommands(registry,'设置 模型')),['settings:models']);
 const conversation=ids(filterCommands(registry,'会话'));
 assert.equal(conversation[0],'panel:conversation');assert.ok(conversation.includes('session:new'));
 assert.deepEqual(filterCommands(registry,'不存在的命令'),[]);
});
test('fuzzy subsequence matching only fills in when no stronger field matched',()=>{
 assert.equal(subsequenceMatch('打开轨迹面板','打轨'),true);
 assert.equal(subsequenceMatch('打开轨迹面板','开轨'),true);
 assert.equal(subsequenceMatch('打开网页','网x'),false);
 assert.equal(subsequenceMatch('abc',''),true);
 const commands:PaletteCommand[]=[{id:'fuzzy',title:'导出会话记录',group:'会话',keywords:[]},{id:'exact',title:'导出',group:'会话',keywords:[]}];
 assert.equal(filterCommands(commands,'导出')[0].id,'exact');
});
test('disabled commands never outrank an equal enabled match',()=>{
 const commands:PaletteCommand[]=[{id:'blocked',title:'操作',group:'会话',disabled:true},{id:'open',title:'操作',group:'会话'}];
 assert.deepEqual(ids(filterCommands(commands,'操作')),['open','blocked']);
});
test('keyboard selection wraps, supports Home and End and handles empty or stale indexes',()=>{
 assert.equal(movePaletteSelection(-1,3,'ArrowDown'),0);
 assert.equal(movePaletteSelection(2,3,'ArrowDown'),0);
 assert.equal(movePaletteSelection(0,3,'ArrowUp'),2);
 assert.equal(movePaletteSelection(9,3,'ArrowUp'),2);
 assert.equal(movePaletteSelection(1,3,'Home'),0);
 assert.equal(movePaletteSelection(1,3,'End'),2);
 assert.equal(movePaletteSelection(0,0,'ArrowDown'),-1);
 assert.equal(movePaletteSelection(0,1,'ArrowUp'),0);
});
test('Enter runs only an enabled command inside the filtered list',()=>{
 const commands:PaletteCommand[]=[{id:'a',title:'甲',group:'面板'},{id:'b',title:'乙',group:'面板',disabled:true}];
 assert.equal(paletteEnterTarget(commands,0),commands[0]);
 assert.equal(paletteEnterTarget(commands,1),undefined);
 assert.equal(paletteEnterTarget(commands,2),undefined);
 assert.equal(paletteEnterTarget([],0),undefined);
});
