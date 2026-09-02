/**
 * Internal interfaces and types for the scheduler plugin.
 *
 * This barrel is intentionally NOT exported from `src/index.ts` — it is an
 * internal seam used only by scheduler-plugin implementation files.
 *
 * @module
 */

import type {
  IIngressBehavior,
  RegistryFactory,
  RetryOptions,
  SchedulerJobHandler,
} from '@setu-ts/common';

/**
 * Distributed lock interface.
 *
 * Implementations acquire a lock before running a scheduled job handler
 * and release it afterward. When another instance holds the lock, the
 * fire is skipped.
 */
export interface IDistributedLock {
  /**
   * Attempt to acquire the lock.
   *
   * @param key - The lock key
   * @param ttlMs - Time-to-live in milliseconds
   * @returns A unique token if acquired, or `null` if held by another instance
   */
  acquire(key: string, ttlMs: number): Promise<string | null>;

  /**
   * Release a previously acquired lock.
   *
   * Only releases if the provided token matches the held token.
   *
   * @param key - The lock key
   * @param token - The token returned by `acquire`
   */
  release(key: string, token: string): Promise<void>;
}

/**
 * Plugin options passed to `SchedulerPlugin()`.
 */
export interface SchedulerPluginOptions {
  /**
   * Timezone for cron evaluation. Only `'UTC'` is supported in this release.
   *
   * @default 'UTC'
   */
  timezone?: string;

  /**
   * Distributed lock configuration.
   *
   * When absent or `enabled: false` a `MemoryLock` is used (process-local).
   * When `storage: 'redis'` a `RedisLock` is used for multi-instance safety.
   */
  distributedLock?: DistributedLockOptions;

  /**
   * Jobs registered declaratively, as an alternative to calling
   * `scheduler.cron()`/`every()`/`delay()` imperatively after `start()`.
   * Each entry — instance or `RegistryFactory` — produces one registration
   * call, dispatched on its `trigger`, so a job can be declared where the
   * plugin is composed instead of after the application has started.
   *
   * Instance entries register during the plugin's `register()` phase,
   * identical to the imperative timing.
   * Factory entries are resolved in the
   * `onInit` phase — the first at which the registry holds every capability —
   * so a factory can build its definition from a resolved capability. A
   * factory that throws rejects `start()` with an error naming
   * `SchedulerPlugin({ jobs })` and the entry's index in THIS declared array,
   * not its position among the factories.
   *
   * On Cloudflare Workers the plugin refuses registration outright
   * (`SchedulerUnavailableError`) before any entry is read — the refusal
   * fires before an instance registers and before `onInit` can resolve a
   * factory.
   *
   * @since 0.3.0
   */
  readonly jobs?: readonly SchedulerJobEntry[];

  /**
   * Ingress behaviours wrapped around every job handler — the scheduler arm
   * of the transport-neutral behaviour chain shared with the websocket,
   * queue, and messaging plugins (`IIngressBehavior` in `@setu-ts/common`).
   *
   * Each behaviour observes an `IngressContext` carrying `kind: 'scheduler'`,
   * the job name as `name`, the delivered `ScheduledJob` as `payload`, and
   * the 1-based `attempt`, and runs in declared order ahead of the handler —
   * INSIDE the distributed lock, so a replica that loses the lock runs no
   * behaviour for that fire. A behaviour that returns without calling
   * `next()` short-circuits: the handler never sees the fire. A behaviour
   * that throws follows the handler's own failure path — retried per the
   * job's `RetryOptions` exactly as a handler throw is. Every registration
   * is wrapped — imperative `cron()`/`every()`/`delay()` calls included — so
   * a mixed application cannot leave a handler unchained.
   *
   * With no behaviours configured, dispatch is byte-identical to the
   * pre-chain behaviour: the handler is handed the job directly, with no
   * chain allocated.
   *
   * When an entry is a FACTORY, dispatch is HELD until `onInit` has resolved
   * the whole chain, so nothing reaches a handler through a partial one. That
   * gate covers every registration — this plugin's declared entries and any a
   * later plugin makes imperatively through the resolved capability — which
   * is why no registration's timing has to change. It is released once and
   * costs nothing thereafter.
   *
   * Instance entries are handed to the service at `register()`; factory
   * entries are resolved in the `onInit` phase and a throwing factory rejects
   * `start()` naming `SchedulerPlugin({ behaviors })` and the entry's index
   * in THIS declared array.
   *
   * @since 0.3.0
   */
  readonly behaviors?: readonly (IIngressBehavior | RegistryFactory<IIngressBehavior>)[];
}

/**
 * The declarative form of one scheduler job registration — the entry an
 * application writes instead of calling `cron()`/`every()`/`delay()`
 * imperatively after `start()`.
 *
 * A union discriminated on `trigger`: each arm carries exactly the field its
 * scheduling strategy needs (`expression` for `cron`, `intervalMs` for
 * `every`, `delayMs` for `delay`), so a cron entry without an `expression` —
 * the one mistake that would otherwise produce a job that silently never
 * fires — is a COMPILE error rather than a runtime one.
 *
 * @since 0.3.0
 */
export type SchedulerJobDefinition = {
  /** Discriminator: this job fires on a 5-field cron expression (UTC). */
  readonly trigger: 'cron';
  /** Unique job name (the `cron()` name argument). */
  readonly name: string;
  /** 5-field cron expression (UTC). Required on the `cron` arm. */
  readonly expression: string;
  /** Invoked on each fire, exactly as the imperative `cron()` accepts. */
  readonly handler: SchedulerJobHandler;
  /** Optional payload handed to the handler. */
  readonly data?: unknown;
  /** Optional retry configuration, exactly as the imperative `cron()` accepts. */
  readonly retry?: RetryOptions;
} | {
  /** Discriminator: this job fires on a fixed interval. */
  readonly trigger: 'every';
  /** Unique job name (the `every()` name argument). */
  readonly name: string;
  /** Interval in milliseconds. Required on the `every` arm. */
  readonly intervalMs: number;
  /** Invoked on each fire, exactly as the imperative `every()` accepts. */
  readonly handler: SchedulerJobHandler;
  /** Optional payload handed to the handler. */
  readonly data?: unknown;
  /** Optional retry configuration, exactly as the imperative `every()` accepts. */
  readonly retry?: RetryOptions;
} | {
  /** Discriminator: this job fires once, after a delay. */
  readonly trigger: 'delay';
  /** Unique job name (the `delay()` name argument). */
  readonly name: string;
  /** Delay in milliseconds. Required on the `delay` arm. */
  readonly delayMs: number;
  /** Invoked when the delay expires, exactly as the imperative `delay()` accepts. */
  readonly handler: SchedulerJobHandler;
  /** Optional payload handed to the handler. */
  readonly data?: unknown;
  /** Optional retry configuration, exactly as the imperative `delay()` accepts. */
  readonly retry?: RetryOptions;
};

/**
 * One entry of {@linkcode SchedulerPluginOptions.jobs}: a job definition, or
 * a {@linkcode RegistryFactory} producing one when the definition needs a
 * resolved capability.
 *
 * @since 0.3.0
 */
export type SchedulerJobEntry =
  | SchedulerJobDefinition
  | RegistryFactory<SchedulerJobDefinition>;

/**
 * Options for distributed locking.
 */
export interface DistributedLockOptions {
  /** Enable distributed locking. Default `false`. */
  enabled?: boolean;

  /** Lock backend. Only `'redis'` is supported when `enabled: true`. */
  storage?: 'redis';

  /** Redis connection URL. Default `'redis://localhost:6379'`. */
  url?: string;

  /** Injected ioredis-compatible client (preferred over lazy load). */
  client?: IRedisLockClient;

  /**
   * Custom lock implementation. Takes priority over `storage` when present.
   */
  lock?: IDistributedLock;

  /**
   * Lock TTL in milliseconds. Must exceed the job's worst-case runtime.
   *
   * Bounds TWO distinct guarantees (M70l C3): how long the per-handler
   * OVERLAP mutex lives after a holder dies without releasing, and how long
   * a claimed fire SLOT is remembered before a late replica may re-run it —
   * slot locks are never released, so this value is the replica-skew window.
   * A value below the maximum skew between replicas lets a slow replica
   * re-run an already-claimed fire.
   *
   * @default 30000
   */
  ttlMs?: number;
}

/**
 * Fields common to every registry-entry variant.
 *
 * Variant-specific fields live on the discriminated union members below; the
 * shared scheduling state (pause flag, next fire time, armed timer) lives here.
 */
interface RegistryEntryBase<T = unknown> {
  /** Unique job name (registry key). */
  name: string;
  /** Handler callback. */
  handler: (job: import('@setu-ts/common').ScheduledJob<T>) => void | Promise<void>;
  /** Optional payload. */
  data?: T;
  /** Optional retry config. */
  retry?: import('@setu-ts/common').RetryOptions;
  /** Current pause state. */
  paused: boolean;
  /** Next fire time (epoch ms). */
  nextRunAtMs: number;
  /** Armed timer handle. */
  timerHandle: import('@setu-ts/common').TimerHandle | null;
  /**
   * Generation counter for re-arm guarding (C4).
   * Incremented on each resume() to prevent double-fire when pause()+resume()
   * fires during an in-flight job's await.
   */
  generation?: number;
}

/**
 * Registry entry for a cron-scheduled job.
 */
export interface CronRegistryEntry<T = unknown> extends RegistryEntryBase<T> {
  /** Discriminator: this entry is scheduled via a cron expression. */
  kind: 'cron';
  /** 5-field cron expression (UTC). Always present for `cron` entries. */
  expression: string;
}

/**
 * Registry entry for a fixed-interval (every) job.
 */
export interface EveryRegistryEntry<T = unknown> extends RegistryEntryBase<T> {
  /** Discriminator: this entry fires on a fixed interval. */
  kind: 'every';
  /** Interval in milliseconds. Always present for `every` entries. */
  intervalMs: number;
}

/**
 * Registry entry for a one-shot delayed job.
 */
export interface DelayRegistryEntry<T = unknown> extends RegistryEntryBase<T> {
  /** Discriminator: this entry fires once after a delay. */
  kind: 'delay';
  /** Original delay in milliseconds. Always present for `delay` entries. */
  delayMs: number;
  /**
   * Whether this entry holds the fire slot (M70l F2).
   *
   * Claimed at REGISTRATION time, keyed on the job name — never on
   * `nextRunAtMs`, which for a delay is `now + delayMs` and therefore
   * carries per-replica startup skew that a fire-time key would turn into
   * non-colliding slots. Set by `SchedulerService` in `delay()`; read by
   * `#fire` to decide whether this replica runs the handler.
   */
  slotClaimed: boolean;
  /**
   * The token of the held fire slot, or `null` when this entry does not
   * hold it. Released when the entry leaves the registry (fire, `remove`),
   * so a re-registration under the same name gets a fresh slot.
   */
  slotToken: string | null;
}

/**
 * Internal registry entry for a scheduled job.
 *
 * A discriminated union over `kind`: each variant carries exactly the fields
 * its scheduling strategy needs. Consumers narrow by `kind` and read those
 * fields directly, so there is no need for defensive `?? 0` defaults,
 * `=== undefined` guards, or a switch `default: throw` — the union is closed
 * and TypeScript enforces exhaustiveness.
 */
export type RegistryEntry<T = unknown> =
  | CronRegistryEntry<T>
  | EveryRegistryEntry<T>
  | DelayRegistryEntry<T>;

/**
 * Minimal ioredis client shape required by RedisLock.
 */
export interface IRedisLockClient {
  /** SET key value [NX] [PX ttl] - PX is the milliseconds flag */
  set(key: string, value: string, option: string, px: 'PX', ttl: number): Promise<string | null>;
  /** Quit the connection */
  quit(): Promise<void>;
  /** EVAL script numkeys keys... argv... */
  eval(script: string, numkeys: number, ...keysAndArgs: string[]): Promise<number | string | null>;
}

/**
 * Options for RedisLock construction.
 */
export interface RedisLockOptions {
  /** Redis connection URL. */
  url: string;
  /** Injected ioredis-compatible client. */
  client?: IRedisLockClient;
}
