/**
 * E2E application test for ConfigPlugin.
 *
 * Uses createApplication() with a runtime-provider test plugin and ConfigPlugin,
 * then resolves config through the real service registry/context.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IConfig, IPlugin, IPluginContext, IRuntimeServices } from '@hono-enterprise/common';

import { createApplication } from '@hono-enterprise/kernel';
import { ConfigPlugin } from '../../src/plugin/config-plugin.ts';
import { createFakeFileSystem, createRuntime } from '../fixtures/fake-runtime.ts';

/** Create a runtime plugin with test environment and filesystem. */
function createTestRuntimePlugin(
  opts: {
    env?: Record<string, string | undefined>;
    fs?: ReturnType<typeof createFakeFileSystem>;
  } = {},
): IPlugin {
  const runtime: IRuntimeServices = createRuntime(opts);

  return {
    name: 'test-runtime',
    version: '0.1.0',
    provides: [CAPABILITIES.RUNTIME],
    register(ctx: IPluginContext) {
      ctx.services.register(CAPABILITIES.RUNTIME, runtime);
    },
  };
}

describe('ConfigPlugin E2E — with real application', () => {
  it('registers and resolves config through application', async () => {
    const app = createApplication({
      plugins: [
        createTestRuntimePlugin({ env: { APP_NAME: 'test-app' } }),
        ConfigPlugin({ expandVariables: false }),
      ],
    });

    await app.start();
    const config = app.services.get<IConfig>(CAPABILITIES.CONFIG);
    expect(config).toBeDefined();
    expect(config?.get<string>('APP_NAME')).toBe('test-app');
    await app.stop();
  });

  it('loads env files via application lifecycle', async () => {
    const fs = createFakeFileSystem({ '.env': 'DB_HOST=localhost\nDB_PORT=5432' });

    const app = createApplication({
      plugins: [
        createTestRuntimePlugin({ env: { DB_HOST: 'prod-db.example.com' }, fs }),
        ConfigPlugin({
          envFilePath: '.env',
          expandVariables: false,
        }),
      ],
    });

    await app.start();
    const config = app.services.get<IConfig>(CAPABILITIES.CONFIG);
    expect(config).toBeDefined();
    // runtime.env overrides file values
    expect(config?.get<string>('DB_HOST')).toBe('prod-db.example.com');
    // file value used when not in env
    expect(config?.get<string>('DB_PORT')).toBe('5432');
    await app.stop();
  });

  it('validates config with Zod at startup', async () => {
    // Import Zod dynamically to test real Zod coercion/defaults/validation.
    const mod = await import('npm:zod@^3.24.0');
    const z = mod.z;

    const schema = z.object({
      PORT: z.coerce.number().default(3000),
      DEBUG: z.coerce.boolean().default(false),
      NAME: z.string().min(1),
    });

    const app = createApplication({
      plugins: [
        createTestRuntimePlugin({ env: { NAME: 'zod-test' } }),
        ConfigPlugin({
          validationSchema: schema,
          expandVariables: false,
        }),
      ],
    });

    await app.start();
    const config = app.services.get<IConfig>(CAPABILITIES.CONFIG);
    expect(config).toBeDefined();
    expect(config?.get<number>('PORT')).toBe(3000);
    expect(config?.get<boolean>('DEBUG')).toBe(false);
    expect(config?.get<string>('NAME')).toBe('zod-test');
    await app.stop();
  });

  it('fails startup when Zod validation fails', async () => {
    const mod = await import('npm:zod@^3.24.0');
    const z = mod.z;

    const schema = z.object({
      PORT: z.coerce.number(),
      URL: z.string().url(),
    });

    const app = createApplication({
      plugins: [
        createTestRuntimePlugin({ env: { URL: 'not-a-url' } }),
        ConfigPlugin({
          validationSchema: schema,
          expandVariables: false,
        }),
      ],
    });

    await expect(app.start()).rejects.toThrow(/validation/i);
  });

  it('throws startup error when envFilePath set without fs', async () => {
    const app = createApplication({
      plugins: [
        createTestRuntimePlugin({ env: {} }),
        ConfigPlugin({ envFilePath: '.env' }),
      ],
    });

    await expect(app.start()).rejects.toThrow(/filesystem/);
  });

  it('works without envFilePath (env only)', async () => {
    const app = createApplication({
      plugins: [
        createTestRuntimePlugin({ env: { KEY: 'VALUE' } }),
        ConfigPlugin(),
      ],
    });

    await app.start();
    const config = app.services.get<IConfig>(CAPABILITIES.CONFIG);
    expect(config).toBeDefined();
    expect(config?.get<string>('KEY')).toBe('VALUE');
    await app.stop();
  });

  it('expands variables across env and files', async () => {
    const fs = createFakeFileSystem({
      '.env.local': 'API_URL=${ORIGIN}/${PATH}',
      '.env': 'ORIGIN=http://file.example\nPATH=v1',
    });

    const app = createApplication({
      plugins: [
        createTestRuntimePlugin({
          env: { ORIGIN: 'https://runtime.example' },
          fs,
        }),
        ConfigPlugin({
          envFilePath: ['.env.local', '.env'],
        }),
      ],
    });

    await app.start();
    const config = app.services.get<IConfig>(CAPABILITIES.CONFIG);
    expect(config).toBeDefined();
    expect(config?.get<string>('API_URL')).toBe('https://runtime.example/v1');
    await app.stop();
  });
});
