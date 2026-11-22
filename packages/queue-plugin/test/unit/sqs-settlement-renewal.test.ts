import { describe, expect, it, vi } from 'vitest';
import { QueueService } from '../../src/services/queue-service.ts';
import { sqsHarness, envelope } from '../fixtures/sqs-harness.ts';

async function drain(): Promise<void> {
  for (let tick = 0; tick < 30; tick++) await Promise.resolve();
}

describe('SQS settlement and renewal ordering', () => {
  it('awaits an in-flight renewal so the retry backoff is the last visibility change', async () => {
    const { queue, transport, runtime } = await sqsHarness();
    await transport.send('source', envelope());
    const [job] = await queue.reserve('build', 1, 0);
    const arrival = Promise.withResolvers<void>();
    const apply = transport.changeVisibility.bind(transport);
    const visibility = vi
      .spyOn(transport, 'changeVisibility')
      .mockImplementationOnce(async (...args) => {
        // Hold the request before it reaches SQS; later arrivals apply immediately.
        await arrival.promise;
        return apply(...args);
      });
    const renewing = queue.claimRenewal.extend('build', job!.id, job!.claimToken!);
    await drain();
    const requeued = queue.requeue('build', job!.id, 1000, 2, job!.claimToken!);
    await drain();
    const sentBeforeRenewalArrived = visibility.mock.calls.map((call) => call[2]);
    arrival.resolve();
    const extended = await renewing;
    await requeued;
    try {
      expect(transport.visibilityChanges.map((call) => call.seconds)).toEqual([3, 1]);
      expect(sentBeforeRenewalArrived).toEqual([3]);
      expect(extended).toBe(true);
      await runtime.advanceMs(1000);
      expect(await queue.reserve('build', 1, runtime.now())).toHaveLength(1);
    } finally {
      await queue.disconnect();
    }
  });

  for (const kind of ['ack', 'requeue', 'deadLetter'] as const) {
    it(`makes no renewal call after ${kind} begins`, async () => {
      const { queue, transport, runtime } = await sqsHarness();
      await transport.send('source', envelope());
      const [job] = await queue.reserve('build', 1, 0);
      const gate = Promise.withResolvers<void>();
      const visibility = vi.spyOn(transport, 'changeVisibility');
      if (kind === 'requeue') visibility.mockReturnValueOnce(gate.promise);
      else vi.spyOn(transport, 'delete').mockReturnValueOnce(gate.promise);
      const settling =
        kind === 'ack'
          ? queue.ack('build', job!.id, job!.claimToken!)
          : kind === 'requeue'
            ? queue.requeue('build', job!.id, 1000, 2, job!.claimToken!)
            : queue.deadLetter('build', job!.id, 0, job!.claimToken!);
      await drain();
      const initiallyExtended = await queue.claimRenewal.extend('build', job!.id, job!.claimToken!);
      await runtime.advanceMs(3000);
      const extended = await queue.claimRenewal.extend('build', job!.id, job!.claimToken!);
      const callsDuringSettle = visibility.mock.calls.length;
      gate.resolve();
      await settling;
      try {
        expect(initiallyExtended).toBe(true);
        expect(extended).toBe(true);
        expect(callsDuringSettle).toBe(kind === 'requeue' ? 1 : 0);
      } finally {
        await queue.disconnect();
      }
    });

    it(`clears the settling mark after ${kind} rejects`, async () => {
      const { queue, transport } = await sqsHarness();
      await transport.send('source', envelope());
      const [job] = await queue.reserve('build', 1, 0);
      const settle = () =>
        kind === 'ack'
          ? queue.ack('build', job!.id, job!.claimToken!)
          : kind === 'requeue'
            ? queue.requeue('build', job!.id, 1000, 2, job!.claimToken!)
            : queue.deadLetter('build', job!.id, 0, job!.claimToken!);
      if (kind === 'requeue')
        vi.spyOn(transport, 'changeVisibility').mockRejectedValueOnce(new Error('settle refused'));
      else vi.spyOn(transport, 'delete').mockRejectedValueOnce(new Error('settle refused'));
      await expect(settle()).rejects.toThrow('settle refused');
      const countBefore = transport.visibilityChanges.length;
      expect(await queue.claimRenewal.extend('build', job!.id, job!.claimToken!)).toBe(true);
      expect(transport.visibilityChanges).toHaveLength(countBefore + 1);
      await settle();
      await queue.disconnect();
    });
  }

  it.each(['expired', 'redelivered', 'disconnected'] as const)(
    'revalidates a claim that became %s while awaiting renewal',
    async (transition) => {
      const { queue, transport, runtime } = await sqsHarness();
      await transport.send('source', envelope());
      const [job] = await queue.reserve('build', 1, 0);
      const gate = Promise.withResolvers<void>();
      vi.spyOn(transport, 'changeVisibility').mockReturnValueOnce(gate.promise);
      const renewing = queue.claimRenewal.extend('build', job!.id, job!.claimToken!);
      await drain();
      const settling = Promise.allSettled([queue.ack('build', job!.id, job!.claimToken!)]);
      await drain();
      if (transition === 'disconnected') await queue.disconnect();
      else {
        await runtime.advanceMs(3000);
        if (transition === 'redelivered') await queue.reserve('build', 1, runtime.now());
      }
      gate.resolve();
      await renewing;
      const [result] = await settling;
      try {
        expect(result!.status).toBe('rejected');
        if (result!.status === 'rejected') expect(result.reason.name).toBe('StaleClaimError');
        expect(transport.deleted).toEqual([]);
      } finally {
        await queue.disconnect();
      }
    },
  );

  it('settles a still-owned claim after an in-flight renewal rejects', async () => {
    const { queue, transport } = await sqsHarness();
    await transport.send('source', envelope());
    const [job] = await queue.reserve('build', 1, 0);
    const gate = Promise.withResolvers<void>();
    vi.spyOn(transport, 'changeVisibility').mockReturnValueOnce(gate.promise);
    const renewing = queue.claimRenewal.extend('build', job!.id, job!.claimToken!);
    const acked = queue.ack('build', job!.id, job!.claimToken!);
    await drain();
    const deletionsBeforeRejection = transport.deleted.length;
    gate.reject(new Error('renewal refused'));
    expect(await renewing).toBe(false);
    await acked;
    try {
      expect(deletionsBeforeRejection).toBe(0);
      expect(transport.depth('source')).toBe(0);
    } finally {
      await queue.disconnect();
    }
  });

  it('shares an in-flight renewal and refuses overlapping settlements of one claim', async () => {
    const { queue, transport } = await sqsHarness();
    await transport.send('source', envelope());
    const [job] = await queue.reserve('build', 1, 0);
    const renewalGate = Promise.withResolvers<void>();
    const visibility = vi
      .spyOn(transport, 'changeVisibility')
      .mockReturnValueOnce(renewalGate.promise);
    const first = queue.claimRenewal.extend('build', job!.id, job!.claimToken!);
    const second = queue.claimRenewal.extend('build', job!.id, job!.claimToken!);
    await drain();
    const ackGate = Promise.withResolvers<void>();
    vi.spyOn(transport, 'delete').mockReturnValueOnce(ackGate.promise);
    const acked = queue.ack('build', job!.id, job!.claimToken!);
    const overlapping = Promise.allSettled([
      queue.requeue('build', job!.id, 1000, 2, job!.claimToken!),
    ]);
    renewalGate.resolve();
    await Promise.all([first, second]);
    await drain();
    const [result] = await overlapping;
    const calls = visibility.mock.calls.length;
    ackGate.resolve();
    await acked;
    try {
      expect(calls).toBe(1);
      expect(result!.status).toBe('rejected');
      if (result!.status === 'rejected') expect(result.reason.name).toBe('StaleClaimError');
    } finally {
      await queue.disconnect();
    }
  });

  it('does not report a false stale renewal when a processor fails during renewal', async () => {
    const { queue, transport, runtime } = await sqsHarness();
    const logger = { error: vi.fn() };
    const service = new QueueService(queue, runtime, { logger, pollIntervalMs: 100 });
    const processor = Promise.withResolvers<void>();
    const arrival = Promise.withResolvers<void>();
    const apply = transport.changeVisibility.bind(transport);
    vi.spyOn(transport, 'changeVisibility').mockImplementationOnce(async (...args) => {
      await arrival.promise;
      return apply(...args);
    });
    await service.connect();
    service.process('build', () => processor.promise);
    await transport.send('source', envelope());
    await runtime.advanceMs(1200);
    processor.reject(new Error('retry'));
    await drain();
    arrival.resolve();
    await runtime.advanceMs(100);
    try {
      expect(
        logger.error.mock.calls.filter(([message]) => message === 'queue job claim renewal failed'),
      ).toEqual([]);
      expect(transport.visibilityChanges.map((call) => call.seconds)).toEqual([3, 2]);
    } finally {
      await service.disconnect();
    }
  });
});
