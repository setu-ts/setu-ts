import { vi } from 'vitest';
import { SqsQueue } from '../../src/adapters/sqs-queue.ts';
import type { ISqsTransport, SqsQueueOptions } from '../../src/adapters/sqs-queue.ts';
import { FakeSqsTransport } from './fake-sqs-transport.ts';
import { FakeRuntimeServices } from './fake-runtime.ts';

export async function sqsHarness(
  options: Partial<SqsQueueOptions> = {},
  overrides: Partial<ISqsTransport> = {},
) {
  const runtime = new FakeRuntimeServices(0);
  const transport = new FakeSqsTransport(() => runtime.now());
  Object.assign(transport, overrides);
  const logger = {
    error: vi.fn<(message: string) => void>(),
    warn: vi.fn<(message: string) => void>(),
  };
  const queue = new SqsQueue(
    runtime,
    {
      queues: { build: 'source', other: 'other-source' },
      deadLetterQueues: { build: 'dead', other: 'dead' },
      visibilityTimeoutSeconds: 3,
      ...options,
      client: transport,
    },
    logger,
    { maxAttempts: 7 },
  );
  await queue.connect();
  return { runtime, transport, logger, queue };
}
export function envelope(maxAttempts = 3): string {
  return JSON.stringify({
    v: 1,
    id: 'j1',
    name: 'build',
    data: { secret: 'payload-canary' },
    maxAttempts,
  });
}
