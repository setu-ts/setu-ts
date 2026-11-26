import { describe, expect, it, vi } from 'vitest';
import { envelope, sqsHarness } from '../fixtures/sqs-harness.ts';

describe('SQS whole-second visibility budget', () => {
  it('does not spend the initial delivery lease waiting for a long poll response', async () => {
    const { queue, runtime, transport } = await sqsHarness();
    vi.spyOn(transport, 'receive').mockImplementationOnce(async () => {
      await runtime.advanceMs(20_000);
      return [{ body: envelope(), receiptHandle: 'receipt', approximateReceiveCount: undefined }];
    });
    const [job] = await queue.reserve('build', 1, 0);
    expect(await queue.claimRenewal.extend('build', 'j1', job!.claimToken!)).toBe(true);
    await queue.ack('build', 'j1', job!.claimToken!);
    await queue.disconnect();
  });
  it('rounds fractional remaining time down with request headroom and includes receive latency', async () => {
    const { queue, runtime, transport } = await sqsHarness({ visibilityTimeoutSeconds: 43_200 });
    await transport.send('source', envelope());
    const receive = transport.receive.bind(transport);
    vi.spyOn(transport, 'receive').mockImplementationOnce(async (...args) => {
      const messages = await receive(...args);
      await runtime.advanceMs(500);
      return messages;
    });
    const [job] = await queue.reserve('build', 1, 0);
    await runtime.advanceMs(43_190_100);
    expect(await queue.claimRenewal.extend('build', 'j1', job!.claimToken!)).toBe(true);
    expect(transport.visibilityChanges.at(-1)?.seconds).toBe(8);
    await queue.disconnect();
  });
  it('makes no renewal request with less than one whole second of safe budget', async () => {
    const { queue, runtime, transport } = await sqsHarness({ visibilityTimeoutSeconds: 43_200 });
    await transport.send('source', envelope());
    const [job] = await queue.reserve('build', 1, 0);
    await runtime.advanceMs(43_198_500);
    expect(await queue.claimRenewal.extend('build', 'j1', job!.claimToken!)).toBe(false);
    expect(transport.visibilityChanges).toEqual([]);
    await queue.disconnect();
  });
  it.each([43_190_100, 43_198_500])(
    'caps requeue visibility to the safe budget at %s ms',
    async (elapsed) => {
      const { queue, runtime, transport } = await sqsHarness({ visibilityTimeoutSeconds: 43_200 });
      await transport.send('source', envelope());
      const [job] = await queue.reserve('build', 1, 0);
      await runtime.advanceMs(elapsed);
      await queue.requeue('build', 'j1', runtime.now() + 30_000, 1, job!.claimToken!);
      expect(transport.visibilityChanges.map((v) => v.seconds)).toEqual(
        elapsed === 43_190_100 ? [8] : [],
      );
      await queue.disconnect();
    },
  );
});
