/**
 * Unit tests for the Consul blocking-query loop.
 *
 * Both index rules are documented upstream requirements: a backwards index
 * after a server restart makes the client miss updates for an unbounded time,
 * and an index of 0 busy-loops older servers.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { nextIndex, watchConsulService } from '../../src/providers/consul-watch.ts';
import type { ServiceInstance } from '@hono-enterprise/common';
import type { Unsubscribe } from '@hono-enterprise/common';
import {
  createFakeHttp,
  createFakeRuntime,
  type FakeHttp,
  type FakeRuntime,
} from '../fixtures/fakes.ts';

/** Yields to the event loop so the detached watch loop can advance. */
function flush(times = 6): Promise<void> {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i++) {
    chain = chain.then(() => undefined);
  }
  return chain;
}

function start(
  http: FakeHttp,
  onChange: (instances: readonly ServiceInstance[]) => void = () => {},
): { unsubscribe: Promise<Unsubscribe>; runtime: FakeRuntime } {
  const runtime = createFakeRuntime();
  const unsubscribe = watchConsulService({
    serviceName: 'billing',
    listener: onChange,
    http,
    runtime,
    url: (index) => `http://consul:8500/v1/health/service/billing?index=${index}`,
    headers: { 'X-Consul-Token': 'secret' },
    map: () => [],
  });
  return { unsubscribe, runtime };
}

describe('nextIndex', () => {
  it('adopts a larger index', () => {
    expect(nextIndex(5, '42')).toBe(42);
  });

  it('treats an index of 0 as 1, since 0 busy-loops older servers', () => {
    expect(nextIndex(5, '0')).toBe(1);
  });

  it('treats a negative index as 1', () => {
    expect(nextIndex(5, '-3')).toBe(1);
  });

  it('resets to 0 when the index moves backwards', () => {
    expect(nextIndex(100, '7')).toBe(0);
  });

  it('keeps the current index when the header is missing', () => {
    expect(nextIndex(9, null)).toBe(9);
  });

  it('keeps the current index when the header is not a number', () => {
    expect(nextIndex(9, 'not-a-number')).toBe(9);
  });
});

describe('watchConsulService', () => {
  it('starts at index=0 and carries the returned index onto the next request', async () => {
    const http = createFakeHttp([
      { text: '[]', headers: { 'X-Consul-Index': '42' } },
      { text: '[]', headers: { 'X-Consul-Index': '43' } },
    ]);
    const unsubscribe = await start(http).unsubscribe;
    await flush();
    unsubscribe();

    expect(http.calls[0].url).toContain('index=0');
    expect(http.calls[1].url).toContain('index=42');
    expect(http.calls[2]?.url).toContain('index=43');
  });

  it('sends the configured headers on every request', async () => {
    const http = createFakeHttp([{ text: '[]', headers: { 'X-Consul-Index': '1' } }]);
    const unsubscribe = await start(http).unsubscribe;
    await flush();
    unsubscribe();

    expect(http.calls[0].init?.headers).toEqual({ 'X-Consul-Token': 'secret' });
  });

  it('fires the listener after every completed response', async () => {
    const http = createFakeHttp([{ text: '[]', headers: { 'X-Consul-Index': '5' } }]);
    let fired = 0;
    const unsubscribe = await start(http, () => fired++).unsubscribe;
    await flush();
    unsubscribe();

    expect(fired).toBeGreaterThan(0);
  });

  it('backs off and retries rather than exiting after a rejected request', async () => {
    const http = createFakeHttp([
      { error: new Error('ECONNREFUSED') },
      { text: '[]', headers: { 'X-Consul-Index': '9' } },
    ]);
    let fired = 0;
    const started = start(http, () => fired++);
    const unsubscribe = await started.unsubscribe;
    await flush();

    // The loop is parked in its backoff sleep — firing the captured timer is
    // what proves it retries rather than exiting.
    expect(started.runtime.timeouts).toHaveLength(1);
    expect(started.runtime.timeouts[0].ms).toBe(250);
    started.runtime.runTimeouts();
    await flush();
    unsubscribe();

    expect(http.calls.length).toBeGreaterThan(1);
    expect(fired).toBeGreaterThan(0);
  });

  it('treats a non-2xx response as a failure and retries', async () => {
    const http = createFakeHttp([
      { status: 500, text: 'boom' },
      { text: '[]', headers: { 'X-Consul-Index': '9' } },
    ]);
    let fired = 0;
    const started = start(http, () => fired++);
    const unsubscribe = await started.unsubscribe;
    await flush();

    started.runtime.runTimeouts();
    await flush();
    unsubscribe();

    expect(http.calls.length).toBeGreaterThan(1);
    expect(fired).toBeGreaterThan(0);
  });

  it('unsubscribe stops the loop and aborts the in-flight request', async () => {
    const http = createFakeHttp([{ text: '[]', headers: { 'X-Consul-Index': '1' } }]);
    const unsubscribe = await start(http).unsubscribe;
    await flush();

    const signal = http.calls[0].init?.signal;
    expect(signal?.aborted).toBe(false);

    unsubscribe();
    expect(signal?.aborted).toBe(true);

    const seen = http.calls.length;
    await flush();
    expect(http.calls.length).toBe(seen);
  });
});
