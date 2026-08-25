/**
 * Capability-token service registry — the framework's primary service
 * resolution mechanism (ARCHITECTURE.md §6).
 *
 * @module
 */
import type {
  CapabilityToken,
  IServiceRegistry,
  RegisterOptions,
  ServiceFactory,
} from '@setu-ts/common';

interface Registration {
  instance?: object;
  factory?: ServiceFactory<object>;
}

function resolveRegistration(registration: Registration): object {
  if (registration.instance === undefined) {
    // Lazy factory: instantiate on first lookup, cache for subsequent ones.
    registration.instance = registration.factory!();
  }
  return registration.instance;
}

/**
 * Default {@linkcode IServiceRegistry} implementation. Request scopes are
 * modeled as child registries that fall back to their parent for lookups
 * while keeping their own registrations isolated.
 */
export class ServiceRegistry implements IServiceRegistry {
  readonly #single = new Map<CapabilityToken, Registration>();
  readonly #multi = new Map<CapabilityToken, Registration[]>();
  readonly #parent: ServiceRegistry | undefined;
  #sealed = false;
  #observer: ((kind: 'override' | 'unregister', token: CapabilityToken) => void) | undefined;

  constructor(parent?: ServiceRegistry) {
    this.#parent = parent;
  }

  /** Creates a request-scoped child registry that falls back to this one. */
  createChild(): ServiceRegistry {
    return new ServiceRegistry(this);
  }

  /** Prevents future application-scoped registrations. */
  seal(): void {
    this.#sealed = true;
  }

  /** Installs the application-owned callback for startup-time mutations. */
  setObserver(
    observer: (kind: 'override' | 'unregister', token: CapabilityToken) => void,
  ): void {
    this.#observer = observer;
  }

  register<T extends object>(
    token: CapabilityToken,
    service: T,
    options?: RegisterOptions,
  ): void {
    this.#store(token, { instance: service }, options);
  }

  registerFactory<T extends object>(
    token: CapabilityToken,
    factory: ServiceFactory<T>,
    options?: RegisterOptions,
  ): void {
    this.#store(token, { factory }, options);
  }

  get<T extends object>(token: CapabilityToken): T {
    const registration = this.#lookup(token);
    if (registration === undefined) {
      throw new Error(
        `No service registered for capability '${token}'. ` +
          `Register a plugin that provides it, or check the token spelling against CAPABILITIES.`,
      );
    }
    return resolveRegistration(registration) as T;
  }

  getAll<T extends object>(token: CapabilityToken): readonly T[] {
    const own = this.#multi.get(token) ?? [];
    const inherited = this.#parent?.getAll<T>(token) ?? [];
    const single = this.#single.get(token);
    return [
      ...inherited,
      ...(single ? [resolveRegistration(single) as T] : []),
      ...own.map((registration) => resolveRegistration(registration) as T),
    ];
  }

  has(token: CapabilityToken): boolean {
    return this.#single.has(token) || this.#multi.has(token) || (this.#parent?.has(token) ?? false);
  }

  unregister(token: CapabilityToken): boolean {
    this.#assertMutable(token, 'unregister');
    const hadSingle = this.#single.delete(token);
    const hadMulti = this.#multi.delete(token);
    const removed = hadSingle || hadMulti;
    if (removed) {
      this.#observer?.('unregister', token);
    }
    return removed;
  }

  #lookup(token: CapabilityToken): Registration | undefined {
    const own = this.#single.get(token) ?? this.#multi.get(token)?.[0];
    if (own !== undefined) {
      return own;
    }
    if (this.#parent === undefined) {
      return undefined;
    }
    return this.#parent.#lookup(token);
  }

  #store(token: CapabilityToken, registration: Registration, options?: RegisterOptions): void {
    this.#assertMutable(token, 'register');
    if (options?.multi) {
      const providers = this.#multi.get(token) ?? [];
      providers.push(registration);
      this.#multi.set(token, providers);
      return;
    }
    // Conflicts are checked against this registry only: a request-scoped
    // child may deliberately shadow an application-scoped service.
    if (this.#single.has(token) && !options?.override) {
      throw new Error(
        `Capability '${token}' is already registered. Use { override: true } to replace it.`,
      );
    }
    if (this.#single.has(token) && options?.override) {
      this.#observer?.('override', token);
    }
    this.#single.set(token, registration);
  }

  #assertMutable(token: CapabilityToken, operation: 'register' | 'unregister'): void {
    if (this.#sealed) {
      throw new Error(
        `Cannot ${operation} capability '${token}' after runBootstrap() has completed. ` +
          `Register during a plugin's register(), onInit, or onBootstrap hook, or use ` +
          `request-scoped ctx.services inside middleware.`,
      );
    }
  }
}
