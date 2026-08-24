# Milestone 70n — Decorators, validation and the alpha.8 closeout sweep

> **Status:** Planning. Branch: `feat/m70n-decorators-di-docs`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

`@ValidateBody(schema)` validates nothing and `@Body()` throws the validated value away, so the
decorator surface the framework advertises as its NestJS-familiar path cannot validate a request at
all: a decorated route accepts any body, and a route that pairs a decorator with explicit
`validateBody(...)` middleware validates the body and then hands the handler the raw one. Those two
rows (E1, E2) are this milestone's substance. It then closes the eighteen remaining alpha.8 register
rows that no other M70 workstream absorbs.

**A scope finding the ROADMAP line does not record, raised here rather than absorbed silently.** The
line calls the eighteen "mechanical documentation rows". Source-checking every one says otherwise:
**ten are code changes**, spanning `static-plugin`, `auth-plugin`, `session-plugin`, `audit-plugin`,
`react-router-plugin`, `realtime-backplane-plugin`, `common`, `sse-plugin`, `messaging-plugin` and
`starters`; three of those widen a committed `common` contract. Two more are already closed by
merged milestones and must not be re-done. The plan below carries the full assigned scope with each
row's true nature named, and §9 records the one row this plan recommends the maintainer reassign
rather than land here (X2-6, broker trace propagation, which is a feature milestone wearing a
register row's clothes).

- **In scope:** E1 (decorator validation is enforced), E2 (`@Body`/`@Query`/`@Param` read the
  validated value), and the closeout of C2, X3-1, X3-3, X3-4, X3-5, X3-6, X3-8, X3-9, X4-5, X4-7,
  X4-11, X5-5, X5-7, X5-9, X7-9, X9-10, D8 — plus the four per-workstream doc deliverables the
  ROADMAP's "Doc Deliverables" section mandates for every M70 PR.
- **Already closed — verified against source, NOT re-done:** **C1** closed by M70m (PR #181):
  `packages/validation-plugin/src/index.ts:16`, its README, `ARCHITECTURE.md:1938` and five
  `PUBLIC_API.md` sites all read `validated:body` now; `grep -rn "validatedBody" packages/ docs/`
  returns nothing. **X8-8** closed by M70k (PR #178), with
  `test/package-readme-fence-compiler.test.ts` as its gate. Both rows' Status columns in
  `smoke/DEFECTS.md` are stale and get corrected by this PR.
- **NOT this milestone:** X2-6 (broker trace propagation) — see §9. Every row already marked
  `closed · M70<x>` in the register. The `v0.1.0-alpha.9` release itself, which
  [`docs/releasing.md`](../docs/releasing.md) owns.

## 1. Contracts verified from SOURCE (not names)

Every row below was opened and read. No entry rests on a name.

| Reference                               | Source (file:line)                                                                                            | Verified surface / fact                                                                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IValidationService`                    | `packages/common/src/services/validation.ts:47,65`                                                            | Exactly two members: `validate<T>(schema, data): Result<T, readonly ValidationIssue[]>` and `middleware(schema, target): MiddlewareFunction`. The second is the entire seam E1 needs — no import required. |
| `ValidationTarget`                      | `packages/common/src/services/validation.ts:18`                                                               | `'body' \| 'query' \| 'params' \| 'headers' \| 'cookies'`. Note `params` is plural while the decorator metadata type is `'param'` singular — the mapping is explicit, not identity.                        |
| `CAPABILITIES.VALIDATION`               | `packages/common/src/tokens.ts:47`                                                                            | `'validation'`. Committed; no new token needed for E1.                                                                                                                                                     |
| Validated-value state key               | `packages/validation-plugin/src/middleware/validation-middleware.ts:172`                                      | `ctx.state.set(`validated:${target}`, result.value)` — a template literal built inline. This is the ONLY writer in `packages/*/src` (checked by grep); no shared helper exists to read it back.            |
| `IRequestContext.state`                 | `packages/common/src/http.ts:231`                                                                             | `readonly state: Map<string, unknown>` — a real `Map`, so `has`/`get` are available to E2 with no contract change.                                                                                         |
| `RouteSchema`                           | `packages/common/src/http.ts:322-336`                                                                         | Carries `body`, `query`, `params`, `headers`, `response`, `tags`, `summary`. `cookies` does NOT exist. `headers` exists with no decorator producing it.                                                    |
| `buildRouteSchema`                      | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:353`                                                | Maps only `schema.body`/`query`/`params` into `RouteSchema`. Its output is the route's DESCRIPTION; nothing enforces it.                                                                                   |
| `composeMiddleware`                     | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:309`                                                | Returns guards → route guards → interceptors → middleware → filters. Reads `ctrl`/`route` metadata only; never touches `route.schema`. This is why E1 exists.                                              |
| `registerController` / `routeDef`       | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:486,499`                                            | `RouteDefinition` is `{ handler, middleware?, schema? }`. The single site where a validation middleware must be appended.                                                                                  |
| `DecoratorPlugin` priority              | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:564`                                                | `PLUGIN_PRIORITY.LOW` = 900.                                                                                                                                                                               |
| `ValidationPlugin` priority             | `packages/validation-plugin/src/plugin/validation-plugin.ts:87-88`                                            | `provides: [CAPABILITIES.VALIDATION]`, `priority: PLUGIN_PRIORITY.HIGH` = 100. So it already registers before decorator-plugin by priority alone.                                                          |
| `resolvePluginOrder`                    | `packages/kernel/src/registry/plugin-resolver.ts:19,46-53`                                                    | Dependency edges are honoured FIRST, then priority, then registration order; `optionalDependencies` contribute a real edge when a provider exists. Confirms the §3.3 register-time resolution is sound.    |
| `resolveParameter` body arm             | `packages/decorator-plugin/src/resolvers/parameter-resolver.ts:97`                                            | `case 'body': return ctx.request.json();` — the E2 defect, one line.                                                                                                                                       |
| `classifyCustom`                        | `packages/decorator-plugin/src/resolvers/parameter-resolver.ts`                                               | Single source of truth for request-time resolution AND the M64 startup check. E2 must not fork it.                                                                                                         |
| `withValidationMetadata`                | `packages/common/src/http.ts:678`                                                                             | M70m's brand. `createValidationMiddleware` applies it, so a middleware E1 obtains through `IValidationService.middleware` is already branded — openapi-plugin's derived path stays consistent for free.    |
| `IMMUTABLE_PATTERN`                     | `packages/static-plugin/src/http/cache-control.ts:12`                                                         | `/[.-][0-9a-f]{8,}\.[a-z0-9]+$/i` — hex-only. The C2 defect.                                                                                                                                               |
| `resolveCacheControl` callback argument | `packages/static-plugin/src/handler/static-handler.ts:96-103`                                                 | `relativePath` is slash-LESS for a file (`'app.js'`) but the literal `'/'` when the request equals the prefix. Both shapes reach the callback. The D8 defect is that inconsistency, not just the wording.  |
| `PasswordHasher.verify`                 | `packages/auth-plugin/src/services/password-hasher.ts:48-53`                                                  | `verify(stored: string, secret: string)`; a `stored` that is not `pbkdf2$…` with 4 parts returns `false`. Two positional strings — the X3-9 defect — and the malformed branch is where the fix lands.      |
| Session cookie default                  | `packages/session-plugin/src/options.ts:15,190`                                                               | `DEFAULT_COOKIE_NAME = 'hono_session'`. The X9-10 defect.                                                                                                                                                  |
| CSRF `headerName`                       | `packages/session-plugin/src/options.ts:65,212,227`; `csrf/verify.ts:94-95`                                   | `headerName` is optional with NO default, and `verify` reads a header only when it is set — so `csrf: {}` can never accept a JSON mutation. The X4-5 defect.                                               |
| `audit-plugin` barrel                   | `packages/audit-plugin/src/index.ts:12-39`                                                                    | Exports the four storage classes and `IAuditDbClient`, but neither `StoredAuditEntry` nor `AuditQuery`. Confirmed by grep. The X4-7 defect — the exported classes' own signatures are unnameable.          |
| `IResponse`                             | `packages/common/src/http.ts:154`                                                                             | `text(body: string): HandlerResult` exists; there is no `html`. The X4-11 gap.                                                                                                                             |
| `SseMessage.data`                       | `packages/common/src/services/sse.ts:23-31`                                                                   | JSDoc already states the string/non-string split precisely; the X3-6 complaint is the TYPE, which is narrower than the documented behaviour.                                                               |
| SSE / WS scaling notice                 | `packages/sse-plugin/src/plugin/sse-plugin.ts:55-71`; `websocket-plugin/src/plugin/websocket-plugin.ts:74-78` | Both gate on `backplane === undefined`. The SSE comment ALREADY names the X3-4 defect ("registering it bare would silence this line without fanning anything out") and the code does not act on it.        |
| `react-router-plugin` asset handler     | `packages/react-router-plugin/src/assets/static-assets.ts:33,70`; `plugin/react-router-plugin.ts:144`         | Serves only under `assetUrlPrefix`; `public/` files land at the `build/client` ROOT, outside it. The X5-5 defect.                                                                                          |
| `FullStackStarterOptions`               | `packages/starters/full-stack-starter/src/options.ts:72`; `app.ts:49`                                         | Has a `reactRouter` arm; there is no `static` arm. The X5-9 gap.                                                                                                                                           |
| `MessageMetadata.headers`               | `packages/common/src/services/messaging.ts:21-22`                                                             | `readonly headers?: Readonly<Record<string, string>>` exists and no broker populates it. Confirms X2-6 is a feature, not a doc fix — see §9.                                                               |
| Prerelease deletion rule                | `AI_GUIDELINES.md` §9 scope note                                                                              | In `0.x`, a public export with no reader is DELETED, not deprecated, but a removal still needs CHANGELOG migration text. Governs X4-7 and §3.9.                                                            |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                              | Resolution (picked side)                                                                                                                                                                        | Doc deliverable (same PR)                                                                                                                         |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `ROADMAP.md:7195` assigns C1 and X8-8 to this milestone; both are closed in merged `main` (M70m PR #181, M70k PR #178). `smoke/DEFECTS.md:58,117` still says `open` and `closed · M70k` respectively.                 | The source wins. C1 and X8-8 are not re-done. The register's C1 row is corrected to `closed · M70m`; the ROADMAP line is corrected to stop assigning them.                                      | `smoke/DEFECTS.md` C1 status; `ROADMAP.md:7195` row list edited to drop C1 and X8-8, with the closing PR named.                                   |
| C2 | `ROADMAP.md:7195` calls all eighteen rows "mechanical documentation rows"; ten are code changes and three widen `common`.                                                                                             | The source wins. The ROADMAP line is rewritten to describe what the rows are.                                                                                                                   | `ROADMAP.md` M70n row rewritten; a new M70n section recording the split and the X2-6 reassignment recommendation.                                 |
| C3 | `packages/decorator-plugin/src/decorators/validation.ts:1-7` module JSDoc says the schema "is enforced only when the ValidationPlugin … is registered" — which reads as a working integration, and none exists.       | The JSDoc described an intention. E1 makes it true; the wording is tightened to say exactly which targets are enforced and what happens when the plugin is absent.                              | `validation.ts` module JSDoc + the three decorators' JSDoc; `PUBLIC_API.md` decorator rows; `packages/decorator-plugin/README.md`.                |
| C4 | `ARCHITECTURE.md` §10 reserves priority 300 for `AuthMiddleware`, while every doc site writes a bare `app.middleware.add(authMiddleware())`, which the kernel defaults to 500 — after every row in that table (X3-1). | The table is right and the examples are wrong. Every doc site gains the explicit `{ priority: 300 }`. No kernel default changes: a default that special-cased one plugin's middleware is worse. | `packages/auth-plugin/README.md`, `PUBLIC_API.md` auth section, `docs/*` auth examples, `ARCHITECTURE.md` §10 note that the priority is explicit. |
| C5 | `static-plugin`'s `cacheControl` is documented as receiving a "root-relative path" (`cache-control.ts:41`, README:50) while the value is slash-less for a file and the literal `'/'` for the prefix root (D8).        | Normalise the VALUE to always carry a leading slash, and document that. A callback written against one observed shape is currently wrong for the other; picking one and stating it is the fix.  | `packages/static-plugin/README.md` options row + example, `PUBLIC_API.md` static section, `cache-control.ts` JSDoc; CHANGELOG breaking entry.     |
| C6 | `PUBLIC_API.md` shows `SessionPlugin({ csrf: {} })` as a registration while that configuration `403`s every JSON mutation forever (X4-5).                                                                             | The code is wrong: a CSRF feature whose documented registration cannot accept a JSON request has a broken default. `headerName` gains a default; the doc example stays valid.                   | `PUBLIC_API.md` session CSRF section, `packages/session-plugin/README.md`, CHANGELOG behaviour entry.                                             |
| C7 | Both realtime READMEs and `PUBLIC_API.md` present `RealtimeBackplanePlugin()` bare as the one-line fix for scaling, while bare defaults to the process-local `'memory'` transport (X3-4).                             | The docs are wrong AND the notice is misplaced. The backplane plugin itself reports a process-local transport; the docs stop presenting a bare call as a scaling fix.                           | `packages/realtime-backplane-plugin/README.md`, `websocket-plugin`/`sse-plugin` READMEs, `PUBLIC_API.md` backplane section.                       |

## 3. Design decisions

### 3.1 E1 — where the enforcing middleware comes from

- **Decision:** `registerController` resolves `CAPABILITIES.VALIDATION` from `ctx.services` and, for
  each of `route.schema.body`/`query`/`params` that is present, appends
  `service.middleware(schema, target)` to the route's middleware array. `decorator-plugin` gains
  `optionalDependencies: [CAPABILITIES.VALIDATION]` and imports nothing from `validation-plugin`.
- **Why:** `IValidationService.middleware` is a committed member
  (`common/src/services/validation.ts:65`) that already returns exactly the middleware needed, and
  it is the same implementation `validateBody(...)` reaches — so a decorated route and a
  middleware-configured route validate identically and share one error format, which is the
  one-capability-one-implementation rule. Re-implementing extraction and formatting inside
  `decorator-plugin` would duplicate `extractTarget` and the formatter resolution (§11.1) and would
  guarantee the two paths drift on `errorFormat`. `optionalDependencies` is the M45b/M47 shape; it
  contributes a real dependency edge (`plugin-resolver.ts:46-53`) so a REPLACEMENT validation
  provider registered at a higher priority number still lands first — priority alone happens to
  order these two correctly today (100 before 900) and that is a coincidence, not a guarantee.
- **Test home:** `test/integration/decorator-validation.test.ts` — a real kernel app with the real
  `ValidationPlugin` and a real Zod schema, asserting `400` for a bad body and `200` for a good one.

### 3.2 E1 — position in the route's middleware chain

- **Decision:** the validation middleware is appended LAST, after `composeMiddleware`'s filters, so
  it runs innermost — immediately before the handler.
- **Why:** guards must decide first. With validation ahead of a guard, an unauthenticated request to
  a decorated route answers `400` and its body names the schema's field paths, which discloses the
  request shape to a caller that was never authorised; running last preserves the `401`/`403`
  precedence the guards already have. Placing it inside the filters is the same reasoning applied to
  exception handling: a filter exists to wrap the handler, and validation is now part of what
  producing a response costs.
- **Test home:** `test/integration/decorator-validation.test.ts` — a route carrying both
  `@UseGuards` (rejecting) and `@ValidateBody` with a body that fails the schema must answer the
  guard's status, not `400`.

### 3.3 E1 — resolution timing, and the absent-plugin case

- **Decision:** resolve once during `register()`, guarded by `ctx.services.has`. When the capability
  is absent and a route carries a validation schema, log ONE warning per route naming the
  controller, the handler, the targets that will not be enforced, and `ValidationPlugin`. Never
  throw.
- **Why:** resolving per request would put a registry lookup on every decorated request for a value
  fixed at startup (§14, and the CLAUDE.md hoist-to-registration pitfall). A warning rather than a
  throw follows M64's precedent and the same reasoning: the decorators have shipped as inert since
  M9, an application may legitimately want the OpenAPI description without the enforcement, and
  turning a released no-op into a startup crash on upgrade is a worse failure than a named warning.
  The warning is what makes the inertness visible, which is the actual complaint in E1.
- **Test home:** `test/unit/plugin/validation-enforcement.test.ts` — asserts the warning's fields
  with no validation capability registered, and asserts no warning when it is present.

### 3.4 E2 — how the resolver finds the validated value

- **Decision:** promote the key builder into `common` as a pure exported
  `validatedStateKey(target: ValidationTarget): string` returning `` `validated:${target}` ``.
  `validation-plugin`'s middleware calls it instead of building the literal inline, and
  `decorator-plugin`'s `resolveParameter` calls it to read. The released key string is unchanged.
- **Why:** the key is a cross-package wire format that two packages must agree on byte-for-byte, and
  §2.2 forbids the import that would let one read the other's constant — the M47 frame-codec and M55
  content-type-map precedent, and the same reasoning as M52's `splitWorkerEnv`. Hardcoding the
  literal a second time in `decorator-plugin` is the §11.2 magic string that silently stops matching
  the day the writer changes. This DELETES the inline literal rather than adding a copy.
- **Test home:** `packages/common/test/unit/validated-state-key.test.ts` for the helper, plus a
  cross-package assertion in
  `packages/decorator-plugin/test/integration/decorator-validation.test.ts` that the value the
  handler receives is the value the middleware wrote.

### 3.5 E2 — which parameter decorators read validated values, and which do not

- **Decision:** `@Body()` reads `validated:body`, `@Query(name?)` reads `validated:query`, and
  `@Param(name)` reads `validated:params`, each falling back to today's raw source when the key is
  absent from `ctx.state`. `@Header` and `@Cookie` are deliberately NOT changed.
- **Why:** those three are exactly the targets a `@ValidateXxx` decorator can produce
  (`buildRouteSchema` maps three; `RouteSchema` has no `cookies` at all), so they are the three
  where a validated value can exist by decorator alone. `@Header` is excluded for a concrete reason
  rather than for symmetry: it resolves through `ctx.request.headers.get(name)`, which is
  case-INSENSITIVE, while `extractTarget('headers')` builds a plain record keyed by
  `headers.entries()`. Reading the validated record instead would make `@Header('Content-Type')`
  case-sensitive and return `undefined` for a name that works today — trading a discarded transform
  for a silent regression. `@Cookie` is excluded because no schema key exists to populate. Presence
  is tested with `ctx.state.has(key)`, not a truthiness check on `get`, so a schema that
  legitimately validates to `null` or `0` is still honoured.
- **Test home:** `test/unit/resolvers/validated-parameters.test.ts` — one case per decorator
  including the absent-key fallback, the `null`-valued validated body, and a
  `@Header('Content-Type')` case pinning the case-insensitive behaviour as unchanged.

### 3.6 E2 — the transform that proves the fix

- **Decision:** the integration test's schema uses a Zod `transform` and a `default`, and asserts
  the handler receives the TRANSFORMED value.
- **Why:** a schema that only rejects invalid input cannot distinguish the fixed resolver from the
  broken one — both hand the handler an object that passes. E2 is specifically about transforms,
  defaults and coercions being discarded, so only a schema that CHANGES its input can fail against
  the old code. This is the no-op-change rule applied to the test design.
- **Test home:** `test/integration/decorator-validation.test.ts`, with the raw and validated values
  asserted as different objects.

### 3.7 C2 — the content-hash pattern

- **Decision:** widen `IMMUTABLE_PATTERN` to accept a base64url-shaped segment (`[A-Za-z0-9_-]{8,}`)
  that contains at least one digit, keeping the existing `[.-]` separator and extension anchors. The
  hash alphabet and the digit requirement are settled by reading the hashes a real Vite build emits
  in `apps/full-stack/build/client/assets/` before the regex is written, and the measured examples
  go into the test as fixtures.
- **Why:** a bare `[A-Za-z0-9_-]{8,}` widening over-matches ordinary words — `styles-production.css`
  would acquire a one-year `immutable` cache, which is a worse defect than the one being fixed,
  because it is unrecoverable from the browser's side. Requiring a digit is what separates a hash
  from a word in practice; it is a heuristic, so the JSDoc says so and names `cacheControl` as the
  deterministic override. The `/i` flag stays for the hex case so existing esbuild/rollup hex hashes
  keep matching.
- **Test home:** `packages/static-plugin/test/unit/http/cache-control.test.ts` — real measured Vite
  hashes match, real hex hashes still match, and `styles-production.css`, `app-controller.js` and
  `index-abcdefgh.js` (letters only) do NOT.

### 3.8 X3-9 — the reversed-argument hazard

- **Decision:** `PasswordHasher.verify` throws a new exported `MalformedPasswordHashError` when
  `stored` is not a well-formed `pbkdf2$…` string, instead of returning `false`.
- **Why:** the branch already exists (`password-hasher.ts:51-53`) and already knows the value is not
  a hash. A plaintext password in the `stored` position lands in exactly that branch, so the
  reversed call is fully detectable at the point it happens — the only reason it presents as "every
  correct password answers 401" is that a programming error and a wrong password share one return
  value. Nominal branding of the two parameters was rejected: it would break every existing caller's
  call site to fix a mistake the malformed branch can name for free, and a stored hash arrives from
  a database as a plain `string` regardless. The argument ORDER is not changed — that is a silent
  breaking change to a released signature, and the throw makes the mistake loud without one.
- **Test home:** `packages/auth-plugin/test/unit/services/password-hasher.test.ts` — the reversed
  call throws and names both positions; a genuinely wrong password still returns `false`; a
  `pbkdf2$…` string with the wrong part count still throws rather than returning `false`.

### 3.9 X4-7 — making the audit trail readable

- **Decision:** export the `StoredAuditEntry` and `AuditQuery` types from the `audit-plugin` barrel.
  `IAuditLogger` is NOT widened with a query method.
- **Why:** the four storage classes are already exported for direct construction, and their `query`
  members' parameter and return types are unnameable by any consumer — the same latent public-API
  defect M52c found when `DataSource.findAll` took an unexported `NormalizedQuery`. Two type exports
  close it. Adding `query` to the committed `IAuditLogger` was rejected: `LogAuditStorage.query()`
  returns `[]` by design and `MemoryAuditStorage` is non-durable, so a required contract member
  would be unsatisfiable by two of the four shipped backends (Liskov, §1.1) — the read path is the
  storage's, and it is already reachable once its types are nameable.
- **Test home:** `packages/audit-plugin/test/unit/barrel-exports.test.ts` — a compile-time assertion
  declared against the BARREL, following M70m's finding that a runtime-only assertion leaves a
  dropped type export green.

### 3.10 X4-5 — the CSRF header default

- **Decision:** `CsrfOptions.headerName` defaults to `'x-csrf-token'`. An explicitly configured name
  still wins; there is no way to switch header reading off, because a synchroniser token that cannot
  be presented is not a security control.
- **Why:** `csrf: {}` is the registration `PUBLIC_API.md` shows, and with no header name a JSON
  mutation can never present its token — the feature is inoperative in its documented default
  configuration. `'x-csrf-token'` is the name the package's own `csrfFormMiddleware` JSDoc example
  already uses (`csrf-form-middleware.ts:46`), so the default is the name the docs already teach.
- **Test home:** `packages/session-plugin/test/integration/csrf-json.test.ts` — a JSON mutation
  presenting the token in `x-csrf-token` under `csrf: {}` succeeds; the same request without the
  header still `403`s; a configured `headerName` still wins.

### 3.11 X9-10 — the session cookie name

- **Decision:** rename the default from `'hono_session'` to `'setu_session'`, as a breaking change
  with CHANGELOG migration text stating that in-flight sessions are invalidated at deploy and that
  pinning `cookie: { name: 'hono_session' }` preserves them.
- **Why:** the framework is not Hono, and the register's own point is that the rename only gets more
  expensive with every release that ships it — the cost is one invalidated cookie generation now
  against the same cost later plus the interim confusion. Doing it inside the alpha line, where the
  CHANGELOG is the announcement mechanism (§9 prerelease scope), is the cheapest moment available.
- **Test home:** `packages/session-plugin/test/unit/options.test.ts` — the default is `setu_session`
  and an explicit name still wins.

### 3.12 X3-4 — who reports a process-local backplane

- **Decision:** `RealtimeBackplanePlugin` logs the notice itself at `register()` when its resolved
  transport is `'memory'`. `sse-plugin` and `websocket-plugin` keep their existing
  `backplane === undefined` notices unchanged.
- **Why:** the plugin that knows its transport is the only one that can report it without a contract
  change; asking the consumers would need a new `IRealtimeBackplane` member describing its own
  reach, which is a `common` widening bought for a log line. The consumers' notices are already
  CORRECT for their own condition — a registered backplane genuinely is a registered backplane — so
  the gap is a missing notice on the provider side, not a wrong condition on the consumer side. One
  notice per application, at the source of the fact.
- **Test home:** `packages/realtime-backplane-plugin/test/unit/plugin/memory-notice.test.ts` — bare
  registration logs the notice naming `'memory'`; `'redis'` and `'messaging'` do not; an explicit
  opt-out suppresses it.

### 3.13 X3-6 — the `SseMessage.data` type

- **Decision:** widen `data` to
  `string | number | boolean | null | readonly unknown[] | Record<string, unknown>`.
- **Why:** the current `string | Record<string, unknown>` is narrower than the documented and
  implemented behaviour, which is "a string is written literally, any non-string is
  `JSON.stringify`-ed" (`sse.ts:28-31`) — so the type rejects values the encoder handles correctly,
  and an inline object literal satisfies `Record<string, unknown>` while a named interface does not,
  which is why every documented example compiles and every real application casts. Widening a
  parameter position is source-compatible for callers; it is the encoder that must accept more, and
  it already does.
- **Test home:** `packages/sse-plugin/test/unit/encoding/frame-encoder.test.ts` gains an array and a
  primitive case, and `packages/common/test/unit/type-contracts.test.ts` gains a compile-time
  assignment from a NAMED interface, which is the case the current type rejects.

### 3.14 X4-11 — `IResponse.html`

- **Decision:** add `html(body: string): HandlerResult` to `IResponse`, implemented in the kernel's
  `ResponseBuilder`, setting `content-type: text/html; charset=utf-8`.
- **Why:** `IResponse` is implemented in exactly one place in `packages/` (the kernel's builder),
  and the M33 `MockResponse`, so a REQUIRED member is affordable here where it would not be for a
  widely-implemented port; the alternative — leaving every CSRF-protected form example to set the
  header by hand — is what the register measured, and the shipped example does not do it. The
  charset is not optional: a bare `text/html` lets a browser sniff the encoding.
- **Test home:** `packages/kernel/test/unit/context/response.test.ts` for the header and body, and
  `packages/testing/test/unit/mock-response.test.ts` for the double, which must implement the new
  member or the contract-violating-double rule is broken at the source.

### 3.15 X5-5 — serving `public/` from the React Router build

- **Decision:** `react-router-plugin` serves files from the client build ROOT as well as from
  `assetUrlPrefix`, gated on an explicit `publicFiles` option that defaults to on, with
  `must-revalidate` caching rather than `immutable` — those files are not content-hashed.
- **Why:** Vite copies `public/` into `build/client/` and the plugin's handler only claims
  `assetUrlPrefix`, so `/robots.txt` and `/favicon.ico` reach the SSR catch-all and answer an HTML
  404 under a 200-shaped page. The `immutable` default would be actively wrong for them, which is
  the same distinction M55 drew between hashed and unhashed assets. The existing containment guard
  (`static-assets.ts:64-82`, including `realPath`) is reused unchanged — a second root must not get
  a second traversal check.
- **Test home:** `packages/react-router-plugin/test/unit/assets/public-files.test.ts` — a root-level
  file is served with `must-revalidate`, a traversal attempt is refused, and a request matching
  neither root still falls through to SSR.

### 3.16 The documentation-only rows, and the gate that keeps them fixed

- **Decision:** X3-1, X3-3, X3-5, X3-8, X5-7, X7-9 and the C5/C7 doc halves are doc-only edits. Each
  package README example this milestone touches is added to
  `test/package-readme-fence-compiler.test.ts` (M70k's gate) rather than to a second gate.
- **Why:** M70k's own header warns against a second classifier, and M70i proved the fold is strictly
  stronger than a per-milestone gate — it found four fences the narrower gate never reached. A
  compiled fence is the only mechanism that stops a corrected example from rotting; a prose fix with
  no gate is exactly what produced C1 and X8-8.
- **Test home:** `test/package-readme-fence-compiler.test.ts`, with its target list extended and the
  count of compilable fences per README asserted so a silently-skipped fence fails.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                              | Kind             | Consumer / real code path that READS it                                                                                                                    |
| -------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validatedStateKey` (`common`)               | function         | `validation-plugin`'s `createValidationMiddleware` (write path) and `decorator-plugin`'s `resolveParameter` (read path). Two real callers in two packages. |
| `MalformedPasswordHashError` (`auth-plugin`) | class            | Thrown by `PasswordHasher.verify`; caught by an application distinguishing a coding error from a wrong password. Named in the README's login example.      |
| `StoredAuditEntry` (`audit-plugin`)          | type             | The return type of `MemoryAuditStorage.query`/`FileAuditStorage.query`/`DatabaseAuditStorage.query`, all already exported. Currently unnameable.           |
| `AuditQuery` (`audit-plugin`)                | type             | The parameter type of those same `query` members. Currently unnameable.                                                                                    |
| `IResponse.html` (`common`)                  | contract member  | `kernel`'s `ResponseBuilder`, `testing`'s `MockResponse`, and the session-plugin CSRF form example that currently sets the header by hand.                 |
| `IMMUTABLE_PATTERN` (`static-plugin`)        | const (existing) | `resolveCacheControl:61`. Unchanged export, changed value — noted here because its regression test is what pins C2.                                        |

### 4.1 Options — every option names its consumer

| Option                                       | Consumer                                         | Behavior (per implementation)                                                                                                                         |
| -------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DecoratorPluginOptions.enforceSchemas`      | `registerController` (§3.1)                      | Default `true`: append validation middleware for each present schema target. `false`: schemas stay description-only and the §3.3 warning is silenced. |
| `CsrfOptions.headerName`                     | `csrf/verify.ts:94`                              | Now defaults to `'x-csrf-token'` instead of being absent (§3.10). An explicit value still wins.                                                       |
| `SessionCookieOptions.name`                  | `options.ts:190`                                 | Default changes to `'setu_session'` (§3.11). An explicit value still wins.                                                                            |
| `RealtimeBackplanePluginOptions.localNotice` | `RealtimeBackplanePlugin.register` (§3.12)       | Default `true`: log the process-local notice when transport is `'memory'`. `false`: suppress, matching the existing `scalingNotice` opt-out shape.    |
| `ReactRouterPluginOptions.publicFiles`       | the asset handler (§3.15)                        | Default `true`: also serve the client build root with `must-revalidate`. `false`: today's behaviour exactly, prefix-only.                             |
| `FullStackStarterOptions.static`             | `full-stack-starter/src/app.ts:49` neighbourhood | Gated arm (X5-9): present registers `StaticPlugin` with the given options; absent registers nothing, so the default composition stays byte-identical. |

## 5. Implementation files

| File                                                                         | Purpose                                                                                        |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/common/src/services/validation.ts`                                 | Add `validatedStateKey` (§3.4).                                                                |
| `packages/common/src/services/sse.ts`                                        | Widen `SseMessage.data` (§3.13).                                                               |
| `packages/common/src/http.ts`                                                | Add `IResponse.html` (§3.14).                                                                  |
| `packages/common/src/index.ts`                                               | Barrel: `validatedStateKey`.                                                                   |
| `packages/validation-plugin/src/middleware/validation-middleware.ts`         | Call `validatedStateKey` instead of the inline literal (§3.4).                                 |
| `packages/decorator-plugin/src/plugin/decorator-plugin.ts`                   | Resolve the validation capability, append per-target middleware, warn when absent (§3.1–§3.3). |
| `packages/decorator-plugin/src/resolvers/parameter-resolver.ts`              | Read validated values for `body`/`query`/`param` with raw fallback (§3.5).                     |
| `packages/decorator-plugin/src/decorators/validation.ts`                     | JSDoc corrected to describe enforcement (C3).                                                  |
| `packages/kernel/src/context/response.ts`                                    | Implement `html` (§3.14).                                                                      |
| `packages/testing/src/mock-response.ts`                                      | Implement `html` on the double (§3.14).                                                        |
| `packages/static-plugin/src/http/cache-control.ts`                           | Widen `IMMUTABLE_PATTERN` (§3.7); JSDoc the leading-slash contract (C5).                       |
| `packages/static-plugin/src/handler/static-handler.ts`                       | Normalise the callback argument to a leading slash (C5).                                       |
| `packages/auth-plugin/src/services/password-hasher.ts`                       | Throw `MalformedPasswordHashError` (§3.8).                                                     |
| `packages/auth-plugin/src/index.ts`                                          | Barrel: `MalformedPasswordHashError`.                                                          |
| `packages/session-plugin/src/options.ts`                                     | `headerName` default (§3.10); cookie name default (§3.11).                                     |
| `packages/audit-plugin/src/index.ts`                                         | Barrel: `StoredAuditEntry`, `AuditQuery` (§3.9).                                               |
| `packages/realtime-backplane-plugin/src/plugin/realtime-backplane-plugin.ts` | Process-local notice + `localNotice` option (§3.12).                                           |
| `packages/react-router-plugin/src/assets/static-assets.ts`                   | Serve the client build root (§3.15).                                                           |
| `packages/react-router-plugin/src/interfaces/index.ts`                       | `publicFiles` option (§3.15).                                                                  |
| `packages/starters/full-stack-starter/src/options.ts`, `src/app.ts`          | `static` arm (X5-9).                                                                           |
| `test/package-readme-fence-compiler.test.ts`                                 | Extend the target list and pin per-README fence counts (§3.16).                                |

Doc-only files (no `src` change): `ARCHITECTURE.md` §10, `PUBLIC_API.md`, `CHANGELOG.md`,
`ROADMAP.md`, `smoke/DEFECTS.md`, and the READMEs of `auth-plugin`, `static-plugin`,
`session-plugin`, `audit-plugin`, `decorator-plugin`, `validation-plugin`, `sse-plugin`,
`websocket-plugin`, `realtime-backplane-plugin`, `resilience-plugin` (X7-9), `react-router-plugin`
(X5-7), the three starters, and `docs/` auth and realtime guides.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                       | src covered                                | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/validated-state-key.test.ts`                         | `services/validation.ts`                   | `validatedStateKey('body') === 'validated:body'` for all five `ValidationTarget` members — types against `(target: ValidationTarget) => string`.                                                                                                                                                                    |
| `packages/common/test/unit/type-contracts.test.ts`                              | `services/sse.ts`, `http.ts`               | Compile-time: a NAMED interface is assignable to `SseMessage.data` (the case the old type rejects); an array and a primitive are assignable; `IResponse.html` is present on the interface.                                                                                                                          |
| `packages/validation-plugin/test/unit/middleware/validation-middleware.test.ts` | `middleware/validation-middleware.ts`      | Existing suite unchanged in expectations; adds an assertion that the written key equals `validatedStateKey(target)` for each target, so the two packages cannot drift.                                                                                                                                              |
| `packages/decorator-plugin/test/unit/plugin/validation-enforcement.test.ts`     | `plugin/decorator-plugin.ts`               | Middleware appended once per present target and in schema order; nothing appended for a schema-less route; the §3.3 warning's fields with no capability; no warning with one; `enforceSchemas: false` appends nothing and warns not at all.                                                                         |
| `packages/decorator-plugin/test/unit/resolvers/validated-parameters.test.ts`    | `resolvers/parameter-resolver.ts`          | `@Body`/`@Query`/`@Param` read the validated value; each falls back to the raw source when the key is absent; a validated `null` body is returned rather than falling back; `@Header('Content-Type')` stays case-insensitive (§3.5).                                                                                |
| `packages/decorator-plugin/test/integration/decorator-validation.test.ts`       | both files above, through the real surface | Real `createApplication` + real `ValidationPlugin` + real Zod with a `transform` and a `default`: `400` on a bad body, `200` on a good one, and the handler's argument is the TRANSFORMED value (§3.6). A rejecting guard beats `400` (§3.2). Declared `schema` still wins over openapi-plugin's M70m derived path. |
| `packages/static-plugin/test/unit/http/cache-control.test.ts`                   | `http/cache-control.ts`                    | Measured real Vite hashes match; hex hashes still match; `styles-production.css` and a letters-only segment do NOT; the callback receives a leading-slash path for both a file and the prefix root (C5).                                                                                                            |
| `packages/static-plugin/test/unit/handler/static-handler.test.ts`               | `handler/static-handler.ts`                | Existing suite plus the normalised callback argument at both call sites (`:248`, `:282`).                                                                                                                                                                                                                           |
| `packages/auth-plugin/test/unit/services/password-hasher.test.ts`               | `services/password-hasher.ts`              | Reversed call throws `MalformedPasswordHashError` naming both positions; a wrong password still returns `false`; a 3-part `pbkdf2$…` throws; round-trip hash/verify unchanged.                                                                                                                                      |
| `packages/session-plugin/test/unit/options.test.ts`                             | `options.ts`                               | `headerName` defaults to `'x-csrf-token'`; cookie name defaults to `'setu_session'`; explicit values win in both cases.                                                                                                                                                                                             |
| `packages/session-plugin/test/integration/csrf-json.test.ts`                    | `csrf/verify.ts`, `options.ts`             | Under `csrf: {}`, a JSON mutation carrying `x-csrf-token` succeeds and one without it `403`s — driven through `app.fetch`, since the flow reads `Set-Cookie`.                                                                                                                                                       |
| `packages/audit-plugin/test/unit/barrel-exports.test.ts`                        | `index.ts`                                 | Compile-time assertions declared against the BARREL for `StoredAuditEntry` and `AuditQuery`, plus the existing surface.                                                                                                                                                                                             |
| `packages/realtime-backplane-plugin/test/unit/plugin/memory-notice.test.ts`     | `plugin/realtime-backplane-plugin.ts`      | Bare registration logs the notice naming `'memory'`; `'redis'`/`'messaging'` do not; `localNotice: false` suppresses.                                                                                                                                                                                               |
| `packages/react-router-plugin/test/unit/assets/public-files.test.ts`            | `assets/static-assets.ts`                  | A build-root file is served with `must-revalidate`; a traversal attempt is refused through the existing `realPath` guard; a miss falls through to SSR; `publicFiles: false` reproduces prefix-only behaviour.                                                                                                       |
| `packages/kernel/test/unit/context/response.test.ts`                            | `context/response.ts`                      | `html(body)` sets `text/html; charset=utf-8` and the body; composes with `status()`.                                                                                                                                                                                                                                |
| `packages/testing/test/unit/mock-response.test.ts`                              | `mock-response.ts`                         | The double implements `html` with the same header, so it cannot pass a test the real builder would fail.                                                                                                                                                                                                            |
| `packages/starters/full-stack-starter/test/unit/static-arm.test.ts`             | `options.ts`, `app.ts`                     | The `static` arm registers `StaticPlugin`; absent it the plugin list is byte-identical to today's.                                                                                                                                                                                                                  |
| `test/package-readme-fence-compiler.test.ts`                                    | (repo gate)                                | Every touched README's fences compile, and the per-README compilable-fence COUNT is asserted so a skipped fence fails rather than passing vacuously (the M70i lesson).                                                                                                                                              |

**Negative controls** — each observed failing, then reverted, and recorded in the PR body:

1. Revert §3.1's middleware append → the integration `400` case answers `200`.
2. Revert §3.5's validated read → the §3.6 transform assertion fails while the `400` case still
   passes, which is what distinguishes E2 from E1.
3. Swap §3.4's helper for an inline literal in `decorator-plugin` only, then change the helper's
   prefix → the cross-package assertion fails, proving the two packages share one key.
4. Revert §3.2's ordering so validation precedes guards → the guard-precedence test answers `400`.
5. Widen §3.7's regex to `[A-Za-z0-9_-]{8,}` with no digit requirement → `styles-production.css`
   acquires `immutable`.
6. Revert §3.8's throw → the reversed-argument test reports `false` instead of throwing.
7. Drop a README from §3.16's target list → the fence-count assertion fails rather than the target
   silently covering less.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m70n-decorators-di-docs, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; >=90% branch/function/line every src file
deno task publish:check     # committed tree; common/kernel/testing exports change
deno task release:verify 0.1.0-alpha.8
```

Both publish gates are mandatory here: this milestone changes `src/index.ts` in `common`,
`auth-plugin` and `audit-plugin`, and adds a `common` contract member, so a slow type or a missing
release-list entry is reachable (the three M51 defects every other gate passed).

Beyond the gates, because this milestone changes what a decorated application does at runtime: boot
a real kernel application with `DecoratorPlugin` + `ValidationPlugin` and drive a decorated route
end to end, asserting the transformed body — the M51 lesson that a hand-rolled plugin context cannot
see a defect in the only real entry point.

## 8. Risks & mitigations

- **E1 turns a released no-op into an enforcing middleware**, so an application whose decorated
  route currently accepts a body its schema rejects starts answering `400` on upgrade. Mitigation:
  `enforceSchemas` defaults to `true` because the decorator's NAME promises validation and shipping
  the fix off by default would leave E1 open, but the CHANGELOG entry is a breaking one naming the
  flag, and the §3.3 warning makes the pre-upgrade state visible.
- **§3.7's digit heuristic can still misclassify.** A hash with no digit gets `must-revalidate`
  (safe, merely suboptimal) and a hashless word containing a digit gets `immutable` (unsafe).
  Mitigation: the JSDoc names the heuristic and points at `cacheControl` as the deterministic
  override, and the test carries the measured real hashes rather than invented ones.
- **§3.14 adds a REQUIRED member to `IResponse`**, breaking any out-of-repo implementor. Mitigation:
  both in-repo implementors are updated in this PR, and the CHANGELOG entry marks it breaking. An
  optional member was rejected because every caller would then need a fallback, which is the
  hand-written header the row is about.
- **§3.11 invalidates live sessions at deploy.** Mitigation: CHANGELOG migration text naming the
  one-line pin that preserves them.
- **Eighteen rows across thirteen packages is a wide diff**, and the per-file coverage bar applies
  to every touched file. Mitigation: the rows are independent, so they land as separate commits on
  this one branch, and coverage is re-read per file after each — including after deletions, since
  M55 showed a rewritten test file can drop an unrelated file below the bar.

## 9. Out of scope

- **X2-6 (no trace context crosses the broker)** — assigned to this milestone by `ROADMAP.md:7195`
  and recommended here for reassignment rather than landed. It is not a documentation row: closing
  it means W3C `traceparent` injection on publish and extraction on delivery across all ten brokers,
  a `telemetry-plugin` seam that works off Node (the register's own point is that the OTel
  instrumentation is Node-gated while the template default runtime is Deno), and a decision about
  whether `MessageMetadata.headers` becomes a populated contract. That is a milestone with its own
  design, real-backend gates and a `common` question, and folding it into a sweep is how a feature
  ships without one. The maintainer's call; this plan proceeds on the assumption it moves.
- **`IAuditLogger` gaining a read method** — §3.9 records why the storage classes, not the logger,
  own the read path.
- **The kernel defaulting `authMiddleware()` to priority 300** — C4 records why the doc sites are
  corrected instead; a kernel default that special-cases one plugin's middleware is worse than an
  explicit argument.
- **Changing `PasswordHasher.verify`'s argument order** — §3.8 records why the throw is preferable
  to a silent breaking change to a released signature.
- **`v0.1.0-alpha.9`** — [`docs/releasing.md`](../docs/releasing.md) owns it; it is not part of any
  M70 workstream branch.
