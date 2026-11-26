import { describe, expect, it, vi } from 'vitest';
import { SqsQueue } from '../../src/adapters/sqs-queue.ts';
import { QueueService } from '../../src/services/queue-service.ts';
import { sqsHarness } from '../fixtures/sqs-harness.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';
import { FakeSqsTransport } from '../fixtures/fake-sqs-transport.ts';

describe('SQS reachability', () => {
  it.each([
    { error: undefined, reachable: true },
    { error: new Error('network'), reachable: false },
    { error: { name: 'QueueDoesNotExist', $metadata: { httpStatusCode: 400 } }, reachable: false },
    {
      error: {
        name: 'AWS.SimpleQueueService.NonExistentQueue',
        $metadata: { httpStatusCode: 400 },
      },
      reachable: false,
    },
    { error: { name: 'ServiceUnavailable', $metadata: { httpStatusCode: 503 } }, reachable: false },
    { error: { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } }, reachable: true },
  ])('classifies $error.name as $reachable', async ({ error, reachable }) => {
    const getQueueAttributes = vi.fn(() =>
      error === undefined ? Promise.resolve({}) : Promise.reject(error),
    );
    const h = await sqsHarness(
      { queues: { build: 'source', duplicate: 'source', other: 'other' } },
      { getQueueAttributes },
    );
    expect(await h.queue.isHealthy!()).toBe(reachable);
    expect(getQueueAttributes.mock.calls).toHaveLength(2);
    expect(getQueueAttributes).toHaveBeenCalledWith('source', ['QueueArn']);
    await h.queue.disconnect();
  });
  it('reports down at its own 1500ms bound before the outer probe expires', async () => {
    const runtime = new FakeRuntimeServices(0);
    const client = Object.assign(new FakeSqsTransport(() => runtime.now()), {
      getQueueAttributes: () => new Promise<Readonly<Record<string, string>>>(() => {}),
    });
    const adapter = new SqsQueue(runtime, { queues: { build: 'source' }, client });
    const service = new QueueService(adapter, runtime);
    await service.connect();
    const result = service.createHealthIndicator()();
    let settled = false;
    void result.then(() => {
      settled = true;
    });
    // Flush the nested probe setup before moving its timer.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await runtime.advanceMs(1499);
    expect(settled).toBe(false);
    await runtime.advanceMs(1);
    expect(await result).toMatchObject({ status: 'down', data: { reachable: false } });
    await service.disconnect();
  });
});
