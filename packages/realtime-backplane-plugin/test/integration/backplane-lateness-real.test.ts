import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { MessagingBackplane, RedisBackplane } from '../../src/index.ts';
import { realFanOutPair, untilReal } from '../../../messaging-plugin/test/fixtures/real-fan-out.ts';

/** A task-owned relay stalls only these test connections; no backend process is changed. */
async function stallingRelay(upstreamUrl: string) {
  const endpoint = new URL(upstreamUrl.replace('localhost', '127.0.0.1'));
  const target = {
    host: endpoint.hostname,
    port: Number(endpoint.port || (endpoint.protocol === 'redis:' ? 6379 : 5672)),
  };
  const sockets = new Set<net.Socket>();
  let stalled = false;
  const pending: Array<() => void> = [];
  const server = net.createServer((client) => {
    const upstream = net.connect(target);
    sockets.add(client);
    sockets.add(upstream);
    const close = (): void => {
      client.destroy();
      upstream.destroy();
      sockets.delete(client);
      sockets.delete(upstream);
    };
    for (const socket of [client, upstream]) {
      socket.on('error', close);
      socket.on('close', close);
    }
    client.on('data', (chunk: Buffer) => {
      const send = (): void => {
        if (!upstream.destroyed) upstream.write(chunk);
      };
      if (stalled) pending.push(send);
      else send();
    });
    upstream.on('data', (chunk: Buffer) => {
      if (!client.destroyed) client.write(chunk);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as net.AddressInfo;
  endpoint.hostname = '127.0.0.1';
  endpoint.port = String(address.port);
  return {
    url: endpoint.toString(),
    stall: (): void => {
      stalled = true;
    },
    resume: (): void => {
      stalled = false;
      for (const send of pending.splice(0)) send();
    },
    buffered: (): number => pending.length,
    close: async (): Promise<void> => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('real frames delayed in a task-owned TCP relay', () => {
  for (const arm of ['redis', 'rabbitmq'] as const) {
    const endpoint = process.env[arm === 'redis' ? 'REDIS_URL' : 'RABBITMQ_URL'];
    for (const maxFrameAgeMs of [0, 1000]) {
      it(
        `${arm} ${maxFrameAgeMs === 0 ? 'delivers by default' : 'drops with an opt-in bound'} after a three-second stall`,
        { skip: endpoint === undefined, timeout: 60000 },
        async () => {
          const relay = await stallingRelay(endpoint!);
          const runtime = createNodeRuntimeServices();
          const warnings: string[] = [];
          const reporter = {
            failed: () => {},
            succeeded: () => {},
            warn: (message: string) => {
              warnings.push(message);
            },
          };
          const received: string[] = [];
          let close: () => Promise<void>;
          let publish: (data: string) => Promise<void>;
          if (arm === 'redis') {
            const topic = 'm143p-' + runtime.uuid();
            const sender = new RedisBackplane(
              { transport: 'redis', url: relay.url, maxFrameAgeMs },
              'sender',
              topic,
              reporter,
              () => runtime.now(),
            );
            const receiver = new RedisBackplane(
              { transport: 'redis', url: endpoint!, maxFrameAgeMs },
              'receiver',
              topic,
              reporter,
              () => runtime.now(),
            );
            close = async () => {
              await sender.close();
              await receiver.close();
            };
            try {
              await sender.connect();
              await receiver.connect();
            } catch (error) {
              await close();
              await relay.close();
              throw error;
            }
            await receiver.subscribe((frame) => {
              received.push(frame.data);
            });
            publish = (data) =>
              sender.publish({ kind: 'ws-room', origin: 'sender', name: 'room', data });
          } else {
            const h = await realFanOutPair('rabbitmq', relay.url).catch(async (error: unknown) => {
              await relay.close();
              throw error;
            });
            const sender = new MessagingBackplane(
              h.brokers[0],
              'sender',
              h.topic,
              reporter,
              () => runtime.now(),
              maxFrameAgeMs,
            );
            const receiver = new MessagingBackplane(
              h.brokers[1],
              'receiver',
              h.topic,
              reporter,
              () => runtime.now(),
              maxFrameAgeMs,
            );
            close = async () => {
              await sender.close();
              await receiver.close();
              await h.close();
            };
            try {
              await sender.connect();
              await receiver.connect();
            } catch (error) {
              await close();
              await relay.close();
              throw error;
            }
            await receiver.subscribe((frame) => {
              received.push(frame.data);
            });
            publish = (data) =>
              sender.publish({ kind: 'ws-room', origin: 'sender', name: 'room', data });
          }
          try {
            relay.stall();
            const late = publish('late');
            await untilReal(() => relay.buffered() > 0);
            await new Promise((resolve) => setTimeout(resolve, 3000));
            relay.resume();
            await late;
            await publish('fresh');
            await untilReal(() => received.includes('fresh'));
            expect(received).toEqual(maxFrameAgeMs === 0 ? ['late', 'fresh'] : ['fresh']);
            expect(warnings.some((message) => message.includes('dropping frames'))).toBe(
              maxFrameAgeMs > 0,
            );
          } finally {
            relay.resume();
            await close();
            await relay.close();
          }
        },
      );
    }
  }
});
