/**
 * Integration test: RealtimeBackplanePlugin in a real kernel app.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type { IRealtimeBackplane } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { RealtimeBackplanePlugin } from '../../src/index.ts';

describe('RealtimeBackplanePlugin', () => {
  it('registers a connected transport under the capability token', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), RealtimeBackplanePlugin({ transport: 'memory', bus: 'app-1' })],
    });
    await app.start();

    const backplane = app.services.get<IRealtimeBackplane>(CAPABILITIES.REALTIME_BACKPLANE);
    expect(backplane).toBeDefined();
    // Connected during register: publishing works with no further setup.
    await backplane.publish({
      kind: 'ws-room',
      origin: backplane.origin,
      name: 'lobby',
      data: 'hi',
    });

    await app.stop();
  });

  it('derives a distinct origin per application from the runtime', async () => {
    const first = createApplication({
      plugins: [RuntimePlugin(), RealtimeBackplanePlugin({ transport: 'memory', bus: 'app-2' })],
    });
    const second = createApplication({
      plugins: [RuntimePlugin(), RealtimeBackplanePlugin({ transport: 'memory', bus: 'app-2' })],
    });
    await first.start();
    await second.start();

    const a = first.services.get<IRealtimeBackplane>(CAPABILITIES.REALTIME_BACKPLANE);
    const b = second.services.get<IRealtimeBackplane>(CAPABILITIES.REALTIME_BACKPLANE);

    // Two replicas must never share an origin, or each would drop the other's
    // frames as its own echo.
    expect(a.origin).not.toBe(b.origin);

    await first.stop();
    await second.stop();
  });

  it('fans a frame out between two applications sharing a bus', async () => {
    const first = createApplication({
      plugins: [RuntimePlugin(), RealtimeBackplanePlugin({ transport: 'memory', bus: 'app-3' })],
    });
    const second = createApplication({
      plugins: [RuntimePlugin(), RealtimeBackplanePlugin({ transport: 'memory', bus: 'app-3' })],
    });
    await first.start();
    await second.start();

    const a = first.services.get<IRealtimeBackplane>(CAPABILITIES.REALTIME_BACKPLANE);
    const b = second.services.get<IRealtimeBackplane>(CAPABILITIES.REALTIME_BACKPLANE);

    const received: string[] = [];
    await b.subscribe((frame) => received.push(frame.name));
    await a.publish({ kind: 'ws-room', origin: a.origin, name: 'lobby', data: 'hi' });

    expect(received).toEqual(['lobby']);

    await first.stop();
    await second.stop();
  });

  it('closes the transport on application shutdown', async () => {
    let closed = false;
    const instance: IRealtimeBackplane = {
      origin: 'custom',
      connect: () => Promise.resolve(),
      publish: () => Promise.resolve(),
      subscribe: () => Promise.resolve(() => {}),
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    };

    const app = createApplication({
      plugins: [RuntimePlugin(), RealtimeBackplanePlugin({ transport: 'custom', instance })],
    });
    await app.start();
    expect(closed).toBe(false);

    await app.stop();
    expect(closed).toBe(true);
  });

  it('connects the transport during register, before the app is started', async () => {
    const order: string[] = [];
    const instance: IRealtimeBackplane = {
      origin: 'custom',
      connect: () => {
        order.push('connect');
        return Promise.resolve();
      },
      publish: () => Promise.resolve(),
      subscribe: () => {
        order.push('subscribe');
        return Promise.resolve(() => {});
      },
      close: () => Promise.resolve(),
    };

    const app = createApplication({
      plugins: [RuntimePlugin(), RealtimeBackplanePlugin({ transport: 'custom', instance })],
    });
    await app.start();

    // connect() is awaited inside register(), so a consumer subscribing later
    // never races an unconnected transport.
    expect(order[0]).toBe('connect');
    await app.stop();
  });
});
