# Milestone 90f — Caller Errors Reach the Client Correctly (`@setu-ts/common`, `@setu-ts/runtime`, `@setu-ts/kernel`, `@setu-ts/testing`, `@setu-ts/database-plugin`, `@setu-ts/resilience-plugin`, `@setu-ts/secrets-plugin`)

> **Status:** Planning. Branch: `feat/m90f-caller-errors-reach-the-client`. `main` is protected —
> all work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

One rule, applied consistently: **a condition the caller caused, or can act on, must not arrive as
`500`.** M89b built the mechanism (`withHttpStatusHint`) and closed two instances; this is five
more, in four packages, and the reason they are one milestone rather than five is that each
individually looks like a one-line brand while together they force one decision about which status
each class of condition takes. Getting that decision made once is the deliverable; branding is the
cheap part.

The sharpest row is X38-1. PostgreSQL answers a serialization failure with SQLSTATE **`40001`** —
the canonical machine-readable "this did not happen, run it again" — and the framework converts it
into `500 Internal Server Error`, which by convention means the opposite. A well-behaved client does
not retry, so the write is **silently dropped**; and because a `500` is indistinguishable from a
bug, optimistic concurrency — the standard answer to M90g's lost update — becomes unusable. The
backend supplied the classifier and the boundary discarded it.

- **In scope:** X38-1 (SQLSTATE class 40 → `409`), X35-2 (connection-acquisition exhaustion →
  `503`), X37-1 (a malformed JSON request body → `400`), X20-2 (`set`/`rotate` on a read-only
  secrets provider → `501`), X32-7 (`BulkheadFullError` → `503`, `CircuitOpenError` → `503`,
  `TimeoutError` → `504`), and the doc deliverables C1–C4 below.
- **NOT this milestone:** X38-2 (`serializeError` drops the SQLSTATE) and X35-3 (seven
  catch-then-throw sites destroy their cause) — **M90j**, which owns what the **operator** is left
  with after masking has correctly done its job. This milestone is about what the **caller** is
  told, and the two are deliberately separate letters. X38-3 and X24-2 (the portable API cannot
  express a correct concurrent write) — **M90g**; this milestone makes the _optimistic_ strategy
  reportable, which is M90g's precondition and not its fix. X20-3 (`set()` cannot create a secret on
  AWS or GCP) and X20-5 — deliberately ungrouped in the ROADMAP register. X22-5 (a `403` naming the
  required role) — **M90c**. The masking default itself, which stays (§3.7).

**Package-list correction.** The ROADMAP names `secrets-plugin`, `resilience-plugin`, `auth-plugin`,
`database-plugin`, `kernel`, `exceptions` — the M70b / M70g / M70h / M70k / M90a precedent applies
and three of those do not survive source-checking:

- **`runtime` and `testing` are added, and they are where X37-1 actually lives.** `IRequest.json()`
  has **three** implementations — `runtime/src/adapters/shared/fetch-mapping.ts:166` (the real HTTP
  path), `kernel/src/application/application.ts:539` (`inject`) and
  `testing/src/mock-context.ts:207`. Fixing only the kernel's would leave every served request
  answering `500` while the in-process test path answered `400`, which is the contract-violating
  double this register keeps finding. This is the same correction M90a made for X32-4.
- **`common` is added**, because those three copies are the same two lines and §11.1 forbids fixing
  one of three (§3.3).
- **`exceptions` needs no `src` change.** M89b already taught `errorHandler` to read the hint before
  it normalizes and before it masks; every row here reaches that reader unchanged. It keeps a doc
  deliverable only.
- **`auth-plugin` is dropped.** No X-row in this letter assigns it; the auth-shaped row the section
  was reaching for is X22-5, which belongs to M90c.

## 1. Contracts verified from SOURCE (not names)

| Reference                            | Source (file:line)                                                                                 | Verified surface / fact                                                                                                                                                                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the mechanism                        | `common/src/errors/status-hint.ts:141-149`                                                         | `withHttpStatusHint<T extends Error>(error, hint): T` brands **in place**, symbol-keyed, non-enumerable, `configurable: true`, `writable: false`, and returns the same reference.                                                                  |
| branding a foreign object can throw  | `common/src/errors/status-hint.ts:122-124` (`@throws`)                                             | `TypeError` when the error is frozen, sealed, or not extensible. **This is why §3.1 wraps rather than brands a driver's own error object.**                                                                                                        |
| the hint's shape                     | `common/src/errors/status-hint.ts:89-106`                                                          | `HttpStatusHint extends ErrorResponseInit` with `detail` narrowed to **required**, deliberately, so the caller-facing sentence is an explicit act and a hinted response can be exempted from masking without widening disclosure.                  |
| the hint carries no headers          | `common/src/errors/error-responder.ts:146-158`                                                     | `ErrorResponseInit` is `{ status, title, detail?, details? }` — **no header channel**. So `Retry-After` is not expressible through a hint today, which §3.5 decides about rather than assumes around.                                              |
| the established brand pattern        | `database-plugin/src/errors.ts:145,193,233,289`                                                    | `withHttpStatusHint(this, { status, title, detail })` inside the constructor, at four sites. The shape every new error class here follows.                                                                                                         |
| the one wrapping choke point         | `database-plugin/src/services/database-service.ts:92,119`                                          | `this.wrapDataSource(entity, …)` wraps **every** data source — the plain repository at `:92` and the transaction-scoped one at `:119`. One interception point covers both, inside and outside a transaction.                                       |
| the two paths that bypass it         | `database-plugin/src/services/database-service.ts:109-131,140-153`                                 | `transaction<T>(work)` catches, rolls back and **rethrows verbatim**; `query<T>` delegates to `this._adapter.rawQuery` unwrapped. Both need the classifier explicitly (§3.1).                                                                      |
| the driver error's shape             | `smoke/X38-FINDINGS.md` (X38-1), measured cause chain                                              | depth 0 `Error "Failed query: update x38.account …"` (drizzle-orm's own wrapper), depth 1 `error "could not serialize access due to concurrent update"` carrying `code: '40001'`. So the classifier must walk the **cause chain**.                 |
| the typed-builder escape             | `database-plugin/src/services/database-service.ts:73` and M69                                      | A caller reaching the native Drizzle builder through `getDrizzleDatabase` bypasses `wrapDataSource` entirely. Named in §9 rather than silently uncovered.                                                                                          |
| `EnvProvider`'s refusal              | `secrets-plugin/src/providers/env-provider.ts:83-88`                                               | `set` rejects with a plain `Error('EnvProvider is read-only; …')`. `ls packages/secrets-plugin/src` shows **no `errors.ts` at all** and `grep -rln withHttpStatusHint packages/secrets-plugin/src` is empty — the package has no error vocabulary. |
| resilience's three errors            | `resilience-plugin/src/errors.ts:16,29,42`                                                         | `TimeoutError`, `BulkheadFullError`, `CircuitOpenError` — all plain `extends Error` setting only `name`. `grep -rln withHttpStatusHint packages/resilience-plugin/src` is empty.                                                                   |
| the three `json()` producers         | `runtime/…/fetch-mapping.ts:166`, `kernel/…/application.ts:539`, `testing/src/mock-context.ts:207` | Each is its own `JSON.parse(await this.text())`. `common/src/http.ts:94` declares `json<T = unknown>(): Promise<T>` and says nothing about failure.                                                                                                |
| the body is cached and idempotent    | `runtime/src/adapters/shared/fetch-mapping.ts:8-12`                                                | `json()`/`text()`/`bytes()` are idempotent because several first-party middlewares read the body and hand it on. **So a parse failure can be raised more than once per request** and must be cheap and identical each time.                        |
| `errorHandler` reads the hint        | M89b, `exceptions/src/middleware/error-handler.ts`                                                 | The hint is consulted before a non-`HttpError` is normalized to `500` and before masking. Nothing in `exceptions` changes here.                                                                                                                    |
| the end-to-end guard precedent       | `database-plugin/test/integration/refusal-status.test.ts:1-31`                                     | Drives a **real** `createApplication` with a real adapter, because "the defect lived in the last step, so a test that asserted the thrown error in isolation would have passed with the symptom in place". The shape every §6 guard takes.         |
| the live-PostgreSQL guard convention | `database-plugin/test/integration/real-prisma-adapter.test.ts:106-110`                             | `describe(… )` with per-case `{ ignore: skipReal }` on a `DATABASE_URL` guard — `ignore:`, never an early `return` (M70c's silent-pass trap).                                                                                                      |
| §2.2 dependency direction            | `AI_GUIDELINES.md` §2.2                                                                            | No plugin imports another; `common ← kernel ← plugins`. A shared JSON-parse helper therefore belongs in `common`, which `runtime`, `kernel` and `testing` all already import.                                                                      |
| §10.2 / §16.1 approval               | `AI_GUIDELINES.md` §10.2, §16.1                                                                    | The `common` addition and the four new error classes each need a `PUBLIC_API.md` row in the same PR; the status changes need `CHANGELOG.md`.                                                                                                       |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                   | Resolution (picked side)                                                                                                                                                                                                              | Doc deliverable (same PR)                                                                                                                                               |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | The ROADMAP's M90f table gives X35-2 and X32-7 the answer "`503` + `Retry-After`", while `ErrorResponseInit` (`common/src/errors/error-responder.ts:146-158`) has no header channel, so a hint cannot carry `Retry-After`. | Ship the **status** and decline the header, with the reason recorded rather than the shortfall left implicit (§3.5). Widening `common` to carry a value the framework would have to invent is worse than omitting an optional header. | ROADMAP M90f table corrected to "`503`"; `PUBLIC_API.md` states that hinted backpressure answers carry no `Retry-After` and why, beside the rate limiter's, which does. |
| C2 | `common/src/http.ts:94` documents `IRequest.json()` with no `@throws`, so a caller cannot learn that a malformed body rejects — nor, after this milestone, that the rejection is branded.                                  | A gap. State it on the contract, since three implementations must now agree about it.                                                                                                                                                 | `common/src/http.ts` JSDoc gains `@throws`; `PUBLIC_API.md` request section states the `400`.                                                                           |
| C3 | `resilience-plugin`'s README presents the three errors for `instanceof` handling and says nothing about the status a caller sees, so the framework's own load-shedding signal reads as a fault in every dashboard.         | State it, and state that shedding is the bulkhead's purpose so the status is part of the contract rather than an implementation detail.                                                                                               | README error table gains a status column; `PUBLIC_API.md` resilience section gains the three mappings.                                                                  |
| C4 | `secrets-plugin`'s README documents `set`/`rotate` per provider and `EnvProvider` as read-only, without saying what a caller sees. X20-3 records that `set()` already means four different things across five providers.   | State the `501` here. The four-meanings problem is **M90h's** row and is not resolved by this milestone — the doc deliverable says only what this milestone makes true.                                                               | README and `PUBLIC_API.md` secrets sections state the `501` and name `ReadOnlySecretProviderError`.                                                                     |

## 3. Design decisions

### 3.1 The database rows wrap rather than brand, and classify in one place

- **Decision:** add `database-plugin/src/errors/classify.ts` exporting an internal
  `classifyDriverError(error: unknown): 'conflict' | 'unavailable' | null` that walks the `cause`
  chain with guarded reads. `DatabaseService` calls it at three sites — inside `wrapDataSource`'s
  per-method wrappers, in `transaction`'s `catch`, and around `query`'s delegation — and throws a
  package-owned `SerializationConflictError` (`409`) or `DatabaseUnavailableError` (`503`) carrying
  the original as `cause`. A `null` classification rethrows the original untouched.
- **Why:** branding the driver's own error in place is the tempting minimal fix and it can **throw**
  — `withHttpStatusHint` raises `TypeError` on a frozen or sealed error (`status-hint.ts:122-124`),
  which would replace a `409` with a fault raised by the error path itself. Wrapping also gives the
  application something to `catch` by class, which is what X38-1 says a retry loop needs and what a
  driver-owned error type cannot portably provide. The cause chain is preserved, so M90j's
  operator-facing work still reaches the SQLSTATE. And one classifier at one choke point is what
  keeps the six adapters from disagreeing: `wrapDataSource` already wraps every data source both
  inside and outside a transaction (`database-service.ts:92,119`), so the interception is contained
  rather than sprayed across adapters.
- **Test home:** `test/unit/classify-driver-error.test.ts` (the table, plus a cause chain, plus a
  frozen error, plus a thrown non-`Error`), `test/integration/refusal-status.test.ts` (extended, end
  to end), and the live suites in §3.2.

### 3.2 The signal table is per backend, and each entry says whether a real backend pins it

- **Decision:** `classifyDriverError` reads a **code** first and falls back to a small set of exact
  message anchors. The table ships as:

  | Backend                      | `conflict` (`409`)                                                               | `unavailable` (`503`)                                                        | Pinned by                     |
  | ---------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------- |
  | PostgreSQL (drizzle, prisma) | SQLSTATE class **40** (`40001` serialization_failure, `40P01` deadlock_detected) | SQLSTATE class **08**, `57P03` cannot_connect_now, and the pool anchor below | live PostgreSQL, guarded      |
  | MongoDB                      | the `TransientTransactionError` error label                                      | `MongoNetworkError` / `MongoServerSelectionError` by `name`                  | live MongoDB, guarded         |
  | DynamoDB                     | `TransactionConflictException`                                                   | `ProvisionedThroughputExceededException`, `ThrottlingException`              | DynamoDB Local in CI          |
  | Bigtable                     | gRPC `ABORTED` (10)                                                              | gRPC `UNAVAILABLE` (14)                                                      | the Bigtable emulator in CI   |
  | Cosmos DB                    | `449` Retry With                                                                 | `429` Too Many Requests, `503`                                               | the local-only emulator suite |
  | Memory                       | none                                                                             | none                                                                         | not applicable (no driver)    |

- **Why:** covering only PostgreSQL would leave the portable API meaning different things per
  backend, which is the complaint the register keeps making about this package (M70j, M79). Reading
  a code first is the whole point of X38-1 — the classifier the backend supplied — and the message
  anchors exist only where no code is carried, each with a real-backend test that fails if the
  driver's text changes, which is the only thing that makes a message match safe. The Cosmos row is
  marked local-only rather than quietly claimed, because its emulator image is 2.48 GB and is
  deliberately not in CI (M81).
- **Test home:** one `it` per row in the corresponding `test/integration/real-*.test.ts`, each
  guarded with `ignore:` and each asserting the wrapped class rather than the message.

### 3.3 One JSON parse, in `common`, read by all three implementations

- **Decision:** `common` gains `parseJsonBody(text: string): unknown` (internal to the request
  contract's module, exported from the barrel so `runtime`, `kernel` and `testing` can each import
  it) which throws `MalformedRequestBodyError` — a new `common` error class branded `400` at
  construction and carrying the platform `SyntaxError` as `cause`. All three `json()`
  implementations call it.
- **Why:** the three copies are the same two lines, and fixing the kernel's alone — which is what
  the ROADMAP's package list would produce — leaves every **served** request answering `500` while
  the in-process test path answers `400`. That divergence is worse than the original defect, because
  it makes a test prove the opposite of production. Putting the parse in `common` also gives the
  `@throws` contract (C2) one place to be true. `MalformedRequestBodyError` lives in `common` rather
  than `exceptions` because `runtime` must throw it and §2.2 forbids that import.
- **Test home:** `common/test/unit/parse-json-body.test.ts`, plus one end-to-end case per producer:
  `runtime`'s real fetch path, `kernel`'s `inject`, and `testing`'s `MockRequest`.

### 3.4 The malformed body answers `400` even though the body is read lazily

- **Decision:** no change to when the body is read. The brand travels on the error, so a parse
  failure raised inside a handler — which is where M87 moved the read — reaches `errorHandler`
  through the ordinary throw path and is answered `400` there.
- **Why:** M87 made the body lazy precisely so a bodyless GET pays nothing, and X32-4 (M90a) already
  established that middleware has no access to the read. A `400` therefore cannot be produced before
  the handler runs, and does not need to be: the hint is read at the boundary that writes the
  response. The one consequence worth stating is that a handler which **catches** its own `json()`
  rejection keeps full control, which is correct and is what a handler wanting a custom message
  should do.
- **Test home:** `kernel/test/integration/malformed-body.test.ts` — a handler that does not catch
  answers `400`; a handler that catches answers whatever it chooses.

### 3.5 `Retry-After` is declined, with cause

- **Decision:** X35-2 and X32-7 answer `503` and carry **no** `Retry-After`. `ErrorResponseInit` is
  not widened with a header channel, and no `retryAfterSeconds` option is added to `BulkheadPolicy`.
- **Why:** the framework holds no honest value for these two conditions. A bulkhead's queue drains
  on the order of one protected call's latency, which it does not measure; a connection pool's
  saturation has no published horizon. `Retry-After` is optional in RFC 9110 and `503` is itself the
  retryable signal, so omitting it costs a hint and inventing it would state a deadline the
  framework cannot keep. The rate limiter (M90a) does emit `Retry-After`, and correctly — a fixed
  window genuinely knows when it resets — so the asymmetry is principled rather than an oversight,
  and C1 records it where a reader will look. An option was rejected as well: an option nobody can
  set correctly is dead surface in practice, and the caller can back off on its own.
- **Test home:** `resilience-plugin/test/integration/shed-status.test.ts` asserts `503` **and**
  asserts `Retry-After` is absent, so a later addition is a deliberate change rather than a drift.

### 3.6 Each package gets error classes, not ad-hoc brands

- **Decision:** `secrets-plugin` gains `src/errors.ts` with `ReadOnlySecretProviderError` (`501`),
  thrown by `EnvProvider.set` and `EnvProvider.rotate`. `resilience-plugin`'s three existing classes
  brand `this` in their constructors: `BulkheadFullError` → `503`, `CircuitOpenError` → `503`,
  `TimeoutError` → `504`.
- **Why:** X20-2's own recommendation is to sweep rather than wait for a fourth report, and a
  package with no error vocabulary at all (`secrets-plugin` has no `errors.ts`) cannot be swept by
  branding a plain `Error` at a call site — the next refusal would brand a second plain `Error` with
  a second hand-written detail. A class is where the status and the caller-facing sentence live
  together. `504` for `TimeoutError` because the framework acted as an intermediary to a protected
  call that did not answer in time, which is what `504` means; `503` for both shedding errors
  because the service is temporarily refusing work it could otherwise do.
- **Test home:** `secrets-plugin/test/integration/readonly-status.test.ts` and
  `resilience-plugin/test/integration/shed-status.test.ts`, both through a real application.

### 3.7 Masking stays on, and the exemption stays narrow

- **Decision:** `maskInternalErrors` keeps its `true` default and its behaviour. Every `detail`
  introduced here is a fixed sentence written at the brand site, composed only of framework-chosen
  identifiers — never a driver message, a statement, or a bound parameter.
- **Why:** X12-3/M70b exists because every `500` used to return the failing SQL and its parameters,
  and the database rows here are the closest this milestone comes to that boundary: a pg error
  carries the query text. The wrapper's `cause` keeps that reachable for the log and the `detail`
  keeps it out of the body — which is exactly the split M89b's `detail`-is-required design enforces.
- **Test home:** `database-plugin/test/integration/refusal-status.test.ts` — the `409` body is
  asserted field by field and asserted **not** to contain the statement text or a parameter value.

### 3.8 Every row is proven end to end, never at the throw site

- **Decision:** each of the five rows gets one test that boots a real `createApplication` with
  `errorHandler` registered and asserts the response, in addition to any unit test.
- **Why:** `refusal-status.test.ts:1-17` states the reason in its own header — the defect lived in
  the last step of the path, so a test asserting the thrown error in isolation would have passed
  with the symptom in place. That is how X19-1 shipped, and four of these five rows are the
  identical shape.
- **Test home:** the five integration suites named in §6.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                  | Kind  | Consumer / real code path that READS it                                                                                                  |
| ------------------------------------------------ | ----- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `parseJsonBody` (`common`)                       | fn    | Called by `runtime`'s `fetch-mapping.ts`, `kernel`'s `inject`, and `testing`'s `MockRequest`. Three real readers outside its own test.   |
| `MalformedRequestBodyError` (`common`)           | class | Thrown by `parseJsonBody`; read by `errorHandler` through its brand, and by an application's `catch` around `ctx.request.json()`.        |
| `SerializationConflictError` (`database-plugin`) | class | Thrown by `DatabaseService` at the three choke points; read by an application's retry loop — the `instanceof` X38-1 says a caller needs. |
| `DatabaseUnavailableError` (`database-plugin`)   | class | Same, for the backpressure classification.                                                                                               |
| `ReadOnlySecretProviderError` (`secrets-plugin`) | class | Thrown by `EnvProvider.set`/`rotate`; read by an application's `catch` and by `errorHandler` through its brand.                          |

`resilience-plugin` exports nothing new — its three existing classes gain a brand. `kernel`,
`runtime` and `testing` export nothing new. Each changed barrel gets a `barrel-exports.test.ts` case
(the M56 defect class, where dropping a barrel export left eighteen other tests green).

### 4.1 Options — every option names its consumer

| Option     | Consumer | Behavior (per implementation)                                                                                                                                                                                                                                          |
| ---------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None added | —        | No opt-out is offered for any status change. A caller cannot be relying on `500` for these five conditions — that is the finding — and an option would preserve the defect as a supported configuration. §3.5 records the one option that was considered and declined. |

## 5. Implementation files

| File                                                           | Purpose                                                        |
| -------------------------------------------------------------- | -------------------------------------------------------------- |
| `common/src/errors/malformed-body.ts`                          | `MalformedRequestBodyError`, branded `400` at construction.    |
| `common/src/http.ts`                                           | `parseJsonBody`; `IRequest.json()` JSDoc gains `@throws` (C2). |
| `common/src/index.ts`                                          | Exports both.                                                  |
| `runtime/src/adapters/shared/fetch-mapping.ts`                 | `json()` delegates to `parseJsonBody`.                         |
| `kernel/src/application/application.ts`                        | `inject`'s `json()` delegates to `parseJsonBody`.              |
| `testing/src/mock-context.ts`                                  | `MockRequest.json()` delegates to `parseJsonBody`.             |
| `database-plugin/src/errors/classify.ts`                       | `classifyDriverError` and the per-backend signal table.        |
| `database-plugin/src/errors.ts`                                | `SerializationConflictError`, `DatabaseUnavailableError`.      |
| `database-plugin/src/services/database-service.ts`             | The three interception points.                                 |
| `secrets-plugin/src/errors.ts`                                 | `ReadOnlySecretProviderError`.                                 |
| `secrets-plugin/src/providers/env-provider.ts`                 | `set` and `rotate` throw it.                                   |
| `resilience-plugin/src/errors.ts`                              | Three constructors brand `this`.                               |
| `README.md` × 3, `PUBLIC_API.md`, `ROADMAP.md`, `CHANGELOG.md` | C1–C4 and the five status entries.                             |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                   | src covered                              | Key assertions (and the signature each call type-checks against)                                                                                                                                        |
| --------------------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/test/unit/parse-json-body.test.ts` (new)                            | `http.ts`, `errors/malformed-body.ts`    | Valid JSON round-trips; `'not-json'` throws `MalformedRequestBodyError`; `httpStatusHintOf` reads `400`; the platform `SyntaxError` is the `cause`; the empty string throws.                            |
| `runtime/test/integration/malformed-body-real.test.ts` (new)                | `fetch-mapping.ts`                       | Through a real socket: `POST` with `content-type: application/json` and a malformed body answers `400` with the configured format's body, on the served path (not `inject`).                            |
| `kernel/test/integration/malformed-body.test.ts` (new)                      | `application.ts`                         | `inject` answers `400`; a handler that catches its own rejection answers whatever it chooses (§3.4).                                                                                                    |
| `testing/test/unit/mock-request.test.ts` (extended)                         | `mock-context.ts`                        | `MockRequest.json()` throws the same class with the same brand — the double matches the real producer.                                                                                                  |
| `database-plugin/test/unit/classify-driver-error.test.ts` (new)             | `errors/classify.ts`                     | One case per §3.2 table row against a synthetic error; a two-deep `cause` chain; a **frozen** error (classification still succeeds because §3.1 wraps); a thrown string returns `null`.                 |
| `database-plugin/test/integration/refusal-status.test.ts` (extended)        | `services/database-service.ts`           | End to end: a `40001` from a real cause chain answers `409`, field by field, and the body contains **neither** the statement text nor a bound parameter (§3.7).                                         |
| `database-plugin/test/integration/real-prisma-adapter.test.ts` (extended)   | `errors/classify.ts`                     | Guarded on `DATABASE_URL`: two concurrent SERIALIZABLE transactions produce a real `40001`, and the caller receives `SerializationConflictError`.                                                       |
| `database-plugin/test/integration/real-drizzle-adapter.test.ts` (extended)  | `errors/classify.ts`                     | Same, plus a bounded `connectionTimeoutMillis` pool exhausted by more holders than `max`, answering `DatabaseUnavailableError`.                                                                         |
| `database-plugin/test/integration/real-mongo-adapter.test.ts` (extended)    | `errors/classify.ts`                     | A `TransientTransactionError` label classifies as `conflict`.                                                                                                                                           |
| `database-plugin/test/integration/real-dynamo-adapter.test.ts` (extended)   | `errors/classify.ts`                     | `TransactionConflictException` classifies as `conflict`.                                                                                                                                                |
| `database-plugin/test/integration/real-bigtable-adapter.test.ts` (extended) | `errors/classify.ts`                     | gRPC `ABORTED` classifies as `conflict`.                                                                                                                                                                |
| `database-plugin/test/integration/real-cosmos-adapter.test.ts` (extended)   | `errors/classify.ts`                     | `449` classifies as `conflict` (local-only, guarded, and recorded as such).                                                                                                                             |
| `secrets-plugin/test/integration/readonly-status.test.ts` (new)             | `errors.ts`, `providers/env-provider.ts` | Through a real application with `errorHandler`: `POST /rotate/X` answers `501` with the class's own sentence, under both `'default'` and `'rfc9457'`.                                                   |
| `resilience-plugin/test/integration/shed-status.test.ts` (new)              | `errors.ts`                              | A bulkhead configured `{ maxConcurrent: 2, maxQueue: 2 }` under ten concurrent requests sheds six as `503`; `Retry-After` is **absent** (§3.5); an open circuit answers `503`; a timeout answers `504`. |
| `*/test/unit/barrel-exports.test.ts` (extended, four packages)              | each `src/index.ts`                      | The added symbols are exported and nothing else joined.                                                                                                                                                 |

**Negative controls to run and revert before hand-off**, each observed failing:

1. Revert the `runtime` delegation only → the `runtime` real-socket case fails while the `kernel`
   `inject` case still passes. That divergence is the package-list correction's whole argument, so
   it must be seen rather than asserted.
2. Revert `SerializationConflictError`'s brand → the live-PostgreSQL case answers `500`.
3. Make `classifyDriverError` read only the top-level error rather than the chain → the live case
   fails, because drizzle-orm wraps the pg error one level down.
4. Brand the driver error in place instead of wrapping, and freeze it → a `TypeError` replaces the
   `409`, which is §3.1's argument made observable.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m90f-caller-errors-reach-the-client, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:docs
deno task publish:check     # on a COMMITTED tree
deno task release:verify 0.4.0
```

Plus, with the local backends up, so the guarded rows in §3.2 actually run rather than being
ignored:

```bash
DATABASE_URL=postgres://… MONGO_URL=… DYNAMODB_ENDPOINT=… BIGTABLE_EMULATOR_HOST=… deno task test
```

The ignored-test count between a bare run and this one is the proof the guards ran.

## 8. Risks & mitigations

- **The message anchors in §3.2 are the fragile part**, and a driver's text can change in a patch
  release. Mitigation: every anchor has a live-backend case that fails when the text moves, and the
  code path is always tried first, so an anchor is reached only where no code exists.
- **Wrapping a driver error changes what an application's existing `catch` sees.** Mitigation: it is
  a `Changed` CHANGELOG entry with the class names, and the `cause` preserves the original for any
  code that was inspecting it. Nothing was portably `instanceof`-checkable before, which is the
  finding.
- **Five status changes in one PR is a wide blast radius for a consumer.** Mitigation: each is a
  status a caller could not have been relying on (a masked `500` carrying `"Internal Server Error"`
  and nothing else), and each is recorded separately in the CHANGELOG so an upgrade note can be read
  row by row.
- **Coverage on `resilience-plugin/src/errors.ts` and the new `secrets-plugin/src/errors.ts` is easy
  to reach vacuously**, since a constructor is covered by being called. Mitigation: the two
  integration suites assert the served status, so the brand — not the constructor — is what is
  measured.
- **`common` gains a barrel export**, which is a published-surface change requiring approval.
  Mitigation: §10.2 is named in §1 and the `PUBLIC_API.md` row is a listed deliverable; if approval
  is withheld, the fallback is three identical private copies, which §3.3 records as strictly worse.

## 9. Out of scope

- **X38-2** (`serializeError` drops `code`, `severity`, `constraint`, `$metadata`) and **X35-3**
  (seven catch-then-throw sites drop their cause) — **M90j**.
- **X38-3 / X24-2 / X22-6 / X24-1** (concurrency loses work) — **M90g**. This milestone makes a
  conflict _reportable_, which M90g's optimistic strategy depends on; it does not make `FOR UPDATE`
  or an isolation level portable.
- **X20-3 / X20-4 / X20-5** — deliberately ungrouped in the ROADMAP register.
- **The typed Drizzle builder path** (`getDrizzleDatabase`, M69): a caller reaching the native
  builder bypasses `wrapDataSource` and therefore the classifier. Named rather than covered, because
  intercepting there means wrapping a native builder the whole point of which is that it is native.
- **`connectionTimeoutMillis`.** X35-2 notes that node-postgres defaults it to `0` — wait forever —
  and that the plugin surfaces no option. It cannot: the application owns the pool it hands to
  Drizzle. The default is documented in C4's neighbourhood and left as the application's to set.
- **Bounding the resilience `TimeoutError` to a cancellation** — M47 already made timeouts cancel;
  this milestone only changes the status the caller is told.
