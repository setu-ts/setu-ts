# Milestone 57 — Derived OpenAPI security (`@setu-ts/common`, `@setu-ts/auth-plugin`, `@setu-ts/openapi-plugin`)

> **Status:** Planning. Branch: `feat/m57-derived-openapi-security`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.
>
> **Stacked on `fix/openapi-spec-defects` (PR #136), not on `main`.** That branch adds
> `RouteSchema.security`, `SecurityRequirement`, and the generator's per-operation `security`
> emission, all of which this milestone reads. The PR base is `fix/openapi-spec-defects` and
> retargets to `main` automatically when #136 merges.

## 0. Objective & scope

PR #136 made an operation's security requirement **declarable**, and that left the OpenAPI document
as a second source of truth: a route can carry `requireAuth()` and declare `security: []`, or carry
no guard and inherit a document-level requirement, and nothing in the framework objects. This
milestone lets the document be **derived** from the guards that actually enforce authentication.
`auth-plugin` brands the middleware its guard factories return with a metadata symbol exported from
`common`; `openapi-plugin` reads that brand off `RouteInfo.definition.middleware` and emits the
operation's `security` from it. No plugin imports another plugin — the symbol in `common` is the
whole channel, on the `TELEMETRY_CONTEXT_OPAQUE` precedent.

- **In scope:** a `SECURITY_METADATA` symbol + `RouteSecurityMetadata` type + the pure
  `withSecurityMetadata`/`securityMetadataOf` helpers in `common`; branding all six `auth-plugin`
  guard factories; a `deriveSecurity` option on `openapi-plugin` that turns the brand into an
  operation-level `security`; precedence over and under the existing declared/document-level forms;
  docs and CHANGELOG.
- **NOT this milestone:** expressing **roles and permissions** in the document (see §9 — OpenAPI has
  no vocabulary for them and inventing an `x-` extension is a separate decision); deriving from
  **application-level** middleware added via `app.middleware.add()` (§9); branding guards in any
  package other than `auth-plugin` (§9); changing any default — `deriveSecurity` is opt-in, so an
  application that does not set it produces a byte-identical document.

## 1. Contracts verified from SOURCE (not names)

| Reference                      | Source (file:line)                                              | Verified surface / fact                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `MiddlewareFunction`           | `packages/common/src/http.ts:260`                               | `(ctx: IRequestContext, next: NextFunction) => void \| HandlerResult \| Promise<void \| HandlerResult>` — a plain function type, no marker    |
| `RouteDefinition.middleware`   | `packages/common/src/http.ts:374`                               | `readonly middleware?: readonly MiddlewareFunction[]` — OPTIONAL, so the generator must handle its absence                                    |
| `RouteInfo`                    | `packages/common/src/plugin.ts:57-64`                           | `{ method, path, definition }` — `definition` is the full `RouteDefinition`, so `middleware` IS reachable from `listRoutes()`                 |
| `Router.listRoutes()`          | `packages/kernel/src/router/router.ts:240-246`                  | maps `entry.pattern` verbatim; NO normalization. A `GroupRouter` stores `prefix + path` (`router.ts:265-268`), so patterns are fully resolved |
| `TELEMETRY_CONTEXT_OPAQUE`     | `packages/common/src/services/telemetry.ts:63`                  | `export const X: unique symbol = Symbol.for('he.telemetry.context')` — the committed precedent for a cross-package symbol channel in `common` |
| `RouteSchema.security`         | `packages/common/src/http.ts:343`                               | `readonly security?: readonly SecurityRequirement[]` — added by PR #136; optional, and `[]` means public                                      |
| `SecurityRequirement`          | `packages/common/src/http.ts:365`                               | `Readonly<Record<string, readonly string[]>>` — added by PR #136                                                                              |
| generator security emission    | `packages/openapi-plugin/src/generators/…:356`                  | `...(schema?.security !== undefined ? { security: schema.security } : {})` — the exact line derived values must slot beside, preserving `!==` |
| `#createOperation`             | `packages/openapi-plugin/src/generators/…:321`                  | `(route: RouteInfo, openApiPath: string)` — already receives the whole `RouteInfo`, so no signature change is needed to reach `middleware`    |
| guard factories                | `packages/auth-plugin/src/guards/index.ts:20,45,80,115,153,191` | `requireAuth`, `requireRole`, `requirePermission`, `requireAnyRole`, `requireAllPermissions`, `publicRoute` — all return `MiddlewareFunction` |
| guard opacity (probed)         | measured, this session                                          | `requireAuth()` → `name === ''`, `length === 2`, zero own properties, zero own symbols — identical to any other middleware                    |
| `buildRouteSchema` (decorator) | `packages/decorator-plugin/src/plugin/…:376`                    | emits `security: []` from `@Public` (PR #136). Decorated routes therefore already have a declared value, which §3.3 precedence must respect   |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                | Resolution (picked side)                                                                                                                                                          | Doc deliverable (same PR)                                                             |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| C1 | PR #136's `RouteSchema.security` JSDoc says "Declaring this does not enforce anything", which reads as though declaration is the ONLY way a document learns about auth. After this milestone it is not. | Keep the non-enforcement sentence (still true) and add that a requirement may instead be DERIVED from branded guards when `deriveSecurity` is configured.                         | `packages/common/src/http.ts` JSDoc + the PUBLIC_API `RouteSchema.security` note.     |
| C2 | `packages/openapi-plugin/README.md` (PR #136) tells the reader that declaring `security` per route is how an operation is marked protected — with no mention that guards can supply it.                 | Add the derived path as the recommended default for applications using `auth-plugin`, keeping the declared form as the override and the only option for non-`auth-plugin` guards. | `packages/openapi-plugin/README.md` "Documenting authentication" section.             |
| C3 | `ROADMAP.md` has no M57 section and no `57` Progress row (checked: `grep -n "M57\|Milestone 57"` returns nothing).                                                                                      | Add both, describing the derived-security capability and naming the roles/permissions gap as explicitly out of scope.                                                             | `ROADMAP.md` M57 section + Progress Tracking row; `CLAUDE.md` "Current status" entry. |

## 3. Design decisions

### 3.1 The cross-package channel is a symbol-keyed property on the middleware function

- **Decision:** `common` exports
  `SECURITY_METADATA: unique symbol = Symbol.for('setu.security.metadata')` and a
  `RouteSecurityMetadata` interface. `auth-plugin` attaches the metadata to the function object its
  guard factories return; `openapi-plugin` reads it back. Both go through two pure helpers in
  `common` — `withSecurityMetadata(fn, metadata)` and `securityMetadataOf(fn)` — so neither plugin
  spells the symbol read itself.
- **Why:** AI_GUIDELINES §2.2 forbids `openapi-plugin` importing `auth-plugin`, and the probe in §1
  shows a guard is otherwise indistinguishable from any other middleware (empty `name`, arity 2, no
  own properties). `Symbol.for` in `common` is the committed precedent (`TELEMETRY_CONTEXT_OPAQUE`)
  and survives two copies of `common` in one process, which a `unique symbol` from `Symbol()` would
  not. Helpers rather than a raw symbol read keep §11.1 (one implementation) and give the brand a
  single documented shape.
- **Test home:** `common/test/unit/security-metadata.test.ts` — round-trips a branded function and
  asserts an unbranded one reads `undefined`.

### 3.2 The metadata carries authentication presence ONLY

- **Decision:** `RouteSecurityMetadata` is `{ readonly authenticated: boolean }`. `requireAuth`,
  `requireRole`, `requirePermission`, `requireAnyRole` and `requireAllPermissions` brand
  `{ authenticated: true }`; `publicRoute` brands `{ authenticated: false }`. Roles and permissions
  are NOT carried.
- **Why:** an OpenAPI security requirement names a **scheme**, not a role, and no declared scheme
  can be inferred from the string `'admin'`. A `roles` field on the metadata would be read by
  nothing on a real code path, which is exactly the dead-surface defect the self-review checklist
  names. The `false` arm is not dead: it is what lets `publicRoute()` produce `security: []`.
- **Test home:** `auth-plugin/test/unit/guard-security-metadata.test.ts` — asserts the branded value
  for each of the six factories, including that `requireRole('admin')` carries no role.

### 3.3 Precedence: declared beats derived beats document-level

- **Decision:** for each operation the generator resolves, in order — (1) `schema.security` present
  (including `[]`) → use it verbatim; (2) else `deriveSecurity` configured AND at least one branded
  middleware on the route → emit `[{ [scheme]: [] }]` when any brand says `authenticated: true`,
  else `[]`; (3) else emit no operation-level key, leaving the document-level `security` to apply.
- **Why:** (1) preserves PR #136's behaviour byte-for-byte for every route that declares, so this
  milestone cannot change an existing document — including every `@Public` decorated route, which
  `buildRouteSchema` already gives a declared `[]` (§1). (2) makes `true` win over `false` because
  that matches enforcement: middleware run in order and `publicRoute()` only calls `next()`, so a
  route carrying both still 401s. (3) is the untouched pre-existing path.
- **Test home:** `openapi-plugin/test/unit/openapi-generator.test.ts` — one case per numbered arm,
  plus the both-brands case.

### 3.4 The scheme name is configured explicitly, never inferred

- **Decision:** the option is `deriveSecurity?: { readonly scheme: string }`. There is no boolean
  form and no inference from a single-entry `securitySchemes`.
- **Why:** `requireAuth()` cannot know whether the document calls its scheme `bearerAuth`, `jwt` or
  `token` — that is `openapi-plugin` configuration. Inferring from "there is exactly one scheme"
  would silently change meaning when a second scheme is added later, and a boolean form would need
  an ambiguity throw that the explicit form makes unreachable. One arm, no ambiguity, nothing to
  fail fast about beyond §3.5.
- **Test home:** `openapi-plugin/test/integration/openapi-integration.test.ts` — a two-scheme
  document derives against the named one.

### 3.5 An undeclared derived scheme is refused at `register()`

- **Decision:** `OpenApiPlugin.register` extends the PR #136 guard to `deriveSecurity.scheme`,
  throwing when the name is absent from `securitySchemes`.
- **Why:** identical failure mode to the document-level case that guard already covers — emitting a
  requirement naming an undeclared scheme produces a document that is invalid per the specification,
  and nothing downstream detects it because the spec endpoint still answers `200`.
- **Test home:** `openapi-plugin/test/integration/openapi-integration.test.ts` — `app.start()`
  rejects naming the scheme.

### 3.6 Only route-level middleware is inspected

- **Decision:** the generator reads `route.definition.middleware` and nothing else. Middleware added
  through `app.middleware.add()` is not consulted, and this is stated in the option's JSDoc, the
  README and PUBLIC_API rather than left to discovery.
- **Why:** `RouteInfo` carries no application-level middleware (§1), so it is not reachable. It is
  also not a loss: `authMiddleware()` POPULATES `ctx.request.user` and never rejects, so it is not a
  guard and marking every route protected because it is registered would be wrong.
- **Test home:** `openapi-plugin/test/integration/openapi-integration.test.ts` — an app with global
  `authMiddleware()` and no route guard derives nothing.

## 4. Exported surface — every symbol names its consumer

| Exported symbol         | Kind      | Consumer / real code path that READS it                                                                               |
| ----------------------- | --------- | --------------------------------------------------------------------------------------------------------------------- |
| `SECURITY_METADATA`     | symbol    | `withSecurityMetadata`/`securityMetadataOf` in `common`; exported so a non-`auth-plugin` guard can brand itself       |
| `RouteSecurityMetadata` | interface | the parameter type of `withSecurityMetadata` and the return type of `securityMetadataOf`; `auth-plugin` constructs it |
| `withSecurityMetadata`  | function  | all six `auth-plugin` guard factories (`packages/auth-plugin/src/guards/index.ts`)                                    |
| `securityMetadataOf`    | function  | `OpenApiGenerator.#deriveSecurity` (`packages/openapi-plugin/src/generators/openapi-generator.ts`)                    |

### 4.1 Options — every option names its consumer

| Option                  | Consumer                                                                  | Behavior (per implementation)                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deriveSecurity.scheme` | `OpenApiGenerator.#deriveSecurity`; validated in `OpenApiPlugin.register` | Names the `securitySchemes` key emitted for a route whose branded middleware requires authentication. Omitting `deriveSecurity` disables derivation entirely. |

## 5. Implementation files

| File                                                          | Purpose                                                                                                        |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/http.ts`                                 | `SECURITY_METADATA`, `RouteSecurityMetadata`, `withSecurityMetadata`, `securityMetadataOf`; C1 JSDoc amendment |
| `packages/common/src/index.ts`                                | barrel exports for the four new symbols                                                                        |
| `packages/auth-plugin/src/guards/index.ts`                    | brand all six guard factories via `withSecurityMetadata`                                                       |
| `packages/openapi-plugin/src/generators/openapi-generator.ts` | `deriveSecurity` on `OpenApiGeneratorOptions`; `#deriveSecurity(route)` read by `#createOperation` per §3.3    |
| `packages/openapi-plugin/src/plugin/openapi-plugin.ts`        | destructure + thread `deriveSecurity`; extend the §3.5 register guard                                          |
| `packages/openapi-plugin/src/services/openapi-service.ts`     | thread `deriveSecurity` through `#makeGeneratorOptions`                                                        |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                         | src covered                                          | Key assertions (and the signature each call type-checks against)                                                                                                                             |
| --------------------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/security-metadata.test.ts`                             | `common/src/http.ts` (new helpers)                   | `withSecurityMetadata(fn, { authenticated: true })` returns a callable that still satisfies `MiddlewareFunction`; `securityMetadataOf` round-trips it and returns `undefined` for a plain fn |
| `packages/common/test/unit/index.test.ts` (extended)                              | `common/src/index.ts`                                | the four new symbols are reachable from the barrel (the M56 barrel-export lesson)                                                                                                            |
| `packages/auth-plugin/test/unit/guard-security-metadata.test.ts`                  | `auth-plugin/src/guards/index.ts`                    | each of the six factories carries the expected `{ authenticated }`; `requireRole('admin')` carries no role field; every branded value still WORKS as a guard (401/403 behaviour unchanged)   |
| `packages/openapi-plugin/test/unit/openapi-generator.test.ts` (extended)          | `openapi-plugin/src/generators/openapi-generator.ts` | §3.3 arms 1–3 + both-brands; `deriveSecurity` absent ⇒ no derived key; a route with no `middleware` array at all (the `RouteDefinition.middleware` optionality from §1)                      |
| `packages/openapi-plugin/test/integration/openapi-integration.test.ts` (extended) | plugin + service threading                           | end-to-end through `createApplication` + `inject`: real `requireAuth()` derives, real `publicRoute()` derives `[]`, §3.4 two-scheme case, §3.5 refusal, §3.6 global-middleware case          |

No external dependency is added, so no guarded real-import test applies — but the integration tests
drive the REAL `auth-plugin` guards rather than hand-branded fakes, which is what proves the two
packages agree on the symbol.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m57-derived-openapi-security, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # committed tree
deno task release:verify 0.1.0-alpha.5
```

## 8. Risks & mitigations

- A second copy of `common` in one process would make a `Symbol()`-created key unmatchable →
  `Symbol.for` uses the global registry, so both copies resolve the same symbol. This is the failure
  mode M37c hit with hand-written React Router context keys, and the mitigation is the same one.
- Branding mutates the function object a guard factory returns, so a caller holding that reference
  sees a new own property → the property is symbol-keyed, so it is invisible to `Object.keys`,
  `JSON.stringify` and spread; the guard tests assert the branded functions still behave
  identically.
- Derivation could silently change an existing document → it cannot: `deriveSecurity` is opt-in and
  §3.3 arm 1 gives any declared value priority. A test pins that a default-options app produces the
  same document before and after.
- A reader could believe roles are documented because guards are now visible → §3.2 keeps them off
  the metadata, and §9 plus the README state the limit explicitly.

## 9. Out of scope

- **Roles and permissions in the document.** OpenAPI security requirements name schemes and scopes;
  a role is neither. Emitting `x-required-roles` is a real option but a separate decision about
  extension members, and would need its own PUBLIC_API surface — deferred, unowned, and named here
  so it is not mistaken for an oversight.
- **Deriving from application-level middleware** (`app.middleware.add()`), which `RouteInfo` does
  not expose (§3.6). Would require a kernel change to `IRouterApi`/`RouteInfo`; unowned.
- **Branding guards outside `auth-plugin`** — `feature-flags-plugin`'s `createFlagGuard` and
  `session-plugin`'s `csrfFormMiddleware` short-circuit too, but neither maps to an OpenAPI security
  scheme. Unowned.
- **A consistency check between guards and declared security** (warn when a route has a branded
  guard but declares `security: []`). Tempting, but the declared form is also the documented
  override for a route whose guard does not brand, so a warning would fire on correct
  configurations. Unowned.
