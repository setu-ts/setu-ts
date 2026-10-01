# Milestone 98o — Diagnostics session renewal (`@setu-ts/diagnostics-plugin`)

> **Status:** Planning. Branch: `feat/m98o-session-renewal`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR. The design
> security review in §10.1 is a DRAFT: it must be reviewed by an agent that did not write it, and
> the maintainer must approve the three numbers in §10.1 "Maintainer approvals", before
> implementation starts (ROADMAP, "Mandatory Security Audit Gates for M98d–M98n").

## 0. Objective & scope

A paired diagnostics session can be renewed from the native client without relaunching the
application, up to a hard maximum lifetime that the application chose at launch. Today an M98b
session lives `ttlMs` (15 minutes by default, at most one hour) and then can only be replaced by a
fresh launch with a fresh credential pair. The devtool is an editor extension that stays open for a
working day, so its D04 free preview needs renewal (devtool roadmap milestone D03b). The boundary:
renewal extends the SAME session — same key, same session ID, same instance binding, same sequence
space — and never outlives the application process, its revocation, or the configured cap.

- **In scope:**
  - An opt-in `maxSessionLifetimeMs` option on `DiagnosticsPlugin`; without it nothing changes,
    including the status body bytes.
  - One new authenticated operation, `GET /v1/renew`, inside protocol v1.
  - An optional `renewal` member in the status body that advertises support.
  - Native client support: `session()`, `renew()`, and a typed `DiagnosticsSessionError` for the one
    session condition a consumer acts on — expiry.
  - The CLI's generated development entry opting in.
  - Protocol, security-review, README, `PUBLIC_API.md` and CHANGELOG updates; new fixture vectors.
- **NOT this milestone:**
  - The devtool's consumer work and its design-document changes — devtool repository, milestone
    D03b.
  - Re-keying or rotating the session ID — rejected in §3.2.
  - Sessions that survive an application restart — a restart is a new instance and needs a new
    pairing; no milestone owns it.
  - Remote connections and non-Deno listeners — unowned, recorded in the ROADMAP M98 out-of-scope
    list.

## 1. Contracts verified from SOURCE (not names)

| Reference                              | Source (file:line)                                                                              | Verified surface / fact                                                                                                                                                                                                                                                                                         |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DiagnosticsSessionState`              | `packages/diagnostics-plugin/src/security/session.ts:47-241`                                    | `#expiresAtHr` is `readonly` and set once in `create()` as `clock.hrtime() + ttlMs` (:95). No renewal, no activation timestamp. `admitAfterVerify` (:178) checks revoked, expiry, sequence exhaustion and monotonicity, then advances — synchronously.                                                          |
| `SessionClock`                         | `session.ts:24-27`                                                                              | `hrtime(): number` only — the runtime's monotonic clock. Never wall-clock.                                                                                                                                                                                                                                      |
| `remainingMs` / `isAdmissible`         | `session.ts:137-139`, `:160-162`                                                                | Both read `#expiresAtHr`; a renewal that moves it is seen by every existing gate with no further change.                                                                                                                                                                                                        |
| `revoke()`                             | `session.ts:237-240`                                                                            | Sets `#revoked`, drops the key; terminal and idempotent.                                                                                                                                                                                                                                                        |
| MAC field builders                     | `packages/diagnostics-plugin/src/security/authentication.ts:20`, `:29-46`, `:55-73`             | Domain `setu-diagnostics-v1`; the request MAC fixes the method to `'GET'` (:42). A new operation needs no new field, only a new canonical target with no LF.                                                                                                                                                    |
| `parseTarget` / target constants       | `packages/diagnostics-plugin/src/protocol/protocol.ts:74`, `:201-274`                           | Fixed snapshot operations return `{ op, canonicalTarget, after: 0, limit: 0 }`; anything unlisted returns `null` and is refused before authentication.                                                                                                                                                          |
| `statusBody`                           | `protocol.ts:414-419`                                                                           | Returns `{ version: 1, instanceId, expiresInMs, inspectors }`.                                                                                                                                                                                                                                                  |
| `parseStatusBody` / `STATUS_BASE_KEYS` | `protocol.ts:518`, `:590-617`                                                                   | Accepts EXACTLY the three base keys plus an optional `inspectors`; any other key is refused (`keys.length !== expectedCount`).                                                                                                                                                                                  |
| Connector gate                         | `packages/diagnostics-plugin/src/transport/connector-handler.ts:1061-1095`                      | Non-status ops must present an instance (:1059-1061); verify → `admitAfterVerify` (:1079) → `expired` when `remainingMs === 0`, else `unauthorized` → session budget → bound-instance check (:1091).                                                                                                            |
| Status branch                          | `connector-handler.ts:1098-1118`                                                                | Repeated status exchanges are allowed once bound if the presented instance matches; the body carries `remainingMs`.                                                                                                                                                                                             |
| Post-await response gates              | `connector-handler.ts:1336-1338`, `:1353-1355`                                                  | `isAdmissible` re-checked before and after signing; failure answers `expired`.                                                                                                                                                                                                                                  |
| Refusal codes                          | `docs/diagnostics-protocol.md:142-164`                                                          | Refusals are UNSIGNED `{ "version": 1, "error": <code> }`. `expired` (401) is answered only to a request whose MAC verified.                                                                                                                                                                                    |
| `ttlMs` validation                     | `packages/diagnostics-plugin/src/plugin/diagnostics-plugin.ts:59`, `:72`, `:118-120`            | `MAX_TTL_MS = 3_600_000`; integer 1–3,600,000, default 900,000.                                                                                                                                                                                                                                                 |
| Revocation hooks                       | `diagnostics-plugin.ts:272-273`                                                                 | `onStopping` and `onClose` both call `revoke()`.                                                                                                                                                                                                                                                                |
| `DiagnosticsPluginOptions`             | `packages/diagnostics-plugin/src/interfaces/index.ts:40-89`                                     | `enabled: true`, `port`, `sessionId`, `sessionKey`, `ttlMs?`. No lifetime cap.                                                                                                                                                                                                                                  |
| `IDiagnosticsClient`                   | `interfaces/index.ts:180-`                                                                      | Read methods only (`snapshot`, `read`, eleven inspectors, `close`); no session or lifetime accessor.                                                                                                                                                                                                            |
| Client exchange                        | `packages/diagnostics-plugin/src/client/client.ts:308-408`                                      | Every non-200 becomes the fixed `connection` error (:357-358) and the refusal body is never read.                                                                                                                                                                                                               |
| Client pairing                         | `client.ts:410-438`                                                                             | Any initial-pairing failure is terminal (`pairingFailed`); `status.expiresInMs` is parsed and then discarded (:436-437).                                                                                                                                                                                        |
| Client error messages                  | `client.ts:93-106`                                                                              | Fixed `CLIENT_ERRORS` strings; every thrown value is a plain `Error`.                                                                                                                                                                                                                                           |
| Generated dev entry                    | `packages/cli/src/devtool/dev-entry.ts:112-117`                                                 | Emits `DiagnosticsPlugin({ enabled, port, sessionId, sessionKey })` with no `ttlMs`.                                                                                                                                                                                                                            |
| Publication gate on the status shape   | `ROADMAP.md`, "Mandatory Security Audit Gates for M98d–M98n" (the inspector-manifest paragraph) | A published client refuses any status key it does not know and latches a terminal pairing failure, so the status body is frozen at first publication of `packages/diagnostics-plugin`. That package is not yet published (`deno.json` `0.7.0`; no JSR versions — `check:docs` reports "no published versions"). |
| `ILifecycleApi.onStopping`             | `packages/common/src/plugin.ts:381`                                                             | Exists; revocation already uses it. No kernel change needed.                                                                                                                                                                                                                                                    |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                       | Resolution (picked side)                                                                                                                                                 | Doc deliverable (same PR)                                                                      |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| C1 | The ROADMAP M98 text says "Future inspectors beyond the eleven fixed entries require a new protocol version", which a reader could apply to any new operation. | That rule is about inspectors and the `inspectors` manifest. Renewal is a session operation, advertised by its own status member. It is a v1 extension, decided in §3.4. | ROADMAP M98o section states the v1 decision and why it is legal only before first publication. |
| C2 | `docs/diagnostics-protocol.md:106` and the security review's budget table state the session lifetime as "15 min default, 1 ms – 1 h" with no renewal.          | Both stay true for the initial window; they gain the renewable maximum.                                                                                                  | Protocol doc "Replay, expiry, and binding" and the review's "Approved budgets" table updated.  |
| C3 | The devtool's `docs/architecture.md`, `docs/security.md` (S09) and `docs/framework-compatibility.md` forbid renewal.                                           | Those are the devtool's documents, updated by devtool D03b, not here.                                                                                                    | None in this repository; recorded so the devtool PR names it.                                  |

## 3. Design decisions

### 3.1 Opt-in by an explicit lifetime cap

- **Decision:** a new option `maxSessionLifetimeMs?: number`. Absent: renewal is disabled, the
  status body is byte-identical to today's, and `GET /v1/renew` is refused after authentication with
  `invalid-request`. Present: a safe integer with `ttlMs ≤ maxSessionLifetimeMs ≤ 43_200_000` (12
  hours); anything else throws at `DiagnosticsPlugin(...)` with a fixed message that echoes no
  value.
- **Why:** renewal lengthens how long a launch credential is worth having. An application that never
  asked for that must not get it by upgrading. A cap the application picks also keeps the absolute
  bound a property of the launch, not of the client.
- **Test home:** `test/unit/plugin.test.ts` (validation), `test/integration/security.test.ts`
  (disabled refusal), `test/unit/protocol.test.ts` (status body unchanged without the option).

### 3.2 Renewal extends the same session; no re-keying

- **Decision:** renewal moves the existing session's expiry. The key, session ID, instance binding
  and sequence counter are unchanged.
- **Why:** the pair is delivered once, through the child environment, and the protocol has no
  channel for delivering a new secret. Re-keying would have to send key material over the wire,
  which the protocol forbids, or derive it from the existing key, which gives no protection against
  the only realistic compromise (the original key leaking). Rotating only the session ID protects
  nothing, because the session ID is not an authenticator.
- **Test home:** `test/unit/session.test.ts` (same key and sequence space after renewal).

### 3.3 Renewal arithmetic

- **Decision:** at activation the session records `activatedAtHr` and
  `maxExpiresAtHr = activatedAtHr + maxSessionLifetimeMs`. A renewal sets
  `expiresAtHr = max(expiresAtHr, min(now + ttlMs, maxExpiresAtHr))`. Renewal is accepted at any
  point while the session is admissible. It never shortens the session, and it cannot be banked: no
  number of renewals puts the expiry later than `now + ttlMs`.
- **Why:** measuring each extension from `now` makes early or repeated renewal harmless, so there is
  no "earliest renewal" rule to get wrong. Every time is on the existing monotonic `SessionClock`,
  so wall-clock changes cannot extend a session. The cap is therefore in monotonic time: a host
  suspended for a night does not use up its awake budget, which is the existing M98b property.
- **Test home:** `test/unit/session.test.ts` (fake clock: before cap, at cap, past cap, repeated
  renewals never beyond `now + ttlMs`, never shortens).

### 3.4 Wire: `GET /v1/renew` and the status `renewal` member, in protocol v1

- **Decision:**
  - `GET /v1/renew` is a fixed snapshot-style operation: no query, canonical target `/v1/renew` (no
    LF), every existing header and MAC rule unchanged. It requires a bound instance like every
    non-status operation.
  - Its signed body is
    `{ "version": 1, "instanceId": <bound>, "expiresInMs": N, "maxRemainingMs": N }`.
  - When renewal is configured, the status body gains `"renewal": { "maxRemainingMs": N }`. When it
    is not, the member is absent.
  - Both stay in protocol v1; `MAC_DOMAIN` is unchanged.
- **Why:** the protocol is GET-only with a zero-body policy and the request MAC fixes the method, so
  a GET with no new field is the change that keeps every existing gate valid. The renewal is a state
  change behind a GET, which is safe here only because every request is signed, sequence-gated,
  `Cache-Control: no-store`, and refused from any browser origin. The status member is how a client
  learns support without probing an unknown route (the ROADMAP rule against inferring support from a
  generic error). Adding a status key is legal only because no client has been published (§1,
  publication gate); after first publication it would break every client in the field. That makes
  this milestone a HARD GATE on the first publication of `packages/diagnostics-plugin` (§8).
- **Test home:** `test/unit/protocol.test.ts`, `test/unit/connector-handler.test.ts`, fixture
  vectors in `test/fixtures/protocol-v1.json`.

### 3.5 The renewal happens inside the existing synchronous gate

- **Decision:** the `renew` branch runs after `admitAfterVerify`, the session budget and the
  bound-instance check, and calls `session.renew(clock)` with no `await` between that check and the
  mutation. The response is then built and passes the existing post-await gates. A renewal that is
  applied but whose response is lost leaves the session renewed; the client recovers the real
  remaining time with `session()`.
- **Why:** the M98b gate's guarantee — a replayed or racing copy cannot also pass — extends to
  renewal for free. An expired or revoked session fails `admitAfterVerify` before the renewal branch
  is reached, so expiry stays terminal.
- **Test home:** `test/unit/connector-handler.test.ts` (two copies of one signed renew → exactly one
  success; renew after expiry → `expired` and the expiry did not move);
  `test/integration/lifecycle.test.ts` (revoke during a renew releases nothing).

### 3.6 Client surface

- **Decision:**
  - `session(): Promise<DiagnosticsSessionLifetime>` performs a signed status exchange (pairing
    first if needed) and returns a frozen `{ expiresInMs, renewal: { maxRemainingMs } | null }`.
  - `renew(): Promise<DiagnosticsSessionLifetime>` throws `DiagnosticsSessionError` with
    `reason: 'not-renewable'` WITHOUT sending a request when the paired status had no `renewal`.
    Otherwise it performs `GET /v1/renew` and validates the exact body (instance equal to the paired
    one, both numbers finite, non-negative and `expiresInMs ≤ maxRemainingMs`).
  - Every operation reads the body of a 401 response under the existing bound. Only the exact bytes
    `{"version":1,"error":"expired"}` become `DiagnosticsSessionError` with `reason: 'expired'`;
    every other non-200 stays the fixed `connection` error.
  - The initial pairing exchange is unchanged: any failure there, expiry included, is still the
    terminal `pairingFailed`.
- **Why:** a consumer must tell expiry apart from everything else to decide between relaunching and
  reporting a fault; nothing else is actionable, so nothing else is classified. The `expired` body
  is UNSIGNED, so the classification is a hint, not proof. The worst a forger can do with it is make
  the consumer relaunch — and a forger able to answer on the port already has the application's port
  (threat T14). The design security review records this.
- **Test home:** `test/unit/client.test.ts`.

### 3.7 Generated development entry opts in

- **Decision:** `renderDevEntry` emits `maxSessionLifetimeMs: 28_800_000` (8 hours) and keeps the
  default `ttlMs`.
- **Why:** the generated entry exists only for the devtool launcher, which is the consumer that
  needs renewal. Without it every scaffolded project would keep the forced relaunch, and the option
  would have no real caller.
- **Test home:** `packages/cli/test/unit/dev-entry.test.ts` (emitted text) and
  `packages/cli/test/e2e/devtool-e2e.test.ts` (the generated entry type-checks against this
  workspace).

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                                | Kind                                       | Consumer / real code path that READS it                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `DiagnosticsSessionError`                                      | class (new)                                | The devtool session controller (`instanceof` + `reason`) choosing renew, relaunch or fault; `scripts/inspect-local-diagnostics.ts`. |
| `DiagnosticsSessionLifetime`                                   | type (new)                                 | Return type of `session()`/`renew()`; read by the devtool to schedule renewal.                                                      |
| `IDiagnosticsClient.session`                                   | method (new, on an existing exported type) | The devtool after pairing and after a lost renew response; the e2e consumer exercise.                                               |
| `IDiagnosticsClient.renew`                                     | method (new)                               | The devtool before its local deadline; the e2e consumer exercise.                                                                   |
| `DiagnosticsPlugin`, `createDiagnosticsClient`, existing types | unchanged                                  | Existing consumers.                                                                                                                 |

`DiagnosticsSessionErrorReason` is NOT exported separately; it is the type of the `reason` field and
reachable through the class. No `common` export changes.

### 4.1 Options — every option names its consumer

| Option                                          | Consumer                                                                                              | Behavior (per implementation)                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `DiagnosticsPluginOptions.maxSessionLifetimeMs` | `validatePluginOptions` → `DiagnosticsSessionState.create`; the connector's status and renew branches | Absent: no renewal, unchanged status body. Present: cap per §3.1/§3.3; refused out of range. |

## 5. Implementation files

| File                                                             | Purpose                                                                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/diagnostics-plugin/src/index.ts`                       | Export `DiagnosticsSessionError` and `DiagnosticsSessionLifetime`.                                                                         |
| `packages/diagnostics-plugin/src/security/session.ts`            | `activatedAtHr`, `maxExpiresAtHr`, mutable expiry, synchronous `renew(clock)`, `maxRemainingMs(clock)`, `isRenewable`.                     |
| `packages/diagnostics-plugin/src/protocol/protocol.ts`           | `RENEW_TARGET`, `parseTarget` `'renew'` op, `statusBody` optional `renewal`, `parseStatusBody` accepting it, `renewBody`/`parseRenewBody`. |
| `packages/diagnostics-plugin/src/transport/connector-handler.ts` | The `renew` branch; status passes the renewal member.                                                                                      |
| `packages/diagnostics-plugin/src/plugin/diagnostics-plugin.ts`   | Validate `maxSessionLifetimeMs`; pass it to the session.                                                                                   |
| `packages/diagnostics-plugin/src/interfaces/index.ts`            | Option, `session()`, `renew()`, `DiagnosticsSessionLifetime`, JSDoc.                                                                       |
| `packages/diagnostics-plugin/src/client/client.ts`               | `session()`, `renew()`, retained renewal support from pairing, 401 `expired` classification.                                               |
| `packages/diagnostics-plugin/src/client/session-error.ts`        | `DiagnosticsSessionError` (fixed messages, no echoed input).                                                                               |
| `packages/cli/src/devtool/dev-entry.ts`                          | Emit `maxSessionLifetimeMs`.                                                                                                               |
| `scripts/inspect-local-diagnostics.ts`                           | Exercise `session()` and `renew()` in the runnable consumer.                                                                               |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                              | src covered                          | Key assertions                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/session.test.ts` (extend)                   | `session.ts`                         | Fake `SessionClock`: renew before cap, clamped at cap, no-op past cap, never shortens, repeated renewals never beyond `now + ttlMs`; refused after expiry and after revoke (expiry unchanged); not renewable without a cap.                                                                         |
| `test/unit/protocol.test.ts` (extend)                  | `protocol.ts`                        | `/v1/renew` parses; `/v1/renew?x`, `/v1/renew/`, `/v1/Renew` refused; status body without the option is byte-identical to the pre-M98o body; with it carries exactly one more key; parsers refuse every extra key, negative, non-finite and `expiresInMs > maxRemainingMs`.                         |
| `test/unit/connector-handler.test.ts` (extend)         | `connector-handler.ts`               | Renew without a bound instance → `invalid-request`; renew disabled → `invalid-request` after verification; two copies of one signed renew → one 200; renew after expiry → `expired`; signed response MAC verifies over `/v1/renew`.                                                                 |
| `test/unit/plugin.test.ts` (extend)                    | `diagnostics-plugin.ts`              | `maxSessionLifetimeMs` below `ttlMs`, above 43,200,000, fractional and `NaN` each throw a message containing no value; absent accepted.                                                                                                                                                             |
| `test/unit/client.test.ts` (extend)                    | `client.ts`, `session-error.ts`      | `session()` pairs then returns the lifetime; `renew()` without support throws `not-renewable` and sends no request; exact `expired` body → `DiagnosticsSessionError('expired')`; a near-miss body (extra key, other code, signed 401) → `connection`; initial pairing expiry stays `pairingFailed`. |
| `test/unit/barrel-exports.test.ts` (new)               | `index.ts`                           | The two new exports are present from the barrel (runtime and compile-time); no internal symbol leaks.                                                                                                                                                                                               |
| `test/integration/security.test.ts` (extend)           | handler + session over a real socket | Raw `Deno.connect`: renew with wrong key, replayed sequence, wrong instance, after revoke and after expiry are refused with the existing uniform codes; a valid renew is served (positive control).                                                                                                 |
| `test/integration/lifecycle.test.ts` (extend)          | plugin + handler                     | Revoke landing during a renew's read and during signing releases no body; the listener closes as before.                                                                                                                                                                                            |
| `test/e2e/local-connector.test.ts` (extend)            | whole package                        | Real app, `ttlMs: 300`, `maxSessionLifetimeMs: 1_500`: pair, renew, `snapshot()` succeeds after the original 300 ms, renewals stop extending at the cap, then `snapshot()` throws `DiagnosticsSessionError('expired')`.                                                                             |
| `test/fixtures/protocol-v1.json` (extend)              | —                                    | Renew request/response vectors computed with plain Web Crypto outside the production helpers, like the existing vectors.                                                                                                                                                                            |
| `packages/cli/test/unit/dev-entry.test.ts` (extend)    | `dev-entry.ts`                       | Emitted entry contains the option with the decided value.                                                                                                                                                                                                                                           |
| `packages/cli/test/e2e/devtool-e2e.test.ts` (existing) | `dev-entry.ts`                       | The generated entry still type-checks and boots against this workspace with the new option.                                                                                                                                                                                                         |

Real-time e2e uses small values on purpose; the arithmetic is proven on the fake clock, and the e2e
proves the real clock and wiring agree.

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

- **The status-shape publication gate.** If `packages/diagnostics-plugin` is published (0.8.0)
  before this lands, adding `renewal` breaks every published client → this milestone must merge
  before that release, or renewal must wait for protocol v2. The release that first publishes the
  package checks this ROADMAP row.
- **A leaked key is useful for longer.** The window grows from at most `ttlMs` to at most
  `maxSessionLifetimeMs` → renewal still needs the key, the cap is chosen by the application,
  revocation on stop is unchanged, and the hard ceiling is fixed in code (§10.1).
- **A forged `expired` refusal.** It is unsigned → the classification is documented as a hint that
  can only cause a relaunch (§3.6).
- **A renewal mutation behind a GET.** A cache or intermediary replaying it → `no-store`, signed and
  sequence-gated requests, and refusal of forwarding headers already rule this out; the integration
  suite replays a captured renew over a raw socket.
- **Coverage of the new branch hides behind the e2e.** → every renew outcome has a unit test on the
  fake clock.

## 9. Out of scope

- The devtool's renewal scheduler, UI countdown and design-document updates — devtool D03b.
- Re-keying or session-ID rotation (rejected, §3.2).
- Persisting a session across an application restart — unowned.
- A protocol v2 — not needed while the package is unpublished; owned by whichever letter first needs
  a v1-incompatible change.
- Non-Deno diagnostics listeners — unowned (ROADMAP M98 out-of-scope list).

## 10. Required security reviews and acceptance evidence

### 10.1 Design security review — DRAFT, not yet reviewed

**Drafted 2026-10-02 by Claude** against base commit `2b72167e`, from the committed M98b design
(`docs/diagnostics-protocol.md`, `docs/diagnostics-security-review.md`) and the decisions above. It
is NOT recorded as complete: an independent agent that did not write it must review it, and its
findings must be resolved here, before implementation starts.

**Reviewed flow:** native client → signed `GET /v1/renew` with the bound instance → every existing
M98b control (Host, Origin, framing, target, session-ID lane, `subtle.verify`) → the synchronous
post-verify gate (revoked, expired, sequence) → session budget → bound-instance check →
`session.renew(clock)` with no await → exact renew body → 256 KiB bound → post-await gates → sign →
client verifies the MAC over exact bytes → instance binding → exact body validation → frozen
lifetime to the caller.

**Assets:** the session key (its useful lifetime is what this milestone changes), the session's
expiry, and the paired application's availability.

**Attackers:** A1–A5 as defined in `docs/diagnostics-security-review.md`. Renewal changes nothing
for A2 (browser) and A5 (provider). A1 (local process without the key) cannot renew, because renewal
needs a verified MAC. A3 (misconfiguration) is the opt-in risk below. A4 (key holder) is the one
whose reach grows.

| #   | Threat                                                        | Resolution                                                                                                                                                             |
| --- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RN1 | A1 extends a session it cannot read.                          | `/v1/renew` passes the same MAC verification as every operation; no renewal path exists before `subtle.verify`.                                                        |
| RN2 | A key holder keeps a session alive indefinitely.              | Absolute `maxExpiresAtHr` fixed at activation; hard code ceiling of 12 hours; `revoke()` on stopping and close is unchanged.                                           |
| RN3 | A replayed or raced renew extends twice or revives a session. | The renewal sits behind the existing sequence gate in one synchronous step; renewal cannot be banked (§3.3).                                                           |
| RN4 | A renew revives an expired or revoked session.                | `admitAfterVerify` refuses first; the renew branch is unreachable for an expired or revoked session.                                                                   |
| RN5 | Wall-clock manipulation extends a session.                    | All arithmetic on the monotonic `SessionClock`.                                                                                                                        |
| RN6 | An application gets renewable sessions it never asked for.    | Opt-in only (§3.1); without the option the status body and behavior are unchanged.                                                                                     |
| RN7 | A forged unsigned `expired` makes the client misreport.       | Only exact bytes are classified; documented as a hint; worst outcome is a relaunch; a port squatter is already T14.                                                    |
| RN8 | Renewal state is learned without the key.                     | The `renewal` member and the renew body are only in signed responses; a disabled renew is refused after verification, so an unauthenticated prober learns nothing new. |
| RN9 | The new canonical target breaks MAC injectivity (T7).         | `/v1/renew` contains no LF; the canonicalization audit obligation covers it.                                                                                           |

**Approved budgets (proposed):** `maxSessionLifetimeMs` from `ttlMs` to 43,200,000 (12 hours); no
renewal count limit (the cap bounds it); renew requests debit the existing session budget.

**Maintainer approvals required before implementation:**

1. The hard ceiling of 12 hours for `maxSessionLifetimeMs`.
2. The CLI's generated value of 8 hours.
3. Shipping renewal as a protocol v1 extension, which ties this milestone to the first publication
   of `packages/diagnostics-plugin` (§8).

### 10.2 Committed-tree audit obligations — not yet executed

Driven at the real surface (RuntimePlugin listener on a real loopback socket, the real connector,
the real client), with a positive control beside each negative case; wire cases use raw
`Deno.connect`, never `fetch`.

1. RN1/RN3/RN4: wrong key, replay, race of two copies, after revoke, after expiry, wrong instance
   and before pairing are each refused with the existing uniform codes; one valid renew is served.
2. RN2: renewals stop at the cap; nothing configurable exceeds the 12-hour ceiling.
3. RN6: without the option the status body bytes equal the pre-M98o bytes, and `/v1/renew` is
   refused.
4. RN7: the client classifies only the exact `expired` bytes; near-misses stay `connection`.
5. RN8/RN9: the canonicalization obligation from the M98b review covers `/v1/renew`; every signed
   field of the renew exchange is mutated one at a time and refused.
6. Revocation in flight: a revoke during a renew releases no data and leaves no renewed expiry
   usable.

### 10.3 Completion gate and evidence record

The implementation PR records the audited commit, the reviewer (independent of the implementer),
each obligation's result, every finding and its disposition. The ROADMAP M98o row flips to ✅ only
with that record.
