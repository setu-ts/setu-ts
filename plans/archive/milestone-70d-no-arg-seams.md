# Milestone 70d — Seams that construct with no arguments (`common`, `health-plugin`, `cqrs-plugin`, `events-plugin`, `di-plugin`, `cli`)

> **Status:** Planning. Branch: `feat/m70d-no-arg-seams`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

A generated artifact cannot receive a dependency. A CLI-owned barrel constructs each one with
literally no arguments — `new PlaceOrderCommandHandler()`, `new WidgetHealthIndicator()` — and the
contract it satisfies hands it nothing at dispatch time, so a generated command handler has no route
to the event bus, a generated event handler none to the broker or the queue, and a generated health
indicator no route to the database it exists to probe. The register calls this its **single most
repeated defect** (D4, X2-2, E3), and records that every affected exercise had to invent the same
workaround: a module-level holder populated during a generated plugin's `register()`, imported by
every handler. That workaround does not even survive — editing the barrel to pass a dependency and
then running an unrelated `setu generate query-handler` erased it, because the barrel is `managed`.
This milestone adds a **factory arm** to the four affected registration surfaces, moves the factory
into the developer-owned artifact module so an edit survives regeneration, and closes E3 (a
class-based project's DI container cannot see any framework capability) and E5 (a documented request
scope that nothing creates).

- **In scope:** the register's rows **D4**, **X2-2**, **E3** and **E5**. A `RegistryFactory<T>` type
  and one `resolveRegistryEntry` resolver in `common`; the factory arm on
  `CqrsPluginOptions.commandHandlers`/`queryHandlers`/`behaviors`, `EventsPluginOptions.handlers`
  and `HealthPluginOptions.indicators`; factory invocation moved to the `onInit` phase so every
  capability exists; the four CLI schematics emitting an exported factory and their three seam
  barrels naming it instead of calling `new`; `DiPlugin({ autoRegister: true })` in the
  `class-based` template; the `ServiceScope` documentation correction; `apps/cqrs` converted to the
  new arm as the in-repo non-test consumer.
- **NOT this milestone:** the default branch of injectable seams (M70e); error format and error
  visibility, including a raw `Error` serializing to `{}` in log metadata — X2-5, which is the
  reason a generated handler's failure is invisible (M70f); routing collisions and the seam scanner
  adopting hand-written files (M70g); the remaining CLI scaffold rows (M70h, merged); `guard`, `job`
  and `migration` gaining registration sites at all (still deliberately unwired —
  `packages/cli/src/seams/registry.ts:11-35`); a request scope actually being created per request,
  which is a kernel pipeline change and a `common` widening (named in §9, unowned).

## 1. Contracts verified from SOURCE (not names)

| Reference                           | Source (file:line)                                                                                                       | Verified surface / fact                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ServiceFactory<T>`                 | `packages/common/src/registry.ts:35`                                                                                     | **The name is already taken**, and it means something else: `() => T`, the no-argument lazy factory `registerFactory` invokes on first lookup. A second type spelled the same way is impossible; a near-name differing only in arity would be a trap. Hence `RegistryFactory<T>`.                                                                    |
| `IServiceRegistry`                  | `packages/common/src/registry.ts:55-123`                                                                                 | `register`, `registerFactory`, `get<T>(token)` (throws when absent), `getAll<T>`, `has(token)`, `unregister`. Everything a generated artifact could want — runtime, logger, config, container — is reachable through `get`/`has` under a `CAPABILITIES` token, so a factory needs no wider argument than this.                                       |
| `ICommandHandler` / `IQueryHandler` | `packages/common/src/services/cqrs.ts:49-57`, `66-74`                                                                    | `handle(command)` / `handle(query)` — **one parameter, the message.** No context, no services. Confirms X2-2's mechanism rather than inferring it.                                                                                                                                                                                                   |
| `IEventHandler<T>`                  | `packages/events-plugin/src/handlers/event-handler.ts:14-16`                                                             | `handle(event)` only — and it lives **in the plugin, not in `common`** (`common/src/services/events.ts:39` declares the _function_ form `EventHandler<T>`). So the events factory type is consumed in `events-plugin` and cannot be declared beside `IEventHandler` in `common`.                                                                     |
| `IHealthIndicator`                  | `packages/common/src/services/health.ts:44-53`                                                                           | `readonly name: string` plus `check(): Promise<HealthCheckResult>` — **`check` takes no argument**, which is the other half of D4: even a constructed indicator gets nothing at probe time.                                                                                                                                                          |
| `HealthPluginOptions.indicators`    | `packages/health-plugin/src/interfaces/index.ts:55`                                                                      | `readonly IHealthIndicator[]` — instances only.                                                                                                                                                                                                                                                                                                      |
| `HealthPlugin` registration         | `packages/health-plugin/src/plugin/health-plugin.ts:62`, `74-80`, `86-95`                                                | `priority: 100` (`PLUGIN_PRIORITY.HIGH`); app-supplied indicators are registered inside `register()`; a drain of `CAPABILITIES.HEALTH_INDICATOR` contributions **already runs in an `onInit` hook**. The deferred phase this milestone needs is therefore an existing pattern in this exact file, not a new mechanism.                               |
| `HealthService.registerIndicator`   | `packages/health-plugin/src/services/health-service.ts:57-61`                                                            | **Throws on a duplicate name.** So the relative order of instance entries, factory entries and plugin contributions decides which registration is reported as the duplicate.                                                                                                                                                                         |
| `CqrsPluginOptions`                 | `packages/cqrs-plugin/src/interfaces/index.ts:23-28`, `38-43`, `63`, `71`, `81`                                          | `commandHandlers`/`queryHandlers` are `{ type, handler }` pairs typed at the interface defaults (method-syntax bivariance is what keeps the list heterogeneous without `any` — preserved by this change); `behaviors?: readonly IPipelineBehavior[]` is the **third** instance list in the same options object.                                      |
| `CqrsPlugin` registration           | `packages/cqrs-plugin/src/plugin/cqrs-plugin.ts:55`, `60-71`                                                             | `priority: PLUGIN_PRIORITY.NORMAL`; buses are constructed with `opts.behaviors` and handlers registered inside `register()`.                                                                                                                                                                                                                         |
| `RequestBus`                        | `packages/cqrs-plugin/src/bus/request-bus.ts:32`, `41`, `69-73`                                                          | `behaviors` is a constructor-held `readonly` field, and `composePipeline` runs **per `execute`** — so a behaviour list replaced after construction takes effect on the next execution with no re-composition step. Also: `registerHandler` is `Map.set`, so a duplicate type **silently overwrites** (pre-existing; §9).                             |
| `EventsPluginOptions.handlers`      | `packages/events-plugin/src/interfaces/index.ts:23-28`, `53`                                                             | `readonly EventHandlerRegistration[]`, `{ type, handler }`.                                                                                                                                                                                                                                                                                          |
| `EventsPlugin` registration         | `packages/events-plugin/src/plugin/events-plugin.ts:52`, `87-88`                                                         | `register()` is already `async`; each entry is subscribed through the exported `subscribeHandler`, so one implementation backs the option and the manual route.                                                                                                                                                                                      |
| `PLUGIN_PRIORITY`                   | `packages/common/src/types.ts:80-92`                                                                                     | `HIGH: 100`, `NORMAL: 500`. `HealthPlugin` at 100 registers **before** `DatabasePlugin` and every other ordinary capability plugin — which is precisely why a health-indicator factory cannot run inside `register()`. D4's own example is a database indicator.                                                                                     |
| Kernel start sequence               | `packages/kernel/src/application/application.ts:298-305`, `311`                                                          | Every plugin's `register()` (and its `onRegister` hooks) completes in the resolved order, and only then does `runInit()` run. So an `onInit` hook is the first phase at which the registry holds every capability, regardless of priority.                                                                                                           |
| `IPluginContext`                    | `packages/common/src/plugin.ts:477-516`                                                                                  | One shared object per application, carrying `router`, `middleware`, `cli`, `environment`, `health`, `metrics`, and `options` — the _plugin's own_ options.                                                                                                                                                                                           |
| Registration cursor                 | `packages/kernel/src/application/application.ts:174-178`, `184-230`                                                      | `#registeringPlugin` is `undefined` outside the registration loop, and `ctx.health`/`ctx.metrics`/`ctx.environment` write into the registry through it. `environment.validate` called from an `onInit` hook is also **past** the env validation step (`:308`). These are the footguns that rule `IPluginContext` out as the factory argument (§3.1). |
| `IRequestContext.services`          | `packages/common/src/http.ts:224`                                                                                        | Route handlers and controller methods **already** reach every capability per request. This is why the `route`, `controller`, `middleware` and `plugin` families are not affected and are not touched here — the defect is specific to the four contracts whose only parameter is the message, or nothing.                                            |
| `SeamSpec.importSymbols`            | `packages/cli/src/seams/seam-spec.ts:40-63`                                                                              | Read by **two** callers deliberately: `renderBarrel` names these symbols in the import it emits, and `readArtifactNames` requires the file to export every one of them. Splitting those two was the M60 defect.                                                                                                                                      |
| `exportsSymbol`                     | `packages/cli/src/seams/seam-spec.ts:255-273`                                                                            | Recognizes `export function X` and `export { X }`; an `export *` re-export reads as ABSENT, and that direction is deliberate — a false negative skips and reports, a false positive would emit an unresolvable import.                                                                                                                               |
| `readArtifactNames`                 | `packages/cli/src/utils/artifact-scanner.ts:115-125`                                                                     | A candidate missing any `importSymbols` entry is pushed to `skipped` with the missing names and **returned**, never silently dropped.                                                                                                                                                                                                                |
| The skip report                     | `packages/cli/src/commands/generate.ts:250-269`                                                                          | Already prints the two routes out — rename the export, or delete the file and re-run the schematic — and deliberately no longer says "regenerate it" (the M65 loop). The migration path this milestone needs already exists and is already non-looping.                                                                                              |
| The `new X()` call sites            | `packages/cli/src/seams/health.ts:87`, `packages/cli/src/seams/cqrs.ts:94`, `98`, `packages/cli/src/seams/events.ts:192` | The four places the barrel constructs with no arguments. `health.ts:81-84`'s own comment states the option wants "Instances, not constructors".                                                                                                                                                                                                      |
| `withPluginOptionSeams`             | `packages/cli/src/templates/seam.ts:172-198`                                                                             | `HealthPlugin({ indicators: [...HEALTH_INDICATORS] })`, `CqrsPlugin({ commandHandlers: …, queryHandlers: … })`, `EventsPlugin({ handlers: … })`. The barrel's exported element type therefore has to satisfy each option after a spread.                                                                                                             |
| `Wiring.args`                       | `packages/cli/src/templates/registry.ts:22-57`                                                                           | A verbatim argument-list string; omitted means a no-argument call. Present since M36b, so E3 needs no template-contract widening.                                                                                                                                                                                                                    |
| `DI_WIRING`                         | `packages/cli/src/templates/di.ts:12-18`                                                                                 | `{ pkg: 'di-plugin', symbol: 'DiPlugin' }` with no `args`, and a JSDoc asserting that none is needed. That assertion is what E3 falsifies.                                                                                                                                                                                                           |
| `DiPlugin`                          | `packages/di-plugin/src/plugin/di-plugin.ts:68`, `79-86`                                                                 | `autoRegister` defaults to **`false`**, and the external resolver that reaches the kernel registry is **only installed when it is true**.                                                                                                                                                                                                            |
| `DiContainer` fallback              | `packages/di-plugin/src/container/container.ts:174`                                                                      | The registry fallback is gated on `#autoRegister` as well, so both halves confirm E3: with the template's bare `DiPlugin()`, `@Inject(CAPABILITIES.X)` can never resolve.                                                                                                                                                                            |
| `ServiceScope`                      | `packages/common/src/container.ts:19-27`                                                                                 | JSDoc: "`scoped` — one instance per request scope". E5 measured that **nothing in the request pipeline creates a scope**, so this documents behaviour the framework does not have.                                                                                                                                                                   |
| `seam-probe.test.ts`                | `packages/cli/test/e2e/seam-probe.test.ts:66-172`                                                                        | Already scaffolds, generates, boots and drives generated command, query and event handlers through the real buses, and reads `/health` for indicator names. The functional bar for this milestone extends this file rather than adding a parallel harness.                                                                                           |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                                                                               | Resolution (picked side)                                                                                                                                                            | Doc deliverable (same PR)                                                                                                                                                                                                                                                                                                                      |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `common/src/container.ts:22` documents `scoped` as "one instance per request scope"; E5 measured that two HTTP requests construct **zero** scoped services because nothing in the pipeline creates a scope. The di-plugin README (`:6`, `:33`, `:41`) and `PUBLIC_API.md:7728-7734` repeat the claim.                                                                                                                  | The code is right and the documentation is wrong. `scoped` means "one instance per `container.createScope()`", which is real and tested; it does **not** mean per request.          | Correct the `ServiceScope` JSDoc, the di-plugin README lifecycle section, and the `PUBLIC_API.md` di-plugin scope bullets to say `createScope()` explicitly and to state that the framework creates no scope per request. Cross-reference `apps/di-decorators`, which already demonstrates the manual call.                                    |
| C2 | `templates/di.ts:15-16` states that `DiPlugin`'s options are optional "so no `args` string is needed and the emitted call is a bare `DiPlugin()`". E3 shows that bare call makes every `@Inject(CAPABILITIES.X)` throw at startup.                                                                                                                                                                                     | The claim about the type is true and the conclusion is wrong: optional options are not a reason to omit them when the default disables the container's only route to the framework. | Rewrite that JSDoc to name E3 and state why `autoRegister: true` is emitted, and add the `class-based` template's own note.                                                                                                                                                                                                                    |
| C3 | `PUBLIC_API.md` CQRS (`:2841`), EventsPlugin (`:1723`) and Health (`:4605`) option tables document `handler`/`indicators` as instances, and the plugin JSDoc examples show `new X()`.                                                                                                                                                                                                                                  | Both arms are supported; the instance arm keeps working byte-identically. The documentation must show the factory arm and, critically, **when** it runs.                            | Update all three option tables and the three plugin JSDoc `@example` blocks; add the `onInit` timing note and the "resolve nothing during `register()`" rule. Add a `common` row for `RegistryFactory` and `resolveRegistryEntry`.                                                                                                             |
| C4 | The four schematics' emitted JSDoc says the artifact "needs no further wiring" (e.g. `schematics/command-handler.ts:48-50`) — true, but it describes a barrel that constructs the class, which is exactly what is changing. `seams/health.ts:81-84` and `seams/registry.ts` describe the entry shapes.                                                                                                                 | Keep the "no further wiring" promise (it stays true) and add the factory to the description, so the emitted comment matches the emitted barrel.                                     | Update the emitted JSDoc in all four schematics, plus the module JSDoc of `seams/health.ts`, `seams/cqrs.ts` and `seams/events.ts`. Each emitted factory carries a one-line worked example of taking `services`.                                                                                                                               |
| C5 | `ROADMAP.md:6937` describes the fix as "a factory arm on the registration types, which is non-breaking", and the "Scope realities" bullet (`:6890`) lists D4 among the `common` **widenings**. Both are true but incomplete: the _contract_ change is non-breaking, while the CLI's **generated output shape** changes, and a pre-existing generated artifact stops being registered until its author adds one export. | State both halves. The contract addition is non-breaking; the generated-output change is a behaviour change to already-published generated output, with a named migration.          | Flip the M70d row to `✅` with its PR number and the Progress-Tracking row (`ROADMAP.md:7144`); amend the row body to record the `behaviors` addition (§3.11) and the generated-output migration. Update the local `smoke/DEFECTS.md` Status column for D4, X2-2, E3 and E5 — **uncommitted**, since `smoke/` is excluded from the repository. |

## 3. Design decisions

### 3.1 What a factory receives

- **Decision:** `IServiceRegistry`, named `services` at every call site. Nothing else — not
  `IPluginContext`, and not a new narrow context type.
- **Why:** it is the smallest argument that closes every row, it declares no new surface, and it has
  no footguns. Everything a generated artifact could want is reachable through it under a
  `CAPABILITIES` token (`registry.ts:96-113`): the runtime, the logger, the config, the DI
  container. `IPluginContext` was rejected on evidence rather than taste: it is **one shared
  object** (`plugin.ts:477`), so handing it to application code hands over `router`, `middleware`,
  `cli` and the _plugin's own_ `options`, and three of its members misbehave in the phase a factory
  runs in — `ctx.health.register` and `ctx.metrics.register` attribute to `#registeringPlugin`,
  which is `undefined` outside the registration loop, and `ctx.environment.validate` runs **after**
  the kernel has already validated the environment (`application.ts:174-178`, `:308`). A
  purpose-built narrow context (`{ services, runtime, logger? }`) was rejected because every field
  except `services` is reachable _through_ `services`, so the extra fields would ship with no
  in-repo reader — dead surface by the standing rule.
- **Test home:** `common/test/unit/registry-factory.test.ts` (the resolver's contract) plus the
  three plugins' integration suites, each of which resolves a real capability out of the argument.

### 3.2 Where the factory type lives, and what it is called

- **Decision:** one generic in `common`: `RegistryFactory<T> = (services: IServiceRegistry) => T`,
  exported from the barrel. The three plugins use it directly; none declares a per-family alias
  except health (§3.6).
- **Why:** three one-line copies in three packages is the shape §11.1 exists to prevent, and a
  fourth family would add a fourth copy. One definition also means the _contract_ — what the
  argument is, and when the factory is called — is documented in exactly one place. The name is
  `RegistryFactory` and deliberately not `ServiceFactory`: that name is taken by `registry.ts:35`'s
  no-argument lazy factory, and two exported types differing only in arity is a trap. Both JSDoc
  blocks cross-reference the other so the distinction is stated at both ends.
- **Test home:** `common/test/unit/registry-factory.test.ts`; the barrel-export assertion in
  `common/test/unit/barrel-exports.test.ts`.

### 3.3 One resolver, in `common`

- **Decision:** `common` also exports
  `resolveRegistryEntry<T>(entry: T | RegistryFactory<T>, services: IServiceRegistry, label: string): T`.
  It returns a non-function entry unchanged, calls a function entry with `services`, and wraps a
  throw from the factory in an `Error` whose message names `label` and whose `cause` is the
  original.
- **Why:** the discrimination and the error attribution would otherwise be copied into three plugins
  and drift. Attribution is the load-bearing part: without it a factory that resolves a capability
  the application forgot to register fails `start()` with a bare
  `No service registered for capability 'database'` and nothing saying which option, which entry, or
  that a factory produced it.
- **Test home:** `common/test/unit/registry-factory.test.ts`.

### 3.4 Discrimination is `typeof entry === 'function'`

- **Decision:** a function entry is a factory; anything else is the instance.
- **Why:** no instance of any of the four contracts is callable — `IHealthIndicator` is an object
  with `name` and `check`, and a handler is an object with `handle`. The one shape that is both a
  function and not a factory is a **class**, and a class is not assignable to `RegistryFactory<T>`
  (a `new () => T` is not callable without `new`), so passing `WidgetHealthIndicator` instead of an
  instance is a compile error rather than a runtime `TypeError`. A test pins that with
  `@ts-expect-error`.
- **Test home:** `common/test/unit/registry-factory.test.ts` (including the `@ts-expect-error`
  case).

### 3.5 Factories run in an `onInit` hook, in every one of the three plugins

- **Decision:** instance entries keep registering inside `register()`, exactly as today. Factory
  entries are resolved and registered from an `onInit` hook the plugin adds during `register()`.
- **Why:** `HealthPlugin` has `priority: 100` and `DatabasePlugin` has 500, so a health-indicator
  factory invoked inside `register()` would run **before** the capability it exists to probe — and
  D4's own example is a database indicator. Handlers at `NORMAL` share a priority band with the
  capabilities they consume, where order is registration order, so the same fragility applies. The
  kernel completes every `register()` before `runInit()` (`application.ts:298-311`), which makes
  `onInit` the first phase at which the answer is order-independent. It is also not a new mechanism:
  `HealthPlugin` already drains contributions there (`health-plugin.ts:86-95`). Keeping instances at
  `register()` makes an existing configuration byte-identical, which is the whole basis of the
  non-breaking claim.
- **Test home:** `health-plugin/test/integration/indicator-factories.test.ts`,
  `cqrs-plugin/test/integration/handler-factories.test.ts`,
  `events-plugin/test/integration/handler-factories.test.ts` — each registering its plugin
  **before** a provider plugin and asserting the factory still resolves it (the assertion that fails
  if a later change moves resolution back into `register()`).

### 3.6 The health option, and the order factories register in

- **Decision:** `health-plugin` exports
  `HealthIndicatorEntry = IHealthIndicator | RegistryFactory<IHealthIndicator>` and
  `HealthPluginOptions.indicators` becomes `readonly HealthIndicatorEntry[]`. Factory-produced
  indicators are registered at the **start** of the existing `onInit` hook, before the
  `CAPABILITIES.HEALTH_INDICATOR` contribution drain.
- **Why:** the alias exists because the CLI barrel has to _name_ the element type in a generated
  `readonly …[]` declaration, and spelling the union inline there needs parentheses the renderer
  does not add — so the alias has two real readers (the option and the generated barrel) and is not
  dead surface. The alias lives in `health-plugin` rather than `common` because the option it types
  lives there and no other package reads it. Ordering matters because `registerIndicator` throws on
  a duplicate name (`health-service.ts:57-61`): registering factories before the drain keeps the
  existing invariant that application-supplied indicators precede plugin contributions, so which
  side of a name collision is reported does not change.
- **Test home:** `health-plugin/test/unit/health-plugin-factories.test.ts` (both arms, ordering, and
  the duplicate-name message naming the application entry).

### 3.7 A factory that throws fails `start()`

- **Decision:** the wrapped error propagates. Nothing is caught and skipped.
- **Why:** skipping would leave the artifact silently unregistered, which is the exact failure this
  milestone exists to end (and the A2 class M70h fixed for health). A loud boot failure naming the
  option and the entry is the only honest outcome. No new exported error class: an `Error` with a
  `cause` carries everything, and an exported class would ship with no in-repo `instanceof` reader.
- **Test home:** `common/test/unit/registry-factory.test.ts` for the message and the `cause`, plus
  one per-plugin assertion that `app.start()` rejects.

### 3.8 The factory lives in the developer-owned artifact module, never in the managed barrel

- **Decision:** each of the four schematics emits an additional exported factory **in the artifact
  file**, and the barrel imports and references it. `SeamSpec.importSymbols` gains that symbol.
- **Why:** this is the whole design, and X2-2 states the reason: the barrel is `managed`, so a
  dependency wired into it is erased by the next unrelated `setu generate`. A CLI-owned barrel also
  _cannot_ know the constructor's shape — the first thing a developer does is change it — so any
  `new X(…)` the barrel writes is a guess that goes stale. The artifact file is the developer's, is
  never rewritten, and is where the constructor is visible. Passing the context into `handle()`
  instead was rejected: adding a parameter to `ICommandHandler.handle` is breaking for every
  implementor, while a union arm is breaking for none.
- **Test home:** `cli/test/unit/seams/*.test.ts` for the emitted shape;
  `cli/test/e2e/seam-probe.test.ts` for the survival property (edit the factory, generate an
  unrelated artifact, boot, and observe the dependency still arriving).

### 3.9 The emitted factory is a zero-parameter exported `function` with a written-out return type

- **Decision:** for example
  `export function createPlaceOrderCommandHandler(): PlaceOrderCommandHandler { return new PlaceOrderCommandHandler(); }`,
  with JSDoc showing the one-line edit that takes `services`.
- **Why:** three constraints decide this shape and each has bitten before. A parameter the emitted
  body does not use fails the generated project's own `deno lint` — M63's D6 class, a fresh scaffold
  failing a gate on files the CLI wrote — and a zero-parameter function is still assignable to
  `RegistryFactory<T>`. A written-out return type is required because an inferred one is a JSR slow
  type, which is the M51 defect that only `publish:check` sees. And a plain `function` declaration
  is what `exportsSymbol` recognizes (`seam-spec.ts:256-260`), needs no `RegistryFactory` import in
  the artifact, and keeps the concrete class as the return type so the developer's own callers stay
  typed.
- **Test home:** the four `cli/test/unit/schematics/*.test.ts` files, plus the scaffold-boot e2e's
  `deno check` and `deno lint` of the generated project.

### 3.10 The barrel writes no `new` anywhere

- **Decision:** barrel entries become bare references —
  `{ type: WIDGET_COMMAND, handler: createWidgetCommandHandler }`, and `createWidgetIndicator` in
  the health array. `importSymbols` for the CQRS families becomes
  `[<SCREAMING>_COMMAND, create<Pascal>CommandHandler]`: the class is no longer imported by the
  barrel, so an artifact whose author replaced the class with a plain object returned from the
  factory stays admissible.
- **Why:** the milestone's title, literally. It also removes the second construction site: with the
  factory owning construction, there is exactly one place a handler is built.
- **Test home:** `cli/test/unit/seams/cqrs.test.ts`, `events.test.ts`, `health.test.ts` — each
  asserting the rendered barrel contains no `new`.

### 3.11 `CqrsPluginOptions.behaviors` gets the same arm — a deliberate addition to the register's row set

- **Decision:** `behaviors` becomes
  `readonly (IPipelineBehavior | RegistryFactory<IPipelineBehavior>)[]`. At `onInit` the plugin
  resolves the **whole** list in declared order and replaces the buses' behaviour list through a new
  internal `RequestBus.setBehaviors`.
- **Why:** it is the same defect in the same options object — a behaviour that wants to log through
  the logger capability has no route to it, and application code has no phase in which to build one.
  Shipping a milestone titled "seams that construct with no arguments" while leaving one such seam
  untouched in a file it edits is the incomplete-thesis pattern this repository keeps re-finding.
  The whole list is resolved rather than the factories appended, because behaviours run in declared
  order and appending would silently reorder a mixed list. `composePipeline` runs per `execute`
  (`request-bus.ts:69`), so replacing the field is enough — there is nothing to re-compose. This is
  a widening of the register's named rows, recorded here so a reviewer sees it as deliberate.
- **Test home:** `cqrs-plugin/test/unit/behavior-factories.test.ts` — a mixed list, asserting the
  execution order is the **declared** order and not instances-then-factories.

### 3.12 Pre-existing generated artifacts: skip, report, migrate

- **Decision:** rely on the existing scanner behaviour. An artifact generated before this milestone
  does not export the factory, so `readArtifactNames` rejects it (`artifact-scanner.ts:115-121`) and
  `generate` prints the two routes out that are already committed (`generate.ts:255-269`). No new
  mechanism, and the report is already non-looping. A CHANGELOG entry carries the migration text.
- **Why:** the alternative — detecting per artifact whether a factory is exported and emitting the
  old `new X()` shape when it is not — was rejected on the direction of its failure. It would keep
  every existing project byte-identical, but a false negative from `exportsSymbol` (which reads
  source text, and reads an `export *` re-export as absent by design) would then **silently ignore a
  factory the developer wrote** and construct the class instead. A reported skip is loud; a silently
  ignored dependency is the defect class this milestone is closing. It also needs `SeamArtifacts` to
  carry per-artifact capability data, which would put a second admission rule beside `importSymbols`
  — the split that caused the M60 defect.
- **Test home:** `cli/test/unit/utils/artifact-scanner.test.ts` (an old-shape artifact is skipped
  with the factory named) and `cli/test/unit/commands/generate-seam-command.test.ts` (the report
  reaches `deps.error` and the barrel omits it).

### 3.13 E3 — the `class-based` template emits `DiPlugin({ autoRegister: true })`

- **Decision:** `DI_WIRING` gains `args: '{ autoRegister: true }'`.
- **Why:** `autoRegister` defaults to `false` and both the external resolver and the container's
  registry fallback are gated on it (`di-plugin.ts:79-86`, `container.ts:174`), so the template's
  bare `DiPlugin()` makes every `@Inject(CAPABILITIES.X)` throw at startup — the entire plugin
  ecosystem unreachable from a service. The template's own showcase cannot surface it: its service
  has no dependencies and its controller injects an explicit provider. A DI container that cannot
  see the framework's own services is not a useful default.
- **Test home:** `cli/test/unit/templates.test.ts` (the emitted `args`) and
  `cli/test/e2e/seam-probe.test.ts` — a generated `@Injectable` edited to inject
  `CAPABILITIES.CONFIG`, resolved through the container in a booted project.

### 3.14 E5 — documentation only, and the JSDoc is the load-bearing site

- **Decision:** correct the three sites in C1. No code change; `scope: 'scoped'` keeps behaving
  exactly as it does.
- **Why:** the register classes E5 as documented behaviour whose _word_ carries an expectation the
  framework does not meet. Creating a request scope per request is a kernel pipeline change plus a
  `common` widening and belongs to a milestone that owns it (§9). Correcting the claim is what stops
  a developer marking a service `scoped` for per-request isolation and getting none.
- **Test home:** none in code; verified by the M38 docs gate (`deno task check:docs`) and by review
  against `apps/di-decorators`, which already demonstrates the manual `createScope()`.

### 3.15 `apps/cqrs` becomes the in-repo, non-test consumer

- **Decision:** convert `apps/cqrs/src/app.ts` from its post-start imperative `wire()` shim to
  `CqrsPlugin({ commandHandlers, queryHandlers })` where at least one entry is a factory that
  resolves a capability, and extend its `smoke` task to observe the dependency arriving.
- **Why:** the standing rule is that a deliverable is demonstrated through the public surface, and
  the register's own thesis is that this seam was closed. `apps/cqrs` currently has the workaround
  shape (`app.ts:19-31`) — a `wired` boolean and a lazy `wire()` call — which is the same "invent a
  holder" pattern the register describes. Converting it deletes the workaround, gives the new arm a
  consumer that is neither a test nor generated output, and is run by `deno task check:apps`. This
  adds `apps/` to the register's package list, recorded here as deliberate.
- **Test home:** `apps/cqrs`'s own `smoke` task, run by `scripts/check-apps.ts`.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                                                                                             | Kind      | Consumer / real code path that READS it                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RegistryFactory<T>` (`common`)                                                                                             | type      | `CqrsPluginOptions.commandHandlers`/`queryHandlers`/`behaviors`, `EventsPluginOptions.handlers`, `HealthIndicatorEntry`, and `resolveRegistryEntry`'s own signature.                                                                                       |
| `resolveRegistryEntry` (`common`)                                                                                           | function  | Called by `cqrs-plugin/src/plugin/cqrs-plugin.ts`, `events-plugin/src/plugin/events-plugin.ts` and `health-plugin/src/plugin/health-plugin.ts` — three real readers, which is why it lives in `common` rather than being copied.                           |
| `HealthIndicatorEntry` (`health-plugin`)                                                                                    | type      | `HealthPluginOptions.indicators`, and the element type the CLI's generated `src/health/index.ts` declares.                                                                                                                                                 |
| `CommandHandlerRegistration`, `QueryHandlerRegistration` (`cqrs-plugin`)                                                    | interface | Already exported; the `handler` field widens. Read by the generated `src/cqrs/index.ts` and by application config.                                                                                                                                         |
| `EventHandlerRegistration` (`events-plugin`)                                                                                | interface | Already exported; the `handler` field widens. Read by the generated `src/events/index.ts`.                                                                                                                                                                 |
| `RequestBus.setBehaviors`                                                                                                   | method    | INTERNAL — `RequestBus` is not barrel-exported (`request-bus.ts:3`). Read by `CqrsPlugin`'s `onInit` hook only.                                                                                                                                            |
| CLI seam symbols (`indicatorClassFactorySymbol`, `indicatorValueFactorySymbol`, and the CQRS/events factory-symbol helpers) | functions | Internal to `packages/cli/src`; read by their seam's `importSymbols` **and** by their schematic's renderer — the one-owner rule from `SeamSpec.importSymbols`. `packages/cli/src/index.ts` is unchanged, pinned by `cli/test/unit/barrel-exports.test.ts`. |

### 4.1 Options — every option names its consumer

| Option                                                                 | Consumer                                    | Behavior (per implementation)                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HealthPluginOptions.indicators` (widened)                             | `HealthPlugin.register` + its `onInit` hook | An instance entry is registered during `register()`, unchanged. A factory entry is called at `onInit` with the registry and its result registered before the contribution drain. A duplicate name still throws, naming the indicator.                |
| `CqrsPluginOptions.commandHandlers` / `queryHandlers` (widened)        | `CqrsPlugin.register` + its `onInit` hook   | Instances register on the bus during `register()`. Factories are called at `onInit`; the result is registered under the entry's `type`.                                                                                                              |
| `CqrsPluginOptions.behaviors` (widened, §3.11)                         | `CqrsPlugin.register` + its `onInit` hook   | Instances are passed to both bus constructors as today. At `onInit` the full list is resolved in declared order and installed through `RequestBus.setBehaviors`, so declared order is the execution order regardless of which entries are factories. |
| `EventsPluginOptions.handlers` (widened)                               | `EventsPlugin.register` + its `onInit` hook | Instances subscribe during `register()` through `subscribeHandler`. Factories are called at `onInit` and subscribe through the **same** `subscribeHandler`, so the option and the manual route cannot drift.                                         |
| `DiPluginOptions.autoRegister` (existing; the generated value changes) | `DiPlugin.register`                         | Unchanged in the plugin. The `class-based` template now emits `true`, so a scaffolded project's container falls back to the kernel registry and `@Inject(CAPABILITIES.X)` resolves.                                                                  |

## 5. Implementation files

| File                                                                                    | Purpose                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/registry.ts`                                                       | Add `RegistryFactory<T>` and `resolveRegistryEntry`, each JSDoc cross-referencing `ServiceFactory` so the arity difference is stated at both ends.                                                                     |
| `packages/common/src/container.ts`                                                      | C1: correct the `ServiceScope` JSDoc for `scoped`.                                                                                                                                                                     |
| `packages/common/src/index.ts`                                                          | Export both new symbols.                                                                                                                                                                                               |
| `packages/health-plugin/src/interfaces/index.ts`                                        | `HealthIndicatorEntry`; widen `indicators`.                                                                                                                                                                            |
| `packages/health-plugin/src/plugin/health-plugin.ts`                                    | Split instance and factory entries; resolve factories at the head of the existing `onInit` hook.                                                                                                                       |
| `packages/health-plugin/src/index.ts`                                                   | Export `HealthIndicatorEntry`.                                                                                                                                                                                         |
| `packages/cqrs-plugin/src/interfaces/index.ts`                                          | Widen `handler` on both registrations and widen `behaviors`.                                                                                                                                                           |
| `packages/cqrs-plugin/src/plugin/cqrs-plugin.ts`                                        | Register instance handlers as today; add an `onInit` hook resolving handler and behaviour factories.                                                                                                                   |
| `packages/cqrs-plugin/src/bus/request-bus.ts`                                           | Internal `setBehaviors`, replacing the `readonly` constructor field with a private mutable one.                                                                                                                        |
| `packages/events-plugin/src/interfaces/index.ts`                                        | Widen `handler`.                                                                                                                                                                                                       |
| `packages/events-plugin/src/plugin/events-plugin.ts`                                    | Add the `onInit` hook subscribing factory-produced handlers through `subscribeHandler`.                                                                                                                                |
| `packages/cli/src/seams/health.ts`                                                      | Factory symbols for both modes; barrel imports `HealthIndicatorEntry` from `@setu-ts/health-plugin` and references factories with no `new`.                                                                            |
| `packages/cli/src/seams/cqrs.ts`                                                        | Factory symbols; `importSymbols` swaps the class for the factory; entries become bare references.                                                                                                                      |
| `packages/cli/src/seams/events.ts`                                                      | Same, for the events family.                                                                                                                                                                                           |
| `packages/cli/src/schematics/health-indicator.ts`                                       | Emit the factory in both modes, with the worked-example JSDoc.                                                                                                                                                         |
| `packages/cli/src/schematics/command-handler.ts`                                        | Emit `create<Pascal>CommandHandler`.                                                                                                                                                                                   |
| `packages/cli/src/schematics/query-handler.ts`                                          | Emit `create<Pascal>QueryHandler`.                                                                                                                                                                                     |
| `packages/cli/src/schematics/event-handler.ts`                                          | Emit `create<Pascal>EventHandler`.                                                                                                                                                                                     |
| `packages/cli/src/templates/di.ts`                                                      | E3: `args: '{ autoRegister: true }'`, and the C2 JSDoc correction.                                                                                                                                                     |
| `apps/cqrs/src/app.ts`, `apps/cqrs/smoke.ts`                                            | §3.15: the workaround deleted, the factory arm consumed, the dependency observed.                                                                                                                                      |
| `CHANGELOG.md`                                                                          | Three entries: the factory arm (Added); the generated-output shape change with migration text (Changed, breaking for already-published generated output); the `class-based` template's `autoRegister` value (Changed). |
| `PUBLIC_API.md`, `ROADMAP.md`, `packages/di-plugin/README.md`, the three plugin READMEs | C1–C5.                                                                                                                                                                                                                 |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                     | src covered                                                        | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/registry-factory.test.ts`                                                          | `common/src/registry.ts`                                           | `resolveRegistryEntry(instance, services, label)` returns the same reference; `resolveRegistryEntry((services) => built, …)` calls it exactly once with the registry passed through by identity; a throwing factory produces an `Error` whose message contains `label` and whose `cause` is the original; and a `@ts-expect-error` case pins that a **class** is not assignable to `RegistryFactory<IHealthIndicator>` (§3.4). Calls type-check against `RegistryFactory<T> = (services: IServiceRegistry) => T`.                                                                                    |
| `packages/common/test/unit/barrel-exports.test.ts` (extend)                                                   | `common/src/index.ts`                                              | `RegistryFactory` and `resolveRegistryEntry` are exported. The M56 defect class: a re-export file is fully covered merely by being loaded, so only this assertion catches a dropped export.                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/health-plugin/test/unit/health-plugin-factories.test.ts`                                            | `health-plugin/src/plugin/health-plugin.ts`, `interfaces/index.ts` | Both arms register; a factory entry is **not** called during `register()` and is called during the `onInit` drain; factories precede contributions; a duplicate name throws naming the application entry; a throwing factory rejects `start()`. Calls type-check against `indicators?: readonly HealthIndicatorEntry[]`.                                                                                                                                                                                                                                                                             |
| `packages/health-plugin/test/integration/indicator-factories.test.ts`                                         | same                                                               | A real `createApplication` registering `HealthPlugin` **before** a provider plugin at `PLUGIN_PRIORITY.NORMAL`; the factory resolves that capability and `GET /health` reports the indicator with data taken from it. This is the test that fails if resolution moves back into `register()`.                                                                                                                                                                                                                                                                                                        |
| `packages/cqrs-plugin/test/unit/handler-factories.test.ts`                                                    | `cqrs-plugin/src/plugin/cqrs-plugin.ts`, `interfaces/index.ts`     | Instance and factory entries both reach the bus; a factory is called once, at `onInit`; the health indicator's `commands`/`queries` counts include factory-produced handlers.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/cqrs-plugin/test/unit/behavior-factories.test.ts`                                                   | `cqrs-plugin/src/bus/request-bus.ts`, `plugin/cqrs-plugin.ts`      | A mixed `behaviors` list of instances and factories executes in **declared** order (the assertion that fails if factories are appended); `setBehaviors` replaces rather than accumulates on a second `onInit`.                                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/cqrs-plugin/test/integration/handler-factories.test.ts`                                             | same                                                               | A kernel app where a command handler's factory resolves `CAPABILITIES.EVENTS` and the executed command publishes an event an independent subscriber observes — the exact X2-2 scenario ("a command handler has no route to the event bus"), driven through `commandBus.execute`.                                                                                                                                                                                                                                                                                                                     |
| `packages/events-plugin/test/unit/handler-factories.test.ts`                                                  | `events-plugin/src/plugin/events-plugin.ts`, `interfaces/index.ts` | Both arms subscribe through `subscribeHandler`; a factory is called at `onInit`; `subscriptionCount` in the health payload counts both.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/events-plugin/test/integration/handler-factories.test.ts`                                           | same                                                               | A kernel app where an event handler's factory resolves a capability registered by a later plugin, and a published event reaches it carrying that dependency's value.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/cli/test/unit/seams/health.test.ts`                                                                 | `cli/src/seams/health.ts`                                          | Both mode barrels reference the factory symbol, contain no `new`, declare `readonly HealthIndicatorEntry[]`, and import that type from `@setu-ts/health-plugin`; `importSymbols` returns the factory symbol; names stay sorted and the empty-family form is unchanged.                                                                                                                                                                                                                                                                                                                               |
| `packages/cli/test/unit/seams/cqrs.test.ts`                                                                   | `cli/src/seams/cqrs.ts`                                            | Entries are bare references; both kinds are listed whichever schematic renders; the import line stays inside `GENERATED_LINE_WIDTH` with three artifacts per kind (the X2-4 class).                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/cli/test/unit/seams/events.test.ts`                                                                 | `cli/src/seams/events.ts`                                          | As above for the events barrel.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/cli/test/unit/schematics/health-indicator.test.ts`                                                  | `cli/src/schematics/health-indicator.ts`                           | Both modes emit an exported factory with a written-out return type and **no parameter**; the JSDoc carries the `services` worked example; the class-mode file still exports its class.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/cli/test/unit/schematics/command-handler.test.ts`, `query-handler.test.ts`, `event-handler.test.ts` | the three schematics                                               | Each emits `export function create<Pascal>…(): <Pascal>…` and the barrel names it; the emitted module compiles against the widened registration type (pinned by the e2e's `deno check`).                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/cli/test/unit/utils/artifact-scanner.test.ts` (extend)                                              | `cli/src/utils/artifact-scanner.ts`                                | An OLD-shape artifact (class only, no factory) is skipped with the factory symbol reported in `missing`; a new-shape one is admitted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/cli/test/unit/commands/generate-seam-command.test.ts` (extend)                                      | `cli/src/commands/generate.ts`                                     | The skip reaches `deps.error` with both routes out, and the regenerated barrel omits the artifact — so an upgrading project is told, not silently unwired.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/cli/test/unit/templates.test.ts` (extend)                                                           | `cli/src/templates/di.ts`                                          | `class-based` emits `DiPlugin({ autoRegister: true })`; no other template gains `di-plugin`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/cli/test/e2e/seam-probe.test.ts` (extend)                                                           | the CLI end to end                                                 | **The functional bar.** On the microservice host: edit the generated command handler's factory to resolve `CAPABILITIES.EVENTS` and pass it into the constructor, then run an **unrelated** `setu generate query-handler` (the regression X2-2 records), then boot and assert the executed command published an event an independent subscriber saw. On the class-based host: a generated `@Injectable` edited to inject `CAPABILITIES.CONFIG`, resolved through the container (E3). On the rest host: a generated health indicator whose factory resolves a capability, observed in `/health` data. |
| `apps/cqrs/smoke.ts`                                                                                          | `apps/cqrs`                                                        | A command handler built by a factory that resolved a capability, driven through the public bus, with the dependency's effect read back. Run by `deno task check:apps`.                                                                                                                                                                                                                                                                                                                                                                                                                               |

**Negative controls — each must be observed failing, then reverted.**

1. Revert `args: '{ autoRegister: true }'` → the class-based container assertion fails with
   `No provider registered for DI token 'config'` (E3 reproduced).
2. Move factory resolution from `onInit` back into `register()` → both integration suites that
   register their plugin before the provider fail.
3. Restore `new X()` in a barrel and drop the factory from the artifact → the survives-regeneration
   probe fails, and the generated project fails `deno check`.
4. Drop the factory from `importSymbols` while the barrel still names it → the old-shape artifact is
   admitted, the skip report vanishes, and the regenerated barrel imports a symbol the file does not
   have (the M60 defect reproduced).
5. Remove the error wrapping in `resolveRegistryEntry` → the attribution assertions fail and the raw
   registry message escapes with no option named.
6. Append factory behaviours instead of resolving the whole list → the declared-order assertion in
   `behavior-factories.test.ts` fails.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m70d-no-arg-seams, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:apps        # apps/cqrs is a real consumer of the new arm (§3.15)
deno task check:docs        # C1–C5 doc deliverables
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" \
  packages/{common,health-plugin,cqrs-plugin,events-plugin,di-plugin,cli}/src   # must be empty
git commit ... && deno task publish:check          # refuses a dirty tree; run AFTER committing
deno task release:verify 0.1.0-alpha.8             # slow types, release lists, @module-first
```

`publish:check` and `release:verify` are mandatory here, not optional: this milestone adds exported
symbols to `common` and `health-plugin`, and an inferred return type on `resolveRegistryEntry` would
be a JSR slow type that `deno check` does not see (the M51 defect).

## 8. Risks & mitigations

- **An upgrading project's generated handler silently stops being registered.** The scanner rejects
  it and `generate` reports both routes out (`generate.ts:255-269`), but a developer who never runs
  `generate` again sees nothing. Mitigation: a CHANGELOG entry under **Changed** with the exact
  two-line edit, and the report text asserted by a test so it cannot regress into silence.
- **Deferring to `onInit` changes when a handler becomes reachable.** A plugin registering after
  `cqrs-plugin` that executes a command from its own `register()` would miss factory-produced
  handlers. Mitigation: instances keep their `register()` timing, so nothing that works today
  changes; the deferral is documented on each option and in `PUBLIC_API.md`.
- **`resolveRegistryEntry` in `common` becomes a dumping ground.** Mitigation: it takes a `label`
  string and returns a value — no plugin-specific knowledge, no registry writes — and §4 names its
  three readers.
- **The health barrel now imports from `@setu-ts/health-plugin`.** If a project has the seam but not
  the package, the generated import is unresolvable. Mitigation: the seam already carries
  `requiresPlugin: 'health-plugin'` (`seams/health.ts:105`, `:117`) and `hostSeamSpecs` filters on
  it (`seams/registry.ts:159-162`); a unit test pins that a host without the package scaffolds no
  health barrel.
- **`autoRegister: true` changes how a scaffolded class-based project constructs everything.** The
  first successful registry fallback is cached as a singleton (`di-plugin.ts:30-34`). Mitigation:
  the seam-probe boot already asserts `singleton` and `transient` behaviour across scopes on that
  host; those assertions must stay green with the flag on.
- **A widened `handler` field could break the method-syntax bivariance that keeps the lists
  heterogeneous without `any`** (`cqrs-plugin/src/interfaces/index.ts:16-19`). Mitigation: each
  plugin's unit suite includes a mixed list of two concretely-typed handlers plus a factory, so
  `deno check` proves the property rather than the comment asserting it.

## 9. Out of scope

- **A request scope created per request.** E5 is corrected as documentation only. Making `scoped`
  mean per-request needs the kernel to create and dispose a child scope around every request and a
  `common` surface to reach it from `IRequestContext` — a design of its own. Unowned; raise as a
  ROADMAP milestone.
- **A duplicate command or query `type` silently overwriting.** `RequestBus.registerHandler` is
  `Map.set` (`request-bus.ts:41`), so two entries for one type leave the second winning with no
  diagnostic — pre-existing, unchanged here, and the same shape M68 fixed for routes. Named for a
  later row rather than folded in, since it is not one of this milestone's registers.
- **`guard`, `job` and `migration` gaining registration sites.** Still deliberately absent, for the
  reasons `packages/cli/src/seams/registry.ts:11-35` gives; M70g owns the seam-scanner rows.
- **`decorator-plugin`'s `controllers`/`services`.** Those options take **classes** and the plugin
  constructs them through the container or the registry, so they already have a dependency route; E3
  is the defect there and is fixed.
- **Other packages' instance-list options.** This milestone changes the four surfaces the register
  names plus `behaviors` (§3.11). A repository-wide sweep for the same shape is worth doing and is
  not done here.
- **X2-5 / X8-12 (an `Error` in log metadata serializing to `{}`).** It is why a generated handler's
  failure is invisible, and it belongs to M70f.

## 10. Corrections found in code review (recorded, not quietly dropped)

Four plan claims did not survive the end-of-milestone review. They are recorded here because an
archived plan that still asserts them would be a lie about what shipped.

- **§3.3's error attribution shipped naming the wrong entry.** The label carried each factory's
  index within the FILTERED list rather than its index in the declared array, so with the two arms
  mixed — the documented case — `commandHandlers[1]` was reported as `[0]` and `indicators[2]` as
  `[0]`, pointing a developer at a different, working entry. `behaviors` was correct, because it
  maps over the whole list, which is what established the intended semantics. Fixed in all four
  remaining sites; the three `{ type, handler }` families now also name the entry's `type`, which
  identifies the failing registration where an index only locates it. The one test that claimed to
  cover this used a single-factory list, where a filtered index and a declared index are both `0`,
  so it passed either way; `cqrs-plugin` and `events-plugin` had no label test at all.
- **§3.12's migration route does not compile for four of the five families.** The plan leaned on the
  committed skip report, which advises "Rename its export to …". The missing symbol is now a
  FACTORY, so renaming a class to a factory's name emits a barrel entry that is a class constructor
  where the option wants an instance or a function — `TS2322`, probed. Only the functional health
  shape survives the rename, because that arm accepts an instance. The report now leads with adding
  the export; `ROADMAP.md` and `CLAUDE.md` repeated the bad advice and are corrected.
- **§6's designated timing test did not discriminate.** Both the health and CQRS integration tests
  resolved their capability lazily — inside `check()` / `handle()`, which run at request time — so
  moving factory resolution back into `register()` left them passing, while the health file's own
  comment claimed that was "impossible". Measured: with resolution moved into `register()` the
  health and CQRS integration tests passed and only the unit tests failed. Both now resolve in the
  factory BODY, and the CQRS test registers `EventsPlugin` AFTER `CqrsPlugin`, so both fail under
  that control. The `events-plugin` integration test already had the right shape and is the model
  the other two were brought to.
- **§6's E3 behavioural test was never written.** The plan promised a scaffolded class-based project
  whose generated `@Injectable` injects `CAPABILITIES.CONFIG`, resolved through the container. What
  shipped asserts only that the string `DiPlugin({ autoRegister: true })` is emitted. The behaviour
  was verified by probe during review — `autoRegister: true` resolves a decorated service's injected
  `ILogger`, `false` throws `No provider registered for DI token 'logger'` — and the mechanism is
  independently covered by `di-plugin`'s own integration suite, so the gap was a missing regression
  guard rather than a defect. **Closed in review**: the class-based `seam-probe` host now overwrites
  its generated `gadget-svc` service with one whose constructor injects `CAPABILITIES.CONFIG`, and
  the booted probe resolves it through the container and asserts the live config service arrived.
  Reverting `DI_WIRING` to a bare `DiPlugin()` fails it with
  `No provider registered for DI token
  'config'` — the register's own E3 signature — so the guard
  discriminates.
