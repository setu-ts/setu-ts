/**
 * Provider registry — maps capability tokens to their provider entries.
 *
 * Supports hierarchical lookups: a child registry delegates to its parent
 * when a token is not found locally, enabling scoped containers to inherit
 * registrations from the root.
 *
 * @module
 */
import type { Provider, ServiceScope } from '@hono-enterprise/common';

/**
 * A provider paired with its resolved lifecycle scope.
 *
 * @internal
 */
export interface ProviderEntry {
  /** The class, factory, or value provider. */
  readonly provider: Provider<unknown>;
  /** Lifecycle scope resolved from options or the container default. */
  readonly scope: ServiceScope;
}

/**
 * Token-keyed store of provider entries with optional parent inheritance.
 *
 * Registration always targets the local map — a child never mutates its
 * parent. Lookup walks the parent chain so a scoped container resolves
 * everything the root registered.
 *
 * @since 0.1.0
 */
export class ProviderRegistry {
  readonly #entries = new Map<string, ProviderEntry>();
  readonly #parent: ProviderRegistry | undefined;

  /**
   * @param parent - Optional parent registry for inherited lookups.
   */
  constructor(parent?: ProviderRegistry) {
    this.#parent = parent;
  }

  /**
   * Registers a provider entry under a token.
   *
   * @param token - The capability token
   * @param entry - Provider and scope
   * @throws {Error} If the token is already registered in this registry
   */
  register(token: string, entry: ProviderEntry): void {
    if (this.#entries.has(token)) {
      throw new Error(
        `DI token '${token}' is already registered. Use a child scope to override.`,
      );
    }
    this.#entries.set(token, entry);
  }

  /**
   * Looks up a provider entry, walking the parent chain.
   *
   * @param token - The capability token
   * @returns The entry, or `undefined` when not found in this chain
   */
  get(token: string): ProviderEntry | undefined {
    const local = this.#entries.get(token);
    if (local !== undefined) {
      return local;
    }
    return this.#parent?.get(token);
  }

  /**
   * Reports whether a token is registered anywhere in this chain.
   *
   * @param token - The capability token
   * @returns `true` if registered locally or in a parent
   */
  has(token: string): boolean {
    return this.#entries.has(token) || (this.#parent?.has(token) ?? false);
  }

  /**
   * Creates a child registry that inherits lookups from this one.
   *
   * @returns A new child registry
   */
  createChild(): ProviderRegistry {
    return new ProviderRegistry(this);
  }
}
