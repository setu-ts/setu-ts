# Milestone 139c — AI-layer and data contracts with a missing half (`agent-runs-plugin` + `idempotency-plugin` + `vector-store-plugin` + `auth-plugin` + `multi-tenancy-plugin` + `database-plugin` + `mail-plugin` + `common`)

> **Status:** Planning. Branch: `feat/m139c-ai-data-contracts`. `develop` and `main` are protected,
> so all work, including fixes, stays on this one branch until it merges through a single PR into
> `develop`.

## 0. Objective & scope

Six rows from the `0.12.0` review (`smoke/V0120-REVIEW.md`). Each is a contract that ships one half
of what a caller needs:

- **V12-4:** agent-runs requires a transactional idempotency store, but nothing checks for one, so
  the app boots healthy and fails at the first tool call.
- **V12-9:** `replaceSource` deletes everything a call did not name, but caps a call at 500 records,
  so a source over 500 records cannot be held.
- **V12-10:** pgvector `ensure: 'verify'` checks index names, never what the indexes are.
- **V12-36:** a quota can be charged but never read.
- **V12-20:** tenant repositories cannot join a transaction.
- **V12-21:** mail has no attachments.

Each row closes on its owning package, with the shared contract widened in `common` where the
contract lives there.

- **In scope:**
  - V12-4: an `IIdempotencyService.transactional` flag, and an agent-runs registration refusal.
  - V12-9: a 5,000-record `replaceSource` call, chunked per statement in pgvector and Qdrant.
  - V12-10: the pgvector describe query checks each index's table, access method, column and
    operator class.
  - V12-36: `IQuota.usage(key)` and `IQuotaStore.read`.
  - V12-20: an optional unit of work on `getRepository` and `getRepositoryFor`, implemented by
    `DatabaseTenantDataStore`.
  - V12-21: `MailMessage.attachments` across all four providers.
  - The README, `PUBLIC_API.md` and CHANGELOG text for each row.
- **NOT this milestone:**
  - A configurable distance metric for vector collections. Every collection is cosine today (§1).
    Adding a metric is a feature, not this row.
  - A `replaceSource` for sources over 5,000 records, which would need a staged replace across
    calls. No milestone owns it; §9 records it.
  - Mail attachment streaming from storage. Attachments are in-memory bytes.
  - The remaining M139 letters (b, d–g).

## 1. Contracts verified from SOURCE (not names)

| Reference                                | Source (file:line)                                                                                                                                                                                                                                                          | Verified surface / fact                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IIdempotencyService`                    | `packages/common/src/services/idempotency.ts:402-447`                                                                                                                                                                                                                       | `middleware`, `behavior`, `within`, `purgeTransactional`. No member reports whether a transactional store is configured.                                                                                                                                                                                                                      |
| `within` without `transactional`         | `packages/idempotency-plugin/src/service/idempotency-service.ts:95-101`                                                                                                                                                                                                     | Rejects `IdempotencyConfigurationError('transactional', 'idempotency: within requires the transactional option')`.                                                                                                                                                                                                                            |
| Transactional presence known at register | `packages/idempotency-plugin/src/plugin/idempotency-plugin.ts:38-41,83-92`                                                                                                                                                                                                  | `transactional` is resolved from options in the factory; `setupTransactional` state becomes defined only in its `onInit` (`within/transactional-runtime.ts:210`). So "configured" is known at `register`, "ready" only after `onInit`.                                                                                                        |
| `IIdempotencyService` implementors       | `idempotency-service.ts`; test doubles in `common/test/unit/idempotency-contract.test.ts`, `decorator-plugin/test/integration/idempotent-registration.test.ts`, `idempotency-plugin/test/unit/idempotent.test.ts` and `idempotency-plugin/test/fixtures/within-backends.ts` | One real implementation. Every test double gains the member; `pnpm run check` over the workspace finds any this list misses. The agent-runs harness (`test/fixtures/harness.ts:162`) already registers a transactional store, so it keeps booting.                                                                                            |
| agent-runs registration                  | `packages/agent-runs-plugin/src/plugin/agent-runs-plugin.ts:105-134`                                                                                                                                                                                                        | `dependencies: [RUNTIME, IDEMPOTENCY]`; `register` reads the service with `ctx.services.get` and never checks it. Every tool call goes through `deps.idempotency.within` (`loop/tool-runner.ts:70`).                                                                                                                                          |
| agent-runs docs                          | `packages/agent-runs-plugin/README.md:28-30`, `AGENT_CARD.md:18-24`                                                                                                                                                                                                         | Both state that the transactional store is required.                                                                                                                                                                                                                                                                                          |
| Vector write cap                         | `packages/vector-store-plugin/src/services/limits.ts:14-15`, `record-validation.ts:120-122`                                                                                                                                                                                 | `MAX_RECORDS_PER_CALL = 500` (pgvector's bind-parameter budget), enforced by `validateRecords` for both `upsert` and `replaceSource`.                                                                                                                                                                                                         |
| `replaceSource` service                  | `packages/vector-store-plugin/src/services/vector-store-service.ts:88-115`                                                                                                                                                                                                  | Validates the records, checks each `sourceId`, then calls `adapter.replaceSource` once with all records.                                                                                                                                                                                                                                      |
| pgvector `replaceSource`                 | `src/adapters/pgvector/pgvector-store.ts:237-277`; `pgvector-sql.ts` `upsertStatement`, `deleteStaleStatement`, `sourceLockStatement`                                                                                                                                       | One transaction: advisory lock, optional version check, ONE multi-row upsert statement, then a stale delete whose keep list is one `jsonb` parameter. Seven bind parameters per row in the upsert.                                                                                                                                            |
| Qdrant `replaceSource`                   | `src/adapters/qdrant/qdrant-store.ts:203-275`                                                                                                                                                                                                                               | No transaction. Unversioned: `this.upsert` (one request with every point), then a stale delete with `has_id: kept`. Versioned: one upsert with `update_filter`, a count, then the stale delete.                                                                                                                                               |
| Vectorize `replaceSource`                | `packages/cloudflare-plugin/src/vectorize/vectorize-store.ts:210-214`                                                                                                                                                                                                       | Refuses with `VectorOperationUnsupportedError`. Unaffected by the cap.                                                                                                                                                                                                                                                                        |
| Adapter port                             | `packages/common/src/services/vector-store.ts:296-302`                                                                                                                                                                                                                      | `IVectorStoreAdapter.replaceSource(spec, scope, sourceId, records, version?)`.                                                                                                                                                                                                                                                                |
| pgvector DDL                             | `pgvector-sql.ts` `tableNames`, `createStatements`                                                                                                                                                                                                                          | Table `vs_<name>`; `vs_<name>_src` ON `(scope, source_id)`; `vs_<name>_hnsw` `USING hnsw (embedding vector_cosine_ops)`. Queries use `<=>` (`pgvector-sql.ts:276`).                                                                                                                                                                           |
| pgvector verify                          | `pgvector-sql.ts` `describeStatement`; `pgvector-store.ts:180-224`                                                                                                                                                                                                          | `to_regclass(<index name>) IS NOT NULL` for each index, plus `atttypmod`. An index of the right name on another table, another column, another access method or another operator class passes.                                                                                                                                                |
| No declared metric                       | `grep metric` over `common/src/services/vector-store.ts` and `vector-store-plugin/src`                                                                                                                                                                                      | No matches. Every collection is cosine. The README's "dimensions or metric" (`README.md:403`) describes a check that does not exist.                                                                                                                                                                                                          |
| `IQuota`, `IQuotaStore`, `createQuota`   | `packages/auth-plugin/src/quota/quota.ts:16-29,46-53,95-160`                                                                                                                                                                                                                | `IQuota` has `reserve`, `settle` and `release`; `IQuotaStore` has `reserve`, `adjust` and optional `close`. `currentWindow` computes `{ id, end, expireAt }`. The store key is `${name}:${key}`. Key validation is inline in `reserve`. The limit comes from a number or a callback.                                                          |
| Quota stores                             | `memory-quota-store.ts:13-56`, `redis-quota-store.ts:44-121`                                                                                                                                                                                                                | Memory: `#used(storeKey)` reads with expiry. Redis: `eval` only (the client port is `eval` + `quit`), wrapping failures in `QuotaStoreUnavailableError`.                                                                                                                                                                                      |
| `IMultiTenancyService` repositories      | `packages/common/src/services/tenancy.ts:89-115`                                                                                                                                                                                                                            | `getRepository(ctx, entity)` and `getRepositoryFor(tenantId, entity)`; neither takes a unit of work.                                                                                                                                                                                                                                          |
| `ITenantDataStore`                       | `packages/common/src/services/tenancy.ts:226-292`                                                                                                                                                                                                                           | `useIsolation?`, `findAll`, `findById`, `find`, `create`, `update`, `delete`, `updateWhere?`, `deleteWhere?`, `close?`. Every method takes `tenantId` and `entity`.                                                                                                                                                                           |
| Tenancy service                          | `packages/multi-tenancy-plugin/src/services/multi-tenancy-service.ts:85-109`                                                                                                                                                                                                | Both methods build `new TenantRepository(this.requireStore(), tenantId, entity)`.                                                                                                                                                                                                                                                             |
| `DatabaseTenantDataStore`                | `packages/database-plugin/src/tenancy/database-tenant-data-store.ts:128-160,206-210`                                                                                                                                                                                        | Holds an `IDatabaseService`; every operation goes through `#repo(entity)` = `this.#service.getRepository(entity)`. Column resolution is `#column(entity)`.                                                                                                                                                                                    |
| `IUnitOfWork`                            | `packages/database-plugin/src/interfaces/index.ts:192-203,236`                                                                                                                                                                                                              | `getRepository<Entity, Id>(entity): IRepository<Entity, Id>`, handed out by `IDatabaseService.transaction(work)`. It lives in database-plugin, not common.                                                                                                                                                                                    |
| Structural unit-of-work precedent        | `packages/common/src/services/outbox.ts:175-200`                                                                                                                                                                                                                            | `IOutboxWriteScope` is a structural slice `{ getRepository(entity): { create } }` that database-plugin's `IUnitOfWork` satisfies. The same pattern serves tenancy.                                                                                                                                                                            |
| `MailMessage`                            | `packages/common/src/services/mail.ts:11-26`                                                                                                                                                                                                                                | `to`, `from?`, `subject`, `html?`, `text?`, `cc?`, `bcc?`. `sendTemplate` takes `Omit<MailMessage, 'html' \| 'text'>`, so a new field flows through templates.                                                                                                                                                                                |
| Mail funnel                              | `packages/mail-plugin/src/services/mail-service.ts:76-99,141-147`                                                                                                                                                                                                           | `send` and `sendTemplate` both reach `provider.send(this.#resolve(...))`. `#resolve` is the one place to validate.                                                                                                                                                                                                                            |
| SES v2 attachments                       | `@aws-sdk/client-sesv2@3.1156.0` `dist-types/models/models_0.d.ts:144-191,570`                                                                                                                                                                                              | `Message.Attachments?: Attachment[]`; `Attachment { RawContent: Uint8Array; FileName: string; ContentType?; ContentDisposition?: 'ATTACHMENT' \| 'INLINE'; ContentId?; ContentTransferEncoding?; ContentDescription? }`. The peer range is `^3`, so the implementation probes the real SDK and states the minimum version that has the field. |
| nodemailer attachments                   | `nodemailer@10.3.1` `dist/esm/mailer/mail-message.js:175,194`                                                                                                                                                                                                               | Attachment content is checked with `Buffer.isBuffer`. A bare `Uint8Array` is not a `Buffer`, so the portable form is `content: <base64 string>, encoding: 'base64'` (no `Buffer` outside `packages/runtime`).                                                                                                                                 |
| SendGrid v3                              | `packages/mail-plugin/src/providers/sendgrid-provider.ts:30-55`                                                                                                                                                                                                             | Builds the `/v3/mail/send` JSON body. The v3 API takes `attachments: [{ content (base64), filename, type?, disposition?, content_id? }]`; the implementation checks this against SendGrid's v3 reference, with the URL cited in the test.                                                                                                     |
| Log provider                             | `packages/mail-plugin/src/providers/log-provider.ts:82-96`                                                                                                                                                                                                                  | Keeps the message in memory and in `sink`, and logs `from`, `to` and `subject`.                                                                                                                                                                                                                                                               |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                      | Resolution (picked side)                                                                                                             | Doc deliverable (same PR)                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| C1  | The vector-store README says `VectorCollectionMismatchError` covers "dimensions or metric" (`README.md:403`); no metric exists or is checked. | The code wins. The error covers dimensions, a missing `source_version` column and the shape of the two indexes.                      | Rewrite the errors-table row and add a "Verify mode" paragraph naming `vs_<name>_src` and `vs_<name>_hnsw` with their DDL. |
| C2  | The ROADMAP M139c package line omits `database-plugin` and `idempotency-plugin`, which V12-20 and V12-4 change.                               | The plan wins: both are changed.                                                                                                     | Correct the ROADMAP M139c package line and its Progress Tracking row.                                                      |
| C3  | The ROADMAP marks M139c as a `fix` letter, but §4 adds required members to three published interfaces.                                        | It ships in `0.13.0`, the next release, which is a minor. The breaks are listed in the CHANGELOG under BREAKING with migration text. | CHANGELOG BREAKING entries (§4).                                                                                           |

## 3. Design decisions

### 3.1 V12-4: agent-runs refuses at registration without a transactional store

- **Decision:**
  - `IIdempotencyService` gains a required `readonly transactional: boolean`.
  - `IdempotencyService` sets it to `true` exactly when the plugin was given a `transactional`
    option, the same `transactional === undefined` test the factory already makes. It reports
    configuration, not readiness, because readiness exists only after `onInit`. A configured store
    that fails to start already fails `onInit` itself.
  - `AgentRunsPlugin.register` reads the service and, when `transactional` is not `true` (a missing
    member counts as not `true`), throws before registering its service:

    ```ts
    new TypeError("Agent runs: register IdempotencyPlugin with a transactional store (transactional: { store: createDatabaseIdempotencyStore() }) before this plugin.")
    ```

  - The application therefore does not start, which matches the plugin's other option refusals.
  - The check applies whatever the definitions declare. The README already states the store is
    required for every run, because a run's tools are only known at call time.
- **Why:** this is the boot-time refusal the row asks for. A probe `within` call would open a
  database transaction at boot, so it is rejected. A flag keeps the check a property read.
- **Test home:**
  - `agent-runs-plugin/test/unit/plugin.test.ts`: refusal with a plain `IdempotencyPlugin()`;
    refusal with a fake lacking the member; boot with the transactional option.
  - `idempotency-plugin/test/unit/idempotency-plugin.test.ts`: the resolved service's flag is
    `false` without the option and `true` with it.

### 3.2 V12-9: one `replaceSource` call holds up to 5,000 records

- **Decision:**
  - A new internal constant `MAX_RECORDS_PER_REPLACE = 5_000` sits in `services/limits.ts`.
  - `validateRecords` takes the cap as a fourth parameter, and its `VectorRecordError` message names
    that cap (`a replaceSource call takes at most 5000 records` /
    `an upsert takes at most 500 records`): `upsert` passes `MAX_RECORDS_PER_CALL` (500, unchanged)
    and `replaceSource` passes `MAX_RECORDS_PER_REPLACE`.
  - Adapters split the write; the service still calls `adapter.replaceSource` once:
    - **pgvector:** inside the existing single transaction, issue one `upsertStatement` per slice of
      at most `MAX_RECORDS_PER_CALL` records, then the one stale delete. Atomicity and the advisory
      lock are unchanged.
    - **Qdrant:** issue one upsert request per slice of at most 500 points, in both the unversioned
      and the versioned arm. The versioned arm sends each slice with the same `update_filter`. The
      count and stale-delete steps are unchanged. Qdrant has no transaction in any arm; the README
      already says so.
    - **Memory:** no change.
    - **Vectorize:** still refuses.
  - The `IVectorStore.replaceSource` JSDoc in common states the 5,000 cap, and that the call
    replaces the WHOLE source, so a source cannot be written across several calls.
  - The `IVectorStoreAdapter.replaceSource` JSDoc states that an adapter receives up to 5,000
    records and must write them all before the stale delete.
  - The README puts the two rules side by side: one call replaces the whole source, and one call
    takes at most 5,000 records.
- **Why:** the row's failure is a caller who splits the document because of the cap. Raising the cap
  to a size a long document fits in (5,000 × ~800 characters ≈ 4 M characters), while keeping each
  statement inside pgvector's parameter budget, removes the need to split. 5,000 rather than more
  bounds the vectors one call holds in memory (5,000 × 2,000 dimensions = 10 M numbers).
- **Test home:**
  - `validation.test.ts`: 5,000 is accepted by replace, and 5,001 and an `upsert` of 501 are
    refused.
  - `pgvector-store.test.ts`: 1,201 records give three upsert statements and one stale delete in one
    transaction.
  - `qdrant-store.test.ts`: 1,201 records give three upsert calls in both arms.
  - `conformance.test.ts`: a 1,200-record source replaced in one call, then replaced with 700
    records, leaves exactly 700, read back through `count`/`query`, on memory and on guarded real
    pgvector and Qdrant.

### 3.3 V12-10: pgvector verify checks what the indexes are

- **Decision:**
  - `describeStatement` replaces the two `to_regclass(...) IS NOT NULL` columns with two `EXISTS`
    subqueries over `pg_index`, `pg_class`, `pg_am`, `pg_opclass` and `pg_attribute`. Each subquery
    matches the named index (`indexrelid = to_regclass(<name>)`) AND `indrelid = <the table>`.
  - `source_index` is true only when the index's key columns are exactly `(scope, source_id)` in
    that order.
  - `vector_index` is true only when the index has one key column, `embedding`, access method `hnsw`
    and operator class `vector_cosine_ops`.
  - `ensureCollection` keeps its error, with messages naming the expected shape:
    - `pgvector: 'vs_docs' is missing its HNSW index: expected vs_docs_hnsw ON vs_docs USING hnsw (embedding vector_cosine_ops).`
    - The same form for the source index, `vs_docs_src ON vs_docs (scope, source_id)`.
  - In `ensure: 'create'` mode, the `CREATE INDEX IF NOT EXISTS` statements do not replace a wrong
    index of the same name. The same check therefore also refuses there, with the same message.
- **Why:** a wrong-operator-class index silently degrades every query to a sequential scan, or
  orders by a metric the scores do not describe. Failing closed at boot is the contract the README
  claims.
- **Test home:**
  - `pgvector-store.test.ts`: each describe column false gives its named message.
  - `conformance.test.ts`, guarded real pgvector: a table whose `vs_<n>_hnsw` uses `vector_l2_ops`
    is refused in both modes. So is an index of the right name on another table, or on
    `(source_id, scope)`. The `create`-made table passes.

### 3.4 V12-36: a quota can be read

- **Decision:**
  - `IQuotaStore` gains a required `read(key: string, windowId: string): Promise<number>`, the
    window's used units, `0` when absent or expired.
    - Memory implements it with `#used(storeKey)`.
    - Redis implements it with one `eval` of `return redis.call('GET', KEYS[1]) or '0'`, parses the
      reply to a non-negative safe integer, and wraps a malformed reply or failure in
      `QuotaStoreUnavailableError`, as `reserve` does.
  - `IQuota` gains `usage(key: string): Promise<QuotaUsage>`, where:

    ```ts
    type QuotaUsage = {
      readonly used: number;
      readonly limit: number | undefined;
      readonly remaining: number | undefined;
      readonly windowEndsAt: number;
    };
    ```

    - `limit` is `undefined` for unlimited.
    - `remaining` is `max(0, limit - used)`, or `undefined` when unlimited.
    - `windowEndsAt` is the epoch-millisecond end of the current window from `currentWindow`.

  - `usage` validates the key with the SAME function `reserve` uses: the inline check is extracted
    to `validateKey`. It resolves the limit the SAME way, through an extracted `resolveLimit`, so a
    callback is called and its answer validated. It reads under the same `${name}:${key}` store key.
  - It never charges.
- **Why:** the row's budget meter needs used, limit and reset time from the counter that enforces
  them. One key and limit path means the meter cannot disagree with `reserve`.
- **Test home:**
  - `quota.test.ts`: after reserve 40 and settle 30, `usage` gives
    `{ used: 30, limit: 100, remaining: 70, windowEndsAt }`. An unlimited callback gives `undefined`
    for both. A bad key is the same `TypeError` as `reserve`'s. A new window reads `0`. `usage` and
    `reserve` reject the same key table.
  - `memory-quota-store.test.ts` and `redis-quota-store.test.ts`: the `read` reply table, including
    malformed replies, and the guarded real-Redis read-back after reserve.

### 3.5 V12-20: tenant repositories join a unit of work

- **Decision:**
  - `common` adds `ITenantUnitOfWork { getRepository(entity: string): unknown }`, a structural slice
    in the `IOutboxWriteScope` pattern that database-plugin's `IUnitOfWork` satisfies.
  - `ITenantDataStore` gains an optional
    `withUnitOfWork?(unitOfWork: ITenantUnitOfWork): ITenantDataStore`.
  - `IMultiTenancyService.getRepository(ctx, entity, unitOfWork?)` and
    `getRepositoryFor(tenantId, entity, unitOfWork?)` take an optional third argument.
  - With it, `MultiTenancyService` builds the `TenantRepository` over
    `store.withUnitOfWork(unitOfWork)`. A store without the method makes the call throw
    `TenantUnitOfWorkUnsupportedError` (new, multi-tenancy-plugin, status hint 500), which names the
    store's class.
  - `DatabaseTenantDataStore.withUnitOfWork(uow)` throws `TypeError` unless
    `typeof uow.getRepository === 'function'`. It returns a bound view in which:
    - every repository comes from `uow.getRepository(entity)`;
    - the tenant column still comes from the PARENT's `#column(entity)`, so the column adopted by
      `useIsolation` applies.
    - Every existing guard is unchanged: tenant stamping on create, tenant column stripped on
      update, conditional or owned-row checks, and the foreign-row refusal.
    - The view implements `findAll`, `findById`, `find`, `create`, `update`, `delete`, `updateWhere`
      and `deleteWhere` through the same code as the parent (one implementation, parameterized by
      where repositories come from), never a copy.
    - The view's `useIsolation` and `close` are absent: the parent owns both.
  - `MemoryTenantDataStore` does not implement it. The memory store has no transaction to join.
  - The README gains a "Transactions" section showing
    `db.transaction(async (uow) => { const repo = tenancy.getRepository(ctx, 'Order', uow); … })`,
    and that a write through the repository rolls back with the transaction.
- **Why:** the row asks for transactional writes without hand-scoping `IDatabaseService`
  repositories, which loses tenant stamping. Binding the existing store keeps every tenant guard on
  one code path.
- **Test home:**
  - `database-plugin/test/unit/database-tenant-data-store.test.ts`: the bound view reads and writes
    through the unit of work's repositories (a recording fake). The parent's column applies. A
    foreign row is still refused. A non-object unit of work gives `TypeError`.
  - `multi-tenancy-plugin/test/unit/tenant-unit-of-work.test.ts` (new): both entry points pass the
    unit of work, with the SAME bound behavior under a non-default tenant column. A memory store
    gives `TenantUnitOfWorkUnsupportedError`.
  - An integration test on the memory database adapter: a create through the tenant repository
    inside `db.transaction` that then throws is absent afterwards. A committed one reads back with
    its tenant column.

### 3.6 V12-21: mail attachments

- **Decision:**
  - `common` adds:

    ```ts
    interface MailAttachment {
      readonly filename: string;
      readonly content: Uint8Array | string; // a string is UTF-8 text
      readonly contentType?: string;
      readonly contentId?: string;
    }
    ```

    and `MailMessage.attachments?: readonly MailAttachment[]`. A `contentId` makes the attachment
    inline, for `cid:` references in `html`.

  - `MailService.#resolve`, the one funnel for `send` and `sendTemplate`, validates each attachment.
    It throws `TypeError` naming the index and field, never the content:
    - `filename`: 1–255 characters, well-formed, with no C0 control character or DEL (that covers
      CR/LF header injection).
    - `content`: a `Uint8Array` or a string.
    - `contentType`, when present: matches `^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$`, with no
      parameters.
    - `contentId`, when present: 1–255 characters of `[A-Za-z0-9!#$%&'*+/=?^_\`{|}~.@-]`, with no
      angle brackets or whitespace.
    - The resolved `OutgoingMail` carries the attachments with string content encoded to bytes, so
      every provider receives `Uint8Array`.
  - An internal `toBase64(bytes)` helper (in `src/providers/encoding.ts`, not exported) uses `btoa`
    over 32 KiB slices.
  - Each provider maps the attachments:
    - **SMTP:**
      `attachments: [{ filename, content: base64, encoding: 'base64', contentType?, cid? }]`.
    - **SES:**
      `Content.Simple.Attachments: [{ FileName, RawContent, ContentType?, ContentDisposition: 'INLINE' | 'ATTACHMENT', ContentId? }]`.
    - **SendGrid:**
      `attachments: [{ content: base64, filename, type?, disposition: 'inline' | 'attachment', content_id? }]`.
    - **Log:** keeps the message as today. Its log line adds
      `attachments: [{ filename, contentType, bytes }]` and never the content.
  - With no attachments, no provider sends the field.
  - No framework size cap: each provider's own limit refuses, and the README names them (SES 40 MB,
    SendGrid 30 MB, SMTP the server's).
- **Why:** all three real backends support attachments. Validation in the one funnel gives every
  provider the same refusal.
- **Test home:**
  - `mail-service.test.ts`: the refusal table, driven through `send` AND `sendTemplate`, with the
    same refusal from both.
  - Each provider test asserts the mapped field-by-field shape, and that no `attachments` field is
    sent when there are none.
  - The guarded real-import tests:
    - nodemailer `streamTransport` produces a MIME message whose decoded attachment bytes equal the
      input, and the inline `cid` appears.
    - The real `@aws-sdk/client-sesv2` `SendEmailCommand` input carries `Attachments`, serialized
      with a fake HTTP handler.
  - `log-provider.test.ts`: the log line has filename and size, and no content.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** these ship in minor `0.13.0`.

- `IIdempotencyService.transactional` is a required member.
- `IQuotaStore.read` is a required member.
- `IQuota.usage` is a required member.

A custom implementation of any of the three fails to type-check until it adds the member. Each gets
a CHANGELOG BREAKING entry with migration text. All other additions are optional members or
parameters.

| Exported symbol                                                        | Kind                      | Consumer / real code path that READS it                                                                    |
| ---------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `IIdempotencyService.transactional` (common)                           | interface member          | `AgentRunsPlugin.register` (§3.1)                                                                          |
| `IQuotaStore.read` (auth-plugin)                                       | interface member          | `createQuota(...).usage` (§3.4)                                                                            |
| `IQuota.usage` (auth-plugin)                                           | interface member          | Application budget meters; the `docs/ai.md` quota recipe gains a budget-meter route that calls it          |
| `QuotaUsage` (auth-plugin)                                             | type                      | Return type of `IQuota.usage`                                                                              |
| `ITenantUnitOfWork` (common)                                           | interface                 | Parameter of `IMultiTenancyService.getRepository`/`getRepositoryFor` and `ITenantDataStore.withUnitOfWork` |
| `ITenantDataStore.withUnitOfWork` (common)                             | optional interface member | `MultiTenancyService.getRepository`/`getRepositoryFor` (§3.5)                                              |
| `IMultiTenancyService.getRepository`/`getRepositoryFor` third argument | optional parameter        | Application transactional writes (§3.5)                                                                    |
| `TenantUnitOfWorkUnsupportedError` (multi-tenancy-plugin)              | class                     | Thrown by `MultiTenancyService`; an app catches it by class                                                |
| `MailAttachment` (common)                                              | interface                 | `MailMessage.attachments`; read by `MailService.#resolve` and all four providers                           |
| `OutgoingMail.attachments` (mail-plugin, exported)                     | type change               | Narrowed to byte content; read by the four providers and the log provider's `sink`                         |
| `MailMessage.attachments` (common)                                     | optional field            | `MailService.#resolve` and the providers (§3.6)                                                            |

### 4.1 Options — every option names its consumer

| Option | Consumer                            | Behavior (per implementation)                                                                        |
| ------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| None   | No plugin option is added (checked) | The idempotency flag derives from the existing `transactional` option, read by `IdempotencyService`. |

## 5. Implementation files

| File                                                                     | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/services/idempotency.ts`                            | `transactional` member and JSDoc                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/common/src/services/vector-store.ts`                           | `replaceSource` JSDoc on both interfaces: the 5,000 cap and whole-source semantics                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/common/src/services/tenancy.ts`                                | `ITenantUnitOfWork`, `withUnitOfWork?`, optional third parameters                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/common/src/services/mail.ts`                                   | `MailAttachment`, `MailMessage.attachments`                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/common/src/index.ts`                                           | Barrel exports for `ITenantUnitOfWork` and `MailAttachment`                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/idempotency-plugin/src/service/idempotency-service.ts`         | `transactional` from a new `transactionalConfigured: boolean` dependency                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/idempotency-plugin/src/plugin/idempotency-plugin.ts`           | Passes `transactionalConfigured: transactional !== undefined`                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/agent-runs-plugin/src/plugin/agent-runs-plugin.ts`             | Registration refusal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/vector-store-plugin/src/services/limits.ts`                    | `MAX_RECORDS_PER_REPLACE`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/vector-store-plugin/src/services/record-validation.ts`         | Cap parameter                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/vector-store-plugin/src/services/vector-store-service.ts`      | Passes the per-operation cap                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/vector-store-plugin/src/adapters/pgvector/pgvector-store.ts`   | Sliced upserts; index-shape messages                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/vector-store-plugin/src/adapters/pgvector/pgvector-sql.ts`     | `describeStatement` index-shape subqueries                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/vector-store-plugin/src/adapters/qdrant/qdrant-store.ts`       | Sliced upserts in both arms                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/auth-plugin/src/quota/quota.ts`                                | `read`, `usage`, `QuotaUsage`, extracted `validateKey`/`resolveLimit`                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/auth-plugin/src/quota/memory-quota-store.ts`                   | `read`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/auth-plugin/src/quota/redis-quota-store.ts`                    | `read` script                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/auth-plugin/src/index.ts`                                      | Export `QuotaUsage`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/multi-tenancy-plugin/src/services/multi-tenancy-service.ts`    | Unit-of-work binding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/multi-tenancy-plugin/src/errors.ts`, `src/index.ts`            | `TenantUnitOfWorkUnsupportedError`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/database-plugin/src/tenancy/database-tenant-data-store.ts`     | `withUnitOfWork` bound view                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/mail-plugin/src/services/mail-service.ts`                      | Attachment validation and byte encoding in `#resolve`                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/mail-plugin/src/providers/encoding.ts` (new, internal)         | `toBase64`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/mail-plugin/src/providers/{smtp,ses,sendgrid,log}-provider.ts` | Attachment mapping                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/mail-plugin/src/interfaces/index.ts`                           | `OutgoingMail` carries byte attachments                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Docs                                                                     | The READMEs of the seven packages; the vector-store, agent-runs and mail `AGENT_CARD.md` where they state a changed limit or surface; `docs/retrieval.md` (the 500-record line), `docs/ai.md` (quota read), `docs/durable-runs.md` (the boot refusal); `PUBLIC_API.md` (including `OutgoingMail`); `CHANGELOG.md`; the ROADMAP package line, the M139c row set to ✅, the CLAUDE.md status line, and this plan moved to `plans/archive/`. New symbols carry `@since 0.13.0`; no existing `@since` changes |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                    | src covered                                       | Key assertions (and the signature each call type-checks against)                                                        |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `agent-runs-plugin/test/unit/plugin.test.ts`                                                 | `agent-runs-plugin.ts`                            | §3.1 refusal, run through `createApplication(...).start()`; a transactional boot; the message names the option          |
| `idempotency-plugin/test/unit/idempotency-plugin.test.ts` (+ the updated test doubles of §1) | `idempotency-service.ts`, `idempotency-plugin.ts` | `transactional` is `false` without the option and `true` with it                                                        |
| `vector-store-plugin/test/unit/validation.test.ts`                                           | `record-validation.ts`, `limits.ts`               | `validateRecords(records, dims, fields, max)` at 500/501 and 5,000/5,001                                                |
| `vector-store-plugin/test/unit/vector-store-service.test.ts`                                 | `vector-store-service.ts`                         | `upsert` of 501 is refused; `replaceSource` of 5,000 reaches the adapter once                                           |
| `vector-store-plugin/test/unit/pgvector-store.test.ts`                                       | `pgvector-store.ts`, `pgvector-sql.ts`            | Slices in one transaction; each index-shape message                                                                     |
| `vector-store-plugin/test/unit/qdrant-store.test.ts`                                         | `qdrant-store.ts`                                 | Slices in both arms; the `update_filter` on each slice                                                                  |
| `vector-store-plugin/test/integration/conformance.test.ts`                                   | All three adapters                                | 1,200 then 700 read back; guarded real pgvector index-shape refusals                                                    |
| `auth-plugin/test/unit/quota.test.ts`                                                        | `quota.ts`                                        | §3.4 usage table; one key-validation table driven through `reserve` AND `usage`                                         |
| `auth-plugin/test/unit/memory-quota-store.test.ts`, `redis-quota-store.test.ts`              | Both stores                                       | `read` table; malformed Redis replies; a guarded real-Redis read-back                                                   |
| `database-plugin/test/unit/database-tenant-data-store.test.ts`                               | `database-tenant-data-store.ts`                   | Bound view routed through the unit of work; parent column; foreign-row refusal; `TypeError`                             |
| `multi-tenancy-plugin/test/unit/tenant-unit-of-work.test.ts` (new)                           | `multi-tenancy-service.ts`, `errors.ts`           | Both entry points under a non-default column; unsupported-store error                                                   |
| `multi-tenancy-plugin/test/integration/tenant-transaction.test.ts` (new)                     | The end-to-end path                               | Rollback leaves nothing; commit reads back with the tenant column (memory database adapter + `DatabaseTenantDataStore`) |
| `mail-plugin/test/unit/mail-service.test.ts`                                                 | `mail-service.ts`                                 | Refusal table through `send` and `sendTemplate`; string content encoded to bytes                                        |
| `mail-plugin/test/unit/encoding.test.ts` (new)                                               | `encoding.ts`                                     | Bytes → base64 against known vectors (empty, 1–3 bytes, a 100 KiB buffer across slice boundaries)                       |
| `mail-plugin/test/unit/{smtp,ses,sendgrid,log}-provider.test.ts`                             | Four providers                                    | Field-by-field mapping; no field without attachments; guarded real nodemailer and SES SDK tests; the log has no content |

Every new test is shown to fail against the unfixed code (fail-without-fix evidence in the
hand-back).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m139c-ai-data-contracts
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test:coverage common idempotency-plugin agent-runs-plugin vector-store-plugin auth-plugin multi-tenancy-plugin database-plugin mail-plugin cloudflare-plugin decorator-plugin
pnpm run ci:local            # final commit, full shards
pnpm run test:deno-lane
pnpm run release:publish --dry-run
pnpm run release:verify 0.13.0
```

Guarded real backends (pgvector, Qdrant, Redis) run with the full-backend environment block. A
skipped guarded test is reported as skipped, never as passed.

## 8a. Design security review

**Flows:**

- F1: a tenant repository bound to a unit of work (V12-20).
- F2: attachment fields entering MIME and API headers (V12-21).
- F3: a quota read by key (V12-36).
- F4: `replaceSource` slicing under a scope (V12-9).
- F5: boot refusals (V12-4, V12-10).

**Assets:** tenant isolation of rows; mail headers; per-key quota counts; scope isolation of
vectors.

**Attackers:**

- A request author controlling an attachment's filename, content type or content id, because apps
  forward uploads.
- A tenant reaching another tenant's rows through a transaction.

| #   | Obligation                                                                                                                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1  | A repository bound to a unit of work stamps the tenant column on create, strips it on update, and refuses reads, updates and deletes of another tenant's row, exactly as the unbound store does (same table driven through both). |
| O2  | An attachment `filename`, `contentType` or `contentId` containing CR, LF, any other C0 control character or DEL is refused before any provider runs. No refusal message contains the content.                                     |
| O3  | The log provider never logs attachment content.                                                                                                                                                                                   |
| O4  | `usage(key)` reads only `${name}:${key}`, under the same key validation as `reserve`. A key that `reserve` refuses, `usage` refuses.                                                                                              |
| O5  | Every `replaceSource` slice and the stale delete carry the call's scope. A 1,200-record replace in scope A leaves scope B's records of the same source id untouched.                                                              |
| O6  | Both boot checks fail closed: a missing `transactional` member, and any pgvector describe column that is `false` or `null`.                                                                                                       |

**Audit:** this diff crosses the tenancy boundary (F1) and a header-injection surface (F2), so it is
security-audited on the committed tree before merge. A fresh agent context runs the audit against
O1–O6, following `.roo/skills/security-audit/SKILL.md`.

## 8. Risks & mitigations

- **The SES `Attachments` field is absent from older `@aws-sdk/client-sesv2` `^3` releases.**
  Mitigation: the real-SDK test runs against the installed version. The README names the minimum SDK
  version, found by checking the package's CHANGELOG at implementation time.
- **A Qdrant replace that fails mid-slice leaves earlier slices written.** Mitigation: this is
  unchanged in kind from today's two-call shape, which the README already documents. The README adds
  that a failed replace is retried whole.
- **The `pg_index` query differs across PostgreSQL versions.** Mitigation: it uses only catalog
  columns stable since PostgreSQL 11 (`indkey`, `indclass`, `indnkeyatts`). The guarded real-PG
  conformance test runs on the CI image.
- **A unit of work from a deferred-write transaction (Cloudflare D1) buffers writes, so the bound
  view's owned-row read before an update may not see a write made earlier in the same transaction.**
  Mitigation: the README's Transactions section states it, and the bound view adds no read the
  unbound store does not already make.
- **Fakes of the three widened interfaces exist in other packages' tests.** Mitigation: §1 lists
  them, and `pnpm run check` across the workspace finds any missed.

## 9. Out of scope

- **A declared distance metric for vector collections.** Every collection is cosine. No milestone
  owns it; it is a feature request, not a defect.
- **Sources over 5,000 records.** These would need a staged, multi-call replace. Recorded here; no
  milestone owns it.
- **Streamed or storage-backed attachments.** Not requested by any row.
- **The `0.13.0` published re-run that closes these six rows.** Per the defect-closure rule, the
  rows close only after that run.
