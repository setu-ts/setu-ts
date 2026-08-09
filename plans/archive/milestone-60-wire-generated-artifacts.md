# Milestone 60 — Generated code that is wired (`@setu-ts/cli`)

> **Status:** Planning. Branch: `feat/m60-wire-generated-artifacts`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

`setu generate` emits fourteen artifacts and exactly one of them reaches a registration site: the
M58 domain module, through the CLI-owned `src/modules/index.ts` barrel the scaffolded
`setu.config.ts` already imports. The other thirteen compile and do nothing — `g service` emits a
class nothing constructs, `g health-indicator` an indicator nothing registers, `g command-handler` a
handler no bus dispatches to. This milestone extends M58's seam to every artifact that HAS a
registration site, states with evidence which three do not, and proves each wired artifact by
booting a scaffolded application and observing the artifact do its job — not by type-checking it.

The sort is the milestone's substance, and the ROADMAP's version of it does not survive source
checking: five of the six artifacts it places in the "has a plugin-options registration site" bucket
have no such option (§1 rows 5–9, §2 C1). Two of those options are added here as pure additions to
the owning plugins, one artifact's site is a per-route position no barrel can reach, and
`IApplication` carries no `lifecycle` member at all, so nothing in application code can run after
capabilities resolve except a plugin's own `register`.

- **In scope:** one generalized barrel-seam mechanism (`SeamSpec` + one scanner + one
  `SchematicOptions.artifacts` field) replacing what would otherwise be eight bespoke copies; seam
  barrels for `controller`, `service`, `route`, `middleware`, `plugin`, `health-indicator`,
  `metric`, `command-handler`, `query-handler`, `event-handler`; the `rest`/`microservice`/`nest`
  templates emitting every seam from scaffold time and consuming it in `setu.config.ts`;
  pure-addition `commandHandlers`/`queryHandlers` options on `CqrsPluginOptions` and `handlers` on
  `EventsPluginOptions`, plus `CqrsPlugin` and `EventsPlugin` joining the `microservice` template so
  those seams have a host; a detected-plugin-conditional `@Injectable` on `g service`; corrected
  emitted JSDoc naming the exact registration call for the three artifacts with no site; and one
  batched boot-and-probe e2e per host template that exercises every wired artifact at once.
- **NOT this milestone:** `setu g app` / monorepo support — **M62**. A `--di` flag, a
  `--no-decorators` resource path, and the `controller`/`module` gate refusal naming `g route` —
  **M61**. Docker/Kubernetes objects — **M39**. Changing any emitted artifact's shape beyond what
  wiring requires: `g metric` gains a `NamedMetricConfig` export and `g middleware` gains a priority
  constant because their registration sites take exactly those shapes; `g service` gains a
  conditional `@Injectable`; nothing else moves. A migration RUNNER (`setu db:migrate`) — unowned,
  see §3.9.

## 1. Contracts verified from SOURCE (not names)

| Reference                                          | Source (file:line)                                                   | Verified surface / fact                                                                                                                                                                                                                                              |
| -------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Schematic`                                        | `packages/cli/src/schematics/registry.ts:76`                         | `(names: DerivedNames, options: SchematicOptions) => readonly GeneratedFile[]` — synchronous and pure. Every barrel must therefore be returned from the one call, and the project state it needs must arrive through `options`.                                      |
| `SchematicOptions`                                 | `packages/cli/src/schematics/registry.ts:36`                         | Four members: `runtime`, `plugins: ReadonlySet<string>`, `now`, `modules?: readonly string[]`. `modules` is OPTIONAL for published-interface compatibility — the same reason `artifacts` must be optional.                                                           |
| `SchematicMetadata`                                | `packages/cli/src/schematics/registry.ts:84`                         | `{ factory, requiresPlugin? }`. The gate is a single package name checked against the detected set; there is no per-schematic hook beyond it, so a seam cannot be attached in the registry.                                                                          |
| `GeneratedFile`                                    | `packages/cli/src/utils/file-writer.ts:12`                           | `{ path, contents, managed? }`, all `readonly`. `managed` already exists (M58) and is the exemption every new barrel needs — **no new field is required**.                                                                                                           |
| `findExisting`                                     | `packages/cli/src/utils/file-writer.ts:115`                          | Skips `file.managed === true`, `stat`s the rest. The single overwrite chokepoint; it already reads the flag, so eight more managed barrels need no change here.                                                                                                      |
| generate write order                               | `packages/cli/src/commands/generate.ts:224`                          | `findExisting` → refuse if non-empty → `writeFiles`. `--dry-run` returns at `:219` from the SAME `files` array, before any `stat`, so barrel content must be computed inside the pure call.                                                                          |
| generate spreads the file                          | `packages/cli/src/commands/generate.ts:209`                          | `{ ...file, path: joinPath(dir, file.path) }` — spread, not rebuilt, so `managed` survives path rooting for every new barrel automatically.                                                                                                                          |
| `readModuleNames`                                  | `packages/cli/src/utils/module-scanner.ts:62`                        | `readdir` + `stat`; admits a directory only when BOTH `<n>.controller.ts` and `<n>.service.ts` exist; sorted; `[]` on any failure. Directory-shaped — the flat families need a different admission rule, so this is extended, not reused.                            |
| `IApplication`                                     | `packages/common/src/plugin.ts:412`                                  | `router`, `middleware`, `services`, `register(plugin)`, `start`, `stop`, `fetch` — and **no `lifecycle`**. So app code cannot hook a phase; anything needing a resolved capability must be a plugin option or a plugin.                                              |
| `IRouterApi`                                       | `packages/common/src/plugin.ts:74`                                   | Seven verbs + `group(prefix, cb)` + `listRoutes()`. `g route` already emits `register<X>Routes(router: IRouterApi)`, so its site is a call taking `app.router`.                                                                                                      |
| `RouteDefinition.middleware`                       | `packages/common/src/http.ts:489`                                    | `readonly middleware?: readonly MiddlewareFunction[]` — route-level middleware. This is a guard's real position, and it is per route, which is why §3.8 gives `guard` no barrel.                                                                                     |
| `IMiddlewareApi.add`                               | `packages/common/src/plugin.ts` (`MiddlewareWiring` consumer)        | Takes `(fn, { priority, name })`; the pipeline default is `500`. `MiddlewareWiring.addOptions` is REQUIRED at `templates/registry.ts:87` precisely so a bare `add()` cannot happen — §3.6 keeps that property.                                                       |
| `HealthPluginOptions.indicators`                   | `packages/health-plugin/src/interfaces/index.ts:55`                  | `readonly indicators?: readonly IHealthIndicator[]` — **exists**, takes INSTANCES, and `health-plugin.ts:75` registers each at `register()` time. Direct fit for the emitted indicator class.                                                                        |
| `IHealthIndicator`                                 | `packages/common/src/services/health.ts:44`                          | `{ readonly name: string; check(): Promise<HealthCheckResult> }`. The emitted class already implements exactly this with a no-argument constructor, so `new XHealthIndicator()` is a legal barrel entry.                                                             |
| `MetricsPluginOptions.customMetrics`               | `packages/metrics-plugin/src/interfaces/index.ts` (options)          | `readonly customMetrics?: readonly NamedMetricConfig[]` — **exists**, but declarative: `NamedMetricConfig extends MetricConfig` = `{ name, type, help, labels?, buckets? }`. The schematic emits a `(services) => ICounter` FUNCTION, which this option cannot take. |
| `customMetrics` materialization                    | `packages/metrics-plugin/src/plugin/metrics-plugin.ts:108`           | `service.register(metric.name, metric)` inside `ctx.lifecycle.onInit`. So a pre-registered metric exists before any request.                                                                                                                                         |
| zero-sample counter still renders                  | `packages/metrics-plugin/src/renderers/prometheus-renderer.ts:117`   | `renderCounter` emits `# HELP` and `# TYPE` before iterating `values`, so a metric with no observations IS visible in `GET /metrics`. This is what makes §3.5's probe non-vacuous.                                                                                   |
| `CqrsPluginOptions`                                | `packages/cqrs-plugin/src/interfaces/index.ts`                       | **Only `behaviors?: readonly IPipelineBehavior[]`.** There is no handler option — the ROADMAP's claim is false. Registration is `commandBus.register(type, handler)`.                                                                                                |
| `ICommandBus.register` / `IQueryBus.register`      | `packages/common/src/services/cqrs.ts:114`, `:146`                   | `register<TCommand extends CqrsCommand, TResult>(type: string, handler: ICommandHandler<TCommand, TResult>): void` — a `(type, handler)` PAIR, so a barrel entry must carry both, not a bare handler.                                                                |
| `CqrsPlugin` shape                                 | `packages/cqrs-plugin/src/plugin/cqrs-plugin.ts:42`, `:48`           | `CqrsPlugin(options?)`, `provides: [CQRS, COMMAND_BUS, QUERY_BUS]`, no `dependencies`. Zero-config and in-memory, so it can join a template without credentials.                                                                                                     |
| `EventsPluginOptions`                              | `packages/events-plugin/src/interfaces/index.ts`                     | **Only `async?` and `errorHandler?`.** No handler option — the ROADMAP's claim is false again.                                                                                                                                                                       |
| `subscribeHandler`                                 | `packages/events-plugin/src/handlers/event-handler.ts:29`            | `(bus: IEventBus, type: string, handler: IEventHandler<T>) => Unsubscribe`, implemented as `bus.subscribe(type, (e) => handler.handle(e))`. The new `handlers` option reuses this, so one implementation serves both entry points.                                   |
| `EventsPlugin` shape                               | `packages/events-plugin/src/plugin/events-plugin.ts:37`, `:44`       | `EventsPlugin(options?)`, `provides: [EVENTS]`, no `dependencies`. Zero-config and in-memory.                                                                                                                                                                        |
| `auth-plugin` has no guards option                 | `packages/auth-plugin/src/index.ts:45-50`                            | Exports six guard FACTORIES (`requireAuth`, `requireRole`, …) and `AuthPluginOptions` (`:29`) carries no guard list. Verified by `grep -rn "guards" packages/auth-plugin/src`: the only hits are those exports and one comment.                                      |
| `@UseGuards`                                       | `packages/decorator-plugin/src/decorators/pipeline.ts:23`            | Attaches guards to a controller or route via the metadata store. Per-target, like `RouteDefinition.middleware` — both are positions inside code the DEVELOPER owns.                                                                                                  |
| `QueuePluginOptions`                               | `packages/queue-plugin/src/interfaces/index.ts:146`                  | `adapter`, `name`, `url`, `client`, `defaultMaxAttempts`, `pollIntervalMs`, `prefix`, `sqs` — **no `processors`**. So `g job` also has no plugin-option site (§3.9).                                                                                                 |
| no `ctx.cli.register` caller in-repo               | `grep -rn "cli.register" packages/*/src`                             | Two hits, both non-code: the CLI's own error message (`plugin-commands.ts:197`) and a JSDoc example (`common/src/plugin.ts:278`). **No migration runner exists**, which is the evidence behind §3.9's `migration` verdict.                                           |
| `DecoratorPluginOptions.controllers` / `.services` | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:55`, `:57` | Both `readonly Constructor[]`; `:519` dedups the explicit list with discovery and `:521` calls `registerService` per entry. So one option takes TWO spread barrels and neither displaces the other.                                                                  |
| `registerService` token path                       | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:268`       | Reads the `@Injectable` token, registers in the DI container when `ctx.container` exists, else instantiates and `ctx.services.register(token, instance)`. Both paths make the token resolvable, which is §3.3's functional bar.                                      |
| `InjectableOptions`                                | `packages/decorator-plugin/src/decorators/injection.ts:16`           | `{ scope?: ServiceScope; token?: string }`; without `token` the token defaults to the class name. §3.3 emits an explicit token for the same reason M58 did — `emitDecoratorMetadata` is absent repo-wide.                                                            |
| `withModuleSeam`                                   | `packages/cli/src/templates/module-seam.ts:85`                       | Maps a wiring list, replacing the `decorator-plugin` entry's `args`. Takes `extraControllers`/`extraServices` prepended before the barrel spread — the exact extension point the two new decorator barrels need.                                                     |
| `Wiring` / `LocalImport`                           | `packages/cli/src/templates/registry.ts:22`, `:66`                   | `args` is a string rendered verbatim; `LocalImport` is `{ symbols, from }` with `from` project-relative. Both already carry everything the plugin-option seams need — no contract widening for those.                                                                |
| `TemplateDefinition.localImports`/`.files`         | `packages/cli/src/templates/registry.ts:236`, `:243`                 | Both optional, both already consumed. `files` paths must not collide with the fixed set; `firstDuplicatePath` (`commands/new.ts:616`) reports a collision rather than letting the last write win.                                                                    |
| `configModule` render points                       | `packages/cli/src/commands/new.ts:161`, `:127`, `:187`               | The plugin list, the middleware `add` lines, and the hello-world route are three separate rendered blocks. Bucket-B seams (§3.6, §3.7) need a FOURTH block, which is the one template-contract widening this milestone makes.                                        |
| host-template set                                  | `packages/cli/src/templates/{rest,microservice,nest}.ts`             | All three carry `MODULE_SEAM_FILES` + `MODULE_SEAM_LOCAL_IMPORT` + `MODULE_SEAM_MANIFEST`; `full-stack.ts` carries none. That is the established host set §3.10 reuses rather than inventing a second one.                                                           |
| template plugin sets                               | `packages/cli/src/templates/rest.ts:33`, `microservice.ts:38`        | `rest` = runtime/config/logger/validation/http-security/health/metrics/openapi/decorator; `microservice` adds messaging/queue/resilience/telemetry/service-discovery. **Neither installs `cqrs-plugin` or `events-plugin`** — hence §3.4.                            |
| `bootAndProbe`                                     | `packages/cli/test/e2e/template-e2e.test.ts:613`                     | Writes a probe module, runs `deno run -A --node-modules-dir=none --config <project>/deno.json`, and parses ONE line behind `__PROBE_RESULT__`. Extended, not replaced, by §6's batched probes.                                                                       |
| `useWorkspacePackages`                             | `packages/cli/test/e2e/template-e2e.test.ts:111`                     | Repoints `@setu-ts/*` at workspace `src/index.ts` and merges `WORKSPACE_COMPILER_OPTIONS` (`:182`), including `exactOptionalPropertyTypes`. Required before any boot, or framework source fails to compile.                                                          |
| PUBLIC_API managed-file claim                      | `PUBLIC_API.md` "Overwrite protection"                               | States "Exactly one managed file ships today: `src/modules/index.ts`". Eight more ship here, so this sentence is a named doc deliverable (§2 C2).                                                                                                                    |
| ARCHITECTURE CLI Rules row                         | `ARCHITECTURE.md:1484` (`@setu-ts/cli` table)                        | Says a generate refuses to overwrite "except one a schematic declares `managed` (only `src/modules/index.ts` today)". Same correction (§2 C2). Public API row (`runCli`, `deriveNames`, `detectPlugins`, `PROGRAM_NAME`) stays true.                                 |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                        | Resolution (picked side)                                                                                                                                                                                                                                                                                                    | Doc deliverable (same PR)                                                                                                                             |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | ROADMAP M60 sorts `guard`, `metric`, `command-handler`, `query-handler`, `event-handler` as having "a plugin-options registration site". Source says: `metric`'s option cannot take the emitted shape, `CqrsPluginOptions` has only `behaviors`, `EventsPluginOptions` only `async`/`errorHandler`, and `auth-plugin` has no guards option at all (§1).         | Take SOURCE. The sort is rewritten in §3.1: two options are ADDED (cqrs, events), `metric` gains a `NamedMetricConfig` export so the existing option fits, and `guard` moves to the no-site bucket with its reason. The ROADMAP bucket list is corrected rather than implemented as written.                                | Rewrite the M60 bucket list in `ROADMAP.md` to the verified sort, naming each site; add the two new plugin options to its deliverable list.           |
| C2 | `PUBLIC_API.md` ("Overwrite protection") and `ARCHITECTURE.md:1484` both state that `src/modules/index.ts` is the ONLY managed file. This milestone ships nine.                                                                                                                                                                                                 | Both texts are narrowed to "the CLI-owned seam barrels", with the full list in the new PUBLIC_API wiring table. Chosen over introducing a second exemption concept: `managed` already means exactly this, and M58 chose it over a `--force` flag for a reason that still holds.                                             | Update the PUBLIC_API "Overwrite protection" section and the ARCHITECTURE `@setu-ts/cli` Rules row; add the per-schematic wiring table to PUBLIC_API. |
| C3 | ROADMAP M60 says the templates "emit each seam from scaffold time so a new project is wired before anything is generated" — but `cqrs-plugin` and `events-plugin` are in no template, so their seams would have no host and the emitted config could not reference them.                                                                                        | Add `CqrsPlugin` and `EventsPlugin` to the `microservice` template (M50b precedent: that milestone added `ServiceDiscoveryPlugin` to the same template). Both are zero-config and in-memory (§1), so the REST-tier rule "every plugin here constructs with no configuration" is preserved. `rest` and `nest` are unchanged. | Record the two added plugins in the ROADMAP M60 deliverables, the PUBLIC_API template table (`microservice` row), and CHANGELOG.                      |
| C4 | The emitted JSDoc of `guard`, `job` and `migration` tells the developer to register the artifact ("Register it with `queue.process(...)`", "Register it with the HealthPlugin's `indicators` option"), which reads as if a site is waiting — for `job` two mutually exclusive ones, and for `migration` a runner that does not exist anywhere in the repo (§1). | Correct each artifact's JSDoc to name its ACTUAL position and say plainly that the CLI does not wire it, and why. `health-indicator`'s "or from a plugin with `ctx.health.register`" line is kept but demoted, since the barrel is now the default path.                                                                    | Corrected JSDoc in the three schematics; a "not wired, and why" row per artifact in the PUBLIC_API wiring table.                                      |

## 3. Design decisions

### 3.1 The sort — a named site, or an explicit none, for all fourteen

- **Decision:** the verified sort below is the milestone's contract. Eleven artifacts reach a
  registration site with no hand edit in a project whose backing plugin is present; three do not,
  each for a reason recorded in code and in PUBLIC_API.

  | Schematic          | Emitted shape                         | Registration site (verified)                                             | Seam barrel                  |
  | ------------------ | ------------------------------------- | ------------------------------------------------------------------------ | ---------------------------- |
  | `module`           | aggregate                             | `DecoratorPlugin({ controllers, services })`                             | `src/modules/index.ts` (M58) |
  | `controller`       | `@Controller` class                   | `DecoratorPlugin({ controllers })`                                       | `src/controllers/index.ts`   |
  | `service`          | class, `@Injectable` when detected    | `DecoratorPlugin({ services })`                                          | `src/services/index.ts`      |
  | `route`            | `register<X>Routes(router)`           | a call in `createApp()` taking `app.router`                              | `src/routes/index.ts`        |
  | `middleware`       | `MiddlewareFunction` factory          | `app.middleware.add(fn, { priority, name })` in `createApp()`            | `src/middleware/index.ts`    |
  | `plugin`           | `IPlugin` factory                     | the `plugins: [...]` array in `createApplication`                        | `src/plugins/index.ts`       |
  | `health-indicator` | `IHealthIndicator` class              | `HealthPlugin({ indicators })`                                           | `src/health/index.ts`        |
  | `metric`           | accessor fn + new `NamedMetricConfig` | `MetricsPlugin({ customMetrics })`                                       | `src/metrics/index.ts`       |
  | `command-handler`  | `ICommandHandler` class               | NEW `CqrsPluginOptions.commandHandlers`                                  | `src/cqrs/index.ts`          |
  | `query-handler`    | `IQueryHandler` class                 | NEW `CqrsPluginOptions.queryHandlers`                                    | `src/cqrs/index.ts`          |
  | `event-handler`    | `IEventHandler` class                 | NEW `EventsPluginOptions.handlers`                                       | `src/events/index.ts`        |
  | `guard`            | `MiddlewareFunction` factory          | **none** — per route (`RouteDefinition.middleware` / `@UseGuards`), §3.8 | —                            |
  | `job`              | `run<X>Job(data)` function            | **none** — transport-ambiguous by design, §3.9                           | —                            |
  | `migration`        | `Migration` object                    | **none** — no runner exists in the framework, §3.9                       | —                            |

- **Why:** the ROADMAP asked for this sort and its own version does not survive `grep` (§2 C1).
  Every row above cites source in §1, including the three negatives — a "none" backed by a name
  nobody read would be the same defect as a wrong positive.
- **Test home:** `test/unit/seams/seam-registry.test.ts` pins the eleven specs and asserts the three
  no-site schematics contribute no barrel; the §6 batched probes prove the eleven functionally.

### 3.2 One generalized seam mechanism, not eight copies

- **Decision:** a single `src/seams/seam-spec.ts` declares `SeamSpec` —
  `{ family, dir, suffix, barrelExport, requiresPlugin?, renderBarrel(names) }` — and
  `src/seams/registry.ts` holds one spec per wired family. `src/utils/artifact-scanner.ts` gains one
  `readArtifactNames(fs, dir, spec)`; `SchematicOptions` gains one optional
  `artifacts?: Readonly<Record<string, readonly string[]>>` keyed by `family`. Each wired schematic
  returns its artifact file PLUS its own barrel, rendered from `options.artifacts[family]` unioned
  with the new name.
- **Why:** eight hand-rolled scanners and eight hand-rolled barrel renderers is the duplicated-logic
  defect §11.1 forbids, and the M58 pieces are already shaped for reuse — the only genuinely
  per-family part is the array entry's text, which `renderBarrel` isolates. One scanner also means
  the sort/dedup/`[]`-on-failure behaviour that keeps a regenerated barrel byte-identical is decided
  once rather than eight times.
- **Test home:** `test/unit/seams/seam-registry.test.ts` (spec table),
  `test/unit/utils/artifact-scanner.test.ts` (scan branches), and one shared assertion helper in
  `test/unit/schematics/_shared.ts` applied to every wired schematic's test.

### 3.3 `g service` — `@Injectable` only when `decorator-plugin` is detected

- **Decision:** `generateService` reads `options.plugins.has('decorator-plugin')`. Present → the
  class carries `@Injectable({ token: '<kebab>-service' })`, imports `Injectable`, and the schematic
  additionally returns the managed `src/services/index.ts` barrel exporting
  `APP_SERVICES: readonly Constructor[]`. Absent → today's output, byte for byte, and NO barrel
  file. The schematic stays ungated.
- **Why:** the maintainer's call among the three framings, and the only one that neither breaks nor
  lies. Emitting `@Injectable` unconditionally would force the schematic to be gated like
  `controller` (its own import could not resolve), which REFUSES `g service` in a bare project where
  it works today — a breaking change to an ungated schematic. Leaving it plain keeps a third of the
  orphan count. Branching on the detected set is the same input the gate already uses
  (`registry.ts:40`), so no new project state is read. The explicit token is mandatory for M58's
  reason: `emitDecoratorMetadata` is absent repo-wide, so a parameter type cannot be read.
- **Test home:** `test/unit/schematics/service.test.ts` — with `plugins: new Set()` the output
  equals the committed string and the file count is 1; with `decorator-plugin` present the class is
  decorated, the token is `<kebab>-service`, and file 2 is the managed barrel. The §6 probe resolves
  `app.services.get('<kebab>-service')` and calls `describe()`.

### 3.4 CQRS and events — two pure-addition options, and a template host

- **Decision:** `CqrsPluginOptions` gains `commandHandlers?: readonly CommandHandlerRegistration[]`
  and `queryHandlers?: readonly QueryHandlerRegistration[]`, each entry `{ type, handler }`;
  `EventsPluginOptions` gains `handlers?: readonly EventHandlerRegistration[]`, each entry
  `{ type, handler }`. Both plugins register their entries inside their existing `register()`, the
  events one by calling the already-exported `subscribeHandler`. `CqrsPlugin()` and `EventsPlugin()`
  join the `microservice` template. `rest` and `nest` are unchanged.
- **Why:** the option shape follows `ICommandBus.register(type, handler)` exactly (§1), so the pair
  is carried, not invented — a bare handler array would have to guess the type name from the class,
  which the emitted `<SCREAMING>_COMMAND` constant already states explicitly. Pure additions cannot
  break a caller. The template host is required by C3 and has the M50b precedent; without it these
  two seams could only ever be proven in a hand-patched project, which is the "compiles but does
  nothing" outcome this milestone exists to end. Routing the events option through
  `subscribeHandler` keeps one implementation behind two entry points, per the self-review
  checklist.
- **Test home:** `packages/cqrs-plugin/test/unit/plugin/cqrs-plugin.test.ts` and
  `packages/events-plugin/test/unit/plugin/events-plugin.test.ts` — a handler supplied through
  options receives a dispatched command/query/event, and an app with the option omitted behaves
  byte-identically; `test/unit/templates/seam-wiring.test.ts` pins the two added `microservice`
  wirings and that `rest`/`nest` plugin lists are unchanged.

### 3.5 `g metric` — emit the `NamedMetricConfig` the existing option takes

- **Decision:** the metric schematic keeps its `<SCREAMING>_TOTAL` name constant and its
  `<camel>Counter(services)` accessor, and ADDS
  `export const <SCREAMING>_METRIC: NamedMetricConfig = { name, type: 'counter', help, labels }`.
  `src/metrics/index.ts` collects those into `CUSTOM_METRICS`, which
  `MetricsPlugin({ customMetrics: [...CUSTOM_METRICS] })` consumes.
- **Why:** the existing option cannot take a function (§1), and the two forms are not redundant —
  the config is how the metric EXISTS at boot, the accessor is how application code increments it.
  Wiring is what requires the addition, so it is inside the ROADMAP's out-of-scope carve-out. The
  functional bar is real rather than nominal because `renderCounter` emits `# HELP`/`# TYPE` before
  any sample exists (§1), so a wired metric is visible in `GET /metrics` with zero application code.
- **Test home:** `test/unit/schematics/metric.test.ts` (all three exports, `labels: ['outcome']`
  preserved); the §6 probe asserts `# TYPE <snake>_total counter` in the `/metrics` body.

### 3.6 `g middleware` — the priority travels in the developer's own file

- **Decision:** the middleware schematic emits `export const <SCREAMING>_MIDDLEWARE_PRIORITY = 500;`
  beside the factory, and `src/middleware/index.ts` exports
  `GENERATED_MIDDLEWARE: readonly { name: string; priority: number; middleware: MiddlewareFunction }[]`
  built from it. `createApp()` renders one loop:
  `for (const m of GENERATED_MIDDLEWARE) app.middleware.add(m.middleware, { priority: m.priority, name: m.name });`
- **Why:** the ROADMAP's constraint is that wiring "must not silently reorder middleware
  priorities", and `MiddlewareWiring.addOptions` is required at `templates/registry.ts:87` for
  exactly that reason — a bare `add()` lands at 500 inside every framework middleware, which is how
  scaffolded projects once got an `errorHandler` that could not catch a metrics throw. Putting the
  number in the artifact module means it is explicit, and the developer changes it in a file THEY
  own rather than in a CLI-owned barrel the next generate rewrites. `500` is the kernel default, so
  the emitted default reorders nothing.
- **Test home:** `test/unit/schematics/middleware.test.ts` (constant emitted, barrel entry names
  it); `test/unit/templates/seam-wiring.test.ts` (the rendered loop passes both fields, and the
  `errorHandler` line still renders at `priority: 0` before it); the §6 probe asserts the generated
  middleware's `X-<Pascal>` response header is present on a request the generated route served.

### 3.7 Bucket B rendering — one new `TemplateDefinition.setupCalls` field

- **Decision:** `TemplateDefinition` gains `setupCalls?: readonly string[]` — statements rendered
  verbatim into `createApp()` after the middleware block and before the hello-world route — and
  `Wiring`-shaped plugin spreads are handled by a second new field
  `pluginSpreads?: readonly string[]`, rendered as extra entries in the `plugins: [...]` array.
  `route`, `middleware` and `plugin` seams are consumed through these two.
- **Why:** `configModule` renders the plugin list, the middleware adds and the hello-world route as
  three fixed blocks (`commands/new.ts:161`, `:127`, `:187`); a statement is expressible in none of
  them, and a plugin ARRAY spread is not a `Wiring` (it has no `pkg`/`symbol`). Both are strings for
  the reason `Wiring.args` is: they are authored by template modules in this repo, never by user
  input, and the e2e drift gate type-checks the generated project — which is the only thing that can
  validate them, and the M50b trap this plan repeats as a negative control (§6).
- **Test home:** `test/unit/templates/seam-wiring.test.ts` — every host template's `setupCalls`
  bring only identifiers its `localImports` declare, and the rendered order is plugins → middleware
  → setup calls → hello-world; `test/unit/new-command.test.ts` — a template with neither field
  renders byte-identically to today.

### 3.7a `g plugin` moves to `src/plugins/<kebab>.plugin.ts`

- **Decision:** the plugin schematic's path changes from `src/plugins/<kebab>.ts` to
  `src/plugins/<kebab>.plugin.ts`, and the scanner matches that suffix. The class body is unchanged.
- **Why:** wiring requires a distinguishable filename. Every other family has one (`.indicator.ts`,
  `.metric.ts`, `.routes.ts`), but `src/plugins/` held bare `.ts` files — so a suffix of `.ts` would
  admit ANY module a developer hand-wrote there, and the barrel would then import a `<Pascal>Plugin`
  symbol that does not exist, making the developer's project fail to compile naming a file they
  never generated. That is the exact failure `readModuleNames` guards against with its two-file
  precondition (`module-scanner.ts:37`), and a suffix is the cheaper guard. Existing generated files
  are untouched; only new generates take the new path.
- **Test home:** `test/unit/schematics/plugin.test.ts` (the new path, and the barrel entry derived
  from it); `test/unit/utils/artifact-scanner.test.ts` — a hand-written `src/plugins/notes.ts` is
  NOT admitted, which is the case the suffix exists for.

### 3.8 `guard` — no barrel, because every honest position is inside the developer's code

- **Decision:** no seam. The emitted JSDoc is corrected to show the two real positions
  (`app.router.get(path, { handler, middleware: [requireX()] })` and `@UseGuards(requireX())`), and
  PUBLIC_API records the reason.
- **Why:** a guard's site is per route (`RouteDefinition.middleware`, `@UseGuards`), and
  `auth-plugin` exposes no guard list (§1). The only barrel-shaped alternative is the global
  pipeline, and the emitted guard answers `401` when `ctx.request.user` is absent — registering it
  globally would 401 `/health`, `/metrics` and `/`, turning a generated file into an outage. A
  wiring that must not be applied is not a wiring.
- **Test home:** `test/unit/schematics/guard.test.ts` — the emitted source names both positions and
  the schematic returns exactly one file (no barrel); `test/unit/seams/seam-registry.test.ts`
  asserts no spec exists for the family.

### 3.9 `job` and `migration` — no site, with the evidence

- **Decision:** neither artifact gets a seam. `job`'s JSDoc states that the function is
  transport-agnostic and names both `queue.process(JOB, (job) => run<X>Job(job.data))` and
  `scheduler.every(...)`/`scheduler.cron(...)` as the developer's choice. `migration`'s JSDoc states
  that no framework component reads migration files and that applying them is the developer's
  tooling. Both reasons go in the PUBLIC_API wiring table.
- **Why:** `QueuePluginOptions` has no `processors` option (§1), and choosing for the developer is
  unsafe in both directions — auto-registering a queue processor starts a worker loop polling for a
  job name nothing enqueues, and auto-scheduling needs a cron expression the artifact does not
  carry. For `migration` the evidence is stronger: `grep -rn "cli.register" packages/*/src` finds no
  plugin registering any command at all, so `setu db:migrate` does not exist and there is nothing to
  wire into. A runner is its own milestone and is left unowned rather than smuggled in here.
- **Test home:** `test/unit/schematics/job.test.ts` and `migration.test.ts` — one file each, no
  barrel, and the corrected JSDoc text present; `test/unit/seams/seam-registry.test.ts` asserts that
  neither family has a spec.

### 3.9a Name collisions — refused, because wiring is what makes them real

- **Decision:** `generate` refuses (exit `1`) before running the schematic when the requested name
  would collide with an artifact already present, in one of two groups:
  `route`/`controller`/`module` (all mount `/<name>`), and `service`/`module` (both register
  `@Injectable({ token: '<name>-service' })`). The check is skipped when `decorator-plugin` is
  absent, since neither collision can exist there. The refusal names the conflicting artifact, the
  consequence, and the fix.
- **Why:** this defect was found by booting the project, not by reasoning — and it was a defect this
  milestone INTRODUCED. Before the seams, two artifacts sharing a name were two inert files. With
  them, `g service widget` + `g module widget` made `DecoratorPlugin.registerService` (first-wins on
  a token) hand the module's controller the standalone service, so every request to that module
  answered `500` (`this.widgets.list is not a function`) — the exact class of defect the ROADMAP
  cites `g controller` for. The path collision is quieter and no less real: the kernel's router keys
  `#entryMap` on `${method} ${path}` and a duplicate OVERWRITES, so `GET /widget` was registered
  three times and two of the three artifacts were unreachable. Refusing beats warning because a
  silent 500 and a silently-dropped route are both worse than a command that will not run, and the
  one remedy covers both cases.
- **Test home:** `test/unit/utils/name-conflicts.test.ts` (both groups, both directions, the
  same-schematic exemption, and the no-`decorator-plugin` skip); `test/e2e/seam-probe.test.ts`
  asserts all four collision commands exit `1` and write nothing, and the batched probe uses
  distinct names per group so it exercises the wiring rather than the collision.

### 3.10 Host set — the three templates M58 already established

- **Decision:** every seam file, `localImport` and config reference is emitted by `rest`,
  `microservice` and `nest`, and by neither the no-template (minimal) path nor `full-stack`. A seam
  whose backing plugin a given host lacks is still emitted when the seam needs no plugin (`routes`,
  `middleware`, `plugins`), and omitted when it does — so the `cqrs`/`events` seams appear on
  `microservice` only.
- **Why:** one host concept, not two. `full-stack` is excluded for M58's reason (its layering is
  `routes → features → services`, it composes through a starter factory, and its `createApp` has no
  plugin array to spread into). The minimal path is excluded because it has no `TemplateDefinition`
  at all — `runNewCommand` reads `MINIMAL_PLUGINS` with `template?.files ?? []` — so giving it seams
  means inventing a fourth template definition for a project that registers the runtime plugin
  alone, where six of the ten seams would be inert. The two lines a minimal-path developer adds are
  documented in PUBLIC_API, exactly as M58 documents them for a pre-M58 project.
- **Test home:** `test/unit/templates/seam-wiring.test.ts` — all three hosts carry every applicable
  seam file and import, `full-stack` carries none, and a bare `setu new` project's `setu.config.ts`
  is byte-identical to today's.

### 3.11 Regeneration and idempotence

- **Decision:** every seam barrel is `managed`, rendered from the sorted, deduplicated union of
  `options.artifacts[family]` and the new name, exactly as `renderModuleBarrel` does. Regenerating
  over an existing artifact still refuses on the artifact's own file and rewrites the barrel; the
  barrel lists each artifact once.
- **Why:** `findExisting` already skips managed paths and `generate.ts:209` already preserves the
  flag through path rooting (§1), so this needs no new mechanism — only the same sort M58 added for
  the same reason: `readdir` order is filesystem-defined, so an unsorted barrel could differ
  byte-for-byte between two machines holding identical artifacts, turning a no-op regeneration into
  a diff.
- **Test home:** `test/unit/schematics/_shared.ts` helper applied to all ten wired schematics — the
  barrel is the only `managed` file, output is byte-identical across two calls with reordered input,
  and the new name appears exactly once when already present.

## 4. Exported surface — every symbol names its consumer

No symbol is added to `packages/cli/src/index.ts`: `runCli`, `deriveNames`, `detectPlugins` and
`PROGRAM_NAME` remain the whole barrel, so `ARCHITECTURE.md:1484`'s Public API row stays correct.
Two other packages DO gain published type surface, listed below.

| Exported symbol                                                                  | Kind      | Consumer / real code path that READS it                                                                                                                                      |
| -------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(none added to `cli/src/index.ts`)_                                             | —         | Verified against `packages/cli/src/index.ts`; no JSR surface moves for the CLI.                                                                                              |
| `SeamSpec`                                                                       | interface | `seams/registry.ts` declares specs; `schematics/*.ts` and `utils/artifact-scanner.ts` read them. Internal to the CLI — not barrel-exported, like the 14 schematic factories. |
| `getSeamSpec` / `listSeamSpecs`                                                  | function  | `commands/generate.ts` (to drive the scan) and `templates/seam.ts` (to emit files + imports). Two real readers each, neither a test.                                         |
| `readArtifactNames`                                                              | function  | `runGenerateCommand` — the one scanner for all flat families. Internal, extracted so its failure branches are unit-testable (the `readModuleNames` precedent).               |
| `SchematicOptions.artifacts`                                                     | field     | Every wired schematic reads `options.artifacts?.[family]` to render its barrel; `runGenerateCommand` populates it. Two real readers.                                         |
| `SEAM_FILES` / `SEAM_LOCAL_IMPORTS` / `SEAM_SETUP_CALLS` / `SEAM_PLUGIN_SPREADS` | const     | `templates/{rest,microservice,nest}.ts` — the four things a host template must declare, derived from one spec list so a host cannot carry a file without its import.         |
| `TemplateDefinition.setupCalls`                                                  | field     | `configModule` in `commands/new.ts` renders them; the three host templates supply them. §3.7.                                                                                |
| `TemplateDefinition.pluginSpreads`                                               | field     | `configModule` renders them into the `plugins: [...]` array; the three host templates supply them. §3.7.                                                                     |
| `CqrsPluginOptions.commandHandlers`                                              | field     | `CqrsPlugin.register` calls `commandBus.register(e.type, e.handler)` per entry. Read on a real code path, proven by a dispatched command.                                    |
| `CqrsPluginOptions.queryHandlers`                                                | field     | `CqrsPlugin.register` calls `queryBus.register(...)` per entry.                                                                                                              |
| `CommandHandlerRegistration` / `QueryHandlerRegistration`                        | interface | Exported from `cqrs-plugin/src/index.ts` because the two options name them and a consumer must be able to type its own array. PUBLIC_API row added.                          |
| `EventsPluginOptions.handlers`                                                   | field     | `EventsPlugin.register` calls the existing `subscribeHandler(bus, e.type, e.handler)` per entry — one implementation, two entry points.                                      |
| `EventHandlerRegistration`                                                       | interface | Exported from `events-plugin/src/index.ts` for the same reason. PUBLIC_API row added.                                                                                        |

### 4.1 Options — every option names its consumer

| Option                              | Consumer                           | Behavior (per implementation)                                                                                                                                                                               |
| ----------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SchematicOptions.artifacts`        | the ten wired schematics           | Existing artifact names per family. Absent → treated as no artifacts yet, so a published harness that predates it still works (the `modules` precedent). Ignored by `guard`/`job`/`migration`/`module`.     |
| `SchematicOptions.modules`          | `module` schematic (unchanged)     | Unchanged. Kept separate from `artifacts` because its admission rule is directory-shaped (two required files), not suffix-shaped, and it is already published.                                              |
| `CqrsPluginOptions.commandHandlers` | `CqrsPlugin.register`              | Each `{ type, handler }` registered on the command bus at `register()`. Omitted → no registrations, byte-identical to today.                                                                                |
| `CqrsPluginOptions.queryHandlers`   | `CqrsPlugin.register`              | Same, on the query bus. A duplicate `type` is the bus's existing behavior, not re-specified here.                                                                                                           |
| `EventsPluginOptions.handlers`      | `EventsPlugin.register`            | Each `{ type, handler }` subscribed through `subscribeHandler`. Omitted → no subscriptions. The returned `Unsubscribe` is intentionally dropped: the bus dies with the application, and there is no caller. |
| `TemplateDefinition.setupCalls`     | `configModule`                     | Statements rendered verbatim inside `createApp()`, after middleware, before the hello-world route. Omitted → nothing rendered, byte-identical to today.                                                     |
| `TemplateDefinition.pluginSpreads`  | `configModule`                     | Extra entries in the `plugins: [...]` array, after the wirings. Omitted → byte-identical.                                                                                                                   |
| `--dry-run` (existing)              | `runGenerateCommand`               | Unchanged: prints every planned path INCLUDING the barrel and writes nothing. The family scan still runs, since barrel content depends on it.                                                               |
| `--dir` (existing)                  | `resolveDir` → `readArtifactNames` | The scan is rooted at the resolved dir, so scan and write cannot disagree (the M34 relative-`--dir` defect class).                                                                                          |

## 5. Implementation files

| File                                                                                      | Purpose                                                                                                                                                                |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/index.ts`                                                               | Unchanged — no new export (§4).                                                                                                                                        |
| `packages/cli/src/seams/seam-spec.ts`                                                     | `SeamSpec` and the shared barrel-rendering helpers (header, sorted imports, array literal) extracted from `module-barrel.ts`.                                          |
| `packages/cli/src/seams/registry.ts`                                                      | One spec per wired family; `getSeamSpec`, `listSeamSpecs`.                                                                                                             |
| `packages/cli/src/utils/artifact-scanner.ts`                                              | `readArtifactNames(fs, dir, spec)`: `readdir` + suffix match, sorted, `[]` when absent or unreadable.                                                                  |
| `packages/cli/src/utils/name-conflicts.ts`                                                | `findNameConflict(...)`: the two collision groups §3.9a establishes.                                                                                                   |
| `packages/cli/src/schematics/registry.ts`                                                 | Add `artifacts` to `SchematicOptions`.                                                                                                                                 |
| `packages/cli/src/commands/generate.ts`                                                   | Scan every family once, refuse a name collision, pass `artifacts` in `SchematicOptions`.                                                                               |
| `packages/cli/src/commands/new.ts`                                                        | `configModule` renders `setupCalls` and `pluginSpreads`.                                                                                                               |
| `packages/cli/src/templates/registry.ts`                                                  | Add the two `TemplateDefinition` fields.                                                                                                                               |
| `packages/cli/src/templates/seam.ts`                                                      | `SEAM_FILES`/`SEAM_LOCAL_IMPORTS`/`SEAM_SETUP_CALLS`/`SEAM_PLUGIN_SPREADS`, derived from the spec list; extends `withModuleSeam` to prepend the two decorator barrels. |
| `packages/cli/src/templates/{rest,microservice,nest}.ts`                                  | Declare the seams; `microservice` additionally gains `CqrsPlugin` and `EventsPlugin`.                                                                                  |
| `packages/cli/src/schematics/controller.ts`                                               | Return the managed `src/controllers/index.ts` barrel alongside the class.                                                                                              |
| `packages/cli/src/schematics/service.ts`                                                  | Conditional `@Injectable` + barrel (§3.3).                                                                                                                             |
| `packages/cli/src/schematics/route.ts`                                                    | Barrel exporting `registerGeneratedRoutes(router)`.                                                                                                                    |
| `packages/cli/src/schematics/middleware.ts`                                               | Priority constant + barrel (§3.6).                                                                                                                                     |
| `packages/cli/src/schematics/plugin.ts`                                                   | Barrel exporting `GENERATED_PLUGINS`.                                                                                                                                  |
| `packages/cli/src/schematics/health-indicator.ts`                                         | Barrel exporting `HEALTH_INDICATORS` (instances); corrected JSDoc.                                                                                                     |
| `packages/cli/src/schematics/metric.ts`                                                   | `NamedMetricConfig` export + barrel exporting `CUSTOM_METRICS` (§3.5).                                                                                                 |
| `packages/cli/src/schematics/{command,query}-handler.ts`                                  | Shared `src/cqrs/index.ts` barrel exporting `COMMAND_HANDLERS` and `QUERY_HANDLERS`.                                                                                   |
| `packages/cli/src/schematics/event-handler.ts`                                            | Barrel exporting `EVENT_HANDLERS`.                                                                                                                                     |
| `packages/cli/src/schematics/{guard,job,migration}.ts`                                    | Corrected JSDoc only; no barrel (§3.8, §3.9).                                                                                                                          |
| `packages/cqrs-plugin/src/interfaces/index.ts` + `plugin/cqrs-plugin.ts` + `index.ts`     | The two handler options, their registration, and the two exported registration types.                                                                                  |
| `packages/events-plugin/src/interfaces/index.ts` + `plugin/events-plugin.ts` + `index.ts` | The `handlers` option through `subscribeHandler`, and its registration type.                                                                                           |

`schematics/module-barrel.ts` and `utils/module-scanner.ts` keep their public shape; the parts
`seam-spec.ts` now owns are moved, not duplicated, and `renderModuleBarrel` delegates.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                | src covered                                             | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/cli/test/unit/seams/seam-registry.test.ts`                     | `seams/seam-spec.ts`, `seams/registry.ts`               | Exactly ten specs, one per wired flat family; `getSeamSpec('guard'\|'job'\|'migration')` is `undefined`; every spec's `dir` matches the path its schematic writes; `renderBarrel([])` type-checks and yields an empty array literal.                                                                                                                                                                                                                                                                                                                                           |
| `packages/cli/test/unit/utils/name-conflicts.test.ts`                    | `utils/name-conflicts.ts`                               | Both groups, both directions (`service`→`module` and `module`→`service`); a second artifact of the SAME schematic is not a conflict; no `decorator-plugin` → `undefined`; an unrelated family (`metric`) never conflicts.                                                                                                                                                                                                                                                                                                                                                      |
| `packages/cli/test/unit/utils/artifact-scanner.test.ts`                  | `utils/artifact-scanner.ts`                             | Names returned sorted; a file whose suffix does not match is excluded; a DIRECTORY matching the suffix is excluded; `readdir` rejecting → `[]`; `stat` rejecting for one entry → that entry excluded, others kept. Typed against `readArtifactNames(fs: IFileSystem, dir: string, spec: SeamSpec)`.                                                                                                                                                                                                                                                                            |
| `packages/cli/test/unit/schematics/*.test.ts` (10 extended)              | the ten wired schematics                                | Per schematic: the artifact file path is unchanged from today; file 2 is the barrel at the spec's `dir`; ONLY the barrel is `managed`; the new name appears once when already in `options.artifacts`; two calls with reordered input are byte-identical (shared helper, §3.11).                                                                                                                                                                                                                                                                                                |
| `packages/cli/test/unit/schematics/service.test.ts`                      | `schematics/service.ts`                                 | `plugins: new Set()` → exactly one file whose contents equal the committed plain-class string (pins §3.3's no-change promise); `plugins: new Set(['decorator-plugin'])` → `@Injectable({ token: 'billing-service' })` and a second, managed file.                                                                                                                                                                                                                                                                                                                              |
| `packages/cli/test/unit/schematics/{guard,job,migration}.test.ts`        | those three                                             | Exactly one file each, no `managed` file, and the corrected JSDoc names the real position (`@UseGuards`/`RouteDefinition.middleware`; both `queue.process` and `scheduler`; "no framework component reads these").                                                                                                                                                                                                                                                                                                                                                             |
| `packages/cli/test/unit/templates/seam-wiring.test.ts`                   | `templates/seam.ts`, the three host templates           | All three hosts carry every applicable seam file + `LocalImport`; `cqrs`/`events` seams appear on `microservice` ONLY; `full-stack` carries none; `microservice` gains exactly two plugin wirings and `rest`/`nest` lists are unchanged; every `setupCalls` identifier is declared by a `localImport`.                                                                                                                                                                                                                                                                         |
| `packages/cli/test/unit/new-command.test.ts` (extend)                    | `commands/new.ts`                                       | A template with neither new field renders a `setu.config.ts` byte-identical to the committed expectation; render order is plugins → middleware → setup calls → hello-world; `errorHandler` still renders at `priority: 0`.                                                                                                                                                                                                                                                                                                                                                     |
| `packages/cli/test/unit/generate-command.test.ts` (extend)               | `commands/generate.ts`                                  | `--dry-run` prints the barrel path and writes nothing; a family scan whose `readdir` throws still exits `0`; `--dir` roots the scan; a second `g health-indicator x` refuses on the indicator file and never reports the barrel.                                                                                                                                                                                                                                                                                                                                               |
| `packages/cqrs-plugin/test/unit/plugin/cqrs-plugin.test.ts` (extend)     | `plugin/cqrs-plugin.ts`                                 | A `commandHandlers` entry receives a dispatched command and its result returns; same for `queryHandlers`; options omitted → `HandlerNotFoundError` exactly as today. Typed against `ICommandBus.register<TCommand, TResult>`.                                                                                                                                                                                                                                                                                                                                                  |
| `packages/events-plugin/test/unit/plugin/events-plugin.test.ts` (extend) | `plugin/events-plugin.ts`                               | A `handlers` entry receives a published event; the option and a manual `subscribeHandler` call produce identical delivery (one implementation, two entry points); omitted → no subscriptions.                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/cli/test/e2e/template-e2e.test.ts` (extend)                    | the whole path, against a real `deno check`             | Scaffold `rest`, generate all available schematics over the hostile-name set, repoint at the workspace, `deno check` every source: the barrels, the config's imports of them, and the emitted classes all agree. Same on `nest`. The file-count arithmetic gains the per-family barrels.                                                                                                                                                                                                                                                                                       |
| `packages/cli/test/e2e/seam-probe.test.ts` (new)                         | the functional bar — one batched boot per host template | Scaffold `rest`, generate one of every available artifact, boot via `bootAndProbe`, and in ONE probe assert: the generated route serves `200`, the generated middleware's `X-<Pascal>` header is on that response, the standalone controller serves `200`, `services.get('<kebab>-service').describe()` returns the name, `/health` lists the generated indicator, `/metrics` contains `# TYPE <snake>_total counter`, and the generated plugin's token resolves. Then the same on `microservice`, additionally dispatching a command, a query and an event through the buses. |

Batched rather than one boot per artifact, deliberately: eleven subprocess boots of a
workspace-source project would add minutes to the suite, and a single boot carrying every artifact
is the STRONGER proof — it shows they coexist, which eleven isolated boots would not.

Negative controls to run and report (each observed failing, then reverted): delete the
`decorator-plugin` branch in `generateService` → the service-resolution probe must fail while
`deno check` still passes; break one identifier inside a `setupCalls` string → the e2e `deno check`
must fail (the M50b trap: these strings are invisible to the CLI's own type-check); remove the
`commandHandlers` loop from `CqrsPlugin.register` → the command probe must fail with
`HandlerNotFoundError`; drop the sort in the shared barrel renderer → the byte-identical assertion
must fail; remove `CqrsPlugin` from the `microservice` template → the config must fail to compile
rather than silently dropping the handlers.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m60-wire-generated-artifacts, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check              # on a COMMITTED tree — three packages change
deno task release:verify 0.1.0-alpha.5
```

## 8. Risks & mitigations

- **`setupCalls` and `pluginSpreads` are rendered strings invisible to the CLI's own `deno check`**
  (the M50b finding) → a wrong identifier is a compile error only in the GENERATED project.
  Mitigated by the e2e drift gate type-checking every host template, and by the negative control
  above that breaks a string deliberately and confirms the gate fails.
- **Auto-registering every file in `src/plugins/` could break boot** if a developer generates a
  plugin they are not ready to enable → documented in the barrel header and PUBLIC_API: removing the
  file removes the registration, and the generated plugin registers one service under its own token
  with no `dependencies`, so array position cannot affect resolution order.
- **Ten `readdir` calls per `generate` invocation**, including for the schematics that ignore
  `artifacts` → `detectPlugins` and `readModuleNames` already read unconditionally
  (`generate.ts:101`, `:182`); the scan is one `readdir` per family against paths that usually do
  not exist, and branching on the schematic name would put a second dispatch beside the registry.
  Covered by the throwing-`readdir` test rather than guarded.
- **Adding two plugins to `microservice` changes what an existing command emits** → both are
  zero-config and in-memory (§1), the `unsupported` map is unchanged (neither needs a socket), and a
  unit test pins that `rest` and `nest` plugin lists do not move. Recorded in CHANGELOG as a
  template change, not a fix.
- **Nine managed barrels widen the overwrite exemption** from one path to nine → each is a path the
  CLI wrote in the first place, `findExisting` remains the single chokepoint, and no `--force` flag
  is introduced, so a mistyped `g service user` still refuses. The PUBLIC_API narrowing (C2) states
  the full list rather than leaving the guarantee overstated.
- **A pre-M60 project has no seam imports**, so a generated artifact sits unwired with no diagnostic
  → each barrel header states the exact lines to add, PUBLIC_API documents them per family, and the
  host templates emit every seam from scaffold time so all NEW projects are wired. Detecting it by
  reading the developer's `setu.config.ts` is deliberately not done: that is the read M58's design
  exists to avoid.

## 9. Out of scope

- **`setu g app` / monorepo support** — M62 owns the workspace shape and the app-side discovery map.
- **A `--di` flag, a `--no-decorators` resource path, and the `controller`/`module` gate refusal
  naming `g route`** — M61. §3.3's conditional shape is not a `--decorators` flag: it reads the
  detected plugin set, which the gate already reads, and adds no CLI option.
- **A migration runner (`setu db:migrate`)** — unowned. §3.9 establishes that no plugin registers
  any CLI command today, so a runner is a new capability rather than a wiring, and inventing one
  here would smuggle a second milestone into this one.
- **Wiring `guard` globally** — rejected in §3.8 with cause, not deferred: the emitted guard answers
  `401` without a user, so a global registration would 401 `/health` and `/metrics`.
- **Seams on the minimal (no-template) path and on `full-stack`** — §3.10 keeps M58's host set;
  giving the minimal path seams means inventing a fourth `TemplateDefinition` for a project that
  registers the runtime plugin alone. Unowned.
- **Editing `setu.config.ts` in place** — still rejected on M58's grounds: it needs a TypeScript
  parser in a zero-dependency package, cannot preserve a developer's formatting, and makes
  `--dry-run` a prediction rather than the truth.
- **Changing `g controller`'s or `g module`'s emitted shape** — M58 corrected both; this milestone
  adds a barrel beside the controller and touches neither class body.
