/**
 * Rooms on Cloudflare Workers: request-bound delivery.
 *
 * Every test runs on fakes that throw for cross-request I/O, as workerd does;
 * the first test proves the fake throws, so a pass here cannot be a pass
 * against the defect (a room writing to its members from whichever request
 * broadcasts).
 *
 * @module
 */

import { describe, expect, it } from 'vitest';
import type {
  IRealtimeBackplane,
  IWebSocketConnection,
  RealtimeFrame,
  WebSocketEventSink,
  WebSocketHandlers,
} from '@setu-ts/common';
import { resolveOptions, WebSocketService } from '../../src/services/websocket-service.ts';
import { WebSocketRoomsUnavailableError } from '../../src/errors/websocket-errors.ts';
import { RequestBoundRooms } from '../../src/rooms/request-bound-rooms.ts';
import { Room } from '../../src/rooms/room-registry.ts';
import {
  createFakeLogger,
  createFakeRuntime,
  type FakeLogger,
  type FakeRuntime,
  upgradeRequest,
} from '../fixtures/fake-runtime.ts';
import {
  FakeHub,
  FOREIGN_IO,
  ownedTransport,
  type OwnedTransport,
  RequestWorld,
} from '../fixtures/request-bound-socket.ts';

/** A runtime reporting Cloudflare Workers. */
function workersRuntime(): FakeRuntime {
  const runtime = createFakeRuntime();
  return { ...runtime, platform: () => 'cloudflare-workers' as const };
}

interface Harness {
  readonly world: RequestWorld;
  readonly hub: FakeHub;
  readonly service: WebSocketService;
  readonly runtime: FakeRuntime;
  readonly logger: FakeLogger;
  /** Connects a member in its own request; returns its connection and transport. */
  connect(owner: string): Promise<{ conn: IWebSocketConnection; transport: OwnedTransport }>;
  /** Delivers a client message in the owner's request. */
  message(owner: string, data: string): void;
  /** Closes a member from the peer side, in its own request. */
  disconnect(owner: string): void;
}

/** Builds a Workers service on a fake hub, with one route whose handlers the test supplies. */
function harness(
  handlers: Partial<WebSocketHandlers> = {},
  shared?: { world: RequestWorld; hub: FakeHub },
  origin = 'isolate-a',
): Promise<Harness> {
  const world = shared?.world ?? new RequestWorld();
  const hub = shared?.hub ?? new FakeHub(world);
  const runtime = workersRuntime();
  const logger = createFakeLogger();
  const service = new WebSocketService(
    runtime,
    resolveOptions({ heartbeatMs: 1000 }),
    true,
    logger,
    hub.backplane(origin),
  );
  const conns = new Map<string, IWebSocketConnection>();
  const sinks = new Map<string, WebSocketEventSink>();
  service.route('/ws', {
    onOpen: (conn) => {
      service.room('lobby').add(conn);
    },
    ...handlers,
  } as WebSocketHandlers);
  return Promise.resolve({
    world,
    hub,
    service,
    runtime,
    logger,
    async connect(owner) {
      const decision = await service.createUpgradeRouter()(upgradeRequest('http://w/ws'));
      if (decision === null || !decision.accept) throw new Error('not accepted');
      const sink = decision.sink;
      sinks.set(owner, sink);
      let transport!: OwnedTransport;
      world.run(owner, () => {
        transport = ownedTransport(world);
        sink.onOpen(transport);
      });
      // The connection object is the one onOpen handed the route handler.
      const opened = lastOpened.get(service);
      if (opened === undefined) throw new Error('no connection');
      conns.set(owner, opened);
      return { conn: opened, transport };
    },
    message(owner, data) {
      world.run(owner, () => {
        sinks.get(owner)?.onMessage(data);
      });
    },
    disconnect(owner) {
      world.run(owner, () => {
        sinks.get(owner)?.onClose({ code: 1000, reason: '' });
      });
    },
  });
}

/** The last connection each service opened, recorded by a wrapping onOpen. */
const lastOpened = new WeakMap<WebSocketService, IWebSocketConnection>();

/** A harness whose route records the opened connection and runs extra handlers. */
async function rooms(
  handlers: Partial<WebSocketHandlers> = {},
  shared?: { world: RequestWorld; hub: FakeHub },
  origin?: string,
): Promise<Harness> {
  const ref: { service?: WebSocketService } = {};
  const h = await harness(
    {
      onOpen: (conn, context) => {
        if (ref.service !== undefined) lastOpened.set(ref.service, conn);
        ref.service?.room('lobby').add(conn);
        void handlers.onOpen?.(conn, context);
      },
      ...(handlers.onMessage === undefined ? {} : { onMessage: handlers.onMessage }),
      ...(handlers.onClose === undefined ? {} : { onClose: handlers.onClose }),
    },
    shared,
    origin,
  );
  ref.service = h.service;
  return h;
}

describe('the request-ownership fake', () => {
  it('throws for a write from another request, as workerd does', () => {
    const world = new RequestWorld();
    const transport = world.run('a', () => ownedTransport(world));
    expect(() => {
      world.run('b', () => transport.send('x'));
    }).toThrow(FOREIGN_IO);
    expect(world.violations).toHaveLength(1);
  });
});

describe('request-bound rooms on Workers', () => {
  it("delivers a member's broadcast to the others without any cross-request write", async () => {
    const ref: { service?: WebSocketService } = {};
    const h = await rooms({
      onMessage: (conn, data) => {
        ref.service?.room('lobby').broadcast(data, { except: conn });
      },
    });
    ref.service = h.service;
    const a = await h.connect('a');
    const b = await h.connect('b');
    const c = await h.connect('c');

    h.message('a', 'hi');

    expect(b.transport.sent).toEqual(['hi']);
    expect(c.transport.sent).toEqual(['hi']);
    expect(a.transport.sent).toEqual([]);
    expect(h.world.violations).toEqual([]);
    expect(h.hub.posts).toBe(0);
  });

  it('delivers a broadcast without except to the sender locally, once', async () => {
    const ref: { service?: WebSocketService } = {};
    const h = await rooms({
      onMessage: (_conn, data) => {
        ref.service?.room('lobby').broadcast(data);
      },
    });
    ref.service = h.service;
    const a = await h.connect('a');
    const b = await h.connect('b');

    h.message('a', 'all');

    expect(a.transport.sent).toEqual(['all']);
    expect(b.transport.sent).toEqual(['all']);
    expect(h.world.violations).toEqual([]);
  });

  it('publishes a route broadcast through the hub, reaching every member', async () => {
    const h = await rooms();
    const a = await h.connect('a');
    const b = await h.connect('b');

    h.world.run('route', () => {
      h.service.room('lobby').broadcast('news');
    });

    expect(a.transport.sent).toEqual(['news']);
    expect(b.transport.sent).toEqual(['news']);
    expect(h.hub.posts).toBe(1);
    expect(h.world.violations).toEqual([]);
  });

  it("falls back to the hub when the except connection's link belongs to another request, logging once", async () => {
    const h = await rooms();
    const a = await h.connect('a');
    const b = await h.connect('b');

    h.world.run('route', () => {
      h.service.room('lobby').broadcast('one', { except: a.conn });
      h.service.room('lobby').broadcast('two', { except: a.conn });
    });

    expect(a.transport.sent).toEqual([]);
    expect(b.transport.sent).toEqual(['one', 'two']);
    expect(h.hub.posts).toBe(2);
    expect(h.logger.entries.filter((e) => e.level === 'debug')).toHaveLength(1);
    expect(h.world.violations).toEqual([]);
  });

  it('publishes over the except link after an await, inside its own request', async () => {
    const h = await rooms();
    const a = await h.connect('a');
    const b = await h.connect('b');

    // Outside any dispatch window, but running as request 'a'.
    h.world.run('a', () => {
      h.service.room('lobby').broadcast('later', { except: a.conn });
    });

    expect(b.transport.sent).toEqual(['later']);
    expect(a.transport.sent).toEqual([]);
    expect(h.hub.posts).toBe(0);
  });

  it('answers size from a route without touching any socket', async () => {
    const h = await rooms();
    await h.connect('a');
    await h.connect('b');

    const size = h.world.run('route', () => h.service.room('lobby').size);

    expect(size).toBe(2);
    expect(h.world.violations).toEqual([]);
  });

  it('delivers nothing to a connection that is not a member of the room', async () => {
    const h = await rooms();
    const a = await h.connect('a');
    const b = await h.connect('b');
    h.service.room('lobby').remove(b.conn);

    h.world.run('route', () => {
      h.service.room('lobby').broadcast('members only');
    });

    expect(a.transport.sent).toEqual(['members only']);
    expect(b.transport.sent).toEqual([]);
  });

  it("closes a leaving member's link and keeps delivering to the rest", async () => {
    const h = await rooms();
    await h.connect('a');
    const b = await h.connect('b');
    expect(h.hub.links.size).toBe(2);

    h.disconnect('a');
    expect(h.hub.links.size).toBe(1);

    h.world.run('route', () => {
      h.service.room('lobby').broadcast('after');
    });
    expect(b.transport.sent).toEqual(['after']);
    expect(h.world.violations).toEqual([]);
  });

  it('runs one heartbeat interval per connection, cleared on close, and no shared sweeper', async () => {
    const h = await rooms();
    const a = await h.connect('a');
    await h.connect('b');
    expect(h.runtime.intervals).toHaveLength(2);

    // Each tick runs in its own connection's request.
    h.world.run('a', () => {
      h.runtime.intervals[0]?.fn();
    });
    expect(a.transport.sent).toEqual(['ping']);

    h.disconnect('a');
    expect(h.runtime.intervals[0]?.cleared).toBe(true);
    expect(h.runtime.intervals[1]?.cleared).toBe(false);
  });

  it('ignores frames of another kind and frames excluding this connection', async () => {
    const h = await rooms();
    const a = await h.connect('a');
    const frame = (overrides: Partial<RealtimeFrame>): RealtimeFrame => ({
      kind: 'ws-room',
      origin: 'x',
      name: 'lobby',
      data: 'payload',
      ...overrides,
    });

    void h.hub.backplane('other').publishViaHub(frame({ kind: 'sse-channel' }));
    void h.hub.backplane('other').publishViaHub(frame({ exceptId: a.conn.id }));
    void h.hub.backplane('other').publishViaHub(frame({ binary: true, data: '%%%' }));
    void h.hub.backplane('other').publishViaHub(frame({}));

    expect(a.transport.sent).toEqual(['payload']);
  });
});

describe('a broadcast from onClose', () => {
  it("goes over the leaving member's own link, not the hub", async () => {
    const ref: { service?: WebSocketService } = {};
    const h = await rooms({
      onClose: (conn) => {
        ref.service?.room('lobby').broadcast('left', { except: conn });
      },
    });
    ref.service = h.service;
    await h.connect('a');
    const b = await h.connect('b');
    h.disconnect('a');
    expect(b.transport.sent).toEqual(['left']);
    expect(h.hub.posts).toBe(0);
    expect(h.hub.links.size).toBe(1);
  });
});

describe('Workers without a link backplane', () => {
  it('refuses rooms by name and keeps single-socket routes working', () => {
    const plain: IRealtimeBackplane = {
      origin: 'o',
      connect: () => Promise.resolve(),
      publish: () => Promise.resolve(),
      subscribe: () => Promise.resolve(() => {}),
      close: () => Promise.resolve(),
    };
    for (const backplane of [undefined, plain]) {
      const service = new WebSocketService(
        workersRuntime(),
        resolveOptions(undefined),
        true,
        undefined,
        backplane,
      );
      expect(() => service.room('lobby')).toThrow(WebSocketRoomsUnavailableError);
      expect(() => service.peek('lobby')).toThrow(/CloudflarePlugin\(\{ durableObject/);
      expect(() => {
        service.route('/ws', {});
      }).not.toThrow();
      expect(service.isRequestBound).toBe(true);
    }
  });

  it('leaves other runtimes in isolate mode', () => {
    const service = new WebSocketService(createFakeRuntime(), resolveOptions(undefined), true);
    expect(service.isRequestBound).toBe(false);
    expect(service.room('lobby').name).toBe('lobby');
  });
});

describe('RequestBoundRooms', () => {
  it('closes every link on closeAll and counts them', () => {
    const world = new RequestWorld();
    const hub = new FakeHub(world);
    const rooms = new RequestBoundRooms(hub.backplane('o'));
    const conn = { id: 'c1', isOpen: true, send: () => {} } as unknown as IWebSocketConnection;
    world.run('c1', () => {
      rooms.open(conn, () => true);
    });
    expect(rooms.linkCount).toBe(1);
    rooms.close({ id: 'missing' } as IWebSocketConnection);
    rooms.closeAll();
    expect(rooms.linkCount).toBe(0);
    expect(hub.links.size).toBe(0);
  });

  it('swallows a send that throws on a closing socket', () => {
    const world = new RequestWorld();
    const hub = new FakeHub(world);
    const rooms = new RequestBoundRooms(hub.backplane('o'));
    const conn = {
      id: 'c1',
      isOpen: true,
      send: () => {
        throw new Error('closing');
      },
    } as unknown as IWebSocketConnection;
    world.run('c1', () => {
      rooms.open(conn, () => true);
    });
    const room = new Room('lobby');
    room.add(conn);
    expect(() => {
      world.run('c1', () => {
        rooms.dispatching(conn, () => {
          rooms.broadcast(room, 'x');
        });
      });
      void hub
        .backplane('p')
        .publishViaHub({ kind: 'ws-room', origin: 'p', name: 'lobby', data: 'y' });
    }).not.toThrow();
  });

  it("delivers the sender's own broadcast locally when its link refuses it, excluded from the hub copy", () => {
    const world = new RequestWorld();
    const hub = new FakeHub(world);
    const posted: RealtimeFrame[] = [];
    const backplane = {
      ...hub.backplane('o'),
      // A link still opening with its byte budget used refuses every frame.
      openConnectionLink: () => ({ publish: () => false, close: () => {} }),
      publishViaHub: (frame: RealtimeFrame) => {
        posted.push(frame);
        return Promise.resolve();
      },
    };
    const rooms = new RequestBoundRooms(backplane);
    const got: unknown[] = [];
    const sender = {
      id: 'sender',
      isOpen: true,
      send: (d: unknown) => got.push(d),
    } as unknown as IWebSocketConnection;
    rooms.open(sender, () => true);
    const room = new Room('lobby');
    room.add(sender);

    rooms.dispatching(sender, () => {
      rooms.broadcast(room, 'mine');
    });

    expect(got).toEqual(['mine']);
    expect(posted.map((f) => f.exceptId)).toEqual(['sender']);
  });

  it('keeps the caller except on the hub copy when its link refuses, and sends the sender nothing', () => {
    const world = new RequestWorld();
    const hub = new FakeHub(world);
    const posted: RealtimeFrame[] = [];
    const backplane = {
      ...hub.backplane('o'),
      openConnectionLink: () => ({ publish: () => false, close: () => {} }),
      publishViaHub: (frame: RealtimeFrame) => {
        posted.push(frame);
        return Promise.resolve();
      },
    };
    const rooms = new RequestBoundRooms(backplane);
    const got: unknown[] = [];
    const sender = {
      id: 'sender',
      isOpen: true,
      send: (d: unknown) => got.push(d),
    } as unknown as IWebSocketConnection;
    rooms.open(sender, () => true);
    const room = new Room('lobby');
    room.add(sender);

    rooms.dispatching(sender, () => {
      rooms.broadcast(room, 'others', { except: sender });
    });

    expect(got).toEqual([]);
    expect(posted.map((f) => f.exceptId)).toEqual(['sender']);
  });

  it('delivers the sender its own refused broadcast when except names another member', () => {
    const world = new RequestWorld();
    const hub = new FakeHub(world);
    const posted: RealtimeFrame[] = [];
    const backplane = {
      ...hub.backplane('o'),
      openConnectionLink: () => ({ publish: () => false, close: () => {} }),
      publishViaHub: (frame: RealtimeFrame) => {
        posted.push(frame);
        return Promise.resolve();
      },
    };
    const rooms = new RequestBoundRooms(backplane);
    const got: unknown[] = [];
    const sender = {
      id: 'sender',
      isOpen: true,
      send: (d: unknown) => got.push(d),
    } as unknown as IWebSocketConnection;
    const other = { id: 'other', isOpen: true, send: () => {} } as unknown as IWebSocketConnection;
    rooms.open(sender, () => true);
    const room = new Room('lobby');
    room.add(sender);
    room.add(other);

    rooms.dispatching(sender, () => {
      rooms.broadcast(room, 'not for other', { except: other });
    });

    expect(got).toEqual(['not for other']);
    expect(posted.map((f) => f.exceptId)).toEqual(['other']);
  });

  it('logs a link that cannot open, and a hub publish that rejects', async () => {
    const logger = createFakeLogger();
    const world = new RequestWorld();
    const hub = new FakeHub(world);
    const failing = {
      ...hub.backplane('o'),
      openConnectionLink: () => {
        throw new Error('no timers');
      },
      publishViaHub: () => Promise.reject(new Error('hub down')),
    };
    const rooms = new RequestBoundRooms(failing, logger);
    const conn = { id: 'c', isOpen: true, send: () => {} } as unknown as IWebSocketConnection;
    expect(rooms.open(conn, () => true)).toBe(false);
    expect(rooms.linkCount).toBe(0);
    rooms.broadcast(new Room('lobby'), 'x');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(logger.entries.map((e) => e.message)).toEqual([
      'websocket: backplane link could not open',
      'websocket: backplane publish failed',
    ]);
  });
});

describe('connections whose link fails, and shutdown, on Workers', () => {
  it('closes a connection whose link cannot open with 1011, after its onOpen runs', async () => {
    const world = new RequestWorld();
    const hub = new FakeHub(world);
    const failing = {
      ...hub.backplane('o'),
      openConnectionLink: () => {
        throw new Error('no timers');
      },
    };
    const events: string[] = [];
    const service = new WebSocketService(
      workersRuntime(),
      resolveOptions(undefined),
      true,
      createFakeLogger(),
      failing,
    );
    service.route('/ws', {
      onOpen: () => {
        events.push('open');
      },
    });
    const decision = await service.createUpgradeRouter()(upgradeRequest('http://w/ws'));
    if (decision === null || !decision.accept) throw new Error('not accepted');
    let transport!: OwnedTransport;
    world.run('a', () => {
      transport = ownedTransport(world);
      decision.sink.onOpen(transport);
    });

    expect(events).toEqual(['open']);
    expect(transport.closes).toEqual([{ code: 1011, reason: 'Backplane link unavailable' }]);
  });

  it('closeAll closes every connection and stops every heartbeat when a close throws', async () => {
    const h = await rooms();
    await h.connect('a');
    await h.connect('b');
    expect(h.runtime.intervals.filter((i) => !i.cleared)).toHaveLength(2);

    // Outside any request: each Workers socket refuses the close.
    expect(() => {
      h.service.closeAll();
    }).not.toThrow();

    expect(h.service.connectionCount).toBe(0);
    expect(h.runtime.intervals.filter((i) => !i.cleared)).toEqual([]);
  });

  it('delivers to members of a room the application retained after it emptied', async () => {
    const h = await rooms();
    // Retained by the application; emptying it drops it from the name index.
    const chat = h.service.room('chat');
    const { conn: a, transport: ta } = await h.connect('a');
    const { conn: b, transport: tb } = await h.connect('b');
    chat.add(a);
    chat.remove(a);
    chat.add(a);
    chat.add(b);

    h.world.run('a', () => {
      chat.broadcast('to b', { except: a });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(tb.sent).toContain('to b');
    expect(ta.sent).not.toContain('to b');
  });

  it('is one member set through a kept handle and ws.room(name), once per connection', async () => {
    const h = await rooms();
    const { conn: a } = await h.connect('a');
    const { conn: b, transport: tb } = await h.connect('b');
    const { conn: c, transport: tc } = await h.connect('c');
    const kept = h.service.room('chat');
    kept.add(a);
    kept.remove(a); // the name empties and is released
    h.service.room('chat').add(b); // a fresh handle takes the name
    kept.add(c);
    kept.add(b); // through both handles: still one member

    h.world.run('a', () => {
      kept.broadcast('via kept');
    });
    h.service.room('chat').broadcast('via route');
    await new Promise((resolve) => setTimeout(resolve, 0));

    for (const t of [tb, tc]) {
      expect(t.sent.filter((m) => m === 'via kept')).toHaveLength(1);
      expect(t.sent.filter((m) => m === 'via route')).toHaveLength(1);
    }
    expect(h.service.room('chat').size).toBe(2);
    expect(h.world.violations).toEqual([]);
  });

  it('closeAll closes every link when one throws, and reports it', () => {
    const logger = createFakeLogger();
    const world = new RequestWorld();
    const hub = new FakeHub(world);
    const closed: string[] = [];
    const backplane = {
      ...hub.backplane('o'),
      openConnectionLink: (id: string) => ({
        publish: () => true,
        close: () => {
          if (id === 'a') throw new Error('foreign request');
          closed.push(id);
        },
      }),
    };
    const rooms = new RequestBoundRooms(backplane, logger);
    for (const id of ['a', 'b']) {
      rooms.open(
        { id, isOpen: true, send: () => {} } as unknown as IWebSocketConnection,
        () => true,
      );
    }

    rooms.closeAll();

    expect(closed).toEqual(['b']);
    expect(rooms.linkCount).toBe(0);
    expect(logger.entries.map((e) => e.message)).toContain(
      'websocket: backplane link failed to close',
    );
  });

  it('closeAll closes every link when a link and then the logger throw', () => {
    const world = new RequestWorld();
    const hub = new FakeHub(world);
    const closed: string[] = [];
    const backplane = {
      ...hub.backplane('o'),
      openConnectionLink: (id: string) => ({
        publish: () => true,
        close: () => {
          if (id === 'a') throw new Error('foreign request');
          closed.push(id);
        },
      }),
    };
    const logger = {
      ...createFakeLogger(),
      warn: (): void => {
        throw new Error('logger down');
      },
    };
    const rooms = new RequestBoundRooms(backplane, logger);
    for (const id of ['a', 'b']) {
      rooms.open(
        { id, isOpen: true, send: () => {} } as unknown as IWebSocketConnection,
        () => true,
      );
    }

    rooms.closeAll();

    expect(closed).toEqual(['b']);
    expect(rooms.linkCount).toBe(0);
  });

  it('closeAll clears its state when a heartbeat stop throws', async () => {
    const h = await rooms();
    await h.connect('a');
    const runtime = h.runtime as { clearInterval: (handle: unknown) => void };
    runtime.clearInterval = () => {
      throw new Error('no timer here');
    };

    expect(() => {
      h.service.closeAll();
    }).not.toThrow();
    expect(h.service.connectionCount).toBe(0);
  });
});
