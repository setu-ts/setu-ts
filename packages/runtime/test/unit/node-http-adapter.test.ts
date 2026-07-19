// deno-lint-ignore-file no-explicit-any
/**
 * Unit tests for NodeHttpAdapter — uses a fake NodeServeHost.
 *
 * @module
 */

import type { NodeServeHost, NodeServer } from '../../src/adapters/node/node-http-adapter.ts';
import {
  isNodeHttpServerHandle,
  NodeHttpAdapter,
  NodeHttpServerHandle,
} from '../../src/adapters/node/node-http-adapter.ts';
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

// ---------------------------------------------------------------------------
// Fake host
// ---------------------------------------------------------------------------

function createFakeHost(): {
  host: NodeServeHost;
  recorded: {
    fetch?: (r: Request) => Response | Promise<Response>;
    port?: number;
    hostname?: string;
    overrideGlobalObjects?: boolean;
  };
} {
  const recorded: {
    fetch?: (r: Request) => Response | Promise<Response>;
    port?: number;
    hostname?: string;
    overrideGlobalObjects?: boolean;
  } = {};

  const host: NodeServeHost = {
    serve: (options) => {
      recorded.fetch = options.fetch;
      recorded.port = options.port;
      if (options.hostname !== undefined) {
        recorded.hostname = options.hostname;
      }
      recorded.overrideGlobalObjects = options.overrideGlobalObjects ?? false;

      return {
        close() {},
      } as unknown as NodeServer;
    },
  };

  return { host, recorded };
}

// ---------------------------------------------------------------------------
// setHandler / fetch round-trip
// ---------------------------------------------------------------------------

describe('node-http-adapter | setHandler/fetch', () => {
  it('stores handler; fetch round-trips', async () => {
    const { host } = createFakeHost();

    // Simpler: directly test fetch with a handler that returns a known response
    const adapter = new NodeHttpAdapter(host);
    // deno-lint-ignore require-await
    adapter.setHandler(async (_request) => {
      return {
        snapshot: () => ({ status: 200, headers: new Headers({ 'x-test': 'ok' }), body: 'hello' }),
      } as any;
    });

    const response = await adapter.fetch(new Request('https://example.com/'));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-test')).toBe('ok');
  });

  it('fetch without setHandler returns 500', async () => {
    const { host } = createFakeHost();
    const adapter = new NodeHttpAdapter(host);

    const response = await adapter.fetch(new Request('https://example.com/'));
    expect(response.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// listen calls host.serve with correct options
// ---------------------------------------------------------------------------

describe('node-http-adapter | listen', () => {
  it('calls host.serve with fetch/port/hostname and overrideGlobalObjects:false', async () => {
    const { host, recorded } = createFakeHost();
    const adapter = new NodeHttpAdapter(host);

    // deno-lint-ignore require-await
    adapter.setHandler(async (_request) => {
      return { snapshot: () => ({ status: 200, headers: new Headers(), body: null }) } as any;
    });

    const handle = await adapter.listen(8080, 'localhost');

    expect(recorded.fetch).toBeDefined();
    expect(recorded.port).toBe(8080);
    expect(recorded.hostname).toBe('localhost');
    expect(recorded.overrideGlobalObjects).toBe(false);
    expect(isNodeHttpServerHandle(handle)).toBe(true);
  });

  it('without hostname omits it', async () => {
    const { host, recorded } = createFakeHost();
    const adapter = new NodeHttpAdapter(host);

    // deno-lint-ignore require-await
    adapter.setHandler(async (_request) => {
      return { snapshot: () => ({ status: 200, headers: new Headers(), body: null }) } as any;
    });

    await adapter.listen(8080);

    expect(recorded.hostname).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// close calls server.close
// ---------------------------------------------------------------------------

describe('node-http-adapter | close', () => {
  it('calls server.close on valid handle', async () => {
    let closeCalled = false;
    const { host } = createFakeHost();

    const adapter = new NodeHttpAdapter(host);
    // deno-lint-ignore require-await
    adapter.setHandler(async (_request) => {
      return { snapshot: () => ({ status: 200, headers: new Headers(), body: null }) } as any;
    });

    const handle = await adapter.listen(8080);

    // Override the server to track close
    (handle as NodeHttpServerHandle).server = {
      close() {
        closeCalled = true;
      },
    } as unknown as NodeServer;

    await adapter.close(handle);
    expect(closeCalled).toBe(true);
  });

  it('close with null server is a no-op', async () => {
    const { host } = createFakeHost();
    const adapter = new NodeHttpAdapter(host);
    // deno-lint-ignore require-await
    adapter.setHandler(async (_request) => {
      return { snapshot: () => ({ status: 200, headers: new Headers(), body: null }) } as any;
    });

    const handle = await adapter.listen(8080);
    (handle as NodeHttpServerHandle).server = null;

    // Should not throw
    await adapter.close(handle);
  });
});

// ---------------------------------------------------------------------------
// close throws on invalid handle type
// ---------------------------------------------------------------------------

describe('node-http-adapter | close with invalid handle', () => {
  it('throws when handle is not a NodeHttpServerHandle', () => {
    const { host } = createFakeHost();
    const adapter = new NodeHttpAdapter(host);

    // deno-lint-ignore require-await
    adapter.setHandler(async (_request) => {
      return { snapshot: () => ({ status: 200, headers: new Headers(), body: null }) } as any;
    });

    expect(() => adapter.close({} as any)).toThrow('Invalid server handle for NodeHttpAdapter');
  });
});

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

describe('node-http-adapter | isNodeHttpServerHandle', () => {
  it('accepts valid handles', () => {
    expect(isNodeHttpServerHandle(new NodeHttpServerHandle())).toBe(true);
  });

  it('rejects invalid handles', () => {
    expect(isNodeHttpServerHandle({} as any)).toBe(false);
    expect(isNodeHttpServerHandle(null as any)).toBe(false);
  });
});
