import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type { ISecretManager } from '@hono-enterprise/common';

import { createProvider, SecretsPlugin } from '../../src/plugin/secrets-plugin.ts';
import { EnvProvider } from '../../src/providers/env-provider.ts';
import { AwsKmsProvider } from '../../src/providers/aws-kms.ts';
import { GcpSecretManagerProvider } from '../../src/providers/gcp-secret-manager.ts';
import { AzureKeyVaultProvider } from '../../src/providers/azure-key-vault.ts';
import { HashiCorpVaultProvider } from '../../src/providers/vault.ts';
import type { SecretsProviderType } from '../../src/interfaces/index.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';

describe('SecretsPlugin metadata', () => {
  it('exposes the expected plugin contract fields', () => {
    const plugin = SecretsPlugin();
    expect(plugin.name).toBe('secrets-plugin');
    expect(plugin.version).toBe('0.1.0');
    expect(plugin.provides).toContain(CAPABILITIES.SECRETS);
    expect(plugin.optionalDependencies).toEqual(['logger']);
    expect(plugin.priority).toBe(PLUGIN_PRIORITY.NORMAL);
  });
});

describe('createProvider', () => {
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

    // The health indicator reports up for a ready provider.
    const health = await healthIndicators.get(CAPABILITIES.SECRETS)!();
    expect(health.status).toBe('up');
    expect(health.data).toEqual({ provider: 'env' });

    // The close handler runs without error.
    await onCloseHandlers[0]();
  });

  it('logs registration metadata but no secret value', async () => {
    const plugin = SecretsPlugin({ options: { prefix: 'APP_' } });
    const { ctx, logs } = createFakeContext({ APP_TOKEN: 'do-not-log-me' }, true);

    await plugin.register(ctx);

    expect(logs.length).toBe(1);
    expect(logs[0].message).toBe('SecretsPlugin registered');
    expect(logs[0].meta).toEqual({ provider: 'env' });
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
});
