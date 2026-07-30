# Milestone 36b — Starter integration: realtime, DI, and NestJS familiarity

> **Status:** Planning. Branch: `feat/m36b-starter-integration`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

M36 shipped three starter composition libraries and deliberately bundled none of the real-time
plugins and no DI container, on the stated grounds that each "requires caller-supplied routes,
channels, or a transport before they do anything" and that `di-plugin` is "an opt-in alternative to
the kernel's ServiceRegistry, not an addition to it". M36b keeps that reasoning intact and adds the
two capabilities as **gated arms** — present only when the caller supplies the arm, exactly as
`database` and `auth` already work — so nothing is bundled that cannot serve a request. Alongside
that, it closes the one ergonomic gap that makes this framework feel foreign to a developer arriving
from NestJS: constructor injection currently requires a positional token list on the class, which
misinjects silently when constructor arguments are reordered.

- **In scope:**
  1. A gated `realtime` arm on `RestStarterOptions` (inherited by the microservice and full-stack
     tiers) adding `WebSocketPlugin`, `SsePlugin`, and `RealtimeBackplanePlugin` per sub-arm.
  2. A gated `di` arm adding `DiPlugin`, which switches `DecoratorPlugin` onto its container path.
  3. Parameter-level `@Inject(token)` in `decorator-plugin` — a public-API addition to an existing
     export, with the class-level form deprecated rather than removed.
  4. The NestJS-familiarity showcase: a `nest` CLI template emitting a decorated controller and an
     injected service, plus a "Coming from NestJS" section in all three starter READMEs.
- **NOT this milestone:** config-key indirection (`urlFromConfig` / `secretFromConfig`) — deferred
  with cause in §9, it needs a kernel answer this plan does not have; the full-stack React Router
  app skeleton adapted from B2BAdmin (M36 C6) — deferred in §9 to M36c on scope, and no longer on
  the session capability, which M48 shipped (PR #105); committed example applications under `apps/*`
  — Milestone 37 (see C3); the M34b `errorHandler` priority defect — its own
  `fix/cli-error-handler-priority` branch, per M36 §9.

## 1. Contracts verified from SOURCE (not names)

| Reference                                      | Source (file:line)                                                                                                                        | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Inject`                                       | `packages/decorator-plugin/src/decorators/injection.ts:62-67`                                                                             | A **`ClassDecorator` only**, taking `...tokens: string[]` and calling `metadataStore.mergeService(target, { inject: tokens })`. There is no parameter-level form today.                                                                                                                                                                                                                          |
| `Injectable`                                   | `packages/decorator-plugin/src/decorators/injection.ts:38-43`                                                                             | `ClassDecorator`; merges `InjectableOptions` into the service record.                                                                                                                                                                                                                                                                                                                            |
| `ServiceMetadata`                              | `packages/decorator-plugin/src/metadata/metadata-store.ts:120-127`                                                                        | Exactly three optional fields: `scope?: 'singleton' \| 'scoped' \| 'transient'`, `token?: string`, `inject?: readonly string[]` — the last documented "in argument order".                                                                                                                                                                                                                       |
| `MetadataStore.mergeService`                   | `packages/decorator-plugin/src/metadata/metadata-store.ts:344-357`                                                                        | Field-wise merge; `inject` is **replaced wholesale**, not appended, so two class-level `@Inject` calls silently keep the last.                                                                                                                                                                                                                                                                   |
| `IMetadataStore`                               | `packages/common/src/plugin.ts:359-366`                                                                                                   | **Only three readonly maps** (`controllers`, `services`, `routes`). `mergeService`/`getService` are concrete-class members, NOT committed. Storing constructor-parameter tokens therefore needs **no `common` change**.                                                                                                                                                                          |
| `instantiate` (registry path)                  | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:112-126`                                                                        | Prefers `ctx.container` when the class is registered there; else `meta.inject.map((t) => ctx.services.get(t))` spread into the constructor; else zero-arg `new`.                                                                                                                                                                                                                                 |
| `registerInContainer` (container path)         | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:84-105`                                                                         | Builds `ClassProvider` `{ useClass: target, inject: meta.inject }` and passes `{ scope }` from `@Injectable`. Both paths read the same `meta.inject` array.                                                                                                                                                                                                                                      |
| `registerService` branch                       | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:132-144`                                                                        | Branches on `ctx.container !== undefined`. **Adding `DiPlugin` to an app changes how every decorated service is constructed** — this is why the `di` arm must be gated (§3.4).                                                                                                                                                                                                                   |
| `ctx.container` origin                         | `packages/kernel/src/application/application.ts:241,248`                                                                                  | A lazy Proxy getter over `registry.get(CAPABILITIES.DI_CONTAINER)`, read at access time. DI ↔ decorator interop is kernel-mediated; neither plugin imports the other.                                                                                                                                                                                                                            |
| `DiPlugin`                                     | `packages/di-plugin/src/plugin/di-plugin.ts:65-92`                                                                                        | `provides: [CAPABILITIES.DI_CONTAINER]`, `priority: PLUGIN_PRIORITY.NORMAL`, synchronous `register`. Options read: `defaultScope`, `autoRegister` (the latter installs an `ExternalResolver` bridging to the ServiceRegistry).                                                                                                                                                                   |
| `DecoratorPlugin`                              | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:341-345`                                                                        | `provides: [CAPABILITIES.METADATA_STORE]`, `priority: PLUGIN_PRIORITY.LOW`. Declares no dependency on the container.                                                                                                                                                                                                                                                                             |
| Plugin ordering rule                           | `packages/kernel/src/registry/plugin-resolver.ts:153-155`                                                                                 | Sorted by `(priority ?? DEFAULT) ascending`, then registration order. With `PLUGIN_PRIORITY.NORMAL = 500` and `LOW = 900` (`packages/common/src/types.ts:86,90`), `DiPlugin` registers **before** `DecoratorPlugin`, so `ctx.container` is set in time. No ordering change needed.                                                                                                               |
| `WebSocketPlugin`                              | `packages/websocket-plugin/src/plugin/websocket-plugin.ts:62-64`                                                                          | `optionalDependencies: ['logger', CAPABILITIES.REALTIME_BACKPLANE]`, `provides: [CAPABILITIES.WEBSOCKET]`, `priority: NORMAL`. Hard-resolves `CAPABILITIES.HTTP_ADAPTER`; registers with `available: false` rather than throwing on a legacy adapter.                                                                                                                                            |
| `SsePlugin`                                    | `packages/sse-plugin/src/plugin/sse-plugin.ts:43-45`                                                                                      | `optionalDependencies: ['logger', CAPABILITIES.REALTIME_BACKPLANE]`, `provides: [CAPABILITIES.SSE]`, `priority: NORMAL`.                                                                                                                                                                                                                                                                         |
| `RealtimeBackplanePlugin`                      | `packages/realtime-backplane-plugin/src/plugin/realtime-backplane-plugin.ts:48,54-57`                                                     | Options default to `{ transport: 'memory' }`; `provides: [CAPABILITIES.REALTIME_BACKPLANE]`, `optionalDependencies: [CAPABILITIES.MESSAGING]`, `priority: HIGH` (100) — so it registers before both consumers.                                                                                                                                                                                   |
| `'messaging'` transport guard                  | `packages/realtime-backplane-plugin/src/transports/backplane-factory.ts:41-47`                                                            | Throws at `register()` naming `MessagingPlugin` when `CAPABILITIES.MESSAGING` is absent. The starter needs **no** tier-side validation for this case; the existing throw is the guard.                                                                                                                                                                                                           |
| `scalingNotice`                                | `packages/websocket-plugin/src/interfaces/index.ts:67`, `packages/sse-plugin/src/interfaces/index.ts:41`                                  | `readonly scalingNotice?: boolean` (default `true`) on both option types, shipped by PR #102. Relevant because a `realtime` arm without a backplane sub-arm emits that notice.                                                                                                                                                                                                                   |
| Starter option shape                           | `packages/starters/rest-starter/src/options.ts:22-65`, `.../microservice-starter/src/options.ts`, `.../full-stack-starter/src/options.ts` | One optional arm per plugin; `MicroserviceStarterOptions extends RestStarterOptions` and `FullStackStarterOptions extends MicroserviceStarterOptions`. An arm added to `RestStarterOptions` is inherited by all three tiers.                                                                                                                                                                     |
| Starter gating idiom                           | `packages/starters/rest-starter/src/app.ts:44-45`                                                                                         | `...(options.database ? [DatabasePlugin(options.database)] : [])` — the established spread-gate for an opt-in arm. **Each tier's implementation file is `src/app.ts`**, renamed from `rest-app.ts`/`microservice-app.ts`/`full-stack-app.ts` by M36 commit `4acc84c`; its tests are `test/unit/app.test.ts`, `test/unit/barrel-exports.test.ts`, and `test/integration/app-integration.test.ts`. |
| CLI template registry                          | `packages/cli/src/templates/registry.ts`, `.../templates/rest.ts`, `.../templates/microservice.ts`                                        | Templates are data modules behind a registry, each declaring plugin/middleware wirings plus an `unsupported` runtime map consulted at `packages/cli/src/commands/new.ts:404`. Templates emit **inline** wiring, not starter imports (M36 §9).                                                                                                                                                    |
| `experimentalDecorators` in generated projects | `packages/cli/src/commands/new.ts:269,311`                                                                                                | Set for both the Deno and the node/bun manifests. `emitDecoratorMetadata` appears **nowhere in the repo**, and no source reads `design:paramtypes` — type-inferred injection is unavailable by construction, not by choice.                                                                                                                                                                      |
| `Wiring` / `TemplateDefinition` shape          | `packages/cli/src/templates/registry.ts:20-24,50-72`                                                                                      | `Wiring` is exactly `{ pkg, symbol }` — **no field for call arguments**. `TemplateDefinition` is exactly `{ name, description, plugins, middleware, unsupported }` — **no field for emitted source files**. Both gaps block §3.7 as first written; §3.7a resolves them.                                                                                                                          |
| `configModule` renderer                        | `packages/cli/src/commands/new.ts:85-125`                                                                                                 | Renders every plugin as `${p.symbol}(),` — **argless** — and imports only `@hono-enterprise/*` packages. So `DecoratorPlugin({ controllers: [...] })` is unrepresentable today, as is an import of a project-local file.                                                                                                                                                                         |
| `projectFiles`                                 | `packages/cli/src/commands/new.ts:238-243`                                                                                                | Signature `(projectName, runtime, plugins, middleware)`, building a fixed file set. Extra template files need a parameter it does not have (§3.7a).                                                                                                                                                                                                                                              |
| `TEMPLATES` / `isTemplateName`                 | `packages/cli/src/constants.ts:54,57,89-91`                                                                                               | `TEMPLATES = ['rest', 'microservice'] as const`; `TemplateName` derives from it and `isTemplateName` gates `--template`. Adding `'nest'` here is what makes the flag accept it.                                                                                                                                                                                                                  |
| `DecoratorPluginOptions`                       | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:44-56`                                                                          | Carries `autoDiscover`, `controllersPath`, `controllers?: readonly Constructor[]`, `services?: readonly Constructor[]` — so the `nest` template's `{ controllers, services }` argument is a real typed surface.                                                                                                                                                                                  |
| `DiPluginOptions`                              | `packages/di-plugin/src/index.ts:18`                                                                                                      | Exported as a type from the package barrel, so the starter's `di?: DiPluginOptions` arm imports a committed name.                                                                                                                                                                                                                                                                                |
| Backplane option names, optional discriminant  | `packages/realtime-backplane-plugin/src/interfaces/index.ts:96-97,163-167`                                                                | The option type is `RealtimeBackplanePluginOptions`, a union discriminated on `transport`; `MemoryBackplaneOptions.transport?: 'memory'` is **optional**, so `backplane: {}` type-checks and selects memory. `WebSocketPluginOptions`/`SsePluginOptions` are exported from their own barrels.                                                                                                    |
| No committed M36b ROADMAP section              | `ROADMAP.md:4741-4802` (Progress Tracking), `grep -n '36b' ROADMAP.md`                                                                    | There is **no `## Milestone 36b:` section and no `36b` Progress row** — only three prose mentions (4488, 4601, 4628). This milestone must ADD both, not flip an existing row (C7).                                                                                                                                                                                                               |
| Dual-position decorator feasibility            | Probe under `experimentalDecorators`, run this session                                                                                    | A single function typed `ClassDecorator & ParameterDecorator` type-checks in the class position, the constructor-parameter position, and the method-parameter position. Constructor params report `propertyKey === undefined`; method params report the method name. **Constructor parameter decorators fire in reverse argument order** (index 1 before index 0).                               |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                                               | Resolution (picked side)                                                                                                                                                                                                                                                                     | Doc deliverable (same PR)                                                                                                                                      |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | M36 §9 states the three real-time plugins and `di-plugin` are "deliberately NOT bundled in any tier", because bundling would "register surface that cannot serve a request". M36b adds all four.                                                                                                                                                                                       | **M36 is right and the rule is kept.** Every added plugin sits behind an arm the caller must supply, so the default composition of all three tiers is byte-identical to M36. Nothing is bundled; the arms make previously-impossible compositions expressible without `app.register(...)`.   | Rewrite that M36 §9 bullet in `plans/archive/milestone-36-starters.md` to record the M36b outcome, so the archived plan does not read as still-current policy. |
| C2 | M36 §9 says "the CLI keeps emitting inline wiring (M34b)" and defers a `honoe new --starter` path. The showcase deliverable adds a CLI template.                                                                                                                                                                                                                                       | **Inline wiring is kept.** The new `nest` template emits inline plugin wiring like `rest` and `microservice` do; it adds decorated-class example files, not starter imports. No conflict remains once the template is inline.                                                                | None — the M36 statement stays true. Recorded here so a reader does not read the new template as the deferred `--starter` path.                                |
| C3 | M36 §9 assigns "example applications under `apps/*`" to Milestone 37, but a runnable NestJS-comparison example was requested as a showcase surface.                                                                                                                                                                                                                                    | **M37 keeps `apps/*`.** M36b's runnable surface is the scaffolded project produced by `honoe new --template nest`, which runs and is exercised by the CLI drift gate — a committed second copy under `apps/` would duplicate it and pre-empt M37's scope.                                    | Add a named deliverable to the ROADMAP M37 section: an example app demonstrating the decorator/DI composition, cross-referencing this plan's §3.1.             |
| C4 | `PUBLIC_API.md`'s decorator-plugin section documents `Inject` as taking `...tokens: string[]` in the class position only. §3.1 adds a parameter position and deprecates the class form.                                                                                                                                                                                                | **Both positions are documented, the class form marked deprecated.** A published export is governed by AI_GUIDELINES §9.2 (deprecate, do not remove), so the class form keeps working for the whole `0.x` line.                                                                              | Update the `Inject` row and example in `PUBLIC_API.md`; add the parameter-position example and the deprecation note on the class form.                         |
| C5 | `CLAUDE.md:752` reads "**Next milestone** — **Milestone 36b** (React Router app skeleton), then M36c which consumes M48", labelling THIS milestone as the React Router skeleton. `ROADMAP.md:4601` says the opposite — "M36b (planned) → **M48** → M36c (React Router app skeleton + config-key indirection)" — and `ROADMAP.md:4628` puts the parameter-level `@Inject` form in M36b. | **ROADMAP is right; `CLAUDE.md:752` is a stale mislabel.** Two committed docs disagree and this plan picks ROADMAP: M36b is realtime/DI/NestJS-familiarity, M36c is the React Router skeleton + config-key indirection. The plan's own §9 already defers the skeleton to M36c on that basis. | Rewrite the `CLAUDE.md` "Next milestone" line to name M36b's real scope and point M36c at the skeleton — shipped as part of the same status flip this PR owes. |
| C6 | `ROADMAP.md:4634-4638` (the Plugin-First vs NestJS comparison) states "**cookie sessions and form-CSRF do not exist yet** (M48) … the CSRF middleware validates Origin/Referer rather than a synchronizer token". M48 shipped (PR #105) and `packages/session-plugin` is on `main`.                                                                                                    | **Correct the paragraph.** It sits in the very section §3.8's "Coming from NestJS" mapping is derived from, so shipping the mapping while the section above it tells a NestJS reader the capability is missing would contradict this milestone's own deliverable.                            | Update that paragraph to reference the shipped `session-plugin` (`csrfFormMiddleware`, `getSession`), keeping the `@Inject` caveat, which stays true.          |
| C7 | ROADMAP has **no `## Milestone 36b:` section and no `36b` Progress Tracking row** (verified, §1) — unlike every other lettered milestone (34b, 30b, 14b–14d), which all have both.                                                                                                                                                                                                     | **Add both.** A milestone whose completion cannot be recorded in the tracking table has no place to be marked done, and CLAUDE.md's status rule requires the row be `✅` in this PR.                                                                                                         | Add a `## Milestone 36b:` section (objective, deliverable checklist) and a `\| 36b \| ✅ \| starters + decorator-plugin + cli \|` Progress row.                |

## 3. Design decisions

### 3.1 Parameter-level `@Inject` — one export, two positions

- **Decision:** extend the existing `Inject` export to return `ClassDecorator & ParameterDecorator`
  and branch at runtime on `typeof parameterIndex === 'number'`. In the parameter position it
  records a single token against its argument index; in the class position it behaves exactly as it
  does today. A single export is chosen over a new name (`InjectParam`) because matching NestJS's
  own `@Inject(token)` vocabulary is the entire point of the deliverable.
- **Why:** verified feasible this session — the intersection type type-checks in both positions
  under `experimentalDecorators`, and the two positions are distinguishable at runtime because a
  class decorator receives one argument while a parameter decorator receives three.
- **Test home:** `test/unit/injection.test.ts` — asserts the class form still records
  `{ inject: [...] }` unchanged, and that the parameter form records per-index tokens.

### 3.2 Constructor-parameter tokens are stored by index, never appended

- **Decision:** parameter tokens are written into a new index-keyed map on `MetadataStore`
  (`mergeCtorParam(target, index, token)`), and assembled into a dense array by ascending index by a
  new `ctorInject(target)` accessor. A missing index below the highest recorded one throws at
  registration time, naming the class and the undecorated index.
- **Why:** the probe established that constructor parameter decorators evaluate in **reverse**
  argument order, so appending in call order would reverse the token list and inject the wrong
  service into every argument — the precise failure this deliverable exists to remove, reintroduced
  one layer down. A hole in the sequence would shift every later argument, so it is refused loudly
  rather than filled with `undefined`.
- **Test home:** `test/unit/injection.test.ts` asserts a two-argument class assembles
  `['database', 'logger']` in declaration order; `test/unit/metadata-store.test.ts` asserts the
  gap-throw names the class and index.

### 3.3 Mixing the class form and the parameter form on one class throws

- **Decision:** when a class carries both a class-level `@Inject(...)` and any parameter-level
  `@Inject`, registration throws naming the class. Neither form silently wins.
- **Why:** `mergeService` replaces `inject` wholesale (verified, §1), so a precedence rule would be
  invisible at the call site and would depend on decorator evaluation order — the same silent-
  misinjection class as §3.2. An explicit throw at startup is the only outcome a reader can predict.
- **Test home:** `test/unit/decorator-plugin.test.ts` — a doubly-annotated class fails `register()`
  with a message naming the class.

### 3.4 The `di` arm is gated, never always-on

- **Decision:** `di?: DiPluginOptions` on `RestStarterOptions`, added with the established
  spread-gate idiom. Omitted by default in all three tiers.
- **Why:** `registerService` branches on `ctx.container !== undefined` (verified, §1), so
  registering `DiPlugin` changes how every decorated service in the application is constructed —
  from a direct `new` with registry-resolved arguments to a container provider honoring
  `@Injectable({ scope })`. Making it always-on would silently change the construction path, and the
  lifecycle, for every application already using an M36 starter. Gating keeps M36's default
  composition byte-identical.
- **Test home:** `test/unit/app.test.ts` asserts `DiPlugin` is absent by default and present when
  the arm is supplied; `test/integration/app-integration.test.ts` asserts a decorated service
  resolves through the container when the arm is on, and through the registry when it is off.

### 3.5 The `realtime` arm is one arm with three sub-arms

- **Decision:** a single `realtime?: RealtimeArm` option, where
  `RealtimeArm = { websocket?: WebSocketPluginOptions; sse?: SsePluginOptions; backplane?: RealtimeBackplanePluginOptions }`.
  Each sub-arm's presence adds exactly its plugin. `realtime: {}` adds nothing and is not an error.
- **Why:** one arm keeps the real-time story discoverable as a unit in the option type and the tier
  tables, while per-sub-arm gating preserves M36's rule that nothing which cannot serve a request is
  registered — a WebSocket plugin with no routes still registers no routes, so it is the caller
  asking for it that makes it meaningful. A flat `websocket?`/`sse?`/`backplane?` triple was
  rejected because it scatters one concern across three unrelated-looking options.
- **Test home:** `test/unit/app.test.ts` — one case per sub-arm asserting the plugin set, plus a
  case asserting `realtime: {}` adds none.

### 3.6 The starter performs no `'messaging'` transport validation

- **Decision:** when `realtime.backplane.transport === 'messaging'` and the tier has no
  `MessagingPlugin`, the starter adds the backplane plugin unchanged and lets its own registration
  throw.
- **Why:** `backplane-factory.ts:41-47` already throws at `register()` with a message naming
  `MessagingPlugin` and the two alternative transports (verified, §1). A second check in the starter
  would duplicate that logic in a place that must not drift from it, and would fire for the `rest`
  tier even when the caller had registered `MessagingPlugin` themselves on the returned app.
- **Test home:** `test/integration/app-integration.test.ts` asserts `start()` rejects with the
  factory's message for that combination.

### 3.7 The `nest` CLI template

- **Decision:** a third template beside `rest` and `microservice`, emitting inline plugin wiring
  that includes `DecoratorPlugin` and `DiPlugin`, plus three source files: a `@Controller` with two
  routes, an `@Injectable` service consumed through parameter-level `@Inject`, and the
  `honoe.config.ts` registration passing the controller through
  `DecoratorPlugin({ controllers: [...] })`. `unsupported` is empty — nothing in the template needs
  raw sockets.
- **Why:** the scaffolded project is the runnable showcase (C3), and it is already covered by the
  M34b CLI drift gate, which type-checks generated output against the workspace. Emitting the
  controller through the template rather than a schematic means a developer sees the composition in
  the first file they open.
- **Test home:** `test/unit/templates.test.ts` asserts the emitted file set and that the wiring
  includes both plugins; the existing drift gate type-checks the generated project.

### 3.7a The template contract gains arguments and files — the seam §3.7 needs

- **Decision:** widen the CLI's template contract by exactly three fields, then let the `nest`
  template be data like the other two:
  1. `Wiring.args?: string` — rendered verbatim as the plugin call's argument list. `configModule`
     emits `${p.symbol}(${p.args ?? ''}),`, so every existing wiring is byte-identical (`args`
     absent → `Symbol()`), and `nest`'s decorator wiring becomes
     `DecoratorPlugin({ controllers: [GreetingController], services: [GreetingService] })`.
  2. `TemplateDefinition.localImports?: readonly LocalImport[]`, each
     `{ symbols: readonly string[]; from: string }` — emitted into `honoe.config.ts` above the
     package imports, so the controller and service classes the `args` string names are actually in
     scope. Without this, `args` would render source referencing undeclared identifiers, which is
     the exact silent-corruption class the M35 codegen review rejected.
  3. `TemplateDefinition.files?: readonly GeneratedFile[]` — extra project-relative source files,
     concatenated onto `projectFiles`'s fixed set. `projectFiles` takes one new
     `extras: readonly GeneratedFile[] = []` parameter, so the no-template path is unchanged.
- **Why:** §3.7 as first written assumed the template contract could already express a plugin
  argument and emit source files. It cannot — verified from source (§1): `Wiring` is
  `{ pkg, symbol }` and the renderer hardcodes `${p.symbol}()`. Discovering that during
  implementation is how a plan ships an improvised design, so the seam is specified here instead.
  Three narrow optional fields are chosen over a per-template render hook because templates must
  stay **data** — the registry JSDoc states "A template is DATA … never a pre-rendered string", and
  `commands/new.ts` owns the single renderer so every template produces the same file shape.
- **`args` is a rendered string, not a structure.** A structured option-object AST would be a second
  serializer to keep in step with TypeScript syntax for no gain: the value is authored in-repo by a
  template module, never taken from user input, so there is no injection surface — unlike M35's
  codegen, which consumed an untrusted OpenAPI document. The drift gate type-checking the generated
  project is what proves each `args` string compiles.
- **Test home:** `packages/cli/test/unit/templates.test.ts` asserts `args`-less wirings still render
  `Symbol()` and that a wiring with `args` renders them; `test/unit/new.test.ts` asserts the emitted
  file set includes the `files` entries and that `localImports` appear in `honoe.config.ts`; the
  existing e2e drift gate type-checks the whole scaffolded `nest` project.

### 3.8 Starter READMEs carry the NestJS mapping, including what differs

- **Decision:** each of the three starter READMEs gains a "Coming from NestJS" section: a vocabulary
  mapping table (module → plugin, provider → service under a token, guard → `@UseGuards`, pipe →
  `@ValidateBody`), and an explicit statement that constructor injection needs `@Inject(token)`
  because Deno does not support `emitDecoratorMetadata`, so parameter types cannot be read.
- **Why:** the limitation is permanent and platform-imposed (verified, §1). A migration doc that
  omits it sends readers to debug their own code; naming it converts a surprise into a one-line
  rule.
- **Test home:** none — prose. Covered by the §7 `fmt:check` gate and by C4's `PUBLIC_API.md` edit
  carrying the same statement for the API reference.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                        | Kind      | Consumer / real code path that READS it                                                                                                        |
| -------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `Inject` (widened, `decorator-plugin`) | function  | Already exported. New parameter position read by `MetadataStore.ctorInject`, consumed by `registerInContainer` and `instantiate` (§1).         |
| `RealtimeArm` (`rest-starter`)         | interface | Read by `buildRestPlugins` (§3.5); re-exported through the microservice and full-stack barrels because their option types extend the REST one. |
| `RestStarterOptions.realtime`          | option    | `buildRestPlugins` — see §4.1.                                                                                                                 |
| `RestStarterOptions.di`                | option    | `buildRestPlugins` — see §4.1.                                                                                                                 |

No new symbol is added to `packages/common`, and no new capability token is invented — the four
plugins involved already own theirs (`WEBSOCKET`, `SSE`, `REALTIME_BACKPLANE`, `DI_CONTAINER`).
`MetadataStore.mergeCtorParam` and `MetadataStore.ctorInject` are **not** added to
`packages/decorator-plugin/src/index.ts`; they are reached through the already-exported
`metadataStore` singleton and the concrete `MetadataStore` class, and `IMetadataStore` in `common`
is untouched (§1).

### 4.1 Options — every option names its consumer

| Option               | Consumer                       | Behavior (per implementation)                                                                                                                   |
| -------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `realtime.websocket` | `buildRestPlugins` spread-gate | Present → `WebSocketPlugin(options.realtime.websocket)` added. Absent → not added. Options passed through unchanged, including `scalingNotice`. |
| `realtime.sse`       | `buildRestPlugins` spread-gate | Present → `SsePlugin(...)` added. Absent → not added.                                                                                           |
| `realtime.backplane` | `buildRestPlugins` spread-gate | Present → `RealtimeBackplanePlugin(...)` added at `priority: HIGH`, so it precedes both consumers. Absent → the two consumers log their notice. |
| `di`                 | `buildRestPlugins` spread-gate | Present → `DiPlugin(options.di)` added, which switches `DecoratorPlugin` onto its container path (§3.4). Absent → registry path, as in M36.     |

## 5. Implementation files

| File                                                       | Purpose                                                                                                                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/decorator-plugin/src/decorators/injection.ts`    | Widen `Inject` to the dual-position form (§3.1); deprecate the class form in JSDoc per C4.                                                                   |
| `packages/decorator-plugin/src/metadata/metadata-store.ts` | Add the index-keyed constructor-parameter map, `mergeCtorParam`, and the assembling `ctorInject` accessor (§3.2).                                            |
| `packages/decorator-plugin/src/plugin/decorator-plugin.ts` | Read `ctorInject` in `registerService`/`instantiate`/`registerInContainer`; add the both-forms throw (§3.3).                                                 |
| `packages/starters/rest-starter/src/options.ts`            | Add `realtime?: RealtimeArm` and `di?: DiPluginOptions`; export `RealtimeArm`.                                                                               |
| `packages/starters/rest-starter/src/app.ts`                | Add the four spread-gates (§3.4, §3.5).                                                                                                                      |
| `packages/starters/rest-starter/src/index.ts`              | Export `RealtimeArm`.                                                                                                                                        |
| `packages/starters/microservice-starter/src/app.ts`        | Inherit the arms through the REST builder; no new gate logic.                                                                                                |
| `packages/starters/full-stack-starter/src/app.ts`          | Inherit the arms through the microservice builder; no new gate logic.                                                                                        |
| `packages/cli/src/templates/nest.ts`                       | The `nest` template: wirings (incl. the `args`-carrying decorator wiring), `localImports`, `unsupported: {}`, and the emitted source files (§3.7, §3.7a).    |
| `packages/cli/src/templates/registry.ts`                   | Add `Wiring.args`, `LocalImport`, `TemplateDefinition.localImports`/`files` (§3.7a); register the `nest` template so `--template nest` and `--help` list it. |
| `packages/cli/src/constants.ts`                            | Add `'nest'` to `TEMPLATES`, so `isTemplateName` accepts the flag (§3.7a).                                                                                   |
| `packages/cli/src/commands/new.ts`                         | Render `args` and `localImports` in `configModule`; thread `extras` through `projectFiles` (§3.7a).                                                          |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                       | src covered                                  | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/decorator-plugin/test/unit/injection.test.ts`                         | `decorators/injection.ts`                    | Class form still records `{ inject: ['a','b'] }`; parameter form on a two-argument constructor assembles `['database','logger']` in **declaration** order despite reverse evaluation (§3.2); `@Inject` on a method parameter throws. Calls type-check against `Inject(...tokens: string[]): ClassDecorator & ParameterDecorator`. |
| `packages/decorator-plugin/test/unit/metadata-store.test.ts`                    | `metadata/metadata-store.ts`                 | `mergeCtorParam(C, 1, 'b')` then `(C, 0, 'a')` → `ctorInject(C)` is `['a','b']`; a recorded index 2 with no index 1 throws naming the class and index 1; `ctorInject` of an unannotated class is `undefined`.                                                                                                                     |
| `packages/decorator-plugin/test/unit/decorator-plugin.test.ts`                  | `plugin/decorator-plugin.ts`                 | Registry path injects registry-resolved arguments in order; container path passes the same array as `ClassProvider.inject`; a class carrying both forms fails `register()` naming the class (§3.3).                                                                                                                               |
| `packages/decorator-plugin/test/integration/di-interop.test.ts`                 | `plugin/decorator-plugin.ts`                 | A real kernel app with `DiPlugin` + `DecoratorPlugin` resolves a parameter-injected service through the container and serves a route from a decorated controller. Guards the priority ordering asserted in §1 rather than assuming it.                                                                                            |
| `packages/starters/rest-starter/test/unit/app.test.ts`                          | `app.ts`, `options.ts`                       | Default set contains none of the four plugins; each sub-arm adds exactly its plugin; `realtime: {}` adds none; `di` present adds `DiPlugin`.                                                                                                                                                                                      |
| `packages/starters/rest-starter/test/integration/app-integration.test.ts`       | `app.ts`                                     | An app with `realtime: { sse: {} }` starts and serves; `realtime: { backplane: { transport: 'messaging' } }` on the REST tier rejects with the factory's message (§3.6); a decorated service resolves through the container with `di` on.                                                                                         |
| `packages/starters/microservice-starter/test/unit/app.test.ts`                  | `app.ts`                                     | The inherited arms work through the microservice builder; the `'messaging'` backplane transport succeeds here because the tier supplies `MessagingPlugin`.                                                                                                                                                                        |
| `packages/starters/full-stack-starter/test/unit/app.test.ts`                    | `app.ts`                                     | Inherited arms work; the full set with every arm supplied still has no duplicate `provides` (the M36 collision guard, extended by four tokens).                                                                                                                                                                                   |
| `packages/starters/full-stack-starter/test/integration/app-integration.test.ts` | `app.ts`                                     | All arms on, one kernel, `inject()` returns `200` — the only check that catches a duplicate name or provider among the imperatively-registering plugins.                                                                                                                                                                          |
| `packages/cli/test/unit/templates.test.ts`                                      | `templates/nest.ts`, `templates/registry.ts` | `getTemplate('nest')` returns it; emitted file set matches §3.7; wiring includes `DecoratorPlugin` and `DiPlugin`; `unsupported` is empty so no runtime is refused.                                                                                                                                                               |
| `packages/cli/test/e2e/generated-project-check.test.ts` (existing drift gate)   | `templates/nest.ts`                          | Scaffolding `--template nest` and running `deno check` against this workspace passes — the gate that caught M34's unresolvable `decorator-plugin` import.                                                                                                                                                                         |

Every `src/` file in §5 has a named test file above. No external npm dependency is added by this
milestone, so no guarded real-import test is required; the one import-shaped risk (the generated
project's own imports) is covered by the existing drift gate.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m36b-starter-integration, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

## 8. Risks & mitigations

- **The milestone spans four packages** (`decorator-plugin`, three starters, `cli`), against
  CLAUDE.md's one-package-per-milestone rule. Mitigation: §3.1–§3.3 are written as a self-contained
  decorator-plugin design with their own contract rows and their own test files, so the smaller
  public surface cannot be under-specified by riding along in the starter sections — the M10 failure
  mode. If the PR grows unreviewable, the decorator-plugin commits are separable and can ship first.
- **`Inject`'s widened type could break an existing call site.** Mitigation: the class position
  keeps its exact current signature and behavior, and `deno task check` over the workspace plus the
  CLI drift gate covers every in-repo caller. The risk is a downstream consumer only, and the
  widening is additive.
- **A decorated class whose constructor mixes injected and plain arguments** is refused by §3.2's
  gap-throw, which may surprise someone porting Nest code that relies on type inference for some
  arguments. Mitigation: the throw names the class and the undecorated index, and the README section
  from §3.8 states the rule up front.
- **`realtime` on Bun and Node needs a real listening server** for WebSocket upgrades
  (`packages/websocket-plugin/README.md` runtime table). Mitigation: documented in the arm's JSDoc;
  not gated, because the plugin degrades to `available: false` rather than throwing, and the same
  application code is correct on Deno and Workers.
- **C6 cannot be verified from this workspace.** Mitigation: deferred in §9 rather than planned
  blind, so no section of this plan rests on a reference nobody here can read.

## 9. Out of scope

- **Config-key indirection** (`urlFromConfig` / `secretFromConfig` / `endpointFromConfig`),
  inherited as M36b scope from M36 §9 — **deferred to M36c**. The starters construct plugin
  instances inside `buildRestPlugins()`, which runs before `app.start()`, while `IConfig` only
  exists once `ConfigPlugin` has registered. Closing that gap means deferring plugin construction
  into registration time, which is a kernel question about whether a plugin may contribute another
  plugin mid-startup. That question is unanswered here, and bundling an unresolved seam into a plan
  whose other four deliverables are fully specified is how a plan ships an improvised design.
- **The full-stack React Router app skeleton** adapted from the B2BAdmin
  `feature → service → lib →
  model` layering, with its cross-cutting `lib/` rewired onto the
  plugins through the M44 `loadContext` bridge (M36 C6, M44 §9) — **deferred to M36c**, now on scope
  alone: **M48 closed the session/CSRF half of this deferral** (PR #105) by shipping
  `packages/session-plugin` with a `SESSION` capability, encrypted cookie sessions, and the
  synchronizer-token `csrfFormMiddleware` that a progressive-enhancement `<Form>` post needs — so
  seven of the eight B2BAdmin cross-cutting concerns now have a plugin target and M36c inherits a
  scope question, not a capability gap. The paragraph below is kept as the record of what M48 was
  scoped from; read it as history, not as current state. The reference is available at
  `/home/dkpaul91/Projects/B2BAdmin` (React Router v7 framework mode, 240 tracked files), so this is
  no longer blocked on verifiability; it is deferred on scope and on one two unresolved
  capabilities. Six of its eight cross-cutting concerns delegate to shipped plugins:
  `app/lib/sse.server.ts` to `sse-plugin`, `app/lib/kv.server.ts` to `secrets-plugin`'s Azure
  provider, `app/lib/http/xior.server.ts` to `@hono-enterprise/sdk`,
  `app/lib/appinsights-bootstrap.server.ts` and `app/lib/service-logger.server.ts` to
  `telemetry-plugin` and `logger-plugin`, `app/lib/route-guards.server.ts` to `auth-plugin`'s guard
  factories, and `app/config/services.server.ts` to the M44 `loadContext` bridge. **The other two
  have no target, and they are related.** (a) This framework has no session capability:
  `packages/common/src/tokens.ts` declares no `SESSION` token and `packages/auth-plugin/src`
  contains no session or cookie surface, while `app/lib/session.server.ts` is the largest of these
  files at 140 lines (with `cookie-attrs.server.ts`, `country-session.ts`, and
  `microsoft-oauth-state.server.ts` beside it). (b) `app/lib/csrf.server.ts` is a **signed
  double-submit cookie** — an HMAC-SHA256 token in a cookie, compared timing-safely against a hidden
  form field, signed with the session secret — whereas
  `packages/http-security-plugin/src/middleware/csrf-middleware.ts:1-5` is stateless Origin/Referer
  validation plus an optional custom header, and states "No cookies or server-side token store".
  Those are different strategies rather than one feature configured two ways: a
  progressive-enhancement `<Form>` post carries no custom header, so they are not interchangeable
  for a server-rendered app. M36c must decide whether both stay app concerns inside the skeleton, or
  become capabilities — and the second answer is its own milestone, not a line item.
- **Committed example applications** under `apps/*` — Milestone 37 (C3). The runnable showcase here
  is the project `honoe new --template nest` produces.
- **A `honoe new --starter` path** consuming the starter libraries — still deferred (M36 §9, C2).
  This milestone's template emits inline wiring.
- **Type-inferred constructor injection** (`constructor(private db: DbService)` with no token) —
  permanently unavailable, not deferred: it requires `emitDecoratorMetadata`, which Deno does not
  support (§1).
- **The M34b `errorHandler` priority defect** — a defect in already-merged `main`, so it belongs on
  `fix/cli-error-handler-priority`, never on this branch (M36 §9).
- **Multi-instance arms** (a second cache, a named queue) — M36 §3.2.1, unchanged.
