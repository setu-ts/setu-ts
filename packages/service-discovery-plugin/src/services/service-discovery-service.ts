/**
 * `ServiceDiscoveryService` — the {@linkcode IServiceDiscovery} implementation
 * registered under `CAPABILITIES.SERVICE_DISCOVERY`.
 *
 * Owns the background-refreshed cache, the in-flight coalescing, the balancer, and the
 * ejection filter, so a provider only answers "who is running this service".
 *
 * @module
 */
import {
  createCachedProbe,
  describeError,
  resolveProbeTiming,
  withHttpStatusHint,
  withDeadline,
} from '@setu-ts/common';
import type {
  ConnectionErrorReporter,
  IRuntimeServices,
  IServiceDiscovery,
  PickOptions,
  ServiceInstance,
  ServiceOutcome,
  TimerHandle,
  Unsubscribe,
} from '@setu-ts/common';
import type { DiscoveryProvider } from '../interfaces/index.ts';
import type { ResolvedDiscoveryOptions } from '../options.ts';
import { createLoadBalancer, type LoadBalancer } from '../balancer/load-balancer.ts';
import { RefreshBackoff } from './refresh-backoff.ts';
import { EjectionTracker } from './ejection-tracker.ts';
import { instanceUrl } from '../url/instance-url.ts';
import { DiscoveryUnavailableError } from '../errors.ts';

/** A reporter that drops every report, for a service built without one. */
const SILENT_REPORTER: ConnectionErrorReporter = { report() {}, recovered() {} };

/** One cached instance list with the monotonic reading it was taken at. */
interface CacheEntry {
  instances: readonly ServiceInstance[];
  stampMs: number;
  failed: boolean;
  emptySince?: number;
}

/** A cache acceptance and whether its list changed. */
interface IAcceptedAnswer {
  readonly instances: readonly ServiceInstance[];
  readonly changed: boolean;
}

/** One backend watch shared by a name's subscribers. */
interface INameWatch {
  readonly listeners: Set<(instances: readonly ServiceInstance[]) => void>;
  ready: Promise<void>;
  stop: Unsubscribe | undefined;
  closed: boolean;
}

/**
 * Resolves, balances, and learns from reported outcomes.
 *
 * @since 0.2.0
 */
export class ServiceDiscoveryService implements IServiceDiscovery {
  readonly #provider: DiscoveryProvider;
  readonly #runtime: IRuntimeServices;
  readonly #options: ResolvedDiscoveryOptions;
  readonly #balancer: LoadBalancer;
  readonly #ejection: EjectionTracker | null;
  readonly #probe: () => Promise<boolean>;

  readonly #cache = new Map<string, CacheEntry>();
  readonly #inFlight = new Map<string, Promise<readonly ServiceInstance[]>>();
  readonly #watches = new Set<Unsubscribe>();
  readonly #backoff: RefreshBackoff;
  readonly #resolveReporters = new Map<string, ConnectionErrorReporter>();
  readonly #resolveReporter: (name: string) => ConnectionErrorReporter;
  readonly #onListenerError: (name: string, error: unknown) => void;
  readonly #listenerFailures = new Map<
    string,
    Set<(instances: readonly ServiceInstance[]) => void>
  >();
  readonly #watchSequences = new Map<string, number>();
  readonly #nameWatches = new Map<string, INameWatch>();
  readonly #emptyTimers = new Map<string, TimerHandle>();
  #closed = false;
  /**
   * M70c: set on the first successful provider read. Distinct from
   * per-name failure state, this is what
   * lets the indicator report `down` for a provider that has never once
   * reached its backend — the X10-3 case.
   */
  #everResolved = false;

  /**
   * @param provider - The discovery backend
   * @param runtime - Supplies the monotonic clock and randomness
   * @param options - Options after defaults
   * @param reporter - Receives each probe failure's reason and each recovery
   *   (M139f X10-3); the plugin passes a logging reporter
   * @param resolveReporter - Builds an independent reporter for each failing name
   * @param onListenerError - Receives one listener error per name until every failing listener has succeeded or unsubscribed, or the watch stopped
   */
  constructor(
    provider: DiscoveryProvider,
    runtime: IRuntimeServices,
    options: ResolvedDiscoveryOptions,
    reporter: ConnectionErrorReporter = SILENT_REPORTER,
    resolveReporter: (name: string) => ConnectionErrorReporter = () => SILENT_REPORTER,
    onListenerError: (name: string, error: unknown) => void = () => {},
  ) {
    this.#backoff = new RefreshBackoff(() => runtime.hrtime());
    this.#resolveReporter = resolveReporter;
    this.#onListenerError = onListenerError;
    this.#provider = provider;
    this.#runtime = runtime;
    this.#options = options;
    this.#balancer = createLoadBalancer(options.strategy, runtime);
    this.#ejection =
      options.ejection === false ? null : new EjectionTracker(runtime, options.ejection);
    this.#probe = createCachedProbe({
      probe: async () => {
        const isHealthy = this.#provider.isHealthy;
        if (isHealthy === undefined) return true;
        try {
          if (await isHealthy.call(this.#provider)) {
            reporter.recovered();
            return true;
          }
          reporter.report(
            new Error(`${this.#provider.kind} discovery backend reported unreachable`),
          );
          return false;
        } catch (error) {
          // M139f X10-3: the provider's reason (a TLS UnknownIssuer, an HTTP
          // status) reaches the log once per outage instead of nowhere.
          reporter.report(error);
          return false;
        }
      },
      ttlMs: 5000,
      timeoutMs: 2000,
      ...resolveProbeTiming(runtime),
    });
  }

  /** The backend id, for the health indicator. */
  get providerKind(): string {
    return this.#provider.kind;
  }

  /** Whether a warm name last failed or holds an empty answer during its grace. */
  get degraded(): boolean {
    return [...this.#cache.values()].some(
      (entry) => entry.failed || entry.emptySince !== undefined,
    );
  }

  /** Age of the oldest list whose last refresh failed, or zero. */
  get staleForMs(): number {
    let age = 0;
    for (const entry of this.#cache.values()) {
      if (entry.failed) age = Math.max(age, this.#runtime.hrtime() - entry.stampMs);
    }
    return age;
  }

  /**
   * M70c: whether the provider has ever successfully resolved a service.
   * `false` until the first success; a stale-cache serve never sets it
   * retroactively (there was no prior success to serve from).
   */
  get everResolved(): boolean {
    return this.#everResolved;
  }

  /** Number of service names currently cached. */
  get cachedServices(): number {
    return this.#cache.size;
  }

  /** Number of active watches. */
  get watchedServices(): number {
    return this.#watches.size;
  }

  /** Number of instances currently ejected. */
  get ejectedInstances(): number {
    return this.#ejection?.ejectedCount ?? 0;
  }

  /**
   * M70c: probes the backend reachability for the health indicator. Delegates
   * to the provider's optional `isHealthy?()`; a provider that cannot probe
   * (no member) is treated as reachable so the indicator can fall back on
   * `everResolved`/`degraded` — absence is never reported as `false`.
   * Cached for 5 s, coalesced, and bounded at 2 s; timeout or rejection is false.
   */
  async isHealthy(): Promise<boolean> {
    return await this.#probe();
  }

  async resolve(serviceName: string): Promise<readonly ServiceInstance[]> {
    if (this.#closed) throw new DiscoveryUnavailableError('Service discovery is closed.');
    const cached = this.#cache.get(serviceName);
    if (cached !== undefined) {
      if (
        this.#runtime.hrtime() - cached.stampMs >= this.#options.cacheTtlMs &&
        !this.#inFlight.has(serviceName) &&
        this.#backoff.ready(serviceName)
      ) {
        void this.#startRead(serviceName).catch(() => {
          /* Failure is recorded by #read. */
        });
      }
      return cached.instances;
    }
    return await (this.#inFlight.get(serviceName) ?? this.#startRead(serviceName));
  }

  #startRead(serviceName: string): Promise<readonly ServiceInstance[]> {
    const read = this.#read(serviceName).finally(() => {
      if (this.#inFlight.get(serviceName) === read) this.#inFlight.delete(serviceName);
      this.#scheduleEmptyRefresh(serviceName);
    });
    this.#inFlight.set(serviceName, read);
    return read;
  }

  async pick(serviceName: string, options?: PickOptions): Promise<ServiceInstance | null> {
    const instances = await this.resolve(serviceName);
    const usable = this.#ejection?.filter(serviceName, instances) ?? instances;
    return this.#balancer.pick(serviceName, usable, options?.strategy);
  }

  async resolveUrl(
    serviceName: string,
    path?: string,
    options?: PickOptions,
  ): Promise<string | null> {
    // Funnels through pick() rather than re-resolving: one cache read, one
    // ejection filter, one strategy resolution. Two entry points honoring two
    // different configurations is the split this deliberately avoids.
    const instance = await this.pick(serviceName, options);
    return instance === null ? null : instanceUrl(instance, path);
  }

  report(instance: ServiceInstance, outcome: ServiceOutcome): void {
    if (this.#ejection === null) {
      return;
    }
    const known = this.#cache.get(instance.serviceName)?.instances.length ?? 0;
    this.#ejection.record(instance.serviceName, instance, outcome, known);
  }

  /**
   * Subscribes to a full list through one shared provider watch per name.
   * A later subscriber may receive the cached list immediately; repeated lists
   * may be delivered. The backend watch stops with its last subscriber.
   * @param serviceName - Logical service name
   * @param listener - Receives the full current list; its failures are isolated
   * @returns The unsubscribe function
   */
  async watch(
    serviceName: string,
    listener: (instances: readonly ServiceInstance[]) => void,
  ): Promise<Unsubscribe> {
    if (this.#closed) return () => {};
    let state = this.#nameWatches.get(serviceName);
    const joining = state !== undefined;
    if (state === undefined) {
      state = { listeners: new Set(), ready: Promise.resolve(), stop: undefined, closed: false };
      this.#nameWatches.set(serviceName, state);
      const created = state;
      created.ready = Promise.resolve()
        .then(() =>
          this.#provider.watch(serviceName, (instances) => {
            if (!created.closed) {
              this.#watchSequences.set(
                serviceName,
                (this.#watchSequences.get(serviceName) ?? 0) + 1,
              );
              const accepted = this.#accept(serviceName, instances);
              this.#broadcast(serviceName, accepted.instances);
            }
          }),
        )
        .then((stop) => {
          created.stop = stop;
          if (created.closed) stop();
        });
    }
    const subscribed = (instances: readonly ServiceInstance[]): void => listener(instances);
    state.listeners.add(subscribed);
    try {
      const cached = this.#cache.get(serviceName);
      if (joining && cached !== undefined)
        this.#invokeListener(serviceName, subscribed, cached.instances);
      await state.ready;
    } catch (error) {
      state.listeners.delete(subscribed);
      if (state.listeners.size === 0) this.#stopWatch(serviceName, state);
      throw error;
    }
    const active = state;
    const wrapped = (): void => {
      this.#watches.delete(wrapped);
      active.listeners.delete(subscribed);
      this.#forgetListener(serviceName, subscribed);
      if (active.listeners.size === 0) this.#stopWatch(serviceName, active);
    };
    if (this.#closed) return () => {};
    this.#watches.add(wrapped);
    return wrapped;
  }

  /** Stops watches and clears cache, refresh, retry, reporter and ejection state. */
  close(): void {
    this.#closed = true;
    this.#cache.clear();
    this.#inFlight.clear();
    this.#backoff.clear();
    this.#resolveReporters.clear();
    this.#listenerFailures.clear();
    this.#watchSequences.clear();
    for (const name of this.#emptyTimers.keys()) this.#clearEmptyTimer(name);
    for (const unsubscribe of [...this.#watches]) {
      unsubscribe();
    }
    this.#watches.clear();
    for (const [name, state] of this.#nameWatches) this.#stopWatch(name, state);
    this.#ejection?.clear();
  }

  #stopWatch(name: string, state: INameWatch): void {
    if (state.closed) return;
    state.closed = true;
    state.listeners.clear();
    this.#listenerFailures.delete(name);
    if (this.#nameWatches.get(name) === state) this.#nameWatches.delete(name);
    state.stop?.();
  }

  #clearEmptyTimer(name: string): void {
    const timer = this.#emptyTimers.get(name);
    if (timer !== undefined) this.#runtime.clearTimeout(timer);
    this.#emptyTimers.delete(name);
  }

  #scheduleEmptyRefresh(name: string): void {
    const entry = this.#cache.get(name);
    if (this.#closed || entry?.emptySince === undefined || this.#emptyTimers.has(name)) return;
    const delay = Math.max(
      entry.emptySince + this.#options.emptyAnswerGraceMs - this.#runtime.hrtime(),
      this.#backoff.remainingMs(name),
    );
    const timer = this.#runtime.setTimeout(
      () => {
        this.#emptyTimers.delete(name);
        if (this.#closed || this.#cache.get(name)?.emptySince === undefined) return;
        if (!this.#backoff.ready(name)) {
          this.#scheduleEmptyRefresh(name);
          return;
        }
        if (!this.#inFlight.has(name)) {
          void this.#startRead(name).catch(() => {
            /* #read records the failure. */
          });
        }
      },
      Math.max(0, delay),
    );
    this.#emptyTimers.set(name, timer);
  }

  #forgetListener(name: string, listener: (instances: readonly ServiceInstance[]) => void): void {
    const failed = this.#listenerFailures.get(name);
    failed?.delete(listener);
    if (failed?.size === 0) this.#listenerFailures.delete(name);
  }

  #invokeListener(
    name: string,
    listener: (instances: readonly ServiceInstance[]) => void,
    instances: readonly ServiceInstance[],
  ): void {
    try {
      listener(instances);
      this.#forgetListener(name, listener);
    } catch (error) {
      const failed =
        this.#listenerFailures.get(name) ??
        new Set<(instances: readonly ServiceInstance[]) => void>();
      const warn = failed.size === 0;
      failed.add(listener);
      this.#listenerFailures.set(name, failed);
      if (warn) {
        try {
          this.#onListenerError(name, error);
        } catch {
          /* A diagnostic sink must not change discovery or skip subscribers. */
        }
      }
    }
  }

  #broadcast(name: string, instances: readonly ServiceInstance[]): void {
    const state = this.#nameWatches.get(name);
    for (const listener of [...(state?.listeners ?? [])])
      this.#invokeListener(name, listener, instances);
  }

  #resolveReporterFor(name: string): ConnectionErrorReporter {
    const reporter = this.#resolveReporters.get(name) ?? this.#resolveReporter(name);
    this.#resolveReporters.delete(name);
    this.#resolveReporters.set(name, reporter);
    if (this.#resolveReporters.size > 256)
      this.#resolveReporters.delete(this.#resolveReporters.keys().next().value!);
    return reporter;
  }

  #readSucceeded(name: string): void {
    this.#backoff.reset(name);
    // The reporter lives only while the name's failure run is open, so the
    // 256 bound counts names failing now, never names that recovered long ago.
    const reporter = this.#resolveReporters.get(name);
    if (reporter !== undefined) {
      this.#resolveReporters.delete(name);
      reporter.recovered();
    }
    this.#everResolved = true;
  }

  /** Store every successful read and watch delivery through the same empty rule. */
  #accept(serviceName: string, instances: readonly ServiceInstance[]): IAcceptedAnswer {
    const old = this.#cache.get(serviceName);
    const now = this.#runtime.hrtime();
    const emptySince = old?.emptySince ?? now;
    const held =
      instances.length === 0 &&
      old !== undefined &&
      old.instances.length > 0 &&
      now - emptySince < this.#options.emptyAnswerGraceMs;
    const accepted = held ? old.instances : instances;
    if (old === undefined && instances.length === 0) {
      // A cold empty answer is not stored: a name nobody has a list for gains
      // no cache entry, so absent names (NXDOMAIN on the DNS arm) cannot grow
      // the cache. It is still a successful read.
      this.#readSucceeded(serviceName);
      return { instances, changed: false };
    }
    this.#cache.set(serviceName, {
      instances: accepted,
      stampMs: now,
      failed: false,
      ...(held ? { emptySince } : {}),
    });
    this.#readSucceeded(serviceName);
    if (held) this.#scheduleEmptyRefresh(serviceName);
    else this.#clearEmptyTimer(serviceName);
    const changed = old === undefined || JSON.stringify(old.instances) !== JSON.stringify(accepted);
    return { instances: accepted, changed };
  }

  async #read(serviceName: string): Promise<readonly ServiceInstance[]> {
    const sequence = this.#watchSequences.get(serviceName) ?? 0;
    let instances: readonly ServiceInstance[];
    try {
      const ms = this.#options.resolveTimeoutMs;
      instances = await withDeadline((signal) => this.#provider.resolve(serviceName, signal), {
        timeoutMs: ms,
        timing: resolveProbeTiming(this.#runtime),
        onTimeout: () =>
          new Error(
            `${this.#provider.kind} discovery did not answer the read for '${serviceName}' within ${ms} ms`,
          ),
      });
    } catch (error) {
      if (!this.#closed) {
        const reporter = this.#resolveReporterFor(serviceName);
        reporter.report(error);
        const stale = this.#cache.get(serviceName);
        // A newer watch delivery arrived while this read was in flight: the
        // list in hand is fresher than the failed read, so it is not marked
        // failed and no retry spacing starts.
        if (stale !== undefined && (this.#watchSequences.get(serviceName) ?? 0) !== sequence) {
          return stale.instances;
        }
        if (stale !== undefined) {
          stale.failed = true;
          this.#backoff.failed(serviceName);
          return stale.instances;
        }
      }
      // A provider's own DiscoveryUnavailableError is a configuration fault (a
      // multi-port Kubernetes service with no portName), not an outage: it
      // passes through unbranded, so it is answered as a 500, not a 503.
      if (error instanceof DiscoveryUnavailableError) {
        throw error;
      }
      throw withHttpStatusHint(
        new DiscoveryUnavailableError(
          `Service discovery could not resolve '${serviceName}' and has nothing cached: ${describeError(error)}`,
          { cause: error },
        ),
        {
          status: 503,
          title: 'Service Unavailable',
          detail: 'Service discovery is temporarily unavailable.',
        },
      );
    }
    if (this.#closed) return instances;
    if ((this.#watchSequences.get(serviceName) ?? 0) !== sequence) {
      this.#readSucceeded(serviceName);
      return this.#cache.get(serviceName)!.instances;
    }
    const accepted = this.#accept(serviceName, instances);
    if (accepted.changed) this.#broadcast(serviceName, accepted.instances);
    return accepted.instances;
  }
}
