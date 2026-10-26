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
  generic per-request cleanup primitive (`ctx.defer`) and owner-keyed per-request storage
  (`ctx.slot`, §3.19); the decorator parameter source that reaches the request scope;
  `apps/di-decorators` moved onto it; docs, PUBLIC_API, CHANGELOG, upgrade guide.
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
| Request-context reuse (§3.19)                 | `packages/kernel/src/context/request-context.ts`; `application.ts` (grep, 2026-10-26)    | A `RequestContext` is created per request and never pooled or reused, so a value held on one context cannot reach another request.                                                                                                                                  |
| `ResponseBuilder` visibility (§3.21)          | `packages/kernel/src/index.ts`                                                           | Not exported; a getter added to it is kernel-internal surface.                                                                                                                                                                                                      |
| Shared slot counter (§3.20)                   | `packages/di-plugin/src/container/compiler.ts:62`, `:222` (at `4ccf701c`)                | One `{ next }` counter is shared by the root compiler and every scope's; a scope-local `scoped` registration takes an index that is never released (probe: 100,000 request scopes each registering one value → the next scope's `slots.length` is 100,001).         |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                                                                                                  | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                                                 | Doc deliverable (same PR)                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| C1  | ROADMAP M125 decision 2 gives each `createToken` token a process-unique numeric `id` assigned at creation. AI_GUIDELINES §11.4 forbids global state, and a creation counter is module-level mutable state.                                                                | **AI_GUIDELINES wins: no id.** A token is a frozen object keyed by identity. The id existed to make a resolve an array read; with the graph compiled (§3.3) every dependency inside it is a direct reference with no lookup, so a lookup happens only at a top-level `resolve()` — one `Map` read on the token object, the same cost as a string token today. **Maintainer to confirm.** | ROADMAP M125 decision 2 rewritten to match.                                                 |
| C2  | ROADMAP decision 4 makes the request scope kernel-owned (`ctx.scope()`). AI_GUIDELINES §2.4 and §3.1 keep the kernel to orchestration, with DI an optional plugin.                                                                                                        | **The kernel gains only a generic cleanup primitive (`ctx.defer`, §3.8); the scope lives in di-plugin as `container.forRequest(ctx)` (§3.10).** Same cost profile — nothing allocated until first use, one `undefined` check at completion — with no DI concept in the kernel.                                                                                                           | ROADMAP decision 4 rewritten to match.                                                      |
| C3  | ROADMAP decision 4 says disposal runs after the response is handed back. On Workers that work can be cut off without `waitUntil`, which the kernel cannot reach (§1, last row).                                                                                           | **Cleanup finishes before a buffered response is handed back, and when the body stream ends, errors or is cancelled for a streaming one (§3.9).** A request with no cleanup is unaffected.                                                                                                                                                                                               | ROADMAP decision 4 rewritten to match.                                                      |
| C4  | ROADMAP decision 7 has existing paths warn for one release and refuse in "the next minor". The next release, 0.11.0, is itself a minor that already carries a BREAKING entry.                                                                                             | **Refuse in 0.11.0, with BREAKING CHANGELOG entries and upgrade-guide steps; no warning phase.** The Versioning Policy batches breaks into a minor, and 0.11.0 is that minor. If M125 misses the 0.11.0 cut, the entries move to the next minor unchanged. **Maintainer to confirm.**                                                                                                    | ROADMAP decision 7 rewritten to match.                                                      |
| C5  | ROADMAP decision 6 suggests the parameter source be named `Scoped(...)`. `ScopedRoles`/`ScopedPermissions` already mean RBAC scopes in the same package.                                                                                                                  | **Named `Service(token)`.**                                                                                                                                                                                                                                                                                                                                                              | ROADMAP decision 6 rewritten to match.                                                      |
| C6  | `ServiceScope` JSDoc says the application "disposes" a scope; `IContainer` has no dispose member.                                                                                                                                                                         | `IContainer.dispose()` is added (§3.7) and the JSDoc is rewritten to describe the request scope.                                                                                                                                                                                                                                                                                         | `packages/common/src/container.ts` JSDoc; PUBLIC_API common DI rows.                        |
| C8  | ROADMAP M125 decision 4 (as rewritten by C1–C3) says the kernel gains only `ctx.defer`, and §3.10 cached the scope in a per-container `WeakMap`. Measured on the committed code, that cache cost a request scope 10.4% of hello-world throughput and tripled p99 (§3.13). | **The kernel also gains a generic, owner-keyed per-request slot (`ctx.slot`, §3.19).** It stays DI-agnostic: any owner keeps a value for one request under a key only it holds.                                                                                                                                                                                                          | ROADMAP decision 4 amended to name `ctx.slot`.                                              |
| C7  | `docs/decorators.md`, `docs/migration-nestjs.md`, the di-plugin README and both AGENT_CARDs state that the framework creates no scope per request and that `scoped` behaves as a singleton until `createScope()` is called.                                               | The behaviour changes; the docs follow it.                                                                                                                                                                                                                                                                                                                                               | Those five files rewritten; their fences compile under `test/guide-fence-compiler.test.ts`. |

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
  request, creating it on first call and keeping it in the context's slot under the container's
  private key (§3.19; amended 2026-10-26 — the first implementation cached it in a per-container
  `WeakMap`, which §3.13's measurement refused). On creation it calls
  `ctx.defer(() => scope.dispose())`; when `ctx.defer` is absent it throws
  `RequestScopeUnavailableError` saying the context cannot dispose a scope and naming
  `createTestApp` as the way to test one. A request that never calls `forRequest` pays only §3.8's
  `undefined` check. `OverridingContainer` forwards `forRequest` and `dispose`, wrapping the
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
  server built from this branch's `dist/`. Acceptance (statistics named 2026-10-26): configuration 2
  against the baseline — a two-sided sign test over the 21 paired passes gives p > 0.05;
  configuration 3 against configuration 2 — the median of the 21 per-pass throughput deltas is at
  most −3%, and its p99 is within 10% of configuration 2's.
- **Measured so far (2026-10-26, against published 0.10.0 — `develop` for the final run):** on the
  committed code (`4ccf701c`) configuration 1 +1.4% and configuration 2 −2.1% (p ≈ 0.19) pass, but
  configuration 3 is −10.4% with p99 867 → 2,566 µs. A micro-benchmark put a `forRequest` cycle at
  1,155 ns, of which the `WeakMap` cache was about 1,000 ns. Prototyped in the harness's installed
  build: §3.19 alone gave −5.3% and p99 913 µs; with §3.20 and §3.21, −3.0% (p = 0.007), p99 913
  against 884 µs, and a 100 ns `forRequest` cycle; configuration 2 re-run +3.3% (p ≈ 0.38). A heap
  test (200,000 requests, after GC) showed no growth in any build.
- **Final (2026-10-26, `09121dca` against `develop` at `92e8b52a`, both built locally, 21 paired
  passes):** configuration 1 −2.9% median per-pass (p ≈ 0.66), medians 122,306 against 122,973 rps,
  p99 873 against 849 µs. Configuration 3 against configuration 2 −2.0% median per-pass (8/21, p ≈
  0.38), medians 116,072 against 118,356 rps, p99 873 against 852 µs (+2.5%): **passes**. The
  configuration 2 run against `develop` was stopped part-way at the maintainer's direction; its bar
  rests on the two runs against 0.10.0 above (p ≈ 0.19 on `4ccf701c`, p ≈ 0.38 with §3.19), the
  request path that configuration being unchanged since.
- **Why:** The fast path is the property most likely to regress silently, so it gets a test, not
  only a measurement.
- **Test home:** `kernel/test/integration/deferred-cleanup.test.ts` (structural); PR body
  (measured).

### 3.14 Cleanup is bounded (added by the design security review, §8a)

- **Decision:** The kernel bounds each asynchronous deferred cleanup with `withDeadline` from
  `@setu-ts/common`, armed through `resolveProbeTiming(runtime)` so it uses the runtime's timers, at
  a fixed internal `DEFERRED_CLEANUP_TIMEOUT_MS = 5000` (not an option, so no limit can be
  configured open). On expiry the kernel reports one `warn` naming the timeout — the §3.8 channel —
  and moves on: the next cleanup runs, the buffered response is handed back, a streaming body
  closes, and the in-flight count is released. The expired cleanup keeps running unobserved; its
  later settlement is ignored. Synchronous cleanups are not timed and stay synchronous. 5 s sits
  inside the 10 s shutdown drain, so one hung cleanup cannot by itself hold `stop()` to its
  deadline.
- **Why:** §8a threat T6. A cleanup is application code over a dependency (a connection release); a
  dependency that never settles must not hold a response, an in-flight slot or a shutdown hostage.
- **Test home:** `kernel/test/integration/deferred-cleanup.test.ts` (a never-settling cleanup: the
  response arrives after the bound with fake timers, the next cleanup still runs, one `warn`, and
  `stop()` completes; a cleanup settling inside the bound is awaited as before).

### 3.15 The root does not accumulate disposable transients (added by §8a)

- **Decision:** The compiler records, per compiled entry, whether resolving it creates a
  **disposable transient** — a `transient` provider with a `dispose` option, directly or through
  other transients (singleton dependencies excluded, since they are built once). `resolve()` on the
  root container throws `ScopeRequiredError` for such a token, exactly as it does for a scoped one;
  the flag is computed at compile time, not walked per resolve. A disposable transient built as a
  singleton's dependency is created once and stays tracked by the root, as before. Inside a scope
  nothing changes: the scope tracks and disposes it.
- **Why:** §8a threat T9. Otherwise every root resolve of a disposable transient appends to the
  root's cleanup list until application close, so request volume grows process memory without bound
  — the root-captured-disposable leak .NET is known for.
- **Test home:** `di-plugin/test/unit/dispose.test.ts` (root resolve refused; the same token
  resolves inside a scope and is disposed with it; a singleton depending on it is built once and
  tracked once).

### 3.16 Each disposal is bounded too (added by the security audit, finding F1/F3)

- **Decision:** `DiContainer.dispose()` bounds each asynchronous `dispose` function with
  `withDeadline` at the same fixed internal 5000 ms as §3.14. On expiry it records a named timeout
  error (`DI disposal of <token> timed out after 5000 ms`) among the failures and continues with the
  next disposal, so every disposal still runs; the final `AggregateError` carries the timeouts with
  the other failures, and the expired disposal's later outcome is ignored. Timers come from a new
  optional `ContainerConfig.timing` (`ProbeTiming` from `@setu-ts/common`), which `DiPlugin` sets
  from `resolveProbeTiming(runtime)` and every scope inherits; a standalone container without it
  uses `withDeadline`'s default timers. Synchronous disposals stay untimed and synchronous, so a
  request scope with synchronous disposal keeps the §3.13 synchronous path. The bound covers root
  disposal in `DiPlugin`'s `onClose` too, so a hung singleton `dispose` cannot hold `app.stop()`
  indefinitely. The bound is per disposal, not a total: k hung disposals take about k × 5000 ms,
  which can exceed the 10 s drain (audit N2, accepted — a total bound would abandon later disposals,
  the F1 defect).
- **Why:** Audit F1 (High): one never-settling `dispose` blocked every later disposal in its scope,
  so sibling resources were never released — §8a T4 and T6. Audit F3 (Medium): the same unbounded
  chain held `app.stop()` and skipped later close hooks.
- **Test home:** `di-plugin/test/unit/dispose.test.ts` (a hung dispose between two others: both
  others run, one timeout in the aggregate, nothing waits past the bound, with fake timers; a
  synchronous scope stays synchronous); `di-plugin/test/integration/di-plugin.test.ts` (a hung
  singleton dispose: `app.stop()` completes and a later `onClose` hook still runs).

### 3.17 A provider a scope registers lives as long as that scope (added by audit F2)

- **Decision:** `register` on a scope (from `createScope` or `forRequest`) stores a `singleton`
  lifetime as `scoped`, so the instance is created once per that scope, held in its slots and
  disposed by it. `transient` and `scoped` registrations on a scope are unchanged. The root never
  creates or tracks anything a scope registered.
- **Why:** Audit F2 (Medium): a scope-registered leaf with the default `singleton` lifetime and a
  `dispose` was built and tracked on the root, one root cleanup per request until shutdown — the §8a
  "no per-request growth of root state" budget. A token only one scope can see cannot outlive that
  scope.
- **Test home:** `di-plugin/test/unit/dispose.test.ts` (1000 request scopes each registering a
  `singleton` leaf with `dispose`: the root tracks nothing new, each scope disposes its own, and two
  resolves inside one scope return one instance).

### 3.18 A request scope reports its own disposal outcome (added by audit N1)

- **Decision:** `ContainerConfig` gains an optional `reportDisposeError?: (error: unknown) => void`,
  inherited by every scope. `forRequest`'s cleanup calls the scope's `dispose()`; when a reporter is
  configured it catches a synchronous throw and reports it, and for a promise attaches a handler
  that reports a rejection, then hands the kernel a promise that never rejects. Without a reporter
  the cleanup rethrows, as before, so the kernel reports it. `DiPlugin` sets the reporter to a
  `warn` through its logger (read when called): message `Request scope disposal failed`, metadata
  `{ error: describeError(error) }`. Each failure is therefore logged once, by the container,
  whenever it settles — also after the kernel's 5000 ms bound has already reported its own timeout.
- **Why:** Audit N1 (Low): a scope disposal outlasting the kernel's bound lost its named timeouts
  and dispose errors, because the kernel stops observing the cleanup at the bound.
- **Test home:** `di-plugin/test/unit/request-scope.test.ts` (with a reporter: a synchronous failure
  is reported once and the cleanup does not throw; an asynchronous failure settling after the kernel
  would have given up is still reported; without a reporter the cleanup rethrows);
  `di-plugin/test/integration/di-plugin.test.ts` (`DiPlugin` wires the reporter to its logger).

### 3.19 Owner-keyed per-request storage: `ctx.slot` (added by §3.13's measurement)

- **Decision:** `IRequestContext` gains an **optional** `slot?<T>(key: object, create: () => T): T`,
  `@since 0.11.0`. It returns the value this request holds under `key`, comparing keys by identity,
  and on the first call for that key stores and returns `create()`. If `create` throws, nothing is
  stored and the error propagates. The kernel's `RequestContext` keeps the first entry in two
  private fields fixed at construction, so the object's shape never changes, and further entries in
  a private list allocated on first use; it has no `delete` and no enumeration, and the store dies
  with the context. A call after completion behaves the same. `DiContainer` holds one private key
  object per container instance, and `forRequest` is
  `ctx.slot(this.#requestKey, () => <create scope, defer its disposal>)`. A context with `defer` but
  no `slot` (a third-party implementor) falls back to a per-container `WeakMap` allocated on first
  use; one with neither throws `RequestScopeUnavailableError` as before. `createTestContext`
  implements neither.
- **Why:** §3.13 measured the `WeakMap` cache at about 1,000 ns of a 1,155 ns `forRequest` cycle,
  and p99 tripled. The prototype's first slot was keyed by the container itself, which let any code
  holding the container — every plugin can reach it — plant its own object as a request's scope
  before DI ran; the committed private `WeakMap` could not be planted. A key only the container
  holds restores that, and identity-keyed entries mean no other owner can claim or overwrite DI's.
- **Test home:** `kernel/test/unit/request-context-slot.test.ts` (one `create` per key; distinct
  keys independent; a throwing `create` stores nothing; works after completion; shape-stable first
  entry and a second and third key); `di-plugin/test/unit/request-scope.test.ts` (the scope lives in
  the slot; code that tries every key it can construct, the container included, neither reads nor
  replaces it; the `WeakMap` fallback for a context without `slot`).

### 3.20 A scope allocates only what it uses (added by §3.13's measurement)

- **Decision:** A scope built by `createScope` or `forRequest` holds its parent, the root and its
  slot array, and creates its own provider registry, compiler, provider map and cleanup list only
  when first needed: the registry and compiler on its first `register`, the cleanup list on its
  first tracked instance. Until then `resolve`, `has` and validation use the nearest ancestor's
  compiler, which is what a scope without registrations already reached. Instances of providers a
  scope registers are stored in the resolving scope's own `Map` keyed by provider entry, allocated
  on first use, not in the shared slot array: slot indexes are assigned only to the root's
  registrations, a fixed set once the root closes, so the shared counter no longer grows with
  request volume and a nested scope can never share an index with its parent's later registrations.
- **Why:** A scope cost 81 ns to create before any resolve. The shared counter (§1, last row) gave
  every request that registers a local value a new index for the life of the process; a per-scope
  counter would avoid the growth but collide when a parent scope registers after a child exists,
  returning the wrong instance for a token. The heap test showed no leak in any build; the cost was
  slower, hash-table lookups in every scope once the index was large.
- **Test home:** `di-plugin/test/unit/request-scope.test.ts` (10,000 request scopes each registering
  a local `scoped` value: a fresh scope's slot array is no longer than the root's registration
  count); `di-plugin/test/unit/container.test.ts` (an untouched scope resolves, refuses and disposes
  as before; a scope that registers after resolving still resolves inherited tokens; a parent scope
  registering after its child exists gives each its own instance; a nested scope reaches a parent
  scope's registration with its own scoped instance).

### 3.21 A buffered response with synchronous cleanups settles without allocating (added by §3.13)

- **Decision:** `#settleRequest` reads a kernel-internal `streamingBody` accessor on
  `ResponseBuilder` (the streaming body, or `undefined`). For a buffered response it runs the
  cleanups with `runDeferred` directly: when that returns synchronously it releases the in-flight
  count and completes the request inline — no snapshot object, no closures — and when it returns a
  promise it does the same once the promise settles. A streaming response's body is wrapped by
  `wrapDeferredStream`, which is streaming-only (the helper's former buffered branch had no caller
  left). §3.8, §3.9 and §3.14 are unchanged in behaviour.
- **Why:** After §3.19 and §3.20 the remaining per-request cost included a response snapshot and two
  closures allocated for every request with a cleanup.
- **Test home:** `kernel/test/integration/deferred-cleanup.test.ts` (existing §3.9 cases unchanged;
  a buffered request with synchronous cleanups returns synchronously, runs them before the response
  is handed back and releases the in-flight count exactly once).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** `IContainer` gains required `forRequest` and `dispose` — ships in
minor 0.11.0. `IRequestContext.defer` and `IRequestContext.slot` are optional and break no
implementor.

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
| `IRequestContext.slot` (common)                         | method                   | `DiContainer.forRequest` (§3.19)                                                   |
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

| Option                               | Consumer                                    | Behavior (per implementation)                                                                                              |
| ------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ProviderOptions.dispose`            | `DiContainer.dispose()`                     | Called once per created instance, reverse creation order; failures aggregated after all run                                |
| `ProviderOptions.scope` (unchanged)  | the compiler                                | Selects the compiled resolver; `scoped` gets a slot                                                                        |
| `DiPluginOptions.defaultScope`       | `DiPlugin` → builder                        | Unchanged; decorator controllers no longer inherit it (§3.11)                                                              |
| `DiPluginOptions.autoRegister`       | the compiler's missing check; external leaf | Unchanged semantics; external tokens validated with `has()` and resolved lazily once                                       |
| `ContainerConfig.timing`             | `DiContainer.dispose()` (§3.16)             | Runtime timers for the per-disposal bound; `DiPlugin` sets it when a runtime is registered, else `withDeadline`'s defaults |
| `ContainerConfig.reportDisposeError` | `forRequest`'s cleanup (§3.18)              | Reports each request-scope disposal failure once; absent, the cleanup rethrows to the kernel                               |

## 5. Implementation files

| File                                                            | Purpose                                                                                                                |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/container.ts`                              | Tokens, `InjectEntry`, provider and option changes, `IContainer` members, JSDoc rewrite                                |
| `packages/common/src/http.ts`                                   | `IRequestContext.defer?`, `IRequestContext.slot?` (§3.19)                                                              |
| `packages/common/src/index.ts`                                  | Barrel: `createToken`, new types                                                                                       |
| `packages/kernel/src/context/request-context.ts`                | `defer`, the private list and an internal `takeDeferred()` on the handle; `slot` (§3.19)                               |
| `packages/kernel/src/context/response.ts`                       | Internal `streamingBody` accessor (§3.21)                                                                              |
| `packages/kernel/src/application/application.ts`                | Completion settles deferred cleanup (§3.8–§3.9, §3.21), stream wrapping                                                |
| `packages/kernel/src/context/deferred.ts` (new, internal)       | Runs cleanups, wraps a stream, reports failures — not exported                                                         |
| `packages/di-plugin/src/container/container.ts`                 | Open/closed lifecycle, token-keyed registry use, `forRequest`, `dispose`, `close`; lazy scope internals (§3.19–§3.20)  |
| `packages/di-plugin/src/container/compiler.ts` (new)            | Graph walk, validation findings, compiled resolvers, slot assignment; scope-local instances in a per-scope map (§3.20) |
| `packages/di-plugin/src/container/errors.ts` (new)              | The five error classes                                                                                                 |
| `packages/di-plugin/src/container/provider-registry.ts`         | Keys widened to `ContainerToken`; class aliases                                                                        |
| `packages/di-plugin/src/container/scope-manager.ts`             | **Deleted**                                                                                                            |
| `packages/di-plugin/src/container/container-builder.ts`         | Token widening; unchanged otherwise                                                                                    |
| `packages/di-plugin/src/plugin/di-plugin.ts`                    | Bootstrap close, debug line for opaque factories, `onClose` dispose                                                    |
| `packages/di-plugin/src/index.ts`                               | Barrel: errors in, `ScopeManager` out                                                                                  |
| `packages/decorator-plugin/src/decorators/params.ts`            | `Service()`                                                                                                            |
| `packages/decorator-plugin/src/resolvers/parameter-resolver.ts` | `service` classification and resolution                                                                                |
| `packages/decorator-plugin/src/plugin/decorator-plugin.ts`      | Optional entries instead of the factory closure; controllers as singletons; class aliases                              |
| `packages/decorator-plugin/src/index.ts`                        | Barrel: `Service`                                                                                                      |
| `packages/testing/src/override-provider.ts`                     | Forward `forRequest`, `dispose`, typed tokens                                                                          |
| `apps/di-decorators/src/modules/lifetimes/*`                    | Per-request lifetimes through `Service()` and `forRequest`                                                             |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                      | src covered                                    | Key assertions (and the signature each call type-checks against)                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/container-token.test.ts`                                            | `common/src/container.ts`                      | `createToken<T>(name)` returns a frozen object with that `name`; two calls with one name are distinct; no state between calls                                                                                          |
| `packages/common/test/unit/barrel-exports.test.ts` (extend)                                    | `common/src/index.ts`                          | New exports present                                                                                                                                                                                                    |
| `packages/kernel/test/unit/request-context-defer.test.ts`                                      | `request-context.ts`, `deferred.ts`            | List allocated only on first `defer`; LIFO; post-completion `defer` runs at once; failure reported once at `warn`                                                                                                      |
| `packages/kernel/test/unit/request-context-slot.test.ts`                                       | `request-context.ts`                           | §3.19: one `create` per key; keys independent; a throwing `create` stores nothing; after completion; first, second and third keys                                                                                      |
| `packages/kernel/test/integration/deferred-cleanup.test.ts`                                    | `application.ts`, `deferred.ts`, `response.ts` | §3.9 cases through `app.inject` and a capturing adapter; §3.13 structural fast-path test                                                                                                                               |
| `packages/di-plugin/test/unit/container-lifecycle.test.ts`                                     | `container.ts`                                 | Open resolve compiles on demand; `close()` validates; `ContainerClosedError` on root and scope after close                                                                                                             |
| `packages/di-plugin/test/unit/compiler.test.ts`                                                | `compiler.ts`                                  | Table of graphs → findings (missing, cycle, captive direct and through transients, optional, external leaf, opaque factory); no instantiation during validation                                                        |
| `packages/di-plugin/test/unit/container.test.ts` (rewritten)                                   | `container.ts`, `provider-registry.ts`         | Lifetimes; `ScopeRequiredError` both shapes; typed and class tokens (`expectTypeOf`); factory arguments; optional `undefined`                                                                                          |
| `packages/di-plugin/test/unit/dispose.test.ts`                                                 | `container.ts`                                 | Reverse order; transient tracked by scope; aggregate after all run; idempotent; `ScopeDisposedError`                                                                                                                   |
| `packages/di-plugin/test/unit/request-scope.test.ts`                                           | `container.ts`, `compiler.ts`                  | One scope per context; `defer` called once; `RequestScopeUnavailableError` without `defer`; §3.19 slot, planting refused and `WeakMap` fallback; §3.20 no slot growth over 10,000 registering scopes                   |
| `packages/di-plugin/test/unit/errors.test.ts`                                                  | `errors.ts`                                    | `name`, message shape, `findings` on `ContainerValidationError`                                                                                                                                                        |
| `packages/di-plugin/test/unit/{circular-detector,provider-registry,container-builder}.test.ts` | those files                                    | Kept; token widening and class aliases added                                                                                                                                                                           |
| `packages/di-plugin/test/unit/scope-manager.test.ts`                                           | —                                              | **Deleted** with its source                                                                                                                                                                                            |
| `packages/di-plugin/test/integration/di-plugin.test.ts`                                        | `di-plugin.ts`                                 | Close after the last bootstrap hook; registration from a bootstrap hook succeeds; after `start()` it throws; debug line lists opaque factories; root disposed on `stop()`                                              |
| `packages/di-plugin/test/e2e/request-scope-e2e.test.ts`                                        | the request path end to end                    | Two concurrent requests each get their own scoped instance and neither sees the other's; disposal after each, including one whose handler throws and one streaming; a captive graph fails `start()` naming both tokens |
| `packages/decorator-plugin/test/unit/service-param.test.ts`                                    | `params.ts`, `parameter-resolver.ts`           | `Service()` descriptor; classified `service`; unresolvable without a container; `resolveParameters` and the plugin wrapper resolve identically                                                                         |
| `packages/decorator-plugin/test/integration/di-optional-scope.test.ts`                         | `decorator-plugin.ts`                          | `@Optional` dependency comes from the request scope; controllers registered as singletons under a `defaultScope: 'scoped'` container; captive controller fails the boot naming `Service`                               |
| `packages/testing/test/unit/override-provider.test.ts` (extend)                                | `override-provider.ts`                         | An override still applies inside `forRequest`; `dispose` forwarded                                                                                                                                                     |
| `apps/di-decorators/smoke.ts` (extend)                                                         | the example                                    | `GET /lifetimes` reports per-request distinct scoped instances over two requests                                                                                                                                       |

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

## 8a. Design security review

**Written after implementation, from this plan's decisions — not from the code.** The review was
requested once M125 was implemented and committed (`9e847ac3`), so unlike a review written before
the code it can only bind the audit to the design; it is not evidence the design was reviewed before
the code existed. Where it found the design incomplete it added decisions §3.14 and §3.15, which the
committed code does not yet implement — the audit runs after they land. §3.19–§3.21 were added on
2026-10-26 after §3.13's benchmark refused the committed request scope; their threats are T14–T16
below, reviewed against prototypes patched into the benchmark build, and obligations 11–13 bind the
next audit to them.

- **Reviewed flows:**
  1. An HTTP request whose handler calls `container.forRequest(ctx)` and resolves scoped, transient
     and singleton services; the response; the kernel settling `ctx.defer` cleanups; the scope's
     `dispose()`.
  2. The same through `@Params(Service(token))` on a decorated, singleton controller.
  3. Those requests running concurrently, interleaving across `await`s, in one or two applications
     in one process.
  4. Every way a request ends: buffered success, handler throw (sync and async), `onError` hooks, a
     throwing error responder, a streaming body that ends, errors, or is cancelled, and a client
     that stalls a stream.
  5. Boot: on-demand compiles during plugin registration and `close()` validating the whole graph.
- **Assets:**
  - **Per-request isolation** — a scoped instance carrying request A's identity, tenant or open
    transaction is never observed by request B. Losing it is a Critical cross-request disclosure.
  - **Lifetime integrity** — no singleton holds a scoped instance (finding 1), including through
    `@Optional`, factories, class aliases and controllers.
  - **Availability** — the in-flight count, the shutdown drain, the response itself, and process
    memory.
  - **Resource release** — what `dispose` returns to a pool happens once, after the last use.
  - **Confidentiality of internals** — token names, provider names and dispose-error messages stay
    out of responses.
- **Attackers:** a remote HTTP client who chooses request timing, concurrency, aborts, stream
  cancellation and stalls, and drives request volume, but cannot choose DI tokens or registrations;
  a second tenant's client doing the same at the same moment; a slow or hostile dependency behind a
  `dispose` function (never settles, throws, throws a value with CR/LF in its message). Application
  code and its registrations are trusted; misconfiguration is in scope only where the framework
  claims to refuse it.
- **Budgets:**
  - A request that never calls `forRequest` allocates nothing new and stays synchronous (§3.13).
  - A request that does allocates one scope object, its slot array and its cleanup list, held in the
    context's slot and released with it (§3.19–§3.20).
  - No per-request growth of root state (§3.15).
  - Each asynchronous cleanup is bounded at 5000 ms (§3.14), inside the unchanged 10 s drain.
- **Audit obligations:**
  1. **Isolation under concurrency.** Fire at least 50 concurrent requests, each awaiting at least
     once mid-handler, each planting `canary-req-<n>` into its scoped instance. Every response
     carries only its own canary; no singleton, cache or captured log holds another's. Positive
     control: each request's own canary arrives. Repeat with two applications sharing one
     `createToken` token: each keeps its own instances.
  2. **Every captive shape is refused at boot.** singleton → scoped; singleton → transient → scoped;
     a factory with `inject`; an `@Optional` class; a class alias; a controller constructor. Each
     fails `start()` naming both tokens. Positive control: the same graphs with the dependent made
     `scoped`, and controllers using `Service(token)`, boot and serve per-request instances.
  3. **Root refusals.** `scoped`, a transient reaching `scoped`, and a disposable transient (§3.15)
     each throw `ScopeRequiredError` on the root; each resolves inside `forRequest`.
  4. **Dispose exactly once, after the last use, on every ending.** For each ending in flow 4, a
     scoped service with a counting `dispose`: count is 1, and for a stream it is 0 until the last
     byte or the cancel and 1 after. A `forRequest` first called after completion yields a scope
     whose `resolve` throws `ScopeDisposedError`, never a live scope nobody disposes.
  5. **Bounded cleanup (§3.14).** A `dispose` that never settles: the response still arrives (after
     the bound), later cleanups run, the in-flight count is released and `stop()` completes inside
     the drain bound. Positive control: a cleanup settling within the bound is awaited.
  6. **No root growth (§3.15).** Resolve a disposable transient through 1,000 request scopes and
     confirm the root's tracked set is unchanged afterwards. Positive control: each scope disposed
     its own.
  7. **Nothing internal reaches a response.** Name a token `canary-token-<random>`, make a scoped
     service's construction throw `canary-ctor-<random>` and its `dispose` throw
     `canary-dispose-<random>`, and trigger `ScopeRequiredError` and `ScopeDisposedError` inside a
     handler. Search the raw response bytes, with and without `errorHandler`: no canary. Positive
     control: the operator's log carries each, once.
  8. **Log lines cannot be forged.** A `dispose` throwing a message containing CR, LF and NUL yields
     one log record, control characters collapsed (`describeError`).
  9. **The fast path holds.** With `DiPlugin` registered and `forRequest` unused, the adapter's
     handler returns synchronously; with a synchronous request scope too.
  10. **Hostile tokens.** `'__proto__'`, `'constructor'` and `'prototype'` as string tokens register
      and resolve as ordinary keys without touching any prototype.
  11. **The request scope cannot be planted or read (§3.19).** Middleware running before the handler
      calls `ctx.slot` with every key it can construct — the container, its scope, the service
      registry, `ctx` itself, fresh objects — and with a `create` returning a fake scope. The
      handler's `forRequest` still returns the real scope and the fake is never consulted. Positive
      control: the same middleware's own key returns its own value.
  12. **No growth with request volume (§3.20).** 10,000 request scopes each register a local
      `scoped` value; afterwards a fresh scope's slot array is no longer than the root's
      registration count, and the root tracks nothing new. Positive control: each scope resolved and
      disposed its own value.
  13. **No index collision between scopes (§3.20).** A parent scope registers a token after a child
      scope exists and the child registers another; each resolves its own instance for each token.

| Threat                                                                                     | Resolution                                                                                                                                                       |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1 Request B observes request A's scoped instance                                          | §3.10: one scope per context in a per-container `WeakMap`; §3.3: scoped values live in that scope's slot array                                                   |
| T2 A singleton captures a scoped instance through some indirect path                       | §3.2 captive validation over every edge kind; §3.6 visible factory and `@Optional` dependencies; §3.11 controllers as singletons                                 |
| T3 A scope used after disposal                                                             | §3.7: `ScopeDisposedError`; §3.8: a post-completion `defer` runs at once, so a late scope is born disposed                                                       |
| T4 Cleanup skipped on some ending (pool exhaustion by abort or error)                      | §3.8 and §3.9 settle on every path; the throwing-responder path fixed during review with a test                                                                  |
| T5 Dispose before the last use, or twice                                                   | §3.9: a stream settles once, after its last chunk or the cancel; §3.7: `dispose()` is idempotent                                                                 |
| T6 A hanging cleanup holds the response, the in-flight slot and `stop()`                   | **§3.14 (new)**: 5000 ms bound per asynchronous cleanup                                                                                                          |
| T7 Token, provider or dispose-error names disclosed in a 500                               | Kernel and `errorHandler` 500 bodies are opaque; cleanup failures go to the log only (§3.8)                                                                      |
| T8 A dispose error forges log lines                                                        | §3.8 reports through `describeError`, which collapses control characters                                                                                         |
| T9 Root cleanup list grows with request volume                                             | **§3.15 (new)**: disposable transients refused on the root                                                                                                       |
| T10 One application's scope or instance reached from another in the same process           | Compiled entries, slots and the request `WeakMap` belong to one root container; tokens carry no state (§2 C1)                                                    |
| T11 `Service`'s `Symbol.for` brand forged                                                  | Accepted: it selects a resolution path for application code, which is trusted; it is not an access decision                                                      |
| T12 An opaque factory captures a scoped instance unseen                                    | Accepted: unvalidated by construction and listed in the `debug` line (§3.2); the docs prefer `inject`                                                            |
| T13 A client stalls a scoped streaming response, holding its scope                         | Accepted: the connection is held anyway; the scope is released on cancel, and `stop()` is bounded by the drain                                                   |
| F1 (audit `d5f0f8c5`, High) A hung `dispose` blocks later disposals in its scope           | FIXED after the audit: §3.16 per-disposal 5000 ms bound                                                                                                          |
| F2 (audit `d5f0f8c5`, Medium) Scope-registered `singleton` leaves tracked on the root      | FIXED after the audit: §3.17 scope registrations live as long as the scope                                                                                       |
| F3 (audit `d5f0f8c5`, Medium) A hung singleton `dispose` holds `app.stop()`                | FIXED after the audit: §3.16 covers root disposal                                                                                                                |
| F4 (audit `d5f0f8c5`, Low) The startup warning says an unbacked `Service()` is `undefined` | FIXED after the audit: the warning says the request will fail                                                                                                    |
| N1 (re-audit `db1e6bf6`, Low) A slow scope disposal's named errors never reach the log     | FIXED after the re-audit: §3.18 the scope reports its own outcome                                                                                                |
| N2 (re-audit `db1e6bf6`, Low) k hung disposals hold `stop()` about k × 5000 ms             | ACCEPTED (maintainer, 2026-10-26): a total bound would abandon later disposals (F1); §3.16 and the docs say so                                                   |
| T14 Code holding the container plants or reads a request's scope through the slot          | §3.19: the key is a private object per container; entries are identity-keyed, with no delete and no enumeration (found in the prototype, keyed by the container) |
| T15 The shared slot counter grows with every scope-local registration                      | §3.20: only root registrations get slot indexes; scope-local instances live in a per-scope map (found 2026-10-26 in `4ccf701c`)                                  |
| T16 A per-scope counter collides with a parent scope's later registration                  | §3.20 avoids per-scope counters; obligation 13 tests the shape                                                                                                   |

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
