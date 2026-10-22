/* eslint-disable no-console -- an example entry reports what it did. */
import { addNote, readNotes } from './src/modules/notes/index.ts';
import { createApp } from './setu.config.ts';

const app = createApp();
await app.start();
try {
  await addNote(app.services, 'CQRS keeps commands and queries separate.');
  console.log(await readNotes(app.services));
} finally {
  await app.stop();
}
