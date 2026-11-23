/**
 * The AWS, GCP and Azure secrets arms end within `requestTimeoutMs` (V13-216)
 * and answer an outage as `SecretProviderUnavailableError` (V13-217), through
 * the REAL SDKs (devDependencies) against an in-test server that accepts and
 * never answers, and against a closed port. The probes and the Azure option are
 * checked over fake modules (V13-215, V13-255).
 *
 * @module
 */
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { httpStatusHintOf } from '@setu-ts/common';
import { SecretProviderUnavailableError } from '../../src/errors.ts';
import { AwsKmsProvider } from '../../src/providers/aws-kms.ts';
import type { AwsSdkModule } from '../../src/providers/aws-kms.ts';
import { adaptAwsModule } from '../../src/providers/aws-kms.ts';
import { GcpSecretManagerProvider } from '../../src/providers/gcp-secret-manager.ts';
import type { GcpSdkModule } from '../../src/providers/gcp-secret-manager.ts';
import { adaptGcpModule } from '../../src/providers/gcp-secret-manager.ts';
import { AzureKeyVaultProvider } from '../../src/providers/azure-key-vault.ts';
import type { AzureSdkModule } from '../../src/providers/azure-key-vault.ts';
import { adaptAzureModule } from '../../src/providers/azure-key-vault.ts';

const BOUND_MS = 300;
const SLACK_MS = 2000;
let blackHole: Server;
let port = 0;
const sockets = new Set<Socket>();
let keyDir = '';
let previousCredentials: string | undefined;

beforeAll(async () => {
  blackHole = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => blackHole.listen(0, '127.0.0.1', resolve));
  port = (blackHole.address() as { port: number }).port;
  // GCP: a locally generated service-account key, so the SDK signs its own
  // token and never reaches a Google endpoint.
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  keyDir = mkdtempSync(join(tmpdir(), 'gcp-key-'));
  const keyFile = join(keyDir, 'key.json');
  writeFileSync(
    keyFile,
    JSON.stringify({
      type: 'service_account',
      project_id: 'p',
      client_email: 'reader@p.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    }),
  );
  previousCredentials = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
  process.env['GOOGLE_APPLICATION_CREDENTIALS'] = keyFile;
});

afterAll(async () => {
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => blackHole.close(() => resolve()));
  if (previousCredentials === undefined) delete process.env['GOOGLE_APPLICATION_CREDENTIALS'];
  else process.env['GOOGLE_APPLICATION_CREDENTIALS'] = previousCredentials;
  rmSync(keyDir, { recursive: true, force: true });
});

async function expectUnavailableWithin(
  run: () => Promise<unknown>,
  limitMs: number,
): Promise<void> {
  const started = performance.now();
  const error = await run().catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SecretProviderUnavailableError);
  expect(httpStatusHintOf(error)?.status).toBe(503);
  expect(performance.now() - started).toBeLessThan(limitMs);
}

describe('aws-kms on the real SDK (V13-216, V13-217)', () => {
  const base = { region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' } as const;

  it('a hung endpoint is a 503 within the bound, for get and set', async () => {
    const provider = new AwsKmsProvider({
      ...base,
      endpoint: `http://127.0.0.1:${port}`,
      requestTimeoutMs: BOUND_MS,
    });
    await provider.connect();
    await expectUnavailableWithin(() => provider.get('s'), BOUND_MS + SLACK_MS);
    await expectUnavailableWithin(() => provider.set('s', 'v'), BOUND_MS + SLACK_MS);
    expect(await provider.isHealthy!()).toBe(false);
  });

  it('a refused endpoint is a 503', async () => {
    const provider = new AwsKmsProvider({ ...base, endpoint: 'http://127.0.0.1:1' });
    await provider.connect();
    await expectUnavailableWithin(() => provider.get('s'), 30_000);
  });
});

describe('gcp on the real SDK (V13-216, V13-217)', () => {
  it('a hung endpoint is a 503 within the bound', async () => {
    const provider = new GcpSecretManagerProvider({
      projectId: 'p',
      endpoint: `127.0.0.1:${port}`,
      requestTimeoutMs: BOUND_MS,
    });
    await provider.connect();
    await expectUnavailableWithin(() => provider.get('s'), BOUND_MS + SLACK_MS);
    expect(await provider.isHealthy!()).toBe(false);
  }, 20_000);

  it('a refused endpoint is a 503 within the bound', async () => {
    const provider = new GcpSecretManagerProvider({
      projectId: 'p',
      endpoint: '127.0.0.1:1',
      requestTimeoutMs: 2000,
    });
    await provider.connect();
    await expectUnavailableWithin(() => provider.get('s'), 2000 + SLACK_MS);
  }, 20_000);
});

describe('azure on the real SDK (V13-216, V13-217)', () => {
  it('a hung vault is a 503 within the bound', async () => {
    const provider = new AzureKeyVaultProvider({
      vaultUrl: `https://127.0.0.1:${port}`,
      disableChallengeResourceVerification: true,
      requestTimeoutMs: BOUND_MS,
    });
    await provider.connect();
    await expectUnavailableWithin(() => provider.get('s'), BOUND_MS + SLACK_MS);
  });

  it('a refused vault is a 503 within the bound', async () => {
    const provider = new AzureKeyVaultProvider({
      vaultUrl: 'https://127.0.0.1:1',
      requestTimeoutMs: 1500,
    });
    await provider.connect();
    await expectUnavailableWithin(() => provider.get('s'), 1500 + SLACK_MS);
  });
});

describe('construction refuses an out-of-range bound', () => {
  it('on all three arms', () => {
    expect(() => new AwsKmsProvider({ requestTimeoutMs: -1 })).toThrow(RangeError);
    expect(() => new GcpSecretManagerProvider({ requestTimeoutMs: Number.NaN })).toThrow(
      RangeError,
    );
    expect(() => new AzureKeyVaultProvider({ requestTimeoutMs: 2_147_483_648 })).toThrow(
      RangeError,
    );
  });
});

describe('the adapted clients probe without reading a value (V13-215)', () => {
  it('aws lists one secret, and a refused credential still reads reachable', async () => {
    const sent: unknown[] = [];
    let answer: () => Promise<unknown> = () => Promise.resolve({});
    const mod = {
      SecretsManagerClient: class {
        send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
          sent.push([command, options?.abortSignal instanceof AbortSignal]);
          return answer();
        }
      },
      GetSecretValueCommand: class {},
      PutSecretValueCommand: class {},
      ListSecretsCommand: class {
        constructor(readonly input: unknown) {}
      },
    } as unknown as AwsSdkModule;
    const client = adaptAwsModule(mod, {});
    expect(await client.isHealthy!()).toBe(true);
    expect(sent).toEqual([[{ input: { MaxResults: 1 } }, true]]);
    answer = () =>
      Promise.reject(
        Object.assign(new Error('AccessDenied'), { $metadata: { httpStatusCode: 400 } }),
      );
    expect(await client.isHealthy!()).toBe(true);
    answer = () =>
      Promise.reject(Object.assign(new Error('down'), { $metadata: { httpStatusCode: 503 } }));
    expect(await client.isHealthy!()).toBe(false);
  });

  it('gcp lists one secret of the project with a call timeout', async () => {
    const calls: unknown[] = [];
    const mod = {
      SecretManagerServiceClient: class {
        listSecrets(request: unknown, options: unknown): Promise<unknown> {
          calls.push([request, options]);
          return Promise.reject(Object.assign(new Error('denied'), { code: 7 }));
        }
        accessSecretVersion(_request: unknown, options: unknown): Promise<unknown> {
          calls.push(['access', options]);
          return Promise.resolve([{ payload: { data: 'v' } }]);
        }
        addSecretVersion(): Promise<unknown> {
          return Promise.resolve({});
        }
      },
    } as unknown as GcpSdkModule;
    const client = adaptGcpModule(mod, { projectId: 'p', requestTimeoutMs: 1234 });
    expect(await client.isHealthy!()).toBe(true);
    expect(await client.accessSecretVersion('s')).toBe('v');
    expect(calls).toEqual([
      [
        { parent: 'projects/p', pageSize: 1 },
        { timeout: 1234, autoPaginate: false },
      ],
      ['access', { timeout: 1234 }],
    ]);
    const unbounded = adaptGcpModule(mod, { projectId: 'p', requestTimeoutMs: 0 });
    await unbounded.accessSecretVersion('s');
    expect(calls.at(-1)).toEqual(['access', {}]);
  });

  it('azure lists one page of one secret, and passes the challenge option (V13-255)', async () => {
    const seen: unknown[] = [];
    let pageAnswer: () => Promise<unknown> = () => Promise.resolve({ value: [] });
    const mod = {
      SecretClient: class {
        constructor(_url: string, _credential: unknown, options: unknown) {
          seen.push(options);
        }
        getSecret(): Promise<{ value: string }> {
          return Promise.resolve({ value: 'v' });
        }
        setSecret(): Promise<unknown> {
          return Promise.resolve({});
        }
        listPropertiesOfSecrets(options: { abortSignal?: AbortSignal }) {
          seen.push(options.abortSignal instanceof AbortSignal);
          return {
            byPage: (settings: unknown) => {
              seen.push(settings);
              return { next: () => pageAnswer() };
            },
          };
        }
      },
      DefaultAzureCredential: class {},
    } as unknown as AzureSdkModule;
    const client = adaptAzureModule(mod, {
      vaultUrl: 'https://v.vault.azure.net',
      disableChallengeResourceVerification: true,
    });
    expect(await client.isHealthy!()).toBe(true);
    expect(seen).toEqual([
      { disableChallengeResourceVerification: true },
      true,
      { maxPageSize: 1 },
    ]);
    pageAnswer = () => Promise.reject(Object.assign(new Error('down'), { statusCode: 503 }));
    expect(await client.isHealthy!()).toBe(false);
    adaptAzureModule(mod, { vaultUrl: 'https://v.vault.azure.net' });
    expect(seen.at(-1)).toEqual({});
    expect(() => adaptAzureModule(mod, {})).toThrow(/requires options.vaultUrl/);
  });
});

describe('an injected client is bounded and classified too', () => {
  it('a never-settling facade is a 503 within the bound; a refusal names the provider', async () => {
    const provider = new AwsKmsProvider({
      requestTimeoutMs: 50,
      client: {
        getSecretValue: () => new Promise<null>(() => undefined),
        putSecretValue: () => Promise.reject(new Error('AccessDenied')),
      },
    });
    await provider.connect();
    await expectUnavailableWithin(() => provider.get('s'), 3000);
    await expect(provider.set('s', 'v')).rejects.toThrow('AwsKmsProvider set failed: AccessDenied');
    expect(provider.isHealthy).toBeUndefined();
  });
});
