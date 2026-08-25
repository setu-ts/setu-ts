# Milestone 71 — Kernel and Contract Boundary Hardening (`@setu-ts/kernel`, `@setu-ts/common`)

> **Status:** Planning. Branch: `feat/m71-kernel-contract-hardening`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Close the three registry/context boundaries a plugin can cross **by accident**, and settle the
`ctx.state` key convention on one mechanically checkable shape. The application service registry
becomes append-only after `runBootstrap()`; every sanctioned late mutation (`override: true`,
`unregister`) is reported through the logger capability, naming the token and the plugin; the two
mutable identity fields on `IRequest` accept exactly one implicit write, with an explicit escape for
the framework's own authoritative writers; and all seven `ctx.state` keys move to one
`<owner-package>:<kebab-key>` shape enforced by a repo-level recurrence gate.

**The threat model, stated first because it decides the design.** All three gaps assume buggy or
careless in-process plugin code — a typo, an ordering mistake, a third-party middleware — **not** a
compromised package. Anything already running in the process can monkey-patch prototypes, re-import
`common` and call the escapes, or reach into the registry's own fields. **None of this is a security
boundary**, and the milestone must say so in the code, the plan and the docs rather than overselling
it. What it buys is that an accident fails loudly at the moment it happens, attributed to the plugin
that caused it, instead of silently changing behaviour three stages later.

- **In scope:** sealing the app registry after `runBootstrap()`; logging `override: true` and
  `unregister` through `CAPABILITIES.LOGGER`; a single-write guard on `IRequest.user` **and**
  `IRequest.tenant` with `replacePrincipal`/`replaceTenant` escapes; one `ctx.state` key convention
  applied to all seven sites; a recurrence gate refusing a string literal as a `ctx.state` key.
- **NOT this milestone:** anything framed as defending against hostile plugin code (stated, not
  deferred — it is not a goal); the `ctx`-retention claim, measured at 6.7 MB heap over 20k requests
  when `ctx` is dropped versus 102 MB when retained, i.e. **no framework leak** (closed as
  not-a-defect, owned by nobody); sealing the middleware pipeline or the router, which the ROADMAP
  does not name and which have no probed exposure — a later milestone owns them if one is found;
  regenerating `docs/api/**`, which is generated output rebuilt on release (`docs/releasing.md`).

## 1. Contracts verified from SOURCE (not names)

| Reference                       | Source (file:line)                                                                                                  | Verified surface / fact                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IServiceRegistry`              | `packages/common/src/registry.ts:88-153`                                                                            | Exactly six members: `register`, `registerFactory`, `get`, `getAll`, `has`, `unregister`. No seal, no observer, no lifecycle member. `unregister` is documented as removing EVERY multi provider. |
| `RegisterOptions`               | `packages/common/src/registry.ts:18-26`                                                                             | Exactly `override?: boolean` and `multi?: boolean`, both `readonly`.                                                                                                                              |
| `ServiceRegistry.#store`        | `packages/kernel/src/registry/service-registry.ts:102-121`                                                          | Throws on duplicate single registration UNLESS `options.override`. The `multi` arm returns before the check, so a multi registration never conflicts. Conflicts checked against `this` only.      |
| `ServiceRegistry.createChild`   | `packages/kernel/src/registry/service-registry.ts:42-44`                                                            | Returns `new ServiceRegistry(this)` — a SEPARATE object with its own `#single`/`#multi`. Request scoping is therefore unaffected by any flag set on the parent.                                   |
| `ServiceRegistry` is not public | `packages/kernel/src/index.ts` (whole file, 17 lines)                                                               | The kernel barrel exports `createApplication` plus four types. `ServiceRegistry` is NOT exported, so adding `seal()`/`setObserver()` is not a public API change.                                  |
| Seal point                      | `packages/kernel/src/application/application.ts:358`                                                                | `await this.#lifecycle.runBootstrap()` is step 7; steps 8–9 only `setHandler` and `listen`, neither of which registers.                                                                           |
| `#registeringPlugin` cursor     | `packages/kernel/src/application/application.ts:118,321,326`                                                        | `string \| undefined`, set per plugin in the registration loop and cleared in a `finally`. Already read by `Router` via `() => this.#registeringPlugin` (line 119).                               |
| Guarded logger helper precedent | `packages/kernel/src/application/application.ts:985-999`                                                            | `has(LOGGER)` → `get(LOGGER)` → log, whole body in a `try {} catch {}`. Read at CALL time, never captured (the M52b lesson).                                                                      |
| `IRequest.user` / `.tenant`     | `packages/common/src/http.ts:49,54`                                                                                 | The ONLY two non-`readonly` members. `ip`, `raw`, `headers`, `signal`, `method`, `url`, `path` are all `readonly`.                                                                                |
| `IRequest` producers            | `application.ts:514`, `fetch-mapping.ts:40`, `mock-context.ts:133`                                                  | THREE producers: the kernel's `inject()` synthetic literal, the runtime's `mapWebRequestToFrameworkRequest` literal, and `testing`'s `MockRequest` class.                                         |
| `createRequestContext`          | `packages/kernel/src/context/request-context.ts:56-99`                                                              | The single funnel every pipeline request passes through, whatever produced the `IRequest`. Receives the request by reference and returns a handle.                                                |
| `createTestContext`             | `packages/testing/src/mock-context.ts:358-409`                                                                      | Replicates the kernel factory by hand and seeds `user`/`tenant` from options into the `MockRequest` CONSTRUCTOR (lines 375-376) — so a seeded value is already an own data property.              |
| `request.user` writers          | `auth-plugin/src/middleware/auth-middleware.ts:30`                                                                  | The ONLY in-repo writer, inside `if (principal !== null)`. `authMiddleware` always calls `next()` and never authorizes.                                                                           |
| `request.tenant` writers        | `multi-tenancy-plugin/src/middleware/tenant-middleware.ts:145`                                                      | The ONLY in-repo writer, inside `if (resolved)`.                                                                                                                                                  |
| Guards read `request.user`      | memory note, re-checked: all five `require*` factories                                                              | Authorization never reads `ctx.state`; `requireAuth`/`requireRole`/`requirePermission`/`requireAnyRole`/`requireAllPermissions` all read `ctx.request.user`.                                      |
| `validatedStateKey`             | `packages/common/src/services/validation.ts:37-39`                                                                  | `(target: ValidationTarget) => string`, returns `` `validated:${target}` ``. `ValidationTarget` = `'body'\|'query'\|'params'\|'headers'\|'cookies'` (line 18).                                    |
| `ERROR_RESPONDER_STATE_KEY`     | `packages/common/src/errors/error-responder.ts:45`                                                                  | `'setu.error.responder'`. Written by `exceptions` and by the kernel; read by `common`'s `respondWithError`.                                                                                       |
| `TELEMETRY_SPAN_KEY`            | `packages/telemetry-plugin/src/interfaces/index.ts:18`                                                              | `'__he_telemetry_span'` — still carries the pre-rename `he` prefix.                                                                                                                               |
| `SESSION_STATE_KEY`             | `packages/session-plugin/src/services/session-service.ts:31`                                                        | `'setu-ts:session'`. Exported from its MODULE but **absent from `packages/session-plugin/src/index.ts`** — so it is not public API under §10.1.                                                   |
| `UPLOADS_STATE_KEY`             | `packages/storage-plugin/src/middleware/upload-middleware.ts:13`                                                    | `'storage-plugin:uploads'`, a module-private `const` (no `export`). Already conformant.                                                                                                           |
| `TENANT_CACHE_PREFIX_STATE_KEY` | `packages/multi-tenancy-plugin/src/middleware/tenant-middleware.ts:21`                                              | `'multi-tenancy-plugin:cache-prefix'`, barrel-exported (`index.ts:22`). Already conformant.                                                                                                       |
| `'clientIp'`                    | `http-security-plugin/.../ip-security-middleware.ts:79` (set), `auth-plugin/.../rate-limit-middleware.ts:130` (get) | A BARE literal duplicated across two packages with no shared constant — §11.2's magic-string case, and the only key with no constant at all.                                                      |
| `unregister` has no caller      | `grep -rn '\.unregister(' packages/*/src` → 3 hits                                                                  | All three are DEFINITIONS: `common/src/registry.ts:152` (contract), `kernel/.../service-registry.ts:88` (impl), `testing/src/mock-registry.ts:87` (mock). Zero call sites.                        |
| `override: true` has no caller  | `grep -rn 'override: true' packages/*/src` → 5 hits                                                                 | All five are error-message strings or JSDoc prose. Zero runtime call sites.                                                                                                                       |
| Only `onBootstrap` consumer     | `service-discovery-plugin/.../service-discovery-plugin.ts:80`                                                       | The hook body calls `provider.registerSelf?.(registration)` — an EXTERNAL registration. It performs no `ctx.services.register`, so sealing after step 7 cannot break it.                          |
| ARCHITECTURE request scoping    | `ARCHITECTURE.md:783-801`                                                                                           | Documents request-scoped registration via `ctx.services.register()` in request middleware. That `ctx.services` is the CHILD registry, which the seal never touches.                               |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                      | Resolution (picked side)                                                                                                                                                                                                                     | Doc deliverable (same PR)                                                                                                                |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `ROADMAP.md` M71 says "Three of the state keys are PUBLISHED exports (`SESSION_STATE_KEY`, `TENANT_CACHE_PREFIX_STATE_KEY`, `ERROR_RESPONDER_STATE_KEY`, plus `validatedStateKey`)". Source disagrees twice: `SESSION_STATE_KEY` is NOT in its barrel, and `TELEMETRY_SPAN_KEY` IS (telemetry `index.ts:23`). | The published set is **`TENANT_CACHE_PREFIX_STATE_KEY`, `ERROR_RESPONDER_STATE_KEY`, `validatedStateKey`, `TELEMETRY_SPAN_KEY`** — four, and a different four. `SESSION_STATE_KEY` and `UPLOADS_STATE_KEY` are module-level, not public API. | Correct the M71 ROADMAP paragraph in the same PR that flips its status row.                                                              |
| C2 | `packages/common/src/services/validation.ts:61` documents `ctx.state.get('rawBody')` in an `@example`. `grep -rn rawBody packages/*/src` returns exactly that one line — **no code anywhere writes `rawBody`**, so the example instructs a reader to read a key that is always `undefined`.                   | Delete the fabricated key from the example and show the real input (`await ctx.request.json()`). This is the "docs must match behavior" rule: a claim about a code path that does not exist.                                                 | Fix the `IValidationService` `@example` in `packages/common/src/services/validation.ts`.                                                 |
| C3 | `packages/validation-plugin/src/index.ts:16` (the module JSDoc jsr.io renders as the package page) and eight `PUBLIC_API.md` sites write the key as the LITERAL `'validated:body'` while `common` exports `validatedStateKey` precisely so the value is never hardcoded.                                      | Every example reads through the exported helper. A literal in the docs is what makes a value change look breaking to readers who copied it — and it is the exact pattern the helper exists to prevent.                                       | Rewrite the literal to `validatedStateKey('body')` in the validation-plugin module JSDoc, its README, and every `PUBLIC_API.md` example. |
| C4 | `ARCHITECTURE.md:790` shows request-scoped registration with `logger.child({ requestId: ctx.request.id })`. `IRequest` has no `id` member (`common/src/http.ts:34-95`); the request id lives on `IRequestContext.id`.                                                                                         | `ctx.id`. Drive-by correction in a section this milestone is already rewriting for the seal.                                                                                                                                                 | Fix the §6 "Service Scopes" snippet while adding the seal paragraph.                                                                     |
| C5 | `ARCHITECTURE.md:802-813` "Thread Safety Considerations" states "**Registration** must happen during the bootstrap phase, not during request processing" as a convention with nothing enforcing it.                                                                                                           | It becomes enforced. The prose changes from an instruction to a statement of what the registry now does, naming the seal point.                                                                                                              | Rewrite §6 "Thread Safety Considerations" and add a "Registry Sealing" subsection.                                                       |

## 3. Design decisions

### 3.1 Where the registry seal lives, and what it refuses

- **Decision:** a private `#sealed` boolean on the concrete `ServiceRegistry`, flipped by a new
  internal `seal(): void` method that `Application.#runStartup` calls immediately after step 7's
  `await this.#lifecycle.runBootstrap()` and before step 8's `setHandler`. Once sealed, `register`,
  `registerFactory` and `unregister` throw; `get`, `getAll`, `has` and `createChild` are untouched.
  `seal()` is idempotent. **`IServiceRegistry` gains no member** — the seal is a property of the
  kernel's implementation, not of the contract, so no external implementor and no test double
  breaks.
- **Why:** the ROADMAP's seal point, verified against §1: nothing in-repo registers in an
  `onBootstrap` hook, and steps 8–9 do not register. Putting `seal()` on the concrete class rather
  than the interface is what keeps this a non-breaking change for `MockServiceRegistry` and any
  external `IServiceRegistry`; a contract member would force every implementor to grow one.
- **Test home:** `packages/kernel/test/unit/registry/service-registry-seal.test.ts` (unit) and
  `packages/kernel/test/integration/registry-seal.test.ts` (a real `createApplication` + `start()`,
  then `app.services.register(...)` → throws).

### 3.2 Child registries are never sealed

- **Decision:** `createChild()` returns a fresh unsealed `ServiceRegistry`, and the child does NOT
  inherit `#sealed` or the observer. A request-scoped registration therefore keeps working exactly
  as `ARCHITECTURE.md:783-801` documents, and per-request overrides are not logged.
- **Why:** the child is a separate object with its own maps (§1), and request-scoped registration is
  a documented feature. Inheriting the seal would break it; inheriting the observer would emit one
  log line per request per override — per-request logging of a sanctioned mechanism is noise, and
  the accident class this milestone targets is a startup-time one.
- **Test home:** `service-registry-seal.test.ts` — "a child of a sealed registry still accepts
  registrations", plus an assertion that the child's registration emits no observer event.

### 3.3 How the seal reports itself

- **Decision:** the throw names the token, the operation and the seal point, and states the two
  supported alternatives: register during a plugin's `register()`/`onInit`/`onBootstrap`, or use the
  request-scoped `ctx.services` inside middleware.
- **Why:** the failure a developer will actually hit is "my plugin retained `ctx` and registered
  later"; a bare "registry is sealed" leaves them nowhere. This is the M50/M52c naming-the-way-out
  precedent.
- **Test home:** `service-registry-seal.test.ts` asserts the message contains the token and the word
  `onBootstrap`.

### 3.4 Attribution of `override: true` and `unregister`

- **Decision:** `ServiceRegistry` gains an internal `setObserver(fn)` taking
  `(kind: 'override' | 'unregister', token: CapabilityToken) => void`. `#store` calls it when it
  takes the override branch (i.e. `#single.has(token) && options.override`), and `unregister` calls
  it when it actually removed something. **The registry never learns the plugin name**: the
  Application installs a closure that reads its own `#registeringPlugin` cursor at call time — the
  same shape `Router` already uses (`application.ts:119`). Logging goes through a guarded
  `#reportRegistryMutation` modelled byte-for-byte on `#reportUpgradeRouterFailure`
  (`application.ts:985`): `has(LOGGER)` → `get(LOGGER)` → log, whole body in `try {} catch {}`.
- **Why:** keeping the plugin name out of the registry keeps the registry ignorant of the
  application, and reading the logger at call time rather than capturing it is the M52b lesson — a
  logger registered by a plugin ordered after the registry's construction would otherwise be
  invisible. The guard exists because a missing or itself-broken logger must never turn a legitimate
  override into a failed startup.
- **Test home:** `packages/kernel/test/integration/registry-observability.test.ts`, driving a REAL
  `createApplication` with a real recording logger registered under `CAPABILITIES.LOGGER`.

### 3.5 Log level: `info` for `override`, `warn` for `unregister`

- **Decision:** an override is reported at `info`; an `unregister` is reported at `warn`.
- **Why:** they are not the same event. `override: true` is the **sanctioned** replacement mechanism
  — AI_GUIDELINES §3.4 says in as many words that "a replacement plugin registers the same
  capability token with `override: true`" — so warning on it would flag correct usage on every boot
  of every application using a replacement plugin. `unregister` has no sanctioned use, zero callers
  repo-wide (§1), and is the one path that removes a registration so a following `register` bypasses
  the duplicate guard with no flag at all. Both are bounded by plugin count and emitted only during
  startup, because the seal makes them impossible afterwards.
- **Test home:** `registry-observability.test.ts` asserts the level of each, not merely that
  something was logged.

### 3.6 `unregister` is kept, not deleted

- **Decision:** `IServiceRegistry.unregister` stays. Its JSDoc gains the seal behaviour and a
  pointer to `register(token, service, { override: true })` as the preferred replacement mechanism.
- **Why:** maintainer's call, taken at plan time. The hole the ROADMAP names — `unregister()` +
  `register()` mutating a booted application — is closed by the seal whichever option is chosen, so
  deleting it would buy nothing extra while breaking every external `IServiceRegistry` implementor
  and any external caller. §9's prerelease dead-surface rule targets surface with no reader; this is
  a contract member of an application-facing interface, and "no in-repo caller" is not the same as
  "no reader" for an interface applications consume directly through `app.services`.
- **Test home:** `service-registry-seal.test.ts` — `unregister` still works pre-seal and throws
  post-seal.

### 3.7 Single-write identity: shared descriptors, symbol-backed slots

- **Decision:** a pure `sealRequestIdentity(request: IRequest): void` in `common` installs accessor
  descriptors over `user` and `tenant` in ONE `Object.defineProperties` call. The descriptors are
  **module-level constants**, and the backing value and written-flag live on the request under two
  module-level symbols, so nothing is allocated per request beyond the two slots. A pre-existing
  value (a `MockRequest` seeded from `TestContextOptions`) is migrated into the slot and counts as
  the first write.
- **Why:** measured, not assumed. A per-request closure pair costs **699 ns/request** for one
  property; shared descriptors with symbol-keyed slots cost **298 ns** for the same property — 2.3×
  cheaper and no closure allocation, which is what §14.1/§14.2 ask for. Symbol keys are invisible to
  `Object.keys`, `JSON.stringify` and every enumeration the framework performs, so they cannot leak
  into a serialized request. Accessors, not `Object.freeze`, because the field must stay writable
  once.
- **Test home:** `packages/common/test/unit/request-identity.test.ts`.

### 3.8 The guard is installed at the ONE funnel, not at the three producers

- **Decision:** `createRequestContext` (kernel) calls `sealRequestIdentity(request)` before building
  the context, and `createTestContext` (`testing`) calls it at the same point in its own replica.
  The three `IRequest` producers are untouched.
- **Why:** every request that reaches the pipeline passes through `createRequestContext` whatever
  produced its `IRequest` (§1), so one call site covers `inject()`, all four HTTP adapters and any
  future producer, and a new producer cannot forget it. `createTestContext` is a deliberate replica
  of the kernel factory and must honour the same contract — a double that leaves `user` freely
  writable would make a broken guard pass its own tests, which is this repository's single most
  recurrent root cause.
- **Test home:** `packages/kernel/test/integration/request-identity.test.ts` (through a real app +
  `inject`) and `packages/testing/test/unit/mock-context.test.ts` (the replica honours it).

### 3.9 What a second write costs, and the escape

- **Decision:** a second implicit assignment throws. Two exported escapes in `common` —
  `replacePrincipal(request, principal)` and `replaceTenant(request, tenant)` — overwrite
  deliberately and reset the one-shot budget to "written". Their in-repo consumers are the
  framework's two authoritative identity writers: `authMiddleware` (`auth-plugin`) and
  `tenantMiddleware` (`multi-tenancy-plugin`) switch from bare assignment to the escape.
- **Why:** the boundary being drawn is **explicit intent versus implicit assignment**, not "one
  write ever". Both middlewares may legitimately run more than once in a request — a global
  registration plus a route-level one is a supported composition, and `authMiddleware`'s own JSDoc
  shows the global `app.middleware.add` form — so leaving them on bare assignment would make a
  documented composition throw. Routing them through the escape also gives both exports a real,
  non-test consumer on a real code path, which is §4's dead-surface bar. And it keeps step-up auth
  and impersonation expressible: an application that means it calls the escape, rather than being
  told the capability is gone.
- **Honesty clause (goes in the JSDoc and in `PUBLIC_API.md`, not only here):** this does **not**
  stop the probed escalation, and claiming it does would be false. In that probe a middleware at
  priority 10 forges `ctx.request.user` BEFORE `authMiddleware` runs; that is a first write and is
  allowed. What the guard closes is the LATE overwrite — a stage after authentication silently
  replacing an authenticated principal — and the detection of two independent identity writers
  during development.
- **Test home:** `request-identity.test.ts` (both packages) asserts the throw, the escape, and — as
  a named test, so the limit is recorded rather than discovered — that a write BEFORE the first
  authoritative write is permitted.

### 3.10 One `ctx.state` convention: `<owner-package>:<kebab-key>`

- **Decision:** every key is `<owning package name without the`@setu-ts/`scope>` + `:` + a
  kebab-case key, with **exactly one colon**. Owner is the package that WRITES the key.

  | Key                 | Owner                  | Before                                | After                               |
  | ------------------- | ---------------------- | ------------------------------------- | ----------------------------------- |
  | client IP           | `http-security-plugin` | `'clientIp'`                          | `'http-security-plugin:client-ip'`  |
  | telemetry span      | `telemetry-plugin`     | `'__he_telemetry_span'`               | `'telemetry-plugin:span'`           |
  | validated value     | `validation-plugin`    | `'validated:<target>'`                | `'validation-plugin:validated-<t>'` |
  | error responder     | `exceptions`           | `'setu.error.responder'`              | `'exceptions:error-responder'`      |
  | session             | `session-plugin`       | `'setu-ts:session'`                   | `'session-plugin:session'`          |
  | uploads             | `storage-plugin`       | `'storage-plugin:uploads'`            | unchanged                           |
  | tenant cache prefix | `multi-tenancy-plugin` | `'multi-tenancy-plugin:cache-prefix'` | unchanged                           |

- **Why:** the owner-prefixed form is the one two of the seven sites already use, it is
  self-attributing (a reader of an unfamiliar key can find the package that wrote it), and "exactly
  one colon, both halves kebab-case" is mechanically checkable, which is what makes §3.12's gate
  possible. `validated-<target>` rather than a third `:` segment keeps the shape uniform so the
  regex has no exceptions. `exceptions` and `validation-plugin` own keys DEFINED in `common` because
  two packages must agree on them byte-for-byte and §2.2 forbids the import that would let one read
  the other's constant — the `validatedStateKey` precedent, unchanged by this milestone.
- **Test home:** `packages/common/test/unit/state-keys.test.ts` pins every value;
  `test/state-key-convention.test.ts` is the repo-wide gate.

### 3.11 `clientIp` gets a shared constant in `common`

- **Decision:** a new `packages/common/src/state-keys.ts` exports `CLIENT_IP_STATE_KEY`, imported by
  `http-security-plugin` (writer) and `auth-plugin` (reader). Its module JSDoc is the single written
  home of the §3.10 convention; `ERROR_RESPONDER_STATE_KEY` and `validatedStateKey` stay in their
  current files and `{@linkcode}` it rather than moving, so the diff stays reviewable.
- **Why:** it is the only key with NO constant — a bare literal duplicated across two packages, the
  §11.2 magic-string case, and the one key where a typo on one side is a silent miss rather than a
  compile error. `common` is the only home both packages may import (§2.2), which is exactly why
  `validatedStateKey` and `ERROR_RESPONDER_STATE_KEY` already live there.
- **Test home:** `state-keys.test.ts`, plus `packages/auth-plugin/test/unit/rate-limit-*.test.ts`
  reading through the constant.

### 3.12 The recurrence gate refuses literals, not just wrong values

- **Decision:** `test/state-key-convention.test.ts` does two things. (a) It scans every
  `packages/*/src/**/*.ts` for a `ctx.state.get/set/has/delete` call whose first argument is a
  **string literal** and fails naming the file and line — every key must go through a constant. (b)
  It asserts each of the seven key values against `/^[a-z][a-z0-9-]*:[a-z0-9-]+$/`, by importing the
  constants rather than re-deriving them.
- **Why:** a value-only assertion cannot see a NEW key added as a literal next milestone, which is
  precisely how the four competing conventions accumulated. Part (a) is the durable half and follows
  the M70e `npm-specifier-audit` precedent — a gate that refuses the shape, not a list that goes
  stale. The gate must be shown to discriminate, not merely to pass (§7).
- **Test home:** itself; the negative control is listed in §7.

### 3.13 What is NOT sealed, stated so it is not read as an oversight

- **Decision:** the middleware pipeline (`MiddlewarePipeline`), the router and the lifecycle manager
  keep their current mutability. `IPluginContext` retention is unchanged.
- **Why:** the ROADMAP names the registry only, and no probe found an exposure in the other three.
  `#pipeline.compile()` already runs at step 6, so a stage added afterwards is not in the compiled
  chain — the failure mode there is a silent no-op rather than a mutation of live behaviour, which
  is a different (and quieter) defect than the ones this milestone closes. Naming it here so a later
  milestone picks it up deliberately rather than rediscovering it.
- **Test home:** none — this is a scope statement, and §6 adds no test for it.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                  | Kind     | Consumer / real code path that READS it                                                                                                           |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sealRequestIdentity` (`common`) | function | `packages/kernel/src/context/request-context.ts` (every pipeline request) and `packages/testing/src/mock-context.ts` `createTestContext`.         |
| `replacePrincipal` (`common`)    | function | `packages/auth-plugin/src/middleware/auth-middleware.ts:30` — replaces the bare `ctx.request.user = principal`.                                   |
| `replaceTenant` (`common`)       | function | `packages/multi-tenancy-plugin/src/middleware/tenant-middleware.ts:145` — replaces the bare `ctx.request.tenant = resolved`.                      |
| `CLIENT_IP_STATE_KEY` (`common`) | const    | WRITTEN by `http-security-plugin/src/middleware/ip-security-middleware.ts:79`; READ by `auth-plugin/src/middleware/rate-limit-middleware.ts:130`. |

No symbol is removed from any barrel. `ERROR_RESPONDER_STATE_KEY`, `validatedStateKey` and
`TELEMETRY_SPAN_KEY` keep their names and exports and change only their VALUES — which is a
behaviour change, not a surface change, and is CHANGELOG'd as such (§9.4).

### 4.1 Options — every option names its consumer

None (checked). This milestone adds no plugin option, no `RegisterOptions` member and no
`ApplicationOptions` member. The seal is unconditional and has no opt-out: an opt-out would be an
option whose only honest use is "my plugin registers after boot", which is the behaviour being
closed, and shipping the escape hatch alongside the guard would make the guard advisory.

## 5. Implementation files

| File                                                                     | Purpose                                                                                                           |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/request-identity.ts`                                | NEW. `sealRequestIdentity`, `replacePrincipal`, `replaceTenant`; module-level descriptors and symbol slots.       |
| `packages/common/src/state-keys.ts`                                      | NEW. `CLIENT_IP_STATE_KEY`; module JSDoc is the written home of the §3.10 convention.                             |
| `packages/common/src/index.ts`                                           | Barrel: four new exports (§4).                                                                                    |
| `packages/common/src/http.ts`                                            | JSDoc on `IRequest.user`/`.tenant` — single-write semantics, the escapes, and the §3.9 honesty clause.            |
| `packages/common/src/registry.ts`                                        | JSDoc on `register`/`registerFactory`/`unregister` — the post-bootstrap throw and the override/unregister report. |
| `packages/common/src/errors/error-responder.ts`                          | `ERROR_RESPONDER_STATE_KEY` value → `'exceptions:error-responder'`.                                               |
| `packages/common/src/services/validation.ts`                             | `validatedStateKey` value → `` `validation-plugin:validated-${target}` ``; C2 `rawBody` example fix.              |
| `packages/kernel/src/registry/service-registry.ts`                       | `#sealed`, `seal()`, `#observer`, `setObserver()`; throws in `register`/`registerFactory`/`unregister`.           |
| `packages/kernel/src/application/application.ts`                         | Install the observer; `seal()` after step 7; guarded `#reportRegistryMutation`.                                   |
| `packages/kernel/src/context/request-context.ts`                         | `sealRequestIdentity(request)` before building the context.                                                       |
| `packages/testing/src/mock-context.ts`                                   | Same call in `createTestContext`, at the same point.                                                              |
| `packages/http-security-plugin/src/middleware/ip-security-middleware.ts` | Write through `CLIENT_IP_STATE_KEY`.                                                                              |
| `packages/auth-plugin/src/middleware/rate-limit-middleware.ts`           | Read through `CLIENT_IP_STATE_KEY`.                                                                               |
| `packages/auth-plugin/src/middleware/auth-middleware.ts`                 | `replacePrincipal(ctx.request, principal)`.                                                                       |
| `packages/multi-tenancy-plugin/src/middleware/tenant-middleware.ts`      | `replaceTenant(ctx.request, resolved)`.                                                                           |
| `packages/telemetry-plugin/src/interfaces/index.ts`                      | `TELEMETRY_SPAN_KEY` value → `'telemetry-plugin:span'`.                                                           |
| `packages/session-plugin/src/services/session-service.ts`                | `SESSION_STATE_KEY` value → `'session-plugin:session'`.                                                           |
| `packages/validation-plugin/src/index.ts`                                | C3: module JSDoc example reads through `validatedStateKey`.                                                       |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                         | src covered                                                                       | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/common/test/unit/request-identity.test.ts`                              | `common/src/request-identity.ts`                                                  | `sealRequestIdentity(req: IRequest): void` — first write lands; second throws naming the field; `'user' in req` stays true and reads `undefined` before any write; a SEEDED value counts as written; `replacePrincipal(req, p: IPrincipal): void` overwrites and re-arms; `replaceTenant` likewise; symbols are invisible to `Object.keys`/`JSON.stringify`; sealing twice is idempotent.                                      |
| `packages/common/test/unit/state-keys.test.ts`                                    | `common/src/state-keys.ts`, `errors/error-responder.ts`, `services/validation.ts` | Every key value pinned byte-for-byte; each matches the §3.12 regex; `validatedStateKey` pinned for all five `ValidationTarget` members.                                                                                                                                                                                                                                                                                        |
| `packages/kernel/test/unit/registry/service-registry-seal.test.ts`                | `kernel/src/registry/service-registry.ts`                                         | `seal()` then `register`/`registerFactory`/`unregister` throw naming the token and `onBootstrap`; `get`/`getAll`/`has` unaffected; `createChild()` of a sealed parent accepts registrations and emits no event; `seal()` twice is a no-op; the observer fires for an override and for a real `unregister`, and NOT for a first registration, NOT for a `multi` registration, and NOT for an `unregister` that removed nothing. |
| `packages/kernel/test/integration/registry-seal.test.ts`                          | `kernel/src/application/application.ts`                                           | A REAL `createApplication` + `start()`, then `app.services.register(...)` throws; a plugin registering in `onInit` and in `onBootstrap` still succeeds; `inject()` still serves after the seal; a request-scoped `ctx.services.register` inside middleware still works end to end.                                                                                                                                             |
| `packages/kernel/test/integration/registry-observability.test.ts`                 | `kernel/src/application/application.ts`                                           | A REAL recording `ILogger` under `CAPABILITIES.LOGGER`: an override during plugin B's `register()` logs at **`info`** naming the token AND `'b'`; an `unregister` logs at **`warn`**; with NO logger registered, both still succeed and nothing throws; a logger whose `info` THROWS does not break startup.                                                                                                                   |
| `packages/kernel/test/integration/request-identity.test.ts`                       | `kernel/src/context/request-context.ts`                                           | Through `app.inject`: a handler's second `ctx.request.user = …` produces the kernel 500 rather than a silent overwrite; a single write is unaffected; `ctx.request.raw`/`signal`/`ip` still read correctly after sealing.                                                                                                                                                                                                      |
| `packages/testing/test/unit/mock-context.test.ts` (extend)                        | `testing/src/mock-context.ts`                                                     | `createTestContext()` returns a context whose `request.user` accepts one write and throws on the second — the double honours the real contract; a context seeded with `request: { user }` reads it back and refuses a second write.                                                                                                                                                                                            |
| `packages/auth-plugin/test/unit/middleware/auth-middleware.test.ts` (extend)      | `auth-plugin/src/middleware/auth-middleware.ts`                                   | `authMiddleware()` run TWICE over one sealed request succeeds and the second principal wins (the escape); a null principal writes nothing.                                                                                                                                                                                                                                                                                     |
| `packages/auth-plugin/test/unit/middleware/rate-limit-*.test.ts` (extend)         | `auth-plugin/src/middleware/rate-limit-middleware.ts`                             | The IP is read from `CLIENT_IP_STATE_KEY`, imported from `common` — not from the literal.                                                                                                                                                                                                                                                                                                                                      |
| `packages/http-security-plugin/test/unit/ip-security-middleware.test.ts` (extend) | `.../ip-security-middleware.ts`                                                   | The IP is written under `CLIENT_IP_STATE_KEY`; a cross-package round trip asserts writer and reader agree by CONSTANT.                                                                                                                                                                                                                                                                                                         |
| `packages/multi-tenancy-plugin/test/unit/tenant-middleware.test.ts` (extend)      | `.../tenant-middleware.ts`                                                        | Two resolutions in one request succeed via the escape; the cache prefix still stamps under the unchanged key.                                                                                                                                                                                                                                                                                                                  |
| `packages/session-plugin/test/**` (extend)                                        | `session-plugin/src/services/session-service.ts`                                  | `getSession(ctx)` still returns the session after the key rename — driven through the middleware, so the writer and reader are proven to agree.                                                                                                                                                                                                                                                                                |
| `packages/telemetry-plugin/test/**` (extend)                                      | `telemetry-plugin/src/interfaces/index.ts`                                        | `TELEMETRY_SPAN_KEY` pinned to the new value; the middleware round trip still reads its own span.                                                                                                                                                                                                                                                                                                                              |
| `test/state-key-convention.test.ts`                                               | repo-wide gate                                                                    | No `ctx.state.{get,set,has,delete}('literal')` anywhere in `packages/*/src`; every exported key constant matches `/^[a-z][a-z0-9-]*:[a-z0-9-]+$/`.                                                                                                                                                                                                                                                                             |

No external dependency is added, so no guarded real-import test applies (checked).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m71-kernel-contract-hardening, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # on a COMMITTED tree
deno task release:verify 0.1.0-alpha.8
```

**Negative controls — each must be observed FAILING and then reverted, and the observation recorded
in the PR body:**

1. Remove the `seal()` call from `application.ts` → `registry-seal.test.ts` must fail.
2. Make `createChild()` inherit `#sealed` → the request-scoped-registration test must fail while the
   seal tests still pass (proving the two are independently covered).
3. Swap the `info`/`warn` levels in `#reportRegistryMutation` → `registry-observability.test.ts`
   must fail on the LEVEL, not merely on the message.
4. Drop `sealRequestIdentity` from `createTestContext` only → the `testing` double test must fail
   while the kernel integration test still passes (proving the double is covered on its own).
5. Re-introduce a bare `ctx.state.set('clientIp', ip)` in `ip-security-middleware.ts` →
   `test/state-key-convention.test.ts` must fail naming that file and line. **This is the control
   that proves the gate discriminates rather than passing vacuously.**
6. Revert `authMiddleware` to bare assignment → the run-twice test must fail with the guard's throw.

## 8. Risks & mitigations

- **The guard is oversold.** Risk: a reader takes "single-write `request.user`" for an authorization
  control. Mitigation: §3.9's honesty clause is written into the JSDoc, `PUBLIC_API.md` and the
  CHANGELOG entry, and a NAMED test records that a pre-authentication write is permitted.
- **Per-request cost.** Risk: §14 forbids per-request work that could be hoisted. Mitigation:
  measured before choosing — 298 ns/property with shared descriptors versus 699 ns with per-request
  closures; the shared form is implemented and the two-property figure is re-measured and recorded
  in the PR body.
- **A key rename breaks a consumer reading the literal.** Risk: five values change. Mitigation:
  CHANGELOG migration text naming each old and new value and pointing at the exported constant; C3
  removes the literals from the docs that taught them; the constants themselves keep their names, so
  a consumer already reading through one is unaffected.
- **The seal breaks an out-of-repo plugin that registers late.** Risk: real, and intended — that is
  the defect being surfaced. Mitigation: the throw names the three supported registration phases
  (§3.3), and the CHANGELOG entry is marked breaking.
- **A test double diverges from the sealed contract.** Risk: this repository's most recurrent root
  cause. Mitigation: `createTestContext` gets the identical call (§3.8) with its own test and its
  own negative control (#4), and `MockServiceRegistry` deliberately grows NO seal, because
  `IServiceRegistry` does not have one.
- **`docs/api/**` goes stale on the renamed constants.** Risk: generated HTML still shows old
  values. Mitigation: it is generated output rebuilt on release (`docs/releasing.md`), explicitly
  out of scope in §0; the hand-written docs (`PUBLIC_API.md`, `ARCHITECTURE.md`, two package
  READMEs) are all corrected in this PR.

## 9. Out of scope

- **Sealing the middleware pipeline, router and lifecycle manager** — §3.13 states why and leaves
  them named for a later milestone rather than silently unclosed.
- **`ctx` retention / per-request memory** — measured at no framework leak; owned by nobody.
- **A hostile-plugin threat model** — explicitly not a goal (§0), not a deferral.
- **`--broker`/`--queue` flags and interactive scaffolding** — M72.
- **Realtime authentication over cookies** — M73.
- **A read-only realtime registry lookup and the `SseMessage.data` narrowing** — M74.
- **Broker trace propagation via `MessageMetadata.headers`** — M75.
