/**
 * Splits a Cloudflare Workers `env` record into the string variables
 * {@linkcode IRuntimeServices.env} contracts for, and the object bindings it
 * does not.
 *
 * A Worker's `env` mixes both: `MY_SECRET` is a string, while `MY_KV` is a
 * `KVNamespace` object. `IRuntimeServices.env` is typed
 * `Readonly<Record<string, string | undefined>>` and is iterated by
 * `ConfigPlugin`, so passing a binding through unfiltered stringifies it to
 * `[object Object]` — a silent configuration corruption that type-checks.
 * Bindings are reached through `CAPABILITIES.CLOUDFLARE` instead.
 *
 * It lives in `common` rather than in either consumer because both need the
 * identical partition — `packages/runtime` to build `IRuntimeServices.env`, and
 * `packages/cloudflare-plugin` to build the binding registry — and no plugin
 * may import another (AI_GUIDELINES §2.2). The `IRealtimeBackplane` frame codec
 * (M47) is in `common` for exactly this reason.
 *
 * @module
 */

/**
 * The two halves of a Workers `env` record.
 *
 * @since 0.2.0
 */
export interface SplitWorkerEnv {
  /** Entries whose value is a string — safe for `IRuntimeServices.env`. */
  readonly vars: Readonly<Record<string, string>>;
  /** Entries whose value is a non-null object — the platform bindings. */
  readonly bindings: Readonly<Record<string, object>>;
}

/**
 * Partitions a Workers `env` record by value type.
 *
 * Values that are neither a string nor a non-null object (a number, a boolean,
 * `null`, `undefined`) land in neither half: coercing them to a string would
 * put a value in `env` that was never a variable, and treating them as a
 * binding would hand a caller something with no methods.
 *
 * @param env - The record the Worker's `env` provides
 * @returns The string variables and the object bindings, separated
 * @example
 * ```typescript
 * const { vars, bindings } = splitWorkerEnv({ API_KEY: 'k', CACHE: kvNamespace });
 * // vars     → { API_KEY: 'k' }
 * // bindings → { CACHE: kvNamespace }
 * ```
 * @since 0.2.0
 */
export function splitWorkerEnv(env: Readonly<Record<string, unknown>>): SplitWorkerEnv {
  const vars: Record<string, string> = {};
  const bindings: Record<string, object> = {};

  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      vars[key] = value;
    } else if (typeof value === 'object' && value !== null) {
      bindings[key] = value;
    }
  }

  return { vars, bindings };
}
