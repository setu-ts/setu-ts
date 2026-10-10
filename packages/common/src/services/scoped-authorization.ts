/**
 * Scoped RBAC contracts — a role granted IN a scope (a tenant, an
 * organisation, a team, a region) rather than everywhere.
 *
 * Scoped RBAC is not a new capability. AuthPlugin evaluates it as ONE built-in
 * authorization policy, named {@linkcode SCOPED_RBAC_POLICY}, on the evaluator
 * registered under `CAPABILITIES.AUTHORIZATION_POLICIES`: every permission in
 * the role catalogue is an ability, encoded by {@linkcode scopedPermissionAbility},
 * every catalogue role is an ability encoded by {@linkcode scopedRoleAbility},
 * and the target is a {@linkcode ScopedRbacTarget}. The contracts live here so
 * DecoratorPlugin and DatabasePlugin can name them without importing
 * AuthPlugin.
 *
 * @module
 */

import type { IRequestContext } from '../http.ts';
import type { IPrincipal } from './auth.ts';

/**
 * The name of the built-in policy AuthPlugin defines when `scopedRbac` is
 * configured. Reserved: AuthPlugin refuses an application policy of this name.
 *
 * @since 0.9.0
 */
export const SCOPED_RBAC_POLICY = 'scoped-rbac';

/**
 * The longest scope identifier accepted, in UTF-16 code units. A longer id is
 * refused rather than truncated, so two distinct ids can never collide.
 *
 * @since 0.9.0
 */
export const MAX_SCOPE_ID_LENGTH = 256;

/** The scope-type grammar: lowercase kebab-case, as a policy name. */
const SCOPE_TYPE = /^[a-z][a-z0-9-]*$/;

/**
 * A reference to one scope: what kind of thing it is, and which one.
 *
 * @example
 * ```typescript
 * const scope: ScopeRef = { type: 'tenant', id: 'acme' };
 * ```
 * @since 0.9.0
 */
export interface ScopeRef {
  /** The scope type — lowercase kebab-case (`tenant`, `organisation`). */
  readonly type: string;
  /** The scope's identifier, non-empty and at most {@linkcode MAX_SCOPE_ID_LENGTH} long. */
  readonly id: string;
}

/**
 * One role assignment: the role, and the scope it is held in. A `null` scope
 * is a GLOBAL grant — it applies in every scope.
 *
 * @since 0.9.0
 */
export interface ScopedGrant {
  /** The role name. */
  readonly role: string;
  /** The scope the role is held in, or `null` for a global grant. */
  readonly scope: ScopeRef | null;
}

/**
 * What a grant source is asked for.
 *
 * - `chain` — the grants held in any of `scopes`, plus every global grant.
 *   The scopes are the check's own scope and the scopes it inherits from.
 * - `all` — every grant the principal holds, in every scope. Asked only when
 *   grants are resolved once, at sign-in.
 *
 * @since 0.9.0
 */
export type GrantQuery =
  | { readonly kind: 'chain'; readonly scopes: readonly ScopeRef[] }
  | { readonly kind: 'all' };

/**
 * A source of scoped role grants — a repository, a directory, an identity
 * provider. Several sources are UNIONED; a source that rejects, throws or
 * exceeds its deadline makes the whole check deny.
 *
 * Every returned value is validated and copied by the evaluator; an invalid
 * grant is dropped, never coerced.
 *
 * @since 0.9.0
 */
export interface IGrantSource {
  /** A short name for the source, used in log records. Never a secret. */
  readonly name: string;
  /**
   * Answers the grants a principal holds.
   *
   * @param principal - The signed-in principal
   * @param query - The scopes asked about, or every scope
   * @param signal - Aborted when the evaluator's deadline expires
   * @returns The grants
   */
  grantsFor(
    principal: IPrincipal,
    query: GrantQuery,
    signal: AbortSignal,
  ): Promise<readonly ScopedGrant[]>;
}

/**
 * A role defined by a scope rather than by the global catalogue — a tenant's
 * own `regional-approver`. It bundles catalogue PERMISSIONS only.
 *
 * @since 0.9.0
 */
export interface ScopedRoleDefinition {
  /** The scope that defines the role. */
  readonly scope: ScopeRef;
  /** The role name, unique within its scope. */
  readonly role: string;
  /** The catalogue permissions the role grants. */
  readonly permissions: readonly string[];
}

/**
 * A source of per-scope custom roles.
 *
 * A grant naming a custom role resolves against the roles defined in the
 * GRANT'S OWN scope only, so two scopes defining the same name never collide.
 *
 * @since 0.9.0
 */
export interface IScopedRoleSource {
  /** A short name for the source, used in log records. Never a secret. */
  readonly name: string;
  /**
   * Answers the roles defined in each of `scopes`, in one call.
   *
   * @param scopes - The scopes whose definitions are needed
   * @param signal - Aborted when the evaluator's deadline expires
   * @returns Every role defined in any of the scopes
   */
  rolesFor(
    scopes: readonly ScopeRef[],
    signal: AbortSignal,
  ): Promise<readonly ScopedRoleDefinition[]>;
}

/**
 * The target of a scoped check: the scope, and — from a guard or decorator —
 * the request context, which lets the evaluator memoise grants for the rest
 * of the request and compare the scope against the resolved request tenant.
 *
 * A `null` scope asks about global grants only.
 *
 * @since 0.9.0
 */
export interface ScopedRbacTarget {
  /** The scope the check is about, or `null` for global grants only. */
  readonly scope: ScopeRef | null;
  /**
   * The request being authorized, when there is one. Pass it whenever the
   * check serves a request: without it the scope is not compared against the
   * request's resolved tenant, so a check for another tenant is answered from
   * the grants alone.
   */
  readonly context?: IRequestContext;
}

/**
 * Encodes a catalogue permission as an ability of the
 * {@linkcode SCOPED_RBAC_POLICY} policy.
 *
 * @param permission - The permission name
 * @returns The ability name
 * @example
 * ```typescript
 * await policies.can(user, SCOPED_RBAC_POLICY, scopedPermissionAbility('invoices:approve'), {
 *   scope: { type: 'tenant', id: 'acme' },
 * });
 * ```
 * @since 0.9.0
 */
export function scopedPermissionAbility(permission: string): string {
  return `perm:${permission}`;
}

/**
 * Encodes a catalogue role as an ability of the
 * {@linkcode SCOPED_RBAC_POLICY} policy.
 *
 * @param role - The role name
 * @returns The ability name
 * @since 0.9.0
 */
export function scopedRoleAbility(role: string): string {
  return `role:${role}`;
}

/**
 * Reports whether a value is a legal scope type: lowercase kebab-case.
 *
 * @param value - The candidate
 * @returns `true` when the value is a string matching the grammar
 * @since 0.9.0
 */
export function isScopeType(value: unknown): value is string {
  return typeof value === 'string' && SCOPE_TYPE.test(value);
}
