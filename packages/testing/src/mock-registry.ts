import type {
  CapabilityToken,
  CapabilityServices,
  StandardCapabilityToken,
  KeysServing,
  UnboundCapability,
  UnboundToken,
  ServiceToken,
  RequestServiceToken,
  RequestBoundService,
  IServiceRegistry,
  RegisterOptions,
  ServiceFactory,
} from '@setu-ts/common';

interface Registration {
  instance?: object;
  factory?: ServiceFactory<object>;
}

/**
 * In-memory `IServiceRegistry` with registration recording.
 *
 * Reproduces the kernel `ServiceRegistry`'s observable semantics
 * field-for-field, because a double that diverges hides the bug it
 * exists to catch:
 *
 * - `get` resolves a factory once and caches it; on a miss throws the
 *   kernel's verbatim two-sentence message.
 * - `getAll` returns `[...(single ? [single] : []), ...multi]` — the
 *   **single** registration is included, not just the multi list.
 * - `register`/`registerFactory` honor `RegisterOptions` exactly:
 *   `multi: true` appends; otherwise a second registration throws
 *   unless `override: true` replaces it.
 * - `has` checks both maps; `unregister` deletes from both.
 * - A readonly `registrations` field records every call.
 *
 * Its public overloads check token/interface pairings just like `IServiceRegistry`.
 *
 * @since 0.1.0
 */
export class MockServiceRegistry implements IServiceRegistry {
  readonly #single = new Map<CapabilityToken, Registration>();
  readonly #multi = new Map<CapabilityToken, Registration[]>();
  /**
   * Records every `register`/`registerFactory` call, in order.
   *
   * Exposed as a `ReadonlyArray` so a test can assert against the recording
   * without being able to rewrite it; `#record` is the mutable backing store.
   */
  get registrations(): ReadonlyArray<{ token: string; multi: boolean }> {
    return this.#record;
  }

  readonly #record: Array<{ token: string; multi: boolean }> = [];

  /** Token-checked registry operation. */
  register<K extends keyof CapabilityServices>(
    token: StandardCapabilityToken<K>,
    service: CapabilityServices[K],
    options?: RegisterOptions,
  ): void;
  register<T extends object>(
    token: StandardCapabilityToken<KeysServing<T>>,
    service: T,
    options?: RegisterOptions,
  ): void;
  register<T extends object>(
    token: StandardCapabilityToken<UnboundCapability>,
    service: T,
    options?: RegisterOptions,
  ): void;
  register<T extends object>(token: ServiceToken<T>, service: T, options?: RegisterOptions): void;
  register<T extends object>(
    token: RequestServiceToken<T>,
    service: RequestBoundService<T>,
    options?: RegisterOptions,
  ): void;
  register<T extends object>(token: UnboundToken, service: T, options?: RegisterOptions): void;
  register<T extends object>(token: CapabilityToken, service: T, options?: RegisterOptions): void {
    this.#store(token, { instance: service }, options);
  }

  /** Token-checked registry operation. */
  registerFactory<K extends keyof CapabilityServices>(
    token: StandardCapabilityToken<K>,
    factory: ServiceFactory<CapabilityServices[K]>,
    options?: RegisterOptions,
  ): void;
  registerFactory<T extends object>(
    token: StandardCapabilityToken<KeysServing<T>>,
    factory: ServiceFactory<T>,
    options?: RegisterOptions,
  ): void;
  registerFactory<T extends object>(
    token: StandardCapabilityToken<UnboundCapability>,
    factory: ServiceFactory<T>,
    options?: RegisterOptions,
  ): void;
  registerFactory<T extends object>(
    token: ServiceToken<T>,
    factory: ServiceFactory<T>,
    options?: RegisterOptions,
  ): void;
  registerFactory<T extends object>(
    token: RequestServiceToken<T>,
    factory: ServiceFactory<RequestBoundService<T>>,
    options?: RegisterOptions,
  ): void;
  registerFactory<T extends object>(
    token: UnboundToken,
    factory: ServiceFactory<T>,
    options?: RegisterOptions,
  ): void;
  registerFactory<T extends object>(
    token: CapabilityToken,
    factory: ServiceFactory<T>,
    options?: RegisterOptions,
  ): void {
    this.#store(token, { factory }, options);
  }

  /** Token-checked registry operation. */
  get<K extends keyof CapabilityServices>(token: StandardCapabilityToken<K>): CapabilityServices[K];
  get<T extends object>(token: StandardCapabilityToken<KeysServing<T>>): T;
  get<T extends object>(token: StandardCapabilityToken<UnboundCapability>): T;
  get<T extends object>(token: ServiceToken<T>): T;
  get<T extends object>(token: UnboundToken): T;
  get<T extends object>(token: CapabilityToken): T {
    const registration = this.#lookup(token);
    if (registration === undefined) {
      throw new Error(
        `No service registered for capability '${token}'. ` +
          `Register a plugin that provides it, or check the token spelling against CAPABILITIES.`,
      );
    }
    return this.#resolve(registration) as T;
  }

  /** Token-checked registry operation. */
  getAll<K extends keyof CapabilityServices>(
    token: StandardCapabilityToken<K>,
  ): readonly CapabilityServices[K][];
  getAll<T extends object>(token: StandardCapabilityToken<KeysServing<T>>): readonly T[];
  getAll<T extends object>(token: StandardCapabilityToken<UnboundCapability>): readonly T[];
  getAll<T extends object>(token: ServiceToken<T>): readonly T[];
  getAll<T extends object>(token: UnboundToken): readonly T[];
  getAll<T extends object>(token: CapabilityToken): readonly T[] {
    const own = this.#multi.get(token) ?? [];
    const single = this.#single.get(token);
    return [
      ...(single ? [this.#resolve(single) as T] : []),
      ...own.map((reg) => this.#resolve(reg) as T),
    ];
  }

  has(token: CapabilityToken): boolean {
    return this.#single.has(token) || this.#multi.has(token);
  }

  unregister(token: CapabilityToken): boolean {
    const hadSingle = this.#single.delete(token);
    const hadMulti = this.#multi.delete(token);
    return hadSingle || hadMulti;
  }

  #store(token: CapabilityToken, registration: Registration, options?: RegisterOptions): void {
    this.#record.push({
      token,
      multi: options?.multi ?? false,
    });

    if (options?.multi) {
      const providers = this.#multi.get(token) ?? [];
      providers.push(registration);
      this.#multi.set(token, providers);
      return;
    }

    if (this.#single.has(token) && !options?.override) {
      throw new Error(
        `Capability '${token}' is already registered. Use { override: true } to replace it.`,
      );
    }
    this.#single.set(token, registration);
  }

  #lookup(token: CapabilityToken): Registration | undefined {
    return this.#single.get(token) ?? this.#multi.get(token)?.[0];
  }

  #resolve(registration: Registration): object {
    if (registration.instance === undefined) {
      registration.instance = registration.factory!();
    }
    return registration.instance;
  }
}
