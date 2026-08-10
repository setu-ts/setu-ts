// Architecture service-registry examples from ARCHITECTURE.md §6 - must compile.
// Verifies the corrected registry examples: CAPABILITIES constants (not raw
// strings), no nonexistent `lazy` option on RegisterOptions, and
// registerFactory() for lazy construction.
import type { ICacheStore, IConfig, INotifier, IPlugin, IPluginContext } from '@setu-ts/common';
import { CAPABILITIES, createCapabilityToken } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

// A custom token uses createCapabilityToken(); standard tokens use CAPABILITIES.
const REQUEST_LOGGER = createCapabilityToken('request-logger');

// A minimal ICacheStore implementation satisfying the generic get<T> and has().
const cacheStore: ICacheStore = {
  get: <T>(_key: string): Promise<T | null> => Promise.resolve(null),
  set: <T>(_key: string, _value: T, _ttlSeconds?: number): Promise<void> => Promise.resolve(),
  delete: (_key: string): Promise<boolean> => Promise.resolve(true),
  has: (_key: string): Promise<boolean> => Promise.resolve(false),
  clear: (): Promise<void> => Promise.resolve(),
};

const registryPlugin: IPlugin = {
  name: 'registry-demo',
  version: '1.0.0',
  register(ctx: IPluginContext) {
    // Register under a standard capability token (CAPABILITIES.*, not a raw string).
    ctx.services.register(CAPABILITIES.CACHE, cacheStore);

    // RegisterOptions has only `override` and `multi` — there is no `lazy` option.
    ctx.services.register(CAPABILITIES.CACHE, cacheStore, {
      override: false,
      multi: false,
    });

    // Lazy construction: the factory runs only on the first get().
    ctx.services.registerFactory(CAPABILITIES.CACHE, () => cacheStore);

    // Multi-provider registration.
    const emailNotifier: INotifier = {
      send: (_msg: unknown) => Promise.resolve(),
    };
    ctx.services.register(CAPABILITIES.NOTIFICATION, emailNotifier, {
      multi: true,
    });

    // Lookup uses the same CAPABILITIES constant.
    const cache = ctx.services.get<ICacheStore>(CAPABILITIES.CACHE);
    if (ctx.services.has(CAPABILITIES.NOTIFICATION)) {
      const notifiers = ctx.services.getAll<INotifier>(
        CAPABILITIES.NOTIFICATION,
      );
      void notifiers;
    }
    void cache;

    // A lazy factory that resolves another capability at construction time.
    ctx.services.registerFactory(CAPABILITIES.CACHE, () => {
      const config = ctx.services.get<IConfig>(CAPABILITIES.CONFIG);
      const ttl = config.get<number>('CACHE_TTL') ?? 60;
      // The resolved TTL would configure the store; here it proves the lookup.
      if (ttl > 0) return cacheStore;
      return cacheStore;
    });

    // Override requires the explicit flag.
    interface SimpleLogger {
      log: (m: string) => void;
    }
    const logger: SimpleLogger = { log: () => {} };
    ctx.services.register(CAPABILITIES.LOGGER, logger);
    ctx.services.register(CAPABILITIES.LOGGER, logger, { override: true });

    // A custom (non-standard) token must be created via createCapabilityToken().
    ctx.services.register(REQUEST_LOGGER, { log: () => {} });
  },
};

const app = createApplication();
app.register(RuntimePlugin());
app.register(registryPlugin);
await app.start({ port: 3000 });
