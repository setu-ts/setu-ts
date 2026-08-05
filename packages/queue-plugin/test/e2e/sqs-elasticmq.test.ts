/**
 * E2E test: SqsQueue against ElasticMQ (SQS-compatible backend).
 *
 * Guarded by SQS_ENDPOINT_URL — when the environment variable is set, the test
 * connects to the live ElasticMQ CI service (default localhost:9324) and runs
 * a real enqueue→reserve→ack round trip. When absent, the test is skipped.
 *
 * Mirrors the real-backend CI pattern from M53 (redis-real-import.test.ts).
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRuntimeServices } from '@hono-enterprise/common';
import { SqsQueue } from '../../src/adapters/sqs-queue.ts';

function createRuntime(): IRuntimeServices {
  return {
    platform: () => 'node' as ReturnType<IRuntimeServices['platform']>,
    uuid: () => 'uuid-e2e',
    now: () => Date.now(),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) as ReturnType<typeof setTimeout>,
    clearTimeout: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
    setInterval: () => (1 as unknown as ReturnType<typeof setInterval>),
    clearInterval: () => {},
    randomBytes: () => new Uint8Array(16),
    subtle: undefined,
    hostname: 'test',
    version: '0.1.0',
    hrtime: () => 0,
    fs: undefined,
    env: {},
    exit: () => {},
  } as unknown as IRuntimeServices;
}

/**
 * The SQS_ENDPOINT_URL points to the ElasticMQ instance (localhost:9324).
 * When absent, all tests in this suite are skipped.
 */
const endpoint = Deno.env.get('SQS_ENDPOINT_URL');

describe('SqsQueue — ElasticMQ E2E', { ignore: !endpoint }, () => {
  it('enqueue → reserve → ack round trip against live ElasticMQ', async () => {
    const queueUrl = `${endpoint}/queue/test-e2e`;
    const runtime = createRuntime();

    const queue = new SqsQueue(runtime, {
      queues: { test: queueUrl },
      endpoint: endpoint!,
    });

    await queue.connect();
    expect(queue.isReady()).toBe(true);

    // Enqueue a message
    await queue.enqueue({
      id: 'job-1',
      name: 'test',
      data: { hello: 'world' },
      attempts: 0,
      maxAttempts: 3,
      availableAtMs: 0,
    });

    // Reserve it back
    const jobs = await queue.reserve<{ hello: string }>('test', 1, runtime.now());
    expect(jobs.length).toBe(1);
    expect(jobs[0].data).toEqual({ hello: 'world' });

    // Ack (delete) it
    await queue.ack('test', jobs[0].id);

    // Verify queue is empty now
    const remaining = await queue.reserve('test', 1, runtime.now());
    expect(remaining.length).toBe(0);

    await queue.disconnect();
    expect(queue.isReady()).toBe(false);
  });
});
