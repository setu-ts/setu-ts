# Milestone 109b — Idempotency tier C and the SDK key (`@setu-ts/idempotency-plugin`, `@setu-ts/database-plugin`, `@setu-ts/common`, `@setu-ts/sdk`)

> **Status:** Planning. Branch: `feat/m109b-idempotency-tier-c-sdk`. `develop` and `main` are
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR. M108 (PR #436) is merged into `develop`, which this branch is based on; §3.6 extracts
> helpers out of its `database-plugin` inbox store.

## 0. Objective & scope

109a delivered the first of the three guarantees M109 names — no duplicate processing — on tiers A
and B, which hold the idempotency record OUTSIDE the business transaction. This milestone delivers
the second: **the work and its record committed together** (tier C). `service.within(options, fn)`
opens ONE database transaction, creates a claim row in it FIRST, runs `fn` with that transaction's
unit of work, creates a result row holding `fn`'s JSON result, and commits. A repeated key whose
record is committed returns the stored result without running `fn`; a concurrent duplicate loses the
race on the claim's primary key and its business writes roll back with it — then it replays the
winner's result, or, where it failed before the winner committed, rejects with a retryable `409`
(§3.3, §3.7). It is the M108 inbox algorithm (pre-read, write first, re-read after a rejection)
applied to plain code instead of a broker delivery. It also delivers the client half: an
`@setu-ts/sdk` request carrying an idempotency key keeps one key across every retry attempt, which
is what makes a `POST` or `PATCH` safe to retry.

- **In scope:**
  - `common`: the tier-C store port `ITransactionalIdempotencyStore`, its record type and kind
    constant, the `within` option and result types, and a `within` member on `IIdempotencyService`
    (§3.1, §3.2).
  - `idempotency-plugin`: `IdempotencyService.within`, the `transactional` plugin option (store
    resolved and verified at `onInit`, a scheduled retention purge), `IdempotencyWithinError`, and
    the store-failure log rule (§3.3–§3.5).
  - `database-plugin`: `createDatabaseIdempotencyStore()`, a bridge over `IDatabaseService`, with
    the backend refusals shared with M107's outbox and M108's inbox stores through one extracted
    helper (§3.6, §3.7).
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
  - Codegen changes in `@setu-ts/sdk`: generated operations take no per-call options beyond the
    header parameters their document declares, so they get generated keys through the client-level
    `idempotency` option (§3.8), not a new per-operation argument.
  - Lease renewal, an erase-by-principal API — still unowned (109a §0).

## 1. Contracts verified from SOURCE (not names)

| Reference                                  | Source (file:line)                                                                            | Verified surface / fact                                                                                                                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IIdempotencyService`                      | `packages/common/src/services/idempotency.ts:250-266`                                         | Two members, `middleware(options?)` and `behavior(options)`, both synchronous. Unreleased: 0.9.0 is not tagged (CHANGELOG `Unreleased`), so adding a required member breaks no published implementor.         |
| `JsonValue`                                | `packages/common/src/types.ts:135`                                                            | `string \| number \| boolean \| null \| readonly JsonValue[] \| { readonly [key: string]: JsonValue \| undefined }`. The `within` result type is bounded by it.                                               |
| `IDatabaseService.transaction`             | `packages/database-plugin/src/interfaces/index.ts:212-215`                                    | `transaction<T>(work: (uow: IUnitOfWork) => Promise<T>, options?): Promise<T>`; a throw rolls back. The store opens the transaction, so the caller never owns it (§3.3).                                      |
| `IUnitOfWork.getRepository`                | `packages/database-plugin/src/interfaces/index.ts:197`                                        | What `fn` receives as its scope; the record and the business writes go through the SAME unit of work.                                                                                                         |
| M108 `IInboxStore`                         | `packages/common/src/services/inbox.ts:158-240`                                               | `find`, `run(marker, work)` (marker created FIRST in one transaction), `purge`, `verify` — the seam tier C shares. Its record shape (consumer, topic, parked) does not fit a stored result, hence a new port. |
| M108 `DatabaseInboxStore`                  | `packages/database-plugin/src/inbox/database-inbox-store.ts:108-160, 345-400`                 | `ProbeRollback`, `unavailableReason`, `isMongoReplicaSetRefusal`, the Cosmos/Bigtable refusal through `adapterInfoOf`, and the two-row rolled-back probe — the code §3.6 extracts instead of copying.         |
| `adapterInfoOf`                            | `packages/database-plugin/src/services/database-service.ts:129`                               | Internal; reports `{ type, adapter }` so a shipped adapter handed to the `'custom'` arm is still refused by class.                                                                                            |
| `RegistryFactory` / `resolveRegistryEntry` | `packages/common/src/registry.ts:66, 216`                                                     | The `transactional.store` option is an instance or a factory resolved at `onInit` (the M108 `inbox.store` shape).                                                                                             |
| `withDeadline`                             | `packages/common/src/health/deadline.ts:118`                                                  | Bounds every store call except the transaction itself (`storeTimeoutMs`), as M108 does.                                                                                                                       |
| `withHttpStatusHint`                       | `packages/common/src/errors/status-hint.ts:141`                                               | Brands `IdempotencyWithinError` so `errorHandler` answers `422`/`400` from a handler that calls `within` (§3.4).                                                                                              |
| 109a key and fingerprint helpers           | `packages/idempotency-plugin/src/core/hash.ts:65`, `core/fingerprint.ts:49`, `core/key.ts:18` | `deriveHash(subtle, segments)` (length-prefixed SHA-256 hex), `canonicalJson(value)`, `parseKeyValue(raw)` (1–255 chars of `0x21`–`0x7E`, no `"`). Reused unchanged.                                          |
| 109a errors                                | `packages/idempotency-plugin/src/errors.ts:15-90`                                             | `IdempotencyRefusedError` carries `ingress` and `target` — ingress-only fields — so `within` gets its own class (§3.4). `IdempotencyConfigurationError(option, message)` is reused for configuration.         |
| 109a plugin wiring                         | `packages/idempotency-plugin/src/plugin/idempotency-plugin.ts:30-75`                          | `register()` connects the tier A/B store and registers the service; no `onInit`, no scheduler dependency today. §3.5 adds both.                                                                               |
| `IScheduler.every`                         | `packages/common/src/services/scheduler.ts:109`                                               | The retention purge job (`idempotency-purge`), M108's `inbox-purge` precedent.                                                                                                                                |
| SDK retry gate                             | `packages/sdk/src/retry/retry-strategy.ts:65, 68-75, 104-135`                                 | `SAFE_METHODS` = GET/HEAD/OPTIONS/PUT/DELETE; retryable statuses 408/425/429/5xx; `runWithRetry(fn, policy, method, timing, signal)` decides `canRetry` from the method alone.                                |
| SDK request path                           | `packages/sdk/src/http/http-client.ts:138-311`                                                | Headers built once, request interceptors run ONCE before any attempt, then `runWithRetry(execute)` re-sends the SAME `headers` object — so a key set before the loop is reused on every attempt by structure. |
| `ClientRequest` / `ClientOptions`          | `packages/sdk/src/http/contracts.ts:43-64, 164-196`                                           | Neither interface has an idempotency member today.                                                                                                                                                            |
| SDK randomness                             | `packages/sdk/src/http/observed-fetch.ts:108`                                                 | The SDK already uses `crypto.getRandomValues` behind a guarded availability check — the precedent for key generation (§3.8).                                                                                  |
| 109a server `409`                          | `packages/idempotency-plugin/src/middleware/http-middleware.ts:217-222`                       | A concurrent duplicate answers `409 Conflict`, no `Retry-After`; the record replays once the first request completes. §3.9 retries it.                                                                        |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                      | Resolution (picked side)                                                                                                                                                                                                                                                                                                                  | Doc deliverable (same PR)                                                              |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| C1 | ROADMAP M109 and 109a plan §0 name the entry point `within(uow, key, fn)` — the CALLER's unit of work.                                                                        | `within(options, fn)`: the store opens the transaction. With a caller-owned transaction, a lost race surfaces OUTSIDE `within` — a PostgreSQL insert aborts the caller's transaction so no re-read is possible inside it, and the deferred backends refuse at the caller's commit — so the winner's result could never be returned. §3.3. | ROADMAP M109 "Four entry points" bullet.                                               |
| C2 | ROADMAP M109: "Tier C per backend: SQL, MongoDB and DynamoDB yes; D1 for database-only effects; Cosmos only within one partition; Bigtable no."                               | Cosmos is REFUSED, like M108's inbox: a database-plugin transaction is one container and one partition-key value, and the record lives in its own entity, so it cannot share the business partition. D1 is supported through `DatabasePlugin({ type: 'custom', adapter: D1Adapter })` with the deferred-write caveat (§3.7).              | ROADMAP M109 tier-C bullet.                                                            |
| C3 | ROADMAP M109 `Package(s)`: "109b: `packages/sdk` (the `idempotencyKey` request option) and tier C."                                                                           | 109b: `common`, `idempotency-plugin`, `database-plugin`, `sdk`.                                                                                                                                                                                                                                                                           | ROADMAP `Package(s)` line; Progress row `109b`.                                        |
| C4 | The idempotency-plugin README tier table (`README.md:124-128`) has no tier-C row; only the archived 109a plan (§3.18) describes one, as "Expiry: Backend-specific; Clock: —". | Tier C row: atomic with the business write; expiry is `expiresAt` from `runtime.now()` (wall clock, read by other replicas), and a record stays authoritative until the scheduled purge deletes it (§3.10).                                                                                                                               | idempotency-plugin README tier table gains the row; PUBLIC_API.md idempotency section. |
| C5 | ROADMAP M109 SDK bullet: "an `idempotencyKey` request option, generated once per logical call".                                                                               | Two members: per-request `ClientRequest.idempotencyKey` (a caller's own key) and client-level `ClientOptions.idempotency` (generated keys — how a GENERATED client gets one, since its operations take no per-call options beyond document-declared header parameters, `test/fixtures/generated-client.ts:47-52`).                        | ROADMAP M109 SDK bullet.                                                               |

## 3. Design decisions

### 3.1 The tier-C store port (`common/src/services/idempotency.ts`)

- **Decision:** add, beside the 109a declarations (JSDoc on every member, `@since 0.9.0`, or the
  next unreleased version if 0.9.0 is tagged first):

```ts
/** Discriminator on every tier-C row. */
export const IDEMPOTENCY_RECORD_KIND = 'setu-idempotency';

/** A committed tier-C record, as `find` returns it. */
export interface TransactionalIdempotencyRecord {
  /** 64 lower-case hex: the derived key (§3.2). */
  readonly id: string;
  /** 64 lower-case hex. */
  readonly fingerprint: string;
  /** The encoded result envelope (§3.3). */
  readonly result: string;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  /** Epoch milliseconds: the earliest the purge may delete the record (§3.10). */
  readonly expiresAt: number;
}

/** The claim `run` writes first. */
export interface TransactionalIdempotencyClaim {
  readonly id: string;
  readonly fingerprint: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface ITransactionalIdempotencyStore {
  /** The committed record, or `undefined` when either of its rows is missing or of another `kind`. */
  find(id: string): Promise<TransactionalIdempotencyRecord | undefined>;
  /**
   * ONE transaction: CREATE the claim row (`id`), run `work` with the transaction's scope, then
   * CREATE the result row (`${id}.r`) from the `result` work returns, and commit. Only creates — no
   * update and no delete — so every supported backend can perform it (§3.7). Rejects, rolling
   * everything back, when a create or the commit is refused or `work` throws.
   */
  run<R>(
    claim: TransactionalIdempotencyClaim,
    work: (scope: unknown) => Promise<{ readonly result: string; readonly value: R }>,
  ): Promise<R>;
  /** Deletes the rows of up to `limit` records whose `expiresAt < before`; returns the count. */
  purge(before: number, limit: number): Promise<number>;
  /**
   * Refuses at startup a backend that cannot serve tier C, by name, by running exactly `run`'s write
   * pattern (two creates on distinct keys) in a transaction that always rolls back. Leaves no row.
   */
  verify(): Promise<void>;
}
```

- **Why two rows, creates only:** DynamoDB and D1 have no read-your-own-writes inside a transaction
  — an in-transaction `update` reads committed state and throws (`dynamo-data-source.ts:251-255`,
  `cloudflare-plugin/src/database/d1-data-source.ts:368-381`), and the DynamoDB buffer refuses two
  operations on one item (`dynamo-transaction-buffer.ts:46-53`). Two creates on distinct keys work
  on every supported backend, and the claim row is still created FIRST, which is what makes a
  PostgreSQL loser block on the primary key before running `fn`. A separate port from M108's
  `IInboxStore` because the inbox record carries consumer/topic/parking and no result.
- **Test home:** `packages/common/test/unit/idempotency-contract.test.ts` (extended).

### 3.2 `within` options, result, key and fingerprint

- **Decision:**

```ts
export interface IdempotentWithinOptions {
  /** The client's key: 1–255 characters of 0x21–0x7E, no `"` (109a `parseKeyValue`). */
  readonly key: string;
  /** What the key is for, e.g. `'payments.charge'`. 1–256 characters of 0x20–0x7E. */
  readonly namespace: string;
  /**
   * REQUIRED isolation segment, built ONLY from authenticated identity — typically
   * `JSON.stringify([tenantId, principalId])`. Do not join parts with a separator that can appear
   * inside them: distinct identities can collide. `''` declares the record global on purpose. Never derived for the
   * caller: `within` has no request context.
   */
  readonly scope: string;
  /** Any canonical-JSON value describing the request; a different value under one key is refused. Default: none. */
  readonly fingerprint?: unknown;
  /** Default: the plugin's `transactional.ttlMs` (86,400,000). Integer 60,000–2,592,000,000. */
  readonly ttlMs?: number;
}

export interface IdempotentWithinResult<R> {
  /** The JSON round trip of what `fn` returned — identical on the first call and on a replay. */
  readonly value: R;
  /** `true` when `value` came from a committed record and `fn` did not run in this call. */
  readonly replayed: boolean;
}

// on IIdempotencyService (both REQUIRED):
within<R, S = unknown>(
  options: IdempotentWithinOptions,
  fn: (scope: S) => Promise<R>,
): Promise<IdempotentWithinResult<R>>;
purgeTransactional(): Promise<number>;
```

- `id = deriveHash(['within', namespace, scope, key])`; fingerprint =
  `deriveHash(['within-fp', canonicalJson(fingerprint ?? null)])`. Raw key, scope and namespace are
  never stored.
- `R` is UNCONSTRAINED: a `JsonValue` bound refuses a named `interface` (`TS2322`, measured by the
  plan review), which is how domain types are usually written. JSON-ness is enforced at run time
  (§3.3 step 4), and `value` is the decoded encoding on BOTH paths, so a first call and a replay can
  never differ (a `Date` comes back a string on both paths — the JSDoc says so).
- `S` is the caller's annotation of the scope (an `IUnitOfWork` of the store's database), unchecked
  — the M108 `IntegrationEventInboxHandler<T, S>` precedent.
- **Why:** `scope` is REQUIRED because an omitted principal is 109a's D1 (cross-user replay), and
  `within` cannot derive one. `replayed` lets an HTTP handler answer `200` on a replay and `201`
  otherwise. Both new service members are required: a replacement provider must serve tier C, or
  throws `IdempotencyConfigurationError('transactional', …)` from both — there is no optional half.
- **Test home:** `packages/idempotency-plugin/test/unit/within-options.test.ts`,
  `test/unit/within.test.ts`, the contract test (an `interface` result compiles).

### 3.3 The `within` algorithm

- **Decision:** in this order:
  1. Validate options (§3.13); a key `parseKeyValue` rejects →
     `IdempotencyWithinError
     ('key-invalid')`; a `fingerprint` `canonicalJson` rejects →
     `'fingerprint-invalid'` (its message names key paths of the input, so it is never surfaced). No
     store call.
  2. Derive id and fingerprint; `now = runtime.now()`.
  3. Pre-read `store.find(id)` (bounded by `storeTimeoutMs`). A record, whatever its `expiresAt`:
     different fingerprint → `'fingerprint-mismatch'`; equal → decode, return
     `{ value,
     replayed: true }`.
  4. `store.run(claim, work)`. `work` calls `fn(scope)` inside a try that TAGS a throw as `fn`'s
     own; then encodes `JSON.stringify({ v: value })` (`void` → `{}`), refusing an encoding over
     `maxResultBytes` UTF-8 bytes (`'result-too-large'`) or one `JSON.stringify` throws on or omits
     (`'result-unserializable'`) — inside the transaction, so the work rolls back — and returns
     `{ result, value: decode(result) }`. Resolve → `{ value, replayed: false }`.
  5. On ANY rejection of step 4:
     - `fn`'s own tagged error, or an `IdempotencyWithinError` from step 4 → rethrown UNCHANGED, no
       re-read (nothing committed for this key from this call).
     - Otherwise (a store-side rejection), re-read `find(id)` (bounded; a failing re-read counts as
       absent and is logged per §3.4). Same fingerprint → `{ value, replayed: true }`; different →
       `'fingerprint-mismatch'`; absent → `'conflict'` when the rejection or its cause chain is a
       `DuplicateKeyError` or carries a `409` status hint (the database plugin brands
       `SerializationConflictError`, M90f), else `'store-failed'`. Neither carries the original as
       `cause`.
  - A stored `result` that does not decode to `{ v? }` → `'record-invalid'`; `fn` is never re-run.
- **The honest contract (§3.7):** a loser that fails BEFORE the winner commits — a MongoDB write
  conflict or a DynamoDB transaction conflict — cannot re-read the result yet and rejects
  `'conflict'` (a `409`). A retry then replays. The SDK retries a keyed `409` (§3.9), so a keyed
  client converges. A Prisma transaction timeout (`P2028`) has no `409` mapping: the re-read replays
  if it finds the winner's record, otherwise the call rejects `'store-failed'` (`503`).
- **Why:** the M108 inbox algorithm (pre-read, write first, re-read after a rejection), plus the tag
  that separates `fn`'s errors — which belong to the application and stay unchanged — from store
  errors, whose driver message can list every bound parameter including the result (M108 F1). An
  expired record is NOT replaced: `IRepository.delete` is unconditional and buffered, so two
  transactions that each delete-then-create an expired key both commit on memory and D1 (measured on
  memory by the plan review). A present record therefore stays authoritative until the purge removes
  it (§3.10).
- **Worked example (README):** an HTTP handler calls
  `within({ key: headerKey, namespace:
  'orders.create', scope:`
  ${tenant}:${user.id}`, fingerprint: body }, (uow: IUnitOfWork) => …)` and answers
  `replayed ? 200 : 201`.
- **Test home:** `test/unit/within.test.ts` (fake store), `test/integration/within-kernel.test.ts`
  (memory database), `test/integration/within-real.test.ts` (§6).

### 3.4 Errors and logging

- **Decision:** `IdempotencyWithinError extends Error`,
  `reason: 'key-invalid' |
  'fingerprint-invalid' | 'fingerprint-mismatch' | 'conflict' | 'result-too-large' |
  'result-unserializable' | 'record-invalid' | 'store-failed'`.
  Messages carry no key, scope, namespace, fingerprint input or result, and no `cause`. Status
  hints: `key-invalid` and `fingerprint-invalid` → `400`; `fingerprint-mismatch` → `422`; `conflict`
  → `409`; `store-failed` → `503`; the rest unhinted (a masked `500`). Every store failure the
  plugin sees (pre-read, re-read, `run`, `purge`, `verify`) is logged once with `{ errorKind }` —
  the error's class name — never its message. `verify` exceeding `storeTimeoutMs` rejects `start()`
  with `IdempotencyVerifyTimeoutError` (M108 `InboxStoreVerifyTimeoutError` precedent); a scheduled
  purge without `CAPABILITIES.SCHEDULER` rejects `start()` with
  `IdempotencyConfigurationError('transactional.purge.schedule', …)`; `within` without the option or
  before `onInit` completed → `IdempotencyConfigurationError('transactional', …)`.
- **Why:** M108's F1 (Drizzle error messages quote bound parameters) and its round-1 fix. A store
  error rethrown verbatim would reach the application's `errorHandler`, which logs the cause chain.
- **Test home:** `test/unit/within-errors.test.ts`, `test/unit/within.test.ts`.

### 3.5 Plugin wiring

- **Decision:**
  `IdempotencyPluginOptions.transactional?: { store, ttlMs?, storeTimeoutMs?,
  maxResultBytes?, purge?: { schedule?, intervalMs?, batch? } }`.
  With `transactional` set the plugin declares
  `optionalDependencies: [CAPABILITIES.SCHEDULER, CAPABILITIES.DATABASE]`, resolves `store` at
  `onInit` (so `DatabasePlugin` may register before or after), runs `verify()` bounded by
  `storeTimeoutMs`, schedules `idempotency-purge` unless `purge.schedule` is `false`, and removes
  the job in `onShutdown`. No new health indicator: the record lives in the application database,
  whose own indicator reports reachability; the existing `idempotency` indicator is unchanged.
- **Why:** M108's `inbox` wiring, already audited (factory at `onInit`, verify before first use,
  named refusals).
- **Test home:** `test/integration/within-plugin.test.ts`.

### 3.6 `createDatabaseIdempotencyStore` and the shared backend helper

- **Decision:** `createDatabaseIdempotencyStore({ entity = 'Idempotency', database? })` returns a
  `RegistryFactory<ITransactionalIdempotencyStore>` resolving `CAPABILITIES.DATABASE` (or
  `database.<name>`). Rows: claim
  `{ id, kind, role: 'claim', fingerprint, createdAt, expiresAt,
  result: null }` and result
  `{ id:`${id}.r`, kind, role: 'result', fingerprint, createdAt,
  expiresAt, result }`; `find`
  reads both by id and requires both, matching `kind`. The backend refusal code — `adapterInfoOf`
  Cosmos/Bigtable checks, `isMongoReplicaSetRefusal`, `ProbeRollback` and the rolled-back two-create
  probe — moves to ONE internal module `src/transactional/backend-probe.ts` used by THREE stores:
  the new one, M108's inbox store and M107's outbox store (`database-outbox-store.ts:150-175` holds
  the third copy today). The outbox keeps its own policy on Cosmos (it supports it); the helper
  exposes backend checks and the probe, and each store keeps its own `unavailableReason` mapper and
  refusal set. The tier-C store refuses with a new `TransactionalStoreUnavailableError` (`reason`,
  `entity`); `InboxStoreUnavailableError` and the outbox error keep their names and shapes.
- **Why:** §11.1 — one implementation of "can this backend do a record-first transaction".
- **Test home:** `packages/database-plugin/test/unit/idempotency/*.test.ts`; the existing
  `test/unit/inbox/*` and outbox tests stay green unchanged.

### 3.7 Per-backend behaviour

| Backend                         | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| memory                          | Supported, single process; a concurrent duplicate is refused at commit, re-reads the committed record and replays.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| PostgreSQL (Drizzle)            | Supported; the loser's claim insert blocks on the primary key until the winner commits, then fails and replays. Each blocked loser holds a pooled connection for the length of `fn` (§10 D17).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| PostgreSQL (Prisma)             | As Drizzle: a concurrent loser waits on the winner's unique-key lock and replays. If the winner's transaction outlives the adapter's `transactionTimeout` (default 30 s), the loser's transaction times out and it answers `'store-failed'` (`503`) unless its re-read already finds the winner's record. Not verified against a real Prisma client.                                                                                                                                                                                                                                                                                                                              |
| SQLite (Drizzle, `node:sqlite`) | Supported; one writer at a time, so a concurrent loser fails with a busy/locked error → `'conflict'` or a replay depending on timing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| D1                              | Supported through `DatabasePlugin({ type: 'custom', adapter: D1Adapter })`; writes are deferred to one batch at commit, so `fn` runs before a concurrent duplicate is refused — its OUTSIDE effects run for both.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| MongoDB replica set             | Supported; a concurrent loser is an immediate write conflict → `'conflict'` (no replay while the winner is open). Collections must exist (two transactions creating one implicitly conflict — M108).                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| MongoDB standalone              | Refused, `'mongodb-standalone'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| DynamoDB                        | Supported (deferred, `TransactWriteItems`); a concurrent loser replays the winner's committed result, or rejects `'conflict'` when the service transactions overlap. `TransactionConflictException` → `'conflict'` is documented-unverified on DynamoDB Local (M90f, `packages/database-plugin/test/integration/real-dynamo-adapter.test.ts:591-600`). Writes are deferred, so `fn` runs for both calls in a concurrent pair: database writes commit once, outside effects run twice. Reads are eventually consistent, so a sequential repeat inside the consistency window can miss the record and run `fn` again; its database writes are refused at commit. The purge `Scan`s. |
| Cosmos DB                       | Refused, `'cosmos-unsupported'` (C2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Bigtable                        | Refused, `'bigtable-unsupported'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

- **Test home:** `test/integration/within-real.test.ts` (PostgreSQL via Drizzle, MongoDB RS,
  DynamoDB Local happy path AND duplicate, Bigtable and standalone MongoDB refusals),
  `test/integration/within-d1.test.ts` (D1 over real SQLite: happy path, replay, concurrent
  duplicate).

**Not verified:** tier C against a real PostgreSQL/Prisma client; DynamoDB's overlapping-service
`TransactionConflictException` outcome on DynamoDB Local (M90f). The real PostgreSQL tier-C suite
uses Drizzle, not Prisma.

### 3.8 SDK: where a key comes from

- **Decision:**
  - `ClientRequest.idempotencyKey?: string` — the caller's own key, validated (1–255 characters of
    `0x21`–`0x7E`, no `"`) before any network call; the error names the field, never the value.
  - `ClientOptions.idempotency?: { methods?: readonly string[] (default ['POST', 'PATCH']); header?:
    string (default 'Idempotency-Key'); generateKey?: () => string }`.
    Every request whose method is listed and that has no key gets ONE generated key: 32 hex
    characters from 16 `crypto.getRandomValues` bytes, through `drawNonce` extracted from
    `observed-fetch.ts` into a shared internal `http/random-hex.ts` (§11.1). `crypto` availability
    and the `header` token are checked at `createClient`; `generateKey()`'s OUTPUT is validated on
    every call like a caller's key.
  - Without `ClientOptions.idempotency` the header name is `Idempotency-Key` and only
    `ClientRequest.idempotencyKey` sets it.
  - Conflicts are refused: `ClientOptions.headers` naming the header while `idempotency` is set
    (refused at `createClient` — a static default would key every request identically), and a
    request carrying both `idempotencyKey` and that header in its merged headers.
  - The key is set before request interceptors run.
- **Why:** generated clients have no per-call option other than document-declared header parameters,
  so the client-level option is how they get generated keys (C5). The headers object is built once
  and reused by every attempt (`http-client.ts:168-236`), so "one key per logical call" holds by
  construction.
- **Test home:** `packages/sdk/test/unit/idempotency-key.test.ts`, `test/unit/random-hex.test.ts`.

### 3.9 SDK: which requests retry

- **Decision:** a request is KEYED when `ClientRequest.idempotencyKey` was given or
  `ClientOptions.idempotency` set a key on it — never merely because some header is present, so a
  client that sets neither behaves exactly as today. `runWithRetry` takes `keyed: boolean`
  (internal): a keyed request may retry on ANY method, and retries `409` as well as today's
  statuses. For a keyed method outside the safe set, an error raised AFTER a `2xx` arrived (JSON
  parse, a response interceptor) is never retried — the server executed; `execute` tags the
  rejection by phase.
- **Why:** the key is what makes a non-idempotent method safe to repeat; 109a's middleware answers a
  concurrent duplicate `409`, and tier C answers `'conflict'` `409`. Opt-in detection keeps existing
  callers' behaviour identical.
- **Browser note (README):** `Idempotency-Key` is not a CORS-safelisted request header, so a
  cross-origin keyed request is preflighted; the server's `allowedHeaders` must include it (or omit
  `allowedHeaders`, whose M70m default echoes the request headers).
- **Test home:** `packages/sdk/test/unit/retry-strategy.test.ts` (extended),
  `test/integration/idempotency-roundtrip.test.ts` (a real `IdempotencyPlugin` app over `app.fetch`:
  a dropped first response retried with the same key runs the handler once; the replay header is
  present).

### 3.10 Retention

- **Decision:** a record is authoritative from commit until the purge deletes it; `expiresAt` only
  makes it ELIGIBLE. The purge lists up to `purge.batch` (default 100) eligible claim rows every
  `purge.intervalMs` (default 60,000) and deletes each claim and its result row. The table stays
  bounded only while inflow stays below that rate (README and JSDoc; M108 round-2 NEW-5). A record
  can therefore outlive `ttlMs` by the purge lag, and a key reused after `ttlMs` replays until the
  purge runs — stated. Accepted race: a purge that lists an id, then deletes it after another
  replica purged and a new `within` recreated it, deletes a live record (the window is one list-to-
  delete gap; the cost is one re-execution) — documented.
- **Test home:** `test/integration/within-plugin.test.ts`, the database-plugin store tests.

### 3.11 Clock

- **Decision:** `createdAt`/`expiresAt` from `runtime.now()` (epoch ms) — read by other processes,
  so never `hrtime()`; never `Date.now()`.
- **Test home:** `test/unit/within.test.ts` (fake runtime clock).

### 3.12 Manual purge (Workers)

- **Decision:** with `purge.schedule: false` the application calls `service.purgeTransactional()` (a
  Cron Trigger on Workers); it throws `IdempotencyConfigurationError('transactional', …)` when tier
  C is not configured.
- **Test home:** `test/integration/within-plugin.test.ts`.

### 3.13 Bounds

| Option                         | Default           | Bound                                                                                  |
| ------------------------------ | ----------------- | -------------------------------------------------------------------------------------- |
| `within` `key`                 | —                 | 1–255 chars, `0x21`–`0x7E`, no `"`                                                     |
| `within` `namespace`           | —                 | 1–256 chars, `0x20`–`0x7E`                                                             |
| `within` `scope`               | — (required)      | 0–512 chars, `0x20`–`0x7E`                                                             |
| `ttlMs`                        | 86,400,000        | integer 60,000–2,592,000,000                                                           |
| `transactional.storeTimeoutMs` | 5,000             | integer 1–2,147,483,647                                                                |
| `transactional.maxResultBytes` | 65,536            | integer 2–262,144 (under DynamoDB's 400 KB item limit with the row's other attributes) |
| `purge.intervalMs`             | 60,000            | integer 1–2,147,483,647                                                                |
| `purge.batch`                  | 100               | integer 1–100,000                                                                      |
| SDK `idempotency.methods`      | POST, PATCH       | 1–16 entries, each an HTTP token, upper-cased                                          |
| SDK `idempotency.header`       | `Idempotency-Key` | HTTP token                                                                             |

`NaN`, `Infinity`, negatives and fractions fail every numeric bound (the M90a fail-open class).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none in a published release. `IIdempotencyService.within` and
`purgeTransactional` are required members of an interface first shipping in 0.9.0 (still
`Unreleased`; latest tag `v0.8.0`). Six in-repo test doubles gain them:
`common/test/unit/idempotency-contract.test.ts:112`,
`decorator-plugin/test/integration/idempotent-registration.test.ts:39,149`,
`idempotency-plugin/test/unit/idempotent.test.ts:36,78,102`. `runWithRetry` is internal.

| Exported symbol                                                                       | Kind                | Consumer / real code path that READS it                            |
| ------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------ |
| `IDEMPOTENCY_RECORD_KIND` (common)                                                    | const               | `DatabaseIdempotencyStore` writes and filters on it                |
| `TransactionalIdempotencyRecord` / `…Claim`                                           | interface           | the port's `find` / `run`; `IdempotencyService.within`             |
| `ITransactionalIdempotencyStore`                                                      | interface           | implemented by `database-plugin`; consumed by `IdempotencyService` |
| `IdempotentWithinOptions` / `IdempotentWithinResult`                                  | interface           | `within`'s parameter and return                                    |
| `IIdempotencyService.within` / `purgeTransactional`                                   | members             | application code; the plugin's purge job                           |
| `IdempotencyWithinError`, `IdempotencyWithinErrorReason` (plugin)                     | class, type         | thrown by `within`; `errorHandler` reads the status hint           |
| `IdempotencyVerifyTimeoutError` (plugin)                                              | class               | `start()` rejects with it                                          |
| `TransactionalIdempotencyOptions` (plugin)                                            | interface           | `IdempotencyPluginOptions.transactional`                           |
| `createDatabaseIdempotencyStore`, `DatabaseIdempotencyStoreOptions` (database-plugin) | function, interface | the application's `transactional.store`                            |
| `TransactionalStoreUnavailableError` (database-plugin)                                | class               | thrown by `verify()`; `start()` rejects with it                    |
| `ClientIdempotencyOptions` (sdk)                                                      | interface           | `ClientOptions.idempotency`                                        |
| `ClientRequest.idempotencyKey` (sdk)                                                  | member              | `HttpClient.request`                                               |

### 4.1 Options — every option names its consumer

| Option                                           | Consumer                             | Behavior                                   |
| ------------------------------------------------ | ------------------------------------ | ------------------------------------------ |
| `transactional.store`                            | plugin `onInit`                      | resolved, verified, used by every `within` |
| `transactional.ttlMs`                            | `within`                             | default record eligibility age             |
| `transactional.storeTimeoutMs`                   | `within` reads, `verify`, `purge`    | bounds each call                           |
| `transactional.maxResultBytes`                   | `within` step 4                      | refuses and rolls back a larger result     |
| `transactional.purge.*`                          | plugin `onInit` / purge job          | schedule, interval, batch                  |
| `within` `key/namespace/scope/fingerprint/ttlMs` | `within`                             | §3.2–§3.3                                  |
| `ClientOptions.idempotency.*`                    | `createClient`, `HttpClient.request` | §3.8                                       |
| `ClientRequest.idempotencyKey`                   | `HttpClient.request`                 | §3.8                                       |

## 5. Implementation files

| File                                                                     | Purpose                                                   |
| ------------------------------------------------------------------------ | --------------------------------------------------------- |
| `packages/common/src/services/idempotency.ts`, `src/index.ts`            | §3.1, §3.2 declarations; barrel                           |
| `packages/idempotency-plugin/src/within/within.ts`                       | §3.3 algorithm                                            |
| `packages/idempotency-plugin/src/within/within-options.ts`               | §3.13 validation and defaults                             |
| `packages/idempotency-plugin/src/within/result-codec.ts`                 | result envelope encode/decode                             |
| `packages/idempotency-plugin/src/within/transactional-runtime.ts`        | §3.5 wiring: resolution, verify, purge job                |
| `packages/idempotency-plugin/src/core/error-kind.ts`                     | `errorKind` (class-only log field)                        |
| `packages/idempotency-plugin/src/errors.ts`                              | `IdempotencyWithinError`, `IdempotencyVerifyTimeoutError` |
| `packages/idempotency-plugin/src/service/idempotency-service.ts`         | `within`, `purgeTransactional`                            |
| `packages/idempotency-plugin/src/plugin/idempotency-plugin.ts`           | `transactional` option, `onInit`, `onShutdown`            |
| `packages/idempotency-plugin/src/interfaces/index.ts`, `src/index.ts`    | options, barrel                                           |
| `packages/idempotency-plugin/deno.json`                                  | test `net` grants for the real backends (§6)              |
| `packages/database-plugin/src/transactional/backend-probe.ts`            | §3.6 shared reason + probe (from the inbox and outbox)    |
| `packages/database-plugin/src/idempotency/database-idempotency-store.ts` | the bridge                                                |
| `packages/database-plugin/src/idempotency/errors.ts`                     | `TransactionalStoreUnavailableError`                      |
| `packages/database-plugin/src/inbox/database-inbox-store.ts`             | uses the helper (no behaviour change)                     |
| `packages/database-plugin/src/outbox/database-outbox-store.ts`           | uses the helper (no behaviour change)                     |
| `packages/database-plugin/src/index.ts`                                  | barrel                                                    |
| `packages/sdk/src/http/contracts.ts`                                     | §3.8 members                                              |
| `packages/sdk/src/http/random-hex.ts`                                    | `drawNonce`, extracted and shared                         |
| `packages/sdk/src/http/idempotency-key.ts`                               | key validation and generation                             |
| `packages/sdk/src/http/observed-fetch.ts`                                | uses `random-hex.ts`                                      |
| `packages/sdk/src/http/http-client.ts`                                   | sets the key, computes `keyed`, tags the response phase   |
| `packages/sdk/src/retry/retry-strategy.ts`                               | `keyed` gate, `409`, post-2xx refusal                     |
| `packages/sdk/src/sdk.ts`, `src/index.ts`                                | option validation at `createClient`, barrel               |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                 | src covered                         | Key assertions                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/test/unit/idempotency-contract.test.ts`                           | `services/idempotency.ts`           | port shape; `within` with a named `interface` result compiles; barrel exports; the double gains the two members                                                                                                                                                                                                                                                 |
| `idempotency-plugin/test/unit/within-options.test.ts`                     | `within-options.ts`                 | every §3.13 bound incl. `NaN`/fraction/U+007F; `scope` required at the type level, `''` accepted                                                                                                                                                                                                                                                                |
| `idempotency-plugin/test/unit/result-codec.test.ts`                       | `result-codec.ts`                   | round trip; `void`; first-call value equals the replay value (a `Date` is a string on both); oversized, cyclic, `BigInt`, `undefined` refused; malformed stored text → `record-invalid`                                                                                                                                                                         |
| `idempotency-plugin/test/unit/within.test.ts`                             | `within.ts`, service `within`       | pre-read replay (an expired-but-present record still replays); mismatch; `fn`'s error rethrown unchanged with no re-read; store rejection → re-read → replay / mismatch / `conflict` (DuplicateKeyError, 409 hint) / `store-failed`; failing re-read; no store call on a bad key or fingerprint                                                                 |
| `idempotency-plugin/test/unit/within-errors.test.ts`                      | `errors.ts`, `error-kind.ts`        | status hints per reason; no message carries an input or stored value; no `cause`; `errorKind` never the message (hostile `name`, throwing getter)                                                                                                                                                                                                               |
| `idempotency-plugin/test/integration/within-plugin.test.ts`               | plugin, `transactional-runtime.ts`  | factory resolved with `DatabasePlugin` registered before and after; verify refusal and `IdempotencyVerifyTimeoutError`; no scheduler → refused; purge scheduled, deletes eligible records, removed at shutdown; `within`/`purgeTransactional` without the option                                                                                                |
| `idempotency-plugin/test/integration/within-kernel.test.ts`               | end to end, memory database         | the README handler: `201` then replayed `200`, one business row; `422` and `409` through `errorHandler` in `rfc9457`; a Drizzle-shaped store error's message reaches no log line and no body                                                                                                                                                                    |
| `idempotency-plugin/test/integration/within-real.test.ts`                 | real backends, `ignore:`-guarded    | PostgreSQL (Drizzle): two apps race one key → one business row, the loser replays the same value; MongoDB RS: one business row, the loser `conflict` then replays on retry; DynamoDB Local: happy path, duplicate, and a concurrent pair → one business row, both calls return the winner's value, execution counter 2; Bigtable and standalone MongoDB refused |
| `idempotency-plugin/test/integration/within-d1.test.ts`                   | D1 over real SQLite                 | happy path; replay; concurrent duplicate refused at commit with the outside-effect counter at 2 (documents the caveat)                                                                                                                                                                                                                                          |
| `database-plugin/test/unit/idempotency/*.test.ts`                         | store, errors, `backend-probe.ts`   | two creates per `run`; a foreign-`kind` row is absent and never purged; a claim without its result row is absent; purge deletes both rows and honours `limit`; verify runs `run`'s pattern and leaves no row; Cosmos/Bigtable refused by arm and by class                                                                                                       |
| `database-plugin/test/unit/inbox/*`, outbox tests (existing)              | inbox and outbox after extraction   | unchanged and green — the regression gate for §3.6                                                                                                                                                                                                                                                                                                              |
| `sdk/test/unit/idempotency-key.test.ts`                                   | `idempotency-key.ts`, client wiring | validation of both key sources incl. a bad `generateKey` output; one key on every attempt; default-header and per-request conflicts refused; `crypto` absence and bad `header` refused at `createClient`                                                                                                                                                        |
| `sdk/test/unit/random-hex.test.ts`                                        | `random-hex.ts`                     | 32 hex; refusal without `crypto.getRandomValues`; `observed-fetch` behaviour unchanged                                                                                                                                                                                                                                                                          |
| `sdk/test/unit/retry-keyed.test.ts` (sibling of `retry-strategy.test.ts`) | `retry-strategy.ts`                 | keyed POST retries 5xx, 409 and fetch rejections; keyed POST never retries a post-2xx failure; unkeyed POST and unkeyed 409 unchanged; a client with neither option is byte-for-byte as before; abort still wins                                                                                                                                                |
| `idempotency-plugin/test/integration/idempotency-roundtrip.test.ts`       | sdk ↔ idempotency-plugin            | a real app via `app.fetch`: dropped first response, retry carries the same key, handler ran once, replay header present                                                                                                                                                                                                                                         |

**Real-backend wiring.** `packages/idempotency-plugin/deno.json` gains the test `net` grants the
messaging plugin already carries for these backends (`127.0.0.1:5433`, `127.0.0.1:27018`,
`127.0.0.1:8000`, `127.0.0.1:8086`) — a CLI `--allow-net` replaces the block (M53). The suite reads
`OUTBOX_POSTGRES_URL`, `MONGODB_RS_URI`, `MONGODB_URI`, `DYNAMODB_ENDPOINT_URL` and
`BIGTABLE_EMULATOR_ENDPOINT`, which CI already sets for M107/M108; `test/apps-gate.test.ts` pins the
grants so an `ignore:`-guarded suite cannot skip silently.

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

- §3.6's extraction changes M107's and M108's stores → their existing tests are the regression gate
  and must pass unchanged.
- Deferred backends run `fn` twice for a concurrent duplicate → its database writes still commit
  once; outside effects are at-least-once (README, M108's table carried over).
- A purge removing a record a client still retries against → `ttlMs` ≥ the client retry window,
  documented beside the option.

## 9. Out of scope

- Tier C behind `idempotent()` middleware or the ingress behaviour (§0).
- A per-operation `idempotencyKey` argument in generated clients — codegen (unowned).
- Lease renewal; erase-by-principal — unowned (109a).
- A conditional write on `IRepository` (M105), which would let a record be replaced in place.

## 10. Design security review (recorded before implementation)

Recorded 2026-10-09 before any implementation; revised the same day after the plan review (rows
D17–D20, obligations 8–9). Nothing below is reverse-engineered from code.

**Flows reviewed.** (F1) `within`: client key, caller-supplied scope and fingerprint → derived id →
pre-read → two-create transaction with the business writes → stored result → replay. (F2) The store
boundary: a shared business database, other applications possibly sharing the table. (F3) The
retention purge. (F4) Logs, error messages and error bodies. (F5) The SDK: key generation, header,
retry.

**Assets.** Stored results (may carry personal data); isolation between principals, tenants and
namespaces; the once-only guarantee; database capacity, including the connection pool; log
integrity.

**Attackers.** (A1) An authenticated user choosing keys, including another user's key. (A2) A client
flooding keys — unique ones, or one key concurrently. (A3) A reader of logs and error bodies. (A4)
Developer misconfiguration (an empty or request-derived `scope`, a too-short TTL, the wrong
database). (A5) A party with write access to the idempotency table. (A6) A network observer or a
server seeing SDK keys.

**Approved budgets.** Per `within` call: one SHA-256 over the canonical fingerprint, one pre-read
(two reads by id), one transaction with two creates; one extra read only after a store-side
rejection; nothing beyond the pre-read on a replay. SDK: 16 random bytes per generated key; no extra
request.

**Design-time findings.**

| #   | Finding                                                                                                             | Disposition                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Without principal scope, user B with A's key receives A's stored result (A1)                                        | `scope` REQUIRED (§3.2); JSDoc/README: build it from authenticated identity only; `''` means global on purpose                          |
| D2  | Two namespaces share a key space (A4)                                                                               | `namespace` is part of the derived id                                                                                                   |
| D3  | `422` reveals a key exists (A1)                                                                                     | Accepted once scoped (109a D3); key never echoed                                                                                        |
| D4  | Unique keys grow the table (A2)                                                                                     | Rate limiting upstream; TTL ≤ 30 days; purge with its rate condition stated (§3.10); 64-hex ids                                         |
| D5  | Stored results hold personal data until purged                                                                      | `maxResultBytes`; README: retention counts toward the data inventory; return an id, not a document                                      |
| D6  | Driver errors quote bound parameters — including the result — into logs and error bodies (A3; M108 F1)              | Store errors are never rethrown: `'conflict'`/`'store-failed'` with no `cause`; logs carry `errorKind` only (§3.3–§3.4)                 |
| D7  | A forged or corrupted row (A5) replays an attacker-chosen value                                                     | Decode accepts only the envelope → `record-invalid`; `fn` is never re-run on it; table write access is otherwise the trust boundary     |
| D8  | A row of another `kind` in a shared table is read or purged                                                         | `kind` on every read and purge; `find` requires both rows                                                                               |
| D9  | A lost race returns the wrong result                                                                                | Re-read after a store-side rejection, fingerprint re-checked before a replay                                                            |
| D10 | An oversized or unserializable result commits work with no record                                                   | Refused inside the transaction, so the work rolls back                                                                                  |
| D11 | Deferred backends run outside effects twice                                                                         | Documented (§3.7); database writes still once                                                                                           |
| D12 | A purge deletes a record a client still retries against → the work runs again                                       | `ttlMs` documented against the retry window; floor 60 s; the list-to-delete race documented (§3.10)                                     |
| D13 | Predictable SDK keys let another client pre-claim a key (A1/A6)                                                     | 128 random bits; server scope makes a guessed key useless across principals                                                             |
| D14 | SDK retries a non-idempotent call without a key, or after the server executed                                       | Only KEYED requests retry outside the safe set; never after a `2xx` arrived (§3.9)                                                      |
| D15 | SDK key or header injection (CR/LF), from both key sources                                                          | Both keys validated `0x21`–`0x7E`; header validated as a token at `createClient`                                                        |
| D16 | Keys in client logs or errors                                                                                       | The SDK never logs; refusal messages name the field, never the value                                                                    |
| D17 | One key flooded concurrently: each PostgreSQL loser holds a pooled connection, blocked, for the length of `fn` (A2) | Rate limiting upstream; the pre-read answers completed keys without a transaction; README states the pool cost per concurrent duplicate |
| D18 | Replacing an expired record inside the transaction lets two concurrent calls both commit (memory, D1)               | No replacement (§3.3); a present record is authoritative until purged                                                                   |
| D19 | A result over a backend limit fails at commit with a driver message                                                 | `maxResultBytes` capped at 262,144; the failure surfaces as value-free `'store-failed'` (D6)                                            |
| D20 | A static default `Idempotency-Key` header keys every SDK request identically                                        | Refused at `createClient` when `idempotency` is set (§3.8)                                                                              |

**Obligations the committed-tree audit must meet.**

1. User A's stored result is never returned to a call with a different `scope` or `namespace` for
   the same key, on every supported backend.
2. Two concurrent `within` calls for one key commit the business write ONCE on real PostgreSQL, a
   real MongoDB replica set and DynamoDB Local. On PostgreSQL and DynamoDB Local both calls return
   the winner's value through replay; on MongoDB the loser rejects `'conflict'` and its retry
   replays.
3. No log line, error message, error `cause` or error body contains the key, scope, namespace,
   fingerprint input or stored result; probe with recognizable values on real PostgreSQL with a
   failing store write AND a failing commit.
4. A tampered row (wrong envelope, wrong `kind`, a claim without its result row) is never replayed
   and never purged as ours.
5. An oversized result leaves no record and no business row.
6. Cosmos, Bigtable and standalone MongoDB are refused at `start()`, and the extracted helper leaves
   M107's and M108's refusals unchanged.
7. The SDK sends one key across every attempt, never retries an unkeyed POST or a keyed POST after a
   `2xx`, and refuses a key with a control character from both sources before any network call.
8. Two concurrent calls on an expired-but-unpurged key do not both commit (memory and D1).
9. A client with neither `idempotency` nor `idempotencyKey` retries exactly as before.

## 11. Review dispositions (plan verification, one round)

- M108's inbox purge has the same overlap and shutdown pattern; its correction belongs to a separate
  `fix/…` branch and is outside M109b.

- Implementation deviation: §3.3 and §3.7 assumed a Prisma timeout meant `'conflict'` with a 5 s
  default. Verification found the existing adapter uses `transactionTimeout ?? 30_000`
  (`prisma-adapter.ts:293`), while `classify.ts` maps `P2034`, not timeout `P2028`, to a write
  conflict. The shipped `within` re-read replays a committed winner or answers `'store-failed'`
  (`within.ts:149–159`). The maintainer accepts this as a docs correction; the policy stays
  unchanged, and tier C remains unverified against a real Prisma client.

- Implementation deviation: the slice sequence put the service members after slice 1's port; both
  required `IIdempotencyService` members shipped in slice 1 to keep the contract and its
  implementors compiling together. Accepted by the maintainer.
- Implementation deviation: §6 placed the SDK/plugin round trip under `sdk/test/integration`; it
  shipped under `idempotency-plugin/test/integration` because that suite owns the server application
  and its plugin wiring. Accepted by the maintainer.
- Implementation deviation: §6 extended `retry-strategy.test.ts`; keyed retries shipped in its
  sibling `retry-keyed.test.ts` to keep the opt-in cases together. Accepted by the maintainer.
- Implementation deviation: §3.6 moved `unavailableReason` into the shared helper; each store
  shipped its own mapper because the named errors and refusal policies differ, while backend checks
  and the probe are shared. Accepted by the maintainer.
- Implementation deviation: §3.7 and obligation 2 predicted a DynamoDB loser rejecting `'conflict'`;
  the real DynamoDB Local probe instead measured a conditional-create rejection followed by replay.
  The maintainer accepts both replay and conflict outcomes, with one committed business row and two
  executions on deferred backends. M90f could not reproduce the service's overlapping
  `TransactionConflictException` locally; that outcome remains documented-unverified.

  | Backend              | Raw loser rejection          | `instanceof DuplicateKeyError` | HTTP hint | Final `within` outcome | Executions | Business rows |
  | -------------------- | ---------------------------- | ------------------------------ | --------- | ---------------------- | ---------- | ------------- |
  | PostgreSQL (Drizzle) | `DuplicateKeyError`          | true                           | 409       | replay                 | 1          | 1             |
  | MongoDB replica set  | `SerializationConflictError` | false                          | 409       | `conflict`             | 1          | 1             |
  | DynamoDB Local       | `DuplicateKeyError`          | true                           | 409       | replay                 | 2          | 1             |

| Finding                                                      | Disposition                                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| B1 update inside `run` fails on DynamoDB and D1              | Fixed: two creates, no update (§3.1); `verify` runs the same pattern; happy-path tests on both                |
| B2 expired-row replacement double-commits                    | Fixed: no replacement; authoritative until purged (§3.3, §3.10, D18, obligation 8)                            |
| M1 the loser cannot always replay                            | Fixed: honest contract, `'conflict'` `409`, per-backend rows (§3.3, §3.7, obligation 2)                       |
| M2 store errors leak via rethrow                             | Fixed: `fn` errors tagged and rethrown; store errors value-free (§3.3, §3.4, D6); `fingerprint-invalid` added |
| M3 `JsonValue` bound refuses interfaces                      | Fixed: `R` unconstrained, runtime check, one decoded value on both paths (§3.2)                               |
| M4 optional vs required contradiction                        | Fixed: both members required; six test doubles named (§4)                                                     |
| Minor: outbox third copy                                     | Folded into the extraction (§3.6)                                                                             |
| Minor: C4 misdescribes README                                | Corrected (C4)                                                                                                |
| Minor: named errors, health indicator                        | Decided (§3.4, §3.5)                                                                                          |
| Minor: real-backend wiring                                   | Stated (§6)                                                                                                   |
| Minor: SQLite and D1 conflated                               | Split (§3.7)                                                                                                  |
| Minor: first call vs replay values                           | Fixed (§3.2)                                                                                                  |
| Minor: purge TOCTOU                                          | Documented (§3.10)                                                                                            |
| Minor: §10 missing threats                                   | D17, D19 and the scope-source rule in D1                                                                      |
| Minor: SDK key output, merged headers, `crypto`, `drawNonce` | Fixed (§3.8)                                                                                                  |
| Minor: SDK opt-in, post-2xx, CORS                            | Fixed (§3.9)                                                                                                  |
| Nits                                                         | Citations aligned; C5 narrowed; `namespace`/`scope` restricted to `0x20`–`0x7E`                               |
