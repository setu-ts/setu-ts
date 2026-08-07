/**
 * @module
 *
 * Cloudflare Workers platform bindings for Setu-TS.
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
 * import { createApplication } from '@setu-ts/kernel';
 * import { RuntimePlugin } from '@setu-ts/runtime';
 * import { CloudflarePlugin } from '@setu-ts/cloudflare-plugin';
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
export type {
  CloudflarePluginOptions,
  DurableObjectArm,
  KvCacheOptions,
  R2StorageArm,
  WorkersQueueArm,
} from './options.ts';

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
  IQueueMessage,
  IQueueMessageBatch,
  IQueueProducer,
  IR2Bucket,
  IR2Object,
  IR2ObjectBody,
  IScheduledController,
  IServiceBinding,
  KvListOptions,
  KvListResult,
  KvPutOptions,
  QueueSendOptions,
} from './bindings/facades.ts';
export {
  isD1Database,
  isDurableObjectNamespace,
  isKvNamespace,
  isR2Bucket,
} from './bindings/facades.ts';

// Durable Objects — the DO-side cores the application's exported DO class
// delegates to, plus the structural facades that class is written against
export { RealtimeBackplaneObjectCore } from './durable-objects/realtime-backplane-object.ts';
export type {
  RealtimeBackplaneObjectCoreOptions,
} from './durable-objects/realtime-backplane-object.ts';
export { DistributedLockObjectCore } from './durable-objects/distributed-lock-object.ts';
export type {
  DistributedLockObjectCoreOptions,
} from './durable-objects/distributed-lock-object.ts';
export { asUpgradeResponse } from './durable-objects/do-facades.ts';
export type {
  DurableObjectMessageEvent,
  DurableObjectUpgradeResponse,
  IDurableObjectClientSocket,
  IDurableObjectState,
  IDurableObjectStorage,
  IDurableObjectWebSocket,
} from './durable-objects/do-facades.ts';
export { createDefaultDurableObjectWebSocketHost } from './durable-objects/do-websocket-host.ts';
export type {
  DurableObjectWebSocketHost,
  DurableObjectWebSocketPair,
} from './durable-objects/do-websocket-host.ts';

// Durable Objects — the replica-side clients
export { DurableObjectBackplane } from './realtime/durable-object-backplane.ts';
export type { DurableObjectBackplaneOptions } from './realtime/durable-object-backplane.ts';
export { DurableObjectLock } from './lock/durable-object-lock.ts';
export type { DurableObjectLockOptions } from './lock/durable-object-lock.ts';

// Background work
export type { LoggerSource, WaitUntilHost } from './background/wait-until.ts';

// Queues — the committed IQueue over a producer binding, plus the `queue` export
export { WorkersQueue } from './queues/workers-queue.ts';
export type { JobIdSource, WorkersQueueOptions } from './queues/workers-queue.ts';
export { createQueueHandler } from './queues/queue-handler.ts';
export type { QueueHandler, QueueHandlerOptions } from './queues/queue-handler.ts';

// Cron Triggers — the registry and the `scheduled` export
export { WorkersCron } from './cron/workers-cron.ts';
export type { CronHandler, WorkersCronOptions } from './cron/workers-cron.ts';
export { createScheduledHandler } from './cron/scheduled-handler.ts';
export type { ScheduledHandler } from './cron/scheduled-handler.ts';

// The edge response cache, over `caches.default`
export { cacheApiMiddleware } from './cache-api/cache-api-middleware.ts';
export type { CacheApiMiddlewareOptions } from './cache-api/cache-api-middleware.ts';
export type { ICacheApi } from './cache-api/cache-api.ts';
export { assessCacheability } from './cache-api/cacheability.ts';
export type { CacheabilityInput, CacheRefusal } from './cache-api/cacheability.ts';

// D1 — the committed IDatabaseAdapter over a D1 binding, handed to
// `DatabasePlugin({ type: 'custom', adapter })` by the application
export { D1Adapter } from './database/d1-adapter.ts';
export type { D1AdapterOptions, D1EntityMapping } from './database/d1-adapter.ts';

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
