/**
 * `QueuePlugin({ processors })` registers in DECLARED order (M86 review).
 *
 * `IQueue.process()` is last-wins on a job name, and the option's own JSDoc
 * documents that two entries under one name behave exactly as two imperative
 * `process()` calls would. Splitting the arms registered every instance before
 * every factory, so `[factoryA, instanceB]` on one name resolved to
 * **factoryA** — the reverse of what the declared array says, and a processor
 * the developer had replaced still running the jobs.
 *
 * Driven through a REAL kernel application and a real memory queue, because
 * the winner is only observable by dispatching a job.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES, type IQueue } from '@setu-ts/common';
import { QueuePlugin } from '../../src/plugin/queue-plugin.ts';

/** Polls until `predicate` holds or the budget elapses. */
async function waitFor(predicate: () => boolean, budgetMs = 3000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('QueuePlugin({ processors }) declared order', () => {
  it('a trailing INSTANCE beats a leading FACTORY on one job name', async () => {
    const ran: string[] = [];
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        QueuePlugin({
          adapter: 'memory',
          pollIntervalMs: 5,
          processors: [
            // Declared FIRST, so under last-wins it must LOSE.
            () => ({
              name: 'work',
              processor: (): void => {
                ran.push('factoryA');
              },
            }),
            // Declared LAST, so it must WIN.
            {
              name: 'work',
              processor: (): void => {
                ran.push('instanceB');
              },
            },
          ],
        }),
      ],
    });
    await app.start();

    const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
    await queue.add('work', {});
    await waitFor(() => ran.length > 0);

    expect(ran).toEqual(['instanceB']);
    await app.stop();
  });

  it('a trailing FACTORY beats a leading INSTANCE on one job name', async () => {
    const ran: string[] = [];
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        QueuePlugin({
          adapter: 'memory',
          pollIntervalMs: 5,
          processors: [
            {
              name: 'work',
              processor: (): void => {
                ran.push('instanceA');
              },
            },
            () => ({
              name: 'work',
              processor: (): void => {
                ran.push('factoryB');
              },
            }),
          ],
        }),
      ],
    });
    await app.start();

    const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
    await queue.add('work', {});
    await waitFor(() => ran.length > 0);

    expect(ran).toEqual(['factoryB']);
    await app.stop();
  });
});
