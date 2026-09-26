# Milestone 100d — Multi-Factor Authentication with TOTP (`@setu-ts/auth-plugin`)

> **Status:** Planning on `docs/m100-auth-federation-mfa`. Implementation and fixes belong on
> `feat/m100d-totp-mfa`; `main` remains protected. Depends on 100a and 100c.

## 0. Objective & scope

Add a second factor: six-digit codes from an authenticator app (RFC 6238 TOTP), with recovery codes,
and a sign-in that stays incomplete until the second factor is given. A password alone must not
produce a signed-in session for a user who has enrolled.

- **In scope:** widening `IAuthSessionService` (100c) with a pending state and
  `completeSecondFactor`; a `signIn.mfa` option deciding when a second factor is required; an
  application-instantiated `TotpService` for enrolment, verification and recovery codes over an
  `ITotpStore` port with a memory default; replay protection and per-account lockout; a
  `requireMfa()` guard; a `second-factor-required` authorization failure.
- **NOT this milestone:** passkeys as a second factor (100e reuses `completeSecondFactor`); SMS or
  email codes (weak, and they need a delivery channel — `notification-plugin` could back a later
  addition); QR-code rendering (the application renders the `otpauth://` URI); re-authentication
  ("step up again after N minutes"); administrator reset flows.

## 1. Contracts verified from SOURCE (not names)

| Reference                          | Source (file:line)                                                 | Verified surface / fact                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `IAuthSessionService`              | `plans/milestone-100c-oidc-sign-in.md` §3.1                        | `signIn`/`current`/`signOut`; `SignInOutcome` has exactly one arm, reserved for widening here.                                            |
| `AuthorizationFailure`             | `packages/common/src/errors/authorization-responder.ts:38-60`      | `'authentication-required'` (401), `'not-configured'` (501), `'insufficient-privileges'` (403, no role or permission named).              |
| Guard helpers                      | `packages/auth-plugin/src/guards/index.ts:1-40`                    | Guards brand themselves with `withSecurityMetadata` and answer through `respondWithAuthorizationFailure` without calling `next()`.        |
| Store-port precedent               | `packages/auth-plugin/src/stores/refresh-token-store.ts:54-71`     | Async port with an atomic `rotate`; memory default exported beside it.                                                                    |
| App-instantiated service precedent | `packages/auth-plugin/src/services/refresh-token-service.ts:18-36` | `RefreshTokenService` takes `{ jwt, store, runtime }`; applications construct it.                                                         |
| HMAC-SHA1 (probe)                  | Deno 2.9.6, Node 24.18, Bun 1.4.2, workerd                         | `importKey('raw', …, { name: 'HMAC', hash: 'SHA-1' })` + `sign` reproduces the RFC 6238 Appendix B vector `94287082` at T=59 on all four. |
| `IRuntimeServices`                 | `packages/common/src/runtime.ts:335-351`                           | `randomBytes`, `subtle`, `now()` (wall clock — TOTP is defined on Unix time, so wall clock is the correct clock here).                    |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                             | Resolution (picked side)                                                                                         | Doc deliverable (same PR)                             |
| -- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| C1 | `PUBLIC_API.md` documents three authorization failures and states a 403 names no role or permission. | A fourth failure, `second-factor-required`, also names nothing; it says only what the caller must do.            | `PUBLIC_API.md` responder table; `common` README row. |
| C2 | "Never mix clocks" (CLAUDE.md) directs durations to `hrtime()`.                                      | TOTP counters are Unix-time by definition (RFC 6238 §4), so `now()` is correct here and is stated in the source. | JSDoc on the counter function.                        |

## 3. Design decisions

### 3.1 Widen `IAuthSessionService`

- **Decision:** Add `pending(ctx): PendingSignIn | null` and
  `completeSecondFactor(ctx, method: SecondFactorMethod): Promise<SignInOutcome>`, with
  `SecondFactorMethod = 'otp' | 'hwk' | 'swk'`, and widen `SignInOutcome` to
  `{ status: 'signed-in' } | { status: 'second-factor-required' }`. `signIn` asks
  `signIn.mfa.required(principal, methods)`; when it answers `true` and `methods` holds no second
  factor, it stores `{ principal, methods, at }` under `__setu_auth_pending_mfa` (NOT the signed-in
  key), regenerates the session and resolves `second-factor-required`. `completeSecondFactor` moves
  the pending record to the signed-in key with the method appended, regenerates again, and throws
  when nothing is pending or the record is older than `pendingTtlMs` (default 5 minutes).
- **Why:** Holding the principal back is what makes the password alone insufficient; routes guarded
  only by `requireAuth()` stay closed during the pending state.
- **Breaking:** new required members on a `common` interface (only in-repo implementor: 100c's
  service), and a widened result union — CHANGELOG'd.
- **Test home:** `auth-session-mfa.test.ts`.

### 3.2 `TotpService` — application-instantiated

- **Decision:** `new TotpService({ store, runtime, issuer })` (the `RefreshTokenService` precedent):
  - `beginEnrolment(principalId, label)` → `{ secret, uri }`: a 20-byte secret from
    `runtime.randomBytes`, base32 (RFC 4648, no padding), and
    `otpauth://totp/<issuer>:<label>?secret=…&issuer=…&algorithm=SHA1&digits=6&period=30`, stored
    unconfirmed;
  - `confirmEnrolment(principalId, code)` — the first valid code confirms;
  - `verify(principalId, code)` → `'ok' | 'invalid' | 'locked' | 'not-enrolled'`;
  - `generateRecoveryCodes(principalId)` → ten codes, returned once;
  - `verifyRecoveryCode(principalId, code)` → `'ok' | 'invalid' | 'locked'`;
  - `disable(principalId)`. The application calls `verify` and then
    `completeSecondFactor(ctx, 'otp')`.
- **Why:** The code form is application UI; the service owns every rule that must not vary.
- **Test home:** `totp-service.test.ts`.

### 3.3 Code verification

- **Decision:** HMAC-SHA1 over the 8-byte big-endian counter `floor(now / 30 s)`, dynamic
  truncation, six digits; the current step and one step before and after it are accepted. A code is
  compared in constant time over its six characters. An accepted step is claimed through
  `store.claimStep(principalId, step)`, which succeeds only for a step greater than the last claimed
  one, so the same code — and any earlier code — cannot be replayed.
- **Test home:** `totp-codes.test.ts` (RFC 6238 Appendix B vectors, window edges, replay).

### 3.4 Lockout per account, not per session

- **Decision:** Each invalid code or recovery code calls `store.recordFailure(principalId, now)`,
  which returns the failures inside the last 15 minutes; at 5, `verify` answers `locked` until the
  window passes, without computing a code. Success clears failures.
- **Why:** Six digits are brute-forceable; counting per session is bypassed by opening new sessions.
- **Test home:** `totp-lockout.test.ts`.

### 3.5 Recovery codes

- **Decision:** Ten codes of 16 base32 characters (80 bits each), stored as SHA-256 digests — not
  PBKDF2, because each code is already high-entropy random and a slow hash across ten candidates
  would cost seconds per attempt for no gain. A code is consumed through
  `store.consumeRecoveryCode(principalId, index)`, atomic, so two concurrent uses cannot both
  succeed. A recovery code completes the second factor with method `'otp'`.
- **Test home:** `recovery-codes.test.ts`.

### 3.6 `ITotpStore` port

- **Decision:** `getEnrolment`, `saveEnrolment`, `deleteEnrolment`, `claimStep`, `recordFailure`,
  `clearFailures`, `saveRecoveryCodes`, `consumeRecoveryCode`, all async; `MemoryTotpStore` exported
  as the default for tests and single-process development. The secret is stored as given; the README
  states that a production store should encrypt it at rest.
- **Test home:** `memory-totp-store.test.ts`, including concurrent `claimStep` and
  `consumeRecoveryCode`.

### 3.7 `requireMfa()` guard

- **Decision:** No principal → `authentication-required` (401). A principal whose `claims.amr` holds
  none of `otp`/`hwk`/`swk` → new failure `second-factor-required` (403, detail "Second factor
  required"). Branded authenticated for M57 OpenAPI derivation.
- **Test home:** `require-mfa.test.ts`.

## 4. Exported surface — every symbol names its consumer

| Exported symbol (package)                        | Kind        | Consumer / real code path that READS it                 |
| ------------------------------------------------ | ----------- | ------------------------------------------------------- |
| `PendingSignIn`, `SecondFactorMethod` (`common`) | types       | `IAuthSessionService.pending` / `completeSecondFactor`. |
| `AuthorizationFailure` member (`common`)         | type        | `requireMfa()`; applications mapping failures.          |
| `TotpService` (`auth-plugin`)                    | class       | Applications' enrolment and code forms.                 |
| `ITotpStore`, `MemoryTotpStore` (`auth-plugin`)  | type, class | `TotpService` constructor.                              |
| `TotpVerifyResult` (`auth-plugin`)               | type        | `verify` / `verifyRecoveryCode` results.                |
| `requireMfa` (`auth-plugin`)                     | function    | Route guards.                                           |
| `MfaOptions` (`auth-plugin`)                     | type        | `SignInConfig.mfa`.                                     |

### 4.1 Options — every option names its consumer

| Option                    | Consumer                     | Behavior                                              |
| ------------------------- | ---------------------------- | ----------------------------------------------------- |
| `signIn.mfa.required`     | `IAuthSessionService.signIn` | `(principal, methods) → boolean \| Promise<boolean>`. |
| `signIn.mfa.pendingTtlMs` | `completeSecondFactor`       | Default 300 000.                                      |
| `TotpService` `issuer`    | `beginEnrolment`             | Shown by the authenticator app.                       |

## 5. Implementation files

| File                                                       | Purpose                                     |
| ---------------------------------------------------------- | ------------------------------------------- |
| `packages/common/src/services/auth-session.ts`             | §3.1 widening.                              |
| `packages/common/src/errors/authorization-responder.ts`    | `second-factor-required`.                   |
| `packages/auth-plugin/src/sign-in/auth-session-service.ts` | Pending state, `completeSecondFactor`.      |
| `packages/auth-plugin/src/mfa/totp-service.ts`             | §3.2–3.5.                                   |
| `packages/auth-plugin/src/mfa/totp-codes.ts`               | Counter, truncation, constant-time compare. |
| `packages/auth-plugin/src/mfa/base32.ts`                   | RFC 4648 base32.                            |
| `packages/auth-plugin/src/stores/totp-store.ts`            | Port and `MemoryTotpStore`.                 |
| `packages/auth-plugin/src/guards/index.ts`                 | `requireMfa`.                               |
| `packages/auth-plugin/src/index.ts`, `interfaces/index.ts` | Exports, `MfaOptions`.                      |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                   | src covered               | Key assertions                                                                                                                                                                                                                      |
| ------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/totp-codes.test.ts`              | `totp-codes.ts`           | RFC 6238 Appendix B SHA-1 vectors; ±1 window; outside window refused.                                                                                                                                                               |
| `test/unit/base32.test.ts`                  | `base32.ts`               | RFC 4648 §10 vectors; round trip.                                                                                                                                                                                                   |
| `test/unit/totp-service.test.ts`            | `totp-service.ts`         | Enrolment URI shape; confirmation; `not-enrolled`; replay of the same step refused; earlier step refused.                                                                                                                           |
| `test/unit/totp-lockout.test.ts`            | `totp-service.ts`         | Fifth failure locks; `locked` computes no code; window expiry unlocks; success clears.                                                                                                                                              |
| `test/unit/recovery-codes.test.ts`          | `totp-service.ts`         | Ten codes; single use; digests stored, never plaintext.                                                                                                                                                                             |
| `test/unit/memory-totp-store.test.ts`       | `totp-store.ts`           | Concurrent `claimStep` and `consumeRecoveryCode` yield exactly one success.                                                                                                                                                         |
| `test/integration/auth-session-mfa.test.ts` | `auth-session-service.ts` | Real kernel app: password sign-in with MFA required → `second-factor-required`, `requireAuth` route still 401; after a valid code → signed in with `amr: ['pwd','otp']`; session id changed at both steps; expired pending refused. |
| `test/integration/require-mfa.test.ts`      | `guards/index.ts`         | 401 anonymous; 403 `second-factor-required` without the factor; 200 with it; Problem Details shape asserted field by field.                                                                                                         |
| `common/test/unit/barrel-exports.test.ts`   | `common` barrel           | New types exported.                                                                                                                                                                                                                 |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m100d-totp-mfa
deno task check:plan
deno task fmt:check && deno task lint && deno task check && deno task test
deno task test:coverage     # ANSI-stripped per-file table; ≥90% every changed src file
deno task check:docs
deno task publish:check && deno task release:verify <version>
```

## 8. Risks & mitigations

- Clock drift on the server → the ±1 step window absorbs 30 s of drift in each direction; larger
  drift is an operational fault the README names.
- An application forgets `requireMfa()` on a sensitive route while MFA is optional for some users →
  the README states that `signIn.mfa.required` governs sign-in, and `requireMfa()` governs a route.

## 9. Out of scope

- Passkeys — 100e.
- SMS and email codes, QR rendering, re-authentication windows, administrator resets.

## 10. Design security review — completed before implementation

**Reviewed flow:** first factor → `signIn` → pending record (no principal) → code form → `verify`
(lockout check, window, constant-time compare, step claim) → `completeSecondFactor` → regenerate →
signed in with `amr`.

| Finding                                       | Resolution in this plan                                |
| --------------------------------------------- | ------------------------------------------------------ |
| Password alone yields a session.              | Pending record is not a principal (§3.1).              |
| Code brute force across sessions.             | Per-account lockout in the store (§3.4).               |
| Code replay within its window.                | Monotonic `claimStep` (§3.3).                          |
| Timing leak on code comparison.               | Constant-time compare (§3.3).                          |
| Recovery code double-spend under concurrency. | Atomic consume by index (§3.5, §3.6).                  |
| Session fixation across the two steps.        | Regenerate at both steps (§3.1).                       |
| A 403 disclosing policy.                      | New failure names only the required action (§3.7, C1). |

The implementation audit submits the same code twice, a code from the previous window after a newer
one was accepted, six wrong codes from six fresh sessions, and a recovery code from two concurrent
requests.
