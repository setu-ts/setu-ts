/**
 * Option shape validation (call time) and resolution (merge with plugin
 * defaults, then cross-field rules) for the route, ingress and plugin options
 * (plan §3.9, §3.13).
 *
 * @module
 */
import type {
  IdempotencyFingerprintSource,
  IdempotencyKeySource,
  IdempotentIngressOptions,
  IdempotentRouteOptions,
  IngressContext,
  IngressIdempotencyFingerprintSource,
  IngressIdempotencyKeySource,
  IRedactionService,
  RedactionPolicy,
} from '@setu-ts/common';
import { createRedactionService } from '@setu-ts/common';
import {
  DEFAULT_HTTP_LEASE_MS,
  DEFAULT_INGRESS_LEASE_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_MEMORY_MAX_ENTRIES,
  DEFAULT_TTL_MS,
  IDEMPOTENCY_KEY_HEADER,
  MAX_BODY_FIELD_CHARS,
  MAX_INGRESS_TARGET_CHARS,
  MAX_INGRESS_TARGETS,
  MAX_KEY_PREFIX_CHARS,
  MAX_LEASE_MS,
  MAX_MEMORY_BYTES,
  MAX_MEMORY_ENTRIES,
  MAX_NAMESPACE_CHARS,
  MAX_PURGE_BATCH,
  MAX_RESPONSE_BYTES,
  MAX_RESULT_BYTES,
  MAX_TIMEOUT_MS,
  MAX_TTL_MS,
  MIN_MEMORY_BYTES,
  MIN_WITHIN_TTL_MS,
  REPLAY_HEADER_DENY_SET,
  STORE_NAMESPACE_PATTERN,
} from '../constants.ts';
import { IdempotencyConfigurationError } from '../errors.ts';
import type {
  IdempotencyPluginOptions,
  IdempotencyStoreConfig,
  TransactionalIdempotencyOptions,
} from '../interfaces/index.ts';
import { validateInjectedClient } from '../stores/redis-client.ts';

/** The plugin-level defaults a route or ingress option set resolves against. */
export interface IdempotencyDefaults {
  /** Default HTTP lease. */
  readonly leaseMs: number;
  /** Default ingress lease. */
  readonly ingressLeaseMs: number;
  /** Default retention. */
  readonly ttlMs: number;
  /** Default HTTP body cap. */
  readonly maxResponseBytes: number;
}

/** A route option set with every default applied and cross-field rules checked. */
export interface ResolvedRouteOptions {
  readonly key: IdempotencyKeySource;
  readonly required: boolean;
  readonly principal: 'required' | 'optional';
  readonly namespace: string | undefined;
  readonly fingerprint: IdempotencyFingerprintSource;
  readonly leaseMs: number;
  readonly ttlMs: number;
  readonly response: 'full' | 'status';
  readonly maxResponseBytes: number;
  readonly replayHeaders: readonly string[];
  readonly redaction: IRedactionService | undefined;
}

/** An ingress option set with every default applied and cross-field rules checked. */
export interface ResolvedIngressOptions {
  readonly key: IngressIdempotencyKeySource;
  readonly fingerprint: IngressIdempotencyFingerprintSource;
  readonly scope: ((ctx: IngressContext) => string | undefined) | undefined;
  readonly leaseMs: number;
  readonly ttlMs: number;
  readonly topics: readonly string[];
  readonly jobNames: readonly string[];
}

/** True for a finite integer within `[min, max]`. */
function isIntInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** True for a string of `min`–`max` characters, each in `0x21`–`0x7E`. */
function isPrintableAscii(value: string, min: number, max: number): boolean {
  if (value.length < min || value.length > max) return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return false;
  }
  return true;
}

/** True for a string of `min`–`max` characters, none below U+0020. */
function isTextWithoutControls(value: string, min: number, max: number): boolean {
  if (value.length < min || value.length > max) return false;
  for (let i = 0; i < value.length; i++) {
    if (value.charCodeAt(i) < 0x20) return false;
  }
  return true;
}

/** True when the string is accepted by the platform's `Headers` as a name. */
function isValidHeaderName(name: string): boolean {
  if (name.length === 0) return false;
  try {
    new Headers().set(name, 'x');
    return true;
  } catch {
    return false;
  }
}

/** True for an object exposing both redaction members. */
function isRedactionService(value: unknown): value is IRedactionService {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Record<'redactValue' | 'redactRecord', unknown>>;
  return typeof candidate.redactValue === 'function' &&
    typeof candidate.redactRecord === 'function';
}

/** Validates a `key` source and names the failing field. */
function validateRouteKeySource(key: IdempotencyKeySource): void {
  if (typeof key === 'function') return;
  if ('header' in key) {
    if (typeof key.header !== 'string' || !isValidHeaderName(key.header)) {
      throw new IdempotencyConfigurationError(
        'key.header',
        'idempotency: key.header is not a valid header name',
      );
    }
    return;
  }
  if ('bodyField' in key) {
    if (
      typeof key.bodyField !== 'string' ||
      !isTextWithoutControls(key.bodyField, 1, MAX_BODY_FIELD_CHARS)
    ) {
      throw new IdempotencyConfigurationError(
        'key.bodyField',
        'idempotency: key.bodyField must be 1 to 256 characters',
      );
    }
    return;
  }
  throw new IdempotencyConfigurationError(
    'key',
    'idempotency: key must be a header, a bodyField, or a function',
  );
}

/**
 * Validates a route option set's SHAPE, each field alone.
 *
 * @param options - The route option set
 * @throws {IdempotencyConfigurationError} When a field is invalid
 */
export function validateRouteOptionShape(options: IdempotentRouteOptions): void {
  if (options.key !== undefined) validateRouteKeySource(options.key);
  if (options.required !== undefined && typeof options.required !== 'boolean') {
    throw new IdempotencyConfigurationError('required', 'idempotency: required must be a boolean');
  }
  if (
    options.principal !== undefined && options.principal !== 'required' &&
    options.principal !== 'optional'
  ) {
    throw new IdempotencyConfigurationError(
      'principal',
      "idempotency: principal must be 'required' or 'optional'",
    );
  }
  if (options.namespace !== undefined) {
    if (
      typeof options.namespace !== 'string' ||
      !isTextWithoutControls(options.namespace, 1, MAX_NAMESPACE_CHARS)
    ) {
      throw new IdempotencyConfigurationError(
        'namespace',
        'idempotency: namespace must be 1 to 256 characters with no control characters',
      );
    }
  }
  if (
    options.fingerprint !== undefined && options.fingerprint !== 'request' &&
    typeof options.fingerprint !== 'function'
  ) {
    throw new IdempotencyConfigurationError(
      'fingerprint',
      "idempotency: fingerprint must be 'request' or a function",
    );
  }
  if (options.leaseMs !== undefined && !isIntInRange(options.leaseMs, 1, MAX_LEASE_MS)) {
    throw new IdempotencyConfigurationError('leaseMs', 'idempotency: leaseMs is out of range');
  }
  if (options.ttlMs !== undefined && !isIntInRange(options.ttlMs, 1, MAX_TTL_MS)) {
    throw new IdempotencyConfigurationError('ttlMs', 'idempotency: ttlMs is out of range');
  }
  if (
    options.response !== undefined && options.response !== 'full' && options.response !== 'status'
  ) {
    throw new IdempotencyConfigurationError(
      'response',
      "idempotency: response must be 'full' or 'status'",
    );
  }
  if (
    options.maxResponseBytes !== undefined &&
    !isIntInRange(options.maxResponseBytes, 0, MAX_RESPONSE_BYTES)
  ) {
    throw new IdempotencyConfigurationError(
      'maxResponseBytes',
      'idempotency: maxResponseBytes is out of range',
    );
  }
  if (options.replayHeaders !== undefined) {
    if (!Array.isArray(options.replayHeaders)) {
      throw new IdempotencyConfigurationError(
        'replayHeaders',
        'idempotency: replayHeaders must be an array',
      );
    }
    for (const name of options.replayHeaders) {
      if (typeof name !== 'string' || !isValidHeaderName(name)) {
        throw new IdempotencyConfigurationError(
          'replayHeaders',
          'idempotency: a replayHeaders entry is not a valid header name',
        );
      }
      if (REPLAY_HEADER_DENY_SET.has(name.toLowerCase())) {
        throw new IdempotencyConfigurationError(
          'replayHeaders',
          'idempotency: a replayHeaders entry is on the replay deny list',
        );
      }
    }
  }
  if (options.redaction !== undefined && !isRedactionService(options.redaction)) {
    if (typeof options.redaction !== 'object' || options.redaction === null) {
      throw new IdempotencyConfigurationError(
        'redaction',
        'idempotency: redaction must be a policy or service',
      );
    }
  }
}

/** Validates the `topics` / `jobNames` allow-list of an ingress option set. */
function validateIngressTargets(options: IdempotentIngressOptions): void {
  const topics = options.topics;
  const jobNames = options.jobNames;
  if (topics === undefined && jobNames === undefined) {
    throw new IdempotencyConfigurationError(
      'topics',
      'idempotency: idempotentIngress needs a non-empty topics or jobNames list',
    );
  }
  for (const [field, list] of [['topics', topics], ['jobNames', jobNames]] as const) {
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length === 0) {
      throw new IdempotencyConfigurationError(
        field,
        `idempotency: ${field} must be a non-empty array`,
      );
    }
    if (list.length > MAX_INGRESS_TARGETS) {
      throw new IdempotencyConfigurationError(field, `idempotency: ${field} has too many entries`);
    }
    for (const entry of list) {
      if (typeof entry !== 'string' || !isTextWithoutControls(entry, 1, MAX_INGRESS_TARGET_CHARS)) {
        throw new IdempotencyConfigurationError(field, `idempotency: a ${field} entry is invalid`);
      }
    }
  }
}

/**
 * Validates an ingress option set's SHAPE, each field alone.
 *
 * @param options - The ingress option set
 * @throws {IdempotencyConfigurationError} When a field is invalid
 */
export function validateIngressOptionShape(options: IdempotentIngressOptions): void {
  validateIngressTargets(options);
  const key = options.key;
  if (
    key !== undefined && key !== 'auto' && key !== 'job-id' && key !== 'deduplication-header' &&
    typeof key !== 'function'
  ) {
    throw new IdempotencyConfigurationError('key', 'idempotency: ingress key source is invalid');
  }
  const fingerprint = options.fingerprint;
  if (fingerprint !== undefined && fingerprint !== 'payload' && typeof fingerprint !== 'function') {
    throw new IdempotencyConfigurationError(
      'fingerprint',
      "idempotency: fingerprint must be 'payload' or a function",
    );
  }
  if (options.scope !== undefined && typeof options.scope !== 'function') {
    throw new IdempotencyConfigurationError('scope', 'idempotency: scope must be a function');
  }
  if (options.leaseMs !== undefined && !isIntInRange(options.leaseMs, 1, MAX_LEASE_MS)) {
    throw new IdempotencyConfigurationError(
      'leaseMs',
      'idempotency: ingress leaseMs is out of range',
    );
  }
  if (options.ttlMs !== undefined && !isIntInRange(options.ttlMs, 1, MAX_TTL_MS)) {
    throw new IdempotencyConfigurationError('ttlMs', 'idempotency: ttlMs is out of range');
  }
}

/** Validates the `memory` store arm. */
function validateMemoryConfig(config: Extract<IdempotencyStoreConfig, { type: 'memory' }>): void {
  const maxEntries = config.maxEntries ?? DEFAULT_MEMORY_MAX_ENTRIES;
  if (config.maxEntries !== undefined && !isIntInRange(config.maxEntries, 1, MAX_MEMORY_ENTRIES)) {
    throw new IdempotencyConfigurationError(
      'store.maxEntries',
      'idempotency: store.maxEntries is out of range',
    );
  }
  if (
    config.maxEntriesPerScope !== undefined &&
    !isIntInRange(config.maxEntriesPerScope, 1, maxEntries)
  ) {
    throw new IdempotencyConfigurationError(
      'store.maxEntriesPerScope',
      'idempotency: store.maxEntriesPerScope must be 1 to store.maxEntries',
    );
  }
  if (
    config.maxBytes !== undefined &&
    !isIntInRange(config.maxBytes, MIN_MEMORY_BYTES, MAX_MEMORY_BYTES)
  ) {
    throw new IdempotencyConfigurationError(
      'store.maxBytes',
      'idempotency: store.maxBytes is out of range',
    );
  }
}

/** Validates the shared `redis` fields and the `keyPrefix`. */
function validateRedisCommon(namespace: string, keyPrefix: string | undefined): void {
  if (typeof namespace !== 'string' || !STORE_NAMESPACE_PATTERN.test(namespace)) {
    throw new IdempotencyConfigurationError(
      'store.namespace',
      'idempotency: store.namespace must match ^[a-z0-9][a-z0-9._-]{0,63}$',
    );
  }
  if (keyPrefix !== undefined && !isPrintableAscii(keyPrefix, 1, MAX_KEY_PREFIX_CHARS)) {
    throw new IdempotencyConfigurationError(
      'store.keyPrefix',
      'idempotency: store.keyPrefix is invalid',
    );
  }
}

/** Validates a store configuration, naming the failing option path. */
function validateStoreConfig(config: IdempotencyStoreConfig): void {
  if (config.type === 'memory') {
    validateMemoryConfig(config);
    return;
  }
  if (config.type === 'custom') {
    const store = config.store;
    if (typeof store !== 'object' || store === null) {
      throw new IdempotencyConfigurationError(
        'store.store',
        'idempotency: store.store must be an IIdempotencyStore',
      );
    }
    const candidate = store as Partial<
      Record<'name' | 'connect' | 'claim' | 'complete' | 'release', unknown>
    >;
    if (
      typeof candidate.name !== 'string' || typeof candidate.connect !== 'function' ||
      typeof candidate.claim !== 'function' || typeof candidate.complete !== 'function' ||
      typeof candidate.release !== 'function'
    ) {
      throw new IdempotencyConfigurationError(
        'store.store',
        'idempotency: store.store must be an IIdempotencyStore',
      );
    }
    return;
  }
  if ('client' in config && config.client !== undefined) {
    validateRedisCommon(config.namespace, config.keyPrefix);
    validateInjectedClient(config.client);
    return;
  }
  const built = config as Extract<IdempotencyStoreConfig, { type: 'redis'; url: string }>;
  validateRedisCommon(built.namespace, built.keyPrefix);
  if (typeof built.url !== 'string' || built.url.length === 0) {
    throw new IdempotencyConfigurationError(
      'store.url',
      'idempotency: store.url must be a non-empty string',
    );
  }
  if (
    built.commandTimeoutMs !== undefined && !isIntInRange(built.commandTimeoutMs, 0, MAX_TIMEOUT_MS)
  ) {
    throw new IdempotencyConfigurationError(
      'store.commandTimeoutMs',
      'idempotency: store.commandTimeoutMs is out of range',
    );
  }
}

/** Validates the tier-C `transactional` option set's shape (M109b §3.5, §3.13). */
function validateTransactionalShape(transactional: TransactionalIdempotencyOptions): void {
  if (typeof transactional !== 'object' || transactional === null) {
    throw new IdempotencyConfigurationError(
      'transactional',
      'idempotency: transactional must be an options object',
    );
  }
  const entry = transactional.store;
  if (
    entry === undefined || entry === null ||
    (typeof entry !== 'object' && typeof entry !== 'function')
  ) {
    throw new IdempotencyConfigurationError(
      'transactional.store',
      'idempotency: transactional.store must be an ITransactionalIdempotencyStore or a factory',
    );
  }
  if (typeof entry === 'object') {
    const candidate = entry as Partial<
      Record<'find' | 'run' | 'purge' | 'verify', unknown>
    >;
    if (
      typeof candidate.find !== 'function' || typeof candidate.run !== 'function' ||
      typeof candidate.purge !== 'function' || typeof candidate.verify !== 'function'
    ) {
      throw new IdempotencyConfigurationError(
        'transactional.store',
        'idempotency: transactional.store must be an ITransactionalIdempotencyStore',
      );
    }
  }
  if (
    transactional.ttlMs !== undefined &&
    !isIntInRange(transactional.ttlMs, MIN_WITHIN_TTL_MS, MAX_TTL_MS)
  ) {
    throw new IdempotencyConfigurationError(
      'transactional.ttlMs',
      'idempotency: transactional.ttlMs is out of range',
    );
  }
  if (
    transactional.storeTimeoutMs !== undefined &&
    !isIntInRange(transactional.storeTimeoutMs, 1, MAX_TIMEOUT_MS)
  ) {
    throw new IdempotencyConfigurationError(
      'transactional.storeTimeoutMs',
      'idempotency: transactional.storeTimeoutMs is out of range',
    );
  }
  if (
    transactional.maxResultBytes !== undefined &&
    !isIntInRange(transactional.maxResultBytes, 2, MAX_RESULT_BYTES)
  ) {
    throw new IdempotencyConfigurationError(
      'transactional.maxResultBytes',
      'idempotency: transactional.maxResultBytes is out of range',
    );
  }
  const purge = transactional.purge;
  if (purge === undefined) return;
  if (typeof purge !== 'object' || purge === null) {
    throw new IdempotencyConfigurationError(
      'transactional.purge',
      'idempotency: transactional.purge must be an options object',
    );
  }
  if (purge.schedule !== undefined && typeof purge.schedule !== 'boolean') {
    throw new IdempotencyConfigurationError(
      'transactional.purge.schedule',
      'idempotency: transactional.purge.schedule must be a boolean',
    );
  }
  if (
    purge.intervalMs !== undefined && !isIntInRange(purge.intervalMs, 1, MAX_TIMEOUT_MS)
  ) {
    throw new IdempotencyConfigurationError(
      'transactional.purge.intervalMs',
      'idempotency: transactional.purge.intervalMs is out of range',
    );
  }
  if (purge.batch !== undefined && !isIntInRange(purge.batch, 1, MAX_PURGE_BATCH)) {
    throw new IdempotencyConfigurationError(
      'transactional.purge.batch',
      'idempotency: transactional.purge.batch is out of range',
    );
  }
}

/**
 * Validates a plugin option set's SHAPE, each field alone.
 *
 * @param options - The plugin option set
 * @throws {IdempotencyConfigurationError} When a field is invalid
 */
export function validatePluginOptionShape(options: IdempotencyPluginOptions): void {
  if (options.leaseMs !== undefined && !isIntInRange(options.leaseMs, 1, MAX_LEASE_MS)) {
    throw new IdempotencyConfigurationError('leaseMs', 'idempotency: leaseMs is out of range');
  }
  if (
    options.ingressLeaseMs !== undefined && !isIntInRange(options.ingressLeaseMs, 1, MAX_LEASE_MS)
  ) {
    throw new IdempotencyConfigurationError(
      'ingressLeaseMs',
      'idempotency: ingressLeaseMs is out of range',
    );
  }
  if (options.ttlMs !== undefined && !isIntInRange(options.ttlMs, 1, MAX_TTL_MS)) {
    throw new IdempotencyConfigurationError('ttlMs', 'idempotency: ttlMs is out of range');
  }
  if (
    options.maxResponseBytes !== undefined &&
    !isIntInRange(options.maxResponseBytes, 0, MAX_RESPONSE_BYTES)
  ) {
    throw new IdempotencyConfigurationError(
      'maxResponseBytes',
      'idempotency: maxResponseBytes is out of range',
    );
  }
  if (options.store !== undefined) {
    if (typeof options.store !== 'object' || options.store === null) {
      throw new IdempotencyConfigurationError(
        'store',
        'idempotency: store must be a store configuration',
      );
    }
    validateStoreConfig(options.store);
  }
  if (options.transactional !== undefined) validateTransactionalShape(options.transactional);
}

/** Applies the plugin defaults to a plugin option set. */
export function resolveDefaults(
  options: IdempotencyPluginOptions | undefined,
): IdempotencyDefaults {
  const resolved: IdempotencyDefaults = {
    leaseMs: options?.leaseMs ?? DEFAULT_HTTP_LEASE_MS,
    ingressLeaseMs: options?.ingressLeaseMs ?? DEFAULT_INGRESS_LEASE_MS,
    ttlMs: options?.ttlMs ?? DEFAULT_TTL_MS,
    maxResponseBytes: options?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  };
  if (resolved.ttlMs < resolved.leaseMs || resolved.ttlMs < resolved.ingressLeaseMs) {
    throw new IdempotencyConfigurationError(
      'ttlMs',
      'idempotency: ttlMs must be at least the lease',
    );
  }
  return resolved;
}

/** Builds the redaction service once, from a policy or an already-built service. */
function buildRedaction(
  redaction: RedactionPolicy | IRedactionService | undefined,
): IRedactionService | undefined {
  if (redaction === undefined) return undefined;
  if (isRedactionService(redaction)) return redaction;
  return createRedactionService(redaction);
}

/**
 * Resolves a route option set against the plugin defaults and checks
 * cross-field rules.
 *
 * @param options - The route option set
 * @param defaults - The plugin defaults
 * @returns The resolved route options
 * @throws {IdempotencyConfigurationError} When shape or a cross-field rule fails
 */
export function resolveRouteOptions(
  options: IdempotentRouteOptions | undefined,
  defaults: IdempotencyDefaults,
): ResolvedRouteOptions {
  const source = options ?? {};
  validateRouteOptionShape(source);
  const leaseMs = source.leaseMs ?? defaults.leaseMs;
  const ttlMs = source.ttlMs ?? defaults.ttlMs;
  if (ttlMs < leaseMs) {
    throw new IdempotencyConfigurationError('ttlMs', 'idempotency: ttlMs must be at least leaseMs');
  }
  return {
    key: source.key ?? { header: IDEMPOTENCY_KEY_HEADER },
    required: source.required ?? true,
    principal: source.principal ?? 'required',
    namespace: source.namespace,
    fingerprint: source.fingerprint ?? 'request',
    leaseMs,
    ttlMs,
    response: source.response ?? 'full',
    maxResponseBytes: source.maxResponseBytes ?? defaults.maxResponseBytes,
    replayHeaders: (source.replayHeaders ?? []).map((name) => name.toLowerCase()),
    redaction: buildRedaction(source.redaction),
  };
}

/**
 * Resolves an ingress option set against the plugin defaults and checks
 * cross-field rules.
 *
 * @param options - The ingress option set
 * @param defaults - The plugin defaults
 * @returns The resolved ingress options
 * @throws {IdempotencyConfigurationError} When shape or a cross-field rule fails
 */
export function resolveIngressOptions(
  options: IdempotentIngressOptions,
  defaults: IdempotencyDefaults,
): ResolvedIngressOptions {
  validateIngressOptionShape(options);
  const leaseMs = options.leaseMs ?? defaults.ingressLeaseMs;
  const ttlMs = options.ttlMs ?? defaults.ttlMs;
  if (ttlMs < leaseMs) {
    throw new IdempotencyConfigurationError(
      'ttlMs',
      'idempotency: ttlMs must be at least the ingress lease',
    );
  }
  return {
    key: options.key ?? 'auto',
    fingerprint: options.fingerprint ?? 'payload',
    scope: options.scope,
    leaseMs,
    ttlMs,
    topics: options.topics ?? [],
    jobNames: options.jobNames ?? [],
  };
}
