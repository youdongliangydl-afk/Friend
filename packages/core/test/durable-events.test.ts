import test from 'node:test';
import assert from 'node:assert/strict';
import {translateAgentEvent,translateAgentEvents} from '../src/durable-events.js';

test('run boundaries become the agent_start and agent_settled the worker already handles',()=>{
  assert.deepEqual(translateAgentEvent({type:'run_start',inputs:[1]}),{type:'agent_start'});
  assert.deepEqual(translateAgentEvent({type:'run_end',inputs:[1]}),{type:'agent_settled'});
});

test('message events carry the message itself, not the wrapping entry',()=>{
  const message={role:'assistant',content:[{type:'text',text:'hi'}],timestamp:1700000000000};
  assert.deepEqual(translateAgentEvent({type:'message_start',message}),{type:'message_start',message});
  assert.deepEqual(
    translateAgentEvent({type:'message_end',entry:{id:1,conversationId:1,kind:'pi.assistant',model:[message]}}),
    {type:'message_end',message},
  );
});

test('a tool end without an entry is reported as an error rather than a silent success',()=>{
  const ok=translateAgentEvent({type:'tool_execution_end',toolCallId:'t1',toolName:'read',entry:{id:1,conversationId:1,kind:'pi.tool-result',model:[{role:'toolResult',content:[{type:'text',text:'body'}]}]}});
  assert.equal(ok?.type,'tool_execution_end');
  assert.equal((ok as {isError:boolean}).isError,false);
  assert.deepEqual((ok as {result:unknown}).result,[{type:'text',text:'body'}]);

  const faulted=translateAgentEvent({type:'tool_execution_end',toolCallId:'t2',toolName:'bash'});
  assert.equal((faulted as {isError:boolean}).isError,true);
  assert.equal((faulted as {result:unknown}).result,undefined);
});

test('tool start preserves the call identity and arguments',()=>{
  const start=translateAgentEvent({type:'tool_execution_start',toolCallId:'c1',toolName:'bash',args:{command:'pwd'}});
  assert.deepEqual(start,{type:'tool_execution_start',toolCallId:'c1',toolName:'bash',args:{command:'pwd'}});
});

test('compaction events map through, keeping the reason when present',()=>{
  assert.deepEqual(translateAgentEvent({type:'compaction_start',taskId:1,reason:'threshold',blocking:false}),{type:'compaction_start',reason:'threshold'});
  assert.deepEqual(translateAgentEvent({type:'compaction_end',taskId:1,reason:'threshold'}),{type:'compaction_end',reason:'threshold'});
  assert.deepEqual(translateAgentEvent({type:'compaction_end',taskId:1}),{type:'compaction_end'});
});

test('events with no worker counterpart are dropped instead of being passed through',()=>{
  for(const type of ['snapshot','turn_start','turn_end','message_update','inbox_update','submission','usage_changed','entry_appended','auto_retry_start','deferred_poll','task_failed'])
    assert.equal(translateAgentEvent({type}),undefined,`${type} has no counterpart`);
  assert.deepEqual(translateAgentEvents([{type:'run_start'},{type:'turn_start'},{type:'run_end'}]),[{type:'agent_start'},{type:'agent_settled'}]);
});

test('a malformed event does not throw',()=>{
  assert.equal(translateAgentEvent(undefined),undefined);
  assert.equal(translateAgentEvent(null),undefined);
  assert.equal(translateAgentEvent('nope'),undefined);
  assert.deepEqual(translateAgentEvent({type:'tool_execution_start'}),{type:'tool_execution_start',toolCallId:'',toolName:'',args:undefined});
});
