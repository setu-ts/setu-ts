import { createDatabaseApp, rollbackCount } from './src/app.ts';

const app = createDatabaseApp();
await app.start();
try {
  const created = await app.inject({
    method: 'POST',
    url: 'http://example.test/notes',
    body: { id: 'first', text: 'Write this note' },
  });
  if (created.statusCode !== 201) throw new Error(`Expected 201, received ${created.statusCode}.`);

  const read = await app.inject({ method: 'GET', url: 'http://example.test/notes/first' });
  if (read.statusCode !== 200 || read.json<{ text: string }>().text !== 'Write this note') {
    throw new Error('The written note was not read back from the repository.');
  }

  const updated = await app.inject({
    method: 'PATCH',
    url: 'http://example.test/notes/first',
    body: { text: 'Read the updated note' },
  });
  if (
    updated.statusCode !== 200 || updated.json<{ text: string }>().text !== 'Read the updated note'
  ) {
    throw new Error('The repository update was not visible on read-back.');
  }
  const reread = await app.inject({ method: 'GET', url: 'http://example.test/notes/first' });
  if (reread.json<{ text: string }>().text !== 'Read the updated note') {
    throw new Error('The updated note was not persisted.');
  }
  if (await rollbackCount(app) !== 1) {
    throw new Error('A rolled-back transaction changed the row count.');
  }
} finally {
  await app.stop();
}
