/**
 * Provider registry — maps capability tokens to their provider entries.
 *
 * Supports hierarchical lookups: a child registry delegates to its parent
 * when a token is not found locally, enabling scoped containers to inherit
 * registrations from the root.
 *
 * @module
 */
import type { ContainerToken, Provider, ProviderOptions, ServiceScope } from '@setu-ts/common';
import { tokenName } from './errors.ts';

/**
 * A provider paired with its resolved lifecycle scope.
 *
 * @since 0.1.0
 *
 * @internal
 */
export interface ProviderEntry {
  /** The class, factory, or value provider. */
  readonly provider: Provider<unknown>;
  /** Lifecycle scope resolved from options or the container default. */
  readonly scope: ServiceScope;
  /**
   * Instance cleanup owned by this provider.
   * @since 0.11.0
   */
  readonly dispose?: ProviderOptions['dispose'];
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
  readonly #entries = new Map<ContainerToken, ProviderEntry>();
  readonly #parent: ProviderRegistry | (() => ProviderRegistry) | undefined;

  /**
   * @param parent - Parent registry or a lazy lookup of the nearest ancestor registry
   */
  constructor(parent?: ProviderRegistry | (() => ProviderRegistry)) {
    this.#parent = parent;
  }

  /**
   * Registers a provider entry under a token.
   *
   * @param token - The capability token
   *
   * @param entry - Provider and scope
   *
   * @returns Nothing
   * @throws {Error} If the token is already registered in this chain
   *
   * @since 0.11.0
   */
  register(token: ContainerToken, entry: ProviderEntry): void {
    if (this.has(token)) {
      throw new Error(`DI token '${tokenName(token)}' is already registered.`);
    }
    this.#entries.set(token, entry);
  }

  /**
   * Looks up a provider entry, walking the parent chain.
   *
   * @param token - The capability token
   *
   * @returns The entry, or `undefined` when not found in this chain
   *
   * @since 0.11.0
   */
  get(token: ContainerToken): ProviderEntry | undefined {
    const local = this.#entries.get(token);
    if (local !== undefined) {
      return local;
    }
    return this.#parentRegistry()?.get(token);
  }

  /**
   * Reports whether a token is registered anywhere in this chain.
   *
   * @param token - The capability token
   *
   * @returns `true` if registered locally or in a parent
   *
   * @since 0.11.0
   */
  has(token: ContainerToken): boolean {
    return this.#entries.has(token) || (this.#parentRegistry()?.has(token) ?? false);
  }

  /** Keeps registrations added later by a previously untouched ancestor visible. */
  #parentRegistry(): ProviderRegistry | undefined {
    return typeof this.#parent === 'function' ? this.#parent() : this.#parent;
  }

  /**
   * Creates a child registry that inherits lookups from this one.
   *
   * @returns A new child registry
   */
  createChild(): ProviderRegistry {
    return new ProviderRegistry(this);
  }

  /**
   * Lists local registrations for boot compilation.
   *
   * @returns Local token-entry pairs
   *
   * @since 0.11.0
   */
  entries(): IterableIterator<[ContainerToken, ProviderEntry]> {
    return this.#entries.entries();
  }
}
