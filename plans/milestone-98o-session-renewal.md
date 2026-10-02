# Milestone 98o — Diagnostics session renewal (`@setu-ts/diagnostics-plugin`)

> **Status:** Planning, revision 3. Branch: `feat/m98o-session-renewal`. `main` is protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR. The design
> security review (§10.1) has had two independent rounds, both of which blocked; this revision
> resolves the round-2 findings and needs a third independent round plus the open maintainer
> approvals in §10.1 before implementation starts (ROADMAP, "Mandatory Security Audit Gates for
> M98d–M98n").

## 0. Objective & scope

A paired diagnostics session can be renewed from the native client without relaunching the
application, up to a hard maximum lifetime that the application chose at launch. Today an M98b
session lives `ttlMs` (15 minutes by default, at most one hour); at that point the plugin's expiry
timer revokes the session, drops the key and closes the listener, and only a fresh launch with a
fresh credential pair reconnects. The devtool is an editor extension that stays open for a working
day, so its D04 free preview needs renewal (devtool roadmap milestone D03b). The boundary: renewal
extends the SAME session — same key, same session ID, same instance binding, same sequence space —
and never outlives the application process, its revocation, or the configured cap. Expiry keeps its
M98b meaning: when the session really expires, the key is dropped and the listener closes.

- **In scope:**
  - An opt-in `maxSessionLifetimeMs` option on `DiagnosticsPlugin`; without it nothing changes,
    including the status body bytes.
  - One new authenticated operation, `GET /v1/renew`, inside protocol v1.
  - An optional `renewal` member in the status body that advertises support.
  - The expiry timer re-arming for the renewed remainder instead of firing at the original `ttlMs`.
  - Native client support: `session()` and `renew()`.
  - The CLI's generated development entry turning renewal on, released in step with the devtool.
  - Protocol, security-review, README, `PUBLIC_API.md`, ROADMAP and CHANGELOG updates; new fixture
    vectors.
- **NOT this milestone:**
  - The devtool's consumer work, its re-pin and its design-document changes — devtool repository,
    milestone D03b.
  - The publication hold that keeps `packages/diagnostics-plugin` from shipping before this letter
    (§3.9) — a release-tooling prerequisite on its own branch, landed before the next release.
  - Re-keying or rotating the session ID — rejected in §3.2.
  - Sessions that survive an application restart — a restart is a new instance and needs a new
    pairing; no milestone owns it.
  - Remote connections and non-Deno listeners — unowned, recorded in the ROADMAP M98 out-of-scope
    list.

## 1. Contracts verified from SOURCE (not names)

| Reference                              | Source (file:line)                                                                                                        | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DiagnosticsSessionState`              | `packages/diagnostics-plugin/src/security/session.ts:47-241`                                                              | `#expiresAtHr` is `readonly` and set once in `create()` as `clock.hrtime() + ttlMs` (:95). No renewal, no activation timestamp. `admitAfterVerify` (:178) checks revoked, expiry, sequence exhaustion and monotonicity, then advances — synchronously.                                                                                                                                                               |
| `SessionClock`                         | `session.ts:24-27`                                                                                                        | `hrtime(): number` only — the runtime's monotonic clock, fractional milliseconds. Never wall-clock.                                                                                                                                                                                                                                                                                                                  |
| `remainingMs` / `isAdmissible`         | `session.ts:137-139`, `:160-162`                                                                                          | The handler's gates read `#expiresAtHr`. They are NOT the only expiry path: see the expiry timer row. `remainingMs` is `Math.max(0, expiresAtHr - hrtime())` with NO floor, so it is fractional (its JSDoc wrongly says "whole milliseconds"); measured on Deno, a status body carries e.g. `899987.28…`.                                                                                                            |
| Runtime clock                          | `packages/runtime/src/services/cross-runtime.ts:39-41`                                                                    | `hrtime()` is `performance.now()`: fractional milliseconds.                                                                                                                                                                                                                                                                                                                                                          |
| Expiry timer                           | `packages/diagnostics-plugin/src/plugin/diagnostics-plugin.ts:159`, `:436-444`                                            | After `listen` resolves, `ctx.runtime.setTimeout(() => revoke().catch(() => {}), ttlMs)`. It fires at the ORIGINAL `ttlMs` and revokes unconditionally. `revoke()` clears only the handle stored in `expiryTimer` (:180-183). Pinned by `test/unit/plugin.test.ts:246-258`, whose fixture clock (`test/fixtures/helpers.ts:54-68`, wired at `plugin.test.ts:113-118`) NEVER advances while its `setTimeout` is real. |
| `revoke()`                             | `diagnostics-plugin.ts:163-191`; `session.ts:237-240`                                                                     | Bumps the generation, revokes and drops the session, clears the expiry timer, closes the listener. Session revocation is terminal and idempotent.                                                                                                                                                                                                                                                                    |
| Revocation paths                       | `diagnostics-plugin.ts:272-273`, `:436-444`                                                                               | Three: `onStopping`, `onClose`, and the expiry timer.                                                                                                                                                                                                                                                                                                                                                                |
| MAC field builders                     | `packages/diagnostics-plugin/src/security/authentication.ts:20`, `:29-46`, `:55-73`                                       | Domain `setu-diagnostics-v1`; the request MAC fixes the method to `'GET'` (:42). A new operation needs no new field, only a new canonical target with no LF.                                                                                                                                                                                                                                                         |
| `parseTarget` / target constants       | `packages/diagnostics-plugin/src/protocol/protocol.ts:201-255` (`STATUS_TARGET` at :74)                                   | Fixed snapshot operations return `{ op, canonicalTarget, after: 0, limit: 0 }`; anything unlisted returns `null` and is refused before authentication.                                                                                                                                                                                                                                                               |
| `statusBody`                           | `protocol.ts:414-419`                                                                                                     | Returns `{ version: 1, instanceId, expiresInMs, inspectors }`.                                                                                                                                                                                                                                                                                                                                                       |
| `parseStatusBody` / `STATUS_BASE_KEYS` | `protocol.ts:518`, `:590-617`                                                                                             | Accepts EXACTLY the three base keys plus an optional `inspectors`; any other key is refused (`keys.length !== expectedCount`).                                                                                                                                                                                                                                                                                       |
| Connector gate                         | `packages/diagnostics-plugin/src/transport/connector-handler.ts:1059-1094`                                                | Non-status ops must present an instance; verify → `admitAfterVerify` (:1079) → `expired` when `remainingMs === 0`, else `unauthorized` → session budget (`rate-limited`, :1084) → bound-instance check (:1092).                                                                                                                                                                                                      |
| Status branch                          | `connector-handler.ts:1098-1118`                                                                                          | Repeated status exchanges are allowed once bound if the presented instance matches; the body carries the fractional `remainingMs` (:1113-1117).                                                                                                                                                                                                                                                                      |
| Post-await response gates              | `connector-handler.ts:1336-1338`, `:1353-1355`                                                                            | `isAdmissible` re-checked before and after signing. Failure answers `expired`, which is ALSO what a revocation landing in flight produces.                                                                                                                                                                                                                                                                           |
| Refusal codes                          | `docs/diagnostics-protocol.md:142-164`                                                                                    | Refusals are UNSIGNED `{ "version": 1, "error": <code> }`. The table describes `expired` only as "monotonic expiry reached" and `invalid-request` as "structural/grammar/framing violation".                                                                                                                                                                                                                         |
| `ttlMs` validation                     | `diagnostics-plugin.ts:59`, `:72`, `:118-120`                                                                             | `MAX_TTL_MS = 3_600_000`; integer 1–3,600,000, default 900,000.                                                                                                                                                                                                                                                                                                                                                      |
| `DiagnosticsPluginOptions`             | `packages/diagnostics-plugin/src/interfaces/index.ts:40-89`                                                               | `enabled: true`, `port`, `sessionId`, `sessionKey`, `ttlMs?`. No lifetime cap.                                                                                                                                                                                                                                                                                                                                       |
| `IDiagnosticsClient`                   | `interfaces/index.ts:180-`                                                                                                | Read methods only (`snapshot`, `read`, eleven inspectors, `close`); no session or lifetime accessor.                                                                                                                                                                                                                                                                                                                 |
| Client exchange                        | `packages/diagnostics-plugin/src/client/client.ts:308-408`                                                                | Every non-200 becomes the fixed `connection` error (:357-358); the refusal body is never read.                                                                                                                                                                                                                                                                                                                       |
| Client pairing                         | `client.ts:410-438`                                                                                                       | Any initial-pairing failure is terminal (`pairingFailed`); `status.expiresInMs` is parsed and then discarded (:436-437).                                                                                                                                                                                                                                                                                             |
| Barrel test                            | `packages/diagnostics-plugin/test/index.test.ts`                                                                          | Existing barrel-export test (runtime identity + type level); extended, not duplicated.                                                                                                                                                                                                                                                                                                                               |
| Generated dev entry                    | `packages/cli/src/devtool/dev-entry.ts:112-117`                                                                           | Emits `DiagnosticsPlugin({ enabled, port, sessionId, sessionKey })` with no `ttlMs`.                                                                                                                                                                                                                                                                                                                                 |
| Runnable consumer                      | `scripts/inspect-local-diagnostics.ts:30`; `test/inspect-local-diagnostics.test.ts`                                       | Imports the package barrel; subprocess-tested.                                                                                                                                                                                                                                                                                                                                                                       |
| Release list                           | `scripts/release-packages.ts:43`, `:93`                                                                                   | `packages/diagnostics-plugin` is in `PUBLISHED_PACKAGES`; `UNPUBLISHED_PACKAGES` is empty. The next release publishes it. JSR returns 404 for it today, so no published version exists.                                                                                                                                                                                                                              |
| Release gates                          | `.github/workflows/ci.yml:452-488`; `.github/workflows/release.yml:361`; `deno.json:74`, `:79`                            | `release:verify` runs on EVERY pull request and push (job `publish-dry-run`). Publishing happens only in `release.yml`, through `release:publish` (`scripts/publish-packages.ts`).                                                                                                                                                                                                                                   |
| CLI use of the package                 | `packages/cli/src/devtool/planner.ts:215`; `packages/cli/src/commands/devtool.ts:65`; `dev-entry.ts:80`                   | Generated projects depend on and import `@setu-ts/diagnostics-plugin`, so a release that skipped it would ship a CLI whose `--devtool` projects cannot install.                                                                                                                                                                                                                                                      |
| Status-shape publication gate          | `ROADMAP.md`, "Mandatory Security Audit Gates for M98d–M98n" (inspector-manifest paragraph)                               | A client refuses any status key it does not know and latches a terminal pairing failure, so the status body is frozen at first publication. That paragraph cites `protocol.ts:294-322`; the parser is now at `:590-617`.                                                                                                                                                                                             |
| Devtool consumer                       | `setu-ts-devtool/src/diagnostics/client.ts`; `setu-ts-devtool/scripts/framework-pin.json`; `setu-ts-devtool/package.json` | The devtool bundles `createDiagnosticsClient` from framework commit `26aebd0e`; that client refuses a status body carrying `renewal`. The devtool itself is unpublished (`"private": true`, version 0.0.1). Users also run `setu new --devtool` themselves (`setu-ts-devtool/docs/framework-compatibility.md:175`).                                                                                                  |
| "Read-only" commitments                | `ROADMAP.md:10692-10694`, `:10819-10823`, `:11403-11404`, `:11426`, the M98 progress row                                  | M98's objective excludes "mutation controls"; the ticked M98b deliverable says the protocol has no "mutation command"; the audit gates require "refusal of … mutation for every added operation"; the acceptance evidence requires refusing "every attempted write/control operation"; the progress row says "secure read-only devtool diagnostics".                                                                 |
| `ILifecycleApi.onStopping`             | `packages/common/src/plugin.ts:381`                                                                                       | Exists; revocation already uses it. No kernel change.                                                                                                                                                                                                                                                                                                                                                                |
| `IRuntimeServices.setTimeout`          | `packages/common/src/runtime.ts:359`                                                                                      | `setTimeout(fn, ms): TimerHandle`, cancelled by `clearTimeout`. The expiry re-check reads `hrtime()`, so timer lateness never closes a session early.                                                                                                                                                                                                                                                                |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                               | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                                        | Doc deliverable (same PR)                                                                                                                                                         |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | The ROADMAP M98 text says "Future inspectors beyond the eleven fixed entries require a new protocol version", which a reader could apply to any new operation.         | That rule is about inspectors and the `inspectors` manifest. Renewal is a session operation, advertised by its own status member: a v1 extension (§3.4).                                                                                                                                                                                                                        | ROADMAP M98o section states the v1 decision and why it is legal only before first publication.                                                                                    |
| C2 | `docs/diagnostics-protocol.md:106` and the security review's budget table state the session lifetime as "15 min default, 1 ms – 1 h" with no renewal.                  | Both stay true for the initial window; they gain the renewable maximum, stated as awake (monotonic) time.                                                                                                                                                                                                                                                                       | Protocol doc "Replay, expiry, and binding" and the review's "Approved budgets" table.                                                                                             |
| C3 | The devtool's `docs/architecture.md`, `docs/security.md` (S09) and `docs/framework-compatibility.md` forbid renewal.                                                   | Those are the devtool's documents, updated by devtool D03b.                                                                                                                                                                                                                                                                                                                     | None here; recorded so the devtool PR names it.                                                                                                                                   |
| C4 | M98 promises a read-only protocol with no mutation command (the "Read-only" commitments row in §1); renewal changes session state. **Maintainer-approved 2026-10-02.** | "Read-only" means the protocol never changes APPLICATION or DIAGNOSTIC state. `/v1/renew` is the only operation whose PURPOSE is to change connector state (every request already advances the sequence and budgets, and the first status binds the instance); it extends the session's lifetime within the launch's cap. Every other write or control operation stays refused. | ROADMAP M98 objective, the M98b deliverable wording, the audit-gates mutation sentence, the acceptance-evidence line and the progress row; the protocol doc's "Operations" intro. |
| C5 | The protocol doc says `expired` means "monotonic expiry reached"; the post-await gates also answer `expired` when a revocation lands in flight.                        | The code is right; the table is incomplete.                                                                                                                                                                                                                                                                                                                                     | Protocol doc refusal table: `expired` covers expiry and revocation during a request.                                                                                              |
| C6 | `invalid-request` is documented as a structural violation; a renew against a session without renewal is refused with it after authentication.                          | Keep the code (a new code would add a value nobody acts on); widen its definition.                                                                                                                                                                                                                                                                                              | Protocol doc refusal table: `invalid-request` also covers an operation the session does not support.                                                                              |
| C7 | The ROADMAP publication-gate paragraph cites `protocol.ts:294-322` for the status parser.                                                                              | The parser is at `:590-617`.                                                                                                                                                                                                                                                                                                                                                    | ROADMAP citation corrected.                                                                                                                                                       |

## 3. Design decisions

### 3.1 Opt-in by an explicit lifetime cap

- **Decision:** a new option `maxSessionLifetimeMs?: number`. Absent: renewal is disabled, the
  status body is byte-identical to today's, the expiry timer behaves exactly as today, and
  `GET /v1/renew` is refused with `invalid-request`. That refusal comes AFTER the admit gate, the
  session budget and the bound-instance check, so it reveals nothing to a caller without the key.
  Present: a safe integer with `ttlMs ≤ maxSessionLifetimeMs ≤ 43_200_000` (12 hours of awake time);
  anything else throws at `DiagnosticsPlugin(...)` with a fixed message that echoes no value.
- **Why:** renewal lengthens how long a launch credential is worth having. An application that never
  asked for that must not get it by upgrading, and a cap the application picks keeps the absolute
  bound a property of the launch rather than of the client.
- **Test home:** `test/unit/plugin.test.ts` (validation), `test/unit/connector-handler.test.ts`
  (disabled refusal and its position), `test/unit/protocol.test.ts` (status body unchanged).

### 3.2 Renewal extends the same session; no re-keying

- **Decision:** renewal moves the existing session's expiry. The key, session ID, instance binding
  and sequence counter are unchanged.
- **Why:** the pair is delivered once, through the child environment, and the protocol has no
  channel for delivering a new secret. Re-keying would have to send key material over the wire,
  which the protocol forbids, or derive it from the existing key, which gives no protection against
  the only realistic compromise (the original key leaking). Rotating only the session ID protects
  nothing, because the session ID is not an authenticator.
- **Test home:** `test/unit/session.test.ts` (same key and sequence space after renewal).

### 3.3 Renewal arithmetic, on one clock reading

- **Decision:** at activation the session records `activatedAtHr` and
  `maxExpiresAtHr = activatedAtHr + maxSessionLifetimeMs`. `renew(clock)` reads `now` ONCE and sets
  `expiresAtHr = max(expiresAtHr, min(now + ttlMs, maxExpiresAtHr))`. Every lifetime report — the
  renew body and the status `renewal` member — is built from one `lifetime(clock)` call that reads
  `now` once and returns `expiresInMs = floor(max(0, expiresAtHr - now))` and
  `maxRemainingMs = floor(max(0, maxExpiresAtHr - now))`. Because `expiresAtHr ≤ maxExpiresAtHr`
  always holds and both floor the same reading, `expiresInMs ≤ maxRemainingMs` always holds. When
  renewal is configured, the status body's `expiresInMs` also comes from that same `lifetime()`
  reading, so all three numbers in a renewable status are integers from one instant. When renewal is
  NOT configured, the status body keeps today's fractional `remainingMs` unchanged — that is what
  "byte-identical" means — and the status parser keeps accepting a fractional `expiresInMs` on the
  legacy and no-renewal bodies; only the renew body and a status carrying `renewal` require
  integers. The `remainingMs` JSDoc is corrected to say it is fractional. Renewal is accepted at any
  point while the session is admissible; it never shortens the session and cannot be banked — no
  number of renewals puts the expiry later than `now + ttlMs`.
- **Why:** measuring each extension from `now` makes early or repeated renewal harmless, so there is
  no earliest-renewal rule to get wrong. One reading prevents a fractional `hrtime()` from making an
  honest body fail the client's inequality at the cap. All arithmetic is on the monotonic clock, so
  the cap is AWAKE time: on Linux the monotonic clock stops during suspend, so a key stays valid
  across a suspended night. M98b already had this property at one hour; the maintainer approves the
  12-hour ceiling knowing it (§10.1).
- **Test home:** `test/unit/session.test.ts` (fake clock: before cap, at cap, past cap, repeated
  renewals never beyond `now + ttlMs`, never shortens, `expiresInMs ≤ maxRemainingMs` at the cap
  with fractional clock values).

### 3.4 Wire: `GET /v1/renew` and the status `renewal` member, in protocol v1

- **Decision:**
  - `GET /v1/renew` is a fixed snapshot-style operation: no query, canonical target `/v1/renew` (no
    LF), every existing header and MAC rule unchanged, a bound instance required.
  - Its signed body is
    `{ "version": 1, "instanceId": <bound>, "expiresInMs": N, "maxRemainingMs": N }`.
  - When renewal is configured, the status body gains `"renewal": { "maxRemainingMs": N }`. When it
    is not, the member is absent. `renewal` is admitted only alongside `inspectors`; a legacy
    three-key body carrying `renewal` is refused by the parser.
  - Both stay in protocol v1; `MAC_DOMAIN` is unchanged.
- **Why:** the protocol is GET-only with a zero-body policy and the request MAC fixes the method, so
  a GET with no new field keeps every existing gate valid. A state change behind a GET is safe here
  only because every request is signed, sequence-gated, `Cache-Control: no-store`, refused from any
  browser origin and refused through forwarding headers. The status member lets a client learn
  support without probing an unknown route. Adding a status key is legal only because no client has
  been PUBLISHED (§1). After first publication it would break every client in the field, so this
  letter must merge before `packages/diagnostics-plugin` first publishes (§3.9).
- **Test home:** `test/unit/protocol.test.ts`, `test/unit/connector-handler.test.ts`, fixture
  vectors in `test/fixtures/protocol-v1.json`.

### 3.5 The renewal happens inside the existing synchronous gate

- **Decision:** the `renew` branch runs after `admitAfterVerify`, the session budget and the
  bound-instance check, then the disabled check, then `session.renew(clock)` — with no `await`
  between the admit gate and the mutation. The response is then built and passes the existing
  post-await gates. If `session.renew(clock)` declines — the session reached expiry between the
  admit gate and the renewal, which an advancing fractional clock makes possible — the handler
  answers `expired` and builds no body. Every refusal AFTER `admitAfterVerify` (`rate-limited`,
  `unauthorized` for a wrong instance, `invalid-request` for a disabled renew, `expired`) means no
  renewal happened and the sequence number is consumed; refusals before admission consume nothing,
  as today. A renewal applied but whose response is refused (revocation in flight) is moot, because
  the session is revoked. A renewal applied but whose response is lost leaves the session renewed;
  the client recovers the real remaining time with `session()`. Consumers renew with a margin — the
  client JSDoc recommends at half the remaining time — so one refused renewal cannot let a session
  lapse.
- **Why:** the M98b gate's guarantee — a replayed or racing copy cannot also pass — extends to
  renewal for free. An expired or revoked session fails `admitAfterVerify` before the renewal
  branch, so expiry stays terminal.
- **Test home:** `test/unit/connector-handler.test.ts` (two copies of one signed renew → exactly one
  200; renew after expiry → `expired` and expiry unchanged; `renew()` declining after admission →
  `expired` with no body; a `rate-limited` renew leaves expiry unchanged; a disabled renew with a
  wrong instance → `unauthorized`, which pins the order); `test/integration/lifecycle.test.ts`
  (revoke during the renew's `sha256Hex` and `sign` awaits releases no body).

### 3.6 The expiry timer re-arms; real expiry still closes the listener (maintainer-approved 2026-10-02)

- **Decision:**
  - Without `maxSessionLifetimeMs` the timer is exactly today's: armed for `ttlMs` after `listen`,
    revoking unconditionally. No re-arm code runs.
  - With it, the callback first returns if `revoked`, if `generation !== startGeneration`, or if the
    plugin-level `session` (nulled by `revoke()`) is `null`. Otherwise it calls `revoke()` when
    `!active.isAdmissible(clock)`, and else re-arms for `Math.ceil(active.remainingMs(clock))` — the
    unfloored remainder, rounded up, so the listener never closes while the handler still admits.
  - Every re-armed handle is written back to `expiryTimer`, so `revoke()` (from stop, close or the
    timer) always clears the live handle and no timer outlives the plugin.
- **Why the option gates it:** the existing TTL test's clock never advances (§1), so a re-arming
  callback would re-arm forever there. Keeping today's code path without the option makes "behaviour
  unchanged" literally true instead of dependent on how a test clock behaves.
- **Why:** this keeps M98b's guarantee that a real expiry drops the key and closes the port, while
  letting a renewed session live. The callback re-reads the monotonic clock, so a late timer only
  delays closing, never ends a live session early, and the handler's own gates already refuse any
  request after expiry. It needs no new seam between the handler and the plugin.
- **Test home:** `test/unit/plugin.test.ts`, with a fake `setTimeout`/`clearTimeout` that counts
  outstanding handles and an advancing fake clock: a renewed session survives the original `ttlMs`;
  the timer revokes at the renewed expiry and at the cap, never while `isAdmissible`; revoke and
  stop after a re-arm leave zero outstanding handles; stop during a re-arm leaves zero; the existing
  "expires the session at the configured TTL" test passes unchanged.

### 3.7 Client surface

- **Decision:**
  - `session(): Promise<DiagnosticsSessionLifetime>` performs a signed status exchange (pairing
    first if needed) and returns a frozen `{ expiresInMs, renewal: { maxRemainingMs } | null }`. A
    later status whose `renewal` presence differs from the paired one is refused with the fixed
    `connection` error. That refusal is non-terminal: it does not latch `pairingFailed`, like every
    other post-pairing verification failure.
  - `renew(): Promise<DiagnosticsSessionLifetime>` pairs first if needed. If the paired status had
    no `renewal`, it throws a new fixed `CLIENT_ERRORS.notRenewable` message WITHOUT sending a renew
    request (a message, not a class; `connection` would wrongly claim a verification failure).
    Otherwise it performs `GET /v1/renew` and validates the exact body: instance equal to the paired
    one, both numbers non-negative safe integers, and `expiresInMs ≤ maxRemainingMs`.
  - No new error type and no reading of refusal bodies: every non-200 stays the fixed `connection`
    error, and initial-pairing failures stay terminal. At real expiry the listener closes, so a
    consumer sees `connection` and schedules renewal from `expiresInMs` rather than waiting for a
    refusal.
- **Why:** with §3.6 an `expired` refusal is almost never observed, and when it is, it can also mean
  revocation in flight (C5). Parsing an unsigned body for that signal would add a client attack
  surface for nothing a consumer can act on. Keeping the M98b rule that a non-200 is one fixed
  failure leaves T6, T14, T15 and T16 untouched.
- **Test home:** `test/unit/client.test.ts`.

### 3.8 The CLI turns renewal on, in step with the devtool (maintainer-approved 2026-10-02)

- **Decision:** `renderDevEntry` emits `maxSessionLifetimeMs: 28_800_000` (8 hours) and keeps the
  default `ttlMs`.
- **Why it is safe to ship:** the devtool is the only client of the generated entry, and it is
  unpublished (§1). Its pinned client refuses `renewal`, but no released devtool exists to break.
  The guarantee is therefore a requirement on the devtool, recorded in devtool D03b: its first
  published version must carry a renewal-aware client, and it re-pins to a framework containing M98o
  before that release. Wherever the devtool itself invokes the CLI (D04's fixtures now, its planned
  context-menu scaffolding later) it runs the exact CLI version that matches its bundled client.
  That does not cover a user running `setu new --devtool` by hand with another CLI version; for that
  the devtool's compatibility documentation names the supported framework version, as it does today.
- **Why emit it at all:** the generated entry exists only for the devtool launcher, the consumer
  that needs renewal; without the line every scaffolded project keeps the forced relaunch.
- **Test home:** `packages/cli/test/unit/dev-entry.test.ts` (emitted text) and
  `packages/cli/test/e2e/devtool-e2e.test.ts` (the generated entry type-checks and boots against
  this workspace).

### 3.9 Publication hold — a prerequisite, not part of this letter

- **Decision:** before the next release, a separate release-tooling change adds a named publication
  hold for `packages/diagnostics-plugin`, enforced at PUBLISH time only:
  `scripts/publish-packages.ts` (the `release:publish` task `release.yml` runs on a tag) refuses to
  start, before publishing any package, while a package in `PUBLISHED_PACKAGES` carries a hold, and
  names the hold's reason (M98o). `release:verify` reports the hold without failing on it, because
  CI runs it on every pull request (§1) and a failing check there would turn every unrelated PR red
  until M98o merges. This letter's PR removes the hold. Moving the package to `UNPUBLISHED_PACKAGES`
  was rejected: the released CLI's `--devtool` scaffolding imports `@setu-ts/diagnostics-plugin`, so
  a release that silently skipped it would ship a CLI whose generated projects cannot install.
- **Why:** the status shape freezes at first publication (§3.4), and today only a manual check
  stands between a release and that freeze. A failing release forces the decision — finish M98o or
  remove the hold on purpose — instead of letting it happen by accident.
- **Test home:** the release-tooling change's own tests, which show both that a publish with the
  hold present refuses before publishing anything and that `release:verify` stays green with it.
  This letter's PR shows the hold removed.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                                | Kind                                       | Consumer / real code path that READS it                                                                 |
| -------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `DiagnosticsSessionLifetime`                                   | type (new)                                 | Return type of `session()`/`renew()`; read by the devtool to schedule renewal and by the e2e exercise.  |
| `IDiagnosticsClient.session`                                   | method (new, on an existing exported type) | The devtool after pairing and after a lost renew response; `scripts/inspect-local-diagnostics.ts`; e2e. |
| `IDiagnosticsClient.renew`                                     | method (new)                               | The devtool before half its remaining time; `scripts/inspect-local-diagnostics.ts`; e2e.                |
| `DiagnosticsPlugin`, `createDiagnosticsClient`, existing types | unchanged                                  | Existing consumers.                                                                                     |

No error class is added (cut in revision 2, §3.7). No `common` export changes. `session()` and
`renew()` become required members of the exported `IDiagnosticsClient`, which is breaking for an
out-of-repo implementor of that interface; the only implementations are in-repo, and the devtool
wraps the client rather than implementing it. The CHANGELOG entry says so.

### 4.1 Options — every option names its consumer

| Option                                          | Consumer                                                                                                                | Behavior (per implementation)                                                                                 |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `DiagnosticsPluginOptions.maxSessionLifetimeMs` | `validatePluginOptions` → `DiagnosticsSessionState.create`; the connector's status and renew branches; the expiry timer | Absent: no renewal, unchanged status body, unchanged timer. Present: cap per §3.1/§3.3; refused out of range. |

## 5. Implementation files

| File                                                             | Purpose                                                                                                                                                           |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/diagnostics-plugin/src/index.ts`                       | Export `DiagnosticsSessionLifetime`.                                                                                                                              |
| `packages/diagnostics-plugin/src/security/session.ts`            | `activatedAtHr`, `maxExpiresAtHr`, mutable expiry, synchronous `renew(clock)`, single-reading `lifetime(clock)`, `isRenewable`.                                   |
| `packages/diagnostics-plugin/src/protocol/protocol.ts`           | `RENEW_TARGET`, `parseTarget` `'renew'` op, `statusBody` optional `renewal`, `parseStatusBody` accepting it only with `inspectors`, `renewBody`/`parseRenewBody`. |
| `packages/diagnostics-plugin/src/transport/connector-handler.ts` | The `renew` branch in the order of §3.5; status passes the renewal member.                                                                                        |
| `packages/diagnostics-plugin/src/plugin/diagnostics-plugin.ts`   | Validate `maxSessionLifetimeMs`; pass it to the session; the re-arming expiry timer (§3.6).                                                                       |
| `packages/diagnostics-plugin/src/interfaces/index.ts`            | Option, `session()`, `renew()`, `DiagnosticsSessionLifetime`, JSDoc (including the half-remaining-time recommendation).                                           |
| `packages/diagnostics-plugin/src/client/client.ts`               | `session()`, `renew()`, renewal support retained from pairing and checked on later status exchanges.                                                              |
| `packages/cli/src/devtool/dev-entry.ts`                          | Emit `maxSessionLifetimeMs`.                                                                                                                                      |
| `scripts/inspect-local-diagnostics.ts`                           | Exercise `session()` and `renew()` in the runnable consumer.                                                                                                      |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                              | src covered                            | Key assertions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/session.test.ts` (extend)                   | `session.ts`                           | Fake `SessionClock`: renew before cap, clamped at cap, no-op past cap, never shortens, never beyond `now + ttlMs`; refused after expiry and after revoke (expiry unchanged); not renewable without a cap; `lifetime()` keeps `expiresInMs ≤ maxRemainingMs` at the cap with fractional clocks.                                                                                                                                                                                                                                                                                        |
| `test/unit/protocol.test.ts` (extend)                  | `protocol.ts`                          | `/v1/renew` parses; `/v1/renew?x`, `/v1/renew/`, `/v1/Renew` refused. Status body without the option is byte-identical to the pre-M98o body; with it carries exactly one more key. Parsers refuse every extra key, `renewal` without `inspectors`, negative and non-finite numbers. The renew parser and a status carrying `renewal` also refuse fractional numbers and `expiresInMs > maxRemainingMs`; legacy and no-renewal status bodies with a fractional `expiresInMs` are still accepted. A renewable status built at the cap with a fractional clock satisfies its own parser. |
| `test/unit/connector-handler.test.ts` (extend)         | `connector-handler.ts`                 | Renew without a bound instance → `invalid-request` before verification; renew disabled → `invalid-request` only after a valid MAC and a free budget; two copies of one signed renew → one 200; renew after expiry → `expired`; `renew()` declining after admission → `expired`, no body; `rate-limited` renew leaves expiry unchanged; disabled renew with a wrong instance → `unauthorized`; signed response MAC verifies over `/v1/renew`.                                                                                                                                          |
| `test/unit/plugin.test.ts` (extend)                    | `diagnostics-plugin.ts`                | `maxSessionLifetimeMs` below `ttlMs`, above 43,200,000, fractional and `NaN` each throw a message containing no value; absent accepted. Re-arming timer (fake counted `setTimeout`, advancing fake clock): a renewed session survives the original `ttlMs`; revocation at the renewed expiry and at the cap, never while admissible; zero outstanding handles after revoke, after stop, and after stop during a re-arm; the existing TTL test unchanged without the option.                                                                                                           |
| `test/unit/client.test.ts` (extend)                    | `client.ts`                            | `session()` pairs then returns the lifetime; `renew()` pairs first when unpaired; `renew()` without support throws `notRenewable` and sends no renew request; a later status whose `renewal` presence changed → `connection`, and a following call still works (non-terminal); a renew body with a wrong instance, extra key or broken inequality → `connection`.                                                                                                                                                                                                                     |
| `test/index.test.ts` (extend)                          | `index.ts`                             | `DiagnosticsSessionLifetime` reachable from the barrel at the type level; `session`/`renew` on a real client instance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `test/integration/security.test.ts` (extend)           | handler + session over a real socket   | Raw `Deno.connect`: renew with wrong key, replayed sequence, wrong instance and after revoke refused with the existing uniform codes; after real expiry the listener is closed (connection refused); a valid renew is served (positive control).                                                                                                                                                                                                                                                                                                                                      |
| `test/integration/lifecycle.test.ts` (extend)          | plugin + handler                       | Revoke landing during the renew's `sha256Hex` and `sign` awaits releases no body; the listener closes as before.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `test/e2e/local-connector.test.ts` (extend)            | whole package                          | Real app, `ttlMs: 1_000`, `maxSessionLifetimeMs: 3_000`: pair, renew at half the remaining time, `snapshot()` succeeds after the original second, renewals stop extending at the cap, then the listener closes and `snapshot()` throws `connection`. Arithmetic edge cases stay on the fake clock.                                                                                                                                                                                                                                                                                    |
| `test/fixtures/protocol-v1.json` (extend)              | —                                      | Renew request/response vectors computed with plain Web Crypto outside the production helpers, like the existing vectors.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `test/inspect-local-diagnostics.test.ts` (extend)      | `scripts/inspect-local-diagnostics.ts` | The subprocess consumer reports a renewed lifetime.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/cli/test/unit/dev-entry.test.ts` (extend)    | `dev-entry.ts`                         | Emitted entry contains the option with the decided value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/cli/test/e2e/devtool-e2e.test.ts` (existing) | `dev-entry.ts`                         | The generated entry still type-checks and boots against this workspace.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m98o-session-renewal, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:docs
deno task publish:check     # on the committed tree
deno task release:verify <version>
```

Plus the committed-tree security audit (§10.2) on the exact commit the PR merges, run in a context
that did not implement the milestone.

## 8. Risks & mitigations

- **The status-shape publication gate.** Publishing `packages/diagnostics-plugin` before this lands
  freezes the status body without `renewal` → the §3.9 hold makes such a release fail.
- **An un-re-pinned devtool against a new CLI.** Generated projects advertise `renewal`, which the
  devtool's pinned client refuses → §3.8 ties the CLI emission to the devtool re-pin and pins the
  CLI version the devtool runs.
- **A leaked key is useful for longer.** The window grows from at most `ttlMs` to at most
  `maxSessionLifetimeMs` of awake time → renewal still needs the key, the application chooses the
  cap, revocation on stop is unchanged, real expiry still closes the listener, and the code ceiling
  is fixed (§10.1).
- **A renewal mutation behind a GET.** A cache or intermediary replaying it → `no-store`, signed and
  sequence-gated requests and refusal of forwarding headers rule this out; the integration suite
  replays a captured renew over a raw socket.
- **Timer and clock disagree.** A late timer could keep the listener open past expiry → the handler
  gates refuse every request after expiry regardless, and the callback re-reads `hrtime()`.
- **Real-time e2e flakiness under the full suite.** → one-second windows, and every edge case on the
  fake clock.

## 9. Out of scope

- The devtool's renewal scheduler, UI countdown, re-pin and design-document updates — devtool D03b.
- The publication hold itself (§3.9) — its own release-tooling branch, before the next release.
- Re-keying or session-ID rotation (rejected, §3.2).
- Persisting a session across an application restart — unowned.
- A protocol v2 — not needed while the package is unpublished; owned by whichever letter first needs
  a v1-incompatible change.
- Non-Deno diagnostics listeners — unowned (ROADMAP M98 out-of-scope list).

## 10. Required security reviews and acceptance evidence

### 10.1 Design security review — revision 2, awaiting a second independent round

**History.**

- **Revision 1** was drafted 2026-10-02 by Claude against base commit `2b72167e`, from the committed
  M98b design (`docs/diagnostics-protocol.md`, `docs/diagnostics-security-review.md`).
- **Round 1** was run on 2026-10-02 against `196a4b6c` by an independent agent that did not write
  the plan, and its verdict was **blocked**. It measured a real app with a 300 ms session: the
  listener was closed at 330 ms, which is the expiry timer firing at the original `ttlMs`.
- **Revision 2** resolved the round-1 findings.
- **Round 2** was run on 2026-10-02 against `e01371b0` by a second independent agent, and its
  verdict was **blocked** (findings 1–3 below). It showed, by simulating the revision-2 timer, that
  the existing TTL test's never-advancing clock makes a re-arming callback re-arm forever.
- **Revision 3** resolves every round-2 finding. It is not recorded as complete until a third
  independent round passes.

**Round-1 findings and dispositions.**

| #  | Severity | Finding                                                                                                                  | Disposition                                                                        |
| -- | -------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| 1  | High     | The plugin's expiry timer revokes at the original `ttlMs` regardless of renewal; the plan never mentioned it.            | §3.6 re-arming timer (maintainer-approved); §1 rows added; tests in §6.            |
| 2  | Medium   | Renewal contradicts M98's committed "read-only, no mutation command" promise; not listed as a doc conflict.              | C4 (maintainer-approved definition) with named doc deliverables.                   |
| 3  | Medium   | The devtool's pinned client is a live consumer that refuses `renewal`; no mechanical guard against an early publication. | §3.8 lockstep and pinned CLI version (maintainer-approved); §3.9 publication hold. |
| 4  | Medium   | Classifying an unsigned 401 body adds client surface for a signal that almost never arrives and is ambiguous.            | Cut (§3.7); C5 corrects the doc.                                                   |
| 5  | Low      | `expiresInMs` and `maxRemainingMs` from separate clock reads can break the client's inequality at the cap.               | §3.3 single reading, floored; fake-clock test.                                     |
| 6  | Low      | The 12-hour cap is awake time; wall-clock validity is unbounded across suspend.                                          | Stated in §3.3, C2 and the approvals below.                                        |
| 7  | Low      | Reusing `invalid-request` for a disabled renew changes the code's documented meaning; refusal order unspecified.         | C6; order fixed in §3.1/§3.5.                                                      |
| 8  | Low      | A `rate-limited` renew consumed its sequence and did not renew; a late renewal can lapse.                                | §3.5 states it; half-remaining-time recommendation; test.                          |
| 9  | Low      | `renew()` before pairing, a changing `renewal` presence, and `renewal` without `inspectors` were unspecified.            | §3.4 and §3.7 specify all three; tests.                                            |
| 10 | Low      | Test-plan gaps: duplicate barrel test, missing consumer-script test, a nonexistent await, "after expiry" cases.          | §6 rewritten.                                                                      |
| 11 | Low      | 300 ms e2e windows are too tight under the full suite.                                                                   | One-second windows; edge cases on the fake clock.                                  |
| 12 | Note     | Citation drift (`parseTarget` span, bound-instance line, a stale ROADMAP citation).                                      | §1 corrected; C7.                                                                  |

**Round-2 findings and dispositions.**

| #  | Severity | Finding                                                                                                                              | Disposition                                                                                                |
| -- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 1  | High     | The re-arming timer breaks the existing TTL test (its clock never advances), and "the first firing always finds zero" is false.      | §3.6: re-arming only with the option; today's code path untouched without it.                              |
| 2  | Medium   | The status `expiresInMs` is fractional and from a separate reading; flooring only the new numbers breaks the parser at the cap.      | §3.3: one reading for every number in a renewable status; no-renewal bodies unchanged; parser rules in §6. |
| 3  | Medium   | Re-arm bookkeeping unspecified: handle not written back, "session gone" ambiguous, floored remainder closes early.                   | §3.6: handle written back, explicit guard, `Math.ceil` of the unfloored remainder, `isAdmissible` check.   |
| 4  | Medium   | A `release:verify` hold turns CI red on every PR until M98o merges.                                                                  | §3.9: enforced at publish time only; `release:verify` reports it without failing.                          |
| 5  | Low      | "The devtool runs the CLI at the exact version" is false for users running `setu new --devtool` themselves.                          | §3.8 restated on the devtool being unpublished, with a D03b requirement.                                   |
| 6  | Low      | No answer specified when `session.renew()` declines after admission.                                                                 | §3.5: `expired`, no body; test.                                                                            |
| 7  | Low      | "Every refusal consumes the sequence" is false for pre-admission refusals.                                                           | §3.5 scoped to refusals after admission.                                                                   |
| 8  | Low      | C4's "the one allowed change to connector state" is inaccurate; two read-only commitments missing from its deliverables.             | C4 reworded; deliverables extended; §1 row updated.                                                        |
| 9  | Low      | Citation drift (`ROADMAP.md:11418`, `parseTarget` at :74).                                                                           | §1 corrected.                                                                                              |
| 10 | Low      | Unsupported `renew()` names no message; terminality of a changed `renewal` presence unspecified; refusal order not pinned by a test. | §3.7: `notRenewable` message, non-terminal; §6 order test.                                                 |
| 11 | Note     | New required members on `IDiagnosticsClient` are breaking for implementors; the status-parser freeze is the last chance to decide.   | §4 and CHANGELOG note; status-parser tolerance added to the maintainer decisions below.                    |

**Reviewed flow:** native client → signed `GET /v1/renew` with the bound instance → every existing
M98b control (Host, Origin, forwarding headers, framing, target, session-ID lane, `subtle.verify`) →
the synchronous post-verify gate (revoked, expired, sequence) → session budget → bound-instance
check → disabled check → `session.renew(clock)` with no await → `lifetime(clock)` once → exact renew
body → 256 KiB bound → post-await gates → sign → client verifies the MAC over exact bytes → instance
binding → exact body validation → frozen lifetime to the caller. Separately: the expiry timer
re-reads the lifetime and revokes only at real expiry.

**Assets:** the session key (its useful lifetime is what this milestone changes), the session's
expiry, and the paired application's availability.

**Attackers:** A1–A5 as defined in `docs/diagnostics-security-review.md`. Renewal changes nothing
for A2 (browser) and A5 (provider). A1 (local process without the key) cannot renew, because renewal
needs a verified MAC. A3 (misconfiguration) is the opt-in risk. A4 (key holder) is the one whose
reach grows.

| #    | Threat                                                             | Resolution                                                                                                                                                                                                                      |
| ---- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RN1  | A1 extends a session it cannot read.                               | `/v1/renew` passes the same MAC verification as every operation; no renewal path exists before `subtle.verify`.                                                                                                                 |
| RN2  | A key holder keeps a session alive indefinitely.                   | Absolute `maxExpiresAtHr` fixed at activation; code ceiling of 12 hours of awake time; revocation on stop unchanged; real expiry closes the port.                                                                               |
| RN3  | A replayed or raced renew extends twice or revives a session.      | The renewal sits behind the existing sequence gate in one synchronous step and cannot be banked (§3.3).                                                                                                                         |
| RN4  | A renew revives an expired or revoked session.                     | `admitAfterVerify` refuses first; after real expiry the listener is closed and the key dropped (§3.6).                                                                                                                          |
| RN5  | Wall-clock manipulation extends a session.                         | All arithmetic on the monotonic `SessionClock`.                                                                                                                                                                                 |
| RN6  | An application gets renewable sessions it never asked for.         | Opt-in only (§3.1); without the option the status bytes, the timer and every behaviour are unchanged.                                                                                                                           |
| RN7  | The client is made to misreport the session's state.               | The client reads no refusal body (§3.7); renewal support is learned only from signed status, and a changed presence is refused.                                                                                                 |
| RN8  | Renewal state is learned without the key.                          | The `renewal` member and the renew body are only in signed responses; a disabled renew is refused only after verification.                                                                                                      |
| RN9  | The new canonical target breaks MAC injectivity (T7).              | `/v1/renew` contains no LF; the canonicalization audit obligation covers it.                                                                                                                                                    |
| RN10 | The timer ends a renewed session early, or outlives a revoked one. | The callback revokes only when `!isAdmissible`, re-arms for the rounded-up unfloored remainder, writes every handle back to `expiryTimer`, and returns once revoked or superseded, so `revoke()` always clears the live handle. |

**Approved budgets (proposed):** `maxSessionLifetimeMs` from `ttlMs` to 43,200,000 (12 hours of
awake time); no renewal count limit (the cap bounds it); renew requests debit the existing session
budget.

**Maintainer decisions.**

- Approved on 2026-10-02:
  - The expiry timer re-arms and real expiry still closes the listener (§3.6).
  - The C4 definition of "read-only".
  - The CLI emission ships in step with the devtool re-pin, and the devtool runs a pinned CLI
    version (§3.8).
- Still required before implementation:
  1. The hard ceiling of 12 hours of awake time for `maxSessionLifetimeMs`.
  2. The CLI's generated value of 8 hours.
  3. Shipping renewal as a protocol v1 extension, which ties this milestone to the first publication
     of `packages/diagnostics-plugin` and requires the §3.9 hold.
  4. Whether the status parser stays exact at first publication. Exact (today's rule, and this
     plan's default) means every future status addition needs protocol v2. The alternative is for a
     client to ignore unknown keys in a SIGNED status body, decided before first publication; that
     keeps the MAC guarantee but weakens the exact-DTO rule the client applies everywhere else.

### 10.2 Committed-tree audit obligations — not yet executed

Driven at the real surface (RuntimePlugin listener on a real loopback socket, the real connector,
the real client), with a positive control beside each negative case; wire cases use raw
`Deno.connect`, never `fetch`.

1. RN1/RN3/RN4: wrong key, replay, race of two copies, after revoke, wrong instance and before
   pairing are each refused with the existing uniform codes; one valid renew is served; after real
   expiry the port is closed.
2. RN2/RN10: renewals stop at the cap; the timer closes the listener at the renewed expiry and at
   the cap, never earlier; nothing configurable exceeds the 12-hour ceiling.
3. RN6: without the option the status body bytes equal the pre-M98o bytes, the timer fires at
   `ttlMs`, and `/v1/renew` is refused after verification.
4. RN7: the client never parses a refusal body, and a status whose `renewal` presence changed is
   refused.
5. RN8/RN9: the M98b canonicalization obligation covers `/v1/renew`; every signed field of the renew
   exchange is mutated one at a time and refused.
6. Revocation in flight: a revoke during a renew releases no data.

### 10.3 Completion gate and evidence record

The implementation PR records the audited commit, the reviewer (independent of the implementer),
each obligation's result, every finding and its disposition. The ROADMAP M98o row flips to ✅ only
with that record.
