# Milestone 113e — Identity and Session Semantics (`@setu-ts/auth-plugin`, `@setu-ts/session-plugin`)

> **Status:** Planning. Branch: `feat/m113e-identity-session-semantics`. `develop` and `main` are
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR.

## 0. Objective & scope

Four findings from the `v0.9.0` smoke run, one shape: identity and session behaviour a client cannot
predict from the documentation. A JWT role silently counts as a grant in every tenant (V9-28). Form
CSRF refuses every bearer-authenticated API request in the same app (V9-27). The store strategy
writes a full-lifetime row for every anonymous page that renders a form (V9-46). And the password
hasher's work factor is a sixth of current guidance (V9-50). The four maintainer decisions
(2026-10-17) are recorded in §3. Every choice was the recommended option.

- **In scope:**
  - **V9-28** (`auth-plugin`): a principal's own `roles` and `permissions` stop counting in scoped
    checks. They count again only with the new opt-in `scopedRbac.principalAuthorityIsGlobal: true`.
  - **V9-27** (`session-plugin`): form CSRF skips a request carrying `Authorization: Bearer <token>`
    by default. `csrf.exemptBearer: false` restores today's refusal.
  - **V9-46** (`session-plugin`): on the store strategy, a session whose data holds only
    framework-reserved keys stays sealed in the cookie and writes no store row.
  - **V9-50** (`auth-plugin`): the `PasswordHasher` default becomes 600,000 iterations. It gains a
    constructor `iterations` option and a `needsRehash(stored)` method.
  - The README, `PUBLIC_API.md`, `docs/authorization.md`, CHANGELOG and `docs/upgrading.md` entries
    for all four.
- **NOT this milestone:**
  - A store row written for pending OIDC/SAML sign-in state (`state`/`nonce`/`verifier`). Those keys
    belong to `auth-plugin` and are secrets, so they stay out of the cookie-held set (§3.3, §8).
    Unowned; recorded in §9.
  - Argon2/scrypt: Web Crypto offers neither, and a dependency would break Workers portability.
    Unowned.

## 1. Contracts verified from SOURCE (not names)

| Reference                                | Source (file:line)                                                         | Verified surface / fact                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ScopedEvaluator.#inChain`               | `packages/auth-plugin/src/scoped/scoped-policy.ts:223-237`                 | Appends every `principal.roles` entry as `{ role, scope: null }` — the V9-28 grant source                                                                                                                                                                                                                                        |
| `ScopedEvaluator.#holdsDirectly`         | `packages/auth-plugin/src/scoped/scoped-policy.ts:258-261`, called at :186 | A principal's own `permissions` (or `'*'`) satisfy every scoped PERMISSION check in every scope — the same defect for permissions; the finding's "scoped `invoices:approve` in every tenant" reaches it                                                                                                                          |
| `ScopedRbacOptions`                      | `packages/auth-plugin/src/interfaces/index.ts:836-874`                     | `sources`, `permissions?`, `inheritsFrom?`, `tenantScopeType?`, `grantableIn?`, `customRoles?`, `timing?`, five bounds. No principal-authority member                                                                                                                                                                            |
| `CompiledScopedRbac` / compile           | `packages/auth-plugin/src/scoped/options.ts:63-95`                         | Read-once compiled form; validation refuses through `AuthPluginConfigurationError` (`refuse`, :97)                                                                                                                                                                                                                               |
| Unscoped RBAC (`requireRole`)            | `packages/auth-plugin/src/services/rbac-service.ts:249,286`                | Reads `principal.roles` directly — unaffected by this milestone                                                                                                                                                                                                                                                                  |
| `PasswordHasher`                         | `packages/auth-plugin/src/services/password-hasher.ts:10,45,48-176`        | `PBKDF2_ITERATIONS = 100000`, `MAX_ITERATIONS = 10_000_000`; `constructor(runtime)`; `hash(secret)` writes `pbkdf2$<it>$<salt>$<hash>`; `verify(stored, secret)` reads the stored count, so existing hashes keep verifying under any new default; malformed → `MalformedPasswordHashError`                                       |
| `CsrfFormOptions` / `ResolvedCsrfConfig` | `packages/session-plugin/src/options.ts:59-80, 222-242`                    | `fieldName?`, `headerName?`, `ignoreMethods?`, `exclude?`. `resolveCsrfConfig` returns `{ fieldName, headerName, ignoreMethods }`, and `exclude` is not resolved                                                                                                                                                                 |
| CSRF entry points                        | `packages/session-plugin/src/middleware/csrf-form-middleware.ts:52-103`    | Both `csrfFormMiddleware` (method + `isCsrfExcluded` skip) and `verifyCsrfToken` (`isCsrfExcluded` skip). They call `verifyWithConfig`, which throws when the session holds no token                                                                                                                                             |
| `verifyCsrfToken`                        | `packages/session-plugin/src/csrf/verify.ts:50-56`                         | Same `isCsrfExcluded` check, then `verifyWithConfig`                                                                                                                                                                                                                                                                             |
| `getCsrfToken`                           | `packages/session-plugin/src/csrf/token.ts:59-73`                          | Mints 32 random bytes under `CSRF_SESSION_KEY = '__csrf'` (:31), marking the session dirty                                                                                                                                                                                                                                       |
| Tenant binding key                       | `packages/common/src/services/session.ts:30`                               | `SESSION_TENANT_BINDING_KEY = '__setu_tenant'`. Sealed on commit by `sessionMiddleware` (`session-middleware.ts:91-96`) for any session under a resolved tenant, anonymous ones included                                                                                                                                         |
| `SessionService.commit`                  | `packages/session-plugin/src/services/session-service.ts:172-238`          | On the store strategy, seals `{ id, data: {}, exp, seen }` into the cookie and calls `store.write(id, data, ttlMs)` with the FULL remaining lifetime whenever the session is dirty. This is the V9-46 write                                                                                                                      |
| `SessionService.#restore`                | `packages/session-plugin/src/services/session-service.ts:277-299`          | On the store strategy, ALWAYS reads `store.read(snapshot.id)` and returns `null` on a miss; cookie `data` is ignored                                                                                                                                                                                                             |
| `parseSnapshot`                          | `packages/session-plugin/src/services/session.ts:241-272`                  | Accepts `{ id, exp, seen, data? }` and ignores other keys, so an older build reading a new marker field degrades to "store miss → fresh session"                                                                                                                                                                                 |
| `ISessionStore`                          | `packages/common/src/services/session.ts:235-260`                          | `read`/`write(id, data, ttlMs)`/`destroy`/`isHealthy?`/`close?` — unchanged                                                                                                                                                                                                                                                      |
| CORS preflight for `Authorization`       | Fetch standard (CORS-safelisted request headers)                           | `Authorization` is not a CORS-safelisted request header, so a cross-origin request carrying it needs a preflight the target must approve. A browser never attaches a Bearer token on its own. Basic credentials, by contrast, are re-sent automatically after a `401 WWW-Authenticate: Basic` challenge — so Basic is NOT exempt |
| PBKDF2 cost (measured, 2026-10-17)       | Node 24 Web Crypto, this machine                                           | 100,000 → 15 ms, 310,000 → 41 ms, 600,000 → 79 ms per hash. Local workerd (`wrangler dev`) accepted 600,000. Deployed Workers are reported to refuse counts above 100,000; this is not verifiable here (§8)                                                                                                                      |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                                                                         | Resolution (picked side)                                                    | Doc deliverable (same PR)                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | `docs/authorization.md` "What a scoped check decides" documents only `scope: null` grants as global; the code also makes the principal's own roles and permissions global (`scoped-policy.ts:221` "The principal's own roles are global grants") | Code changes (§3.1); docs gain the new row                                  | `docs/authorization.md` table row; `packages/auth-plugin/README.md` scoped-RBAC section; `PUBLIC_API.md` `ScopedRbacOptions` row; the `#inChain` JSDoc |
| C2  | `packages/session-plugin/README.md:255` says `exclude` is "only for a separately-mounted non-browser protocol surface such as Connect/gRPC", while an app mixing forms and a bearer API had no other remedy (V9-27)                              | Bearer exemption becomes the API answer; `exclude` keeps its narrow purpose | README Form CSRF section: a bearer paragraph and the Basic caveat; Options table row `exemptBearer`; `PUBLIC_API.md` `CsrfFormOptions`                 |
| C3  | `packages/session-plugin/README.md` "Choosing a strategy" implies the store strategy keeps every session server-side, and says nothing about anonymous traffic (V9-46)                                                                           | Code changes (§3.3); README states the cookie-held rule                     | README strategy section and Form CSRF section; `PUBLIC_API.md` session-store note                                                                      |
| C4  | `password-hasher.ts:107` comment cites OWASP 600,000 as "well above" the 10,000,000 cap's purpose while the default is 100,000; the auth README documents no work factor                                                                         | Default moves to 600,000 (§3.4)                                             | Comment update; README `PasswordHasher` section (default, `iterations`, `needsRehash`, Workers note); `PUBLIC_API.md` row                              |

## 3. Design decisions

### 3.1 V9-28 — principal authority stops counting in scoped checks

- **Decision:** `ScopedRbacOptions` gains `principalAuthorityIsGlobal?: boolean`, default `false`.
  When `false`, `#inChain` adds no grant from `principal.roles`, and the permission branch skips
  `#holdsDirectly`. When `true`, both behave exactly as today: roles become `{ role, scope: null }`
  grants, still subject to `grantableIn`, and direct permissions (including `'*'`) satisfy any
  scoped permission. The option is read once into `CompiledScopedRbac.principalAuthorityIsGlobal`. A
  non-boolean value is refused at `AuthPlugin(...)` with `AuthPluginConfigurationError`
  (`scopedRbac.principalAuthorityIsGlobal must be a boolean`).
- **Why:** the maintainer's decision was "off by default (fail closed)". Permissions are included
  because `#holdsDirectly` is the same mechanism. Leaving it on would keep the finding's own example
  (a scoped permission check admitted in every tenant) open through a principal's `permissions`
  claim. One option covers both because they are one property: "authority the principal carries is
  global". Two options would let an app close one door and not the other. The unscoped guards
  (`requireRole`, `requirePermission`) keep reading the principal directly.
- **Breaking:** an app relying on JWT roles in scoped checks is denied until it sets the option or
  issues grants. CHANGELOG plus an upgrade-guide entry.
- **Test home:** `test/unit/scoped/scoped-policy.test.ts`;
  `test/integration/scoped-rbac-principal-authority.test.ts` (a real kernel app; the X72 control);
  `test/unit/scoped/scoped-options.test.ts` (refusal).

### 3.2 V9-27 — form CSRF exempts Bearer requests by default

- **Decision:**
  - `CsrfFormOptions.exemptBearer?: boolean`, default `true`, resolved into
    `ResolvedCsrfConfig.exemptBearer`.
  - One internal predicate, `isBearerRequest(headers)` in `src/csrf/exclude.ts`, answers whether the
    `Authorization` header's scheme is `bearer` (case-insensitive, RFC 9110 §11.1) followed by
    whitespace and a non-empty token.
  - A new internal `isCsrfExempt(ctx, config, exclude)` combines `isCsrfExcluded` with the Bearer
    rule. Both `csrfFormMiddleware` and `verifyCsrfToken` call it, so the two entry points cannot
    disagree.
  - `Basic`, an empty Bearer token, and other schemes stay subject to verification.
- **Why:** a CSRF attack needs a credential the browser attaches by itself. A Bearer token is never
  attached by the browser, and a cross-origin page cannot add `Authorization` without a preflight
  the server approves. A server that approves it for credentialed requests from that origin already
  trusts the origin, and that origin's script could read a form token anyway. Basic is excluded
  because browsers re-send cached Basic credentials automatically.
- **What the exemption cannot do:** let an unauthenticated forged form post through. A form cannot
  set `Authorization`, so it still has to carry a valid token.
- **Breaking:** the change only relaxes a refusal. It is recorded as a behaviour change, with
  `exemptBearer: false` restoring it.
- **Test home:** `test/unit/csrf/bearer-exemption.test.ts`; `test/integration/csrf-bearer.test.ts`
  (a real kernel app with `AuthPlugin` JWT + `SessionPlugin({ csrf: {} })`: JWT `POST` 200, form
  post without a token 403, `Basic` 403, `exemptBearer: false` 403; both entry points under
  `exemptBearer: false`).

### 3.3 V9-46 — reserved-only sessions stay in the cookie on the store strategy

- **Decision:**
  - A session is **cookie-held** when every key of its data is in
    `COOKIE_HELD_KEYS = { CSRF_SESSION_KEY, SESSION_TENANT_BINDING_KEY }`. An empty data set also
    counts.
  - On the store strategy, `commit` seals a cookie-held session as
    `{ id, data, exp, seen, held: 'cookie' }`. It writes no store row, and calls `store.destroy(id)`
    when the restored session was store-held. That demotion makes an old id-only cookie unable to
    restore the previous row.
  - Any other session is store-held and committed exactly as today (cookie `data: {}`, no `held`
    member, row written).
  - `#restore` honours `held: 'cookie'` on the store strategy by restoring the cookie's `data` with
    no store read. A snapshot without the marker reads the store as today.
  - `parseSnapshot` accepts `held` only as the literal `'cookie'`, and any other value refuses the
    snapshot. On the cookie strategy the marker is never written and is ignored on read.
  - `Session` gains an internal `wasStoreHeld` flag, set by `restoreSession` from the snapshot, so
    commit knows whether to demote.
- **Why:** the reserved keys exist to serve anonymous traffic. A row behind them buys nothing,
  because there is nothing to revoke in a session holding only a CSRF token or a tenant id. The
  cookie is sealed under the same key ring, so it cannot be forged. Under `mode: 'encrypt'` it
  cannot be read. Under `mode: 'sign'` the browser holding the HttpOnly cookie can read its own
  token, which the form already shows it.
- **Promotion and replay:** the first non-reserved write promotes the session, which also covers a
  login that does not call `regenerate()`. An attacker's copy of a pre-login cookie-held cookie
  restores only the anonymous data, because that cookie never reads the store. This is strictly
  safer than today's fixation exposure on the store strategy.
- **Test home:** `test/unit/services/cookie-held.test.ts` (commit and restore matrix, the demotion
  destroy, marker parsing); `test/integration/store-anonymous-traffic.test.ts` (a real kernel app
  over a recording store: 200 anonymous `GET /login` writes 0 rows, login writes 1, logout demotes
  and destroys it, and an id-only replay after demotion is a fresh session). A guarded real-Redis
  suite reproduces the finding's count: 200 → 0 keys.

### 3.4 V9-50 — `PasswordHasher` at 600,000 iterations, with a rehash check

- **Decision:**
  - `new PasswordHasher(runtime, options?: PasswordHasherOptions)`, where
    `PasswordHasherOptions = { readonly iterations?: number }`, default `600_000`.
  - `iterations` must be an integer in `[100_000, 10_000_000]`. Anything else, `NaN` included,
    throws a `TypeError` at construction that names the bounds and not the value. The floor keeps
    every configuration at least as strong as the previous default, and the ceiling is the existing
    `MAX_ITERATIONS`.
  - `hash` uses the configured count.
  - `verify` is unchanged: it reads the stored count, so every existing hash keeps verifying.
  - New `needsRehash(stored): boolean` returns `true` when the stored count is below the configured
    count, and `false` at or above it, so a lowered configuration never downgrades a hash. It throws
    `MalformedPasswordHashError` on the same inputs `verify` refuses, through one shared internal
    `parseStoredHash` that both call.
- **Why:** the maintainer chose 600k plus rehash. Without `needsRehash` the new default only reaches
  new passwords. The hasher owns no storage, so the application re-hashes after a successful
  `verify`, and the README shows that sequence.
- **Workers:** documented to pass `iterations: 100_000` (§8).
- **Test home:** `test/unit/password-hasher.test.ts` (extended); a real Web Crypto round-trip at the
  default.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. These are behaviour changes, not contract changes:

- scoped checks ignore principal authority by default;
- form CSRF exempts Bearer by default;
- store-strategy anonymous sessions are cookie-held;
- the hasher's default is 600,000.

All ship in minor 0.10.0 with CHANGELOG and upgrade-guide entries. No `common` export changes and no
`ISessionStore` change.

| Exported symbol                                      | Kind          | Consumer / real code path that READS it                                                                     |
| ---------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| `ScopedRbacOptions.principalAuthorityIsGlobal` (new) | option member | `compileScopedRbac` → `ScopedEvaluator.#inChain` / permission branch                                        |
| `CsrfFormOptions.exemptBearer` (new)                 | option member | `resolveCsrfConfig` → `isCsrfExempt`, called by `csrfFormMiddleware` and `verifyCsrfToken`                  |
| `PasswordHasherOptions` (new)                        | type          | `PasswordHasher` constructor parameter (application code passes it; README example)                         |
| `PasswordHasher.needsRehash` (new)                   | method        | Application sign-in code (README recipe); the integration test drives the full verify → rehash → store loop |
| `PasswordHasher` (changed constructor)               | class         | Existing consumers; a second optional parameter is source-compatible                                        |

### 4.1 Options — every option names its consumer

| Option                                  | Consumer                                          | Behavior (per implementation)                                                          |
| --------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `scopedRbac.principalAuthorityIsGlobal` | `ScopedEvaluator`                                 | `false` (default): principal roles/permissions ignored in scoped checks; `true`: today |
| `csrf.exemptBearer`                     | `isCsrfExempt` (middleware and `verifyCsrfToken`) | `true` (default): `Authorization: Bearer <token>` skips verification; `false`: verify  |
| `PasswordHasherOptions.iterations`      | `PasswordHasher.hash`, `needsRehash`              | Integer 100,000–10,000,000, default 600,000; `verify` ignores it                       |

## 5. Implementation files

| File                                                             | Purpose                                                                                                  |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `packages/auth-plugin/src/index.ts`                              | Barrel: add `PasswordHasherOptions`                                                                      |
| `packages/auth-plugin/src/interfaces/index.ts`                   | `ScopedRbacOptions.principalAuthorityIsGlobal` with JSDoc                                                |
| `packages/auth-plugin/src/scoped/options.ts`                     | Compile and validate the option                                                                          |
| `packages/auth-plugin/src/scoped/scoped-policy.ts`               | Gate `#inChain` principal roles and `#holdsDirectly` on the compiled flag                                |
| `packages/auth-plugin/src/services/password-hasher.ts`           | Options, configured count, `needsRehash`, shared `parseStoredHash`                                       |
| `packages/session-plugin/src/options.ts`                         | `CsrfFormOptions.exemptBearer`, `ResolvedCsrfConfig.exemptBearer`                                        |
| `packages/session-plugin/src/csrf/exclude.ts`                    | `isBearerRequest`, `isCsrfExempt`                                                                        |
| `packages/session-plugin/src/csrf/verify.ts`                     | Call `isCsrfExempt`                                                                                      |
| `packages/session-plugin/src/middleware/csrf-form-middleware.ts` | Call `isCsrfExempt`                                                                                      |
| `packages/session-plugin/src/services/session.ts`                | `held` snapshot member, `wasStoreHeld`, `isCookieHeld()`                                                 |
| `packages/session-plugin/src/services/session-service.ts`        | Cookie-held commit/restore and the demotion destroy                                                      |
| Docs                                                             | §2 deliverables, CHANGELOG `Unreleased`, `docs/upgrading.md` `Unreleased`, ROADMAP row, CLAUDE.md status |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                      | src covered                                 | Key assertions                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auth-plugin/test/unit/scoped/scoped-policy.test.ts` (extended)                | `scoped-policy.ts`                          | Default: a principal with role `admin` and no grants is denied `requireScopedRole('admin')` and a scoped permission; with `permissions: ['*']`, denied too; with the option `true`, both allowed; `grantableIn` still limits the `true` case                       |
| `auth-plugin/test/unit/scoped/scoped-options.test.ts` (extended)               | `scoped/options.ts`                         | Non-boolean refused with the named message; absent compiles to `false`                                                                                                                                                                                             |
| `auth-plugin/test/integration/scoped-rbac-principal-authority.test.ts`         | end to end                                  | X72 control through a real kernel app: scoped `owner` grant in tenant A only (the catalogue's admin-equivalent role), a JWT carrying global `owner` → A 200, B 403 by default; B 200 with the option; `requireRole('owner')` 200 in both (unscoped path unchanged) |
| `auth-plugin/test/unit/password-hasher.test.ts` (extended)                     | `password-hasher.ts`                        | Default writes `pbkdf2$600000$…`; `iterations: 100_000` writes 100000; out-of-range/NaN/fraction refused naming bounds; a 100k hash verifies under a 600k hasher; `needsRehash` true below, false equal and above; malformed throws like verify                    |
| `session-plugin/test/unit/csrf/bearer-exemption.test.ts`                       | `csrf/exclude.ts`, `options.ts`             | `isBearerRequest` table: `Bearer x`, `bearer x`, `BEARER\tx` exempt; `Bearer`, `Bearer `, `Basic x`, `Bearerx`, absent not; `resolveCsrfConfig` default `true`                                                                                                     |
| `session-plugin/test/integration/csrf-bearer.test.ts`                          | `csrf-form-middleware.ts`, `csrf/verify.ts` | Real app: JWT `POST /api` 200 with no token; form `POST` without token 403; `Basic` 403; `exemptBearer: false` 403 through BOTH the middleware and `verifyCsrfToken`; the handler does not run on a refusal (short-circuit)                                        |
| `session-plugin/test/unit/services/cookie-held.test.ts`                        | `session.ts`, `session-service.ts`          | Store strategy: CSRF-only commit writes 0 rows and a `held: 'cookie'` cookie; restore reads no store; a non-reserved write writes 1 row, id-only cookie; demotion destroys the row; `parseSnapshot` refuses `held: 'x'`; cookie strategy unchanged                 |
| `session-plugin/test/integration/store-anonymous-traffic.test.ts`              | end to end                                  | Real app over a recording store: 200 anonymous `GET /login` → 0 writes; the form's token then verifies on `POST`; login → 1 row; logout → row destroyed; replay of the id-only login cookie after logout → fresh session (no data)                                 |
| `session-plugin/test/integration/store-anonymous-redis-real.test.ts` (guarded) | end to end                                  | `REDIS_URL`: 200 anonymous `GET /login` add 0 keys under the session prefix (the finding's own measurement, inverted); login adds 1                                                                                                                                |

Every changed `src` file is covered by at least one row above.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m113e-identity-session-semantics
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test:coverage auth-plugin session-plugin   # ANSI-stripped per-file table, ≥90% every src file
pnpm test && pnpm test:coverage                  # the full suite, once, captured to a log
pnpm run test:deno-lane
pnpm run check:docs
pnpm run release:publish --dry-run && pnpm run release:verify 0.9.0
```

Negative controls, each observed failing and reverted:

1. Re-enable the principal-roles loop unconditionally → the integration B-tenant 403 fails.
2. Re-enable `#holdsDirectly` unconditionally → the `permissions: ['*']` case fails.
3. Drop the Bearer branch from `isCsrfExempt` → the JWT 200 fails.
4. Make the Bearer rule match `Basic` too → the Basic 403 fails.
5. Remove the demotion `destroy` → the replay-after-logout test restores the old data.
6. Skip the `held` marker check on restore → the anonymous round trip reads the store and loses its
   token.
7. `needsRehash` comparing `!==` instead of `<` → the "above configured" case fails.

## 8. Risks & mitigations

- **Deployed Workers refusing 600,000 PBKDF2 iterations** (reported; local workerd accepts it) → a
  Workers app hashing with the default fails at `hash`. Mitigation: the README and upgrade guide
  tell Workers apps to pass `iterations: 100_000`. The refusal surfaces at the first `hash`, not
  silently. Recorded as unverified against a deployed Worker.
- **Rolling deploy across the cookie-held change** → an older replica reading a `held: 'cookie'`
  cookie ignores the marker, misses the store and starts a fresh session, so an anonymous form loses
  its token once (one 403). Mitigation: stated in the upgrade guide. No authenticated session is
  affected, because those keep their row.
- **Apps relying on JWT roles in scoped checks** → denied after upgrade. Mitigation: breaking
  CHANGELOG entry, upgrade-guide entry naming the option, and the integration test proving the
  option restores the old answer.
- **Hash latency ×5 (15 → 79 ms on Node)** → slower sign-in and a cheaper online guessing DoS.
  Mitigation: documented. Sign-in routes should already sit behind `rateLimitMiddleware`, and the
  README recipe shows it.

## 9. Out of scope

- Pending OIDC/SAML sign-in state still writes a store row per login attempt. Those keys are
  `auth-plugin` secrets (the PKCE verifier), and the cookie-held rule deliberately covers only
  session-plugin's own reserved keys. Unowned; recorded for the next session/auth letter.
- Argon2id/scrypt hashing — no Web Crypto primitive. Unowned.

## 10. Design security review

Recorded before implementation. Trust boundaries crossed: browser → CSRF verifier (V9-27), cookie →
session restore (V9-46), principal claims → scoped authorization (V9-28), password storage (V9-50).

| #   | Threat                                                                                   | Mitigation in the design                                                                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | A cross-site form forges a mutation through the Bearer exemption                         | A form cannot set `Authorization`; `fetch` from another origin needs a preflight. Only `Bearer` with a non-empty token is exempt. Basic, which browsers resend, is not (§3.2; negative control 4)                                                                                        |
| S2  | A forged Bearer header with a bogus token bypasses CSRF and then authenticates by cookie | The exemption is decided before auth runs (priority 275 < 300), so the session cookie could still authenticate the request. That needs a script able to set `Authorization` — same-origin or CORS-approved — which can already read the form token. Stated in the README as the boundary |
| S3  | A cookie-held session is forged or tampered with                                         | Sealed by the existing key ring (AES-GCM or HMAC); `open` refuses tampering; `held` is inside the sealed plaintext, so a client cannot flip a store-held cookie into a cookie-held one                                                                                                   |
| S4  | A stale id-only cookie restores a session after it was demoted (logout)                  | Demotion destroys the row before the new cookie is sent (§3.3; negative control 5)                                                                                                                                                                                                       |
| S5  | Session fixation through a cookie-held pre-login session                                 | A cookie-held cookie never reads the store, so a copy restores only the anonymous data; promotion writes the row under the current id                                                                                                                                                    |
| S6  | `mode: 'sign'` exposes reserved keys to the client                                       | Only the CSRF token (already in the page) and the tenant id. The pending sign-in secrets stay store-held (§9)                                                                                                                                                                            |
| S7  | Principal claims grant authority across tenants (V9-28 itself)                           | Default off; opt-in documented as "authority the principal carries counts in every scope"                                                                                                                                                                                                |
| S8  | A misconfigured `iterations` silently weakens hashing                                    | Integer floor 100,000, `NaN` and fractions refused at construction; the message names the bounds, not the value                                                                                                                                                                          |
| S9  | `needsRehash` downgrades a hash after a configuration is lowered                         | Returns `false` at or above the configured count (negative control 7)                                                                                                                                                                                                                    |
| S10 | Unbounded store growth from anonymous traffic (V9-46)                                    | Zero rows for reserved-only sessions; pending sign-in state remains a known residual (§9)                                                                                                                                                                                                |

A committed-tree security audit runs before the PR, in a fresh context.

### Committed-tree audit, round 1 (fresh-context agent, `36f497b1`) — failed

Two Low findings, no Critical, High or Medium; all 10 negative controls observed failing.

- **L1 — S2's justification was false under path-scoped CORS.** An origin allowed
  `credentials: true` and `Authorization` on `/api/*` only cannot read the form token on `/form`,
  yet can send a junk bearer header with the victim's cookie and skip the check (`200` as the
  victim; `403` with `exemptBearer: false`). Fixed in the docs (session README, `CsrfFormOptions`
  JSDoc, CHANGELOG, upgrade guide, `PUBLIC_API.md`): the exemption trusts every origin CORS lets
  send `Authorization` with credentials. The default is unchanged (maintainer decision).
- **L2 — `exemptBearer` was not validated.** `'false'`, `'no'` and `null` left the exemption on.
  `resolveCsrfConfig` now refuses a non-boolean with a value-free `TypeError`; reverting fails 5
  tests.
- **O1 (observation, fixed) — fixation without `regenerate()` was reduced, not closed.** Promotion
  of a cookie-held session to the store now rotates its id (`Session.rotateId`, internal), so a copy
  of the anonymous cookie can never address the promoted row. Implemented by Codex; reverting fails
  2 tests.
- **O2 (pre-existing, not fixed here)** — `parseStoredHash` echoes the stored iteration string into
  its error. **O3** — an oversized tenant id breaks only the requester's own commit.

### Committed-tree audit, round 2 (same independent auditor, `46acb5dd`) — passed

No open findings. L1 (wording judged accurate and sufficient), L2 and O1 verified fixed. 13 negative
controls observed failing (NC1–NC10 plus NC11/NC11b for the rotation and NC12 for the boolean
check). Observation: two concurrent promotions from one held cookie leave one orphan row, reachable
only by the discarded cookie, until its TTL — benign. Support limits: Node only, no real browser
(CORS asserted from response headers), not tested on a deployed Worker.

### Design change after review (bearer exemption)

A CodeRabbit Major finding — an origin CORS lets send `Authorization` with credentials can add a
junk bearer header to a request the session cookie authenticates and skip the form check — plus a
framework survey (Django REST Framework enforces CSRF only when session authentication succeeded;
Laravel, Rails, Spring, and ASP.NET Core exempt by route; no framework exempts on header presence)
led the maintainer to choose credential-based exemption: a bearer request skips form CSRF only when
a `'header'`-credential strategy authenticated it.

Three changes: (1) `IAuthStrategy.credential` (`'header'` | `'cookie'`, absent treated as `'cookie'`
— fail closed) declares where each strategy reads its credential — the built-in jwt, api-key and
issuer strategies are `'header'`, the session and auth-session strategies are `'cookie'`; (2)
`CREDENTIAL_SOURCE_STATE_KEY` (`auth-plugin:credential-source` in `common`) — the authentication
middleware records the credential of the strategy that authenticated the request, unset when nothing
did, and form CSRF reads it: `exemptBearer` and a bearer header are not enough, the source must be
`'header'`; (3) the form-CSRF middleware moved from priority 275 to 325 (after authentication at
300, before authorization at 350) so the source exists when the check runs. `L1` is now closed in
code rather than documented: the stated boundary — the exemption trusting every origin CORS lets
send `Authorization` with credentials — no longer exists, and the documentation that carried it was
replaced by the new rule.

### Committed-tree audit, round 3 (same independent auditor, `d36f019d`) — failed

L1 (the CodeRabbit Major) is now closed in code by the credential-source rule: the round-1 junk
bearer header beside the session cookie (R1) is refused `403`. 17 negative controls observed
failing. One new Low, fixed in code.

- **L3 — a CORS-approved credentialed origin with its own valid bearer token beside the victim's
  cookie was exempt yet acted on the victim's session.** An origin allowed `credentials: true` and
  `Authorization` can send its own VALID bearer token — authenticating as the attacker, source
  `'header'` — beside the victim's session cookie, which the session middleware (260) has already
  restored (`isNew` false). The credential-source rule exempted the request (a `'header'` strategy
  authenticated it), so a mutating handler wrote into the victim's session, or
  `POST <basePath>/logout` signed them out. Fixed by also requiring the request to have restored no
  session: the exemption now additionally reads the session `session-plugin` parks under
  `SESSION_STATE_KEY` and exempts only when it is new (`isNew === true`), failing closed when the
  session or the credential source is missing. A non-browser API client sends no session cookie, so
  its new session keeps the exemption.

### Committed-tree audit, round 4 (same independent auditor, `0279bac3`) — failed

L3 closed on both strategies (attacker token + victim cookie: write and logout 403, victim session
unchanged); every requested edge case failed closed. New Low **L4**: when the victim's cookie no
longer restores (tampered, expired, revoked, absent) the session is new, so a CORS-approved origin's
own valid bearer request was exempt, and a session its handler wrote was committed and sent as
`Set-Cookie` — session planting, login CSRF if the route writes identity. Fixed by the maintainer's
choice of making bearer-exempt requests sessionless: `applyCsrfExemption` marks a request the bearer
rule exempts (`BEARER_EXEMPT_STATE_KEY`, internal), and `sessionMiddleware` skips the commit for it.
Implemented inline; reverting the skip fails both L4 tests (tampered cookie, no cookie).

The L4 fix was NOT re-audited, at the maintainer's direction (2026-10-17).
