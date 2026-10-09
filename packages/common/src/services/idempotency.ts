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

// ── Tier-C store port ───────────────────────────────────────────────────────

/**
 * The discriminator every tier-C row carries in its `kind` column.
 *
 * A store writes it on every row and requires it in the `where` of every read,
 * so a business document that shares the tier-C entity is never read, listed
 * or purged as a tier-C row.
 *
 * @since 0.9.0
 */
export const IDEMPOTENCY_RECORD_KIND = 'setu-idempotency';

/**
 * A committed tier-C record, as {@linkcode ITransactionalIdempotencyStore.find}
 * returns it. The record is the two rows of one key — the claim and the result
 * — committed together with the work they describe.
 *
 * @since 0.9.0
 */
export interface TransactionalIdempotencyRecord {
  /** 64 lower-case hex: the derived key. */
  readonly id: string;
  /** 64 lower-case hex. */
  readonly fingerprint: string;
  /** The encoded result envelope. */
  readonly result: string;
  /** Epoch milliseconds of the commit. */
  readonly createdAt: number;
  /** Epoch milliseconds: the earliest the purge may delete the record. */
  readonly expiresAt: number;
}

/**
 * The claim row {@linkcode ITransactionalIdempotencyStore.run} writes first.
 *
 * @since 0.9.0
 */
export interface TransactionalIdempotencyClaim {
  /** 64 lower-case hex: the derived key. */
  readonly id: string;
  /** 64 lower-case hex. */
  readonly fingerprint: string;
  /** Epoch milliseconds of the claim. */
  readonly createdAt: number;
  /** Epoch milliseconds: the earliest the purge may delete the claim. */
  readonly expiresAt: number;
}

/**
 * The store port a tier-C (`within`) provider writes through: the work and its
 * idempotency record commit in ONE transaction, so a lost race rolls the
 * business writes back with the claim.
 *
 * Every method returns a promise that REJECTS on failure and never throws
 * synchronously. A read requires `kind` to equal
 * {@linkcode IDEMPOTENCY_RECORD_KIND}, and a row of another `kind` is treated
 * as missing; a custom store must honour both rules.
 *
 * @since 0.9.0
 */
export interface ITransactionalIdempotencyStore {
  /**
   * Reads the committed record of one key.
   *
   * @param id - The derived key
   * @returns The record, or `undefined` when either of its rows is missing or
   *   of another `kind`
   */
  find(id: string): Promise<TransactionalIdempotencyRecord | undefined>;

  /**
   * ONE transaction: creates the claim row (`claim.id`) FIRST, runs `work` with
   * the transaction's scope, then creates the result row (`${claim.id}.r`) from
   * the `result` `work` returns, and commits.
   *
   * Only creates — no update and no delete — so every supported backend can
   * perform it. Rejects, rolling everything back, when a create or the commit
   * is refused or when `work` throws.
   *
   * @typeParam R - The caller's result type, unconstrained
   * @param claim - The claim to create first
   * @param work - The work, given the transaction's scope, returning the
   *   encoded result and the caller's value
   * @returns What `work` returned
   */
  run<R>(
    claim: TransactionalIdempotencyClaim,
    work: (scope: unknown) => Promise<{ readonly result: string; readonly value: R }>,
  ): Promise<R>;

  /**
   * Deletes the rows of up to `limit` records whose `expiresAt < before`.
   *
   * @param before - Epoch milliseconds
   * @param limit - Maximum records deleted
   * @returns The number of records deleted
   */
  purge(before: number, limit: number): Promise<number>;

  /**
   * Refuses, at startup, a backend that cannot serve tier C, by name, by
   * running exactly `run`'s write pattern (two creates on distinct keys) in a
   * transaction that always rolls back. Leaves no row.
   *
   * @returns A promise that rejects naming why the store cannot serve
   */
  verify(): Promise<void>;
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
  /**
   * Default `'required'`: no principal → 401. `'optional'`: every anonymous
   * request shares ONE scope, so an anonymous caller who sends another
   * anonymous caller's key is served that caller's stored response. Pair
   * `'optional'` with `response: 'status'` unless the response is safe to show
   * any anonymous caller.
   */
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

// ── Tier-C options ──────────────────────────────────────────────────────────

/**
 * Options for {@linkcode IIdempotencyService.within}: the key, what it is for,
 * the isolation segment, and the request fingerprint.
 *
 * @since 0.9.0
 */
export interface IdempotentWithinOptions {
  /** The client's key: 1–255 characters of `0x21`–`0x7E`, no `"`. */
  readonly key: string;
  /** What the key is for, e.g. `'payments.charge'`. 1–256 characters of `0x20`–`0x7E`. */
  readonly namespace: string;
  /**
   * REQUIRED isolation segment, built ONLY from authenticated identity —
   * typically `JSON.stringify([tenantId, principalId])`. Do not join parts with
   * a separator that can appear inside them: distinct identities can collide.
   * `''` declares the record
   * global on purpose. Never derived for the caller: `within` has no request
   * context.
   */
  readonly scope: string;
  /**
   * Any canonical-JSON value describing the request; a different value under
   * one key is refused. Default: none.
   */
  readonly fingerprint?: unknown;
  /** Default: the plugin's `transactional.ttlMs` (86,400,000). Integer 60,000–2,592,000,000. */
  readonly ttlMs?: number;
}

/**
 * The result of {@linkcode IIdempotencyService.within}.
 *
 * @typeParam R - The caller's result type, unconstrained
 * @since 0.9.0
 */
export interface IdempotentWithinResult<R> {
  /**
   * The JSON round trip of what the work returned — identical on the first
   * call and on a replay. A `Date` is a string on both paths.
   */
  readonly value: R;
  /** `true` when `value` came from a committed record and the work did not run in this call. */
  readonly replayed: boolean;
}

// ── Service ─────────────────────────────────────────────────────────────────

/**
 * The service an idempotency provider registers under
 * `CAPABILITIES.IDEMPOTENCY`. Every entry point funnels through it so one
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
  /**
   * Runs `work` and its idempotency record in ONE transaction (tier C): a
   * repeated key whose record is committed returns the stored result without
   * running `work`; a concurrent duplicate loses the claim's primary key and
   * its business writes roll back with it (then it replays, or rejects with a
   * retryable `409` before the winner committed).
   *
   * REQUIRED: a provider without a `transactional` store refuses with
   * `IdempotencyConfigurationError('transactional', …)`.
   *
   * @typeParam R - The work's result type, unconstrained
   * @typeParam S - The caller's annotation of the transaction scope, unchecked
   * @param options - The key, namespace, scope, fingerprint and TTL
   * @param fn - The work, given the transaction's scope
   * @returns The value and whether it was replayed
   */
  within<R, S = unknown>(
    options: IdempotentWithinOptions,
    fn: (scope: S) => Promise<R>,
  ): Promise<IdempotentWithinResult<R>>;
  /**
   * Deletes up to the configured batch of expired tier-C records.
   *
   * REQUIRED, like {@linkcode within}: an unconfigured provider refuses with
   * `IdempotencyConfigurationError('transactional', …)`.
   *
   * @returns The number of records deleted
   */
  purgeTransactional(): Promise<number>;
}
