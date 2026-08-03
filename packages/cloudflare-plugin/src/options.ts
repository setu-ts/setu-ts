/**
 * `CloudflarePlugin` options.
 *
 * @module
 */

import type { WaitUntilHost } from './background/wait-until.ts';
import type { CloudflareWorkerEnv } from './bindings/facades.ts';

/**
 * Wires a KV namespace up as the application's {@linkcode ICacheStore} under
 * `CAPABILITIES.CACHE`.
 *
 * @since 0.2.0
 */
export interface KvCacheOptions {
  /** The KV namespace binding name from `wrangler.toml`. */
  readonly binding: string;
  /**
   * Instance name. `'default'` (the default) claims the bare `cache` token;
   * anything else derives `cache.<name>`, matching `CachePlugin`'s convention
   * so several caches can coexist.
   */
  readonly name?: string;
  /**
   * Prefix applied to every cache key. Required to call `clear()`, and
   * recommended whenever the namespace is shared.
   */
  readonly prefix?: string;
  /** TTL in seconds applied when `set` omits one. Omitted means no expiry. */
  readonly defaultTtlSeconds?: number;
}

/**
 * Wires an R2 bucket up as the application's {@linkcode IStorage} under
 * `CAPABILITIES.STORAGE`.
 *
 * @since 0.2.0
 */
export interface R2StorageArm {
  /** The R2 bucket binding name from `wrangler.toml`. */
  readonly binding: string;
  /**
   * Instance name. `'default'` (the default) claims the bare `storage` token;
   * anything else derives `storage.<name>`.
   */
  readonly name?: string;
  /** Prefix applied to every object key. */
  readonly prefix?: string;
}

/**
 * Wires a Cloudflare Queues producer binding up as the application's
 * {@linkcode IQueue} under `CAPABILITIES.QUEUE`.
 *
 * Producing is all this arm configures. Consuming needs the Worker module to
 * export the handler `createQueueHandler(app)` builds, which no plugin option
 * can do on the application's behalf.
 *
 * @since 0.2.0
 */
export interface WorkersQueueArm {
  /** The Queues producer binding name from `wrangler.toml`. */
  readonly binding: string;
  /**
   * Instance name. `'default'` (the default) claims the bare `queue` token;
   * anything else derives `queue.<name>`, which
   * {@linkcode QueueHandlerOptions.name} must then match.
   */
  readonly name?: string;
  /**
   * Largest accepted `AddJobOptions.delayMs`, in **seconds**. Defaults to
   * 86400, the platform maximum; a larger delay throws rather than being
   * silently truncated.
   */
  readonly maxDelaySeconds?: number;
}

/**
 * Wires a Durable Object namespace up as the application's
 * {@linkcode IRealtimeBackplane} under `CAPABILITIES.REALTIME_BACKPLANE`, so
 * WebSocket rooms and SSE channels reach clients on other replicas.
 *
 * The namespace's `class_name` must be a Durable Object class the application
 * exports, delegating to {@linkcode RealtimeBackplaneObjectCore}. No plugin
 * option can export that class on the application's behalf, which is why the
 * DO class is a documented deliverable rather than an implementation detail.
 *
 * Registering this arm **and** `RealtimeBackplanePlugin` in one application
 * fails at startup: the kernel rejects two providers of one capability token.
 * Register exactly one.
 *
 * @since 0.2.0
 */
export interface DurableObjectArm {
  /** The Durable Object namespace binding name from `wrangler.toml`. */
  readonly binding: string;
  /**
   * Instance name. `'default'` (the default) claims the bare
   * `realtime-backplane` token; anything else derives
   * `realtime-backplane.<name>`.
   */
  readonly name?: string;
  /**
   * The object name every replica shares, passed to `idFromName`.
   *
   * Two applications sharing one namespace must set different topics, or each
   * receives the other's frames.
   *
   * @default 'realtime'
   */
  readonly topic?: string;
}

/**
 * Options for {@linkcode CloudflarePlugin}.
 *
 * @example Bindings only
 * ```typescript
 * import { env, waitUntil } from 'cloudflare:workers';
 *
 * app.register(CloudflarePlugin({ env, waitUntil }));
 * ```
 * @example Also serving cache and storage from the platform
 * ```typescript
 * app.register(CloudflarePlugin({
 *   env,
 *   waitUntil,
 *   cache: { binding: 'CACHE_KV', prefix: 'cache:' },
 *   storage: { binding: 'UPLOADS' },
 *   requireBindings: ['CACHE_KV', 'UPLOADS', 'SESSIONS'],
 * }));
 * ```
 * @since 0.2.0
 */
export interface CloudflarePluginOptions {
  /**
   * The Worker's `env`, from `import { env } from 'cloudflare:workers'`.
   *
   * Passed in rather than imported by this package: `cloudflare:workers` is
   * unresolvable outside a Worker toolchain, so importing it here would break
   * type-checking on every other runtime.
   */
  readonly env: CloudflareWorkerEnv;
  /**
   * The platform's background-work sink, from
   * `import { waitUntil } from 'cloudflare:workers'` (available from
   * compatibility date 2025-08-08).
   *
   * Omitting it leaves `bindings.waitUntil()` running the promise without
   * extending the invocation — correct off Cloudflare Workers, and a silent
   * truncation risk on it, so pass it whenever deploying to Workers.
   */
  readonly waitUntil?: WaitUntilHost;
  /**
   * Bindings that must be present. `register()` throws naming every absent
   * one, so a missing `wrangler.toml` stanza fails at startup instead of on
   * the first request that needs it.
   */
  readonly requireBindings?: readonly string[];
  /** Serve `CAPABILITIES.CACHE` from a KV namespace. Omitted registers nothing. */
  readonly cache?: KvCacheOptions;
  /** Serve `CAPABILITIES.STORAGE` from an R2 bucket. Omitted registers nothing. */
  readonly storage?: R2StorageArm;
  /**
   * Serve `CAPABILITIES.QUEUE` from a Queues producer binding. Omitted
   * registers nothing.
   */
  readonly queue?: WorkersQueueArm;
  /**
   * Serve `CAPABILITIES.REALTIME_BACKPLANE` from a Durable Object namespace.
   * Omitted registers nothing.
   */
  readonly durableObject?: DurableObjectArm;
}
