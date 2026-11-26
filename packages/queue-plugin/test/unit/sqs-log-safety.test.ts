import { describe, expect, it } from 'vitest';
import type { SqsDeadLetterTargetMissingError } from '../../src/index.ts';
import { sqsHarness } from '../fixtures/sqs-harness.ts';

/** An envelope whose sender-chosen id tries to forge a second log record. */
function hostileEnvelope(id: string): string {
  return JSON.stringify({ v: 1, id, name: 'build', data: {}, maxAttempts: 1 });
}

describe('SQS log lines with a sender-chosen job id', () => {
  it('quotes a CR/LF id in the discard warning so it stays one record', async () => {
    const { queue, transport, logger } = await sqsHarness({ deadLetterQueues: { build: false } });
    const id = 'j1"\n2026-11-22T00:00:00.000Z [ERROR] forged-record';
    await transport.send('source', hostileEnvelope(id));
    const [job] = await queue.reserve('build', 1, 0);
    await queue.deadLetter('build', job!.id, 0, job!.claimToken!);
    const [line] = logger.warn.mock.calls.at(-1)!;
    expect(line).not.toContain('\n');
    expect(line).toContain(JSON.stringify(id));
    await queue.disconnect();
  });

  it('cuts a very long id to 128 characters', async () => {
    const { queue, transport, logger } = await sqsHarness({ deadLetterQueues: { build: false } });
    await transport.send('source', hostileEnvelope('x'.repeat(10_000)));
    const [job] = await queue.reserve('build', 1, 0);
    await queue.deadLetter('build', job!.id, 0, job!.claimToken!);
    const [line] = logger.warn.mock.calls.at(-1)!;
    expect(line).toContain(JSON.stringify(`${'x'.repeat(128)}…`));
    expect(line.length).toBeLessThan(400);
    await queue.disconnect();
  });

  it('names a disconnect, not a timeout, when it cancels a pending attribute read', async () => {
    const { queue } = await sqsHarness(
      { deadLetterQueues: {} },
      { getQueueAttributes: () => new Promise<Readonly<Record<string, string>>>(() => {}) },
    );
    const outcome = queue.prepareConsumer('build').then(
      () => undefined,
      (caught: unknown) => caught,
    );
    await queue.disconnect();
    const error = (await outcome) as SqsDeadLetterTargetMissingError;
    expect((error.cause as Error).message).toBe('SqsQueue is disconnecting');
  });
});
