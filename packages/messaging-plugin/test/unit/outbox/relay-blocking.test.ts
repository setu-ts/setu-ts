/**
 * Blocking, retries, poison rows and trace re-parenting (M107 §3.7, §3.9):
 * a failed row blocks its key, an unkeyed row is never blocked, the tenant is
 * part of the key, exhausted attempts poison the key, every `invalid-row`
 * cause is refused and never published, and a stored `traceparent` either
 * re-parents the relay span or — anything invalid — starts a ROOT span.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { INVALID_ROW_ERROR } from '../../../src/outbox/relay.ts';
import {
  countingObserver,
  edit,
  outboxHarness,
  recordingTelemetry,
  row,
} from '../../fixtures/outbox.ts';

describe('relay blocking', () => {
  it('a failed row blocks its key; other keys and unkeyed rows still publish', async () => {
    const h = await outboxHarness();
    const failed = await h.write({ key: 'K', n: 1 });
    await h.write({ key: 'K', n: 2 });
    await h.write({ key: 'L', n: 3 });
    await h.write({ n: 4 });
    await edit(h.db, failed, { status: 'failed' });
    await h.sweep();
    expect(h.broker.sequence()).toEqual([3, 4]);
  });

  it('an unkeyed row in backoff delays only itself', async () => {
    const h = await outboxHarness();
    h.broker.behaviour = (call) =>
      (call.message.data as { n: number }).n === 1 ? Promise.reject(new Error('no')) : undefined;
    await h.write({ n: 1 });
    await h.write({ n: 2 });
    await h.sweep();
    expect(h.broker.sequence()).toEqual([2]);
    const first = (await h.db.getRepository<Record<string, unknown>>('Outbox').findAll())
      .find((r) => r.status === 'pending')!;
    expect(first.attempts).toBe(1);
    expect(first.availableAt).toBe((first.createdAt as number) + 1000);
  });

  it('includes the tenant in the key: tenant A poisoned does not block tenant B', async () => {
    const h = await outboxHarness();
    const a = await h.write({ key: 'K', n: 1 }, { tenantId: 'a' });
    await h.write({ key: 'K', n: 2 }, { tenantId: 'a' });
    await h.write({ key: 'K', n: 3 }, { tenantId: 'b' });
    await edit(h.db, a, { status: 'failed' });
    await h.sweep();
    expect(h.broker.sequence()).toEqual([3]);
  });

  it('backs off exponentially to the ceiling and poisons the key at maxAttempts', async () => {
    const observer = countingObserver();
    const h = await outboxHarness({
      observer,
      options: { relay: { maxAttempts: 3, baseBackoffMs: 100, maxBackoffMs: 150 } },
    });
    h.broker.behaviour = () => Promise.reject(new Error('down\nhard'));
    const id = await h.write({ key: 'K', n: 1 });
    await h.write({ key: 'K', n: 2 });
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const before = h.clock.runtime.now();
      await h.sweep();
      const stored = await row(h.db, id);
      expect(stored!.attempts).toBe(attempt);
      delays.push((stored!.availableAt as number) - before);
      h.clock.advanceWall(1000);
    }
    const stored = await row(h.db, id);
    expect(stored!.status).toBe('failed');
    expect(stored!.lastError).toBe('Error: down hard');
    expect(delays).toEqual([100, 150, 150]);
    expect(observer.counts).toEqual({ publishFailed: 3, poisoned: 1 });
    h.broker.behaviour = undefined;
    await h.sweep();
    expect(h.broker.sequence()).toEqual([]); // K stays blocked until released
  });

  it('cuts lastError to 1024 characters', async () => {
    const h = await outboxHarness();
    h.broker.behaviour = () => Promise.reject(new Error('x'.repeat(5000)));
    const id = await h.write({ n: 1 });
    await h.sweep();
    expect(((await row(h.db, id))!.lastError as string).length).toBe(1024);
  });

  const invalid: [string, (id: string) => Record<string, unknown>][] = [
    ['a non-JSON envelope', () => ({ envelope: '{' })],
    ['an envelope id differing from the row id', () => ({ envelope: '{"id":"other"}' })],
    ['an oversized envelope', (id) => ({ envelope: JSON.stringify({ id, pad: 'x'.repeat(300) }) })],
    [
      'a reserved header in the stored options',
      (id) => ({
        options: JSON.stringify({
          orderingKey: 'K',
          deduplicationId: id,
          headers: { 'x-setu-ordering-key': 'evil' },
        }),
      }),
    ],
    [
      'an options.orderingKey that disagrees with its column',
      (id) => ({ options: JSON.stringify({ orderingKey: 'other', deduplicationId: id }) }),
    ],
    ['an empty topic', () => ({ topic: '' })],
    ['a topic with a control character', () => ({ topic: 'orders\u0000.v1' })],
  ];
  for (const [label, change] of invalid) {
    it(`poisons ${label} as invalid-row, never publishing it`, async () => {
      const observer = countingObserver();
      const h = await outboxHarness({ observer, options: { maxEnvelopeBytes: 250 } });
      const id = await h.write({ key: 'K', n: 1 });
      await h.write({ key: 'K', n: 2 });
      await edit(h.db, id, change(id));
      await h.sweep();
      expect(h.broker.calls).toEqual([]);
      const stored = await row(h.db, id);
      expect(stored!.status).toBe('failed');
      expect(stored!.lastError).toBe(INVALID_ROW_ERROR);
      expect(observer.counts).toEqual({ 'poisoned-invalid': 1 });
    });
  }

  it('an invalid-row keeps a sane attempt count when the stored one is not a number', async () => {
    const h = await outboxHarness();
    const id = await h.write({ n: 1 });
    await edit(h.db, id, { topic: '', attempts: 'many' });
    await h.sweep();
    expect((await row(h.db, id))!.attempts).toBe(0);
  });
});

describe('relay trace re-parenting', () => {
  const PARENT = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;

  it('re-parents a row with a valid stored traceparent', async () => {
    const telemetry = recordingTelemetry({
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      traceFlags: '01',
    });
    const h = await outboxHarness({ telemetry });
    await h.write({ n: 1 });
    await h.sweep();
    expect(telemetry.spans).toHaveLength(1);
    expect(telemetry.spans[0]!.name).toBe('outbox relay orders.placed.v1');
    expect(telemetry.spans[0]!.options).toEqual({
      kind: 'internal',
      parentContext: expect.objectContaining({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }),
    });
    expect(h.broker.sequence()).toEqual([1]);
  });

  const roots: [string, unknown][] = [
    ['an absent traceparent', null],
    ['a malformed traceparent', 'not-a-traceparent'],
    ['an all-zero trace id', `00-${'0'.repeat(32)}-${'b'.repeat(16)}-01`],
    ['a non-string traceparent', 42],
  ];
  for (const [label, stored] of roots) {
    it(`starts a ROOT span for ${label}, never one under the active span`, async () => {
      const telemetry = recordingTelemetry();
      const h = await outboxHarness({ telemetry });
      const id = await h.write({ n: 1 });
      await edit(h.db, id, { traceparent: stored });
      await h.sweep();
      expect(telemetry.spans[0]!.options).toEqual({ kind: 'internal', root: true });
      expect(h.broker.sequence()).toEqual([1]);
    });
  }

  it('publishes the stored row as written, keeping its PARENT out of the published options', async () => {
    const h = await outboxHarness({ telemetry: recordingTelemetry() });
    const id = await h.write({ key: 'K', n: 1 });
    await edit(h.db, id, { traceparent: PARENT });
    await h.sweep();
    expect(h.broker.published[0]!.options).toEqual({
      orderingKey: 'K',
      deduplicationId: id,
      headers: {},
    });
  });
});
