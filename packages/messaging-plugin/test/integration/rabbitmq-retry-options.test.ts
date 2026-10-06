import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MessagingPlugin } from '../../src/index.ts';
import { FakeAmqpConnection } from '../fixtures/fake-amqplib-client.ts';

describe('RabbitMQ retry options through MessagingPlugin', () => {
  it('reads every new option under non-default configuration', async () => {
    const client = new FakeAmqpConnection();
    let classifications = 0;
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MessagingPlugin({
          broker: 'rabbitmq',
          client,
          prefetch: 7,
          deadLetterMaxLength: 9,
          consumerRetry: {
            maxAttempts: 2,
            delaysMs: [17, 53],
            isRetryable: () => {
              classifications++;
              return true;
            },
          },
          subscriptions: [{
            topic: 't',
            options: { queue: 'q' },
            handler: () => {
              throw Error('blip');
            },
          }],
        }),
      ],
    });
    try {
      await app.start();
      const channel = await client.createChannel();
      await channel.deliver('1');
      await channel.deliver('1', { headers: { 'x-setu-attempt': 2 } });
      expect(classifications).toBe(2);
      expect(channel.calls.find((c) => c.method === 'prefetch')?.args).toEqual([7]);
      expect(
        channel.calls.find((c) => c.method === 'assertQueue' && c.args[0] === 'q.dead')?.args[1],
      )
        .toEqual({ durable: true, arguments: { 'x-max-length': 9 } });
      expect(
        channel.calls.find((c) => c.method === 'assertQueue' && c.args[0] === 'q.retry.53ms')
          ?.args[1],
      )
        .toEqual({
          durable: true,
          arguments: {
            'x-message-ttl': 53,
            'x-dead-letter-exchange': '',
            'x-dead-letter-routing-key': 'q',
          },
        });
      expect(channel.calls.filter((c) => c.method === 'publish').map((c) => c.args[1]))
        .toEqual(['q.retry.17ms', 'q.dead']);
    } finally {
      await app.stop();
    }
  });

  it('threads the false policy through the plugin', async () => {
    const client = new FakeAmqpConnection();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MessagingPlugin({
          broker: 'rabbitmq',
          client,
          consumerRetry: false,
          subscriptions: [{
            topic: 't',
            options: { queue: 'q' },
            handler: () => {
              throw Error('blip');
            },
          }],
        }),
      ],
    });
    try {
      await app.start();
      const channel = await client.createChannel();
      await channel.deliver('1');
      expect(channel.calls.filter((c) => c.method === 'assertQueue')).toHaveLength(1);
      expect(channel.calls.find((c) => c.method === 'nack')?.args.slice(1)).toEqual([false, false]);
    } finally {
      await app.stop();
    }
  });
});
