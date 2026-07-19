// deno-lint-ignore-file no-explicit-any
/**
 * Unit tests for BunHttpAdapter — uses a fake BunServeHost.
 *
 * @module
 */

import type { BunServeHost, BunServer } from '../../src/adapters/bun/bun-http-adapter.ts';
import {
  BunHttpAdapter,
  BunHttpServerHandle,
  isBunHttpServerHandle,
} from '../../src/adapters/bun/bun-http-adapter.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

// ---------------------------------------------------------------------------
// Fake host
// ---------------------------------------------------------------------------

function createFakeHost(): {
  host: BunServeHost;
  recorded: {
    port?: number;
    hostname?: string;
    fetch?: (r: Request) => Response | Promise<Response>;
  };
} {
  const recorded: {
    port?: number;
    hostname?: string;
    fetch?: (r: Request) => Response | Promise<Response>;
  } = {};

  const host: BunServeHost = {
    serve: (options) => {
      recorded.port = options.port;
      if (options.hostname !== undefined) {
        recorded.hostname = options.hostname;
      }
      recorded.fetch = options.fetch;

      return {
        stop() {},
      } as unknown as BunServer;
    },
  };

  return { host, recorded };
}

// ---------------------------------------------------------------------------
// setHandler / fetch round-trip
// ---------------------------------------------------------------------------

describe('bun-http-adapter | setHandler/fetch', () => {
  it('stores handler; fetch round-trips', async () => {
    const { host } = createFakeHost();
    const adapter = new BunHttpAdapter(host);

    // deno-lint-ignore require-await
    adapter.setHandler(async (_request) => {
      return {
        snapshot: () => ({ status: 200, headers: new Headers({ 'x-bun': 'ok' }), body: 'bun' }),
      } as any;
    });

    const response = await adapter.fetch(new Request('https://example.com/'));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-bun')).toBe('ok');
  });

  it('fetch without setHandler returns 500', async () => {
    const { host } = createFakeHost();
    const adapter = new BunHttpAdapter(host);

    const response = await adapter.fetch(new Request('https://example.com/'));
    expect(response.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// listen calls host.serve with correct options
// ---------------------------------------------------------------------------

describe('bun-http-adapter | listen', () => {
  it('calls host.serve with port/hostname/fetch', async () => {
    const { host, recorded } = createFakeHost();
    const adapter = new BunHttpAdapter(host);

    // deno-lint-ignore require-await
    adapter.setHandler(async (_request) => {
      return { snapshot: () => ({ status: 200, headers: new Headers(), body: null }) } as any;
    });

    const handle = await adapter.listen(9000, '127.0.0.1');

    expect(recorded.fetch).toBeDefined();
    expect(recorded.port).toBe(9000);
    expect(recorded.hostname).toBe('127.0.0.1');
    expect(isBunHttpServerHandle(handle)).toBe(true);
  });

  it('without hostname omits it', async () => {
    const { host, recorded } = createFakeHost();
    const adapter = new BunHttpAdapter(host);

    // deno-lint-ignore require-await
    adapter.setHandler(async (_request) => {
      return { snapshot: () => ({ status: 200, headers: new Headers(), body: null }) } as any;
    });

    await adapter.listen(9000);

    expect(recorded.hostname).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// close calls server.stop
// ---------------------------------------------------------------------------

describe('bun-http-adapter | close', () => {
  it('calls server.stop on valid handle', async () => {
    let stopCalled = false;
    const { host } = createFakeHost();
    const adapter = new BunHttpAdapter(host);

    // deno-lint-ignore require-await
    adapter.setHandler(async (_request) => {
      return { snapshot: () => ({ status: 200, headers: new Headers(), body: null }) } as any;
    });

    const handle = await adapter.listen(9000);

    (handle as BunHttpServerHandle).server = {
      stop() {
        stopCalled = true;
      },
    } as unknown as BunServer;

    await adapter.close(handle);
    expect(stopCalled).toBe(true);
  });

  it('close with null server is a no-op', async () => {
    const { host } = createFakeHost();
    const adapter = new BunHttpAdapter(host);

    // deno-lint-ignore require-await
    adapter.setHandler(async (_request) => {
      return { snapshot: () => ({ status: 200, headers: new Headers(), body: null }) } as any;
    });

    const handle = await adapter.listen(9000);
    (handle as BunHttpServerHandle).server = null;

    await adapter.close(handle);
  });
});

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

describe('bun-http-adapter | isBunHttpServerHandle', () => {
  it('accepts valid handles', () => {
    expect(isBunHttpServerHandle(new BunHttpServerHandle())).toBe(true);
  });

  it('rejects invalid handles', () => {
    expect(isBunHttpServerHandle({} as any)).toBe(false);
  });
});
