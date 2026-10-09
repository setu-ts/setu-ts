/**
 * The delivery path (M108 §3.6): validate, pre-read, parse, create the marker
 * and run the handler in one transaction, and — after ANY rejection — re-read
 * the marker to decide whether the delivery was already handled.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ILogger, InboxRecord, MessageMetadata } from '@setu-ts/common';
import { DuplicateKeyError } from '@setu-ts/common';
import { InboxNotReadyError, IntegrationEventRejectedError } from '../../../src/index.ts';
import { deriveInboxIds } from '../../../src/inbox/inbox-key.ts';
import { InboxService, type InboxSubscription } from '../../../src/inbox/inbox-service.ts';
import type { Hired } from '../../fixtures/inbox.ts';
import {
  envelope,
  FakeInboxStore,
  hired,
  inboxRuntime,
  never,
  options,
} from '../../fixtures/inbox.ts';

const metadata: MessageMetadata = { topic: 'people.hired.v1' };

/** A service over a fresh fake store, recording every handler call. */
function harness(overrides: Parameters<typeof options>[0] = {}) {
  const store = new FakeInboxStore();
  const runtime = inboxRuntime();
  const warnings: Record<string, unknown>[] = [];
  const logger = {
    warn: (_message: string, meta?: Record<string, unknown>) => warnings.push(meta ?? {}),
  } as unknown as ILogger;
  const service = new InboxService({ runtime, options: options(overrides), logger: () => logger });
  service.activate(store);
  const handled: { payload: Hired; scope: unknown }[] = [];
  const subscription: InboxSubscription<Hired> = {
    consumer: 'payroll',
    definition: hired,
    handler: (payload, _envelope, _metadata, scope) => {
      handled.push({ payload, scope });
    },
  };
  return { store, runtime, service, handled, subscription, warnings };
}

/** The marker id `harness` deliveries use for an envelope id. */
async function markerOf(envelopeId: string): Promise<string> {
  return (await deriveInboxIds(crypto.subtle, 'payroll', envelopeId)).marker;
}

describe('inbox delivery', () => {
  it('runs the handler once with the store scope and records a processed marker', async () => {
    const { store, service, handled, subscription } = harness();
    await service.deliver(subscription, envelope('e-1'), metadata);

    expect(handled).toEqual([{ payload: { personId: 'p-1' }, scope: store.scope }]);
    const marker = store.rows.get(await markerOf('e-1')) as InboxRecord;
    expect(marker).toMatchObject({
      kind: 'setu-inbox',
      consumer: 'payroll',
      topic: 'people.hired.v1',
      envelopeId: 'e-1',
      status: 'processed',
      attempts: 0,
      updatedAt: 1_000_000,
    });
    expect(store.calls).toEqual(['find', 'run']);
  });

  it('acknowledges a duplicate after the pre-read, without running the handler', async () => {
    const { store, service, handled, subscription } = harness();
    await service.deliver(subscription, envelope('e-1'), metadata);
    await service.deliver(subscription, envelope('e-1'), metadata);
    expect(handled).toHaveLength(1);
    expect(store.calls).toEqual(['find', 'run', 'find']);
  });

  it('hands the handler the parsed payload and a rebuilt envelope', async () => {
    const { service, subscription } = harness();
    const seen: unknown[] = [];
    await service.deliver(
      {
        ...subscription,
        handler: (payload, delivered) => {
          seen.push(payload, delivered.data, delivered.id);
        },
      },
      envelope('e-1', { personId: 'p-2', extra: true }),
      metadata,
    );
    expect(seen).toEqual([{ personId: 'p-2' }, { personId: 'p-2' }, 'e-1']);
  });

  for (
    const [label, error] of [
      ['a commit-time duplicate', new DuplicateKeyError('dup at commit')],
      ['a write conflict', Object.assign(new Error('WriteConflict'), { code: 112 })],
      ['an unclassified error', new Error('TransactionCanceledException')],
    ] as const
  ) {
    it(`acknowledges ${label} when the re-read finds the marker`, async () => {
      const { store, service, subscription } = harness({ maxAttempts: 3 });
      // Another delivery commits the marker while this one's transaction is open.
      store.beforeCommit = async () => {
        store.rows.set(await markerOf('e-1'), {
          id: await markerOf('e-1'),
          kind: 'setu-inbox',
          consumer: 'payroll',
          topic: 'people.hired.v1',
          status: 'processed',
          attempts: 0,
          updatedAt: 1,
        });
        throw error;
      };
      await service.deliver(subscription, envelope('e-1'), metadata);
      expect(store.calls).toEqual(['find', 'run', 'find']);
    });
  }

  it('treats a business DuplicateKeyError with no marker as the handler failing', async () => {
    const { store, service, subscription } = harness();
    const business = new DuplicateKeyError('Person p-1 exists');
    await expect(
      service.deliver(
        {
          ...subscription,
          handler: () => {
            throw business;
          },
        },
        envelope('e-1'),
        metadata,
      ),
    ).rejects.toBe(business);
    expect(store.rows.size).toBe(0);
  });

  it('rethrows the original error when the re-read itself fails, and warns', async () => {
    const { store, service, subscription, warnings } = harness();
    const boom = new Error('handler failed');
    let reads = 0;
    store.find$ = () => {
      reads += 1;
      return reads === 1 ? Promise.resolve(undefined) : Promise.reject(new Error('db down'));
    };
    await expect(
      service.deliver(
        {
          ...subscription,
          handler: () => {
            throw boom;
          },
        },
        envelope('e-1'),
        metadata,
      ),
    ).rejects.toBe(boom);
    expect(warnings).toHaveLength(1);
  });

  it('refuses a malformed envelope before any inbox work', async () => {
    const { store, service, subscription } = harness();
    await expect(service.deliver(subscription, { id: 7 }, metadata)).rejects.toBeInstanceOf(
      IntegrationEventRejectedError,
    );
    expect(store.calls).toEqual([]);
  });

  it('keys an id the publish-id rule refuses, and stores no envelopeId for it', async () => {
    const { store, service, handled, subscription } = harness();
    const hostile = `x${'\u0000'.repeat(4)}${'y'.repeat(500)}`;
    await service.deliver(subscription, envelope(hostile), metadata);
    expect(handled).toHaveLength(1);
    const marker = store.rows.get(await markerOf(hostile));
    expect(marker?.status).toBe('processed');
    expect(marker && 'envelopeId' in marker).toBe(false);
  });

  it('refuses a delivery before activation and after close', async () => {
    const { service, subscription } = harness();
    const fresh = new InboxService({
      runtime: inboxRuntime(),
      options: options(),
      logger: () => undefined,
    });
    await expect(fresh.deliver(subscription, envelope('e-1'), metadata)).rejects.toBeInstanceOf(
      InboxNotReadyError,
    );
    service.close();
    expect(service.closed).toBe(true);
    expect(service.activeStore()).toBeUndefined();
    await expect(service.deliver(subscription, envelope('e-1'), metadata)).rejects.toThrow(
      'closed',
    );
  });

  it('bounds the pre-read by storeTimeoutMs', async () => {
    const { store, service, handled, subscription } = harness({ storeTimeoutMs: 20 });
    store.find$ = () => never();
    await expect(service.deliver(subscription, envelope('e-1'), metadata)).rejects.toThrow(
      'inbox.storeTimeoutMs',
    );
    expect(handled).toEqual([]);
  });

  it('a throwing logger never changes the outcome', async () => {
    const store = new FakeInboxStore();
    const service = new InboxService({
      runtime: inboxRuntime(),
      options: options(),
      logger: () => {
        throw new Error('logger broken');
      },
    });
    service.activate(store);
    const boom = new Error('handler failed');
    store.find$ = (() => {
      let n = 0;
      return () => (++n === 1 ? Promise.resolve(undefined) : Promise.reject(new Error('down')));
    })();
    await expect(
      service.deliver(
        {
          consumer: 'payroll',
          definition: hired,
          handler: () => {
            throw boom;
          },
        },
        envelope('e-1'),
        metadata,
      ),
    ).rejects.toBe(boom);
  });
});
