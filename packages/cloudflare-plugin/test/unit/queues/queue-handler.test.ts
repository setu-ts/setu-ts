/**
 * The `queue` export resolves its queue from the application registry, so the
 * processors registered anywhere in the app are the ones a batch reaches.
 *
 * Resolution is deliberately per-invocation rather than at factory time: an
 * application builds its module exports before `start()` has registered
 * anything.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import type { IApplication, IPlugin, IQueue } from '@setu-ts/common';

import { CloudflareUnsupportedError } from '../../../src/errors.ts';
import { createQueueHandler } from '../../../src/queues/queue-handler.ts';
import { WorkersQueue } from '../../../src/queues/workers-queue.ts';
import { FakeQueueBatch, FakeQueueMessage, FakeQueueProducer, SequentialIds } from '../../fakes.ts';

/** Registers a service under a token through a real plugin. */
function providing(token: string, service: object): IPlugin {
  return {
    name: `provider-${token}`,
    version: '0.0.0',
    provides: [token],
    register(ctx): void {
      ctx.services.register(token, service);
    },
  };
}

/** An app whose registry carries `queue` (or a named instance). */
async function appWith(token: string, service: object): Promise<IApplication> {
  const app = createApplication({ plugins: [RuntimePlugin(), providing(token, service)] });
  await app.start();
  return app;
}

describe('createQueueHandler', () => {
  it('dispatches a batch into the queue registered under the bare token', async () => {
    const queue = new WorkersQueue(new FakeQueueProducer(), new SequentialIds());
    const app = await appWith(CAPABILITIES.QUEUE, queue);

    const seen: unknown[] = [];
    queue.process<string>('greet', (job) => {
      seen.push(job.data);
    });

    const handler = createQueueHandler(app);
    const message = new FakeQueueMessage('cf-1', { v: 1, name: 'greet', id: 'i', data: 'hi' });
    await handler(new FakeQueueBatch('jobs', [message]));

    expect(seen).toEqual(['hi']);
    expect(message.disposition).toBe('acked');
    await app.stop();
  });

  it('resolves the derived token for a named instance', async () => {
    const queue = new WorkersQueue(new FakeQueueProducer(), new SequentialIds());
    const app = await appWith('queue.reports', queue);

    let ran = false;
    queue.process('build', () => {
      ran = true;
    });

    const handler = createQueueHandler(app, { name: 'reports' });
    await handler(
      new FakeQueueBatch('reports', [
        new FakeQueueMessage('cf-1', { v: 1, name: 'build', id: 'i', data: null }),
      ]),
    );

    expect(ran).toBe(true);
    await app.stop();
  });

  it("treats an explicit name of 'default' as the bare token", async () => {
    const queue = new WorkersQueue(new FakeQueueProducer(), new SequentialIds());
    const app = await appWith(CAPABILITIES.QUEUE, queue);

    let ran = false;
    queue.process('j', () => {
      ran = true;
    });

    await createQueueHandler(app, { name: 'default' })(
      new FakeQueueBatch('q', [
        new FakeQueueMessage('cf-1', { v: 1, name: 'j', id: 'i', data: null }),
      ]),
    );

    expect(ran).toBe(true);
    await app.stop();
  });

  it('resolves lazily, so the export can be built before start()', async () => {
    const queue = new WorkersQueue(new FakeQueueProducer(), new SequentialIds());
    const app = createApplication({
      plugins: [RuntimePlugin(), providing(CAPABILITIES.QUEUE, queue)],
    });

    // Built first — nothing is registered yet, and this must not throw.
    const handler = createQueueHandler(app);

    await app.start();
    let ran = false;
    queue.process('j', () => {
      ran = true;
    });

    await handler(
      new FakeQueueBatch('q', [
        new FakeQueueMessage('cf-1', { v: 1, name: 'j', id: 'i', data: null }),
      ]),
    );

    expect(ran).toBe(true);
    await app.stop();
  });

  it('throws naming the token when the registered IQueue is not a WorkersQueue', async () => {
    // A memory or Redis queue has no batch to dispatch, so silently returning
    // would drop every delivered message.
    const foreign: IQueue = {
      add: () => Promise.resolve('x'),
      process: () => {},
      addRecurring: () => Promise.resolve(),
    };
    const app = await appWith(CAPABILITIES.QUEUE, foreign);

    const handler = createQueueHandler(app);
    const message = new FakeQueueMessage('cf-1', { v: 1, name: 'j', id: 'i', data: null });

    // REJECTS rather than throwing synchronously: the handler is declared
    // `=> Promise<void>` and is assigned straight to the Worker's `queue`
    // export, so `handler(b).catch(report)` has to be able to see this.
    await expect(handler(new FakeQueueBatch('q', [message])))
      .rejects.toBeInstanceOf(CloudflareUnsupportedError);
    await expect(handler(new FakeQueueBatch('q', [message]))).rejects.toThrow(/'queue'/);
    // The message is left unsettled rather than wrongly acked.
    expect(message.disposition).toBe('unsettled');
    await app.stop();
  });

  it('rejects rather than throwing when no queue is registered at all', async () => {
    const app = createApplication({ plugins: [RuntimePlugin()] });
    await app.start();

    // The registry throws synchronously; the handler must still surface it as
    // a rejection, not an exception escaping the promise contract.
    const pending = createQueueHandler(app)(new FakeQueueBatch('q', []));
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).rejects.toThrow();
    await app.stop();
  });
});
