/** Behavior tests for the fetch-based SSE client. */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createSseClient } from '../../src/realtime/sse-client.ts';
import type { IClientTiming } from '../../src/http/contracts.ts';

function streamResponse(source: string): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode(source));
        controller.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

const immediateTiming: IClientTiming = {
  now: () => 0,
  sleep: () => Promise.resolve(),
};

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createSseClient', () => {
  it('delivers parsed events while sending configured bearer headers', async () => {
    let seenHeaders: Headers | undefined;
    const delivered = new Promise<{ readonly score: number }>((resolve) => {
      createSseClient<{ score: { readonly score: number } }>({
        url: 'https://example.test/events',
        headers: { Authorization: 'Bearer token' },
        timing: immediateTiming,
        reconnect: { maxAttempts: 0 },
        fetch: (_input, init) => {
          seenHeaders = new Headers(init?.headers);
          return Promise.resolve(streamResponse('event: score\ndata: {"score":2}\n\n'));
        },
        onEvent: (event) => resolve(event.data),
      });
    });

    await expect(delivered).resolves.toEqual({ score: 2 });
    expect(seenHeaders?.get('authorization')).toBe('Bearer token');
  });

  it('filters comment heartbeats before dispatching application events', async () => {
    const delivered = new Promise<string>((resolve) => {
      createSseClient<{ message: string }>({
        url: 'https://example.test/events',
        timing: immediateTiming,
        reconnect: { maxAttempts: 0 },
        fetch: () =>
          Promise.resolve(streamResponse(': heartbeat\n\nevent: message\ndata: "ready"\n\n')),
        onEvent: (event) => resolve(event.data),
      });
    });

    await expect(delivered).resolves.toBe('ready');
  });

  it('resends Last-Event-ID after a stream ends', async () => {
    const calls: Headers[] = [];
    let call = 0;
    const completed = new Promise<void>((resolve) => {
      createSseClient<{ message: string }>({
        url: 'https://example.test/events',
        timing: immediateTiming,
        reconnect: { maxAttempts: 1, delayMs: 0 },
        fetch: (_input, init) => {
          calls.push(new Headers(init?.headers));
          call++;
          if (call === 2) {
            resolve();
            return Promise.reject(new Error('server stopped'));
          }
          return Promise.resolve(
            streamResponse('id: checkpoint\nevent: message\ndata: "first"\n\n'),
          );
        },
        onEvent: () => {},
      });
    });

    await completed;
    expect(calls).toHaveLength(2);
    expect(calls[1]?.get('last-event-id')).toBe('checkpoint');
  });

  it('stops after the configured number of ended-stream reconnects', async () => {
    let calls = 0;
    const client = createSseClient({
      url: 'https://example.test/events',
      timing: immediateTiming,
      reconnect: { maxAttempts: 1, delayMs: 0 },
      fetch: () => {
        calls++;
        return Promise.resolve(streamResponse('data: null\n\n'));
      },
      onEvent: () => {},
    });

    await flush();

    expect(calls).toBe(2);
    expect(client.state).toBe('closed');
  });

  it('clears a prior event ID when the server supplies an empty ID', async () => {
    const calls: Headers[] = [];
    const client = createSseClient({
      url: 'https://example.test/events',
      timing: immediateTiming,
      reconnect: { maxAttempts: 1, delayMs: 0 },
      fetch: (_input, init) => {
        calls.push(new Headers(init?.headers));
        return Promise.resolve(
          streamResponse(
            calls.length === 1 ? 'id: checkpoint\n\nid:\ndata: null\n\n' : 'data: null\n\n',
          ),
        );
      },
      onEvent: () => {},
    });

    await flush();

    expect(calls[1]?.has('last-event-id')).toBe(false);
    expect(client.state).toBe('closed');
  });

  it('reports transport and payload errors before giving up', async () => {
    const errors: unknown[] = [];
    const client = createSseClient({
      url: 'https://example.test/events',
      timing: immediateTiming,
      reconnect: { maxAttempts: 0 },
      fetch: () => Promise.resolve(streamResponse('data: invalid-json\n\n')),
      onEvent: () => {},
      onError: (error) => errors.push(error),
    });

    await flush();

    expect(errors).toHaveLength(1);
    expect(client.state).toBe('closed');
  });

  it('uses custom parsing and validates reconnect options', async () => {
    const values: string[] = [];
    const client = createSseClient<{ message: string }>({
      url: 'https://example.test/events',
      timing: immediateTiming,
      reconnect: { maxAttempts: 0 },
      fetch: () => Promise.resolve(streamResponse('event: message\ndata: raw\n\n')),
      parse: (event) => event.data.toUpperCase(),
      onEvent: (event) => {
        values.push(event.data);
      },
    });

    await flush();

    expect(values).toEqual(['RAW']);
    expect(client.state).toBe('closed');
    for (
      const reconnect of [
        { maxAttempts: -1 },
        { maxAttempts: 1.5 },
        { delayMs: -1 },
        { maxDelayMs: -1 },
        { delayMs: Number.NaN },
        { delayMs: Infinity },
        { maxDelayMs: -Infinity },
      ]
    ) {
      expect(() =>
        createSseClient({
          url: 'https://example.test/events',
          reconnect,
          onEvent: () => {},
        })
      ).toThrow();
    }
  });

  it('does not start when its external signal was already aborted', () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const client = createSseClient({
      url: 'https://example.test/events',
      signal: controller.signal,
      fetch: () => {
        calls++;
        return Promise.resolve(streamResponse('data: null\n\n'));
      },
      onEvent: () => {},
    });

    expect(calls).toBe(0);
    expect(client.state).toBe('closed');
  });

  it('uses the global fetch fallback and reports rejected HTTP responses', async () => {
    const originalFetch = globalThis.fetch;
    const errors: unknown[] = [];
    globalThis.fetch = (() => Promise.resolve(new Response(null, { status: 503 }))) as typeof fetch;
    try {
      const client = createSseClient({
        url: 'https://example.test/events',
        timing: immediateTiming,
        reconnect: { maxAttempts: 0 },
        onEvent: () => {},
        onError: (error) => errors.push(error),
      });
      await flush();

      expect(errors).toHaveLength(1);
      expect(client.state).toBe('closed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('stops an active stream when close is called', async () => {
    let cancelled = false;
    const client = createSseClient({
      url: 'https://example.test/events',
      timing: immediateTiming,
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              cancel(): void {
                cancelled = true;
              },
            }),
            { status: 200 },
          ),
        ),
      onEvent: () => {},
    });

    await Promise.resolve();
    client.close();
    await Promise.resolve();
    expect(client.state).toBe('closed');
    expect(cancelled).toBe(true);
  });

  it('clamps a server retry hint to the configured maximum delay', async () => {
    const slept: number[] = [];
    let served = 0;
    const client = createSseClient({
      url: 'https://example.test/events',
      reconnect: { delayMs: 1_000, maxDelayMs: 30_000 },
      timing: {
        now: () => 0,
        sleep: (ms: number) => {
          slept.push(ms);
          return Promise.resolve();
        },
      },
      fetch: (_input, init) => {
        served += 1;
        if (served > 1 || (init?.signal as AbortSignal | undefined)?.aborted) {
          return Promise.reject(new DOMException('Aborted', 'AbortError'));
        }
        // A server may send any digit string; the parser accepts up to
        // Number.MAX_SAFE_INTEGER, which overflows a 32-bit timer and fires
        // immediately, turning the reconnect policy into a hot loop.
        return Promise.resolve(streamResponse('retry: 9007199254740991\ndata: 1\n\n'));
      },
      onEvent: () => {},
    });

    await flush();
    client.close();

    expect(slept[0]).toBeLessThanOrEqual(30_000);
  });

  it('does not reopen a closed client when a custom fetch ignores the abort signal', async () => {
    let release: ((response: Response) => void) | undefined;
    const states: string[] = [];
    const client = createSseClient({
      url: 'https://example.test/events',
      timing: immediateTiming,
      reconnect: { maxAttempts: 0 },
      fetch: () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
      onEvent: () => {},
      onStateChange: (state) => states.push(state),
    });

    client.close();
    release?.(streamResponse('data: 1\n\n'));
    await flush();

    expect(client.state).toBe('closed');
    expect(states).not.toContain('open');
  });
});
