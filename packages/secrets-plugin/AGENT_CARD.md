# @setu-ts/secrets-plugin — retrieve secrets without exposing values

**Add it:** `setu add secrets` adds it and inserts `SecretsPlugin()` into a recognized functional
`setu.config.ts`. It provides `CAPABILITIES.SECRETS` (`ISecretManager`), using environment variables
by default.

## Retrieve a secret inside a handler

Use the value only in the operation needing it; do not put it in a response or log:

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { ISecretManager } from '@setu-ts/common';

const secrets = ctx.services.get<ISecretManager>(CAPABILITIES.SECRETS);
const password = await secrets.get('database/password');
```

## Configure the environment naming convention

Put this plugin in the config's plugins array instead of the generated default:

```ts
import { SecretsPlugin } from '@setu-ts/secrets-plugin';

export const secrets = SecretsPlugin({
  provider: 'env',
  options: { prefix: 'APP_', cacheTtl: 60 },
});
```

## Behaviour the types do not show

- Environment names are uppercased and `/`, `-` and `.` become `_`; the configured prefix is
  prepended first. The example reads database/password from APP_DATABASE_PASSWORD.
- `get` rejects when absent; `has` returns false. Both successful reads populate the cache.
- `options.cacheTtl` is seconds, defaults to 300, and `0` disables the read cache.
- `rotate` writes through the provider and refreshes the cache. The environment provider refuses
  writes with `ReadOnlySecretProviderError` carrying a 501 hint.
- Plugin registration logs provider metadata, never secret values.

## Other options

- `provider` also selects `'aws-kms'`, `'gcp'`, `'azure'` or `'vault'`; cloud providers lazy-load
  SDKs.
- Cloud `options.client` injects the provider's facade and bypasses its SDK import.
- Vault stores the KV v2 `value` field; `requestTimeoutMs` defaults to 5000 milliseconds.
- `rotate` can create missing Vault and Azure names; AWS and GCP names must already exist.
