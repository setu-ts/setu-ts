import { addAndRead, createCqrsApp } from './src/app.ts';

const app = createCqrsApp();
await app.start();
try {
  const notes = await addAndRead(app, 'separate buses');
  if (notes.length !== 1) {
    throw new Error('The query bus did not read the mutation made through the command bus.');
  }
  // The command handler was built by a FACTORY that resolved the runtime
  // capability, so the note carries the clock it stamped: `<text> @ <ms>`.
  // Asserting the stamp is the proof the dependency arrived at `onInit`.
  const [note] = notes;
  const stamp = note?.split(' @ ');
  if (stamp?.[0] !== 'separate buses' || stamp?.[1] === undefined || stamp[1] === '') {
    throw new Error('The factory-built handler did not resolve the runtime clock.');
  }
  if (!/^\d+$/.test(stamp[1])) {
    throw new Error('The runtime clock the factory resolved was not a millisecond timestamp.');
  }
} finally {
  await app.stop();
}
