# Milestone 70h — CLI scaffold (`@setu-ts/cli`, `@setu-ts/common`, `@setu-ts/runtime`, starters)

> **Status:** Planning. Branch: `feat/m70h-cli-scaffold`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

The alpha.8 smoke programme built a three-service monorepo and a full-stack SSR project against the
**published** packages and found 22 defects in what `setu` writes. They share one shape: **a
generated file sits outside every check path the generated project actually runs.** A scaffolded
`full-stack` project cannot be started by following its own README (X5-3); a pristine one fails its
own `check:app` on a cold checkout (X5-4); a `--transport rabbitmq` workspace fails its own
`deno fmt --check` on five files before anything is edited (X2-4); a Workers project's
`deno task
start` binds nothing and exits `0` (X9-7); every post-response task on Workers is
silently dropped (X9-1). This milestone repairs what the CLI emits and extends
`packages/cli/test/e2e/scaffold-runs-e2e.test.ts` — the M63 boot gate — to cover the targets and
flags that had none, which is why the ROADMAP calls this the workstream that "amortizes best".

Three scope calls were taken by the maintainer at plan time and each widens the ROADMAP's stated
`(cli, starters)` boundary (§2, C1–C3): **E8** (fold `src/routes/` into `src/controllers/`) is
folded in here rather than left in M70n; **D3** (`setu add <plugin>`) is built rather than deferred;
and **B1** is closed completely with a new optional `IRuntimeServices.onSignal?` seam in `common`
implemented across the four runtime adapters, rather than only its two CLI-side halves.

- **In scope:** all 22 register rows assigned to M70h — X2-3, X2-4, X2-7, X4-10, X5-2, X5-3, X5-4,
  X5-8, X9-1, X9-3, X9-4, X9-7, X9-9, A2, A3, B1, D1, D2, D3, D5, D6, E4 — plus **E8**, reassigned
  here from M70n. The `common` + `runtime` `onSignal` widening that B1 needs. The scaffold-boot gate
  extensions that keep every one of them fixed.
- **NOT this milestone:** A1 (generated indicator name colliding with a plugin's own) and F2/X4-4
  (the seam scanner adopting a hand-written file) are **M70g**, which owns collisions — E8 removes
  the `routes/` directory F2 fires in, but the ownership-marker fix is M70g's. D4 (generated
  artifacts constructing with no arguments) is **M70d**, which owns the factory arm on the
  registration types; A2 here makes `health-indicator` mode-aware without touching how it is
  constructed. C1/C2/C3 (validation state key, `IMMUTABLE_PATTERN`, `ValidationPlugin` error format)
  are **M70n**'s doc sweep. X9-2, X9-5, X9-8 are **M70l**. E1/E2/E3/E5 are **M70n**.
  `app.start({
  gracefulShutdown: true })` — the finding's "better still" option, which would move
  the signal handler into the kernel — is deferred to **M40**, named in §9.

## 1. Contracts verified from SOURCE (not names)

| Reference                           | Source (file:line)                                                                                                                      | Verified surface / fact                                                                                                                                                                                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IRuntimeServices.exit`             | `packages/common/src/runtime.ts:346`                                                                                                    | `exit(code?: number): never` — **already committed**, so B1's `Deno.exit()`/`process.exit()` touch is gratuitous, not a gap. Implemented in all four adapters; Workers throws (`cf-runtime.ts:59-60`).                                   |
| `IRuntimeServices` optional members | `packages/common/src/runtime.ts:349,352,362`                                                                                            | `fs?`, `workers?`, `dns?` — the three-precedent pattern for adding an OPTIONAL member omitted on a runtime that cannot serve it. `onSignal?` follows it exactly.                                                                         |
| Deno runtime host seam              | `packages/runtime/src/adapters/deno/deno-runtime.ts:30,193`                                                                             | `exit(code?: number): never` on the injectable `host`, wired at `:193`. `onSignal` gets the same treatment — a host member, so it is unit-testable without sending a real signal.                                                        |
| Node runtime host seam              | `packages/runtime/src/adapters/node/node-runtime.ts:61-65,87,141,216`                                                                   | `mods.proc` carries `version`, `env`, `exit`. `process.on` is reachable from the same module object.                                                                                                                                     |
| Bun runtime host seam               | `packages/runtime/src/adapters/bun/bun-runtime.ts:11-13,48,182,264`                                                                     | The file's own comment records that `Bun.hostname`/`Bun.exit` **do not exist** and were `undefined` at runtime — so any `onSignal` implementation must be probed against a real Bun, not inferred from the namespace.                    |
| Workers runtime                     | `packages/runtime/src/adapters/workers/cf-runtime.ts:59-60`                                                                             | `exit` throws. An isolate is evicted, never signalled → `onSignal` is **omitted** on this platform, matching `fs?`/`workers?`/`dns?`.                                                                                                    |
| `SeamSpec`                          | `packages/cli/src/seams/seam-spec.ts:34-87`                                                                                             | `{ schematic, dir, suffix, importSymbols, barrel, exports, requiresPlugin?, renderBarrel }`. `renderBarrel` takes the full `SeamArtifacts` record, not one name list — which is what lets ONE barrel read two kinds. E8 depends on this. |
| Two-spec-one-directory precedent    | `packages/cli/src/seams/services.ts` (`FUNCTIONAL_SERVICES_SEAM`, `SERVICES_SEAM`)                                                      | Both declare `dir: 'src/services'` and `barrel: 'src/services/index.ts'`, selected by `scanSeamSpecs`. E8 is this pattern applied to controllers — an existing mechanism, not a new one.                                                 |
| `scanSeamSpecs` mode selection      | `packages/cli/src/seams/registry.ts:94-98`                                                                                              | Swaps in the functional service spec when `generatorMode(installed) !== 'class-based'`. The registry, not the scanner, decides which spec describes a family. A2 and E8 extend this map.                                                 |
| `generatorMode` consumers           | `packages/cli/src/utils/generator-mode.ts:22`; read by `schematics/module.ts:135`, `schematics/service.ts:119`, `seams/registry.ts:94`  | **Exactly three readers.** `health-indicator` is not one of them — A2 confirmed from source, not from the finding.                                                                                                                       |
| `generateHealthIndicator`           | `packages/cli/src/schematics/health-indicator.ts:34`                                                                                    | Emits `export class ${names.pascal}HealthIndicator implements IHealthIndicator` unconditionally. `IHealthIndicator` is an interface, so `{ name, check }` satisfies it — the class is the CLI's choice, not the contract's.              |
| `SchematicMetadata`                 | `packages/cli/src/schematics/registry.ts:118-135`                                                                                       | `{ factory, requiresPlugin?, alternative? }`. `alternative` is `{ schematic, why }` and is used **once** — on `controller` (`:166-167`). E8 deletes that entry, because the directory it redirects to stops existing.                    |
| `controller` gate                   | `packages/cli/src/schematics/registry.ts:166`                                                                                           | `requiresPlugin: 'decorator-plugin'`. E8 removes it: with a functional spec sharing the directory, an ungated `g controller` emits `registerUserRoutes` instead of source whose import cannot resolve (the M34b defect).                 |
| `migration` seam absence            | `packages/cli/src/seams/registry.ts:23-26`                                                                                              | Deliberate, and the stated reason is that **no plugin in the repository calls `ctx.cli.register`**, so `setu db:migrate` does not exist and there is no site to wire into. D5's fix must not contradict this (§3.7).                     |
| `npmBuildScript`                    | `packages/cli/src/templates/registry.ts:203`; declared `templates/full-stack.ts:145`; read `templates/project-files.ts:843-845,937,951` | Read into `package.json` `scripts` ONLY. Confirmed X5-3: the Deno task block never sees it.                                                                                                                                              |
| Deno task block                     | `packages/cli/src/templates/project-files.ts:1055-1058`                                                                                 | `tasks: { start: …, ...host.extraTasks }`. `full-stack`'s `extraTasks` is `FULL_STACK_CHECK_TASK` (`templates/full-stack.ts:133`) — `check:app` alone. No `build`, no `install`.                                                         |
| `nodeModulesDir` emission           | `packages/cli/src/workspace/root-manifest.ts:33` (`NODE_MODULES_DIR`); `project-files.ts:1048`                                          | Emitted by the workspace ROOT only, and a member is refused it by Deno. A **standalone** `--template full-stack` project gets neither. Confirms X5-4.                                                                                    |
| Boot gate coverage                  | `packages/cli/test/e2e/scaffold-runs-e2e.test.ts:39,42,116`                                                                             | `BOOTABLE = ['rest', 'microservice', 'class-based']`; `full-stack` is in `HOSTS` (formatted/linted/checked) but excluded from the only loop that boots. Confirms X5-3's "the one template that cannot boot is the one the gate skips".   |
| Standalone port literal             | `packages/cli/src/templates/project-files.ts:417-425`                                                                                   | `portExpression = port === undefined ? '3000' : port.symbol` → a standalone project emits the literal `app.start({ port: 3000 })`. Confirms X4-10.                                                                                       |
| `TemplateManifest.envVariables`     | `packages/cli/src/templates/registry.ts:181`                                                                                            | Already exists (M67). X4-10's fix needs no new manifest field — a `PORT` entry plus a `Deno.env` read in `serveEntry`.                                                                                                                   |
| Generated `.gitignore`              | `packages/cli/src/templates/project-files.ts:1034-1037`                                                                                 | `node_modules/` (non-Deno) + `coverage/` + `.wrangler/` (Workers) + the env file. **No `fmt`/`lint` exclude anywhere** — confirms D2.                                                                                                    |
| Generated `wrangler.toml`           | `packages/cli/src/templates/project-files.ts:1139-1161`                                                                                 | `compatibility_date = "2025-09-01"`, commented `[[kv_namespaces]]` and `[[r2_buckets]]` only, then `host.wranglerToml`. Confirms X9-9: two binding types of seven.                                                                       |
| Workers npm manifest                | `packages/cli/src/templates/project-files.ts:892,929-952`                                                                               | `{ wrangler: '^4.0.0' }` and `{ dev, deploy }` scripts. **No `typescript`, no `@cloudflare/workers-types`, no `check` script** — confirms X9-4.                                                                                          |
| k8s probe rendering                 | `packages/cli/src/workspace/k8s.ts:125-133,226`                                                                                         | `tcpSocket` on both probes plus a comment telling the developer to switch to `httpGet: /ready` "once it does" register HealthPlugin. Confirms X2-7 — and the template is an argument the generator already holds.                        |
| Class-based showcase paths          | `packages/cli/src/templates/class-based.ts:38-39,100-101`                                                                               | `src/greeting-service.ts` / `src/greeting-controller.ts` at `src/` root, imported by explicit path. Confirms E4.                                                                                                                         |
| `app.start` in the config module    | `packages/cli/src/templates/project-files.ts:626`                                                                                       | `await app.start()` with no port — the Workers/no-socket path. Distinct from `serveEntry`; the port fix must not touch it.                                                                                                               |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                | Resolution (picked side)                                                                                                                                                                                    | Doc deliverable (same PR)                                                                                                       |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `ROADMAP.md` scopes M70h as "(`cli`, starters)" while listing B1, whose register row names `cli`, `common`, `runtime`.                                                                                                                  | **Maintainer's call at plan time: include the seam.** M70h widens `common` with `IRuntimeServices.onSignal?` and implements it in `runtime`. The workstream's package list was simply wrong.                | ROADMAP M70h row's package list corrected to `cli`, `common`, `runtime`, starters.                                              |
| C2 | `ROADMAP.md` assigns E8 to M70n as "maintainer-class … a decision to take, not a defect to fix", while `smoke/X1-FINDINGS.md` E8 records it as already classified a defect by the maintainer with breakage accepted and an agreed fix.  | **The finding is current; the ROADMAP line is stale.** E8 ships here, because M70h already rewrites the seam registry for A2/X5-8/E4 and a second pass would rework the same files.                         | ROADMAP: E8 moved from the M70n row to the M70h row, with the reassignment stated. `smoke/DEFECTS.md` E8 Status → closed.       |
| C3 | `ROADMAP.md` lists D3 among M70h's rows; `setu generate --help` tells the developer to "install `@setu-ts/auth-plugin`" and the register records that no command exists to do it.                                                       | **Build `setu add <plugin>`** (maintainer's call). X9-9's wrangler comments then point at a verb that exists.                                                                                               | `PUBLIC_API.md` CLI section gains the `add` verb. `packages/cli/README.md` + `docs/getting-started.md` gain it.                 |
| C4 | `packages/cli/src/seams/registry.ts:23-26` states migration has "no site to wire into" because no plugin calls `ctx.cli.register` and `setu db:migrate` does not exist — while D5 asks for a runner and a barrel.                       | **Both stay true.** The framework ships no migration runner and `migration` stays OUT of the seam registry; the CLI emits a **project-local** `src/migrations/run.ts` + a `db:migrate` task instead (§3.7). | The `seams/registry.ts` note gains a sentence distinguishing the framework seam (absent, deliberately) from the emitted runner. |
| C5 | The generated `src/discovery/services.ts` says `setu.config.ts` consumes `SERVICE_ENDPOINTS` via `ServiceDiscoveryPlugin`; `workspace/member-host.ts` deliberately installs it only for `microservice`/`full-stack` (X1 "Not defects"). | **Behaviour is right, the comment is wrong.** The header becomes conditional on whether this member installs the plugin.                                                                                    | Generated comment corrected (D6). No behaviour change; the X1 "Not defects" entry is cited in the plan so it is not re-raised.  |

## 3. Design decisions

### 3.1 One HTTP directory (E8)

- **Decision:** Three `SeamSpec`s share `dir: 'src/controllers'` and
  `barrel: 'src/controllers/index.ts'` — `CONTROLLERS_SEAM` (`.controller.ts`, gated on
  `decorator-plugin`, emits an `@Controller` class), `FUNCTIONAL_CONTROLLERS_SEAM`
  (`.controller.ts`, ungated, emits `registerUserRoutes(router)`), and `ROUTES_SEAM` (`.routes.ts`,
  ungated, the imperative escape hatch, in BOTH modes). `src/routes/` is no longer emitted.
  `scanSeamSpecs` selects between the two `.controller.ts` specs exactly as it already does for
  services. `g controller` loses `requiresPlugin` and becomes mode-aware; the
  `alternative: ROUTE_ALTERNATIVE` entry is deleted because the directory it redirects to is gone.
  The one barrel exports both `APP_CONTROLLERS` (array) and `registerGeneratedRoutes` (function).
- **Why:** This is the `services.ts` mechanism, not a new one — `renderBarrel` already takes the
  full `SeamArtifacts` "so a shared barrel can read both of its kinds". It removes the collision
  surface M60's route-vs-controller refusal exists to mitigate, makes functional and class-based
  projects structurally identical, and gives one answer to "where does an HTTP endpoint go?".
- **Test home:** `test/unit/seams/seam-registry.test.ts` (three specs, one dir, one barrel),
  `test/unit/schematics/controller.test.ts` (both shapes), `test/e2e/generate-e2e.test.ts` (the
  merged barrel type-checks and both shapes register), `test/e2e/seam-probe.test.ts` (a functional
  project's `g controller` answers 200 — the path that was gated before).
- **Breaking:** yes, to generated layout. CHANGELOG carries the migration (a directory move plus a
  barrel regeneration); the scanner already reports what it skips, so an un-migrated project
  degrades loudly.

### 3.2 `health-indicator` becomes mode-aware (A2)

- **Decision:** `generateHealthIndicator` reads `generatorMode(options.plugins)` — the fourth reader
  of a function that has exactly three today. Functional mode emits
  `export const xIndicator: IHealthIndicator = { name, check }`; class-based keeps today's class
  byte-for-byte. `HEALTH_SEAM` gains a functional sibling selected by `scanSeamSpecs`, whose barrel
  **spreads values** rather than calling `new`.
- **Why:** `health-plugin` ships with the `rest` template, so a project the CLI itself decided is
  functional gets the one class in an otherwise function-shaped project — and converting it by hand
  silently drops it from the barrel with remediation advice that loops. The barrel's own comment
  already says "Instances, not constructors".
- **Test home:** `test/unit/schematics/health-indicator.test.ts` (both shapes),
  `test/e2e/seam-probe.test.ts` (the indicator appears in `GET /health` in a functional project).
- **Note:** this does NOT fix D4 (the indicator still receives no dependencies) — that is M70d's
  factory arm. Recorded so the two are not conflated.

### 3.3 `full-stack` becomes a seam host (X5-8)

- **Decision:** Option 1 of the finding. `full-stack` hosts the ungated flat families
  (`route`/`controller`, `middleware`, `plugin`, `service`), emitting their wiring **through
  `appFactory`** the way M61 did for the minimal host — `AppFactoryRenderContext` already carries a
  render hook (`templates/registry.ts:118`), which is how `TemplateHost.plugins` stays empty. The
  seam directories stay at `src/`, and `check:app`'s glob widens to reach them.
- **Why:** Option 2 (refuse the schematics) would make `full-stack` the one template where
  `setu generate` does not work, and the README already tells the developer to run it. The generator
  keys off the installed plugin set, so it cannot know the template left it out — the fix belongs on
  the template side.
- **Test home:** `test/unit/full-stack-template.test.ts` (seam files + wiring emitted),
  `test/e2e/template-e2e.test.ts` (a generated route in a full-stack project answers 200, and a
  deliberate type error in a generated service is CAUGHT by `check:app`).
- Also fixes the barrel's remediation text, which blames an old scaffold for something the current
  template never emitted.

### 3.4 The class-based showcase moves into the seam directories (E4)

- **Decision:** `src/greeting-service.ts` → `src/services/greeting.service.ts` and
  `src/greeting-controller.ts` → `src/controllers/greeting.controller.ts`, wired through the seam
  barrels rather than by explicit path in `setu.config.ts`.
- **Why:** A developer following the scaffold's own example puts their next service where the
  showcase is, which is the wrong place. Moving it also means the showcase exercises the same
  barrels every generated artifact uses — so a broken seam fails the pristine scaffold, not only a
  generated one.
- **Test home:** `test/unit/templates.test.ts` (paths + no explicit-path imports),
  `test/e2e/scaffold-runs-e2e.test.ts` (`class-based` still serves `/greetings` from a pristine
  scaffold).

### 3.5 The full-stack project can be built and booted (X5-3, X5-4)

- **Decision:** A template declaring `npmBuildScript` on a Deno target emits `install`
  (`deno install --allow-scripts`) and `build` (`deno task install && deno run -A npm:<script>`)
  tasks, `start` becomes `deno task build && <existing start>`, and the manifest gains
  `"nodeModulesDir": "auto"`. The condition is the one that already drives `npmBuildScript`, so no
  new manifest field. `full-stack` joins `BOOTABLE`.
- **Why:** These are the four pieces `apps/full-stack/deno.json` already carries and
  `project-files.ts` never emits — the repo's own runnable counterpart is the reference. The fix and
  its gate are the same change: the boot gate needs the build step before it can include the
  template.
- **Test home:** `test/unit/templates/project-files.test.ts` (all four emitted),
  `test/e2e/scaffold-runs-e2e.test.ts` (`full-stack` in `BOOTABLE`, booted and requested), plus a
  **cold-checkout** case that deletes `node_modules`/`deno.lock` before `check:app` — the M37c trap,
  which a warm run cannot see.

### 3.6 The config callback regains excess-property checking (X5-2)

- **Decision:** Option 1. The template emits an **annotated** resolver rather than an inline
  callback: `const resolve = (config: IConfigService): FullStackStarterOptions => ({ … });` passed
  as `createFullStackAppFromConfig(build, resolve)`. No starter API change.
- **Why:** TypeScript does not apply excess-property checking to an object literal returned from a
  contextually-typed callback, which is why `sessionn: {…}` type-checks, boots, and logs nothing. An
  annotated position restores it. M61 recorded this exposure for the `di` arm and filed it out of
  scope; this closes it for every arm at once, including the nesting mistake (`drizzleInstance` one
  level too high) that cost the smoke run a startup crash.
- **Test home:** `test/e2e/template-e2e.test.ts` — the M61 probe-module pattern, asserting a
  misspelled arm is now a **compile error** in the generated project. Verified to discriminate by
  restoring the inline callback.
- **Not doing** the finding's option 3 (runtime key validation): with the annotated return the
  compiler catches it, and a second mechanism would be two sources of truth.

### 3.7 Migrations get a project-local runner, not a framework one (D5)

- **Decision:** The `migration` schematic emits its stub **plus** a managed `src/migrations/run.ts`
  runner and a `db:migrate` task in the project's `deno.json`. `migration` stays OUT of
  `SEAM_REGISTRY`.
- **Why:** `seams/registry.ts:23-26` is right that the FRAMEWORK has no site to wire into — no
  plugin calls `ctx.cli.register`. But that is an argument against a framework seam, not against the
  CLI writing a runner into the project, which is exactly the file the smoke run had to hand-write
  in every member. Keeping the seam registry unchanged keeps that note honest (C4).
- **Test home:** `test/unit/schematics/migration.test.ts` (runner + task emitted, ordering by
  filename), `test/e2e/generate-e2e.test.ts` (`deno task db:migrate` type-checks and runs against
  the memory adapter).

### 3.8 The Workers target becomes buildable, checkable and runnable (X9-1, X9-4, X9-7, X9-9)

- **Decision, four parts, all in the Workers arm of `project-files.ts`:**
  1. **X9-1** — the scaffolded `src/index.ts` imports `waitUntil` from `cloudflare:workers` and
     threads it as a second parameter: `createApp(env, waitUntil)`, with `setu.config.ts` taking
     `(env = {}, waitUntil?)` and spreading it into `CloudflarePlugin`. This is the pattern the
     smoke run verified works, and it keeps the unresolvable specifier **out of `setu.config.ts`**,
     which `setu` itself must load under Deno.
  2. **X9-4** — emit `typescript` + `@cloudflare/workers-types` devDependencies and a
     `"check": "tsc --noEmit"` script; the `tsconfig.json` already emitted finally has a consumer.
  3. **X9-7** — the Deno `start` task becomes `deno serve src/index.ts` for this target. Deno's own
     warning names the fix.
  4. **X9-9** — the emitted `wrangler.toml` comments all seven binding kinds (KV, R2, D1, Queues
     producer **and** consumer with `max_batch_timeout = 0`, Durable Objects with their
     `[exports.*]` stanza, `[triggers] crons`), each naming the plugin option that reads it and, for
     Durable Objects, that the class must be exported from your own `src/index.ts`.
- **Why:** The CLI already pays for `compatibility_date = "2025-09-01"` precisely so the `waitUntil`
  import is available (its own source comment says so) and then threads only `env` — it should wire
  the seam it bought. The other three are the same class as X5-4 and A3: generated code outside
  every check path the project runs.
- **Test home:** `test/unit/templates/project-files.test.ts` (all four),
  `test/e2e/scaffold-runs-e2e.test.ts` Workers arm (`tsc --noEmit` passes on a pristine scaffold
  including a README-shaped Durable Object class), and a **real workerd** check in `apps/cloudflare`
  asserting a `waitUntil` task actually lands — the M52b/M59 precedent, since no fake can prove the
  isolate extended its lifetime.

### 3.9 `setu commands` survives a binding-backed Workers config (X9-3)

- **Decision:** The command-discovery path passes a **proxy `env`** whose every property read
  returns a structurally-valid inert stub (a `Proxy` with a `get` trap returning an object carrying
  the union of the shapes the binding guards check — `prepare`/`batch`, `get`/`put`/`list`,
  `idFromName`/`get`, `send`). If construction still throws, the failure is caught and reported as
  "plugin commands are unavailable in this project because `createApp()` needs platform bindings",
  naming the thrown message as a cause rather than surfacing a binding error the developer cannot
  act on.
- **Why:** Every documented binding-backed composition constructs eagerly in the plugin list,
  because those options are read before any application exists. The binding is absent because the
  CLI passed no env, not because `wrangler.toml` is wrong — so the current error is correct and
  useless. Both halves are needed: the proxy fixes the documented compositions, the catch keeps any
  other eager construction from breaking every plugin-contributed verb.
- **Test home:** `test/unit/plugin-commands.test.ts` (proxy satisfies each guard; a throwing
  `createApp` reports the framed message), `test/e2e/template-e2e.test.ts` (`setu commands` on a
  Workers scaffold wired with D1 + a session store exits 0).

### 3.10 `--transport` reaches the queue, and the transport renderer formats (X2-3, X2-4)

- **Decision:** `--transport <broker>` derives `QueuePlugin({ adapter, url })` when the transport is
  one `QueueAdapterType` supports (`redis`, `rabbitmq`, `sqs`), reading the same URL the workspace
  manifest already holds; `http` and any transport the queue cannot serve leave `QueuePlugin()`
  alone. Separately, every string the transport renderer emits — `setu.config.ts` wirings,
  `README.md` prose, `k8s/README.md` bullets — is produced through the same wrapping the generated
  `fmt` config sets, and the `cqrs` barrel's array renders through `renderList` rather than on one
  line.
- **Why:** In the one template built for distributed work, background jobs were process-local: lost
  on restart, invisible to a second replica, unaffected by the broker the workspace was explicitly
  pointed at. Everything needed is already known to the CLI. X2-4 is M63's D6 reintroduced by a
  renderer that predates the emitted `fmt` config.
- **Test home:** `test/unit/workspace/transport.test.ts` (each transport → its queue adapter, and
  `http` → untouched), `test/e2e/workspace-e2e.test.ts` (a `--transport rabbitmq` workspace passes
  its own `deno fmt --check` — the case the gate did not cover), `test/e2e/generate-e2e.test.ts`
  (`g command-handler` then `deno fmt --check`).

### 3.11 Generated k8s probes use the answer the CLI already holds (X2-7)

- **Decision:** `renderDeployment` takes the member's template and emits
  `httpGet: { path: /ready, port: http }` (and `/live` for liveness) when that template installs
  `HealthPlugin` — which all four named templates do — falling back to `tcpSocket` only for a
  template-less member, with the comment kept for exactly that case.
- **Why:** The manifest is rendered per member and the template is an argument to
  `setu generate app`, so `httpGet` is expressible precisely where it is correct. As shipped the
  generator hands the developer a decision it already holds the answer to.
- **Test home:** `test/unit/workspace/k8s.test.ts` (both arms), `test/e2e/workspace-e2e.test.ts`
  (the rendered manifest's probe path matches an endpoint the booted member actually serves).
- **Note:** X2-1's interaction is real — `/ready` still answers 200 with a dead broker — but that is
  **M70c**'s row, not this one. Recorded so the two are not conflated.

### 3.12 The standalone port comes from the environment (X4-10)

- **Decision:** `serveEntry` emits `port: Number(Deno.env.get('PORT') ?? 3000)` (and the per-runtime
  equivalent) for a standalone project, and every template's `envVariables` gains a `PORT` entry — a
  development value in the ignored `.env`, an empty one in the tracked `.env.example`. The workspace
  path, which imports `SERVICE_PORT`, is unchanged.
- **Why:** `--port` is already correctly refused for a standalone project with a clear message, so
  the gap is only that the `.env` the CLI now emits (M67) cannot supply the one value the entry
  point needs — `loadConfig` runs inside `createApp()` and `main.ts` sees only the environment.
  `TemplateManifest.envVariables` already exists for exactly this.
- **Test home:** `test/unit/templates/project-files.test.ts`, `test/e2e/scaffold-runs-e2e.test.ts`
  (boot with `PORT` set to a free port and request it there).

### 3.13 `IRuntimeServices.onSignal?` closes B1

- **Decision:** `common` gains `onSignal?(signal: 'SIGTERM' | 'SIGINT', handler: () => void): void`
  — **optional**, on the `fs?`/`workers?`/`dns?` precedent (`runtime.ts:349,352,362`). Implemented
  on Deno (`Deno.addSignalListener`, with the Windows guard moving INSIDE the adapter where a
  runtime API belongs), Node and Bun (`process.on`), and **omitted on Workers**, where an isolate is
  evicted rather than signalled. Generated `main.ts` then becomes one portable body on all four
  targets, using `runtime.onSignal?.(…)`, `runtime.exit()` and the resolved logger instead of
  `Deno.exit` / `process.exit` / `console.error` / `Deno.build.os`.
- **Why:** Two of B1's four runtime touches were gratuitous — `exit()` is committed
  (`runtime.ts:346`) and a logger capability exists — and the other two are real gaps M39 named and
  deferred. The smoke run verified the rewritten entry exits **0** with a structured JSON shutdown
  line. Windows is the load-bearing detail: `Deno.addSignalListener('SIGTERM')` **throws** there, so
  the guard cannot simply be dropped.
- **Test home:** `packages/runtime/test/unit/{deno,node,bun}-runtime.test.ts` (each adapter
  registers through its injectable host seam; Deno's Windows branch omits the member),
  `packages/runtime/test/unit/cf-runtime.test.ts` (member absent),
  `packages/cli/test/e2e/shutdown-e2e.test.ts` (a scaffolded project receives a real SIGTERM and
  exits 0 with the shutdown line as JSON — the existing e2e, extended off the literal `Deno.exit`).
- **Bun caveat, from source:** `bun-runtime.ts:11-13` records that `Bun.hostname` and `Bun.exit` did
  not exist despite being in the namespace. The Bun implementation is therefore **probed against a
  real Bun** before the plan's claim is trusted, exactly as that comment demands.

### 3.14 `setu add <plugin>` (D3)

- **Decision:** A new top-level verb dispatched before the schematic registry (the `custom` / `app`
  precedent, not a `SchematicMetadata` entry, because it performs I/O and reads the target
  manifest). It resolves a short name (`auth`) or a full one (`@setu-ts/auth-plugin`) against a
  static allow-list of the framework's own packages, adds the `jsr:` pin **at the CLI's own
  `VERSION`** to the target's `deno.json` `imports` (and to `package.json` as `@jsr/…` on a
  node/bun/Workers target), and reports the `deno install` the developer should run rather than
  spawning it. `--dry-run` prints the exact edit.
- **Why:** `setu generate --help` says `guard (unavailable — install @setu-ts/auth-plugin)` and
  offers no command to do it; unlocking a gated schematic means hand-editing `deno.json`. Pinning at
  the CLI's own version is the rule `setu new` already follows, so a project's framework packages
  stay on one version. It reports rather than spawns because `deno install` on release day hits the
  same 24-hour policy as D1 — the developer needs to see the command and its flags.
- **Test home:** `test/unit/commands/add.test.ts` (name resolution, both manifest shapes, unknown
  name refused with the allow-list, idempotent re-add), `test/e2e/generate-e2e.test.ts`
  (`setu add auth` then `setu generate guard` succeeds — the gate that was previously unreachable).
- **Public surface:** yes — `PUBLIC_API.md` and both READMEs (C3).

### 3.15 Running the CLI on release day (D1)

- **Decision:** Documentation plus one emitted flag. The CLI cannot control how it is invoked, so
  every published invocation string — `packages/cli/README.md`, `docs/getting-started.md`, the root
  `README.md`, and the "Next:" hint the CLI itself prints — carries `--min-dep-age 0`. A
  `setu --version` run that fails this way is not reachable from inside the process.
- **Why:** M63/D1 fixed this for scaffolded projects (they emit `minimumDependencyAge`) but not for
  invoking the CLI, and the failure lands on exactly the day a reader is most likely to try it.
- **Test home:** `test/unit/help.test.ts` (the printed next-step string), plus M38's doc gate, which
  already type-checks the guides' fences and will see the changed command lines.

### 3.16 A frontend-build story for a Deno target (D2)

- **Decision:** A template declaring `npmBuildScript` also emits `fmt.exclude` and `lint.exclude`
  entries for its build output directory in `deno.json`, and the generated `.gitignore` gains that
  directory. This rides §3.5's condition — the same `npmBuildScript` check — so one signal drives
  all of it.
- **Why:** `deno fmt` tried to reformat a minified bundle, and the generated `.gitignore` was only
  `coverage/` plus the env file. Serving a React build is the documented reason `static-plugin`
  exists, and `full-stack` is SSR — a different architecture.
- **Test home:** `test/unit/templates/project-files.test.ts`, `test/e2e/scaffold-runs-e2e.test.ts`
  (a built full-stack project still passes `deno fmt --check` — verified to fail without the
  exclude).

### 3.17 Generated tests actually run (A3)

- **Decision:** Every template emits a `test` task (`deno test -A`, mirroring the workspace root's),
  and the module schematic's barrel re-exports the module **surface** rather than the stub symbol,
  so replacing the stub does not break the barrel and its test.
- **Why:** Rewriting a generated service — the obvious next step — broke both, and neither is
  reachable from `deno check main.ts setu.config.ts`, which is the natural command. Both files
  stayed broken through a full green run of every gate the smoke run had.
- **Test home:** `test/unit/templates/test-deps.test.ts` (task emitted by every host, asserted by
  iteration rather than by name — the M65 lesson), `test/e2e/generate-e2e.test.ts` (rewrite the
  generated service's export, then `deno task test` still passes).

### 3.18 The discovery module's comment matches its member (D6)

- **Decision:** `renderDiscoveryModule` takes whether this member installs
  `service-discovery-plugin` and emits the consuming sentence only then; otherwise the header says
  the map is exported for the member to use directly.
- **Why:** Behaviour is deliberate (`member-host.ts`, and X1 records it under "Not defects") — only
  the unconditional comment is wrong.
- **Test home:** `test/unit/workspace/discovery-module.test.ts` (both arms).

## 4. Exported surface — every symbol names its consumer

`packages/cli/src/index.ts` — **no change.** Every CLI addition is internal to `runCli` dispatch;
`setu add` is a verb, not an export. Confirmed against the current barrel (`src/index.ts`, 54 lines)
at plan time.

`packages/common/src/index.ts` — one addition:

| Exported symbol | Kind         | Consumer / real code path that READS it                                                                                                                                                              |
| --------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RuntimeSignal` | type (union) | The parameter type of `IRuntimeServices.onSignal?`; read by all three implementing adapters in `packages/runtime` and by the `main.ts` the CLI generates. Not a marker — it constrains the argument. |

`IRuntimeServices.onSignal?` is a member on an already-exported interface, so it adds no new barrel
symbol. `packages/runtime/src/index.ts` — no change: the adapters implementing it are already
exported and `createRuntimeServices` already returns the interface.

`packages/cli/src/seams/controllers.ts` gains `FUNCTIONAL_CONTROLLERS_SEAM` and
`packages/cli/src/seams/health.ts` gains `FUNCTIONAL_HEALTH_SEAM` — both module-level, both read by
`seams/registry.ts`'s `scanSeamSpecs`, neither exported from `src/index.ts` (the
`FUNCTIONAL_SERVICES_SEAM` precedent).

### 4.1 Options — every option names its consumer

| Option                                       | Consumer                                                               | Behavior (per implementation)                                                                                                                                              |
| -------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IRuntimeServices.onSignal?`                 | Generated `main.ts`; any application wanting graceful shutdown         | **Deno:** `Deno.addSignalListener`, omitted on Windows (it throws there). **Node/Bun:** `process.on`. **Workers:** member ABSENT — an isolate is evicted, never signalled. |
| `setu add --dry-run`                         | `runAddCommand`                                                        | Prints the exact manifest edit and writes nothing. Same flag semantics as `generate --dry-run`.                                                                            |
| `TemplateManifest.npmBuildScript` (existing) | §3.5 tasks, §3.16 excludes, `nodeModulesDir`, `package.json` scripts   | One signal now drives four emissions. No new field — this is the condition the finding names ("the same condition that already drives `npmBuildScript`").                  |
| `--transport <broker>` (existing)            | `workspace/transport.ts` → `MessagingPlugin` **and now** `QueuePlugin` | `redis`/`rabbitmq`/`sqs` derive a queue adapter + URL; `http` and any other leave `QueuePlugin()` bare.                                                                    |

## 5. Implementation files

| File                                                  | Purpose                                                                                                   |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `packages/common/src/runtime.ts`                      | `RuntimeSignal` + optional `IRuntimeServices.onSignal?` (§3.13)                                           |
| `packages/common/src/index.ts`                        | Export `RuntimeSignal`                                                                                    |
| `packages/runtime/src/adapters/deno/deno-runtime.ts`  | `onSignal` via the injectable host; Windows guard moves here                                              |
| `packages/runtime/src/adapters/node/node-runtime.ts`  | `onSignal` via `mods.proc.on`                                                                             |
| `packages/runtime/src/adapters/bun/bun-runtime.ts`    | `onSignal` via `mods.proc.on` — probed against a real Bun first (`:11-13`)                                |
| `packages/runtime/src/adapters/workers/cf-runtime.ts` | Member deliberately omitted; JSDoc says why                                                               |
| `packages/cli/src/seams/controllers.ts`               | `FUNCTIONAL_CONTROLLERS_SEAM`; shared dir/barrel with `CONTROLLERS_SEAM` (§3.1)                           |
| `packages/cli/src/seams/routes.ts`                    | `ROUTES_SEAM` repoints to `src/controllers`, keeps `.routes.ts` (§3.1)                                    |
| `packages/cli/src/seams/health.ts`                    | `FUNCTIONAL_HEALTH_SEAM`, value-spreading barrel (§3.2)                                                   |
| `packages/cli/src/seams/registry.ts`                  | `scanSeamSpecs` selects controller + health shapes; C4 note                                               |
| `packages/cli/src/schematics/registry.ts`             | `controller` ungated, `ROUTE_ALTERNATIVE` deleted (§3.1)                                                  |
| `packages/cli/src/schematics/controller.ts`           | Mode-aware: `@Controller` class or `registerXRoutes` (§3.1)                                               |
| `packages/cli/src/schematics/health-indicator.ts`     | Mode-aware (§3.2)                                                                                         |
| `packages/cli/src/schematics/migration.ts`            | Runner + `db:migrate` task (§3.7)                                                                         |
| `packages/cli/src/schematics/module.ts`               | Barrel re-exports the module surface (§3.17)                                                              |
| `packages/cli/src/commands/add.ts`                    | **New** — `setu add <plugin>` (§3.14)                                                                     |
| `packages/cli/src/cli.ts`                             | Dispatch `add` before the schematic registry                                                              |
| `packages/cli/src/commands/plugin-commands.ts`        | Proxy env + framed construction failure (§3.9)                                                            |
| `packages/cli/src/templates/project-files.ts`         | §3.5 tasks + `nodeModulesDir`, §3.8 all four Workers parts, §3.12 port, §3.16 excludes, §3.17 `test` task |
| `packages/cli/src/templates/full-stack.ts`            | Seam host via `appFactory` (§3.3); annotated resolver (§3.6)                                              |
| `packages/cli/src/templates/full-stack-app-files.ts`  | `check:app` glob widens to the seam directories (§3.3)                                                    |
| `packages/cli/src/templates/class-based.ts`           | Showcase moves into the seam directories (§3.4)                                                           |
| `packages/cli/src/templates/registry.ts`              | `envVariables` gains `PORT` per template (§3.12)                                                          |
| `packages/cli/src/templates/seam.ts`                  | Derive the full-stack host's seam wiring (§3.3)                                                           |
| `packages/cli/src/workspace/transport.ts`             | Queue adapter derivation + wrapped output (§3.10)                                                         |
| `packages/cli/src/workspace/k8s.ts`                   | `httpGet` probes when the template installs HealthPlugin (§3.11)                                          |
| `packages/cli/src/workspace/discovery-module.ts`      | Conditional header (§3.18)                                                                                |
| `packages/cli/src/seams/cqrs.ts`                      | Barrel array through `renderList` (§3.10, the `g command-handler` half of X2-4)                           |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                | src covered                                          | Key assertions (and the signature each call type-checks against)                                                                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runtime/test/unit/deno-runtime.test.ts`                 | `deno-runtime.ts`                                    | `onSignal('SIGTERM', fn)` registers through the injected host; the Windows branch omits the member entirely. Types against `RuntimeSignal`.                                                  |
| `runtime/test/unit/node-runtime.test.ts`                 | `node-runtime.ts`                                    | `onSignal` reaches `mods.proc.on` with both signals.                                                                                                                                         |
| `runtime/test/unit/bun-runtime.test.ts`                  | `bun-runtime.ts`                                     | Same, plus the `:11-13` lesson: the host member is asserted PRESENT, not assumed from the namespace.                                                                                         |
| `runtime/test/unit/cf-runtime.test.ts`                   | `cf-runtime.ts`                                      | `onSignal` is `undefined` — the omission is asserted, not incidental.                                                                                                                        |
| `runtime/test/integration/signal-real.test.ts` **(new)** | all four adapters' default hosts                     | Drives each adapter's DEFAULT host — the `read-stream-real.test.ts` precedent, because M55 proved every-test-injects hides a dead default.                                                   |
| `cli/test/unit/seams/seam-registry.test.ts`              | `seams/{registry,controllers,routes,health}.ts`      | Three specs share `dir`/`barrel`; `scanSeamSpecs` returns the functional controller + health specs off-mode; no spec still names `src/routes`.                                               |
| `cli/test/unit/schematics/controller.test.ts`            | `schematics/controller.ts`                           | Both shapes emitted by mode; the class shape byte-identical to today's.                                                                                                                      |
| `cli/test/unit/schematics/health-indicator.test.ts`      | `schematics/health-indicator.ts`                     | Functional emits `export const … : IHealthIndicator`; class-based unchanged; barrel spreads values.                                                                                          |
| `cli/test/unit/schematics/migration.test.ts`             | `schematics/migration.ts`                            | Runner + task emitted; migrations ordered by filename; `migration` still absent from `SEAM_REGISTRY`.                                                                                        |
| `cli/test/unit/schematics/module.test.ts`                | `schematics/module.ts`                               | Barrel re-exports the surface; rewriting the stub export leaves it valid.                                                                                                                    |
| `cli/test/unit/commands/add.test.ts` **(new)**           | `commands/add.ts`                                    | Short + full name; both manifest shapes; unknown name refused naming the allow-list; re-add idempotent; `--dry-run` writes nothing; pin equals `VERSION`.                                    |
| `cli/test/unit/plugin-commands.test.ts`                  | `commands/plugin-commands.ts`                        | Proxy env satisfies each binding guard; a throwing `createApp` yields the framed message, not the binding error.                                                                             |
| `cli/test/unit/templates/project-files.test.ts`          | `templates/project-files.ts`                         | `install`/`build`/`start` chain + `nodeModulesDir` under `npmBuildScript`; `PORT` expression; `deno serve` on Workers; seven wrangler binding kinds; fmt/lint excludes; `test` task.         |
| `cli/test/unit/full-stack-template.test.ts`              | `templates/full-stack.ts`, `full-stack-app-files.ts` | Seam files + wiring emitted through `appFactory`; annotated resolver emitted; `check:app` glob reaches the seam directories.                                                                 |
| `cli/test/unit/templates.test.ts`                        | `templates/class-based.ts`                           | Showcase at the seam paths; `setu.config.ts` carries no explicit-path showcase import.                                                                                                       |
| `cli/test/unit/templates/test-deps.test.ts`              | `templates/registry.ts`, `test-deps.ts`              | Every host emits a `test` task — asserted by iteration over the host list, not by name (M65's lesson).                                                                                       |
| `cli/test/unit/workspace/transport.test.ts`              | `workspace/transport.ts`                             | Each transport → its queue adapter + URL; `http` leaves `QueuePlugin()` bare; rendered strings within the emitted `fmt` line width.                                                          |
| `cli/test/unit/workspace/k8s.test.ts`                    | `workspace/k8s.ts`                                   | `httpGet` for a HealthPlugin template; `tcpSocket` + comment for a template-less member.                                                                                                     |
| `cli/test/unit/workspace/discovery-module.test.ts`       | `workspace/discovery-module.ts`                      | Both header arms.                                                                                                                                                                            |
| `cli/test/unit/help.test.ts`                             | `cli.ts`                                             | `add` in `--help`; next-step strings carry `--min-dep-age 0`.                                                                                                                                |
| `cli/test/e2e/scaffold-runs-e2e.test.ts`                 | the whole emitted project, per template              | `full-stack` joins `BOOTABLE` and is built + booted + requested; **cold-checkout** `check:app`; `PORT`-driven boot; a built project still passes `deno fmt --check`; Workers `tsc --noEmit`. |
| `cli/test/e2e/generate-e2e.test.ts`                      | generate → check → run                               | Merged controller barrel type-checks; `setu add auth` unlocks `g guard`; `db:migrate` runs; `g command-handler` then `deno fmt --check`; rewrite-the-stub then `deno task test`.             |
| `cli/test/e2e/seam-probe.test.ts`                        | the seam hosts                                       | A **functional** project's `g controller` answers 200 (previously gated); its generated indicator appears in `GET /health`.                                                                  |
| `cli/test/e2e/template-e2e.test.ts`                      | full-stack + Workers                                 | A misspelled starter arm is a COMPILE error (§3.6, probe-module pattern); a generated route in a full-stack project answers 200; `setu commands` exits 0 on a binding-backed Workers config. |
| `cli/test/e2e/shutdown-e2e.test.ts`                      | generated `main.ts`                                  | Real SIGTERM → exit 0 with a structured JSON shutdown line, on the portable body.                                                                                                            |
| `apps/cloudflare` smoke                                  | X9-1 against **real workerd**                        | A `waitUntil` task lands after the response — no fake can prove isolate lifetime extension (M52b/M59 precedent).                                                                             |

**Negative controls** (each observed failing, then reverted — the repo's standing bar): restore the
inline config callback (§3.6 e2e fails, everything else passes); drop `nodeModulesDir` and delete
`node_modules` (cold-checkout `check:app` fails); revert the transport wrapping
(`--transport
rabbitmq` fmt gate fails while `http` passes); remove `full-stack` from `BOOTABLE`
(the build/boot assertions vanish rather than fail — so the gate asserts membership too); replace
`onSignal` with the literal `Deno.exit` body; point `ROUTES_SEAM` back at `src/routes` (the
shared-barrel assertions fail).

**Correction — the `onSignal` control's stated failure site was wrong, and measuring it is what
showed that.** This plan claimed the literal-`Deno.exit` body would make "the shutdown e2e fail on
Node". It does not, and cannot: `shutdown-e2e.test.ts` scaffolds a default (Deno) project,
`BOOTABLE` in `scaffold-runs-e2e.test.ts` lists only templates, and **no e2e in this repository
boots a Node project at all** — so the literal Deno body passes that gate cleanly. Measured: with
the regression in place the shutdown e2e reported `ok | 1 passed (2 steps) | 0 failed`.

The control still discriminates, at the level that can see it: `project-files.test.ts` fails **6
steps** — the byte-identical-across-targets assertion and the `reaches no runtime-specific API` arm
for each of deno/node/bun. That is the honest site, because what B1 changes is the emitted source,
not the Deno run of it.

A real Node boot was investigated and is **structurally unavailable this milestone**, which is
recorded rather than left as a to-do: a `--runtime node` project resolves `@setu-ts/runtime` from
the published npm mirror (`npm:@jsr/setu-ts__runtime@^0.1.0-alpha.8`), that published version
predates `onSignal`, and npm has no import-map equivalent for `useWorkspacePackages` to repoint at
this workspace — so such a boot would fail for a reason unrelated to the code under test until the
runtime package publishes. What IS proven for Node without it: the entry is byte-identical to the
Deno one and reaches no runtime API (unit), and `buildNodeHost()` with no injection routes
`onSignal` to the real `node:process.on`, asserted by listener count (`signal-real.test.ts`) — the
M55 dead-default guard. Delivery of the signal itself is Node's contract, not this package's.

**Post-implementation review — ten defects the gates passed, recorded here because three of them
falsify claims this plan made.**

- §3.1 said E8's risk was covered because "the scanner already reports what it skips, so an
  un-migrated project degrades loudly". It does not: the scanner reads `src/controllers/`, so a file
  in `src/routes/` is never scanned and never reported. Closed with an explicit legacy-layout
  notice; the CHANGELOG sentence was corrected too.
- The same section treated a same-name `route`/`controller` pair as guarded by M60. It was not —
  that guard returned early without `decorator-plugin`, a premise M65 and this milestone had each
  invalidated — and the pair produced a `TS2300` barrel. The HTTP-path group is now checked in every
  generator mode.
- X2-4 was described as fixed "as a class rather than an instance". It reached 2 of 8 call sites,
  because the renderer took a guessed width each caller had to override. Measured at 123 columns on
  a real scaffold. The renderer now derives its own prefix, and the gate generates three artifacts
  of every family instead of one of the one family that was fixed.

Also found: the generated test could not execute on Bun or Node at all (`@std/testing/bdd` reaches
`Deno.test`); `generate` assumed Deno whenever `--runtime` was absent; a pre-A2 health indicator is
silently unregistered and was told to "regenerate", which the overwrite check refuses; the host
seams gained REQUIRED members without a breaking-change entry; `SchematicAlternative` became
unreachable; and `db:migrate` was documented three times and emitted nowhere.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m70h-cli-scaffold, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:apps        # apps/cloudflare carries the X9-1 workerd proof
deno task publish:check     # committed tree — common + runtime changed, so a publish gate is mandatory
deno task release:verify 0.1.0-alpha.8
```

## 8. Risks & mitigations

- **E8 is a breaking layout change to already-published generated output.** → CHANGELOG carries the
  migration (directory move + barrel regeneration); the scanner already reports what it skips, so an
  un-migrated project degrades loudly rather than silently. It also belongs in the alpha.9 release
  notes, not only the CHANGELOG.
- **The `common` widening collides with M70a**, which is unmerged and also edits
  `packages/common/src/index.ts` and `runtime.ts`. → Both additions are purely additive and in
  different regions; expect a trivial conflict at merge, resolved by taking both. Do not rebase onto
  M70a — this branch is cut from `main` deliberately (M70h needs nothing M70a produces).
- **Bun's `process.on` availability is assumed until probed.** → `bun-runtime.ts:11-13` records that
  the namespace lies. The guarded real-import/real-host test in
  `runtime/test/integration/signal-real.test.ts` is written BEFORE the implementation claim is
  trusted, and the plan is corrected if Bun disagrees.
- **`tsc --noEmit` on the Workers target adds an npm toolchain step CI must run.** → It runs from
  the project's own `check` script inside the existing e2e, which already does `npm install` for
  Node/Bun arms (M61). No new CI job.
- **22+3 deliverables is a large branch and the coverage bar is per file.** → Work the seven groups
  in §5 order and re-read the ANSI-stripped per-file table after each, not once at the end: M68
  shipped a REGRESSION from 96.4 → 90.3 branch that every green gate passed over.
- **A gate scoped to what its author already believed worked is the recurring failure here** (M37c's
  blank `/`, M58's skipped file, M65's dropped host). → Every e2e assertion added must be observed
  failing against the pre-fix tree, and the §6 negative-control list is the checklist for it.

## 9. Out of scope

- **`app.start({ gracefulShutdown: true })`** — the finding's "better still" option, collapsing
  `main.ts` to three byte-identical lines by moving the handler into the kernel. `onSignal` is the
  seam it would build on, so this milestone is a prerequisite rather than a competitor. Owned by
  **M40**.
- **A1** (generated indicator name colliding with one of the 15 plugin-claimed names) and
  **F2/X4-4** (the seam scanner adopting a hand-written file) — **M70g**, which owns collisions.
- **D4** (generated artifacts constructing with no arguments) — **M70d**, which owns the factory arm
  on the registration types. §3.2 makes `health-indicator` mode-aware without touching construction.
- **C1, C2, C3, E1, E2, E3, E5** — **M70n**'s decorator/validation/doc sweep.
- **X2-1** (`/ready` staying 200 with a dead broker), which §3.11's `httpGet` probes interact with —
  **M70c**, which owns health signals.
- **X9-2, X9-5, X9-8** — **M70l**, deployment and operations.
- **A migration runner in the framework** — §3.7 emits a project-local one; a `ctx.cli.register`
  based `setu db:migrate` would need a plugin to register it and no plugin does. Unowned; raise
  after alpha.9 if wanted.
