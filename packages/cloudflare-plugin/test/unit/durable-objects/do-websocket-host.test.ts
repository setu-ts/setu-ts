/**
 * The `WebSocketPair` seam.
 *
 * The default factory reads a Workers-only global, so these tests install and
 * restore a fake one. That is what covers the default path — the path every
 * real deployment takes — instead of leaving it behind a skipped test.
 */

import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  createDefaultDurableObjectWebSocketHost,
} from '../../../src/durable-objects/do-websocket-host.ts';

/** The global under test, absent on Deno. */
interface PairGlobal {
  WebSocketPair?: unknown;
}

const globals = globalThis as PairGlobal;

afterEach(() => {
  delete globals.WebSocketPair;
});

describe('createDefaultDurableObjectWebSocketHost', () => {
  it('does not throw at import or construction time, only when a pair is needed', () => {
    // Importing this module on Deno must be harmless; the cast is deferred.
    const host = createDefaultDurableObjectWebSocketHost();
    expect(typeof host.createPair).toBe('function');
  });

  it('throws naming the runtime when WebSocketPair is absent', () => {
    const host = createDefaultDurableObjectWebSocketHost();
    expect(() => host.createPair()).toThrow(/WebSocketPair is not available/);
    expect(() => host.createPair()).toThrow(/Cloudflare Workers runtime/);
  });

  it('returns the client and server halves from the global', () => {
    const client = { id: 'client' };
    const server = { id: 'server' };
    globals.WebSocketPair = class {
      0 = client;
      1 = server;
    };

    const pair = createDefaultDurableObjectWebSocketHost().createPair();

    expect(pair.client).toBe(client);
    expect(pair.server).toBe(server);
  });

  it('throws when the global yields an incomplete pair', () => {
    globals.WebSocketPair = class {
      0 = { id: 'client' };
    };

    expect(() => createDefaultDurableObjectWebSocketHost().createPair()).toThrow(
      /did not produce a client\/server pair/,
    );
  });
});
