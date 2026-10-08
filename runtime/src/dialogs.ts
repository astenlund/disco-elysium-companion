import { newIdentity } from './identity.ts';
import type { DialogAnswer, DialogOption, DialogQuestion } from './provider.ts';

export interface OpenDialog { readonly dialogId: string; readonly interactionId: string; readonly questions: readonly DialogQuestion[] }
export type DialogEvent = { readonly type: 'dialog.requested'; readonly dialog: OpenDialog } | { readonly type: 'dialog.closed'; readonly dialogId: string; readonly reason: 'answered' | 'cancelled' | 'turnEnded' };
export type AnswerResult = 'accepted' | 'unknownDialog' | 'invalidAnswer';
interface PendingDialog { readonly data: OpenDialog; readonly resolve: (answer: DialogAnswer) => void }

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, empty = false): value is string { return typeof value === 'string' && value.isWellFormed() && (empty || value.trim().length > 0); }
function fields(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

export function parseDialogQuestions(value: unknown): readonly DialogQuestion[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) { return null; }
  const names = new Set<string>();
  const questions: DialogQuestion[] = [];
  for (const candidate of value) {
    if (!object(candidate) || !fields(candidate, ['question', 'header', 'options', 'multiSelect']) || !text(candidate['question']) || !text(candidate['header'])
      || candidate['header'].length > 12 || typeof candidate['multiSelect'] !== 'boolean' || !Array.isArray(candidate['options']) || candidate['options'].length < 2 || candidate['options'].length > 4 || names.has(candidate['question'])) { return null; }
    names.add(candidate['question']);
    const options: DialogOption[] = [];
    const labels = new Set<string>();
    for (const option of candidate['options']) {
      if (!object(option) || !fields(option, ['label', 'description'], ['preview']) || !text(option['label']) || !text(option['description'], true)
        || Object.hasOwn(option, 'preview') && !text(option['preview'], true) || labels.has(option['label'])) { return null; }
      labels.add(option['label']);
      options.push(Object.freeze({ label: option['label'], description: option['description'], ...(Object.hasOwn(option, 'preview') ? { preview: option['preview'] as string } : {}) }));
    }
    questions.push(Object.freeze({ question: candidate['question'], header: candidate['header'], multiSelect: candidate['multiSelect'], options: Object.freeze(options) }));
  }
  return Object.freeze(questions);
}

export class Dialogs {
  private readonly emit: (event: DialogEvent) => void;
  private readonly mint: () => string;
  private pending: PendingDialog | null = null;

  constructor(emit: (event: DialogEvent) => void, mint = newIdentity) { this.emit = emit; this.mint = mint; }

  get open(): OpenDialog | null { return this.pending?.data ?? null; }

  ask(interactionId: string, rawQuestions: unknown): Promise<DialogAnswer> {
    const questions = parseDialogQuestions(rawQuestions);
    if (this.pending !== null || questions === null) { return Promise.resolve({ cancelled: true }); }
    const data: OpenDialog = Object.freeze({ dialogId: this.mint(), interactionId, questions });
    let resolve: (answer: DialogAnswer) => void = () => {};
    const promise = new Promise<DialogAnswer>(done => { resolve = done; });
    this.pending = { data, resolve };
    try { this.emit({ type: 'dialog.requested', dialog: data }); }
    catch { this.finish({ cancelled: true }, 'cancelled'); }
    return promise;
  }

  answer(dialogId: string, value: unknown): AnswerResult {
    const pending = this.pending;
    if (pending === null || pending.data.dialogId !== dialogId) { return 'unknownDialog'; }
    if (!object(value)) { return 'invalidAnswer'; }
    if (fields(value, ['cancelled']) && value['cancelled'] === true) {
      this.finish({ cancelled: true }, 'cancelled');
      return 'accepted';
    }
    if (!fields(value, ['answers']) || !object(value['answers'])) { return 'invalidAnswer'; }
    const answers = value['answers'];
    const keys = pending.data.questions.map(question => question.question);
    if (!fields(answers, keys) || keys.some(key => !text(answers[key]))) { return 'invalidAnswer'; }
    const frozen = Object.freeze(Object.fromEntries(keys.map(key => [key, answers[key] as string])));
    this.finish({ answers: frozen }, 'answered');
    return 'accepted';
  }

  endTurn(interactionId: string): void {
    if (this.pending?.data.interactionId === interactionId) { this.finish({ cancelled: true }, 'turnEnded'); }
  }

  private finish(answer: DialogAnswer, reason: 'answered' | 'cancelled' | 'turnEnded'): void {
    const pending = this.pending;
    if (pending === null) { return; }
    this.pending = null;
    pending.resolve(answer);
    try { this.emit({ type: 'dialog.closed', dialogId: pending.data.dialogId, reason }); }
    catch { /* The closed state and provider cancellation survive a failed client notification. */ }
  }
}
