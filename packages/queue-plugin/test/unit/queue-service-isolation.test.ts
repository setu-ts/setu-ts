/**
 * One job name the backend refuses must not stop any other name (M106 audit
 * R4-1). A name the adapter can NEVER use is refused at registration; a name
 * whose reserve or recurring enqueue fails is reported and skipped, and the
 * names after it in the same tick still run.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { QueueService } from '../../src/services/queue-service.ts';
import type { QueueLogger } from '../../src/services/queue-service.ts';
import { MemoryQueue } from '../../src/adapters/memory-queue.ts';
import { RabbitMqQueue } from '../../src/adapters/rabbitmq-queue.ts';
import type { StoredJob } from '../../src/interfaces/index.ts';
import { createFakeAmqpConnection } from '../fixtures/fake-amqplib-client.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';

/** A memory adapter that refuses every backend call for the name `bad`. */
class RefusingQueue extends MemoryQueue {
  readonly advanced: string[] = [];

  override reserve<T>(
    name: string,
    limit: number,
    nowMs: number,
  ): Promise<readonly StoredJob<T>[]> {
    if (name === 'bad') return Promise.reject(new Error('backend refused bad'));
    return super.reserve<T>(name, limit, nowMs);
  }

  override enqueue<T>(job: StoredJob<T>): Promise<void> {
    if (job.name === 'bad') return Promise.reject(new Error('backend refused bad'));
    return super.enqueue(job);
  }

  override advanceRecurring(id: string, nextRunAtMs: number): Promise<void> {
    this.advanced.push(id);
    return super.advanceRecurring(id, nextRunAtMs);
  }
}

function recordingLogger(): { logger: QueueLogger; logged: { message: string; name: unknown }[] } {
  const logged: { message: string; name: unknown }[] = [];
  return {
    logged,
    logger: { error: (message, metadata) => logged.push({ message, name: metadata?.name }) },
  };
}

describe('QueueService — refusing an unusable job name at registration', () => {
  it('throws from process() and rejects addRecurring() when the adapter says so', async () => {
    const adapter = new MemoryQueue() as MemoryQueue & {
      jobNameProblem(name: string): string | null;
    };
    adapter.jobNameProblem = (name) => (name === 'bad' ? 'cannot use the job name' : null);
    const service = new QueueService(adapter, new FakeRuntimeServices(1_000));

    expect(() => service.process('bad', () => {})).toThrow(RangeError);
    await expect(service.addRecurring('bad', {}, { cron: '* * * * *' })).rejects.toThrow(
      'cannot use the job name',
    );
    expect(() => service.process('good', () => {})).not.toThrow();
  });

  it('refuses a name RabbitMqQueue cannot derive queues for, without quoting it', () => {
    const adapter = new RabbitMqQueue(new FakeRuntimeServices(), {
      client: createFakeAmqpConnection(),
    });
    const service = new QueueService(adapter, new FakeRuntimeServices());
    const name = 'n'.repeat(241);
    let message = '';
    try {
      service.process(name, () => {});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("exceed AMQP's 255 UTF-8 byte limit");
    expect(message).not.toContain(name);
    expect(() => service.process('n'.repeat(240), () => {})).not.toThrow();
  });
});

describe('QueueService — one failing name never stops the others', () => {
  it('polls the processors registered after a name whose reserve fails', async () => {
    const runtime = new FakeRuntimeServices(1_000);
    const adapter = new RefusingQueue();
    const { logger, logged } = recordingLogger();
    const service = new QueueService(adapter, runtime, { pollIntervalMs: 10, logger });
    await service.connect();
    const handled: unknown[] = [];
    service.process('bad', () => {}); // registered FIRST, so it is polled first
    service.process('good', (job) => {
      handled.push(job.data);
    });
    await service.add('good', { n: 1 });

    await runtime.advanceMs(20);
    await service.disconnect();

    expect(handled).toEqual([{ n: 1 }]);
    expect(logged.some((l) => l.message === 'queue reserve failed' && l.name === 'bad')).toBe(true);
  });

  it('enqueues the recurring jobs after one whose enqueue fails, leaving that one due', async () => {
    const runtime = new FakeRuntimeServices(1_000);
    const adapter = new RefusingQueue();
    const { logger, logged } = recordingLogger();
    const service = new QueueService(adapter, runtime, { pollIntervalMs: 1_000, logger });
    await service.connect();
    await service.addRecurring('bad', {}, { cron: '* * * * *' });
    await service.addRecurring('good', { n: 1 }, { cron: '* * * * *' });
    const handled: unknown[] = [];
    service.process('good', (job) => {
      handled.push(job.data);
    });

    await runtime.advanceMs(62_000);
    await service.disconnect();

    expect(handled.length).toBeGreaterThan(0);
    expect(logged.some((l) => l.message === 'queue recurring enqueue failed' && l.name === 'bad'))
      .toBe(true);
    // Only the good entry was advanced: the failed one stays due for a retry.
    expect(adapter.advanced).toHaveLength(handled.length);
  });
});
