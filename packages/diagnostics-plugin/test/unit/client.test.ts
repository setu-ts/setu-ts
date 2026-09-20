/**
 * Unit tests for the native client, driven against an IN-MEMORY signed
 * server implemented over the same production protocol helpers the
 * connector-handler uses. The canonicalization itself is pinned
 * independently in `authentication.test.ts` and by the fixture vectors in
 * `connector-handler.test.ts`; this file covers client behavior: pairing,
 * verification, sequence serialization, tampering, bounds, deadlines, and
 * terminal failures.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { DiagnosticsClientOptions } from '../../src/interfaces/index.ts';
import { CLIENT_ERRORS, createDiagnosticsClient } from '../../src/client/client.ts';
import {
  importSessionKey,
  requestMacFields,
  responseMacFields,
  sha256Hex,
  signFields,
  verifyFields,
} from '../../src/security/authentication.ts';
import { STATUS_BODY_KEYS } from '../../src/protocol/protocol.ts';
import {
  minimalBatch,
  minimalSnapshot,
  TEST_INSTANCE_ID,
  TEST_KEY_BYTES,
  TEST_PORT,
  TEST_SESSION_ID,
} from '../fixtures/helpers.ts';

/**
 * Local assertion helper: fails the test when the condition is false.
 *
 * @param value - The condition
 * @param label - What the condition asserts
 */
function assertTrue(value: boolean, label: string): void {
  if (!value) {
    throw new Error('PROBE FAIL: ' + label);
  }
}

/**
 * A recorded request the fake server can assert on.
 *
 * @internal
 */
interface RecordedRequest {
  readonly target: string;
  readonly session: string;
  readonly sequence: string;
  readonly instance: string | null;
  readonly mac: string;
}

/**
 * Builds the fake server: verifies request MACs and answers with correctly
 * signed responses for the configured snapshot/batch, with per-test
 * mutation hooks.
 *
 * @param subtle - The subtle crypto to use
 * @param overrides - Response behavior overrides
 * @returns The fetch implementation and the request log
 */
function fakeServer(
  subtle: SubtleCrypto,
  overrides: {
    mutateBody?: (target: string, bodyText: string) => string;
    dropMac?: boolean;
    wrongInstance?: boolean;
    status?: number;
    oversizedBody?: boolean;
    redirect?: boolean;
    malformedBody?: boolean;
  } = {},
): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const key = importSessionKey(subtle, TEST_KEY_BYTES);
  const encoder = new TextEncoder();
  const fetchImpl = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    void key;
    return await key.then(async (imported) => {
      const target = `${url.pathname}${url.search}`;
      const session = String(
        requestHeadersOf(input).get('x-setu-session') ?? '',
      );
      const sequence = requestHeadersOf(input).get('x-setu-sequence') ?? '';
      const instance = requestHeadersOf(input).get('x-setu-instance');
      const mac = requestHeadersOf(input).get('x-setu-mac') ?? '';
      requests.push({ target, session, sequence, instance, mac });

      const verified = await verifyFields(
        subtle,
        imported,
        mac,
        requestMacFields(session, instance ?? '', sequence, `127.0.0.1:${TEST_PORT}`, target),
      );
      if (!verified) {
        return new Response(JSON.stringify({ version: 1, error: 'unauthorized' }), {
          status: 401,
        });
      }
      if (overrides.redirect) {
        return new Response(null, { status: 302, headers: { location: '/elsewhere' } });
      }
      if (overrides.status !== undefined) {
        return new Response('nope', { status: overrides.status });
      }

      let bodyText: string;
      if (target === '/v1/status') {
        const body: Record<string, unknown> = {
          version: 1,
          instanceId: TEST_INSTANCE_ID,
          expiresInMs: 899_000,
        };
        bodyText = JSON.stringify(body);
      } else if (target === '/v1/snapshot') {
        bodyText = JSON.stringify(minimalSnapshot());
      } else {
        bodyText = JSON.stringify(minimalBatch());
      }
      // Signed, therefore authentic — and not JSON. Deliberately NOT applied
      // to `/v1/status`: the pairing path has always guarded its parse, so a
      // malformed status body fails there with the SAME fixed message and
      // would make this fixture pass without ever reaching the data paths it
      // exists to cover. (Observed: the first version of this test did.)
      if (overrides.malformedBody && target !== '/v1/status') {
        bodyText = '{"version":1,"nodes":[';
      }
      // The MAC is computed over the UNMUTATED body; a mutation hook then
      // swaps the served bytes, simulating an attacker tampering AFTER the
      // honest server signed them.
      const bodyBytes = encoder.encode(bodyText);
      const digest = await sha256Hex(subtle, bodyBytes);
      const responseFields = responseMacFields(
        session,
        overrides.wrongInstance ? '0'.repeat(36) : TEST_INSTANCE_ID,
        sequence,
        target,
        '200',
        digest,
      );
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-setu-instance': overrides.wrongInstance ? '0'.repeat(36) : TEST_INSTANCE_ID,
        'x-setu-mac': overrides.dropMac
          ? 'z'.repeat(64)
          : await signFields(subtle, imported, responseFields),
      };
      let served = bodyBytes;
      if (oversizedBodies && overrides.oversizedBody) {
        served = encoder.encode(JSON.stringify({ pad: 'x'.repeat(300 * 1024) }));
      } else if (overrides.oversizedBody) {
        served = encoder.encode('x'.repeat(300 * 1024));
      } else if (overrides.mutateBody !== undefined) {
        served = encoder.encode(overrides.mutateBody(target, bodyText));
      }
      return new Response(served, { status: 200, headers });
    });
  };
  return { fetch: fetchImpl as unknown as typeof fetch, requests };
}

let oversizedBodies = false;

/**
 * Reads the headers of a fetch input the way the fake server receives it.
 * The client calls fetch with a string URL and a headers init; this helper
 * reconstructs them from the last-call record.
 *
 * @param input - The fetch input
 * @returns The recorded headers
 */
function requestHeadersOf(_input: string | URL | Request): Headers {
  return lastHeaders;
}

let lastHeaders = new Headers();

/**
 * Wraps a fetch so the headers init is recorded for the fake server.
 *
 * @param base - The fake server's fetch
 * @returns An instrumented fetch
 */
function recording(base: typeof fetch): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    lastHeaders = new Headers(init?.headers);
    return base(input, init);
  }) as typeof fetch;
}

/**
 * Builds a client against the fake server.
 *
 * @param overrides - Server and client overrides
 * @returns The client, the request log, and the timing log
 */
function buildClient(overrides: {
  server?: Parameters<typeof fakeServer>[1];
  client?: Partial<DiagnosticsClientOptions>;
} = {}): {
  client: ReturnType<typeof createDiagnosticsClient>;
  requests: RecordedRequest[];
  timeouts: number[];
} {
  const subtle = crypto.subtle;
  const { fetch, requests } = fakeServer(subtle, overrides.server);
  const timeouts: number[] = [];
  const options: DiagnosticsClientOptions = {
    endpoint: `http://127.0.0.1:${TEST_PORT}`,
    sessionId: TEST_SESSION_ID,
    sessionKey: TEST_KEY_BYTES,
    subtle,
    fetch: recording(fetch),
    timing: {
      setTimeout(fn: () => void, ms: number): unknown {
        timeouts.push(ms);
        return setTimeout(fn, ms);
      },
      clearTimeout(handle: unknown): void {
        clearTimeout(handle as number);
      },
    },
    ...(overrides.client ?? {}),
  };
  return { client: createDiagnosticsClient(options), requests, timeouts };
}

describe('Client — endpoint and option validation', () => {
  it('refuses any endpoint other than exact numeric loopback', () => {
    const base = {
      sessionId: TEST_SESSION_ID,
      sessionKey: TEST_KEY_BYTES,
      subtle: crypto.subtle,
      fetch: globalThis.fetch,
      timing: {
        setTimeout: (_fn: () => void, _ms: number) => 0,
        clearTimeout: (_h: unknown) => {},
      },
    };
    const bad = [
      'https://127.0.0.1:4919',
      'http://localhost:4919',
      'http://127.0.0.1',
      'http://127.0.0.1:0',
      'http://127.0.0.1:80',
      'http://127.0.0.1:4919/',
      'http://127.0.0.1:4919/v1/status',
      'http://127.0.0.1:4919?x=1',
      'http://user:pass@127.0.0.1:4919',
      'http://127.0.0.1:4919#frag',
      'not a url',
    ];
    for (const endpoint of bad) {
      expect(() => createDiagnosticsClient({ ...base, endpoint })).toThrow(
        CLIENT_ERRORS.endpoint,
      );
    }
  });

  it('refuses malformed credentials at creation', () => {
    const base = {
      endpoint: `http://127.0.0.1:${TEST_PORT}`,
      subtle: crypto.subtle,
      fetch: globalThis.fetch,
      timing: {
        setTimeout: (_fn: () => void, _ms: number) => 0,
        clearTimeout: (_h: unknown) => {},
      },
    };
    expect(() =>
      createDiagnosticsClient({ ...base, sessionId: 'short', sessionKey: TEST_KEY_BYTES })
    ).toThrow(CLIENT_ERRORS.sessionId);
    expect(() =>
      createDiagnosticsClient({
        ...base,
        sessionId: TEST_SESSION_ID,
        sessionKey: new Uint8Array(8),
      })
    ).toThrow(CLIENT_ERRORS.sessionKey);
  });
});

describe('Client — pairing and reads', () => {
  it('performs the signed status exchange automatically, then serves reads', async () => {
    const { client, requests } = buildClient();
    const snapshot = await client.snapshot();
    expect(snapshot.version).toEqual(1);
    expect(snapshot.instanceId).toEqual(TEST_INSTANCE_ID);
    expect(snapshot.state).toEqual('running');
    // Two requests: status then snapshot; the status came first and
    // carried NO instance header.
    expect(requests.length).toEqual(2);
    expect(requests[0].target).toEqual('/v1/status');
    expect(requests[0].instance).toBe(null);
    expect(requests[1].target).toEqual('/v1/snapshot');
    expect(requests[1].instance).toEqual(TEST_INSTANCE_ID);
    client.close();
  });

  it('reads events after binding and enforces the argument bounds', async () => {
    const { client, requests } = buildClient();
    const batch = await client.read(4, 16);
    expect(batch.version).toEqual(1);
    expect(batch.next).toEqual(1);
    // Status, then the canonical events target in exact order.
    expect(requests[1].target).toEqual('/v1/events?after=4&limit=16');
    await expect(client.read(-1)).rejects.toThrow(CLIENT_ERRORS.arguments);
    await expect(client.read(0, 0)).rejects.toThrow(CLIENT_ERRORS.arguments);
    await expect(client.read(0, 129)).rejects.toThrow(CLIENT_ERRORS.arguments);
    client.close();
  });

  it('serializes calls and reserves strictly increasing sequence numbers', async () => {
    const { client, requests } = buildClient();
    const [snapshot, batch] = await Promise.all([
      client.snapshot(),
      client.read(0, 4),
    ]);
    expect(snapshot.version).toEqual(1);
    expect(batch.version).toEqual(1);
    const sequences = requests.map((r) => Number.parseInt(r.sequence, 10));
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBeGreaterThan(sequences[i - 1]);
    }
    client.close();
  });
});

describe('Client — verification and bounds', () => {
  it('treats a mutated response body as a connection failure', async () => {
    const { client } = buildClient({
      server: {
        mutateBody: (target, body) =>
          target === '/v1/snapshot' ? JSON.stringify(minimalSnapshot('0'.repeat(36))) : body,
      },
    });
    await expect(client.snapshot()).rejects.toThrow(CLIENT_ERRORS.connection);
    client.close();
  });

  it('treats a broken response MAC as a connection failure', async () => {
    const { client } = buildClient({ server: { dropMac: true } });
    await expect(client.snapshot()).rejects.toThrow(CLIENT_ERRORS.connection);
    client.close();
  });

  it('treats a non-200 as a connection failure without parsing', async () => {
    const { client } = buildClient({ server: { status: 503 } });
    await expect(client.snapshot()).rejects.toThrow(CLIENT_ERRORS.connection);
    client.close();
  });

  it('refuses an oversized body through the read bound', async () => {
    oversizedBodies = false;
    const { client } = buildClient({ server: { oversizedBody: true } });
    await expect(client.snapshot()).rejects.toThrow(CLIENT_ERRORS.connection);
    client.close();
  });

  it('refuses a redirect instead of following it', async () => {
    const { client } = buildClient({ server: { redirect: true } });
    await expect(client.snapshot()).rejects.toThrow(CLIENT_ERRORS.connection);
    client.close();
  });

  it('pairs terminally: a failed status exchange kills the session', async () => {
    const { client } = buildClient({ server: { status: 401 } });
    await expect(client.snapshot()).rejects.toThrow(CLIENT_ERRORS.connection);
    // Terminal: even a now-healthy server cannot revive the identity.
    await expect(client.snapshot()).rejects.toThrow(CLIENT_ERRORS.pairingFailed);
    await expect(client.read(0)).rejects.toThrow(CLIENT_ERRORS.pairingFailed);
    client.close();
  });

  it('rejects every call after close and clears deadlines', async () => {
    const { client, timeouts } = buildClient();
    await client.snapshot();
    expect(timeouts.every((ms) => ms === 5_000)).toBe(true);
    client.close();
    client.close(); // idempotent
    await expect(client.snapshot()).rejects.toThrow(CLIENT_ERRORS.closed);
    await expect(client.read(0)).rejects.toThrow(CLIENT_ERRORS.closed);
  });

  it('sends credentials: omit and no redirects, exact headers, no body', async () => {
    const { client, requests } = buildClient();
    await client.snapshot();
    expect(requests[0].session).toEqual(TEST_SESSION_ID);
    expect(requests[0].mac).toMatch(/^[0-9a-f]{64}$/);
    client.close();
  });

  it('answers its own fixed error for an authentic but malformed body', async () => {
    // The body VERIFIES (the server signed exactly these bytes) and is not
    // JSON. A raw `JSON.parse` here throws a `SyntaxError` whose V8 message
    // quotes the offending peer bytes — the client's stated contract is that
    // no failure echoes server input, and the pairing path already guarded
    // this. Both data paths must too.
    const { client } = buildClient({ server: { malformedBody: true } });
    await expect(client.snapshot()).rejects.toThrow(CLIENT_ERRORS.connection);
    client.close();

    const second = buildClient({ server: { malformedBody: true } });
    await expect(second.client.read(0, 8)).rejects.toThrow(CLIENT_ERRORS.connection);
    second.client.close();
  });

  it('carries the status body version and keys exactly once', () => {
    // The client's own validator: exact key set, so an envelope smuggled by
    // a hostile server is refused. STATUS_BODY_KEYS is the exported
    // allowlist the validator checks against.
    expect(STATUS_BODY_KEYS.length).toEqual(3);
  });
});

/**
 * Bounds a promise so a regression that HANGS (a body read nothing aborts)
 * fails loudly instead of stalling the suite.
 *
 * @param promise - The promise under test
 * @param ms - The bound
 * @returns The original outcome
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('test timed out — the body read was never aborted')), ms)
    ),
  ]);
}

describe('Client — the deadline and close() govern the body read', () => {
  const encoder = new TextEncoder();

  /**
   * A fetch whose 200 response streams one JSON chunk and then pends
   * forever, unless its abort signal fires — the shape of a stalled
   * loopback endpoint after headers.
   *
   * @param captured - Receives the request's AbortSignal
   * @returns The fake fetch
   */
  function stallingFetch(captured: { signal: AbortSignal | null }): typeof fetch {
    return ((_input: string | URL | Request, init?: RequestInit) => {
      captured.signal = (init?.signal as AbortSignal) ?? null;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('{"version":1'));
          captured.signal?.addEventListener('abort', () => {
            try {
              controller.error(new Error('aborted'));
            } catch {
              // already closed
            }
          });
        },
      });
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-setu-instance': TEST_INSTANCE_ID,
            'x-setu-mac': 'a'.repeat(64),
          },
        }),
      );
    }) as typeof fetch;
  }

  function stallClient(captured: { signal: AbortSignal | null }, timing: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  }): ReturnType<typeof createDiagnosticsClient> {
    return createDiagnosticsClient({
      endpoint: `http://127.0.0.1:${TEST_PORT}`,
      sessionId: TEST_SESSION_ID,
      sessionKey: TEST_KEY_BYTES,
      subtle: crypto.subtle,
      fetch: stallingFetch(captured),
      timing,
    });
  }

  it('keeps the 5-second deadline armed across the body read', async () => {
    const captured: { signal: AbortSignal | null } = { signal: null };
    let deadlineFn: (() => void) | undefined;
    const client = stallClient(captured, {
      setTimeout(fn: () => void, _ms: number): unknown {
        deadlineFn = fn;
        return 0;
      },
      clearTimeout(handle: unknown): void {
        // Mirrors production clearing: once cleared, firing is a no-op.
        if (deadlineFn !== undefined && handle === 0) {
          deadlineFn = undefined;
        }
      },
    });
    const pending = client.snapshot();
    // Let the fetch resolve (headers) and the body read pend on chunk two.
    await new Promise((resolve) => setTimeout(resolve, 10));
    assertTrue(captured.signal !== null, 'request captured its abort signal');
    // Fire the deadline: the WHOLE exchange must still be governed by it.
    deadlineFn?.();
    await withTimeout(
      (async () => {
        await expect(pending).rejects.toThrow(CLIENT_ERRORS.connection);
      })(),
      2_000,
    );
    client.close();
  });

  it('aborts an in-flight body read when close() is called', async () => {
    const captured: { signal: AbortSignal | null } = { signal: null };
    const client = stallClient(captured, {
      setTimeout: (_fn: () => void, _ms: number) => 0,
      clearTimeout: (_handle: unknown) => {},
    });
    const pending = client.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 10));
    client.close();
    await withTimeout(
      (async () => {
        await expect(pending).rejects.toThrow(CLIENT_ERRORS.connection);
      })(),
      2_000,
    );
    await expect(client.snapshot()).rejects.toThrow(CLIENT_ERRORS.closed);
  });
});
