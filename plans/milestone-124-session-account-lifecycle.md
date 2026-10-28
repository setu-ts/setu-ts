# Milestone 124 — Session and Account Lifecycle (`@setu-ts/auth-plugin`)

> **Status:** Planning. Branch: `feat/m124-session-account-lifecycle`. `main` is protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Close the three framework gaps the 2026-10-24 review of a cookie-session React Router application
found (register rows V10-65, V10-66): a password-only application without MFA cannot re-check the
account on each request; `requireAuth()` cannot send a browser to the sign-in page; and there is no
way to end every session of one user. The boundary is `auth-plugin`'s session arm and guards:
`session-plugin` and `common` need no code change (§2 C1 records the ROADMAP deviation).

- **In scope:** lifting the `signIn` provider refusal (item 1); `requireAuth({ signInPage })` with
  navigation detection and a safe `returnTo` (item 2); `signIn.sessionStamp`, a per-user stamp
  recorded at sign-in and compared on every request (item 3); exporting `safeReturnTo` so an
  application's own login handler honours `returnTo` by the same rule; a real-kernel e2e; READMEs,
  `PUBLIC_API.md`, CHANGELOG, `docs/upgrading.md`, recipes; ROADMAP section and row `124`.
- **NOT this milestone:** listing a user's sessions with IP/device (generator material — a
  full-stack template candidate, no milestone yet); forced password reset and admin impersonation
  ship as recipes only (§3.6); a server-side session registry (§3.3 rejects it).

## 1. Contracts verified from SOURCE (not names)

| Reference                                      | Source (file:line)                                                                                                                            | Verified surface / fact                                                                                                                                                                                         |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compileSignIn` provider refusal               | `packages/auth-plugin/src/sign-in/config.ts:335`                                                                                              | Throws when `providers` is empty and neither `mfa` nor `passkeys` is set — the V10-65 block.                                                                                                                    |
| `SignInConfig`                                 | `packages/auth-plugin/src/interfaces/index.ts:721`                                                                                            | `basePath?`, `providers` (required array), `refreshPrincipal?` (738), `mfa?`, `passkeys?`.                                                                                                                      |
| `RefreshPrincipal`                             | `packages/auth-plugin/src/interfaces/index.ts:607`                                                                                            | `(stored: IPrincipal) => IPrincipal \| null \| Promise<IPrincipal \| null>`.                                                                                                                                    |
| `SessionStrategy` (`AuthPlugin({ session })`)  | `packages/auth-plugin/src/strategies/session-strategy.ts:25`                                                                                  | `toPrincipal` is synchronous; no per-request re-check is possible on this arm.                                                                                                                                  |
| `AuthSessionStrategy.authenticate`             | `packages/auth-plugin/src/strategies/auth-session-strategy.ts:88`                                                                             | Reads `SessionView` via `fromHeaders` (read-only), parses the record, calls `refreshPrincipal` when configured; a throw or `null` → anonymous (fails closed); result frozen with `amr` from the record.         |
| `AuthSessionRecord` / `parseAuthSessionRecord` | `packages/auth-plugin/src/sign-in/auth-session-service.ts:94,117`                                                                             | `{ principal, methods, at }` under `AUTH_SESSION_KEY`; parser treats anything malformed as "not signed in".                                                                                                     |
| `AuthSessionService.signIn`                    | `packages/auth-plugin/src/sign-in/auth-session-service.ts:261`                                                                                | Writes the record, clears provider/pending keys, then `session.regenerate()`; async (resolves scoped grants first).                                                                                             |
| `IAuthSessionService`                          | `packages/common/src/services/auth-session.ts`                                                                                                | `signIn`, `current`, `pending`, `signOut` — unchanged by this milestone.                                                                                                                                        |
| `registerSignInRoutes`                         | `packages/auth-plugin/src/sign-in/routes.ts:623`                                                                                              | Registers login + callback per provider, then the logout route: with no providers only `POST <basePath>/logout` is registered.                                                                                  |
| `requireAuth`                                  | `packages/auth-plugin/src/guards/index.ts:69`                                                                                                 | No parameters; `respondWithAuthorizationFailure(ctx, 'authentication-required')` (401 Problem Details) when `ctx.request.user` is absent; wrapped by `withSecurityMetadata(…, AUTHENTICATED)`.                  |
| `respondWithAuthorizationFailure`              | `packages/common/src/errors/authorization-responder.ts:91`                                                                                    | The 401/403 Problem Details writer every guard uses.                                                                                                                                                            |
| `safeReturnTo`                                 | `packages/auth-plugin/src/sign-in/return-to.ts:41`                                                                                            | Single leading `/` only, no `\`, no control chars, non-ASCII percent-encoded, byte-capped; returns `fallback` otherwise. Internal today (not in `src/index.ts`).                                                |
| `RETURN_TO_QUERY_PARAM`                        | `packages/auth-plugin/src/sign-in/routes.ts:52`                                                                                               | `'returnTo'` — the query name M100c's provider login routes already read.                                                                                                                                       |
| `constantTimeEquals`                           | `packages/auth-plugin/src/mfa/totp-codes.ts:92`                                                                                               | Internal constant-time string compare, reused for the stamp.                                                                                                                                                    |
| `ISessionStore`                                | `packages/common/src/services/session.ts:235`                                                                                                 | `read`/`write`/`destroy` by session id only — no per-user index, so "every session of a user" cannot be enumerated (why §3.3 compares a stamp instead).                                                         |
| `SessionPluginOptions.mode`                    | `packages/session-plugin/src/options.ts:138`                                                                                                  | `'encrypt'` (default, AES-256-GCM) or `'sign'` (readable base64url JSON under an HMAC): with `'sign'` on the cookie strategy the CLIENT can read every session value — why §3.3 stores a digest, not the stamp. |
| `UseGuards`                                    | `packages/decorator-plugin/src/decorators/pipeline.ts:32`                                                                                     | Attaches middleware to a decorated class or method — how a decorated route takes `requireAuth({ signInPage })`; `@RequirePolicy` answers its own 401.                                                           |
| CORS / localization `Vary`                     | `packages/http-security-plugin/src/middleware/cors-middleware.ts:110`, `packages/localization-plugin/src/middleware/locale-middleware.ts:116` | Both APPEND to `Vary`, so the guard must append too, never set.                                                                                                                                                 |
| `AuthSessionStrategy` options                  | `packages/auth-plugin/src/strategies/auth-session-strategy.ts:29-35`                                                                          | `sessionService`, `refreshPrincipal?` — no runtime today; §3.3 adds `subtle` for the digest.                                                                                                                    |
| Cookie strategy                                | `packages/common/src/services/session.ts:1-10` (module doc)                                                                                   | The payload lives in the cookie; the server cannot destroy it — a per-request compare is the only server-side revocation that works on both strategies.                                                         |

**Framework behaviour (read from source, 2026-10-29):**

| Concern          | Laravel 12.x                                                                                                                                                             | Django main                                                                                                                                                         | Devise main                                                                                     | ASP.NET Core main                                                                                                  | Spring Security main                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Page vs API      | `Handler::unauthenticated`: `shouldReturnJson` → JSON 401, else `redirect()->guest(...)`; `expectsJson` = XHR (not PJAX) accepting anything, or `Accept` first type JSON | `login_required` always redirects (`redirect_to_login`, `next`)                                                                                                     | `FailureApp#http_auth?`: XHR → configurable; else 401 unless the request format is navigational | `OnRedirectToLogin`: `X-Requested-With: XMLHttpRequest` → 401, else redirect                                       | `AbstractAuthenticationFilterConfigurer`: login redirect only when `Accept` matches HTML/XHTML/image/text-plain AND not `X-Requested-With: XMLHttpRequest` |
| Return path      | `guest()` stores `url.intended` only for a GET that does not expect JSON                                                                                                 | `next` query                                                                                                                                                        | `store_location_for` only for GET + navigational                                                | `ReturnUrl` query                                                                                                  | saved request cache                                                                                                                                        |
| End all sessions | `AuthenticateSession`: password hash in session, `hash_equals` each request; `logoutOtherDevices()` rehashes                                                             | `get_user`: `get_session_auth_hash()` stored at login, `constant_time_compare` each request, mismatch flushes; `update_session_auth_hash` keeps the current session | `serialize_from_session` compares `authenticatable_salt` (`encrypted_password[0,29]`) each load | `SecurityStampValidator`: stamp on the user, checked every `ValidationInterval`, then `RejectPrincipal` + sign-out | `SessionRegistry` (server-side registry)                                                                                                                   |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                               | Resolution (picked side)                                                                                                                                             | Doc deliverable (same PR)                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| C1  | ROADMAP §124 lists `packages/common` ("a per-user session stamp contract") and suggests "a small port in `common` with memory and cache-backed stores" | The stamp lives on the application's user record (§3.3, maintainer decision 2026-10-29, four of the five compared frameworks): no port, no store, `common` unchanged | ROADMAP §124 rewritten to name the shipped design and the decision |
| C2  | ROADMAP §124 item 3 asks for "the API that bumps it (`signOutEverywhere(userId)` or similar)"                                                          | The application bumps its own stamp (it owns the user record); the framework ships no bump API, and the recipe shows the one-line update                             | ROADMAP §124 and the auth README recipe                            |

## 3. Design decisions

### 3.1 Item 1 — `signIn` without any provider (V10-65)

- **Decision:** `compileSignIn` accepts `providers: []` with neither `mfa` nor `passkeys`. The
  refusal at `config.ts:335` keeps only its array check (`!Array.isArray(config.providers)`); the
  error message is updated. Such a configuration registers `CAPABILITIES.AUTH_SESSION`, the
  `auth-session` strategy (with `refreshPrincipal` and `sessionStamp` when given) and the logout
  route — `registerSignInRoutes` already handles an empty provider list. `AuthPlugin({ session })`
  is unchanged and stays synchronous; its README and JSDoc point to `signIn` for a per-request
  re-check. One mechanism: `signIn` is the session arm that re-checks.
- **Why:** the re-check, `amr`, rotation at sign-in and §3.3's stamp all hang off the record
  `IAuthSessionService` writes; an async `toPrincipal` on the other arm would duplicate the re-check
  and leave the stamp nowhere to live.
- **Test home:** `sign-in-config.test.ts` (empty list accepted; non-array still refused);
  `auth-session-strategy.test.ts` integration (a password-only app's `refreshPrincipal` returning
  `null` makes the next request anonymous); the e2e (§6).

### 3.2 Item 2 — `requireAuth({ signInPage })` (V10-66)

- **Decision:** `requireAuth(options?: RequireAuthOptions)`,
  `RequireAuthOptions = { readonly signInPage?: string }`. Absent options keep today's behaviour
  exactly. With `signInPage`, an unauthenticated request that is a **navigation** is answered `302`
  to `signInPage` with `returnTo` set; every other unauthenticated request keeps the existing 401
  Problem Details. A navigation is: method `GET` or `HEAD`, AND no
  `X-Requested-With: XMLHttpRequest`, AND `Sec-Fetch-Mode: navigate` — or, when `Sec-Fetch-Mode` is
  absent, an `Accept` header naming `text/html` or `application/xhtml+xml` (a bare `*/*` is NOT
  enough, Spring's rule; `curl` sends `*/*`). A present `Sec-Fetch-Mode` other than `navigate` is
  never a navigation. `returnTo` is `safeReturnTo(path + search)`, added with `URLSearchParams` so a
  `signInPage` that already has a query keeps it. `signInPage` is validated once, when the guard is
  built: it must equal its own `safeReturnTo` result (same-origin absolute path) or `requireAuth`
  throws `AuthPluginConfigurationError` — a misconfigured guard fails at registration, not per
  request. Both responses APPEND `Accept`, `Sec-Fetch-Mode` and `X-Requested-With` to `Vary` through
  `appendHeader`, so a `Vary: Origin` already written by CORS survives, and a shared cache cannot
  serve one client's redirect to another's API call. A navigation whose path equals `signInPage`'s
  own path is answered 401, not redirected, so a sign-in page placed behind the guard by mistake
  cannot loop. A decorated route takes the option as `@UseGuards(requireAuth({ signInPage }))`;
  `@RequirePolicy` keeps its own 401, which the README says. The security metadata
  (`withSecurityMetadata(…, AUTHENTICATED)`) is unchanged.
- **Why:** the GET-only and HTML-only rules are what Laravel, Devise and Spring do (§1); a redirect
  for a POST would drop its body and turn a form submit into a GET. An option on the existing guard
  keeps one guard (maintainer decision 2026-10-29). `requireRole` / `requirePermission` stay 401: a
  route that wants the redirect lists `requireAuth({ signInPage })` first, which the README says.
- **Test home:** `guards.test.ts` — a table over (method × `Sec-Fetch-Mode` × `Accept` ×
  `X-Requested-With`) asserting redirect-or-401 as data; `returnTo` encoding and an unsafe path
  falling back to `/`; `signInPage` with an existing query; an invalid `signInPage` throwing at
  construction; `Vary` present on both; the no-options case byte-identical to today
  (`guard-format.test.ts`); short-circuit (handler never runs on the redirect or the 401).

### 3.3 Item 3 — `signIn.sessionStamp`, the per-user stamp

- **Decision:** `SignInConfig.sessionStamp?: SessionStamp`,
  `SessionStamp = (principal: IPrincipal) => string | null | Promise<string | null>`.
  `AuthSessionService.signIn` reads the principal's stamp once, BEFORE any write and for both
  outcomes — the pattern scoped grants already follow (`auth-session-service.ts:268-271`) — and
  stores its digest — SHA-256 through `runtime.subtle`, base64url — as `stamp: string | null` in the
  signed-in record or in the pending MFA record. The digest, never the raw stamp: with
  `mode: 'sign'` on the cookie strategy the client can read the session payload, and an application
  may use a password-hash prefix as its stamp. The synchronous `promotePending`
  (`auth-session-service.ts:390`) copies the pending record's stamp into the signed-in record and
  never calls the callback. On every request `AuthSessionStrategy` resolves the principal as today
  (snapshot, or `refreshPrincipal`), then calls `sessionStamp(principal)`, digests the result the
  same way (the strategy options gain `subtle`, passed from `ctx.runtime` by the plugin) and
  compares it with the recorded digest through `constantTimeEquals` (both `null` is a match). A
  mismatch, a throw, or a non-string non-null value makes the request anonymous — fail closed,
  exactly like `refreshPrincipal`. A record written before `sessionStamp` was configured has no
  `stamp` field and is read as `null`: it survives only while the user's current stamp is also
  `null`. The application owns the stamp (a `sessionVersion` column, or a prefix of its password
  hash, as Laravel/Django/Devise do) and **bumps it to sign out every session**; to keep the current
  session after a password change it calls `IAuthSessionService.signIn` again with the session's
  RECORDED methods (`ctx.request.user.claims.amr`, which the strategy sets from the record) —
  passing only `['pwd']` would demote an MFA session to pending — which records the new stamp and
  rotates the id (Django's `update_session_auth_hash`). A re-`signIn` also clears the
  provider-session and ID-token keys, as every `signIn` does; the recipe says so for federated
  users. To avoid a second user load per request, the recipe's `refreshPrincipal` copies the stamp
  into the refreshed principal's claims and `sessionStamp` reads it from there; the principal handed
  to `signIn` carries the same claim. Validated at compile time: a non-function `sessionStamp` is
  refused like a non-function `refreshPrincipal`.
- **Why:** maintainer decision 2026-10-29; four of five compared frameworks keep the stamp on the
  user record and compare it during the per-request user load the application already performs (§1).
  It needs no session registry, no new port and no extra I/O beyond that load, and works on both
  session strategies — on the cookie strategy, where the session cannot be destroyed, the compare is
  what ends it.
- **Test home:** `auth-session-service.test.ts` (stamp read once before any write, stored for both
  outcomes; promotion copies it without calling the callback; `null` recorded);
  `auth-session-strategy.test.ts` (match, mismatch, throw, non-string, legacy record, both-null;
  constant-time compare called; the recorded value is the digest, not the stamp);
  `sign-in-config.test.ts` (non-function refused); the e2e (two sessions signed out by one bump;
  re-sign-in with the recorded methods keeps the current one; the cookie strategy, §3.5 (d)).

### 3.4 `safeReturnTo` export

- **Decision:** export `safeReturnTo` from `@setu-ts/auth-plugin`, unchanged, with JSDoc, so an
  application's own password login handler validates `returnTo` by the rule the framework's routes
  use. `RETURN_TO_QUERY_PARAM` stays internal; the README names the `returnTo` query parameter.
- **Why:** §3.2 sends `returnTo` to a sign-in page the application writes; without the helper every
  application re-implements an open-redirect check (the gap V10-66 names).
- **Test home:** `return-to.test.ts` (existing) plus one barrel-import assertion in the e2e.

### 3.5 Real-kernel e2e

- **Decision:** `packages/auth-plugin/test/e2e/session-lifecycle-e2e.test.ts` boots
  `createApplication` with `RuntimePlugin`, `SessionPlugin` (store strategy, memory store) and
  `AuthPlugin({ signIn: { providers: [], refreshPrincipal, sessionStamp } })` over an in-memory user
  table, and drives it with `app.inject()`: (a) sign in; deactivate the user; the next request is
  anonymous; (b) an unauthenticated navigation to a `requireAuth({ signInPage: '/login' })` route
  gets `302 /login?returnTo=…` while the same path as an API call gets 401 Problem Details; (c) two
  sessions of one user both answer authenticated, one bump of the user's `sessionVersion` makes both
  anonymous, and a re-`signIn` after a bump keeps that session; (d) the same bump on the cookie
  strategy with `mode: 'sign'`, where the test decodes the readable cookie payload and asserts it
  holds the digest and not the raw stamp.
- **Why:** the ROADMAP deliverable; proves each item through the public surface, reading state back.
- **Test home:** itself.

### 3.6 Recipes for the "named, not taken" items

- **Decision:** the auth README gains three short recipes: sign out everywhere (bump the stamp),
  forced password reset (a `refreshPrincipal` claim plus an allow-list guard the application
  writes), and admin impersonation (stated as not provided, with the shape an application would
  take: record the real admin in a claim, audit through the audit plugin). Session listing with
  IP/device is named as generator material with no recipe.
- **Why:** the ROADMAP deliverable allows "recipes … or a stated decision not to write them".
- **Test home:** none (documentation; `check:docs` compiles fenced TypeScript).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. `requireAuth`'s new parameter is optional; `SignInConfig` gains
an optional member; the `signIn` refusal is relaxed, not tightened. Ships in minor 0.11.0.

| Exported symbol      | Kind                        | Consumer / real code path that READS it                                                      |
| -------------------- | --------------------------- | -------------------------------------------------------------------------------------------- |
| `RequireAuthOptions` | type                        | `requireAuth(options)` reads `signInPage` when building the guard                            |
| `SessionStamp`       | type                        | `SignInConfig.sessionStamp`; called by `AuthSessionService.signIn` and `AuthSessionStrategy` |
| `safeReturnTo`       | function (already internal) | the sign-in routes (today) and `requireAuth`'s redirect (new); applications' login handlers  |

### 4.1 Options — every option names its consumer

| Option                          | Consumer                                                       | Behavior (per implementation)                                      |
| ------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| `RequireAuthOptions.signInPage` | `requireAuth` guard (navigation branch)                        | validated at construction; redirect target for navigations         |
| `SignInConfig.sessionStamp`     | `AuthSessionService.signIn` / promotion; `AuthSessionStrategy` | recorded at sign-in; compared per request; absent = no stamp check |

## 5. Implementation files

| File                                                                                                                                      | Purpose                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/auth-plugin/src/index.ts`                                                                                                       | export `RequireAuthOptions`, `SessionStamp`, `safeReturnTo`               |
| `packages/auth-plugin/src/interfaces/index.ts`                                                                                            | `SessionStamp`, `SignInConfig.sessionStamp`, `RequireAuthOptions`         |
| `packages/auth-plugin/src/sign-in/config.ts`                                                                                              | relax the refusal; validate and compile `sessionStamp`                    |
| `packages/auth-plugin/src/sign-in/auth-session-service.ts`                                                                                | record `stamp` at sign-in and promotion; parse it                         |
| `packages/auth-plugin/src/strategies/auth-session-strategy.ts`                                                                            | per-request stamp compare                                                 |
| `packages/auth-plugin/src/plugin/auth-plugin.ts`                                                                                          | pass `sessionStamp` to the service and the strategy                       |
| `packages/auth-plugin/src/guards/index.ts`                                                                                                | `requireAuth(options)`, navigation detection, redirect, `Vary`            |
| `packages/auth-plugin/README.md`, `PUBLIC_API.md`, `CHANGELOG.md`, `docs/upgrading.md`, `ROADMAP.md`, `packages/session-plugin/README.md` | docs (§2, §3.6)                                                           |
| `CLAUDE.md` "Current status", ROADMAP row `124`, `plans/archive/milestone-124-session-account-lifecycle.md`                               | status flip with the PR number and the plan archived, in the milestone PR |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                 | src covered                                                    | Key assertions (and the signature each call type-checks against)                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/sign-in-config.test.ts`                                                                        | `sign-in/config.ts`                                            | empty providers accepted; non-array refused; non-function `sessionStamp` refused (`compileSignIn(config: SignInConfig)`)                                                                                                               |
| `test/unit/auth-session-service.test.ts`                                                                  | `sign-in/auth-session-service.ts`                              | `stamp` read once before any write, stored in the signed-in or pending record; `promotePending` copies it (callback not called); `null` recorded; legacy record parses with `stamp: null`                                              |
| `test/integration/auth-session-strategy.test.ts`                                                          | `strategies/auth-session-strategy.ts`, `plugin/auth-plugin.ts` | match / mismatch / throw / non-string / both-null / legacy; digest compared, not the raw stamp; refresh + stamp order; password-only `refreshPrincipal` `null` → anonymous                                                             |
| `test/unit/guards.test.ts`, `test/unit/guard-format.test.ts`, `test/unit/guard-security-metadata.test.ts` | `guards/index.ts`                                              | §3.2 table as data; `returnTo`; existing query kept; construction refusal; `Vary` appended after an existing `Vary: Origin`; the `signInPage` path itself answered 401; short-circuit; no-options output unchanged; metadata unchanged |
| `test/unit/return-to.test.ts`                                                                             | `sign-in/return-to.ts`                                         | unchanged behaviour, imported from the barrel                                                                                                                                                                                          |
| `test/e2e/session-lifecycle-e2e.test.ts`                                                                  | end to end                                                     | §3.5 (a)–(d) through `app.inject()`                                                                                                                                                                                                    |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m124-session-account-lifecycle, never main
pnpm run check:plan        # this plan lints clean
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run check:docs
pnpm test:coverage auth-plugin session-plugin   # per-file ≥90% branch/function/line
pnpm run ci:local          # on the final commit, alone on the machine
pnpm run test:deno-lane
pnpm run release:publish --dry-run
pnpm run release:verify 0.10.0
```

## 8. Risks & mitigations

- An open redirect through `returnTo` or `signInPage` → both pass `safeReturnTo`; `signInPage` is
  refused at construction if unsafe; tests include `//evil`, `/\evil`, control characters and an
  absolute URL.
- A shared cache serving a redirect to an API client →
  `Vary: Accept, Sec-Fetch-Mode, X-Requested-With` on both answers; tested.
- A POST form submit turned into a GET by a redirect → only GET/HEAD navigations redirect; tested.
- A stamp the client can read (cookie strategy, `mode: 'sign'`) → only its SHA-256 digest is stored;
  the e2e decodes the cookie and asserts the raw stamp is absent.
- A redirect loop when the sign-in page is itself guarded → its own path answers 401; tested.
- A re-`signIn` that demotes an MFA session to pending → the recipe passes the recorded `amr`; the
  e2e re-signs in with the recorded methods.
- A stamp compare that leaks timing → `constantTimeEquals`; a test asserts it is the compare used.
- A stamp callback that throws signing everyone in as the stale snapshot → fail closed (anonymous),
  the same rule as `refreshPrincipal`; tested.
- Enabling `sessionStamp` on a running app signs out sessions whose user already has a stamp →
  intended (records without a stamp are pre-stamp sessions); stated in `docs/upgrading.md`.

## 9. Out of scope

- Listing a user's sessions with IP and device (generator material; no milestone yet).
- Forced password reset and admin impersonation as framework features (recipes only, §3.6).
- A server-side session registry or a `common` stamp store (rejected in §3.3, decision 2026-10-29).
- Redirects from `requireRole` / `requirePermission` (compose with `requireAuth({ signInPage })`).

## 10. Design security review

| Change                        | Trust boundary                    | Threat considered                                                                                     | Mitigation in design                                                                                                            |
| ----------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| §3.1 signIn without providers | authentication                    | a configuration that silently authenticates nobody, or one where the strategy trusts a stale snapshot | same strategy and record as the other `signIn` arms; `refreshPrincipal` and `sessionStamp` fail closed                          |
| §3.2 redirect                 | redirect / request classification | open redirect; cache confusion; method downgrade; an API client receiving HTML                        | `safeReturnTo` on both values, construction-time refusal, `Vary`, GET/HEAD only, `Sec-Fetch-Mode` and XHR checks, 401 otherwise |
| §3.3 stamp                    | session revocation                | a revoked session still authenticating; timing leak; a throwing callback failing open                 | per-request compare on both strategies; only a SHA-256 digest stored; constant-time; throw / non-string → anonymous             |
| §3.4 export                   | public helper                     | a weakened validator once public                                                                      | exported unchanged; existing tests run against the barrel export                                                                |

A fresh Claude agent audits the committed tree before the PR (never Codex), per
`.roo/skills/security-audit/SKILL.md`.
