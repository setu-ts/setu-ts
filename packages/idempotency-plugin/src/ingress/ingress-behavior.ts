/**
 * The ingress idempotency behaviour: the allow-list, key, consumer and
 * fingerprint steps of plan §3.7, and its outcomes.
 *
 * @module
 */
import type {
  IdempotencyClaimResult,
  IIngressBehavior,
  IngressContext,
  IngressIdempotencyKeySource,
} from '@setu-ts/common';
import { DEDUPLICATION_ID_HEADER } from '@setu-ts/common';
import { CanonicalJsonError, payloadFingerprint } from '../core/fingerprint.ts';
import { deriveHash } from '../core/hash.ts';
import { parseKeyValue } from '../core/key.ts';
import type { ResolvedIngressOptions } from '../core/options.ts';
import { IdempotencyRefusedError } from '../errors.ts';
import type { ServiceDeps } from '../service/idempotency-service.ts';
import { describeThrown, safeLog } from '../core/safe-log.ts';

/** The queue job id, when the payload carries a string `id`. */
function jobId(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const id = (payload as Record<string, unknown>).id;
  return typeof id === 'string' ? id : undefined;
}

/** A key extraction result, distinguishing missing from invalid. */
type IngressKeyExtraction =
  | { readonly state: 'value'; readonly value: string }
  | { readonly state: 'missing' };

/** Reads the key from the resolved source (step 3). */
function ingressKey(
  ctx: IngressContext,
  source: IngressIdempotencyKeySource,
): IngressKeyExtraction {
  if (typeof source === 'function') {
    const value = source(ctx);
    return value === undefined ? { state: 'missing' } : { state: 'value', value };
  }
  const kind = ctx.kind;
  if (source === 'auto') {
    if (kind === 'queue') {
      const id = jobId(ctx.payload);
      return id === undefined ? { state: 'missing' } : { state: 'value', value: id };
    }
    const header = ctx.headers?.[DEDUPLICATION_ID_HEADER];
    return header === undefined ? { state: 'missing' } : { state: 'value', value: header };
  }
  if (source === 'job-id') {
    if (kind !== 'queue') {
      throw new IdempotencyRefusedError(
        'unsupported-key-source',
        kind,
        ctx.name,
        "idempotentIngress: the 'job-id' key source applies to queue jobs only",
      );
    }
    const id = jobId(ctx.payload);
    return id === undefined ? { state: 'missing' } : { state: 'value', value: id };
  }
  // 'deduplication-header'
  if (kind !== 'messaging') {
    throw new IdempotencyRefusedError(
      'unsupported-key-source',
      kind,
      ctx.name,
      "idempotentIngress: the 'deduplication-header' key source applies to messages only",
    );
  }
  const header = ctx.headers?.[DEDUPLICATION_ID_HEADER];
  return header === undefined ? { state: 'missing' } : { state: 'value', value: header };
}

/**
 * Builds the ingress idempotency behaviour for one allow-list.
 *
 * @param deps - The service dependencies
 * @param resolved - The resolved ingress options
 * @returns The behaviour
 */
export function createIngressBehavior(
  deps: ServiceDeps,
  resolved: ResolvedIngressOptions,
): IIngressBehavior {
  const releaseSafe = async (key: string, token: string, ctx: IngressContext): Promise<void> => {
    try {
      if (await deps.store.release(key, token) === 'lost') {
        safeLog(
          deps.logger,
          'warn',
          'idempotency lease lapsed before completion; the work may have run twice',
          {
            kind: ctx.kind,
            name: ctx.name,
          },
        );
      }
    } catch (error) {
      safeLog(deps.logger, 'error', 'idempotency release failed', { error: describeThrown(error) });
    }
  };
  const completeSafe = async (key: string, token: string, ctx: IngressContext): Promise<void> => {
    try {
      if (await deps.store.complete(key, token, '', resolved.ttlMs) === 'lost') {
        safeLog(
          deps.logger,
          'warn',
          'idempotency lease lapsed before completion; the work may have run twice',
          {
            kind: ctx.kind,
            name: ctx.name,
          },
        );
      }
    } catch (error) {
      safeLog(deps.logger, 'error', 'idempotency complete failed', {
        error: describeThrown(error),
      });
    }
  };

  return {
    async handle(ctx, next) {
      // 1. Allow-list.
      if (ctx.kind === 'messaging') {
        if (!resolved.topics.includes(ctx.name)) return next();
      } else if (ctx.kind === 'queue') {
        if (!resolved.jobNames.includes(ctx.name)) return next();
      } else {
        return next();
      }

      // 2. Consumer.
      const consumer = ctx.consumer;
      if (consumer === undefined) {
        throw new IdempotencyRefusedError(
          'consumer-missing',
          ctx.kind,
          ctx.name,
          `idempotentIngress: a listed ${ctx.kind} reached the behaviour without a consumer identity`,
        );
      }

      // 3. Key.
      const extracted = ingressKey(ctx, resolved.key);
      if (extracted.state === 'missing') {
        throw new IdempotencyRefusedError(
          'key-missing',
          ctx.kind,
          ctx.name,
          `idempotentIngress: no idempotency key for the listed ${ctx.kind} '${ctx.name}'`,
        );
      }
      const clientKey = parseKeyValue(extracted.value);
      if (clientKey === undefined) {
        throw new IdempotencyRefusedError(
          'key-invalid',
          ctx.kind,
          ctx.name,
          `idempotentIngress: the idempotency key for '${ctx.name}' is not valid`,
        );
      }

      // 4. Fingerprint.
      let fingerprint: string;
      try {
        fingerprint = await payloadFingerprint(deps.runtime.subtle, ctx, resolved.fingerprint);
      } catch (error) {
        if (error instanceof CanonicalJsonError) {
          throw new IdempotencyRefusedError(
            'fingerprint-unavailable',
            ctx.kind,
            ctx.name,
            'idempotentIngress: the payload could not be canonicalised',
            { cause: error },
          );
        }
        throw error;
      }

      // 5. Derive and claim.
      const scopeSegment = resolved.scope?.(ctx) ?? '';
      const key = await deriveHash(deps.runtime.subtle, [
        'ingress',
        ctx.kind,
        ctx.name,
        consumer,
        scopeSegment,
        clientKey,
      ]);
      const scope = await deriveHash(deps.runtime.subtle, [
        'ingress',
        ctx.kind,
        ctx.name,
        consumer,
      ]);
      const token = deps.runtime.uuid();
      const claim: IdempotencyClaimResult = await deps.store.claim({
        key,
        scope,
        fingerprint,
        token,
        leaseMs: resolved.leaseMs,
        ttlMs: resolved.ttlMs,
      });

      // 6. Outcomes.
      switch (claim.outcome) {
        case 'completed':
          return;
        case 'in-progress':
          throw new IdempotencyRefusedError(
            'in-progress',
            ctx.kind,
            ctx.name,
            'idempotentIngress: a claim with this key is still being processed',
          );
        case 'fingerprint-mismatch':
          throw new IdempotencyRefusedError(
            'fingerprint-mismatch',
            ctx.kind,
            ctx.name,
            'idempotentIngress: this key was already used with a different payload',
          );
        case 'capacity-exceeded':
          throw new IdempotencyRefusedError(
            'capacity-exceeded',
            ctx.kind,
            ctx.name,
            'idempotentIngress: too many idempotency keys are held for this consumer',
          );
        case 'claimed': {
          if (claim.takeover) {
            safeLog(deps.logger, 'warn', 'idempotency claim took over a lapsed lease', {
              kind: ctx.kind,
              name: ctx.name,
            });
          }
          try {
            await next();
          } catch (error) {
            await releaseSafe(key, token, ctx);
            throw error;
          }
          await completeSafe(key, token, ctx);
          return;
        }
      }
    },
  };
}
