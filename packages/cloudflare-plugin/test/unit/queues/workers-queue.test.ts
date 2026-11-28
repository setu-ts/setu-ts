import { WorkersResponse } from '../../../../../test/node-helpers.ts';
import { afterAll, beforeAll } from 'vitest';
const nativeResponse = globalThis.Response;
beforeAll(() => {
  globalThis.Response = WorkersResponse;
});
afterAll(() => {
  globalThis.Response = nativeResponse;
});
/**
 * The queue's two halves: what reaches the producer binding, and how a
 * delivered batch is settled.
 *
 * Every dispatch case asserts the message's **disposition** — acked or retried,
 * never both and never neither — because the failure mode a queue exists to
 * prevent is a message that is silently discarded.
 */

import { describe, expect, it } from 'vitest';
import type { IJob, IQueue } from '@setu-ts/common';

import { CloudflareUnsupportedError } from '../../../src/errors.ts';
import { WorkersQueue } from '../../../src/queues/workers-queue.ts';
import type { WorkersQueueOptions } from '../../../src/queues/workers-queue.ts';
import { isJobEnvelope } from '../../../src/queues/job-envelope.ts';
import {
  AckFailsQueueMessage,
  FakeQueueBatch,
  FakeQueueMessage,
  FakeQueueProducer,
  RecordingLogger,
  SequentialIds,
} from '../../fakes.ts';

/** Builds a queue over fresh fakes, typed as the committed port where it matters. */
function build(options?: WorkersQueueOptions): {
  readonly queue: WorkersQueue;
  readonly producer: FakeQueueProducer;
  readonly dlq: FakeQueueProducer;
  readonly logger: RecordingLogger;
} {
  const producer = new FakeQueueProducer();
  const dlq = new FakeQueueProducer();
  const logger = new RecordingLogger();
  return {
    queue: new WorkersQueue(producer, new SequentialIds(), {
      logger: () => logger,
      deadLetter: dlq,
      ...options,
    }),
    producer,
    dlq,
    logger,
  };
}

/** A message carrying the envelope `add` would have produced. */
function delivered(
  name: string,
  data: unknown,
  options?: {
    readonly id?: string;
    readonly attempts?: number;
    readonly maxAttempts?: number;
    readonly headers?: unknown;
  },
): FakeQueueMessage {
  return new FakeQueueMessage(
    `cf-${options?.id ?? 'id-1'}`,
    {
      v: 1,
      name,
      id: options?.id ?? 'id-1',
      data,
      ...(options?.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      ...(options?.headers === undefined ? {} : { headers: options.headers }),
    },
    options?.attempts ?? 1,
  );
}

describe('WorkersQueue.add', () => {
  it('returns the id it put inside the envelope, so add and job.id agree', async () => {
    const { queue, producer } = build();

    const id = await queue.add('send-email', { to: 'a@example.com' });

    expect(id).toBe('id-1');
    const body = producer.sends.at(0)?.body;
    expect(isJobEnvelope(body)).toBe(true);
    expect(body).toEqual({ v: 1, name: 'send-email', id: 'id-1', data: { to: 'a@example.com' } });
  });

  it('sends no delay option when the caller asked for none', async () => {
    const { queue, producer } = build();
    await queue.add('j', {});

    expect(producer.sends.at(0)?.options).toEqual({});
  });

  it('converts delayMs to whole seconds, rounding UP so a job is never early', async () => {
    const { queue, producer } = build();

    await queue.add('j', {}, { delayMs: 1500 });
    await queue.add('j', {}, { delayMs: 2000 });
    await queue.add('j', {}, { delayMs: 1 });

    expect(producer.sends.map((send) => send.options?.delaySeconds)).toEqual([2, 2, 1]);
  });

  it('clamps a negative delay to zero rather than sending a value the platform rejects', async () => {
    const { queue, producer } = build();
    await queue.add('j', {}, { delayMs: -5000 });

    expect(producer.sends.at(0)?.options?.delaySeconds).toBe(0);
  });

  it('throws naming the cap when the delay exceeds the platform maximum', async () => {
    const { queue, producer } = build();

    await expect(queue.add('nightly', {}, { delayMs: 90_000_000 })).rejects.toBeInstanceOf(
      CloudflareUnsupportedError,
    );
    await expect(queue.add('nightly', {}, { delayMs: 90_000_000 })).rejects.toThrow(/86400s/);
    // Nothing reached the binding — the send is refused, not truncated.
    expect(producer.sends).toHaveLength(0);
  });

  it('honours a configured maxDelaySeconds below the platform maximum', async () => {
    const producer = new FakeQueueProducer();
    const queue = new WorkersQueue(producer, new SequentialIds(), { maxDelaySeconds: 60 });

    await expect(queue.add('j', {}, { delayMs: 61_000 })).rejects.toThrow(/at most 60s/);
    await expect(queue.add('j', {}, { delayMs: 60_000 })).resolves.toBe('id-1');
  });

  it('carries maxAttempts into the envelope so dispatch can enforce it', async () => {
    const { queue, producer } = build();
    await queue.add('j', {}, { maxAttempts: 3 });

    expect(producer.sends.at(0)?.body).toMatchObject({ maxAttempts: 3 });
  });
});

describe('WorkersQueue.addRecurring', () => {
  it('throws, naming Cron Triggers as the platform mechanism instead', async () => {
    const { queue } = build();

    await expect(queue.addRecurring('nightly', {}, { cron: '0 3 * * *' })).rejects.toBeInstanceOf(
      CloudflareUnsupportedError,
    );
    await expect(queue.addRecurring('nightly', {}, { cron: '0 3 * * *' })).rejects.toThrow(
      /wrangler\.toml.*\[triggers\] crons/s,
    );
  });
});

describe('WorkersQueue.process', () => {
  it('replaces an earlier registration for the same name, matching QueueService', async () => {
    const { queue } = build();
    const ran: string[] = [];

    queue.process('j', () => {
      ran.push('first');
    });
    queue.process('j', () => {
      ran.push('second');
    });

    await queue.dispatch(new FakeQueueBatch('q', [delivered('j', {})]));
    expect(ran).toEqual(['second']);
  });
});

describe('WorkersQueue.dispatch', () => {
  it('reads the name and payload back out of the envelope', async () => {
    const { queue } = build();
    const seen: IJob[] = [];

    queue.process<{ to: string }>('send-email', (job) => {
      seen.push(job);
    });

    const message = delivered('send-email', { to: 'a@example.com' }, { id: 'id-9', attempts: 2 });
    await queue.dispatch(new FakeQueueBatch('mail', [message]));

    expect(seen).toEqual([
      { id: 'id-9', name: 'send-email', data: { to: 'a@example.com' }, attempts: 2 },
    ]);
    expect(message.disposition).toBe('acked');
  });

  it('acks a message whose processor resolves', async () => {
    const { queue } = build();
    queue.process('j', () => {});

    const message = delivered('j', {});
    await queue.dispatch(new FakeQueueBatch('q', [message]));

    expect(message.disposition).toBe('acked');
  });

  it('RETRIES a message whose name has no processor, and never acks it', async () => {
    // Acking would discard the message permanently and silently — the exact
    // failure a queue exists to prevent.
    const { queue, logger } = build();
    queue.process('known', () => {});

    const message = delivered('unknown', {});
    await queue.dispatch(new FakeQueueBatch('q', [message]));

    expect(message.disposition).toBe('retried');
    expect(logger.messages()).toEqual(['cloudflare-queue: message not routable, retried']);
    expect(logger.records.at(0)?.meta).toMatchObject({
      reason: 'no processor registered',
      job: 'unknown',
      registered: ['known'],
    });
  });

  it('RETRIES a message whose body is not an envelope', async () => {
    const { queue, logger } = build();
    queue.process('j', () => {});

    const message = new FakeQueueMessage('cf-1', { to: 'someone' });
    await queue.dispatch(new FakeQueueBatch('shared', [message]));

    expect(message.disposition).toBe('retried');
    expect(logger.records.at(0)?.meta).toMatchObject({ reason: 'body is not a job envelope' });
  });

  it('RETRIES a message whose processor throws, and reports why', async () => {
    const { queue, logger } = build();
    queue.process('j', () => {
      throw new Error('upstream 503');
    });

    const message = delivered('j', {});
    await queue.dispatch(new FakeQueueBatch('q', [message]));

    expect(message.disposition).toBe('retried');
    expect(logger.messages()).toEqual(['cloudflare-queue: processor failed, message retried']);
    expect(logger.records.at(0)?.meta).toMatchObject({ error: 'upstream 503' });
  });

  it('reports a non-Error rejection without crashing the dispatch', async () => {
    const { queue, logger } = build();
    queue.process('j', () => Promise.reject('a bare string'));

    const message = delivered('j', {});
    await queue.dispatch(new FakeQueueBatch('q', [message]));

    expect(message.disposition).toBe('retried');
    expect(logger.records.at(0)?.meta).toMatchObject({ error: 'a bare string' });
  });

  it('forwards to the dead-letter producer, without running the processor, once attempts pass maxAttempts', async () => {
    const { queue, logger, dlq } = build();
    let ran = 0;
    queue.process('j', () => {
      ran += 1;
    });

    const message = delivered('j', {}, { attempts: 4, maxAttempts: 3 });
    await queue.dispatch(new FakeQueueBatch('q', [message]));

    expect(ran).toBe(0);
    expect(message.disposition).toBe('acked');
    expect(dlq.sends).toHaveLength(1);
    expect(logger.messages()).toEqual(['cloudflare-queue: job arrived past its attempt budget']);
  });

  it('still runs the processor on the final permitted attempt', async () => {
    // Off-by-one guard: maxAttempts 3 means the third delivery must run.
    const { queue } = build();
    let ran = 0;
    queue.process('j', () => {
      ran += 1;
    });

    await queue.dispatch(
      new FakeQueueBatch('q', [delivered('j', {}, { attempts: 3, maxAttempts: 3 })]),
    );

    expect(ran).toBe(1);
  });

  it('routes a mixed batch to the right processors and settles every message', async () => {
    const { queue } = build();
    const emails: string[] = [];
    const reports: string[] = [];

    queue.process<string>('email', (job) => {
      emails.push(job.data);
    });
    queue.process<string>('report', (job) => {
      reports.push(job.data);
    });

    const messages = [
      delivered('email', 'a', { id: 'id-1' }),
      delivered('report', 'r', { id: 'id-2' }),
      delivered('email', 'b', { id: 'id-3' }),
      delivered('nobody', 'x', { id: 'id-4' }),
    ];
    await queue.dispatch(new FakeQueueBatch('mixed', messages));

    expect(emails.sort()).toEqual(['a', 'b']);
    expect(reports).toEqual(['r']);
    expect(messages.map((m) => m.disposition)).toEqual(['acked', 'acked', 'acked', 'retried']);
  });

  it("bounds one name's messages by its own concurrency, without throttling another", async () => {
    const { queue } = build();
    let slowInFlight = 0;
    let slowPeak = 0;
    let fastPeak = 0;
    let fastInFlight = 0;

    queue.process(
      'slow',
      async () => {
        slowInFlight += 1;
        slowPeak = Math.max(slowPeak, slowInFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        slowInFlight -= 1;
      },
      { concurrency: 1 },
    );

    queue.process(
      'fast',
      async () => {
        fastInFlight += 1;
        fastPeak = Math.max(fastPeak, fastInFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        fastInFlight -= 1;
      },
      { concurrency: 4 },
    );

    const messages = [
      ...Array.from({ length: 4 }, (_, i) => delivered('slow', i, { id: `s${i}` })),
      ...Array.from({ length: 4 }, (_, i) => delivered('fast', i, { id: `f${i}` })),
    ];
    await queue.dispatch(new FakeQueueBatch('mixed', messages));

    expect(slowPeak).toBe(1);
    expect(fastPeak).toBe(4);
    expect(messages.every((m) => m.disposition === 'acked')).toBe(true);
  });

  it('defaults concurrency to 1 when the registration omitted it', async () => {
    const { queue } = build();
    let inFlight = 0;
    let peak = 0;

    queue.process('j', async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      inFlight -= 1;
    });

    await queue.dispatch(
      new FakeQueueBatch(
        'q',
        Array.from({ length: 3 }, (_, i) => delivered('j', i, { id: `${i}` })),
      ),
    );

    expect(peak).toBe(1);
  });

  it('is silent on every path when no logger was supplied', async () => {
    // The logger is optional, so its absence must not become a TypeError on the
    // reporting paths — which are exactly the paths a production Worker hits.
    const queue = new WorkersQueue(new FakeQueueProducer(), new SequentialIds(), {
      deadLetter: new FakeQueueProducer(),
    });
    queue.process('boom', () => {
      throw new Error('x');
    });

    const messages = [
      delivered('boom', {}, { id: 'a' }),
      delivered('nobody', {}, { id: 'b' }),
      new FakeQueueMessage('cf-c', 'not an envelope'),
      delivered('boom', {}, { id: 'd', attempts: 9, maxAttempts: 1 }),
    ];
    await queue.dispatch(new FakeQueueBatch('q', messages));

    expect(messages.map((m) => m.disposition)).toEqual(['retried', 'retried', 'retried', 'acked']);
  });

  it('does not retry — or blame the processor — when ack() itself throws', async () => {
    // `ack()` inside the processor's try meant a platform-side ack failure was
    // reported as "processor failed" and the message was ALSO retried, giving
    // one message two dispositions.
    const { queue, logger } = build();
    let ran = 0;
    queue.process('j', () => {
      ran += 1;
    });

    const message = new AckFailsQueueMessage('cf-1', {
      v: 1,
      name: 'j',
      id: 'id-1',
      data: null,
    });

    await expect(queue.dispatch(new FakeQueueBatch('q', [message]))).rejects.toThrow('cannot ack');

    expect(ran).toBe(1);
    expect(message.retried).toBe(0);
    expect(logger.messages()).toEqual([]);
  });

  it('does nothing for an empty batch', async () => {
    const { queue, logger } = build();
    await queue.dispatch(new FakeQueueBatch('q', []));

    expect(logger.records).toHaveLength(0);
  });

  it('satisfies the committed IQueue port', () => {
    // Types against the contract rather than the class, so a drift in either
    // one is a compile error here.
    const { queue } = build();
    const port: IQueue = queue;

    expect(typeof port.add).toBe('function');
    expect(typeof port.process).toBe('function');
    expect(typeof port.addRecurring).toBe('function');
  });
});

describe('WorkersQueue header channel (M90i)', () => {
  it('sends the caller-supplied headers on the envelope', async () => {
    const { queue, producer } = build();
    await queue.add(
      'mail',
      { to: 'a@b.c' },
      {
        headers: { traceparent: 'tp', 'x-tenant': 't-1' },
      },
    );

    expect(producer.sends).toHaveLength(1);
    const sent = producer.sends[0]!.body as { headers?: unknown };
    expect(sent.headers).toEqual({ traceparent: 'tp', 'x-tenant': 't-1' });
  });

  it('omits headers when the caller supplied none', async () => {
    const { queue, producer } = build();
    await queue.add('mail', { to: 'a@b.c' });

    expect(producer.sends).toHaveLength(1);
    expect(Object.hasOwn(producer.sends[0]!.body as object, 'headers')).toBe(false);
  });

  it('delivers the headers to the processor as IJob.headers', async () => {
    // The whole point of the channel: what `add` accepted must reach the
    // handler. Before M90i this queue accepted `headers` and discarded them.
    const { queue } = build();
    let seen: IJob | undefined;
    queue.process('mail', (job) => {
      seen = job;
    });

    await queue.dispatch(
      new FakeQueueBatch('q', [delivered('mail', {}, { headers: { traceparent: 'tp' } })]),
    );

    expect(seen?.headers).toEqual({ traceparent: 'tp' });
  });

  it('leaves the member ABSENT for a job that carried no channel', async () => {
    const { queue } = build();
    let seen: IJob | undefined;
    queue.process('mail', (job) => {
      seen = job;
    });

    await queue.dispatch(new FakeQueueBatch('q', [delivered('mail', {})]));

    expect(seen).toBeDefined();
    expect('headers' in (seen as object)).toBe(false);
  });

  it('DROPS a malformed header map and still runs the job', async () => {
    // The envelope guard retries what it refuses, so refusing a job over its
    // observability field would lose the work to protect the record of it.
    const { queue } = build();
    let seen: IJob | undefined;
    queue.process('mail', (job) => {
      seen = job;
    });

    await queue.dispatch(
      new FakeQueueBatch('q', [delivered('mail', {}, { headers: { traceparent: 7 } })]),
    );

    expect(seen).toBeDefined();
    expect('headers' in (seen as object)).toBe(false);
  });

  it('round-trips add() -> dispatch through the real envelope', async () => {
    const { queue, producer } = build();
    let seen: IJob | undefined;
    queue.process('mail', (job) => {
      seen = job;
    });

    const id = await queue.add('mail', { to: 'a@b.c' }, { headers: { traceparent: 'tp' } });
    // Feed the producer's OWN body back through dispatch, so the two halves are
    // checked against each other rather than against a hand-written envelope.
    await queue.dispatch(
      new FakeQueueBatch('q', [new FakeQueueMessage(`cf-${id}`, producer.sends[0]?.body, 1)]),
    );

    expect(seen?.id).toBe(id);
    expect(seen?.headers).toEqual({ traceparent: 'tp' });
  });
});

describe('WorkersQueue exhausted jobs (V13-197)', () => {
  const always = (): never => {
    throw new Error('always fails');
  };

  it('refuses process() with no dead-letter target, naming both ways past it', () => {
    const queue = new WorkersQueue(new FakeQueueProducer(), new SequentialIds());
    expect(() => {
      queue.process('j', () => {});
    }).toThrow(CloudflareUnsupportedError);
    expect(() => {
      queue.process('j', () => {});
    }).toThrow(/deadLetterQueue.*false/s);
  });

  it('refuses a deadLetter that is the producer of the queue it serves', () => {
    const producer = new FakeQueueProducer();
    expect(() => new WorkersQueue(producer, new SequentialIds(), { deadLetter: producer })).toThrow(
      /queue it serves/,
    );
  });

  it('lets a producer-only queue add without any dead-letter target', async () => {
    const producer = new FakeQueueProducer();
    const queue = new WorkersQueue(producer, new SequentialIds());
    await queue.add('j', {});
    expect(producer.sends).toHaveLength(1);
  });

  it.each([0, 101, 1.5, Number.NaN])('refuses maxRetries %s', (maxRetries) => {
    expect(() => build({ maxRetries })).toThrow(/maxRetries must be a whole number from 1 to 100/);
  });

  it.each([-1, Infinity, Number.NaN])('refuses retryDelaySeconds %s', (retryDelaySeconds) => {
    expect(() => build({ retryDelaySeconds })).toThrow(/retryDelaySeconds/);
  });

  it('calls onFailed once on the final attempt, never earlier, then forwards and acks', async () => {
    const now = 1_700_000_000_000;
    const { queue, dlq } = build({ now: () => now });
    const failed: { id: string; attempts: number; error: unknown }[] = [];
    queue.process('j', always, {
      onFailed: (job, error) => void failed.push({ id: job.id, attempts: job.attempts, error }),
    });

    const deliveries = [1, 2, 3].map((attempts) => delivered('j', { n: 1 }, { attempts }));
    for (const message of deliveries) await queue.dispatch(new FakeQueueBatch('q', [message]));

    expect(deliveries.map((m) => m.disposition)).toEqual(['retried', 'retried', 'acked']);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.attempts).toBe(3);
    expect(dlq.sends.at(0)?.body).toEqual({
      v: 1,
      name: 'j',
      id: 'id-1',
      data: { n: 1 },
      failedAt: now,
      attempts: 3,
      error: 'Error: always fails',
    });
  });

  it('honours a lower maxAttempts, and caps a higher one with one warning per name', async () => {
    const { queue, dlq, logger } = build();
    queue.process('j', always);

    await queue.dispatch(
      new FakeQueueBatch('q', [delivered('j', {}, { attempts: 2, maxAttempts: 2 })]),
    );
    expect(dlq.sends).toHaveLength(1);

    const capped = [
      delivered('j', {}, { attempts: 2, maxAttempts: 9 }),
      delivered('j', {}, { attempts: 3, maxAttempts: 9 }),
    ];
    for (const message of capped) await queue.dispatch(new FakeQueueBatch('q', [message]));
    expect(capped.map((m) => m.disposition)).toEqual(['retried', 'acked']);
    expect(logger.records.filter((r) => r.message.includes('capped'))).toHaveLength(1);
    expect(logger.records.find((r) => r.message.includes('capped'))?.meta).toMatchObject({
      maxAttempts: 9,
      maxRetries: 3,
      budget: 3,
    });
  });

  it('retries a failed dead-letter send without logging the payload, keeping the job', async () => {
    const { queue, dlq, logger } = build();
    dlq.send = () => Promise.reject(new TypeError('queue unavailable'));
    queue.process('j', always);

    const message = delivered('j', { secret: 's3cr3t' }, { attempts: 3 });
    await queue.dispatch(new FakeQueueBatch('q', [message]));

    expect(message.disposition).toBe('retried');
    const record = logger.records.find((r) => r.message.includes('dead-letter send failed'));
    expect(record?.meta).toMatchObject({ error: 'TypeError', attempts: 3 });
    expect(JSON.stringify(logger.records)).not.toContain('s3cr3t');
  });

  it('on the last delivery, sends the original job when the enriched copy is refused', async () => {
    // The added fields can push a job near the Queues size limit over it.
    const { queue, dlq, logger } = build();
    const accepted: unknown[] = [];
    let first = true;
    dlq.send = (body: unknown) => {
      if (first) {
        first = false;
        return Promise.reject(new RangeError('message too large'));
      }
      accepted.push(body);
      return Promise.resolve();
    };
    queue.process('j', always);

    const reserve = delivered('j', { n: 1 }, { attempts: 4 });
    await queue.dispatch(new FakeQueueBatch('q', [reserve]));

    expect(reserve.disposition).toBe('acked');
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).not.toHaveProperty('attempts');
    expect(accepted[0]).toMatchObject({ name: 'j', data: { n: 1 } });
    expect(logger.messages()).toContain(
      'cloudflare-queue: dead-letter copy refused on the last delivery; the original job was sent',
    );
  });

  it('on the last delivery, forwards an unroutable body unwrapped when its copy is refused', async () => {
    const { queue, dlq } = build();
    const accepted: unknown[] = [];
    let first = true;
    dlq.send = (body: unknown) => {
      if (first) {
        first = false;
        return Promise.reject(new RangeError('message too large'));
      }
      accepted.push(body);
      return Promise.resolve();
    };
    queue.process('known', () => {});

    const garbage = new FakeQueueMessage('cf-g', 'not an envelope', 4);
    await queue.dispatch(new FakeQueueBatch('q', [garbage]));

    expect(garbage.disposition).toBe('acked');
    expect(accepted).toEqual(['not an envelope']);
  });

  it('acks a job whose original was sent even when the warning logger throws', async () => {
    // Only the line reported after the dead-letter write throws.
    const throwing = new RecordingLogger();
    throwing.warn = (message: string) => {
      if (message.includes('the original job was sent')) throw new Error('logger down');
    };
    const { queue, dlq } = build({ logger: () => throwing });
    let first = true;
    dlq.send = () => {
      if (first) {
        first = false;
        return Promise.reject(new RangeError('message too large'));
      }
      return Promise.resolve();
    };
    queue.process('j', always);

    const reserve = delivered('j', { n: 1 }, { attempts: 4 });
    await expect(queue.dispatch(new FakeQueueBatch('q', [reserve]))).resolves.toBeUndefined();

    expect(reserve.disposition).toBe('acked');
  });

  it('retries a job whose dead-letter send failed even when the error logger throws', async () => {
    const throwing = new RecordingLogger();
    throwing.error = (message: string) => {
      if (message.includes('dead-letter send failed')) throw new Error('logger down');
    };
    const { queue, dlq } = build({ logger: () => throwing });
    dlq.send = () => Promise.reject(new TypeError('queue unavailable'));
    queue.process('j', always);

    const message = delivered('j', {}, { attempts: 3 });
    await expect(queue.dispatch(new FakeQueueBatch('q', [message]))).resolves.toBeUndefined();

    expect(message.disposition).toBe('retried');
  });

  it('applies the configured retry delay when a dead-letter send fails', async () => {
    // retryDelaySeconds: 0 must be sent explicitly, or the consumer's
    // retry_delay applies instead.
    const { queue, dlq } = build({ retryDelaySeconds: 0 });
    dlq.send = () => Promise.reject(new TypeError('queue unavailable'));
    queue.process('j', always);

    const message = delivered('j', {}, { attempts: 3 });
    await queue.dispatch(new FakeQueueBatch('q', [message]));

    expect(message.retryOptions).toEqual({ delaySeconds: 0 });
  });

  it('forwards an unroutable body losslessly, on the copy and on the last-delivery original', async () => {
    // JSON serialization would turn a binary body into {}.
    const { queue, dlq } = build();
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const refused: unknown[] = [];
    let first = true;
    dlq.send = (body: unknown, options?: unknown) => {
      if (first) {
        first = false;
        refused.push(options);
        return Promise.reject(new RangeError('message too large'));
      }
      dlq.sends.push({ body, options: options as never });
      return Promise.resolve();
    };
    queue.process('known', () => {});

    const binary = new FakeQueueMessage('cf-b', bytes, 4);
    await queue.dispatch(new FakeQueueBatch('q', [binary]));

    // The copy wraps the bytes in an object, so only structured clone carries
    // it; the original is the bytes alone, sent as bytes so a pull consumer
    // can still read it.
    expect(binary.disposition).toBe('acked');
    expect(refused).toEqual([{ contentType: 'v8' }]);
    expect(dlq.sends.map((s) => [s.body, s.options])).toEqual([[bytes, { contentType: 'bytes' }]]);
  });

  it('sends a foreign body JSON can carry as JSON, and one it cannot with structured clone', async () => {
    // Pull consumers and the dashboard cannot decode v8, so it is used only
    // where JSON would lose the body.
    const { queue, dlq } = build();
    queue.process('known', () => {});
    const at = new Date(0);
    // A hole (`[, 1]`) and an extra array key both read as JSON-unsafe.
    const holed: unknown[] = [];
    holed[1] = 1;
    const extra = Object.assign([1], { extra: 2 });
    // One of each: the key count matches the length, the content does not.
    const both: unknown[] = Object.assign([], { x: 2 });
    both[1] = 1;
    const bodies: unknown[] = [
      'text',
      { order: 7, items: [1, 'two', null, { ok: true }] },
      { at },
      new Map([['k', 1]]),
      [new Uint8Array([1])],
      holed,
      [-0],
      extra,
      both,
      { n: 1n },
    ];

    await queue.dispatch(
      new FakeQueueBatch(
        'q',
        bodies.map((body, i) => new FakeQueueMessage(`cf-${String(i)}`, body, 3)),
      ),
    );

    expect(dlq.sends.map((s) => s.options)).toEqual([
      undefined,
      undefined,
      ...Array.from({ length: 8 }, () => ({ contentType: 'v8' })),
    ]);
  });

  it('sends a cyclic or deeply nested foreign body with structured clone', async () => {
    const { queue, dlq } = build();
    queue.process('known', () => {});
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    let deep: unknown = 'leaf';
    for (let i = 0; i < 200; i++) deep = [deep];

    await queue.dispatch(
      new FakeQueueBatch('q', [
        new FakeQueueMessage('cf-c', cyclic, 3),
        new FakeQueueMessage('cf-d', deep, 3),
      ]),
    );

    expect(dlq.sends.map((s) => s.options)).toEqual([{ contentType: 'v8' }, { contentType: 'v8' }]);
  });

  it('checks a body that shares one object many times in linear time, sending it as v8', async () => {
    // JSON writes a shared object out at every reference, so `x = [x, x]`
    // repeated n times is 2^n copies; structured clone stores it once. 26 levels
    // take seconds walked once per reference, and microseconds walked once.
    const { queue, dlq } = build();
    queue.process('known', () => {});
    let shared: unknown = 'leaf';
    for (let i = 0; i < 26; i++) shared = [shared, shared];

    const started = performance.now();
    await queue.dispatch(new FakeQueueBatch('q', [new FakeQueueMessage('cf-s', shared, 3)]));

    expect(performance.now() - started).toBeLessThan(500);
    expect(dlq.sends.map((s) => s.options)).toEqual([{ contentType: 'v8' }]);
  });

  it('retries, then reports, when the retry-delay function throws and so does the logger', async () => {
    const throwing = new RecordingLogger();
    throwing.warn = (message: string) => {
      if (message.includes('retryDelaySeconds')) throw new Error('logger down');
    };
    const { queue, dlq } = build({
      logger: () => throwing,
      retryDelaySeconds: () => {
        throw new Error('bad policy');
      },
    });
    dlq.send = () => Promise.reject(new TypeError('queue unavailable'));
    queue.process('j', always);

    const message = delivered('j', {}, { attempts: 3 });
    await expect(queue.dispatch(new FakeQueueBatch('q', [message]))).resolves.toBeUndefined();

    expect(message.disposition).toBe('retried');
  });

  it('discards with deadLetterQueue false even when the warning logger throws', async () => {
    // Only the line reported after the discard throws.
    const throwing = new RecordingLogger();
    throwing.warn = (message: string) => {
      if (message.includes('deadLetterQueue is false')) throw new Error('logger down');
    };
    const { queue } = build({ logger: () => throwing, deadLetter: false });
    queue.process('j', always);

    const message = delivered('j', {}, { attempts: 3 });
    await expect(queue.dispatch(new FakeQueueBatch('q', [message]))).resolves.toBeUndefined();

    expect(message.disposition).toBe('acked');
  });

  it('forwards an envelope whose data JSON would change losslessly, on both paths', async () => {
    // Another producer can put binary data inside a well-formed envelope.
    const { queue, dlq } = build();
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const refused: unknown[] = [];
    let first = true;
    dlq.send = (body: unknown, options?: unknown) => {
      if (first) {
        first = false;
        refused.push(options);
        return Promise.reject(new RangeError('message too large'));
      }
      dlq.sends.push({ body, options: options as never });
      return Promise.resolve();
    };
    queue.process('j', always);

    const reserve = delivered('j', bytes, { attempts: 4 });
    await queue.dispatch(new FakeQueueBatch('q', [reserve]));

    expect(reserve.disposition).toBe('acked');
    expect(refused).toEqual([{ contentType: 'v8' }]);
    expect(dlq.sends.map((s) => s.options)).toEqual([{ contentType: 'v8' }]);
  });

  it('keeps a job envelope on the default JSON serialization when forwarding it', async () => {
    const { queue, dlq } = build();
    queue.process('j', always);

    await queue.dispatch(new FakeQueueBatch('q', [delivered('j', { n: 1 }, { attempts: 3 })]));

    expect(dlq.sends.map((s) => s.options)).toEqual([undefined]);
  });

  it('on the last delivery, retries when the original job is refused too', async () => {
    const { queue, dlq } = build();
    dlq.send = () => Promise.reject(new TypeError('queue unavailable'));
    queue.process('j', always);

    const reserve = delivered('j', {}, { attempts: 4 });
    await queue.dispatch(new FakeQueueBatch('q', [reserve]));

    expect(reserve.disposition).toBe('retried');
  });

  it('forwards on the reserve delivery without the error text or a second onFailed', async () => {
    const { queue, dlq, logger } = build();
    let calls = 0;
    queue.process('j', always, { onFailed: () => void calls++ });

    const reserve = delivered('j', {}, { attempts: 4 });
    await queue.dispatch(new FakeQueueBatch('q', [reserve]));

    expect(calls).toBe(0);
    expect(reserve.disposition).toBe('acked');
    expect(dlq.sends.at(0)?.body).not.toHaveProperty('error');
    expect(logger.messages()).toContain('cloudflare-queue: job arrived past its attempt budget');
  });

  it('logs that the job leaves the adapter when the reserve-delivery send fails too', async () => {
    const { queue, dlq, logger } = build();
    dlq.send = () => Promise.reject('down');
    queue.process('j', always);

    const reserve = delivered('j', {}, { attempts: 4 });
    await queue.dispatch(new FakeQueueBatch('q', [reserve]));

    expect(reserve.disposition).toBe('retried');
    expect(logger.records.at(-1)?.message).toContain('the job leaves the adapter');
    expect(logger.records.at(-1)?.meta).toMatchObject({ error: 'string' });
  });

  it('discards with one warning per discard, never the payload, when deadLetter is false', async () => {
    const { queue, logger } = build({ deadLetter: false });
    let calls = 0;
    queue.process('j', always, { onFailed: () => void calls++ });

    const message = delivered('j', { secret: 'p' }, { attempts: 3 });
    await queue.dispatch(new FakeQueueBatch('q', [message]));

    expect(message.disposition).toBe('acked');
    expect(calls).toBe(1);
    expect(logger.messages()).toContain(
      'cloudflare-queue: job discarded after 3 attempts; deadLetterQueue is false',
    );
    expect(JSON.stringify(logger.records)).not.toContain('"secret"');
  });

  it('logs and swallows an onFailed that throws, still forwarding the job', async () => {
    const { queue, dlq, logger } = build();
    queue.process('j', always, {
      onFailed: () => {
        throw new RangeError('callback bug');
      },
    });

    const message = delivered('j', {}, { attempts: 3 });
    await queue.dispatch(new FakeQueueBatch('q', [message]));

    expect(message.disposition).toBe('acked');
    expect(dlq.sends).toHaveLength(1);
    expect(
      logger.records.find((r) => r.message.includes('onFailed callback threw'))?.meta,
    ).toMatchObject({
      error: 'RangeError',
    });
  });

  it('forwards an unroutable message on its last processor attempt instead of letting it be deleted', async () => {
    const { queue, dlq } = build();
    queue.process('known', () => {});

    const unknown = delivered('unknown', {}, { attempts: 3 });
    const garbage = new FakeQueueMessage('cf-g', 'not an envelope', 3);
    await queue.dispatch(new FakeQueueBatch('q', [unknown, garbage]));

    expect([unknown.disposition, garbage.disposition]).toEqual(['acked', 'acked']);
    expect(dlq.sends.map((s) => (s.body as { error?: string }).error)).toEqual([
      'Error: no processor registered',
      'Error: body is not a job envelope',
    ]);
    expect(dlq.sends.at(1)?.body).toMatchObject({ body: 'not an envelope' });
  });

  it('retries an unroutable message on its last attempt when the queue has no dead-letter target', async () => {
    // A producer-only queue never called process(); the platform's own
    // dead_letter_queue still decides, as before.
    const logger = new RecordingLogger();
    const queue = new WorkersQueue(new FakeQueueProducer(), new SequentialIds(), {
      logger: () => logger,
    });
    const message = delivered('unknown', {}, { attempts: 3 });
    await queue.dispatch(new FakeQueueBatch('q', [message]));
    expect(message.disposition).toBe('retried');
    expect(logger.messages()).toEqual(['cloudflare-queue: message not routable, retried']);
  });

  it('names the last-attempt forward in the unroutable log line', async () => {
    const { queue, logger } = build();
    queue.process('known', () => {});
    await queue.dispatch(new FakeQueueBatch('q', [delivered('unknown', {}, { attempts: 3 })]));
    expect(logger.messages()).toContain(
      'cloudflare-queue: message not routable on its last attempt, forwarding to the dead-letter queue',
    );
  });

  it('discards an unroutable message on its last attempt when deadLetter is false', async () => {
    const { queue, logger } = build({ deadLetter: false });
    queue.process('known', () => {});
    const message = new FakeQueueMessage('cf-g', 'not an envelope', 3);
    await queue.dispatch(new FakeQueueBatch('q', [message]));
    expect(message.disposition).toBe('acked');
    expect(logger.messages()).toContain(
      'cloudflare-queue: message not routable on its last attempt, discarded',
    );
  });
});

describe('WorkersQueue retry spacing (V13-220, Workers half)', () => {
  const always = (): never => {
    throw new Error('x');
  };

  async function retryOf(options: WorkersQueueOptions, attempts = 1) {
    const { queue, logger } = build(options);
    queue.process('j', always);
    const message = delivered('j', {}, { attempts });
    await queue.dispatch(new FakeQueueBatch('q', [message]));
    return { options: message.retryOptions, logger };
  }

  it('keeps the queue retry_delay when unset', async () => {
    expect((await retryOf({})).options).toBeUndefined();
  });

  it('passes a fixed delay, rounded up and bounded by maxDelaySeconds', async () => {
    expect((await retryOf({ retryDelaySeconds: 2.2 })).options).toEqual({ delaySeconds: 3 });
    expect((await retryOf({ retryDelaySeconds: 500, maxDelaySeconds: 60 })).options).toEqual({
      delaySeconds: 60,
    });
    // An explicit 0 overrides the queue's retry_delay; a bare retry() would keep it.
    expect((await retryOf({ retryDelaySeconds: 0 })).options).toEqual({ delaySeconds: 0 });
  });

  it('calls a function with the attempt that failed', async () => {
    expect((await retryOf({ retryDelaySeconds: (n) => n * 10 }, 2)).options).toEqual({
      delaySeconds: 20,
    });
    expect((await retryOf({ retryDelaySeconds: () => -5 })).options).toEqual({ delaySeconds: 0 });
  });

  it("falls back to the queue's retry_delay, warning once, for a function that throws or returns non-finite", async () => {
    const throwing = await retryOf({
      retryDelaySeconds: () => {
        throw new Error('bug');
      },
    });
    expect(throwing.options).toBeUndefined();
    expect(throwing.logger.messages()).toContain(
      "cloudflare-queue: retryDelaySeconds threw or returned a non-finite value; retried with the queue's own retry_delay",
    );

    const { queue, logger } = build({ retryDelaySeconds: () => Number.NaN });
    queue.process('j', always);
    await queue.dispatch(
      new FakeQueueBatch('q', [delivered('j', {}), delivered('j', {}, { id: 'b' })]),
    );
    expect(logger.messages().filter((m) => m.includes('retryDelaySeconds'))).toHaveLength(1);
  });

  it('spaces an unroutable retry the same way', async () => {
    const { queue } = build({ retryDelaySeconds: 7 });
    queue.process('known', () => {});
    const message = delivered('unknown', {});
    await queue.dispatch(new FakeQueueBatch('q', [message]));
    expect(message.retryOptions).toEqual({ delaySeconds: 7 });
  });
});
