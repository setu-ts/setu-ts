# Milestone 119g — Failures That Reach the Operator Without Their Reason (`@setu-ts/auth-plugin`, `@setu-ts/common`, `@setu-ts/service-discovery-plugin`)

> **Status:** Planning. Branch: `fix/m119g-failure-reasons` (a **fix** letter of M119, so a `fix/…`
> branch per the M119 letter kinds; one branch for all three rows, the M113h precedent). `develop`
> and `main` are protected — all work stays on this branch until it merges via a single PR.

## 0. Objective & scope

Three failures an operator meets with no cause in the default log (ROADMAP M119g, register rows
V10-62, V10-63, V10-34). Each fix is local: the reason already exists at the failure site and is
dropped, logged at the wrong level, or masked.

- **In scope:**
  - **V10-62** — an OIDC/OAuth2 sign-in login route answering `503 provider-unavailable` logs the
    reason at `warn`, once per change of reason per provider; repeats go to `debug`; a later
    successful resolve resets the state so the next outage warns again.
  - **V10-63** — an `AggregateError` (ioredis multi-address `ECONNREFUSED`/`ETIMEDOUT`) is described
    by its inner errors wherever the connection-error reporter and the idempotency log helper render
    a thrown value, through ONE shared describer promoted from `messaging-plugin` to `common`.
  - **V10-34** — a service-discovery backend failure with nothing cached throws a
    `DiscoveryUnavailableError` branded with a `503` status hint (the M89b mechanism), so the kernel
    answers a named 503 instead of a masked 500.
  - **V10-62, same shape on the bearer path** (maintainer decision 2026-10-24, after comparing
    ASP.NET Core JwtBearer and Spring Security): the outside-issuer strategy's key-set refresh
    failures — a provider the operator cannot reach — log at `warn` once per change of reason per
    issuer, through the same reporter; token rejections stay at `debug`.
- **NOT this milestone:** readiness semantics (M119b); every documentation-only row (M119i).

## 1. Contracts verified from SOURCE (not names)

| Reference                                   | Source (file:line)                                                                | Verified surface / fact                                                                                                                                                                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| login route 503                             | `packages/auth-plugin/src/sign-in/routes.ts:254-266`                              | `resolveEndpoints()` returns `null` and the route answers `503 provider-unavailable` with no log line at any level                                                                                                                                        |
| `resolveEndpoints`                          | `packages/auth-plugin/src/sign-in/routes.ts:133-168`                              | Four distinct `null` returns: no key set/issuer, `discovery()` null, invalid authorization/token endpoint; the reason is discarded                                                                                                                        |
| `IssuerKeySet.discovery()`                  | `packages/auth-plugin/src/issuers/key-set-cache.ts:186-205`                       | Catches the fetch failure, calls `#report(name, code)` and returns `null`; codes are fixed strings (`discovery-issuer-mismatch`, `discovery-cooldown`, `discovery-fetch-failed`, …) from `RefreshError`                                                   |
| sign-in key-set reporter                    | `packages/auth-plugin/src/plugin/auth-plugin.ts:348-350`                          | The reporter passed for sign-in key sets writes only `debug(...)`                                                                                                                                                                                         |
| `debug` helper                              | `packages/auth-plugin/src/plugin/auth-plugin.ts:191-197`                          | Best-effort `ctx.logger?.debug`, a throw swallowed; no `warn` counterpart exists                                                                                                                                                                          |
| `SignInRouteDeps.debug`                     | `packages/auth-plugin/src/sign-in/routes.ts:83-84`                                | Optional `debug?: (message: string) => void`; no `warn` member                                                                                                                                                                                            |
| `createConnectionErrorReporter`             | `packages/common/src/health/connection-errors.ts` (`messageOf`, `report`)         | Logs `error.message` only; `AggregateError` from ioredis has `message === ''`, hence `error: ""`. Consumers: cache, idempotency, auth rate-limit store, messaging redis-streams, queue, realtime-backplane, scheduler — all fixed by changing `messageOf` |
| idempotency `describeThrown`                | `packages/idempotency-plugin/src/core/safe-log.ts:51-57`                          | `value.message` only — the same empty string for an `AggregateError`; used by the claim/release/settle log lines in `http-middleware.ts` and `ingress-behavior.ts`                                                                                        |
| `serializeError`                            | `packages/common/src/errors/serialize-error.ts`                                   | Already serializes `AggregateError.errors` (cap 8, node budget 64) and safe `classifiers` (`code`, `errno`, `syscall`, …)                                                                                                                                 |
| messaging `describeError`/`describeLogText` | `packages/messaging-plugin/src/brokers/describe-error.ts`                         | One-line bounded (8192 code points) renderer over `serializeError`, including aggregate members and cause chain; not exported from the messaging barrel; used by eight messaging src files                                                                |
| `DiscoveryUnavailableError`                 | `packages/service-discovery-plugin/src/errors.ts:16-27`                           | Plain `Error` subclass, no status hint; thrown for the cold outage AND for configuration errors (no DNS resolver, no k8s token, no API server, multi-port service)                                                                                        |
| cold-outage throw                           | `packages/service-discovery-plugin/src/services/service-discovery-service.ts:234` | The only site where a backend read fails with nothing cached                                                                                                                                                                                              |
| `withHttpStatusHint`                        | `packages/common/src/errors/status-hint.ts:142`                                   | Brands in place, returns the same error; precedent `packages/cache-plugin/src/errors.ts:16` (`CacheStoreUnavailableError` → 503)                                                                                                                          |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                              | Resolution (picked side)                                                            | Doc deliverable (same PR)                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| C1  | PUBLIC_API.md `createConnectionErrorReporter` says "Only the error's message is logged", which is the V10-63 defect                   | The code changes; the description now says the error is rendered by `describeError` | PUBLIC_API.md `createConnectionErrorReporter` row, plus the new `describeError` row |
| C2  | PUBLIC_API.md `DiscoveryUnavailableError` row ("Cold backend failure, missing DNS resolver, k8s multi-port") says nothing of a status | Only the cold-outage instance carries the 503 hint                                  | PUBLIC_API.md row and `packages/service-discovery-plugin/README.md` error section   |

## 3. Design decisions

### 3.1 Shared describer — `describeError` promoted to `common`

- **Decision:** move the rendering half of `messaging-plugin/src/brokers/describe-error.ts`
  (`describeError` and its budget helpers) to `packages/common/src/errors/describe-error.ts`,
  exported from the common barrel as `describeError(value: unknown): string`. The messaging file
  keeps `describeLogText` and imports `describeError` from `@setu-ts/common`, re-exporting it under
  the same name for its eight internal callers, so one implementation exists. Output is unchanged:
  `Name: message (code=…, …) [inner; inner] <- cause`, bounded to 8192 code points.
- **Why:** ROADMAP names "the shared error describer"; a second hand-rolled aggregate renderer in
  common would be the duplicated-logic defect.
- **Test home:** `packages/common/test/unit/describe-error.test.ts` (moved cases from messaging's
  `describe-error.test.ts`, which keeps only the `describeLogText` cases plus one delegation case).

### 3.2 Connection-error reporter renders through `describeError`

- **Decision:** `messageOf` in `connection-errors.ts` returns `describeError(error)` (still inside
  its `try`, still `'unrepresentable error value'` on a throw). The de-dup key is the rendered
  string, so an outage whose inner addresses and codes are stable de-duplicates as before.
- **Why:** one change fixes all seven reporter consumers, cache and idempotency included.
- **Test home:** `packages/common/test/unit/connection-errors.test.ts` — an
  `AggregateError([ECONNREFUSED ::1, ECONNREFUSED 127.0.0.1])` warn line contains both inner
  messages and `code=ECONNREFUSED`; a repeat of the same aggregate logs at `debug`; existing
  plain-`Error` lines keep their `Error: msg` content updated to the new rendering.

### 3.3 Idempotency `describeThrown` delegates to `describeError`

- **Decision:** `describeThrown(value)` returns `describeError(value)` inside its existing `try`;
  the `typeof value` fallback stays. As shipped, `describeError` is total, so `Object.create(null)`
  renders as `Error: [object Object]`; the `typeof` fallback is reached only by a failing renderer
  (audit L3).
- **Test home:** `packages/idempotency-plugin/test/unit/safe-log.test.ts` — an aggregate renders its
  inner errors; `Object.create(null)` still yields `'object'`.

### 3.4 Sign-in provider-unavailable reason at `warn`, once per state change

- **Decision:**
  1. `resolveEndpoints` returns `{ ok: true, endpoints } | { ok: false, reason }` with fixed reason
     codes: `key-set-missing`, `discovery-endpoint-invalid` (authorization/token endpoint fails
     `isEndpoint`), or the key set's last discovery failure code.
  2. `IssuerKeySet` gains `lastDiscoveryFailure(): string | null` (class method; `IssuerKeySet` is
     not exported from `src/index.ts`). It records the code in the `#ensureDiscovery` failure catch
     of `discovery()`, does NOT overwrite it with `discovery-cooldown`, and clears it on a
     successful fetch. A `null` document with no recorded failure (stale past `maxStaleMs`) reports
     `discovery-stale`.
  3. `SignInRouteDeps` gains an optional `warn?: (message: string) => void`; `auth-plugin.ts`
     supplies a best-effort `warn` built like `debug`. The routes keep a per-provider
     `Map<string, string>` of the last reported reason: a new or changed reason logs
     `auth-plugin: signIn['<provider>'] provider unavailable (<reason>)` at `warn`; the same reason
     again logs at `debug`; a successful `resolveEndpoints` for that provider deletes the entry. The
     logout path's `resolveEndpoints` call shares the same reporter.
  4. Reasons are fixed codes only — never response data, never the configured or received issuer
     value.
- **Why:** X74 (b) met a Keycloak issuer mismatch as a bare 503; logging per request would flood
  under an outage of an unauthenticated route.
- **Test home:** `packages/auth-plugin/test/integration/login-flow.test.ts`: issuer-mismatch → one
  `warn` naming `discovery-issuer-mismatch`; second login → `debug` only; recovery then a new
  failure → `warn` again; invalid endpoint → `warn` naming `discovery-endpoint-invalid`; a throwing
  `warn` does not change the 503. `key-set-cache.test.ts`: `lastDiscoveryFailure()` set on failure,
  kept through cooldown, cleared on success.

### 3.5 One state-change reporter for both auth paths

- **Decision:** a single internal helper, `packages/auth-plugin/src/issuers/failure-reporter.ts`
  (not exported from `src/index.ts`), `createStateChangeReporter({ warn, debug })` returning
  `{ failed(key, reason, message), recovered(key) }`: a new or changed reason for a key → `warn`;
  the same reason again → `debug`; `recovered(key)` forgets the key so the next failure warns. Both
  `warn` and `debug` sinks are best-effort (a throw is swallowed). The sign-in routes (§3.4) use it
  keyed by provider name. `IssuerKeySet`'s constructor `report` parameter changes from the
  `RefreshFailureReporter` function to `{ failed(issuer, reason), recovered(issuer) }`; the key set
  calls `recovered` after a successful key-set or discovery fetch. In `auth-plugin.ts` the bearer
  key sets (line 253) wire it to the helper with
  `auth-plugin: issuer '<name>' key-set refresh failed (<reason>)`; the sign-in key sets keep their
  `debug`-only reporter, because the route reporter already carries the operator line for them.
  `RefreshFailureReporter` is internal (not in the barrel), so the shape change is not public.
- **Why:** one de-dup implementation for the two places the same failure surfaces.
- **Test home:** `packages/auth-plugin/test/unit/failure-reporter.test.ts` (new) for the helper's
  branches; `key-set-cache.test.ts` asserts `recovered` after success and `failed` with the fixed
  code; an outside-issuer integration test with a recording logger asserts one `warn` for an
  unreachable JWKS across several requests and none for an expired token.

### 3.6 Discovery cold outage carries a 503 hint

- **Decision:** at `service-discovery-service.ts:234` only, throw
  `withHttpStatusHint(new DiscoveryUnavailableError(...), { status: 503, title: 'Service Unavailable', detail: 'Service discovery is temporarily unavailable.' })`.
  Configuration-error instances stay unbranded (a misconfiguration is a 500). A provider's own
  `DiscoveryUnavailableError` thrown during a cold lookup (the Kubernetes multi-port case) is
  rethrown unbranded rather than wrapped (audit finding L2).
- **Why:** M89b mechanism; the detail carries no service name or backend data.
- **Test home:** `packages/service-discovery-plugin/test/unit/service-discovery-service.test.ts`
  asserts `httpStatusHintOf(error)` on the cold outage and `undefined` on a config error; an
  integration test through a kernel app asserts the Problem Details body `status: 503`, `title`,
  `detail`, and the absence of `message`.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. Additive export in `common`; ships in minor 0.11.0.

| Exported symbol               | Kind     | Consumer / real code path that READS it                                                                                               |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `describeError` (common, new) | function | `common/health/connection-errors.ts` `messageOf`; `idempotency-plugin/core/safe-log.ts`; `messaging-plugin/brokers/describe-error.ts` |

### 4.1 Options — every option names its consumer

| Option                            | Consumer                                     | Behavior (per implementation)                                |
| --------------------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| `SignInRouteDeps.warn` (internal) | sign-in routes provider-unavailable reporter | Receives the state-change line; omitted, the line is dropped |

## 5. Implementation files

| File                                                                          | Purpose                                             |
| ----------------------------------------------------------------------------- | --------------------------------------------------- |
| `packages/common/src/index.ts`                                                | export `describeError`                              |
| `packages/common/src/errors/describe-error.ts` (new)                          | the shared renderer (moved from messaging)          |
| `packages/common/src/health/connection-errors.ts`                             | `messageOf` → `describeError`                       |
| `packages/messaging-plugin/src/brokers/describe-error.ts`                     | keep `describeLogText`; `describeError` from common |
| `packages/idempotency-plugin/src/core/safe-log.ts`                            | `describeThrown` → `describeError`                  |
| `packages/auth-plugin/src/issuers/key-set-cache.ts`                           | `lastDiscoveryFailure()`                            |
| `packages/auth-plugin/src/sign-in/routes.ts`                                  | reasoned `resolveEndpoints`, state-change reporter  |
| `packages/auth-plugin/src/issuers/failure-reporter.ts` (new)                  | state-change reporter (§3.5)                        |
| `packages/auth-plugin/src/plugin/auth-plugin.ts`                              | best-effort `warn` passed to the routes             |
| `packages/service-discovery-plugin/src/services/service-discovery-service.ts` | 503 hint on the cold outage                         |
| `PUBLIC_API.md`, `CHANGELOG.md`, service-discovery and auth READMEs           | C1, C2; Unreleased entries for the three rows       |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                     | src covered                                  | Key assertions                                               |
| --------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------ |
| `packages/common/test/unit/describe-error.test.ts` (new)                                      | `errors/describe-error.ts`                   | §3.1 rendering, aggregate, cause, classifiers, truncation    |
| `packages/common/test/unit/connection-errors.test.ts`                                         | `health/connection-errors.ts`                | §3.2                                                         |
| `packages/messaging-plugin/test/unit/describe-error.test.ts`                                  | `brokers/describe-error.ts`                  | `describeLogText` cases; delegation identity with common     |
| `packages/idempotency-plugin/test/unit/safe-log.test.ts`                                      | `core/safe-log.ts`                           | §3.3                                                         |
| `packages/auth-plugin/test/unit/failure-reporter.test.ts` (new)                               | `issuers/failure-reporter.ts`                | §3.5 warn/debug/recovered, throwing sinks                    |
| `packages/auth-plugin/test/unit/key-set-cache.test.ts`                                        | `issuers/key-set-cache.ts`                   | §3.4 (2)                                                     |
| `packages/auth-plugin/test/integration/login-flow.test.ts`                                    | `sign-in/routes.ts`, `plugin/auth-plugin.ts` | §3.4 (1)(3)(4), through a kernel app with a recording logger |
| `packages/service-discovery-plugin/test/unit/service-discovery-service.test.ts` + integration | `services/service-discovery-service.ts`      | §3.6                                                         |

Bug-fix proof: each new assertion is run once against the unfixed code and shown to fail.

## 7. Verification gates

```bash
git branch --show-current   # MUST be fix/m119g-failure-reasons
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test
pnpm test:coverage          # ANSI-stripped per-file table; ≥90% every touched src file
pnpm run test:deno-lane
pnpm run release:publish --dry-run
pnpm run release:verify <version>
```

## 8. Risks & mitigations

- Messaging log lines change shape if the move alters output → the moved tests are byte-identical
  assertions, and messaging's delegation test pins identity.
- Reporter de-dup could stop collapsing if the rendering included volatile text → ioredis aggregates
  carry address/port/code only; a test pins repeat → `debug` for an identical aggregate.
- A `warn` line on an unauthenticated route could become a log-flood vector → state-change de-dup
  per provider (bounded by the configured provider count), fixed reason codes only.

## 8a. Design security review

> Added after the committed-tree audit of `73a71f4e` reported it missing (the audit's blocking
> finding). Written by the planner, not the auditor; the maintainer waived a re-audit.

- **Reviewed flows:** an unauthenticated `GET <loginPath>` and a signed-in `POST logoutPath`
  resolving provider endpoints; a bearer token triggering an outside-issuer key-set refresh; a
  backend driver error reaching `createConnectionErrorReporter` or idempotency `describeThrown`; a
  discovery lookup with nothing cached reaching `errorHandler`.
- **Assets:** log integrity and volume (no forged lines, no flood); credentials and payloads inside
  error text; discovery topology (service names, backend addresses) in response bodies.
- **Attackers:** an unauthenticated HTTP client (any host, query, path, forged or expired token); a
  hostile or misrouted discovery or JWKS server; a dependency whose errors carry unusual values.
- **Budgets:** at most one `warn` per change of reason per CONFIGURED provider or issuer; reporter
  state keyed only by configuration; a rendered error line capped at 8192 code points.
- **Audit obligations:** plant canaries in discovery documents, JWKS responses, request host and
  query, and token claims, and prove their absence from every log line and body; drive repeated
  failures across cooldown windows and show one `warn`; show unconfigured provider paths add no
  reporter state; show CR/LF/NUL/bidi characters cannot reach a log line; show the discovery 503
  body carries no service name, cause or `message`, and that configuration faults stay 500.

| Threat                                                        | Resolution                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Log flood from the unauthenticated login route                | §3.5 state-change reporter keyed by configured provider name                                                                                                                                                                                                                                                          |
| Attacker data in a log line                                   | Reasons are fixed `RefreshError` codes; messages are built from codes and configured names only                                                                                                                                                                                                                       |
| Log injection through a rendered error                        | `describeError` collapses whitespace, control and format characters                                                                                                                                                                                                                                                   |
| Topology in the 503 body                                      | Fixed `detail`; the service name stays in the server-side message                                                                                                                                                                                                                                                     |
| Credentials in cause or aggregate messages (audit L1)         | ACCEPTED: classifiers are a scalar allowlist, and ioredis/pg/net put credentials in fields outside it; logger-plugin already logs cause chains. A credential embedded in a cause MESSAGE now reaches the line, and field-path redaction cannot mask a substring — an application whose driver does that must scrub it |
| Configuration fault reported as a temporary outage (audit L2) | FIXED after the audit: a provider's own `DiscoveryUnavailableError` passes through unbranded (§3.6)                                                                                                                                                                                                                   |

## 9. Out of scope

- Changing the level of bearer token REJECTIONS (bad signature, expired, wrong audience) — caller
  faults, deliberately kept at `debug`.
- Readiness changes for discovery or Redis — M119b.
