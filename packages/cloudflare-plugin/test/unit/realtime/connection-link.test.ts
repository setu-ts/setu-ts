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
  LINK_REOPEN_MAX_DELAY_MS,
} from '../../../src/realtime/connection-link.ts';
import type { FakeClientSocket } from '../../do-fakes.ts';
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

  it('counts the opening budget in UTF-8 bytes, not UTF-16 units', () => {
    const namespace = new FakeDurableObjectNamespace();
    const opening = (): ConnectionLink => link(namespace, () => {});
    // 350,000 units of three bytes each: under the budget in `.length`,
    // 1,050,000 bytes once encoded.
    expect(opening().publish(frame('€'.repeat(350_000)))).toBe(false);
    // Exactly the budget in bytes: two-byte, four-byte (a surrogate pair) and
    // three-byte (a lone surrogate, encoded as U+FFFD) characters.
    for (const [unit, bytes] of [
      ['é', 2],
      ['😀', 4],
      ['\uD800', 3],
    ] as const) {
      const sender = opening();
      const fits = 'x'.repeat(LINK_QUEUE_BYTE_BUDGET % bytes);
      const exact = unit.repeat(Math.floor(LINK_QUEUE_BYTE_BUDGET / bytes)) + fits;
      expect(sender.publish(frame(exact))).toBe(true);
      expect(sender.publish(frame('y'))).toBe(false); // one byte past it
    }
  });

  it('gives a multibyte frame dropped by the count bound its UTF-8 bytes back', () => {
    const namespace = new FakeDurableObjectNamespace();
    const sender = link(namespace, () => {});
    // Each frame is its share of the budget in bytes, a third of that in units.
    const share = '€'.repeat(Math.floor(LINK_QUEUE_BYTE_BUDGET / LINK_QUEUE_LIMIT / 3));
    for (let i = 0; i < LINK_QUEUE_LIMIT; i++) expect(sender.publish(frame(share))).toBe(true);
    for (let i = 0; i < 10; i++) expect(sender.publish(frame(share))).toBe(true);
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
    // Long enough to be encoded and measured, and still under the cap.
    expect(sender.publish(frame('x'.repeat(12_000_000)))).toBe(true);
    // Above the cap in characters: refused before serializing.
    expect(sender.publish(frame('x'.repeat(33_554_433)))).toBe(false);
    expect(namespace.clients[0]?.sent).toHaveLength(2);
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

  /**
   * Loses a socket (the newest by default) and fails the next `attempts`
   * reopens, returning each delay.
   */
  async function failReopens(
    namespace: FakeDurableObjectNamespace,
    timers: ReturnType<typeof manualTimers>,
    attempts: number,
    lostSocket: FakeClientSocket | null | undefined = namespace.clients.at(-1),
  ): Promise<number[]> {
    // Dropped at the hub too, so the lost socket delivers nothing more. `null`
    // continues an outage already under way.
    lostSocket?.close();
    lostSocket?.fire('close', { data: '' });
    namespace.omitSocket = true;
    const delays: number[] = [];
    for (let i = 0; i < attempts; i++) {
      delays.push(timers.pending.at(-1)?.ms ?? -1);
      timers.runNext();
      await setImmediate();
    }
    return delays;
  }

  it('keeps reopening a lost link past three attempts, backing off to a 30 s cap', async () => {
    // Like other backplanes, a link never gives up while its connection is
    // open: the connection stays open and its rooms resume once the hub is back.
    const namespace = new FakeDurableObjectNamespace();
    const timers = manualTimers();
    const l = link(namespace, () => {}, { timers });
    await setImmediate();

    const delays = await failReopens(namespace, timers, 8);

    expect(delays).toEqual([...LINK_REOPEN_DELAYS_MS, 4000, 8000, 16000, 30_000, 30_000]);
    expect(LINK_REOPEN_MAX_DELAY_MS).toBe(30_000);
    expect(timers.pending.filter((t) => !t.cleared)).toHaveLength(1); // still retrying
    // Past the routine reopens the link refuses, so the caller goes through the hub.
    expect(l.publish(frame('during'))).toBe(false);
  });

  it('drops what it queued once an outage is warned about, so recovery sends nothing stale', async () => {
    // Other replicas would get minutes-old frames in a burst; a stale frame is
    // worse than none, as on the Redis backplane during an outage.
    const namespace = new FakeDurableObjectNamespace();
    const timers = manualTimers();
    const logger = new RecordingLogger();
    const got: RealtimeFrame[] = [];
    link(namespace, (f) => got.push(f));
    await setImmediate();
    const sender = link(namespace, () => {}, { timers, logger });
    await setImmediate();
    const senderSocket = namespace.clients.at(-1);

    await failReopens(namespace, timers, 1, senderSocket);
    expect(sender.publish(frame('early'))).toBe(true); // queued: a routine reopen
    await failReopens(namespace, timers, LINK_REOPEN_DELAYS_MS.length - 1, null);
    expect(
      logger.records.find((r) => r.message === 'cloudflare: backplane link still reopening')?.meta,
    ).toEqual({ topic: 'chat', connection: 'conn-1', dropped: 1 });
    namespace.omitSocket = false;
    timers.runNext();
    await setImmediate();

    expect(got).toEqual([]);
    expect(sender.publish(frame('fresh'))).toBe(true);
    expect(got.map((f) => f.data)).toEqual(['fresh']);
  });

  it('warns once per outage past the third reopen, and reports the recovery at info', async () => {
    const namespace = new FakeDurableObjectNamespace();
    const timers = manualTimers();
    const logger = new RecordingLogger();
    const got: RealtimeFrame[] = [];
    const l = link(namespace, (f) => got.push(f), { timers, logger });
    await setImmediate();
    const lost = (): unknown[] =>
      logger.records.filter((r) => r.message === 'cloudflare: backplane link still reopening');
    const restored = (): unknown[] =>
      logger.records.filter((r) => r.message === 'cloudflare: backplane link restored');

    await failReopens(namespace, timers, LINK_REOPEN_DELAYS_MS.length - 1);
    expect(lost()).toEqual([]); // the first reopens are routine
    timers.runNext(); // the third reopen fails too
    await setImmediate();
    expect(lost()).toHaveLength(1);
    timers.runNext();
    await setImmediate();
    expect(lost()).toHaveLength(1); // once per outage
    expect(logger.records.find((r) => r.message.includes('still reopening'))?.meta).toEqual({
      topic: 'chat',
      connection: 'conn-1',
      dropped: 0,
    });

    // The hub is back: the next reopen succeeds, and delivery resumes.
    expect(l.publish(frame('refused'))).toBe(false);
    namespace.omitSocket = false;
    timers.runNext();
    await setImmediate();
    expect(restored()).toHaveLength(1);
    expect(restored().at(0)).toMatchObject({ level: 'info' });
    const reopened = namespace.clients.at(-1);
    const other = link(namespace, () => {});
    await setImmediate();
    other.publish(frame('after'));
    expect(got.map((f) => f.data)).toEqual(['after']);

    // A second outage warns again, once.
    await failReopens(namespace, timers, LINK_REOPEN_DELAYS_MS.length + 2, reopened);
    expect(lost()).toHaveLength(2);
  });

  it('reports no recovery for a socket lost and reopened within the first three reopens', async () => {
    const namespace = new FakeDurableObjectNamespace();
    const timers = manualTimers();
    const logger = new RecordingLogger();
    link(namespace, () => {}, { timers, logger });
    await setImmediate();
    namespace.clients.at(-1)?.fire('close', { data: '' });
    timers.runNext();
    await setImmediate();

    expect(logger.records).toEqual([]);
  });

  it('leaves no timer once its connection closes it while it reopens', async () => {
    const namespace = new FakeDurableObjectNamespace();
    const timers = manualTimers();
    const l = link(namespace, () => {}, { timers });
    await setImmediate();
    await failReopens(namespace, timers, 5);

    l.close();

    expect(timers.pending.filter((t) => !t.cleared)).toEqual([]);
    expect(l.publish(frame('after'))).toBe(false);
  });

  it('keeps reopening when the logger throws on the outage warning', async () => {
    const namespace = new FakeDurableObjectNamespace();
    const timers = manualTimers();
    const logger = new RecordingLogger();
    logger.warn = () => {
      throw new Error('logger down');
    };
    link(namespace, () => {}, { timers, logger });
    await setImmediate();

    const delays = await failReopens(namespace, timers, 6);

    expect(delays.at(-1)).toBe(16000);
    expect(timers.pending.filter((t) => !t.cleared)).toHaveLength(1);
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

  it('hands an open in flight to waitUntil when closed with nothing queued, and closes its socket', async () => {
    const namespace = new FakeDurableObjectNamespace();
    const held: Promise<unknown>[] = [];
    const early = new ConnectionLink({
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

    // Closed before its socket arrives: the close of that socket must outlive
    // this connection's request, or the hub keeps it open.
    early.close();
    expect(held).toHaveLength(1);
    await held[0];

    expect(namespace.clients[0]?.closed).toBe(true);
    expect(namespace.state('chat').getWebSockets()).toHaveLength(0);
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
