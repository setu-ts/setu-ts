import { WorkersResponse } from '../../../../../test/node-helpers.ts';
import { afterAll, beforeAll } from 'vitest';
const nativeResponse = globalThis.Response;
beforeAll(() => {
  globalThis.Response = WorkersResponse;
});
afterAll(() => {
  globalThis.Response = nativeResponse;
});
/**
 * One connection's link to the hub, driven against the real
 * `RealtimeBackplaneObjectCore` behind the shared fake namespace.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';
import { setImmediate } from 'node:timers/promises';

import type { IRuntimeServices, RealtimeFrame } from '@setu-ts/common';
import type { IServiceBinding } from '../../../src/bindings/facades.ts';
import {
  ConnectionLink,
  LINK_QUEUE_BYTE_BUDGET,
  LINK_QUEUE_LIMIT,
  LINK_REOPEN_DELAYS_MS,
} from '../../../src/realtime/connection-link.ts';
import { FakeDurableObjectNamespace } from '../../do-fakes.ts';
import { RecordingLogger } from '../../fakes.ts';

const frame = (data: string, name = 'lobby'): RealtimeFrame => ({
  kind: 'ws-room',
  origin: 'isolate',
  name,
  data,
});

/** Timers whose callbacks the test runs by hand. */
function manualTimers(): Pick<IRuntimeServices, 'setTimeout' | 'clearTimeout'> & {
  readonly pending: { fn: () => void; ms: number; cleared: boolean }[];
  runNext(): void;
} {
  const pending: { fn: () => void; ms: number; cleared: boolean }[] = [];
  return {
    pending,
    setTimeout: (fn, ms) => {
      const entry = { fn, ms, cleared: false };
      pending.push(entry);
      return entry;
    },
    clearTimeout: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    runNext(): void {
      const entry = pending.shift();
      if (entry !== undefined && !entry.cleared) entry.fn();
    },
  };
}

function link(
  namespace: FakeDurableObjectNamespace,
  deliver: (frame: RealtimeFrame) => void,
  extra?: {
    timers?: ReturnType<typeof manualTimers>;
    logger?: RecordingLogger;
    hub?: () => IServiceBinding;
  },
): ConnectionLink {
  return new ConnectionLink({
    hub: extra?.hub ?? (() => namespace.get(namespace.idFromName('chat'))),
    binding: 'REALTIME',
    topic: 'chat',
    connectionId: 'conn-1',
    deliver,
    timers: extra?.timers ?? manualTimers(),
    ...(extra?.logger === undefined ? {} : { logger: () => extra.logger }),
  });
}

describe('ConnectionLink', () => {
  it('opens on /link, sends queued frames once open, and delivers what other links send', async () => {
    const namespace = new FakeDurableObjectNamespace();
    const gotA: RealtimeFrame[] = [];
    const gotB: RealtimeFrame[] = [];
    const b = link(namespace, (f) => gotB.push(f));
    await setImmediate();
    const a = link(namespace, (f) => gotA.push(f));

    // Queued while A's link opens, sent once it is open.
    expect(a.publish(frame('early'))).toBe(true);
    await setImmediate();

    expect(namespace.state('chat').getWebSockets()).toHaveLength(2);
    expect(gotB.map((f) => f.data)).toEqual(['early']);
    // The hub never returns a link's own frame to it.
    expect(gotA).toEqual([]);

    b.publish(frame('reply'));
    expect(gotA.map((f) => f.data)).toEqual(['reply']);
  });

  it('bounds the queue while opening, dropping the oldest and warning once', async () => {
    const namespace = new FakeDurableObjectNamespace();
    const logger = new RecordingLogger();
    const got: RealtimeFrame[] = [];
    link(namespace, (f) => got.push(f));
    await setImmediate();
    const sender = link(namespace, () => {}, { logger });

    for (let i = 0; i < LINK_QUEUE_LIMIT + 3; i++) sender.publish(frame(`m${i}`));
    await setImmediate();

    expect(got).toHaveLength(LINK_QUEUE_LIMIT);
    expect(got[0]?.data).toBe('m3');
    expect(logger.records.filter((r) => r.message.includes('queue full'))).toHaveLength(1);
  });

  it('refuses a frame that would pass the byte budget while opening, keeping what it queued', async () => {
    const namespace = new FakeDurableObjectNamespace();
    const got: RealtimeFrame[] = [];
    link(namespace, (f) => got.push(f));
    await setImmediate();
    const sender = link(namespace, () => {});
    const half = 'x'.repeat(LINK_QUEUE_BYTE_BUDGET / 2);

    expect(sender.publish(frame(half))).toBe(true);
    expect(sender.publish(frame(half))).toBe(true); // exactly the budget
    expect(sender.publish(frame('y'))).toBe(false); // one byte past it
    await setImmediate();

    expect(got.map((f) => f.data.length)).toEqual([half.length, half.length]);
  });

  it('refuses a frame above the hub cap even on an open link', async () => {
    const namespace = new FakeDurableObjectNamespace();
    const sender = link(namespace, () => {});
    await setImmediate();

    expect(sender.publish(frame('x'.repeat(33_554_433)))).toBe(false);
    expect(namespace.clients[0]?.sent).toEqual([]);
  });

  it('measures the hub cap in UTF-8 bytes of the whole frame, not characters', async () => {
    const namespace = new FakeDurableObjectNamespace();
    const sender = link(namespace, () => {});
    await setImmediate();
    // 12,000,000 characters of three bytes each: under the cap in characters,
    // 36,000,000 bytes on the wire.
    const wide = '€'.repeat(12_000_000);

    expect(sender.publish(frame(wide))).toBe(false);
    expect(sender.publish(frame('é'.repeat(1000)))).toBe(true);
    expect(namespace.clients[0]?.sent).toHaveLength(1);
  });

  it('gives a drained frame its bytes back, so a reopen can queue the full budget again', async () => {
    const namespace = new FakeDurableObjectNamespace();
    const timers = manualTimers();
    const sender = link(namespace, () => {}, { timers });
    const full = 'x'.repeat(LINK_QUEUE_BYTE_BUDGET);
    expect(sender.publish(frame(full))).toBe(true);
    await setImmediate(); // opens and drains

    namespace.clients[0]?.fire('close', { data: '' });
    // Waiting to reopen: queued again, against an emptied budget.
    expect(sender.publish(frame(full))).toBe(true);
    timers.runNext();
    await setImmediate();

    expect(namespace.clients[1]?.sent).toHaveLength(1);
    namespace.clients[1]?.fire('close', { data: '' });
    expect(sender.publish(frame(full))).toBe(true);
  });

  it('gives a frame dropped by the count bound its bytes back', () => {
    const namespace = new FakeDurableObjectNamespace();
    const sender = link(namespace, () => {});
    const share = 'x'.repeat(Math.floor(LINK_QUEUE_BYTE_BUDGET / LINK_QUEUE_LIMIT));
    for (let i = 0; i < LINK_QUEUE_LIMIT; i++) expect(sender.publish(frame(share))).toBe(true);

    // Each further frame drops the oldest; its bytes leave the budget with it.
    for (let i = 0; i < 10; i++) expect(sender.publish(frame(share))).toBe(true);
  });

  it('drops traffic that is not a realtime frame', async () => {
    const namespace = new FakeDurableObjectNamespace();
    const got: RealtimeFrame[] = [];
    link(namespace, (f) => got.push(f));
    await setImmediate();
    const client = namespace.clients[0];
    client?.receive('not json');
    client?.receive(JSON.stringify({ kind: 'other' }));
    client?.receive(new ArrayBuffer(2));
    client?.receive(JSON.stringify(frame('ok')));
    expect(got.map((f) => f.data)).toEqual(['ok']);
  });

  it('keeps delivering when a delivery callback throws', async () => {
    const namespace = new FakeDurableObjectNamespace();
    let calls = 0;
    link(namespace, () => {
      calls++;
      throw new Error('boom');
    });
    await setImmediate();
    namespace.clients[0]?.receive(JSON.stringify(frame('a')));
    namespace.clients[0]?.receive(JSON.stringify(frame('b')));
    expect(calls).toBe(2);
  });

  it('answers false for a socket that throws (another request owns it), so the caller falls back', async () => {
    const namespace = new FakeDurableObjectNamespace();
    const a = link(namespace, () => {});
    await setImmediate();
    namespace.clients[0]!.failSend = true;
    expect(a.publish(frame('x'))).toBe(false);
  });

  it('reopens a lost link with 0.5 s, 1 s and 2 s delays, then warns once and stays closed', async () => {
    const namespace = new FakeDurableObjectNamespace();
    const timers = manualTimers();
    const logger = new RecordingLogger();
    const l = link(namespace, () => {}, { timers, logger });
    await setImmediate();

    // The socket is lost; every reopen then fails, so each delay is tried in turn.
    namespace.clients.at(-1)?.fire('close', { data: '' });
    namespace.omitSocket = true;
    for (const delay of LINK_REOPEN_DELAYS_MS) {
      expect(timers.pending.at(-1)?.ms).toBe(delay);
      timers.runNext();
      await setImmediate();
    }
    expect(timers.pending).toEqual([]);

    const lost = logger.records.filter((r) => r.message === 'cloudflare: backplane link lost');
    expect(lost).toHaveLength(1);
    expect(lost[0]?.meta).toEqual({ topic: 'chat', connection: 'conn-1' });
    expect(l.publish(frame('after'))).toBe(false);
  });

  it('resets the reopen count once a reopen succeeds', async () => {
    const namespace = new FakeDurableObjectNamespace();
    const timers = manualTimers();
    link(namespace, () => {}, { timers });
    await setImmediate();
    namespace.clients.at(-1)?.fire('error', { data: '' });
    timers.runNext();
    await setImmediate();
    namespace.clients.at(-1)?.fire('close', { data: '' });
    expect(timers.pending.at(-1)?.ms).toBe(LINK_REOPEN_DELAYS_MS[0]);
  });

  it('treats a hub that throws or rejects as a lost link', async () => {
    const namespace = new FakeDurableObjectNamespace();
    const timers = manualTimers();
    link(namespace, () => {}, {
      timers,
      hub: () => {
        throw new Error('no stub');
      },
    });
    expect(timers.pending).toHaveLength(1);

    const rejecting = manualTimers();
    link(namespace, () => {}, {
      timers: rejecting,
      hub: () => ({ fetch: () => Promise.reject(new Error('unreachable')) }),
    });
    await setImmediate();
    expect(rejecting.pending).toHaveLength(1);
  });

  it('closes its socket, clears a pending reopen, and closes a socket that arrives after close', async () => {
    const namespace = new FakeDurableObjectNamespace();
    const timers = manualTimers();
    const l = link(namespace, () => {}, { timers });
    await setImmediate();
    namespace.clients[0]?.fire('close', { data: '' });
    l.close();
    l.close();
    expect(timers.pending[0]?.cleared).toBe(true);

    const late = link(namespace, () => {});
    late.close();
    await setImmediate();
    expect(namespace.clients.at(-1)?.closed).toBe(true);
  });

  it('stops draining the queue when the socket fails mid-drain', async () => {
    const namespace = new FakeDurableObjectNamespace();
    const l = link(namespace, () => {}, {
      hub: () => ({
        fetch: async () => {
          const response = await namespace.get('chat').fetch('https://x/link', {
            headers: { Upgrade: 'websocket' },
          });
          const socket = (response as unknown as { webSocket: { failSend: boolean } }).webSocket;
          socket.failSend = true;
          return response;
        },
      }),
    });
    l.publish(frame('a'));
    l.publish(frame('b'));
    await setImmediate();
    expect(namespace.clients[0]?.sent).toEqual([]);
  });

  it('keeps the frames a failed drain did not try, and sends only those after the reopen', async () => {
    const namespace = new FakeDurableObjectNamespace();
    const timers = manualTimers();
    let opens = 0;
    const l = link(namespace, () => {}, {
      timers,
      hub: () => ({
        fetch: async (input: string, init?: RequestInit) => {
          const response = await namespace.get('chat').fetch(input, init);
          opens++;
          if (opens === 1) {
            // The first socket takes one frame, then fails.
            const socket = (response as unknown as { webSocket: { send(m: string): void } })
              .webSocket;
            const send = socket.send.bind(socket);
            let calls = 0;
            socket.send = (m: string) => {
              if (++calls > 1) throw new Error('gone');
              send(m);
            };
          }
          return response;
        },
      }),
    });
    l.publish(frame('a'));
    l.publish(frame('b'));
    l.publish(frame('c'));
    await setImmediate();
    expect(
      namespace.clients[0]?.sent.map((m) => (JSON.parse(String(m)) as RealtimeFrame).data),
    ).toEqual(['a']);

    namespace.clients[0]?.fire('close', { data: '' });
    timers.runNext();
    await setImmediate();

    expect(
      namespace.clients[1]?.sent.map((m) => (JSON.parse(String(m)) as RealtimeFrame).data),
    ).toEqual(['b', 'c']);
  });

  it('reports how many frames a closing link could not flush', async () => {
    const namespace = new FakeDurableObjectNamespace();
    const logger = new RecordingLogger();
    const quick = link(namespace, () => {}, {
      logger,
      hub: () => ({
        fetch: async (input: string, init?: RequestInit) => {
          const response = await namespace.get('chat').fetch(input, init);
          (response as unknown as { webSocket: { failSend: boolean } }).webSocket.failSend = true;
          return response;
        },
      }),
    });
    quick.publish(frame('a'));
    quick.publish(frame('b'));
    quick.close();
    await setImmediate();

    const unsent = logger.records.find(
      (r) => r.message === 'cloudflare: backplane link closed with frames unsent',
    );
    expect(unsent?.meta).toMatchObject({ dropped: 2 });
  });

  it('closes a live socket on close(), and ignores a second close event from the same socket', async () => {
    const namespace = new FakeDurableObjectNamespace();
    const timers = manualTimers();
    const l = link(namespace, () => {}, { timers });
    await setImmediate();
    const client = namespace.clients[0];
    client?.fire('close', { data: '' });
    client?.fire('close', { data: '' });
    expect(timers.pending).toHaveLength(1);

    const live = link(namespace, () => {});
    await setImmediate();
    live.close();
    expect(namespace.clients.at(-1)?.closed).toBe(true);
    l.close();
  });

  it('schedules nothing when the hub fails after the link was closed', async () => {
    const timers = manualTimers();
    let reject!: (error: unknown) => void;
    const l = link(new FakeDurableObjectNamespace(), () => {}, {
      timers,
      hub: () => ({
        fetch: () =>
          new Promise<Response>((_resolve, rejectFetch) => {
            reject = rejectFetch;
          }),
      }),
    });
    l.close();
    reject(new Error('late'));
    await setImmediate();
    expect(timers.pending).toEqual([]);
  });

  it('still sends frames queued before it opened when closed early, then closes', async () => {
    const namespace = new FakeDurableObjectNamespace();
    const got: RealtimeFrame[] = [];
    link(namespace, (f) => got.push(f));
    await setImmediate();
    const quick = link(namespace, () => {});
    quick.publish(frame('said before leaving'));
    quick.close();
    expect(quick.publish(frame('after'))).toBe(false);
    await setImmediate();
    expect(got.map((f) => f.data)).toEqual(['said before leaving']);
    expect(namespace.clients.at(-1)?.closed).toBe(true);
  });

  it('warns once, without content, when a link closed early cannot open', async () => {
    const logger = new RecordingLogger();
    const timers = manualTimers();
    const quick = link(new FakeDurableObjectNamespace(), () => {}, {
      logger,
      timers,
      hub: () => ({ fetch: () => Promise.reject(new Error('down')) }),
    });
    quick.publish(frame('secret'));
    quick.close();
    await setImmediate();
    expect(logger.records.map((r) => r.message)).toEqual([
      'cloudflare: backplane link closed before its socket opened',
    ]);
    expect(logger.records[0]?.meta).toEqual({ topic: 'chat', connection: 'conn-1', dropped: 1 });
    expect(timers.pending).toEqual([]);
  });

  it('stops flushing when the socket fails mid-flush', async () => {
    const namespace = new FakeDurableObjectNamespace();
    const quick = link(namespace, () => {}, {
      hub: () => ({
        fetch: async () => {
          const response = await namespace.get('chat').fetch('https://x/link', {
            headers: { Upgrade: 'websocket' },
          });
          (response as unknown as { webSocket: { failSend: boolean } }).webSocket.failSend = true;
          return response;
        },
      }),
    });
    quick.publish(frame('a'));
    quick.publish(frame('b'));
    quick.close();
    await setImmediate();
    expect(namespace.clients[0]?.closed).toBe(true);
  });

  it('hands an early close flush to waitUntil, and warns when closed while waiting to reopen', async () => {
    const namespace = new FakeDurableObjectNamespace();
    const held: Promise<unknown>[] = [];
    const quick = new ConnectionLink({
      hub: () => namespace.get(namespace.idFromName('chat')),
      binding: 'REALTIME',
      topic: 'chat',
      connectionId: 'c',
      deliver: () => {},
      timers: manualTimers(),
      waitUntil: (p) => {
        held.push(p);
      },
    });
    quick.publish(frame('x'));
    quick.close();
    expect(held).toHaveLength(1);
    await held[0];

    const logger = new RecordingLogger();
    const timers = manualTimers();
    const waiting = link(namespace, () => {}, { logger, timers });
    await setImmediate();
    namespace.clients.at(-1)?.fire('close', { data: '' });
    waiting.publish(frame('queued while reopening'));
    waiting.close();
    expect(logger.records.map((r) => r.message)).toEqual([
      'cloudflare: backplane link closed with frames unsent',
    ]);
    expect(logger.records[0]?.meta).toMatchObject({ dropped: 1 });
  });
});
