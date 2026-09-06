/**
 * Cloud facade reachability probes (M90b).
 *
 * One suite for the three cloud providers because the behavior under test
 * is identical by design: an injected facade that exposes the OPTIONAL
 * `isHealthy()` member publishes real reachability — called through its
 * OWNER, since a facade may read instance state — and a facade without the
 * member leaves the provider's probe `undefined`, which the plugin's
 * indicator reports as `reachable: 'unknown'` (never a lifecycle reading
 * standing in for reachability, and never a secret read as a probe).
 *
 * The adapted (lazy SDK) facades built by `adaptAwsModule` /
 * `adaptGcpModule` / `adaptAzureModule` deliberately carry no probe: a
 * third-party SDK has no non-mutating health call, so the lazy path is
 * always `unknown` (see PUBLIC_API.md, Secrets → Health status).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { AwsKmsProvider } from '../../src/providers/aws-kms.ts';
import { GcpSecretManagerProvider } from '../../src/providers/gcp-secret-manager.ts';
import { AzureKeyVaultProvider } from '../../src/providers/azure-key-vault.ts';
import type {
  IAwsSecretsClient,
  IAzureSecretsClient,
  IGcpSecretsClient,
} from '../../src/interfaces/index.ts';

/** Facades whose probe reads `this` — the X21-1-style detached-call trap. */
const awsClientWithProbe = (): IAwsSecretsClient => {
  const facade: IAwsSecretsClient & { isHealthy(): Promise<boolean> } = {
    getSecretValue: (_id: string): Promise<string | null> => Promise.resolve('v'),
    putSecretValue: (_id: string, _v: string): Promise<void> => Promise.resolve(),
    isHealthy(): Promise<boolean> {
      // Reading `this.getSecretValue` throws when the member is invoked
      // detached from its owner.
      return Promise.resolve(typeof this.getSecretValue === 'function');
    },
  };
  return facade;
};

const gcpClientWithProbe = (): IGcpSecretsClient => {
  const facade: IGcpSecretsClient & { isHealthy(): Promise<boolean> } = {
    accessSecretVersion: (_name: string): Promise<string | null> => Promise.resolve('v'),
    addSecretVersion: (_name: string, _v: string): Promise<void> => Promise.resolve(),
    isHealthy(): Promise<boolean> {
      return Promise.resolve(typeof this.accessSecretVersion === 'function');
    },
  };
  return facade;
};

const azureClientWithProbe = (): IAzureSecretsClient => {
  const facade: IAzureSecretsClient & { isHealthy(): Promise<boolean> } = {
    getSecret: (_name: string): Promise<string | null> => Promise.resolve('v'),
    setSecret: (_name: string, _v: string): Promise<void> => Promise.resolve(),
    isHealthy(): Promise<boolean> {
      return Promise.resolve(typeof this.getSecret === 'function');
    },
  };
  return facade;
};

/** Facades WITHOUT the optional member — the `unknown` arm of every table. */
const awsClientWithoutProbe = (): IAwsSecretsClient => ({
  getSecretValue: (_id: string): Promise<string | null> => Promise.resolve(null),
  putSecretValue: (_id: string, _v: string): Promise<void> => Promise.resolve(),
});

const gcpClientWithoutProbe = (): IGcpSecretsClient => ({
  accessSecretVersion: (_name: string): Promise<string | null> => Promise.resolve(null),
  addSecretVersion: (_name: string, _v: string): Promise<void> => Promise.resolve(),
});

const azureClientWithoutProbe = (): IAzureSecretsClient => ({
  getSecret: (_name: string): Promise<string | null> => Promise.resolve(null),
  setSecret: (_name: string, _v: string): Promise<void> => Promise.resolve(),
});

describe('cloud facade reachability (M90b)', () => {
  it('AwsKmsProvider delegates to the injected facade probe, called through its owner', async () => {
    const provider = new AwsKmsProvider({ client: awsClientWithProbe() });
    await provider.connect();
    expect(typeof provider.isHealthy).toBe('function');
    // Resolves (not throws on `this`) — the owner-bound call.
    await expect(provider.isHealthy?.()).resolves.toBe(true);
  });

  it('AwsKmsProvider stays probe-less when the facade omits isHealthy', async () => {
    const provider = new AwsKmsProvider({ client: awsClientWithoutProbe() });
    await provider.connect();
    expect(provider.isHealthy).toBeUndefined();
  });

  it('GcpSecretManagerProvider delegates to the injected facade probe, called through its owner', async () => {
    const provider = new GcpSecretManagerProvider({ projectId: 'p', client: gcpClientWithProbe() });
    await provider.connect();
    expect(typeof provider.isHealthy).toBe('function');
    await expect(provider.isHealthy?.()).resolves.toBe(true);
  });

  it('GcpSecretManagerProvider stays probe-less when the facade omits isHealthy', async () => {
    const provider = new GcpSecretManagerProvider({
      projectId: 'p',
      client: gcpClientWithoutProbe(),
    });
    await provider.connect();
    expect(provider.isHealthy).toBeUndefined();
  });

  it('AzureKeyVaultProvider delegates to the injected facade probe, called through its owner', async () => {
    const provider = new AzureKeyVaultProvider({ client: azureClientWithProbe() });
    await provider.connect();
    expect(typeof provider.isHealthy).toBe('function');
    await expect(provider.isHealthy?.()).resolves.toBe(true);
  });

  it('AzureKeyVaultProvider stays probe-less when the facade omits isHealthy', async () => {
    const provider = new AzureKeyVaultProvider({ client: azureClientWithoutProbe() });
    await provider.connect();
    expect(provider.isHealthy).toBeUndefined();
  });
});
