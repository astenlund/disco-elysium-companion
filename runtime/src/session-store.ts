import { requireControl } from './control-values.ts';
import type { Deadline } from './deadline.ts';
import { parseStrictJson, stringifyJson, stringifyProspectiveJson, utcNow, type ProspectiveJsonFailure } from './json.ts';
import { admitNamedSession, indexCurrentBinding, parseSessionBinding, parseSessionIndex, type AgentSessionBinding, type AgentSessionIndex, type NamedSessionAdmission } from './session-records.ts';
import { SerialQueue } from './serial.ts';
import { ScopeStorage, type StoredDocument } from './storage.ts';

export interface SessionBindingProof {
  // Reads current safety, protected operation intents and the actual provider identity.
  readonly verify: (binding: AgentSessionBinding, deadline?: Deadline) => Promise<boolean>;
}
export interface BoundSession { readonly binding: AgentSessionBinding; readonly bindingSha256: string; readonly indexSha256: string }
export interface SessionDocuments { readonly binding: StoredDocument<AgentSessionBinding>; readonly index: StoredDocument<AgentSessionIndex> }

const sameBinding = (left: AgentSessionBinding, right: AgentSessionBinding): boolean => stringifyJson(left) === stringifyJson(right);

function sameSessionHistory(left: AgentSessionBinding, right: AgentSessionBinding): void {
  if (left.providerId !== right.providerId || left.providerSessionId !== right.providerSessionId) { return; }
  requireControl(left.createdAt === right.createdAt && left.instructionsSha256 === right.instructionsSha256 && left.stateGeneration === right.stateGeneration && right.turnsCompleted >= left.turnsCompleted);
}

export interface SessionStoreOptions {
  readonly mutation?: <T>(action: () => Promise<T>, deadline?: Deadline) => Promise<T>;
  readonly bind?: <T>(action: () => Promise<T>) => () => Promise<T>;
  readonly prospectiveFailure?: ProspectiveJsonFailure;
}
export class SessionStore {
  private readonly storage: ScopeStorage;
  private readonly queue = new SerialQueue();

  private readonly options: SessionStoreOptions;
  constructor(storage: ScopeStorage, options: SessionStoreOptions = {}) { this.storage = storage; this.options = options; }

  readBinding(deadline?: Deadline): Promise<StoredDocument<AgentSessionBinding>> {
    return this.storage.read('agent-session.json', 'config', parseSessionBinding, deadline);
  }

  readIndex(deadline?: Deadline): Promise<StoredDocument<AgentSessionIndex>> {
    return this.storage.read('agent-session-index.json', 'config', parseSessionIndex, deadline);
  }

  async readPair(deadline?: Deadline): Promise<SessionDocuments> {
    const values = await this.storage.readMany(['agent-session.json', 'agent-session-index.json'], 'config', (value, index) => index === 0
      ? { kind: 'binding' as const, value: parseSessionBinding(value) } : { kind: 'index' as const, value: parseSessionIndex(value) }, deadline);
    const binding = values[0];
    const index = values[1];
    requireControl(values.length === 2 && binding !== undefined && index !== undefined);
    let bindingDocument: StoredDocument<AgentSessionBinding>;
    if (binding.status === 'valid') {
      requireControl(binding.value.kind === 'binding');
      bindingDocument = { status: 'valid', sha256: binding.sha256, value: binding.value.value };
    } else { bindingDocument = binding; }
    let indexDocument: StoredDocument<AgentSessionIndex>;
    if (index.status === 'valid') {
      requireControl(index.value.kind === 'index');
      indexDocument = { status: 'valid', sha256: index.sha256, value: index.value.value };
    } else { indexDocument = index; }
    return { binding: bindingDocument, index: indexDocument };
  }

  async admitNamed(providerId: string, sessionId: string, generation: string, instructionsSha256: string, deadline?: Deadline): Promise<NamedSessionAdmission> {
    let index: StoredDocument<AgentSessionIndex>;
    try { index = await this.readIndex(deadline); }
    catch { return { result: 'unknownSession' }; }
    return admitNamedSession(index.status === 'valid' ? index.value : null, providerId, sessionId, generation, instructionsSha256);
  }

  bind(input: AgentSessionBinding, proof: SessionBindingProof, deadline?: Deadline): Promise<BoundSession> {
    const action = () => this.bindOwned(input, proof, deadline);
    return this.options.mutation?.(action, deadline) ?? action();
  }

  private bindOwned(input: AgentSessionBinding, proof: SessionBindingProof, deadline?: Deadline): Promise<BoundSession> {
    const binding = parseSessionBinding(parseStrictJson(Buffer.from(stringifyProspectiveJson(input, 'config', 'agent-session.json', this.options.prospectiveFailure))));
    const action = async () => {
      deadline?.check();
      const previous = await this.readBinding(deadline);
      if (previous.status === 'valid') { sameSessionHistory(previous.value, binding); }
      let index: AgentSessionIndex | null = null;
      try { const stored = await this.readIndex(deadline); if (stored.status === 'valid') { index = stored.value; } }
      catch { /* A binding write may reconstruct this derived index alone. */ }
      for (const prior of index?.sessions ?? []) { sameSessionHistory(prior, binding); }
      requireControl(await proof.verify(binding, deadline));
      requireControl(previous.status !== 'invalid' || previous.sha256 !== null);
      const bindingSha256 = await this.storage.write('agent-session.json', binding, 'config', previous.status === 'absent' ? null : previous.sha256, deadline);
      const nextIndex = indexCurrentBinding(index, binding, utcNow());
      requireControl(await proof.verify(binding, deadline));
      const indexSha256 = await this.storage.replaceSessionIndex(nextIndex, bindingSha256, deadline);
      return { binding, bindingSha256, indexSha256 };
    };
    return this.queue.run(this.options.bind?.(action) ?? action);
  }

  ready(proof: SessionBindingProof, deadline?: Deadline): Promise<BoundSession | null> {
    return this.queue.run(async () => {
      const { binding, index } = await this.readPair(deadline);
      if (binding.status !== 'valid' || index.status !== 'valid') { return null; }
      const entry = index.value.sessions.find(entry => entry.providerId === binding.value.providerId && entry.providerSessionId === binding.value.providerSessionId);
      if (entry === undefined) { return null; }
      const { lastBoundAt: _, ...indexedBinding } = entry;
      if (!sameBinding(binding.value, indexedBinding) || !await proof.verify(binding.value, deadline)) { return null; }
      deadline?.check();
      return { binding: binding.value, bindingSha256: binding.sha256, indexSha256: index.sha256 };
    });
  }
}
