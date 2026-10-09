# Milestone 109b — Idempotency tier C and the SDK key (`@setu-ts/idempotency-plugin`, `@setu-ts/database-plugin`, `@setu-ts/common`, `@setu-ts/sdk`)

> **Status:** Planning. Branch: `feat/m109b-idempotency-tier-c-sdk`. `develop` and `main` are
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR. **Implementation waits for M108 (PR #436) to merge**: §3.6 extracts helpers out of
> M108's `database-plugin` inbox store, and the branch is rebased on `develop` once it carries M108.

## 0. Objective & scope

109a delivered the first of the three guarantees M109 names — no duplicate processing — on tiers A
and B, which hold the idempotency record OUTSIDE the business transaction. This milestone delivers
the second: **the work and its record committed together** (tier C). `service.within(options, fn)`
opens ONE database transaction, writes the idempotency record in it FIRST, runs `fn` with that
transaction's unit of work, stores `fn`'s JSON result on the record, and commits. A repeated key
whose record is committed returns the stored result without running `fn`; a concurrent duplicate
loses the race on the record's primary key, its business writes roll back with it, and the record is
re-read to return the winner's result. It is the M108 inbox algorithm (pre-read, record first,
re-read after any rejection) applied to plain code instead of a broker delivery. It also delivers
the client half: an `@setu-ts/sdk` request carrying an idempotency key keeps one key across every
retry attempt, which is what makes a `POST` or `PATCH` safe to retry.

- **In scope:**
  - `common`: the tier-C store port `ITransactionalIdempotencyStore`, its record type and kind
    constant, the `within` option and result types, and a `within` member on `IIdempotencyService`
    (§3.1, §3.2).
  - `idempotency-plugin`: `IdempotencyService.within`, the `transactional` plugin option (store
    resolved and verified at `onInit`, a scheduled retention purge), `IdempotencyWithinError`, and
    the store-failure log rule (§3.3–§3.5).
  - `database-plugin`: `createDatabaseIdempotencyStore()`, a bridge over `IDatabaseService`, with
    the backend refusals shared with M108's inbox store through one extracted helper (§3.6, §3.7).
  - `sdk`: `ClientOptions.idempotency` and `ClientRequest.idempotencyKey`; a keyed request is
    retryable on any method and also on `409` (§3.8, §3.9).
  - Docs: package READMEs, PUBLIC_API.md, CHANGELOG `Unreleased`, ROADMAP corrections (§2) and a
    `109b` Progress row, `docs/upgrading.md` (nothing to do — §4), the DDL for PostgreSQL and
    SQLite/D1.
  - A design security review (§10) and the obligations the committed-tree audit must meet.
- **NOT this milestone:**
  - `idempotent()` (HTTP middleware) on tier C. Middleware cannot own the handler's transaction, so
    tier C stays a code entry point; an HTTP handler calls `within` itself (§3.3 worked example).
  - The ingress entry point on tier C. M108's inbox is the tier-C mechanism for broker messages; a
    queue-job equivalent is unowned.
  - Codegen changes in `@setu-ts/sdk`: generated operations take no per-call options today, so they
    get keys through the client-level `idempotency` option (§3.8), not a new per-operation argument.
  - Lease renewal, an erase-by-principal API — still unowned (109a §0).

## 1. Contracts verified from SOURCE (not names)

| Reference                                  | Source (file:line)                                                                            | Verified surface / fact                                                                                                                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IIdempotencyService`                      | `packages/common/src/services/idempotency.ts:250-266`                                         | Two members, `middleware(options?)` and `behavior(options)`, both synchronous. Unreleased: 0.9.0 is not tagged (CHANGELOG `Unreleased`), so adding a required member breaks no published implementor.         |
| `JsonValue`                                | `packages/common/src/types.ts:135`                                                            | `string \| number \| boolean \| null \| readonly JsonValue[] \| { readonly [key: string]: JsonValue \| undefined }`. The `within` result type is bounded by it.                                               |
| `IDatabaseService.transaction`             | `packages/database-plugin/src/interfaces/index.ts:212-215`                                    | `transaction<T>(work: (uow: IUnitOfWork) => Promise<T>, options?): Promise<T>`; a throw rolls back. The store opens the transaction, so the caller never owns it (§3.3).                                      |
| `IUnitOfWork.getRepository`                | `packages/database-plugin/src/interfaces/index.ts:197`                                        | What `fn` receives as its scope; the record and the business writes go through the SAME unit of work.                                                                                                         |
| M108 `IInboxStore`                         | `packages/common/src/services/inbox.ts:158-240` (branch `feat/m108-consumer-inbox`, PR #436)  | `find`, `run(marker, work)` (marker created FIRST in one transaction), `purge`, `verify` — the seam tier C shares. Its record shape (consumer, topic, parked) does not fit a stored result, hence a new port. |
| M108 `DatabaseInboxStore`                  | `packages/database-plugin/src/inbox/database-inbox-store.ts:108-160, 345-400` (same branch)   | `ProbeRollback`, `unavailableReason`, `isMongoReplicaSetRefusal`, the Cosmos/Bigtable refusal through `adapterInfoOf`, and the two-row rolled-back probe — the code §3.6 extracts instead of copying.         |
| `adapterInfoOf`                            | `packages/database-plugin/src/services/database-service.ts:129` (same branch)                 | Internal; reports `{ type, adapter }` so a shipped adapter handed to the `'custom'` arm is still refused by class.                                                                                            |
| `RegistryFactory` / `resolveRegistryEntry` | `packages/common/src/registry.ts:66, 216`                                                     | The `transactional.store` option is an instance or a factory resolved at `onInit` (the M108 `inbox.store` shape).                                                                                             |
| `withDeadline`                             | `packages/common/src/health/deadline.ts:118`                                                  | Bounds every store call except the transaction itself (`storeTimeoutMs`), as M108 does.                                                                                                                       |
| `withHttpStatusHint`                       | `packages/common/src/errors/status-hint.ts:141`                                               | Brands `IdempotencyWithinError` so `errorHandler` answers `422`/`400` from a handler that calls `within` (§3.4).                                                                                              |
| 109a key and fingerprint helpers           | `packages/idempotency-plugin/src/core/hash.ts:65`, `core/fingerprint.ts:49`, `core/key.ts:18` | `deriveHash(subtle, segments)` (length-prefixed SHA-256 hex), `canonicalJson(value)`, `parseKeyValue(raw)` (1–255 chars of `0x21`–`0x7E`, no `"`). Reused unchanged.                                          |
| 109a errors                                | `packages/idempotency-plugin/src/errors.ts:15-90`                                             | `IdempotencyRefusedError` carries `ingress` and `target` — ingress-only fields — so `within` gets its own class (§3.4). `IdempotencyConfigurationError(option, message)` is reused for configuration.         |
| 109a plugin wiring                         | `packages/idempotency-plugin/src/plugin/idempotency-plugin.ts:30-75`                          | `register()` connects the tier A/B store and registers the service; no `onInit`, no scheduler dependency today. §3.5 adds both.                                                                               |
| `IScheduler.every`                         | `packages/common/src/services/scheduler.ts:109`                                               | The retention purge job (`idempotency-purge`), M108's `inbox-purge` precedent.                                                                                                                                |
| SDK retry gate                             | `packages/sdk/src/retry/retry-strategy.ts:65, 68-75, 104-135`                                 | `SAFE_METHODS` = GET/HEAD/OPTIONS/PUT/DELETE; retryable statuses 408/425/429/5xx; `runWithRetry(fn, policy, method, timing, signal)` decides `canRetry` from the method alone.                                |
| SDK request path                           | `packages/sdk/src/http/http-client.ts:138-200`                                                | Headers built once, request interceptors run ONCE before any attempt, then `runWithRetry(execute)` re-sends the SAME `headers` object — so a key set before the loop is reused on every attempt by structure. |
| `ClientRequest` / `ClientOptions`          | `packages/sdk/src/http/contracts.ts:43-64, 164-196`                                           | Neither interface has an idempotency member today.                                                                                                                                                            |
| SDK randomness                             | `packages/sdk/src/http/observed-fetch.ts:108`                                                 | The SDK already uses `crypto.getRandomValues` behind a guarded availability check — the precedent for key generation (§3.8).                                                                                  |
| 109a server `409`                          | `packages/idempotency-plugin/src/middleware/http-middleware.ts:217-222`                       | A concurrent duplicate answers `409 Conflict`, no `Retry-After`; the record replays once the first request completes. §3.9 retries it.                                                                        |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                        | Resolution (picked side)                                                                                                                                                                                                                                                                                                                  | Doc deliverable (same PR)                                                |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| C1 | ROADMAP M109 and 109a plan §0 name the entry point `within(uow, key, fn)` — the CALLER's unit of work.                                          | `within(options, fn)`: the store opens the transaction. With a caller-owned transaction, a lost race surfaces OUTSIDE `within` — a PostgreSQL insert aborts the caller's transaction so no re-read is possible inside it, and the deferred backends refuse at the caller's commit — so the winner's result could never be returned. §3.3. | ROADMAP M109 "Four entry points" bullet.                                 |
| C2 | ROADMAP M109: "Tier C per backend: SQL, MongoDB and DynamoDB yes; D1 for database-only effects; Cosmos only within one partition; Bigtable no." | Cosmos is REFUSED, like M108's inbox: a database-plugin transaction is one container and one partition-key value, and the record lives in its own entity, so it cannot share the business partition. D1 is supported through `DatabasePlugin({ type: 'custom', adapter: D1Adapter })` with the deferred-write caveat (§3.7).              | ROADMAP M109 tier-C bullet.                                              |
| C3 | ROADMAP M109 `Package(s)`: "109b: `packages/sdk` (the `idempotencyKey` request option) and tier C."                                             | 109b: `common`, `idempotency-plugin`, `database-plugin`, `sdk`.                                                                                                                                                                                                                                                                           | ROADMAP `Package(s)` line; Progress row `109b`.                          |
| C4 | 109a plan §3.18 and the idempotency-plugin README tier table: tier C row reads "Expiry: Backend-specific; Clock: —".                            | Expiry is the record's `expiresAt`, written from `runtime.now()` (wall clock, because records outlive the process and are read by other replicas), removed by the scheduled purge; an expired record is treated as absent and replaced inside the next transaction.                                                                       | idempotency-plugin README tier table; PUBLIC_API.md idempotency section. |
| C5 | ROADMAP M109 SDK bullet: "an `idempotencyKey` request option, generated once per logical call".                                                 | Two members: per-request `ClientRequest.idempotencyKey` (a caller's own key) and client-level `ClientOptions.idempotency` (generated keys, the only way a GENERATED client gets one, since generated operations take no per-call options — §1).                                                                                           | ROADMAP M109 SDK bullet.                                                 |

## 3. Design decisions

### 3.1 The tier-C store port (`common/src/services/idempotency.ts`)

- **Decision:** add, beside the 109a declarations (JSDoc on every member, `@since 0.9.0`, or the
  next unreleased version if 0.9.0 is tagged first):

```ts
/** Discriminator on every tier-C record row. */
export const IDEMPOTENCY_RECORD_KIND = 'setu-idempotency';

/** A committed tier-C record. */
export interface TransactionalIdempotencyRecord {
  /** 64 lower-case hex: the derived key (§3.2). The row id. */
  readonly id: string;
  readonly kind: typeof IDEMPOTENCY_RECORD_KIND;
  /** 64 lower-case hex. */
  readonly fingerprint: string;
  /** The encoded result envelope (§3.3). */
  readonly result: string;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  /** Epoch milliseconds; the record is absent once `expiresAt <= now`. */
  readonly expiresAt: number;
}

export interface ITransactionalIdempotencyStore {
  /** The committed record, or `undefined`. A row of another `kind` is absent. Read outside any transaction. */
  find(id: string): Promise<TransactionalIdempotencyRecord | undefined>;
  /**
   * ONE transaction: delete an expired row of `claim.id` if present, create `claim` (with
   * `result: ''`) FIRST, run `work` with the transaction's scope, write its returned `result`
   * onto the row, commit. Rejects — and rolls back the work — when the create or the commit is
   * refused (a concurrent duplicate) or `work` throws.
   */
  run<R>(
    claim: TransactionalIdempotencyRecord,
    now: number,
    work: (scope: unknown) => Promise<{ readonly result: string; readonly value: R }>,
  ): Promise<R>;
  /** Deletes up to `limit` records with `expiresAt < before`; returns the count. */
  purge(before: number, limit: number): Promise<number>;
  /** Refuses at startup a backend that cannot serve tier C, by name. Leaves no row. */
  verify(): Promise<void>;
}
```

- **Why:** M108's `IInboxStore` is the same seam but its record carries consumer/topic/parking and
  no result, so a separate, smaller port. The port lives in `common` because `database-plugin`
  implements it and `idempotency-plugin` consumes it (AI_GUIDELINES §2.2). `run` takes the result
  from `work` rather than a second call so the store writes it in the SAME transaction.
- **Test home:** `packages/common/test/unit/idempotency-contract.test.ts` (extended).

### 3.2 `within` options, result, key and fingerprint

- **Decision:**

```ts
export interface IdempotentWithinOptions {
  /** The client's key: 1–255 characters of 0x21–0x7E, no `"` (109a `parseKeyValue`). */
  readonly key: string;
  /** What the key is for, e.g. `'payments.charge'`. 1–256 characters, none below U+0020. */
  readonly namespace: string;
  /**
   * REQUIRED isolation segment — typically `${tenantId}:${principalId}`. `''` declares the
   * record global on purpose. Never derived for the caller: `within` has no request context.
   */
  readonly scope: string;
  /** Any canonical-JSON-able value describing the request; a different value under the same key is refused. Default: none (any repeat matches). */
  readonly fingerprint?: unknown;
  /** Default: the plugin's `transactional.ttlMs` (86,400,000). Integer 60,000–2,592,000,000. */
  readonly ttlMs?: number;
}

export interface IdempotentWithinResult<R> {
  readonly value: R;
  /** `true` when `value` came from a committed record and `fn` did not run in this call. */
  readonly replayed: boolean;
}

// on IIdempotencyService:
within<R extends JsonValue | void, S = unknown>(
  options: IdempotentWithinOptions,
  fn: (scope: S) => Promise<R>,
): Promise<IdempotentWithinResult<R>>;
```

- `id = deriveHash(['within', namespace, scope, key])`; fingerprint =
  `deriveHash(['within-fp', canonicalJson(fingerprint ?? null)])`. Raw key, scope and namespace are
  never stored.
- `S` is the caller's annotation of the scope (an `IUnitOfWork` from the database the store writes
  to), unchecked — the M108 `IntegrationEventInboxHandler<T, S>` precedent.
- **Why:** `scope` is REQUIRED because `within` has no request context to derive a principal from,
  and an omitted principal is exactly 109a's D1 (cross-user replay). Making `''` an explicit choice
  keeps that decision visible in the call site. `replayed` lets an HTTP handler answer `200` on a
  replay and `201` on first execution.
- **Test home:** `packages/idempotency-plugin/test/unit/within-options.test.ts`,
  `test/unit/within.test.ts`.

### 3.3 The `within` algorithm

- **Decision:** in this order:
  1. Validate options (§3.13 bounds); refuse a key `parseKeyValue` rejects with
     `IdempotencyWithinError('key-invalid')`. No store call.
  2. Derive id and fingerprint; `now = runtime.now()`.
  3. Pre-read `store.find(id)` (bounded by `storeTimeoutMs`). A record with `expiresAt > now`:
     fingerprint differs → `IdempotencyWithinError('fingerprint-mismatch')`; equal → decode and
     return `{ value, replayed: true }`.
  4. `store.run(claim, now, work)` where `work` runs `fn(scope)`, encodes
     `JSON.stringify({ v: value })` (`void` → `{}`), refuses a result over `maxResultBytes` UTF-8
     bytes (`'result-too-large'`) or one `JSON.stringify` rejects or returns `undefined` for
     (`'result-unserializable'`) — throwing inside the transaction, so the work rolls back — and
     returns `{ result, value }`. Resolve → `{ value, replayed: false }`.
  5. On ANY rejection of step 4, re-read `find(id)` (bounded; a failing re-read counts as absent and
     is logged per §3.4): a live record with the same fingerprint →
     `{ value: decoded,
     replayed: true }`; a different fingerprint → `'fingerprint-mismatch'`;
     absent → rethrow the ORIGINAL rejection.
  - A stored `result` that does not parse to `{ v? }` → `IdempotencyWithinError('record-invalid')`,
    never `fn` re-run.
- **Why:** the M108 inbox algorithm, which measured that the error alone cannot tell a lost race
  from a real failure (a commit-time `DuplicateKeyError` carries no entity; a MongoDB replica-set
  loser is a write conflict). Rolling back on an oversized result keeps "work and record together"
  true: no record means no committed work.
- **Worked example (README):** an HTTP handler calls
  `within({ key: headerKey, namespace:
  'orders.create', scope:`
  ${tenant}:${user.id}`, fingerprint: body }, (uow: IUnitOfWork) => …)` and answers
  `replayed ? 200 : 201`.
- **Test home:** `test/unit/within.test.ts` (fake store), `test/integration/within-kernel.test.ts`
  (memory database), `test/integration/within-real.test.ts` (§6).

### 3.4 Errors and logging

- **Decision:** `IdempotencyWithinError extends Error` with
  `reason: 'key-invalid' | 'fingerprint-mismatch' | 'result-too-large' | 'result-unserializable' |
  'record-invalid'`.
  Messages carry no key, scope, namespace, fingerprint or result. `key-invalid` is branded with the
  status hint `400`, `fingerprint-mismatch` with `422`; the rest stay unhinted (a masked `500`).
  Calling `within` without the `transactional` option throws
  `IdempotencyConfigurationError('transactional', …)`. A failed store call (`find`, re-read,
  `purge`) is logged with the error CLASS only, `{ errorKind }`, never its message.
- **Why:** M108's audit finding F1 — Drizzle's error message lists every bound parameter, which for
  tier C includes the stored result. 109a's `IdempotencyRefusedError` carries ingress-only fields.
- **Test home:** `test/unit/within-errors.test.ts`, `test/unit/within.test.ts`.

### 3.5 Plugin wiring

- **Decision:**
  `IdempotencyPluginOptions.transactional?: { store, ttlMs?, storeTimeoutMs?,
  maxResultBytes?, purge?: { schedule?, intervalMs?, batch? } }`.
  The plugin adds `optionalDependencies: [CAPABILITIES.SCHEDULER, CAPABILITIES.DATABASE]` only when
  `transactional` is set, resolves `store` at `onInit` (so `DatabasePlugin` may register before or
  after), runs `verify()` bounded by `storeTimeoutMs` (a timeout rejects `start()` naming the
  bound), and schedules `idempotency-purge` via `CAPABILITIES.SCHEDULER`; without a scheduler and
  with `purge.schedule` not `false`, `start()` rejects naming the option. The purge job is removed
  in `onShutdown`. `within` before `onInit` completes throws
  `IdempotencyConfigurationError('transactional', …)` naming readiness.
- **Why:** M108's `inbox` wiring, already audited, including the ordering lessons (factory at
  `onInit`, verify before first use). On Workers the purge is not scheduled; §3.12 covers it.
- **Test home:** `test/integration/within-plugin.test.ts`.

### 3.6 `createDatabaseIdempotencyStore` and the shared backend helper

- **Decision:** `createDatabaseIdempotencyStore({ entity = 'Idempotency', database? })` returns a
  `RegistryFactory<ITransactionalIdempotencyStore>` resolving `CAPABILITIES.DATABASE` (or
  `database.<name>`). The M108 inbox store's backend refusal — `adapterInfoOf` Cosmos/Bigtable
  checks, `unavailableReason`, `isMongoReplicaSetRefusal`, `ProbeRollback` and the rolled-back probe
  — moves to ONE internal module `src/transactional/backend-probe.ts` used by both stores, with the
  inbox store's behaviour unchanged (its tests are the regression gate). The tier-C store refuses
  with a new `TransactionalStoreUnavailableError` carrying the same `reason` union and its `entity`;
  `InboxStoreUnavailableError` keeps its name and shape, and both come from the one shared reason
  computation.
- **Why:** §11.1 — one implementation of "can this backend do a record-first transaction".
- **Test home:** `packages/database-plugin/test/unit/idempotency/*.test.ts`; the existing
  `test/unit/inbox/*` stay green unchanged.

### 3.7 Per-backend behaviour

| Backend                      | Behaviour                                                                                                                                |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| memory                       | Supported, single process; a concurrent duplicate is refused at commit.                                                                  |
| PostgreSQL (Drizzle, Prisma) | Supported; the second insert blocks on the primary key until the first commits, then fails; the loser re-reads.                          |
| SQLite / D1                  | Supported; writes deferred to commit, so `fn` runs before a concurrent duplicate is refused — its OUTSIDE effects run for both (README). |
| MongoDB replica set          | Supported; the loser is a write conflict. Collections must exist (implicit creation in two transactions conflicts — M108).               |
| MongoDB standalone           | Refused, `'mongodb-standalone'`.                                                                                                         |
| DynamoDB                     | Supported (deferred, `TransactWriteItems`); the purge `Scan`s without a GSI on `kind`/`expiresAt`.                                       |
| Cosmos DB                    | Refused, `'cosmos-unsupported'` (C2).                                                                                                    |
| Bigtable                     | Refused, `'bigtable-unsupported'` (one row per transaction).                                                                             |

- **Test home:** `test/integration/within-real.test.ts` (PostgreSQL, MongoDB RS, DynamoDB Local,
  Bigtable refusal), `test/integration/within-d1.test.ts` (D1 over real SQLite).

### 3.8 SDK: where a key comes from

- **Decision:**
  - `ClientRequest.idempotencyKey?: string` — the caller's own key, validated 1–255 characters of
    `0x21`–`0x7E` with no `"` before any network call (`Error` naming the field, never the value).
  - `ClientOptions.idempotency?: { methods?: readonly string[] (default ['POST', 'PATCH']); header?:
    string (default 'Idempotency-Key'); generateKey?: () => string }`
    — every request whose method is listed and that carries no key gets ONE generated key: 32 hex
    characters from 16 `crypto.getRandomValues` bytes, behind the `observed-fetch.ts` availability
    check. `header` is validated as an HTTP token at construction.
  - The key is set on the request headers BEFORE request interceptors run; supplying
    `idempotencyKey` while `headers` already names the header is refused.
- **Why:** generated clients have no per-call options (§1, C5), so the client-level option is the
  only route for them; the request headers are built once and reused by every attempt
  (`http-client.ts:168-236`), so "one key per logical call" holds by construction.
- **Test home:** `packages/sdk/test/unit/idempotency-key.test.ts`.

### 3.9 SDK: which requests retry

- **Decision:** a request is KEYED when its final headers (after interceptors) carry the configured
  header (default `Idempotency-Key`), however it got there. `runWithRetry` takes `keyed: boolean`
  (internal signature change): a keyed request may retry on ANY method, and a keyed request also
  retries `409`. Everything else is unchanged.
- **Why:** the key is what makes a non-idempotent method safe to repeat; 109a answers a concurrent
  duplicate `409` and replays once the first completes. A manually set header counts so an existing
  caller who already sends one benefits — recorded as a CHANGELOG `Changed` entry, not breaking.
- **Test home:** `packages/sdk/test/unit/retry-strategy.test.ts` (extended),
  `test/integration/idempotency-roundtrip.test.ts` (a real `IdempotencyPlugin` app over `app.fetch`:
  a lost response retried once executes the handler once).

### 3.10 Retention

- **Decision:** `purge` deletes up to `purge.batch` (default 100) expired records per run every
  `purge.intervalMs` (default 60,000). The table stays bounded only while inflow stays below that
  rate — stated in the README and the option JSDoc (M108 round-2 NEW-5).
- **Test home:** `test/integration/within-plugin.test.ts`.

### 3.11 Clock

- **Decision:** `createdAt`/`expiresAt` from `runtime.now()` (epoch ms). Never `Date.now()`, never
  `hrtime()` — the record is read by other processes.
- **Test home:** `test/unit/within.test.ts` (fake runtime clock).

### 3.12 Manual purge (Workers)

- **Decision:** with `purge.schedule: false` the application calls `service.purgeTransactional()` (a
  Cron Trigger on Workers). That method is on the concrete `IdempotencyService` and on
  `IIdempotencyService` as an OPTIONAL member (`purgeTransactional?(): Promise<number>`), so a
  replacement provider need not implement tier C.
- **Test home:** `test/integration/within-plugin.test.ts`.

### 3.13 Bounds

| Option                         | Default           | Bound                                         |
| ------------------------------ | ----------------- | --------------------------------------------- |
| `within` `key`                 | —                 | 1–255 chars, `0x21`–`0x7E`, no `"`            |
| `within` `namespace`           | —                 | 1–256 chars, none below U+0020                |
| `within` `scope`               | — (required)      | 0–512 chars, none below U+0020                |
| `ttlMs`                        | 86,400,000        | integer 60,000–2,592,000,000                  |
| `transactional.storeTimeoutMs` | 5,000             | integer 1–2,147,483,647                       |
| `transactional.maxResultBytes` | 65,536            | integer 2–16,777,216                          |
| `purge.intervalMs`             | 60,000            | integer 1–2,147,483,647                       |
| `purge.batch`                  | 100               | integer 1–100,000                             |
| SDK `idempotency.methods`      | POST, PATCH       | 1–16 entries, each an HTTP token, upper-cased |
| SDK `idempotency.header`       | `Idempotency-Key` | HTTP token                                    |

`NaN`, `Infinity`, negatives and fractions fail every numeric bound (the M90a fail-open class).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none in a published release. `IIdempotencyService.within` is a
required member added to an interface that ships for the first time in 0.9.0 (still `Unreleased`).
`runWithRetry`'s signature is internal.

| Exported symbol                                      | Kind      | Consumer / real code path that READS it                            |
| ---------------------------------------------------- | --------- | ------------------------------------------------------------------ |
| `IDEMPOTENCY_RECORD_KIND` (common)                   | const     | `DatabaseIdempotencyStore` writes and filters on it                |
| `TransactionalIdempotencyRecord`                     | interface | the port's `find`/`run`; `IdempotencyService.within`               |
| `ITransactionalIdempotencyStore`                     | interface | implemented by `database-plugin`; consumed by `IdempotencyService` |
| `IdempotentWithinOptions`                            | interface | `within`'s parameter                                               |
| `IdempotentWithinResult`                             | interface | `within`'s return                                                  |
| `IIdempotencyService.within` / `purgeTransactional?` | members   | application code; the plugin's purge job                           |
| `IdempotencyWithinError` (plugin)                    | class     | thrown by `within`; `errorHandler` reads its status hint           |
| `IdempotencyWithinErrorReason` (plugin)              | type      | `IdempotencyWithinError.reason`                                    |
| `TransactionalIdempotencyOptions` (plugin)           | interface | `IdempotencyPluginOptions.transactional`                           |
| `createDatabaseIdempotencyStore` (database-plugin)   | function  | application's `transactional.store`                                |
| `DatabaseIdempotencyStoreOptions`                    | interface | its parameter                                                      |
| `TransactionalStoreUnavailableError`                 | class     | thrown by `verify()`; `start()` rejects with it                    |
| `ClientIdempotencyOptions` (sdk)                     | interface | `ClientOptions.idempotency`                                        |
| `ClientRequest.idempotencyKey`                       | member    | `HttpClient.request`                                               |

### 4.1 Options — every option names its consumer

| Option                                           | Consumer                          | Behavior                                   |
| ------------------------------------------------ | --------------------------------- | ------------------------------------------ |
| `transactional.store`                            | plugin `onInit`                   | resolved, verified, used by every `within` |
| `transactional.ttlMs`                            | `within`                          | default record lifetime                    |
| `transactional.storeTimeoutMs`                   | `within` reads, `verify`, `purge` | bounds each call                           |
| `transactional.maxResultBytes`                   | `within` step 4                   | refuses and rolls back a larger result     |
| `transactional.purge.*`                          | plugin `onInit` / purge job       | schedule, interval, batch                  |
| `within` `key/namespace/scope/fingerprint/ttlMs` | `within`                          | §3.2–§3.3                                  |
| `ClientOptions.idempotency.*`                    | `HttpClient.request`              | §3.8                                       |
| `ClientRequest.idempotencyKey`                   | `HttpClient.request`              | §3.8                                       |

## 5. Implementation files

| File                                                                     | Purpose                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------- |
| `packages/common/src/services/idempotency.ts`                            | §3.1, §3.2 declarations                           |
| `packages/common/src/index.ts`                                           | barrel                                            |
| `packages/idempotency-plugin/src/within/within.ts`                       | §3.3 algorithm                                    |
| `packages/idempotency-plugin/src/within/within-options.ts`               | §3.13 validation and defaults                     |
| `packages/idempotency-plugin/src/within/result-codec.ts`                 | result envelope encode/decode                     |
| `packages/idempotency-plugin/src/within/transactional-runtime.ts`        | §3.5 wiring: store resolution, verify, purge job  |
| `packages/idempotency-plugin/src/core/error-kind.ts`                     | `errorKind` (class-only log field)                |
| `packages/idempotency-plugin/src/errors.ts`                              | `IdempotencyWithinError`                          |
| `packages/idempotency-plugin/src/service/idempotency-service.ts`         | `within`, `purgeTransactional`                    |
| `packages/idempotency-plugin/src/plugin/idempotency-plugin.ts`           | `transactional` option, `onInit`, `onShutdown`    |
| `packages/idempotency-plugin/src/interfaces/index.ts`, `src/index.ts`    | options, barrel                                   |
| `packages/database-plugin/src/transactional/backend-probe.ts`            | §3.6 shared refusal + probe (extracted from M108) |
| `packages/database-plugin/src/idempotency/database-idempotency-store.ts` | the bridge                                        |
| `packages/database-plugin/src/idempotency/errors.ts`                     | `TransactionalStoreUnavailableError`              |
| `packages/database-plugin/src/inbox/database-inbox-store.ts`             | uses the extracted helper (no behaviour change)   |
| `packages/database-plugin/src/index.ts`                                  | barrel                                            |
| `packages/sdk/src/http/contracts.ts`                                     | §3.8 members                                      |
| `packages/sdk/src/http/idempotency-key.ts`                               | key validation and generation                     |
| `packages/sdk/src/http/http-client.ts`                                   | sets the key, computes `keyed`                    |
| `packages/sdk/src/retry/retry-strategy.ts`                               | `keyed` gate and `409`                            |
| `packages/sdk/src/sdk.ts`, `src/index.ts`                                | option validation at `createClient`, barrel       |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                   | src covered                         | Key assertions                                                                                                                                                                                                           |
| ----------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `common/test/unit/idempotency-contract.test.ts`             | `services/idempotency.ts`           | type rows: `within` result typing (`R` bounded by `JsonValue \| void`, a `Date` refused at compile time), port shape; barrel exports                                                                                     |
| `idempotency-plugin/test/unit/within-options.test.ts`       | `within-options.ts`                 | every §3.13 bound incl. `NaN`/fraction; `scope` required at the type level and `''` accepted                                                                                                                             |
| `idempotency-plugin/test/unit/result-codec.test.ts`         | `result-codec.ts`                   | round trip; `void`; oversized; `undefined`/cyclic/BigInt refused; malformed stored text → `record-invalid`                                                                                                               |
| `idempotency-plugin/test/unit/within.test.ts`               | `within.ts`, service `within`       | pre-read replay; mismatch; run; re-read after ANY rejection (dup, unclassified error, re-read itself failing); absent → original rethrown; expired record ignored; no store call on bad key                              |
| `idempotency-plugin/test/unit/within-errors.test.ts`        | `errors.ts`, `error-kind.ts`        | status hints 400/422; messages carry no input value; `errorKind` never the message (hostile `name`, throwing getter)                                                                                                     |
| `idempotency-plugin/test/integration/within-plugin.test.ts` | plugin, `transactional-runtime.ts`  | factory resolved at `onInit` with `DatabasePlugin` registered before and after; verify refusal fails `start()`; verify timeout; no scheduler → refused; purge scheduled and removed at shutdown; `within` without option |
| `idempotency-plugin/test/integration/within-kernel.test.ts` | end to end, memory database         | HTTP handler worked example: `201` then replayed `200` with one business row; `422` through `errorHandler` in `rfc9457`                                                                                                  |
| `idempotency-plugin/test/integration/within-real.test.ts`   | real backends (`ignore:`-guarded)   | PostgreSQL and MongoDB RS: two apps race one key → one business row, both return the same value, one `replayed`; DynamoDB Local; Bigtable refused; standalone Mongo refused                                              |
| `idempotency-plugin/test/integration/within-d1.test.ts`     | D1 over real SQLite                 | replay and duplicate refused at commit; outside effect counted twice (documents the caveat)                                                                                                                              |
| `database-plugin/test/unit/idempotency/*.test.ts`           | store, errors, `backend-probe.ts`   | discriminator (a foreign `kind` row is absent and never purged), expired-row replacement inside `run`, purge limit, verify leaves no row, Cosmos/Bigtable refused by arm and by class                                    |
| `database-plugin/test/unit/inbox/*` (existing)              | inbox store after extraction        | unchanged and green — the regression gate for §3.6                                                                                                                                                                       |
| `sdk/test/unit/idempotency-key.test.ts`                     | `idempotency-key.ts`, client wiring | validation; generated key format; one key reused across every attempt (fake fetch records headers); header+option conflict refused; header token validated at construction                                               |
| `sdk/test/unit/retry-strategy.test.ts` (extended)           | `retry-strategy.ts`                 | keyed POST retries 5xx and 409; unkeyed POST does not; unkeyed 409 does not; abort still wins                                                                                                                            |
| `sdk/test/integration/idempotency-roundtrip.test.ts`        | sdk ↔ idempotency-plugin            | real app via `app.fetch`: first response dropped by the fetch double, retry carries the same key, handler ran once, replay header present                                                                                |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m109b-idempotency-tier-c-sdk
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:docs
deno task publish:check     # committed tree
deno task release:verify <version>
```

## 8. Risks & mitigations

- M108 review changes the inbox store before merge → §3.6's extraction is rebased after #436 merges;
  the inbox tests gate it.
- Deferred backends run `fn` twice for a concurrent duplicate → its database writes still commit
  once; outside effects are documented as at-least-once (M108's table, carried over).
- A purge removing a record before a client stops retrying → `ttlMs` ≥ client retry window,
  documented beside the option.
- The SDK starts retrying POSTs a caller manually keyed → `Changed` CHANGELOG entry; retries are
  still bounded by `retry.limit` and only happen when `retry` is configured.

## 9. Out of scope

- Tier C behind `idempotent()` middleware or the ingress behaviour (§0).
- A per-operation `idempotencyKey` argument in generated clients — codegen (unowned).
- Lease renewal; erase-by-principal — unowned (109a).

## 10. Design security review (recorded before implementation)

Recorded 2026-10-09 before any implementation. Nothing below is reverse-engineered from code.

**Flows reviewed.** (F1) `within`: client key, caller-supplied scope and fingerprint → derived id →
pre-read → record-first transaction with the business writes → stored result → replay. (F2) The
store boundary: a shared business database, other applications possibly sharing the table. (F3) The
retention purge. (F4) Logs and error bodies. (F5) The SDK: key generation, header, retry.

**Assets.** Stored results (may carry personal data); isolation between principals, tenants and
namespaces; the guarantee itself; database capacity; log integrity.

**Attackers.** (A1) An authenticated user choosing keys, including another user's key. (A2) A client
flooding unique keys. (A3) A reader of logs and error bodies. (A4) Developer misconfiguration (an
empty `scope`, a too-short TTL, the wrong database). (A5) A party with write access to the
idempotency table. (A6) A network observer or a server seeing SDK keys.

**Approved budgets.** Per `within` call: one SHA-256 over the canonical fingerprint, one pre-read,
one transaction (record create + result update); one extra read only after a rejection; none beyond
the pre-read on a replay. SDK: 16 random bytes per generated key; no extra request.

**Design-time findings.**

| #   | Finding                                                                               | Disposition                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Without principal scope, user B with A's key receives A's stored result (A1)          | `scope` is REQUIRED (§3.2); JSDoc/README: put tenant and principal in it; `''` means global on purpose                                                               |
| D2  | Two namespaces share a key space (A4)                                                 | `namespace` is part of the derived id (§3.2)                                                                                                                         |
| D3  | `422` reveals a key exists (A1)                                                       | Accepted once scoped (109a D3); key never echoed                                                                                                                     |
| D4  | Unique keys grow the table (A2)                                                       | Rate limiting upstream; TTL ≤ 30 days; purge, with its rate condition stated (§3.10); 64-hex ids                                                                     |
| D5  | Stored results hold personal data for the TTL                                         | `maxResultBytes`; README: retention counts toward the data inventory; the caller chooses what `fn` returns (return an id, not a document)                            |
| D6  | Driver errors quote bound parameters — including the result — into logs (A3; M108 F1) | Store failures logged as `errorKind` only (§3.4); error messages carry no input or stored value                                                                      |
| D7  | A forged or corrupted row (A5) replays an attacker-chosen value, or crashes decoding  | Decode refuses anything but the envelope → `record-invalid`; `fn` is never re-run on it; an attacker with table write access is outside the trust boundary otherwise |
| D8  | A row of another `kind` in a shared table is read or purged                           | `kind` discriminator on every read and purge (§3.1; M108 D5 precedent)                                                                                               |
| D9  | Lost race returns the wrong result                                                    | Re-read after ANY rejection, fingerprint re-checked before a replay is returned (§3.3)                                                                               |
| D10 | An oversized or unserializable result commits work with no record                     | Refused inside the transaction, so the work rolls back (§3.3)                                                                                                        |
| D11 | Deferred backends run outside effects twice                                           | Documented (§3.7); the database writes are still once                                                                                                                |
| D12 | A purge deletes a record a client still retries against → the work runs again         | `ttlMs` documented against the client retry window; floor 60 s                                                                                                       |
| D13 | Predictable SDK keys let another client pre-claim a key (A1/A6)                       | 128 random bits from `crypto.getRandomValues`; server scope makes a guessed key useless across principals                                                            |
| D14 | SDK retries a non-idempotent call without a key                                       | Only KEYED requests retry outside the safe set (§3.9)                                                                                                                |
| D15 | SDK key or header injection (CR/LF)                                                   | Key restricted to `0x21`–`0x7E`; header name validated as a token at construction                                                                                    |
| D16 | Keys in logs or error bodies on the client                                            | The SDK never logs; refusal messages name the field, never the value                                                                                                 |

**Obligations the committed-tree audit must meet.**

1. User A's stored result is never returned to a call with a different `scope` or `namespace` for
   the same key, on every supported backend.
2. Two concurrent `within` calls for one key on real PostgreSQL and a real MongoDB replica set
   commit the business write once and both return the same value; drive it.
3. No log line, error message or error body contains the key, scope, namespace, fingerprint input or
   stored result; probe with recognizable values on real PostgreSQL with a failing store write.
4. A tampered row (wrong envelope, wrong `kind`) is never replayed and never purged as ours.
5. An oversized result leaves no record and no business row.
6. Cosmos, Bigtable and standalone MongoDB are refused at `start()`, and the extracted helper leaves
   M108's inbox refusals unchanged.
7. The SDK sends one key across every attempt, never retries an unkeyed POST, and refuses a key with
   a control character before any network call.
