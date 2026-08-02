/**
 * The read-it-back proof for both deliverables.
 *
 * A milestone can ship green with a no-op implementation whose tests assert the
 * no-op (M10 did exactly that). So these tests do not assert which methods were
 * called: replica A publishes and replica B RECEIVES, through the genuine
 * Durable Object fan-out; and the second lock caller is genuinely refused by
 * the real arbitration in `DistributedLockObjectCore`.
 *
 * The delegating class below is the documented one, character for character.
 * Writing it here is what proves the snippet in the README and the class JSDoc
 * is the shape that actually works, rather than an untested illustration.
 */

import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IRuntimeServices, RealtimeFrame } from '@hono-enterprise/common';
import type {
  IDurableObjectState,
  IDurableObjectWebSocket,
} from '../../src/durable-objects/do-facades.ts';
import { DistributedLockObjectCore } from '../../src/durable-objects/distributed-lock-object.ts';
import { RealtimeBackplaneObjectCore } from '../../src/durable-objects/realtime-backplane-object.ts';
import { DurableObjectBackplane } from '../../src/realtime/durable-object-backplane.ts';
import { DurableObjectLock } from '../../src/lock/durable-object-lock.ts';
import { FakeDurableObjectNamespace } from '../do-fakes.ts';

/**
 * The Durable Object class an application exports, exactly as documented.
 *
 * On Workers this would `extends DurableObject` from `cloudflare:workers` and
 * read `this.ctx`. That specifier is unresolvable here, so the base class is
 * elided and the state is taken as a constructor argument — which is the whole
 * point of the delegation design: the behavior under test is identical either
 * way, because it all lives in the core.
 */
class RealtimeBackplaneObject {
  readonly #core: RealtimeBackplaneObjectCore;

  constructor(state: IDurableObjectState) {
    this.#core = new RealtimeBackplaneObjectCore(state);
  }

  fetch(request: Request): Promise<Response> {
    return this.#core.fetch(request);
  }
  webSocketMessage(ws: IDurableObjectWebSocket, message: string | ArrayBuffer): void {
    this.#core.webSocketMessage(ws, message);
  }
  webSocketClose(ws: IDurableObjectWebSocket, code: number, reason: string): void {
    this.#core.webSocketClose(ws, code, reason);
  }
  webSocketError(ws: IDurableObjectWebSocket): void {
    this.#core.webSocketError(ws);
  }
}

/** The lock object class an application exports, exactly as documented. */
class DistributedLockObject {
  readonly #core: DistributedLockObjectCore;

  constructor(state: IDurableObjectState) {
    this.#core = new DistributedLockObjectCore(state);
  }

  fetch(request: Request): Promise<Response> {
    return this.#core.fetch(request);
  }
}

function runtime(prefix: string): IRuntimeServices {
  let next = 0;
  return { uuid: () => `${prefix}-${++next}` } as unknown as IRuntimeServices;
}

function replica(namespace: FakeDurableObjectNamespace, origin: string): DurableObjectBackplane {
  return new DurableObjectBackplane(namespace, {
    origin,
    binding: 'REALTIME',
    topic: 'realtime',
  });
}

describe('Durable Object realtime backplane, across replicas', () => {
  it('carries a frame from one replica to another', async () => {
    const namespace = new FakeDurableObjectNamespace('realtime');
    const a = replica(namespace, 'replica-a');
    const b = replica(namespace, 'replica-b');

    const seenByA: RealtimeFrame[] = [];
    const seenByB: RealtimeFrame[] = [];
    await a.subscribe((frame) => seenByA.push(frame));
    await b.subscribe((frame) => seenByB.push(frame));
    // Both must be connected before the publish — the object fans out to the
    // sockets it holds at that moment, exactly as a real deployment does.
    await a.connect();
    await b.connect();

    await a.publish({
      kind: 'ws-room',
      origin: 'replica-a',
      name: 'lobby',
      data: 'hello from a',
    });

    expect(seenByB).toHaveLength(1);
    expect(seenByB[0]?.data).toBe('hello from a');
    expect(seenByB[0]?.name).toBe('lobby');
    // The publisher must not receive its own broadcast: local members already
    // got it directly, and redelivering would double-send.
    expect(seenByA).toEqual([]);
  });

  it('reaches every other replica, not just the first', async () => {
    const namespace = new FakeDurableObjectNamespace('realtime');
    const [a, b, c] = ['a', 'b', 'c'].map((id) => replica(namespace, `replica-${id}`));
    const seen: string[] = [];
    await b!.subscribe(() => seen.push('b'));
    await c!.subscribe(() => seen.push('c'));
    await a!.connect();
    await b!.connect();
    await c!.connect();

    await a!.publish({ kind: 'sse-channel', origin: 'replica-a', name: 'news', data: '{}' });

    expect(seen.sort()).toEqual(['b', 'c']);
  });

  it('carries the exceptId, so a cluster-wide exclusion survives the wire', async () => {
    const namespace = new FakeDurableObjectNamespace('realtime');
    const a = replica(namespace, 'replica-a');
    const b = replica(namespace, 'replica-b');
    const seen: RealtimeFrame[] = [];
    await b.subscribe((frame) => seen.push(frame));
    await a.connect();
    await b.connect();

    await a.publish({
      kind: 'ws-room',
      origin: 'replica-a',
      name: 'lobby',
      data: 'hi',
      exceptId: 'connection-7',
    });

    expect(seen[0]?.exceptId).toBe('connection-7');
  });

  it('isolates topics, so two applications sharing a namespace do not cross-talk', async () => {
    const namespace = new FakeDurableObjectNamespace('realtime');
    const a = new DurableObjectBackplane(namespace, {
      origin: 'replica-a',
      binding: 'REALTIME',
      topic: 'app-one',
    });
    const b = new DurableObjectBackplane(namespace, {
      origin: 'replica-b',
      binding: 'REALTIME',
      topic: 'app-two',
    });
    const seen: RealtimeFrame[] = [];
    await b.subscribe((frame) => seen.push(frame));
    await a.connect();
    await b.connect();

    await a.publish({ kind: 'ws-room', origin: 'replica-a', name: 'lobby', data: 'hi' });

    expect(seen).toEqual([]);
  });

  it('stops delivering once a replica closes', async () => {
    const namespace = new FakeDurableObjectNamespace('realtime');
    const a = replica(namespace, 'replica-a');
    const b = replica(namespace, 'replica-b');
    const seen: RealtimeFrame[] = [];
    await b.subscribe((frame) => seen.push(frame));
    await a.connect();
    await b.connect();

    await b.close();
    await a.publish({ kind: 'ws-room', origin: 'replica-a', name: 'lobby', data: 'hi' });

    expect(seen).toEqual([]);
  });
});

describe('The Durable Object class an application exports', () => {
  // The documented class passes NO `createPair` seam, so it takes the default
  // host — which reads the Workers global. Installing a stand-in is what lets
  // these tests drive the documented shape exactly as written, rather than a
  // seam-injecting variant of it that no application would copy.
  interface PairGlobal {
    WebSocketPair?: unknown;
  }
  const globals = globalThis as PairGlobal;

  beforeEach(() => {
    globals.WebSocketPair = class {
      0 = { accept(): void {}, send(): void {}, close(): void {}, addEventListener(): void {} };
      1 = { send(): void {}, close(): void {} };
    };
  });

  afterEach(() => {
    delete globals.WebSocketPair;
  });

  it('serves the backplane through the documented delegating class', async () => {
    const namespace = new FakeDurableObjectNamespace('realtime');
    const state = namespace.state('realtime');
    // Prove the documented class shape compiles and drives the same behavior.
    const exported = new RealtimeBackplaneObject(state);

    const response = await exported.fetch(
      new Request('https://do/connect', { headers: { Upgrade: 'websocket' } }),
    );

    expect(response.status).toBe(101);
    expect(state.accepted).toHaveLength(1);
  });

  it('refuses a non-upgrade request through the documented class', async () => {
    const exported = new RealtimeBackplaneObject(new FakeDurableObjectNamespace().state('x'));
    expect((await exported.fetch(new Request('https://do/'))).status).toBe(426);
  });

  it('forwards close through the documented class without throwing', async () => {
    const namespace = new FakeDurableObjectNamespace('realtime');
    const state = namespace.state('realtime');
    const exported = new RealtimeBackplaneObject(state);
    await exported.fetch(new Request('https://do/connect', { headers: { Upgrade: 'websocket' } }));

    exported.webSocketClose(state.accepted[0]!, 1001, 'bye');
  });

  it('forwards a socket error through the documented class', async () => {
    const namespace = new FakeDurableObjectNamespace('realtime');
    const state = namespace.state('realtime');
    const exported = new RealtimeBackplaneObject(state);
    await exported.fetch(new Request('https://do/connect', { headers: { Upgrade: 'websocket' } }));

    // Forwarded by the documented class, so the method is reachable on a real
    // deployment rather than being unit-tested surface nobody calls.
    exported.webSocketError(state.accepted[0]!);
  });

  it('serves the lock through the documented delegating class', async () => {
    const namespace = new FakeDurableObjectNamespace('lock');
    const exported = new DistributedLockObject(namespace.state('reports'));

    const response = await exported.fetch(
      new Request('https://lock/acquire', {
        method: 'POST',
        body: JSON.stringify({ token: 'token-1', ttlMs: 30_000 }),
      }),
    );

    expect(((await response.json()) as { token: string }).token).toBe('token-1');
  });
});

describe('Durable Object distributed lock, across replicas', () => {
  it('grants one holder and refuses the other, then hands over on release', async () => {
    const namespace = new FakeDurableObjectNamespace('lock');
    const a = new DurableObjectLock(namespace, { runtime: runtime('a') });
    const b = new DurableObjectLock(namespace, { runtime: runtime('b') });

    const held = await a.acquire('nightly-report', 30_000);
    expect(held).toBe('a-1');
    expect(await b.acquire('nightly-report', 30_000)).toBeNull();

    await a.release('nightly-report', held!);

    // `b-2`, not `b-1`: this is b's SECOND attempt, and a token is minted per
    // attempt rather than per success.
    expect(await b.acquire('nightly-report', 30_000)).toBe('b-2');
  });

  it('serializes a burst of contenders down to exactly one winner', async () => {
    const namespace = new FakeDurableObjectNamespace('lock');
    const contenders = Array.from(
      { length: 5 },
      (_, i) => new DurableObjectLock(namespace, { runtime: runtime(`r${i}`) }),
    );

    const results = await Promise.all(
      contenders.map((lock) => lock.acquire('nightly-report', 30_000)),
    );

    expect(results.filter((token) => token !== null)).toHaveLength(1);
  });
});
