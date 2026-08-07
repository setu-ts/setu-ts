/**
 * `SqsQueue` against a REAL SQS-compatible server (ElasticMQ).
 *
 * Guarded by `SQS_ENDPOINT_URL`; skipped when absent. CI supplies it alongside
 * an `elasticmq-native` service container.
 *
 * This suite drives the ADAPTER directly — the `QueuePlugin` → `QueueService`
 * wiring is covered by `test/integration/sqs-arm-integration.test.ts`. The split
 * is deliberate and load-bearing: an adapter-level e2e stays green over a broken
 * settle path, which is exactly what happened before that integration file
 * existed.
 *
 * Queues are CREATED here rather than assumed. ElasticMQ starts empty, and its
 * queue URLs are `<endpoint>/000000000000/<name>` — a format worth taking from
 * `CreateQueue`'s own response rather than hand-assembling.
 *
 * @module
 */
import { afterAll, beforeAll, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRuntimeServices } from '@setu-ts/common';
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

const endpoint = Deno.env.get('SQS_ENDPOINT_URL');
/**
 * The AWS SDK requires a region even against a local emulator, and it reads
 * `AWS_REGION` — not `SQS_REGION`. Passing it explicitly keeps the suite
 * independent of which name the environment happens to set.
 */
const region = Deno.env.get('SQS_REGION') ?? Deno.env.get('AWS_REGION') ?? 'us-east-1';
/** ElasticMQ ignores credential values but the SDK refuses to sign without them. */
const credentials = { accessKeyId: 'test', secretAccessKey: 'test' };

/** Queue names this run owns, suffixed so repeated runs never share state. */
const runId = crypto.randomUUID().slice(0, 8);
const NAMES = {
  round: `e2e-round-${runId}`,
  alpha: `e2e-alpha-${runId}`,
  beta: `e2e-beta-${runId}`,
  retry: `e2e-retry-${runId}`,
  dlqSource: `e2e-dlq-source-${runId}`,
  dlqTarget: `e2e-dlq-target-${runId}`,
} as const;

/** Live queue URLs, filled by {@linkcode beforeAll} from `CreateQueue`. */
const urls: Record<string, string> = {};

/** Options every adapter in this suite shares. */
function baseOptions(): { region: string; credentials: unknown; endpoint: string } {
  return { region, credentials, endpoint: endpoint! };
}

describe('SqsQueue — ElasticMQ E2E', { ignore: !endpoint }, () => {
  let sqsClient: { send(command: unknown): Promise<unknown>; destroy(): void } | undefined;
  // Command constructors are captured as `unknown`-returning factories: the
  // suite only needs to build and send them, and the SDK's own input types
  // demand required fields the generic form cannot express.
  let createQueue: (name: string) => unknown;
  let deleteQueue: (url: string) => unknown;
  let receiveFromDlq: (url: string) => unknown;

  beforeAll(async () => {
    const mod = await import('npm:@aws-sdk/client-sqs@^3');
    createQueue = (name: string) => new mod.CreateQueueCommand({ QueueName: name });
    deleteQueue = (url: string) => new mod.DeleteQueueCommand({ QueueUrl: url });
    receiveFromDlq = (url: string) =>
      new mod.ReceiveMessageCommand({
        QueueUrl: url,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 2,
      });

    sqsClient = new mod.SQSClient({
      region,
      credentials,
      endpoint: endpoint!,
    }) as unknown as typeof sqsClient;

    for (const name of Object.values(NAMES)) {
      const result = await sqsClient!.send(createQueue(name)) as { QueueUrl?: string };
      expect(result.QueueUrl).toBeDefined();
      urls[name] = result.QueueUrl!;
    }
  });

  afterAll(async () => {
    if (!sqsClient) return;
    for (const url of Object.values(urls)) {
      await sqsClient.send(deleteQueue(url));
    }
    sqsClient.destroy();
  });

  it('enqueue → reserve → ack round trip against live ElasticMQ', async () => {
    const runtime = createRuntime();
    const queue = new SqsQueue(runtime, {
      queues: { test: urls[NAMES.round]! },
      ...baseOptions(),
    });

    await queue.connect();
    expect(queue.isReady()).toBe(true);

    await queue.enqueue({
      id: 'job-1',
      name: 'test',
      data: { hello: 'world' },
      attempts: 0,
      maxAttempts: 3,
      availableAtMs: 0,
    });

    const jobs = await queue.reserve<{ hello: string }>('test', 1, runtime.now());
    expect(jobs.length).toBe(1);
    expect(jobs[0]!.id).toBe('job-1');
    expect(jobs[0]!.data).toEqual({ hello: 'world' });
    // First delivery, straight from the platform's ApproximateReceiveCount.
    expect(jobs[0]!.attempts).toBe(1);

    await queue.ack('test', jobs[0]!.id, jobs[0]!.claimToken ?? jobs[0]!.id);

    const remaining = await queue.reserve('test', 1, runtime.now());
    expect(remaining.length).toBe(0);

    await queue.disconnect();
    expect(queue.isReady()).toBe(false);
  });

  it('two job names remain isolated on their own queues', async () => {
    const runtime = createRuntime();
    const queue = new SqsQueue(runtime, {
      queues: { alpha: urls[NAMES.alpha]!, beta: urls[NAMES.beta]! },
      ...baseOptions(),
    });

    await queue.connect();

    await queue.enqueue({
      id: 'alpha-1',
      name: 'alpha',
      data: { from: 'alpha' },
      attempts: 0,
      maxAttempts: 1,
      availableAtMs: 0,
    });

    const betaJobs = await queue.reserve('beta', 1, runtime.now());
    expect(betaJobs.length).toBe(0);

    const alphaJobs = await queue.reserve('alpha', 1, runtime.now());
    expect(alphaJobs.length).toBe(1);
    expect(alphaJobs[0]!.data).toEqual({ from: 'alpha' });

    await queue.ack('alpha', alphaJobs[0]!.id, alphaJobs[0]!.claimToken ?? alphaJobs[0]!.id);
    await queue.disconnect();
  });

  it('requeue shortens the claim so the job returns with a higher attempt count', async () => {
    const runtime = createRuntime();
    const queue = new SqsQueue(runtime, {
      queues: { retry: urls[NAMES.retry]! },
      ...baseOptions(),
      // Long claim, so only the explicit requeue can make the job visible again
      // — otherwise a lapsing visibility window would produce the same result
      // and the test would not be measuring `requeue` at all.
      visibilityTimeoutSeconds: 60,
    });

    await queue.connect();

    await queue.enqueue({
      id: 'retry-1',
      name: 'retry',
      data: { attempt: 0 },
      attempts: 0,
      maxAttempts: 3,
      availableAtMs: 0,
    });

    const first = await queue.reserve('retry', 1, runtime.now());
    expect(first.length).toBe(1);
    expect(first[0]!.attempts).toBe(1);

    // Release the claim now rather than in 60 s.
    await queue.requeue(
      'retry',
      first[0]!.id,
      runtime.now(),
      2,
      first[0]!.claimToken ?? first[0]!.id,
    );

    const second = await queue.reserve('retry', 1, runtime.now());
    expect(second.length).toBe(1);
    expect(second[0]!.id).toBe('retry-1');
    // The count is the platform's, and it advanced on redelivery.
    expect(second[0]!.attempts).toBe(2);

    await queue.ack('retry', second[0]!.id, second[0]!.claimToken ?? second[0]!.id);
    await queue.disconnect();
  });

  it('deadLetter moves the body to the DLQ and clears the source', async () => {
    const runtime = createRuntime();
    const queue = new SqsQueue(runtime, {
      queues: { 'dlq-test': urls[NAMES.dlqSource]! },
      deadLetterQueues: { 'dlq-test': urls[NAMES.dlqTarget]! },
      ...baseOptions(),
      visibilityTimeoutSeconds: 5,
    });

    await queue.connect();

    await queue.enqueue({
      id: 'dlq-1',
      name: 'dlq-test',
      data: { original: 'body-data' },
      attempts: 0,
      maxAttempts: 1,
      availableAtMs: 0,
    });

    const jobs = await queue.reserve('dlq-test', 1, runtime.now());
    expect(jobs.length).toBe(1);

    await queue.deadLetter(
      'dlq-test',
      jobs[0]!.id,
      runtime.now(),
      jobs[0]!.claimToken ?? jobs[0]!.id,
    );

    // The body must actually arrive on the DLQ — the previous version of this
    // test only checked that `deadLetter` did not throw.
    const received = await sqsClient!.send(
      receiveFromDlq(urls[NAMES.dlqTarget]!),
    ) as { Messages?: { Body?: string }[] };

    expect(received.Messages?.length).toBe(1);
    const envelope = JSON.parse(received.Messages![0]!.Body!) as {
      id: string;
      name: string;
      data: { original: string };
    };
    expect(envelope.id).toBe('dlq-1');
    expect(envelope.name).toBe('dlq-test');
    expect(envelope.data).toEqual({ original: 'body-data' });

    // And the source claim is settled: nothing comes back after the window.
    await new Promise((resolve) => setTimeout(resolve, 6000));
    const sourceAfter = await queue.reserve('dlq-test', 1, runtime.now());
    expect(sourceAfter.length).toBe(0);

    await queue.disconnect();
  });
});
