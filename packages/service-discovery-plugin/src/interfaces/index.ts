/**
 * Internal ports and injectable seams of the service discovery plugin.
 *
 * @module
 */
import type { ServiceInstance, Unsubscribe } from '@setu-ts/common';

/**
 * A discovery backend.
 *
 * The plugin's caching, balancing, and ejection all sit above this port, so a
 * provider only has to answer "who is running this service" and, where its
 * backend supports it, "tell me when that changes".
 *
 * @since 0.2.0
 */
export interface DiscoveryProvider {
  /** Backend id, surfaced by the health indicator. */
  readonly kind: string;

  /**
   * Reads the current instance list for a service.
   *
   * @param serviceName - Logical service name
   * @returns Every instance the backend reports, possibly empty
   * @throws {Error} If the backend cannot be read
   */
  resolve(serviceName: string): Promise<readonly ServiceInstance[]>;

  /**
   * Subscribes to instance-list changes.
   *
   * Push-based where the backend supports it, interval-polled where it does
   * not. The listener always receives the full list.
   *
   * @param serviceName - Logical service name
   * @param listener - Called with the full instance list on every change
   * @returns Unsubscribe function that stops the underlying watch
   */
  watch(
    serviceName: string,
    listener: (instances: readonly ServiceInstance[]) => void,
  ): Promise<Unsubscribe>;

  /**
   * Registers this application instance with the backend.
   *
   * Present only on providers with a registration API (Consul).
   *
   * @param registration - What to advertise
   */
  registerSelf?(registration: SelfRegistration): Promise<void>;

  /**
   * Removes this application instance from the backend.
   *
   * @param registration - The registration to remove
   */
  deregisterSelf?(registration: SelfRegistration): Promise<void>;
}

/**
 * The health check the backend runs against this instance after registration.
 *
 * Not optional and not disable-able: self-registration happens at `onBootstrap`,
 * which runs before the socket is bound, so the instance is advertised for a
 * short window before it can serve. That window is harmless only because the
 * backend marks a newly registered service critical until its first check
 * passes and every read filters on passing instances — which makes the check
 * load-bearing rather than a convenience.
 *
 * @since 0.2.0
 */
export interface SelfRegistrationCheck {
  /** HTTP path the backend polls, appended to this instance's origin. */
  readonly httpPath: string;
  /** Seconds between checks. */
  readonly intervalSeconds: number;
  /** Seconds a critical service survives before the backend removes it. */
  readonly deregisterAfterSeconds: number;
}

/**
 * What this application advertises about itself.
 *
 * @since 0.2.0
 */
export interface SelfRegistration {
  /** Logical service name other applications resolve. */
  readonly serviceName: string;
  /** Instance id, unique within the service. Defaults to `<name>-<uuid>`. */
  readonly id?: string;
  /** Address other applications should reach this instance on. */
  readonly address: string;
  /** Port other applications should reach this instance on. */
  readonly port: number;
  /** Labels to attach to the registration. */
  readonly tags?: readonly string[];
  /** Key/value metadata to attach to the registration. */
  readonly metadata?: Readonly<Record<string, string>>;
  /** The mandatory health check (defaults applied by `resolveOptions`). */
  readonly check?: SelfRegistrationCheck;
  /**
   * Milliseconds to keep serving after deregistering, before draining begins.
   *
   * The point of the delay is propagation: callers that already hold a stale
   * instance list keep sending traffic for a moment after the registry forgets
   * this instance, and this window serves them normally instead of refusing.
   */
  readonly drainDelayMs?: number;
}

/**
 * Outlier-ejection tuning.
 *
 * @since 0.2.0
 */
export interface EjectionOptions {
  /** Failures inside the window that eject an instance. */
  readonly failureThreshold?: number;
  /** Rolling window, in milliseconds, that failures are counted over. */
  readonly windowMs?: number;
  /** How long an ejection lasts, in milliseconds. */
  readonly durationMs?: number;
  /**
   * Ceiling on the percentage of a service's instances ejected at once.
   *
   * A correlated failure — a bad deploy, a shared dependency — makes every
   * instance report failures at the same time, and ejecting all of them turns
   * a partial outage into a total one. An ejection that would push past this
   * cap simply does not happen.
   */
  readonly maxEjectionPercent?: number;
}

/**
 * One entry of a `'static'` service list.
 *
 * @since 0.2.0
 */
export interface StaticServiceDefinition {
  /** Instance id. Synthesized as `<host>:<port>` when omitted. */
  readonly id?: string;
  /** Hostname or IP literal. */
  readonly host: string;
  /** TCP port. */
  readonly port: number;
  /** Whether the instance speaks TLS. */
  readonly secure?: boolean;
  /** Relative selection weight for `'weighted-random'`. */
  readonly weight?: number;
  /** Labels. */
  readonly tags?: readonly string[];
  /** Key/value metadata. */
  readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * A buffered HTTP response, as {@linkcode IDiscoveryHttp.request} returns it.
 *
 * `headers` is exposed because Consul's blocking-query protocol lives entirely
 * in the `X-Consul-Index` response header.
 *
 * @since 0.2.0
 */
export interface DiscoveryHttpResponse {
  /** Whether the status is 2xx. */
  readonly ok: boolean;
  /** HTTP status code. */
  readonly status: number;
  /** Response headers. */
  readonly headers: Headers;
  /** Response body, read to completion as text. */
  readonly text: string;
}

/**
 * A streaming HTTP response, as {@linkcode IDiscoveryHttp.stream} returns it.
 *
 * A Kubernetes watch is a chunked response that never ends while the watch is
 * open, so reading it with `text()` would never resolve.
 *
 * @since 0.2.0
 */
export interface DiscoveryHttpStream {
  /** Whether the status is 2xx. */
  readonly ok: boolean;
  /** HTTP status code. */
  readonly status: number;
  /** Response headers. */
  readonly headers: Headers;
  /** The response body, or `null` when the response carries none. */
  readonly body: ReadableStream<Uint8Array> | null;
}

/**
 * The HTTP surface the Consul and Kubernetes providers need.
 *
 * One seam with two methods rather than two seams: both providers need both a
 * buffered read and a streaming one. Injecting it is also the documented
 * escape hatch for a caller-supplied TLS configuration — an in-cluster
 * Kubernetes API server presents a CA that plain `fetch` rejects.
 *
 * @since 0.2.0
 */
export interface IDiscoveryHttp {
  /**
   * Performs a request and reads the whole body.
   *
   * A non-2xx response is returned with `ok: false`, never thrown — callers
   * decide what a 404 or a 410 means.
   *
   * @param url - Absolute URL
   * @param init - Standard fetch init
   * @returns The buffered response
   */
  request(url: string, init?: RequestInit): Promise<DiscoveryHttpResponse>;

  /**
   * Performs a request and leaves the body unread.
   *
   * @param url - Absolute URL
   * @param init - Standard fetch init
   * @returns The streaming response
   */
  stream(url: string, init?: RequestInit): Promise<DiscoveryHttpStream>;
}
