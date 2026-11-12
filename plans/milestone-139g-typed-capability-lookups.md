# Milestone 139g — Capability lookups typed by their token (`@setu-ts/common`, `kernel`, `testing`, `react-router-plugin`, `cli`)

> **Status:** Planning. Branch: `feat/m139g-typed-capability-lookups`. `develop` and `main` are
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR.

## 0. Objective & scope

`IServiceRegistry.get<T>(token)` takes `T` from the caller, so
`services.get<IMailer>(CAPABILITIES.QUEUE)` compiles and fails at run time, and the type a
`serviceToken<T>()` carries is never read (V12-41). This milestone binds each standard capability
token to its interface at the type level. A `CAPABILITIES` value becomes a branded string. An
augmentable `CapabilityServices` map in `common` names its interface; plugins whose interface lives
outside `common` add their entry by module augmentation. `get`, `getAll`, `register` and
`registerFactory` gain overloads that infer the service type from the token and refuse a wrong
explicit pairing. The explicit type argument stays for tokens that have no bound interface:
third-party strings, derived instance tokens, and the standard tokens the map deliberately leaves
unbound. Nothing changes at run time in the registry.

The milestone also carries three CLI rows found during M139d and #583. The maintainer folded them in
on 2026-11-12 so no separate `fix/` branch is needed:

- **V12-58:** the workspace `AGENTS.md` copies a credentialed `brokerUrl` unmasked.
- **V12-59:** `setu check` says nothing about an installed provider that nothing registers.
- **V12-61:** the full-stack template has no `TRUST_FORWARDED_HOST` switch.

- **In scope:**
  - **V12-41:**
    - Branded standard tokens and the `CapabilityServices` map.
    - Registry overloads.
    - `RequestServiceToken<T>` / `requestServiceToken<T>()`, so a request-bound token is never read
      through a `get` that would type the wrapper as the service.
    - Typed `resolveRequestService` and react-router `getService`.
    - Augmentation from database, cloudflare, static and messaging plugins.
    - `MockServiceRegistry` overloads.
    - Generated module code switched to `requestServiceToken`.
    - Every test, doc snippet and example that the new types refuse, fixed.
  - **V12-58, V12-59, V12-61** as specified in §3.9–§3.11.
- **NOT this milestone:**
  - Named types for the four kernel-registered `{ name, … }` multi tokens (`METRIC_REGISTRATION`,
    `OPENAPI_SCHEMA`, `DECORATOR_HANDLER`, `CLI_COMMAND`). They stay unbound (§3.2), with no owner
    milestone.
  - Typing `overrideCapability` (§3.7).
  - Moving `getOrSet` onto `ICacheStore` (§9).
  - Arm-level detection for V12-59 (§9).

## 1. Contracts verified from SOURCE (not names)

| Reference                                     | Source (file:line)                                                                                                                                                                                                                                                           | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IServiceRegistry`                            | `packages/common/src/registry.ts:86-187`                                                                                                                                                                                                                                     | `register<T extends object>(token: CapabilityToken, service: T, options?)`, `registerFactory<T>(token, factory: ServiceFactory<T>, options?)`, `get<T extends object>(token): T` (first provider on a multi token; throws when absent), `getAll<T>(token): readonly T[]` (empty when absent), `has`, optional `isCurrent?<T>(token, instance)`, `unregister`. No overloads today.                                                  |
| `CapabilityToken`                             | `packages/common/src/tokens.ts:22`                                                                                                                                                                                                                                           | `export type CapabilityToken = string;` — unbranded.                                                                                                                                                                                                                                                                                                                                                                               |
| `CAPABILITIES`                                | `packages/common/src/tokens.ts:39`                                                                                                                                                                                                                                           | An `as const` object of literal strings. Key `EVENTS_DIAGNOSTICS` has the value `'event-diagnostics'`, so key and value differ: the map keys by VALUE. `StandardCapability = (typeof CAPABILITIES)[keyof typeof CAPABILITIES]` is exported, and its only reader is `common/test/unit/types.test.ts:49`.                                                                                                                            |
| `createCapabilityToken`                       | `packages/common/src/tokens.ts:361`                                                                                                                                                                                                                                          | Validates `^seg(\.seg)*$` and returns plain `CapabilityToken`. Unchanged: a token it creates is unbound.                                                                                                                                                                                                                                                                                                                           |
| `ServiceToken<T>` / `serviceToken<T>()`       | `packages/common/src/services/request-service.ts:26,42`                                                                                                                                                                                                                      | `CapabilityToken & { readonly __service?: T }`. The phantom is OPTIONAL, so any plain string is assignable to it.                                                                                                                                                                                                                                                                                                                  |
| `requestService` / `RequestBoundService<T>`   | `request-service.ts:57-80`                                                                                                                                                                                                                                                   | A frozen wrapper branded `Symbol.for('setu.request-service')`. PUBLIC_API.md:382-384 says `get(token)` on such an entry returns the WRAPPER.                                                                                                                                                                                                                                                                                       |
| `resolveRequestService<T>`                    | `request-service.ts:169-188`                                                                                                                                                                                                                                                 | `(ctx, token: ServiceToken<T> \| CapabilityToken): T`. Calls `ctx.services.get<object>(token)` and unwraps a request-bound entry.                                                                                                                                                                                                                                                                                                  |
| Kernel `ServiceRegistry`                      | `packages/kernel/src/registry/service-registry.ts:53,172-214`                                                                                                                                                                                                                | Single generic implementation signatures. NOT exported from `kernel/src/index.ts`; the public type of `app.services` is `IServiceRegistry`. `getAll` returns inherited providers first (`:195-203`).                                                                                                                                                                                                                               |
| `MockServiceRegistry`                         | `packages/testing/src/mock-registry.ts:32-83`                                                                                                                                                                                                                                | `implements IServiceRegistry` with single generic signatures. Exported (`testing/src/index.ts:26`), so a test that types a variable as the class gets no inference unless the class declares overloads.                                                                                                                                                                                                                            |
| `overrideCapability`                          | `packages/testing/src/override-capability.ts:94`                                                                                                                                                                                                                             | `(token: CapabilityToken, service: object)`.                                                                                                                                                                                                                                                                                                                                                                                       |
| react-router `getService` / `ServiceResolver` | `packages/react-router-plugin/src/handler/get-service.ts:20,80-87`, `load-context.ts:30`                                                                                                                                                                                     | `ServiceResolver = <T>(token: ServiceToken<T> \| CapabilityToken) => T`. The load context assigns `(token) => resolveRequestService(ctx, token)`.                                                                                                                                                                                                                                                                                  |
| Interfaces outside `common`                   | `database-plugin/src/interfaces/index.ts:211` (`IDatabaseService`); `cloudflare-plugin/src/bindings/binding-registry.ts` (`ICloudflareBindings`); `static-plugin/src/interfaces/index.ts` (`IStaticFiles`); `messaging-plugin/src/interfaces/index.ts` (`IOutbox`, `IInbox`) | `common` cannot import these: it would create a cycle. Each plugin imports from `'@setu-ts/common'` (for example `database-plugin/src/interfaces/index.ts:14`).                                                                                                                                                                                                                                                                    |
| Kernel multi-token shapes                     | `packages/kernel/src/application/application.ts:~616-644`                                                                                                                                                                                                                    | `HEALTH_INDICATOR` registers `{ name, check, readiness? }`, which matches `IHealthIndicator` (`common/src/services/health.ts:54`). `METRIC_REGISTRATION`, `OPENAPI_SCHEMA`, `DECORATOR_HANDLER` and `CLI_COMMAND` register ad-hoc `{ name, … }` with no named type in `common`.                                                                                                                                                    |
| Augmentation through a re-export              | probe3 at the session scratchpad (tsc 6.0.3)                                                                                                                                                                                                                                 | `declare module` on the barrel adds a key to an interface the barrel only re-exports (`export type { X } from './map.ts'`). This is exactly how `CapabilityServices` reaches `index.ts`.                                                                                                                                                                                                                                           |
| Registry contract test                        | `packages/common/test/unit/registry-contract.test.ts:17-47`                                                                                                                                                                                                                  | Assigns a single-signature object literal to `IServiceRegistry`.                                                                                                                                                                                                                                                                                                                                                                   |
| Compiler facts the design relies on           | probe at the session scratchpad, tsc 6.0.3, repo flags (`strict`, `exactOptionalPropertyTypes`, `isolatedDeclarations`, `nodenext`)                                                                                                                                          | Verified by the probe: <br>• a single-generic class and a single-generic object literal both satisfy the overloaded interface; <br>• cross-module `declare module` augmentation adds a key; <br>• all ten refusal and acceptance cases behave as §3.3 states; <br>• declarations emit. <br>`isolatedDeclarations` refuses a helper-call-built `CAPABILITIES` (TS9013) and accepts `'x' as StandardCapabilityToken<'x'>` per value. |
| V12-58 site                                   | `packages/cli/src/agents/render.ts:166`                                                                                                                                                                                                                                      | `displayValue(workspace.brokerUrl ?? 'broker default')`, with no masking. `maskUrlUserinfo` is exported from `@setu-ts/common`.                                                                                                                                                                                                                                                                                                    |
| V12-59 sites                                  | `packages/cli/src/diagnostics/ids.ts:6-27`, `packages/cli/src/commands/add.ts:311-331`, `packages/cli/src/utils/starter-arms.ts:5-88`, `packages/cli/src/diagnostics/wiring.ts:17-20`                                                                                        | <br>• **Ids:** the highest warning id is `setu.W005`. <br>• **Zero-config providers:** `ZERO_CONFIG_WIRINGS` is module-private in `add.ts` and maps package → factory symbol. <br>• **Starter arms:** `STARTER_ARMS` / `composingStarter(config)` give each starter's arm map. <br>• **Call test:** `calledOutsideImports(config, symbol)` is the read-only call test.                                                             |
| V12-61 site                                   | `packages/cli/src/templates/full-stack.ts:133,169-171,291-308`                                                                                                                                                                                                               | Builds `trustedProxies` from `config.get<string>('TRUSTED_PROXIES', { default: '' })` and emits `ipSecurity: { trustProxy: true, trustedProxies }` only when the list is non-empty. `trustForwardedHost` is the http-security option #583 added (`develop` `117d57845`).                                                                                                                                                           |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                                                  | Resolution (picked side)                                                                     | Doc deliverable (same PR)                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `cache-plugin/README.md:35` shows `get<CacheService>(CAPABILITIES.CACHE).getOrSet(…)`, a downcast to the plugin class. The token is bound to `ICacheStore`.                                                               | The binding wins. The README reads the store through `ICacheStore` methods (`get`/`set`).    | `packages/cache-plugin/README.md` example rewritten.                                                                                                          |
| C2  | ARCHITECTURE.md `:749,:758-764` and `test/fixtures/snippets/architecture-registry.ts:49` present `NOTIFICATION` as multi-provider (`getAll<INotifier>`). The plugin registers one notifier (`notification-plugin.ts:91`). | Source wins: single provider, read with `get`.                                               | ARCHITECTURE.md passage and its snippet fixture corrected.                                                                                                    |
| C3  | PUBLIC_API.md:382-384 documents that `get` on a request-bound token returns the wrapper. After this milestone, `get` on a `RequestServiceToken` does not compile.                                                         | New behaviour.                                                                               | PUBLIC_API "Request-bound services" rewritten: `requestServiceToken`, and `get` refuses it at compile time.                                                   |
| C4  | AI_GUIDELINES.md:176 ("only via `ctx.services.get<T>(token)`") and the `tokens.ts` / `registry.ts` JSDoc examples teach the explicit type argument.                                                                       | Teach the inferred form `ctx.services.get(CAPABILITIES.X)`; the explicit form remains valid. | AI_GUIDELINES:176, the `tokens.ts:33` and `registry.ts:78-83` examples, the PUBLIC_API registry row, the `common` README and ARCHITECTURE's registry section. |

## 3. Design decisions

### 3.1 Branded standard tokens

- **Decision:**
  - `export type StandardCapabilityToken<K extends string> = K & { readonly [capabilityBrand]: K }`,
    with `declare const capabilityBrand: unique symbol` in `tokens.ts`.
  - Every `CAPABILITIES` value is written `'logger' as StandardCapabilityToken<'logger'>`.
  - `CapabilityToken` stays `string`.
  - `StandardCapability` keeps its definition, so it becomes the union of branded tokens.
  - Add
    `export type CapabilityKey = StandardCapability extends StandardCapabilityToken<infer K> ? K : never`
    (the plain value union).
- **Why:**
  - A brand is the only way a lookup can tell a `CAPABILITIES` value from an arbitrary string.
    Without it, an explicit `T` on a literal cannot be checked (survey: only Effect enforces this,
    and it does so by not using strings).
  - Branded values are still strings at run time and assignable to `string`, so `has`, `unregister`,
    comparisons and template literals are unaffected.
  - Assertion syntax is the form `isolatedDeclarations` accepts (probe).
- **Test home:** `packages/common/test/unit/capability-types.test.ts`:
  - `CAPABILITIES.LOGGER === 'logger'` at run time;
  - assignable to `string`;
  - a plain `'logger'` is not a `StandardCapabilityToken<'logger'>` (`@ts-expect-error`).

### 3.2 `CapabilityServices`: the token→interface map

- **Decision:**
  - New file `packages/common/src/capability-services.ts` exports `interface CapabilityServices`,
    keyed by token VALUE.
  - It holds an entry for every standard token whose interface lives in `common`, from the §1 table:
    - `HEALTH_INDICATOR` maps to `IHealthIndicator`;
    - each `*_DIAGNOSTICS` token maps to its source interface;
    - `METADATA_STORE` maps to `IMetadataStore`;
    - `DI_CONTAINER` maps to `IContainer`;
    - `HTTP_ADAPTER` maps to `IHttpAdapter`;
    - `LOCAL_DIAGNOSTICS_LISTENER` maps to `ILocalDiagnosticsListenerFactory`.
  - These plugins augment `'@setu-ts/common'` in the file that declares the interface:
    - `database-plugin` adds `database: IDatabaseService`;
    - `cloudflare-plugin` adds `cloudflare: ICloudflareBindings`;
    - `static-plugin` adds `'static-files': IStaticFiles` (`tokens.ts:268`);
    - `messaging-plugin` adds `outbox: IOutbox` and `inbox: IInbox`.
  - `export type UnboundCapability = Exclude<CapabilityKey, keyof CapabilityServices>`. In the full
    program it is exactly the four kernel-registered tokens:
    - `METRIC_REGISTRATION`, `OPENAPI_SCHEMA`, `DECORATOR_HANDLER`, `CLI_COMMAND`.
  - In an application that does not load a plugin's types, that plugin's token is also unbound and
    takes an explicit `T`.
- **Why:**
  - The map has to be open: five interfaces live in plugins.
  - hono's `ContextVariableMap` is the same augmentation pattern.
  - Leaving the four ad-hoc shapes unbound keeps them at today's behaviour instead of inventing four
    public types that nobody asked for.
- **Test home:**
  - Root `test/capability-map.test.ts` asserts `expectTypeOf<UnboundCapability>()` equals the
    four-value union. It is a whole-program fact (it holds only when every augmenting plugin is
    compiled with it), so it lives in root `test/`, which `pnpm run check` compiles with every
    package. The set is data in the test, not prose.
  - Each augmenting plugin gets one type assertion,
    `expectTypeOf(registry.get(CAPABILITIES.DATABASE)).toEqualTypeOf<IDatabaseService>()`:
    - `database-plugin/test/unit/capability-binding.test.ts`;
    - the cloudflare, static and messaging tests follow the same pattern (§6).

### 3.3 Registry overloads

- **Decision:**
  - **`get`** gets these signatures, in this order:
    1. `get<K extends keyof CapabilityServices>(token: StandardCapabilityToken<K>): CapabilityServices[K]`:
       inferred.
    2. `get<T extends object>(token: StandardCapabilityToken<KeysServing<T>>): T`: an explicit `T`
       is accepted only when the bound interface is assignable to `T`. Widening (`get<object>`)
       passes; a downcast or a wrong interface is refused.
    3. `get<T extends object>(token: StandardCapabilityToken<UnboundCapability>): T`.
    4. `get<T extends object>(token: ServiceToken<T>): T`.
    5. `get<T extends object>(token: UnboundToken): T`, where
       `UnboundToken = string & { readonly [capabilityBrand]?: never; readonly [serviceBrand]?: never; readonly [requestServiceBrand]?: never }`.
  - **`getAll`** has the same five signatures returning `readonly …[]`.
  - **`register` and `registerFactory`** have the same token arms. The service (or the factory's
    result) is typed `CapabilityServices[K]`, the unbound `T`, the `ServiceToken`'s `T`, or, for a
    `RequestServiceToken<T>` only, `RequestBoundService<T>`.
  - **No `get` or `getAll` arm accepts a `RequestServiceToken`.**
  - `has`, `unregister` and `isCurrent?` keep `CapabilityToken`.
  - `KeysServing<T>` is exported as a type because `resolveRequestService` and `getService` reuse it
    (§3.5). `UnboundToken` is exported because it appears in the published signature and in the
    compiler's refusal message ("not assignable to parameter of type 'UnboundToken'").
- **Why:**
  - Typing `register` puts the check at the write as well as the read: a plugin that registers the
    wrong object under a token fails to compile where the defect is.
  - Overload 2 keeps every correct explicit call site compiling unchanged; about 1,150 sites exist.
  - Probe: all ten acceptance and refusal cases hold, and the kernel's single-signature class still
    `implements` the interface.
- **Test home:** `packages/common/test/unit/registry-overloads.test.ts`, with type assertions
  compiled by `pnpm run check`:
  - inferred `get`/`getAll`;
  - correct explicit, widened, downcast-refused and wrong-pairing-refused calls;
  - unbound token with explicit `T`;
  - a third-party string;
  - a derived `string` token;
  - `register` of a wrong object refused;
  - a `RequestServiceToken` refused by `get` and `getAll`, and accepted by `register` only with
    `requestService(…)`.
  - `registry-contract.test.ts` keeps its single-signature literal, which proves third-party
    implementors still compile.

### 3.4 Service tokens and request-bound tokens

- **Decision:**
  - `ServiceToken<T>` becomes `string & { readonly [serviceBrand]: T }`, a required unique-symbol
    phantom. A plain string is no longer assignable to it.
  - New `RequestServiceToken<T> = string & { readonly [requestServiceBrand]: T }` and
    `requestServiceToken<T>(name)`, which validates through `createCapabilityToken` exactly as
    `serviceToken` does.
  - A token used with `requestService(…)` is a `RequestServiceToken`.
  - A token whose service is registered as itself (apps/cqrs `NOTE_STORE`, apps/cloudflare
    `WORKER_ENV`) stays a `ServiceToken`.
  - Run-time behaviour of the registry and of `resolveRequestService` is unchanged.
- **Why:**
  - `get(PRODUCTS)` returns the wrapper (PUBLIC_API:382). Inferring `T` there would type a wrapper
    as the service, which is the very lie this milestone removes. A separate token kind is the only
    place the type can know.
  - The alternative of making `get` throw on a request-bound entry was rejected:
    `resolveRequestService` itself reads the raw entry through `get`, and `getAll` orders inherited
    providers first, so it cannot stand in.
- **Test home:**
  - `packages/common/test/unit/request-service.test.ts` gets new cases: `requestServiceToken`
    grammar refusal, resolve through a request token, and the type refusals.
  - `registry-overloads.test.ts` (§3.3).

### 3.5 `resolveRequestService` and react-router `getService` read the same map

- **Decision:**
  - `resolveRequestService` gets five overloads, mirroring `get` arm for arm:
    1. `StandardCapabilityToken<K>` → `CapabilityServices[K]`;
    2. `StandardCapabilityToken<KeysServing<T>>` → explicit `T` (so an existing
       `resolveRequestService<ILogger>(ctx, CAPABILITIES.LOGGER)` still compiles, and a wrong one
       does not);
    3. `StandardCapabilityToken<UnboundCapability>` → explicit `T`;
    4. `ServiceToken<T> | RequestServiceToken<T>` → `T`;
    5. `UnboundToken` → explicit `T`.
  - Its implementation widens the token by assignment, `const key: CapabilityToken = token;`, and
    calls `ctx.services.get<object>(key)` through the unbound arm. No cast: a branded string is
    assignable to `string`.
  - React-router `ServiceResolver` becomes an interface with the same five call signatures.
  - `getService` declares the same five overloads.
  - `load-context.ts` builds the resolver as an overloaded function declaration whose body calls
    `resolveRequestService`. There is no cast.
- **Why:** one capability, one typing. A loader and a kernel route resolving the same token must
  infer the same type.
- **Test home:**
  - `request-service.test.ts`: inference per arm.
  - `react-router-plugin/test/unit/get-service.test.ts`: the same five arms through `getService`,
    plus a `RequestServiceToken` resolved in a loader at run time.

### 3.6 Kernel registry implementation

- **Decision:**
  - `ServiceRegistry` keeps its single implementation signatures.
  - It is not exported. Every public path types it as `IServiceRegistry` (`app.services`,
    `ctx.services`), so callers get the overloads.
  - No run-time change.
- **Why:** the probe showed a single-generic class satisfies the overloaded interface, and an
  unexported class needs no public overloads.
- **Test home:** the existing kernel registry tests keep passing. `pnpm run check` proves
  `implements` still holds.

### 3.7 `testing`: `MockServiceRegistry` and `overrideCapability`

- **Decision:**
  - `MockServiceRegistry` declares the same overload signatures as `IServiceRegistry` above its
    implementation signature, so a test typed against the class is checked like one typed against
    the interface.
  - `overrideCapability(token, service: object)` stays untyped. It exists to swap in a test double,
    and a double is often partial.
  - Its JSDoc says so.
- **Why:** an exported class used directly in tests would otherwise silently accept wrong pairings.
- **Test home:** `packages/testing/test/unit/mock-registry.test.ts`:
  - `expectTypeOf<MockServiceRegistry['get']>().toEqualTypeOf<IServiceRegistry['get']>()`, and the
    same for `getAll`, `register` and `registerFactory`. This is the drift guard.
  - One refused wrong pairing.

### 3.8 Call sites, generated code and docs the new types refuse

- **Decision:**
  - Every refused site is fixed to the bound interface. That means src, tests, apps, doc snippets
    and `test/fixtures/snippets`.
  - A test that deliberately passes a partial double uses `overrideCapability` or a typed full
    double. There is no blanket `as unknown as`: a cast is allowed only where a test asserts
    behaviour against an intentionally malformed registration, and it carries a comment.
  - **Generated code:**
    - `cli/src/templates/full-stack-module-files.ts` and `cli/src/schematics/module-full-stack.ts`
      emit `requestServiceToken<…>`;
    - `apps/full-stack/src/modules/products/products.token.ts` does the same;
    - generated `get<ILogger>(CAPABILITIES.LOGGER)` lines stay as they are. The explicit form is
      valid, and the shutdown block is shared with the dev entry, whose CLI-owned recognition would
      otherwise have to accept both spellings (found in review).
  - The comment at `cli/src/templates/full-stack.ts:260` that names `serviceToken` is updated.
  - Template baselines are re-captured.
  - Existing correct explicit calls elsewhere are left alone: they compile and are not churn this
    milestone owns.
- **Why:** generated code changes only where the new types require it (the request-bound token). A
  rewrite of valid sites would bloat the diff with no behavioural gain.
- **Test home:**
  - `packages/cli/test/unit/full-stack-template.test.ts` asserts the emitted token constructor;
  - the scaffold e2e boots a full-stack project with a module (existing
    `full-stack-modules-e2e.test.ts`);
  - `pnpm run check` and `check:docs` cover the rest.

### 3.9 V12-58: mask the workspace broker URL

- **Decision:** `render.ts:166` renders `displayValue(maskUrlUserinfo(workspace.brokerUrl))` when a
  URL is set. The `'broker default'` fallback is unchanged.
- **Why:** the brief is committed to the repository, and a credentialed URL in it leaks a secret.
- **Test home:** `packages/cli/test/unit/agents/workspace-brief.test.ts`. A `brokerUrl` of
  `amqp://user:secret@mq:5672` renders without `secret` or `user:`, and the host is kept.

### 3.10 V12-59: `setu.W006 plugin-unregistered`

- **Decision:**
  - `ZERO_CONFIG_WIRINGS` moves from `add.ts` to `packages/cli/src/utils/plugin-wirings.ts` and is
    exported for `add.ts` and the diagnostic. This is a pure move with no entry changes.
  - New finding kind `plugin-unregistered` → `setu.W006` in `ids.ts`.
  - It fires once per package where all of these hold:
    - the package is in the project manifest;
    - it is in `ZERO_CONFIG_WIRINGS` or is `mcp-plugin` (symbol `McpPlugin`);
    - it is not an arm key of the composing starter (`composingStarter(config)?.arms.has(pkg)`);
    - `calledOutsideImports(config, symbol)` returns `false`.
  - `undefined` (an unreadable config) emits nothing, because `setu.E012` already covers it.
  - It is a warning: registration in another module cannot be seen.
  - The rendered text names the package and the call to add, for example `McpPlugin({ … })` in the
    factory.
  - It can be silenced through `.setu-ts/check.json` like every other id.
  - Only the config file is read. The rendered advice says the call belongs in that config, and that
    a project registering the plugin elsewhere silences the id.
  - Like every warning it fails only under `setu check --strict` (`commands/check.ts:154`).
- **Why:** the row's own proposal, using the existing read-only call test, so the check is no
  stricter than `E006`.
- **Test home:** `packages/cli/test/unit/check-wiring.test.ts`:
  - installed and uncalled fires;
  - installed and called is silent;
  - starter-owned is silent;
  - an unreadable config is silent;
  - `mcp-plugin` fires;
  - a silenced id is suppressed.
  - `diagnose.test.ts` checks that the id appears in the JSON output.
  - A fresh scaffold of every template, and every `apps/*` example (the examples gate runs
    `setu check` per app), reports no `W006`. Asserted in `scaffold-runs-e2e.test.ts`, which already
    runs the generated `check` script.

### 3.11 V12-61: `TRUST_FORWARDED_HOST` in the full-stack template

- **Decision:**
  - The generated config reads `TRUST_FORWARDED_HOST` with default `''`:
    - `''` or `'false'` → `false`;
    - `'true'` → `true`;
    - anything else → `throw new Error("TRUST_FORWARDED_HOST must be 'true', 'false' or empty")`.
      The value is not echoed.
  - `true` with an empty `TRUSTED_PROXIES` →
    `throw new Error('TRUST_FORWARDED_HOST=true needs TRUSTED_PROXIES: …')`.
  - With proxies, the template emits
    `ipSecurity: { trustProxy: true, trustedProxies, trustForwardedHost }`.
  - The `.env` gets `TRUST_FORWARDED_HOST=` beside `TRUSTED_PROXIES`.
  - The template README's "Behind a TLS proxy" section names the variable, says when to set it, and
    warns to keep it off behind a proxy that passes `X-Forwarded-Host` through.
  - `docs/deployment.md`'s proxy table gains the column.
  - Generated text is wrapped as `deno fmt` wraps it.
  - No `http-security-plugin` change.
  - The refusals run wherever the config factory runs, so a `setu` command that evaluates the config
    stops with the same message. That is intended: the value is wrong everywhere.
- **Why:**
  - Design in `smoke/PR583-FOLLOWUP.md#v12-61`.
  - A truthiness read is ruled out: #583's review found `'false'` turned trust on.
  - Turning trust on whenever proxies are set was rejected, because it brings back the cloudflared
    defect.
- **Test home:**
  - `packages/cli/test/unit/full-stack-template.test.ts`: the emitted config is evaluated for each
    of `''`, `'false'`, `'true'` and `'yes'`, and `true` with no proxies (two refusals).
  - `packages/cli/test/e2e/scaffold-runs-e2e.test.ts`, full-stack case:
    - with `TRUST_FORWARDED_HOST=true`, `TRUSTED_PROXIES=127.0.0.1/32` and
      `X-Forwarded-Host: public.example`, the origin is the public host and the login POST from it
      gets 302;
    - unset, a forged `X-Forwarded-Host` is ignored.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** yes, and it ships in minor `0.13.0`. The breaking changes:

- `IServiceRegistry`'s methods become overloaded and typed by token.
- `CAPABILITIES` values change type (branded).
- `ServiceToken<T>` is no longer satisfied by a plain string.
- A request-bound token must be a `RequestServiceToken`.

A third-party registry implementation with single generic signatures still compiles (§3.6). The
CHANGELOG `BREAKING` entry and the `docs/upgrading.md` 0.13.0 section say what to change: replace
`serviceToken` with `requestServiceToken` where the token is used with `requestService`, and fix any
wrong pairing the compiler now reports.

| Exported symbol                                         | Kind                     | Consumer / real code path that READS it                                                                 |
| ------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `StandardCapabilityToken<K>`                            | type (common)            | The type of every `CAPABILITIES` value, and the parameter of registry overloads 1–3.                    |
| `CapabilityKey`                                         | type (common)            | `UnboundCapability`'s definition, and the plugin augmentation docs.                                     |
| `CapabilityServices`                                    | interface (common)       | Registry overloads and the `resolveRequestService` / `getService` overloads. Augmented by four plugins. |
| `UnboundCapability`                                     | type (common)            | Overload 3 of `get`, `getAll`, `register`, `registerFactory` and `resolveRequestService`.               |
| `UnboundToken`                                          | type (common)            | The last overload's parameter; named in compiler errors.                                                |
| `RequestServiceToken<T>`                                | type (common)            | `register`'s request-bound arm, `resolveRequestService`, `getService`, and generated module tokens.     |
| `requestServiceToken<T>()`                              | function (common)        | The generated `*.token.ts`, `apps/full-stack` products token, and docs.                                 |
| `KeysServing<T>`                                        | type (common)            | Overload 2 of every registry method, `resolveRequestService`, `getService`.                             |
| `StandardCapability` (changed: union of branded tokens) | type (common)            | `CapabilityKey`'s definition.                                                                           |
| `ServiceToken<T>` (changed)                             | type (common)            | apps/cqrs `NOTE_STORE`, apps/cloudflare `WORKER_ENV`, registry overload 4.                              |
| `IServiceRegistry` (changed)                            | interface (common)       | Every `ctx.services` / `app.services` call.                                                             |
| `ServiceResolver` (changed)                             | interface (react-router) | `getService` and `load-context.ts`.                                                                     |
| `MockServiceRegistry` (changed)                         | class (testing)          | Tests typed against the class.                                                                          |

### 4.1 Options — every option names its consumer

| Option                                                               | Consumer                                                                            | Behavior (per implementation)                                                          |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `TRUST_FORWARDED_HOST` (generated env variable, not a plugin option) | The generated full-stack `setu.config.ts` (§3.11) → `ipSecurity.trustForwardedHost` | `''`/`'false'` off; `'true'` on; other values refused; `true` without proxies refused. |

No plugin option is added.

## 5. Implementation files

| File                                                                                                                                                                                                                     | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/tokens.ts`                                                                                                                                                                                          | Brand, `StandardCapabilityToken`, `CapabilityKey`, and branded `CAPABILITIES` values (§3.1).                                                                                                                                                                                                                                                                                                                                             |
| `packages/common/src/capability-services.ts` (new)                                                                                                                                                                       | `CapabilityServices` and `UnboundCapability` (§3.2).                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/common/src/registry.ts`                                                                                                                                                                                        | Overloads, `KeysServing`, `UnboundToken` (§3.3).                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/common/src/services/request-service.ts`                                                                                                                                                                        | `ServiceToken` brand, `RequestServiceToken`, `requestServiceToken`, typed `resolveRequestService` (§3.4–3.5).                                                                                                                                                                                                                                                                                                                            |
| `packages/common/src/index.ts`                                                                                                                                                                                           | Barrel exports for the new symbols.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/database-plugin/src/interfaces/index.ts`, `packages/cloudflare-plugin/src/bindings/binding-registry.ts`, `packages/static-plugin/src/interfaces/index.ts`, `packages/messaging-plugin/src/interfaces/index.ts` | `declare module '@setu-ts/common'` augmentation (§3.2).                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/react-router-plugin/src/handler/get-service.ts`, `load-context.ts`                                                                                                                                             | Overloaded `ServiceResolver` / `getService` (§3.5).                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/testing/src/mock-registry.ts`, `override-capability.ts` (JSDoc only)                                                                                                                                           | §3.7.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/kernel/src/**`                                                                                                                                                                                                 | Only where a call site is refused (§3.8); no behaviour change.                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/cli/src/templates/full-stack-module-files.ts`, `schematics/module-full-stack.ts`, `templates/project-files.ts`, `templates/full-stack-build-files.ts`, `schematics/{metric,migration,service,sse,ws-route}.ts` | Generated token constructor and inferred `get` (§3.8).                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/cli/src/agents/render.ts`                                                                                                                                                                                      | V12-58 (§3.9).                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/cli/src/utils/plugin-wirings.ts` (new), `commands/add.ts`, `diagnostics/ids.ts`, `diagnostics/wiring.ts`, `diagnostics/diagnose.ts`, `diagnostics/render.ts`                                                   | V12-59 (§3.10).                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/cli/src/templates/full-stack.ts`                                                                                                                                                                               | V12-61 (§3.11).                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Every other `src` / test / app / doc site the compiler or `check:docs` refuses                                                                                                                                           | §3.8.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Docs                                                                                                                                                                                                                     | PUBLIC_API.md (registry row, tokens row, request-bound section, react-router and testing rows); AI_GUIDELINES:176; ARCHITECTURE registry section and C2; `common` and `cache-plugin` READMEs; `docs/deployment.md`; `docs/upgrading.md` 0.13.0; CHANGELOG `[Unreleased]` (BREAKING + Fixed); ROADMAP M139g row and section (packages gain `testing`, `react-router-plugin`, `cli` and the four augmenting plugins; V12-58/59/61 listed). |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                                                                                                                                                                                                                               | src covered                                                | Key assertions (and the signature each call type-checks against)                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/capability-types.test.ts` (new)                                                                                                                                                                                                                                                                              | `tokens.ts`, `capability-services.ts`                      | §3.1: run-time values unchanged, branded types, a plain literal refused.                       |
| `test/capability-map.test.ts` (new, root)                                                                                                                                                                                                                                                                                               | `capability-services.ts` (whole program)                   | §3.2: `UnboundCapability` is exactly the four kernel-registered tokens.                        |
| `packages/common/test/unit/registry-overloads.test.ts` (new)                                                                                                                                                                                                                                                                            | `registry.ts`                                              | §3.3: every overload arm, accepted and refused.                                                |
| `packages/common/test/unit/registry-contract.test.ts` (existing)                                                                                                                                                                                                                                                                        | `registry.ts`                                              | A single-signature literal still implements `IServiceRegistry`.                                |
| `packages/common/test/unit/request-service.test.ts` (extended)                                                                                                                                                                                                                                                                          | `services/request-service.ts`                              | §3.4–3.5: `requestServiceToken` grammar refusal, resolve via request token, inference per arm. |
| `packages/common/test/unit/barrel-exports.test.ts` (extended)                                                                                                                                                                                                                                                                           | `index.ts`                                                 | New value export `requestServiceToken`.                                                        |
| `packages/database-plugin/test/unit/capability-binding.test.ts` (new); a binding line in `cloudflare-plugin/test/unit/bindings-registry.test.ts`, `static-plugin/test/unit/static-plugin.test.ts`, `messaging-plugin/test/unit/outbox-plugin.test.ts` (whichever existing file holds that interface's tests, checked at implementation) | The augmentation blocks                                    | `get(CAPABILITIES.X)` infers the plugin interface.                                             |
| `packages/react-router-plugin/test/unit/get-service.test.ts` (extended)                                                                                                                                                                                                                                                                 | `get-service.ts`, `load-context.ts`                        | §3.5 arms and a request-bound resolve.                                                         |
| `packages/testing/test/unit/mock-registry.test.ts` (extended)                                                                                                                                                                                                                                                                           | `mock-registry.ts`                                         | §3.7 type-equality drift guard and one refused pairing.                                        |
| `packages/cli/test/unit/agents/workspace-brief.test.ts` (extended)                                                                                                                                                                                                                                                                      | `agents/render.ts`                                         | §3.9.                                                                                          |
| `packages/cli/test/unit/check-wiring.test.ts`, `diagnose.test.ts` (extended); `packages/cli/test/unit/plugin-wirings.test.ts` (new, table membership: every entry's symbol is the package's exported factory)                                                                                                                           | `utils/plugin-wirings.ts`, `diagnostics/*`                 | §3.10.                                                                                         |
| `packages/cli/test/unit/full-stack-template.test.ts` (extended)                                                                                                                                                                                                                                                                         | `templates/full-stack.ts`, module templates and schematics | §3.8 token constructor, and §3.11 per value.                                                   |
| `packages/cli/test/e2e/scaffold-runs-e2e.test.ts`, `full-stack-modules-e2e.test.ts`                                                                                                                                                                                                                                                     | Generated output                                           | §3.11 forwarded-host cases; a module scaffold boots with `requestServiceToken`.                |

Type-level assertions are enforced by `pnpm run check`, the repository's only type gate (there is no
Vitest typecheck mode). Each `@ts-expect-error` is a real refusal, because an unused directive fails
`tsc`.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m139g-typed-capability-lookups
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run check:docs
pnpm run test:tooling
pnpm run ci:local          # all shards, incl. --shard cli (scaffold boot) and the Node coverage tables
pnpm run test:deno-lane
pnpm run release:publish --dry-run
pnpm run release:verify 0.12.0
```

Additional evidence:

- A tiny consumer compiled against the BUILT `dist` declarations of `common` plus `database-plugin`
  shows that augmentation survives packing: `get(CAPABILITIES.DATABASE)` infers `IDatabaseService`.
  It is run by hand and its output is pasted into the PR.
- A fresh-agent security audit of V12-58 (credential masking) and V12-61 (proxy trust switch) on the
  final commit, per `.roo/skills/security-audit/SKILL.md`. Its record goes in the PR.

## 8a. Design security review

- **Assets:**
  - broker credentials a workspace's `brokerUrl` can carry into committed files (`AGENTS.md`, the
    root `README.md`);
  - the public origin an application derives behind a proxy (absolute URLs, the React Router action
    origin check, the WebSocket Origin check);
  - the developer's project tree that `setu check` reads.
- **Attackers and inputs:**
  - any reader of the repository, for credentials written into committed text;
  - a network client that sends its own `X-Forwarded-Host`, `X-Forwarded-For` or
    `X-Forwarded-Proto`;
  - a deployer who sets `TRUST_FORWARDED_HOST` to an unexpected spelling;
  - a hostile or unusual project manifest or `setu.config.ts` that `setu check` reads.
- **Reviewed flows and obligations:**
  1. **V12-58:** a credentialed `brokerUrl` reaches `AGENTS.md` and the root `README.md` transport
     section only through `maskUrlUserinfo`. The host is kept, and the `broker default` /
     local-default fallbacks are unchanged. Masking covers userinfo, which is the function's
     documented scope; see the accepted risk below.
  2. **V12-61:** only the exact strings `''`, `'false'` and `'true'` are accepted. Every other value
     refuses with a constant message that does not echo the value. `true` without `TRUSTED_PROXIES`
     refuses. `trustForwardedHost` reaches `ipSecurity` only when proxies are listed. The forwarded
     host is believed only behind a trusted peer whose walk resolves a client; that is the unchanged
     `ip-security-middleware` rule (M113n F2). The default is off in `.env`, `.env.example` and the
     template.
  3. **V12-59:** `setu check` reads files only and executes nothing from the project. Rendered names
     come from the constant provider table and pass through `escapeName`. The call test is a
     constant regex.
  4. **§3.1–§3.8:** the typing changes are compile-time only. The emitted JavaScript of the
     registry, `resolveRequestService` and `getService` is unchanged, and no test double weakens a
     security-relevant assertion.
- **Accepted risk:**
  - `maskUrlUserinfo` does not mask credentials in a query string or a fragment, or userinfo in a
    URL with no scheme (audit F3). This is the function's documented limit and outside V12-58's row.
  - The generated `src/transport/index.ts` and `setu.workspace.json` hold the `brokerUrl` as
    entered, because the transport connects with it. A credentialed endpoint belongs in the broker's
    environment variable, not in the override.
- **Audit:** a committed-tree security audit by a fresh Claude agent, per
  `.roo/skills/security-audit/SKILL.md`, before the PR merges.

## 8. Risks & mitigations

- **Two copies of `@setu-ts/common` in one install** have distinct `unique symbol` brands, so a
  token from one copy is refused by the other's registry type.
  - Mitigation: the release pins internal ranges to the exact version (`release:verify`).
  - The upgrading guide names the symptom ("not assignable to parameter of type 'UnboundToken'" on a
    `CAPABILITIES` value) and the fix: dedupe `@setu-ts/common`.
- **Churn across ~750 test call sites and ~280 `register` sites** that pass partial doubles.
  - Mitigation: §3.8's rule (full double, `overrideCapability`, or a commented cast for a
    deliberately malformed registration).
  - The refused-site count is reported in the PR.
- **A variable typed as the whole `StandardCapability` union** passed to `get` infers the union of
  services.
  - Mitigation: none is needed for correctness; any such src site `pnpm run check` reports is
    narrowed to its own token.
- **Opaque compiler errors on a wrong pairing.**
  - Mitigation: the named `UnboundToken` parameter type, and an upgrading-guide entry that quotes
    the message.
- **Augmentation lost in packed declarations.**
  - Mitigation: the `dist` consumer check in §7.
- **Generated Deno output not `deno fmt`-clean** after template edits (M139d lesson).
  - Mitigation: scaffold with the real CLI and diff against `deno fmt` before the CLI shard.

## 9. Out of scope

- `getOrSet` on `ICacheStore`: the C1 README is fixed instead. No milestone owns it.
- Named types for `METRIC_REGISTRATION`, `OPENAPI_SCHEMA`, `DECORATOR_HANDLER` and `CLI_COMMAND`
  (they stay unbound).
- V12-59 for a starter arm that is installed but not configured: an arm key in a config cannot be
  told apart from an ordinary word by the read-only call test.
- Typing `overrideCapability`.
