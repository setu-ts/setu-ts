/**
 * Header names, defaults, bounds, replay allow/deny sets and internal state-key
 * constants for the idempotency plugin (plan §3.10, §3.13).
 *
 * @module
 */

/** The request header the default HTTP key source reads. */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

/** The response header written when a stored record is replayed. */
export const IDEMPOTENT_REPLAYED_HEADER = 'Idempotent-Replayed';

/**
 * The request-state key under which the middleware records the derived store
 * key, so a handler can forward it to a provider (§3.12). Internal.
 */
export const IDEMPOTENCY_DERIVED_KEY_STATE_KEY = 'idempotency-plugin:derived-key';

/** Default HTTP claim lease in milliseconds. */
export const DEFAULT_HTTP_LEASE_MS = 60_000;

/** Default ingress claim lease in milliseconds. */
export const DEFAULT_INGRESS_LEASE_MS = 30_000;

/** Default record retention in milliseconds. */
export const DEFAULT_TTL_MS = 86_400_000;

/** Default HTTP response body cap in UTF-8 bytes. */
export const DEFAULT_MAX_RESPONSE_BYTES = 262_144;

/** Default in-process store entry cap. */
export const DEFAULT_MEMORY_MAX_ENTRIES = 100_000;

/** Default in-process per-scope entry cap. */
export const DEFAULT_MEMORY_MAX_ENTRIES_PER_SCOPE = 1_000;

/** Default in-process store byte cap. */
export const DEFAULT_MEMORY_MAX_BYTES = 67_108_864;

/** Default Redis store key prefix. */
export const DEFAULT_REDIS_KEY_PREFIX = 'setu:idempotency:';

/** Default Redis command timeout in milliseconds (`0` disables). */
export const DEFAULT_REDIS_COMMAND_TIMEOUT_MS = 15_000;

/** Default Durable Object store key prefix. */
export const DEFAULT_DO_KEY_PREFIX = 'idempotency:';

/** Default Durable Object per-call timeout in milliseconds (`0` disables). */
export const DEFAULT_DO_TIMEOUT_MS = 5_000;

/** Largest allowed `leaseMs` / `ingressLeaseMs` (24 hours). */
export const MAX_LEASE_MS = 86_400_000;

/** Largest allowed `ttlMs` (30 days). */
export const MAX_TTL_MS = 2_592_000_000;

/** Largest allowed `maxResponseBytes` (16 MiB). */
export const MAX_RESPONSE_BYTES = 16_777_216;

/** Largest allowed route `namespace` length. */
export const MAX_NAMESPACE_CHARS = 256;

/** Largest allowed `key.bodyField` length. */
export const MAX_BODY_FIELD_CHARS = 256;

/** Largest allowed single `topics` / `jobNames` entry length. */
export const MAX_INGRESS_TARGET_CHARS = 512;

/** Largest allowed `topics` / `jobNames` entry count. */
export const MAX_INGRESS_TARGETS = 1_000;

/** Largest allowed client key length after normalization (draft-07 §2.1, Stripe). */
export const MAX_CLIENT_KEY_CHARS = 255;

/** Largest allowed in-process store `maxEntries`. */
export const MAX_MEMORY_ENTRIES = 10_000_000;

/** Smallest allowed in-process store `maxBytes`. */
export const MIN_MEMORY_BYTES = 1_024;

/** Largest allowed in-process store `maxBytes` (4 GiB). */
export const MAX_MEMORY_BYTES = 4_294_967_296;

/** Largest allowed `commandTimeoutMs` / DO `timeoutMs` (`2^31 - 1`). */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** Largest allowed `keyPrefix` length for the Redis and Durable Object stores. */
export const MAX_KEY_PREFIX_CHARS = 64;

/** How often the in-process store may run its capacity sweep. */
export const SWEEP_THROTTLE_MS = 1_000;

/** Deepest value `canonicalJson` walks before refusing. */
export const MAX_CANONICAL_DEPTH = 64;

/** Lowest status a completed record may carry and `decodeHttpRecord` accepts. */
export const RECORDABLE_STATUS_MIN = 200;

/** Highest recordable status — a stored 5xx can only be tampering. */
export const RECORDABLE_STATUS_MAX = 499;

/** Response statuses treated as transient and released rather than recorded (§3.8). */
export const RELEASE_STATUSES: readonly number[] = [408, 425, 429];

/** Regex the Redis and Durable Object store `namespace` must match. */
export const STORE_NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Header names a replayed response may carry, beyond any per-route
 * `replayHeaders`. Lower-case.
 */
export const REPLAY_HEADER_ALLOW: readonly string[] = [
  'content-type',
  'content-encoding',
  'content-location',
  'location',
  'cache-control',
  'etag',
  'last-modified',
  'expires',
  'vary',
];

/**
 * Header names a replay never carries and `replayHeaders` may not name.
 * Lower-case. `content-language` is here because the localization middleware
 * writes it after the handler from the CURRENT request's locale.
 */
export const REPLAY_HEADER_DENY: readonly string[] = [
  'set-cookie',
  'set-cookie2',
  'content-language',
  'ratelimit',
  'ratelimit-policy',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'retry-after',
  'x-request-id',
  'request-id',
  'traceparent',
  'tracestate',
  'date',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'www-authenticate',
  'idempotent-replayed',
];

/** The set form of {@linkcode REPLAY_HEADER_DENY} for membership tests. */
export const REPLAY_HEADER_DENY_SET: ReadonlySet<string> = new Set(REPLAY_HEADER_DENY);
