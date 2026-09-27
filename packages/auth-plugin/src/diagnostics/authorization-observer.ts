/**
 * The package-private observer seam between the first-party `RbacService` and
 * the M98h authorization-observation collector.
 *
 * The observer is stored in a WeakMap keyed by the `RbacService` instance, so
 * a service that was never attached retains nothing and a discarded service is
 * collected together with its observer. The `RbacService` looks the observer up
 * on every check and invokes it inside a `try/catch` AFTER it has computed the
 * boolean, so a diagnostic failure can never permit, deny, throw, or alter the
 * decision or a guard's short-circuit order.
 *
 * The observer receives ONLY the evaluation facts — the requested rule names,
 * the per-step results and reasons, and the granting role name — never the
 * principal, its id, its roles, its permissions, or any request data. It is the
 * collector that aliases those names and drops any decision whose requested
 * rules are not all approved.
 *
 * @module
 */
import type { AuthorizationDecisionReason } from '@setu-ts/common';

/** One evaluated role check of a compound `hasAnyRole`. */
export interface RoleStepEval {
  /** The exact role name that was checked. */
  readonly role: string;
  /** Whether that role check passed. */
  readonly result: boolean;
  /** How that single check resolved. */
  readonly reason: AuthorizationDecisionReason;
  /** The principal role that granted it, or `null`. */
  readonly viaRole: string | null;
}

/** One evaluated permission check of a compound `hasAllPermissions`. */
export interface PermissionStepEval {
  /** The exact permission name that was checked. */
  readonly permission: string;
  /** Whether that permission check passed. */
  readonly result: boolean;
  /** How that single check resolved. */
  readonly reason: AuthorizationDecisionReason;
  /** The role that granted it, or `null` for a direct grant. */
  readonly viaRole: string | null;
}

/**
 * The observer the collector attaches to a `RbacService`. Every method is
 * synchronous, receives only evaluation facts (never a principal), and must
 * not let a failure cross the seam — the service wraps each call in
 * `try/catch` and returns the already-computed boolean regardless.
 */
export interface AuthorizationObserver {
  /** A single `hasRole` check, after the boolean was computed. */
  onRole(
    role: string,
    result: boolean,
    reason: AuthorizationDecisionReason,
    viaRole: string | null,
  ): void;
  /** A single `hasPermission` check, after the boolean was computed. */
  onPermission(
    permission: string,
    result: boolean,
    reason: AuthorizationDecisionReason,
    viaRole: string | null,
  ): void;
  /**
   * A `hasAnyRole` check: every requested role (the complete input, passed by
   * reference), the steps actually evaluated before the short-circuit (bounded
   * to the first 16 by the caller), the TRUE evaluated count, and the
   * authoritative result.
   */
  onAnyRole(
    requested: readonly string[],
    evaluated: readonly RoleStepEval[],
    evaluatedCount: number,
    result: boolean,
  ): void;
  /**
   * A `hasAllPermissions` check: every requested permission (the complete
   * input, passed by reference), the steps actually evaluated before the
   * short-circuit (bounded to the first 16 by the caller), the TRUE evaluated
   * count, and the authoritative result.
   */
  onAllPermissions(
    requested: readonly string[],
    evaluated: readonly PermissionStepEval[],
    evaluatedCount: number,
    result: boolean,
  ): void;
}

/**
 * The package-private WeakMap of attached observers. Keyed by the service so
 * an unattached service retains nothing and a discarded one is collected.
 */
const OBSERVERS = new WeakMap<object, AuthorizationObserver>();

/** Attaches (or replaces) the observer for a service. */
export function attachAuthorizationObserver(
  service: object,
  observer: AuthorizationObserver,
): void {
  OBSERVERS.set(service, observer);
}

/** Detaches the observer for a service. */
export function detachAuthorizationObserver(service: object): void {
  OBSERVERS.delete(service);
}

/** The observer attached to a service, or `undefined` when none is attached. */
export function authorizationObserverOf(service: object): AuthorizationObserver | undefined {
  return OBSERVERS.get(service);
}
