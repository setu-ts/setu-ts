/**
 * @module
 *
 * Cloudflare Workers platform bindings for Hono Enterprise.
 *
 * The framework has served traffic on Workers since the Hono migration, but had
 * no way to reach the platform's own primitives. `CloudflarePlugin` publishes a
 * Worker's bindings under `CAPABILITIES.CLOUDFLARE`, and optionally serves the
 * committed cache and storage capabilities from KV and R2.
 *
 * Zero npm dependencies, and nothing here imports `cloudflare:workers` — the
 * application passes `env` (and `waitUntil`) in, which keeps the package
 * type-checkable on every runtime and trivially testable.
 *
 * Every export is documented in PUBLIC_API.md.
 *
 * @example
 * ```typescript
 * import { env, waitUntil } from 'cloudflare:workers';
 * import { createApplication } from '@hono-enterprise/kernel';
 * import { RuntimePlugin } from '@hono-enterprise/runtime';
 * import { CloudflarePlugin } from '@hono-enterprise/cloudflare-plugin';
 *
 * const app = createApplication({
 *   plugins: [
 *     RuntimePlugin({ env }),
 *     CloudflarePlugin({ env, waitUntil, cache: { binding: 'CACHE_KV', prefix: 'cache:' } }),
 *   ],
 * });
 *
 * await app.start();
 * export default { fetch: app.fetch };
 * ```
 */

// Plugin factory
export { CloudflarePlugin } from './plugin/cloudflare-plugin.ts';
export type { CloudflarePluginOptions, KvCacheOptions, R2StorageArm } from './options.ts';

// The capability published under CAPABILITIES.CLOUDFLARE
export type { ICloudflareBindings } from './bindings/binding-registry.ts';

// Binding facades — the injection surface, and the accessors' return types
export type {
  CloudflareWorkerEnv,
  D1Result,
  ID1Database,
  ID1PreparedStatement,
  IDurableObjectNamespace,
  IKvNamespace,
  IQueueProducer,
  IR2Bucket,
  IR2Object,
  IR2ObjectBody,
  IServiceBinding,
  KvListOptions,
  KvListResult,
  KvPutOptions,
  QueueSendOptions,
} from './bindings/facades.ts';
export { isKvNamespace, isR2Bucket } from './bindings/facades.ts';

// Background work
export type { WaitUntilHost } from './background/wait-until.ts';

// Stores — constructible standalone, for wiring a capability the plugin does
// not register (sessions) or for use outside an application
export { KvCacheStore } from './stores/kv-cache-store.ts';
export type { CacheClock, KvCacheStoreOptions } from './stores/kv-cache-store.ts';

export { KvSessionStore } from './stores/kv-session-store.ts';
export type { KvSessionStoreOptions } from './stores/kv-session-store.ts';

export { R2Storage } from './storage/r2-storage.ts';
export type { R2StorageOptions } from './storage/r2-storage.ts';

// Errors, for `instanceof` narrowing at call sites
export {
  CloudflareBindingMissingError,
  CloudflareObjectNotFoundError,
  CloudflareUnsupportedError,
} from './errors.ts';
