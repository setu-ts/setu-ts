/**
 * Resolves the grants and custom roles a scoped check reads (M110b plan
 * §3.7, §3.11, §3.12, §3.13).
 *
 * Grants from every source are UNIONED; one source that rejects, throws,
 * answers a non-array or outlives the deadline fails the whole resolution.
 * Every grant is validated and copied; an invalid one is dropped and counted.
 *
 * Three layers keep the static and custom sources from being asked twice:
 *
 * - a per-request memo keyed by the request's `ctx.state` map — module-private,
 *   so a caller cannot hand the evaluator a memo of its own;
 * - an optional cross-request cache (`timing: { kind: 'cache' }`), keyed by
 *   the principal's id AND issuer plus the question, on the monotonic clock;
 * - in-flight coalescing: identical questions for the identical principal,
 *   asked concurrently, share one call. A timed-out repository query is
 *   abandoned but keeps running on the database, so this is what stops a slow
 *   backend receiving one more copy of the same query per concurrent request.
 *
 * A `claims` source is outside all three. Its grants come from the
 * credential, not the principal: two tokens for one `sub` and `iss` can carry
 * different claims, and a result keyed by the principal would hand one
 * token's grants to the other. So it is mapped on every resolution from the
 * claims being checked, which costs only the application's `map` call.
 *
 * Internal: not exported from the package barrel.
 *
 * @module
 */
import type {
  GrantQuery,
  IGrantSource,
  IPrincipal,
  IRequestContext,
  IScopedRoleSource,
  IServiceRegistry,
  RegistryFactory,
  ScopedGrant,
  ScopeRef,
} from '@setu-ts/common';
import type { CompiledScopedRbac, CompiledSource, CompiledTiming } from './options.ts';
import {
  errorNameOf,
  readGrant,
  readName,
  readScopeRef,
  ScopedDeadlineError,
  scopeKey,
} from './model.ts';
import type { Bounded, Failure } from './model.ts';
import type { GrantResolutionReason } from './errors.ts';

/** A resolved grant list, or why it could not be resolved. */
export type GrantsOutcome =
  | { readonly ok: true; readonly grants: readonly ScopedGrant[]; readonly dropped: number }
  | (Failure & { readonly reason: GrantResolutionReason });

/** Custom roles by defining scope key, then by role name. */
export type CustomRoleIndex = ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;

/** Resolved custom roles, or why they could not be resolved. */
export type CustomRolesOutcome =
  | { readonly ok: true; readonly roles: CustomRoleIndex; readonly dropped: number }
  | Failure;

/** A bound grant source: a name for logs, and the call. */
interface BoundSource {
  readonly name: string;
  readonly kind: 'static' | 'claims' | 'custom';
  fetch(principal: IPrincipal, query: GrantQuery, bounded: Bounded): Promise<unknown>;
}

/** What the resolver reads besides its configuration. */
export interface GrantResolverDeps {
  /** Runs a source call under the configured deadline. */
  readonly bounded: Bounded;
  /** The monotonic clock, in milliseconds (the cache's TTL clock). */
  readonly hrtime: () => number;
}

/**
 * The key two resolutions share only when they ask the same question for the
 * same principal: the id AND the `iss` claim, so one `sub` issued by two
 * identity providers never shares an entry.
 *
 * @param principal - The principal
 * @returns Its key
 */
export function principalKey(principal: IPrincipal): string {
  const iss = principal.claims?.iss;
  return JSON.stringify([principal.id, typeof iss === 'string' ? iss : null]);
}

function queryKey(query: GrantQuery): string {
  return query.kind === 'all' ? 'all' : JSON.stringify(query.scopes.map(scopeKey));
}

function unbound(): GrantsOutcome {
  return { ok: false, reason: 'source-failed', source: 'unbound' };
}

function isFactory<T extends object>(value: T | RegistryFactory<T>): value is RegistryFactory<T> {
  return typeof value === 'function';
}

/** Per-request memo maps, keyed by the request's own `state` map. */
const requestMemos = new WeakMap<Map<string, unknown>, Map<string, Promise<unknown>>>();

/**
 * Runs `compute` once per request for `key` (when there is a request), and
 * once per concurrent identical question across requests otherwise. A FAILED
 * outcome is memoised for the rest of the request too, so an all-of check
 * over two abilities asks a failing source once. The memo is module-private
 * and keyed by the request's own `state` map, so no caller can supply one.
 *
 * Internal: shared with the scope-chain walk; not exported from the barrel.
 *
 * @param context - The request, when there is one
 * @param key - The question's key; callers prefix it by kind
 * @param inflight - The caller's in-flight map, for cross-request coalescing
 * @param compute - Answers the question
 * @returns The answer
 */
export function memoised<T>(
  context: IRequestContext | undefined,
  key: string,
  inflight: Map<string, Promise<T>>,
  compute: () => Promise<T>,
): Promise<T> {
  const coalesced = (): Promise<T> => {
    const running = inflight.get(key);
    if (running !== undefined) {
      return running;
    }
    const started = compute().finally(() => inflight.delete(key));
    inflight.set(key, started);
    return started;
  };
  if (context === undefined) {
    return coalesced();
  }
  let memo = requestMemos.get(context.state);
  if (memo === undefined) {
    memo = new Map();
    requestMemos.set(context.state, memo);
  }
  const hit = memo.get(key) as Promise<T> | undefined;
  if (hit !== undefined) {
    return hit;
  }
  const started = coalesced();
  memo.set(key, started);
  return started;
}

function bindSource(entry: CompiledSource, services: IServiceRegistry, index: number): BoundSource {
  if (entry.kind === 'static') {
    return {
      name: entry.name,
      kind: 'static',
      fetch: (principal) => Promise.resolve(entry.bySubject.get(principal.id) ?? []),
    };
  }
  if (entry.kind === 'claims') {
    return {
      name: entry.name,
      kind: 'claims',
      // Synchronous application code: run inside the promise so a throw is a
      // rejection, never an escape.
      fetch: (principal) =>
        Promise.resolve().then(() => entry.map(principal.claims ?? {}, principal)),
    };
  }
  const source: IGrantSource = isFactory(entry.source) ? entry.source(services) : entry.source;
  const name = readName(source?.name) ?? `custom[${index}]`;
  if (typeof source?.grantsFor !== 'function') {
    throw new TypeError(`scopedRbac source ${JSON.stringify(name)} does not implement grantsFor`);
  }
  return {
    name,
    kind: 'custom',
    fetch: (principal, query, bounded) =>
      bounded((signal) => source.grantsFor(principal, query, signal)),
  };
}

/** The scoped grant resolver. */
export class GrantResolver {
  readonly #config: CompiledScopedRbac;
  readonly #deps: GrantResolverDeps;
  #sources: readonly BoundSource[] | undefined;
  /** The static and custom sources: memoised, cached and coalesced. */
  #sharedSources: readonly BoundSource[] | undefined;
  /** The claims sources: mapped on every resolution, never shared. */
  #claimsSources: readonly BoundSource[] | undefined;
  #roleSource: IScopedRoleSource | undefined;
  readonly #cache = new Map<
    string,
    { readonly expiresAt: number; readonly grants: readonly ScopedGrant[] }
  >();
  readonly #grantsInflight = new Map<string, Promise<GrantsOutcome>>();
  readonly #rolesInflight = new Map<string, Promise<CustomRolesOutcome>>();
  #stored:
    | ((context: IRequestContext, principal: IPrincipal) => readonly ScopedGrant[] | null)
    | undefined;

  /**
   * @param config - The compiled `scopedRbac` option
   * @param deps - The deadline and the monotonic clock
   */
  constructor(config: CompiledScopedRbac, deps: GrantResolverDeps) {
    this.#config = config;
    this.#deps = deps;
  }

  /**
   * Resolves factory sources once every plugin has registered (AuthPlugin's
   * `onInit`, the M101c precedent). A factory that throws, or answers no
   * `grantsFor`, fails `start()`.
   *
   * @param services - The application registry
   */
  bind(services: IServiceRegistry): void {
    this.#sources = this.#config.sources.map((entry, index) => bindSource(entry, services, index));
    this.#sharedSources = this.#sources.filter((source) => source.kind !== 'claims');
    this.#claimsSources = this.#sources.filter((source) => source.kind === 'claims');
    const roles = this.#config.customRoles;
    if (roles !== undefined) {
      const resolved = isFactory(roles) ? roles(services) : roles;
      if (typeof resolved?.rolesFor !== 'function') {
        throw new TypeError('scopedRbac.customRoles does not implement rolesFor');
      }
      this.#roleSource = resolved;
    }
  }

  /**
   * Supplies the session read used by `'sign-in'` timing.
   *
   * @param stored - Answers the grants stored at sign-in for the principal,
   *   or `null` when none are stored for it
   */
  useStoredGrants(
    stored: (context: IRequestContext, principal: IPrincipal) => readonly ScopedGrant[] | null,
  ): void {
    this.#stored = stored;
  }

  /**
   * Answers the grants a check reads for `query`. Under `'sign-in'` timing
   * that is the stored list (empty without a request or a stored list); under
   * the other modes the sources are asked, through the memo, cache and
   * coalescing described in the module doc.
   *
   * @param principal - The signed-in principal
   * @param query - The chain asked about
   * @param context - The request, when there is one
   * @returns The grants, or the failure
   */
  grantsFor(
    principal: IPrincipal,
    query: GrantQuery,
    context: IRequestContext | undefined,
  ): Promise<GrantsOutcome> {
    const timing = this.#config.timing;
    if (timing.kind === 'sign-in') {
      const stored = context === undefined ? null : this.#stored?.(context, principal) ?? null;
      return Promise.resolve({ ok: true, grants: stored ?? [], dropped: 0 });
    }
    const shared = this.#sharedGrantsFor(principal, query, context, timing);
    const claims = this.#claimsSources;
    if (claims === undefined || claims.length === 0) {
      return shared;
    }
    return Promise.all([shared, this.#collect(principal, query, claims)])
      .then(([fromShared, fromClaims]) => this.#union(fromShared, fromClaims));
  }

  /**
   * The static and custom sources' grants, through the memo, cache and
   * coalescing. Keyed by the principal, which is sound for these sources:
   * neither reads the credential.
   */
  #sharedGrantsFor(
    principal: IPrincipal,
    query: GrantQuery,
    context: IRequestContext | undefined,
    timing: Exclude<CompiledTiming, { readonly kind: 'sign-in' }>,
  ): Promise<GrantsOutcome> {
    const key = `grants:${principalKey(principal)}:${queryKey(query)}`;
    return memoised(context, key, this.#grantsInflight, async () => {
      if (timing.kind === 'cache') {
        const cached = this.#cache.get(key);
        if (cached !== undefined) {
          this.#cache.delete(key);
          if (cached.expiresAt > this.#deps.hrtime()) {
            // Re-inserted, so the map's insertion order is least-recently-used first.
            this.#cache.set(key, cached);
            return { ok: true, grants: cached.grants, dropped: 0 };
          }
        }
      }
      const outcome = this.#sharedSources === undefined
        ? unbound()
        : await this.#collect(principal, query, this.#sharedSources);
      if (outcome.ok && timing.kind === 'cache') {
        this.#cache.set(key, {
          expiresAt: this.#deps.hrtime() + timing.ttlMs,
          grants: outcome.grants,
        });
        while (this.#cache.size > timing.maxEntries) {
          this.#cache.delete(this.#cache.keys().next().value as string);
        }
      }
      return outcome;
    });
  }

  /**
   * Asks every source, unions and validates the answers. No memo, no cache:
   * sign-in calls this directly with an `all` query.
   *
   * @param principal - The principal
   * @param query - The question
   * @returns The grants, or the failure
   */
  resolveFromSources(principal: IPrincipal, query: GrantQuery): Promise<GrantsOutcome> {
    const sources = this.#sources;
    return sources === undefined
      ? Promise.resolve(unbound())
      : this.#collect(principal, query, sources);
  }

  /** Unions two resolutions: either failure wins, and the limit spans both. */
  #union(a: GrantsOutcome, b: GrantsOutcome): GrantsOutcome {
    if (!a.ok) {
      return a;
    }
    if (!b.ok) {
      return b;
    }
    const grants = [...a.grants, ...b.grants];
    if (grants.length > this.#config.maxGrants) {
      return { ok: false, reason: 'grant-limit', source: 'claims' };
    }
    return { ok: true, grants, dropped: a.dropped + b.dropped };
  }

  /** Asks `sources`, unions and validates the answers. */
  async #collect(
    principal: IPrincipal,
    query: GrantQuery,
    sources: readonly BoundSource[],
  ): Promise<GrantsOutcome> {
    const answers = await Promise.all(sources.map(async (source) => {
      try {
        return { source, value: await source.fetch(principal, query, this.#deps.bounded) };
      } catch (error) {
        return { source, error };
      }
    }));
    const grants: ScopedGrant[] = [];
    let dropped = 0;
    for (const answer of answers) {
      if ('error' in answer) {
        return answer.error instanceof ScopedDeadlineError
          ? { ok: false, reason: 'source-timeout', source: answer.source.name }
          : {
            ok: false,
            reason: 'source-failed',
            source: answer.source.name,
            errorName: errorNameOf(answer.error),
          };
      }
      if (!Array.isArray(answer.value)) {
        return { ok: false, reason: 'source-failed', source: answer.source.name };
      }
      for (const raw of answer.value as readonly unknown[]) {
        const grant = readGrant(raw);
        if (grant === undefined) {
          dropped += 1;
          continue;
        }
        grants.push(grant);
        if (grants.length > this.#config.maxGrants) {
          return { ok: false, reason: 'grant-limit', source: answer.source.name };
        }
      }
    }
    return { ok: true, grants, dropped };
  }

  /**
   * Answers the custom roles defined in `scopes`, in one call to the role
   * source (plan §3.11). With no role source configured, or no scopes, no
   * call is made.
   *
   * @param scopes - The defining scopes asked about
   * @param context - The request, when there is one
   * @returns The index, or the failure
   */
  customRolesFor(
    scopes: readonly ScopeRef[],
    context: IRequestContext | undefined,
  ): Promise<CustomRolesOutcome> {
    const source = this.#roleSource;
    if (source === undefined || scopes.length === 0) {
      return Promise.resolve({ ok: true, roles: new Map(), dropped: 0 });
    }
    const key = `roles:${JSON.stringify(scopes.map(scopeKey))}`;
    return memoised(
      context,
      key,
      this.#rolesInflight,
      () => this.#fetchCustomRoles(source, scopes),
    );
  }

  async #fetchCustomRoles(
    source: IScopedRoleSource,
    scopes: readonly ScopeRef[],
  ): Promise<CustomRolesOutcome> {
    const name = readName(source.name) ?? 'customRoles';
    let answered: unknown;
    try {
      answered = await this.#deps.bounded((signal) => source.rolesFor(scopes, signal));
    } catch (error) {
      return error instanceof ScopedDeadlineError
        ? { ok: false, reason: 'custom-roles-timeout', source: name }
        : { ok: false, reason: 'custom-roles-failed', source: name, errorName: errorNameOf(error) };
    }
    if (!Array.isArray(answered)) {
      return { ok: false, reason: 'custom-roles-failed', source: name };
    }
    const asked = new Set(scopes.map(scopeKey));
    const roles = new Map<string, Map<string, Set<string>>>();
    let dropped = 0;
    for (const raw of answered as readonly unknown[]) {
      const entry = readDefinition(raw);
      // Dropped: malformed, a scope nobody asked about (a source may not widen
      // the question), or a name that would shadow a catalogue role.
      if (
        entry === undefined || !asked.has(scopeKey(entry.scope)) ||
        this.#config.roles.has(entry.role)
      ) {
        dropped += 1;
        continue;
      }
      const key = scopeKey(entry.scope);
      const inScope = roles.get(key) ?? new Map<string, Set<string>>();
      if (!inScope.has(entry.role) && inScope.size >= this.#config.maxCustomRoles) {
        return {
          ok: false,
          reason: 'custom-roles-limit',
          scopeType: entry.scope.type,
          source: name,
        };
      }
      const permissions = inScope.get(entry.role) ?? new Set<string>();
      for (const permission of entry.permissions) {
        // A permission outside the catalogue grants nothing a guard can name.
        if (this.#config.permissions.has(permission)) {
          permissions.add(permission);
        } else {
          dropped += 1;
        }
      }
      if (permissions.size > this.#config.maxPermissionsPerRole) {
        return {
          ok: false,
          reason: 'custom-roles-limit',
          scopeType: entry.scope.type,
          source: name,
        };
      }
      inScope.set(entry.role, permissions);
      roles.set(key, inScope);
    }
    return { ok: true, roles, dropped };
  }
}

/** Reads one custom-role definition, copying it, or `undefined` when invalid. */
function readDefinition(
  value: unknown,
):
  | { readonly scope: ScopeRef; readonly role: string; readonly permissions: readonly string[] }
  | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const { scope, role, permissions } = value as {
    readonly scope?: unknown;
    readonly role?: unknown;
    readonly permissions?: unknown;
  };
  const ref = readScopeRef(scope);
  const name = readName(role);
  if (ref === undefined || name === undefined || !Array.isArray(permissions)) {
    return undefined;
  }
  const names: string[] = [];
  for (const permission of permissions as readonly unknown[]) {
    const read = readName(permission);
    if (read !== undefined) {
      names.push(read);
    }
  }
  return { scope: ref, role: name, permissions: names };
}
