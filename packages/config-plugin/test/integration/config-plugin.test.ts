/**
 * Integration tests for ConfigPlugin.
 *
 * Covers plugin metadata, runtime dependency, service registration,
 * async file loading, missing filesystem support, and startup validation failure.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type {
  IApplication,
  IConfig,
  IPluginContext,
  IRuntimeServices,
} from '@hono-enterprise/common';

import { ConfigPlugin } from '../../src/plugin/config-plugin.ts';
import {
  createFailingFileSystem,
  createFakeFileSystem,
  createRuntime,
} from '../fixtures/fake-runtime.ts';

/** Create a minimal service registry test double backed by a Map. */
function createServiceRegistry(map: Map<string, unknown>) {
  return {
    register<T>(key: string, service: T): void {
      map.set(key, service);
    },
    registerFactory<T>(_key: string, _factory: () => T): void {},
    get<T>(key: string): T {
      const value = map.get(key);
      if (value === undefined) {
        throw new Error(`Service not found: ${key}`);
      }
      return value as T;
    },
    getAll<T>(): T[] {
      return [];
    },
    has(key: string): boolean {
      return map.has(key);
    },
    unregister(key: string): boolean {
      return map.delete(key);
    },
  };
}

/** Create a fake plugin context with all required properties. */
function createFakeContext(runtime: IRuntimeServices): {
  ctx: IPluginContext;
  registeredServices: Map<string, unknown>;
} {
  const registeredServices = new Map<string, unknown>();
  registeredServices.set(CAPABILITIES.RUNTIME, runtime);

  const ctx: IPluginContext = {
    runtime,
    services: createServiceRegistry(registeredServices),
    middleware: { add: () => {} },
    router: {
      get: () => {},
      post: () => {},
      put: () => {},
      patch: () => {},
      delete: () => {},
      head: () => {},
      options: () => {},
      group: () => {},
      listRoutes: () => [],
    },
    lifecycle: {
      onRegister: () => {},
      onInit: () => {},
      onBootstrap: () => {},
      onRequest: () => {},
      onResponse: () => {},
      onError: () => {},
      onShutdown: () => {},
      onClose: () => {},
    },
    health: { register: () => {} },
    metrics: { register: () => {} },
    openapi: { addSchema: () => {} },
    decorators: { register: () => {} },
    cli: { register: () => {} },
    environment: { validate: () => {} },
    options: {},
    app: {} as unknown as IApplication,
  };

  return { ctx, registeredServices };
}

describe('ConfigPlugin — metadata', () => {
  it('has correct name and version', () => {
    const plugin = ConfigPlugin();
    expect(plugin.name).toBe('config-plugin');
    expect(plugin.version).toBe('0.1.0');
  });

  it('depends on and provides correct capabilities', () => {
    const plugin = ConfigPlugin();
    expect(plugin.dependencies).toContain(CAPABILITIES.RUNTIME);
    expect(plugin.provides).toContain(CAPABILITIES.CONFIG);
    expect(plugin.consumes).toContain(CAPABILITIES.RUNTIME);
  });

  it('uses the high infrastructure priority', () => {
    const plugin = ConfigPlugin();
    expect(plugin.priority).toBe(PLUGIN_PRIORITY.HIGH);
  });
});

describe('ConfigPlugin — registration', () => {
  it('registers IConfig when runtime is available', async () => {
    const plugin = ConfigPlugin();
    const { ctx, registeredServices } = createFakeContext(createRuntime({ env: { PORT: '3000' } }));

    await plugin.register!(ctx);

    const config = registeredServices.get(CAPABILITIES.CONFIG) as IConfig;
    expect(config.get<string>('PORT')).toBe('3000');
  });

  it('filters undefined from runtime.env', async () => {
    const plugin = ConfigPlugin();
    const { ctx, registeredServices } = createFakeContext(
      createRuntime({ env: { PORT: '3000', EMPTY: undefined } }),
    );

    await plugin.register!(ctx);
    const config = registeredServices.get(CAPABILITIES.CONFIG) as IConfig;
    expect(config.has('PORT')).toBe(true);
    expect(config.has('EMPTY')).toBe(false);
  });

  it('throws when envFilePath set but fs unavailable', async () => {
    const plugin = ConfigPlugin({ envFilePath: '.env' });
    const { ctx } = createFakeContext(createRuntime({}));

    await expect(plugin.register!(ctx)).rejects.toThrow(/filesystem/);
  });
});

describe('ConfigPlugin — file loading', () => {
  it('loads from env file via runtime.fs', async () => {
    const fs = createFakeFileSystem({ '.env': 'DB_HOST=localhost\nDB_PORT=5432' });
    const plugin = ConfigPlugin({
      envFilePath: '.env',
      expandVariables: false,
    });
    const { ctx, registeredServices } = createFakeContext(createRuntime({ fs }));

    await plugin.register!(ctx);
    const config = registeredServices.get(CAPABILITIES.CONFIG) as IConfig;
    expect(config.get<string>('DB_HOST')).toBe('localhost');
    expect(config.get<string>('DB_PORT')).toBe('5432');
  });

  it('runtime.env overrides env file values', async () => {
    const fs = createFakeFileSystem({ '.env': 'PORT=9090' });
    const plugin = ConfigPlugin({
      envFilePath: '.env',
      expandVariables: false,
    });
    const { ctx, registeredServices } = createFakeContext(
      createRuntime({ env: { PORT: '3000' }, fs }),
    );

    await plugin.register!(ctx);
    const config = registeredServices.get(CAPABILITIES.CONFIG) as IConfig;
    expect(config.get<string>('PORT')).toBe('3000');
  });

  it('earlier file paths have higher precedence', async () => {
    const fs = createFakeFileSystem({
      '.env.local': 'PORT=8080',
      '.env': 'PORT=3000\nEXTRA=value',
    });
    const plugin = ConfigPlugin({
      envFilePath: ['.env.local', '.env'],
      expandVariables: false,
    });
    const { ctx, registeredServices } = createFakeContext(createRuntime({ fs }));

    await plugin.register!(ctx);
    const config = registeredServices.get(CAPABILITIES.CONFIG) as IConfig;
    expect(config.get<string>('PORT')).toBe('8080');
    expect(config.get<string>('EXTRA')).toBe('value');
  });

  it('expands once after merging all files and runtime.env', async () => {
    const fs = createFakeFileSystem({
      '.env.local': 'FROM_LOCAL=${FROM_BASE}\nRUNTIME_URL=${ORIGIN}/runtime',
      '.env': 'FROM_BASE=base\nORIGIN=http://file.example',
    });
    const plugin = ConfigPlugin({ envFilePath: ['.env.local', '.env'] });
    const { ctx, registeredServices } = createFakeContext(
      createRuntime({ env: { ORIGIN: 'https://runtime.example' }, fs }),
    );

    await plugin.register!(ctx);
    const config = registeredServices.get(CAPABILITIES.CONFIG) as IConfig;
    expect(config.get<string>('FROM_LOCAL')).toBe('base');
    expect(config.get<string>('RUNTIME_URL')).toBe('https://runtime.example/runtime');
  });

  it('allows runtime.env values to reference file values', async () => {
    const fs = createFakeFileSystem({ '.env': 'HOST=example.test' });
    const plugin = ConfigPlugin({ envFilePath: '.env' });
    const { ctx, registeredServices } = createFakeContext(
      createRuntime({ env: { URL: 'https://${HOST}' }, fs }),
    );

    await plugin.register!(ctx);
    const config = registeredServices.get(CAPABILITIES.CONFIG) as IConfig;
    expect(config.get<string>('URL')).toBe('https://example.test');
  });

  it('does not validate references from values removed by precedence', async () => {
    const fs = createFakeFileSystem({ '.env': 'VALUE=${MISSING}' });
    const plugin = ConfigPlugin({ envFilePath: '.env' });
    const { ctx, registeredServices } = createFakeContext(
      createRuntime({ env: { VALUE: 'runtime-value' }, fs }),
    );

    await plugin.register!(ctx);
    const config = registeredServices.get(CAPABILITIES.CONFIG) as IConfig;
    expect(config.get<string>('VALUE')).toBe('runtime-value');
  });

  it('leaves references untouched when expansion is disabled', async () => {
    const plugin = ConfigPlugin({ expandVariables: false });
    const { ctx, registeredServices } = createFakeContext(
      createRuntime({ env: { A: 'value', B: '${A}' } }),
    );

    await plugin.register!(ctx);
    const config = registeredServices.get(CAPABILITIES.CONFIG) as IConfig;
    expect(config.get<string>('B')).toBe('${A}');
  });

  it('detects cycles spanning files and runtime.env', async () => {
    const fs = createFakeFileSystem({ '.env': 'A=${B}' });
    const plugin = ConfigPlugin({ envFilePath: '.env' });
    const { ctx } = createFakeContext(createRuntime({ env: { B: '${A}' }, fs }));

    await expect(plugin.register!(ctx)).rejects.toThrow(/A -> B -> A/);
  });

  it('throws on unreadable env file', async () => {
    const fs = createFailingFileSystem(new Error('Permission denied'));
    const plugin = ConfigPlugin({
      envFilePath: '.env',
      expandVariables: false,
    });
    const { ctx } = createFakeContext(createRuntime({ fs }));

    await expect(plugin.register!(ctx)).rejects.toThrow(/Permission denied/);
  });
});

describe('ConfigPlugin — validation', () => {
  it('validates with schema and stores parsed output', async () => {
    const schema = {
      parse(input: unknown): unknown {
        const obj = input as Record<string, string>;
        return {
          PORT: Number(obj['PORT']),
          NAME: obj['NAME'],
        };
      },
    };

    const plugin = ConfigPlugin({
      validationSchema: schema,
      expandVariables: false,
    });
    const { ctx, registeredServices } = createFakeContext(
      createRuntime({ env: { PORT: '3000', NAME: 'test' } }),
    );

    await plugin.register!(ctx);
    const config = registeredServices.get(CAPABILITIES.CONFIG) as IConfig;
    expect(config.get<number>('PORT')).toBe(3000);
    expect(config.get<string>('NAME')).toBe('test');
  });

  it('throws on validation failure', async () => {
    const schema = {
      parse(): unknown {
        throw new Error('Invalid configuration');
      },
    };

    const plugin = ConfigPlugin({
      validationSchema: schema,
      expandVariables: false,
    });
    const { ctx } = createFakeContext(createRuntime({}));

    await expect(plugin.register!(ctx)).rejects.toThrow(/validation failed/i);
  });

  it('does not expose a schema error containing a secret', async () => {
    const secret = 'do-not-leak-this-secret';
    const schema = {
      parse(): unknown {
        throw new Error(`Invalid value: ${secret}`);
      },
    };
    const plugin = ConfigPlugin({ validationSchema: schema });
    const { ctx } = createFakeContext(createRuntime({}));

    try {
      await plugin.register!(ctx);
      throw new Error('Expected validation to fail');
    } catch (error) {
      expect((error as Error).message).toBe('Configuration validation failed.');
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).cause).toBeUndefined();
    }
  });

  it('throws when schema output is an array', async () => {
    const schema = {
      parse(): unknown {
        return ['a', 'b'];
      },
    };

    const plugin = ConfigPlugin({
      validationSchema: schema,
      expandVariables: false,
    });
    const { ctx } = createFakeContext(createRuntime({}));

    await expect(plugin.register!(ctx)).rejects.toThrow(/not be an array/);
  });

  it('throws when schema output is null', async () => {
    const schema = {
      parse(): unknown {
        return null;
      },
    };

    const plugin = ConfigPlugin({
      validationSchema: schema,
      expandVariables: false,
    });
    const { ctx } = createFakeContext(createRuntime({}));

    await expect(plugin.register!(ctx)).rejects.toThrow(/non-null/);
  });

  it('throws when schema output is a primitive', async () => {
    const schema = {
      parse(): unknown {
        return 42;
      },
    };

    const plugin = ConfigPlugin({
      validationSchema: schema,
      expandVariables: false,
    });
    const { ctx } = createFakeContext(createRuntime({}));

    await expect(plugin.register!(ctx)).rejects.toThrow(/must be an object/);
  });
});
