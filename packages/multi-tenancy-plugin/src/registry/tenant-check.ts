/**
 * The ONE tenant check — run by the tenant middleware for every resolved id
 * and by `IMultiTenancyService.lookupTenant`, so a queue handler validating a
 * payload's tenant gets the answer the HTTP path would give. Internal: not
 * exported from `src/index.ts`.
 *
 * It also owns the ONE definition of a well-formed registry answer
 * ({@linkcode snapshotAnswer}), shared with the caching registry so the cache
 * can never store an answer the check would refuse.
 *
 * @module
 */
import type { ILogger, ITenant, ITenantRegistry, Option } from '@setu-ts/common';
import { describeError, none, some } from '@setu-ts/common';
import { TenantRegistryUnavailableError } from '../errors.ts';

/**
 * The longest tenant id (UTF-16 code units) ever handed to a registry. A
 * longer id is a miss without a lookup, so a header-sized string never reaches
 * a database query or a cache key — no resolver bounds the id itself.
 */
export const MAX_TENANT_ID_LENGTH = 256;

/** The `warn` emitted once per transition from healthy to failing. */
export const REGISTRY_FAULT_LOG =
  'Tenant registry lookup failed; requests naming a tenant answer 503';

/** The `info` emitted on the first success after a failure. */
export const REGISTRY_RECOVERED_LOG = 'Tenant registry lookups recovered';

/** What replaces the requested id wherever it appears in a logged registry error. */
export const MASKED_TENANT_ID = '<tenant-id>';

/** A plain (non-array) object, the only shape `metadata` may take. */
function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Builds the frozen tenant every request receives from a tenant-shaped value:
 * `id`, plus `name` when it is a string and `metadata` when it is a plain
 * object (itself a frozen shallow copy). Every member is read EXACTLY ONCE,
 * so a getter cannot pass validation with one value and serve another; any
 * other key on the value is dropped. Objects nested deeper inside `metadata`
 * are not copied — they stay the application's.
 *
 * @param value - The candidate tenant
 * @returns The frozen tenant, or `undefined` when `id` is not a non-empty string
 */
function snapshotTenant(value: unknown): ITenant | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const { id, name, metadata } = value as { id?: unknown; name?: unknown; metadata?: unknown };
  if (typeof id !== 'string' || id === '') return undefined;
  return Object.freeze({
    id,
    ...(typeof name === 'string' && { name }),
    ...(isPlainObject(metadata) && { metadata: Object.freeze({ ...metadata }) }),
  });
}

/**
 * Returns a frozen copy of a tenant — the static registry's storage form.
 *
 * @param tenant - The tenant to copy (its `id` already validated)
 * @returns A frozen copy no handler can mutate at the top level
 * @throws {TypeError} When `tenant.id` is not a non-empty string
 */
export function freezeTenant(tenant: ITenant): ITenant {
  const frozen = snapshotTenant(tenant);
  if (frozen === undefined) {
    throw new TypeError('A tenant needs a non-empty string id.');
  }
  return frozen;
}

/**
 * Validates and snapshots a registry answer — the single definition of
 * well-formed, used by the check and by the cache. Every member of the answer
 * and of its tenant is read once; a throwing accessor reads as malformed.
 *
 * @param answer - Whatever a registry's `lookup` resolved to
 * @returns `none()`, `some(frozenTenant)`, or `undefined` when malformed
 */
export function snapshotAnswer(answer: unknown): Option<ITenant> | undefined {
  try {
    if (typeof answer !== 'object' || answer === null) return undefined;
    const { present, value } = answer as { present?: unknown; value?: unknown };
    if (present === false) return none();
    if (present !== true) return undefined;
    const tenant = snapshotTenant(value);
    return tenant === undefined ? undefined : some(tenant);
  } catch {
    return undefined;
  }
}

/**
 * Removes the requested id from a logged description. A registry or driver
 * error may quote the bound value (`invalid input syntax for type uuid: "…"`),
 * so both the raw id and the id as `describeError` renders it — control
 * characters collapsed to spaces — are replaced.
 *
 * @param text - The description of the registry's error
 * @param id - The requested id
 * @returns The description with every occurrence of the id masked
 */
export function maskTenantId(text: string, id: string): string {
  const rendered = describeError(new Error(id))
    .replace(/^Error: /, '')
    .trim();
  let masked = text;
  for (const form of new Set([id, rendered])) {
    if (form !== '') masked = masked.split(form).join(MASKED_TENANT_ID);
  }
  return masked;
}

/**
 * Owns the whole admit/refuse decision for a tenant id, and the fault-state
 * logging. The registry is late-bound for the factory arm.
 */
export class TenantCheck {
  #registry: ITenantRegistry | undefined;
  readonly #configured: boolean;
  readonly #logger: ILogger | undefined;
  #failing = false;

  /**
   * @param options.configured - Whether a `tenants` registry is configured at
   * all; `false` means every id is admitted (the behaviour without `tenants`)
   * @param options.registry - The registry, when known at `register()`
   * @param options.logger - Receives the fault/recovery transitions
   */
  constructor(options: { configured: boolean; registry?: ITenantRegistry; logger?: ILogger }) {
    this.#configured = options.configured;
    this.#registry = options.registry;
    this.#logger = options.logger;
  }

  /** Binds a factory-built registry, from the plugin's `onInit`. */
  bind(registry: ITenantRegistry): void {
    this.#registry = registry;
  }

  /**
   * Checks a tenant id.
   *
   * @param id - The requested id (untrusted)
   * @returns `some(tenant)` — a fresh frozen snapshot holding only `id`,
   * `name` and `metadata` — to admit, `none()` to refuse
   * @throws {TenantRegistryUnavailableError} When the registry is not bound,
   * throws, or answers malformed
   */
  async check(id: string): Promise<Option<ITenant>> {
    if (!this.#configured) return some({ id });
    if (id.length > MAX_TENANT_ID_LENGTH) return none();
    const registry = this.#registry;
    if (registry === undefined) {
      throw this.#fault(
        new TenantRegistryUnavailableError(
          'MultiTenancyPlugin: the tenants factory is resolved in onInit; a lookup before onInit has no registry',
        ),
        id,
      );
    }
    let answer: unknown;
    try {
      answer = await registry.lookup(id);
    } catch (cause) {
      throw this.#fault(
        new TenantRegistryUnavailableError('The tenant registry lookup threw', { cause }),
        id,
      );
    }
    const snapshot = snapshotAnswer(answer);
    if (snapshot === undefined) {
      throw this.#fault(
        new TenantRegistryUnavailableError(
          'The tenant registry returned a malformed answer (expected none() or some({ id }))',
          { cause: answer },
        ),
        id,
      );
    }
    if (this.#failing) {
      this.#failing = false;
      this.#logger?.info(REGISTRY_RECOVERED_LOG);
    }
    return snapshot;
  }

  /** Logs the healthy→failing transition once (id masked), then returns the error to throw. */
  #fault(error: TenantRegistryUnavailableError, id: string): TenantRegistryUnavailableError {
    if (!this.#failing) {
      this.#failing = true;
      this.#logger?.warn(REGISTRY_FAULT_LOG, {
        error: maskTenantId(describeError(error.cause ?? error), id),
      });
    }
    return error;
  }
}
