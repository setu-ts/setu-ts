/**
 * Integration test: cross-replica room fan-out.
 *
 * Two independent `WebSocketService` instances share one backplane, standing in
 * for two application replicas. These are the tests that fail without the
 * backplane wiring: before it, a broadcast on one replica reached nobody on the
 * other.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IRealtimeBackplane,
  IWebSocketConnection,
  RealtimeFrame,
} from '@hono-enterprise/common';
import { resolveOptions, WebSocketService } from '../../src/services/websocket-service.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

/**
 * A minimal in-process backplane pair.
 *
 * Written here rather than imported from the backplane plugin, because no
 * plugin may depend on another; it reproduces the two behaviors the wiring
 * relies on — deliver to peers, never to self.
 */
function createBackplanePair(): readonly [IRealtimeBackplane, IRealtimeBackplane] {
  const handlers = new Map<string, Set<(frame: RealtimeFrame) => void>>();

  const make = (origin: string): IRealtimeBackplane => {
    handlers.set(origin, new Set());
    return {
      origin,
      connect: () => Promise.resolve(),
      publish: (frame: RealtimeFrame) => {
        for (const [key, set] of handlers) {
          if (key === origin) {
            continue;
          }
          for (const handler of set) {
            handler(frame);
          }
        }
        return Promise.resolve();
      },
      subscribe: (handler) => {
        handlers.get(origin)?.add(handler);
        return Promise.resolve(() => {
          handlers.get(origin)?.delete(handler);
        });
      },
      close: () => {
        handlers.get(origin)?.clear();
        return Promise.resolve();
      },
    };
  };

  return [make('node-a'), make('node-b')] as const;
}

/** A connection double recording everything sent to it. */
function fakeConnection(id: string): IWebSocketConnection & { readonly sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    id,
    sent,
    isOpen: true,
    readyState: 'open',
    data: new Map<string, unknown>(),
    send: (payload: string | Uint8Array): void => {
      sent.push(payload);
    },
    sendJson: (payload: unknown): void => {
      sent.push(JSON.stringify(payload));
    },
    close: (): void => {},
  } as unknown as IWebSocketConnection & { readonly sent: unknown[] };
}

/** Builds a service wired to a backplane, with its subscription live. */
async function serviceOn(
  backplane: IRealtimeBackplane,
): Promise<WebSocketService> {
  const service = new WebSocketService(
    createFakeRuntime(),
    resolveOptions(undefined),
    true,
    undefined,
    backplane,
  );
  await backplane.subscribe((frame) => service.deliverRemoteFrame(frame));
  return service;
}

describe('WebSocket rooms across replicas', () => {
  it('delivers a broadcast on one replica to members on the other', async () => {
    const [aPlane, bPlane] = createBackplanePair();
    const a = await serviceOn(aPlane);
    const b = await serviceOn(bPlane);

    const localMember = fakeConnection('local');
    const remoteMember = fakeConnection('remote');
    a.room('lobby').add(localMember);
    b.room('lobby').add(remoteMember);

    a.room('lobby').broadcast('hello');

    expect(localMember.sent).toEqual(['hello']);
    // The behavior the whole milestone item exists for.
    expect(remoteMember.sent).toEqual(['hello']);
  });

  it('delivers exactly once and never re-publishes an arriving frame', async () => {
    const [aPlane, bPlane] = createBackplanePair();
    const a = await serviceOn(aPlane);
    const b = await serviceOn(bPlane);

    const localMember = fakeConnection('local');
    const remoteMember = fakeConnection('remote');
    a.room('lobby').add(localMember);
    b.room('lobby').add(remoteMember);

    a.room('lobby').broadcast('once');

    // Re-publishing an arriving frame would echo it around the cluster forever;
    // exactly-once on both sides is the proof it does not.
    expect(localMember.sent.length).toBe(1);
    expect(remoteMember.sent.length).toBe(1);
  });

  it('carries binary frames across the wire intact', async () => {
    const [aPlane, bPlane] = createBackplanePair();
    const a = await serviceOn(aPlane);
    const b = await serviceOn(bPlane);

    const remoteMember = fakeConnection('remote');
    b.room('bin').add(remoteMember);

    const payload = new Uint8Array([0, 1, 250, 255]);
    a.room('bin').broadcast(payload);

    // Base64 round-trip, asserted on the value that actually reached the peer.
    expect(remoteMember.sent).toEqual([payload]);
  });

  it('carries broadcastJson across replicas', async () => {
    const [aPlane, bPlane] = createBackplanePair();
    const a = await serviceOn(aPlane);
    const b = await serviceOn(bPlane);

    const remoteMember = fakeConnection('remote');
    b.room('json').add(remoteMember);

    a.room('json').broadcastJson({ type: 'ping', n: 1 });

    expect(remoteMember.sent).toEqual([JSON.stringify({ type: 'ping', n: 1 })]);
  });

  it('honors `except` on the originating replica and on every other one', async () => {
    const [aPlane, bPlane] = createBackplanePair();
    const a = await serviceOn(aPlane);
    const b = await serviceOn(bPlane);

    const sender = fakeConnection('sender');
    const otherLocal = fakeConnection('other-local');
    const remoteMember = fakeConnection('remote');
    a.room('lobby').add(sender);
    a.room('lobby').add(otherLocal);
    b.room('lobby').add(remoteMember);

    a.room('lobby').broadcast('hi', { except: sender });

    expect(sender.sent).toEqual([]);
    expect(otherLocal.sent).toEqual(['hi']);
    // Everyone else still receives it, wherever they are connected.
    expect(remoteMember.sent).toEqual(['hi']);
  });

  it('excludes the sender even when it is connected to another replica', async () => {
    const [aPlane, bPlane] = createBackplanePair();
    const a = await serviceOn(aPlane);
    const b = await serviceOn(bPlane);

    // The excluded connection lives on B while the broadcast is issued on A —
    // the case a connection-object comparison cannot express, and the reason
    // the frame carries the globally-unique connection ID instead.
    const sender = fakeConnection('shared-id');
    const remoteSameId = fakeConnection('shared-id');
    const otherRemote = fakeConnection('other-remote');
    a.room('lobby').add(sender);
    b.room('lobby').add(remoteSameId);
    b.room('lobby').add(otherRemote);

    a.room('lobby').broadcast('hi', { except: sender });

    expect(sender.sent).toEqual([]);
    expect(remoteSameId.sent).toEqual([]);
    expect(otherRemote.sent).toEqual(['hi']);
  });

  it('carries no exceptId when the broadcast excludes nobody', async () => {
    const [aPlane, bPlane] = createBackplanePair();
    const a = await serviceOn(aPlane);
    const b = await serviceOn(bPlane);

    const remoteMember = fakeConnection('remote');
    b.room('lobby').add(remoteMember);

    a.room('lobby').broadcast('hi');
    expect(remoteMember.sent).toEqual(['hi']);
  });

  it('ignores a frame addressed to an SSE channel of the same name', async () => {
    const [, bPlane] = createBackplanePair();
    const b = await serviceOn(bPlane);

    const remoteMember = fakeConnection('remote');
    b.room('shared-name').add(remoteMember);

    b.deliverRemoteFrame({
      kind: 'sse-channel',
      origin: 'node-a',
      name: 'shared-name',
      data: 'not for rooms',
    });

    // One topic carries both kinds; a room and a channel may share a name.
    expect(remoteMember.sent).toEqual([]);
  });

  it('ignores a frame it published itself', async () => {
    const [, bPlane] = createBackplanePair();
    const b = await serviceOn(bPlane);

    const member = fakeConnection('member');
    b.room('lobby').add(member);

    b.deliverRemoteFrame({
      kind: 'ws-room',
      origin: bPlane.origin,
      name: 'lobby',
      data: 'echo',
    });

    expect(member.sent).toEqual([]);
  });

  it('drops a frame for a room with no local members without creating one', async () => {
    const [, bPlane] = createBackplanePair();
    const b = await serviceOn(bPlane);

    b.deliverRemoteFrame({
      kind: 'ws-room',
      origin: 'node-a',
      name: 'nobody-here',
      data: 'hi',
    });

    // Creating a room per arriving name would let a cluster-wide namespace
    // grow this replica's room map without bound.
    expect(b.roomCount).toBe(0);
  });

  it('leaves rooms purely in-process when no backplane is registered', async () => {
    const service = new WebSocketService(
      createFakeRuntime(),
      resolveOptions(undefined),
      true,
    );
    const member = fakeConnection('member');
    service.room('lobby').add(member);
    service.room('lobby').broadcast('local only');

    expect(member.sent).toEqual(['local only']);
    await Promise.resolve();
  });
});
