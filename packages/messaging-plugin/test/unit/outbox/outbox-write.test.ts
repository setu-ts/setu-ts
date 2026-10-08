/**
 * `IOutbox.write` (M107 §3.5): the row commits with the business change and
 * rolls back with it, an oversized envelope is refused before `append`, the
 * active trace is captured, and every refusal is a REJECTED promise.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { EntityKey } from '@setu-ts/common';
import { OUTBOX_RECORD_KIND } from '@setu-ts/common';

import { OutboxEnvelopeTooLargeError, OutboxNotReadyError } from '../../../src/outbox/errors.ts';
import { resolveOutboxOptions } from '../../../src/outbox/options.ts';
import { OutboxService } from '../../../src/outbox/outbox-service.ts';
import {
  FakeOutboxBroker,
  memoryOutbox,
  orderPlaced,
  outboxClock,
  outboxHarness,
  recordingTelemetry,
  row,
  rows,
  WALL_START,
} from '../../fixtures/outbox.ts';

const TRACE = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: '01' };

describe('IOutbox.write', () => {
  it('stores one pending row whose id, key and options are the effective ones', async () => {
    const h = await outboxHarness();
    const id = await h.write({ key: 'order-1', n: 1 }, {
      metadata: { aggregateId: 'order-1', aggregateVersion: 3 },
      options: { headers: { 'x-source': 'test' } },
    });
    const stored = await row(h.db, id);
    expect(stored).not.toBeNull();
    expect(stored!.kind).toBe(OUTBOX_RECORD_KIND);
    expect(stored!.status).toBe('pending');
    expect(stored!.topic).toBe('orders.placed.v1');
    expect(stored!.orderingKey).toBe('order-1');
    expect(stored!.createdAt).toBe(WALL_START);
    expect(stored!.availableAt).toBe(WALL_START);
    expect(stored!.attempts).toBe(0);
    expect(stored!.tenantId).toBeNull();
    expect(stored!.traceparent).toBeNull();
    const envelope = JSON.parse(stored!.envelope as string);
    expect(envelope.id).toBe(id);
    expect(envelope.aggregateVersion).toBe(3);
    expect(JSON.parse(stored!.options as string)).toEqual({
      orderingKey: 'order-1',
      deduplicationId: id,
      headers: { 'x-source': 'test' },
    });
    expect(stored!.position).toBe(`00${WALL_START}${id.replaceAll('-', '')}`);
  });

  it('commits with the business row and rolls back with it', async () => {
    const h = await outboxHarness();
    const business = h.db.getRepository<Record<string, unknown>, EntityKey>('Order');
    await h.db.transaction(async (uow) => {
      await uow.getRepository<Record<string, unknown>, EntityKey>('Order').create({ id: 'o-1' });
      await h.service.write(uow, orderPlaced, { n: 1 });
    });
    await expect(
      h.db.transaction(async (uow) => {
        await uow.getRepository<Record<string, unknown>, EntityKey>('Order').create({ id: 'o-2' });
        await h.service.write(uow, orderPlaced, { n: 2 });
        throw new Error('business rule failed');
      }),
    ).rejects.toThrow('business rule failed');
    expect((await business.findAll()).map((r) => r.id)).toEqual(['o-1']);
    expect((await rows(h.db)).map((r) => JSON.parse(r.envelope as string).data.n)).toEqual([1]);
  });

  it('refuses an oversized envelope before append, rolling the transaction back', async () => {
    const h = await outboxHarness({ options: { maxEnvelopeBytes: 300 } });
    const rejection = h.write({ n: 1, key: 'x'.repeat(100) }, {
      metadata: { correlationId: 'c'.repeat(400) },
    });
    await expect(rejection).rejects.toBeInstanceOf(OutboxEnvelopeTooLargeError);
    expect(h.store.count('append')).toBe(0);
    expect(await rows(h.db)).toEqual([]);
  });

  it('captures the active trace as traceparent', async () => {
    const h = await outboxHarness({ telemetry: recordingTelemetry(TRACE) });
    const id = await h.write({ n: 1 });
    expect((await row(h.db, id))!.traceparent).toBe(`00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`);
  });

  it('stores no traceparent when nothing is active or the context is invalid', async () => {
    const none = await outboxHarness({ telemetry: recordingTelemetry(undefined) });
    expect((await row(none.db, await none.write({ n: 1 })))!.traceparent).toBeNull();
    const zero = await outboxHarness({
      telemetry: recordingTelemetry({
        traceId: '0'.repeat(32),
        spanId: '1'.repeat(16),
        traceFlags: '01',
      }),
    });
    expect((await row(zero.db, await zero.write({ n: 1 })))!.traceparent).toBeNull();
  });

  it('rejects (never throws) before the service is activated', async () => {
    const { db, store } = await memoryOutbox();
    const clock = outboxClock();
    const service = new OutboxService({
      runtime: clock.runtime,
      broker: new FakeOutboxBroker(),
      options: resolveOutboxOptions({ store }),
    });
    let result: Promise<string> | undefined;
    await db.transaction(async (uow) => {
      result = service.write(uow, orderPlaced, { n: 1 });
      await result.catch(() => {});
    });
    await expect(result!).rejects.toBeInstanceOf(OutboxNotReadyError);
    await expect(service.sweep()).rejects.toBeInstanceOf(OutboxNotReadyError);
    await expect(service.purge()).rejects.toBeInstanceOf(OutboxNotReadyError);
    await expect(service.release('id', 'retry')).rejects.toBeInstanceOf(OutboxNotReadyError);
    service.dispatch(); // a no-op, never a throw
    expect(store.calls).toEqual([]);
  });

  it('rejects invalid options, an undefined payload and a bad tenant id', async () => {
    const h = await outboxHarness();
    const call = (fn: () => Promise<string>) => {
      const promise = fn();
      expect(promise).toBeInstanceOf(Promise);
      return promise;
    };
    await expect(call(() => h.write({ n: 1 }, { options: { headers: { traceparent: 'x' } } })))
      .rejects.toThrow(RangeError);
    await expect(
      call(() => h.db.transaction((uow) => h.service.write(uow, orderPlaced, undefined as never))),
    ).rejects.toThrow(TypeError);
    await expect(call(() => h.write({ n: 1 }, { tenantId: ' padded' }))).rejects.toThrow(
      'tenantId must be a valid id',
    );
    expect(h.store.count('append')).toBe(0);
  });

  it('records the tenant with a single store', async () => {
    const h = await outboxHarness();
    const id = await h.write({ n: 1 }, { tenantId: 'acme' });
    expect((await row(h.db, id))!.tenantId).toBe('acme');
  });
});
