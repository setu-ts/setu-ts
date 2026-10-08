/**
 * Additional HTTP-middleware cases (plan §3.6, §3.8, §3.10): the `bodyField`
 * key source, the recorded-without-body warnings, and the `lost` settle warns.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IdempotencyClaimResult,
  IIdempotencyStore,
  ILogger,
  IRedactionService,
  IRequestContext,
  ResponseSnapshot,
} from '@setu-ts/common';
import type { IdempotentRouteOptions } from '@setu-ts/common';
import { resolveDefaults, resolveRouteOptions } from '../../src/core/options.ts';
import { createHttpMiddleware } from '../../src/middleware/http-middleware.ts';
import { createClockRuntime } from '../fixtures/clock-runtime.ts';

/** A store answering one outcome and recording its settle calls. */
function recordingStore(outcome: IdempotencyClaimResult, settle: 'settled' | 'lost' = 'settled') {
  const calls = { claim: [] as unknown[], complete: [] as unknown[], release: [] as unknown[] };
  const store: IIdempotencyStore = {
    name: 'recording',
    connect: () => Promise.resolve(),
    claim: (request) => {
      calls.claim.push(request);
      return Promise.resolve(outcome);
    },
    complete: (key, token, record, ttl) => {
      calls.complete.push([key, token, record, ttl]);
      return Promise.resolve(settle);
    },
    release: (key, token) => {
      calls.release.push([key, token]);
      return Promise.resolve(settle);
    },
  };
  return { store, calls };
}

/** A fake context. */
function makeCtx(options: {
  json?: () => Promise<unknown>;
  headers?: Headers;
  snapshot?: ResponseSnapshot;
  user?: { id: string };
  path?: string;
}) {
  const captured = { status: 0, json: undefined as unknown };
  const request = {
    method: 'POST',
    path: options.path ?? '/orders',
    url: `https://x${options.path ?? '/orders'}`,
    headers: options.headers ?? new Headers({ 'Idempotency-Key': 'k' }),
    user: options.user ?? { id: 'u1' },
    json: options.json ?? (() => Promise.resolve({})),
    bytes: () => Promise.resolve(new Uint8Array()),
  };
  const response = {
    status: (code: number) => {
      captured.status = code;
      return response;
    },
    header: () => response,
    json: (body: unknown) => {
      captured.json = body;
      return undefined;
    },
    send: () => undefined,
    snapshot: () =>
      options.snapshot ?? { streaming: false, status: 200, headers: new Headers(), body: 'ok' },
  };
  const ctx = {
    request,
    response,
    state: new Map(),
    services: { has: () => false, get: () => undefined },
  } as unknown as IRequestContext;
  return { ctx, captured };
}

/** A fresh streaming snapshot (a body stream can be read only once). */
function streaming(): ResponseSnapshot {
  return {
    streaming: true,
    status: 200,
    headers: new Headers(),
    body: new ReadableStream<Uint8Array>(),
  } as ResponseSnapshot;
}

/** Builds the middleware under test. */
function middleware(store: IIdempotencyStore, options: IdempotentRouteOptions, logger?: ILogger) {
  const defaults = resolveDefaults(undefined);
  return createHttpMiddleware(
    { store, runtime: createClockRuntime(), logger: () => logger, defaults },
    resolveRouteOptions(options, defaults),
  );
}

describe('createHttpMiddleware — bodyField key source (M109a §3.6 step 2)', () => {
  it('uses a string field', async () => {
    const { store, calls } = recordingStore({ outcome: 'claimed', takeover: false });
    const { ctx } = makeCtx({ json: () => Promise.resolve({ id: 'k1' }) });
    await middleware(store, { key: { bodyField: 'id' } })(ctx, () => Promise.resolve());
    expect(calls.claim).toHaveLength(1);
  });

  it('answers 400 for an absent field, a non-string field and a non-object body', async () => {
    const cases = [
      () => Promise.resolve({}),
      () => Promise.resolve({ id: 1 }),
      () => Promise.resolve([]),
    ];
    for (const json of cases) {
      const { store, calls } = recordingStore({ outcome: 'claimed', takeover: false });
      const { ctx, captured } = makeCtx({ json });
      await middleware(store, { key: { bodyField: 'id' } })(ctx, () => Promise.resolve());
      expect(captured.status).toBe(400);
      expect(calls.claim).toHaveLength(0);
    }
  });
});

describe('createHttpMiddleware — recorded-without-body warnings (M109a §3.10)', () => {
  const captureLogger = () => {
    const warnings: string[] = [];
    const logger = {
      level: 'info',
      warn: (m: string) => void warnings.push(m),
    } as unknown as ILogger;
    return { logger, warnings };
  };

  it('warns once for a streaming response', async () => {
    const { logger, warnings } = captureLogger();
    const { store } = recordingStore({ outcome: 'claimed', takeover: false });
    const streaming = {
      streaming: true,
      status: 200,
      headers: new Headers(),
      body: new ReadableStream<Uint8Array>(),
    } as ResponseSnapshot;
    const mw = middleware(store, {}, logger);
    const first = makeCtx({ snapshot: streaming });
    await mw(first.ctx, () => Promise.resolve());
    const second = makeCtx({ snapshot: streaming });
    await mw(second.ctx, () => Promise.resolve());
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('streaming');
  });

  it('bounds the warnings a caller can cause with distinct paths (M109a audit F1)', async () => {
    // The default namespace carries the request path. An uncapped set kept
    // every distinct path for the life of the process and warned for each.
    const { logger, warnings } = captureLogger();
    const { store } = recordingStore({ outcome: 'claimed', takeover: false });
    const mw = middleware(store, {}, logger);
    for (let n = 0; n < 1_000; n++) {
      await mw(
        makeCtx({ snapshot: streaming(), path: `/orders/${n}` }).ctx,
        () => Promise.resolve(),
      );
    }
    // 256 distinct (reason, namespace) pairs, then ONE suppression line.
    expect(warnings).toHaveLength(257);
    expect(warnings.filter((w) => w.includes('suppressed'))).toHaveLength(1);
    expect(warnings.at(-1)).toContain('suppressed');
  });

  it('warns once per route when one instance serves several routes (round 2, N1)', async () => {
    // Keyed by reason alone, a shared instance warned for the first route only.
    const { logger, warnings } = captureLogger();
    const { store } = recordingStore({ outcome: 'claimed', takeover: false });
    const mw = middleware(store, {}, logger);
    for (let n = 0; n < 3; n++) {
      for (const path of ['/items', '/other']) {
        await mw(makeCtx({ snapshot: streaming(), path }).ctx, () => Promise.resolve());
      }
    }
    expect(warnings).toHaveLength(2);
    expect(warnings.every((w) => w.includes('streaming'))).toBe(true);
  });

  it('warns for an oversize body and a redaction miss', async () => {
    const { logger, warnings } = captureLogger();
    const { store } = recordingStore({ outcome: 'claimed', takeover: false });
    const oversize = { streaming: false, status: 200, headers: new Headers(), body: 'x' };
    await middleware(store, { maxResponseBytes: 0 }, logger)(
      makeCtx({ snapshot: oversize } as never).ctx,
      () => Promise.resolve(),
    );
    expect(warnings.join(' ')).toContain('exceeds maxResponseBytes');
  });

  it('warns for a redaction miss', async () => {
    const { logger, warnings } = captureLogger();
    const redaction: IRedactionService = { redactValue: (_p, v) => v, redactRecord: (r) => r };
    const { store } = recordingStore({ outcome: 'claimed', takeover: false });
    const plain = {
      streaming: false,
      status: 200,
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: 'x',
    };
    await middleware(store, { redaction }, logger)(
      makeCtx({ snapshot: plain } as never).ctx,
      () => Promise.resolve(),
    );
    expect(warnings.join(' ')).toContain('not a JSON object');
  });

  it('warns when the record exceeds the store limit', async () => {
    const { logger, warnings } = captureLogger();
    const { store } = recordingStore({ outcome: 'claimed', takeover: false });
    (store as { maxRecordBytes?: number }).maxRecordBytes = 5;
    const big = { streaming: false, status: 200, headers: new Headers(), body: 'x'.repeat(100) };
    await middleware(store, {}, logger)(
      makeCtx({ snapshot: big } as never).ctx,
      () => Promise.resolve(),
    );
    expect(warnings.join(' ')).toContain('store limit');
  });
});

describe('createHttpMiddleware — lost settle warns (M109a §3.8)', () => {
  it('warns on a lost complete and a lost release', async () => {
    const warnings: string[] = [];
    const logger = {
      level: 'info',
      warn: (m: string) => void warnings.push(m),
    } as unknown as ILogger;

    const completed = recordingStore({ outcome: 'claimed', takeover: false }, 'lost');
    await middleware(completed.store, {}, logger)(
      makeCtx({ snapshot: { streaming: false, status: 201, headers: new Headers(), body: null } })
        .ctx,
      () => Promise.resolve(),
    );

    const released = recordingStore({ outcome: 'claimed', takeover: false }, 'lost');
    await middleware(released.store, {}, logger)(
      makeCtx({ snapshot: { streaming: false, status: 503, headers: new Headers(), body: null } })
        .ctx,
      () => Promise.resolve(),
    );

    expect(warnings.filter((message) => message.includes('lease lapsed')).length).toBe(2);
  });
});
