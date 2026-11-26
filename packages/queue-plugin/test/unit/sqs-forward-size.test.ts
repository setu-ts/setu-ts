import { describe, expect, it, vi } from 'vitest';
import { sqsHarness } from '../fixtures/sqs-harness.ts';

describe('SQS dead-letter size refusal', () => {
  it.each(['terminal', 'unreadable'] as const)(
    'retries an attribute-overflow %s forward once with the unchanged body only',
    async (kind) => {
      const { queue, transport, logger } = await sqsHarness();
      const body =
        kind === 'unreadable'
          ? 'x'.repeat(1024)
          : JSON.stringify({
              v: 1,
              id: 'large',
              name: 'build',
              maxAttempts: 1,
              data: 'x'.repeat(1024),
            });
      await transport.send('source', body);
      const send = transport.send.bind(transport);
      const forward = vi
        .spyOn(transport, 'send')
        .mockImplementation((url, bytes, delay, attributes) => {
          if (url === 'dead' && attributes !== undefined)
            return Promise.reject(
              Object.assign(new Error('private-remote-text'), { name: 'InvalidParameterValue' }),
            );
          return send(url, bytes, delay, attributes);
        });
      const jobs = await queue.reserve('build', 1, 0);
      if (kind === 'terminal') await queue.deadLetter('build', 'large', 0, jobs[0]!.claimToken!);
      else for (let n = 0; n < 100; n++) await Promise.resolve();
      expect(forward).toHaveBeenCalledTimes(2);
      expect(forward.mock.calls[1]).toEqual([
        'dead',
        body,
        undefined,
        undefined,
        { abortSignal: expect.any(AbortSignal) },
      ]);
      expect(transport.depth('source')).toBe(0);
      expect(transport.sent.at(-1)).toMatchObject({ queueUrl: 'dead', body });
      expect(transport.sent.at(-1)!.attributes).toBeUndefined();
      expect(logger.warn.mock.calls.filter(([m]) => m.includes('metadata omitted'))).toHaveLength(
        1,
      );
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('private-remote-text');
      await queue.disconnect();
    },
  );

  it.each([
    null,
    'InvalidParameterValue',
    new Error('InvalidParameterValue: size'),
    { name: 'AccessDenied', message: 'InvalidParameterValue' },
    { name: 'InvalidAttributeValue' },
  ])('does not retry another error shape: %j', async (cause) => {
    const { queue, transport } = await sqsHarness();
    await transport.send(
      'source',
      JSON.stringify({ v: 1, id: 'j1', name: 'build', maxAttempts: 1, data: {} }),
    );
    const [job] = await queue.reserve('build', 1, 0);
    const send = vi.spyOn(transport, 'send').mockRejectedValue(cause);
    await expect(queue.deadLetter('build', 'j1', 0, job!.claimToken!)).rejects.toBe(cause);
    expect(send).toHaveBeenCalledOnce();
    expect(transport.deleted).toEqual([]);
    await queue.disconnect();
  });

  it('keeps the source when the single body-only retry also fails', async () => {
    const { queue, transport, logger } = await sqsHarness();
    await transport.send('source', JSON.stringify({ v: 1, id: 'j1', name: 'build', data: {} }));
    const [job] = await queue.reserve('build', 1, 0);
    const cause = Object.assign(new Error('oversize'), { name: 'InvalidParameterValue' });
    const send = vi.spyOn(transport, 'send').mockRejectedValue(cause);
    await expect(queue.deadLetter('build', 'j1', 0, job!.claimToken!)).rejects.toBe(cause);
    expect(send).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls.filter(([m]) => m.includes('metadata omitted'))).toHaveLength(1);
    expect(transport.depth('source')).toBe(1);
    expect(transport.deleted).toEqual([]);
    await queue.disconnect();
  });
});
