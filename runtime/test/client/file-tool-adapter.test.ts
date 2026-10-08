import assert from 'node:assert/strict';
import test from 'node:test';
import type { PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

import type { PathInspector } from '../../src/admission.ts';
import { FileToolAdapter } from '../../src/file-tool-adapter.ts';

test('production file adapter refuses unverified footprints without disabling web or dialogs', async () => {
  const adapter = await FileToolAdapter.create({ companionRoot: 'C:/fixture',
    inspector: { inspect: async () => { throw new Error('No admitted root.'); }, idle: async () => {} } as unknown as PathInspector,
    supervisor: { spawn: () => { throw new Error('No provider process expected.'); }, verifyQuiescent: async () => {} },
    isActive: () => true, dialogsAvailable: () => true });
  const boundary = adapter.boundary('provider');
  for (const tool of ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash']) {
    const input = { hook_event_name: 'PreToolUse', session_id: 'session', transcript_path: '', cwd: 'C:/fixture', tool_name: tool, tool_use_id: tool, tool_input: {} } as PreToolUseHookInput;
    const decision = await boundary.pre(input, tool, { signal: new AbortController().signal });
    assert.ok('hookSpecificOutput' in decision);
    assert.equal(decision.hookSpecificOutput?.hookEventName === 'PreToolUse' && decision.hookSpecificOutput.permissionDecision, 'deny');
  }
  for (const tool of ['WebSearch', 'WebFetch', 'AskUserQuestion']) {
    const input = { hook_event_name: 'PreToolUse', session_id: 'session', transcript_path: '', cwd: 'C:/fixture', tool_name: tool, tool_use_id: tool, tool_input: {} } as PreToolUseHookInput;
    const decision = await boundary.pre(input, tool, { signal: new AbortController().signal });
    assert.ok('hookSpecificOutput' in decision);
    assert.equal(decision.hookSpecificOutput?.hookEventName === 'PreToolUse' && decision.hookSpecificOutput.permissionDecision, 'allow');
  }
  await adapter.close();
});
