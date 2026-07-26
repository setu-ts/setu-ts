import type { IPlugin } from '@hono-enterprise/common';
import { createMockPlugin } from '../mock-plugin.ts';

/**
 * Collects mock plugin definitions and real plugins, produces the
 * `IPlugin[]` for `createTestApp`, and resets between tests.
 *
 * Integration tests that mock several capabilities at once (e.g.
 * `database` + `cache` + `logger`) build the plugin array via
 * `FixtureManager` so `afterEach(() => fixtures.reset())` is the
 * only teardown needed.
 *
 * @example
 * ```typescript
 * import { FixtureManager, createTestApp } from '@hono-enterprise/testing';
 * import { RuntimePlugin } from '@hono-enterprise/runtime';
 *
 * const fixtures = new FixtureManager();
 *
 * beforeEach(async () => {
 *   fixtures
 *     .mock('database', { query: () => [] })
 *     .mock('cache', { get: () => null, set: () => {} });
 *
 *   const app = await createTestApp({
 *     plugins: [RuntimePlugin(), ...fixtures.plugins()],
 *   });
 * });
 *
 * afterEach(() => fixtures.reset());
 * ```
 *
 * @since 0.1.0
 */
export class FixtureManager {
  #list: IPlugin[] = [];

  /**
   * Registers a mock service under a capability token.
   *
   * @param name - Plugin name (also the capability token when `provides` is absent)
   * @param service - The mock service object
   * @param options - Optional `provides` token and priority
   * @returns `this` for chaining
   */
  mock(
    name: string,
    service: object,
    options?: { provides?: string; priority?: number },
  ): this {
    this.#list.push(createMockPlugin({ name, service, ...options }));
    return this;
  }

  /**
   * Stores a real plugin.
   *
   * @param plugin - An `IPlugin` instance
   * @returns `this` for chaining
   */
  plugin(plugin: IPlugin): this {
    this.#list.push(plugin);
    return this;
  }

  /**
   * Returns all plugins in true insertion order.
   *
   * @returns All plugins for `createTestApp({ plugins })`
   */
  plugins(): IPlugin[] {
    return [...this.#list];
  }

  /**
   * Clears the store. Call in `afterEach` to reset between tests.
   */
  reset(): void {
    this.#list = [];
  }
}
