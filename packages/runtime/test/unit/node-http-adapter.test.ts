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
import { UPGRADE_INTENT } from '@setu-ts/common';
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
    // `| undefined` explicitly, so an ABSENT option is recordable and can be
    // asserted apart from an explicit `false` (M87).
    overrideGlobalObjects?: boolean | undefined;
  };
} {
  const recorded: {
    fetch?: (r: Request) => Response | Promise<Response>;
    port?: number;
    hostname?: string;
    // `| undefined` explicitly, so an ABSENT option is recordable and can be
    // asserted apart from an explicit `false` (M87).
    overrideGlobalObjects?: boolean | undefined;
  } = {};

  const host: NodeServeHost = {
    serve: async (options) => {
      // Await Promise.resolve to satisfy deno lint require-await rule
      await Promise.resolve();
      recorded.fetch = options.fetch;
      recorded.port = options.port;
      if (options.hostname !== undefined) {
        recorded.hostname = options.hostname;
      }
      // Record the RAW value. Defaulting it here would erase the only
      // distinction that matters — "explicitly false" versus "not passed, so
      // node-server applies its own default" (M87).
      recorded.overrideGlobalObjects = options.overrideGlobalObjects;

      return {
        close() {},
      } as NodeServer;
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
        snapshot: () => ({
          streaming: false,
          status: 200,
          headers: new Headers({ 'x-test': 'ok' }),
          body: 'hello',
        }),
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
  it('calls host.serve with fetch/port/hostname and does NOT pass overrideGlobalObjects', async () => {
    const { host, recorded } = createFakeHost();
    const adapter = new NodeHttpAdapter(host);

    // deno-lint-ignore require-await
    adapter.setHandler(async (_request) => {
      return {
        snapshot: () => ({ streaming: false, status: 200, headers: new Headers(), body: null }),
      } as any;
    });

    const handle = await adapter.listen(8080, 'localhost');

    expect(recorded.fetch).toBeDefined();
    expect(recorded.port).toBe(8080);
    expect(recorded.hostname).toBe('localhost');
    // NOT passed, so node-server installs its own `Request`/`Response` as
    // globals. That is load-bearing rather than incidental: its synchronous
    // response path is gated on the response carrying that class's internal
    // cache symbol, so passing `false` here — as this adapter did until M87 —
    // puts every response on the slow path. Asserting `undefined` rather than
    // a value is the point: the previous form of this test recorded
    // `options.overrideGlobalObjects ?? false` and so could not tell an
    // explicit `false` from an absent option, and passed either way.
    expect(recorded.overrideGlobalObjects).toBeUndefined();
    expect(isNodeHttpServerHandle(handle)).toBe(true);
  });

  it('without hostname omits it', async () => {
    const { host, recorded } = createFakeHost();
    const adapter = new NodeHttpAdapter(host);

    // deno-lint-ignore require-await
    adapter.setHandler(async (_request) => {
      return {
        snapshot: () => ({ streaming: false, status: 200, headers: new Headers(), body: null }),
      } as any;
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
      return {
        snapshot: () => ({ streaming: false, status: 200, headers: new Headers(), body: null }),
      } as any;
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
      return {
        snapshot: () => ({ streaming: false, status: 200, headers: new Headers(), body: null }),
      } as any;
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
      return {
        snapshot: () => ({ streaming: false, status: 200, headers: new Headers(), body: null }),
      } as any;
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

// ---------------------------------------------------------------------------
// performUpgrade (fetch path) returns 501
// ---------------------------------------------------------------------------

describe('node-http-adapter | performUpgrade via fetch path', () => {
  it('returns 501 when upgrade intent reaches fetch handler', async () => {
    const { host } = createFakeHost();
    const adapter = new NodeHttpAdapter(host);

    // Track whether onClose was called on the sink.
    let onCloseCalled = false;
    let onCloseReason = '';

    // deno-lint-ignore require-await
    adapter.setHandler(async (request) => {
      // Write upgrade intent on the request (simulating kernel terminal handler).
      (request as unknown as Record<symbol, any>)[UPGRADE_INTENT] = {
        sink: {
          onClose(info: { code: number; reason: string }) {
            onCloseCalled = true;
            onCloseReason = info.reason;
          },
        },
      };
      return {
        snapshot: () => ({ streaming: false, status: 200, headers: new Headers(), body: null }),
      } as any;
    });

    const response = await adapter.fetch(new Request('https://example.com/'));

    // #performUpgrade returns 501 and calls sink.onClose.
    expect(response.status).toBe(501);
    expect(onCloseCalled).toBe(true);
    expect(onCloseReason).toBe('Upgrade unsupported on fetch path');
  });
});
