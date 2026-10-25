# Milestone 125 — A compiled container and a request scope (`@setu-ts/di-plugin`, `@setu-ts/common`, `@setu-ts/kernel`, `@setu-ts/decorator-plugin`, `@setu-ts/testing`)

> **Status:** Planning. Branch: `feat/m125-compiled-container`. `develop` and `main` are protected —
> all work (implementation + fixes) stays on this one branch until it merges via a single PR. Ships
> in **0.11.0**, a minor that already carries a BREAKING entry (`CHANGELOG.md:107`).

## 0. Objective & scope

Make the optional DI container safe and fast to use per request. Today a singleton silently captures
a scoped service, the dependency graph is checked only on the first resolve that reaches it, tokens
are untyped strings, and no request scope exists. After this milestone the container compiles its
graph into direct factories, validates it once at boot, accepts typed and class tokens, disposes
what it creates, and gives every request a lazily created scope that is disposed when the response
is finished — without moving a request that never uses it off the kernel's synchronous path.

- **In scope:** ROADMAP M125 findings 1–6 and decisions 1–7, as corrected in §2; the kernel's
  generic per-request cleanup primitive (`ctx.defer`); the decorator parameter source that reaches
  the request scope; `apps/di-decorators` moved onto it; docs, PUBLIC_API, CHANGELOG, upgrade guide.
- **NOT this milestone:**
  - Static `@Module` graph validation in `setu check` — after M118 and this milestone both ship
    (ROADMAP M125 "Named, not taken").
  - Tenant-keyed scopes (NestJS durable providers) — named, not taken; no consumer yet.
  - An ambient `currentScope()` over `AsyncLocalStorage` — named, not taken.
  - Request scopes for non-HTTP ingress (`IngressContext`: queue jobs, WebSocket messages, gRPC
    streams) — §9.
  - `Symbol.dispose` / `Symbol.asyncDispose` support — §9.
  - Per-request provider slots declared on the root and filled by middleware — §9.

## 1. Contracts verified from SOURCE (not names)

| Reference                                     | Source (file:line)                                                                       | Verified surface / fact                                                                                                                                                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IContainer`                                  | `packages/common/src/container.ts:100-134`                                               | `register<T>(token: string, provider, options?)` (throws on duplicate), `resolve<T>(token: string)`, `has(token: string)`, `createScope(): IContainer`. No dispose member.                                                                                          |
| `ServiceScope` JSDoc                          | `packages/common/src/container.ts:17-26`                                                 | Says the application "disposes" a scope explicitly and that the framework creates no scope per request. The first half describes nothing (no dispose member).                                                                                                       |
| `ClassProvider` / `FactoryProvider`           | `packages/common/src/container.ts:33-56`                                                 | `inject?: readonly string[]` (bare tokens, no optionality); `useFactory: () => T` takes no arguments.                                                                                                                                                               |
| `Constructor<T>`                              | `packages/common/src/container.ts:14`                                                    | `new (...args: never[]) => T` — the precedent for `never[]` parameter typing.                                                                                                                                                                                       |
| `IRequestContext`                             | `packages/common/src/http.ts:318-358`                                                    | `id, request, response, services, params, query, state, startTime, signal, raw?`. No cleanup member. Implemented by the kernel's `RequestContext` and by `createTestContext` (`packages/testing/src/mock-context.ts:398`).                                          |
| `IPluginContext.container`                    | `packages/common/src/plugin.ts:534`                                                      | `readonly container?: IContainer`, resolved lazily from `CAPABILITIES.DI_CONTAINER` (`packages/kernel/src/application/application.ts:651`).                                                                                                                         |
| `ILifecycleApi.onResponse`                    | `packages/common/src/plugin.ts:354`                                                      | Exists, but any registered response hook disables the kernel's synchronous path (next row), so it is not used here.                                                                                                                                                 |
| Kernel synchronous path (M87)                 | `packages/kernel/src/application/application.ts:1214-1226`                               | `#runRequest` dispatches directly only when there are no request hooks, no response hooks and an empty compiled chain; otherwise every request takes `#runRequestFull`.                                                                                             |
| Kernel request completion                     | `packages/kernel/src/application/application.ts:1163-1178`, `:1679-1720`                 | Sync and async success both run `#inFlight--` then `#completeRequest`; failure goes `#failRequest` → `#finishFailure` (`#inFlight--`, report, 500). The stopping-503 and bad-request-400 paths create no handler context.                                           |
| Request context laziness                      | `packages/kernel/src/context/request-context.ts:49-140`                                  | One class, prototype getters; the child registry is created on first `ctx.services` read (`:87-90`). A new private field follows the same pattern.                                                                                                                  |
| `ResponseBuilder` streaming                   | `packages/kernel/src/context/response.ts:32-33`, `:105-108`                              | `#body` holds the `ReadableStream`, `#streaming` flags it; `stream(body)` replaces both. The kernel owns the class, so it can swap in a wrapped stream.                                                                                                             |
| Bootstrap order and sealing                   | `packages/kernel/src/application/application.ts:790-791`; `lifecycle-manager.ts:152-158` | `runBootstrap()` iterates `for (const fn of this.#bootstrap)` over the live array, so a hook pushed during the run is visited; `registry.seal()` follows. ARCHITECTURE "Registry Sealing" confirms registration is allowed until then.                              |
| Cycle detector usage                          | `packages/di-plugin/src/container/container.ts:169`                                      | `#resolveToken` enters the detector before any lookup, cache hits included.                                                                                                                                                                                         |
| Captive scoped (finding 1)                    | `packages/di-plugin/src/container/scope-manager.ts:96-97`; `container.ts:228-234`        | `createChild()` passes the parent's singleton map and a fresh scoped map; a singleton built inside a scope keeps that scope's instances. The root has its own scoped map, so `scoped` on the root behaves as a singleton.                                           |
| Auto-registration                             | `packages/di-plugin/src/plugin/di-plugin.ts` (`register`); `container.ts:177-185`        | `autoRegister` (default `true`) resolves an unknown token through `ctx.services.has/get` and caches it as a singleton. Registry factories stay lazy until that first resolve.                                                                                       |
| `ProviderRegistry`                            | `packages/di-plugin/src/container/provider-registry.ts`                                  | String-keyed `Map` with a parent chain; `register` throws on a duplicate in the same registry.                                                                                                                                                                      |
| `@Optional` closure (finding 2)               | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:240-283`                       | A class with an optional argument registers a `useFactory` that closes over the registering container, so its dependencies never come from the resolving scope.                                                                                                     |
| Controllers built at registration (finding 3) | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:996-997`                       | `registerInContainer(...)` then `instantiate(target, ctx)` during the decorator plugin's `register()` — before any bootstrap hook. Controllers register with the container's default scope (`opts` only when `@Injectable({ scope })` is present).                  |
| `@Inject` / `@Optional`                       | `packages/decorator-plugin/src/decorators/injection.ts:32-41`, `:92-135`                 | `InjectToken = string \| OptionalToken`, `OptionalToken = { token: string; optional: true }`; `@Inject` stores names plus optional indices.                                                                                                                         |
| `ParamSource` / `Ctx()`                       | `packages/decorator-plugin/src/decorators/params.ts:47-66`, `:202-208`                   | A source is `{ descriptor }`; `Ctx()` is a `custom` descriptor with a branded metadata marker.                                                                                                                                                                      |
| Custom parameter classification               | `packages/decorator-plugin/src/resolvers/parameter-resolver.ts:186-247`                  | `classifyCustom` is the single source for request-time resolution and the startup "unresolvable" warning; `resolveParameters(ctx, params)` is public and takes only the request context.                                                                            |
| Name collision check                          | `packages/decorator-plugin/src/index.ts:46-57`, `:81`                                    | `ScopedRoles`/`ScopedPermissions` exist (RBAC scopes), so a `Scoped(...)` source name would mislead; `Service` is unused.                                                                                                                                           |
| `overrideProvider` / `OverridingContainer`    | `packages/testing/src/override-provider.ts:25-66`, `:85-140`                             | Implements `IContainer` by delegation, registers the override on the container during `register()`, and re-registers itself under `DI_CONTAINER` with `override: true`.                                                                                             |
| Example app                                   | `apps/di-decorators/src/modules/lifetimes/lifetimes.controller.ts:18-35`                 | Reaches scoped services only by calling `createScope()` inside a handler.                                                                                                                                                                                           |
| di-plugin exports                             | `packages/di-plugin/src/index.ts`; `PUBLIC_API.md:13424-13480`                           | `DiPlugin`, `ContainerBuilder`, `createContainer`, `DiContainer`, `CircularDetector`, `ProviderRegistry`, `ScopeManager`; types `DiPluginOptions`, `ContainerConfig`, `ExternalResolver`, `ProviderEntry`. No other package imports any of them (grep, 2026-10-25). |
| Docs that pin "no scope per request"          | `docs/decorators.md:383-431`; `docs/migration-nestjs.md:878-897`; both AGENT_CARDs       | Prose and fences state the current behaviour; `test/guide-fence-compiler.test.ts:138` compiles the decorators guide fences.                                                                                                                                         |
| Capability-token grammar                      | `packages/common/src/tokens.ts:353`                                                      | No new capability token is added; `createToken` creates DI tokens, which are not capability tokens and are not validated by that grammar.                                                                                                                           |
| Versioning Policy                             | `ROADMAP.md` "Versioning Policy From `0.9.0`"; `CHANGELOG.md:7`, `:107`                  | Breaks are batched into a minor; `Unreleased` is 0.11.0 and already carries a BREAKING entry.                                                                                                                                                                       |
| Workers post-response work                    | `packages/cloudflare-plugin/src/options.ts:187-217`                                      | Work after the response needs `waitUntil`, which only the Cloudflare plugin holds; the kernel has no `waitUntil` contract. This decides §3.9's ordering.                                                                                                            |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                                                    | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                                                 | Doc deliverable (same PR)                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| C1  | ROADMAP M125 decision 2 gives each `createToken` token a process-unique numeric `id` assigned at creation. AI_GUIDELINES §11.4 forbids global state, and a creation counter is module-level mutable state.                  | **AI_GUIDELINES wins: no id.** A token is a frozen object keyed by identity. The id existed to make a resolve an array read; with the graph compiled (§3.3) every dependency inside it is a direct reference with no lookup, so a lookup happens only at a top-level `resolve()` — one `Map` read on the token object, the same cost as a string token today. **Maintainer to confirm.** | ROADMAP M125 decision 2 rewritten to match.                                                 |
| C2  | ROADMAP decision 4 makes the request scope kernel-owned (`ctx.scope()`). AI_GUIDELINES §2.4 and §3.1 keep the kernel to orchestration, with DI an optional plugin.                                                          | **The kernel gains only a generic cleanup primitive (`ctx.defer`, §3.8); the scope lives in di-plugin as `container.forRequest(ctx)` (§3.10).** Same cost profile — nothing allocated until first use, one `undefined` check at completion — with no DI concept in the kernel.                                                                                                           | ROADMAP decision 4 rewritten to match.                                                      |
| C3  | ROADMAP decision 4 says disposal runs after the response is handed back. On Workers that work can be cut off without `waitUntil`, which the kernel cannot reach (§1, last row).                                             | **Cleanup finishes before a buffered response is handed back, and when the body stream ends, errors or is cancelled for a streaming one (§3.9).** A request with no cleanup is unaffected.                                                                                                                                                                                               | ROADMAP decision 4 rewritten to match.                                                      |
| C4  | ROADMAP decision 7 has existing paths warn for one release and refuse in "the next minor". The next release, 0.11.0, is itself a minor that already carries a BREAKING entry.                                               | **Refuse in 0.11.0, with BREAKING CHANGELOG entries and upgrade-guide steps; no warning phase.** The Versioning Policy batches breaks into a minor, and 0.11.0 is that minor. If M125 misses the 0.11.0 cut, the entries move to the next minor unchanged. **Maintainer to confirm.**                                                                                                    | ROADMAP decision 7 rewritten to match.                                                      |
| C5  | ROADMAP decision 6 suggests the parameter source be named `Scoped(...)`. `ScopedRoles`/`ScopedPermissions` already mean RBAC scopes in the same package.                                                                    | **Named `Service(token)`.**                                                                                                                                                                                                                                                                                                                                                              | ROADMAP decision 6 rewritten to match.                                                      |
| C6  | `ServiceScope` JSDoc says the application "disposes" a scope; `IContainer` has no dispose member.                                                                                                                           | `IContainer.dispose()` is added (§3.7) and the JSDoc is rewritten to describe the request scope.                                                                                                                                                                                                                                                                                         | `packages/common/src/container.ts` JSDoc; PUBLIC_API common DI rows.                        |
| C7  | `docs/decorators.md`, `docs/migration-nestjs.md`, the di-plugin README and both AGENT_CARDs state that the framework creates no scope per request and that `scoped` behaves as a singleton until `createScope()` is called. | The behaviour changes; the docs follow it.                                                                                                                                                                                                                                                                                                                                               | Those five files rewritten; their fences compile under `test/guide-fence-compiler.test.ts`. |

## 3. Design decisions

### 3.1 Container lifecycle: open, then closed at the end of bootstrap

- **Decision:** A `DiContainer` is **open** from construction: `register` and `resolve` both work,
  and a resolve compiles the token's subgraph on demand (§3.3). `DiContainer.close()` compiles and
  validates every registered provider (§3.2) and moves the container to **closed**; a `register` on
  a closed root throws `ContainerClosedError` naming the token. A scope (from `createScope` or
  `forRequest`) stays open for tokens its parent chain does not have — a per-request leaf value, for
  instance — compiled on demand within that scope; registering a token the parent chain already has
  throws the registry's duplicate-token error, because a compiled parent graph cannot be rebound
  from below (shadowing in a child was allowed before, and the root graph's dependents honoured it).
  Root providers cannot depend on a scope-only token: §3.2 reports it as missing.
  `DiPlugin.register()` adds an `onBootstrap` hook whose body adds a second `onBootstrap` hook that
  calls `close()`. `runBootstrap()` iterates the live hook array (§1), so the close runs after every
  bootstrap hook registered before bootstrap began — the same moment the service registry seals. A
  standalone container (`createContainer`, `ContainerBuilder.build()`) stays open until its owner
  calls `close()`; `close()` is a `DiContainer` method, not an `IContainer` member, because only the
  owner of a container may end its registration phase.
- **Why:** The decorator plugin resolves controllers during `register()` (§1), so resolution must
  work before close. Closing at the seal point matches the registry's own rule, so a plugin may
  still register providers from a bootstrap hook.
- **Test home:** `di-plugin/test/unit/container-lifecycle.test.ts`;
  `di-plugin/test/integration/di-plugin.test.ts` (a later plugin's bootstrap hook registers
  successfully; a registration after `start()` throws `ContainerClosedError`; a request scope
  registers and resolves a new leaf token; shadowing a parent token in a scope throws).

### 3.2 Boot validation: one error listing every finding

- **Decision:** `close()` walks the graph from every registered token and collects findings of three
  kinds: a **missing** dependency (not registered, not optional, and not resolvable through the
  external resolver when `autoRegister` is on — checked with `has()`, never by resolving); a
  **cycle**, reported as `A → B → A`; and a **captive** dependency — a `singleton` that reaches a
  `scoped` provider directly or through any chain of `transient` providers. All findings are thrown
  together as one `ContainerValidationError` whose `findings` array carries
  `{ kind: 'missing' | 'cycle' | 'captive', token, path }` and whose message lists each one. A
  factory provider without `inject` is opaque: it is excluded from the walk, and `DiPlugin` logs one
  `debug` line listing the unchecked tokens. External (service-registry) tokens are leaves with
  singleton lifetime. Validation never instantiates anything.
- **Why:** Fails the boot on wiring mistakes, as NestJS and .NET `ValidateOnBuild` do, instead of on
  the first request that reaches them; one error with every finding saves a fix-boot-fix loop.
- **Test home:** `di-plugin/test/unit/compiler.test.ts` (table-driven: each kind, several at once,
  optional missing allowed, external leaf, opaque factory skipped and listed).

### 3.3 Compiled resolution, one implementation

- **Decision:** Each provider compiles once into a resolver function. Its dependencies are direct
  references to their own compiled resolvers — no `Map` lookup and no cycle detector on any resolve.
  A singleton is still created lazily, on first resolve, and cached on its compiled entry. A scoped
  provider gets a slot index; a scope holds one `unknown[]` of those slots, allocated on the scope's
  first scoped resolve. A transient is constructed on every resolve. Compilation happens on the
  first resolve of a token while open (compiling and validating only that subgraph) and for
  everything at `close()`; there is no second, uncompiled resolution path. The walk uses the
  existing `CircularDetector`, which keeps a real reader. `ScopeManager` is replaced by the slot
  array and singleton fields, and is deleted with its export (prerelease rule, AI_GUIDELINES §9).
- **Why:** AI_GUIDELINES §14 — per-request work moves to registration time. One compiled path keeps
  pre-close and post-close resolution from disagreeing.
- **Test home:** `di-plugin/test/unit/container.test.ts` (rewritten), `compiler.test.ts`.

### 3.4 Lifetime rules at resolve time

- **Decision:** Resolving a `scoped` token on the root container throws `ScopeRequiredError` naming
  the token. Resolving a `transient` on the root whose graph reaches a `scoped` provider throws the
  same error; whether it reaches one is computed at compile time as a flag on the compiled entry,
  not walked per resolve. Inside a scope, all three lifetimes resolve, and a transient created there
  is tracked by that scope for disposal. A child of a scope is a scope with its own slot array.
- **Why:** These are the two remaining captive shapes not visible as a singleton-to-scoped edge.
  .NET refuses both.
- **Test home:** `container.test.ts` (both refusals; transient tracked by its scope).

### 3.5 Tokens: strings, typed token objects and classes

- **Decision:** `@setu-ts/common` adds `InjectionToken<T>` (a frozen object `{ name }` carrying a
  phantom `T`) and `createToken<T>(name: string): InjectionToken<T>`, a pure function with no state.
  `ContainerToken<T> = string | InjectionToken<T> | Constructor<T>`. `register`, `resolve` and `has`
  accept any `ContainerToken`; `resolve` on an `InjectionToken<T>` or `Constructor<T>` returns `T`
  with no type argument, and on a string keeps `resolve<T>(token: string): T`. The registry keys one
  `Map` by the token value itself (identity for objects). A token's `name`, a class's `name` or the
  string is used only in error messages. The decorator plugin registers an `@Injectable` class under
  its string token as today **and** under the class itself as an alias to the same compiled entry,
  so `resolve(UserService)` returns the same instance as `resolve('UserService')`.
- **Why:** Typed resolution without a build step; §2 C1 for why there is no id.
- **Test home:** `common/test/unit/container-token.test.ts`; `di-plugin/test/unit/container.test.ts`
  (typed resolve compiles with no type argument — asserted by a `expectTypeOf` check — class alias
  identity, a minified-name class still resolves by identity).

### 3.6 Dependencies a factory and a class declare

- **Decision:**
  `InjectEntry = ContainerToken<unknown> | { token: ContainerToken<unknown>; optional: true }`.
  `ClassProvider.inject` and a new optional `FactoryProvider.inject` take `readonly InjectEntry[]`.
  `FactoryProvider.useFactory` becomes `(...deps: never[]) => T` and is called with the resolved
  dependencies in order — the `Constructor<T>` precedent for `never[]`. An absent optional
  dependency is passed as `undefined`. The decorator plugin's `@Optional` path registers a
  `ClassProvider` with `{ token, optional: true }` entries and its factory closure is deleted.
- **Why:** Makes factory dependencies visible to validation (§3.2) and retires finding 2.
- **Test home:** `container.test.ts` (factory receives dependencies; optional absent → `undefined`);
  `decorator-plugin/test/integration/di-optional-scope.test.ts` (an `@Optional` class's dependency
  comes from the resolving request scope, not the root).

### 3.7 Disposal

- **Decision:** `ProviderOptions` becomes `ProviderOptions<T = unknown>` with
  `dispose?: (instance: T) => void | Promise<void>`, and `register<T>` takes `ProviderOptions<T>`.
  `IContainer.dispose(): void | Promise<void>` disposes, in reverse creation order, every instance
  the container created that has a `dispose` option: on a scope, its scoped instances and the
  transients it created; on the root, its singletons and the transients built as their dependencies.
  Instances obtained from the external resolver (the service registry) are never disposed. It
  returns a promise only when at least one dispose function returned one, so a scope with no
  asynchronous disposal leaves the request synchronous (§3.13). Each dispose function runs even if
  an earlier one failed; failures are thrown, or rejected, together as one `AggregateError` after
  all have run. A second `dispose()` is a no-op. Any `resolve` on a disposed scope throws
  `ScopeDisposedError`. `DiPlugin` disposes the root in an `onClose` hook.
- **Why:** Makes the `ServiceScope` JSDoc true (§2 C6) and gives a unit of work somewhere to release
  its connection. An explicit option is portable to every runtime; `Symbol.dispose` support is §9.
- **Test home:** `di-plugin/test/unit/dispose.test.ts`; `di-plugin.test.ts` (root disposed on
  `app.stop()`).

### 3.8 Kernel: `ctx.defer` — generic per-request cleanup

- **Decision:** `IRequestContext` gains an **optional** member
  `defer?(cleanup: () => void | Promise<void>): void`. The kernel's `RequestContext` implements it
  with a private list allocated on first call. At completion — the sync success path, the async
  success path and the failure path — the kernel checks whether the list exists; if not, nothing
  else happens and the M87 synchronous path is unchanged. If it exists, cleanups run in reverse
  registration order (§3.9 sets when). A cleanup's throw or rejection is reported once at `warn`
  with `describeError`, through the logger capability when one is registered and otherwise nowhere —
  the kernel's existing precedent for a failure with no safe channel (`#reportSuppressedHookError`)
  — and it never changes the response. A `defer` called after completion runs its cleanup
  immediately, reporting failures the same way. `createTestContext` does not implement it.
- **Why:** The kernel stays DI-agnostic (§2 C2); the one per-request cost is an `undefined` check.
  Optional, so no third-party `IRequestContext` implementor breaks.
- **Test home:** `kernel/test/unit/request-context-defer.test.ts`;
  `kernel/test/integration/deferred-cleanup.test.ts`.

### 3.9 When cleanup runs

- **Decision:** For a **buffered** response, cleanups run after the response is final and before
  `#inFlight--`, so a shutdown drain waits for them. If any returns a promise, the kernel awaits all
  of them (each settled independently) before handing back the response, and that request's handler
  result becomes a promise; if all are synchronous it stays synchronous. For a **streaming**
  response, the kernel replaces the body with a wrapping `ReadableStream` that forwards every chunk
  and runs the cleanups once when the source ends, errors, or the consumer cancels. The failure path
  runs cleanups after the 500 is written, the same way.
- **Why:** §2 C3 — work after the response is not reliable on Workers, and a streamed body (SSE)
  still uses its services until the stream ends.
- **Test home:** `deferred-cleanup.test.ts` (buffered sync, buffered async awaited before return,
  stream end, stream cancel, handler throws, cleanup throws and is logged with the response
  unchanged, drain waits).

### 3.10 The request scope: `container.forRequest(ctx)`

- **Decision:** `IContainer.forRequest(ctx: IRequestContext): IContainer` returns the scope for that
  request, creating it on first call and caching it in a `WeakMap` held by the container instance
  (no module-level state). On creation it calls `ctx.defer(() => scope.dispose())`; when `ctx.defer`
  is absent it throws `RequestScopeUnavailableError` saying the context cannot dispose a scope and
  naming `createTestApp` as the way to test one. A request that never calls `forRequest` pays only
  §3.8's `undefined` check. `OverridingContainer` forwards `forRequest` and `dispose`, wrapping the
  returned scope so a claimed override still applies inside it.
- **Why:** The Awilix and `@fastify/awilix` shape (a child scope per request, disposed at the end),
  without the kernel knowing about DI (§2 C2).
- **Test home:** `di-plugin/test/unit/request-scope.test.ts`;
  `di-plugin/test/e2e/request-scope-e2e.test.ts`; `testing/test/unit/override-provider.test.ts`.

### 3.11 Decorated handlers: `@Params(Service(token))`

- **Decision:** `Service<T>(token: ContainerToken<T>): ParamSource<T>` is a `custom` source with a
  branded metadata marker, like `Ctx()`. `classifyCustom` gains a `service` kind, so request-time
  resolution and the startup check stay one implementation. At request time it resolves
  `ctx.services.get<IContainer>(CAPABILITIES.DI_CONTAINER).forRequest(ctx).resolve(token)`, which
  makes the public `resolveParameters(ctx, params)` honour it too. The startup check reports a
  `Service` parameter as unresolvable when no DI container is registered. Controllers register in
  the container with `scope: 'singleton'` explicitly, matching how they are built once; a controller
  constructor that reaches a scoped service therefore fails the boot with a captive finding (§3.2),
  whose message names `@Params(Service(...))` as the fix.
- **Why:** Retires finding 3 without NestJS-style scope bubbling.
- **Test home:** `decorator-plugin/test/unit/service-param.test.ts`;
  `decorator-plugin/test/integration/di-optional-scope.test.ts`.

### 3.12 Breaking changes ship in 0.11.0

- **Decision:** Per §2 C4, these are BREAKING in 0.11.0 with no warning phase: resolving `scoped` on
  the root throws; a captive graph fails the boot; registering after close throws; `useFactory`
  receives its dependencies as arguments; a scope can no longer shadow a token its parent has;
  `IContainer` gains required `forRequest` and `dispose`; `ServiceScope`'s `scoped` now means per
  request when reached through `forRequest`; `ScopeManager` is deleted. Each gets a CHANGELOG
  `BREAKING` entry and a `docs/upgrading.md` step.
- **Why:** The Versioning Policy batches breaks into a minor, and 0.11.0 is the minor.
- **Test home:** the tests named in §3.1–§3.11 assert each new refusal.

### 3.13 Performance acceptance

- **Decision:** Two proofs. **Structural, in CI**, at two levels. In the kernel (which cannot import
  a plugin), an integration test registers a capturing HTTP adapter and asserts the captured
  handler's return value is not a `Promise` for a synchronous handler that never calls `ctx.defer`,
  and for one whose deferred cleanups are all synchronous. In di-plugin's e2e (which imports the
  real kernel and runtime as test-only workspace dependencies, the precedent cache-plugin and
  decorator-plugin already follow; `node scripts/node-manifests.ts --write` records them), the same
  capture asserts a synchronous return with `DiPlugin` registered and `forRequest` never called, and
  with a request scope whose disposal is synchronous. **Measured, in the PR:** the benchmark harness
  in three configurations against `develop` — no DI, DI registered and unused, DI with a request
  scope resolving two scoped services — paired and alternating per the harness README, with the
  server built from this branch's `dist/`. Acceptance: configuration 2 is within noise of the
  baseline (paired p > 0.05); configuration 3 costs at most 3% of hello-world throughput.
- **Why:** The fast path is the property most likely to regress silently, so it gets a test, not
  only a measurement.
- **Test home:** `kernel/test/integration/deferred-cleanup.test.ts` (structural); PR body
  (measured).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** `IContainer` gains required `forRequest` and `dispose` — ships in
minor 0.11.0. `IRequestContext.defer` is optional and breaks no implementor.

| Exported symbol                                         | Kind                     | Consumer / real code path that READS it                                            |
| ------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------- |
| `InjectionToken<T>` (common)                            | type                     | `ContainerToken`; `DiContainer.resolve` overloads; `Service()`                     |
| `createToken` (common)                                  | function                 | Applications; `apps/di-decorators` tokens; docs fences                             |
| `ContainerToken<T>` (common)                            | type                     | `IContainer` methods; `InjectEntry`; `Service()`                                   |
| `InjectEntry` (common)                                  | type                     | `ClassProvider.inject`, `FactoryProvider.inject`; the compiler's dependency walk   |
| `ClassProvider.inject` (common, changed)                | field                    | The compiler (§3.3); decorator-plugin `registerInContainer`                        |
| `FactoryProvider.inject`, `useFactory` args (common)    | field                    | The compiler; the factory call                                                     |
| `ProviderOptions<T>.dispose` (common)                   | field                    | `DiContainer.dispose()`                                                            |
| `IContainer.forRequest` / `.dispose` (common)           | method                   | decorator-plugin `Service` resolution; `DiPlugin` `onClose`; `OverridingContainer` |
| `IRequestContext.defer` (common)                        | method                   | `DiContainer.forRequest`                                                           |
| `ContainerValidationError` (di-plugin)                  | class                    | Thrown by `close()` and on-demand compiles; applications catch it by `instanceof`  |
| `ScopeRequiredError` (di-plugin)                        | class                    | Thrown by root `resolve` (§3.4)                                                    |
| `ScopeDisposedError` (di-plugin)                        | class                    | Thrown by `resolve` on a disposed scope                                            |
| `ContainerClosedError` (di-plugin)                      | class                    | Thrown by `register` after close                                                   |
| `RequestScopeUnavailableError` (di-plugin)              | class                    | Thrown by `forRequest` without `ctx.defer`                                         |
| `DiContainer.close()` (di-plugin, new method)           | method                   | `DiPlugin`'s bootstrap hook; standalone owners                                     |
| `Service` (decorator-plugin)                            | function (`ParamSource`) | `classifyCustom`; `apps/di-decorators`                                             |
| `ScopeManager` (di-plugin)                              | class — **deleted**      | None after §3.3; removed with its PUBLIC_API row and a CHANGELOG entry             |
| `CircularDetector`, `ProviderRegistry`, `ProviderEntry` | unchanged exports        | The compiler walk; the registry store                                              |

### 4.1 Options — every option names its consumer

| Option                              | Consumer                                    | Behavior (per implementation)                                                               |
| ----------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `ProviderOptions.dispose`           | `DiContainer.dispose()`                     | Called once per created instance, reverse creation order; failures aggregated after all run |
| `ProviderOptions.scope` (unchanged) | the compiler                                | Selects the compiled resolver; `scoped` gets a slot                                         |
| `DiPluginOptions.defaultScope`      | `DiPlugin` → builder                        | Unchanged; decorator controllers no longer inherit it (§3.11)                               |
| `DiPluginOptions.autoRegister`      | the compiler's missing check; external leaf | Unchanged semantics; external tokens validated with `has()` and resolved lazily once        |

## 5. Implementation files

| File                                                            | Purpose                                                                                   |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `packages/common/src/container.ts`                              | Tokens, `InjectEntry`, provider and option changes, `IContainer` members, JSDoc rewrite   |
| `packages/common/src/http.ts`                                   | `IRequestContext.defer?`                                                                  |
| `packages/common/src/index.ts`                                  | Barrel: `createToken`, new types                                                          |
| `packages/kernel/src/context/request-context.ts`                | `defer`, the private list and an internal `takeDeferred()` on the handle                  |
| `packages/kernel/src/application/application.ts`                | Completion settles deferred cleanup (§3.8–§3.9), stream wrapping                          |
| `packages/kernel/src/context/deferred.ts` (new, internal)       | Runs cleanups, wraps a stream, reports failures — not exported                            |
| `packages/di-plugin/src/container/container.ts`                 | Open/closed lifecycle, token-keyed registry use, `forRequest`, `dispose`, `close`         |
| `packages/di-plugin/src/container/compiler.ts` (new)            | Graph walk, validation findings, compiled resolvers, slot assignment                      |
| `packages/di-plugin/src/container/errors.ts` (new)              | The five error classes                                                                    |
| `packages/di-plugin/src/container/provider-registry.ts`         | Keys widened to `ContainerToken`; class aliases                                           |
| `packages/di-plugin/src/container/scope-manager.ts`             | **Deleted**                                                                               |
| `packages/di-plugin/src/container/container-builder.ts`         | Token widening; unchanged otherwise                                                       |
| `packages/di-plugin/src/plugin/di-plugin.ts`                    | Bootstrap close, debug line for opaque factories, `onClose` dispose                       |
| `packages/di-plugin/src/index.ts`                               | Barrel: errors in, `ScopeManager` out                                                     |
| `packages/decorator-plugin/src/decorators/params.ts`            | `Service()`                                                                               |
| `packages/decorator-plugin/src/resolvers/parameter-resolver.ts` | `service` classification and resolution                                                   |
| `packages/decorator-plugin/src/plugin/decorator-plugin.ts`      | Optional entries instead of the factory closure; controllers as singletons; class aliases |
| `packages/decorator-plugin/src/index.ts`                        | Barrel: `Service`                                                                         |
| `packages/testing/src/override-provider.ts`                     | Forward `forRequest`, `dispose`, typed tokens                                             |
| `apps/di-decorators/src/modules/lifetimes/*`                    | Per-request lifetimes through `Service()` and `forRequest`                                |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                      | src covered                            | Key assertions (and the signature each call type-checks against)                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/container-token.test.ts`                                            | `common/src/container.ts`              | `createToken<T>(name)` returns a frozen object with that `name`; two calls with one name are distinct; no state between calls                                                                                          |
| `packages/common/test/unit/barrel-exports.test.ts` (extend)                                    | `common/src/index.ts`                  | New exports present                                                                                                                                                                                                    |
| `packages/kernel/test/unit/request-context-defer.test.ts`                                      | `request-context.ts`, `deferred.ts`    | List allocated only on first `defer`; LIFO; post-completion `defer` runs at once; failure reported once at `warn`                                                                                                      |
| `packages/kernel/test/integration/deferred-cleanup.test.ts`                                    | `application.ts`, `deferred.ts`        | §3.9 cases through `app.inject` and a capturing adapter; §3.13 structural fast-path test                                                                                                                               |
| `packages/di-plugin/test/unit/container-lifecycle.test.ts`                                     | `container.ts`                         | Open resolve compiles on demand; `close()` validates; `ContainerClosedError` on root and scope after close                                                                                                             |
| `packages/di-plugin/test/unit/compiler.test.ts`                                                | `compiler.ts`                          | Table of graphs → findings (missing, cycle, captive direct and through transients, optional, external leaf, opaque factory); no instantiation during validation                                                        |
| `packages/di-plugin/test/unit/container.test.ts` (rewritten)                                   | `container.ts`, `provider-registry.ts` | Lifetimes; `ScopeRequiredError` both shapes; typed and class tokens (`expectTypeOf`); factory arguments; optional `undefined`                                                                                          |
| `packages/di-plugin/test/unit/dispose.test.ts`                                                 | `container.ts`                         | Reverse order; transient tracked by scope; aggregate after all run; idempotent; `ScopeDisposedError`                                                                                                                   |
| `packages/di-plugin/test/unit/request-scope.test.ts`                                           | `container.ts`                         | One scope per context; `defer` called once; `RequestScopeUnavailableError` without `defer`                                                                                                                             |
| `packages/di-plugin/test/unit/errors.test.ts`                                                  | `errors.ts`                            | `name`, message shape, `findings` on `ContainerValidationError`                                                                                                                                                        |
| `packages/di-plugin/test/unit/{circular-detector,provider-registry,container-builder}.test.ts` | those files                            | Kept; token widening and class aliases added                                                                                                                                                                           |
| `packages/di-plugin/test/unit/scope-manager.test.ts`                                           | —                                      | **Deleted** with its source                                                                                                                                                                                            |
| `packages/di-plugin/test/integration/di-plugin.test.ts`                                        | `di-plugin.ts`                         | Close after the last bootstrap hook; registration from a bootstrap hook succeeds; after `start()` it throws; debug line lists opaque factories; root disposed on `stop()`                                              |
| `packages/di-plugin/test/e2e/request-scope-e2e.test.ts`                                        | the request path end to end            | Two concurrent requests each get their own scoped instance and neither sees the other's; disposal after each, including one whose handler throws and one streaming; a captive graph fails `start()` naming both tokens |
| `packages/decorator-plugin/test/unit/service-param.test.ts`                                    | `params.ts`, `parameter-resolver.ts`   | `Service()` descriptor; classified `service`; unresolvable without a container; `resolveParameters` and the plugin wrapper resolve identically                                                                         |
| `packages/decorator-plugin/test/integration/di-optional-scope.test.ts`                         | `decorator-plugin.ts`                  | `@Optional` dependency comes from the request scope; controllers registered as singletons under a `defaultScope: 'scoped'` container; captive controller fails the boot naming `Service`                               |
| `packages/testing/test/unit/override-provider.test.ts` (extend)                                | `override-provider.ts`                 | An override still applies inside `forRequest`; `dispose` forwarded                                                                                                                                                     |
| `apps/di-decorators/smoke.ts` (extend)                                                         | the example                            | `GET /lifetimes` reports per-request distinct scoped instances over two requests                                                                                                                                       |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m125-compiled-container, never develop or main
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run check:docs
pnpm run ci:local          # all shards on the final commit
pnpm run test:deno-lane
pnpm run release:publish --dry-run
pnpm run release:verify 0.11.0
```

Read the ANSI-stripped per-file coverage for every changed `src` file in common, kernel, di-plugin,
decorator-plugin and testing; each ≥ 90% on branch, function and line.

## 8. Risks & mitigations

- **A token is compiled before a provider it depends on is registered** (a resolve during one
  plugin's `register()`, its dependency registered by a later plugin). → The early resolve fails
  with a missing finding, exactly as the uncompiled container fails today; a failed compile caches
  nothing, so once the dependency is registered the next resolve and `close()` compile it afresh.
  `container-lifecycle.test.ts` pins both halves.
- **Third-party `IContainer` implementors break on the new required members.** → BREAKING entry for
  0.11.0 with the two members to implement; `OverridingContainer` is the in-repo reference.
- **Stream wrapping changes byte timing or backpressure.** → The wrapper forwards chunks through
  `pull` without buffering; the e2e streams a large body and asserts it arrives intact, and that
  cancel reaches the source.
- **The nested bootstrap hook relies on array iteration order.** → The integration test pins it; if
  the kernel's loop changes, that test fails before the container closes early.
- **Decorator controllers in apps using `defaultScope: 'scoped'` change lifetime.** → They were
  always built once; registering them as singletons states that. Upgrade-guide entry.

## 9. Out of scope

- **`Symbol.dispose` / `Symbol.asyncDispose` on instances** — the explicit `dispose` option is
  portable today; adopt the symbols once every supported runtime ships them and the TypeScript `lib`
  setting includes them.
- **Request scopes for non-HTTP ingress** (`IngressContext` in queue, WebSocket and gRPC handlers) —
  needs an ingress cleanup primitive like `ctx.defer`; a follow-up milestone once a consumer asks.
- **Per-request provider slots** (declaring `currentUser` on the root and filling it in middleware)
  — per-request data stays on typed state keys; a scope may still `register` its own leaf values.
- **Static graph validation in `setu check`**, **tenant-keyed scopes** and **an ambient
  `currentScope()`** — ROADMAP M125 "Named, not taken".
