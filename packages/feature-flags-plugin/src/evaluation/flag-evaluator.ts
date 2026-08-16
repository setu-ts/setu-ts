/**
 * Pure flag evaluation logic — allowlist-first, deterministic percentage bucket.
 *
 * NOT exported from the barrel; consumed internally by providers and tested directly.
 *
 * @module
 */

import type { FlagContext } from '@setu-ts/common';
import type { FlagDefinition } from '../interfaces/index.ts';

// ── FNV-1a 32-bit hash ─────────────────────────────────────────────────────

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * Computes an FNV-1a 32-bit hash over `input`.
 *
 * Iterates UTF-8 bytes (via `TextEncoder`) using the textbook sequence:
 * `hash = (hash ^ byte) >>> 0; hash = Math.imul(hash, FNV_PRIME) >>> 0;`
 * for every input byte.
 *
 * Verified against the known vector: `fnv1a32("foobar") === 0xbf9cf968`
 * (3214735720 decimal).
 *
 * @param input - String to hash.
 * @returns Unsigned 32-bit hash value.
 */
export function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  const bytes = new TextEncoder().encode(input);
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    hash = (hash ^ byte) >>> 0;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash;
}

/**
 * Deterministic bucket value [0, 99] for `flag:userId`.
 *
 * @param flag - Flag name.
 * @param userId - User identifier.
 * @returns Bucket index between 0 and 99 inclusive.
 */
export function bucket(flag: string, userId: string): number {
  return fnv1a32(`${flag}:${userId}`) % 100;
}

/**
 * Evaluates whether a flag is enabled for the given context.
 *
 * Precedence:
 * 1. `def === undefined` → `false`
 * 2. `tenants` present and `context?.tenantId` not in it → `false` (a
 *    restriction, ahead of every other rule: a non-matching tenant is `false`
 *    even with the user allowlisted and `enabled: true`)
 * 3. `users` allowlist contains `context?.userId` → `true` (overrides `enabled: false`)
 * 4. `enabled === false` → `false`
 * 5. `percentage` present → deterministic bucket check
 * 6. otherwise → `true`
 *
 * @param flag - Flag name.
 * @param def - Flag definition (may be `undefined`).
 * @param context - Targeting context.
 * @returns Whether the flag is enabled.
 */
export function evaluateFlag(
  flag: string,
  def: FlagDefinition | undefined,
  context: FlagContext | undefined,
): boolean {
  // Unknown flag → false (committed contract)
  if (def === undefined) {
    return false;
  }

  // Tenant restriction — ahead of every other rule. A flag scoped to certain
  // tenants is `false` for any context whose tenant is not in the list,
  // including a context with no tenant at all. When `tenants` is absent the
  // rule is inert and evaluation continues through the committed precedence.
  if (
    def.tenants !== undefined &&
    def.tenants.length > 0 &&
    (context?.tenantId === undefined || !def.tenants.includes(context.tenantId))
  ) {
    return false;
  }

  // User allowlist takes precedence — overrides enabled: false
  if (
    def.users !== undefined &&
    def.users.length > 0 &&
    context?.userId !== undefined &&
    def.users.includes(context.userId)
  ) {
    return true;
  }

  // Explicitly disabled
  if (def.enabled === false) {
    return false;
  }

  // Percentage rollout
  if (def.percentage !== undefined) {
    if (def.percentage >= 100) {
      return true;
    }
    if (def.percentage <= 0) {
      return false;
    }
    if (context?.userId === undefined) {
      return false;
    }
    return bucket(flag, context.userId) < def.percentage;
  }

  // Default: enabled
  return true;
}
