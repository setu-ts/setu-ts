/**
 * Parses and validates the three registry options — `tenants`,
 * `unknownTenantStatus` and `tenantCache` — once, at `register()`. Internal:
 * not exported from `src/index.ts`.
 *
 * @module
 */
import type { ITenant, ITenantRegistry, RegistryFactory } from '@setu-ts/common';
import type { MultiTenancyPluginOptions } from '../interfaces/index.ts';
import {
  type CachingTenantRegistryLimits,
  DEFAULT_TENANT_CACHE_MAX_BYTES,
  DEFAULT_TENANT_CACHE_MAX_ENTRIES,
  DEFAULT_TENANT_CACHE_TTL_MS,
} from './caching-tenant-registry.ts';
import { StaticTenantRegistry } from './static-tenant-registry.ts';

/** Default status of the `Unknown Tenant` refusal. */
export const DEFAULT_UNKNOWN_TENANT_STATUS = 404;

/** The parsed registry configuration. */
export type ParsedTenantRegistry =
  | { readonly kind: 'none' }
  | { readonly kind: 'static'; readonly registry: ITenantRegistry }
  | {
      readonly kind: 'custom';
      readonly registry: ITenantRegistry;
      readonly cache: CachingTenantRegistryLimits | undefined;
    }
  | {
      readonly kind: 'factory';
      readonly factory: RegistryFactory<ITenantRegistry>;
      readonly cache: CachingTenantRegistryLimits | undefined;
    };

/** All three options, parsed. */
export interface ParsedRegistryOptions {
  readonly registry: ParsedTenantRegistry;
  readonly unknownTenantStatus: number;
}

/**
 * Refuses a value that is not an `ITenantRegistry`.
 *
 * @param value - The instance, or a factory's result
 * @param where - Which arm produced it, for the message
 * @throws {Error} Naming `MultiTenancyPlugin.tenants` when `lookup` is not a function
 */
export function assertUsableRegistry(
  value: unknown,
  where: string,
): asserts value is ITenantRegistry {
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof (value as { lookup?: unknown }).lookup !== 'function'
  ) {
    throw new Error(
      `MultiTenancyPlugin.tenants: ${where} is not an ITenantRegistry (it has no lookup method).`,
    );
  }
}

/** Validates one numeric `tenantCache` field. */
function cacheField(
  value: number | undefined,
  name: string,
  min: number,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw new Error(`MultiTenancyPlugin: tenantCache.${name} must be a finite integer >= ${min}.`);
  }
  return value;
}

/** Resolves `tenantCache` for an instance or factory registry. */
function parseCache(
  option: MultiTenancyPluginOptions['tenantCache'],
): CachingTenantRegistryLimits | undefined {
  if (option === false) return undefined;
  if (option !== undefined && (typeof option !== 'object' || option === null)) {
    throw new Error('MultiTenancyPlugin: tenantCache must be false or an options object.');
  }
  const ttlMs = cacheField(option?.ttlMs, 'ttlMs', 0, DEFAULT_TENANT_CACHE_TTL_MS);
  if (ttlMs === 0) return undefined;
  return {
    ttlMs,
    maxEntries: cacheField(option?.maxEntries, 'maxEntries', 1, DEFAULT_TENANT_CACHE_MAX_ENTRIES),
    maxBytes: cacheField(option?.maxBytes, 'maxBytes', 1, DEFAULT_TENANT_CACHE_MAX_BYTES),
  };
}

/**
 * Parses the registry options.
 *
 * @param options - The plugin options
 * @returns The parsed registry and the unknown-tenant status
 * @throws {Error} Naming the option, for every refusal in the plan (§3.2,
 * §3.5, §3.7)
 */
export function parseRegistryOptions(options: MultiTenancyPluginOptions): ParsedRegistryOptions {
  const { tenants, tenantCache, unknownTenantStatus } = options;

  if (tenants === undefined) {
    if (unknownTenantStatus !== undefined) {
      throw new Error(
        'MultiTenancyPlugin: unknownTenantStatus is set but `tenants` is not; it would configure nothing.',
      );
    }
    if (tenantCache !== undefined) {
      throw new Error(
        'MultiTenancyPlugin: tenantCache is set but `tenants` is not; it would configure nothing.',
      );
    }
    return { registry: { kind: 'none' }, unknownTenantStatus: DEFAULT_UNKNOWN_TENANT_STATUS };
  }

  const status = unknownTenantStatus ?? DEFAULT_UNKNOWN_TENANT_STATUS;
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 400 || status > 499) {
    throw new Error('MultiTenancyPlugin: unknownTenantStatus must be an integer in 400-499.');
  }

  if (Array.isArray(tenants)) {
    if (tenantCache !== undefined) {
      throw new Error(
        'MultiTenancyPlugin: tenantCache does not apply to a `tenants` list (it is already in memory).',
      );
    }
    return {
      registry: {
        kind: 'static',
        registry: new StaticTenantRegistry(tenants as readonly (string | ITenant)[]),
      },
      unknownTenantStatus: status,
    };
  }

  const cache = parseCache(tenantCache);
  if (typeof tenants === 'function') {
    return {
      registry: { kind: 'factory', factory: tenants as RegistryFactory<ITenantRegistry>, cache },
      unknownTenantStatus: status,
    };
  }

  assertUsableRegistry(tenants, 'the instance');
  return { registry: { kind: 'custom', registry: tenants, cache }, unknownTenantStatus: status };
}
