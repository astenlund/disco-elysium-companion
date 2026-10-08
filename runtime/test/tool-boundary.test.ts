import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PostToolUseHookInput, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

import { FileOperationGuard, type FileAdmission } from '../src/file-operation.ts';
import { ToolBoundary } from '../src/tool-boundary.ts';

function fixture(pendingAdmission?: Promise<FileAdmission | null>) {
  const guard = new FileOperationGuard({ held: true });
  guard.admitQuiescentNamespace();
  const state = { active: true, dialogs: false, verified: false, finished: false };
  const boundary = new ToolBoundary({
    providerInstance: 'provider', fileOperations: guard, isActive: (_instance, session) => state.active && session === 'session', dialogsAvailable: () => state.dialogs,
    admitFile: async () => pendingAdmission ?? (state.verified ? { canonicalInput: Object.freeze({ file_path: 'C:/admitted/cache.md' }), evidence: Object.freeze({ identity: 'file' }) } : null),
    verifyFileCompletion: async () => state.finished,
  });
  return { guard, state, boundary };
}

function pre(tool: string): PreToolUseHookInput {
  return { hook_event_name: 'PreToolUse', session_id: 'session', transcript_path: 'host-owned', cwd: 'C:/admitted', tool_name: tool, tool_input: {}, tool_use_id: 'tool' };
}

function post(): PostToolUseHookInput {
  return { ...pre('Read'), hook_event_name: 'PostToolUse', tool_response: {} };
}
const options = () => ({ signal: new AbortController().signal });

describe('pinned SDK mandatory tool boundary', () => {
  it('denies unknown tools, mismatched identities and invalidated provider activity', async () => {
    const { boundary, state } = fixture();
    for (const tool of ['Bash', 'Task', 'mcp__server__Read', 'read']) {
      assert.equal((await boundary.pre(pre(tool), 'tool', options()) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, 'deny');
    }
    assert.equal((await boundary.pre(pre('WebSearch'), 'other', options()) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, 'deny');
    state.active = false;
    assert.equal((await boundary.pre(pre('WebSearch'), 'tool', options()) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, 'deny');
  });

  it('keeps web and dialog decisions independent of file-tool availability', async () => {
    const { boundary, state } = fixture();
    assert.equal((await boundary.pre(pre('WebFetch'), 'tool', options()) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, 'allow');
    assert.equal((await boundary.pre(pre('AskUserQuestion'), 'tool', options()) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, 'deny');
    state.dialogs = true;
    assert.equal((await boundary.pre(pre('AskUserQuestion'), 'tool', options()) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, 'allow');
    assert.equal((await boundary.pre(pre('Read'), 'tool', options()) as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, 'deny');
  });

  it('passes canonical input only after admission and does not confuse a post hook with finished work', async () => {
    const { boundary, state, guard } = fixture();
    state.verified = true;
    const permission = await boundary.pre(pre('Read'), 'tool', options()) as { hookSpecificOutput: { permissionDecision: string; updatedInput: Record<string, unknown> } };
    assert.equal(permission.hookSpecificOutput.permissionDecision, 'allow');
    assert.deepEqual(permission.hookSpecificOutput.updatedInput, { file_path: 'C:/admitted/cache.md' });
    await boundary.post(post(), 'tool', options());
    assert.equal(guard.state, 'uncertain');
    state.finished = true;
    await boundary.post({ ...post(), tool_name: 'Edit' }, 'tool', options());
    assert.equal(guard.state, 'uncertain');
    await boundary.post(post(), 'tool', options());
    assert.equal(guard.state, 'idle');
  });

  it('holds the owner uncertain when the SDK reports completion before preflight permission', async () => {
    let finish: (value: FileAdmission) => void = () => {};
    const pendingAdmission = new Promise<FileAdmission>(resolve => { finish = resolve; });
    const { boundary, guard } = fixture(pendingAdmission);
    const request = boundary.pre(pre('Read'), 'tool', options());
    assert.equal(guard.state, 'preflight');
    await boundary.post(post(), 'tool', options());
    finish({ canonicalInput: {}, evidence: {} });
    assert.equal((await request as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(guard.state, 'uncertain');
    guard.providerTerminated('provider');
    assert.equal(guard.state, 'idle');
  });
});
