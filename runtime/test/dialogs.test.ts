import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Dialogs, parseDialogQuestions, type DialogEvent } from '../src/dialogs.ts';

const question = { question: 'Choose?', header: 'Choice', multiSelect: false, options: [{ label: 'One', description: 'First', preview: 'Detail' }, { label: 'Two', description: 'Second' }] };

describe('client dialog lifecycle', () => {
  it('keeps one open dialog available for a new attach snapshot and preserves free text', async () => {
    const events: DialogEvent[] = [];
    const dialogs = new Dialogs(event => events.push(event), () => 'dialog');
    const answer = dialogs.ask('turn', [question]);
    assert.deepEqual(dialogs.open?.questions, [question]);
    assert.deepEqual(await dialogs.ask('turn', [question]), { cancelled: true });
    assert.equal(dialogs.answer('old-dialog', { cancelled: true }), 'unknownDialog');
    assert.equal(dialogs.answer('dialog', { answers: {} }), 'invalidAnswer');
    assert.equal(dialogs.answer('dialog', { answers: { 'Choose?': '  A different option with a note  ' } }), 'accepted');
    assert.deepEqual(await answer, { answers: { 'Choose?': '  A different option with a note  ' } });
    assert.equal(dialogs.open, null);
    assert.equal(dialogs.answer('dialog', { cancelled: true }), 'unknownDialog');
    assert.deepEqual(events.map(event => event.type), ['dialog.requested', 'dialog.closed']);
  });

  it('closes only the owning turn and rejects ambiguous or excessive question shapes', async () => {
    const dialogs = new Dialogs(() => {}, () => 'dialog');
    const answer = dialogs.ask('current', [question]);
    dialogs.endTurn('old');
    assert.notEqual(dialogs.open, null);
    dialogs.endTurn('current');
    assert.deepEqual(await answer, { cancelled: true });
    assert.equal(parseDialogQuestions([question, question]), null);
    assert.equal(parseDialogQuestions([{ ...question, options: [question.options[0], question.options[0]] }]), null);
    assert.equal(parseDialogQuestions([{ ...question, options: [...question.options, ...question.options, question.options[0]] }]), null);
    assert.equal(parseDialogQuestions([{ ...question, multiSelect: undefined }]), null);
    assert.equal(parseDialogQuestions([{ ...question, header: 'An excessively long header' }]), null);
  });

  it('retains plain-data answers for prototype-shaped question text without accepting inherited fields', async () => {
    const dialogs = new Dialogs(() => {}, () => 'dialog');
    const answer = dialogs.ask('turn', [{ ...question, question: '__proto__' }]);
    assert.equal(dialogs.answer('dialog', { answers: {} }), 'invalidAnswer');
    const answers = Object.fromEntries([['__proto__', 'One']]);
    assert.equal(dialogs.answer('dialog', { answers }), 'accepted');
    assert.deepEqual(await answer, { answers });
  });

  it('does not strand the provider when client notification throws', async () => {
    const dialogs = new Dialogs(() => { throw new Error('disconnected client'); });
    assert.deepEqual(await dialogs.ask('turn', [question]), { cancelled: true });
    assert.equal(dialogs.open, null);
  });
});
