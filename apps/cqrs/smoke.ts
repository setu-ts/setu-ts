import { addAndRead, createCqrsApp } from './src/app.ts';

const app = createCqrsApp();
await app.start();
try {
  const notes = await addAndRead(app, 'separate buses');
  if (notes.length !== 1 || notes[0] !== 'separate buses') {
    throw new Error('The query bus did not read the mutation made through the command bus.');
  }
} finally {
  await app.stop();
}
