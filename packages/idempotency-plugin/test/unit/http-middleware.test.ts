/**
 * Unit tests for the HTTP middleware — one case per §3.6 step and each §3.8
 * failure classification (plan §3.6, §3.8, §3.10).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type {
  IdempotencyClaimResult,
  IIdempotencyStore,
  ILogger,
  IRequestContext,
  ResponseSnapshot,
} from '@setu-ts/common';
import { MalformedRequestBodyError } from '@setu-ts/common';
import { resolveDefaults, resolveRouteOptions } from '../../src/core/options.ts';
import type { IdempotentRouteOptions } from '@setu-ts/common';
import { createHttpMiddleware } from '../../src/middleware/http-middleware.ts';
import { IDEMPOTENCY_DERIVED_KEY_STATE_KEY } from '../../src/constants.ts';
import { createClockRuntime } from '../fixtures/clock-runtime.ts';

/** A store recording its calls. */
function recordingStore(outcome: IdempotencyClaimResult, over: Partial<IIdempotencyStore> = {}) {
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
      return Promise.resolve('settled');
    },
    release: (key, token) => {
      calls.release.push([key, token]);
      return Promise.resolve('settled');
    },
    ...over,
  };
  return { store, calls };
}

interface CtxOptions {
  method?: string;
  path?: string;
  url?: string;
  headers?: Headers;
  user?: { id: string } | undefined;
  tenant?: { id: string } | undefined;
  json?: () => Promise<unknown>;
  bytes?: () => Promise<Uint8Array>;
  snapshot?: ResponseSnapshot;
}

/** Builds a fake request context and a recorder of what it wrote. */
function makeCtx(options: CtxOptions = {}) {
  const state = new Map<string, unknown>();
  const captured = { status: 0, headers: [] as [string, string][], json: undefined as unknown };
  const request = {
    method: options.method ?? 'POST',
    path: options.path ?? '/orders',
    url: options.url ?? 'https://example.test/orders',
    headers: options.headers ?? new Headers({ 'Idempotency-Key': 'key-1' }),
    user: options.user,
    tenant: options.tenant,
    json: options.json ?? (() => Promise.resolve({})),
    bytes: options.bytes ?? (() => Promise.resolve(new Uint8Array([1]))),
  };
  const response = {
    status: (code: number) => {
      captured.status = code;
      return response;
    },
    header: (name: string, value: string) => {
      captured.headers.push([name, value]);
      return response;
    },
    json: (body: unknown) => {
      captured.json = body;
      return undefined;
    },
    send: () => undefined,
    snapshot: () =>
      options.snapshot ??
        { streaming: false, status: 200, headers: new Headers(), body: 'ok' } as ResponseSnapshot,
  };
  const ctx = {
    request,
    response,
    state,
    services: { has: () => false, get: () => undefined },
  } as unknown as IRequestContext;
  return { ctx, state, captured };
}

/** Builds the middleware under test. */
function middleware(
  store: IIdempotencyStore,
  options?: IdempotentRouteOptions,
  logger?: ILogger,
) {
  const defaults = resolveDefaults(undefined);
  return createHttpMiddleware(
    { store, runtime: createClockRuntime(), logger: () => logger, defaults },
    resolveRouteOptions(options, defaults),
  );
}

const ok = (): Promise<void> => Promise.resolve();
const noStoreCalls = (
  calls: { claim: unknown[]; complete: unknown[]; release: unknown[] },
): boolean => calls.claim.length === 0 && calls.complete.length === 0 && calls.release.length === 0;

describe('createHttpMiddleware — the numbered check order (M109a §3.6)', () => {
  it('step 1: a safe method passes with no store call', async () => {
    const { store, calls } = recordingStore({ outcome: 'claimed', takeover: false });
    let ran = false;
    await middleware(store)(makeCtx({ method: 'GET' }).ctx, () => {
      ran = true;
      return ok();
    });
    expect(ran).toBe(true);
    expect(noStoreCalls(calls)).toBe(true);
  });

  it('step 3: a missing key with required:false passes BEFORE the principal check', async () => {
    const { store, calls } = recordingStore({ outcome: 'claimed', takeover: false });
    let ran = false;
    await middleware(store, { required: false })(
      makeCtx({ headers: new Headers(), user: undefined }).ctx,
      () => {
        ran = true;
        return ok();
      },
    );
    expect(ran).toBe(true);
    expect(noStoreCalls(calls)).toBe(true);
  });

  it('step 4: no principal answers 401 with no store call', async () => {
    const { store, calls } = recordingStore({ outcome: 'claimed', takeover: false });
    const { ctx, captured } = makeCtx({ user: undefined });
    await middleware(store)(ctx, ok);
    expect(captured.status).toBe(401);
    expect((captured.json as { error?: string }).error).toBe('Unauthorized');
    expect(noStoreCalls(calls)).toBe(true);
  });

  it('step 5: a missing key with required:true answers 400', async () => {
    const { store } = recordingStore({ outcome: 'claimed', takeover: false });
    const { ctx, captured } = makeCtx({ headers: new Headers(), user: { id: 'u1' } });
    await middleware(store)(ctx, ok);
    expect(captured.status).toBe(400);
    expect((captured.json as { detail?: string }).detail).toBe(
      'This request requires an idempotency key',
    );
  });

  it('step 5: an invalid key answers 400 and never echoes the key', async () => {
    const { store } = recordingStore({ outcome: 'claimed', takeover: false });
    const { ctx, captured } = makeCtx({
      headers: new Headers({ 'Idempotency-Key': 'has space' }),
      user: { id: 'u1' },
    });
    await middleware(store)(ctx, ok);
    expect(captured.status).toBe(400);
    expect((captured.json as { detail?: string }).detail).toBe('The idempotency key is not valid');
    expect(JSON.stringify(captured.json)).not.toContain('has space');
  });

  it('step 2: a malformed JSON body propagates MalformedRequestBodyError', async () => {
    const { store } = recordingStore({ outcome: 'claimed', takeover: false });
    const error = new MalformedRequestBodyError(new SyntaxError('bad'));
    const { ctx } = makeCtx({
      user: { id: 'u1' },
      json: () => Promise.reject(error),
    });
    await expect(middleware(store, { key: { bodyField: 'id' } })(ctx, ok)).rejects.toBe(error);
  });

  it('step 2: a throwing key function propagates unchanged', async () => {
    const { store } = recordingStore({ outcome: 'claimed', takeover: false });
    const boom = new Error('key function failed');
    const { ctx } = makeCtx({ user: { id: 'u1' } });
    await expect(middleware(store, { key: () => Promise.reject(boom) })(ctx, ok)).rejects.toBe(
      boom,
    );
  });

  it('step 6: a bytes() rejection propagates unchanged', async () => {
    const { store } = recordingStore({ outcome: 'claimed', takeover: false });
    const tooLarge = new Error('RequestBodyTooLarge');
    const { ctx } = makeCtx({ user: { id: 'u1' }, bytes: () => Promise.reject(tooLarge) });
    await expect(middleware(store)(ctx, ok)).rejects.toBe(tooLarge);
  });
});

describe('createHttpMiddleware — claim outcomes (M109a §3.6, §3.8)', () => {
  const table: readonly { outcome: IdempotencyClaimResult; status: number; title: string }[] = [
    { outcome: { outcome: 'fingerprint-mismatch' }, status: 422, title: 'Unprocessable Entity' },
    { outcome: { outcome: 'in-progress' }, status: 409, title: 'Conflict' },
    { outcome: { outcome: 'capacity-exceeded' }, status: 429, title: 'Too Many Requests' },
  ];

  for (const row of table) {
    it(`answers ${row.status} for ${JSON.stringify(row.outcome)}`, async () => {
      const { store } = recordingStore(row.outcome);
      const { ctx, captured } = makeCtx({ user: { id: 'u1' } });
      await middleware(store)(ctx, ok);
      expect(captured.status).toBe(row.status);
      expect((captured.json as { error?: string }).error).toBe(row.title);
      // The client's key never appears in the body.
      expect(JSON.stringify(captured.json)).not.toContain('key-1');
    });
  }

  it('replays a completed record with the sentinel and marks the derived key state', async () => {
    const { store } = recordingStore({ outcome: 'claimed', takeover: false });
    const record = JSON.stringify({ v: 1, s: 201, h: [], b: null });
    const { ctx, captured } = makeCtx({ user: { id: 'u1' } });
    await middleware(store, undefined, undefined)(ctx, ok);
    // A second call against a completed store.
    const completed = recordingStore({ outcome: 'completed', record });
    const second = makeCtx({ user: { id: 'u1' } });
    await middleware(completed.store)(second.ctx, ok);
    expect(second.captured.status).toBe(201);
    expect(second.captured.headers).toContainEqual(['Idempotent-Replayed', 'true']);
    expect(captured.status).toBe(0); // the first call recorded no error status
  });

  it('answers 503 and logs when a completed record is tampered', async () => {
    const errors: string[] = [];
    const logger = {
      level: 'info',
      error: (m: string) => void errors.push(m),
    } as unknown as ILogger;
    const { store } = recordingStore({ outcome: 'completed', record: JSON.stringify({ v: 2 }) });
    const { ctx, captured } = makeCtx({ user: { id: 'u1' } });
    await middleware(store, undefined, logger)(ctx, ok);
    expect(captured.status).toBe(503);
    expect(errors).toContain('idempotency record rejected');
  });

  it('answers 503 and logs when the claim throws', async () => {
    const errors: string[] = [];
    const logger = {
      level: 'info',
      error: (m: string) => void errors.push(m),
    } as unknown as ILogger;
    const { store } = recordingStore({ outcome: 'claimed', takeover: false }, {
      claim: () => Promise.reject(new Error('down')),
    });
    const { ctx, captured } = makeCtx({ user: { id: 'u1' } });
    await middleware(store, undefined, logger)(ctx, ok);
    expect(captured.status).toBe(503);
    expect(errors).toContain('idempotency claim failed');
  });
});

describe('createHttpMiddleware — failure classification (M109a §3.8)', () => {
  it('releases and rethrows the ORIGINAL error even when release rejects', async () => {
    const { store, calls } = recordingStore({ outcome: 'claimed', takeover: false });
    // The release REJECTS, but must still have been attempted, and must never
    // replace the original error.
    store.release = (key, token) => {
      calls.release.push([key, token]);
      return Promise.reject(new Error('release down'));
    };
    const { ctx } = makeCtx({ user: { id: 'u1' } });
    const boom = new Error('handler failed');
    await expect(middleware(store)(ctx, () => Promise.reject(boom))).rejects.toBe(boom);
    expect(calls.release).toHaveLength(1);
  });

  it('records a returned 400 and releases a returned 503, 408, 429 and a 1xx', async () => {
    for (
      const [status, shouldComplete] of [
        [400, true],
        [422, true],
        [503, false],
        [408, false],
        [425, false],
        [429, false],
        [100, false],
      ] as const
    ) {
      const { store, calls } = recordingStore({ outcome: 'claimed', takeover: false });
      const { ctx } = makeCtx({
        user: { id: 'u1' },
        snapshot: {
          streaming: false,
          status,
          headers: new Headers(),
          body: 'x',
        } as ResponseSnapshot,
      });
      await middleware(store)(ctx, ok);
      if (shouldComplete) {
        expect(calls.complete).toHaveLength(1);
        expect(calls.release).toHaveLength(0);
      } else {
        expect(calls.release).toHaveLength(1);
        expect(calls.complete).toHaveLength(0);
      }
    }
  });

  it('logs a complete rejection without throwing', async () => {
    const errors: string[] = [];
    const logger = {
      level: 'info',
      error: (m: string) => void errors.push(m),
    } as unknown as ILogger;
    const { store } = recordingStore({ outcome: 'claimed', takeover: false }, {
      complete: () => Promise.reject(new Error('complete down')),
    });
    const { ctx, captured } = makeCtx({ user: { id: 'u1' } });
    await middleware(store, undefined, logger)(ctx, ok);
    expect(captured.status).toBe(0);
    expect(errors).toContain('idempotency complete failed');
  });

  it('sets the derived-key state and logs a takeover', async () => {
    const warnings: string[] = [];
    const logger = {
      level: 'info',
      warn: (m: string) => void warnings.push(m),
    } as unknown as ILogger;
    const { store } = recordingStore({ outcome: 'claimed', takeover: true });
    const { ctx, state } = makeCtx({ user: { id: 'u1' } });
    await middleware(store, undefined, logger)(ctx, ok);
    expect(typeof state.get(IDEMPOTENCY_DERIVED_KEY_STATE_KEY)).toBe('string');
    expect(warnings).toContain('idempotency claim took over a lapsed lease');
  });
});
