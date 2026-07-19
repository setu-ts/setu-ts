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
