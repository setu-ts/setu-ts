// deno-lint-ignore-file no-explicit-any
/**
 * Unit tests for CloudflareWorkersHttpAdapter.
 *
 * @module
 */

import { CloudflareWorkersHttpAdapter } from '../../src/adapters/workers/cf-http-adapter.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

// ---------------------------------------------------------------------------
// setHandler / fetch round-trip
// ---------------------------------------------------------------------------

describe('cf-http-adapter | setHandler/fetch', () => {
  it('stores handler; fetch round-trips', async () => {
    const adapter = new CloudflareWorkersHttpAdapter();

    // deno-lint-ignore require-await
    adapter.setHandler(async (_request) => {
      return {
        snapshot: () => ({
          status: 200,
          headers: new Headers({ 'x-cf': 'ok' }),
          body: 'cf-workers',
        }),
      } as any;
    });

    const response = await adapter.fetch(new Request('https://example.com/'));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-cf')).toBe('ok');
  });

  it('returns the response WITHOUT a promise when the handler is synchronous (M87)', () => {
    // The whole point of the M87 widening: a handler that answers without
    // yielding must not be wrapped back into a promise, or the runtime's own
    // synchronous response path is foreclosed. Asserting the ABSENCE of a
    // promise is the only assertion that can see this — `await` passes either
    // way, which is why the async arm below could not cover it.
    const adapter = new CloudflareWorkersHttpAdapter();

    adapter.setHandler((_request) =>
      ({
        snapshot: () => ({
          status: 201,
          headers: new Headers({ 'x-sync': 'yes' }),
          body: 'sync',
        }),
      }) as any
    );

    const response = adapter.fetch(new Request('https://example.com/'));
    expect(response).not.toBeInstanceOf(Promise);
    const settled = response as Response;
    expect(settled.status).toBe(201);
    expect(settled.headers.get('x-sync')).toBe('yes');
  });

  it('still returns a promise when the handler is asynchronous', async () => {
    const adapter = new CloudflareWorkersHttpAdapter();

    // deno-lint-ignore require-await
    adapter.setHandler(async (_request) =>
      ({
        snapshot: () => ({ status: 202, headers: new Headers(), body: 'async' }),
      }) as any
    );

    const response = adapter.fetch(new Request('https://example.com/'));
    expect(response).toBeInstanceOf(Promise);
    expect((await response).status).toBe(202);
  });

  it('fetch without setHandler returns 500', async () => {
    const adapter = new CloudflareWorkersHttpAdapter();

    const response = await adapter.fetch(new Request('https://example.com/'));
    expect(response.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// listen throws
// ---------------------------------------------------------------------------

describe('cf-http-adapter | listen', () => {
  it('throws with CF Workers message', () => {
    const adapter = new CloudflareWorkersHttpAdapter();
    expect(() => adapter.listen(8080)).toThrow(
      'Cloudflare Workers has no listen(port) model',
    );
  });
});

// ---------------------------------------------------------------------------
// close is no-op
// ---------------------------------------------------------------------------

describe('cf-http-adapter | close', () => {
  it('is a no-op', async () => {
    const adapter = new CloudflareWorkersHttpAdapter();
    await adapter.close({} as any);
    // No assertion needed — just confirming it doesn't throw
  });
});
