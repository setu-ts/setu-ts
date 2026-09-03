# Milestone 89b — Caller Errors That Read as Server Faults (`@setu-ts/common`, `@setu-ts/exceptions`, `@setu-ts/database-plugin`, `@setu-ts/auth-plugin`)

> **Status:** Planning. Branch: `feat/m89b-caller-errors-read-as-server-faults`. `main` is protected
> — all work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Two findings, one mechanism: a condition the **caller** caused, carrying an accurate and actionable
message, delivered to that caller as a masked `500 Internal Server Error` with the message reachable
only in the server log. `common` gains a symbol-keyed HTTP status hint that any package may brand an
error with; `errorHandler` reads it before it wraps a non-`HttpError` into a 500; `database-plugin`
brands the three query-shape refusals; and `auth-plugin`'s guards stop throwing when the
authorization capability is absent. Fixing both together forces **one** decision about status
mapping rather than two that drift.

- **In scope:** X19-1 (`UnsupportedQueryFeatureError`, `UnsupportedFilterOperatorError`,
  `UnsupportedRawQueryError` answer `501` with their own message), X18-2 (the four authorization
  guards answer `501` naming the absent configuration instead of throwing into a masked 500), the
  `common` status-hint seam, and the ROADMAP correction C1 below.
- **NOT this milestone:** X18-3/X18-5/X18-4/X18-1 — **M89a**. X16-1/X16-2 — **M89c**. Changing the
  `403` path of any guard, or the masking default itself (§3.6 records why both stay). The four
  transaction-scope and concurrency errors keep their masked 500 (§3.4).

## 1. Contracts verified from SOURCE (not names)

| Reference                          | Source (file:line)                                               | Verified surface / fact                                                                                                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `errorHandler`'s normalize step    | `exceptions/src/middleware/error-handler.ts:155-161`             | `const isHttpError = rawError instanceof HttpError;` then a non-`HttpError` becomes `internalServerError(message, cause)`. **This is the insertion point** — the status is decided here, before anything else. |
| `errorHandler`'s masking condition | `exceptions/src/middleware/error-handler.ts:175`                 | `if (maskInternalErrors && !isHttpError && error.statusCode >= 500)`. A hinted `501` would satisfy all three clauses and be masked — so the condition must learn about hints (§3.3).                           |
| `errorHandler` logs first          | `exceptions/src/middleware/error-handler.ts:163-167`             | The UNMASKED error is logged before masking, "regardless of masking". The log keeps its detail whatever this milestone does.                                                                                   |
| `HttpError`                        | `exceptions/src/errors/http-error.ts:71-82`                      | `extends Error`, `readonly statusCode: number`, `declare readonly details?`. Constructed as `new HttpError(status, title, details, cause)` (see `:176-182` usage).                                             |
| the seven error classes            | `database-plugin/src/errors.ts:34,86,123,170,210,234,271`        | All `extends Error`; **none** derives from `HttpError`. Each carries `override readonly name`, and two carry a machine-readable field: `operator` (`:39`), `feature` (`:128`).                                 |
| `requireRole`'s resolution         | `auth-plugin/src/guards/index.ts:71`                             | `ctx.services.get<IAuthorizationService>(CAPABILITIES.AUTHORIZATION)` — unconditional. `ServiceRegistry.get` throws for an unregistered token.                                                                 |
| `requireRole`'s existing refusals  | `auth-plugin/src/guards/index.ts:59-84`                          | `401` for an absent principal and `403` for a failed check, both via `respondWithError`. **Both are already correct and are not touched.**                                                                     |
| `respondWithError`                 | `common/src/http.ts` (M70f seam)                                 | Lets a package that may not import `@setu-ts/exceptions` (§2.2) answer in the configured format. Already the guards' mechanism.                                                                                |
| `SECURITY_METADATA` precedent      | `common/src/http.ts:461`                                         | `Symbol.for('setu.security.metadata')` — the shape a cross-package brand takes here, and why `Symbol.for` rather than `Symbol()` (a local symbol misses when two copies of `common` share a process).          |
| §2.2 dependency direction          | `AI_GUIDELINES.md` §2.2                                          | `common ← kernel ← all plugins`; no plugin imports another. So `database-plugin` cannot import `exceptions`, and `exceptions` must not import `database-plugin`. The brand has to live in `common`.            |
| §10.2 / §16.1 approval             | `AI_GUIDELINES.md` §10.2, §16.1                                  | A `common` export addition requires explicit approval and a `PUBLIC_API.md` edit in the same PR.                                                                                                               |
| X12-3's reason for masking         | `smoke/DEFECTS.md` (X12-3, closed M70b)                          | Every 500 used to return the failing SQL statement and every bound parameter. Masking exists for that; §3.6 is why it stays.                                                                                   |
| the measured symptom               | `smoke/X19-FINDINGS.md` (X19-1), `smoke/X18-FINDINGS.md` (X18-2) | Both reproduce as `{"title":"Internal Server Error","detail":"Internal Server Error"}` with the real message log-only. X18-2 additionally leaves `/health`, `/ready`, `/live` all reporting `up`.              |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                        | Resolution (picked side)                                                                                                                                                                                                                                                                              | Doc deliverable (same PR)                                                                                                                                                        |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `ROADMAP.md`'s M89b section says "X18-2's guards take the same treatment at **`403`**". Checked against `auth-plugin/src/guards/index.ts:59-84`, the `403` path is already correct — the broken case is the **absent capability**, which is a server misconfiguration and not a policy refusal. | **`501`**, not `403`. A principal that fails a policy check keeps its `403`; a guard that cannot evaluate the policy at all because no provider is registered is "not implemented". That also makes the ROADMAP's own "share the mechanism" claim true, since both findings then use the status hint. | **Done in the opening PR (#234)**, not deferred: that PR introduced the `403` line, so leaving two committed docs contradicting each other on `main` would itself be the defect. |
| C2 | `PUBLIC_API.md:1899` documents that a JWT-only `AuthPlugin` "deliberately does not register an authorization service" and says nothing about what the guards then do.                                                                                                                           | Not a contradiction — a gap. State the behaviour.                                                                                                                                                                                                                                                     | `PUBLIC_API.md` auth section and the `auth-plugin` README capability table gain the `501` behaviour.                                                                             |
| C3 | `PUBLIC_API.md:1539` and `:1747` document the query refusals themselves and are silent on what the caller sees; a reader planning a backend switch cannot learn the status.                                                                                                                     | Not a contradiction — a gap. State it.                                                                                                                                                                                                                                                                | `PUBLIC_API.md` database section and the `database-plugin` README gain the `501` statement and the log-only note.                                                                |

## 3. Design decisions

### 3.1 The status: `501 Not Implemented`

- **Decision:** `501` for both findings. Maintainer decision, 2026-09-03.
- **Why:** the backend genuinely does not implement the requested feature, and the condition is
  permanent for that query rather than transient — which is what separates it from a `503`. `400`
  was the alternative and is defensible for the query refusals, but it is wrong for X18-2 (nothing
  about the caller's request is malformed) and using two statuses across one mechanism is exactly
  the drift this milestone exists to prevent.
- **Test home:** `exceptions/test/unit/status-hint.test.ts` and both integration tests below.

### 3.2 The mechanism: a symbol-keyed status hint in `common`

- **Decision:** `common` exports `HTTP_STATUS_HINT` (`Symbol.for('setu.http.status-hint')`), a
  `HttpStatusHint` type (`{ status: number; title: string; detail: string }`), and the pure
  `withHttpStatusHint(error, hint)` / `httpStatusHintOf(error)` helpers. `errorHandler` reads the
  hint at `error-handler.ts:157` and, when present, builds the `HttpError` from
  **`hint.status`/`hint.title`/`hint.detail`** — it never reads `error.message`.
- **`detail` is a required member of the hint, and that is the whole point.** The first draft of
  this plan carried `{ status, title }` and served `error.message`, on the assumption that a package
  branding an error had decided its message was caller-safe. **That assumption is false, and the
  source says so in as many words**: all three branded constructors document the message as "the
  full diagnostic — safe to log, **never to serve**" (`database-plugin/src/errors.ts:50-51`,
  `:135-136`, `:93`). Requiring an explicit `detail` makes caller-safety an act at the brand site
  rather than an inference about a message, and it keeps those three JSDoc statements literally true
  — nothing serves the message.
- **Why:** §2.2 forbids `database-plugin` importing `exceptions`, and `exceptions` importing
  `database-plugin` would invert the dependency direction — so a brand in `common` is the only
  channel, exactly as `SECURITY_METADATA` is for M57 and the realtime frame codec is for M47.
  `Symbol.for` for the reason `common/src/http.ts:461` already documents. It is chosen over routing
  the adapters through `respondWithError` because the adapters **throw** from deep inside a data
  source that holds no `IRequestContext`; the hint keeps the mapping in one reader.
- **Test home:** `common/test/unit/status-hint.test.ts` (the pure helpers, including a
  cross-copy-safety assertion) and `exceptions/test/unit/status-hint.test.ts` (the reader).

### 3.3 A hinted error is not masked

- **Decision:** the masking condition at `error-handler.ts:175` gains a hint check: a hinted error
  is treated like an `HttpError` for masking purposes and its detail survives.
- **Why:** without this the fix is inert — `maskInternalErrors && !isHttpError && statusCode >= 500`
  is satisfied by a hinted `501` and would replace the detail with the status title, which is the
  exact symptom. It is safe **because the served text is the hint's own `detail`**, not the error's
  message: masking exists to stop a driver diagnostic reaching a caller, and a hinted response
  contains no driver diagnostic to stop. The exemption is therefore narrow by construction — it
  exempts a fixed sentence the brand site wrote, never the `Error`'s own message.
- **Test home:** `exceptions/test/unit/status-hint.test.ts` — a hinted 501 keeps its detail with
  masking ON; an unhinted 500 is still masked in the same test file, so the guard cannot be widened
  by accident.

### 3.4 Which errors get branded, and which deliberately do not

- **Decision:** brand the three **query-shape** refusals only — `UnsupportedQueryFeatureError`,
  `UnsupportedFilterOperatorError`, `UnsupportedRawQueryError`. The four transaction and concurrency
  errors (`MongoTransactionUnavailableError`, `CosmosTransactionScopeError`,
  `CosmosConcurrentModificationError`, `BigtableTransactionScopeError`) keep their masked 500.
- **Why:** the three describe the caller's own query against a backend's declared capabilities, and
  each already carries **structured, framework-chosen** fields from which a caller-facing `detail`
  is built: `feature` + `adapter` (`errors.ts:128`, `:143`), `operator` + `connector` (`:39`,
  `:41`). Those are identifiers this framework chose, not driver output, so a detail composed from
  them discloses nothing — which is what makes these three brandable and the message irrelevant. The
  other four may legitimately carry backend detail — a concurrency conflict in particular is
  transient and its message can quote server state — so branding them would widen disclosure for no
  gain. `CosmosConcurrentModificationError` is also arguably a `409`, which is a separate decision
  and is named in §9 rather than guessed here.
- **Test home:** `database-plugin/test/unit/error-status-hints.test.ts` — the three carry a hint,
  the four do not, asserted as a table so adding an eighth class forces a decision.

### 3.5 X18-2: `has()` instead of `get()`, then a hinted refusal

- **Decision:** the four authorization guards resolve with
  `ctx.services.has(CAPABILITIES.AUTHORIZATION)` and, when absent,
  `respondWithError(ctx, { status: 501, title: 'Not Implemented', detail: 'Authorization is not configured' })`.
  `requireAuth()` is untouched — it resolves nothing and already works.
- **Why:** the guards already hold an `IRequestContext`, so `respondWithError` reaches them directly
  and the hint seam is unnecessary on this side; the shared decision is the **status**, not the
  plumbing. Failing closed is preserved — this is the property X18-2 confirmed and must not regress.
- **Test home:** `auth-plugin/test/integration/rbac-absent.test.ts` — through a REAL
  `createApplication`, because the package's unit fixtures use a fake registry whose `get` returns
  `undefined` where the kernel's throws, so the finding is unreachable against the fake.

### 3.6 What does not change

- **Decision:** masking stays on by default; the `403` path of every guard is untouched; the log
  keeps the unmasked error.
- **Why:** X12-3 exists because these same 500s used to disclose the failing SQL and every bound
  parameter, and `error-handler.ts:163-167` logs before masking precisely so the operator keeps the
  detail. Disabling masking would trade this finding for that one.
- **Test home:** `exceptions/test/unit/status-hint.test.ts` retains the existing unhinted-500
  masking assertions alongside the new ones.

### 3.7 A startup signal for X18-2

- **Decision:** none in this milestone.
- **Why:** `AuthPlugin` cannot see routes at `register()`, and the guards are free functions it
  never observes — so the only honest startup check would read M57's `SECURITY_METADATA` brand off
  `RouteInfo`, which depends on registration order between the auth plugin and whichever plugin
  registered the route. M89a adds the equivalent warning where it _is_ observable (the decorator
  path). Recorded in §9 rather than half-built.

## 4. Exported surface — every symbol names its consumer

| Exported symbol      | Kind     | Consumer / real code path that READS it                                                                                                   |
| -------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `HTTP_STATUS_HINT`   | symbol   | `httpStatusHintOf` in `common`; branded by `database-plugin/src/errors.ts`; read by `exceptions/src/middleware/error-handler.ts:157,175`. |
| `HttpStatusHint`     | type     | The `withHttpStatusHint` parameter and `httpStatusHintOf`'s return; named by `database-plugin`'s branding call sites.                     |
| `withHttpStatusHint` | function | Called by the three branded error constructors in `database-plugin/src/errors.ts`.                                                        |
| `httpStatusHintOf`   | function | Called by `errorHandler` at the normalize step and by the masking condition.                                                              |

All four are in **`common`**, are a §10.2 addition requiring approval, and ship with their
`PUBLIC_API.md` rows in the same PR. `database-plugin` and `auth-plugin` gain **no** export — their
changes are internal — pinned by a `barrel-exports.test.ts` in each (the M56 defect class).

### 4.1 Options — every option names its consumer

| Option                                   | Consumer           | Behavior (per implementation)                                                                                                                                                                                      |
| ---------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| None added                               | —                  | Checked. A `maskStatusHints` switch was considered and cut: an application that wants a hinted error masked can set `maskInternalErrors: false`… which does the opposite, so the option would have no correct use. |
| `ErrorHandlerOptions.maskInternalErrors` | `errorHandler:175` | Unchanged for unhinted errors. A hinted error is exempt (§3.3) whatever this is set to, because its detail is caller-safe by construction.                                                                         |

## 5. Implementation files

| File                                                  | Purpose                                                                                                                                               |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/http.ts`                         | `HTTP_STATUS_HINT`, `HttpStatusHint`, `withHttpStatusHint`, `httpStatusHintOf` (beside M57's `SECURITY_METADATA`, which is the shape being followed). |
| `packages/common/src/index.ts`                        | Barrel re-exports for the four.                                                                                                                       |
| `packages/exceptions/src/middleware/error-handler.ts` | Read the hint at the normalize step (`:157`); exempt a hinted error from masking (`:175`).                                                            |
| `packages/database-plugin/src/errors.ts`              | Brand the three query-shape refusals with `{ status: 501, title: 'Not Implemented' }`.                                                                |
| `packages/auth-plugin/src/guards/index.ts`            | `has()` + hinted `501` refusal in the four authorization guards; `requireAuth` untouched.                                                             |
| `packages/auth-plugin/README.md`                      | C2: the capability table states what the guards do with no `rbac`.                                                                                    |
| `packages/database-plugin/README.md`                  | C3: the refusals answer `501`; the message is log-only.                                                                                               |
| `PUBLIC_API.md`                                       | The four new `common` exports; C2; C3.                                                                                                                |
| `ROADMAP.md`, `CLAUDE.md`                             | C1: the `403` → `501` correction.                                                                                                                     |
| `CHANGELOG.md`                                        | Two behaviour changes (`500` → `501` on both paths) with migration text, plus the `common` addition.                                                  |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                   | src covered                                 | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                           |
| ----------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/test/unit/status-hint.test.ts`                      | `src/http.ts` (the four symbols)            | `withHttpStatusHint(error, hint)` returns the same error branded; `httpStatusHintOf` reads it; an unbranded error reads `undefined`; a **second module instance** under a distinct URL reads the same brand (the `Symbol.for` property M57's cross-copy test established). |
| `exceptions/test/unit/status-hint.test.ts`                  | `middleware/error-handler.ts`               | A hinted error answers its hinted status with its own detail under `maskInternalErrors: true`; an **unhinted** 500 is still masked in the same file; an `HttpError` still passes through; the log still receives the unmasked error.                                       |
| `database-plugin/test/unit/error-status-hints.test.ts`      | `src/errors.ts`                             | Table-driven: the three query-shape classes carry `{ status: 501 }`; the four transaction/concurrency classes carry no hint (§3.4).                                                                                                                                        |
| `database-plugin/test/integration/refusal-status.test.ts`   | the whole path, through `createApplication` | A Dynamo-shaped non-key `orderBy` and a Bigtable-shaped `offset` answer **`501`** with the adapter's own message, driven with an injected client so no emulator is required (§6.7). Reverting the brand returns `500` — the control.                                       |
| `auth-plugin/test/integration/rbac-absent.test.ts`          | `guards/index.ts`                           | Through a REAL kernel app with no `rbac`: the four authorization guards answer `501 "Authorization is not configured"`; `requireAuth()` still answers `200`; a principal **holding** the role is no longer refused by a 500.                                               |
| `auth-plugin/test/unit/guards.test.ts` (extend)             | `guards/index.ts`                           | With `rbac` present, the `403` bodies are **byte-identical** to today's — the regression guard for §3.6.                                                                                                                                                                   |
| `auth-plugin/test/unit/barrel-exports.test.ts`              | `src/index.ts`                              | Surface unchanged.                                                                                                                                                                                                                                                         |
| `database-plugin/test/unit/barrel-exports.test.ts` (extend) | `src/index.ts`                              | Surface unchanged.                                                                                                                                                                                                                                                         |
| `test/fixtures/snippets/*`, package-README fences           | the corrected docs                          | The M38/M70k fence gates compile every changed example.                                                                                                                                                                                                                    |

No external dependency is added. The two integration tests are the ones that matter: each reproduces
its finding's exact measured symptom and each has a stated control that returns the old `500`.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m89b-caller-errors-read-as-server-faults, never main
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # committed tree
deno task release:verify 0.3.0
```

`common` gains exports, so `publish:check` matters more than usual here: an inferred return type on
a new exported function is a JSR slow type and blocks the `.d.ts` the Node/Bun compat jobs consume
(the M51 defect). All four new symbols carry written-out types.

## 8. Risks & mitigations

- **A branded error's diagnostic reaches the caller**, re-opening X12-3. → Structurally prevented
  rather than mitigated: the hint carries its own `detail` and `errorHandler` never reads
  `error.message` (§3.2). The unit test brands an error with a deliberately alarming message and
  asserts the body contains no substring of it, so a future reader that falls back to the message
  fails a test. Branding also stays opt-in per class, and §3.4's table makes an eighth class a
  decision rather than a default.
- **`501` is wrong for some future branded error.** → The hint carries the status rather than
  hard-coding it, so a later class can brand `409` (which is what
  `CosmosConcurrentModificationError` may want) without touching the reader.
- **A `common` widening ships as a slow type** and blocks publish. → §7's `publish:check` on a
  committed tree, and explicit return types on all four.
- **The masking exemption is widened by accident**, so a genuine driver 500 stops being masked. →
  The unhinted-500 masking assertions live in the _same_ test file as the new exemption, so widening
  the condition fails a test on the line below.
- **X18-2's fix is tested against a fake registry** and passes vacuously, since a fake `get` returns
  `undefined` where the kernel's throws. → §3.5 mandates a real `createApplication`; this is the
  specific reason the finding was invisible to the package's own suite.

## 9. Out of scope

- **X18-3/X18-5/X18-4/X18-1** — **M89a**, which also owns the decorator-side startup warning that
  §3.7 declines to build here.
- **X16-1/X16-2** — **M89c**.
- **A startup refusal or warning for `rbac`-absent guards** — §3.7. Unowned; it needs M57's brand
  read off `RouteInfo` and depends on plugin registration order.
- **`409` for `CosmosConcurrentModificationError`** — §3.4. Unowned; a concurrency conflict is
  transient and retryable, which is a different contract statement from "not implemented", and it
  deserves its own decision rather than riding a status this milestone chose for a different reason.
- **Disabling or changing the masking default** — §3.6. X12-3 owns why it exists.
