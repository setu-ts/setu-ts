import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CAPABILITIES } from '@setu-ts/common';
import type { IDatabaseService } from '@setu-ts/database-plugin';
import type { IKernelApplication } from '@setu-ts/kernel';
import type { Note } from './src/modules/notes/notes.schemas.ts';
import { NOTES_ENTITY } from './src/modules/notes/notes.service.ts';
import { createApp } from './setu.config.ts';

describe('database example', () => {
  let app: IKernelApplication;

  before(async () => {
    app = createApp();
    await app.start();
  });

  after(async () => {
    await app.stop();
  });

  it('reads back a note it wrote', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/notes',
      body: { id: 'first', text: 'Write this note' },
    });
    assert.equal(created.statusCode, 201);

    const read = await app.inject({ method: 'GET', url: '/notes/first' });

    assert.equal(read.statusCode, 200);
    assert.equal(read.json<Note>().text, 'Write this note');
  });

  it('persists an update', async () => {
    const updated = await app.inject({
      method: 'PATCH',
      url: '/notes/first',
      body: { text: 'Read the updated note' },
    });
    assert.equal(updated.statusCode, 200);

    const reread = await app.inject({ method: 'GET', url: '/notes/first' });

    assert.equal(reread.json<Note>().text, 'Read the updated note');
  });

  it('answers 404 for a note that does not exist', async () => {
    const read = await app.inject({ method: 'GET', url: '/notes/missing' });
    const patched = await app.inject({
      method: 'PATCH',
      url: '/notes/missing',
      body: { text: 'x' },
    });

    assert.equal(read.statusCode, 404);
    assert.equal(patched.statusCode, 404);
  });

  it('discards the writes of a transaction that throws', async () => {
    const database = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
    const notes = database.getRepository<Note>(NOTES_ENTITY);
    const countBefore = await notes.count();

    await assert.rejects(
      database.transaction(async (unitOfWork) => {
        await unitOfWork.getRepository<Note>(NOTES_ENTITY).create({ id: 'rolled-back', text: '-' });
        throw new Error('roll back');
      }),
      /roll back/,
    );

    assert.equal(await notes.count(), countBefore);
  });
});
