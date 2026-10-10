/**
 * Validators for the values scoped RBAC reads from configuration and from
 * grant sources.
 *
 * Every value is read ONCE into a fresh object (the M110a T9 rule): a source
 * returning an object whose getters answer differently on a second read cannot
 * pass validation with one value and be evaluated with another. An invalid
 * value is refused (`undefined`), never coerced.
 *
 * Internal: not exported from the package barrel.
 *
 * @module
 */
import { isScopeType, MAX_SCOPE_ID_LENGTH } from '@setu-ts/common';
import type { ScopedGrant, ScopeRef } from '@setu-ts/common';

/** The longest role or permission name accepted from a source. */
export const MAX_NAME_LENGTH = 256;

/**
 * Reads a scope reference, or `undefined` when it is not a valid one.
 *
 * @param value - The candidate
 * @returns A fresh, frozen `ScopeRef`, or `undefined`
 */
export function readScopeRef(value: unknown): ScopeRef | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const { type, id } = value as { readonly type?: unknown; readonly id?: unknown };
  if (!isScopeType(type) || typeof id !== 'string') {
    return undefined;
  }
  if (id.length === 0 || id.length > MAX_SCOPE_ID_LENGTH) {
    return undefined;
  }
  return Object.freeze({ type, id });
}

/**
 * Reads a role or permission name, or `undefined` when it is not one.
 *
 * @param value - The candidate
 * @returns The name, or `undefined`
 */
export function readName(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_NAME_LENGTH
    ? value
    : undefined;
}

/**
 * Reads one grant, or `undefined` when it is not a valid one. A `null` scope
 * is a global grant; an absent or malformed scope is invalid.
 *
 * @param value - The candidate
 * @returns A fresh, frozen `ScopedGrant`, or `undefined`
 */
export function readGrant(value: unknown): ScopedGrant | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const { role, scope } = value as { readonly role?: unknown; readonly scope?: unknown };
  const name = readName(role);
  if (name === undefined) {
    return undefined;
  }
  if (scope === null) {
    return Object.freeze({ role: name, scope: null });
  }
  const ref = readScopeRef(scope);
  return ref === undefined ? undefined : Object.freeze({ role: name, scope: ref });
}

/**
 * The one key a scope is compared and memoised by. The separator is a NUL,
 * which `isScopeType` excludes from a type, so no two scopes share a key.
 *
 * @param scope - The scope
 * @returns Its key
 */
export function scopeKey(scope: ScopeRef): string {
  return `${scope.type}\u0000${scope.id}`;
}

/**
 * Why a scoped check denied. A fixed vocabulary: a log record carries one of
 * these, never a scope id, a principal id or a source's error message.
 */
export type DenyReason =
  | 'scope-unresolved'
  | 'scope-invalid'
  | 'tenant-mismatch'
  | 'scope-cycle'
  | 'scope-depth'
  | 'scope-nodes'
  | 'resolver-failed'
  | 'resolver-timeout'
  | 'source-failed'
  | 'source-timeout'
  | 'grant-limit'
  | 'custom-roles-failed'
  | 'custom-roles-timeout'
  | 'custom-roles-limit'
  | 'evaluation-failed';

/** A denied resolution: why, and what may be logged about it. */
export interface Failure {
  /** Always `false`. */
  readonly ok: false;
  /** Why it denied. */
  readonly reason: DenyReason;
  /** The scope TYPE involved, when there is one — never its id. */
  readonly scopeType?: string;
  /** The failing source's configured name. */
  readonly source?: string;
  /** The thrown value's `name` — never its message, which can quote bound ids. */
  readonly errorName?: string;
}

/** Raised by {@linkcode Bounded} when a call outlives its deadline. */
export class ScopedDeadlineError extends Error {
  constructor() {
    super('scoped RBAC call exceeded its deadline');
    this.name = 'ScopedDeadlineError';
  }
}

/**
 * Runs a call under the configured deadline. Rejects with
 * {@linkcode ScopedDeadlineError} on expiry; the signal is aborted then.
 */
export type Bounded = <T>(run: (signal: AbortSignal) => Promise<T>) => Promise<T>;

/**
 * The `name` of a thrown value, read without converting it (a `String(value)`
 * or a getter can throw).
 *
 * @param error - The thrown value
 * @returns Its `name`, or a type label
 */
export function errorNameOf(error: unknown): string {
  try {
    if (typeof error === 'object' && error !== null) {
      const name = (error as { readonly name?: unknown }).name;
      // An identifier only: a `name` is library-controlled, and anything
      // looser could carry a scope or subject id into a log record.
      if (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) {
        return name;
      }
    }
  } catch {
    // A throwing `name` getter is labelled like any other unreadable value.
  }
  return `[${typeof error}]`;
}
