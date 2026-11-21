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
`feature-flags-plugin`, `worker-pool-plugin`, `localization-plugin`, plus three additive files in
`common`. Everything is proved on local stand-ins; no live cloud account exists, and no stand-in
result is recorded as proof of the live service.

- **In scope:** the sixteen rows V13-232, V13-233, V13-234, V13-235, V13-216, V13-217, V13-245,
  V13-248, V13-4, V13-119, V13-131, V12-132, V13-193, V13-228, V13-255, V13-257; the lane halves of
  V13-215 (the SES probe the row names, and the storage `gcs`/`azure` and secrets
  `aws-kms`/`gcp`/`azure` probes its X123 widening names, which only this lane can edit) and of
  V13-58 (the brand that lets the OpenAPI generator see `createUploadMiddleware`).
- **NOT this milestone:** the SQS half of V13-215 and V13-216 (M143m, Messaging lane — it takes the
  option name and semantics of §3.1); the OpenAPI half of V13-58 (M143l, Web lane — it reads the
  brand of §3.15); the R2 not-found row of V13-217 (M143o, Workers lane — it may throw the
  `StorageObjectNotFoundError` of §3.2); the `IStorage.delete`/`exists` JSDoc wording in
  `common/src/services/storage.ts` (Core lane, M143i, or Docs, M143n — this lane may not edit an
  existing `common` file); folding `signal` into `WorkerRunOptions` itself (Core lane, later);
  wiring the new stand-ins into CI (`.github/workflows/ci.yml` and `scripts/local-ci.ts` belong to
  no lane).

## 1. Contracts verified from SOURCE (not names)

| Reference                                                           | Source (file:line)                                                                                                                                               | Verified surface / fact                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `withDeadline`, `deadlineRangeError`                                | `packages/common/src/health/deadline.ts:77,118`                                                                                                                  | `withDeadline(run(signal), { timeoutMs, onTimeout, timing? })`; `0` = unbounded; aborts the signal and rejects with `onTimeout()`'s error; `deadlineRangeError(name, ms)` → `RangeError` or `null`                              |
| `resolveProbeTiming`                                                | used at `packages/secrets-plugin/src/plugin/secrets-plugin.ts` (`createProvider(..., timing)`)                                                                   | the timer surface a plugin hands a provider; Vault already takes it                                                                                                                                                             |
| `toBackendFault`, `BackendUnavailableError`, `…OutcomeUnknownError` | `packages/common/src/errors/backend-fault.ts:85,123,268`                                                                                                         | 503 "not applied" / 504 "may have been applied", fixed `detail`, driver error as `cause`; `toBackendFault` returns `undefined` for an unrecognised shape                                                                        |
| `isConnectionFault`                                                 | `packages/common/src/errors/connection-fault.ts`                                                                                                                 | cause-chain walk (5 deep) over eight node codes plus Redis shapes                                                                                                                                                               |
| `withHttpStatusHint`, `httpStatusHintOf`                            | `packages/common/src/errors/status-hint.ts`                                                                                                                      | symbol brand read by `errorHandler`; `detail` required                                                                                                                                                                          |
| `SecretProviderUnavailableError`                                    | `packages/secrets-plugin/src/errors.ts`                                                                                                                          | `(provider, cause)`, 503 hint, detail "The secrets provider is temporarily unreachable."; used by Vault only                                                                                                                    |
| Vault `requestTimeoutMs` (default 5000)                             | `packages/secrets-plugin/src/providers/vault.ts:18,71,221,343-376`                                                                                               | the precedent this plan copies: one bound per request via `withDeadline`, expiry and transport failure → `SecretProviderUnavailableError`                                                                                       |
| `SecretsProviderOptions.requestTimeoutMs`                           | `packages/secrets-plugin/src/interfaces/index.ts:132-198`                                                                                                        | flat option bag shared by every arm; today read by `vault` only                                                                                                                                                                 |
| `MailProviderOptions.endpoint`                                      | `packages/mail-plugin/src/interfaces/index.ts:189-229`                                                                                                           | flat bag; `endpoint` exists (SendGrid); SES reads only region/keys/client                                                                                                                                                       |
| `IStorage`                                                          | `packages/common/src/services/storage.ts:70-116`                                                                                                                 | `get` throws when absent; `delete` "`true` if an object was deleted"; `exists` "`true` if present"; `getStream?` throws when absent                                                                                             |
| `StorageService` not-found                                          | `packages/storage-plugin/src/services/storage-service.ts:303,316,345`                                                                                            | `new Error('Storage object not found: …')`, no class, no hint                                                                                                                                                                   |
| GCS adapter                                                         | `packages/storage-plugin/src/providers/gcs-provider.ts:131-226,392-431,457-488`                                                                                  | `new Storage({ projectId })` only; `delete`/`exists` bare `catch { return false }`; `expires` in epoch SECONDS; `getStream` returns `createReadStream()` at once                                                                |
| Azure adapter                                                       | `packages/storage-plugin/src/providers/azure-provider.ts:203-220,267-306,373`                                                                                    | `new BlobServiceClient(connectionString)`; fixed `https://<acct>.blob.core.windows.net`; hand-built SAS URL, name unencoded; injected client spread `{ ...injected, canSign: true }`; facade `delete` swallows all              |
| S3 adapter                                                          | `packages/storage-plugin/src/providers/s3-provider.ts:103-119,168-183,328-338`                                                                                   | `delete`/`head` bare catch → `false`; `isHealthy` = `head('')`, catch → `false`                                                                                                                                                 |
| B2 preset                                                           | `packages/storage-plugin/src/plugin/storage-plugin.ts:84-97`                                                                                                     | `region ?? 'us-east-1'` → `https://s3.us-east-1.backblazeb2.com` (not a Backblaze host)                                                                                                                                         |
| Storage indicator                                                   | `packages/storage-plugin/src/plugin/storage-plugin.ts:199-212`                                                                                                   | `isHealthy` absent → `up`/`reachable: 'unknown'`; GCS/Azure lazy adapters never install one                                                                                                                                     |
| Upload middleware                                                   | `packages/storage-plugin/src/middleware/upload-middleware.ts:213-219`                                                                                            | disallowed MIME → `400 Invalid MIME type`; the returned middleware carries no brand                                                                                                                                             |
| `FORM_FILE_METADATA` pattern                                        | `packages/common/src/form/form-file-metadata.ts`                                                                                                                 | `Symbol.for` brand, `withX(target, meta)` defines a non-enumerable property, `xOf(value)` validates and treats foreign values as absent — §3.15 copies it                                                                       |
| `WorkerRunOptions`, `IWorkerPool.run`                               | `packages/common/src/services/worker-pool.ts:16-27,67-83`                                                                                                        | only `timeoutMs`; changing it is a Core-lane change                                                                                                                                                                             |
| Task pool timeout path                                              | `packages/worker-pool-plugin/src/pool/task-pool.ts:183-205,514-…`                                                                                                | timer armed at enqueue; a queued task is removed from `pending`, a running one terminates its worker — §3.16 reuses both paths                                                                                                  |
| LaunchDarkly start                                                  | `packages/feature-flags-plugin/src/providers/launchdarkly-provider.ts:207-209`; `launchdarkly-module.ts:69`                                                      | passes `{ timeoutSeconds }`; facade types `waitForInitialization(options?: { timeoutSeconds?: number })`                                                                                                                        |
| `LDWaitForInitializationOptions`                                    | `node_modules/.pnpm/@launchdarkly+js-server-sdk-common@2.26.5/.../dist/index.d.ts:2123-2137`                                                                     | the field is `timeout` (seconds); no options → waits forever                                                                                                                                                                    |
| Slack channel                                                       | `packages/notification-plugin/src/channels/slack-channel.ts:31-42`                                                                                               | posts `{ text: body, channel? }`; `subject` never read                                                                                                                                                                          |
| SMTP mapping                                                        | `packages/mail-plugin/src/providers/smtp-provider.ts:86-98,126-134`                                                                                              | transport config = port/secure/host/auth; attachment passes `cid` only                                                                                                                                                          |
| nodemailer 10.6.0                                                   | `node_modules/.pnpm/nodemailer@10.6.0/.../dist/cjs/mail-composer/index.js:171`, `smtp-connection/index.js:140-150,260-264`, `shared/index.js:61,205`             | `contentDisposition` honoured, default `inline` only for an image with `cid`; `connectionTimeout`/`greetingTimeout`/`socketTimeout`/`dnsTimeout` honoured; a 5-minute DNS cache whose `dnsTtl` the SMTP connection never passes |
| `@google-cloud/storage` 7.22.0 / 8.4.0 / 9.0.0                      | measured (§3.4), `9.0.0` `build/cjs/src/storage.d.ts:36-66`                                                                                                      | `StorageOptions.apiEndpoint`, `retryOptions.autoRetry`; `bucket.exists()`, `file.getSignedUrl({ expires })` reads a number as ms                                                                                                |
| `@azure/storage-blob` 12.34.0                                       | `dist/esm/BlobServiceClient.d.ts:209`, `Clients.d.ts:881,1160`, `ContainerClient.d.ts:527`, `sas/BlobSASPermissions.d.ts:17`, `models.d.ts:305`                  | `BlobServiceClient.fromConnectionString`, `BlobClient.generateSasUrl({ permissions, expiresOn })`, `exists()`, `BlobSASPermissions.parse('r')`, `abortSignal` on every operation's options                                      |
| `@azure/keyvault-secrets` 4.12.0                                    | `dist/esm/secretsModels.d.ts:20`, `index.d.ts:374`                                                                                                               | `SecretClientOptions.disableChallengeResourceVerification`; `listPropertiesOfSecrets().byPage({ maxPageSize })`                                                                                                                 |
| `@google-cloud/secret-manager` 5.6.0                                | `build/src/v1/secret_manager_service_client.d.ts:335,586`                                                                                                        | `accessSecretVersion(request, options?: CallOptions)`, `listSecrets(request, options?)`; `CallOptions.timeout`                                                                                                                  |
| AWS SDK v3 3.1169.0                                                 | `@smithy/types@4.20.0/dist-types/http.d.ts:104`; `client-sesv2/dist-types/commands/GetAccountCommand.d.ts`; `client-secrets-manager/.../ListSecretsCommand.d.ts` | `client.send(command, { abortSignal })`; `GetAccountCommand`, `ListSecretsCommand({ MaxResults })` exist                                                                                                                        |
| Localization catalogue body                                         | `packages/localization-plugin/src/routes/catalogue-route.ts:115-157`; `common/src/services/localization.ts:58`                                                   | flat `Record<key, message>`; bodies built once at register                                                                                                                                                                      |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                    | Resolution (picked side)                                                                  | Doc deliverable (same PR)                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| C1  | `gcs-provider.ts:260` and `azure-provider.ts:342` say the real adapter probes; `docs/health-indicators.md` row 3 says storage probes exist  | the code changes to match (§3.9)                                                          | the two comments rewritten; `docs/health-indicators.md` row 3 and the SES/secrets rows corrected |
| C2  | `gcs-provider.ts:427` comment "expires is epoch-seconds"                                                                                    | the SDK is right (ms)                                                                     | the comment deleted with the fix                                                                 |
| C3  | storage README says only `bucket` is required for `'b2'`                                                                                    | `b2` needs `region` or `endpoint` (§3.7)                                                  | README options table and PUBLIC_API.md                                                           |
| C4  | secrets README names only `@azure/keyvault-secrets` and shows `deno add`; its "What `set()` means" table says gcp/azure "no local emulator" | the code: `@azure/identity` is required; the package set is npm-first; X123 ran both arms | secrets README install block, peer list and `set()` table                                        |
| C5  | feature-flags README says npm installs the LaunchDarkly SDK alongside                                                                       | it is an optional peer                                                                    | feature-flags README sentence                                                                    |
| C6  | storage README and agent card document `400` for a disallowed type                                                                          | `415` (§3.14)                                                                             | README, agent card, PUBLIC_API.md, upgrade note                                                  |
| C7  | `IStorage.delete` JSDoc "`true` if an object was deleted" vs S3's idempotent delete                                                         | §3.3 per-provider table; the `common` JSDoc is outside this lane                          | storage README table now; JSDoc correction handed to M143i/M143n (hand-over notes)               |

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
  timers when constructed directly); the signal is forwarded natively where the SDK takes one — AWS
  `client.send(command, { abortSignal })`, Azure `{ abortSignal }` on every operation, gax
  `{ timeout: requestTimeoutMs }` call option on `gcp` secrets, SendGrid `fetch(…, { signal })`. GCS
  takes no signal; the race bounds the caller and the dangling request is left to the SDK. Expiry
  error: storage → `BackendOutcomeUnknownError` (504), secrets → `SecretProviderUnavailableError`
  (503, as Vault), mail → `BackendOutcomeUnknownError` (504: a send may have gone out). SMTP keeps
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
  deadline error → `BackendOutcomeUnknownError`; (2) `toBackendFault(error, label)`; (3) an HTTP
  status the backend answered, read from the three SDK shapes (`$metadata.httpStatusCode`,
  `statusCode`, numeric `code`): `502`/`503` → `BackendUnavailableError`, `500`/`504` →
  `BackendOutcomeUnknownError`; (4) anything else →
  `new Error('storage-plugin (<provider>): <operation> failed: <cause message>', { cause })` (masked
  500, provider named in the log). The label is `storage-plugin (<provider>): <operation>`. A
  missing object is `StorageObjectNotFoundError` — a new `common` file (§4) with a `404` hint,
  detail "The requested object was not found.", the key in `message` (log) only — thrown by
  `StorageService` where it throws a plain `Error` today. Secrets: each SDK provider maps an outage
  — `isConnectionFault`, our deadline, an answered HTTP `>= 500`, gRPC code `14`/`4` — to
  `SecretProviderUnavailableError` (503); anything else rethrown as
  `Error('<ProviderName> <get|set> failed: <msg>', { cause })`. Mail: `ses`/`sendgrid` send failures
  go through `toBackendFault` (503/504); unrecognised ones are unchanged (SendGrid already names
  itself).
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
  `DeleteObject` answers 204 for an absent key, so `s3`/`b2` resolve `true` for one — stated in the
  README per provider. Memory and local keep their behaviour. The provider × case outcomes are one
  table in `exists-delete-conformance.test.ts` that the test iterates (fakes per provider), and the
  same table's rows are re-run against the real SDKs on the stand-ins.
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
- **Test home:** `gcs-outage-real.test.ts` (real SDK, in-test 502/503 server, child process alive
  and rejection observed); `gcs-provider.test.ts` (peek branches with fakes).

### 3.5 GCS signed URLs (V13-234)

- **Decision:** `expires = now() + expiresIn * 1000` (epoch ms).
- **Test home:** `gcs-provider.test.ts` (fake records `expires`); guarded `gcs-standin.test.ts`
  signs with a locally generated service-account key and fetches the URL from fake-gcs-server.

### 3.6 GCS endpoint (V13-248)

- **Decision:** `GcsProviderOptions.endpoint` → SDK `apiEndpoint` (the SDK appends `/storage/v1` and
  `/upload/storage/v1`, measured). Same name as `S3ProviderOptions.endpoint`.
- **Test home:** `gcs-provider.test.ts` (fake module records the config); `gcs-standin.test.ts`.

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
  given (no spread); the provider owns the 404 → `null`/`false` mapping, so a raw
  `BlobServiceClient` works through `get`, `put`, `exists`, `delete`, `getStream` and signs through
  `generateSasUrl` when it holds a shared key.
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
  credential may lack the list permission. `s3`/`b2` keep their `head('')` probe unchanged.
- **Test home:** `*-health.test.ts` per provider (fake modules, rule table), guarded stand-in runs.

### 3.10 LaunchDarkly outage at boot is bounded (V13-232)

- **Decision:** `start()` passes `{ timeout: initTimeoutSeconds }` and also wraps the wait in
  `withDeadline(initTimeoutSeconds * 1000)`, so an injected client that ignores the option is
  bounded too; the post-init `allFlagsState` refill runs under the same bound. The facade type
  becomes `waitForInitialization(options?: { readonly timeout?: number })`. Expiry keeps today's
  documented degraded start (warn, fallback values, `status()` unhealthy).
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
  the provider resolves.
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
  `multipart/form-data` with the file field as `format: binary`.
- **Test home:** `common` `upload-metadata.test.ts`; storage `upload-middleware.test.ts` reads the
  brand back.

### 3.16 A worker task can be withdrawn (V13-131)

- **Decision:** new `common/src/services/worker-run-signal.ts`:
  `interface WorkerRunSignalOptions extends WorkerRunOptions { readonly signal?: AbortSignal }`
  (additive; the Core lane may fold the field into `WorkerRunOptions` later).
  `WorkerPoolService.run` takes `WorkerRunSignalOptions`. An aborted signal before `run` → rejects
  with `signal.reason`, nothing queued; abort while queued → removed from `pending`, rejected with
  `signal.reason`; abort while running → the worker is terminated as the timeout path does and the
  call rejects with `signal.reason`. The listener is removed on every settle. A withdrawn task
  counts as neither `completed` nor `failed`.
- **Test home:** `task-pool-abort.test.ts` (real worker threads: queued withdrawal frees the queue
  slot; running withdrawal terminates and replaces the worker; pre-aborted).

### 3.17 Catalogue key filter (V12-132)

- **Decision:** `exposeCatalogues.keyPrefixes?: readonly string[]`; when present, each served body
  holds only keys starting with one of the prefixes (after the default-locale overlay). Validated at
  register: a non-empty array of non-empty strings, else `TypeError` naming the option.
- **Test home:** `catalogue-route.test.ts`.

### 3.18 Azure Key Vault options and README (V13-255)

- **Decision:** `disableChallengeResourceVerification?: boolean` on `AzureKeyVaultProviderOptions`
  and `SecretsProviderOptions`, passed to `new SecretClient(url, credential, { … })`; README names
  `@azure/identity` beside `@azure/keyvault-secrets` and every install line is `npm install`.
- **Test home:** `azure-key-vault.test.ts` (fake records the options); guarded
  `azure-key-vault-standin.test.ts` on Lowkey Vault (read, rotate, bound, outage → 503).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** an injected `ILaunchDarklyClient` now receives
`waitForInitialization({ timeout })` instead of `{ timeoutSeconds }`; behaviour changes listed in
the upgrade note (415, `exists`/`delete` reject on outage, classified 503/504/404, GCS SDK retry
off, `b2` needs a region or endpoint, Slack text carries the subject, SMTP inline disposition).
Ships in minor `0.14.0`.

| Exported symbol                                  | Kind      | Consumer / real code path that READS it                                            |
| ------------------------------------------------ | --------- | ---------------------------------------------------------------------------------- |
| `StorageObjectNotFoundError` (common)            | class     | `StorageService` throws it; `errorHandler` reads its hint; R2 (M143o) may throw it |
| `UPLOAD_METADATA`, `withUploadMetadata` (common) | symbol/fn | `createUploadMiddleware` brands with it                                            |
| `uploadMetadataOf` (common)                      | fn        | openapi-plugin generator (M143l); storage test reads it back                       |
| `UploadMetadata` (common)                        | type      | parameter/return type of the two functions                                         |
| `WorkerRunSignalOptions` (common)                | type      | `WorkerPoolService.run` parameter; applications pass `{ signal }`                  |

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
| `WorkerRunSignalOptions.signal`                                                                                                               | `TaskPool.run`                                   | §3.16                             |

## 5. Implementation files

| File                                                                                                             | Purpose                                           |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `packages/common/src/index.ts`                                                                                   | three new export lines                            |
| `packages/common/src/errors/storage-object-not-found.ts`                                                         | §3.2 class                                        |
| `packages/common/src/form/upload-metadata.ts`                                                                    | §3.15 brand                                       |
| `packages/common/src/services/worker-run-signal.ts`                                                              | §3.16 type                                        |
| `packages/storage-plugin/src/providers/fault.ts`                                                                 | §3.2 internal classifier                          |
| `packages/storage-plugin/src/providers/{s3,gcs,azure}-provider.ts`                                               | §3.1–3.9                                          |
| `packages/storage-plugin/src/plugin/storage-plugin.ts`                                                           | timing, `requestTimeoutMs`, endpoints, b2 refusal |
| `packages/storage-plugin/src/services/storage-service.ts`                                                        | `StorageObjectNotFoundError`                      |
| `packages/storage-plugin/src/interfaces/index.ts`                                                                | option fields                                     |
| `packages/storage-plugin/src/middleware/upload-middleware.ts`                                                    | 415, brand                                        |
| `packages/secrets-plugin/src/providers/{aws-kms,gcp-secret-manager,azure-key-vault}.ts`                          | bound, classification, probes, Azure option       |
| `packages/secrets-plugin/src/plugin/secrets-plugin.ts`, `src/interfaces/index.ts`                                | pass timing and new options                       |
| `packages/mail-plugin/src/providers/{ses,sendgrid,smtp}-provider.ts`                                             | §3.1, §3.9, §3.11, §3.12                          |
| `packages/mail-plugin/src/plugin/mail-plugin.ts`, `src/interfaces/index.ts`                                      | pass timing, `runtime.dns`, options               |
| `packages/notification-plugin/src/channels/slack-channel.ts`                                                     | §3.13                                             |
| `packages/feature-flags-plugin/src/providers/launchdarkly-{provider,module}.ts`                                  | §3.10                                             |
| `packages/worker-pool-plugin/src/{pool/task-pool.ts,services/worker-pool-service.ts}`                            | §3.16                                             |
| `packages/localization-plugin/src/{interfaces/index.ts,routes/catalogue-route.ts,plugin/localization-plugin.ts}` | §3.17                                             |
| READMEs and agent cards of the seven packages, `docs/health-indicators.md`                                       | §2                                                |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                                     | src covered                          | Key assertions (and the signature each call type-checks against)                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `common/test/unit/storage-object-not-found.test.ts`                                                                                           | `errors/storage-object-not-found.ts` | name, key in message, 404 hint with fixed detail                                                                     |
| `common/test/unit/upload-metadata.test.ts`                                                                                                    | `form/upload-metadata.ts`            | brand round trip; foreign/invalid values absent; non-enumerable                                                      |
| `common/test/unit/worker-run-signal.test.ts`                                                                                                  | `services/worker-run-signal.ts`      | type-level: assignable to `WorkerRunOptions`; barrel export                                                          |
| `storage-plugin/test/unit/storage-fault.test.ts`                                                                                              | `providers/fault.ts`                 | table: deadline, ECONNREFUSED, ECONNRESET, 502/503/500/504 per SDK shape, 403 → named plain Error                    |
| `storage-plugin/test/unit/exists-delete-conformance.test.ts`                                                                                  | the three providers                  | §3.3 table iterated                                                                                                  |
| `storage-plugin/test/unit/{s3,gcs,azure}-provider.test.ts` (extended)                                                                         | providers                            | §3.4–3.8 branches with fake modules; configs recorded                                                                |
| `storage-plugin/test/unit/storage-deadline.test.ts`                                                                                           | providers + plugin                   | real SDKs vs black-hole server settle within bound; `RangeError` table                                               |
| `storage-plugin/test/integration/gcs-outage-real.test.ts`                                                                                     | gcs provider                         | real SDK, 502/503 server, process alive, 503 class                                                                   |
| `storage-plugin/test/unit/providers/{gcs,azure}-health.test.ts` (extended)                                                                    | probes                               | §3.9 rule table                                                                                                      |
| `storage-plugin/test/unit/storage-plugin.test.ts`, `storage-service.test.ts`                                                                  | plugin, service                      | b2 refusal; options passed; not-found class                                                                          |
| `storage-plugin/test/unit/upload-refusal-status.test.ts`, `upload-middleware.test.ts`                                                         | middleware                           | 415; brand read back                                                                                                 |
| `storage-plugin/test/integration/{gcs,azure,s3}-standin.test.ts` (guarded `GCS_EMULATOR_URL`, `AZURITE_CONNECTION_STRING`, `S3_ENDPOINT_URL`) | real SDKs                            | upload/download/exists/delete/signed URL round trip; outage (stopped stand-in) → 503; credential refused → named 500 |
| `secrets-plugin/test/unit/secrets-fault.test.ts`, `secrets-deadline.test.ts`, provider tests extended                                         | three providers, plugin              | classification table; bounds with real SDKs vs black hole; probes; Azure option                                      |
| `secrets-plugin/test/integration/{aws-kms,azure-key-vault}-standin.test.ts` (guarded `AWS_ENDPOINT_URL`, `LOWKEY_VAULT_URL`)                  | real SDKs                            | read/rotate; outage → 503                                                                                            |
| `mail-plugin/test/unit/{smtp,ses,sendgrid}-provider.test.ts` (extended), `ses-capture.test.ts`                                                | providers, plugin                    | inline; config; DNS rebuild; endpoint; bound; probe                                                                  |
| `mail-plugin/test/integration/smtp-standin.test.ts` (guarded `SMTP_URL`)                                                                      | smtp                                 | inline part read back from Mailpit                                                                                   |
| `notification-plugin/test/unit/slack-channel.test.ts`, `slack-capture.test.ts`                                                                | slack channel                        | subject in text; wire shape                                                                                          |
| `feature-flags-plugin/test/unit/launchdarkly-provider.test.ts`, `launchdarkly-real.test.ts`                                                   | LD provider/module                   | bounded start, option name                                                                                           |
| `worker-pool-plugin/test/unit/task-pool-abort.test.ts`                                                                                        | task pool, service                   | §3.16                                                                                                                |
| `localization-plugin/test/unit/catalogue-route.test.ts` (extended)                                                                            | route, plugin validation             | §3.17                                                                                                                |

Every fix's test is shown failing on the parent commit before the fix lands (recorded in the PR).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m143r-provider-arms, never develop or main
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test:coverage common storage-plugin secrets-plugin mail-plugin notification-plugin feature-flags-plugin worker-pool-plugin localization-plugin
flock ~/.cache/setu-ts/locks/suite.lock pnpm run ci:local
pnpm run release:publish --dry-run
pnpm run release:verify 0.14.0
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
