# @hono-enterprise/secrets-plugin

Secret management for Hono Enterprise. Registers an `ISecretManager` under `CAPABILITIES.SECRETS`,
backed by a pluggable provider with a read-through cache.

Providers:

| Provider                   | `provider` id | Backend                                      | Dependency                                             |
| -------------------------- | ------------- | -------------------------------------------- | ------------------------------------------------------ |
| `EnvProvider` (default)    | `env`         | Environment variables via `IRuntimeServices` | none (every runtime, incl. Cloudflare Workers)         |
| `AwsKmsProvider`           | `aws-kms`     | AWS Secrets Manager (KMS-backed encryption)  | lazy `npm:@aws-sdk/client-secrets-manager` (or inject) |
| `GcpSecretManagerProvider` | `gcp`         | GCP Secret Manager                           | lazy `npm:@google-cloud/secret-manager` (or inject)    |
| `AzureKeyVaultProvider`    | `azure`       | Azure Key Vault                              | lazy `npm:@azure/keyvault-secrets` (or inject)         |
| `HashiCorpVaultProvider`   | `vault`       | HashiCorp Vault KV v2 over `fetch`           | none (zero-dependency, Workers-compatible)             |

No cloud SDK is a hard dependency: a provider either receives an injected client facade through
options, or lazily imports the SDK at `connect()` time (AI_GUIDELINES §12.2). Secrets are never
logged.

## Installation

```typescript
import { SecretsPlugin } from '@hono-enterprise/secrets-plugin';
```

Install the SDK only for the provider you choose (e.g.
`deno add npm:@aws-sdk/client-secrets-manager`). `env` and `vault` need nothing.

## Usage

```typescript
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { SecretsPlugin } from '@hono-enterprise/secrets-plugin';
import type { ISecretManager } from '@hono-enterprise/common';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    // Environment variables (default) — reads e.g. DATABASE_PASSWORD.
    SecretsPlugin(),
  ],
});
await app.start();

const secrets = app.services.get<ISecretManager>('secrets');
const dbPassword = await secrets.get('database/password'); // → env DATABASE_PASSWORD
const exists = await secrets.has('database/password');
```

### HashiCorp Vault

```typescript
SecretsPlugin({
  provider: 'vault',
  options: {
    address: 'https://vault.example.com',
    token: vaultToken,
    mount: 'secret', // KV v2 mount (default)
  },
});
```

Vault secrets store the string under the `value` field of the KV item; `rotate` writes a new
version.

### AWS Secrets Manager (KMS-backed)

```typescript
SecretsPlugin({
  provider: 'aws-kms',
  options: { region: 'us-east-1' /* or inject `client` */ },
});
```

> "KMS" here denotes AWS Secrets Manager's KMS-backed encryption: KMS alone cannot store/retrieve
> named secrets by path, so `get`/`rotate` go through Secrets Manager (which encrypts with KMS).

### Injecting a client (testing / custom credentials)

Every cloud provider accepts a structural `client` facade, bypassing the lazy import:

```typescript
SecretsPlugin({
  provider: 'aws-kms',
  options: {
    client: {
      getSecretValue: (id) => myGet(id), // Promise<string | null>
      putSecretValue: (id, v) => myPut(id, v), // Promise<void>
    },
  },
});
```

## Options

| Option                                               | Provider                | Description                                                    |
| ---------------------------------------------------- | ----------------------- | -------------------------------------------------------------- |
| `provider`                                           | —                       | `'env'` (default), `'aws-kms'`, `'gcp'`, `'azure'`, `'vault'`. |
| `options.cacheTtl`                                   | all                     | Read-cache TTL in seconds; `0` disables. Default `300`.        |
| `options.prefix`                                     | `env`                   | Prefix prepended to the derived env key.                       |
| `options.region` / `accessKeyId` / `secretAccessKey` | `aws-kms`               | AWS client config (ignored when `client` injected).            |
| `options.projectId`                                  | `gcp`                   | GCP project id for resource paths.                             |
| `options.vaultUrl`                                   | `azure`                 | Key Vault URL.                                                 |
| `options.address` / `token` / `mount`                | `vault`                 | Vault server address, token, and KV mount.                     |
| `options.client`                                     | `aws-kms`/`gcp`/`azure` | Injected client facade (bypasses lazy import).                 |
| `options.http`                                       | `vault`                 | Injected `fetch`-shaped function (defaults to global `fetch`). |

## API

- `SecretsPlugin(options?)` — plugin factory.
- `SecretsService` — the `ISecretManager` implementation (provider + read cache).
- `EnvProvider`, `AwsKmsProvider`, `GcpSecretManagerProvider`, `AzureKeyVaultProvider`,
  `HashiCorpVaultProvider` — provider classes.
- `IAwsSecretsClient`, `IGcpSecretsClient`, `IAzureSecretsClient`, `IVaultHttp` — structural
  injection types.

`EnvProvider` is read-only: `rotate()` (and provider `set`) throws, because environment variables
cannot be mutated at runtime.
