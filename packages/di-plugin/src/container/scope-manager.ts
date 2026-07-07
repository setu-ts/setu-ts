/**
 * Scope manager — caches resolved instances according to their lifecycle
 * scope.
 *
 * Singleton instances are stored in a map shared between a root container
 * and all its child scopes, so every scope sees the same singleton.
 * Scoped instances live in a per-scope map, giving each scope its own
 * instance. Transient instances are never cached.
 *
 * @module
 */

/**
 * Manages singleton and scoped instance caches for a container.
 *
 * @since 0.1.0
 */
export class ScopeManager {
  readonly #singletons: Map<string, unknown>;
  readonly #scoped: Map<string, unknown>;

  /**
   * @param singletons - Map shared with the parent (or a fresh map for root)
   * @param scoped - Per-scope map (always fresh)
   */
  constructor(singletons?: Map<string, unknown>, scoped?: Map<string, unknown>) {
    this.#singletons = singletons ?? new Map();
    this.#scoped = scoped ?? new Map();
  }

  /**
   * Retrieves a cached singleton instance.
   *
   * @param token - The capability token
   * @returns The cached instance, or `undefined`
   */
  getSingleton(token: string): unknown {
    return this.#singletons.get(token);
  }

  /**
   * Stores a singleton instance (shared across all scopes).
   *
   * @param token - The capability token
   * @param instance - The instance to cache
   */
  setSingleton(token: string, instance: unknown): void {
    this.#singletons.set(token, instance);
  }

  /**
   * Reports whether a singleton is cached.
   *
   * @param token - The capability token
   * @returns `true` if a singleton instance is cached
   */
  hasSingleton(token: string): boolean {
    return this.#singletons.has(token);
  }

  /**
   * Retrieves a cached scoped instance.
   *
   * @param token - The capability token
   * @returns The cached instance, or `undefined`
   */
  getScoped(token: string): unknown {
    return this.#scoped.get(token);
  }

  /**
   * Stores a scoped instance (local to this scope).
   *
   * @param token - The capability token
   * @param instance - The instance to cache
   */
  setScoped(token: string, instance: unknown): void {
    this.#scoped.set(token, instance);
  }

  /**
   * Reports whether a scoped instance is cached.
   *
   * @param token - The capability token
   * @returns `true` if a scoped instance is cached
   */
  hasScoped(token: string): boolean {
    return this.#scoped.has(token);
  }

  /**
   * Creates a child scope that shares singletons but has its own scoped map.
   *
   * @returns A new scope manager for the child container
   */
  createChild(): ScopeManager {
    return new ScopeManager(this.#singletons);
  }
}
