// deno-lint-ignore-file no-explicit-any
/**
 * Unit tests for DenoHttpAdapter — uses a fake DenoServeHost.
 *
 * @module
 */

import type { DenoServeHost, DenoServer } from '../../src/adapters/deno/deno-http-adapter.ts';
import {
  DenoHttpAdapter,
  DenoHttpServerHandle,
  isDenoHttpServerHandle,
} from '../../src/adapters/deno/deno-http-adapter.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

// ---------------------------------------------------------------------------
// Fake host
// ---------------------------------------------------------------------------

function createFakeHost(): {
  host: DenoServeHost;
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

  const host: DenoServeHost = {
    serve: (options) => {
      recorded.port = options.port;
      if (options.hostname !== undefined) {
        recorded.hostname = options.hostname;
      }
      recorded.fetch = options.fetch;

      return {
        shutdown: async () => {},
      } as unknown as DenoServer;
    },
  };

  return { host, recorded };
}

// ---------------------------------------------------------------------------
// setHandler / fetch round-trip
// ---------------------------------------------------------------------------

describe('deno-http-adapter | setHandler/fetch', () => {
  it('stores handler; fetch round-trips', async () => {
    const { host } = createFakeHost();
    const adapter = new DenoHttpAdapter(host);

    // deno-lint-ignore require-await
    adapter.setHandler(async (_request) => {
      return {
        snapshot: () => ({ status: 200, headers: new Headers({ 'x-den': 'ok' }), body: 'deno' }),
      } as any;
    });

    const response = await adapter.fetch(new Request('https://example.com/'));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-den')).toBe('ok');
  });

  it('fetch without setHandler returns 500', async () => {
    const { host } = createFakeHost();
    const adapter = new DenoHttpAdapter(host);

    const response = await adapter.fetch(new Request('https://example.com/'));
    expect(response.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// listen calls host.serve with correct options
// ---------------------------------------------------------------------------

describe('deno-http-adapter | listen', () => {
  it('calls host.serve with port/hostname/fetch', async () => {
    const { host, recorded } = createFakeHost();
    const adapter = new DenoHttpAdapter(host);

    // deno-lint-ignore require-await
    adapter.setHandler(async (_request) => {
      return { snapshot: () => ({ status: 200, headers: new Headers(), body: null }) } as any;
    });

    const handle = await adapter.listen(3000, '0.0.0.0');

    expect(recorded.fetch).toBeDefined();
    expect(recorded.port).toBe(3000);
    expect(recorded.hostname).toBe('0.0.0.0');
    expect(isDenoHttpServerHandle(handle)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// close calls server.shutdown
// ---------------------------------------------------------------------------

describe('deno-http-adapter | close', () => {
  it('calls server.shutdown on valid handle', async () => {
    let shutdownCalled = false;
    const { host } = createFakeHost();
    const adapter = new DenoHttpAdapter(host);

    // deno-lint-ignore require-await
    adapter.setHandler(async (_request) => {
      return { snapshot: () => ({ status: 200, headers: new Headers(), body: null }) } as any;
    });

    const handle = await adapter.listen(3000);

    (handle as DenoHttpServerHandle).server = {
      // deno-lint-ignore require-await
      shutdown: async () => {
        shutdownCalled = true;
      },
    } as unknown as DenoServer;

    await adapter.close(handle);
    expect(shutdownCalled).toBe(true);
  });

  it('close with null server is a no-op', async () => {
    const { host } = createFakeHost();
    const adapter = new DenoHttpAdapter(host);

    // deno-lint-ignore require-await
    adapter.setHandler(async (_request) => {
      return { snapshot: () => ({ status: 200, headers: new Headers(), body: null }) } as any;
    });

    const handle = await adapter.listen(3000);
    (handle as DenoHttpServerHandle).server = null;

    await adapter.close(handle);
  });
});

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

describe('deno-http-adapter | isDenoHttpServerHandle', () => {
  it('accepts valid handles', () => {
    expect(isDenoHttpServerHandle(new DenoHttpServerHandle())).toBe(true);
  });

  it('rejects invalid handles', () => {
    expect(isDenoHttpServerHandle({} as any)).toBe(false);
  });
});
