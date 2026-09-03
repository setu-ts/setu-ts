# Milestone 89a — Declarations That Enforce Nothing (`@setu-ts/decorator-plugin`, `@setu-ts/multi-tenancy-plugin`, `@setu-ts/cli`)

> **Status:** Planning. Branch: `feat/m89a-declarations-that-enforce-nothing`. `main` is protected —
> all work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Close the two High findings that share one shape — a security-relevant declaration whose published
documentation asserts an outcome no code produces. Each is resolved in the direction §3 records:
`@Roles`/`@Permissions` become **enforcing** route middleware built from the authorization
capability, and the two isolation strategies that produce no physical isolation stop **claiming**
they do, with a startup warning on the pairing that guarantees they cannot. Two Medium rows ride
along: the unverified-JWT resolver gains a warning where the choice is made, and `setu add` stops
discarding arguments it cannot honour.

- **In scope:** X18-3 (enforce `@Roles`/`@Permissions`, default on, `enforceRoles` escape hatch,
  startup warning when the capability is absent), X18-5 (correct the isolation table and the
  README's headline example; warn at `register()` when a non-`column` strategy is selected with no
  `dataStore`), X18-4 (README + option JSDoc + `register()` warning for `JwtResolver`), X18-1
  (`setu add` refuses extra positionals).
- **NOT this milestone:** X18-2 and X19-1 (masked-500 refusals) — **M89b**. X16-1 and X16-2 (the
  `0.3.0` ingress surface) — **M89c**. Shipping a `DatabasePlugin`-backed `ITenantDataStore` that
  honours `resolveSchema` — unowned; named in §9. Making `@Public()` exempt a route from a guard —
  unowned; it is fail-closed today and §3.7 records why it stays documentation here.

## 1. Contracts verified from SOURCE (not names)

| Reference                               | Source (file:line)                                                    | Verified surface / fact                                                                                                                                         |
| --------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `composeMiddleware`                     | `decorator-plugin/src/plugin/decorator-plugin.ts:328`                 | Reads `ctrl.guards`, `route.guards`, `ctrl.interceptors`, `route.interceptors`, `ctrl.filters`, `route.filters`. **Never `roles`/`permissions`.**               |
| `Roles` / `Permissions`                 | `decorator-plugin/src/decorators/security.ts:66-77`, `:80-86`         | Write `store.mergeController(target, { roles })` and `meta.roles = roles`. Both document **"any of the given"** — roles AND permissions.                        |
| readers of that metadata                | `decorator-plugin/src/metadata/metadata-store.ts:328-336,662-663`     | The ONLY readers in `packages/*/src` are the store's own merge and copy lines. No enforcement reader, no document reader.                                       |
| `appendValidationMiddleware`            | `decorator-plugin/src/plugin/decorator-plugin.ts:469-487`             | The precedent: called after `composeMiddleware`, pushes LAST, warns when the capability is `undefined`, returns early when there is nothing to do.              |
| `registerController` call order         | `decorator-plugin/src/plugin/decorator-plugin.ts:610-613`             | `composeMiddleware(...)` then `if (enforceSchemas) appendValidationMiddleware(...)`. The insertion point for a 403 band sits between the two.                   |
| `DecoratorPluginOptions.enforceSchemas` | `decorator-plugin/src/plugin/decorator-plugin.ts:72-76`, `:695`       | `readonly enforceSchemas?: boolean`, resolved `?? true`. The shape `enforceRoles` mirrors exactly.                                                              |
| `IAuthorizationService`                 | `common/src/services/auth.ts:152-180`                                 | `hasRole`, `hasPermission`, `hasAnyRole(principal, roles)`, `hasAllPermissions(principal, permissions)`. **There is no `hasAnyPermission`.**                    |
| `requireRole`'s refusal shape           | `auth-plugin/src/guards/index.ts:59-84`                               | `401 Unauthorized / "Authentication required"` with no principal; `403 Forbidden / 'Role "x" is required'` on failure; both via `respondWithError`.             |
| `respondWithError`                      | `common/src/errors/error-responder.ts:203` (M70f seam)                | Answers in the application's configured error format (re-exported at `common/src/index.ts:22`) from a package that may not import `@setu-ts/exceptions` (§2.2). |
| `withSecurityMetadata`                  | `common/src/http.ts:621`                                              | In **`common`**, not `auth-plugin` — so `decorator-plugin` may brand its own middleware and M57's `deriveSecurity` will see it.                                 |
| `SECURITY_METADATA`                     | `common/src/http.ts:461`                                              | `Symbol.for('setu.security.metadata')` — cross-copy safe, which is why branding works across a duplicated `common`.                                             |
| isolation strategy consumers            | `multi-tenancy-plugin/src/stores/memory-tenant-store.ts:46-58`        | `deriveScope` switches on `kind` and uses `resolveSchema`/`resolveDatabase` as a **partition-map key**. The only consumer in `packages/`.                       |
| tenancy ↔ database wiring               | `multi-tenancy-plugin/src/` (grep)                                    | `CAPABILITIES.DATABASE` and `IDatabaseService` appear **nowhere**. No shipped adapter is told the strategy.                                                     |
| `ITenantDataStore` contract note        | `multi-tenancy-plugin/src/interfaces/index.ts:149-150`                | A store "may ignore isolation metadata entirely" — the architecture is honest; the README is not.                                                               |
| `MultiTenancyPluginOptions`             | `multi-tenancy-plugin/src/interfaces/index.ts:90-111`                 | `resolver` (required), per-resolver bags, `database?`, `dataStore?`. `database` defaults `'column-per-tenant'`.                                                 |
| tenancy `register()` + logger           | `multi-tenancy-plugin/src/plugin/multi-tenancy-plugin.ts:165`, `:236` | `register(ctx)` is the hook, and `ctx.logger` is already read there — so a startup warning has a home and needs no new seam.                                    |
| `JwtResolver`'s own warning             | `multi-tenancy-plugin/src/resolvers/jwt-resolver.ts:11-13`            | "Resolves the tenant id from a claim in an **unverified** JWT payload. **Security note:** … unverified decode".                                                 |
| `setu add` argument handling            | `cli/src/commands/add.ts:167`                                         | `const requested = args.positionals[0];` — `positionals[1..]` are never inspected, refused or reported.                                                         |
| prerelease deletion rule                | `AI_GUIDELINES.md` §9 scope note                                      | At `0.x` a public export with no reader is DELETED, not deprecated, with CHANGELOG migration text. No deprecation dance is available or needed.                 |
| secure-defaults rule                    | `AI_GUIDELINES.md` §13.4                                              | "All security-related plugins must default to the most secure configuration" — the rule that makes `enforceRoles` default **on** mandatory, not a taste call.   |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                             | Resolution (picked side)                                                                                                                                                                                         | Doc deliverable (same PR)                                                                                                      |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| C1 | `decorators/security.ts:57` says `@Roles` "Requires the authenticated principal to hold any of the given roles"; the code enforces nothing.                                                                                                                                                                                          | The JSDoc wins — enforce it.                                                                                                                                                                                     | None needed for the claim itself; the JSDoc gains the `enforceRoles` caveat and the absent-capability behaviour.               |
| C2 | `multi-tenancy-plugin/README.md:43-49` says `'schema-per-tenant'` gives "one schema per tenant"; no shipped code creates a schema, and `interfaces/index.ts:149-150` says a store may ignore the strategy entirely.                                                                                                                  | The **source** wins — a strategy names the isolation an `ITenantDataStore` is expected to implement.                                                                                                             | Rewrite the isolation table; change the README's headline example (`:22`) from `'schema-per-tenant'` to `'column-per-tenant'`. |
| C3 | `PUBLIC_API.md:5559` carries the unverified-JWT note; `README.md:38` presents the four resolvers as equivalent and the option's JSDoc says only "Options forwarded to `JwtResolver`".                                                                                                                                                | Both are right and one is misplaced — move the warning to where the choice is made rather than restate it.                                                                                                       | README resolver list gains the caveat; `MultiTenancyPluginOptions.jwt` JSDoc gains it; a startup warning names it.             |
| C4 | The `ROADMAP.md` M89b section (:8786-8790) already reads "take the same status… answers `501`… keeps its existing `403` — already correct". Checked against `guards/index.ts:59-84`, the 403 path is already correct — what is wrong is the **absent-capability** case, which is a server misconfiguration and not a policy refusal. | Already resolved on `main` — nothing left to correct here. **This plan does not touch it**; M89b's plan owns the remaining doc half (its §2 C1), and §3.5 keeps the two refusal paths identical by construction. | Correction already shipped on `main`; the M89b deliverable stands in that plan's §5.                                           |
| C5 | `decorators/security.ts:101-102` calls `@Public` "authentication and authorization are bypassed" with "precedence over `@Roles`/`@Permissions`"; its only readers (`decorator-plugin.ts:382,395`, `metadata-store.ts:661`) emit `security: []` — nothing bypasses a guard.                                                           | The **source** wins — the same shape as C1, fail-safe direction. §3.7 corrects the JSDoc instead of enforcing a bypass.                                                                                          | The §5 `decorators/security.ts` row — the JSDoc rewrite, same PR.                                                              |
| C6 | `ROADMAP.md:8704-8706` says the warning "names every route whose restrictions are unenforced" — the wording describes the rejected warn-and-register-unguarded draft; under §3.5 nothing goes unenforced (the route answers `501`).                                                                                                  | §3.5's fail-closed decision wins (AI_GUIDELINES §13.4); the sentence is corrected when the status flips.                                                                                                         | New §5 row: `ROADMAP.md`.                                                                                                      |

## 3. Design decisions

### 3.1 Where the authorization middleware is appended

- **Decision:** a new `appendAuthorizationMiddleware(ctx, controller, ctrlMeta, route, middleware)`,
  called in `registerController` **after** `composeMiddleware` and **before**
  `appendValidationMiddleware`. The middleware it appends resolves `CAPABILITIES.AUTHORIZATION` from
  `ctx.services` **per request** — the capability is never captured at registration.
- **Why per request:** `requireRole` resolves the capability inside the guard, per request
  (`auth-plugin/src/guards/index.ts:71`), so capturing it at registration would make the decorated
  path diverge from the guard path — the one thing M89a exists to prevent. It also removes a
  contradiction the first draft carried: §3.5 argues against refusing `start()` partly because a
  provider may be registered later by an imperative call, and a captured capability could never see
  one, so such a route would answer `501` forever. Per-request resolution makes the refusal dynamic
  — it applies exactly while no provider exists. This is the M52b lesson in its general form: read a
  capability at call time, not at wiring time. The registration-time resolution survives **only** to
  decide whether to emit the startup warning.
- **Why this position in the chain:** it reproduces the band the validation append already documents
  — "LAST … so guard `401`/`403` decisions still precede any `400`" (`decorator-plugin.ts:462-467`).
  Authorization must run after a route's own guards (so an authentication `401` still wins) and
  before validation (so a `403` is not preceded by a `400` describing a body the caller was never
  entitled to submit).
- **Test home:** `test/unit/authorization-enforcement.test.ts` asserts the exact middleware order;
  `test/integration/roles-enforced.test.ts` asserts `401` → `403` → `400` precedence through a real
  kernel app.

### 3.2 How `@Permissions` "any" semantics is enforced

- **Decision:** `permissions.some((p) => authorization.hasPermission(user, p))`. No `common` change.
- **Why:** `@Permissions`'s own JSDoc says "**any** of the given permissions" (`security.ts:80`),
  and `IAuthorizationService` offers `hasPermission` (single) and `hasAllPermissions` (all) but **no
  `hasAnyPermission`** (`common/src/services/auth.ts:152-180`). Composing the single check is the
  committed surface; widening `common` for a helper the decorator can build is dead surface by §4's
  rule. `@Roles` maps directly onto `hasAnyRole`, which exists.
- **Test home:** `test/unit/authorization-enforcement.test.ts` — a principal holding the second of
  two declared permissions passes; one holding neither is refused.

### 3.2b Composition when a route declares BOTH `@Roles` and `@Permissions`

- **Decision:** **ALL-of across the two kinds, ANY-of within each.** A route carrying
  `@Roles('admin', 'owner')` and `@Permissions('billing:write', 'billing:admin')` admits a principal
  holding (any of those roles) **AND** (any of those permissions). Two middleware entries are
  appended, roles first, so the refusal names the restriction that actually failed.
- **Why:** `RouteMetadata` can carry both independently (`metadata-store.ts:328-336` merges `roles`
  and `permissions` as separate fields), so the composition is a real decision and the plan did not
  make it. Three reasons pick AND. The guard equivalent is unambiguously AND —
  `@UseGuards(requireRole('admin'), requirePermission('billing:write'))` runs both in sequence and
  every one must pass — and M89a's whole purpose is making the decorated form agree with the guard
  form. §13.4 makes the conservative reading the default for a security-related plugin. And an
  any-of reading across kinds would make **adding** a restriction to a route _weaken_ it, which no
  reader would predict.
- **Test home:** `test/unit/authorization-enforcement.test.ts` — a route declaring both admits a
  principal satisfying both; refuses one satisfying only the roles; refuses one satisfying only the
  permissions. `test/integration/roles-enforced.test.ts` pins that the guard spelling of the same
  pair answers identically.

### 3.3 Class-level versus method-level precedence

- **Decision:** method metadata overrides class metadata; the effective restriction is the route's
  own when present, the controller's otherwise. Never the union.
- **Why:** both decorators document exactly that ("May be applied at the class level (default for
  all routes) or method level (**overrides** the class default)", `security.ts:53-56`). The metadata
  store already merges this way for the fields it copies.
- **Test home:** `test/unit/authorization-enforcement.test.ts` — a class `@Roles('admin')` with a
  method `@Roles('viewer')` admits a viewer.

### 3.4 The `enforceRoles` option and its default

- **Decision:** `readonly enforceRoles?: boolean` on `DecoratorPluginOptions`, resolved `?? true`.
  `false` restores the pre-M89a behaviour (metadata recorded, nothing enforced) and silences the
  absent-capability warning.
- **Why:** §13.4 requires a security-related plugin to default to its most secure configuration, and
  the maintainer took this decision on 2026-09-03. The shape mirrors `enforceSchemas` (`:72-76`,
  `:695`) so the two read identically. It is a **breaking behaviour change** and takes CHANGELOG
  migration text.
- **Test home:** `test/unit/enforce-roles-option.test.ts` — default on; `false` reproduces the old
  behaviour byte-for-byte on the emitted `RouteDefinition`.

### 3.5 What happens when no authorization capability is registered

- **Decision:** **fail closed at request time.** The route is registered WITH a middleware that
  answers `501 Not Implemented / "Authorization is not configured"`, and `register()` additionally
  warns once per affected route naming the controller, the handler, the restriction and both
  remedies (register a provider, or set `enforceRoles: false`). Startup is **not** refused.
- **Why:** the first draft warned and registered the route **unguarded**, which is an authorization
  bypass — a route the developer declared as restricted serving every caller, with the only signal a
  startup log line. That it matches today's behaviour is not a defence: `enforceRoles: true` means
  "enforce", and "cannot enforce" is not "enforce nothing". Refusing `start()` was the other
  candidate and is rejected because it converts a misconfiguration into a total outage for an
  application that boots today, and because the decorator plugin cannot see whether an authorization
  provider is registered _later_ by an imperative call. Refusing the **request** is the only option
  that fails closed while causing neither a bypass nor an outage — and it is the same status and
  detail M89b gives the free-function guards for the identical condition, so the two paths agree by
  construction rather than by coincidence.
- **Cost, stated:** a route carrying `@Roles` in an application with no RBAC stops serving. That is
  the same breaking-change class as enforcement itself, which the maintainer approved defaulting on;
  `enforceRoles: false` restores the inert behaviour in one line, and the startup warning names it.
- **Test home:** `test/unit/enforce-roles-option.test.ts` (the warning fires once per route) and
  `test/integration/rbac-absent-decorated.test.ts` — through a real kernel app with no authorization
  provider, a decorated route answers `501` and the handler provably does not run.

### 3.6 The refusal's error shape

- **Decision:** `respondWithError(ctx, { status, title, detail })` from `common`, with
  `401 Unauthorized / "Authentication required"` for an absent principal and `403 Forbidden` for a
  failed check.
- **Why:** §2.2 forbids `decorator-plugin` importing `auth-plugin`, so `requireRole` itself cannot
  be reused; funnelling through the same `respondWithError` seam and the same status/title/detail
  strings is what makes a decorated route and a guarded route answer identically. The shared
  implementation is the **capability** (`IAuthorizationService`), which both call.
- **Test home:** `test/integration/roles-enforced.test.ts` drives a decorated route and a
  `@UseGuards(requireRole(...))` route in ONE application under a non-default `errorHandler` format
  and asserts byte-identical bodies.

### 3.7 `@Public()` stays documentation in this milestone

- **Decision:** no behaviour change. The JSDoc's two false sentences (the bypass claim and the
  precedence claim, C5) are replaced by a statement that it contributes `security: []` to the
  OpenAPI document and does **not** exempt a route from a guard.
- **Why:** measured, a `@Public()` route under a blanket authentication guard answers `401` — inert
  in the **fail-closed** direction, so it is a usability wart rather than a hole. Making it exempt
  is a security-relevant behaviour change that deserves its own decision, and bundling it with an
  enforcement change that turns refusals ON would put two opposite-direction changes in one release.
- **Test home:** `test/unit/public-decorator-docs.test.ts` pins that `@Public()` adds no middleware,
  so a later milestone changing that has a failing test to update.

### 3.8 The M57 brand on the appended middleware

- **Decision:** wrap the appended middleware in `withSecurityMetadata(fn, AUTHENTICATED)` from
  `common`.
- **Why:** it closes X18-3's second half for free. Measured, `security` is **absent** from the
  OpenAPI document for both decorated routes; branding makes M57's `deriveSecurity` see them, so the
  document stops under-reporting the application's own protection. `withSecurityMetadata` lives in
  `common/src/http.ts:621`, so no plugin-to-plugin import is involved.
- **Test home:** `test/integration/roles-enforced.test.ts` asserts the derived document carries a
  requirement for the decorated route when `deriveSecurity` is configured.

### 3.9 X18-5 — the isolation strategies

- **Decision:** documentation correction (C2) plus one `register()` warning when `database` resolves
  to a non-`column` strategy AND `dataStore` is absent. No code change to the strategies, the store,
  or the plugin's behaviour.
- **Why:** the architecture is deliberate — a store may ignore isolation metadata — so the defect is
  the README's unqualified promise and the pairing that cannot possibly honour it. Warning at
  `register()` catches the exact composition the README's own headline example produced.
- **Test home:** `test/unit/isolation-strategy-warning.test.ts` — warns for `'schema-per-tenant'`
  with no `dataStore`, silent with one supplied, silent for `'column-per-tenant'`.

### 3.10 X18-4 — the unverified-JWT warning

- **Decision:** one `register()` warning when the resolved chain contains a `JwtResolver`, stating
  that tenant identity comes from an unverified claim and naming the precondition. Plus the README
  and option-JSDoc text (C3).
- **Why:** the code is honest and the placement is wrong; a warning fires at the moment the choice
  takes effect and cannot be missed, which no document placement achieves.
- **Test home:** `test/unit/jwt-resolver-warning.test.ts` — warns for `resolver: 'jwt'` and for a
  chain containing one; silent otherwise.

### 3.11 X18-1 — `setu add` refuses extra positionals

- **Decision:** a second positional is a usage error:
  `setu add takes one package; got N. Run it once per package.` Exit `EXIT_USAGE`, write nothing.
- **Why:** the documented contract is singular and every other misapplied input in this CLI is
  refused by name; accepting arguments it silently discards is the one place it does not. Accepting
  a list instead would widen a published command and grow `--dry-run`'s report — larger than the
  defect.
- **Test home:** `test/unit/commands/add.test.ts` — two positionals exit 2 and the manifest is
  untouched; one positional is unchanged.

## 4. Exported surface — every symbol names its consumer

No package's `src/index.ts` gains or loses a symbol. Every change is internal behaviour, a new
**option** on an already-exported factory's options type, or documentation.

| Exported symbol                     | Kind      | Consumer / real code path that READS it                                                                                                     |
| ----------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| None added                          | —         | Checked: the enforcement lives in `decorator-plugin/src/plugin/`, unexported; the two warnings are internal to their plugins' `register()`. |
| `DecoratorPluginOptions` (existing) | interface | Gains `enforceRoles?`; read by `registerController` at `decorator-plugin.ts:695`'s resolution site.                                         |

A `barrel-exports.test.ts` per touched package pins that the published surface is unchanged — the
M56 defect class, where dropping an export left 18 tests green because none imported the barrel.

### 4.1 Options — every option names its consumer

| Option                                | Consumer                                                                 | Behavior (per implementation)                                                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DecoratorPluginOptions.enforceRoles` | `registerController` (`decorator-plugin.ts:~695` resolution, `~611` use) | `true`/absent: append authorization middleware per route carrying a restriction, warn when the capability is absent. `false`: append nothing, warn nothing — the pre-M89a behaviour.          |
| No new tenancy option                 | —                                                                        | Checked: the X18-5 and X18-4 warnings derive from `database`/`dataStore`/`resolver`, all already present. Adding a silence-the-warning option would be an option no correct application sets. |
| No new CLI flag                       | —                                                                        | Checked: X18-1 is a refusal, not a mode.                                                                                                                                                      |

## 5. Implementation files

| File                                                               | Purpose                                                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `packages/decorator-plugin/src/plugin/decorator-plugin.ts`         | `enforceRoles` option + resolution; `appendAuthorizationMiddleware`; `warnUnenforcedRestrictions`; call-order edit.      |
| `packages/decorator-plugin/src/plugin/authorization-middleware.ts` | The middleware factory: principal check, `hasAnyRole` / `some(hasPermission)`, `respondWithError`, M57 brand.            |
| `packages/decorator-plugin/src/decorators/security.ts`             | JSDoc only — the `enforceRoles` caveat on `@Roles`/`@Permissions`, and the C5 `@Public` JSDoc correction (§3.7).         |
| `packages/decorator-plugin/README.md`                              | The "Security" section stops implying enforcement is unconditional; states the option and the absent-capability warning. |
| `packages/multi-tenancy-plugin/src/plugin/multi-tenancy-plugin.ts` | The two `register()` warnings (§3.9, §3.10).                                                                             |
| `packages/multi-tenancy-plugin/src/interfaces/index.ts`            | JSDoc on `database` and `jwt` — what a strategy names, and the unverified-claim caveat.                                  |
| `packages/multi-tenancy-plugin/README.md`                          | C2 and C3: the isolation table, the headline example, the resolver list.                                                 |
| `packages/cli/src/commands/add.ts`                                 | Refuse a second positional (§3.11).                                                                                      |
| `ROADMAP.md`                                                       | C6: the warning-semantics sentence (`unenforced` → fails closed), corrected when the status flips.                       |
| `PUBLIC_API.md`                                                    | `enforceRoles`; the `@Roles`/`@Permissions` enforcement statement; the isolation-strategy correction.                    |
| `CHANGELOG.md`                                                     | The breaking behaviour change with migration text, plus the three fixes.                                                 |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                           | src covered                                     | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decorator-plugin/test/unit/authorization-enforcement.test.ts`      | `plugin/authorization-middleware.ts`            | `hasAnyRole(user, roles)` and `some(hasPermission(user, p))` against `IAuthorizationService` (`common/src/services/auth.ts:152-180`); absent principal → 401; failed check → 403; method-overrides-class (§3.3).                                                                                                |
| `decorator-plugin/test/unit/enforce-roles-option.test.ts`           | `plugin/decorator-plugin.ts` (option + warning) | Default `true`; `false` leaves `RouteDefinition.middleware` byte-identical to pre-M89a; absent capability warns once per route naming controller/handler/restriction.                                                                                                                                           |
| `decorator-plugin/test/unit/public-decorator-docs.test.ts`          | `decorators/security.ts`                        | `@Public()` contributes no middleware (§3.7), so a later exemption change has a failing test to update.                                                                                                                                                                                                         |
| `decorator-plugin/test/integration/roles-enforced.test.ts`          | the whole path, through `createApplication`     | A `viewer` is refused `403` on `@Roles('admin')` and admitted on `@Roles('viewer')`; **the control**: `@UseGuards(requireRole('admin'))` on the same app refuses identically, byte-for-byte, under a non-default `errorHandler` format; ordering `401` → `403` → `400`; `deriveSecurity` sees the brand (§3.8). |
| `decorator-plugin/test/unit/barrel-exports.test.ts` (extend)        | `src/index.ts`                                  | The published surface is unchanged (M56 defect class).                                                                                                                                                                                                                                                          |
| `multi-tenancy-plugin/test/unit/isolation-strategy-warning.test.ts` | `plugin/multi-tenancy-plugin.ts`                | Warns for a non-`column` strategy with no `dataStore`; silent with one; silent for the default.                                                                                                                                                                                                                 |
| `multi-tenancy-plugin/test/unit/jwt-resolver-warning.test.ts`       | `plugin/multi-tenancy-plugin.ts`                | Warns for `resolver: 'jwt'` and for a chain containing a `JwtResolver`; silent otherwise.                                                                                                                                                                                                                       |
| `multi-tenancy-plugin/test/unit/barrel-exports.test.ts` (extend)    | `src/index.ts`                                  | Unchanged surface.                                                                                                                                                                                                                                                                                              |
| `cli/test/unit/commands/add.test.ts` (extend)                       | `commands/add.ts`                               | Two positionals → exit 2, manifest untouched; one positional unchanged; the message names the count.                                                                                                                                                                                                            |
| `test/fixtures/snippets/*` (extend)                                 | the corrected README/PUBLIC_API fences          | The M38/M70k fence gates compile every changed example, so a corrected doc cannot ship uncompilable.                                                                                                                                                                                                            |

No external dependency is added, so no guarded real-import test is required. The integration test is
the one that matters and is the finding's own control: two routes expressing one restriction two
ways, in one application, must now agree.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m89a-declarations-that-enforce-nothing, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # committed tree; a slow type or a broken export blocks publish
deno task release:verify 0.3.0
```

Beyond the gates, per CLAUDE.md's "Before reporting a task done": boot a scaffolded
`--template class-based` project with a generated module, drive a decorated route with an
insufficient principal, and confirm the refusal — because M58 shipped a `g controller` whose every
route answered 500 for five releases behind tests that asserted decorator presence.

## 8. Risks & mitigations

- **Turning enforcement on breaks a passing suite somewhere.** → Intended, and the CHANGELOG says so
  with migration text; `enforceRoles: false` is the one-line restore. The startup warning gives an
  application with no RBAC a signal instead of a surprise.
- **An application with no RBAC provider finds its decorated routes answering `501` after upgrade.**
  → §3.5's stated cost. It is the failing-closed direction, the warning names both remedies at
  startup, and `enforceRoles: false` is the escape hatch. The rejected alternative — registering the
  route unguarded — is an authorization bypass, which is a worse outcome than a loud refusal.
- **The decorated refusal and the guard refusal drift**, since §2.2 forbids sharing the guard
  function. → Mitigated by sharing the _capability_ and the `respondWithError` seam, and pinned by
  an integration test that asserts byte-identical bodies under a non-default error format. That test
  is the only thing that can catch drift, so it is not optional.
- **A route carrying both a class and a method restriction is enforced with the wrong one.** →
  §3.3's decision is taken from the decorators' own JSDoc and has its own test; the union is never
  used.
- **The tenancy warnings become noise** for an application that has deliberately supplied a custom
  store. → Both warnings are conditioned on the pairing that cannot work (`non-column` + no
  `dataStore`), not on the strategy alone.
- **A doc correction ships uncompilable.** → The M38/M70k fence gates already compile package
  READMEs and `PUBLIC_API.md`; the changed fences go through them.

## 9. Out of scope

- **X18-2 and X19-1** — masked-500 refusals; **M89b**, which owns the guard-side `501` (C4; the
  ROADMAP half already landed on `main`).
- **X16-1 and X16-2** — the `0.3.0` ingress surface; **M89c**.
- **A `DatabasePlugin`-backed `ITenantDataStore`** that actually realises `resolveSchema` — the
  composition the multi-tenancy README's table describes. Unowned; X19 left the seven-backend
  project standing specifically so a later milestone can answer whether it can be written at all.
- **Making `@Public()` exempt a route from a guard** — §3.7. Unowned; it is fail-closed today.
- **`hasAnyPermission` on `IAuthorizationService`** — §3.2 composes the committed surface instead,
  so the widening would be dead surface.
