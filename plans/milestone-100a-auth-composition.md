# Milestone 100a — Two Composition Defects in `@setu-ts/auth-plugin`

> **Status:** Planning on `docs/m100-auth-federation-mfa`. Implementation and fixes belong on
> `feat/m100a-auth-composition`; `main` remains protected.

## 0. Objective & scope

Remove the two defects that make `AuthPlugin` awkward to compose, before any new authentication
method is added on top of it: `jwt` is required even when an application never issues or accepts a
JWT, and nothing registers `authMiddleware()`, so a correctly configured plugin authenticates nobody
unless the application also remembers a hand-written `app.middleware.add(...)` line.

- **In scope:** `AuthPluginOptions.jwt` becomes optional; `AuthPlugin` registers `authMiddleware()`
  itself, with an option to move or disable it; the starters' `auth` arm documentation and READMEs;
  every doc site that tells the reader to add the middleware by hand; the ARCHITECTURE and guide
  priority tables that disagree with the source.
- **NOT this milestone:** any new authentication method — outside-issuer tokens (100b), OIDC sign-in
  (100c), TOTP (100d), passkeys (100e), SAML (100f). The `full-stack` scaffold switching its route
  middleware from the raw session to `userContext` is a CLI change and waits for a separate
  decision.

## 1. Contracts verified from SOURCE (not names)

| Reference                      | Source (file:line)                                                                                           | Verified surface / fact                                                                                                                                                                  |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AuthPluginOptions.jwt`        | `packages/auth-plugin/src/interfaces/index.ts:91`                                                            | `readonly jwt: JwtOptions` — required, documented "Required."                                                                                                                            |
| Construction check             | `packages/auth-plugin/src/plugin/auth-plugin.ts:49`                                                          | Throws unless `jwt.secret` or both `jwt.privateKey`/`jwt.publicKey` are set; `options.jwt` is dereferenced unconditionally at `:49`, `:55`, `:87-100`, `:116-123`.                       |
| `provides`                     | `packages/auth-plugin/src/plugin/auth-plugin.ts:60`                                                          | `CAPABILITIES.JWT` and `CAPABILITIES.AUTH` always; `AUTHORIZATION` only when `rbac` is set — the conditional-provides precedent this plan follows.                                       |
| Strategy chain                 | `packages/auth-plugin/src/plugin/auth-plugin.ts:106-167`                                                     | JWT strategy pushed unconditionally ("always present"), then api-key, session, caller strategies; duplicate names throw.                                                                 |
| `authMiddleware`               | `packages/auth-plugin/src/middleware/auth-middleware.ts`                                                     | Resolves `CAPABILITIES.AUTH` per request, calls `authenticate`, writes through `replacePrincipal` when non-null, ALWAYS calls `next()`; a strategy throw is swallowed and `next()` runs. |
| `replacePrincipal`             | `packages/common/src/request-identity.ts:161`                                                                | The M71 explicit-replacement escape: a second write replaces rather than throwing, so running the middleware twice cannot fail a request.                                                |
| Plugin middleware registration | `packages/common/src/plugin.ts:503`                                                                          | `IPluginContext.middleware: IMiddlewareApi` — `add(fn, { priority, name })`.                                                                                                             |
| Self-registering neighbours    | `session-plugin/src/plugin/session-plugin.ts:121-127`                                                        | `SessionPlugin` adds its session middleware at 260 and form CSRF at 275 from `register()`; `metrics-plugin.ts:85`, `telemetry-plugin.ts:213`, `multi-tenancy-plugin.ts:278` do the same. |
| Starters compose separately    | `starters/rest-starter/src/app.ts`, `microservice-starter/src/app.ts:63`, `full-stack-starter/src/app.ts:84` | Each calls `createApplication` itself and adds only `errorHandler`; none adds `authMiddleware`.                                                                                          |
| Starter `auth` arm             | `packages/starters/rest-starter/src/options.ts:114-120`                                                      | JSDoc: "supply `jwt` alone for a JWT-only application" — true today, and the only guidance on the arm.                                                                                   |
| `userContext` bridge           | `packages/react-router-plugin/src/handler/load-context.ts:30`                                                | `context.set(userContext, ctx.request.user)` — so SSR routes see a principal only if the auth middleware ran before the catch-all.                                                       |
| Session strategy               | `packages/auth-plugin/src/strategies/session-strategy.ts`                                                    | Reads through `ISessionService.fromHeaders`; does not need the session middleware to have run, so its position relative to 260 is not load-bearing for correctness.                      |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                               | Resolution (picked side)                                         | Doc deliverable (same PR)                                                                                                                          |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `ARCHITECTURE.md` §10 says "no first-party middleware registers itself globally at the number this table names — the application (or a starter) adds it". Source contradicts it TODAY: session (260), CSRF form (275), metrics (20), telemetry (30) and tenant (40) all self-register. | Source wins. After this milestone auth (300) self-registers too. | Rewrite that paragraph to name which rows are self-registered and which the application adds (error handler).                                      |
| C2 | `docs/plugin-architecture.md` "Middleware Priorities" lists `authMiddleware` at **25** (and validation at 35, cache at 15), while `ARCHITECTURE.md` §10 and every example use **300**.                                                                                                 | 300 (source, ARCHITECTURE, READMEs).                             | Correct the guide's table against the same values `packages/cli/test/integration/middleware-bands.test.ts`-style checks read from source.          |
| C3 | `AuthPluginOptions.jwt` is documented "Required." in source, README and `PUBLIC_API.md`; the starter arm says "supply `jwt` alone for a JWT-only application".                                                                                                                         | `jwt` becomes optional.                                          | Update `interfaces/index.ts` JSDoc, `packages/auth-plugin/README.md`, `PUBLIC_API.md` (AuthPlugin section), `rest-starter/src/options.ts:114-120`. |
| C4 | Five doc sites instruct `app.middleware.add(authMiddleware(), { priority: 300 })` (`auth-plugin/src/index.ts:24`, `plugin/auth-plugin.ts:44`, `middleware/auth-middleware.ts:25`, `auth-plugin/README.md:74`, `PUBLIC_API.md:2401`).                                                   | The call becomes unnecessary and double-runs.                    | Remove it from every example; add the opt-out example to the README and `PUBLIC_API.md`.                                                           |
| C5 | `docs/plugins.md:405` names `CAPABILITIES.AUTHENTICATION`, which does not exist; the constant is `CAPABILITIES.AUTH` (`'authentication'`, `packages/common/src/tokens.ts:57`).                                                                                                         | Source wins.                                                     | Correct the guide line.                                                                                                                            |

## 3. Design decisions

### 3.1 `jwt` optional, conditional `provides`

- **Decision:** `AuthPluginOptions.jwt?: JwtOptions`. When absent: no `JwtService` is constructed,
  `provides` omits `CAPABILITIES.JWT`, and no JWT strategy joins the chain. When present, behaviour
  is byte-identical to today, including the existing construction-time refusal of a `jwt` object
  carrying no key material. `RefreshTokenService` keeps requiring an `IJwtService` in its own
  options (`RefreshTokenOptions.jwt`, `refresh-token-service.ts:18`), so an application using
  refresh tokens must configure `jwt` — the requirement is already a compile error there.
- **Why:** The M68 `rbac` precedent; a JWT-less application should not invent a secret.
- **Test home:** `test/unit/auth-plugin-options.test.ts`, `test/integration/jwt-optional.test.ts`.

### 3.2 Refuse an empty request chain

- **Decision:** After the chain is assembled in `register()`, zero strategies throws
  `AuthPluginConfigurationError` naming `jwt`, `apiKey`, `session` and `strategies`. It is thrown at
  `register()`, not construction, because caller strategies are only known there.
- **Why:** A plugin that can authenticate nothing is a configuration mistake whose only symptom
  would be every request answering `401`. `local` alone is refused too: it verifies credentials for
  a login form but cannot recognise the next request.
- **Test home:** `test/unit/auth-plugin-options.test.ts`.

### 3.3 The plugin registers `authMiddleware()`

- **Decision:** New option `middleware?: false | { readonly priority?: number }`. Default: the
  plugin calls `ctx.middleware.add(authMiddleware(), { priority: 300, name: 'auth' })` in
  `register()`. `false` registers nothing (for an application attaching it per route). A supplied
  priority must be a finite integer, else construction throws.
- **Why:** Three reasons from §1 — the starters compose separately, neighbours self-register, and
  the middleware never rejects. Fixing it in the starters would leave every non-starter composition
  broken.
- **Test home:** `test/integration/auth-middleware-registration.test.ts` drives a real kernel
  application with NO hand-written add and asserts `ctx.request.user` is populated; the opt-out case
  asserts it is not.

### 3.4 Double registration is harmless and documented

- **Decision:** No detection of a hand-added copy. The kernel exposes no way to enumerate global
  middleware to a plugin, and `replacePrincipal` makes the duplicate idempotent. The CHANGELOG and
  `docs/upgrading.md` tell the reader to delete their call.
- **Why:** A detection heuristic (matching `name: 'auth'`) would miss every unnamed call, which is
  all of them.
- **Test home:** `test/integration/auth-middleware-registration.test.ts` — with a hand-added copy
  the request still succeeds with the same principal, and the strategy is invoked twice (asserted,
  so the documented cost is real).

## 4. Exported surface — every symbol names its consumer

| Exported symbol                | Kind          | Consumer / real code path that READS it                                                          |
| ------------------------------ | ------------- | ------------------------------------------------------------------------------------------------ |
| `AuthPluginOptions` (widened)  | type          | Applications and the three starters' `auth` arm.                                                 |
| `AuthMiddlewareOption`         | type          | The `middleware` field of `AuthPluginOptions`; named so starters can re-export it in their docs. |
| `AuthPluginConfigurationError` | class (error) | Thrown by `register()` (§3.2); applications `instanceof` it in startup error handling and tests. |

### 4.1 Options — every option names its consumer

| Option       | Consumer                              | Behavior (per implementation)                                              |
| ------------ | ------------------------------------- | -------------------------------------------------------------------------- |
| `jwt`        | `AuthPlugin` factory and `register()` | Absent → no JWT service, capability or strategy (§3.1).                    |
| `middleware` | `register()` → `ctx.middleware.add`   | Default adds at 300; `{ priority }` moves it; `false` adds nothing (§3.3). |

## 5. Implementation files

| File                                             | Purpose                                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| `packages/auth-plugin/src/index.ts`              | Export `AuthMiddlewareOption`, `AuthPluginConfigurationError`; fix example. |
| `packages/auth-plugin/src/interfaces/index.ts`   | `jwt` optional; `middleware` option; JSDoc.                                 |
| `packages/auth-plugin/src/plugin/auth-plugin.ts` | Conditional JWT construction/provides; chain refusal; middleware add.       |
| `packages/auth-plugin/src/errors.ts`             | `AuthPluginConfigurationError`.                                             |
| `packages/starters/rest-starter/src/options.ts`  | `auth` arm JSDoc (C3).                                                      |
| Docs                                             | C1–C4, READMEs of the three starters, CHANGELOG, `docs/upgrading.md`.       |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                | src covered                   | Key assertions                                                                                                                                                                  |
| ------------------------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth-plugin/test/unit/auth-plugin-options.test.ts`                      | `auth-plugin.ts`, `errors.ts` | `jwt` absent → `provides` lacks `jwt`; empty chain throws naming the four options; `local`-only throws; bad priority throws; existing jwt refusal kept.                         |
| `auth-plugin/test/integration/jwt-optional.test.ts`                      | `auth-plugin.ts`              | Session-only app (real `SessionPlugin`) boots; `services.has(CAPABILITIES.JWT)` is false; a session login is recognised on the next request.                                    |
| `auth-plugin/test/integration/auth-middleware-registration.test.ts`      | `auth-plugin.ts`              | No hand-written add → principal populated; `middleware: false` → not; custom priority observed via kernel diagnostics; hand-added copy → same principal, strategy called twice. |
| `starters/full-stack-starter/test/integration/auth-user-context.test.ts` | (starter wiring)              | Starter app with `auth.session` and a `reactRouter` stub build: an SSR loader reads the principal from `userContext` with no hand-written add.                                  |
| `auth-plugin/test/unit/barrel-exports.test.ts` (extended)                | `index.ts`                    | Both new symbols exported; compile-time assertion on the widened options type.                                                                                                  |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m100a-auth-composition, never main
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # ANSI-stripped per-file table; ≥90% branch/function/line every changed src file
deno task check:docs
deno task publish:check     # committed tree
deno task release:verify <version>
```

## 8. Risks & mitigations

- An application that already adds the middleware now authenticates twice per request → documented
  migration step; a test pins that it stays correct.
- An application that deliberately attached `authMiddleware` only to some routes now gets it
  globally → it answers identically (the middleware never rejects), and `middleware: false` restores
  the previous composition exactly; stated in the upgrade guide.
- The starter full-stack test needs a server build → it uses the `loadRequestHandler` injection seam
  (`react-router-plugin/src/interfaces/index.ts:134`) rather than a real Vite build.

## 9. Out of scope

- New authentication methods — 100b–100f.
- The CLI `full-stack` scaffold reading `userContext` instead of the raw session — a separate CLI
  decision once this lands.
- Making the `local` login path create a session automatically — application code today, revisited
  by 100c's callback design.

## 10. Design security review — completed before implementation

**Reviewed change:** the set of requests that are authenticated grows from "routes the application
remembered to cover" to "every request", and a JWT-less configuration becomes legal.

| Finding                                                                       | Resolution in this plan                                                                              |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Global authentication could reject requests that used to pass.                | `authMiddleware` never rejects; guards decide. Asserted by the opt-out/duplicate tests.              |
| A misconfigured plugin could silently authenticate nobody.                    | Empty chain refused at `register()` (§3.2).                                                          |
| Priority lower than the session could hide a session principal.               | Session strategy reads headers directly, so order is not a correctness dependency; default 300 kept. |
| Removing `jwt` could leave `RefreshTokenService` issuing unverifiable tokens. | `RefreshTokenOptions.jwt` is required; it cannot be constructed without an `IJwtService`.            |

The implementation audit verifies that with `jwt` absent no JWT is accepted from an `Authorization`
header (a forged HS256 token with a guessed secret is anonymous), and that `middleware: false`
leaves `ctx.request.user` unset on every request.
