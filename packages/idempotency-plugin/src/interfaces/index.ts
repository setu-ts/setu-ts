/**
 * Plugin-specific public interfaces: the Redis client facade, the store
 * configuration union, and the plugin options (plan §3.5, §4.1).
 *
 * @module
 */
import type {
  IIdempotencyStore,
  ITransactionalIdempotencyStore,
  RegistryFactory,
} from '@setu-ts/common';

/**
 * The minimal Redis client surface the Redis store needs. A real `ioredis`
 * `Redis` instance is assignable to it with no cast.
 *
 * @since 0.9.0
 */
export interface IRedisIdempotencyClient {
  /** Runs a Lua script, passing values only through `numkeys` and `args`. */
  eval(script: string, numkeys: number, ...args: (string | number)[]): Promise<unknown>;
  /** Round-trips a `PING`. */
  ping(): Promise<string>;
  /** Closes the connection. */
  quit(): Promise<unknown>;
  /** Runs a raw command, e.g. `call('CONFIG', 'GET', 'maxmemory-policy')`. */
  call(command: string, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * The shape of a client this package BUILDS (internal, not exported).
 *
 * @since 0.9.0
 */
export interface IBuiltRedisIdempotencyClient extends IRedisIdempotencyClient {
  /** Opens the lazily-created connection. */
  connect(): Promise<void>;
  /** Attaches an error listener. */
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/**
 * Which store backs the idempotency service (plan §4.1).
 *
 * @since 0.9.0
 */
export type IdempotencyStoreConfig =
  | {
    /** The in-process store. */
    readonly type: 'memory';
    /** Global entry cap. Default 100,000. */
    readonly maxEntries?: number;
    /** Per-scope entry cap. Default 1,000; at most `maxEntries`. */
    readonly maxEntriesPerScope?: number;
    /** Global byte cap (approximate). Default 67,108,864. */
    readonly maxBytes?: number;
  }
  | {
    /** The Redis store, over a client this package builds lazily. */
    readonly type: 'redis';
    /** Required. Isolates this application's records from another on the same Redis. */
    readonly namespace: string;
    /** The Redis connection URL. */
    readonly url: string;
    /** Must be absent on this arm — a URL and a client are mutually exclusive. */
    readonly client?: never;
    /** Per-command timeout in ms. Default 15,000; `0` disables. */
    readonly commandTimeoutMs?: number;
    /** Key prefix. Default `'setu:idempotency:'`. */
    readonly keyPrefix?: string;
  }
  | {
    /** The Redis store, over a caller-supplied client. */
    readonly type: 'redis';
    /** Required. Isolates this application's records from another on the same Redis. */
    readonly namespace: string;
    /** The caller-owned Redis client. */
    readonly client: IRedisIdempotencyClient;
    /** Must be absent on this arm — a client and a URL are mutually exclusive. */
    readonly url?: never;
    /** Key prefix. Default `'setu:idempotency:'`. */
    readonly keyPrefix?: string;
  }
  | {
    /** Any `IIdempotencyStore` the application supplies. */
    readonly type: 'custom';
    /** The store instance, passed through unchanged. */
    readonly store: IIdempotencyStore;
  };

/**
 * The tier-C retention purge's schedule (plan §3.10).
 *
 * @since 0.9.0
 */
export interface TransactionalIdempotencyPurgeOptions {
  /** Runs the purge on `CAPABILITIES.SCHEDULER`. Default `true`; `false` means a manual `purgeTransactional()`. */
  readonly schedule?: boolean;
  /** Purge interval in milliseconds. Integer 1–2,147,483,647. Default 60,000. */
  readonly intervalMs?: number;
  /** Records deleted per purge. Integer 1–100,000. Default 100. */
  readonly batch?: number;
}

/**
 * The tier-C (`within`) configuration (plan §3.5).
 *
 * @since 0.9.0
 */
export interface TransactionalIdempotencyOptions {
  /**
   * The transactional store: an `ITransactionalIdempotencyStore`, or a
   * {@linkcode RegistryFactory} resolved at `onInit` (so `DatabasePlugin` may
   * register before or after).
   */
  readonly store: ITransactionalIdempotencyStore | RegistryFactory<ITransactionalIdempotencyStore>;
  /** Default record eligibility age. Integer 60,000–2,592,000,000. Default 86,400,000. */
  readonly ttlMs?: number;
  /** Bounds each store call except the transaction itself. Integer 1–2,147,483,647. Default 5,000. */
  readonly storeTimeoutMs?: number;
  /** Largest storable result in UTF-8 bytes. Integer 2–262,144. Default 65,536. */
  readonly maxResultBytes?: number;
  /** The retention purge. Defaults: scheduled every 60,000 ms, batch 100. */
  readonly purge?: TransactionalIdempotencyPurgeOptions;
}

/**
 * Options for {@linkcode IdempotencyPlugin}.
 *
 * @since 0.9.0
 */
export interface IdempotencyPluginOptions {
  /** Default `{ type: 'memory' }`. */
  readonly store?: IdempotencyStoreConfig;
  /** Default HTTP lease. Default 60,000. */
  readonly leaseMs?: number;
  /** Default ingress lease. Default 30,000. */
  readonly ingressLeaseMs?: number;
  /** Default retention. Default 86,400,000. */
  readonly ttlMs?: number;
  /** Default HTTP body cap. Default 262,144. */
  readonly maxResponseBytes?: number;
  /** Tier C: enables `within` and the retention purge. Default: unconfigured. */
  readonly transactional?: TransactionalIdempotencyOptions;
}
