import { describe, expect, it, vi } from 'vitest';

import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';
import type { ISecretManager } from '@setu-ts/common';

import { createProvider, SecretsPlugin } from '../../src/plugin/secrets-plugin.ts';
import { EnvProvider } from '../../src/providers/env-provider.ts';
import { AwsKmsProvider } from '../../src/providers/aws-kms.ts';
import { GcpSecretManagerProvider } from '../../src/providers/gcp-secret-manager.ts';
import { AzureKeyVaultProvider } from '../../src/providers/azure-key-vault.ts';
import { HashiCorpVaultProvider } from '../../src/providers/vault.ts';
import type {
  IVaultHttp,
  SecretsProviderOptions,
  SecretsProviderType,
} from '../../src/interfaces/index.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';
import { createFakeConfig } from '../fixtures/fake-config.ts';
import manifest from '../../deno.json' with { type: 'json' };

describe('SecretsPlugin metadata', () => {
  it('exposes the expected plugin contract fields', () => {
    const plugin = SecretsPlugin();
    expect(plugin.name).toBe('secrets-plugin');
    expect(plugin.version).toBe(manifest.version);
    expect(plugin.provides).toContain(CAPABILITIES.SECRETS);
    expect(plugin.optionalDependencies).toEqual([CAPABILITIES.LOGGER, CAPABILITIES.CONFIG]);
    expect(plugin.priority).toBe(PLUGIN_PRIORITY.NORMAL);
  });
});

describe('SecretsPlugin configFallback', () => {
  it.each(['false', 0, 1, null, {}, []])('rejects non-booleans at construction (%j)', (value) => {
    const options = { configFallback: value } as unknown as SecretsProviderOptions;
    expect(() => SecretsPlugin({ options })).toThrow(TypeError);
    expect(() => SecretsPlugin({ provider: 'env', options })).toThrow('options.configFallback');
  });

  it.each(['aws-kms', 'gcp', 'azure', 'vault'] as const)(
    'ignores configFallback for %s',
    (provider) => {
      expect(() =>
        SecretsPlugin({
          provider,
          options: { configFallback: 'ignored' } as unknown as SecretsProviderOptions,
        }),
      ).not.toThrow();
    },
  );

  it.each([undefined, true])(
    'wires config by default or when explicitly enabled (%j)',
    async (flag) => {
      const config = createFakeConfig({ TOKEN: 'config-only-do-not-log' });
      const { ctx, logs } = createFakeContext({}, true, true, config);
      const plugin = SecretsPlugin({ options: flag === undefined ? {} : { configFallback: flag } });
      await plugin.register(ctx);
      const service = ctx.services.get<ISecretManager>(CAPABILITIES.SECRETS);
      expect(await service.get('token')).toBe('config-only-do-not-log');
      expect(logs).toEqual([
        {
          message: 'SecretsPlugin registered',
          meta: { provider: 'env', configFallback: true },
        },
      ]);
    },
  );

  it('configFallback false wires no config and never resolves the CONFIG service', async () => {
    const config = createFakeConfig({ TOKEN: 'config-only' });
    const { ctx, logs } = createFakeContext({ ENV_TOKEN: 'env' }, true, true, config);
    const resolve = vi.spyOn(ctx.services, 'get');
    await SecretsPlugin({ options: { configFallback: false } }).register(ctx);
    expect(resolve.mock.calls.some(([token]) => token === CAPABILITIES.CONFIG)).toBe(false);
    const service = ctx.services.get<ISecretManager>(CAPABILITIES.SECRETS);
    expect(await service.has('token')).toBe(false);
    expect(await service.get('env/token')).toBe('env');
    expect(logs[0].meta).toEqual({ provider: 'env', configFallback: false });
  });

  it('acts on the configFallback value read at construction, not a later mutation', async () => {
    const config = createFakeConfig({ TOKEN: 'config-only' });
    const { ctx, logs } = createFakeContext({}, true, true, config);
    const options: { configFallback?: unknown } = { configFallback: false };
    const plugin = SecretsPlugin({ options: options as SecretsProviderOptions });
    // A string would have been refused at construction; it must not take effect now.
    options.configFallback = 'false';
    await plugin.register(ctx);
    const service = ctx.services.get<ISecretManager>(CAPABILITIES.SECRETS);
    expect(await service.has('token')).toBe(false);
    expect(logs[0].meta).toEqual({ provider: 'env', configFallback: false });
  });

  it('reads a configFallback getter exactly once', async () => {
    const config = createFakeConfig({ TOKEN: 'config-only' });
    const { ctx, logs } = createFakeContext({}, true, true, config);
    let reads = 0;
    const options = {
      get configFallback(): boolean {
        reads += 1;
        return reads > 1;
      },
    };
    const plugin = SecretsPlugin({ options });
    await plugin.register(ctx);
    expect(reads).toBe(1);
    const service = ctx.services.get<ISecretManager>(CAPABILITIES.SECRETS);
    expect(await service.has('token')).toBe(false);
    expect(logs[0].meta).toEqual({ provider: 'env', configFallback: false });
  });

  it.each([
    [
      'an inherited value',
      (): SecretsProviderOptions =>
        Object.create({ configFallback: false }) as SecretsProviderOptions,
    ],
    [
      'a class accessor',
      (): SecretsProviderOptions =>
        new (class {
          get configFallback(): boolean {
            return false;
          }
        })(),
    ],
    [
      'a non-enumerable own value',
      (): SecretsProviderOptions =>
        Object.defineProperty({}, 'configFallback', { value: false, enumerable: false }),
    ],
  ])('honours configFallback false supplied as %s', async (_label, makeOptions) => {
    const config = createFakeConfig({ TOKEN: 'config-only' });
    const { ctx, logs } = createFakeContext({}, true, true, config);
    await SecretsPlugin({ options: makeOptions() }).register(ctx);
    const service = ctx.services.get<ISecretManager>(CAPABILITIES.SECRETS);
    expect(await service.has('token')).toBe(false);
    expect(logs[0].meta).toEqual({ provider: 'env', configFallback: false });
  });

  it('passes other options through untouched, including an inherited prefix', async () => {
    const config = createFakeConfig({ TOKEN: 'unprefixed-config' });
    const { ctx } = createFakeContext({ APP_TOKEN: 'prefixed-env' }, true, true, config);
    const options = Object.create({ prefix: 'APP_' }) as SecretsProviderOptions;
    await SecretsPlugin({ options }).register(ctx);
    const service = ctx.services.get<ISecretManager>(CAPABILITIES.SECRETS);
    expect(await service.get('token')).toBe('prefixed-env');
  });

  it('is silent when CONFIG is absent and reads only the environment', async () => {
    const { ctx, logs } = createFakeContext({ TOKEN: 'env' }, true);
    await SecretsPlugin({ options: { configFallback: true } }).register(ctx);
    const service = ctx.services.get<ISecretManager>(CAPABILITIES.SECRETS);
    expect(await service.get('token')).toBe('env');
    expect(await service.has('missing')).toBe(false);
    expect(logs).toEqual([
      {
        message: 'SecretsPlugin registered',
        meta: { provider: 'env', configFallback: false },
      },
    ]);
  });

  it('leaves other providers on their own backend even when CONFIG is present', async () => {
    const config = createFakeConfig({ TOKEN: 'config' });
    const get = vi.spyOn(config, 'get');
    const { ctx, logs } = createFakeContext({}, true, true, config);
    const client = {
      getSecretValue: (): Promise<string | null> => Promise.resolve(null),
      putSecretValue: (): Promise<void> => Promise.resolve(),
    };
    await SecretsPlugin({ provider: 'aws-kms', options: { client } }).register(ctx);
    expect(await ctx.services.get<ISecretManager>(CAPABILITIES.SECRETS).has('token')).toBe(false);
    expect(get).not.toHaveBeenCalled();
    expect(logs[0].meta).toEqual({ provider: 'aws-kms', configFallback: false });
  });

  it('does not cache misses and caches config values with the configured TTL', async () => {
    const data: Record<string, unknown> = {};
    const { ctx } = createFakeContext({}, false, true, createFakeConfig(data));
    let now = 0;
    (ctx.runtime as { hrtime: () => number }).hrtime = () => now;
    await SecretsPlugin({ options: { cacheTtl: 1 } }).register(ctx);
    const service = ctx.services.get<ISecretManager>(CAPABILITIES.SECRETS);
    expect(await service.has('token')).toBe(false);
    await expect(service.get('token')).rejects.toThrow('Secret not found');
    data.TOKEN = 'first';
    expect(await service.get('token')).toBe('first');
    data.TOKEN = 'next';
    expect(await service.get('token')).toBe('first');
    now = 1000;
    expect(await service.get('token')).toBe('next');
  });
});

describe('createProvider', () => {
  it('wires config only when the caller passes it', async () => {
    const config = createFakeConfig({ TOKEN: 'config' });
    const enabled = createProvider('env', {}, {}, undefined, config);
    const disabled = createProvider('env', {}, {});
    expect(await enabled.get('token')).toBe('config');
    expect(await disabled.get('token')).toBeNull();
  });
  it('builds the matching provider for each id', () => {
    expect(createProvider('env', {}, {})).toBeInstanceOf(EnvProvider);
    expect(createProvider('aws-kms', {}, {})).toBeInstanceOf(AwsKmsProvider);
    expect(createProvider('gcp', {}, {})).toBeInstanceOf(GcpSecretManagerProvider);
    expect(createProvider('azure', {}, {})).toBeInstanceOf(AzureKeyVaultProvider);
    expect(createProvider('vault', {}, {})).toBeInstanceOf(HashiCorpVaultProvider);
  });

  it('passes an injected AWS client through', () => {
    const client = {
      getSecretValue: () => Promise.resolve(null),
      putSecretValue: () => Promise.resolve(),
    };
    const provider = createProvider('aws-kms', { client }, {});
    expect(provider).toBeInstanceOf(AwsKmsProvider);
  });

  it('passes an injected GCP client through', () => {
    const client = {
      accessSecretVersion: () => Promise.resolve(null),
      addSecretVersion: () => Promise.resolve(),
    };
    expect(createProvider('gcp', { client }, {})).toBeInstanceOf(GcpSecretManagerProvider);
  });

  it('passes an injected Azure client through', () => {
    const client = {
      getSecret: () => Promise.resolve(null),
      setSecret: () => Promise.resolve(),
    };
    expect(createProvider('azure', { client }, {})).toBeInstanceOf(AzureKeyVaultProvider);
  });

  it('throws for an unknown provider id', () => {
    expect(() => createProvider('bogus' as SecretsProviderType, {}, {})).toThrow(
      'Unsupported secrets provider: bogus',
    );
  });
});

describe('SecretsPlugin.register', () => {
  it('registers the service, health indicator, and close handler (env default)', async () => {
    const plugin = SecretsPlugin();
    const { ctx, registered, healthIndicators, onCloseHandlers } = createFakeContext({
      DATABASE_PASSWORD: 's3cret',
    });

    await plugin.register(ctx);

    expect(registered.has(CAPABILITIES.SECRETS)).toBe(true);
    expect(healthIndicators.has(CAPABILITIES.SECRETS)).toBe(true);
    expect(onCloseHandlers.length).toBe(1);

    // The registered service reads a secret through the env provider.
    const service = registered.get(CAPABILITIES.SECRETS) as ISecretManager;
    expect(await service.get('database/password')).toBe('s3cret');

    // The health indicator reports up for a ready provider, with the
    // env provider's lifecycle-truth reachability (M90b).
    const health = await healthIndicators.get(CAPABILITIES.SECRETS)!();
    expect(health.status).toBe('up');
    expect(health.data).toEqual({ provider: 'env', reachable: true });

    // The close handler runs without error.
    await onCloseHandlers[0]();
  });

  it('logs registration metadata but no secret value', async () => {
    const plugin = SecretsPlugin({ options: { prefix: 'APP_' } });
    const { ctx, logs } = createFakeContext({ APP_TOKEN: 'do-not-log-me' }, true);

    await plugin.register(ctx);

    expect(logs.length).toBe(1);
    expect(logs[0].message).toBe('SecretsPlugin registered');
    expect(logs[0].meta).toEqual({ provider: 'env', configFallback: false });
    // No secret value leaks into the log metadata.
    expect(JSON.stringify(logs[0])).not.toContain('do-not-log-me');
  });

  it('threads cacheTtl through to the service', async () => {
    let calls = 0;
    const client = {
      getSecretValue: (_id: string): Promise<string | null> => {
        calls++;
        return Promise.resolve('v');
      },
      putSecretValue: (): Promise<void> => Promise.resolve(),
    };
    const plugin = SecretsPlugin({
      provider: 'aws-kms',
      options: { client, cacheTtl: 300 },
    });
    const { ctx, registered } = createFakeContext();
    await plugin.register(ctx);

    const service = registered.get(CAPABILITIES.SECRETS) as ISecretManager;
    await service.get('k');
    await service.get('k');
    // Second read served from cache → provider hit only once.
    expect(calls).toBe(1);
  });

  it('registers without a runtime service (no clock available)', async () => {
    const plugin = SecretsPlugin();
    // Third arg false → runtime not registered under the token, so the plugin's
    // clock resolution takes its undefined branch.
    const { ctx, registered } = createFakeContext({ TOKEN: 't' }, false, false);
    await plugin.register(ctx);

    const service = registered.get(CAPABILITIES.SECRETS) as ISecretManager;
    expect(await service.get('token')).toBe('t');
  });

  describe('health reachability (M90b)', () => {
    interface HealthFn {
      (): Promise<{ status: string; data?: Record<string, unknown> }>;
    }

    it('reports unknown for an injected facade without a probe — never a false true', async () => {
      const client = {
        getSecretValue: (_id: string): Promise<string | null> => Promise.resolve('v'),
        putSecretValue: (_id: string, _v: string): Promise<void> => Promise.resolve(),
      };
      const plugin = SecretsPlugin({ provider: 'aws-kms', options: { client } });
      const { ctx, healthIndicators } = createFakeContext();
      await plugin.register(ctx);

      const indicator = healthIndicators.get(CAPABILITIES.SECRETS) as HealthFn;
      const health = await indicator();
      expect(health.status).toBe('up');
      expect(health.data).toEqual({ provider: 'aws-kms', reachable: 'unknown' });
    });

    it('reports down with reachable: false when the provider probe fails', async () => {
      const plugin = SecretsPlugin({
        provider: 'vault',
        options: {
          address: 'https://vault.example.com',
          token: 't',
          http: (() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as IVaultHttp,
        },
      });
      const { ctx, healthIndicators } = createFakeContext();
      await plugin.register(ctx);

      const indicator = healthIndicators.get(CAPABILITIES.SECRETS) as HealthFn;
      const health = await indicator();
      expect(health.status).toBe('down');
      expect(health.data).toEqual({ provider: 'vault', reachable: false });
    });

    it('reports down with reachable: false when the provider was never connected', async () => {
      // A provider that fails connect() never reaches the indicator
      // registration, so drive the not-ready branch through a provider whose
      // backend probe answers false AFTER a successful connect: disconnect
      // via the close handler, then read the indicator.
      const plugin = SecretsPlugin({
        provider: 'vault',
        options: {
          address: 'https://vault.example.com',
          token: 't',
          http: (() =>
            Promise.resolve(
              new Response(JSON.stringify({ initialized: true }), { status: 200 }),
            )) as unknown as IVaultHttp,
        },
      });
      const { ctx, healthIndicators, onCloseHandlers } = createFakeContext();
      await plugin.register(ctx);
      await onCloseHandlers[0]();

      const indicator = healthIndicators.get(CAPABILITIES.SECRETS) as HealthFn;
      const health = await indicator();
      expect(health.status).toBe('down');
      expect(health.data).toEqual({ provider: 'vault', reachable: false });
    });

    it('measures the probe TTL on the INJECTED runtime clock', async () => {
      let probes = 0;
      const client = {
        getSecretValue: (_id: string): Promise<string | null> => Promise.resolve('v'),
        putSecretValue: (_id: string, _v: string): Promise<void> => Promise.resolve(),
        isHealthy: (): Promise<boolean> => {
          probes++;
          return Promise.resolve(true);
        },
      };
      const plugin = SecretsPlugin({ provider: 'aws-kms', options: { client } });
      const { ctx, healthIndicators } = createFakeContext();
      // Controllable monotonic clock on the injected runtime. Set BEFORE
      // register(): resolveProbeTiming binds ctx.runtime's hrtime there.
      let now = 0;
      (ctx.runtime as { hrtime: () => number }).hrtime = (): number => now;
      await plugin.register(ctx);

      const indicator = healthIndicators.get(CAPABILITIES.SECRETS) as HealthFn;
      await indicator();
      await indicator();
      expect(probes).toBe(1);
      // Advance the INJECTED clock past the 5-second TTL: the next read is a
      // fresh probe even though no wall-clock time has passed. Against the
      // old ambient performance.now() fallback the third read still landed
      // inside the real-time TTL and this failed with 1 probe.
      now = 5001;
      await indicator();
      expect(probes).toBe(2);
    });

    it('bounds each probe with the INJECTED runtime timers', async () => {
      const timerCalls: Array<{ ms: number }> = [];
      const client = {
        getSecretValue: (_id: string): Promise<string | null> => Promise.resolve('v'),
        putSecretValue: (_id: string, _v: string): Promise<void> => Promise.resolve(),
        isHealthy: (): Promise<boolean> => Promise.resolve(true),
      };
      const plugin = SecretsPlugin({ provider: 'aws-kms', options: { client } });
      const { ctx, healthIndicators } = createFakeContext();
      (
        ctx.runtime as {
          setTimeout: (fn: () => void, ms: number) => unknown;
        }
      ).setTimeout = (fn: () => void, ms: number): unknown => {
        timerCalls.push({ ms });
        return setTimeout(fn, ms);
      };
      await plugin.register(ctx);

      const indicator = healthIndicators.get(CAPABILITIES.SECRETS) as HealthFn;
      await indicator();
      // Exactly one bound armed, from the runtime's setTimeout — not the
      // ambient one. The old code armed an ambient timer and this saw zero.
      expect(timerCalls.length).toBe(1);
      expect(timerCalls[0]?.ms).toBe(2000);
    });
  });
});
