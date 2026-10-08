/**
 * Idempotency contracts: the store port, the service contract, the route and
 * ingress option types. This is the `common`-level port every idempotency
 * adapter implements (an in-process store, a Redis store, a Cloudflare Durable
 * Object store) and every entry point reaches (`idempotent()`,
 * `idempotentIngress()`, `@Idempotent`).
 *
 * The record is an opaque string so every store holds identical bytes and a
 * store never re-derives a key, a scope or a fingerprint.
 *
 * @module
 */

import type { IRequestContext, MiddlewareFunction } from '../http.ts';
import type { IIngressBehavior, IngressContext } from './ingress.ts';
import type { IRuntimeServices } from '../runtime.ts';
import type { RedactionPolicy } from '../redaction/policy.ts';
import type { IRedactionService } from '../redaction/redaction-service.ts';

// ── Store port ──────────────────────────────────────────────────────────────

/**
 * One attempt to claim an idempotency key.
 *
 * @since 0.9.0
 */
export interface IdempotencyClaimRequest {
  /** Store key: 64 lower-case hex characters, scoped and hashed by the caller. */
  readonly key: string;
  /** Capacity bucket: 64 lower-case hex characters. Stores without per-scope caps ignore it. */
  readonly scope: string;
  /** Request fingerprint: 64 lower-case hex characters. */
  readonly fingerprint: string;
  /** Candidate token minted by the caller with `runtime.uuid()`. Fences the RECORD only. */
  readonly token: string;
  /** Milliseconds before a retry may take the claim over. Integer ≥ 1. */
  readonly leaseMs: number;
  /** Milliseconds the record is retained from this write. Integer ≥ `leaseMs`. */
  readonly ttlMs: number;
}

/**
 * The outcome of a {@linkcode IIdempotencyStore.claim}.
 *
 * @since 0.9.0
 */
export type IdempotencyClaimResult =
  | { readonly outcome: 'claimed'; readonly takeover: boolean }
  | { readonly outcome: 'completed'; readonly record: string }
  | { readonly outcome: 'in-progress' }
  | { readonly outcome: 'fingerprint-mismatch' }
  | { readonly outcome: 'capacity-exceeded' };

/**
 * The outcome of settling a claim with `complete` or `release`.
 *
 * @since 0.9.0
 */
export type IdempotencySettleResult = 'settled' | 'lost';

/**
 * The store port behind every idempotency entry point.
 *
 * The state machine a store implements is: a claim of an absent key is
 * `claimed`; a claim whose stored fingerprint differs is
 * `fingerprint-mismatch`; a claim of a completed record is `completed` with the
 * record; a claim of an in-progress record inside its lease is `in-progress`,
 * and after the lease lapses it is `claimed` with `takeover: true`. `complete`
 * and `release` succeed only for the token that holds the claim.
 *
 * @since 0.9.0
 */
export interface IIdempotencyStore {
  /** Short store kind for health data, e.g. `'memory'`, `'redis'`, `'durable-object'`. */
  readonly name: string;
  /** Largest serialized record in UTF-8 bytes the store can hold. Absent: no store limit. */
  readonly maxRecordBytes?: number;
  /**
   * Prepares the store. Called exactly once, before any other member.
   *
   * @param runtime - The runtime services the store may use (its clock, timers)
   * @returns A promise resolved once the store is ready
   */
  connect(runtime: IRuntimeServices): Promise<void>;
  /**
   * Claims a key.
   *
   * @param request - The claim request
   * @returns The claim outcome
   */
  claim(request: IdempotencyClaimRequest): Promise<IdempotencyClaimResult>;
  /**
   * Settles a held claim into a completed record.
   *
   * @param key - The store key
   * @param token - The token that holds the claim
   * @param record - The opaque record to store
   * @param ttlMs - Milliseconds the record is retained from this write
   * @returns `'settled'` when the token still held the claim, else `'lost'`
   */
  complete(
    key: string,
    token: string,
    record: string,
    ttlMs: number,
  ): Promise<IdempotencySettleResult>;
  /**
   * Releases a held claim, deleting the record.
   *
   * @param key - The store key
   * @param token - The token that holds the claim
   * @returns `'settled'` when the token still held the claim, else `'lost'`
   */
  release(key: string, token: string): Promise<IdempotencySettleResult>;
  /**
   * Reachability probe. Absent: "cannot tell".
   *
   * @returns `true` when the store answers, `false` when it does not
   */
  isHealthy?(): Promise<boolean>;
  /**
   * Releases the store's own resources. Called from the plugin's close hook.
   *
   * @returns A promise resolved once the store's resources are released
   */
  disconnect?(): Promise<void>;
}

// ── HTTP options ────────────────────────────────────────────────────────────

/**
 * Where an HTTP request's idempotency key comes from.
 *
 * @since 0.9.0
 */
export type IdempotencyKeySource =
  | { readonly header: string }
  | { readonly bodyField: string }
  | ((ctx: IRequestContext) => string | undefined | Promise<string | undefined>);

/**
 * How an HTTP request is fingerprinted. The function's result is re-hashed.
 *
 * @since 0.9.0
 */
export type IdempotencyFingerprintSource =
  | 'request'
  | ((ctx: IRequestContext) => string | Promise<string>);

/**
 * Options for the HTTP `idempotent()` middleware and the `@Idempotent`
 * decorator.
 *
 * @since 0.9.0
 */
export interface IdempotentRouteOptions {
  /** Default `{ header: 'Idempotency-Key' }`. */
  readonly key?: IdempotencyKeySource;
  /** Default `true`: a request without a key answers 400. `false`: it passes through, unclaimed. */
  readonly required?: boolean;
  /** Default `'required'`: no principal → 401. `'optional'`: anonymous requests share one scope. */
  readonly principal?: 'required' | 'optional';
  /** Default `` `${method} ${path}` `` of the request. 1–256 characters, none below U+0020. */
  readonly namespace?: string;
  /** Default `'request'`. */
  readonly fingerprint?: IdempotencyFingerprintSource;
  /** Default: the plugin's `leaseMs` (60,000). */
  readonly leaseMs?: number;
  /** Default: the plugin's `ttlMs` (86,400,000). */
  readonly ttlMs?: number;
  /** Default `'full'`. `'status'` stores no body and no headers. */
  readonly response?: 'full' | 'status';
  /** Default: the plugin's `maxResponseBytes` (262,144). UTF-8 bytes of a string body; byte length of a binary body. */
  readonly maxResponseBytes?: number;
  /** Extra replayable header names, beyond the default allow-list. Default `[]`. */
  readonly replayHeaders?: readonly string[];
  /** Redacts a JSON-object body before it is stored. Default: none. */
  readonly redaction?: RedactionPolicy | IRedactionService;
}

// ── Ingress options ─────────────────────────────────────────────────────────

/**
 * Where an ingress work item's key comes from.
 *
 * @since 0.9.0
 */
export type IngressIdempotencyKeySource =
  | 'auto'
  | 'job-id'
  | 'deduplication-header'
  | ((ctx: IngressContext) => string | undefined);

/**
 * How an ingress work item is fingerprinted. The function's result is re-hashed.
 *
 * @since 0.9.0
 */
export type IngressIdempotencyFingerprintSource =
  | 'payload'
  | ((ctx: IngressContext) => string | Promise<string>);

/**
 * The half of {@linkcode IdempotentIngressOptions} shared by both arms.
 *
 * Exported so the `IdempotentIngressOptions` union has no unexported type
 * reference, which would be a `deno doc --lint` `private-type-ref` diagnostic.
 *
 * @since 0.9.0
 */
export interface IdempotentIngressCommonOptions {
  /** Default `'auto'`: a queue job's id; a message's `x-setu-deduplication-id` header. */
  readonly key?: IngressIdempotencyKeySource;
  /** Default `'payload'`. */
  readonly fingerprint?: IngressIdempotencyFingerprintSource;
  /** An extra scope segment (for example a tenant id read from the payload). Default: none. */
  readonly scope?: (ctx: IngressContext) => string | undefined;
  /** Default: the plugin's `ingressLeaseMs` (30,000). */
  readonly leaseMs?: number;
  /** Default: the plugin's `ttlMs` (86,400,000). */
  readonly ttlMs?: number;
}

/** At least one of `topics` and `jobNames` is required; anything not listed passes through. */
export type IdempotentIngressOptions =
  | (IdempotentIngressCommonOptions & {
    readonly topics: readonly string[];
    readonly jobNames?: readonly string[];
  })
  | (IdempotentIngressCommonOptions & {
    readonly topics?: readonly string[];
    readonly jobNames: readonly string[];
  });

// ── Service ─────────────────────────────────────────────────────────────────

/**
 * The service an idempotency provider registers under
 * `CAPABILITIES.IDEMPOTENCY`. Both HTTP entry points funnel through it so one
 * configuration governs every path.
 *
 * @since 0.9.0
 */
export interface IIdempotencyService {
  /**
   * Builds the HTTP middleware. SYNCHRONOUS. Resolves `options` against the provider's defaults
   * and throws when the result is invalid (`ttlMs < leaseMs`, an option shape the provider refuses).
   *
   * @param options - The route's idempotency options
   * @returns The middleware for that route
   */
  middleware(options?: IdempotentRouteOptions): MiddlewareFunction;
  /**
   * Builds the ingress behaviour. SYNCHRONOUS; throws like `middleware`.
   *
   * @param options - The ingress idempotency options
   * @returns The behaviour for that ingress chain
   */
  behavior(options: IdempotentIngressOptions): IIngressBehavior;
}
