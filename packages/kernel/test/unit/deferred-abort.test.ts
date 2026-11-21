/**
 * `wrapDeferredStream` with the request's signal (V13-200): cleanups run once,
 * on whichever comes first, the stream finishing or the signal aborting.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';

import { wrapDeferredStream } from '../../src/context/deferred.ts';
import { ServiceRegistry } from '../../src/registry/service-registry.ts';

/** A source that never ends unless cancelled. */
function endless(onCancel: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    cancel() {
      onCancel();
    },
  });
}

describe('wrapDeferredStream and the request signal', () => {
  it('runs the cleanups at once for a signal that was already aborted', async () => {
    const order: string[] = [];
    const client = new AbortController();
    client.abort();
    wrapDeferredStream(
      endless(() => order.push('source cancelled')),
      [() => void order.push('cleanup')],
      new ServiceRegistry(),
      () => order.push('complete'),
      client.signal,
      () => order.push('aborted'),
    );
    await Promise.resolve();
    expect(order).toEqual(['aborted', 'cleanup', 'complete', 'source cancelled']);
  });

  it('ignores an abort that comes after the stream finished', async () => {
    let cleaned = 0;
    let aborts = 0;
    const client = new AbortController();
    const wrapped = wrapDeferredStream(
      new Blob(['ok']).stream(),
      [() => void cleaned++],
      new ServiceRegistry(),
      () => {},
      client.signal,
      () => void aborts++,
    );
    expect(await new Response(wrapped).text()).toBe('ok');
    client.abort();
    await Promise.resolve();
    expect(cleaned).toBe(1);
    expect(aborts).toBe(0);
  });

  it('attaches nothing when there is no cleanup to run', async () => {
    let aborts = 0;
    const client = new AbortController();
    wrapDeferredStream(
      endless(() => {}),
      [],
      new ServiceRegistry(),
      () => {},
      client.signal,
      () => void aborts++,
    );
    client.abort();
    await Promise.resolve();
    expect(aborts).toBe(0);
  });
});
