import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ISqsTransport } from '../../../src/adapters/sqs-queue.ts';
import { SqsQueue } from '../../../src/adapters/sqs-queue.ts';
import { FakeRuntimeServices } from '../../fixtures/fake-runtime.ts';

function makeTransport(isHealthy?: () => Promise<boolean>): ISqsTransport {
  const transport: Record<string, unknown> = {
    send: () => Promise.resolve(),
    receive: () => Promise.resolve([]),
    delete: () => Promise.resolve(),
    changeVisibility: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  if (isHealthy !== undefined) {
    transport.isHealthy = isHealthy;
  }
  return transport as unknown as ISqsTransport;
}

const OPTIONS = { queues: { jobs: 'https://sqs/jobs' } };

describe('SqsQueue health (M70c)', () => {
  it('delegates to the transport isHealthy when present (true)', async () => {
    let calls = 0;
    const queue = new SqsQueue(
      new FakeRuntimeServices(),
      {
        ...OPTIONS,
        client: makeTransport(() => {
          calls++;
          return Promise.resolve(true);
        }),
      },
    );
    await queue.connect();
    const probe = queue.isHealthy;
    expect(typeof probe).toBe('function');
    if (typeof probe === 'function') {
      expect(await probe()).toBe(true);
    }
    expect(calls).toBe(1);
  });

  it('delegates to the transport isHealthy when present (false)', async () => {
    const queue = new SqsQueue(
      new FakeRuntimeServices(),
      { ...OPTIONS, client: makeTransport(() => Promise.resolve(false)) },
    );
    await queue.connect();
    const probe = queue.isHealthy;
    expect(typeof probe).toBe('function');
    if (typeof probe === 'function') {
      expect(await probe()).toBe(false);
    }
  });

  it('reports unknown (absent isHealthy) when the transport omits it', async () => {
    const queue = new SqsQueue(new FakeRuntimeServices(), { ...OPTIONS, client: makeTransport() });
    await queue.connect();
    // A minimal injected transport has not told us the queue is dead: absence,
    // not false, keeps /ready from failing on upgrade.
    expect(queue.isHealthy).toBeUndefined();
  });

  it('reports unknown after disconnect', async () => {
    const queue = new SqsQueue(
      new FakeRuntimeServices(),
      { ...OPTIONS, client: makeTransport(() => Promise.resolve(true)) },
    );
    await queue.connect();
    expect(typeof queue.isHealthy).toBe('function');
    await queue.disconnect();
    expect(queue.isHealthy).toBeUndefined();
  });
});
