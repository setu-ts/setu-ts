# Milestone 90g — Concurrency Loses Work Silently (`@setu-ts/common`, `@setu-ts/database-plugin`, `@setu-ts/cache-plugin`, `@setu-ts/session-plugin`)

> **Status:** Planning. Branch: `feat/m90g-concurrency-loses-work`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Four findings, one shape: **two concurrent requests both answer `200` and one of them did nothing.**
X24-2 measured a read-modify-write through the portable repository API losing an update — on the
memory adapter and, identically, on real PostgreSQL at READ COMMITTED, where it is a lost update by
specification rather than a framework defect. X38 then measured the escapes: `SELECT … FOR UPDATE`
works, a single-statement `UPDATE … SET n = n + delta` works, SERIALIZABLE correctly prevents the
anomaly — and **none of them is expressible through the portable API**. `transaction<T>(work)` takes
one parameter, `IUnitOfWork` exposes exactly one member, and
`grep -rniE "isolation|serializable|repeatable.read|read.committed"` over `packages/common/src`
returns nothing. So a correct concurrent write is adapter-specific by construction, at exactly the
point where portability matters most, and nothing documents the cliff. X22-6 and X24-1 are the same
shape in two more packages: a session commit writes the whole payload as a snapshot, so two
overlapping requests writing different keys lose one; and neither `cacheMiddleware` nor the cache
contract coalesces concurrent misses, so 100 of 100 simultaneous misses reached the origin.

The decision this milestone has to take is the ROADMAP's own: **make the optimistic strategy
portable.** It does not make `FOR UPDATE` portable — a locking read is a different contract — but
paired with M90f's retryable `409` it gives an application one strategy that works on every backend
that can support it and is **refused by name** on every backend that cannot, which is the
`UnsupportedFilterOperatorError` precedent.

- **In scope:** X24-2 and X38-3 (an optional `isolation`, translated per adapter and refused by
  name, plus the memory adapter honouring `'serializable'` for real), X24-1 (in-flight coalescing in
  `cacheMiddleware` and a `CacheService.getOrSet` sharing one implementation), X22-6 (the
  documentation deliverable the finding asks for, plus a committed test that pins the behaviour the
  documentation describes), and the doc deliverables C1–C4.
- **NOT this milestone:** X38-1 (the `409` a conflict must answer with) — **M90f**, and this
  milestone depends on it rather than duplicating it. X38-2 and X35-3 — **M90j**. A portable
  **locking read** (`forUpdate`) or an atomic `increment`-style write — both are contract additions
  to `IRepository` with their own design, named in §9 rather than folded in. Per-key session
  merging, which the finding itself says is a write-model change belonging in its own milestone
  (§3.6). Cross-process cache coalescing (§3.4).

**Package-list note.** The ROADMAP's four packages hold, and the `common` half is narrower than it
looks: `IDatabaseService` and `IUnitOfWork` are declared in **`database-plugin`**
(`interfaces/index.ts:168,187`), not `common`. What `common` owns is the promoted adapter port
`IDatabaseAdapter.beginTransaction()` (`common/src/services/database.ts:340`), which is the one
member an isolation level must reach.

## 1. Contracts verified from SOURCE (not names)

| Reference                            | Source (file:line)                                                             | Verified surface / fact                                                                                                                                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the portable transaction             | `database-plugin/src/interfaces/index.ts:211`                                  | `transaction<T>(work: (uow: IUnitOfWork) => Promise<T>): Promise<T>` — one parameter. Declared in the **plugin**, not `common`.                                                                                                                                                               |
| the Unit of Work's whole surface     | `database-plugin/src/interfaces/index.ts:168-179`                              | `IUnitOfWork` exposes exactly `getRepository()`. No raw query, no locking read. So inside a transaction there is no portable escape at all.                                                                                                                                                   |
| the adapter port `common` owns       | `common/src/services/database.ts:340`                                          | `beginTransaction(): Promise<IAdapterTransaction>` on `IDatabaseAdapter` (promoted in M52c). **This is the one `common` member an isolation level must travel through**, and an optional parameter keeps implementors source-compatible.                                                      |
| the older lifecycle port             | `common/src/services/database.ts:59`                                           | `IOrmAdapter.beginTransaction(): Promise<ITransaction>` — a different, lifecycle-only port. Not widened; naming which of the two is the target is exactly the M10 miss this table exists to prevent.                                                                                          |
| the service's transaction path       | `database-plugin/src/services/database-service.ts:109-131`                     | `const txn = await this._adapter.beginTransaction();` then a `UnitOfWork` over it, `commit()` on success and `rollback()` on throw. One call site to thread options through.                                                                                                                  |
| the Drizzle bridge is app-owned      | `database-plugin/src/query/drizzle-database.ts:113-133`                        | `createDrizzleDatabase(database, transaction, ...unsupportedSynchronousDriver)` — the third slot is a conditional-type **rest** parameter refusing synchronous drivers, so a plain third options parameter is not available (§3.2).                                                           |
| the bridge's invocation              | `database-plugin/src/query/drizzle-database.ts:130`                            | `transaction: (work) => transaction(database, async (tx) => await work(tx))` — the recorded bridge takes only `work`, so an isolation option has nowhere to go without a widening.                                                                                                            |
| the Drizzle open site                | `database-plugin/src/adapters/drizzle/drizzle-adapter.ts:346,354`              | `const transactionBridge = this._transactionBridge!;` then `transactionBridge(async (tx) => …)`.                                                                                                                                                                                              |
| the cache contract                   | `common/src/services/cache.ts:27-54`                                           | `ICacheStore` is exactly `get` / `set` / `delete` / `has` / `clear`. **No `getOrSet`**, so every read-through in every application is hand-written and stampedes by default. Adding a member here is breaking for implementors.                                                               |
| the concrete service                 | `cache-plugin/src/services/cache-service.ts:30-58`                             | `CacheService` implements those five and nothing more. A method added **here** is not breaking (the finding's own preference-2).                                                                                                                                                              |
| the middleware's miss path           | `cache-plugin/src/middleware/cache-middleware.ts:63-68,116-142`                | Resolves an `ICacheStore` **per request** from `options.store ?? CAPABILITIES.CACHE`, reads, and on a miss calls `next()` then `store.set`. Nothing sits between the read and the write, which is X24-1's mechanism exactly.                                                                  |
| the middleware's own header          | `cache-plugin/src/middleware/cache-middleware.ts:128,142`                      | `X-Cache: MISS` on the miss path, `HIT` on the short-circuit. A coalesced waiter is neither, so §3.3 adds a third value rather than lying with an existing one.                                                                                                                               |
| coalescing is already precedent here | M47 (`feature-flags-plugin` LaunchDarkly) and M50 (`service-discovery-plugin`) | "coalesced per key, so a hot loop over an uncached user does not stampede" and "per-service in-flight coalescing". The pattern is built twice in this repository and absent from the caching plugin.                                                                                          |
| session commit writes a snapshot     | `smoke/X22-FINDINGS.md` (X22-6), measured on both strategies                   | Cookie: two divergent snapshots exist at once and the client keeps whichever it processes last. Store: one shared row is overwritten. Same mechanism, different visibility.                                                                                                                   |
| the README paragraph to extend       | `session-plugin/README.md` trade-off paragraph                                 | States one trade-off plainly — a stolen cookie stays valid until expiry — and **points the reader at the store as the remedy**, which loses the write just as readily. `grep -rn -i "concurrent\|race\|last write\|lost"` over the README and `PUBLIC_API.md` returns nothing about sessions. |
| the refuse-by-name precedent         | `database-plugin` `UnsupportedFilterOperatorError` (M70b)                      | A portable operator a backend cannot express is refused with a named error rather than silently downgraded. The shape §3.1 follows.                                                                                                                                                           |
| the brand mechanism                  | `common/src/errors/status-hint.ts:34` and M57 `SECURITY_METADATA`              | `Symbol.for`-keyed brands are this repository's established way to carry an explicit declaration across a function boundary. §3.2 uses it for the bridge.                                                                                                                                     |
| the live-backend guard convention    | `database-plugin/test/integration/real-prisma-adapter.test.ts:106-110`         | `{ ignore: skipReal }` per case on a `DATABASE_URL` guard — never an early `return` (M70c's silent-pass trap).                                                                                                                                                                                |
| §10.2 / §16.1 approval               | `AI_GUIDELINES.md` §10.2, §16.1                                                | The `common` widening and every new export need a `PUBLIC_API.md` row in the same PR.                                                                                                                                                                                                         |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                              | Resolution (picked side)                                                                                                                                        | Doc deliverable (same PR)                                                                                                                                    |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 | `session-plugin/README.md`'s trade-off paragraph names one trade-off "plainly" and points at the **store** as the remedy, while the store loses a concurrent write just as readily — so the one doc site a reader consults is wrong about the remedy. | The paragraph is right about revocation and incomplete about concurrency. Add the second trade-off beside the first, and say the store does **not** remedy it.  | README trade-off paragraph and `PUBLIC_API.md` session section gain the snapshot-commit sentence and the two mitigations (§3.6).                             |
| C2 | `PUBLIC_API.md`'s database section documents `transaction()` as "executes work in a transaction" with no statement about isolation, so a reader cannot learn that a read-modify-write inside it is a lost update on every adapter.                    | A gap, and the one that makes X24-2 a finding rather than a database fact. State the default and the new option together.                                       | `PUBLIC_API.md` and the `database-plugin` README gain an isolation table: the option, the four levels, and the per-adapter support/refusal matrix from §3.1. |
| C3 | `cache-plugin`'s README presents `cacheMiddleware` as protecting an expensive origin and says nothing about concurrent misses, while 100 of 100 reached the handler.                                                                                  | The behaviour changes (§3.3), so the README becomes true — and it gains the two things a reader still needs: the new `X-Cache` value and the per-process limit. | README and `PUBLIC_API.md` cache sections document coalescing, `X-Cache: COALESCED`, `getOrSet`, and that coalescing is per process (§3.4).                  |
| C4 | The ROADMAP's M90g section suggests "an optional `transaction(work, { isolation })` … refused by name where unsupported" and lists `common` first among the packages, implying the contract lives there. It does not.                                 | The suggestion holds; the location is corrected. `IDatabaseService` is plugin-owned; only `IDatabaseAdapter.beginTransaction` is in `common`.                   | ROADMAP M90g section corrected to name the two surfaces separately.                                                                                          |

## 3. Design decisions

### 3.1 One optional isolation level, translated per adapter, refused by name everywhere else

- **Decision:** `common` gains
  `TransactionIsolationLevel = 'read-uncommitted' | 'read-committed' |
  'repeatable-read' | 'serializable'`
  and `TransactionOptions = { readonly isolation?:
  TransactionIsolationLevel }`, and
  `IDatabaseAdapter.beginTransaction(options?: TransactionOptions)` takes it.
  `IDatabaseService.transaction<T>(work, options?: TransactionOptions)` passes it through. An
  adapter that cannot honour a requested level throws the new
  `UnsupportedIsolationLevelError(adapter, level)`, branded `501` with M89b's `withHttpStatusHint`.
  Support matrix:

  | Adapter   | Honoured                                                                        | Refused by name    |
  | --------- | ------------------------------------------------------------------------------- | ------------------ |
  | Prisma    | all four, via `$transaction(fn, { isolationLevel })`                            | none               |
  | Drizzle   | all four, **only** through a bridge declared with `withIsolationSupport` (§3.2) | all four otherwise |
  | Memory    | `'serializable'` (§3.3)                                                         | the other three    |
  | MongoDB   | `'serializable'` → `readConcern: 'snapshot'` + `writeConcern: majority`         | the other three    |
  | D1        | none — a deferred batch has no isolation surface (M52c)                         | all four           |
  | DynamoDB  | none — `TransactWriteItems` is atomic, not levelled                             | all four           |
  | Cosmos DB | none — a batch is scoped to one partition key (M81)                             | all four           |
  | Bigtable  | none — one row is the atomicity unit (M82)                                      | all four           |

- **Why:** silently ignoring an unsupported level is the one outcome that must not ship, because it
  reproduces the exact defect — an application believes it asked for SERIALIZABLE, gets READ
  COMMITTED, and loses the update anyway with a stronger belief that it did not. Refusing by name is
  the established answer here (`UnsupportedFilterOperatorError`, `UnsupportedQueryFeatureError`),
  and the `501` brand means the refusal reaches a developer as a readable response rather than a
  masked `500` — which is only true because M90f lands first. Omitting the option entirely keeps a
  portability cliff that nothing documents; adding a locking read instead is a bigger contract
  change that does not generalise (§9).
- **Test home:** `test/unit/transaction-isolation.test.ts` (the matrix, one case per row) and the
  live suites in §6.

### 3.2 The Drizzle bridge declares isolation support with a brand, never by arity

- **Decision:** export `withIsolationSupport(bridge)` from `database-plugin`. It returns the same
  function branded under a `Symbol.for` key. `DrizzleTransactionBridge` is widened to
  `(database, work, options?: TransactionOptions) => …`, which leaves every existing two-parameter
  bridge assignable. `createDrizzleDatabase` reads the brand and records it; `DrizzleAdapter`
  refuses an isolation request against an unbranded bridge, naming `withIsolationSupport` in the
  message. `createDrizzleDatabase`'s own signature is unchanged.
- **Why:** the bridge is **application-owned** (M69), so the adapter cannot verify that a level it
  passed was honoured — and a widened callback type alone would let an existing two-parameter bridge
  silently drop the option, which is §3.1's forbidden outcome dressed as a type-safe change. Arity
  sniffing (`bridge.length >= 3`) was rejected: a rest parameter or a default argument reports the
  wrong number, so the check would be wrong for correct code. A brand is an explicit act by the
  application, which is the same argument M89b made for requiring `detail` on a hint, and it needs
  no change to `createDrizzleDatabase`'s signature — whose third slot is already a conditional-type
  rest parameter refusing synchronous drivers (`drizzle-database.ts:116-125`) and cannot take an
  options object.
- **Test home:** `test/unit/drizzle-isolation-bridge.test.ts` (branded and unbranded, plus a
  type-level case that a two-parameter bridge still compiles) and
  `test/integration/real-drizzle-adapter.test.ts`.

### 3.3 The memory adapter honours `'serializable'` for real, with a process-local mutex

- **Decision:** `MemoryAdapter.beginTransaction({ isolation: 'serializable' })` serializes
  transactions through a process-local queue, so a read-modify-write inside one cannot interleave
  with another. The other three levels are refused by name.
- **Why:** X24-2 measured the memory adapter losing the update, which makes the default adapter the
  one place an application cannot even develop a correct concurrent write. A store with a single
  in-process owner can provide serializability exactly, so refusing would be a double that rejects
  what production accepts — the inverse of this register's usual complaint and equally misleading.
  The limit is stated rather than implied: it is process-local, so it is a development and
  single-replica guarantee and not a distributed one.
- **Test home:** `test/unit/memory-isolation.test.ts` — the X24-2 probe, verbatim, asserting `80`
  with `'serializable'` and `90` without it. The second assertion is what keeps the test honest: it
  pins that the default is unchanged.

### 3.4 Cache coalescing lives in one implementation, read by both entry points

- **Decision:** an internal `createCoalescer()` in `cache-plugin` holds a
  `WeakMap<object, Map<string, Promise<unknown>>>` keyed by the resolved store instance and then by
  key. `cacheMiddleware` uses it on the miss path, and a new
  `CacheService.getOrSet(key, factory,
  ttlSeconds?)` uses the same registry. A waiter replays the
  leader's stored payload and answers `X-Cache: COALESCED`. Entries are removed in a `finally`. If
  the leader **fails**, the in-flight promise rejects and each waiter then runs the origin itself —
  exactly what would have happened without coalescing.
- **Why:** the finding lists three fixes in preference order and the first two are the same
  mechanism; shipping them as two would be the split that produced every "one capability, two
  implementations" defect in this register — a middleware that coalesces and a `getOrSet` that does
  not would be worse than neither. `getOrSet` goes on the concrete `CacheService` and **not** on
  `ICacheStore`, because the contract is implemented outside this repository and a required member
  is breaking (the finding says so, and the M74 `peek` decision is the counter-case where every
  implementor was in-repo). A third `X-Cache` value rather than reusing `HIT`: X24-1 was measured by
  reading that header's distribution, so a distinct token is what makes the fix observable to the
  same probe. The failure path deliberately preserves today's behaviour so coalescing can never make
  a failing origin worse.
- **Test home:** `test/unit/coalescer.test.ts`, `test/integration/cache-stampede.test.ts` (the X24-1
  probe: 100 concurrent requests, one handler invocation, 1 `MISS` and 99 `COALESCED`), and a
  leader-failure case asserting each waiter reaches the origin.

### 3.5 Coalescing is per process, and that is stated rather than implied

- **Decision:** no cross-replica coordination. The README and `PUBLIC_API.md` say that N replicas
  produce at most N origin calls per key.
- **Why:** cross-process coalescing needs a distributed lock, which is a different capability
  (`IDistributedLock`, M18) and a different failure model — a lock holder that dies leaves every
  waiter blocked, which is worse than a stampede. Both prior in-repo coalescers (M47, M50) are
  per-process for the same reason. Stating the bound is what stops a reader assuming a guarantee the
  code does not make, which is this whole milestone's theme.
- **Test home:** none — a doc deliverable, verified by `deno task check:docs`.

### 3.6 The session row ships documentation plus a test that pins the documented behaviour

- **Decision:** no write-model change. `session-plugin`'s trade-off paragraph gains the second
  trade-off, naming both mitigations (hold session writes to one request; keep concurrently-written
  state out of the session) and saying explicitly that the store does not remedy it. A new committed
  test reproduces X22-6 on **both** strategies and asserts the loss.
- **Why:** the finding is explicit that snapshot commit is defensible — it is what makes the cookie
  strategy self-contained and rotation simple — and that per-key merging is a write-model change
  belonging in its own milestone. What made it a finding is that the README has a paragraph whose
  stated job is exactly this and it names a different trade-off, then points at the store as the
  remedy. A doc sentence alone can drift; a test that asserts the documented loss cannot, and it is
  the M77 executable-prose precedent applied to behaviour.
- **Test home:** `session-plugin/test/integration/concurrent-writes.test.ts`.

### 3.7 Nothing changes for an application that passes no options

- **Decision:** `transaction(work)` with no second argument behaves byte-identically to today on
  every adapter, and `cacheMiddleware` with no new option coalesces — which is a behaviour change
  and is recorded as one.
- **Why:** the isolation option is opt-in because a default of `'serializable'` would change every
  existing application's throughput and failure profile without asking. Coalescing is **not**
  opt-in, because an application cannot be relying on N origin calls for one key: the middleware's
  documented purpose is protecting the origin, and the only observable difference is a new `X-Cache`
  value and fewer handler invocations. The asymmetry is deliberate and stated in the CHANGELOG.
- **Test home:** `cache-plugin/test/integration/no-options-unchanged.test.ts` (extended) and
  `database-plugin/test/integration/database-plugin.test.ts`.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                      | Kind      | Consumer / real code path that READS it                                                                                                                              |
| ---------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TransactionIsolationLevel` (`common`)               | type      | The parameter type of `IDatabaseAdapter.beginTransaction` and `IDatabaseService.transaction`; read by every adapter's translation.                                   |
| `TransactionOptions` (`common`)                      | interface | Same.                                                                                                                                                                |
| `UnsupportedIsolationLevelError` (`database-plugin`) | class     | Thrown by six adapters; read by an application's `catch` and by `errorHandler` through its `501` brand.                                                              |
| `withIsolationSupport` (`database-plugin`)           | fn        | Called by an application building a Drizzle bridge; **read by `createDrizzleDatabase`**, which records the brand, and by `DrizzleAdapter`, which refuses without it. |
| `CacheService.getOrSet` (`cache-plugin`)             | method    | Called by an application writing a read-through; shares `createCoalescer` with `cacheMiddleware`.                                                                    |

`session-plugin` exports nothing new. Each changed barrel gets a `barrel-exports.test.ts` case (the
M56 defect class).

### 4.1 Options — every option names its consumer

| Option                                   | Consumer                                      | Behavior (per implementation)                                                                                           |
| ---------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `TransactionOptions.isolation`           | every adapter's `beginTransaction`            | Honoured per the §3.1 matrix; refused by name otherwise. Absent → today's behaviour on every adapter.                   |
| `CacheMiddlewareOptions` (no new member) | —                                             | Coalescing is unconditional (§3.7). An opt-out was rejected: it would preserve the defect as a supported configuration. |
| `CacheService.getOrSet`'s `ttlSeconds`   | `CacheService.set` after the factory resolves | Omitted → the service's configured default TTL, exactly as `set` behaves today.                                         |

## 5. Implementation files

| File                                                                                     | Purpose                                                                                           |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `common/src/services/database.ts`                                                        | `TransactionIsolationLevel`, `TransactionOptions`; `IDatabaseAdapter.beginTransaction(options?)`. |
| `common/src/index.ts`                                                                    | Exports both types.                                                                               |
| `database-plugin/src/interfaces/index.ts`                                                | `IDatabaseService.transaction(work, options?)`; `DrizzleTransactionBridge` widened.               |
| `database-plugin/src/services/database-service.ts`                                       | Threads options into `beginTransaction`.                                                          |
| `database-plugin/src/errors.ts`                                                          | `UnsupportedIsolationLevelError`, branded `501`.                                                  |
| `database-plugin/src/query/drizzle-database.ts`                                          | `withIsolationSupport`; the brand recorded alongside the bridge.                                  |
| `database-plugin/src/adapters/{drizzle,prisma,mongo,memory,d1,dynamo,cosmos,bigtable}/…` | Per-adapter translation or refusal.                                                               |
| `cache-plugin/src/services/coalescer.ts`                                                 | `createCoalescer` and the per-store registry.                                                     |
| `cache-plugin/src/services/cache-service.ts`                                             | `getOrSet`.                                                                                       |
| `cache-plugin/src/middleware/cache-middleware.ts`                                        | The miss path joins or leads; `X-Cache: COALESCED`.                                               |
| `session-plugin` — no `src` change                                                       | Documentation only (§3.6).                                                                        |
| `README.md` × 3, `PUBLIC_API.md`, `ROADMAP.md`, `CHANGELOG.md`                           | C1–C4 and the behaviour entries.                                                                  |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                  | src covered                      | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                            |
| -------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database-plugin/test/unit/transaction-isolation.test.ts` (new)            | every adapter                    | One case per §3.1 matrix row: honoured levels reach the driver with the translated value (asserted on a recording fake), refused levels throw `UnsupportedIsolationLevelError` naming the adapter and the level, and the `501` brand is readable via `httpStatusHintOf`.    |
| `database-plugin/test/unit/memory-isolation.test.ts` (new)                 | `adapters/memory/…`              | The X24-2 probe verbatim: `'serializable'` yields `80`; no option yields `90` (the default is unchanged).                                                                                                                                                                   |
| `database-plugin/test/unit/drizzle-isolation-bridge.test.ts` (new)         | `query/drizzle-database.ts`      | A branded bridge receives `TransactionOptions` as its third argument; an unbranded one causes a refusal naming `withIsolationSupport`; a two-parameter bridge still type-checks (a compile-time case).                                                                      |
| `database-plugin/test/integration/real-prisma-adapter.test.ts` (extended)  | `adapters/prisma/…`              | Guarded on `DATABASE_URL`: the X24-2 probe at `'serializable'` against real PostgreSQL yields `80`, and a `40001` that M90f reports as `409` is equally correct — the test accepts exactly those two outcomes rather than picking the one a single run happened to produce. |
| `database-plugin/test/integration/real-drizzle-adapter.test.ts` (extended) | `adapters/drizzle/…`             | Same, through a branded bridge; and an unbranded bridge refuses without touching the database.                                                                                                                                                                              |
| `database-plugin/test/integration/real-mongo-adapter.test.ts` (extended)   | `adapters/mongo/…`               | `'serializable'` reaches `startTransaction` with a snapshot read concern; the other three refuse.                                                                                                                                                                           |
| `cache-plugin/test/unit/coalescer.test.ts` (new)                           | `services/coalescer.ts`          | One leader for N waiters; the registry is empty after settlement (no leak); a rejecting leader leaves the key clear and each waiter re-runs; two different stores do not share a key.                                                                                       |
| `cache-plugin/test/integration/cache-stampede.test.ts` (new)               | `middleware/cache-middleware.ts` | The X24-1 probe: 100 concurrent requests to a 300 ms handler produce **1** handler invocation, `X-Cache` distribution `{ MISS: 1, COALESCED: 99 }`, and identical bodies. Vacuity-checked first, exactly as the finding did: request 1 `MISS`, request 2 `HIT`.             |
| `cache-plugin/test/unit/cache-service.test.ts` (extended)                  | `services/cache-service.ts`      | `getOrSet` calls the factory once for N concurrent callers, stores the value, and honours an explicit and a defaulted TTL.                                                                                                                                                  |
| `cache-plugin/test/integration/no-options-unchanged.test.ts` (extended)    | `middleware/cache-middleware.ts` | A sequential MISS→HIT pair is byte-identical to today, including headers.                                                                                                                                                                                                   |
| `session-plugin/test/integration/concurrent-writes.test.ts` (new)          | documentation guard              | Two overlapping requests on one cookie: the cookie strategy produces two divergent snapshots and the store strategy loses one write — the exact behaviour C1 documents.                                                                                                     |
| `*/test/unit/barrel-exports.test.ts` (extended, three packages)            | each `src/index.ts`              | The added symbols are exported and nothing else joined.                                                                                                                                                                                                                     |

**Negative controls to run and revert before hand-off**, each observed failing:

1. Make an unsupported level a silent no-op instead of a refusal → the matrix cases fail; this is
   §3.1's forbidden outcome made observable.
2. Drop the brand check in `DrizzleAdapter` and pass options to any bridge → the unbranded case
   passes silently while the real-Drizzle case still passes, which is precisely why the brand
   exists.
3. Remove the `finally` that clears the coalescer entry → the leak assertion fails while every
   stampede assertion still passes.
4. Point the stampede test at a handler with no delay → the coalescing window closes and the
   distribution reverts toward `MISS`. This one must be observed **passing** with the defect
   reintroduced, because it is the vacuity trap the finding itself checked for.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m90g-concurrency-loses-work, never main
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:docs
deno task publish:check     # on a COMMITTED tree
deno task release:verify 0.4.0
```

Plus, with PostgreSQL and MongoDB up so the guarded isolation rows run rather than being ignored:

```bash
DATABASE_URL=postgres://… MONGO_URL=… deno task test
```

## 8. Risks & mitigations

- **This milestone reads best after M90f.** The `501` refusal and the `409` conflict both depend on
  M89b's hint being honoured, and the optimistic strategy is only usable once a conflict is
  reportable. Mitigation: nothing here **requires** M90f to compile — a refusal without M90f is a
  masked `500`, which is today's behaviour — so the order of the two is free, and the CHANGELOG
  entry names the pairing.
- **The isolation matrix is eight adapters wide and only three are honoured**, so most of the work
  is refusals. Mitigation: that is the deliverable — a documented, tested refusal is what turns an
  undocumented portability cliff into a contract — and the matrix is a single table read by one
  test.
- **Coalescing changes an unconditional behaviour.** Mitigation: the only observable differences are
  a new `X-Cache` value and fewer handler invocations; the sequential path is pinned byte-identical;
  and the leader-failure path is pinned to today's behaviour so a failing origin is never worse.
- **A coalesced waiter must not replay a streaming response.** Mitigation: `cacheMiddleware` already
  skips `encodePayload` when `snapshot().streaming === true` (M42), so a streaming response is never
  a cache candidate and never a coalescing candidate; a test pins that a streaming route is
  untouched.
- **The memory adapter's new mutex could deadlock a nested transaction.** Mitigation: a test opens a
  transaction inside a transaction and asserts the documented behaviour rather than a hang, with a
  bounded timeout so a regression fails instead of stalling the suite.

## 9. Out of scope

- **A portable locking read** (`forUpdate` on `IRepository`, or a `SELECT … FOR UPDATE` equivalent)
  — a contract addition with its own per-adapter matrix, and the strategy that does **not**
  generalise: four of the eight adapters have no lock to take.
- **An atomic arithmetic write** (`UPDATE … SET n = n + delta`) — the other working escape X38
  measured, and a different contract question (an expression language in a portable update).
- **Per-key session merging** — the finding's own words: a write-model change belonging in its own
  milestone.
- **Cross-process cache coalescing** — needs `IDistributedLock` and has a worse failure mode (§3.5).
- **X38-1's `409`** — **M90f**. **X38-2 / X35-3** — **M90j**.
- **`query()`'s availability on instances that refuse it** (X12-2) — noted in X38-3 as compounding
  the cliff, settled in M70j, and unchanged here.
