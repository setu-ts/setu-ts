import { describe, expect, it, vi } from 'vitest';
import { SqsQueue } from '../../src/adapters/sqs-queue.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';
import { sqsHarness, envelope } from '../fixtures/sqs-harness.ts';

describe('SQS delivery leases', () => {
  it.each([0, -1, 1.5, NaN, Infinity, 43_201])('refuses visibilityTimeoutSeconds=%s', (value) => {
    expect(
      () =>
        new SqsQueue(new FakeRuntimeServices(0), { queues: {}, visibilityTimeoutSeconds: value }),
    ).toThrow(/visibilityTimeoutSeconds/);
  });
  it.each([0, NaN, 1.5])('validates the consumer maxAttempts default %s', (maxAttempts) => {
    expect(
      () => new SqsQueue(new FakeRuntimeServices(0), { queues: {} }, undefined, { maxAttempts }),
    ).toThrow(RangeError);
  });
  it('renews a receipt across three visibility windows and deletes it once', async () => {
    const { queue, runtime, transport } = await sqsHarness();
    await transport.send('source', envelope());
    const [job] = await queue.reserve('build', 1, 0);
    expect(queue.claimRenewal.intervalMs).toBe(1000);
    for (let tick = 0; tick < 10; tick++) {
      await runtime.advanceMs(1000);
      expect(await queue.claimRenewal.extend('build', job!.id, job!.claimToken!)).toBe(true);
      expect(await queue.reserve('build', 1, runtime.now())).toEqual([]);
    }
    await queue.ack('build', job!.id, job!.claimToken!);
    expect(transport.deleted).toHaveLength(1);
    expect(transport.depth('source')).toBe(0);
    await queue.disconnect();
    expect(runtime.timerCount).toBe(0);
  });
  it('refuses absent, wrong-name, mismatched, expired and disconnected renewals', async () => {
    const { queue, runtime, transport } = await sqsHarness();
    await transport.send('source', envelope());
    const [job] = await queue.reserve('build', 1, 0);
    expect(await queue.claimRenewal.extend('build', 'absent', 'token')).toBe(false);
    expect(await queue.claimRenewal.extend('other', 'j1', job!.claimToken!)).toBe(false);
    expect(await queue.claimRenewal.extend('build', 'j1', 'bad')).toBe(false);
    await runtime.advanceMs(3000);
    expect(await queue.claimRenewal.extend('build', 'j1', job!.claimToken!)).toBe(false);
    expect(transport.visibilityChanges).toHaveLength(0);
    await queue.disconnect();
    expect(await queue.claimRenewal.extend('build', 'j1', job!.claimToken!)).toBe(false);
  });
  it('does not revive or erase a redelivery while a renewal or settle is pending', async () => {
    for (const operation of ['renew', 'ack', 'requeue', 'deadLetter'] as const) {
      const { queue, transport, runtime } = await sqsHarness();
      await transport.send('source', envelope());
      const [first] = await queue.reserve('build', 1, 0);
      const gate = Promise.withResolvers<void>();
      if (operation === 'renew' || operation === 'requeue')
        vi.spyOn(transport, 'changeVisibility').mockReturnValueOnce(gate.promise);
      else vi.spyOn(transport, 'delete').mockReturnValueOnce(gate.promise);
      const pending =
        operation === 'renew'
          ? queue.claimRenewal.extend('build', 'j1', first!.claimToken!)
          : operation === 'ack'
            ? queue.ack('build', 'j1', first!.claimToken!)
            : operation === 'requeue'
              ? queue.requeue('build', 'j1', 0, 1, first!.claimToken!)
              : queue.deadLetter('build', 'j1', 0, first!.claimToken!);
      // Allow the terminal forward to reach its delete.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      await runtime.advanceMs(3000);
      const [second] = await queue.reserve('build', 1, runtime.now());
      expect(second!.claimToken).not.toBe(first!.claimToken);
      gate.resolve();
      if (operation === 'renew') expect(await pending).toBe(false);
      else await pending;
      await queue.ack('build', 'j1', second!.claimToken!);
      expect(transport.depth('source')).toBe(0);
      await queue.disconnect();
    }
  });
  it('caps renewal at twelve hours per receive, then resets on redelivery', async () => {
    const { queue, runtime, transport } = await sqsHarness({ visibilityTimeoutSeconds: 43_200 });
    await transport.send('source', envelope());
    const [first] = await queue.reserve('build', 1, 0);
    await runtime.advanceMs(43_190_000);
    expect(await queue.claimRenewal.extend('build', 'j1', first!.claimToken!)).toBe(true);
    expect(transport.visibilityChanges.at(-1)?.seconds).toBe(10);
    await runtime.advanceMs(10_000);
    const calls = transport.visibilityChanges.length;
    expect(await queue.claimRenewal.extend('build', 'j1', first!.claimToken!)).toBe(false);
    expect(transport.visibilityChanges).toHaveLength(calls);
    const [second] = await queue.reserve('build', 1, runtime.now());
    expect(await queue.claimRenewal.extend('build', 'j1', second!.claimToken!)).toBe(true);
    expect(transport.visibilityChanges.at(-1)?.seconds).toBe(43_200);
    await queue.disconnect();
  });
  it('returns false on transport rejection and can recover before expiry', async () => {
    const { queue, transport } = await sqsHarness();
    await transport.send('source', envelope());
    const [job] = await queue.reserve('build', 1, 0);
    vi.spyOn(transport, 'changeVisibility').mockRejectedValueOnce(new Error('unavailable'));
    expect(await queue.claimRenewal.extend('build', 'j1', job!.claimToken!)).toBe(false);
    expect(await queue.claimRenewal.extend('build', 'j1', job!.claimToken!)).toBe(true);
    await queue.disconnect();
  });
  it.each(['ack', 'requeue', 'deadLetter'] as const)(
    '%s throws for absent, mismatched and expired receipts',
    async (kind) => {
      const { queue, transport, runtime } = await sqsHarness();
      const settle = (id: string, token: string) =>
        kind === 'ack'
          ? queue.ack('build', id, token)
          : kind === 'requeue'
            ? queue.requeue('build', id, 0, 1, token)
            : queue.deadLetter('build', id, 0, token);
      await expect(settle('missing', 'token')).rejects.toThrow('queue job claim is stale');
      await transport.send('source', envelope());
      const [job] = await queue.reserve('build', 1, 0);
      await expect(settle('j1', 'wrong')).rejects.toThrow('queue job claim is stale');
      await runtime.advanceMs(3000);
      await expect(settle('j1', job!.claimToken!)).rejects.toThrow('queue job claim is stale');
      expect(transport.deleted).toEqual([]);
      await queue.disconnect();
    },
  );
});
