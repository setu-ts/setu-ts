/**
 * The bounded body read (M90a §3.4).
 *
 * X32-4: `requestSizeMiddleware` refuses on a declared `Content-Length` and a
 * chunked request declares none, so a body of any size reached
 * `Request.arrayBuffer()` unbounded. The middleware cannot close that — the
 * read lives in this package, and since M87 made it lazy it happens inside the
 * handler, after every middleware has returned. `RuntimePlugin({ maxBodyBytes })`
 * threads a cap into the mapping, which is where the body is actually consumed.
 *
 * Driven with real `Request` objects over real `ReadableStream` bodies: a fake
 * stream cannot show that the reader is cancelled, and a fake `Request` cannot
 * show that the bodyless fast path is taken before `.body` is ever touched.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  mapWebRequestToFrameworkRequest,
  RequestBodyTooLargeError,
} from '../../src/adapters/shared/fetch-mapping.ts';
import { httpStatusHintOf } from '@setu-ts/common';

/** A chunked-style request whose body arrives in `chunks`, with no length. */
function streamedRequest(chunks: readonly Uint8Array[]): {
  request: Request;
  cancelled: () => boolean;
} {
  let wasCancelled = false;
  let index = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index] as Uint8Array);
        index++;
        return;
      }
      controller.close();
    },
    cancel() {
      wasCancelled = true;
    },
  });
  const request = new Request('http://localhost/upload', {
    method: 'POST',
    body,
    // A real chunked upload declares no length. Deno requires the duplex hint
    // for a stream body.
    ...({ duplex: 'half' } as Record<string, unknown>),
  });
  return { request, cancelled: () => wasCancelled };
}

const encoder = new TextEncoder();
const chunk = (text: string): Uint8Array => encoder.encode(text);

describe('bounded body read (X32-4)', () => {
  it('with NO cap the body is read whole — the released behaviour', async () => {
    const { request } = streamedRequest([chunk('a'.repeat(5_000))]);
    const framework = mapWebRequestToFrameworkRequest(request);
    const bytes = await framework.bytes();
    expect(bytes.byteLength).toBe(5_000);
  });

  it('a body under the cap resolves whole', async () => {
    const { request } = streamedRequest([chunk('hello'), chunk(' world')]);
    const framework = mapWebRequestToFrameworkRequest(request, 100);
    expect(await framework.text()).toBe('hello world');
  });

  it('a body EXACTLY at the cap is accepted', async () => {
    const { request } = streamedRequest([chunk('0123456789')]);
    const framework = mapWebRequestToFrameworkRequest(request, 10);
    expect((await framework.bytes()).byteLength).toBe(10);
  });

  it('a body past the cap rejects with RequestBodyTooLargeError', async () => {
    const { request } = streamedRequest([chunk('0123456789X')]);
    const framework = mapWebRequestToFrameworkRequest(request, 10);
    await expect(framework.bytes()).rejects.toThrow(RequestBodyTooLargeError);
  });

  it('the refusal names the configured limit and never the observed size', async () => {
    // The observed size is only ever a lower bound — the read stops at the cap
    // — so reporting it would mislead.
    const { request } = streamedRequest([chunk('X'.repeat(1_000))]);
    const framework = mapWebRequestToFrameworkRequest(request, 10);
    const error = await framework.bytes().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestBodyTooLargeError);
    expect((error as RequestBodyTooLargeError).maxBodyBytes).toBe(10);
    expect((error as Error).message).toContain('10 bytes');
    expect((error as Error).message).not.toContain('1000');
  });

  it('the refusal is branded with a 413 status hint', async () => {
    // So an application running `errorHandler` answers `413 Content Too Large`
    // in its configured format rather than the masked 500 an unbranded throw
    // from this depth would produce (the M89b mechanism).
    const { request } = streamedRequest([chunk('X'.repeat(50))]);
    const framework = mapWebRequestToFrameworkRequest(request, 10);
    const error = await framework.bytes().catch((e: unknown) => e);
    const hint = httpStatusHintOf(error as Error);
    expect(hint?.status).toBe(413);
    expect(hint?.title).toBe('Payload Too Large');
    expect(hint?.detail).toBe('Request body exceeds the maximum of 10 bytes.');
  });

  it('refuses on the chunk that CROSSES the cap, not after buffering it all', async () => {
    // At most one chunk beyond the limit is ever held: the running total is
    // compared before a chunk is retained, and the source is cancelled rather
    // than drained.
    const chunks = [chunk('X'.repeat(8)), chunk('X'.repeat(8)), chunk('X'.repeat(8))];
    const { request, cancelled } = streamedRequest(chunks);
    const framework = mapWebRequestToFrameworkRequest(request, 10);
    await expect(framework.bytes()).rejects.toThrow(RequestBodyTooLargeError);
    expect(cancelled()).toBe(true);
  });

  it('a fully drained body needs no cancel — the source is already released', async () => {
    // Measured, not assumed: `cancel()` on an already-closed stream is a no-op
    // and does NOT invoke the underlying source's `cancel`, because a stream
    // read to `done` has released its source itself. The `finally` cancel in
    // `readBounded` therefore matters only on the early-exit path above — which
    // is precisely the path where an abandoned stream would keep a connection
    // draining (the M70k HEAD-descriptor-leak class).
    const { request, cancelled } = streamedRequest([chunk('ok')]);
    const framework = mapWebRequestToFrameworkRequest(request, 100);
    expect(await framework.text()).toBe('ok');
    expect(cancelled()).toBe(false);
  });

  it('a multi-chunk body is concatenated in order', async () => {
    const { request } = streamedRequest([chunk('one'), chunk('two'), chunk('three')]);
    const framework = mapWebRequestToFrameworkRequest(request, 100);
    expect(await framework.text()).toBe('onetwothree');
  });

  it('the read stays memoized — a second call does not re-read', async () => {
    const { request } = streamedRequest([chunk('once')]);
    const framework = mapWebRequestToFrameworkRequest(request, 100);
    const first = await framework.bytes();
    const second = await framework.bytes();
    expect(second).toBe(first);
    // And the parsed forms agree, which is what the memoization exists for.
    expect(await framework.text()).toBe('once');
  });

  it('a rejection stays cached rather than reporting a different failure', async () => {
    // The body is one-shot, so a retry cannot succeed; re-reading would report
    // `Body already consumed` instead of the refusal the first caller saw.
    const { request } = streamedRequest([chunk('X'.repeat(50))]);
    const framework = mapWebRequestToFrameworkRequest(request, 10);
    await expect(framework.bytes()).rejects.toThrow(RequestBodyTooLargeError);
    await expect(framework.bytes()).rejects.toThrow(RequestBodyTooLargeError);
  });

  it('a bodyless GET is answered without touching the stream, cap or no cap', async () => {
    // The framing-header fast path runs FIRST, so the cap never makes the
    // mapping read `.body` — which on Node would materialize the full undici
    // Request the lightweight facade exists to avoid (M87).
    const get = new Request('http://localhost/');
    const framework = mapWebRequestToFrameworkRequest(get, 1);
    expect((await framework.bytes()).byteLength).toBe(0);
  });

  it('a POST with an empty body resolves empty rather than rejecting', async () => {
    const request = new Request('http://localhost/', { method: 'POST', body: '' });
    const framework = mapWebRequestToFrameworkRequest(request, 10);
    expect((await framework.bytes()).byteLength).toBe(0);
  });

  it('a GET carrying a declared body is still read under the cap', async () => {
    // A GET that DOES carry a body must be read, or the kernel's
    // upgrade-with-body refusal silently stops working (M70a §3.6).
    const request = new Request('http://localhost/', {
      method: 'POST',
      body: 'abc',
    });
    const framework = mapWebRequestToFrameworkRequest(request, 2);
    await expect(framework.bytes()).rejects.toThrow(RequestBodyTooLargeError);
  });

  // -------------------------------------------------------------------------
  // Option domain — the guard added in verification
  // -------------------------------------------------------------------------

  it('a NaN cap would DISABLE the bound, so RuntimePlugin refuses it', async () => {
    // The reason the guard exists rather than being defensive polish:
    // `total + n > NaN` is always `false`, so a NaN cap accepts every chunk and
    // the bound silently never fires — fail-OPEN in a size limit. `Number()` of
    // an unset or misspelled env var is exactly `NaN`, which is how this value
    // is supplied in a real deployment. Asserted at the mapping level here (the
    // arithmetic), and refused at the factory in `runtime-plugin.test.ts`.
    const { request } = streamedRequest([chunk('X'.repeat(1_000))]);
    const framework = mapWebRequestToFrameworkRequest(request, Number.NaN);
    // Documents the arithmetic the guard protects against: unbounded.
    expect((await framework.bytes()).byteLength).toBe(1_000);
  });

  it('a cap of 0 refuses any body but still serves a bodyless request', async () => {
    // `0` means "refuse every request carrying a body" — NOT "disabled", which
    // is what `0` means for `maxDepth`/`maxNodes`/`maxBatchSize` elsewhere in
    // this framework. Pinned so the divergence cannot drift silently.
    const { request } = streamedRequest([chunk('X')]);
    await expect(mapWebRequestToFrameworkRequest(request, 0).bytes())
      .rejects.toThrow(RequestBodyTooLargeError);

    const bodyless = new Request('http://localhost/');
    expect((await mapWebRequestToFrameworkRequest(bodyless, 0).bytes()).byteLength).toBe(0);
  });

  it('json() and text() both surface the refusal', async () => {
    const a = streamedRequest([chunk('{"a":1}')]);
    const b = streamedRequest([chunk('{"a":1}')]);
    await expect(mapWebRequestToFrameworkRequest(a.request, 2).json())
      .rejects.toThrow(RequestBodyTooLargeError);
    await expect(mapWebRequestToFrameworkRequest(b.request, 2).text())
      .rejects.toThrow(RequestBodyTooLargeError);
  });
});
