import type { HookCallback, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';

import { FileOperationGuard, type FileAdmission, type FileOperationIdentity } from './file-operation.ts';

export const hostedTools = Object.freeze(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'WebSearch', 'WebFetch', 'AskUserQuestion'] as const);
export type FileTool = 'Read' | 'Glob' | 'Grep' | 'Edit' | 'Write';
const fileTools = new Set<string>(['Read', 'Glob', 'Grep', 'Edit', 'Write']);
const denial = 'This tool is unavailable for this turn.';

export interface ToolBoundaryOptions {
  readonly providerInstance: string;
  readonly fileOperations: FileOperationGuard;
  readonly isActive: (providerInstance: string, sdkSessionId: string) => boolean;
  readonly dialogsAvailable: () => boolean;
  // Returns null unless this pinned SDK operation footprint is verified and the
  // canonical target's entire physical access path has passed fresh admission.
  readonly admitFile: (tool: FileTool, input: unknown, signal: AbortSignal) => Promise<FileAdmission | null>;
  readonly verifyFileCompletion: (tool: FileTool, admission: FileAdmission, observedInput: unknown, succeeded: boolean, signal: AbortSignal) => Promise<boolean>;
}

function deny(): HookJSONOutput {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denial } };
}

function allow(input?: Readonly<Record<string, unknown>>): HookJSONOutput {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', ...(input === undefined ? {} : { updatedInput: { ...input } }) } };
}

// Mandatory pre-tool decisions are independent of SDK permission mode. Native
// completion alone does not discharge the file guard without footprint evidence.
export class ToolBoundary {
  private readonly options: ToolBoundaryOptions;
  private admitted: { readonly identity: FileOperationIdentity; readonly tool: FileTool; readonly admission: FileAdmission } | null = null;

  constructor(options: ToolBoundaryOptions) { this.options = options; }

  private active(sessionId: string): boolean {
    try { return this.options.isActive(this.options.providerInstance, sessionId); }
    catch { return false; }
  }

  private dialogsAvailable(): boolean {
    try { return this.options.dialogsAvailable(); }
    catch { return false; }
  }

  readonly pre: HookCallback = async (input, toolUseId, { signal }) => {
    if (input.hook_event_name !== 'PreToolUse' || signal.aborted || toolUseId !== undefined && toolUseId !== input.tool_use_id
      || input.mcp_server !== undefined || !this.active(input.session_id)) { return deny(); }
    if (input.tool_name === 'WebSearch' || input.tool_name === 'WebFetch') { return allow(); }
    if (input.tool_name === 'AskUserQuestion') { return this.dialogsAvailable() ? allow() : deny(); }
    if (!fileTools.has(input.tool_name)) { return deny(); }
    const identity: FileOperationIdentity = { providerInstance: this.options.providerInstance, toolUseId: input.tool_use_id };
    const cancel = (): void => this.options.fileOperations.cancelled(identity);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const permission = await this.options.fileOperations.request(identity, preflightSignal => this.options.admitFile(input.tool_name as FileTool, input.tool_input, preflightSignal));
      if (!permission.allowed || signal.aborted || !this.active(input.session_id)) {
        if (permission.allowed) { cancel(); }
        return deny();
      }
      const admission = this.options.fileOperations.admission;
      if (admission === null) { cancel(); return deny(); }
      this.admitted = { identity, tool: input.tool_name as FileTool, admission };
      return allow(permission.input);
    } catch {
      cancel();
      return deny();
    } finally { signal.removeEventListener('abort', cancel); }
  };

  readonly post: HookCallback = async (input, toolUseId, { signal }) => {
    if (input.hook_event_name !== 'PostToolUse' && input.hook_event_name !== 'PostToolUseFailure') { return {}; }
    if (!fileTools.has(input.tool_name) || toolUseId !== undefined && toolUseId !== input.tool_use_id) { return {}; }
    const identity: FileOperationIdentity = { providerInstance: this.options.providerInstance, toolUseId: input.tool_use_id };
    const owner = this.options.fileOperations.identity;
    const admission = this.options.fileOperations.admission;
    if (owner?.providerInstance !== identity.providerInstance || owner.toolUseId !== identity.toolUseId) { return {}; }
    if (admission === null) { this.options.fileOperations.completed(identity, false); return {}; }
    if (this.admitted?.admission !== admission || this.admitted.tool !== input.tool_name) {
      this.options.fileOperations.completed(identity, false);
      return {};
    }
    const cancel = (): void => this.options.fileOperations.cancelled(identity);
    signal.addEventListener('abort', cancel, { once: true });
    try {
      if (signal.aborted) { cancel(); return {}; }
      const finished = await this.options.verifyFileCompletion(input.tool_name as FileTool, admission, input.tool_input, input.hook_event_name === 'PostToolUse', signal);
      this.options.fileOperations.completed(identity, finished);
      if (this.options.fileOperations.identity === null) { this.admitted = null; }
    } catch { this.options.fileOperations.completed(identity, false); }
    finally { signal.removeEventListener('abort', cancel); }
    return {};
  };
}
