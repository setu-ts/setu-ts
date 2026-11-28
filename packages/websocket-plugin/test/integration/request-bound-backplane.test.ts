/**
 * Integration: rooms on Workers across two isolates sharing one hub.
 *
 * Two `WebSocketService` instances, each on a Workers runtime, share one fake
 * hub whose links and sockets enforce workerd's request-ownership rule. This
 * is the V13-195/V13-196 shape: before request-bound delivery a room worked
 * only while each isolate had a single member.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';
import type { IWebSocketConnection, WebSocketEventSink } from '@setu-ts/common';
import { resolveOptions, WebSocketService } from '../../src/services/websocket-service.ts';
import { createFakeRuntime, upgradeRequest } from '../fixtures/fake-runtime.ts';
import {
  FakeHub,
  ownedTransport,
  type OwnedTransport,
  RequestWorld,
} from '../fixtures/request-bound-socket.ts';

interface Member {
  readonly owner: string;
  readonly sink: WebSocketEventSink;
  readonly transport: OwnedTransport;
  conn: IWebSocketConnection | undefined;
}

/** One isolate: a Workers service on the shared hub with a chat route. */
function isolate(
  world: RequestWorld,
  hub: FakeHub,
  origin: string,
): {
  service: WebSocketService;
  join(owner: string): Promise<Member>;
} {
  const runtime = {
    ...createFakeRuntime({ uuidPrefix: origin }),
    platform: () => 'cloudflare-workers' as const,
  };
  const service = new WebSocketService(
    runtime,
    resolveOptions(undefined),
    true,
    undefined,
    hub.backplane(origin),
  );
  let opening: Member | undefined;
  service.route('/chat', {
    onOpen: (conn) => {
      if (opening !== undefined) opening.conn = conn;
      service.room('lobby').add(conn);
    },
    onMessage: (conn, data) => {
      service.room('lobby').broadcast(data, { except: conn });
    },
  });
  return {
    service,
    async join(owner) {
      const decision = await service.createUpgradeRouter()(upgradeRequest('http://w/chat'));
      if (decision === null || !decision.accept) throw new Error('not accepted');
      const member = world.run(owner, () => {
        const transport = ownedTransport(world);
        const m: Member = { owner, sink: decision.sink, transport, conn: undefined };
        opening = m;
        decision.sink.onOpen(transport);
        opening = undefined;
        return m;
      });
      return member;
    },
  };
}

describe('Workers rooms across two isolates', () => {
  it('a 200-member room: every member hears a member and a route broadcast', async () => {
    const world = new RequestWorld();
    const hub = new FakeHub(world);
    const a = isolate(world, hub, 'a');
    const b = isolate(world, hub, 'b');
    const members: Member[] = [];
    for (let i = 0; i < 100; i++) members.push(await a.join(`a${i}`));
    for (let i = 0; i < 100; i++) members.push(await b.join(`b${i}`));

    const sender = members[0] as Member;
    world.run(sender.owner, () => {
      sender.sink.onMessage('from a0');
    });
    world.run('route', () => {
      b.service.room('lobby').broadcast('from a route');
    });

    const others = members.slice(1);
    expect(others.every((m) => m.transport.sent.includes('from a0'))).toBe(true);
    expect(sender.transport.sent).toEqual(['from a route']);
    expect(members.every((m) => m.transport.sent.includes('from a route'))).toBe(true);
    expect(a.service.room('lobby').size).toBe(100);
    expect(b.service.room('lobby').size).toBe(100);
    expect(world.violations).toEqual([]);
  });

  it('keeps delivering after 25 turnovers, with one hub link per live member', async () => {
    const world = new RequestWorld();
    const hub = new FakeHub(world);
    const a = isolate(world, hub, 'a');
    const b = isolate(world, hub, 'b');
    const listener = await b.join('listener');
    let current = await a.join('first');

    for (let i = 0; i < 25; i++) {
      const leaving = current;
      world.run(leaving.owner, () => {
        leaving.sink.onClose({ code: 1000, reason: '' });
      });
      current = await a.join(`member${i}`);
    }
    expect(hub.links.size).toBe(2);

    world.run(current.owner, () => {
      current.sink.onMessage('still here');
    });
    expect(listener.transport.sent).toEqual(['still here']);
    expect(world.violations).toEqual([]);
  });

  it('200 frames from one member arrive in order at another', async () => {
    const world = new RequestWorld();
    const hub = new FakeHub(world);
    const a = isolate(world, hub, 'a');
    const b = isolate(world, hub, 'b');
    const sender = await a.join('s');
    const receiver = await b.join('r');

    for (let i = 0; i < 200; i++) {
      world.run('s', () => {
        sender.sink.onMessage(`m${i}`);
      });
    }

    expect(receiver.transport.sent).toEqual(Array.from({ length: 200 }, (_, i) => `m${i}`));
    expect(hub.posts).toBe(0);
  });
});
