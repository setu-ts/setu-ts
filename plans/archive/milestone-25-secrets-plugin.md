# Milestone 25 — Secrets Plugin (`@hono-enterprise/secrets-plugin`)

> **Status:** Planning. Branch: `feat/25-secrets-plugin`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Provide secret management as a plugin: a single `ISecretManager` (committed in `common`) registered
under `CAPABILITIES.SECRETS`, backed by a pluggable provider. The service adds a monotonic-clock
in-memory read cache in front of the provider; each provider is an internal `SecretProvider` port
adapter. Providers cover environment variables (default, zero-dependency, Workers/Deno/Bun/Node) and
four external backends (AWS, GCP, Azure, HashiCorp Vault). Every external client is injected through
plugin options, else lazily loaded per AI_GUIDELINES §12.2 — no heavy SDK is a hard dependency.
`EnvProvider` reads env through `IRuntimeServices.env`, never `process.env`, so it resolves Workers
and Deno bindings too.

- **In scope:** `SecretsPlugin` factory; `SecretsService` (get/has/rotate + read cache); five
  providers (`EnvProvider`, `AwsKmsProvider`, `GcpSecretManagerProvider`, `AzureKeyVaultProvider`,
  `HashiCorpVaultProvider`); structural client interfaces for injection; health indicator; README;
  PUBLIC_API.md + ROADMAP + CLAUDE.md updates.
- **NOT this milestone:** audit logging of secret access (Milestone 26, `audit-plugin`); logger
  redaction of secret fields (owned by `logger-plugin`, M4 — already ships; this plugin never logs a
  secret value); a KMS envelope-encryption primitive for arbitrary payloads (out of scope, see §9);
  automatic scheduled rotation (Milestone 18 `scheduler-plugin` orchestrates; this plugin exposes
  `rotate()` only).

## 1. Contracts verified from SOURCE (not names)

| Reference                 | Source (file:line)                                                    | Verified surface / fact                                                                                                                                                                                          |
| ------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ISecretManager`          | `packages/common/src/services/secrets.ts:22-45`                       | Exactly three async methods: `get(name: string): Promise<string>` (throws when missing/denied), `has(name: string): Promise<boolean>`, `rotate(name: string, value: string): Promise<void>`. No `list`/`delete`. |
| `CAPABILITIES.SECRETS`    | `packages/common/src/tokens.ts:73`                                    | Value is the literal `'secrets'` (lowercase, no namespace). One provider only — the resolver throws on duplicate capability providers.                                                                           |
| `ISecretManager` export   | `packages/common/src/index.ts:150`                                    | Re-exported as a type from `common`; the plugin re-exports it from its own `index.ts` (mirrors cache re-exporting `ICacheStore`).                                                                                |
| `IPluginContext`          | `packages/common/src/plugin.ts:409-448`                               | `services`, `health`, `lifecycle`, and non-optional `runtime` are present; `logger`/`config` are optional. Used for `services.register`, `health.register`, `lifecycle.onClose`, `runtime`.                      |
| `IRuntimeServices.env`    | `packages/common/src/runtime.ts:184-185`                              | `readonly env: Readonly<Record<string, string \| undefined>>` — the only sanctioned env source. It is read-only, so `EnvProvider.set` cannot mutate it (drives the §3.5 tested throw).                           |
| `IRuntimeServices.hrtime` | `packages/common/src/runtime.ts` (RUNTIME token)                      | Monotonic ms reading; used for cache-entry expiry so no wall-clock is mixed (CLAUDE.md clock rule). Resolved via `CAPABILITIES.RUNTIME` exactly as `cache-plugin` `resolveClock` does.                           |
| Plugin/provider pattern   | `packages/cache-plugin/src/stores/redis-store.ts`                     | Inject-or-lazy precedent: prefer `options.client` (structurally validated), else `await import('npm:…')`. `constructor → connect()` split; `register()` may be async. Mirrored per provider.                     |
| Guarded real-import       | `packages/messaging-plugin/test/unit/rabbitmq-broker.test.ts:226-231` | The lazy `await import('npm:…')` path is covered by a guarded test that enters the loader; branch logic around it is unit-tested via injected fakes.                                                             |
| Plan-lint canonical root  | `scripts/plan-lint.ts:41`                                             | `milestone-\d+-[a-z0-9.-]+\.md` is permitted at `plans/` root; this file's name conforms.                                                                                                                        |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                          | Resolution (picked side)                                                                                                                                                                                                                                                                                                                            | Doc deliverable (same PR)                                                                                                    |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| C1 | ROADMAP §M25 names the provider `AwsKmsProvider` with id `'aws-kms'`, but AWS KMS (`@aws-sdk/client-kms`) only encrypts/decrypts — it cannot store/retrieve a named secret by path, which `get`/`rotate` require. | Keep the committed public names `AwsKmsProvider` / `'aws-kms'` (ROADMAP is the committed registration surface). Back them with AWS Secrets Manager (`@aws-sdk/client-secrets-manager`), which stores KMS-encrypted named secrets — "KMS" denotes the KMS-backed encryption. A structural `IAwsSecretsClient` is injected; the SDK is lazily loaded. | Add a clarifying sentence to ROADMAP §M25 and a PUBLIC_API.md row noting `aws-kms` retrieves via KMS-backed Secrets Manager. |
| C2 | ROADMAP §M25 shows `provider: 'aws-kms'` in its example but AI_GUIDELINES §13.4 mandates the most-secure/zero-friction default, and `common` docs call env "environment variables in development".                | Default `provider` is `'env'` (zero-dependency, no cloud credentials, works on every runtime). The ROADMAP example stays valid as an explicit opt-in; the default is documented as `'env'`.                                                                                                                                                         | PUBLIC_API.md notes the default provider is `'env'`.                                                                         |

## 3. Design decisions

### 3.1 Service ↔ provider seam (internal port)

- **Decision:** An internal `SecretProvider` port — `get(name: string): Promise<string | null>`
  (`null` = absent) and `set(name: string, value: string): Promise<void>` — declared in
  `src/interfaces/index.ts` and **NOT** exported from `src/index.ts`. `SecretsService` composes one
  provider; the committed `ISecretManager.get` throw-on-missing semantics live in the service, not
  the provider, so providers return `null` uniformly and the service converts `null → throw`.
- **Why:** `ISecretManager` is lifecycle-thin (get/has/rotate) and has no notion of "absent vs
  present"; a `string | null` provider port makes `has` cheap and keeps the throw contract in one
  place (Interface Segregation; mirrors `CacheStore` sitting behind `CacheService`).
- **Test home:** `secrets-service.test.ts` drives get/has/rotate against a fake provider.

### 3.2 Read cache

- **Decision:** `SecretsService` holds an in-memory
  `Map<string, { value: string; expiresAt: number
  }>`. `get`/`has` populate it; `rotate`
  overwrites the entry with the new value. TTL comes from `cacheTtl` (seconds);
  `expiresAt = clock() + cacheTtl*1000` using the injected monotonic `clock` (`runtime.hrtime`).
  `cacheTtl` of `0` disables caching (every read hits the provider). A stale entry
  (`clock() >= expiresAt`) is treated as a miss and re-fetched.
- **Why:** Cloud secret reads are latency-heavy; the ROADMAP test list explicitly names "Caching".
  Monotonic clock avoids the epoch-vs-monotonic mixing bug called out in CLAUDE.md.
- **Test home:** `secrets-service.test.ts` — cache hit avoids a second provider call; expiry
  re-fetches (fake clock advanced past TTL); `rotate` updates the cached value.

### 3.3 Provider client resolution (inject-or-lazy)

- **Decision:** Each cloud provider (`aws-kms`, `gcp`, `azure`) prefers a structurally-validated
  injected `options.client`; absent one, it lazily `await import('npm:<sdk>')` inside `connect()`
  and adapts the SDK to the provider's structural client interface. `HashiCorpVaultProvider` uses
  the web-standard global `fetch` against Vault's HTTP API (no SDK), with an injectable `fetch` for
  tests. Validation rejects a malformed injected client with a clear error (mirrors `redis-store.ts`
  `validateClient`).
- **Why:** AI_GUIDELINES §12.2/§14.4 — heavy SDKs are never hard deps; §4 runtime independence —
  Vault-over-`fetch` is Workers-compatible with zero deps.
- **Test home:** each provider test injects a fake client/fetch (branch coverage); a guarded
  real-import/real-HTTP test enters the lazy path.

### 3.4 Provider selection & naming

- **Decision:** `provider` is a closed union `'env' | 'aws-kms' | 'gcp' | 'azure' | 'vault'`
  (default `'env'`). A `createProvider(type, options, runtime)` factory maps each id to its class;
  an unknown id throws at registration. `EnvProvider` is the `default` branch.
- **Why:** closed union + factory keeps the seam single (no per-call branching), and the default is
  the secure zero-dep choice (§13.4, conflict C2).
- **Test home:** `secrets-plugin.test.ts` asserts each id builds the right provider and an unknown
  id throws.

### 3.5 `EnvProvider` semantics

- **Decision:** `get(name)` maps a secret path to an env key: apply optional `prefix`, uppercase,
  and replace `/` and `-` with `_` (e.g. `database/password` with prefix `APP_` →
  `APP_DATABASE_PASSWORD`), then read `runtime.env[key] ?? null`. `set(name, value)` throws
  `Error('EnvProvider is read-only; environment secrets cannot be rotated at runtime')` — a
  documented, tested throw, because `runtime.env` is `Readonly` (§1). This is the planned behavior
  for an interface method an implementation cannot support.
- **Why:** env is immutable at runtime across every target; a silent no-op rotate would be a lie.
- **Test home:** `env-provider.test.ts` — name→key mapping (with/without prefix), present/absent
  read, and `set` throws.

### 3.6 Health & lifecycle

- **Decision:** `register()` builds the provider, calls `provider.connect()`, registers the service
  under `CAPABILITIES.SECRETS`, registers a health indicator `secrets` reporting
  `provider.isReady()`, and an `onClose` hook calling `provider.disconnect()`. Providers with no
  connection (`EnvProvider`) implement `connect`/`disconnect` as no-ops and `isReady() → true`.
- **Why:** mirrors `cache-plugin` register wiring; graceful shutdown is mandatory (§14.5).
- **Test home:** `secrets-integration.test.ts` — a real kernel app resolves `ISecretManager`, reads
  a secret back through the public surface, and the health indicator reports `up`.

## 4. Exported surface — every symbol names its consumer

| Exported symbol            | Kind    | Consumer / real code path that READS it                                                                     |
| -------------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `SecretsPlugin`            | factory | Application `app.register(SecretsPlugin(...))`; integration test drives it through a kernel app.            |
| `SecretsService`           | class   | Registered under `CAPABILITIES.SECRETS`; resolved by apps as `ISecretManager`. Exported for replaceability. |
| `EnvProvider`              | class   | Built by `createProvider('env')`; exported so apps can inject a custom provider instance.                   |
| `AwsKmsProvider`           | class   | Built by `createProvider('aws-kms')`; exported for direct construction/injection.                           |
| `GcpSecretManagerProvider` | class   | Built by `createProvider('gcp')`; exported for direct construction/injection.                               |
| `AzureKeyVaultProvider`    | class   | Built by `createProvider('azure')`; exported for direct construction/injection.                             |
| `HashiCorpVaultProvider`   | class   | Built by `createProvider('vault')`; exported for direct construction/injection.                             |
| `SecretsPluginOptions`     | type    | Parameter of `SecretsPlugin`; read by apps configuring the plugin.                                          |
| `SecretsProviderType`      | type    | The `provider` field union; read by apps selecting a backend.                                               |
| `SecretsProviderOptions`   | type    | The `options` field; read by `createProvider` and each provider constructor.                                |
| `IAwsSecretsClient`        | type    | Structural shape validated/consumed by `AwsKmsProvider`; the type of `options.client` for aws.              |
| `IGcpSecretsClient`        | type    | Structural shape consumed by `GcpSecretManagerProvider`.                                                    |
| `IAzureSecretsClient`      | type    | Structural shape consumed by `AzureKeyVaultProvider`.                                                       |
| `IVaultHttp`               | type    | Injectable `fetch`-shaped function consumed by `HashiCorpVaultProvider`.                                    |
| `ISecretManager`           | type    | Re-exported from `common`; the interface apps type their resolved service as.                               |

### 4.1 Options — every option names its consumer

| Option                                                | Consumer                   | Behavior (per implementation)                                                                         |
| ----------------------------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `provider`                                            | `createProvider` in plugin | Selects the backend class; default `'env'`.                                                           |
| `options.cacheTtl`                                    | `SecretsService`           | Read-cache TTL in seconds; `0` disables caching. Default `300`.                                       |
| `options.prefix`                                      | `EnvProvider`              | Prepended to the derived env key. Env only; ignored by other providers (they do not receive it).      |
| `options.region`                                      | `AwsKmsProvider`           | Passed to the lazily-loaded `SecretsManagerClient` config (ignored when `client` injected).           |
| `options.accessKeyId` / `options.secretAccessKey`     | `AwsKmsProvider`           | AWS credentials for the lazy client (ignored when `client` injected).                                 |
| `options.projectId`                                   | `GcpSecretManagerProvider` | GCP project for `accessSecretVersion` resource paths.                                                 |
| `options.vaultUrl`                                    | `AzureKeyVaultProvider`    | Key Vault URL for the lazy `SecretClient` (ignored when `client` injected).                           |
| `options.address` / `options.token` / `options.mount` | `HashiCorpVaultProvider`   | Vault server address, auth token, and KV mount (default `secret`) used to build request URLs/headers. |
| `options.client`                                      | aws/gcp/azure providers    | Injected structural client; bypasses the lazy import. Validated; a bad shape throws.                  |
| `options.http`                                        | `HashiCorpVaultProvider`   | Injected `fetch`-shaped function for tests; defaults to global `fetch`.                               |

## 5. Implementation files

| File                                  | Purpose                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/index.ts`                        | Barrel: plugin, service, five providers, option/client types, re-exported `ISecretManager`. |
| `src/plugin/secrets-plugin.ts`        | `SecretsPlugin` factory; `createProvider`; health + lifecycle wiring; logger/clock resolve. |
| `src/services/secrets-service.ts`     | `SecretsService implements ISecretManager` — get/has/rotate + monotonic read cache.         |
| `src/providers/env-provider.ts`       | `EnvProvider` over `runtime.env`; name→key mapping; read-only `set` throw.                  |
| `src/providers/aws-kms.ts`            | `AwsKmsProvider` + `validateAwsClient`; inject-or-lazy `@aws-sdk/client-secrets-manager`.   |
| `src/providers/gcp-secret-manager.ts` | `GcpSecretManagerProvider` + validate; inject-or-lazy `@google-cloud/secret-manager`.       |
| `src/providers/azure-key-vault.ts`    | `AzureKeyVaultProvider` + validate; inject-or-lazy `@azure/keyvault-secrets`.               |
| `src/providers/vault.ts`              | `HashiCorpVaultProvider` over injectable `fetch`; Vault KV v2 HTTP API.                     |
| `src/interfaces/index.ts`             | Internal `SecretProvider` port (not exported) + public option/client types.                 |
| `README.md`                           | Purpose, install, usage per provider, config options.                                       |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                      | src covered                       | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                           |
| ---------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/unit/secrets-service.test.ts`            | `services/secrets-service.ts`     | `get` returns value & caches; second `get` skips provider; expiry (fake clock) re-fetches; `get` throws on `null`; `has` true/false; `rotate(name,value)` calls `provider.set` & updates cache; `cacheTtl:0` disables cache. Calls type-check against `ISecretManager` + `SecretProvider`. |
| `test/unit/env-provider.test.ts`               | `providers/env-provider.ts`       | name→key mapping with/without `prefix`; present env → value; absent → `null`; `set` throws the documented read-only error.                                                                                                                                                                 |
| `test/unit/aws-kms.test.ts`                    | `providers/aws-kms.ts`            | `validateAwsClient` accepts/rejects shapes; `get` via fake client returns value / `null` on not-found; `set` calls `putSecretValue`; guarded real-import enters `await import('npm:@aws-sdk/client-secrets-manager')`.                                                                     |
| `test/unit/gcp-secret-manager.test.ts`         | `providers/gcp-secret-manager.ts` | fake client `accessSecretVersion`/`addSecretVersion` paths; not-found → `null`; guarded real-import.                                                                                                                                                                                       |
| `test/unit/azure-key-vault.test.ts`            | `providers/azure-key-vault.ts`    | fake client `getSecret`/`setSecret`; not-found → `null`; guarded real-import.                                                                                                                                                                                                              |
| `test/unit/vault.test.ts`                      | `providers/vault.ts`              | injected `fetch` fake: GET builds `/{address}/v1/{mount}/data/{name}` with `X-Vault-Token`; 404 → `null`; `set` POSTs; guarded real-HTTP test skipped without `RUN_INTEGRATION`.                                                                                                           |
| `test/unit/secrets-plugin.test.ts`             | `plugin/secrets-plugin.ts`        | each `provider` id builds the matching class; unknown id throws; default is `env`; health indicator + `onClose` registered; `cacheTtl` threaded to service.                                                                                                                                |
| `test/unit/barrel-exports.test.ts`             | `index.ts`                        | every documented symbol is exported and defined.                                                                                                                                                                                                                                           |
| `test/integration/secrets-integration.test.ts` | plugin + service + env provider   | real kernel app: register `SecretsPlugin`, resolve `ISecretManager`, `get` reads an env secret back through the public surface, `has` true/false, health `up`.                                                                                                                             |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/25-secrets-plugin, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # ANSI-stripped per-file table; >=90% branch/function/line every src file
```

## 8. Risks & mitigations

- Cloud SDK client shapes drift between versions → depend only on the two methods each provider
  calls via a narrow structural interface; validate injected clients; pin the lazy `npm:` specifier.
- Lazy-import branches are hard to cover deterministically → branch logic tested with injected
  fakes; only the single `await import(...)` I/O line sits behind a guarded test (per CLAUDE.md).
- Vault KV v1 vs v2 path differences → target KV v2 (`/data/` path) and document it; `mount` is
  configurable; v1 support is out of scope (§9).
- A secret value accidentally logged → the plugin logs only metadata (provider id, secret name),
  never values; asserted by grepping the debug-log call in the plugin test.

## 9. Out of scope

- KMS envelope encryption of arbitrary payloads (this plugin manages named secrets, not a crypto
  API).
- Vault KV v1, AppRole/Kubernetes auth methods (token auth only this milestone).
- Automatic/scheduled rotation — orchestrated by `scheduler-plugin` (M18); this plugin exposes
  `rotate()` only.
- Audit logging of secret access — `audit-plugin` (M26).
- Secret `list`/`delete` operations — not on the committed `ISecretManager` contract.
