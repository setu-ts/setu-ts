/**
 * Instance-name → capability-token derivation, shared by everything in this
 * package that registers or resolves a named capability instance.
 *
 * It lives in one module because two sides have to agree exactly: the plugin
 * derives the token it REGISTERS under, and `createQueueHandler` derives the
 * token it RESOLVES. Two copies that drift by a character leave the handler
 * looking up a token nothing registered, which surfaces as a queue whose
 * messages are never dispatched rather than as a startup error.
 *
 * Not exported from `src/index.ts` — the derivation is an implementation
 * detail of how the options map onto tokens, and an application names an
 * instance rather than building a token itself.
 *
 * @module
 */

import type { CapabilityToken } from '@hono-enterprise/common';
import { createCapabilityToken } from '@hono-enterprise/common';

/** The instance name that claims a bare capability token. */
const DEFAULT_INSTANCE = 'default';

/**
 * Derives the capability token an instance registers under.
 *
 * Matches `CachePlugin`'s convention, so a KV-backed instance can sit beside a
 * memory-backed one: `'default'` (or an omitted name) claims the bare token,
 * and anything else derives `<base>.<name>`.
 *
 * @param base - The bare capability token, e.g. `CAPABILITIES.QUEUE`
 * @param name - The configured instance name, when the caller set one
 * @returns The bare token, or the dot-namespaced instance token
 * @throws {Error} When `name` makes the derived token violate the token grammar
 * (`createCapabilityToken` rejects uppercase, colons, and empty segments)
 * @example
 * ```typescript
 * instanceToken(CAPABILITIES.QUEUE, undefined); // 'queue'
 * instanceToken(CAPABILITIES.QUEUE, 'default'); // 'queue'
 * instanceToken(CAPABILITIES.QUEUE, 'reports'); // 'queue.reports'
 * ```
 * @internal
 */
export function instanceToken(
  base: CapabilityToken,
  name: string | undefined,
): CapabilityToken {
  const instance = name ?? DEFAULT_INSTANCE;
  return instance === DEFAULT_INSTANCE ? base : createCapabilityToken(`${base}.${instance}`);
}
