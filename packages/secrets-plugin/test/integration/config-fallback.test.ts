import { describe, expect, it } from 'vitest';

import { CAPABILITIES } from '@setu-ts/common';
import type { IConfig, IRuntimeServices, ISecretManager } from '@setu-ts/common';
import { ConfigPlugin, loadConfig } from '@setu-ts/config-plugin';
import type { ConfigPluginOptions } from '@setu-ts/config-plugin';
import { createApplication } from '@setu-ts/kernel';
import { createRuntimeServices, RuntimePlugin } from '@setu-ts/runtime';
import { createMockPlugin } from '@setu-ts/testing';

import { createFakeFileSystem } from '../../../config-plugin/test/fixtures/fake-runtime.ts';
import { SecretsPlugin } from '../../src/index.ts';
import { createFakeConfig } from '../fixtures/fake-config.ts';

/** Uses real runtime services with an isolated env and in-memory filesystem. */
function runtimePlugin(env: Record<string, string | undefined> = {}, dotenv = '') {
  const runtime = {
    ...createRuntimeServices(),
    env,
    fs: createFakeFileSystem({ '.env': dotenv }),
  };
  return RuntimePlugin({ platform: 'node', adapters: { node: () => runtime } });
}

/** Secrets intentionally precede ConfigPlugin in the registration list. */
function configApp(
  dotenv: string,
  env: Record<string, string | undefined> = {},
  fallback = true,
  configOptions: ConfigPluginOptions = {},
) {
  return createApplication({
    plugins: [
      runtimePlugin(env, dotenv),
      SecretsPlugin({ options: { configFallback: fallback } }),
      ConfigPlugin({ envFilePath: '.env', ...configOptions }),
    ],
  });
}

describe('Config fallback through a real kernel and ConfigPlugin', () => {
  it('reads a .env-only secret with SecretsPlugin listed before ConfigPlugin', async () => {
    const app = configApp('DATABASE_PASSWORD=dotenv-value');
    await app.start();
    try {
      const secrets = app.services.get<ISecretManager>(CAPABILITIES.SECRETS);
      expect(await secrets.get('database/password')).toBe('dotenv-value');
      expect(await secrets.has('database/password')).toBe(true);
      await expect(secrets.rotate('database/password', 'next')).rejects.toThrow('read-only');
    } finally {
      await app.stop();
    }
  });

  it('configFallback false hides a .env-only secret', async () => {
    const app = configApp('DATABASE_PASSWORD=dotenv-value', {}, false);
    await app.start();
    try {
      expect(app.services.get<IConfig>(CAPABILITIES.CONFIG).get('DATABASE_PASSWORD')).toBe(
        'dotenv-value',
      );
      const secrets = app.services.get<ISecretManager>(CAPABILITIES.SECRETS);
      expect(await secrets.has('database/password')).toBe(false);
      await expect(secrets.get('database/password')).rejects.toThrow('Secret not found');
    } finally {
      await app.stop();
    }
  });

  it('environment value wins over the .env value', async () => {
    const app = configApp('DATABASE_PASSWORD=dotenv-value', { DATABASE_PASSWORD: 'env-value' });
    await app.start();
    try {
      expect(
        await app.services.get<ISecretManager>(CAPABILITIES.SECRETS).get('database/password'),
      ).toBe('env-value');
    } finally {
      await app.stop();
    }
  });

  it('returns an unexpanded environment value even when ConfigPlugin expanded its snapshot', async () => {
    const app = configApp('X=expanded', { DATABASE_PASSWORD: '${X}' });
    await app.start();
    try {
      expect(app.services.get<IConfig>(CAPABILITIES.CONFIG).get('DATABASE_PASSWORD')).toBe(
        'expanded',
      );
      expect(
        await app.services.get<ISecretManager>(CAPABILITIES.SECRETS).get('database/password'),
      ).toBe('${X}');
    } finally {
      await app.stop();
    }
  });

  it('boots without ConfigPlugin and reads only the environment', async () => {
    const app = createApplication({
      plugins: [runtimePlugin({ DATABASE_PASSWORD: 'env-only' }), SecretsPlugin()],
    });
    await app.start();
    try {
      expect(app.services.has(CAPABILITIES.CONFIG)).toBe(false);
      const secrets = app.services.get<ISecretManager>(CAPABILITIES.SECRETS);
      expect(await secrets.get('database/password')).toBe('env-only');
      expect(await secrets.has('missing')).toBe(false);
    } finally {
      await app.stop();
    }
  });

  it('cannot read a key omitted by the validation schema', async () => {
    // The structural schema returns only its declared key, like z.object.
    const validationSchema = {
      parse(input: unknown): { APP_NAME: string } {
        const raw = input as Record<string, string>;
        return { APP_NAME: raw.APP_NAME };
      },
    };
    const app = configApp('APP_NAME=demo\nDATABASE_PASSWORD=stripped', {}, true, {
      validationSchema,
    });
    await app.start();
    try {
      const config = app.services.get<IConfig>(CAPABILITIES.CONFIG);
      expect(config.get('APP_NAME')).toBe('demo');
      expect(config.has('DATABASE_PASSWORD')).toBe(false);
      const secrets = app.services.get<ISecretManager>(CAPABILITIES.SECRETS);
      expect(await secrets.has('database/password')).toBe(false);
      await expect(secrets.get('database/password')).rejects.toThrow('Secret not found');
    } finally {
      await app.stop();
    }
  });

  it('rejects a config value coerced to a non-string by a schema', async () => {
    const app = configApp('DATABASE_PASSWORD=123', {}, true, {
      validationSchema: {
        parse(input: unknown): { DATABASE_PASSWORD: number } {
          return { DATABASE_PASSWORD: Number((input as Record<string, string>).DATABASE_PASSWORD) };
        },
      },
    });
    await app.start();
    try {
      expect(app.services.get<IConfig>(CAPABILITIES.CONFIG).get('DATABASE_PASSWORD')).toBe(123);
      expect(
        await app.services.get<ISecretManager>(CAPABILITIES.SECRETS).has('database/password'),
      ).toBe(false);
    } finally {
      await app.stop();
    }
  });

  it.each([true, false])(
    'honors ConfigPlugin expandVariables=%s for .env-only values',
    async (expandVariables) => {
      const app = configApp('X=expanded\nDATABASE_PASSWORD=prefix-${X}', {}, true, {
        expandVariables,
      });
      await app.start();
      try {
        expect(
          await app.services.get<ISecretManager>(CAPABILITIES.SECRETS).get('database/password'),
        ).toBe(expandVariables ? 'prefix-expanded' : 'prefix-${X}');
      } finally {
        await app.stop();
      }
    },
  );

  it('sees a replacement CONFIG provider with priority above 500 listed after SecretsPlugin', async () => {
    const app = createApplication({
      plugins: [
        runtimePlugin(),
        SecretsPlugin(),
        createMockPlugin({
          name: 'replacement-config',
          provides: CAPABILITIES.CONFIG,
          priority: 900,
          service: createFakeConfig({ DATABASE_PASSWORD: 'replacement-value' }),
        }),
      ],
    });
    await app.start();
    try {
      expect(
        await app.services.get<ISecretManager>(CAPABILITIES.SECRETS).get('database/password'),
      ).toBe('replacement-value');
    } finally {
      await app.stop();
    }
  });

  it('reads an injected ConfigPlugin instance on Workers without filesystem support', async () => {
    const instance = await loadConfig(
      createRuntimeServices({
        platform: 'cloudflare-workers',
        env: { DATABASE_PASSWORD: 'injected-value' },
      }),
    );
    const app = createApplication({
      plugins: [
        RuntimePlugin({ platform: 'cloudflare-workers' }),
        SecretsPlugin(),
        ConfigPlugin({ instance }),
      ],
    });
    await app.start();
    try {
      expect(app.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME).fs).toBeUndefined();
      expect(
        await app.services.get<ISecretManager>(CAPABILITIES.SECRETS).get('database/password'),
      ).toBe('injected-value');
    } finally {
      await app.stop();
    }
  });
});
