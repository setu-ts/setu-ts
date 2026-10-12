import { CAPABILITIES } from '@setu-ts/common';
import type { IWorkerPool } from '@setu-ts/common';
import { createWorkerPoolApp } from './src/app.ts';

const spinModule = new URL('./tasks/spin.ts', import.meta.url).href;
const fillModule = new URL('./tasks/fill.ts', import.meta.url).href;
const app = createWorkerPoolApp();
await app.start();
try {
  const pool = app.services.get<IWorkerPool>(CAPABILITIES.WORKER_POOL);
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
  }, 10);
  try {
    await pool.run(spinModule, 300);
  } finally {
    clearInterval(timer);
  }
  if (ticks < 5) throw new Error(`CPU work blocked main-thread ticks: ${ticks}`);

  const order: string[] = [];
  const spins = Array.from({ length: 5 }, (_, index) =>
    pool.run(spinModule, 30).then(() => {
      order.push(`spin-${index}`);
    }));
  const shared = new SharedArrayBuffer(1024);
  const fill = pool.run(fillModule, { buf: shared, pattern: 0x5a }).then(() => {
    order.push('fill');
  });
  await Promise.all([...spins, fill]);
  if (order.indexOf('fill') >= order.indexOf('spin-4')) {
    throw new Error(`A second module starved behind the spin queue: ${order.join(', ')}`);
  }
  if (!new Uint8Array(shared).every((byte) => byte === 0x5a)) {
    throw new Error('Worker writes to a SharedArrayBuffer were not visible to its caller.');
  }
  const copied = new ArrayBuffer(1024);
  const copiedLength = await pool.run<{ buf: ArrayBuffer; pattern: number }, number>(
    fillModule,
    { buf: copied, pattern: 0x5a },
  );
  if (copiedLength !== copied.byteLength || !new Uint8Array(copied).every((byte) => byte === 0)) {
    throw new Error('ArrayBuffer control was not copied into the worker.');
  }
  const health = await app.inject({ method: 'GET', url: '/health' });
  const payload = health.json<
    { checks: Record<string, { data: { budget: { maxWorkers: number; workers: number } } }> }
  >();
  const budget = payload.checks['worker-pool'].data.budget;
  if (health.statusCode !== 200 || budget.maxWorkers !== 1 || budget.workers > 1) {
    throw new Error(`Health budget does not match the configured cap: ${JSON.stringify(budget)}`);
  }
} finally {
  await app.stop();
}
