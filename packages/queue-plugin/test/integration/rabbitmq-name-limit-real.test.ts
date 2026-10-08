/**
 * Real RabbitMQ: a job name whose queue names exceed AMQP's 255-byte short
 * string is refused before any channel operation. amqplib claims the
 * channel's RPC reply slot before encoding a declaration, so before this guard
 * one such name left every later declaration on the channel waiting forever
 * (M106 audit O4). Guarded with `ignore:` on `RABBITMQ_URL`.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { RabbitMqQueue } from '../../src/adapters/rabbitmq-queue.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';

const url = Deno.env.get('RABBITMQ_URL');

/** Resolves `'resolved'`, `'rejected'` or `'pending'` after `ms`. */
function outcome(promise: Promise<unknown>, ms: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.then(() => 'resolved', () => 'rejected'),
    new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve('pending'), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

describe('REAL RabbitMqQueue name limit (guarded)', () => {
  it('refuses an oversized job name without jamming the channel', {
    ignore: url === undefined,
  }, async () => {
    const runtime = new FakeRuntimeServices();
    const prefix = `m106-o4-${crypto.randomUUID().slice(0, 8)}`;
    const queue = new RabbitMqQueue(runtime, { url: url!, prefix });
    await queue.connect();
    const job = (name: string) => ({
      id: crypto.randomUUID(),
      name,
      data: { n: 1 },
      attempts: 0,
      maxAttempts: 1,
      availableAtMs: 0,
    });
    try {
      await expect(queue.enqueue(job('n'.repeat(250)))).rejects.toThrow('its queue names exceed');
      // Before the guard, a declaration for a NEW name never answered here.
      expect(await outcome(queue.enqueue(job('after')), 2_000)).toBe('resolved');
      const reserving = queue.reserve('after', 1, runtime.now());
      expect(await outcome(reserving, 2_000)).toBe('resolved');
      expect((await reserving).map((j) => j.name)).toEqual(['after']);
    } finally {
      await queue.disconnect();
    }
  });
});
