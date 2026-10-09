/**
 * Operator listing, release and purge (M108 §3.9, §3.11).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { InboxRecord } from '@setu-ts/common';
import { InboxNotReadyError, InboxRowStateError } from '../../../src/index.ts';
import { InboxService } from '../../../src/inbox/inbox-service.ts';
import { envelope, FakeInboxStore, inboxRuntime, never, options } from '../../fixtures/inbox.ts';

const ROW = 'a'.repeat(64);

/** A parked marker for `ROW`. */
function parked(overrides: Partial<InboxRecord> = {}): InboxRecord {
  return {
    id: ROW,
    kind: 'setu-inbox',
    consumer: 'payroll',
    topic: 'people.hired.v1',
    envelopeId: 'e-1',
    status: 'parked',
    attempts: 3,
    updatedAt: 5,
    lastError: 'boom',
    envelope: JSON.stringify(envelope('e-1')),
    ...overrides,
  };
}

function harness(overrides: Parameters<typeof options>[0] = {}) {
  const store = new FakeInboxStore();
  const runtime = inboxRuntime();
  const service = new InboxService({
    runtime,
    options: options(overrides),
    logger: () => undefined,
  });
  service.activate(store);
  return { store, runtime, service };
}

describe('IInbox.parked', () => {
  it('lists parked deliveries without envelopes', async () => {
    const { store, service } = harness();
    store.rows.set(ROW, parked());
    store.rows.set('b'.repeat(64), parked({ id: 'b'.repeat(64), status: 'processed' }));
    const minimal = parked({ id: 'c'.repeat(64) });
    const { envelopeId: _e, lastError: _l, ...bare } = minimal;
    store.rows.set(minimal.id, bare);

    expect(await service.parked()).toEqual([
      {
        rowId: ROW,
        consumer: 'payroll',
        topic: 'people.hired.v1',
        envelopeId: 'e-1',
        attempts: 3,
        updatedAt: 5,
        lastError: 'boom',
      },
      {
        rowId: 'c'.repeat(64),
        consumer: 'payroll',
        topic: 'people.hired.v1',
        attempts: 3,
        updatedAt: 5,
      },
    ]);
    expect(await service.parked(1)).toHaveLength(1);
  });

  it('refuses an out-of-range limit', async () => {
    const { service } = harness();
    for (const limit of [0, 1001, 1.5, Number.NaN]) {
      await expect(service.parked(limit)).rejects.toBeInstanceOf(RangeError);
    }
  });
});

describe('IInbox.release', () => {
  it('retry deletes the marker and answers the topic and the parsed envelope', async () => {
    const { store, service } = harness();
    store.rows.set(ROW, parked());
    expect(await service.release(ROW, 'retry')).toEqual({
      topic: 'people.hired.v1',
      envelope: envelope('e-1'),
    });
    expect(store.rows.has(ROW)).toBe(false);
  });

  it('retry answers no envelope when none was stored, or it is unreadable', async () => {
    const { store, service } = harness();
    const { envelope: _dropped, ...without } = parked();
    store.rows.set(ROW, without);
    expect(await service.release(ROW, 'retry')).toEqual({ topic: 'people.hired.v1' });
    store.rows.set(ROW, parked({ envelope: '{not json' }));
    expect(await service.release(ROW, 'retry')).toEqual({ topic: 'people.hired.v1' });
  });

  it('discard keeps a discarded marker and answers the topic only', async () => {
    const { store, service, runtime } = harness();
    store.rows.set(ROW, parked());
    expect(await service.release(ROW, 'discard')).toEqual({ topic: 'people.hired.v1' });
    expect(store.rows.get(ROW)).toMatchObject({
      status: 'discarded',
      updatedAt: runtime.clock.now,
    });
  });

  it('refuses a malformed id, a missing marker and one that is not parked', async () => {
    const { store, service } = harness();
    const invalid = await service.release('nope', 'retry').catch((e: unknown) => e);
    expect(invalid).toBeInstanceOf(InboxRowStateError);
    expect((invalid as InboxRowStateError).outcome).toBe('invalid-id');
    expect('status' in (invalid as object)).toBe(false);

    const missing = await service.release(ROW, 'retry').catch((e: unknown) => e);
    expect((missing as InboxRowStateError).outcome).toBe('missing');

    store.rows.set(ROW, parked({ status: 'processed' }));
    const done = await service.release(ROW, 'discard').catch((e: unknown) => e);
    expect(done).toMatchObject({ outcome: 'not-parked', status: 'processed' });
    expect((done as Error).message).toContain('processed');
  });

  it('refuses an unknown action', async () => {
    const { service } = harness();
    await expect(service.release(ROW, 'delete' as never)).rejects.toBeInstanceOf(TypeError);
  });

  it('bounds the store call', async () => {
    const { store, service } = harness({ storeTimeoutMs: 20 });
    store.release$ = () => never();
    await expect(service.release(ROW, 'retry')).rejects.toThrow('inbox.storeTimeoutMs');
  });
});

describe('IInbox.purge', () => {
  it('deletes rows older than retainMs, up to the batch', async () => {
    const { store, service, runtime } = harness({ retainMs: 60_000, purge: { batch: 7 } });
    expect(await service.purge()).toBe(0);
    expect(store.calls).toEqual([`purge:${runtime.clock.now - 60_000}:7`]);
  });

  it('every operator call refuses before activation and after close', async () => {
    const fresh = new InboxService({
      runtime: inboxRuntime(),
      options: options(),
      logger: () => undefined,
    });
    await expect(fresh.purge()).rejects.toBeInstanceOf(InboxNotReadyError);
    await expect(fresh.parked()).rejects.toBeInstanceOf(InboxNotReadyError);
    await expect(fresh.release(ROW, 'retry')).rejects.toBeInstanceOf(InboxNotReadyError);
    const { service } = harness();
    service.close();
    await expect(service.purge()).rejects.toThrow('closed');
  });
});
