/**
 * The queue's two halves: what reaches the producer binding, and how a
 * delivered batch is settled.
 *
 * Every dispatch case asserts the message's **disposition** — acked or retried,
 * never both and never neither — because the failure mode a queue exists to
 * prevent is a message that is silently discarded.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IJob, IQueue } from '@setu-ts/common';

import { CloudflareUnsupportedError } from '../../../src/errors.ts';
import { WorkersQueue } from '../../../src/queues/workers-queue.ts';
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
function build(): {
  readonly queue: WorkersQueue;
  readonly producer: FakeQueueProducer;
  readonly logger: RecordingLogger;
} {
  const producer = new FakeQueueProducer();
  const logger = new RecordingLogger();
  return {
    queue: new WorkersQueue(producer, new SequentialIds(), { logger: () => logger }),
    producer,
    logger,
  };
}

/** A message carrying the envelope `add` would have produced. */
function delivered(
  name: string,
  data: unknown,
  options?: { readonly id?: string; readonly attempts?: number; readonly maxAttempts?: number },
): FakeQueueMessage {
  return new FakeQueueMessage(
    `cf-${options?.id ?? 'id-1'}`,
    {
      v: 1,
      name,
      id: options?.id ?? 'id-1',
      data,
      ...(options?.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
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

    await expect(queue.addRecurring('nightly', {}, { cron: '0 3 * * *' }))
      .rejects.toBeInstanceOf(CloudflareUnsupportedError);
    await expect(queue.addRecurring('nightly', {}, { cron: '0 3 * * *' }))
      .rejects.toThrow(/wrangler\.toml.*\[triggers\] crons/s);
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

  it('ACKS without running the processor once attempts pass maxAttempts', async () => {
    const { queue, logger } = build();
    let ran = 0;
    queue.process('j', () => {
      ran += 1;
    });

    const message = delivered('j', {}, { attempts: 4, maxAttempts: 3 });
    await queue.dispatch(new FakeQueueBatch('q', [message]));

    expect(ran).toBe(0);
    expect(message.disposition).toBe('acked');
    expect(logger.messages()).toEqual(['cloudflare-queue: job exhausted its attempts']);
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
    expect(messages.map((m) => m.disposition)).toEqual([
      'acked',
      'acked',
      'acked',
      'retried',
    ]);
  });

  it("bounds one name's messages by its own concurrency, without throttling another", async () => {
    const { queue } = build();
    let slowInFlight = 0;
    let slowPeak = 0;
    let fastPeak = 0;
    let fastInFlight = 0;

    queue.process('slow', async () => {
      slowInFlight += 1;
      slowPeak = Math.max(slowPeak, slowInFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      slowInFlight -= 1;
    }, { concurrency: 1 });

    queue.process('fast', async () => {
      fastInFlight += 1;
      fastPeak = Math.max(fastPeak, fastInFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      fastInFlight -= 1;
    }, { concurrency: 4 });

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
    const queue = new WorkersQueue(new FakeQueueProducer(), new SequentialIds());
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

    expect(messages.map((m) => m.disposition)).toEqual([
      'retried',
      'retried',
      'retried',
      'acked',
    ]);
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

    await expect(queue.dispatch(new FakeQueueBatch('q', [message])))
      .rejects.toThrow('cannot ack');

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
