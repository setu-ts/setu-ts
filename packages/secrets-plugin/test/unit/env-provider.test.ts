import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { EnvProvider, toEnvKey } from '../../src/providers/env-provider.ts';

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

  it('set throws because environment secrets are read-only', async () => {
    const provider = new EnvProvider({});
    await expect(provider.set('k', 'v')).rejects.toThrow('EnvProvider is read-only');
  });
});
