/**
 * Releases a test file's port claims once the file has finished.
 *
 * Vitest ends each worker with a signal, so a `process.on('exit')` handler never
 * runs there. A setup file's `afterAll` is registered before the file's own hooks
 * and therefore runs after them, when every server the file started is stopped.
 *
 * @module
 */
import { afterAll } from 'vitest';

import { releaseTestPorts } from '../node-helpers.ts';

afterAll(() => {
  releaseTestPorts();
});
