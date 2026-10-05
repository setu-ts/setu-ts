/**
 * M98l realtime observations for the SSE plugin: what each capture site counts
 * (plan §3.6) — including the backlog guard's `backpressureCloses` — the
 * gauges read from the plugin's OWN service, the disabled path, canaries,
 * observed-versus-unobserved parity, and teardown.
 *
 * Driven through `SsePlugin(...).register(...)` over a fake context with a
 * hand-advanced monotonic clock and captured intervals.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IPluginContext,
  IRealtimeDiagnosticsSource,
  IRequestContext,
  IRuntimeServices,
  RealtimeDiagnosticsSnapshot,
  TimerHandle,
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { SsePlugin } from '../../src/plugin/sse-plugin.ts';
import type { SsePluginOptions } from '../../src/interfaces/index.ts';
import type { SseService } from '../../src/services/sse-service.ts';
import type { SseConnection } from '../../src/connection/sse-connection.ts';
import { realtimeObserverOf } from '../../src/diagnostics/realtime-observations.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

const ENABLED = { enabled: true, alias: 'news-feed' } as const;

interface ManualRuntime extends IRuntimeServices {
  advance(ms: number): void;
  tick(): void;
}

/** The package's fake runtime with a manual clock and captured intervals. */
function manualRuntime(): ManualRuntime {
  let now = 1_000;
  const intervals: { fn: () => void; cleared: boolean }[] = [];
  return {
    ...createFakeRuntime(),
    hrtime: () => now,
    setInterval: (fn: () => void): TimerHandle => {
      const entry = { fn, cleared: false };
      intervals.push(entry);
      return entry as unknown as TimerHandle;
    },
    clearInterval: (handle: TimerHandle): void => {
      (handle as unknown as { cleared: boolean }).cleared = true;
    },
    advance(ms: number): void {
      now += ms;
    },
    tick(): void {
      for (const entry of intervals) {
        if (!entry.cleared) {
          entry.fn();
        }
      }
    },
  };
}

interface Harness {
  readonly runtime: ManualRuntime;
  readonly service: SseService;
  readonly source: IRealtimeDiagnosticsSource;
  readonly sources: unknown[];
  readonly closeHooks: (() => void)[];
  replaceService(replacement: unknown): void;
}

async function setup(options?: SsePluginOptions): Promise<Harness> {
  const runtime = manualRuntime();
  const single = new Map<string, unknown>();
  const multi = new Map<string, unknown[]>();
  const closeHooks: (() => void)[] = [];
  const ctx = {
    runtime,
    services: {
      has: (token: string): boolean => single.has(token),
      get: <T>(token: string): T => single.get(token) as T,
      register: <T>(token: string, value: T, opts?: { multi?: boolean }): void => {
        if (opts?.multi === true) {
          multi.set(token, [...(multi.get(token) ?? []), value]);
        } else {
          single.set(token, value);
        }
      },
    },
    health: { register: (): void => {} },
    lifecycle: {
      onClose: (hook: () => void): void => {
        closeHooks.push(hook);
      },
    },
  } as unknown as IPluginContext;
  await SsePlugin({ scalingNotice: false, ...options }).register(ctx);
  const sources = multi.get(CAPABILITIES.REALTIME_DIAGNOSTICS) ?? [];
  return {
    runtime,
    service: single.get(CAPABILITIES.SSE) as SseService,
    source: sources[0] as IRealtimeDiagnosticsSource,
    sources,
    closeHooks,
    replaceService(replacement: unknown): void {
      single.set(CAPABILITIES.SSE, replacement);
    },
  };
}

/** Opens a stream over a fake request whose signal the test controls. */
function openStream(
  harness: Harness,
  headers?: Record<string, string>,
): { conn: SseConnection; abort: AbortController; ctx: IRequestContext } {
  const abort = new AbortController();
  const ctx = createFakeContext({
    signal: abort.signal,
    runtime: harness.runtime,
    ...(headers === undefined ? {} : { headers }),
  });
  return { conn: harness.service.open(ctx) as SseConnection, abort, ctx };
}

/** Everything the stream carried, read after it closed. */
async function drain(ctx: IRequestContext): Promise<string> {
  const snapshot = ctx.response.snapshot();
  if (!snapshot.streaming) {
    return '';
  }
  const reader = snapshot.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      return text;
    }
    text += decoder.decode(chunk.value);
  }
}

function record(snapshot: RealtimeDiagnosticsSnapshot, operation: string) {
  return snapshot.records.find((entry) => entry.operation === operation);
}

/** Fills the unread stream past the 1 MiB backlog guard. */
function overflow(conn: SseConnection): void {
  const big = 'x'.repeat(10_000);
  for (let index = 0; index < 200 && conn.isOpen; index++) {
    conn.send({ data: big });
  }
}

describe('SsePlugin realtime observations (M98l)', () => {
  it('refuses an invalid diagnostics option when the plugin is constructed', () => {
    expect(() => SsePlugin({ diagnostics: { enabled: true, alias: 'a\u0000' } })).toThrow(
      'control, format or line-separator character',
    );
  });

  describe('disabled by default', () => {
    it('registers one inert sse source, attaches nothing, and never reads the service', async () => {
      const harness = await setup();
      expect(harness.sources).toHaveLength(1);
      expect(Object.keys(harness.source)).toEqual(['snapshot']);
      expect(realtimeObserverOf(harness.service)).toBeUndefined();
      const { conn } = openStream(harness);
      conn.send({ data: 'x' });
      expect(realtimeObserverOf(conn)).toBeUndefined();
      let reads = 0;
      Object.defineProperty(harness.service, 'connectionCount', {
        get: () => {
          reads++;
          return 0;
        },
      });
      expect(harness.source.snapshot()).toEqual({
        state: 'disabled',
        alias: null,
        sourceKind: 'sse',
        coverage: 'owned-instance',
        gauges: { state: 'disabled', openConnections: null, groups: null },
        records: [],
        dropped: 0,
      });
      expect(reads).toBe(0);
    });
  });

  describe('enabled', () => {
    it('reports measured zero gauges and ready before any operation', async () => {
      const harness = await setup({ diagnostics: ENABLED });
      expect(harness.source.snapshot()).toMatchObject({
        state: 'ready',
        alias: 'news-feed',
        sourceKind: 'sse',
        gauges: { state: 'available', openConnections: 0, groups: 0 },
        records: [],
      });
    });

    it('counts opens and every enqueued frame, heartbeats included', async () => {
      const harness = await setup({ diagnostics: ENABLED, heartbeatMs: 1_000, retryMs: 500 });
      const { conn } = openStream(harness);
      conn.send({ data: 'a' });
      conn.comment('b');
      harness.service.channel('c').add(conn);
      harness.service.channel('c').publish({ data: 'c' });
      harness.runtime.tick();
      const snapshot = harness.source.snapshot();
      expect(record(snapshot, 'open')).toMatchObject({ count: 1, succeeded: 1, failed: 0 });
      // The `retry:` frame is written during construction, before attachment.
      expect(record(snapshot, 'send')).toMatchObject({
        count: 4,
        succeeded: 4,
        failed: 0,
        backpressureCloses: null,
        lastDurationMs: null,
      });
    });

    it('a client abort is a normal close carrying 0 backpressure closes', async () => {
      const harness = await setup({ diagnostics: ENABLED });
      const { abort } = openStream(harness);
      abort.abort();
      expect(record(harness.source.snapshot(), 'close')).toEqual({
        alias: 'news-feed',
        operation: 'close',
        count: 1,
        lastDurationMs: null,
        ageMs: 0,
        succeeded: 1,
        failed: 0,
        backpressureCloses: 0,
      });
    });

    it('a backlog close is a failed send, a failed close and one backpressure close', async () => {
      const harness = await setup({ diagnostics: ENABLED });
      const { conn } = openStream(harness);
      overflow(conn);
      expect(conn.isOpen).toBe(false);
      const snapshot = harness.source.snapshot();
      expect(record(snapshot, 'close')).toMatchObject({
        count: 1,
        succeeded: 0,
        failed: 1,
        backpressureCloses: 1,
      });
      expect(record(snapshot, 'send')?.failed).toBe(1);
      // A write after the close is the existing silent no-op, not counted.
      const before = record(snapshot, 'send')?.count;
      conn.send({ data: 'late' });
      expect(record(harness.source.snapshot(), 'send')?.count).toBe(before);
    });

    it('an enqueue that throws is a failed send and a failed, non-backpressure close', async () => {
      const harness = await setup({ diagnostics: ENABLED });
      const original = globalThis.ReadableStream;
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      class Capturing extends original<Uint8Array> {
        constructor(source?: UnderlyingSource<Uint8Array>, strategy?: QueuingStrategy<Uint8Array>) {
          super({
            ...source,
            start: (ctrl) => {
              controller = ctrl as ReadableStreamDefaultController<Uint8Array>;
              return source?.start?.(ctrl);
            },
          }, strategy);
        }
      }
      globalThis.ReadableStream = Capturing as typeof globalThis.ReadableStream;
      let conn: SseConnection;
      try {
        conn = openStream(harness).conn;
      } finally {
        globalThis.ReadableStream = original;
      }
      controller!.error(new Error('CANARY-stream-error'));
      conn.send({ data: 'x' });
      expect(conn.isOpen).toBe(false);
      const snapshot = harness.source.snapshot();
      expect(record(snapshot, 'send')).toMatchObject({ succeeded: 0, failed: 1 });
      expect(record(snapshot, 'close')).toMatchObject({ failed: 1, backpressureCloses: 0 });
      expect(JSON.stringify(snapshot)).not.toContain('CANARY');
    });

    it('a constructor that throws is a failed open, rethrown unchanged', async () => {
      const harness = await setup({ diagnostics: ENABLED });
      const ctx = createFakeContext({ runtime: harness.runtime });
      const boom = new Error('stream refused');
      (ctx.response as { stream: unknown }).stream = () => {
        throw boom;
      };
      let caught: unknown;
      try {
        harness.service.open(ctx);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(boom);
      expect(record(harness.source.snapshot(), 'open')).toMatchObject({ succeeded: 0, failed: 1 });
      expect(harness.service.connectionCount).toBe(0);
    });

    it('an idle stream outlives its records: gauges stay current and the source stays ready', async () => {
      const harness = await setup({ diagnostics: ENABLED });
      openStream(harness);
      harness.runtime.advance(60_001);
      const snapshot = harness.source.snapshot();
      expect(snapshot.records).toEqual([]);
      expect(snapshot.state).toBe('ready');
      expect(snapshot.gauges).toEqual({ state: 'available', openConnections: 1, groups: 0 });
    });

    it('sees a channel created with no traffic, and repeated reads create none', async () => {
      const harness = await setup({ diagnostics: ENABLED });
      harness.service.channel('announcements');
      for (let index = 0; index < 5; index++) {
        expect(harness.source.snapshot().gauges.groups).toBe(1);
      }
      expect(harness.service.channelCount).toBe(1);
    });

    it('reports openConnections 0 after the last stream closes', async () => {
      const harness = await setup({ diagnostics: ENABLED });
      const { conn } = openStream(harness);
      expect(harness.source.snapshot().gauges.openConnections).toBe(1);
      conn.close();
      expect(harness.source.snapshot().gauges.openConnections).toBe(0);
    });

    it('reads the ORIGINAL service after the capability is replaced', async () => {
      const harness = await setup({ diagnostics: ENABLED });
      openStream(harness);
      harness.replaceService({
        get connectionCount(): number {
          throw new Error('the replacement must never be read');
        },
      });
      expect(harness.source.snapshot().gauges.openConnections).toBe(1);
    });

    it('carries no message, comment, channel name or Last-Event-ID — with counts as the control', async () => {
      const harness = await setup({ diagnostics: ENABLED });
      const { conn, abort } = openStream(harness, { 'last-event-id': 'CANARY-last-id' });
      harness.service.channel('CANARY-channel').add(conn);
      harness.service.channel('CANARY-channel').publish({ id: 'CANARY-id', data: 'CANARY-data' });
      conn.comment('CANARY-comment');
      abort.abort('CANARY-abort-reason');
      const serialized = JSON.stringify(harness.source.snapshot());
      expect(serialized).not.toContain('CANARY');
      expect(serialized).not.toContain(conn.id);
      expect(serialized).toContain('news-feed');
      expect(record(harness.source.snapshot(), 'send')?.count).toBe(2);
    });

    it('does not change the stream bytes, closes or membership compared with an unobserved plugin', async () => {
      const run = async (options?: SsePluginOptions) => {
        const harness = await setup({ retryMs: 250, ...options });
        const a = openStream(harness);
        const b = openStream(harness);
        harness.service.channel('n').add(a.conn);
        harness.service.channel('n').add(b.conn);
        harness.service.channel('n').publish({ event: 'e', data: 'one' });
        a.conn.comment('note');
        b.abort.abort();
        overflow(a.conn);
        return {
          a: (await drain(a.ctx)).length,
          b: await drain(b.ctx),
          open: [a.conn.isOpen, b.conn.isOpen],
          size: harness.service.channel('n').size,
          connections: harness.service.connectionCount,
        };
      };
      expect(await run({ diagnostics: ENABLED })).toEqual(await run());
    });
  });

  describe('teardown', () => {
    it('detaches first, then closes: disabled gauges, no reader call, no late counts', async () => {
      const harness = await setup({ diagnostics: ENABLED, heartbeatMs: 1_000 });
      const { conn } = openStream(harness);
      let reads = 0;
      Object.defineProperty(harness.service, 'connectionCount', {
        get: () => {
          reads++;
          return 1;
        },
      });
      for (const hook of harness.closeHooks) {
        hook();
      }
      expect(realtimeObserverOf(harness.service)).toBeUndefined();
      expect(conn.isOpen).toBe(false);
      conn.send({ data: 'late' });
      const snapshot = harness.source.snapshot();
      expect(snapshot.state).toBe('disabled');
      expect(snapshot.sourceKind).toBe('sse');
      expect(snapshot.gauges).toEqual({ state: 'disabled', openConnections: null, groups: null });
      expect(snapshot.records).toEqual([]);
      expect(reads).toBe(0);
    });
  });
});
