/**
 * Integration: a REAL `node:worker_threads` worker that ends its own thread,
 * observed through the DEFAULT `createNodeWorkerHost()` — no injected fake.
 *
 * This is the guarded real path behind X8-7. Every other test of `onExit` runs
 * against an injected worker double, which can be made to emit anything; only a
 * real thread proves the runtime emits it at all. It runs on Deno's `node:`
 * compatibility layer, which is where CI executes.
 *
 * The negative half matters as much as the positive one: a self-terminating
 * worker raises NO `'error'` event, so `onError` alone leaves the task
 * unsettled forever — which is the defect (a permanently leaked pool slot) that
 * `onExit` exists to close.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { isWorkerReadySignal, isWorkerTaskReply } from '@setu-ts/common';
import { createNodeWorkerHost } from '../../src/adapters/node/node-worker-host.ts';

const selfExitingTaskUrl = new URL('../fixtures/self-exiting-task.ts', import.meta.url).href;

describe('node worker host — real self-terminating worker (X8-7)', () => {
  it('should report exit detection before any worker is spawned', () => {
    // The capability query answers at registration time, which is the whole
    // reason it lives on the host rather than being read off a handle.
    expect(createNodeWorkerHost().reportsExit?.()).toBe(true);
  });

  it('should fire onExit for a worker that ends its own thread, with no error', async () => {
    const host = createNodeWorkerHost();
    const handle = host.spawn(selfExitingTaskUrl);

    const errors: Error[] = [];
    handle.onError((error) => errors.push(error));

    const exited = new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for the worker to exit')),
        15_000,
      );
      handle.onExit?.((code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    // Drive one real task through so the worker is genuinely alive and working
    // before it leaves — an exit observed on a worker that never started would
    // prove nothing about the case that leaks a slot.
    const replied = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for the worker reply')),
        15_000,
      );
      handle.onMessage((message) => {
        if (isWorkerReadySignal(message)) {
          handle.postMessage({ __hewp: 1, kind: 'task', id: 7, input: { n: 4 } });
          return;
        }
        if (isWorkerTaskReply(message)) {
          clearTimeout(timer);
          resolve(message.result);
        }
      });
    });

    expect(await replied).toEqual({ doubled: 8 });

    const code = await exited;
    expect(code).toBe(0);
    // A clean self-termination is NOT an error, so nothing reached onError —
    // this is why onError could never have covered X8-7.
    expect(errors).toEqual([]);
  });
});
