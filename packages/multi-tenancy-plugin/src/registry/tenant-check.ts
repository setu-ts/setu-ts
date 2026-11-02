/**
 * The ONE tenant check — run by the tenant middleware for every resolved id
 * and by `IMultiTenancyService.lookupTenant`, so a queue handler validating a
 * payload's tenant gets the answer the HTTP path would give. Internal: not
 * exported from `src/index.ts`.
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

/**
 * Reports whether a registry answer is a well-formed `Option<ITenant>`: the
 * `none()` shape, or a `some` whose value carries a non-empty string id.
 */
function isWellFormed(answer: unknown): answer is Option<ITenant> {
  if (typeof answer !== 'object' || answer === null) return false;
  const option = answer as { present?: unknown; value?: unknown };
  if (option.present === false) return true;
  if (option.present !== true) return false;
  const value = option.value as { id?: unknown } | null | undefined;
  return (
    typeof value === 'object' && value !== null && typeof value.id === 'string' && value.id !== ''
  );
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
   * @returns `some(tenant)` to admit with the registry's tenant, `none()` to refuse
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
      );
    }
    let answer: unknown;
    try {
      answer = await registry.lookup(id);
    } catch (cause) {
      throw this.#fault(
        new TenantRegistryUnavailableError('The tenant registry lookup threw', { cause }),
      );
    }
    if (!isWellFormed(answer)) {
      throw this.#fault(
        new TenantRegistryUnavailableError(
          'The tenant registry returned a malformed answer (expected none() or some({ id }))',
          { cause: answer },
        ),
      );
    }
    if (this.#failing) {
      this.#failing = false;
      this.#logger?.info(REGISTRY_RECOVERED_LOG);
    }
    return answer;
  }

  /** Logs the healthy→failing transition once, then returns the error to throw. */
  #fault(error: TenantRegistryUnavailableError): TenantRegistryUnavailableError {
    if (!this.#failing) {
      this.#failing = true;
      this.#logger?.warn(REGISTRY_FAULT_LOG, { error: describeError(error.cause ?? error) });
    }
    return error;
  }
}
