/**
 * `VectorStorePlugin` — registers the vector store under
 * `CAPABILITIES.VECTOR_STORE`. Collections are declared up front, validated
 * when the plugin is created, and created or verified by the adapter during
 * registration, so a mismatched or unreachable backend fails startup rather
 * than the first request (plan §3.2).
 *
 * @module
 */
import { CAPABILITIES } from '@setu-ts/common';
import type {
  IPlugin,
  IPluginContext,
  IRuntimeServices,
  IVectorStoreAdapter,
  VectorCollectionSpec,
} from '@setu-ts/common';
import { resolveCollections } from '../services/collection-spec.ts';
import { validateScope } from '../services/record-validation.ts';
import { VectorStoreService } from '../services/vector-store-service.ts';
import type { VectorStoreTenancy } from '../services/vector-store-service.ts';
import { VERSION } from '../version.ts';

const ADAPTER_METHODS = [
  'open',
  'ensureCollection',
  'upsert',
  'replaceSource',
  'query',
  'delete',
  'deleteScope',
] as const;

/**
 * Options for {@linkcode VectorStorePlugin}.
 *
 * @since 0.12.0
 */
export interface VectorStorePluginOptions {
  /**
   * The backend, or a factory called once during registration — for a client
   * built from `runtime.env` or a driver imported lazily.
   */
  readonly adapter:
    | IVectorStoreAdapter
    | ((runtime: IRuntimeServices) => IVectorStoreAdapter | Promise<IVectorStoreAdapter>);
  /** Every collection the application uses, declared up front. */
  readonly collections: readonly VectorCollectionSpec[];
  /**
   * `'required'` (default): `scopeFor` returns the request's tenant id and
   * throws without one. `{ fixed }`: `scopeFor` always returns the fixed scope.
   */
  readonly tenancy?: VectorStoreTenancy;
}

/**
 * Registers a tenant-scoped vector store.
 *
 * @param options - Adapter, collections and tenancy mode
 * @returns The plugin; register it once per application
 * @throws {TypeError} When the options are invalid
 * @example
 * ```typescript
 * createApplication({
 *   plugins: [
 *     RuntimePlugin(),
 *     MultiTenancyPlugin({ resolver: 'header' }),
 *     VectorStorePlugin({
 *       adapter: new MemoryVectorStore(),
 *       collections: [{ name: 'documents', dimensions: 1024, filterable: { tag: 'string' } }],
 *     }),
 *   ],
 * });
 * ```
 * @since 0.12.0
 */
export function VectorStorePlugin(options: VectorStorePluginOptions): IPlugin {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('VectorStorePlugin: options are required.');
  }
  const collections = resolveCollections(options.collections);
  const tenancy = options.tenancy ?? 'required';
  if (
    tenancy !== 'required' &&
    (typeof tenancy !== 'object' || typeof tenancy.fixed !== 'string')
  ) {
    throw new TypeError("VectorStorePlugin: tenancy must be 'required' or { fixed: string }.");
  }
  if (tenancy !== 'required') validateScope(tenancy.fixed);
  const source = options.adapter;
  if (typeof source !== 'function') assertAdapter(source);

  return {
    name: 'vector-store-plugin',
    version: VERSION,
    dependencies: [CAPABILITIES.RUNTIME],
    provides: [CAPABILITIES.VECTOR_STORE],
    async register(ctx: IPluginContext): Promise<void> {
      const adapter = typeof source === 'function' ? await source(ctx.runtime) : source;
      assertAdapter(adapter);
      // Registered before the backend is touched, so an adapter that opened a
      // connection and then failed to ensure a collection is still closed.
      ctx.lifecycle.onShutdown(async () => {
        await adapter.close?.();
      });
      await adapter.open(ctx.runtime);
      for (const { spec } of collections.values()) await adapter.ensureCollection(spec);
      ctx.services.register(
        CAPABILITIES.VECTOR_STORE,
        new VectorStoreService(adapter, collections, tenancy),
      );
    },
  };
}

function assertAdapter(adapter: unknown): asserts adapter is IVectorStoreAdapter {
  const candidate = adapter as Record<string, unknown> | null;
  const missing =
    candidate === null || typeof candidate !== 'object'
      ? ['adapter']
      : ADAPTER_METHODS.filter((method) => typeof candidate[method] !== 'function');
  if (missing.length > 0) {
    throw new TypeError(
      `VectorStorePlugin: adapter must implement IVectorStoreAdapter (missing ${missing.join(', ')}).`,
    );
  }
}
