import { describe, expect, it, vi } from 'vitest';

import { EnvProvider, toEnvKey } from '../../src/providers/env-provider.ts';
import { createFakeConfig } from '../fixtures/fake-config.ts';

describe('toEnvKey', () => {
  it('uppercases and replaces / - . with _', () => {
    expect(toEnvKey('database/password', '')).toBe('DATABASE_PASSWORD');
    expect(toEnvKey('api-key', '')).toBe('API_KEY');
    expect(toEnvKey('svc.token', '')).toBe('SVC_TOKEN');
  });

  it('applies the prefix', () => {
    expect(toEnvKey('database/password', 'APP_')).toBe('APP_DATABASE_PASSWORD');
  });
});

describe('EnvProvider', () => {
  it('is ready without connecting and no-ops connect/disconnect', async () => {
    const provider = new EnvProvider({});
    expect(provider.isReady()).toBe(true);
    await provider.connect();
    await provider.disconnect();
    expect(provider.isReady()).toBe(true);
  });

  it('reads a present variable and returns null when absent', async () => {
    const provider = new EnvProvider({ DATABASE_PASSWORD: 's3cret' });
    expect(await provider.get('database/password')).toBe('s3cret');
    expect(await provider.get('missing/key')).toBeNull();
  });

  it('honors the prefix', async () => {
    const provider = new EnvProvider({ APP_TOKEN: 't' }, { prefix: 'APP_' });
    expect(await provider.get('token')).toBe('t');
  });

  it('environment value wins over config without consulting it', async () => {
    const config = createFakeConfig({ DATABASE_PASSWORD: 'from-config' });
    const get = vi.spyOn(config, 'get');
    const provider = new EnvProvider({ DATABASE_PASSWORD: 'from-env' }, { config });
    expect(await provider.get('database/password')).toBe('from-env');
    expect(get).not.toHaveBeenCalled();
  });

  it('returns an unexpanded environment value even when config expanded it', async () => {
    const config = createFakeConfig({ TOKEN: 'expanded' });
    const provider = new EnvProvider({ TOKEN: '${X}' }, { config });
    expect(await provider.get('token')).toBe('${X}');
  });

  it('preserves an empty environment string instead of consulting config', async () => {
    const provider = new EnvProvider({ TOKEN: '' }, { config: createFakeConfig({ TOKEN: 'v' }) });
    expect(await provider.get('token')).toBe('');
  });

  it('falls back to a config string only when the environment lacks the key', async () => {
    const provider = new EnvProvider(
      { TOKEN: undefined },
      {
        config: createFakeConfig({ TOKEN: 'from-config' }),
      },
    );
    expect(await provider.get('token')).toBe('from-config');
  });

  it('applies the prefix and all key mappings to the config lookup', async () => {
    const config = createFakeConfig({ APP_DATABASE_PASSWORD_API_KEY: 'mapped' });
    const get = vi.spyOn(config, 'get');
    const provider = new EnvProvider({}, { prefix: 'app_', config });
    expect(await provider.get('database/password.api-key')).toBe('mapped');
    expect(get).toHaveBeenCalledWith('APP_DATABASE_PASSWORD_API_KEY');
  });

  it.each([undefined, null, 42, true, {}, ['value']])(
    'returns null for a non-string config value (%j)',
    async (value) => {
      const provider = new EnvProvider({}, { config: createFakeConfig({ TOKEN: value }) });
      expect(await provider.get('token')).toBeNull();
    },
  );

  it('rejects rather than throwing synchronously when the config throws', async () => {
    const failure = new Error('config failed');
    const provider = new EnvProvider(
      {},
      {
        config: {
          get: () => {
            throw failure;
          },
        },
      },
    );
    let call: Promise<string | null> | undefined;
    expect(() => {
      call = provider.get('missing');
    }).not.toThrow();
    await expect(call).rejects.toBe(failure);
  });

  it('accepts an empty config string', async () => {
    const provider = new EnvProvider({}, { config: createFakeConfig({ TOKEN: '' }) });
    expect(await provider.get('token')).toBe('');
  });

  it('reads changes to the supplied environment map live', async () => {
    const env: Record<string, string | undefined> = {};
    const provider = new EnvProvider(env, { config: createFakeConfig({ TOKEN: 'snapshot' }) });
    expect(await provider.get('token')).toBe('snapshot');
    env.TOKEN = 'live';
    expect(await provider.get('token')).toBe('live');
  });

  it('set throws because environment secrets are read-only', async () => {
    const provider = new EnvProvider({});
    await expect(provider.set('k', 'v')).rejects.toThrow('EnvProvider is read-only');
  });

  describe('isHealthy (M90b)', () => {
    it('resolves true — the environment is process state, always reachable', async () => {
      const provider = new EnvProvider({});
      await expect(provider.isHealthy()).resolves.toBe(true);
    });
  });
});
