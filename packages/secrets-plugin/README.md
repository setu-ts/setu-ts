# @setu-ts/secrets-plugin

Secret management for Setu-TS. Registers an `ISecretManager` under `CAPABILITIES.SECRETS`, backed by
a pluggable provider with a read-through cache.

Providers:

| Provider                   | `provider` id | Backend                                     | Dependency                                         |
| -------------------------- | ------------- | ------------------------------------------- | -------------------------------------------------- |
| `EnvProvider` (default)    | `env`         | Environment, then optional config snapshot  | none (every runtime, incl. Cloudflare Workers)     |
| `AwsKmsProvider`           | `aws-kms`     | AWS Secrets Manager (KMS-backed encryption) | lazy `@aws-sdk/client-secrets-manager` (or inject) |
| `GcpSecretManagerProvider` | `gcp`         | GCP Secret Manager                          | lazy `@google-cloud/secret-manager` (or inject)    |
| `AzureKeyVaultProvider`    | `azure`       | Azure Key Vault                             | lazy `@azure/keyvault-secrets` (or inject)         |
| `HashiCorpVaultProvider`   | `vault`       | HashiCorp Vault KV v2 over `fetch`          | none (zero-dependency, Workers-compatible)         |

No cloud SDK is a hard dependency: a provider either receives an injected client facade through
options, or lazily imports the SDK at `connect()` time (AI_GUIDELINES §12.2). Secrets are never
logged.

## Installation

```typescript
import { SecretsPlugin } from '@setu-ts/secrets-plugin';
```

Install the SDK only for the provider you choose (e.g.
`deno add npm:@aws-sdk/client-secrets-manager`). `env` and `vault` need nothing.

## Usage

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SecretsPlugin } from '@setu-ts/secrets-plugin';
import type { ISecretManager } from '@setu-ts/common';

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

## Environment secrets and `.env`

`EnvProvider` reads `IRuntimeServices.env` first, then falls back to `CAPABILITIES.CONFIG` when
registered and the environment has no string value for the key. Its key mapping prepends
`options.prefix` (default `''`), uppercases, then replaces `/`, `-`, and `.` with `_`:
`database/password` with prefix `APP_` reads `APP_DATABASE_PASSWORD` from either source. Only string
config values are accepted; numbers, booleans and objects are treated as missing, without coercion.
Environment strings, including empty strings and `${NAME}` references, are returned unchanged.

Register `ConfigPlugin({ envFilePath: '.env' })` to make `.env`-only secrets available. The optional
CONFIG dependency orders its provider before secrets regardless of their order in the plugin list,
including replacement CONFIG providers. The fallback defaults to `true`; opt out with
`SecretsPlugin({ options: { configFallback: false } })`. A non-boolean `options.configFallback`
throws at plugin construction for the env provider; other providers ignore it. With no CONFIG
capability, reads silently use the environment only.

Config values retain ConfigPlugin's loading rules:

- A validation schema must declare the secret key (or pass unknown keys through); an undeclared key
  stripped by a schema is unavailable and `secrets.get()` throws "Secret not found".
- `${NAME}` references in `.env`-only secrets are expanded by default. For literal references in
  secrets containing `$`, use `ConfigPlugin({ expandVariables: false })` or supply the secret in the
  real environment. The environment path always returns its string unchanged.

The fallback also applies to `SessionPlugin`'s `SESSION_SECRET` and full-stack starter apps, which
always compose `SecretsPlugin`. A consequence to check: `SessionPlugin` used to refuse to start when
no `SESSION_SECRET` existed outside a dotenv file; a dotenv file present at runtime now satisfies
that check. If a deployment relied on the refusal, keep dotenv files out of production or set
`configFallback: false`. Found values use the normal `options.cacheTtl` read cache; missing values
are never cached. `EnvProvider` remains read-only and its health is lifecycle-only.

Dotenv files are for local development only. In production, inject variables through the
orchestrator or secret store; see
[Dotenv files never reach an image](https://github.com/setu-ts/setu-ts/blob/main/docs/deployment.md#dotenv-files-never-reach-an-image).
For local development, loading the process environment directly is an optional alternative to
ConfigPlugin's fallback:

```bash
# Node: tsx passes these Node flags through.
npx tsx --env-file=.env main.ts
# Skip an absent file instead:
npx tsx --env-file-if-exists=.env main.ts
# Deno: load it before the runtime reads the environment.
deno run --allow-env --allow-read --allow-net --env-file=.env main.ts
# Bun loads .env into the process environment automatically.
bun run main.ts
```

Keep `.env` and local secret files out of version control.

Workers have no ambient process environment: only string entries of the `env` record passed to
`RuntimePlugin({ env })` reach `runtime.env`; without it the map is empty. Pass the platform's
bindings record so deployed secrets and local development bindings reach `EnvProvider`. Provisioning
a secret alone does not pass that record to the runtime:

```typescript
import { env } from 'cloudflare:workers';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SecretsPlugin } from '@setu-ts/secrets-plugin';

const app = createApplication({ plugins: [RuntimePlugin({ env }), SecretsPlugin()] });
await app.start();
export default { fetch: (request: Request): Promise<Response> => app.fetch(request) };
```

On Workers, ConfigPlugin normally sees the same string bindings as the environment, so the fallback
adds no keys; `envFilePath` requires filesystem support and cannot load files there. An injected
`ConfigPlugin({ instance })` or another `IConfig` provider can supply additional keys, including the
snapshot used by `createFullStackAppFromConfig`.

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

Every Vault request is bounded by `options.requestTimeoutMs` (default `5000`, `0` disables). A
request that fails on the network or does not answer in time — the response body included, so a
server that sends headers and then stalls counts as not answering — rejects with
`SecretProviderUnavailableError`, which carries a `503 Service Unavailable` status hint, so an
application running `errorHandler` answers an outage with a retryable `503` instead of a masked
`500`. The transport error is kept as `cause` for the log and never reaches the response body. A
Vault that answers with an HTTP error or a body that is not JSON is reachable, so it keeps the
existing handling (a plain `Error`; an unparseable body is one too): `404` reads as `null`, any
other error status rejects with a plain `Error`. A value outside `0`–`2147483647` is refused with a
`RangeError` when the application starts.

**Since M101a** a secret name is checked and encoded before it reaches the URL. Each `/`-separated
segment is percent-encoded, so `app db/pass` is read from `app%20db/pass`, and a name with an empty,
`.` or `..` segment (`../../sys/health`, `a//b`, `a/`) is refused before any request is sent: it
would otherwise address a Vault endpoint outside the mount with the token attached. A name longer
than 4096 characters once encoded is refused the same way, as an input error rather than an outage.
A read whose response body exceeds 1 MiB is refused with a plain `Error` and the rest of the body is
cancelled; the body is copied into one buffer as it arrives, so the memory a read holds is bounded
by that 1 MiB whatever size of chunk the dependency sends. A name quoted in an error message has its
C0 and C1 control characters, DEL, and the Unicode line and paragraph separators written as
`\uXXXX`, so a name cannot start a new log line, and only its first 256 characters are quoted.

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
import { SecretsPlugin } from '@setu-ts/secrets-plugin';

// Your own fetchers, shaped to the facade the plugin expects.
const myGet = (id: string): Promise<string | null> => Promise.resolve(null);
const myPut = (id: string, value: string): Promise<void> => Promise.resolve();

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

| Option                                               | Provider                | Description                                                                                                                      |
| ---------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `provider`                                           | —                       | `'env'` (default), `'aws-kms'`, `'gcp'`, `'azure'`, `'vault'`.                                                                   |
| `options.cacheTtl`                                   | all                     | Read-cache TTL in seconds; `0` disables. Default `300`.                                                                          |
| `options.prefix`                                     | `env`                   | Prefix prepended to the derived env key.                                                                                         |
| `options.region` / `accessKeyId` / `secretAccessKey` | `aws-kms`               | AWS client config (ignored when `client` injected).                                                                              |
| `options.endpoint`                                   | `aws-kms`               | LocalStack / emulator / private endpoint for the lazy client (ignored when `client` injected).                                   |
| `options.projectId`                                  | `gcp`                   | GCP project id for resource paths.                                                                                               |
| `options.endpoint`                                   | `gcp`                   | Private/regional endpoint for the lazy client as `host` or `host:port`, no scheme; TLS only (ignored when `client` injected).    |
| `options.vaultUrl`                                   | `azure`                 | Key Vault URL.                                                                                                                   |
| `options.address` / `token` / `mount`                | `vault`                 | Vault server address, token, and KV mount.                                                                                       |
| `options.client`                                     | `aws-kms`/`gcp`/`azure` | Injected client facade (bypasses lazy import).                                                                                   |
| `options.http`                                       | `vault`                 | Injected `fetch`-shaped function (defaults to global `fetch`).                                                                   |
| `options.requestTimeoutMs`                           | `vault`                 | Bound on one Vault request in ms; `0` disables. Default `5000`. An outage rejects with `SecretProviderUnavailableError` (`503`). |

## API

- `SecretsPlugin(options?)` — plugin factory.
- `SecretsService` — the `ISecretManager` implementation (provider + read cache).
- `EnvProvider`, `AwsKmsProvider`, `GcpSecretManagerProvider`, `AzureKeyVaultProvider`,
  `HashiCorpVaultProvider` — provider classes.
- `ReadOnlySecretProviderError` — the read-only refusal, answered `501`.
- `SecretProviderUnavailableError` — a provider that cannot be reached, answered `503`.
- `IAwsSecretsClient`, `IGcpSecretsClient`, `IAzureSecretsClient`, `IVaultHttp` — structural
  injection types.

`EnvProvider` is read-only: `rotate()` (and provider `set`) rejects with
`ReadOnlySecretProviderError`, because environment variables cannot be mutated at runtime. The error
is branded `501 Not Implemented` (X20-2): nothing is wrong with the caller — the configured provider
cannot store or rotate secrets, permanently — so an application running `errorHandler` answers the
write attempt with a `501` in its configured format instead of a masked `500`. Both public write
paths inherit the refusal from the one `set` throw site, because `SecretsService.rotate()` delegates
to `provider.set()`.

### What `set()` means per provider

`ISecretManager` exposes one write method — `rotate()`, which delegates to the provider's `set()` —
but the method means a different thing on every provider. A bootstrap that reads a secret, finds it
absent, and writes a default works on some providers and fails on others, and the failure names _not
found_ — which reads as a problem with the secret being written rather than with the API being used.
The divergence is documented here rather than removed: making `set()` mean one thing is the
ROADMAP's X20-3, a contract question deliberately ungrouped from this one.

| Provider        | `set()` on an existing secret | `set()` on a name that does not exist                                                               | Verified against a real backend                        |
| --------------- | ----------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `env`           | rejects                       | rejects                                                                                             | yes — `readonly-status.test.ts` pins the `501` refusal |
| `vault` (KV v2) | writes a new version          | **creates** the secret                                                                              | yes — real HashiCorp Vault (X20)                       |
| `aws-kms`       | writes a new version          | **refuses** — `PutSecretValueCommand` requires the secret to exist; the provider has no create path | yes — real LocalStack (X20 addendum)                   |
| `gcp`           | adds a new version            | **refuses** — `addSecretVersion` requires the secret container to pre-exist                         | no — no local emulator; stated, not claimed            |
| `azure`         | writes a new version          | **creates** the secret                                                                              | no — no local emulator; stated, not claimed            |

The second column is the finding: an application that assumes `set()` creates is correct for `vault`
and `azure`, and wrong for `aws-kms` and `gcp`. On those two, create the secret out of band (or
through the provider's own client facade, which bypasses the plugin's write path) before the first
`set()`.

## Exports

| Export                            | Kind      |
| --------------------------------- | --------- |
| `SecretsPlugin`                   | function  |
| `AwsKmsProvider`                  | class     |
| `AzureKeyVaultProvider`           | class     |
| `EnvProvider`                     | class     |
| `GcpSecretManagerProvider`        | class     |
| `HashiCorpVaultProvider`          | class     |
| `ReadOnlySecretProviderError`     | class     |
| `SecretProviderUnavailableError`  | class     |
| `SecretsService`                  | class     |
| `AwsKmsProviderOptions`           | interface |
| `AzureKeyVaultProviderOptions`    | interface |
| `GcpSecretManagerProviderOptions` | interface |
| `HashiCorpVaultProviderOptions`   | interface |
| `IAwsSecretsClient`               | interface |
| `IAzureSecretsClient`             | interface |
| `IGcpSecretsClient`               | interface |
| `ISecretManager`                  | interface |
| `SecretsPluginOptions`            | interface |
| `SecretsProviderOptions`          | interface |
| `SecretsServiceOptions`           | interface |
| `IVaultHttp`                      | type      |
| `SecretsProviderType`             | type      |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#secretsplugin-setu-tssecrets-plugin).
