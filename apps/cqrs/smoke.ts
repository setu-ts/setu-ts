import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { IKernelApplication } from '@setu-ts/kernel';
import { addNote, readNotes } from './src/modules/notes/index.ts';
import { createApp } from './setu.config.ts';

describe('cqrs example', () => {
  let app: IKernelApplication;

  before(async () => {
    app = createApp();
    await app.start();
  });

  after(async () => {
    await app.stop();
  });

  it('reads through the query bus what the command bus wrote', async () => {
    await addNote(app.services, 'separate buses');

    const notes = await readNotes(app.services);

    assert.equal(notes.length, 1);
    // The factory-built handler stamps each note with the runtime clock it resolved.
    assert.match(notes[0] ?? '', /^separate buses @ \d+$/);
  });
});
