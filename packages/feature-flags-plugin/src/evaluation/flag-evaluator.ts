/**
 * Pure flag evaluation logic — allowlist-first, deterministic percentage bucket.
 *
 * NOT exported from the barrel; consumed internally by providers and tested directly.
 *
 * @module
 */

import type { FlagContext } from '@hono-enterprise/common';
import type { FlagDefinition } from '../interfaces/index.ts';

// ── FNV-1a 32-bit hash ─────────────────────────────────────────────────────

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const FNV_MOD = 2 ** 32;

/**
 * Computes an FNV-1a 32-bit hash over `input`.
 *
 * @param input - String to hash.
 * @returns Unsigned 32-bit hash value.
 */
export function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * FNV_PRIME) % FNV_MOD;
  }
  // Ensure unsigned right shift for consistent results across runtimes
  return hash >>> 0;
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
 * 2. `users` allowlist contains `context?.userId` → `true` (overrides `enabled: false`)
 * 3. `enabled === false` → `false`
 * 4. `percentage` present → deterministic bucket check
 * 5. otherwise → `true`
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
