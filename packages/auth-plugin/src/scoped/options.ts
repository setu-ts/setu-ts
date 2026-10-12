/**
 * Validates `AuthPluginOptions.scopedRbac` when `AuthPlugin(...)` is called,
 * and compiles it into the read-once form the evaluator uses.
 *
 * Every refusal is an `AuthPluginConfigurationError`, before any application
 * exists (M110b plan §3.2). Every bound refuses `NaN` and non-integers — an
 * unset environment variable read through `Number(...)` is `NaN`, and a
 * bound that silently disabled itself would fail open (the M90a lesson).
 *
 * Internal: not exported from the package barrel.
 *
 * @module
 */
import { isScopeType } from '@setu-ts/common';
import type {
  IGrantSource,
  IScopedRoleSource,
  RbacConfig,
  RegistryFactory,
  ScopedGrant,
  ScopeRef,
} from '@setu-ts/common';
import { AuthPluginConfigurationError } from '../errors.ts';
import type { ClaimsGrantMapper, ScopedRbacOptions } from '../interfaces/index.ts';
import { readGrant, readName } from './model.ts';

/** The wildcard permission: a grant-side shorthand, never a checkable ability. */
export const WILDCARD = '*';

/** One catalogue role's transitive closure. */
export interface CatalogueRole {
  /** Every permission the role grants, directly or through inheritance. */
  readonly permissions: ReadonlySet<string>;
  /** Every role the role inherits, transitively. */
  readonly inherits: ReadonlySet<string>;
}

/** A compiled grant source. */
export type CompiledSource =
  | {
    readonly kind: 'static';
    readonly name: string;
    readonly bySubject: ReadonlyMap<string, readonly ScopedGrant[]>;
  }
  | { readonly kind: 'claims'; readonly name: string; readonly map: ClaimsGrantMapper }
  | { readonly kind: 'custom'; readonly source: IGrantSource | RegistryFactory<IGrantSource> };

/** The compiled timing mode. */
export type CompiledTiming =
  | { readonly kind: 'request' }
  | { readonly kind: 'sign-in' }
  | { readonly kind: 'cache'; readonly ttlMs: number; readonly maxEntries: number };

/** A compiled per-role limit. */
export interface CompiledLimit {
  /** The scope types a grant of the role counts in. */
  readonly scopeTypes: ReadonlySet<string>;
  /** Whether a global grant of the role counts. */
  readonly global: boolean;
}

/** `scopedRbac` after validation. */
export interface CompiledScopedRbac {
  /** Catalogue roles, keyed by name. A `Map`, so `constructor` is never a key. */
  readonly roles: ReadonlyMap<string, CatalogueRole>;
  /** Every checkable catalogue permission (never the wildcard). */
  readonly permissions: ReadonlySet<string>;
  /** The grant sources, in declaration order. */
  readonly sources: readonly CompiledSource[];
  /** The scope inheritance resolver, when configured. */
  readonly inheritsFrom:
    | ((scope: ScopeRef, signal: AbortSignal) => readonly ScopeRef[] | Promise<readonly ScopeRef[]>)
    | undefined;
  /** The scope type compared against the request tenant. */
  readonly tenantScopeType: string;
  /** Per-role limits, keyed by catalogue role. */
  readonly limits: ReadonlyMap<string, CompiledLimit>;
  /** The custom-role source, when configured. */
  readonly customRoles: IScopedRoleSource | RegistryFactory<IScopedRoleSource> | undefined;
  /** When grants are resolved. */
  readonly timing: CompiledTiming;
  /** Deadline on every source and resolver call, in milliseconds. */
  readonly sourceTimeoutMs: number;
  /** The most grants one resolution may return. */
  readonly maxGrants: number;
  /** The deepest inheritance walk. */
  readonly maxScopeDepth: number;
  /** The most scopes one walk may visit. */
  readonly maxScopeNodes: number;
  /** The most custom roles one scope may define. */
  readonly maxCustomRoles: number;
  /** The most permissions one custom role may bundle. */
  readonly maxPermissionsPerRole: number;
}

function refuse(message: string): never {
  throw new AuthPluginConfigurationError(`auth-plugin: scopedRbac.${message}`);
}

/**
 * Reads an optional integer bound, refusing anything outside `[min, max]` —
 * including `NaN`, infinities and fractions.
 */
function bound(name: string, value: unknown, min: number, max: number, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    refuse(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/**
 * Builds each catalogue role's transitive closure. Each role is walked from its
 * own starting point with its own `seen` set, so a cyclic `inherits` cannot
 * cache an incomplete closure (the RbacService lesson). Lookups use
 * `Object.hasOwn`, so `constructor` is never a role.
 */
function buildCatalogue(rbac: RbacConfig): Map<string, CatalogueRole> {
  const definitions = rbac.roles;
  const catalogue = new Map<string, CatalogueRole>();
  for (const roleName of Object.keys(definitions)) {
    const permissions = new Set<string>();
    const inherits = new Set<string>();
    const seen = new Set<string>([roleName]);
    const stack = [roleName];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (!Object.hasOwn(definitions, current)) {
        continue;
      }
      const definition = definitions[current];
      for (const permission of definition.permissions ?? []) {
        permissions.add(permission);
      }
      for (const parent of definition.inherits ?? []) {
        inherits.add(parent);
        if (!seen.has(parent)) {
          seen.add(parent);
          stack.push(parent);
        }
      }
    }
    catalogue.set(roleName, { permissions, inherits });
  }
  return catalogue;
}

function compileSource(entry: unknown, index: number): CompiledSource {
  if (typeof entry !== 'object' || entry === null) {
    refuse(`sources[${index}] must be an object`);
  }
  const { kind } = entry as { readonly kind?: unknown };
  if (kind === 'static') {
    const { grants } = entry as { readonly grants?: unknown };
    if (!Array.isArray(grants)) {
      refuse(`sources[${index}].grants must be an array`);
    }
    const bySubject = new Map<string, ScopedGrant[]>();
    grants.forEach((raw: unknown, at: number) => {
      const subject = typeof raw === 'object' && raw !== null
        ? readName((raw as { readonly subject?: unknown }).subject)
        : undefined;
      const grant = readGrant(raw);
      if (subject === undefined || grant === undefined) {
        refuse(`sources[${index}].grants[${at}] is not a valid grant`);
      }
      const list = bySubject.get(subject) ?? [];
      list.push(grant);
      bySubject.set(subject, list);
    });
    return { kind: 'static', name: `static[${index}]`, bySubject };
  }
  if (kind === 'claims') {
    const { map } = entry as { readonly map?: unknown };
    if (typeof map !== 'function') {
      refuse(`sources[${index}].map must be a function`);
    }
    return { kind: 'claims', name: `claims[${index}]`, map: map as ClaimsGrantMapper };
  }
  if (kind === 'custom') {
    const { source } = entry as { readonly source?: unknown };
    const isFactory = typeof source === 'function';
    const isSource = typeof source === 'object' && source !== null &&
      typeof (source as { readonly grantsFor?: unknown }).grantsFor === 'function';
    if (!isFactory && !isSource) {
      refuse(`sources[${index}].source must be an IGrantSource or a factory returning one`);
    }
    return {
      kind: 'custom',
      source: source as IGrantSource | RegistryFactory<IGrantSource>,
    };
  }
  refuse(`sources[${index}].kind must be 'static', 'claims' or 'custom'`);
}

function compileTiming(timing: unknown): CompiledTiming {
  if (timing === undefined || timing === 'request') {
    return { kind: 'request' };
  }
  if (timing === 'sign-in') {
    return { kind: 'sign-in' };
  }
  if (
    typeof timing === 'object' && timing !== null &&
    (timing as { readonly kind?: unknown }).kind === 'cache'
  ) {
    const { ttlMs, maxEntries } = timing as {
      readonly ttlMs?: unknown;
      readonly maxEntries?: unknown;
    };
    if (ttlMs === undefined || maxEntries === undefined) {
      refuse('timing cache needs both ttlMs and maxEntries');
    }
    return {
      kind: 'cache',
      ttlMs: bound('timing.ttlMs', ttlMs, 1_000, 3_600_000, 0),
      maxEntries: bound('timing.maxEntries', maxEntries, 1, 100_000, 0),
    };
  }
  refuse("timing must be 'request', 'sign-in' or { kind: 'cache', ttlMs, maxEntries }");
}

function compileLimits(
  grantableIn: unknown,
  roles: ReadonlyMap<string, CatalogueRole>,
): Map<string, CompiledLimit> {
  const limits = new Map<string, CompiledLimit>();
  if (grantableIn === undefined) {
    return limits;
  }
  if (typeof grantableIn !== 'object' || grantableIn === null || Array.isArray(grantableIn)) {
    refuse('grantableIn must be an object keyed by role');
  }
  for (const [role, raw] of Object.entries(grantableIn)) {
    if (!roles.has(role)) {
      refuse(`grantableIn names ${JSON.stringify(role)}, which is not an rbac role`);
    }
    const { scopeTypes, global } = (raw ?? {}) as {
      readonly scopeTypes?: unknown;
      readonly global?: unknown;
    };
    if (!Array.isArray(scopeTypes) || !scopeTypes.every((type) => isScopeType(type))) {
      refuse(`grantableIn.${role}.scopeTypes must be an array of lowercase kebab-case scope types`);
    }
    if (global !== undefined && typeof global !== 'boolean') {
      refuse(`grantableIn.${role}.global must be a boolean`);
    }
    if (scopeTypes.length === 0 && global !== true) {
      refuse(`grantableIn.${role} makes the role grantable nowhere`);
    }
    limits.set(role, { scopeTypes: new Set(scopeTypes as string[]), global: global === true });
  }
  return limits;
}

/**
 * Validates and compiles `scopedRbac`.
 *
 * @param options - The `scopedRbac` option
 * @param rbac - The `rbac` option, whose roles are the catalogue
 * @param signInConfigured - Whether `signIn` is configured (required by `'sign-in'` timing)
 * @returns The compiled configuration
 * @throws {AuthPluginConfigurationError} On any refusal in plan §3.2/§3.13
 */
export function compileScopedRbac(
  options: ScopedRbacOptions,
  rbac: RbacConfig | undefined,
  signInConfigured: boolean,
): CompiledScopedRbac {
  if (typeof options !== 'object' || options === null) {
    refuse('must be an object');
  }
  if (rbac === undefined) {
    throw new AuthPluginConfigurationError(
      'auth-plugin: scopedRbac requires rbac — its roles are the scoped RBAC catalogue',
    );
  }
  const roles = buildCatalogue(rbac);
  if (roles.size === 0) {
    refuse('requires at least one rbac role — the catalogue is empty');
  }

  const permissions = new Set<string>();
  for (const role of roles.values()) {
    for (const permission of role.permissions) {
      permissions.add(permission);
    }
  }
  if (options.permissions !== undefined) {
    if (!Array.isArray(options.permissions)) {
      refuse('permissions must be an array of permission names');
    }
    for (const permission of options.permissions) {
      if (readName(permission) === undefined) {
        refuse('permissions must be an array of non-empty permission names');
      }
      permissions.add(permission);
    }
  }
  permissions.delete(WILDCARD);

  const rawSources: unknown = options.sources;
  if (!Array.isArray(rawSources) || rawSources.length === 0) {
    refuse('sources must name at least one grant source');
  }
  const sources = rawSources.map((entry: unknown, index: number) => compileSource(entry, index));

  const inheritsFrom = options.inheritsFrom;
  if (inheritsFrom !== undefined && typeof inheritsFrom !== 'function') {
    refuse('inheritsFrom must be a function');
  }

  const tenantScopeType = options.tenantScopeType ?? 'tenant';
  if (!isScopeType(tenantScopeType)) {
    refuse('tenantScopeType must be a lowercase kebab-case scope type');
  }

  const customRoles = options.customRoles;
  if (
    customRoles !== undefined && typeof customRoles !== 'function' &&
    (typeof customRoles !== 'object' || customRoles === null ||
      typeof (customRoles as { readonly rolesFor?: unknown }).rolesFor !== 'function')
  ) {
    refuse('customRoles must be an IScopedRoleSource or a factory returning one');
  }

  const timing = compileTiming(options.timing);
  if (timing.kind === 'sign-in' && !signInConfigured) {
    refuse("timing 'sign-in' requires the signIn option — grants are resolved at sign-in");
  }

  return {
    roles,
    permissions,
    sources,
    inheritsFrom,
    tenantScopeType,
    limits: compileLimits(options.grantableIn, roles),
    customRoles,
    timing,
    sourceTimeoutMs: bound('sourceTimeoutMs', options.sourceTimeoutMs, 1, 60_000, 2_000),
    maxGrants: bound('maxGrantsPerPrincipal', options.maxGrantsPerPrincipal, 1, 10_000, 256),
    maxScopeDepth: bound('maxScopeDepth', options.maxScopeDepth, 1, 64, 8),
    maxScopeNodes: bound('maxScopeNodes', options.maxScopeNodes, 1, 1_024, 32),
    maxCustomRoles: bound('maxCustomRoles', options.maxCustomRoles, 1, 10_000, 128),
    maxPermissionsPerRole: bound(
      'maxPermissionsPerRole',
      options.maxPermissionsPerRole,
      1,
      10_000,
      256,
    ),
  };
}
