/**
 * A WebSocket room on Workers, while the publishing connection's link is still
 * opening: what the link's byte budget refuses goes through the hub's HTTP
 * publish, and still arrives.
 *
 * Drives websocket-plugin's `RequestBoundRooms` (the caller that falls back)
 * against cloudflare-plugin's `DurableObjectBackplane` and the real hub core
 * behind the shared Durable Object fake, so the 413 is the hub's own.
 *
 * @module
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setImmediate } from 'node:timers/promises';

import type { IWebSocketConnection } from '@setu-ts/common';
import { RequestBoundRooms } from '../packages/websocket-plugin/src/rooms/request-bound-rooms.ts';
import { Room } from '../packages/websocket-plugin/src/rooms/room-registry.ts';
import { DurableObjectBackplane } from '../packages/cloudflare-plugin/src/realtime/durable-object-backplane.ts';
import { LINK_QUEUE_BYTE_BUDGET } from '../packages/cloudflare-plugin/src/realtime/connection-link.ts';
import type { IDurableObjectNamespace } from '../packages/cloudflare-plugin/src/bindings/facades.ts';
import { FakeDurableObjectNamespace } from '../packages/cloudflare-plugin/test/do-fakes.ts';
import { RecordingLogger } from '../packages/cloudflare-plugin/test/fakes.ts';
import { WorkersResponse } from './node-helpers.ts';

const nativeResponse = globalThis.Response;
beforeEach(() => {
  // The Workers fakes answer a 101 that Node's own Response refuses to build.
  globalThis.Response = WorkersResponse;
});
afterEach(() => {
  globalThis.Response = nativeResponse;
});

/** One fixture: a receiver whose link is open, a sender whose link is not. */
async function world(): Promise<{
  rooms: RequestBoundRooms;
  sender: IWebSocketConnection;
  got: string[];
  posts: () => number;
  logger: RecordingLogger;
}> {
  const real = new FakeDurableObjectNamespace();
  let posts = 0;
  const namespace: IDurableObjectNamespace = {
    idFromName: (name) => real.idFromName(name),
    get: (id) => ({
      fetch: (input: Request | string, init?: RequestInit): Promise<Response> => {
        if (init?.method === 'POST') posts++;
        return real.get(id).fetch(input, init);
      },
    }),
  };
  const logger = new RecordingLogger();
  const backplane = new DurableObjectBackplane(namespace, {
    origin: 'isolate',
    binding: 'REALTIME',
    topic: 'chat',
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as never),
    },
    logger: () => logger,
  });
  const rooms = new RequestBoundRooms(backplane);
  const got: string[] = [];
  const receiver = {
    id: 'receiver',
    isOpen: true,
    send: (data: string) => got.push(data),
  } as unknown as IWebSocketConnection;
  const sender = { id: 'sender', isOpen: true, send: () => {} } as unknown as IWebSocketConnection;
  rooms.open(receiver, () => true);
  await setImmediate();
  // The sender's link starts opening now and is not open until a later tick.
  rooms.open(sender, () => true);
  return { rooms, sender, got, posts: () => posts, logger };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await setImmediate();
};

describe('a room broadcast while its link opens, past the link byte budget', () => {
  it('sends a frame larger than the budget through the hub, and it is delivered', async () => {
    const { rooms, sender, got, posts } = await world();
    const big = 'b'.repeat(LINK_QUEUE_BYTE_BUDGET + 1);

    rooms.dispatching(sender, () => rooms.broadcast(new Room('lobby'), big));
    await settle();

    expect(posts()).toBe(1);
    expect(got).toEqual([big]);
  });

  it('overflows a run of small frames to the hub once the budget is used, and every frame arrives', async () => {
    const { rooms, sender, got, posts } = await world();
    const size = 100 * 1024;
    const frames = Array.from({ length: 20 }, (_, i) => `${i}:`.padEnd(size, 's'));

    rooms.dispatching(sender, () => {
      for (const f of frames) rooms.broadcast(new Room('lobby'), f);
    });
    await settle();

    // 10 fit in 1 MiB (10 × 100 KiB); the other 10 went through the hub.
    expect(posts()).toBe(10);
    expect([...got].sort()).toEqual([...frames].sort());
  });

  it('reports a frame above the hub cap as a 413, never dropping it in silence', async () => {
    const { rooms, sender, got, posts, logger } = await world();

    rooms.dispatching(sender, () => rooms.broadcast(new Room('lobby'), 'x'.repeat(33_554_433)));
    await settle();

    expect(posts()).toBe(1);
    expect(got).toEqual([]);
    expect(logger.records.map((r) => [r.message, r.meta])).toEqual([
      ['cloudflare: backplane publish failed', { topic: 'chat', status: 413 }],
    ]);
  });
});
