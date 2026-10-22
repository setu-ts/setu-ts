import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { CAPABILITIES } from '@setu-ts/common';
import type { IWorkerPool } from '@setu-ts/common';
import type { IKernelApplication } from '@setu-ts/kernel';
import { FILL_TASK, SPIN_TASK } from './src/tasks/index.ts';
import type { FillInput } from './src/tasks/index.ts';
import { createApp } from './setu.config.ts';

const PATTERN = 0x5a;

interface WorkerPoolHealth {
  readonly checks: Record<string, { readonly data: { readonly budget: Budget } }>;
}

interface Budget {
  readonly maxWorkers: number;
  readonly workers: number;
}

describe('worker-pool example', () => {
  let app: IKernelApplication;
  let pool: IWorkerPool;

  before(async () => {
    app = createApp();
    await app.start();
    pool = app.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);
  });

  after(async () => {
    await app.stop();
  });

  it('keeps main-thread timers running during CPU-bound work', async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 10);
    try {
      await pool.run(SPIN_TASK, 300);
    } finally {
      clearInterval(timer);
    }

    assert.ok(ticks >= 5, `only ${ticks} timer ticks ran during the spin`);
  });

  it('lets a second task module through before a queue of the first drains', async () => {
    const order: string[] = [];
    const spins = Array.from({ length: 5 }, (_, index) =>
      pool.run(SPIN_TASK, 30).then(() => order.push(`spin-${index}`)),
    );
    const fill = pool
      .run<FillInput, number>(FILL_TASK, { buf: new SharedArrayBuffer(16), pattern: PATTERN })
      .then(() => order.push('fill'));
    await Promise.all([...spins, fill]);

    assert.ok(order.indexOf('fill') < order.indexOf('spin-4'), order.join(', '));
  });

  it("shows a worker's writes to a SharedArrayBuffer to the caller", async () => {
    const shared = new SharedArrayBuffer(1024);

    await pool.run<FillInput, number>(FILL_TASK, { buf: shared, pattern: PATTERN });

    assert.ok(new Uint8Array(shared).every((byte) => byte === PATTERN));
  });

  it('copies an ordinary ArrayBuffer into the worker', async () => {
    const copied = new ArrayBuffer(1024);

    const written = await pool.run<FillInput, number>(FILL_TASK, { buf: copied, pattern: PATTERN });

    assert.equal(written, copied.byteLength);
    assert.ok(new Uint8Array(copied).every((byte) => byte === 0));
  });

  it('reports the configured worker budget through /health', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    const budget = response.json<WorkerPoolHealth>().checks['worker-pool']?.data.budget;

    assert.equal(response.statusCode, 200);
    assert.equal(budget?.maxWorkers, 1);
    assert.ok((budget?.workers ?? Infinity) <= 1);
  });
});
