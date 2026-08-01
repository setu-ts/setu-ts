/**
 * Unit tests for the Kubernetes watch loop.
 *
 * The stream is a change SIGNAL, not a delta log: every real event triggers a
 * fresh LIST, which is what removes the stateful slice-merge these tests would
 * otherwise have to pin.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { watchKubernetesService } from '../../src/providers/kubernetes-watch.ts';
import type { ServiceInstance, Unsubscribe } from '@hono-enterprise/common';
import {
  createFakeHttp,
  createFakeRuntime,
  type FakeHttp,
  type FakeRuntime,
} from '../fixtures/fakes.ts';

/** Yields to the event loop so the detached watch loop can advance. */
function flush(times = 12): Promise<void> {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i++) {
    chain = chain.then(() => undefined);
  }
  return chain;
}

function start(
  http: FakeHttp,
  listener: (instances: readonly ServiceInstance[]) => void = () => {},
): { unsubscribe: Promise<Unsubscribe>; runtime: FakeRuntime } {
  const runtime = createFakeRuntime();
  const unsubscribe = watchKubernetesService({
    serviceName: 'billing',
    listener,
    http,
    runtime,
    listUrl: (extra) => {
      const params = new URLSearchParams(extra ?? {});
      return `https://api/endpointslices?${params}`;
    },
    authHeader: () => Promise.resolve('Bearer t'),
    map: () => [],
    resourceVersionOf: (body) =>
      (body as { metadata?: { resourceVersion?: string } }).metadata?.resourceVersion ?? null,
  });
  return { unsubscribe, runtime };
}

/** A LIST response carrying a resource version. */
function listAt(version: string): { text: string } {
  return { text: JSON.stringify({ items: [], metadata: { resourceVersion: version } }) };
}

describe('watchKubernetesService', () => {
  it('LISTs first, fires the listener, then opens a watch at that version', async () => {
    const http = createFakeHttp([
      listAt('100'),
      { chunks: [] },
    ]);
    let fired = 0;
    const unsubscribe = await start(http, () => fired++).unsubscribe;
    await flush();
    unsubscribe();

    expect(http.calls[0].streaming).toBe(false);
    expect(fired).toBeGreaterThan(0);
    expect(http.calls[1].streaming).toBe(true);
    expect(http.calls[1].url).toContain('watch=true');
    expect(http.calls[1].url).toContain('resourceVersion=100');
    expect(http.calls[1].url).toContain('allowWatchBookmarks=true');
  });

  it('a MODIFIED event triggers a re-LIST and another listener call', async () => {
    const http = createFakeHttp([
      listAt('100'),
      { chunks: ['{"type":"MODIFIED","object":{"metadata":{"resourceVersion":"101"}}}\n'] },
      listAt('102'),
      { chunks: [] },
    ]);
    let fired = 0;
    const unsubscribe = await start(http, () => fired++).unsubscribe;
    await flush(20);
    unsubscribe();

    // One from the initial LIST, one from the re-LIST the event triggered.
    expect(fired).toBeGreaterThanOrEqual(2);
    const lists = http.calls.filter((c) => !c.streaming);
    expect(lists.length).toBeGreaterThanOrEqual(2);
  });

  it('a BOOKMARK fires no listener call but advances the version', async () => {
    const http = createFakeHttp([
      listAt('100'),
      { chunks: ['{"type":"BOOKMARK","object":{"metadata":{"resourceVersion":"150"}}}\n'] },
      { chunks: [] },
    ]);
    let fired = 0;
    const unsubscribe = await start(http, () => fired++).unsubscribe;
    await flush(20);
    unsubscribe();

    // Only the initial LIST fired the listener; the bookmark did not.
    expect(fired).toBe(1);
    const watches = http.calls.filter((c) => c.streaming);
    expect(watches[1].url).toContain('resourceVersion=150');
  });

  it('a 410 Gone discards the watch and restarts from a fresh LIST', async () => {
    const http = createFakeHttp([
      listAt('100'),
      { status: 410, chunks: null },
      listAt('200'),
      { chunks: [] },
    ]);
    const unsubscribe = await start(http).unsubscribe;
    await flush(20);
    unsubscribe();

    const streamIndex = http.calls.findIndex((c) => c.streaming);
    // The call right after the 410 is a LIST, not another watch.
    expect(http.calls[streamIndex + 1].streaming).toBe(false);
  });

  it('an ERROR event restarts from a fresh LIST', async () => {
    const http = createFakeHttp([
      listAt('100'),
      { chunks: ['{"type":"ERROR","object":{}}\n'] },
      listAt('200'),
      { chunks: [] },
    ]);
    const unsubscribe = await start(http).unsubscribe;
    await flush(20);
    unsubscribe();

    const lists = http.calls.filter((c) => !c.streaming);
    expect(lists.length).toBeGreaterThanOrEqual(2);
  });

  it('a stream that closes cleanly reconnects without a fresh LIST', async () => {
    const http = createFakeHttp([
      listAt('100'),
      { chunks: ['{"type":"BOOKMARK","object":{"metadata":{"resourceVersion":"101"}}}\n'] },
      { chunks: ['{"type":"BOOKMARK","object":{"metadata":{"resourceVersion":"102"}}}\n'] },
    ]);
    const unsubscribe = await start(http).unsubscribe;
    await flush(20);
    unsubscribe();

    // Two consecutive watch calls with only the one initial LIST before them.
    const kinds = http.calls.slice(0, 3).map((c) => c.streaming);
    expect(kinds).toEqual([false, true, true]);
  });

  it('backs off before reconnecting a stream that delivered nothing', async () => {
    // A watch that closes immediately — an idle timeout, or a server refusing
    // it with a 200 — must not be reconnected in a tight loop. Without the
    // backoff this spins the event loop forever and floods the API server.
    const http = createFakeHttp([listAt('100'), { chunks: [] }]);
    const started = start(http);
    const unsubscribe = await started.unsubscribe;
    await flush(20);

    expect(started.runtime.timeouts).toHaveLength(1);
    expect(started.runtime.timeouts[0].ms).toBe(250);

    const before = http.calls.length;
    started.runtime.runTimeouts();
    await flush(20);
    expect(http.calls.length).toBeGreaterThan(before);

    unsubscribe();
  });

  it('backs off and retries when the LIST rejects', async () => {
    const http = createFakeHttp([
      { error: new Error('ECONNREFUSED') },
      listAt('100'),
      { chunks: [] },
    ]);
    const started = start(http);
    const unsubscribe = await started.unsubscribe;
    await flush();

    expect(started.runtime.timeouts).toHaveLength(1);
    expect(started.runtime.timeouts[0].ms).toBe(250);
    started.runtime.runTimeouts();
    await flush(20);
    unsubscribe();

    expect(http.calls.length).toBeGreaterThan(1);
  });

  it('treats a non-2xx LIST as a failure', async () => {
    const http = createFakeHttp([
      { status: 500, text: 'boom' },
      listAt('100'),
      { chunks: [] },
    ]);
    const started = start(http);
    const unsubscribe = await started.unsubscribe;
    await flush();

    expect(started.runtime.timeouts).toHaveLength(1);
    started.runtime.runTimeouts();
    await flush(20);
    unsubscribe();

    expect(http.calls.length).toBeGreaterThan(1);
  });

  it('unsubscribe aborts the stream and stops the restart loop', async () => {
    const http = createFakeHttp([listAt('100'), { chunks: [] }]);
    const unsubscribe = await start(http).unsubscribe;
    await flush();

    const signal = http.calls[0].init?.signal;
    expect(signal?.aborted).toBe(false);
    unsubscribe();
    expect(signal?.aborted).toBe(true);

    const seen = http.calls.length;
    await flush(20);
    expect(http.calls.length).toBe(seen);
  });
});

describe('watchKubernetesService — resource hygiene', () => {
  /**
   * A stream that stays OPEN after emitting, the way a real watch does, and
   * reports whether it was cancelled. A self-closing fake cannot show this
   * defect at all: cancelling an already-closed stream is a no-op, so it
   * reports zero cancels whether the code is correct or not.
   */
  function longLivedStream(
    lines: readonly string[],
    onCancel: () => void,
  ): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(line));
        }
      },
      pull() {
        // Never closes — the watch is long-lived.
      },
      cancel: onCancel,
    });
  }

  it('cancels a watch body it abandons on resync', async () => {
    // An ERROR event makes the loop stop consuming and re-LIST. Releasing the
    // reader lock without cancelling leaves a chunked body — a live connection
    // to the API server — open until the server times it out.
    let opened = 0;
    let cancelled = 0;
    const list = JSON.stringify({ items: [], metadata: { resourceVersion: '100' } });
    const http = {
      request: () => Promise.resolve({ ok: true, status: 200, headers: new Headers(), text: list }),
      stream: () => {
        opened++;
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          body: longLivedStream(['{"type":"ERROR","object":{}}\n'], () => {
            cancelled++;
          }),
        });
      },
    };

    const runtime = createFakeRuntime();
    const unsubscribe = await watchKubernetesService({
      serviceName: 'billing',
      listener: () => {},
      http,
      runtime,
      listUrl: () => 'https://api/x',
      authHeader: () => Promise.resolve('Bearer t'),
      map: () => [],
      resourceVersionOf: () => '100',
    });

    await flush(40);
    unsubscribe();
    await flush(10);

    expect(opened).toBeGreaterThan(1);
    // Every abandoned body is cancelled, not merely unlocked.
    expect(cancelled).toBe(opened);
  });

  it('does not accumulate an abort listener per backoff retry', async () => {
    let added = 0;
    let removed = 0;
    const originalAdd = AbortSignal.prototype.addEventListener;
    const originalRemove = AbortSignal.prototype.removeEventListener;
    AbortSignal.prototype.addEventListener = function (
      ...args: Parameters<typeof originalAdd>
    ) {
      if (args[0] === 'abort') added++;
      return originalAdd.apply(this, args);
    };
    AbortSignal.prototype.removeEventListener = function (
      ...args: Parameters<typeof originalRemove>
    ) {
      if (args[0] === 'abort') removed++;
      return originalRemove.apply(this, args);
    };

    try {
      const http = createFakeHttp([{ error: new Error('ECONNREFUSED') }]);
      const started = start(http);
      const unsubscribe = await started.unsubscribe;

      for (let cycle = 0; cycle < 20; cycle++) {
        await flush();
        started.runtime.runTimeouts();
      }
      await flush();
      unsubscribe();

      expect(added).toBeGreaterThan(5);
      expect(added - removed).toBeLessThanOrEqual(1);
    } finally {
      AbortSignal.prototype.addEventListener = originalAdd;
      AbortSignal.prototype.removeEventListener = originalRemove;
    }
  });
});
