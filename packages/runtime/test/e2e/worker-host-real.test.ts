/**
 * E2E: spawns a REAL Deno web worker through the runtime's worker host and
 * round-trips the shared protocol against the echo-task fixture (which wires
 * itself with `defineWorkerTask`).
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { WorkerTaskReply } from '@setu-ts/common';
import { isWorkerReadySignal, isWorkerTaskReply } from '@setu-ts/common';
import { createWebWorkerHost } from '../../src/adapters/shared/web-worker-host.ts';

const echoTaskUrl = new URL('../fixtures/echo-task.ts', import.meta.url).href;

describe('web worker host — real worker round-trip', () => {
  it('should spawn the fixture, receive ready, and correlate a task reply', async () => {
    const host = createWebWorkerHost();
    const handle = host.spawn(echoTaskUrl);
    try {
      const reply = await new Promise<WorkerTaskReply>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for worker reply')),
          10_000,
        );
        handle.onError((error) => {
          clearTimeout(timer);
          reject(error);
        });
        handle.onMessage((message) => {
          if (isWorkerReadySignal(message)) {
            handle.postMessage({ __hewp: 1, kind: 'task', id: 99, input: { n: 21 } });
            return;
          }
          if (isWorkerTaskReply(message)) {
            clearTimeout(timer);
            resolve(message);
          }
        });
      });

      expect(reply.id).toBe(99);
      expect(reply.ok).toBe(true);
      expect(reply.result).toEqual({ doubled: 42, from: 'worker' });
    } finally {
      await handle.terminate();
    }
  });
});
