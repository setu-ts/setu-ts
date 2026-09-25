# Milestone 99e — Class-Based Style As Its Own Axis (`@setu-ts/cli`)

> **Status:** Opened on `docs/m99e-class-based-style`, which carries only this plan and the ROADMAP
> section — CLAUDE.md assigns opening a milestone to a `docs/…` branch, because a `feat/…` branch
> asserts the milestone is being built on it (the M37c/PR #124 precedent). The implementation, the
> status flip, the plan archival and every follow-up fix all belong on ONE branch,
> `feat/m99e-class-based-style`, which merges through one PR; `main` is protected.

## 0. Objective & scope

One command scaffolds a class-based microservice:
`setu new <name> --template microservice --style class-based`. The same flag works on
`setu generate app`. Today the style and the plugin set are one choice. `--template microservice` is
functional (M65), and `--template class-based` is the REST set plus the decorator and DI pair, so no
template has both. That leaves a NestJS team migrating a microservice with no scaffold, and
`docs/migration-nestjs.md` is silent on scaffolding and microservices alike.

This milestone fixes composition only. The runtime already supports the combination: the probe in §1
booted the full microservice plugin set with the decorator and DI pair and drove every decorated
ingress family. The generator already supports it too, because `generatorMode` reads the manifest.

- **In scope:** the `--style` flag on `new` and `generate app`; class-based variants of `rest` and
  `microservice` derived from the SAME recipe as their functional forms; `--template class-based`
  kept as a byte-identical alias; one seam-gate correction so a class-based host has exactly one
  registration site per ingress family; the interactive prompt; help and flag inventories; a booted
  e2e covering the new host; and the documentation named in §2.
- **NOT this milestone:**
  - A class-based `full-stack`. Refused with a reason. Unowned: the starter already has `decorators`
    and `di` arms (`packages/starters/rest-starter/src/options.ts:108,163`), but the full-stack
    layout (`routes → features → services`) has no controller or ingress seam to register decorated
    classes through. That is a template design question, not a flag.
  - Converting an existing functional project to class-based. `setu add decorator` and `setu add di`
    already change `generatorMode`, but neither rewrites `setu.config.ts` to add the
    `DecoratorPlugin` seam arguments. Unowned.
  - A `setu g subscription` schematic emitting `@Subscribe`. No such schematic exists in any style
    (`packages/cli/src/schematics/` has no subscription file). Unowned.
  - A decorator for brokered request/reply. NestJS `@MessagePattern` maps to `broker.respond(...)`,
    which `decorator-plugin` does not expose as a decorator
    (`packages/decorator-plugin/src/index.ts` exports `Subscribe` and no respond form). The
    migration guide documents the programmatic form. Unowned.

## 1. Contracts verified from SOURCE (not names)

| Reference                    | Source (file:line)                                                                                                     | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Template selection           | `packages/cli/src/templates/choice.ts:66-95`                                                                           | `resolveTemplateChoice(args)` reads `--template` only. It refuses `--di` (`:67-73`), refuses an unknown name through the registry `Map`, and returns `{ ok, template? }`. `new` (`commands/new.ts:449`) and `generate app` (`commands/app.ts:200`) both call it, so one change reaches both verbs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Stacked JSDoc (pre-existing) | `packages/cli/src/templates/choice.ts:37-65`                                                                           | The JSDoc for `resolveTemplateChoice` sits above `RENAMED_TEMPLATES`, and the function at `:66` has none. This is the M70m stacked-docblock defect. It is corrected here because this milestone rewrites the function.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Template contract            | `packages/cli/src/templates/registry.ts:297-414,525-537`                                                               | `TemplateHost` is data: `plugins`, `middleware`, `localImports`, `files`, `pluginSpreads`, `setupCalls`, `manifest`, `runtimeSwaps`, and others. `TemplateDefinition` adds `name: TemplateName` and `description`. The registry is a `Map` of four definitions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Template names (public)      | `packages/cli/src/constants.ts:54-57`; `packages/cli/src/index.ts`                                                     | `TEMPLATES = ['rest', 'microservice', 'class-based', 'full-stack']`, and `TemplateName` is exported from the barrel. Keeping `class-based` in the list means no barrel change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| REST composition             | `packages/cli/src/templates/rest.ts:36-50,102-114`                                                                     | `REST_PLUGINS` (runtime, config, logger, validation, http-security, health, metrics, openapi). `REST_TEMPLATE` applies `withPluginOptionSeams`, adds the functional `REST_SHOWCASE_FILES`, and uses `FUNCTIONAL_MODULE_MANIFEST`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Class-based composition      | `packages/cli/src/templates/class-based.ts:32-35,110-178`                                                              | `CLASS_BASED_SEAMS = seamsFor(REST_PLUGINS + decorator-plugin)`. Plugins: `withPluginOptionSeams(withModuleSeam([...REST_PLUGINS, DECORATOR_WIRING], extras…), seams).concat([DI_WIRING])`. Files: the greeting service and controller, `MODULE_SEAM_FILES`, and seeded seam barrels. Uses `CLASS_BASED_MODULE_MANIFEST`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Microservice composition     | `packages/cli/src/templates/microservice.ts:33-57,201,221-233`                                                         | `MICROSERVICE_PLUGINS = [...REST_PLUGINS, ...MICROSERVICE_ADDITIONS]` (messaging, queue, resilience, telemetry, cqrs, events, service discovery `'static'`). It has no showcase files, only seam barrels, and carries `runtimeSwaps: { 'cloudflare-workers': WORKERS_SWAP }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| DI wiring                    | `packages/cli/src/templates/di.ts:28-32`                                                                               | `DI_WIRING` renders `DiPlugin({ autoRegister: true })`. The default `false` leaves `@Inject(CAPABILITIES.X)` unresolvable (E3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Seam selection per host      | `packages/cli/src/seams/registry.ts:106-122,163-167`                                                                   | `withHostShapes` returns every spec unchanged in class-based mode and drops only `INGRESS_SEAM` in functional mode. `hostSeamSpecs` then filters by `requiresPlugin`. So a class-based host that installs `cqrs-plugin` and `events-plugin` would scaffold the functional `src/cqrs` and `src/events` barrels alongside `src/ingress`. No shipped host installs both, so this is unreachable today and reachable the moment this milestone composes one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Double-delivery hazard       | `packages/cli/src/seams/ingress.ts:1-8`                                                                                | "The generated artifacts are deliberately absent from the functional seams: registering an event or CQRS handler through both paths would deliver each message twice."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Plugin-option seams          | `packages/cli/src/templates/seam.ts:167-209`                                                                           | `withPluginOptionSeams` gives `CqrsPlugin` `{ commandHandlers, queryHandlers }` and `EventsPlugin` `{ handlers }` whenever their seams are present. With the seams absent, both render bare, which matches what `setu add cqrs` emits into a class-based config.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Decorator seam arguments     | `packages/cli/src/templates/module-seam.ts:92-123`; `packages/cli/src/templates/seam.ts:224-245`                       | `withModuleSeam` rewrites only the `decorator-plugin` wiring's `args`. `decoratorSeamExtras` contributes the `ingress` spread when `INGRESS_SEAM` is present.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Class-based schematics       | `packages/cli/src/schematics/{command-handler,query-handler,event-handler,job}.ts`                                     | In class-based mode each writes `src/ingress/<name>.ingress.ts` plus the managed ingress barrel. `job` does so only when `queue-plugin` is in the manifest (`job.ts:27`). None writes into `src/cqrs` or `src/events` in class-based mode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Style persistence            | `packages/cli/src/utils/generator-mode.ts:22-24`                                                                       | `generatorMode(plugins)` is `'class-based'` exactly when `decorator-plugin` is installed. No generated state file is needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Decorator ingress ordering   | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:1010-1023`                                                   | With a non-empty `ingress` list, `optionalDependencies` names QUEUE, SCHEDULER, EVENTS, MESSAGING, WEBSOCKET, COMMAND_BUS and QUERY_BUS, so the kernel orders the ingress providers first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Broker overlay gate          | `packages/cli/src/templates/broker.ts:163-187`                                                                         | `standaloneOverlayRefusal` refuses on Workers, on a starter-composed host, and on a host whose `plugins` lack the package. It never reads the template name, so a class-based microservice host passes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Interactive prompt           | `packages/cli/src/commands/new-interactive.ts:41,54-57,132-163`                                                        | Asks the template from `listTemplates()`, then asks broker and queue against the resolved host. No style question exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Flag inventories             | `packages/cli/src/flags.ts:118-170`                                                                                    | `NEW` and `GENERATE_APP` are strict allowlists, and the help ↔ inventory gate (`test/unit/flags.test.ts`) asserts help text against `documented` in both directions. `VALUE_FLAGS` (`constants.ts:66-80`) must list any flag that takes a value.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Workspace-root refusal       | `packages/cli/src/commands/new.ts:136-190`                                                                             | `new --workspace` refuses `--template`, `--di`, the broker flags and others by name.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `setu add` ingress wiring    | `packages/cli/src/commands/add.ts:103-110,205-236`                                                                     | Only in a config carrying the class-based `DecoratorPlugin({ … ingress: [...INGRESS_HANDLERS] … })` shape does `add` insert the provider for cqrs, events, messaging, queue, scheduler or websocket. It inserts directly after `plugins: [`, above `RuntimePlugin()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Existing boot gates          | `packages/cli/test/e2e/scaffold-runs-e2e.test.ts:45,56-69,262-264`; `packages/cli/test/e2e/seam-probe.test.ts:306-381` | `BOOTABLE` is pinned to the four template names, and `HOSTS` lists the scaffolded argument sets. `seam-probe` boots `class-based` (decorated HTTP and DI) and `microservice` (functional CQRS and events) separately. No host has both.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Runtime probe (measured)** | scratch probe, 2026-09-24, against this workspace's sources                                                            | Steps: `setu new shop --template class-based`; `setu add cqrs events messaging queue`; hand-register resilience, telemetry and `ServiceDiscoveryPlugin({ provider: 'static', services: {} })`; `setu g command-handler/query-handler/event-handler/job`; repoint at the workspace with `useWorkspacePackages`; boot with `bootAndProbe`. Result: `{"command":{"id":"c1"},"query":{"id":"q1"},"event":["e1"],"job":["j1"],"http":[200,"{\"message\":\"Hello, ada!\"}"]}`. So the full microservice set plus the decorator and DI pair resolves with no plugin cycle, and every decorated ingress family fires. **Reproduced during plan verification (2026-09-24)** on the same steps with distinct artifact names: `{"command":{"id":"c1"},"query":{"id":"q1"},"seen":["event:e1","job:j1"],"http":[200,"{\"message\":\"Hello, ada!\"}"]}` — the event recorded exactly once. `setu add resilience/telemetry/service-discovery` updated only `deno.json`, confirming those three need the hand edit. |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Resolution (picked side)                                                                                                                                     | Doc deliverable (same PR)                                                                                                                                                                                                                                                                                                   |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `docs/cli.md:50-72` and `PUBLIC_API.md:7583-7600` present `--template class-based` as the one class-based choice. `docs/decorators.md:69` says it "is the only combination the CLI writes".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Style is its own axis. `--template class-based` is an alias. The decorator and DI pair stays indivisible, which is the M65 property those sentences protect. | Rewrite the style table in `docs/cli.md` and `PUBLIC_API.md` with `--style` rows; correct `docs/decorators.md:69-73`; keep the `docs/cli.md` anchor that `decorators.md` links to, or update both.                                                                                                                          |
| C2 | `docs/migration-nestjs.md` has no scaffolding instructions and no Microservices section. Its checklist (`:904-916`) never names a template.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | The guide gains the path this milestone creates.                                                                                                             | Add `## Scaffolding` and `## Microservices` sections (`@MessagePattern` → `broker.respond(...)`, `@EventPattern` → `@Subscribe`, `@nestjs/cqrs` → `@CommandHandler`/`@QueryHandler`, `@nestjs/bull` → `@Processor`, `@nestjs/schedule` → `@Cron`/`@Every`), plus a checklist line. The fences must pass the M38 fence gate. |
| C3 | `packages/cli/README.md:20,40`, `docs/plugins.md:1225-1226` and `PUBLIC_API.md:7428-7430,8087` list `class-based` as a peer template and show no `--style`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Same as C1.                                                                                                                                                  | Update each site to show `--style` and to name `class-based` as the alias.                                                                                                                                                                                                                                                  |
| C4 | The `--di` refusal (`choice.ts:67-73`, `new.ts:148-153`) points only at `--template class-based`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | It should name the axis that now exists.                                                                                                                     | Refusal text: `Use --style class-based (with --template rest or microservice)`. Update the `PUBLIC_API.md:7736` row.                                                                                                                                                                                                        |
| C5 | Broker refusal text (`broker.ts:177,183`) says "Use --template microservice". That stays true, but a class-based reader should be told it combines with `--style class-based`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Keep the advice and extend it.                                                                                                                               | Append `(add --style class-based for decorators)` to the no-wiring arm. Update the matching `docs/cli.md:134-143` sentence.                                                                                                                                                                                                 |
| C6 | Sites the rewritten sections carry that C1–C5 do not name. `PUBLIC_API.md:7499` (the `--broker` row) lists `class-based` among templates with no messaging; `docs/cli.md:139-143` says a `microservice` answer gets four interactive questions and lists `class-based` as skipped. Two are already stale on `main`: `PUBLIC_API.md:8150-8152` says the class-based template emits `src/greeting-service.ts` and `src/greeting-controller.ts` imported directly by `setu.config.ts`, while the source writes `src/services/greeting.service.ts` and `src/controllers/greeting.controller.ts` registered through the seam barrels (`class-based.ts:110-123`, E4); and `packages/cli/README.md:40` says the controller uses parameter-level `@Inject`, which M76 removed (the showcase uses the class-position `@Inject` list, `class-based.ts:86-89`). | Correct them in the same PR, because each sits inside a section this milestone rewrites and would otherwise be republished stale.                            | Update `PUBLIC_API.md:7499` for the style-aware answer; update the `docs/cli.md` interactive paragraph for the style question and the question count; correct `PUBLIC_API.md:8150-8152` to the seam-barrel paths; correct `packages/cli/README.md:40` to the class-position `@Inject` list.                                 |

## 3. Design decisions

### 3.1 Style is a precomputed variant on the template definition, not a runtime transform

- **Decision:** A styleable template module exports one internal `TemplateRecipe`: the pre-seam
  plugin list, middleware, the manifest base, `runtimeSwaps`, and a per-style showcase
  (`{ functional?: Showcase; 'class-based'?: Showcase }`, where a showcase is files plus seeded seam
  names). One internal `composeHost(recipe, style): TemplateHost` builds a host. For class-based it
  sets installed packages to recipe plus `decorator-plugin`, selects seams with `seamsFor`, builds
  plugins as
  `withPluginOptionSeams(withModuleSeam([...recipe.plugins, DECORATOR_WIRING], extras), seams).concat([DI_WIRING])`,
  adds `MODULE_SEAM_FILES`, the module-seam local import and `CLASS_BASED_MODULE_MANIFEST`. For
  functional it reproduces today's rest and microservice construction. `TemplateDefinition` gains
  one optional field, `classBased?: TemplateHost`, the precomputed class-based variant. `rest` and
  `microservice` set it. `full-stack` and `class-based` do not.
- **Why:** Transforming a finished `TemplateDefinition` would be lossy. Its seams, seam barrels and
  plugin `args` are already baked, so a transform would have to un-derive them. Precomputing keeps
  `--dry-run` exact and lets a test assert a variant without rendering a project, which is the
  `runtimeSwaps` reasoning (`registry.ts:479-492`). One `composeHost` is also what makes
  `class-based` and `rest --style class-based` identical by construction rather than by care.
- **Test home:** `test/unit/templates/style.test.ts`.

### 3.2 `--template class-based` stays and is byte-identical

- **Decision:** `CLASS_BASED_TEMPLATE` becomes
  `{ name: 'class-based', description, aliasOf: '--template rest --style class-based', ...composeHost(REST_RECIPE, 'class-based') }`.
  The new optional `TemplateDefinition.aliasOf?: string` has three readers:
  - `new --help` and `generate app --help` append `(alias of <aliasOf>)`.
  - The interactive template prompt omits the entry.
  - `resolveTemplateChoice` returns a `notice` the command logs once, naming the canonical spelling.
    It is informational: the alias is not deprecated, so the notice never says it will be removed.

  The output stays byte-identical, and nothing is refused or scheduled for removal. The field is
  named `aliasOf`, not `deprecatedFor`: under AI_GUIDELINES §9.2 "deprecated" means scheduled for
  removal, which this is not, and the name would contradict the ROADMAP bullet that calls it an
  alias.
- **Why:** A published template name is public surface (§9.2, the M65 `nest` reasoning). Removing it
  would break five releases of docs and scripts for no gain. Leaving it as an equal peer would show
  two names for one project in the prompt with nothing telling them apart.
- **Test home:** `test/unit/templates/style-baseline.test.ts` (byte identity, see §3.7);
  `test/unit/help.test.ts`; `test/unit/new-interactive.test.ts`.

### 3.3 Flag semantics and refusals

- **Decision:** `--style` takes a value and is added to `VALUE_FLAGS`. It is accepted on `new` and
  on `generate app`. Resolution happens inside `resolveTemplateChoice`, which returns the host to
  render. Its result becomes `{ ok: true; template?; host?; notice? }`, and the callers use
  `choice.host ?? MINIMAL_HOST`. Rules:
  - An absent `--style` means the template's own style.
  - `--style functional` with `rest` or `microservice` is today's host. With `class-based` it is
    refused: "`--template class-based` is `--template rest --style class-based`; for a functional
    project use `--template rest`."
  - `--style class-based` with `rest` or `microservice` gives `template.classBased`. With
    `class-based` it is accepted as redundant.
  - `--style` with no `--template` is refused, naming the two styleable templates.
  - `--style` with `full-stack` is refused. The message says the template composes through a starter
    and has no controller or ingress seam.
  - An unknown `--style` value is refused, listing `functional` and `class-based`.
  - `new --workspace --style …` is refused beside `--template`, naming
    `generate app <name> --template … --style …`.
  - The `--di` refusal text names `--style class-based` (C4).
- **Why:** Every flag is refused wherever it would be a silent no-op (the M72 rule), and one
  resolver for both verbs keeps their messages identical (`choice.ts:1-11`).
- **Test home:** `test/unit/templates/choice.test.ts` (resolver rows — it already tests
  `resolveTemplateChoice`); `test/unit/style-flag.test.ts` (command-level rows and exit codes);
  `test/unit/flags.test.ts` (inventory ↔ help).
- **Existing assertions the C4 text change breaks, updated in the same commit:**
  `flags.test.ts:416,423,452` pin the substring
  `` no longer supported. Use `--template class-based` ``; `choice.test.ts:36`,
  `app-command.test.ts:209,713` and `new-command.test.ts:569,1108` assert `--template class-based`
  in the `--di` refusal. The C5 change appends text, so `broker-flags.test.ts:207,231`
  (`toContain('--template microservice')`) keep passing and need no edit.

### 3.4 A class-based host has exactly one registration site per ingress family

- **Decision:** `hostSeamSpecs` drops `COMMAND_HANDLER_SEAM`, `QUERY_HANDLER_SEAM` and `EVENTS_SEAM`
  when `generatorMode(installed) === 'class-based'`, just as `withHostShapes` drops `INGRESS_SEAM`
  in functional mode. `scanSeamSpecs` is unchanged. A class-based microservice therefore renders
  `CqrsPlugin()` and `EventsPlugin()` bare, and decorated handlers arrive only through
  `DecoratorPlugin({ ingress })`.
- **Why:** Without this the class-based microservice would scaffold `src/cqrs/index.ts` and
  `src/events/index.ts`, wired into plugin options but never written by any class-based schematic.
  That is dead surface, and any handler placed there would be registered twice
  (`seams/ingress.ts:4-6`). The change reaches no shipped host, because none installs the decorator
  plugin together with cqrs or events, and §3.7 proves that.
- **Test home:** `test/unit/seams/seam-registry.test.ts` (extend; there is no `host-seams.test.ts`).

### 3.5 `--broker` and `--queue` work unchanged under the style

- **Decision:** No code change. `standaloneOverlayRefusal` and `withBrokerArgs`/`withQueueArgs` key
  on `host.plugins` (`broker.ts:163-187`), and the class-based microservice host carries
  `messaging-plugin` and `queue-plugin`. The workspace transport overlay
  (`workspace/member-host.ts`) composes the same helpers.
- **Why:** The refusal the user met on `class-based` was correct for that host (no messaging
  wiring). The new host has the wiring, so the flag has something to rewrite.
- **Test home:** `test/unit/style-flag.test.ts` (overlay applied, variables added, compose file
  emitted); `test/e2e/workspace-e2e.test.ts` (`--transport rabbitmq` with a class-based member).

### 3.6 Interactive prompt asks for a style

- **Decision:** After the template answer, when the chosen template has `classBased` and `--style`
  is absent, `resolveNewChoices` asks `Code style?` with `functional` (default) and `class-based`
  and records `flags['style']`. The broker and queue questions then run against the styled host,
  resolved by the same `resolveTemplateChoice`, not by a second lookup in `standaloneHost`. `--yes`
  skips it, as it skips every prompt.
- **Why:** Prompts rewrite flag values before the ordinary pipeline runs (M72), so every prompted
  value is expressible as a flag and `--dry-run` stays exact.
- **Test home:** `test/unit/new-interactive.test.ts`.

### 3.7 Byte identity of every existing output is proven against a pre-refactor baseline

- **Decision:** The FIRST implementation commit, made before any template code changes, adds
  `test/fixtures/template-baseline.json`. It maps each `(template, runtime)` pair for `rest`,
  `microservice` and `class-based` × the four runtimes, plus the no-template host, to
  `{ path: sha256(contents) }` over `projectFiles(...)`. A test asserts that the refactored
  functional hosts, and `class-based`, reproduce it exactly. The fixture is regenerated only by a
  named script invocation written in the test file's header. It is never edited by hand.
- **Why:** This is the M76 precedent. A refactor of a renderer's inputs cannot otherwise tell
  "unchanged" from "consistently different", and the four existing templates are published output.
- **Test home:** `test/unit/templates/style-baseline.test.ts`.

### 3.8 The new host is proven by booting it

- **Decision:** `seam-probe.test.ts` gains a third arm, `microservice --style class-based`. It
  generates `ARTIFACTS`, `CLASS_BASED_ONLY`, and `command-handler`, `query-handler`, `event-handler`
  and `job` (all class-based, so all ingress), then boots once and asserts. The four ingress
  artifacts need **four distinct names**: in class-based mode every family writes
  `src/ingress/<name>.ingress.ts`, so reusing `MICROSERVICE_ONLY` (all `widget`) makes the second
  `setu g` refuse to overwrite — measured during plan verification (`g query-handler widget` exited
  `1` after `g command-handler widget`). Assertions:
  - The HTTP and DI results the class-based arm already asserts, including E3 capability injection.
  - The command and query results through `ICqrsFacade`.
  - A published event reaching the generated `@OnEvent` class exactly once. The generated file is
    rewritten to record deliveries, as the scratch probe did.
  - An enqueued job reaching the `@Processor` class.
  - `src/cqrs/` and `src/events/` both absent.

  `scaffold-runs-e2e.test.ts` gains `microservice --style class-based` and its Workers arm in
  `HOSTS`. That list drives only `fmt --check` and `lint` (`scaffold-runs-e2e.test.ts:236-252`); the
  boot loop iterates `BOOTABLE` and runs `new shop --template <name>` (`:266-268`), so a `HOSTS`
  entry alone would never boot. The boot therefore gets its own case: a `BOOTABLE_STYLED` list of
  argument sets (`['--template', 'microservice', '--style', 'class-based']`) driven through the same
  `bootWithGeneratedPermissions` path and the same `/health`, `/ready`, `/metrics` assertions, with
  its own membership assertion beside the existing `BOOTABLE` one, so dropping the arm fails rather
  than vanishing. `BOOTABLE` stays the four template names.
- **Why:** Compiling is not working (M58: every generated controller answered 500 for five releases
  while `deno check` passed).
- **Test home:** `test/e2e/seam-probe.test.ts`; `test/e2e/scaffold-runs-e2e.test.ts`.

## 4. Exported surface — every symbol names its consumer

`packages/cli/src/index.ts` does not change. `TemplateName` still covers exactly the four names,
because `class-based` stays in `TEMPLATES`. `barrel-exports.test.ts` pins that.

| Exported symbol              | Kind | Consumer / real code path that READS it                                                                                                                                                                                                                                                          |
| ---------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| None added to `src/index.ts` | —    | New symbols are module-internal: `TemplateRecipe`, `composeHost`, `TemplateStyle`, and the `classBased`/`aliasOf` fields. `composeHost` is read by the three template modules. `classBased` and `aliasOf` are read by `resolveTemplateChoice`, help rendering and the prompt, as §3.2–§3.6 name. |

### 4.1 Options — every option names its consumer

| Option                          | Consumer                                                     | Behavior (per implementation)                                                                                               |
| ------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `--style` (`new`)               | `resolveTemplateChoice` → `planProject`                      | Selects `template.classBased` or refuses, per §3.3.                                                                         |
| `--style` (`generate app`)      | `resolveTemplateChoice` → `runAppCommand`                    | Same resolver and same messages. The member host then takes the discovery and transport overlays unchanged.                 |
| `--style` (`new --workspace`)   | `planWorkspace` refusal                                      | Refused. A root registers nothing.                                                                                          |
| `TemplateDefinition.classBased` | `resolveTemplateChoice`, `resolveNewChoices`                 | Present only where a class-based variant exists. Absence drives the `full-stack` refusal and suppresses the style question. |
| `TemplateDefinition.aliasOf`    | help renderers, `resolveNewChoices`, `resolveTemplateChoice` | Help annotation, prompt omission, and a one-line notice.                                                                    |

## 5. Implementation files

| File                              | Purpose                                                                                                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/templates/style.ts` (new)    | `TemplateStyle`, `TemplateRecipe`, `Showcase`, `composeHost`.                                                                                                                                                                        |
| `src/templates/rest.ts`           | Export `REST_RECIPE`. `REST_TEMPLATE` is built from `composeHost(REST_RECIPE, 'functional')` and carries `classBased: composeHost(REST_RECIPE, 'class-based')`.                                                                      |
| `src/templates/class-based.ts`    | Keep the showcase sources and export them as the REST recipe's class-based showcase. `CLASS_BASED_TEMPLATE` becomes the alias from §3.2. `CLASS_BASED_PLUGINS` stays exported and derived, for `test/unit/templates/di.test.ts`.     |
| `src/templates/microservice.ts`   | Export `MICROSERVICE_RECIPE` (no showcase in any style). Build the template and its `classBased` variant through `composeHost`. `WORKERS_SWAP` is shared by both.                                                                    |
| `src/templates/registry.ts`       | Add `classBased?` and `aliasOf?` to `TemplateDefinition`, with JSDoc.                                                                                                                                                                |
| `src/templates/choice.ts`         | `--style` resolution, the host in the result, the notice, updated `--di` text, and the stacked JSDoc moved onto its function.                                                                                                        |
| `src/seams/registry.ts`           | The §3.4 filter in `hostSeamSpecs`.                                                                                                                                                                                                  |
| `src/commands/new.ts`             | Use `choice.host`, log the notice, refuse `--workspace --style`, update help.                                                                                                                                                        |
| `src/commands/app.ts`             | Use `choice.host`, log the notice, update help.                                                                                                                                                                                      |
| `src/commands/new-interactive.ts` | The style question, prompt omission, and host resolution through `resolveTemplateChoice`.                                                                                                                                            |
| `src/constants.ts`                | `'style'` in `VALUE_FLAGS`.                                                                                                                                                                                                          |
| `src/flags.ts`                    | `'style'` in `NEW` and `GENERATE_APP`.                                                                                                                                                                                               |
| `src/templates/broker.ts`         | C5 refusal text.                                                                                                                                                                                                                     |
| Docs                              | `packages/cli/README.md`, `docs/cli.md`, `docs/decorators.md`, `docs/plugins.md`, `docs/migration-nestjs.md`, `PUBLIC_API.md` (CLI section and `--di` row), `CHANGELOG.md` (`Unreleased` → Added, plus Changed for the `--di` text). |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                            | src covered                                                                        | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/unit/templates/style.test.ts` (new)                                            | `templates/style.ts`                                                               | `composeHost(REST_RECIPE, 'class-based')` installs exactly one `DecoratorPlugin` and one `DiPlugin({ autoRegister: true })`, in that order and last. The microservice variant keeps all eight additions and the `WORKERS_SWAP`. Functional hosts contain neither plugin. Each style's showcase files are present only in that style.                               |
| `test/unit/templates/style-baseline.test.ts` (new)                                   | `templates/{rest,microservice,class-based,minimal}.ts` via `projectFiles`          | Hashes equal `template-baseline.json` for all 13 `(host, runtime)` pairs. `class-based` equals `rest --style class-based` file for file. **Negative control:** changing one wiring order fails it.                                                                                                                                                                 |
| `test/unit/style-flag.test.ts` (new) + `test/unit/templates/choice.test.ts` (extend) | `templates/choice.ts`, `commands/new.ts`, `commands/app.ts`, `templates/broker.ts` | Each §3.3 row, accepted or refused, with exit code `2` and the exact message. The notice is logged once for `--template class-based`. `--di` text names `--style`. `--broker redis --queue redis` on `microservice --style class-based` rewrites both wirings and emits the compose file. The C5 text is on the `rest --style class-based --broker redis` refusal. |
| `test/unit/seams/seam-registry.test.ts` (extend)                                     | `seams/registry.ts`                                                                | A class-based set containing cqrs and events excludes the command, query and events seams and includes ingress. The functional set is unchanged. `scanSeamSpecs` is unchanged in both modes.                                                                                                                                                                       |
| `test/unit/new-interactive.test.ts` (extend)                                         | `commands/new-interactive.ts`                                                      | The style question is asked for `rest` and `microservice` and skipped for `full-stack`, for an explicit `--style`, and under `--yes`. `class-based` is absent from the template choices. The broker question is asked for `microservice` + `class-based`.                                                                                                          |
| `test/unit/help.test.ts`, `test/unit/flags.test.ts` (extend)                         | `commands/new.ts`, `commands/app.ts`, `flags.ts`                                   | Help lists `--style` and annotates the alias. The inventory ↔ help gate passes in both directions.                                                                                                                                                                                                                                                                 |
| `test/unit/barrel-exports.test.ts` (existing)                                        | `src/index.ts`                                                                     | Unchanged surface.                                                                                                                                                                                                                                                                                                                                                 |
| `test/e2e/seam-probe.test.ts` (extend)                                               | the class-based microservice host end to end                                       | §3.8 assertions from a real boot. **Negative control:** removing the §3.4 filter makes the `src/cqrs` absence assertion fail.                                                                                                                                                                                                                                      |
| `test/e2e/scaffold-runs-e2e.test.ts` (extend)                                        | the same host under generated permissions                                          | Format and lint for `microservice --style class-based` and its Workers arm (via `HOSTS`); boot with generated permissions via the new `BOOTABLE_STYLED` case and its membership assertion.                                                                                                                                                                         |
| `test/e2e/workspace-e2e.test.ts` (extend)                                            | `commands/app.ts` + member overlays                                                | `generate app orders --template microservice --style class-based` in a `--transport rabbitmq` workspace type-checks from the root and formats clean.                                                                                                                                                                                                               |
| Doc gates                                                                            | `docs/migration-nestjs.md`, `docs/cli.md`                                          | `deno task check:docs` and the M38 fence gate compile the new sections.                                                                                                                                                                                                                                                                                            |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m99e-class-based-style, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:docs
deno task publish:check     # on the committed tree
deno task release:verify <version>
```

Also, because this milestone changes what `packages/cli` generates: scaffold
`microservice --style class-based` outside the suite, run `setu g` for each ingress family, repoint
at the workspace, and boot it with the generated `start` task's own permissions, not `-A` (the M63
rule).

## 8. Risks & mitigations

- **The refactor silently changes an existing template's output.** Mitigated by the §3.7 baseline,
  captured before any template edit. That hash fixture is the only evidence that "byte-identical" is
  true.
- **Plugin order in the class-based microservice triggers a resolver cycle.** The probe (§1) found
  none. The §3.8 boot arm is the regression guard.
- **The class-based microservice on Workers.** `WORKERS_SWAP` removes messaging and queue, and `job`
  then falls back to the functional shape because `queue-plugin` is not in the manifest
  (`job.ts:27`), while `DecoratorPlugin` ingress resolves MESSAGING and QUEUE from
  `CloudflarePlugin`. Verified only by type-check in this milestone. A Workers boot needs workerd
  and is recorded as unverified rather than claimed.
- **Help and inventory drift.** The `flags.test.ts` both-directions gate catches a flag documented
  but not allowed, or allowed but not documented.
- **Doc anchors.** Renaming the `docs/cli.md` heading breaks `docs/decorators.md`'s link.
  `check:docs` validates cross-file anchors.

## 9. Out of scope

- Class-based `full-stack`, conversion of an existing project, a `g subscription` schematic, and a
  request/reply decorator are named in §0 with their reasons.
- `setu add` inserting a provider above `RuntimePlugin()` (`add.ts:229-235`) is cosmetic, since the
  kernel orders by dependency. It is not changed here.

## 10. Design security review (completed)

This milestone crosses a trust boundary, so it carries a completed design review for the
implementation audit to check the code against: the reviewed flow, the assets and attackers, the
threat→resolution table, and the obligations the audit must meet. (A section that only lists what a
review must still cover is a requirement for one, not a review; this section records the review.)

### 10.1 Reviewed flow

1. **Name → path write sink.** Every name-taking verb derives `deriveNames(raw).kebab` and joins it
   into a filesystem path: the `new` project directory (`joinPath(dir, kebab)`), the `generate app`
   and `adopt` member directory (`joinPath(MEMBERS_DIR, kebab)`), and the artifact file name
   (`src/controllers/<kebab>.routes.ts`). The name is the only user-influenced input that reaches a
   write in this CLI.
2. **Class-based ingress host.** `composeHost(recipe, 'class-based')` adds
   `DecoratorPlugin({
   ingress })` and `DiPlugin`. Generated ingress artifacts
   (command/query/event/job handlers) register as decorated classes and receive payloads from the
   `CqrsPlugin` / `EventsPlugin` / `QueuePlugin` buses. In the scaffolded default those are
   in-memory, process-local transports.
3. **Style axis.** `--style` only selects between precomputed hosts and adds static refusal text. It
   introduces no new external input, credential, or network path.

### 10.2 Assets and attackers

- **Assets:** the host filesystem around the intended project/member directory (the scaffold must
  not write outside it); the scaffolded project's own correctness (no double-registered ingress, no
  unresolvable barrel import); the developer's time (refusals must be accurate, not silent no-ops).
- **Attackers:** this is a local CLI, not a network service. The realistic attackers are (a) a
  developer copy-pasting a malformed or hostile name onto the command line, and (b) a CI job or
  script on the same host that builds argv from untrusted data. There is no remote attacker, no
  multi-tenant boundary, and no credential in scope.

### 10.3 Threats and resolutions

| #  | Threat                                                                                                                                                                                                                                                                                                                                                                                      | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1 | A name carrying a path separator (`../sibling`, `a/b`, `..`) joins into the path and writes the scaffold into an ancestor directory or the workspace root.                                                                                                                                                                                                                                  | The shared guard `isIdentifierSafe` rejects any derived kebab that contains `/` (and, as before, any kebab with no letter or that starts with a digit). It is applied at the single `deriveNames` → guard site of **every** name-taking verb — `new`, `generate app`, `generate <schematic>`, `adopt`, `library` — so no verb can regress to a weaker check. The refusal is a usage error (exit 2) before anything is planned, and the existing overwrite preflight still refuses a clobber. |
| T2 | The class-based microservice registers the same ingress artifact twice — through the functional `CqrsPlugin`/`EventsPlugin` barrels and through `DecoratorPlugin({ ingress })` — duplicating delivery.                                                                                                                                                                                      | `hostSeamSpecs` drops the `COMMAND_HANDLER`, `QUERY_HANDLER`, and `EVENTS` seams in class-based mode (the §3.4 filter), so the functional barrels are never scaffolded and the ingress barrel is the single registration site.                                                                                                                                                                                                                                                               |
| T3 | A `--style` combination that is a silent no-op (unknown style; style with no template; `full-stack` + `class-based`; `class-based` + `functional`; `--workspace` + `--style`) is accepted and scaffolds the wrong thing.                                                                                                                                                                    | `resolveTemplateChoice` refuses each with a message that names the fix (exit 2). The workspace root refuses `--style` in `planWorkspace` before any template resolution.                                                                                                                                                                                                                                                                                                                     |
| T4 | The refactor silently changes an existing template's output (a published artifact).                                                                                                                                                                                                                                                                                                         | The §3.7 byte-identity baseline, captured before any template edit, asserts the file set and every hash for all four existing templates.                                                                                                                                                                                                                                                                                                                                                     |
| T5 | A name that passes every rule above but is not a legal filename component — a NUL byte (`a·b`), or one over the 255-byte component ceiling — reaches the filesystem, which rejects it mid-flight (`TypeError: file name contained an unexpected NUL byte`, `File name too long (os error 36)`) as an error nothing up to the CLI entry point catches: an uncaught rejection, not a refusal. | The shared guard also refuses any derived kebab carrying a control character and any kebab over 255 UTF-8 bytes, before any filesystem access. Every name-taking verb inherits the check at the same single `deriveNames` → guard site.                                                                                                                                                                                                                                                      |
| T6 | A refused name is quoted verbatim into the refusal message, so a name carrying a CRLF forges a standalone line in the rendered output (`INJECTED: scaffold complete`).                                                                                                                                                                                                                      | Every refusal renders the echoed name through `escapeName`, which turns control characters into their `\uXXXX` escapes: the message stays one line and still shows what was typed.                                                                                                                                                                                                                                                                                                           |

### 10.4 Obligations the implementation audit must meet

The audit (`.roo/skills/security-audit/SKILL.md`) drives each of these with a positive control, in a
fresh independent subtask, and records the PR audit block:

1. **Name traversal is refused (T1).** `new ..`, `new .`, `new ../sibling`, `new ../../..`,
   `new
   a/b`, and `generate app ../sibling` exit 2 with **no writes**. Positive control:
   `new shop` and `generate app orders` still scaffold (exit 0).
2. **Single ingress registration (T2).** A booted `microservice --style class-based` host delivers
   each generated ingress family (command, query, event, job) **exactly once**, and the functional
   `src/cqrs` / `src/events` barrels are absent. Positive control: the root HTTP route still answers
   200.
3. **Style axis refuses every silent no-op (T3).** Each of the five combinations in T3 exits 2 with
   the named fix. Positive control: a valid combination (`rest --style class-based`) scaffolds.
4. **Negative controls.** Revert the §3.4 seam filter → obligation 2's double-delivery probe fails.
   Revert the §3.3 style axis → obligation 3's refusal probe fails. Restore both; tree clean.
5. **Defect-class sweep.** All fifteen recurring classes, each applied (with probe) or N/A (with
   reason).
6. **Filesystem-illegal names are refused (T5).** `new` with a NUL-byte name and with an over-long
   name each exit 2 with **no writes** — on a real filesystem the pre-fix behavior was an uncaught
   rejection. Positive control: a 255-byte name still scaffolds (exit 0).
7. **Refusals stay one line (T6).** A refused name carrying a CRLF renders with the CR/LF escaped —
   no standalone forged line in the output. Positive control: an ordinary refused name renders as
   one line.

## 11. Code-review corrections (2026-09-25)

Recorded here rather than folded into the sections above, so the design as planned stays readable
beside what review changed.

- **T1 named only `/`.** `\` is a path separator on Windows and Deno honours it there, so
  `setu new ..\sibling` escaped the target directory on that platform. The path rules now refuse
  both, plus the exact segments `.` and `..`.
- **T5 bounded the kebab, not the file name.** A schematic appends a suffix (`.controller.ts`), so a
  245-byte name passed the guard and `setu g controller` then died on an uncaught
  `File name too long (os error 36)` from the overwrite probe — the T5 defect, still live for the
  verb that appends. `generate` and `generate library` now refuse a planned file name over 255 bytes
  before `--dry-run` and before any filesystem access.
- **`new` inherited the identifier rules.** Reusing `isIdentifierSafe` for the project name refused
  `setu new 3d-shop` and `setu new 2048`, which scaffolded before this milestone, with no CHANGELOG
  entry. A project directory is never an identifier, so `new` runs the path rules alone
  (`isPathSegmentSafe`); every verb that generates source still runs both.
- **The control-character rule failed `deno task lint`** (`no-control-regex`) and covered only C0
  and DEL. It is now the Unicode `Cc` category, which adds C1 (`U+0085` is a line break to several
  terminals), and `escapeName` also escapes `U+2028`/`U+2029`.
- **§3.3's full-stack row was implemented for `class-based` only.**
  `--template full-stack
  --style functional` was accepted with no effect while the CHANGELOG said
  `--style` is refused on `full-stack`; it is now refused for either value.
- **§3.2's `generate app --help` annotation was not implemented** — that usage listed `class-based`
  as a bare peer. It now annotates the alias from the registry, and both help renderers are
  asserted.
- **Punctuation reached generated source.** `g service a:b` emitted `class A:bService`, and `x'y`
  closed the `@Injectable` token literal early. A generating verb now requires every derived form to
  match `\p{ID_Start}\p{ID_Continue}*`, and `new` requires the kebab to match the portable segment
  `[\p{L}\p{N}][\p{L}\p{M}\p{N}.-]*` — both allowlists, which subsume the separator, dot-segment and
  control-character refusals above.
- Dead surface removed: `REST_SEAMS`/`REST_PACKAGES` and `CLASS_BASED_SHOWCASE_FILES`, which the
  refactor left with no reader.
