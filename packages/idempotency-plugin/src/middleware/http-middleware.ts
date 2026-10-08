/**
 * The HTTP idempotency middleware: the numbered check order of plan §3.6, the
 * failure classification of §3.8, the record codec of §3.10 and the derived key
 * of §3.12.
 *
 * @module
 */
import type { IdempotencyClaimResult, IRequestContext, MiddlewareFunction } from '@setu-ts/common';
import { respondWithError } from '@setu-ts/common';
import { IDEMPOTENCY_DERIVED_KEY_STATE_KEY, RELEASE_STATUSES } from '../constants.ts';
import { deriveHash } from '../core/hash.ts';
import { parseKeyValue } from '../core/key.ts';
import { requestFingerprint } from '../core/fingerprint.ts';
import type { ResolvedRouteOptions } from '../core/options.ts';
import type { RecordOmissionReason } from '../core/record.ts';
import {
  decodeHttpRecord,
  encodeHttpRecord,
  IdempotencyRecordError,
  replay,
} from '../core/record.ts';
import type { ServiceDeps } from '../service/idempotency-service.ts';

/** The warn message shared by every lease-lapse settle. */
const LEASE_LAPSED = 'idempotency lease lapsed before completion; the work may have run twice';

/** Why a recorded response dropped its body/headers, and the warn to emit. */
const OMISSION_WARNINGS: Readonly<Record<string, string>> = {
  stream: 'idempotency: a streaming response is recorded without its body',
  size: 'idempotency: the response body exceeds maxResponseBytes and is recorded without its body',
  'store-limit': 'idempotency: the record exceeds the store limit and is recorded without its body',
  redaction: 'idempotency: the response body is not a JSON object and is recorded without its body',
};

/** The extracted client key, distinguishing a missing key from an invalid one. */
type KeyExtraction =
  | { readonly state: 'value'; readonly value: string }
  | { readonly state: 'missing' }
  | { readonly state: 'invalid' };

/** Reads the key from the resolved source (step 2). */
async function extractKey(
  ctx: IRequestContext,
  resolved: ResolvedRouteOptions,
): Promise<KeyExtraction> {
  const source = resolved.key;
  if (typeof source === 'function') {
    const value = await source(ctx);
    return value === undefined ? { state: 'missing' } : { state: 'value', value };
  }
  if ('header' in source) {
    const value = ctx.request.headers.get(source.header);
    return value === null ? { state: 'missing' } : { state: 'value', value };
  }
  const body = await ctx.request.json();
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { state: 'invalid' };
  }
  const field = (body as Record<string, unknown>)[source.bodyField];
  if (field === undefined) return { state: 'missing' };
  return typeof field === 'string' ? { state: 'value', value: field } : { state: 'invalid' };
}

/**
 * Builds the HTTP idempotency middleware for one route.
 *
 * @param deps - The service dependencies
 * @param resolved - The resolved route options
 * @returns The middleware
 */
export function createHttpMiddleware(
  deps: ServiceDeps,
  resolved: ResolvedRouteOptions,
): MiddlewareFunction {
  // Keyed by the omission REASON, a fixed vocabulary, never by namespace: the
  // default namespace carries the request path, so a set keyed by it grew one
  // entry per distinct path an authenticated caller sent and logged on every
  // request (M109a audit F1). This middleware serves one route, so one warning
  // per reason is one warning per route and reason.
  const warned = new Set<RecordOmissionReason>();

  const release = async (key: string, token: string, namespace: string): Promise<void> => {
    try {
      if (await deps.store.release(key, token) === 'lost') {
        deps.logger()?.warn(LEASE_LAPSED, { namespace });
      }
    } catch (error) {
      deps.logger()?.error('idempotency release failed', { error: String(error) });
    }
  };
  const complete = async (
    key: string,
    token: string,
    record: string,
    namespace: string,
  ): Promise<void> => {
    try {
      if (await deps.store.complete(key, token, record, resolved.ttlMs) === 'lost') {
        deps.logger()?.warn(LEASE_LAPSED, { namespace });
      }
    } catch (error) {
      deps.logger()?.error('idempotency complete failed', { error: String(error) });
    }
  };

  return async (ctx, next) => {
    // 1. Safe method.
    const method = ctx.request.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();

    // 2. Key extraction.
    const extraction = await extractKey(ctx, resolved);

    // 3. Missing key with `required: false` passes BEFORE the principal check.
    if (extraction.state === 'missing' && resolved.required === false) return next();

    // 4. Principal.
    if (resolved.principal === 'required' && ctx.request.user === undefined) {
      respondWithError(ctx, {
        status: 401,
        title: 'Unauthorized',
        detail: 'Idempotent requests require an authenticated principal',
      });
      return;
    }

    // 5. Missing / invalid key.
    if (extraction.state === 'missing') {
      respondWithError(ctx, {
        status: 400,
        title: 'Bad Request',
        detail: 'This request requires an idempotency key',
      });
      return;
    }
    if (extraction.state === 'invalid') {
      respondWithError(ctx, {
        status: 400,
        title: 'Bad Request',
        detail: 'The idempotency key is not valid',
      });
      return;
    }
    const clientKey = parseKeyValue(extraction.value);
    if (clientKey === undefined) {
      respondWithError(ctx, {
        status: 400,
        title: 'Bad Request',
        detail: 'The idempotency key is not valid',
      });
      return;
    }

    // 6. Fingerprint.
    const fingerprint = await requestFingerprint(deps.runtime.subtle, ctx, resolved.fingerprint);

    // 7. Scope, key and claim.
    const tenantId = ctx.request.tenant?.id ?? '';
    const principalId = ctx.request.user?.id ?? '';
    const namespace = resolved.namespace ?? `${ctx.request.method} ${ctx.request.path}`;
    const key = await deriveHash(deps.runtime.subtle, [
      'http',
      tenantId,
      principalId,
      namespace,
      clientKey,
    ]);
    const scope = await deriveHash(deps.runtime.subtle, ['http', tenantId, principalId]);
    const token = deps.runtime.uuid();

    let claim: IdempotencyClaimResult;
    try {
      claim = await deps.store.claim({
        key,
        scope,
        fingerprint,
        token,
        leaseMs: resolved.leaseMs,
        ttlMs: resolved.ttlMs,
      });
    } catch (error) {
      deps.logger()?.error('idempotency claim failed', { error: String(error) });
      respondWithError(ctx, {
        status: 503,
        title: 'Service Unavailable',
        detail: 'The idempotency store is unavailable',
      });
      return;
    }

    // 8. Outcomes.
    switch (claim.outcome) {
      case 'fingerprint-mismatch':
        respondWithError(ctx, {
          status: 422,
          title: 'Unprocessable Entity',
          detail: 'The idempotency key was already used with a different request',
        });
        return;
      case 'in-progress':
        respondWithError(ctx, {
          status: 409,
          title: 'Conflict',
          detail: 'A request with this idempotency key is still being processed',
        });
        return;
      case 'capacity-exceeded':
        respondWithError(ctx, {
          status: 429,
          title: 'Too Many Requests',
          detail: 'Too many idempotency keys are held for this caller',
        });
        return;
      case 'completed': {
        const decoded = decodeHttpRecord(claim.record, resolved);
        if (decoded instanceof IdempotencyRecordError) {
          deps.logger()?.error('idempotency record rejected', { error: decoded.message });
          respondWithError(ctx, {
            status: 503,
            title: 'Service Unavailable',
            detail: 'The idempotency store is unavailable',
          });
          return;
        }
        return replay(ctx, decoded);
      }
      case 'claimed': {
        if (claim.takeover) {
          deps.logger()?.warn('idempotency claim took over a lapsed lease', { namespace });
        }
        ctx.state.set(IDEMPOTENCY_DERIVED_KEY_STATE_KEY, key);
        try {
          await next();
        } catch (error) {
          await release(key, token, namespace);
          throw error;
        }
        const snapshot = ctx.response.snapshot();
        const status = snapshot.status;
        if (status < 200 || status >= 500 || RELEASE_STATUSES.includes(status)) {
          await release(key, token, namespace);
          return;
        }
        const encoded = encodeHttpRecord(snapshot, resolved, deps.store.maxRecordBytes);
        if (encoded.omitted !== undefined && !warned.has(encoded.omitted)) {
          const warning = OMISSION_WARNINGS[encoded.omitted];
          if (warning !== undefined) {
            warned.add(encoded.omitted);
            deps.logger()?.warn(warning, { namespace });
          }
        }
        await complete(key, token, encoded.record, namespace);
        return;
      }
    }
  };
}
