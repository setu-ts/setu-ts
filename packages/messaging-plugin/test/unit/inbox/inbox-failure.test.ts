/**
 * Failures, counting and parking (M108 §3.8).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ILogger, MessageMetadata } from '@setu-ts/common';
import { IntegrationEventRejectedError } from '../../../src/index.ts';
import { deriveInboxIds } from '../../../src/inbox/inbox-key.ts';
import {
  errorKind,
  InboxService,
  type InboxSubscription,
} from '../../../src/inbox/inbox-service.ts';
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

/** A service whose handler always throws `boom`. */
function failing(overrides: Parameters<typeof options>[0] = {}) {
  const store = new FakeInboxStore();
  const warnings: string[] = [];
  const logged: Record<string, unknown>[] = [];
  const logger = {
    warn: (message: string, meta?: Record<string, unknown>) => {
      warnings.push(message);
      logged.push(meta ?? {});
    },
  } as unknown as ILogger;
  const service = new InboxService({
    runtime: inboxRuntime(),
    options: options(overrides),
    logger: () => logger,
  });
  service.activate(store);
  const boom = new Error('handler failed');
  const subscription: InboxSubscription<Hired> = {
    consumer: 'payroll',
    definition: hired,
    handler: () => {
      throw boom;
    },
  };
  return { store, service, boom, subscription, warnings, logged };
}

async function idsOf(envelopeId: string) {
  return await deriveInboxIds(crypto.subtle, 'payroll', 'people.hired.v1', envelopeId);
}

describe('inbox failures', () => {
  it('without maxAttempts, rethrows and records nothing', async () => {
    const { store, service, boom, subscription } = failing();
    await expect(service.deliver(subscription, envelope('e-1'), metadata)).rejects.toBe(boom);
    expect(store.rows.size).toBe(0);
    expect(store.calls).not.toContain('recordFailure');
  });

  it('counts each failure, then parks at the limit and acknowledges', async () => {
    const { store, service, boom, subscription, warnings } = failing({ maxAttempts: 3 });
    await expect(service.deliver(subscription, envelope('e-1'), metadata)).rejects.toBe(boom);
    await expect(service.deliver(subscription, envelope('e-1'), metadata)).rejects.toBe(boom);
    await service.deliver(subscription, envelope('e-1'), metadata);

    const ids = await idsOf('e-1');
    const parked = store.rows.get(ids.marker);
    expect(parked).toMatchObject({
      status: 'parked',
      attempts: 3,
      consumer: 'payroll',
      envelopeId: 'e-1',
      envelope: JSON.stringify(envelope('e-1')),
    });
    expect(parked?.lastError).toContain('handler failed');
    expect(store.rows.get(ids.attempts)?.attempts).toBe(3);
    expect(warnings).toEqual(['inbox: parked a delivery after repeated failures']);

    // Every later redelivery is skipped by the pre-read.
    await service.deliver(subscription, envelope('e-1'), metadata);
  });

  it('parks a parse rejection at once when maxAttempts is set', async () => {
    const { store, service, subscription, warnings } = failing({ maxAttempts: 5 });
    await service.deliver(subscription, envelope('e-1', { personId: 7 }), metadata);
    expect(warnings).toEqual(['inbox: parked a delivery whose payload the definition rejected']);
    const parked = store.rows.get((await idsOf('e-1')).marker);
    expect(parked).toMatchObject({ status: 'parked', attempts: 1 });
    expect(parked?.lastError).toContain('parse');
    expect(store.calls).not.toContain('recordFailure');
  });

  it('throws a parse rejection unchanged when maxAttempts is absent', async () => {
    const { store, service, subscription } = failing();
    const error = await service.deliver(subscription, envelope('e-1', { personId: 7 }), metadata)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IntegrationEventRejectedError);
    expect((error as IntegrationEventRejectedError).reason).toBe('parse');
    expect(store.rows.size).toBe(0);
  });

  it('rethrows the original error when recording the failure fails or times out', async () => {
    const { store, service, boom, subscription, warnings } = failing({
      maxAttempts: 2,
      storeTimeoutMs: 20,
    });
    store.recordFailure$ = () => Promise.reject(new Error('db down'));
    await expect(service.deliver(subscription, envelope('e-1'), metadata)).rejects.toBe(boom);
    store.recordFailure$ = () => never();
    await expect(service.deliver(subscription, envelope('e-1'), metadata)).rejects.toBe(boom);
    expect(warnings).toEqual([
      'inbox: recording a delivery failure failed',
      'inbox: recording a delivery failure failed',
    ]);
  });

  it('rethrows the original error when parking fails', async () => {
    const { store, service, boom, subscription, warnings } = failing({ maxAttempts: 1 });
    store.park$ = () => Promise.reject(new Error('db down'));
    await expect(service.deliver(subscription, envelope('e-1'), metadata)).rejects.toBe(boom);
    expect(warnings).toEqual(['inbox: parking a delivery failed']);
  });

  it('logs a failed store write by its error class only, never the driver message', async () => {
    // A driver error quoting its bound parameters (Drizzle's shape): the
    // envelope id, the handler's error text and the parked payload.
    class DrizzleQueryError extends Error {
      override readonly name = 'DrizzleQueryError';
    }
    const leak = 'params: e-1,handler failed,{"personId":"secret-person"}';
    const { store, service, subscription, logged } = failing({ maxAttempts: 1 });
    store.park$ = () => Promise.reject(new DrizzleQueryError(leak));
    await expect(service.deliver(subscription, envelope('e-1'), metadata)).rejects.toThrow();
    const second = failing({ maxAttempts: 2 });
    second.store.recordFailure$ = () => Promise.reject(new DrizzleQueryError(leak));
    await expect(second.service.deliver(second.subscription, envelope('e-1'), metadata)).rejects
      .toThrow();
    for (const meta of [...logged, ...second.logged]) {
      expect(meta.errorKind).toBe('DrizzleQueryError');
      expect(JSON.stringify(meta)).not.toContain('secret-person');
      expect(JSON.stringify(meta)).not.toContain('params:');
    }
    expect(logged.length + second.logged.length).toBe(2);
  });

  it('acknowledges when park finds a marker already present', async () => {
    const { store, service, subscription, warnings } = failing({ maxAttempts: 1 });
    store.park$ = () => Promise.resolve('exists');
    await service.deliver(subscription, envelope('e-1'), metadata);
    // Nothing was parked, so nothing is reported as parked.
    expect(warnings).toEqual([]);
  });

  it('parks without the envelope when it exceeds the cap, or the cap is 0', async () => {
    for (const cap of [10, 0]) {
      const { store, service, subscription } = failing({
        maxAttempts: 1,
        maxParkedEnvelopeBytes: cap,
      });
      await service.deliver(subscription, envelope('e-1'), metadata);
      const parked = store.rows.get((await idsOf('e-1')).marker);
      expect(parked?.status).toBe('parked');
      expect(parked && 'envelope' in parked).toBe(false);
    }
  });

  it('parks without the envelope when it cannot be serialized', async () => {
    const { store, service, subscription } = failing({ maxAttempts: 1 });
    const raw = { ...envelope('e-1'), big: 1n };
    await service.deliver(subscription, raw, metadata);
    const parked = store.rows.get((await idsOf('e-1')).marker);
    expect(parked?.status).toBe('parked');
    expect(parked && 'envelope' in parked).toBe(false);
  });

  it('cuts a long error line to 1024 characters', async () => {
    const { store, service, subscription } = failing({ maxAttempts: 1 });
    await service.deliver(
      {
        ...subscription,
        handler: () => {
          throw new Error('x'.repeat(5000));
        },
      },
      envelope('e-1'),
      metadata,
    );
    expect(store.rows.get((await idsOf('e-1')).marker)?.lastError?.length).toBeLessThanOrEqual(
      1024,
    );
  });
});

describe('errorKind', () => {
  it('names an Error by its identifier-shaped name, and nothing else', () => {
    expect(errorKind(new TypeError('quoted data'))).toBe('TypeError');
    const forged = new Error('x');
    forged.name = 'Evil\r\nFORGED level=info';
    expect(errorKind(forged)).toBe('Error');
    const long = new Error('x');
    long.name = 'A'.repeat(65);
    expect(errorKind(long)).toBe('Error');
    const throwing = new Error('x');
    Object.defineProperty(throwing, 'name', {
      get() {
        throw new Error('hostile');
      },
    });
    expect(errorKind(throwing)).toBe('Error');
    const hostileProto = new Proxy({}, {
      getPrototypeOf() {
        throw new Error('hostile');
      },
    });
    expect(errorKind(hostileProto)).toBe('Error');
  });

  it('names a non-Error by its type', () => {
    expect(errorKind('secret text')).toBe('string');
    expect(errorKind(null)).toBe('null');
    expect(errorKind(undefined)).toBe('undefined');
    expect(errorKind({ message: 'secret' })).toBe('object');
  });
});
