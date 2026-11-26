/**
 * The `aws-kms` and `azure` secrets arms against local stand-ins, through the
 * REAL SDKs. Each block is guarded on its stand-in and skips without it:
 *
 * - `AWS_ENDPOINT_URL` — LocalStack serving Secrets Manager
 * - `LOWKEY_VAULT_URL` — Lowkey Vault (an Azure Key Vault emulator). The run
 *   also needs `IDENTITY_ENDPOINT`/`IDENTITY_HEADER` (Lowkey's token endpoint,
 *   read by `DefaultAzureCredential`) and `NODE_EXTRA_CA_CERTS` trusting the
 *   emulator's certificate.
 *
 * A stand-in run proves the arm against the stand-in only; no live AWS or
 * Azure account was used.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { SecretProviderUnavailableError } from '../../src/errors.ts';
import { AwsKmsProvider } from '../../src/providers/aws-kms.ts';
import { AzureKeyVaultProvider } from '../../src/providers/azure-key-vault.ts';

const AWS = process.env['AWS_ENDPOINT_URL'];
const LOWKEY = process.env['LOWKEY_VAULT_URL'];
const unique = (): string => `standin-${Math.floor(performance.now() * 1000)}`;

describe.skipIf(AWS === undefined)('aws-kms on LocalStack', () => {
  const options = {
    region: process.env['AWS_REGION'] ?? 'us-east-1',
    accessKeyId: process.env['AWS_ACCESS_KEY_ID'] ?? 'test',
    secretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? 'test',
    endpoint: AWS,
  };

  it('reads, rotates and probes; an unreachable endpoint is a 503', async () => {
    const name = unique();
    const mod = await import('@aws-sdk/client-secrets-manager');
    await new mod.SecretsManagerClient({
      region: options.region,
      endpoint: AWS!,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    }).send(new mod.CreateSecretCommand({ Name: name, SecretString: 'first' }));
    const provider = new AwsKmsProvider(options);
    await provider.connect();
    expect(await provider.get(name)).toBe('first');
    await provider.set(name, 'second');
    expect(await provider.get(name)).toBe('second');
    expect(await provider.get(`${name}-absent`)).toBeNull();
    expect(await provider.isHealthy!()).toBe(true);
    const down = new AwsKmsProvider({ ...options, endpoint: 'http://127.0.0.1:1' });
    await down.connect();
    await expect(down.get(name)).rejects.toBeInstanceOf(SecretProviderUnavailableError);
    expect(await down.isHealthy!()).toBe(false);
  });
});

describe.skipIf(LOWKEY === undefined)('azure on Lowkey Vault (V13-255)', () => {
  it('a vault at localhost is refused without the option and works with it', async () => {
    const refused = new AzureKeyVaultProvider({ vaultUrl: LOWKEY });
    await refused.connect();
    await expect(refused.get('absent')).rejects.toThrow(/disableChallengeResourceVerification/);

    const name = unique();
    const provider = new AzureKeyVaultProvider({
      vaultUrl: LOWKEY,
      disableChallengeResourceVerification: true,
    });
    await provider.connect();
    expect(await provider.get(name)).toBeNull();
    // `set` creates a missing name on Key Vault.
    await provider.set(name, 'first');
    expect(await provider.get(name)).toBe('first');
    await provider.set(name, 'second');
    expect(await provider.get(name)).toBe('second');
    expect(await provider.isHealthy!()).toBe(true);
  });

  it('an unreachable vault is a 503 within the bound', async () => {
    const down = new AzureKeyVaultProvider({
      vaultUrl: 'https://localhost:1',
      disableChallengeResourceVerification: true,
      requestTimeoutMs: 1500,
    });
    await down.connect();
    await expect(down.get('x')).rejects.toBeInstanceOf(SecretProviderUnavailableError);
  });
});
