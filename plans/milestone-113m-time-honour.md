# Milestone 113m — Time the framework does not honour (`@setu-ts/scheduler-plugin`, `@setu-ts/auth-plugin`)

> **Status:** Planning. Branch: `feat/m113m-time-honour`. `develop` and `main` are protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR into
> `develop`.

## 0. Objective & scope

Two rows from the `v0.9.0` smoke run (X43) where the framework does not honour a time it was given.
**V9-63 (High):** the scheduler hands a delay over 2³¹−1 ms (~24.8 days) to `setTimeout` unchanged.
Node, Deno and Bun all clamp such a delay to about 1 ms, and nothing checks that the job is due when
the timer fires. So `delay(30 days)` fires 2 ms after registration. A `0 0 29 2 *` leap-day cron
fires at once and then every 30 s (each early fire contends for the same slot lock until its 30 s
TTL expires). And every monthly cron double-fires after its first run. **V9-70:** a first-party JWT
is accepted for up to a second after `exp`, because the check compares against a floored `now` with
`<`. RFC 7519 §4.1.4 forbids accepting a token on or after `exp`.

- **In scope:** chunked timers plus a due check for every scheduler timer (job fires and retry
  backoff); startup refusal of non-finite or out-of-range time values the scheduler already accepts
  silently (`every` with `0` or `NaN` loops hot today); the first-party JWT `exp`/`nbf` boundary;
  the outside-issuer verifier's `exp` boundary; the scheduler test fixture's timer, which hides
  V9-63.
- **NOT this milestone:**
  - Other packages' caller-supplied timer delays (`resilience-plugin` timeout and retry, queue
    observation timeouts, outbox health). Each takes a configured or computed delay that could in
    principle exceed 2³¹−1 ms, but none was found firing early in the smoke run. Recorded in §9;
    unowned.
  - A runtime-level clamp-safe `setTimeout` in `IRuntimeServices` (§9).
  - Session expiry and other non-JWT clocks.

## 1. Contracts verified from SOURCE (not names)

| Reference                  | Source (file:line)                                                    | Verified surface / fact                                                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scheduler arming           | `packages/scheduler-plugin/src/services/scheduler-service.ts:448-458` | `#armTimer` computes `Math.max(0, entry.nextRunAtMs - now)` and passes it straight to `runtime.setTimeout`; the callback calls `#fire(entry)` unconditionally                                                    |
| Re-arm after a fire        | `scheduler-service.ts:777-785`                                        | cron recomputes `cronNextMs(expression, now)`, `every` the next grid boundary, then `#armTimer` again                                                                                                            |
| Fire-time slot key         | `scheduler-service.ts:701`                                            | `scheduler:job:<name>:<nextRunAtMs>`: an early fire leaves `nextRunAtMs` unchanged, so repeated early fires contend for one key until its TTL (`ttlMs`, default 30000) expires — the "every 30 s" of the finding |
| `delay()`                  | `scheduler-service.ts:318-360`                                        | `nextRunAtMs = now + delayMs`; `delayMs` unvalidated                                                                                                                                                             |
| `every()`                  | `scheduler-service.ts:283-312`, `:472-476`                            | `#gridAlignedNextRun` = `(floor(now / interval) + 1) * interval`; `intervalMs` unvalidated, so `0` gives `NaN`                                                                                                   |
| Pause/resume               | `scheduler-service.ts:366-420`                                        | pause clears `entry.timerHandle`; resume re-arms and bumps `generation`                                                                                                                                          |
| Retry backoff wait         | `packages/scheduler-plugin/src/jobs/job-executor.ts:240-247`          | `runtime.setTimeout(resolve, backoffMs)`; `backoffMs` from `computeBackoffMs`                                                                                                                                    |
| Backoff value              | `packages/scheduler-plugin/src/retry/retry-handler.ts:30-38`          | exponential = `retry.delay * 2 ** (attempt - 1)`, unbounded                                                                                                                                                      |
| `RetryOptions`             | `packages/common/src/services/scheduler.ts:50-57`                     | `limit`, `delay`, `backoff`; no validation anywhere                                                                                                                                                              |
| Existing range refusal     | `scheduler-service.ts:17`, `:113`                                     | `deadlineRangeError('acquireTimeoutMs', …)` from `common` — the precedent for a named startup refusal                                                                                                            |
| Fake runtime timer         | `packages/scheduler-plugin/test/fixtures/fake-runtime.ts:146-150`     | records `delay: ms` verbatim, so a delay the platform would clamp to ~1 ms waits its full length in tests                                                                                                        |
| First-party JWT time check | `packages/auth-plugin/src/services/jwt-service.ts:204-211`            | `now = floor(runtime.now() / 1000)`; `exp < now` → expired; `nbf > now` → not yet valid                                                                                                                          |
| Issuer verifier time check | `packages/auth-plugin/src/issuers/jwt-verifier.ts:174-190`            | `now = runtime.now() / 1000` (unfloored); `now > exp + skew` → expired; `now + skew < nbf` → not yet valid                                                                                                       |
| Platform clamp             | Node, Deno and Bun timers; X43 `x43/probes/overflow.ts`               | a delay above 2147483647 ms fires after ~1 ms (Node prints `TimeoutOverflowWarning`); measured in the smoke run on all three                                                                                     |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                | Resolution (picked side)                                   | Doc deliverable (same PR)                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------- |
| C1  | The scheduler README documents `delay`, `every` and `cron` with no upper limit, and the code silently fires an over-limit delay at once | The documented behaviour is right; the code changes (§3.1) | README states that any delay is honoured, and the startup refusals of §3.3 |
| C2  | The auth README/JSDoc say an expired token is refused, but the first-party check accepts it for a further second                        | RFC 7519: refused at and after `exp` (§3.4)                | README and `PUBLIC_API.md` state the boundary for both verifiers           |

## 3. Design decisions

### 3.1 V9-63 — every scheduler timer is armed in bounded chunks and fires only when due

- **Decision:** one internal module, `packages/scheduler-plugin/src/timers/bounded-timer.ts`,
  exporting `armAt(runtime, dueAtMs, onDue, onArm)` and `sleepUntil(runtime, dueAtMs)`.
  - **`armAt`** arms `runtime.setTimeout` for `min(max(0, dueAtMs - runtime.now()), 2147483647)`.
    When that timer fires it re-reads `runtime.now()`:
    - before `dueAtMs`, it arms again for the remainder, without calling `onDue`;
    - otherwise it calls `onDue`.

    `onArm(handle)` receives every handle it arms, so the caller can always cancel the live one.

  - **`sleepUntil`** is the promise form, built on `armAt`.

  `#armTimer` uses `armAt`, with `onArm` writing `entry.timerHandle`, so pause still clears the
  current handle. The retry backoff in `job-executor.ts` uses
  `sleepUntil(runtime, now + backoffMs)`.

- **Why:** chunking alone fixes the overflow. The due check also covers a wall clock stepped
  backwards (NTP) and any other early wake, so a job never fires before its time. One module serves
  both the fire path and the backoff path, so the two cannot disagree.
- **Test home:** `test/unit/bounded-timer.test.ts`, `test/unit/scheduler-long-delays.test.ts` (the
  three V9-63 shapes against the fixture of §3.2), and `test/integration/long-delay-real.test.ts`
  (real Node runtime: `delay(30 days)` has not fired after 200 ms).

### 3.2 The test fixture's timer clamps like the platform

- **Decision:** `FakeRuntime.setTimeout` and `setInterval` record a delay above 2147483647, or a
  `NaN`, as `1`, which is the platform behaviour. A test that schedules a long delay therefore
  reproduces V9-63 when the fix is reverted.
- **Second fixture change (review finding):** `advance(ms)` fires a timer when its recorded delay is
  `<= ms` of that one call. It tracks no absolute deadline, and a timer armed inside a callback
  during an `advance` never fires in the same call — so a chunked 30-day wait cannot be driven at
  all. `advance` keeps its semantics, because 135 existing calls rely on them. The fixture gains
  `advanceTo(epochMs)` instead: every timer records `dueAt = now + clampedDelay` when armed, and
  `advanceTo` fires due timers in `dueAt` order, setting the clock to each one's `dueAt` first and
  including timers armed while it runs, until none is due at or before the target. It also gains
  `setTime(epochMs)` for the stepped-back clock case. Only the new tests use them.
- **Why:** the fixture let V9-63 ship green. This is the contract-violating-double rule.
- **Test home:** every scheduler test that uses the fixture; the negative control in §6.

### 3.3 Out-of-range time values are refused when registered

- **Decision:** the methods reject with a `RangeError` built by `deadlineRangeError`-style wording:
  - `delay` for a `delayMs` that is not a finite number ≥ 0;
  - `every` for an `intervalMs` that is not a finite number > 0;
  - `cron`, `every` and `delay` for a `retry.delay` that is not a finite number ≥ 0.

  The message names the job and the option. The methods are `async`, so the refusal is a rejection,
  never a synchronous throw. **No upper bound** is imposed on `delayMs`, `intervalMs` or
  `retry.delay`: values above 2147483647 are exactly what §3.1 makes work, so `deadlineRangeError`
  itself (which caps at that value) is not reused — only its wording.

- **Why:** `every(name, 0, …)` computes `NaN`, which `setTimeout` treats as 0, so the job loops hot.
  A `NaN` delay or retry delay does the same. This is the M90a fail-open class.
- **Breaking:** these calls used to be accepted.
- **Test home:** `test/unit/scheduler-time-validation.test.ts`.

### 3.4 V9-70 — JWT `exp` and `nbf` boundaries

- **First-party (`jwt-service.ts`):** `now` is `runtime.now() / 1000`, unfloored. A token is expired
  when `exp <= now`, and not yet valid when `now < nbf`. RFC 7519 §4.1.4 rejects "on or after"
  `exp`, and §4.1.5 rejects "before" `nbf`. No tolerance is added: the issuer and the verifier share
  the application's clock.
- **Issuer verifier (`jwt-verifier.ts`):** expired when `now >= exp + skew` (was `>`). `nbf` is
  already correct.
- **Breaking:** a first-party token stops being accepted up to one second earlier.
- **Test home:** `packages/auth-plugin/test/unit/jwt-time-boundary.test.ts`, driving both verifiers
  at `exp - 1 ms`, at `exp` and at `exp + 1 ms` (with `skew`), and `nbf` likewise.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. The breaking changes are behavioural (§3.3, §3.4) and ship in
minor `0.10.0`.

| Exported symbol | Kind | Consumer / real code path that READS it                                                                          |
| --------------- | ---- | ---------------------------------------------------------------------------------------------------------------- |
| None added      | —    | `bounded-timer.ts` is internal, not exported from `src/index.ts` (pinned by the scheduler `barrel-exports` test) |

### 4.1 Options — every option names its consumer

None (checked): no option is added. §3.3 validates existing parameters only.

## 5. Implementation files

| File                                                          | Purpose                                    |
| ------------------------------------------------------------- | ------------------------------------------ |
| `packages/scheduler-plugin/src/timers/bounded-timer.ts`       | `armAt`, `sleepUntil` (internal)           |
| `packages/scheduler-plugin/src/services/scheduler-service.ts` | `#armTimer` through `armAt`; §3.3 refusals |
| `packages/scheduler-plugin/src/jobs/job-executor.ts`          | retry backoff through `sleepUntil`         |
| `packages/scheduler-plugin/test/fixtures/fake-runtime.ts`     | platform clamp (§3.2)                      |
| `packages/auth-plugin/src/services/jwt-service.ts`            | §3.4 first-party boundary                  |
| `packages/auth-plugin/src/issuers/jwt-verifier.ts`            | §3.4 issuer boundary                       |

Documentation deliverables (same PR): the scheduler README (C1, §3.3), the auth README (C2),
`PUBLIC_API.md` (both boundaries, the refusals), `CHANGELOG.md` `Unreleased` (Fixed: V9-63, V9-70;
Changed, breaking: §3.3, §3.4), `docs/upgrading.md` `Unreleased`, the ROADMAP M113m section and row,
and the CLAUDE.md status entry.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                      | src covered                               | Key assertions                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scheduler-plugin/test/unit/bounded-timer.test.ts`             | `bounded-timer.ts`                        | a due time 30 days out arms ≤ 2147483647 ms chunks and calls `onDue` exactly once, at the due time; an early wake re-arms and does not fire; a wall clock stepped backwards re-arms; `onArm` sees every handle; `sleepUntil` resolves at the due time; a past due time fires on the next tick                                       |
| `scheduler-plugin/test/unit/scheduler-long-delays.test.ts`     | `scheduler-service.ts`, `job-executor.ts` | `delay(30 days)` does not fire before 30 days and fires once at it; a monthly cron (`0 0 1 * *`) fires once per month across three simulated months; the leap-day cron fires once at the next 29 February and not before; pause during a chunked wait cancels it; an exponential retry backoff over the limit waits its full length |
| `scheduler-plugin/test/unit/scheduler-time-validation.test.ts` | `scheduler-service.ts`                    | each §3.3 refusal rejects (never throws) naming job and option; boundary values accepted (`delayMs: 0`, `retry.delay: 0`)                                                                                                                                                                                                           |
| `scheduler-plugin/test/integration/long-delay-real.test.ts`    | real Node runtime                         | `delay(30 days)` through `SchedulerService` over `createNodeRuntimeServices()` has not fired after 200 ms                                                                                                                                                                                                                           |
| `auth-plugin/test/unit/jwt-time-boundary.test.ts`              | `jwt-service.ts`, `jwt-verifier.ts`       | the §3.4 boundaries, on both verifiers                                                                                                                                                                                                                                                                                              |

Existing tests asserting the old behaviour are updated, never deleted.

**Negative controls** (each observed failing, then reverted):

1. `#armTimer` without `armAt` → the long-delay tests fail (via the §3.2 clamp).
2. `armAt` without the due check → the early-wake case fails.
3. The fixture without the clamp, together with control 1 → the long-delay tests pass vacuously.
   This shows the clamp is what makes them discriminate.
4. `exp <= now` back to `exp < floor(now)` → the at-`exp` case fails.
5. Issuer `>=` back to `>` → its boundary case fails.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m113m-time-honour
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run check:docs
pnpm test:coverage          # full; ANSI-stripped per-file table, every changed src file ≥90%
pnpm run test:deno-lane
pnpm run release:publish --dry-run
pnpm run release:verify 0.9.0
```

## 8. Risks & mitigations

- **A re-arm loop that never fires** if `runtime.now()` stalls → a re-arm (the not-yet-due branch)
  arms `max(1, …)`, so it never spins at 0 ms; only the first arm of a past due time uses 0. The
  integration test runs on a real clock.
- **Pause racing a chunk boundary** → `onArm` writes `entry.timerHandle` before the timer can fire,
  so the handle pause clears is always the live one; a unit case pauses mid-wait.
- **Existing tests relied on the fixture's unclamped long delays** → the plan expects to update
  them; a test that only passed because the fixture ignored the clamp was asserting V9-63.

## 9. Out of scope

- **Other packages' long timers:** `resilience-plugin`'s `timeout`/`retry` waits, the queue
  observation collector's `timeoutMs`, outbox health and RabbitMQ reconnect delays take a delay that
  could exceed 2³¹−1 ms if configured so. None was observed firing early. Unowned.
- **A clamp-safe `IRuntimeServices.setTimeout`:** would fix every caller at once, but changes all
  four runtime adapters and the timer-handle contract. Recorded; unowned.
- **Workers cron:** `WorkersCron` uses platform Cron Triggers, not timers; unaffected.

## 10. Design security review

### 10.1 Trust boundaries and reviewed flows

| Flow | Path                                                                               | Boundary crossed                            |
| ---- | ---------------------------------------------------------------------------------- | ------------------------------------------- |
| F1   | client `Authorization: Bearer` → `JwtStrategy` → `JwtService.verify` (`exp`/`nbf`) | client credential → authenticated principal |
| F2   | outside issuer's token → `IssuerVerifier` (`exp + skew`)                           | federated credential → principal            |
| F3   | application code → `SchedulerService.delay/every/cron` → timer                     | none (application-owned); availability only |

### 10.2 Assets and attackers

**Assets:** the validity window of a credential. **A1:** a holder of an expired or stolen token,
replaying it at the expiry boundary.

### 10.3 Threats, mitigations and residuals

| Threat                                                                              | Mitigation                                               | Residual                                                                                   |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| A1 uses a token in the second after `exp`                                           | §3.4 rejects at `exp`                                    | the issuer verifier still honours `clockToleranceSec` by design (default 30 s, configured) |
| A scheduled security job (a key rotation, a revocation sweep) fires early, or loops | §3.1 never fires early; §3.3 refuses the hot-loop values | none                                                                                       |

### 10.4 Obligations for the committed-tree audit

Confirm on the merge commit:

- both verifiers reject a token presented exactly at `exp` and accept one a millisecond before;
- no scheduler timer path calls `runtime.setTimeout` with a delay above 2147483647 (grep, and the
  fixture's clamp);
- every §3.3 refusal rejects rather than throws.
