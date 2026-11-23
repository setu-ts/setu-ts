# Milestone 143r — Provider arms and their options (Integrations lane)

> **Status:** Planning. Branch: `feat/m143r-provider-arms`. `develop` and `main` are protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Every storage, secrets, mail, flags and notification arm of the Integrations lane starts from its
documented options and passes upload, download, signed URL, rotation or send against a local
stand-in; an outage is an error a caller can act on, never "not there"; every call to a cloud
backend (AWS, Google, Azure, SendGrid) ends within a bound the application can set; GCS, Backblaze
and SES take an endpoint; and the option requests for the same packages are met. The boundary is the
lane: `storage-plugin`, `secrets-plugin`, `mail-plugin`, `notification-plugin`,
`feature-flags-plugin`, `localization-plugin`, plus two additive files in `common`. Everything is
proved on local stand-ins; no live cloud account exists, and no stand-in result is recorded as proof
of the live service.

- **In scope:** fifteen of the sixteen rows — V13-232, V13-233, V13-234, V13-235, V13-216, V13-217,
  V13-245, V13-248, V13-4, V13-119, V12-132, V13-193, V13-228, V13-255, V13-257; the lane halves of
  V13-215 (the SES probe the row names, and the storage `gcs`/`azure` and secrets
  `aws-kms`/`gcp`/`azure` probes its X123 widening names, which only this lane can edit) and of
  V13-58 (the brand that lets the OpenAPI generator see `createUploadMiddleware`).
- **NOT this milestone:** the SQS half of V13-215 and V13-216 (M143m, Messaging lane — it takes the
  option name and semantics of §3.1); the OpenAPI half of V13-58 (M143l, Web lane — it reads the
  brand of §3.15); the R2 not-found row of V13-217 (M143o, Workers lane — it may throw the
  `StorageObjectNotFoundError` of §3.2); the `IStorage.delete`/`exists` JSDoc wording in
  `common/src/services/storage.ts` (Core lane, M143i, or Docs, M143n — this lane may not edit an
  existing `common` file); **V13-131, first stopped and reported for the Core lane (M143i), then
  built here once M143i merged (§3.16):** an application resolves the pool as
  `CapabilityServices['worker-pool']` = `IWorkerPool` (`common/src/capability-services.ts:140`),
  whose `run` takes `WorkerRunOptions` (`common/src/services/worker-pool.ts:87-91`), so `{ signal }`
  cannot reach the pool without adding the field to that existing contract — a Core-lane change (the
  lane rule's "a change to an existing contract is made by the Core lane first"); once it lands, the
  worker-pool half (queued withdrawal, running termination, listener removal) is a follow-up in this
  lane; the `docs/health-indicators.md` rows (storage, SES, secrets) and `docs/pages.md:122` ("a
  wrong type with 400") — `docs/` belongs to the Docs lane (M143n), and M143m edits the same file
  for SQS; both corrections are handed over; wiring the new stand-ins into CI
  (`.github/workflows/ci.yml` and `scripts/local-ci.ts` belong to no lane).

## 1. Contracts verified from SOURCE (not names)

| Reference                                                           | Source (file:line)                                                                                                                                               | Verified surface / fact                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `withDeadline`, `deadlineRangeError`                                | `packages/common/src/health/deadline.ts:77,118`                                                                                                                  | `withDeadline(run(signal), { timeoutMs, onTimeout, timing? })`; `0` = unbounded; aborts the signal and rejects with `onTimeout()`'s error; `deadlineRangeError(name, ms)` → `RangeError` or `null`                                                                                                                                                                 |
| `resolveProbeTiming`                                                | used at `packages/secrets-plugin/src/plugin/secrets-plugin.ts` (`createProvider(..., timing)`)                                                                   | the timer surface a plugin hands a provider; Vault already takes it                                                                                                                                                                                                                                                                                                |
| `toBackendFault`, `BackendUnavailableError`, `…OutcomeUnknownError` | `packages/common/src/errors/backend-fault.ts:85,123,268`                                                                                                         | 503 "not applied" / 504 "may have been applied", fixed `detail`, driver error as `cause`; `toBackendFault` returns `undefined` for an unrecognised shape                                                                                                                                                                                                           |
| `isConnectionFault`                                                 | `packages/common/src/errors/connection-fault.ts`                                                                                                                 | cause-chain walk (5 deep) over eight node codes plus Redis shapes                                                                                                                                                                                                                                                                                                  |
| `withHttpStatusHint`, `httpStatusHintOf`                            | `packages/common/src/errors/status-hint.ts`                                                                                                                      | symbol brand read by `errorHandler`; `detail` required                                                                                                                                                                                                                                                                                                             |
| `SecretProviderUnavailableError`                                    | `packages/secrets-plugin/src/errors.ts`                                                                                                                          | `(provider, cause)`, 503 hint, detail "The secrets provider is temporarily unreachable."; used by Vault only                                                                                                                                                                                                                                                       |
| Vault `requestTimeoutMs` (default 5000)                             | `packages/secrets-plugin/src/providers/vault.ts:18,71,221,343-376`                                                                                               | the precedent this plan copies: one bound per request via `withDeadline`, expiry and transport failure → `SecretProviderUnavailableError`                                                                                                                                                                                                                          |
| `SecretsProviderOptions.requestTimeoutMs`                           | `packages/secrets-plugin/src/interfaces/index.ts:132-198`                                                                                                        | flat option bag shared by every arm; today read by `vault` only                                                                                                                                                                                                                                                                                                    |
| `MailProviderOptions.endpoint`                                      | `packages/mail-plugin/src/interfaces/index.ts:189-229`                                                                                                           | flat bag; `endpoint` exists (SendGrid); SES reads only region/keys/client                                                                                                                                                                                                                                                                                          |
| `IStorage`                                                          | `packages/common/src/services/storage.ts:70-116`                                                                                                                 | `get` throws when absent; `delete` "`true` if an object was deleted"; `exists` "`true` if present"; `getStream?` throws when absent                                                                                                                                                                                                                                |
| `StorageService` not-found                                          | `packages/storage-plugin/src/services/storage-service.ts:303,316,345`                                                                                            | `new Error('Storage object not found: …')`, no class, no hint                                                                                                                                                                                                                                                                                                      |
| GCS adapter                                                         | `packages/storage-plugin/src/providers/gcs-provider.ts:131-226,392-431,457-488`                                                                                  | `new Storage({ projectId })` only; `delete`/`exists` bare `catch { return false }`; `expires` in epoch SECONDS; `getStream` returns `createReadStream()` at once                                                                                                                                                                                                   |
| Azure adapter                                                       | `packages/storage-plugin/src/providers/azure-provider.ts:203-220,267-306,373`                                                                                    | `new BlobServiceClient(connectionString)`; fixed `https://<acct>.blob.core.windows.net`; hand-built SAS URL, name unencoded; injected client spread `{ ...injected, canSign: true }`; facade `delete` swallows all                                                                                                                                                 |
| S3 adapter                                                          | `packages/storage-plugin/src/providers/s3-provider.ts:103-119,168-183,328-338`                                                                                   | `delete`/`head` bare catch → `false`; `isHealthy` = `head('')`, catch → `false`                                                                                                                                                                                                                                                                                    |
| B2 preset                                                           | `packages/storage-plugin/src/plugin/storage-plugin.ts:84-97`                                                                                                     | `region ?? 'us-east-1'` → `https://s3.us-east-1.backblazeb2.com` (not a Backblaze host)                                                                                                                                                                                                                                                                            |
| Storage indicator                                                   | `packages/storage-plugin/src/plugin/storage-plugin.ts:199-212`                                                                                                   | `isHealthy` absent → `up`/`reachable: 'unknown'`; GCS/Azure lazy adapters never install one                                                                                                                                                                                                                                                                        |
| Upload middleware                                                   | `packages/storage-plugin/src/middleware/upload-middleware.ts:213-219`                                                                                            | disallowed MIME → `400 Invalid MIME type`; the returned middleware carries no brand                                                                                                                                                                                                                                                                                |
| `FORM_FILE_METADATA` pattern                                        | `packages/common/src/form/form-file-metadata.ts`                                                                                                                 | `Symbol.for` brand, `withX(target, meta)` defines a non-enumerable property, `xOf(value)` validates and treats foreign values as absent — §3.15 copies it                                                                                                                                                                                                          |
| `WorkerRunOptions`, `IWorkerPool.run`, `CapabilityServices`         | `packages/common/src/services/worker-pool.ts:16-27,87-91`; `capability-services.ts:140`                                                                          | only `timeoutMs`; the `worker-pool` token is typed `IWorkerPool`, so V13-131 needs a Core-lane contract change (§0)                                                                                                                                                                                                                                                |
| Storage option interfaces                                           | `packages/storage-plugin/src/interfaces/index.ts:159,181,191` and `providers/s3-provider.ts:51`, `gcs-provider.ts:86`, `azure-provider.ts:108`                   | each provider option type is declared twice (the barrel exports the `interfaces/` copy); every new field goes into both, and a type test asserts the two stay assignable both ways                                                                                                                                                                                 |
| GCS custom endpoint and auth                                        | `@google-cloud+storage@7.22.0/.../build/cjs/src/storage.js:468-474`; `build/cjs/src/nodejs-common/util.js:494-495`                                               | `apiEndpoint` sets `customEndpoint = true`, which skips auth unless `useAuthWithCustomEndpoint`; `STORAGE_EMULATOR_HOST` overrides the base URL even with `apiEndpoint` set                                                                                                                                                                                        |
| LaunchDarkly start                                                  | `packages/feature-flags-plugin/src/providers/launchdarkly-provider.ts:207-209`; `launchdarkly-module.ts:69`                                                      | passes `{ timeoutSeconds }`; facade types `waitForInitialization(options?: { timeoutSeconds?: number })`                                                                                                                                                                                                                                                           |
| `LDWaitForInitializationOptions`                                    | `node_modules/.pnpm/@launchdarkly+js-server-sdk-common@2.26.5/.../dist/index.d.ts:2123-2137`                                                                     | the field is `timeout` (seconds); no options → waits forever                                                                                                                                                                                                                                                                                                       |
| Slack channel                                                       | `packages/notification-plugin/src/channels/slack-channel.ts:31-42`                                                                                               | posts `{ text: body, channel? }`; `subject` never read                                                                                                                                                                                                                                                                                                             |
| SMTP mapping                                                        | `packages/mail-plugin/src/providers/smtp-provider.ts:86-98,126-134`                                                                                              | transport config = port/secure/host/auth; attachment passes `cid` only                                                                                                                                                                                                                                                                                             |
| nodemailer 10.6.0                                                   | `node_modules/.pnpm/nodemailer@10.6.0/.../dist/cjs/mail-composer/index.js:171`, `smtp-connection/index.js:140-150,260-264`, `shared/index.js:61,205`             | `contentDisposition` honoured, default `inline` only for an image with `cid`; `connectionTimeout`/`greetingTimeout`/`socketTimeout`/`dnsTimeout` honoured; a 5-minute DNS cache whose `dnsTtl` the SMTP connection never passes                                                                                                                                    |
| `@google-cloud/storage` 7.22.0 / 8.4.0 / 9.0.0                      | measured (§3.4, 8.4.0 and 9.0.0 in a scratch install); installed 7.22.0 `build/cjs/src/storage.d.ts:36,52`                                                       | `StorageOptions.apiEndpoint`, `retryOptions.autoRetry`; `bucket.exists()`, `file.getSignedUrl({ expires })` reads a number as ms                                                                                                                                                                                                                                   |
| `@azure/storage-blob` 12.34.0                                       | `dist/esm/BlobServiceClient.d.ts:209`, `Clients.d.ts:881,1160`, `ContainerClient.d.ts:527`, `sas/BlobSASPermissions.d.ts:17`                                     | `BlobServiceClient.fromConnectionString`, `BlobClient.generateSasUrl({ permissions, expiresOn })` (throws `RangeError` without a shared-key credential), `exists()`, `BlobSASPermissions.parse('r')`, `abortSignal?: AbortSignalLike` on each operation's options (`Clients.d.ts:60,117` — `BlobDownloadOptions`, `BlobExistsOptions`; likewise delete and upload) |
| `@azure/keyvault-secrets` 4.12.0                                    | `dist/esm/secretsModels.d.ts:20`, `index.d.ts:374`                                                                                                               | `SecretClientOptions.disableChallengeResourceVerification`; `listPropertiesOfSecrets().byPage({ maxPageSize })`                                                                                                                                                                                                                                                    |
| `@google-cloud/secret-manager` 5.6.0                                | `build/src/v1/secret_manager_service_client.d.ts:335,586`                                                                                                        | `accessSecretVersion(request, options?: CallOptions)`, `listSecrets(request, options?)`; `CallOptions.timeout`                                                                                                                                                                                                                                                     |
| AWS SDK v3 3.1169.0                                                 | `@smithy/types@4.20.0/dist-types/http.d.ts:104`; `client-sesv2/dist-types/commands/GetAccountCommand.d.ts`; `client-secrets-manager/.../ListSecretsCommand.d.ts` | `client.send(command, { abortSignal })`; `GetAccountCommand`, `ListSecretsCommand({ MaxResults })` exist                                                                                                                                                                                                                                                           |
| Localization catalogue body                                         | `packages/localization-plugin/src/routes/catalogue-route.ts:115-157`; `common/src/services/localization.ts:58`                                                   | flat `Record<key, message>`; bodies built once at register                                                                                                                                                                                                                                                                                                         |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                    | Resolution (picked side)                                                                  | Doc deliverable (same PR)                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| C1  | `gcs-provider.ts:260` and `azure-provider.ts:342` say the real adapter probes; `docs/health-indicators.md` row 3 says storage probes exist  | the code changes to match (§3.9)                                                          | the two comments rewritten; the `docs/health-indicators.md` rows handed to M143n (§0) |
| C2  | `gcs-provider.ts:427` comment "expires is epoch-seconds"                                                                                    | the SDK is right (ms)                                                                     | the comment deleted with the fix                                                      |
| C3  | storage README says only `bucket` is required for `'b2'`                                                                                    | `b2` needs `region` or `endpoint` (§3.7)                                                  | README options table and PUBLIC_API.md                                                |
| C4  | secrets README names only `@azure/keyvault-secrets` and shows `deno add`; its "What `set()` means" table says gcp/azure "no local emulator" | the code: `@azure/identity` is required; the package set is npm-first; X123 ran both arms | secrets README install block, peer list and `set()` table                             |
| C5  | feature-flags README says npm installs the LaunchDarkly SDK alongside                                                                       | it is an optional peer                                                                    | feature-flags README sentence                                                         |
| C6  | storage README, agent card and `docs/pages.md:122` document `400` for a disallowed type                                                     | `415` (§3.14)                                                                             | README, agent card, PUBLIC_API.md, upgrade note; `docs/pages.md` handed to M143n      |
| C7  | `IStorage.delete` JSDoc "`true` if an object was deleted" vs S3's idempotent delete                                                         | §3.3 per-provider table; the `common` JSDoc is outside this lane                          | storage README table now; JSDoc correction handed to M143i/M143n (hand-over notes)    |

## 3. Design decisions

### 3.1 One time bound for every cloud call (V13-216)

- **Decision:** one option name, `requestTimeoutMs`, on every arm that calls a cloud backend in this
  lane: storage `s3`/`b2` (`S3ProviderOptions`), `gcs` (`GcsProviderOptions`), `azure`
  (`AzureBlobProviderOptions`); secrets `aws-kms`, `gcp`, `azure` (the existing
  `SecretsProviderOptions.requestTimeoutMs`, today read by `vault` only, plus the per-provider
  option interfaces); mail `ses` and `sendgrid` (`MailProviderOptions.requestTimeoutMs` plus
  `SesProviderOptions`/`SendGridProviderOptions`). Semantics, the same everywhere: **the whole
  provider call, including the SDK's own retries, must settle within the bound**; for `getStream`
  the bound covers obtaining the stream (§3.4: up to the first chunk), not the transfer after it.
  `0` disables. Out of range (`deadlineRangeError`) throws `RangeError` at construction. Defaults:
  storage `30000`, secrets `5000` (Vault's), mail `15000`. Mechanism: `withDeadline` from `common`,
  with the plugin's `resolveProbeTiming(ctx.runtime)` timer surface passed to the provider (ambient
  timers when constructed directly). **Where the bound sits:** the adapter that builds the SDK
  client (`adaptAwsS3Module`, `adaptGcsModule`, `adaptAzureModule`, the three secrets adapters,
  `adaptSesModule`) takes `{ requestTimeoutMs, timing }` as an extra argument and bounds its own SDK
  calls, forwarding the deadline's signal natively — AWS `client.send(command, { abortSignal })`,
  Azure `{ abortSignal }` on each operation, gax `{ timeout: requestTimeoutMs }` on `gcp` secrets;
  SendGrid owns its `fetch` call and passes `{ signal }` directly. GCS takes no signal: the race
  bounds the caller and the dangling request is left to the SDK. For an **injected** client the
  provider wraps each facade call in the same `withDeadline` (race only — the facade has no signal
  parameter). The exported facade types (`IS3Backend`, `IGcsClient`, `IAzureBlobClient`, the secrets
  and SES facades) do not change. Expiry error: storage reads (`get`, `exists`, `getStream`,
  `getSignedUrl`) → `BackendUnavailableError` (503, "not applied" is true of a read), storage writes
  (`put`, `delete`) → `BackendOutcomeUnknownError` (504); secrets → `SecretProviderUnavailableError`
  (503, as Vault); mail → `BackendOutcomeUnknownError` (504: a send may have gone out). SMTP keeps
  nodemailer's own bounds (§3.11).
- **Why:** Vault already ships exactly this name and shape, so one package does not grow two
  spellings; a per-attempt socket timeout would leave the SDK's retries unbounded.
- **Hand-over (M143m):** `SqsQueueOptions.requestTimeoutMs`, same semantics, `withDeadline` +
  `send(command, { abortSignal })`; expiry → `BackendOutcomeUnknownError`.
- **Test home:** each package's `*-deadline.test.ts` (real SDK against an in-test TCP server that
  accepts and never answers; asserts settle within bound + slack and the 503/504 class), plus a
  `RangeError` table per option.

### 3.2 Faults are classified and name the provider (V13-217, X123-18)

- **Decision:** storage: one internal module `src/providers/fault.ts` exporting
  `toStorageError(error, provider, operation)` (not exported from `src/index.ts`). Order: (1) our
  deadline error → `BackendUnavailableError` for a read, `BackendOutcomeUnknownError` for a write
  (§3.1); (2) `toBackendFault(error, label)`; (3) an HTTP status the backend answered, read from the
  three SDK shapes (`$metadata.httpStatusCode`, `statusCode`, numeric `code`): `502`/`503` →
  `BackendUnavailableError`, `500`/`504` → `BackendOutcomeUnknownError`; (4) anything else →
  `new Error('storage-plugin (<provider>): <operation> failed: <cause message>', { cause })` (masked
  500, provider named in the log). The label is `storage-plugin (<provider>): <operation>`. A
  missing object is `StorageObjectNotFoundError` — a new `common` file (§4) with a `404` hint,
  detail "The requested object was not found.", the key in `message` (log) only — thrown by
  `StorageService` where it throws a plain `Error` today. Secrets: each SDK provider maps an outage
  — `isConnectionFault`, our deadline, an answered HTTP `>= 500`, gRPC code `14`/`4` — to
  `SecretProviderUnavailableError` (503); anything else rethrown as
  `Error('<ProviderName> <get|set> failed: <msg>', { cause })`. Mail: `ses`/`sendgrid` send failures
  go through `toBackendFault` (503/504); unrecognised ones are unchanged, except that SendGrid's
  `SendGrid send failed: HTTP <status>` message gains SendGrid's own first error text
  (`errors[0].message` of the JSON body, cut to 200 characters, log only — the response stays a
  masked 500), which X123-18 found dropped.
- **Why:** the queue and Vault answer 503 for the same outage; a caller and an operator need the
  class and the provider. A refused credential stays a 500: it is the server's configuration, not a
  condition the client can act on.
- **Test home:** `storage-fault.test.ts` (table: shape → class/status), `secrets-fault.test.ts`
  (table per provider), `storage-service.test.ts` (not-found class and hint), mail deadline tests.

### 3.3 `exists()` and `delete()` contract (V13-245)

- **Decision:** `exists` resolves `false` only on a definite not-found answer (S3
  `NotFound`/`NoSuchKey`/404, GCS 404, Azure `exists() === false` or 404); every other failure
  rejects through §3.2. `delete` resolves `true` when the store accepted the delete, `false` only
  when the store answered not-found (GCS 404, Azure 404); every other failure rejects. S3/B2
  `DeleteObject` answers 204 for an absent key, so `s3`/`b2` check with `HEAD` first and resolve
  `false` for an absent key (§3.21), like memory, local, GCS, Azure and R2. Memory keeps its
  behaviour; local follows the same rule (`ENOENT` or Deno's `NotFound` is "not there"; a permission
  or I/O failure rejects), found during implementation. The provider × case outcomes are one table
  in `exists-delete-conformance.test.ts` that the test iterates (fakes per provider), and the same
  table's rows are re-run against the real SDKs on the stand-ins.
- **Why:** an application that writes when `exists` is `false` overwrites during an outage.
- **Test home:** `exists-delete-conformance.test.ts`; guarded `*-standin.test.ts`.

### 3.4 GCS: a 5xx no longer ends the process; `getStream` honours absent (V13-235)

- **Decision:** the GCS adapter constructs `Storage` with `retryOptions: { autoRetry: false }`; the
  peer range stays `^7`. Measured 2026-11-22 on Node 24.22.1 against a server answering 502/503 to
  everything: `download()` and `createReadStream()` on 7.22.0 and 8.4.0 end the process with an
  unhandled `ERR_STREAM_UNABLE_TO_PIPE` under default retries and under `maxRetries: 0`; with
  `autoRetry: false` both reject at once with `code` 502/503 and the process lives. 9.0.0 does not
  crash but never settles: ~600 requests/s for 100 s on `download` and on `exists` with default and
  with tight retry options. Retrying is left to the caller (`resilience-plugin`). `getStream` waits
  for the read stream's first chunk, `end` or `error` before it resolves: `error` 404 → `null`
  (service throws not-found), other `error` → §3.2, otherwise a web stream that yields the first
  chunk then the rest (cancel destroys the source).
- **Why:** the crash is in the SDK's retry path, and the newer majors are not free of a fault.
- **Test home:** `storage-deadline-real.test.ts` (real SDK, in-test 502/503 server, in-process:
  Vitest fails the run on the unhandled rejection the old path raised);
  `cloud-provider-options.test.ts` (peek branches with fakes).

### 3.5 GCS signed URLs (V13-234)

- **Decision:** `expires = now() + expiresIn * 1000` (epoch ms). `GcsProvider` and
  `AzureBlobProvider` are public exports whose `now` defaults to `() => 0`, which signs a 1970
  expiry when constructed directly; the default becomes "no clock", and `getSignedUrl` without one
  rejects with
  `Error('GcsProvider.getSignedUrl needs a clock: pass now to the constructor, or register the provider through StoragePlugin')`
  (same for Azure). `StoragePlugin` keeps passing `runtime.now()`.
- **Test home:** `gcs-provider.test.ts` (fake records `expires`; no-clock refusal);
  `azure-provider.test.ts` (no-clock refusal); guarded `gcs-standin.test.ts` signs with a locally
  generated service-account key and fetches the URL from fake-gcs-server.

### 3.6 GCS endpoint (V13-248)

- **Decision:** `GcsProviderOptions.endpoint` → SDK `apiEndpoint` (the SDK appends `/storage/v1` and
  `/upload/storage/v1`, measured). Same name as `S3ProviderOptions.endpoint`. Because a custom
  `apiEndpoint` turns the SDK's authentication off (§1), the adapter passes
  `useAuthWithCustomEndpoint: options.endpointAuth ?? true`: credentials are sent to a custom
  endpoint by default (a private endpoint in production needs them), and `endpointAuth: false` is
  the documented setting for an emulator that has no credentials to check. The README also says
  `STORAGE_EMULATOR_HOST` overrides `endpoint` when both are set.
- **Test home:** `gcs-provider.test.ts` (fake module records `apiEndpoint` and
  `useAuthWithCustomEndpoint` for unset/`true`/`false`); `gcs-standin.test.ts` (with
  `endpointAuth: false`); the refused-credential case (§3.2, 403 → named plain Error) on an in-test
  `node:http` server answering 403, since fake-gcs-server checks no credential.

### 3.7 B2 needs a region or an endpoint (V13-248)

- **Decision:** `createProvider` throws
  `Error("storage-plugin: the 'b2' provider needs options.region (a Backblaze region such as 'us-west-004') or options.endpoint")`
  when both are absent; with a region the endpoint stays `https://s3.<region>.backblazeb2.com`.
- **Test home:** `storage-plugin.test.ts`.

### 3.8 Azure storage starts from its documented options (V13-233)

- **Decision:** `connectionString` → `BlobServiceClient.fromConnectionString(cs)`; a new
  `AzureBlobProviderOptions.endpoint` (blob service URL) for the `accountName`/`accountKey` form,
  default `https://<account>.blob.core.windows.net`. SAS URLs come from the SDK:
  `blockBlobClient.generateSasUrl({ permissions: BlobSASPermissions.parse('r'), expiresOn })`, which
  encodes the name and uses the client's own host; a client without a shared key (SAS URL connection
  string, managed identity) is refused with the existing message. An injected client is stored as
  given (no spread, no `canSign` flag); the provider owns the 404 → `null`/`false` mapping, so a raw
  `BlobServiceClient` works through `get`, `put`, `exists`, `delete`, `getStream`. **Signing, one
  path for both clients:** `getSignedUrl` first honours an injected facade's optional
  `IAzureBlobClient.getSignedUrl?` (unchanged contract); otherwise it calls the block blob client's
  `generateSasUrl` when that is a function, and maps the SDK's `RangeError` (no shared-key
  credential) to the existing "requires an account key" message; a blob client with neither is
  refused with the same message. The lazily adapted client signs through the same `generateSasUrl`
  call. The exported `canSign(options)` function keeps its meaning (options carry a key).
- **Test home:** `azure-provider.test.ts` (fake module); `azure-standin.test.ts` on Azurite for both
  option forms and an injected real client, including a key `docs/a b/ñ#1?.txt` whose SAS URL is
  fetched back.

### 3.9 Readiness probes (V13-215, lane half)

- **Decision:** new probes on the lazily adapted clients: storage `gcs` `bucket.exists()`, `azure`
  `containerClient.exists()`; secrets `aws-kms` `ListSecretsCommand({ MaxResults: 1 })`, `gcp`
  `listSecrets({ parent: 'projects/<id>', pageSize: 1 }, { autoPaginate: false })`, `azure`
  `listPropertiesOfSecrets().byPage({ maxPageSize: 1 }).next()`; mail `ses` `GetAccountCommand`.
  Each runs under the arm's `requestTimeoutMs`. Rule for the new probes: reachable when the backend
  answered (a resolved call, an HTTP status `< 500`, a gRPC status other than `14`/`4`); down on a
  network failure, the bound, or a `>= 500` answer. A refused credential therefore reads reachable —
  the README states it (as SendGrid's `isHealthy` already does), because a least-privilege
  credential may lack the list permission. `s3`/`b2` keep their `head('')` probe unchanged, which
  reads a refused credential as down; the README carries one table of the probe and its rule per arm
  so the difference is stated, not discovered. The storage indicator today calls
  `provider.isHealthy()` with no bound or cache (`storage-plugin.ts:199-212`); it now wraps the
  probe in `createCachedProbe` (TTL 5000 ms, timeout 2000 ms), as `secrets-plugin` does, so `/ready`
  is never held for `requestTimeoutMs`.
- **Test home:** `*-health.test.ts` per provider (fake modules, rule table);
  `storage-plugin.test.ts` (a never-settling probe answers `down` within the 2 s bound, and a second
  call inside the TTL does not call the probe again); guarded stand-in runs.

### 3.10 LaunchDarkly outage at boot is bounded (V13-232)

- **Decision:** `start()` passes `{ timeout: initTimeoutSeconds }` and also wraps the wait in
  `withDeadline(initTimeoutSeconds * 1000)`, so an injected client that ignores the option is
  bounded too; the anonymous snapshot that `start()` awaits runs under the same bound. Background
  refills are not bounded: they hold nothing, and a timer per refill measurably slowed the growth
  tests (one per distinct context). The facade type becomes
  `waitForInitialization(options?: { readonly timeout?: number })`. Expiry keeps today's documented
  degraded start (warn, fallback values, `status()` unhealthy). `initTimeoutSeconds` must be a
  finite number `> 0` and `<= 2147483` (so `* 1000` stays in the timer range); anything else, `0`
  included, throws `RangeError` naming the option at construction — a zero wait is not offered,
  because the LaunchDarkly `0` ("do not wait") and `withDeadline`'s `0` ("unbounded") mean opposite
  things.
- **Test home:** `launchdarkly-real.test.ts` (real SDK, `baseUri`/`streamUri` to a black-hole TCP
  server and to a closed port: `start()` settles within `initTimeoutSeconds` + 2 s);
  `launchdarkly-provider.test.ts` (never-settling fake bounded).

### 3.11 SMTP: inline attachments, timeouts, DNS TTL (V13-4, V13-119)

- **Decision:** an attachment with `contentId` gets `contentDisposition: 'inline'`. New
  `SmtpProviderOptions`/`MailProviderOptions` fields `connectionTimeoutMs`, `greetingTimeoutMs`,
  `socketTimeoutMs`, passed to nodemailer as `connectionTimeout`/`greetingTimeout`/`socketTimeout`
  only when set (nodemailer's defaults otherwise). `dnsTtlMs` (opt-in; absent = nodemailer's own
  resolution): when set and the runtime has `dns`, the provider resolves the host through
  `runtime.dns.resolveHost` at most once per `dnsTtlMs`, builds the transport against the first
  address with `tls: { servername: host }`, and rebuilds it (closing the old one) when the address
  changes. nodemailer 10.6.0 has no TTL setting reachable from an SMTP transport (§1), which is why
  the provider resolves. TLS still verifies the certificate against `host` (the servername), not the
  address. `dnsTtlMs` is never silently inert: with an injected `transport` the provider throws at
  construction, and with a runtime that has no `dns` `MailPlugin` throws at register, each naming
  the option.
- **Test home:** `smtp-provider.test.ts` (raw message through nodemailer's stream transport shows
  `Content-Disposition: inline`; config table; DNS resolver fake changing address rebuilds); guarded
  `smtp-standin.test.ts` on Mailpit reads the inline part back.

### 3.12 SES endpoint (V13-228)

- **Decision:** SES reads `endpoint` from the existing flat `MailProviderOptions.endpoint` and a new
  `SesProviderOptions.endpoint`, passed to `SESv2Client({ endpoint })`.
- **Test home:** `ses-provider.test.ts`; `ses-capture.test.ts` (real SDK → in-test capture server
  records `POST /v2/email/outbound-emails` and `GET /v2/email/account`).

### 3.13 Slack carries `subject` (V13-257)

- **Decision:** with a non-empty `subject` the text is `*<subject>*\n<body>`; without one, `body`.
  The subject is escaped as Slack documents (`&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`), so a
  subject cannot inject `<!channel>`; the body is passed as before (the caller owns its mrkdwn).
- **Test home:** `slack-channel.test.ts`; capture run in `slack-capture.test.ts` (real provider and
  default `fetch` against an in-test server).

### 3.14 `415` for a disallowed upload type (V13-193)

- **Decision:** `allowedMimeTypes` refusal answers `415 Unsupported Media Type`, detail unchanged.
- **Test home:** `upload-refusal-status.test.ts` (updated row).

### 3.15 Upload brand for the OpenAPI generator (V13-58, lane half)

- **Decision:** new `common/src/form/upload-metadata.ts`:
  `UPLOAD_METADATA = Symbol.for('setu.upload.metadata')`,
  `interface UploadMetadata { fieldname: string; maxFiles?: number; maxBytes: number; mimeTypes?: readonly string[] }`,
  `withUploadMetadata(middleware, meta)` and `uploadMetadataOf(value)` in the `FORM_FILE_METADATA`
  pattern. `createUploadMiddleware` brands its middleware with the resolved field name, `maxSize` as
  `maxBytes`, `maxFiles` and `allowedMimeTypes`. Consumer: openapi-plugin (M143l) documents
  `multipart/form-data` with the file field as `format: binary`. If M143l is cut from `0.14.0`, the
  `0.14.0` release branch removes `uploadMetadataOf` (and the brand) rather than ship a reader with
  no caller; this is recorded in the hand-over notes to M143l.
- **Test home:** `common` `upload-metadata.test.ts`; storage `upload-middleware.test.ts` reads the
  brand back.

### 3.16 V13-131: worker-pool calls cancelled by `WorkerRunOptions.signal`

- **Decision:** stopped and reported for the Core lane (§0) at first, because the capability is
  typed `IWorkerPool` and its `WorkerRunOptions` had no `signal` (an additive type would need a
  cast, which the token↔interface rule forbids). M143i added `readonly signal?: AbortSignal` (#611);
  once it merged, the worker-pool half was built here. Pre-aborted → reject with `signal.reason`,
  nothing queued; abort while queued → removed from `pending` with the timeout's starting-worker
  reclaim; abort while running → the worker terminated and replaced as the timeout path does;
  listener attached before the task is queued and removed on every settle, with a `settled` flag
  guarding a listener a host still holds; one signal shared by several calls withdraws the queued
  ones together, so no replacement worker starts for them; a `signal` that is not an `AbortSignal`
  is a `TypeError` before admission. Counted in the rejected-tasks metric under a new `aborted`
  reason, never as `completed` or `failed`.
- **Test home:** `worker-pool-plugin/test/unit/task-pool-abort.test.ts`; the real-thread case in
  `test/e2e/real-worker.test.ts` with the `test/fixtures/wait-task.ts` fixture.

### 3.17 Catalogue key filter (V12-132)

- **Decision:** `exposeCatalogues.keyPrefixes?: readonly string[]`; when present, each served body
  holds only keys starting with one of the prefixes (after the default-locale overlay). Validated at
  register: a non-empty array of non-empty strings, else `TypeError` naming the option.
- **Test home:** `catalogue-route.test.ts`.

### 3.18 Azure Key Vault options and README (V13-255)

- **Decision:** `disableChallengeResourceVerification?: boolean` on `AzureKeyVaultProviderOptions`
  and `SecretsProviderOptions`, passed to `new SecretClient(url, credential, { … })`; README names
  `@azure/identity` beside `@azure/keyvault-secrets` and every install line is `npm install`. The
  option's JSDoc and README say it is for an emulator or a test vault only: the challenge check
  stops a bearer token being sent to a host that is not the vault.
- **Test home:** `azure-key-vault.test.ts` (fake records the options); guarded
  `azure-key-vault-standin.test.ts` on Lowkey Vault (read, rotate, bound, outage → 503).

### 3.19 Security review and audit

- **Decision:** the diff crosses trust boundaries — credentials sent to a custom endpoint (§3.6),
  Key Vault's challenge check made optional (§3.18), SMTP connecting to a resolved address (§3.11),
  error text from a backend reaching logs (§3.2) — so a committed-tree security audit runs before
  the PR, by a freshly spawned Claude agent following `.roo/skills/security-audit/SKILL.md`, never
  by Codex. Obligations it probes: (1) with `endpoint` set and `endpointAuth` unset, GCS requests
  carry the credential's `Authorization` header (positive control: `endpointAuth: false` sends
  none); (2) `disableChallengeResourceVerification` defaults off and is documented test-only; (3) an
  SMTP connection by address presents and verifies `host` as the TLS servername (negative control: a
  certificate for another name is refused); (4) no credential, SAS token, signed URL or secret value
  appears in any new log line or error message, including the SendGrid error text and
  `toStorageError`'s message; (5) a 404 hint's detail never contains the object key.
- **Test home:** the audit record in the PR; obligations (1), (3), (4) and (5) also have unit tests
  in the packages' suites.

### 3.20 Compared with — siblings and established libraries (checked 2026-11-22)

| Decision                                                                             | Siblings in this repository                                                                                  | Established libraries (primary sources)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Verdict                                                                                  |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Whole-call bound, `requestTimeoutMs`; storage 30 s, secrets 5 s, mail 15 s           | Vault `requestTimeoutMs` 5000; Redis `commandTimeoutMs` 15 s; RabbitMQ and messaging `publishTimeoutMs` 15 s | AWS SDK JS v3: no request timeout by default ([node-http-handler](https://raw.githubusercontent.com/smithy-lang/smithy-typescript/main/packages/node-http-handler/src/node-http-handler.ts)); AWS Java v2: none by default, AWS advises setting `apiCallTimeout` ([timeouts](https://docs.aws.amazon.com/sdk-for-java/latest/developer-guide/timeouts.html)); Azure blob: per-try `tryTimeoutInMs`, none by default ([retry policy](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-retry-policy-javascript)); GCS: `totalTimeout` 600 s across retries ([storage.ts](https://raw.githubusercontent.com/googleapis/nodejs-storage/main/src/storage.ts)) | Matches the sibling name and defaults; stricter than SDK defaults, as AWS advises. Kept. |
| `exists`/`delete` reject on an outage; `false` only on not-found                     | R2 (`cloudflare-plugin`) lets an outage reject                                                               | ActiveStorage raises ([s3_service.rb](https://raw.githubusercontent.com/rails/rails/main/activestorage/lib/active_storage/service/s3_service.rb)); Flysystem `UnableToCheckFileExistence` ([adapter](https://raw.githubusercontent.com/thephpleague/flysystem/3.x/src/AwsS3V3/AwsS3V3Adapter.php)); Go CDK `Exists` errors except NotFound ([blob](https://pkg.go.dev/gocloud.dev/blob)); Azure .NET `ExistsAsync` throws ([docs](https://learn.microsoft.com/en-us/dotnet/api/azure.storage.blobs.specialized.blobbaseclient.existsasync)); Spring `AbstractResource.exists()` swallows (outlier)                                                                    | Matches. Kept.                                                                           |
| S3/B2 `delete` of an absent key resolves `true`                                      | R2 `head`s first and returns `false` (one extra round trip)                                                  | Go CDK: NotFound error; Azure `DeleteIfExistsAsync`: `false`; Flysystem: silent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | **Decided 2026-11-22: changed** — check first, `false` for an absent key (§3.21).        |
| LaunchDarkly unreachable at boot: wait `initTimeoutSeconds` (5), then start degraded | —                                                                                                            | LaunchDarkly: no default, recommends 1–5 s, degrades on timeout ([LDClient.ts](https://raw.githubusercontent.com/launchdarkly/js-core/main/packages/shared/sdk-server/src/api/LDClient.ts), [resilience](https://launchdarkly.com/docs/guides/sdk/resilience)); Split `readyTimeout` 15 s, degrades ([docs](https://developer.harness.io/feature-management-experimentation/new-to-fme/sdks-and-customer-deployed-components/server-side-sdks/nodejs-sdk.md)); OpenFeature: never throws, default value ([spec](https://raw.githubusercontent.com/open-feature/spec/main/specification/sections/02-providers.md))                                                     | Matches. Kept.                                                                           |
| Disallowed upload part type answers `415`                                            | Form parse (`UnsupportedFormEncodingError`) answers 415 for the request's own encoding                       | RFC 9110 §15.5.16 allows 415 "as a result of inspecting the data directly" ([RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.txt)); NestJS `ParseFilePipe` 400 ([source](https://raw.githubusercontent.com/nestjs/nest/master/packages/common/pipes/file/parse-file.pipe.ts)); Laravel `mimes` 422 ([source](https://raw.githubusercontent.com/laravel/framework/12.x/src/Illuminate/Validation/ValidationException.php)); DRF and ASP.NET use 415 for the request `Content-Type` only                                                                                                                                                                               | **Decided 2026-11-22: kept** (§3.21).                                                    |
| Slack `subject`: `*subject*\n` + body in `text`, escaped                             | Push channel maps `subject` to the title                                                                     | Apprise: attachment title or a `header` block ([slack.py](https://raw.githubusercontent.com/caronc/apprise/master/apprise/plugins/slack.py)); Novu: no subject ([provider](https://raw.githubusercontent.com/novuhq/novu/next/packages/providers/src/lib/chat/slack/slack.provider.ts)); Laravel: no subject on `SlackMessage` ([docs](https://laravel.com/docs/12.x/notifications))                                                                                                                                                                                                                                                                                  | **Decided 2026-11-22: kept** (§3.21).                                                    |
| Worker task withdrawal by `AbortSignal` (not built here)                             | —                                                                                                            | Piscina: pre-aborted rejects, queued removed, running worker removed ([index.ts](https://raw.githubusercontent.com/piscinajs/piscina/current/src/index.ts)); Tinypool the same ([index.ts](https://raw.githubusercontent.com/tinylibs/tinypool/main/src/index.ts)); workerpool `cancel()` terminates ([README](https://raw.githubusercontent.com/josdejong/workerpool/master/README.md))                                                                                                                                                                                                                                                                              | Matches the follow-up design.                                                            |

### 3.21 Maintainer decisions on the comparison's splits (2026-11-22)

- **Decision:** (1) a disallowed upload part type stays `415`: the row asks for it, and RFC 9110
  allows 415 "as a result of inspecting the data directly"; NestJS (400) and Laravel (422) differ.
  (2) The Slack subject stays an escaped inline bold first line: it renders on every client and
  needs no change to `SlackMessage`; Apprise uses a structural title, Novu and Laravel none. (3)
  **Changed:** S3/B2 `delete()` checks with `HEAD` first and resolves `false` for an absent key, so
  one `delete()` gives the same answer on every provider (memory, local, R2, GCS, Azure, S3/B2): an
  application tested on memory and deployed on S3 must not see a different answer. The race is
  accepted and documented: an object removed between the check and the delete still resolves `true`.
  An outage on either request still rejects.
- **Why:** the comparison in §3.20; the reason for (3) is the interface, not the round trip.
- **Test home:** `delete-consistency.test.ts` (one table over memory, local, S3/B2, GCS and Azure;
  R2 is in `cloudflare-plugin` and not driven here); `cloud-standin.test.ts` on MinIO, Azurite and
  fake-gcs-server.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** an injected `ILaunchDarklyClient` now receives
`waitForInitialization({ timeout })` instead of `{ timeoutSeconds }`; behaviour changes listed in
the upgrade note (415, `exists`/`delete` reject on outage, classified 503/504/404, GCS SDK retry
off, `b2` needs a region or endpoint, Slack text carries the subject, SMTP inline disposition, a
directly constructed `GcsProvider`/`AzureBlobProvider` without a clock refuses `getSignedUrl`, GCS
sends credentials to a custom endpoint unless `endpointAuth: false`, `initTimeoutSeconds: 0` is
refused). Ships in minor `0.14.0`.

| Exported symbol                                  | Kind      | Consumer / real code path that READS it                                            |
| ------------------------------------------------ | --------- | ---------------------------------------------------------------------------------- |
| `StorageObjectNotFoundError` (common)            | class     | `StorageService` throws it; `errorHandler` reads its hint; R2 (M143o) may throw it |
| `UPLOAD_METADATA`, `withUploadMetadata` (common) | symbol/fn | `createUploadMiddleware` brands with it                                            |
| `uploadMetadataOf` (common)                      | fn        | openapi-plugin generator (M143l); storage test reads it back                       |
| `UploadMetadata` (common)                        | type      | parameter/return type of the two functions                                         |

### 4.1 Options — every option names its consumer

| Option                                                                                                                                        | Consumer                                         | Behavior (per implementation)     |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------- |
| storage `requestTimeoutMs` (`S3ProviderOptions`, `GcsProviderOptions`, `AzureBlobProviderOptions`)                                            | `S3Provider`, `GcsProvider`, `AzureBlobProvider` | §3.1, default 30000               |
| `GcsProviderOptions.endpoint`                                                                                                                 | `adaptGcsModule`                                 | SDK `apiEndpoint`                 |
| `AzureBlobProviderOptions.endpoint`                                                                                                           | `adaptAzureModule`                               | blob service URL for the key form |
| `SecretsProviderOptions.requestTimeoutMs` (now also aws-kms/gcp/azure)                                                                        | `createProvider` → each provider                 | §3.1, default 5000                |
| `AwsKmsProviderOptions.requestTimeoutMs`, `GcpSecretManagerProviderOptions.requestTimeoutMs`, `AzureKeyVaultProviderOptions.requestTimeoutMs` | the three providers                              | §3.1                              |
| `disableChallengeResourceVerification` (secrets bag + Azure options)                                                                          | `adaptAzureModule` (secrets)                     | `SecretClient` option             |
| `MailProviderOptions.requestTimeoutMs`, `SesProviderOptions.requestTimeoutMs`, `SendGridProviderOptions.requestTimeoutMs`                     | `SesProvider`, `SendGridProvider`                | §3.1, default 15000               |
| `SesProviderOptions.endpoint` (and the bag's `endpoint` for `ses`)                                                                            | `adaptSesModule`                                 | `SESv2Client` endpoint            |
| `connectionTimeoutMs`, `greetingTimeoutMs`, `socketTimeoutMs` (SMTP)                                                                          | `buildTransportConfig`                           | nodemailer option when set        |
| `dnsTtlMs` (SMTP)                                                                                                                             | `SmtpProvider`                                   | §3.11, opt-in                     |
| `exposeCatalogues.keyPrefixes`                                                                                                                | `registerCatalogueRoute`                         | §3.17                             |
| `GcsProviderOptions.endpointAuth`                                                                                                             | `adaptGcsModule`                                 | §3.6, default `true`              |

## 5. Implementation files

| File                                                                                                                                                        | Purpose                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `packages/common/src/index.ts`                                                                                                                              | two new export lines                              |
| `packages/common/src/errors/storage-object-not-found.ts`                                                                                                    | §3.2 class                                        |
| `packages/common/src/form/upload-metadata.ts`                                                                                                               | §3.15 brand                                       |
| `packages/storage-plugin/src/providers/fault.ts`                                                                                                            | §3.2 internal classifier                          |
| `packages/storage-plugin/src/providers/{s3,gcs,azure}-provider.ts`                                                                                          | §3.1–3.9                                          |
| `packages/storage-plugin/src/plugin/storage-plugin.ts`                                                                                                      | timing, `requestTimeoutMs`, endpoints, b2 refusal |
| `packages/storage-plugin/src/services/storage-service.ts`                                                                                                   | `StorageObjectNotFoundError`                      |
| `packages/storage-plugin/src/interfaces/index.ts` and the provider files' own option interfaces                                                             | option fields, in both copies (§1)                |
| `packages/storage-plugin/src/middleware/upload-middleware.ts`                                                                                               | 415, brand                                        |
| `packages/secrets-plugin/src/providers/{aws-kms,gcp-secret-manager,azure-key-vault}.ts`                                                                     | bound, classification, probes, Azure option       |
| `packages/secrets-plugin/src/plugin/secrets-plugin.ts`, `src/interfaces/index.ts`                                                                           | pass timing and new options                       |
| `packages/mail-plugin/src/providers/{ses,sendgrid,smtp}-provider.ts`                                                                                        | §3.1, §3.9, §3.11, §3.12                          |
| `packages/mail-plugin/src/plugin/mail-plugin.ts`, `src/interfaces/index.ts`                                                                                 | pass timing, `runtime.dns`, options               |
| `packages/notification-plugin/src/channels/slack-channel.ts`                                                                                                | §3.13                                             |
| `packages/feature-flags-plugin/src/providers/launchdarkly-{provider,module}.ts`                                                                             | §3.10                                             |
| `packages/localization-plugin/src/{interfaces/index.ts,routes/catalogue-route.ts,plugin/localization-plugin.ts}`                                            | §3.17                                             |
| READMEs and agent cards of the six changed packages                                                                                                         | §2                                                |
| `CHANGELOG.md` (one `0.14.0` entry), `docs/upgrading.md` (behaviour changes of §4), `PUBLIC_API.md` (every new export and option, the 415, the facade type) | shared files, one entry for this letter           |
| `ROADMAP.md` Progress Tracking row `143r`, `CLAUDE.md` status line ("complete (PR pending)"), `git mv` of this plan to `plans/archive/`                     | completion, in the same branch                    |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                                     | src covered                          | Key assertions (and the signature each call type-checks against)                                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/test/unit/storage-object-not-found.test.ts`                                                                                           | `errors/storage-object-not-found.ts` | name, key in message, 404 hint with fixed detail                                                                                                                                       |
| `common/test/unit/upload-metadata.test.ts`                                                                                                    | `form/upload-metadata.ts`            | brand round trip; foreign/invalid values absent; non-enumerable                                                                                                                        |
| `storage-plugin/test/unit/storage-fault.test.ts`                                                                                              | `providers/fault.ts`                 | table: deadline, ECONNREFUSED, ECONNRESET, 502/503/500/504 per SDK shape, 403 → named plain Error                                                                                      |
| `storage-plugin/test/unit/exists-delete-conformance.test.ts`                                                                                  | the three providers                  | §3.3 table iterated                                                                                                                                                                    |
| `storage-plugin/test/unit/{s3,gcs,azure}-provider.test.ts` (extended)                                                                         | providers                            | §3.4–3.8 branches with fake modules; configs recorded                                                                                                                                  |
| `storage-plugin/test/unit/storage-deadline.test.ts`                                                                                           | providers + plugin                   | real SDKs vs black-hole server settle within bound; `RangeError` table                                                                                                                 |
| `storage-plugin/test/integration/storage-deadline-real.test.ts`                                                                               | gcs provider                         | real SDK, 502/503 server, process alive, 503 class                                                                                                                                     |
| `storage-plugin/test/unit/providers/{gcs,azure}-health.test.ts` (extended)                                                                    | probes                               | §3.9 rule table                                                                                                                                                                        |
| `storage-plugin/test/unit/storage-plugin.test.ts`, `storage-service.test.ts`                                                                  | plugin, service                      | b2 refusal; options passed; not-found class                                                                                                                                            |
| `storage-plugin/test/unit/upload-refusal-status.test.ts`, `upload-middleware.test.ts`                                                         | middleware                           | 415; brand read back                                                                                                                                                                   |
| `storage-plugin/test/integration/{gcs,azure,s3}-standin.test.ts` (guarded `GCS_EMULATOR_URL`, `AZURITE_CONNECTION_STRING`, `S3_ENDPOINT_URL`) | real SDKs                            | upload/download/exists/delete/signed URL round trip; outage (a second provider on a closed port) → 503; credential refused → named 500 on Azurite and MinIO (GCS: §3.6 in-test server) |
| `secrets-plugin/test/unit/secrets-fault.test.ts`, `secrets-deadline.test.ts`, provider tests extended                                         | three providers, plugin              | classification table; bounds with real SDKs vs black hole; probes; Azure option                                                                                                        |
| `secrets-plugin/test/integration/{aws-kms,azure-key-vault}-standin.test.ts` (guarded `AWS_ENDPOINT_URL`, `LOWKEY_VAULT_URL`)                  | real SDKs                            | read/rotate; outage → 503                                                                                                                                                              |
| `mail-plugin/test/unit/{smtp,ses,sendgrid}-provider.test.ts` (extended), `ses-capture.test.ts`                                                | providers, plugin                    | inline; config; DNS rebuild; endpoint; bound; probe                                                                                                                                    |
| `mail-plugin/test/integration/smtp-standin.test.ts` (guarded `SMTP_URL`)                                                                      | smtp                                 | inline part read back from Mailpit                                                                                                                                                     |
| `notification-plugin/test/unit/slack-channel.test.ts`, `slack-capture.test.ts`                                                                | slack channel                        | subject in text; wire shape                                                                                                                                                            |
| `feature-flags-plugin/test/unit/launchdarkly-provider.test.ts`, `launchdarkly-real.test.ts`                                                   | LD provider/module                   | bounded start, option name                                                                                                                                                             |
| `localization-plugin/test/integration/catalogue-route.test.ts` (extended)                                                                     | route, plugin validation             | §3.17                                                                                                                                                                                  |
| `storage-plugin/test/unit/options-typing.test.ts` (extended)                                                                                  | `interfaces/index.ts`                | each provider's two option interfaces assignable both ways                                                                                                                             |

Every fix's test is shown failing on the parent commit before the fix lands (recorded in the PR). |
`worker-pool-plugin/test/unit/task-pool-abort.test.ts`, `test/e2e/real-worker.test.ts`
(`fixtures/wait-task.ts`) | `pool/task-pool.ts`, `services/worker-pool-service.ts`,
`services/sizing.ts`, `metrics/metric-names.ts` | pre-aborted/queued/running abort reject with
`signal.reason`; listener removed on every settle; shared-signal batch; non-signal `TypeError`;
`aborted` reason only; real worker terminated |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m143r-provider-arms, never develop or main
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test:coverage common storage-plugin secrets-plugin mail-plugin notification-plugin feature-flags-plugin localization-plugin
flock ~/.cache/setu-ts/locks/suite.lock pnpm run ci:local
pnpm run release:publish --dry-run
pnpm run release:verify 0.14.0
# then the committed-tree security audit of §3.19, by a freshly spawned Claude agent
```

## 8. Risks & mitigations

- `autoRetry: false` drops GCS's own retry on transient errors → named 503 at once, README points to
  `resilience-plugin`; injected clients keep their own retry setting.
- A whole-call bound can cut a large transfer → `0` disables, the default is 30 s, and the README
  says to raise it for large objects or use `getStream`.
- Stand-in images are pulled (fake-gcs-server, Azurite, Lowkey Vault) → named in the report,
  containers `m143r-*`, removed with their volumes before reporting.
- Hook refuses vitest while another session's suite runs → wait on that PID; never kill it.

## 9. Out of scope

- CI services for the new stand-ins — no lane owns `.github/workflows/ci.yml`; listed as a
  follow-up.
- Live-account proof of any arm — no account exists; READMEs say which arms were proved only on a
  stand-in.
- Passing a logger to the LaunchDarkly SDK (X123-1 Low aside) — not a row.
