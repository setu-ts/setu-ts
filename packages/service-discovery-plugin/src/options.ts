/**
 * Plugin options — a union discriminated on `provider`, plus the one place
 * every default is applied.
 *
 * The union is what makes a missing per-arm credential a **compile** error
 * rather than a startup throw: `provider: 'consul'` without an `address` does
 * not type-check, so there is no runtime branch to test for it.
 *
 * @module
 */
import type { LoadBalanceStrategy } from '@hono-enterprise/common';
import type {
  DiscoveryProvider,
  EjectionOptions,
  IDiscoveryHttp,
  SelfRegistration,
  SelfRegistrationCheck,
  StaticServiceDefinition,
} from './interfaces/index.ts';

/** Options every arm shares. */
interface CommonDiscoveryOptions {
  /**
   * Milliseconds a resolved instance list is served from cache.
   *
   * `0` disables caching so every `resolve` hits the backend. A watched
   * service invalidates its own entry on every change, so this is a safety net
   * rather than the primary freshness mechanism.
   */
  readonly cacheTtlMs?: number;
  /** Default selection strategy; `PickOptions.strategy` overrides it per call. */
  readonly strategy?: LoadBalanceStrategy;
  /** Outlier-ejection tuning, or `false` to disable ejection entirely. */
  readonly ejection?: EjectionOptions | false;
  /** Advertise this instance to the backend (Consul only). */
  readonly selfRegistration?: SelfRegistration;
}

/**
 * The `'static'` arm — a literal instance list, with no backend at all.
 *
 * @since 0.2.0
 */
export interface StaticDiscoveryOptions extends CommonDiscoveryOptions {
  /** Discriminant. */
  readonly provider: 'static';
  /** Service name to its instances. An unknown name resolves to `[]`. */
  readonly services: Readonly<Record<string, readonly StaticServiceDefinition[]>>;
  /**
   * Milliseconds between `watch()` polls.
   *
   * The list is immutable by construction, so a static watch fires once with
   * it and never again — this exists so the option is uniform across the two
   * poll-based arms, and the static watch reads it only to schedule that first
   * delivery on the next tick.
   */
  readonly watchIntervalMs?: number;
}

/**
 * The `'consul'` arm.
 *
 * @since 0.2.0
 */
export interface ConsulDiscoveryOptions extends CommonDiscoveryOptions {
  /** Discriminant. */
  readonly provider: 'consul';
  /** Base URL of the Consul agent, e.g. `http://127.0.0.1:8500`. */
  readonly address: string;
  /** ACL token, sent as `X-Consul-Token`. */
  readonly token?: string;
  /** Datacenter, sent as `?dc=`. */
  readonly datacenter?: string;
  /**
   * Blocking-query `wait`, in seconds. Default `30`, clamped to Consul's
   * documented maximum of 600.
   */
  readonly waitSeconds?: number;
  /** Whether resolved instances speak TLS — Consul carries no scheme. */
  readonly secure?: boolean;
  /** Overrides the default `fetch`-backed HTTP seam. */
  readonly http?: IDiscoveryHttp;
}

/**
 * The `'kubernetes'` arm — EndpointSlices read from the API server.
 *
 * @since 0.2.0
 */
export interface KubernetesDiscoveryOptions extends CommonDiscoveryOptions {
  /** Discriminant. */
  readonly provider: 'kubernetes';
  /** Namespace the services live in. */
  readonly namespace: string;
  /**
   * API server base URL. Defaults to the in-cluster
   * `https://$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT`.
   */
  readonly apiServer?: string;
  /**
   * Bearer token, used verbatim.
   *
   * Omit it in-cluster and the provider reads the projected service-account
   * token instead, re-reading it periodically because Kubernetes rotates it.
   */
  readonly token?: string;
  /** Selects the `ports[]` entry by name when a service exposes several. */
  readonly portName?: string;
  /** Whether resolved instances speak TLS. */
  readonly secure?: boolean;
  /** Overrides the default `fetch`-backed HTTP seam. */
  readonly http?: IDiscoveryHttp;
}

/** Shared fields of the two DNS modes. */
interface DnsDiscoveryCommon extends CommonDiscoveryOptions {
  /** Discriminant. */
  readonly provider: 'dns';
  /** `{service}` is replaced with the requested name. */
  readonly domainTemplate?: string;
  /** Whether resolved instances speak TLS. */
  readonly secure?: boolean;
  /** Milliseconds between `watch()` polls — DNS has no push channel. */
  readonly watchIntervalMs?: number;
}

/** The `'dns'` arm in `SRV` mode — records carry their own ports. */
export interface SrvDnsDiscoveryOptions extends DnsDiscoveryCommon {
  /** Query `SRV` records and honor RFC 2782 priority tiers. */
  readonly mode: 'srv';
}

/** The `'dns'` arm in address mode — `A`/`AAAA` records carry no port. */
export interface ADnsDiscoveryOptions extends DnsDiscoveryCommon {
  /** Query `A`/`AAAA` records. */
  readonly mode: 'a';
  /**
   * Port every resolved address is reached on.
   *
   * Mandatory in this mode and absent from the `'srv'` arm: DNS address
   * records carry no port, and defaulting to 80 would silently point traffic
   * at the wrong place.
   */
  readonly port: number;
}

/**
 * The `'dns'` arm.
 *
 * @since 0.2.0
 */
export type DnsDiscoveryOptions = SrvDnsDiscoveryOptions | ADnsDiscoveryOptions;

/**
 * The `'custom'` arm — the application's own backend.
 *
 * @since 0.2.0
 */
export interface CustomDiscoveryOptions extends CommonDiscoveryOptions {
  /** Discriminant. */
  readonly provider: 'custom';
  /** The provider, used as supplied. */
  readonly discovery: DiscoveryProvider;
}

/**
 * Options accepted by `ServiceDiscoveryPlugin`.
 *
 * @since 0.2.0
 */
export type ServiceDiscoveryPluginOptions =
  | StaticDiscoveryOptions
  | ConsulDiscoveryOptions
  | KubernetesDiscoveryOptions
  | DnsDiscoveryOptions
  | CustomDiscoveryOptions;

/** Consul's documented maximum blocking-query wait, in seconds. */
const MAX_WAIT_SECONDS = 600;

/** The check applied when `selfRegistration` names none. */
const DEFAULT_CHECK: SelfRegistrationCheck = {
  httpPath: '/health',
  intervalSeconds: 10,
  deregisterAfterSeconds: 60,
};

/** Ejection tuning applied when `ejection` is omitted. */
const DEFAULT_EJECTION: Required<EjectionOptions> = {
  failureThreshold: 5,
  windowMs: 30_000,
  durationMs: 30_000,
  maxEjectionPercent: 50,
};

/**
 * Every option after defaults, in the shape the service and plugin read.
 *
 * @since 0.2.0
 */
export interface ResolvedDiscoveryOptions {
  /** Cache TTL in milliseconds; `0` disables caching. */
  readonly cacheTtlMs: number;
  /** Default selection strategy. */
  readonly strategy: LoadBalanceStrategy;
  /** Ejection tuning, or `false` when disabled. */
  readonly ejection: Required<EjectionOptions> | false;
  /** Self-registration with its check and drain delay filled in. */
  readonly selfRegistration?: SelfRegistration & {
    readonly check: SelfRegistrationCheck;
    readonly drainDelayMs: number;
  };
  /** Poll interval for the providers with no push channel. */
  readonly watchIntervalMs: number;
  /** Blocking-query wait in seconds, clamped to Consul's maximum. */
  readonly waitSeconds: number;
}

/**
 * Applies every documented default exactly once.
 *
 * Written with explicit `!== undefined` checks rather than `??` where `0` and
 * `false` are meaningful values: `cacheTtlMs ?? 30_000` would quietly turn a
 * deliberate `0` into the default, and `ejection` distinguishes `false` from
 * absent.
 *
 * @param options - The application's option literal
 * @returns Options with defaults applied
 * @since 0.2.0
 */
export function resolveOptions(
  options: ServiceDiscoveryPluginOptions,
): ResolvedDiscoveryOptions {
  const watchIntervalMs = 'watchIntervalMs' in options && options.watchIntervalMs !== undefined
    ? options.watchIntervalMs
    : 30_000;

  const waitSeconds = options.provider === 'consul' && options.waitSeconds !== undefined
    ? Math.min(options.waitSeconds, MAX_WAIT_SECONDS)
    : 30;

  const ejection: Required<EjectionOptions> | false = options.ejection === false
    ? false
    : { ...DEFAULT_EJECTION, ...(options.ejection ?? {}) };

  const base = {
    cacheTtlMs: options.cacheTtlMs !== undefined ? options.cacheTtlMs : 30_000,
    strategy: options.strategy ?? ('round-robin' as const),
    ejection,
    watchIntervalMs,
    waitSeconds,
  };

  if (options.selfRegistration === undefined) {
    return base;
  }

  return {
    ...base,
    selfRegistration: {
      ...options.selfRegistration,
      check: options.selfRegistration.check ?? DEFAULT_CHECK,
      drainDelayMs: options.selfRegistration.drainDelayMs ?? 0,
    },
  };
}
