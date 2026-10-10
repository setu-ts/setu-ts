/**
 * The scoped RBAC evaluator and the built-in `scoped-rbac` policy it backs
 * (M110b plan §3.1, §3.8, §3.14).
 *
 * The check NEVER throws. Every failure is caught here, answered `false`, and
 * logged through this module's own logger with a fixed reason, a scope TYPE,
 * a source name and an error NAME — never a scope id, a principal id or an
 * error message. That is load-bearing: a throwing check would reach
 * `PolicyService.#report`, which serializes the error in full, and a database
 * error can quote its bound parameters (M108 measured Drizzle doing exactly
 * that) — here, subject and scope ids.
 *
 * Internal: not exported from the package barrel.
 *
 * @module
 */
import {
  SCOPED_RBAC_POLICY,
  scopedPermissionAbility,
  scopedRoleAbility,
  withDeadline,
} from '@setu-ts/common';
import type {
  ILogger,
  IPrincipal,
  IRequestContext,
  PolicyCheck,
  PolicyDefinition,
  ProbeTiming,
  ScopedGrant,
  ScopeRef,
} from '@setu-ts/common';
import type { CompiledScopedRbac } from './options.ts';
import { WILDCARD } from './options.ts';
import { memoised } from './grant-resolver.ts';
import { GrantResolver } from './grant-resolver.ts';
import type { CustomRoleIndex } from './grant-resolver.ts';
import { errorNameOf, readName, readScopeRef, ScopedDeadlineError, scopeKey } from './model.ts';
import type { Bounded, Failure } from './model.ts';
import { tenantMismatch, walkScopeChain } from './scope-chain.ts';
import type { ChainOutcome } from './scope-chain.ts';

/** What a scoped ability requires. */
export type ScopedRequirement =
  | { readonly kind: 'permission'; readonly name: string }
  | { readonly kind: 'role'; readonly name: string };

/** The reasons a client can cause; everything else is an operational failure. */
const CLIENT_REASONS: ReadonlySet<string> = new Set([
  'scope-unresolved',
  'scope-invalid',
  'tenant-mismatch',
]);

/** What the evaluator reads besides its configuration. */
export interface ScopedEvaluatorDeps {
  /** The grant and custom-role resolver. */
  readonly resolver: GrantResolver;
  /** Runs a resolver call under the configured deadline. */
  readonly bounded: Bounded;
  /** Read at CALL time, so a logger registered later still receives reports. */
  readonly logger: () => ILogger | undefined;
}

/** The target read once: its scope (or why it has none) and its request. */
interface ReadTarget {
  readonly scope: ScopeRef | null | 'unresolved' | 'invalid';
  readonly context: IRequestContext | undefined;
}

/**
 * Reads a `ScopedRbacTarget` once. A missing `scope` is unresolved; anything
 * that is not `null` or a valid `ScopeRef` is invalid. A `context` counts only
 * when it carries the per-request `state` map the memo is keyed by.
 */
function readTarget(target: unknown): ReadTarget {
  if (typeof target !== 'object' || target === null) {
    return { scope: 'invalid', context: undefined };
  }
  const { scope, context } = target as { readonly scope?: unknown; readonly context?: unknown };
  const request = typeof context === 'object' && context !== null &&
      (context as { readonly state?: unknown }).state instanceof Map &&
      typeof (context as { readonly request?: unknown }).request === 'object'
    ? context as IRequestContext
    : undefined;
  if (scope === undefined) {
    return { scope: 'unresolved', context: request };
  }
  if (scope === null) {
    return { scope: null, context: request };
  }
  return { scope: readScopeRef(scope) ?? 'invalid', context: request };
}

/** The scoped RBAC evaluator. */
export class ScopedEvaluator {
  readonly #config: CompiledScopedRbac;
  readonly #deps: ScopedEvaluatorDeps;
  readonly #chainsInflight = new Map<string, Promise<ChainOutcome>>();

  /**
   * @param config - The compiled `scopedRbac` option
   * @param deps - The resolver, the deadline and the logger
   */
  constructor(config: CompiledScopedRbac, deps: ScopedEvaluatorDeps) {
    this.#config = config;
    this.#deps = deps;
  }

  /**
   * Answers whether `principal` holds `requirement` in the target's scope.
   * Never throws and never rejects.
   *
   * @param principal - The signed-in principal
   * @param target - The `ScopedRbacTarget`
   * @param requirement - The permission or role required
   * @returns `true` when allowed
   */
  async allows(
    principal: IPrincipal,
    target: unknown,
    requirement: ScopedRequirement,
  ): Promise<boolean> {
    try {
      const outcome = await this.#evaluate(principal, target, requirement);
      if (outcome === true) {
        return true;
      }
      if (outcome !== false) {
        this.report(outcome);
      }
      return false;
    } catch (error) {
      this.report({ ok: false, reason: 'evaluation-failed', errorName: errorNameOf(error) });
      return false;
    }
  }

  async #evaluate(
    principal: IPrincipal,
    target: unknown,
    requirement: ScopedRequirement,
  ): Promise<boolean | Failure> {
    const { scope, context } = readTarget(target);
    if (scope === 'unresolved') {
      return { ok: false, reason: 'scope-unresolved' };
    }
    if (scope === 'invalid') {
      return { ok: false, reason: 'scope-invalid' };
    }
    let chain: readonly ScopeRef[] = [];
    if (scope !== null) {
      if (tenantMismatch(scope, context, this.#config.tenantScopeType)) {
        return { ok: false, reason: 'tenant-mismatch', scopeType: scope.type };
      }
      const walked = await this.#chainFor(scope, context);
      if (!walked.ok) {
        return walked;
      }
      chain = walked.chain;
    }

    const resolved = await this.#deps.resolver.grantsFor(
      principal,
      { kind: 'chain', scopes: chain },
      context,
    );
    if (!resolved.ok) {
      return resolved;
    }
    if (resolved.dropped > 0) {
      this.#warnDropped('grants', resolved.dropped);
    }
    const grants = this.#inChain(resolved.grants, chain, principal);

    if (requirement.kind === 'role') {
      return grants.some((grant) => this.#grantsRole(grant, requirement.name));
    }
    if (this.#holdsDirectly(principal, requirement.name)) {
      return true;
    }
    if (grants.some((grant) => this.#catalogueGrantsPermission(grant, requirement.name))) {
      return true;
    }
    const customScopes = this.#customRoleScopes(grants);
    if (customScopes.length === 0) {
      return false;
    }
    const roles = await this.#deps.resolver.customRolesFor(customScopes, context);
    if (!roles.ok) {
      return roles;
    }
    if (roles.dropped > 0) {
      this.#warnDropped('custom-roles', roles.dropped);
    }
    return grants.some((grant) => customGrantsPermission(grant, requirement.name, roles.roles));
  }

  /**
   * The chain for `scope`, walked once per request and coalesced across
   * requests — a chain is not principal-specific, so concurrent requests
   * asking about one scope share a walk.
   */
  #chainFor(scope: ScopeRef, context: IRequestContext | undefined): Promise<ChainOutcome> {
    return memoised(
      context,
      `chain:${scopeKey(scope)}`,
      this.#chainsInflight,
      () => walkScopeChain(scope, this.#config, this.#deps.bounded),
    );
  }

  /**
   * Keeps the grants that apply here: global ones, and those held in a scope
   * of the chain. A source may answer more than it was asked (a static or
   * claims source returns everything); this filter is what scopes them.
   * The principal's own roles are global grants.
   */
  #inChain(
    grants: readonly ScopedGrant[],
    chain: readonly ScopeRef[],
    principal: IPrincipal,
  ): ScopedGrant[] {
    const keys = new Set(chain.map(scopeKey));
    const kept = grants.filter((grant) => grant.scope === null || keys.has(scopeKey(grant.scope)));
    for (const role of principal.roles ?? []) {
      const name = readName(role);
      if (name !== undefined) {
        kept.push({ role: name, scope: null });
      }
    }
    return kept;
  }

  /** Whether a grant counts where it is held (`grantableIn`, plan §3.8). */
  #grantable(grant: ScopedGrant): boolean {
    const limit = this.#config.limits.get(grant.role);
    if (limit === undefined) {
      return true;
    }
    return grant.scope === null ? limit.global : limit.scopeTypes.has(grant.scope.type);
  }

  #grantsRole(grant: ScopedGrant, role: string): boolean {
    if (!this.#grantable(grant)) {
      return false;
    }
    if (grant.role === role) {
      return this.#config.roles.has(role);
    }
    return this.#config.roles.get(grant.role)?.inherits.has(role) === true;
  }

  #holdsDirectly(principal: IPrincipal, permission: string): boolean {
    const held = principal.permissions ?? [];
    return held.includes(permission) || held.includes(WILDCARD);
  }

  #catalogueGrantsPermission(grant: ScopedGrant, permission: string): boolean {
    const role = this.#config.roles.get(grant.role);
    if (role === undefined || !this.#grantable(grant)) {
      return false;
    }
    return role.permissions.has(permission) || role.permissions.has(WILDCARD);
  }

  /** The distinct scopes holding a grant of a non-catalogue role. */
  #customRoleScopes(grants: readonly ScopedGrant[]): ScopeRef[] {
    const scopes = new Map<string, ScopeRef>();
    for (const grant of grants) {
      if (grant.scope !== null && !this.#config.roles.has(grant.role)) {
        scopes.set(scopeKey(grant.scope), grant.scope);
      }
    }
    return [...scopes.values()];
  }

  #warnDropped(kind: 'grants' | 'custom-roles', count: number): void {
    this.#safeLog('warn', 'Scoped authorization ignored invalid entries', {
      policy: SCOPED_RBAC_POLICY,
      kind,
      count,
    });
  }

  /**
   * Logs a failure once, with the fixed fields only. Also used by sign-in
   * timing, so a failure there is reported the same way.
   *
   * @param failure - The failure to report
   */
  report(failure: Failure): void {
    const fields: Record<string, unknown> = { policy: SCOPED_RBAC_POLICY, reason: failure.reason };
    if (failure.scopeType !== undefined) {
      fields.scopeType = failure.scopeType;
    }
    if (failure.source !== undefined) {
      fields.source = failure.source;
    }
    if (failure.errorName !== undefined) {
      fields.errorName = failure.errorName;
    }
    this.#safeLog(
      CLIENT_REASONS.has(failure.reason) ? 'warn' : 'error',
      'Scoped authorization denied',
      fields,
    );
  }

  /** A throwing logger cannot change the outcome (the M109a `safeLog` precedent). */
  #safeLog(level: 'warn' | 'error', message: string, fields: Record<string, unknown>): void {
    try {
      this.#deps.logger()?.[level](message, fields);
    } catch {
      // Deliberately discarded: the decision is already made.
    }
  }
}

/**
 * Whether a grant of a custom role grants `permission`. A grant resolves
 * against the roles defined in ITS OWN scope only (plan §3.11), so two scopes
 * defining the same name never widen each other.
 */
function customGrantsPermission(
  grant: ScopedGrant,
  permission: string,
  roles: CustomRoleIndex,
): boolean {
  if (grant.scope === null) {
    return false;
  }
  return roles.get(scopeKey(grant.scope))?.get(grant.role)?.has(permission) === true;
}

/**
 * Builds the built-in `scoped-rbac` policy over an evaluator: one ability per
 * catalogue permission (`perm:<p>`, never the wildcard) and per catalogue role
 * (`role:<r>`).
 *
 * @param config - The compiled `scopedRbac` option
 * @param evaluator - The evaluator every ability calls
 * @returns The policy definition AuthPlugin defines
 */
export function buildScopedPolicy(
  config: CompiledScopedRbac,
  evaluator: ScopedEvaluator,
): PolicyDefinition {
  const abilities: Record<string, PolicyCheck<never>> = {};
  for (const permission of config.permissions) {
    abilities[scopedPermissionAbility(permission)] = (principal, target) =>
      evaluator.allows(principal, target, { kind: 'permission', name: permission });
  }
  for (const role of config.roles.keys()) {
    abilities[scopedRoleAbility(role)] = (principal, target) =>
      evaluator.allows(principal, target, { kind: 'role', name: role });
  }
  return { name: SCOPED_RBAC_POLICY, abilities };
}

/** The scoped RBAC parts AuthPlugin wires together. */
export interface ScopedRbac {
  /** Resolves grants and custom roles; bound to the registry at `onInit`. */
  readonly resolver: GrantResolver;
  /** The evaluator behind every ability. */
  readonly evaluator: ScopedEvaluator;
  /** The built-in `scoped-rbac` policy. */
  readonly policy: PolicyDefinition;
}

/**
 * Builds the resolver, evaluator and built-in policy over one deadline.
 *
 * @param config - The compiled `scopedRbac` option
 * @param timing - The runtime's monotonic clock and timer surface
 * @param logger - Read at call time
 * @returns The wired parts
 */
export function createScopedRbac(
  config: CompiledScopedRbac,
  timing: ProbeTiming,
  logger: () => ILogger | undefined,
): ScopedRbac {
  const bounded: Bounded = (run) =>
    withDeadline(run, {
      timeoutMs: config.sourceTimeoutMs,
      onTimeout: () => new ScopedDeadlineError(),
      timing,
    });
  const resolver = new GrantResolver(config, { bounded, hrtime: timing.hrtime });
  const evaluator = new ScopedEvaluator(config, { resolver, bounded, logger });
  return { resolver, evaluator, policy: buildScopedPolicy(config, evaluator) };
}
