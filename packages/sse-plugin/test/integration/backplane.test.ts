/**
 * Integration test: cross-replica channel fan-out.
 *
 * Two independent `SseService` instances share one backplane, standing in for
 * two application replicas. These are the tests that fail without the backplane
 * wiring: before it, a publish on one replica reached nobody on the other.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  ILogger,
  IRealtimeBackplane,
  ISseConnection,
  RealtimeFrame,
  SseMessage,
} from '@hono-enterprise/common';
import { SseService } from '../../src/services/sse-service.ts';
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

/** A connection double recording every message sent to it. */
function fakeConnection(id: string): ISseConnection & { readonly sent: SseMessage[] } {
  const sent: SseMessage[] = [];
  return {
    id,
    sent,
    lastEventId: null,
    isOpen: true,
    result: undefined,
    send: (msg: SseMessage): void => {
      sent.push(msg);
    },
    comment: (): void => {},
    close: (): void => {},
  } as unknown as ISseConnection & { readonly sent: SseMessage[] };
}

/** Builds a service wired to a backplane, with its subscription live. */
async function serviceOn(backplane: IRealtimeBackplane): Promise<SseService> {
  const service = new SseService(undefined, createFakeRuntime(), backplane);
  await backplane.subscribe((frame) => service.deliverRemoteFrame(frame));
  return service;
}

describe('SSE channels across replicas', () => {
  it('delivers a publish on one replica to members on the other', async () => {
    const [aPlane, bPlane] = createBackplanePair();
    const a = await serviceOn(aPlane);
    const b = await serviceOn(bPlane);

    const localMember = fakeConnection('local');
    const remoteMember = fakeConnection('remote');
    a.channel('news').add(localMember);
    b.channel('news').add(remoteMember);

    a.channel('news').publish({ id: '1', data: 'breaking' });

    expect(localMember.sent).toEqual([{ id: '1', data: 'breaking' }]);
    // The behavior the whole milestone item exists for.
    expect(remoteMember.sent).toEqual([{ id: '1', data: 'breaking' }]);
  });

  it('delivers exactly once and never re-publishes an arriving message', async () => {
    const [aPlane, bPlane] = createBackplanePair();
    const a = await serviceOn(aPlane);
    const b = await serviceOn(bPlane);

    const localMember = fakeConnection('local');
    const remoteMember = fakeConnection('remote');
    a.channel('news').add(localMember);
    b.channel('news').add(remoteMember);

    a.channel('news').publish({ data: 'once' });

    expect(localMember.sent.length).toBe(1);
    expect(remoteMember.sent.length).toBe(1);
  });

  it('preserves every SseMessage field across the wire', async () => {
    const [aPlane, bPlane] = createBackplanePair();
    const a = await serviceOn(aPlane);
    const b = await serviceOn(bPlane);

    const remoteMember = fakeConnection('remote');
    b.channel('news').add(remoteMember);

    const message: SseMessage = {
      id: '42',
      event: 'update',
      data: { nested: true, count: 3 },
      retry: 5000,
    };
    a.channel('news').publish(message);

    // Field-by-field, so a dropped `event` or `retry` cannot pass silently.
    expect(remoteMember.sent).toEqual([message]);
  });

  it('ignores a frame addressed to a WebSocket room of the same name', async () => {
    const [, bPlane] = createBackplanePair();
    const b = await serviceOn(bPlane);

    const remoteMember = fakeConnection('remote');
    b.channel('shared-name').add(remoteMember);

    b.deliverRemoteFrame({
      kind: 'ws-room',
      origin: 'node-a',
      name: 'shared-name',
      data: JSON.stringify({ data: 'not for channels' }),
    });

    expect(remoteMember.sent).toEqual([]);
  });

  it('ignores a frame it published itself', async () => {
    const [, bPlane] = createBackplanePair();
    const b = await serviceOn(bPlane);

    const member = fakeConnection('member');
    b.channel('news').add(member);

    b.deliverRemoteFrame({
      kind: 'sse-channel',
      origin: bPlane.origin,
      name: 'news',
      data: JSON.stringify({ data: 'echo' }),
    });

    expect(member.sent).toEqual([]);
  });

  it('drops unparseable and malformed remote payloads', async () => {
    const [, bPlane] = createBackplanePair();
    const b = await serviceOn(bPlane);

    const member = fakeConnection('member');
    b.channel('news').add(member);

    // None of these may throw: the delivery runs inside a transport callback
    // where nothing would catch it.
    b.deliverRemoteFrame({
      kind: 'sse-channel',
      origin: 'node-a',
      name: 'news',
      data: 'not json{',
    });
    b.deliverRemoteFrame({
      kind: 'sse-channel',
      origin: 'node-a',
      name: 'news',
      data: JSON.stringify({ missing: 'the data field' }),
    });

    expect(member.sent).toEqual([]);
  });

  it('drops a message for a channel with no local members without creating one', async () => {
    const [, bPlane] = createBackplanePair();
    const b = await serviceOn(bPlane);

    b.deliverRemoteFrame({
      kind: 'sse-channel',
      origin: 'node-a',
      name: 'nobody-here',
      data: JSON.stringify({ data: 'hi' }),
    });

    expect(b.channel('nobody-here').size).toBe(0);
  });

  it('leaves channels purely in-process when no backplane is registered', () => {
    const service = new SseService(undefined, createFakeRuntime());
    const member = fakeConnection('member');
    service.channel('news').add(member);
    service.channel('news').publish({ data: 'local only' });

    expect(member.sent).toEqual([{ data: 'local only' }]);
  });
});

describe('SSE backplane failure reporting', () => {
  it('logs a failed fan-out instead of swallowing it', async () => {
    const warnings: Array<{ message: string; metadata?: Record<string, unknown> }> = [];
    const logger: ILogger = {
      level: 'info',
      fatal: (): void => {},
      error: (): void => {},
      warn: (message: string, metadata?: Record<string, unknown>): void => {
        warnings.push(metadata === undefined ? { message } : { message, metadata });
      },
      info: (): void => {},
      debug: (): void => {},
      trace: (): void => {},
      child: (): ILogger => logger,
    };

    const failing: IRealtimeBackplane = {
      origin: 'node-a',
      connect: () => Promise.resolve(),
      publish: () => Promise.reject(new Error('redis unreachable')),
      subscribe: () => Promise.resolve(() => {}),
      close: () => Promise.resolve(),
    };

    const service = new SseService(undefined, createFakeRuntime(), failing, logger);
    const member = fakeConnection('local');
    service.channel('news').add(member);

    service.channel('news').publish({ data: 'still local' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Local delivery is unaffected...
    expect(member.sent).toEqual([{ data: 'still local' }]);
    // ...and the degradation to local-only is visible rather than silent.
    const failure = warnings.find((w) => w.message.includes('backplane publish failed'));
    expect(failure).toBeDefined();
    expect(failure?.metadata?.channel).toBe('news');
    expect(failure?.metadata?.error).toBe('redis unreachable');
  });
});
