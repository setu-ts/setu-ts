# @setu-ts/secrets-plugin — secrets behind `CAPABILITIES.SECRETS`

`setu add secrets` adds the dependency and inserts `SecretsPlugin()` — the zero-configuration `env`
provider, which reads the name `database/password` as the environment variable DATABASE_PASSWORD.
Values are cached 300 s and never logged.

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IRequestContext, ISecretManager } from '@setu-ts/common';

export async function readDbPassword(context: IRequestContext): Promise<string> {
  const secrets = context.services.get<ISecretManager>(CAPABILITIES.SECRETS);
  return await secrets.get('database/password');
}
```

HashiCorp Vault needs no SDK; the AWS, GCP and Azure providers lazy-load theirs, or take an injected
client:

```ts
import { SecretsPlugin } from '@setu-ts/secrets-plugin';

export const secrets = SecretsPlugin({
  provider: 'vault',
  options: {
    address: 'https://vault.example.com',
    token: process.env.VAULT_TOKEN ?? '',
    mount: 'secret',
  },
});
```

- `provider` is `'env'` (default), `'aws-kms'`, `'gcp'`, `'azure'` or `'vault'`. Every arm accepts
  `options.cacheTtl` in seconds (default `300`; `0` disables the read cache).
- The contract is `get`, `has` and `rotate`. `rotate` delegates to the provider's write; `env` is
  read-only and refuses with `ReadOnlySecretProviderError`, answered `501`.
- A Vault secret is the KV v2 item's `value` field. `requestTimeoutMs` defaults to `5000`; an
  unreachable or stalled Vault rejects with `SecretProviderUnavailableError` (a `503` hint).
- Cloud arms take an injected `options.client` facade, bypassing the lazy import: `aws-kms` also
  reads `region`, `accessKeyId`, `secretAccessKey`, `endpoint`; `gcp` reads `projectId` and
  `endpoint`; `azure` reads `vaultUrl`.
- Writing a name that does not exist creates it on `vault` and `azure`, and is refused on `aws-kms`
  and `gcp` — create those out of band first.
