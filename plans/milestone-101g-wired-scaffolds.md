# Milestone 101g — scaffolds that are not wired (`@setu-ts/cli`, `@setu-ts/testing`, the full-stack template)

> **Status:** Planning. Branch: `feat/m101g-wired-scaffolds`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

What `setu new`, `setu add` and `setu generate` write compiles, passes every generated check, and
does not do what it is for until the developer wires it by hand — the M60 "generated code that is
wired" bar, applied to what has shipped since. Nine rows plus one deliverable with no row: in X60
every one of the eleven diagnostics sources was configured by hand because no command writes a
`diagnostics` option. Every row reproduces on `0.7.0` or rides `0.8.0` surface; none is a
regression.

**Dependencies (decided in the ROADMAP sequence).** This letter lands AFTER **M101e** and **M101f**.
From M101e it reuses `detectProject` (so `setu add`'s new wiring never edits a file outside a
detected project), `readJsonManifest`, and the `WriteOutcome` reporting; from M101f it reuses the
`devtool enable` merge rules (`factoryRefusal`'s three outcomes, the three-outcome task/import
merge) as the home of the diagnostics-option deliverable, and it does NOT decide anything about
ports: the standalone default, the devtool range and `--devtool-port` are M101f §3.4/§3.8,
referenced here and never restated.

- **In scope:** a generated `createApp()` the M91 test recipe type-checks against, plus
  `setu add testing` and a generated smoke test every fresh scaffold can run (V8-12, V8-39); a
  full-stack member whose Vite build resolves a workspace library (V8-13); `setu add` on a
  starter-composed member naming the starter arm (V8-14); `node_modules/` in every `.gitignore` that
  can acquire one (V8-15); `setu add` registering a zero-configuration plugin in BOTH styles, so
  `generate ws-route` boots (V8-31, V8-32); `g guard` composing the installed `auth-plugin` (V8-32);
  class-based `generate job` refusing without a queue (V8-33); `setu add` inserting one line without
  re-sorting and without an unused npm copy (V8-40); and the no-row deliverable — a CLI path that
  writes each installed plugin's `diagnostics` option; and a second no-row deliverable — a browser
  gate (§3.10) that verifies hydration, asset delivery and client-side navigation of the full-stack
  example AND a fresh full-stack scaffold on every merge, which M37c left manual because CI
  installed no browser.
- **NOT this milestone:** the standalone devtool port (M101f §3.8); the kernel's duplicate-plugin
  error text suggesting `override: true` (the error is the kernel's, `plugin-resolver.ts`, and the
  V8-14 remedy belongs in the CLI's message — named in §9); an auth `--mfa`/login-route schematic
  (generator gap 7's second half, no finding); the dev runner keeping healthy siblings up when one
  member exits (decided in §3.6: fail-fast stays).

## 1. Contracts verified from SOURCE (not names)

| Reference                                          | Source (file:line)                                                                                                                                                                                                                                                                    | Verified surface / fact                                                                                                                                                                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createTestApp` app arm                            | `packages/testing/src/test-app.ts:56-82,158`                                                                                                                                                                                                                                          | `TestAppFromApp.app: IKernelApplication`; `without?`/`overrides?`; returns `Promise<IKernelApplication>`                                                                                                                                                         |
| `IKernelApplication`                               | `packages/kernel/src/application/application.ts:191`; exported `packages/kernel/src/index.ts:13`                                                                                                                                                                                      | `extends IApplication` with `inject`, `unregister`, `hasPlugin`                                                                                                                                                                                                  |
| Generated factory return types                     | `packages/cli/src/templates/project-files.ts:322-324,396,484`                                                                                                                                                                                                                         | plugin-list path `export function createApp(…): IApplication`; starter path `Promise<IApplication>`; the type import is `IApplication, IPlugin` from `@setu-ts/common` — the V8-12 mechanism                                                                     |
| `createApplication` and the starters' return types | `packages/kernel` (`createApplication` returns `IKernelApplication`); `packages/starters/*/src/app.ts:57,78,93`; `full-stack-starter/src/from-config.ts:134-137`                                                                                                                      | every factory the generated config calls already returns `IKernelApplication`, so the annotation is the only thing that narrows it                                                                                                                               |
| `kernel` is pinned by every scaffold               | `packages/cli/src/templates/project-files.ts:837`                                                                                                                                                                                                                                     | `const packages = new Set<string>(['common', 'kernel'])` — importing `IKernelApplication` from `@setu-ts/kernel` adds no dependency                                                                                                                              |
| `@setu-ts/testing` package                         | `packages/testing/deno.json:1-10`                                                                                                                                                                                                                                                     | depends on `common` + `kernel` only; exports `./src/index.ts`                                                                                                                                                                                                    |
| `ADDABLE`                                          | `packages/cli/src/commands/add.ts:57-96`                                                                                                                                                                                                                                              | 38 rows; no `testing`                                                                                                                                                                                                                                            |
| `withDependency`                                   | `packages/cli/src/commands/add.ts:154-175`                                                                                                                                                                                                                                            | re-serialises the whole map SORTED (`:171-173`) under a comment claiming the emitters sort theirs                                                                                                                                                                |
| `jsrImports` / `frameworkPackages` order           | `packages/cli/src/templates/project-files.ts:829-870`                                                                                                                                                                                                                                 | insertion order (`common`, `kernel`, `runtime`, then plugins in list order); NEVER sorted — so `withDependency`'s sort rewrites every line (V8-40, first half)                                                                                                   |
| Deno-target `package.json`                         | `packages/cli/src/templates/project-files.ts:1412-1418`                                                                                                                                                                                                                               | a Deno project with an npm build gets `standaloneNpmFiles` — a `package.json` carrying ONLY the template's own npm dependencies; framework packages stay in the import map. `setu add` still writes `npm:@jsr/…` into it (`add.ts:319-325`) — V8-40, second half |
| `add`'s targets                                    | `packages/cli/src/commands/add.ts:314-325`                                                                                                                                                                                                                                            | always both `deno.json` and `package.json` when present                                                                                                                                                                                                          |
| `withIngressProviderWiring`                        | `packages/cli/src/commands/add.ts:112-119,214-246`                                                                                                                                                                                                                                    | six providers; inserts `<Symbol>(),` after `plugins: [` ONLY when the config carries the class-based ingress markers; the functional config is never wired — V8-31's mechanism                                                                                   |
| Functional config shape                            | `packages/cli/src/templates/project-files.ts:412-423,484-488`                                                                                                                                                                                                                         | `plugins: [` … one `<Symbol>(<args>),` per wiring … `...(devtool?.plugins ?? []),` — the spread line is a stable anchor present in every post-M98c config                                                                                                        |
| Zero-argument plugin factories (the §3.5 table)    | `cache-plugin.ts:78`, `sse-plugin.ts:50`, `websocket-plugin.ts:72`, `metrics-plugin.ts:39`, `health-plugin.ts:100`, `openapi-plugin.ts:75`, `realtime-backplane-plugin.ts:60-62` (default `{ transport: 'memory' }`); the six ingress providers already in `INGRESS_PROVIDER_WIRINGS` | each takes `options?` and the REST template already calls Health/Metrics/OpenApi bare (`rest.ts:44-46`)                                                                                                                                                          |
| `generateWsRoute` functional arm                   | `packages/cli/src/schematics/ws-route.ts:46-81`                                                                                                                                                                                                                                       | emits a plugin with `dependencies: ['websocket-plugin']` into the `PLUGINS_SEAM` barrel — correct once the provider is registered                                                                                                                                |
| `generateJob`                                      | `packages/cli/src/schematics/job.ts:27-59,60-97`                                                                                                                                                                                                                                      | class-based AND `queue-plugin` → decorated ingress; otherwise the functional file whose JSDoc says "The CLI does not wire this one" — so class-based without queue falls into the functional arm (V8-33)                                                         |
| Schematic gates                                    | `packages/cli/src/schematics/registry.ts:121-125,148-157`                                                                                                                                                                                                                             | `requiresPlugin?: string` is the only gate; `job` has none; `guard` requires `auth-plugin`; `ws-route` requires `websocket-plugin`                                                                                                                               |
| `generateGuard`                                    | `packages/cli/src/schematics/guard.ts:25-73`                                                                                                                                                                                                                                          | emits `const allowed = true` and raw `{ error }` JSON; never imports `auth-plugin` although the schematic is gated on it                                                                                                                                         |
| `auth-plugin` guard factories                      | `packages/auth-plugin/src/guards/*.ts:69,125`                                                                                                                                                                                                                                         | `requireAuth(): MiddlewareFunction`, `requirePermission(permission: string): MiddlewareFunction` — M57-branded, responder-aware (M70f)                                                                                                                           |
| Vite config externals                              | `packages/cli/src/templates/full-stack-build-files.ts:53-95`                                                                                                                                                                                                                          | `environments.ssr.build.rollupOptions.external = frameworkPackages` — a static `@setu-ts/*` list; nothing else is external, so a workspace library's bare specifier fails to resolve (V8-13)                                                                     |
| Library specifier and scope                        | `packages/cli/src/workspace/library.ts:43-53`; `commands/library.ts:64-82`                                                                                                                                                                                                            | `@<scope>/<name>`, scope defaulting to the ROOT DIRECTORY name and overridable per library with `--scope` — so no single prefix identifies "a workspace member"; a member's `deno.json` `name` does                                                              |
| Where X58 imported the library                     | `smoke/.../x58-platform/apps/web/app/features/auth/principal.server.ts:2`, `app/middleware/orders-client.server.ts:10`                                                                                                                                                                | both `.server.ts` modules — the SERVER build; the client bundle never saw the specifier                                                                                                                                                                          |
| Full-stack build on Deno                           | `packages/cli/src/templates/full-stack.ts:204-209`                                                                                                                                                                                                                                    | `denoCommand: 'deno run -A npm:@react-router/dev build'` — the Vite config is evaluated under Deno on that target, Node on `--runtime node`; `node:fs` is available in both                                                                                      |
| `.gitignore` emitters                              | `packages/cli/src/templates/project-files.ts:1355-1366`; `workspace/root-files.ts:206-211`                                                                                                                                                                                            | project: `node_modules/` only when `runtime !== 'deno'`, so a Deno full-stack project (which sets `nodeModulesDir: 'auto'`, `:1393-1399`) omits it; root: `coverage/` alone on a Deno workspace                                                                  |
| `planRootNodeModulesDir`                           | `packages/cli/src/workspace/root-manifest.ts:68-119`                                                                                                                                                                                                                                  | plans the root `deno.json` `nodeModulesDir: 'auto'` edit as a managed file; touches no `.gitignore`                                                                                                                                                              |
| Starter arms                                       | `packages/starters/rest-starter/src/options.ts:50-175`; `microservice-starter/src/options.ts:23-38`; `full-stack-starter/src/options.ts:29-65`                                                                                                                                        | the 28 `<arm>?: <Plugin>Options` keys the §3.4 table is built from; full-stack extends microservice extends rest                                                                                                                                                 |
| Starter detection in a config                      | `packages/cli/src/devtool/planner.ts:159`                                                                                                                                                                                                                                             | `STARTER_FACTORY_MARK = 'export async function createApp('` — the one async shape the CLI emits; the starter SYMBOL is importable by name from the config's import line                                                                                          |
| Dev runner on a failed child                       | `packages/cli/src/workspace/dev-runner.ts:153-157`                                                                                                                                                                                                                                    | `if (!status.success) { shutdown(); Deno.exit(status.code); }` — fail-fast by design                                                                                                                                                                             |
| Generated `test` tasks                             | `packages/cli/src/templates/project-files.ts:924,1139`                                                                                                                                                                                                                                | `deno test -A` (Deno, Workers) / `bun test` / `node --test`; no template emits a test file, so a fresh Deno scaffold's `deno task test` exits 1 "No test modules found" (V8-39)                                                                                  |
| `--permit-no-files`                                | `deno test --help` (Deno 2.9.6)                                                                                                                                                                                                                                                       | "Don't return an error code if no files were found"                                                                                                                                                                                                              |
| Test harness per runtime                           | `packages/cli/src/schematics/test-harness.ts:27-70`                                                                                                                                                                                                                                   | `testHarnessFor(runtime)` → `@std/testing/bdd`+`@std/expect` (Deno), `bun:test`, `node:test`+`node:assert`; `needsStdDeps`                                                                                                                                       |
| The eleven diagnostics option shapes (verified)    | see §3.9 table                                                                                                                                                                                                                                                                        | each `readonly` field list read from the owning `interfaces/index.ts` / `options.ts`                                                                                                                                                                             |
| Empty allowlists are legal                         | `scheduler-observations.ts:132` ("an empty map approves no observations"); `event-observations.ts:160`, `health-observation-collector.ts:252,289`, `queue-observation-collector.ts:198`, `span-observation-collector.ts:206` (only `> MAX` checks)                                    | a `{}` map validates; the record itself is REQUIRED where the type says so                                                                                                                                                                                       |
| `PLUGIN_HEALTH_INDICATORS`                         | `packages/cli/src/utils/plugin-claims.ts:35-70`                                                                                                                                                                                                                                       | the indicator name each installed plugin registers — the one allowlist the CLI can fill from knowledge it already holds                                                                                                                                          |
| Health-indicator and event-handler names           | `schematics/health-indicator.ts:122`; `schematics/event-handler.ts:38`                                                                                                                                                                                                                | both register under `names.kebab` — derivable from the artifact scan the command layer already performs                                                                                                                                                          |
| `devtool` parameter in the generated factory       | `packages/cli/src/templates/project-files.ts:52,438-452`                                                                                                                                                                                                                              | `devtool?: { plugins?: readonly IPlugin[]; diagnostics?: KernelDiagnosticsOptions }` — the value whose presence means "a development run"                                                                                                                        |

**Measured by the smoke run.** X58:
`TS2739: Type 'IApplication' is missing … inject, unregister,
hasPlugin` against
`createTestApp({ app: createApp() })`; `Rolldown failed to resolve import
"@x58/security"` from
`deno task build` while `deno check` passed. X57: `git add -A` staged 73,632 files after the root
grew `node_modules`; a one-line `setu add` produced a 25-line manifest diff and an unused
`npm:@jsr/setu-ts__storage-plugin` entry; `app.register(StoragePlugin(...))` on a full-stack member
crashed with `Duplicate plugin name 'storage-plugin'`. X60: `setu add websocket` followed by
`generate ws-route board` crashed the workspace at boot — "Plugin 'board-ws-route' depends on
capability 'websocket-plugin', but no registered plugin provides it" — and the runner took every
member down. X65: class-based `generate job nightly` without `queue-plugin` emitted
`src/jobs/nightly.job.ts` as a plain function. X59: `deno task test` exited 1 on all six Deno
templates.

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                | Resolution (picked side)                                                                                                                        | Doc deliverable (same PR)                                                                                                                                                                |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `add.ts:169-170` claims the emitters sort their maps; `project-files.ts:862-870` emits insertion order (recorded as M101e C5)                                           | The emitter is right (insertion order keeps the framework triple first); `withDependency` stops sorting (§3.7)                                  | The `withDependency` comment states the real rule                                                                                                                                        |
| C2 | ROADMAP V8-32 says the standalone devtool port is "fixed at 4919" with no flag                                                                                          | Owned and corrected by **M101f** (its C3); this plan only references it                                                                         | None here                                                                                                                                                                                |
| C3 | ROADMAP M101g lists `packages/testing` as a package of this letter                                                                                                      | `testing` needs NO source change: the recipe fails because the GENERATED annotation is narrow, and `setu add testing` is a CLI table row (§3.1) | ROADMAP M101g package list corrected to `cli` + the full-stack template; the row text keeps naming `testing` as the recipe's package                                                     |
| C4 | `PUBLIC_API.md` testing section and `packages/testing/README.md` show `createTestApp({ app: createApp() })` against a generated project with no note on the return type | True after §3.1 for a NEW scaffold; a pre-existing project needs the one-word edit                                                              | Both sites gain the sentence; `docs/upgrading.md` carries the edit for existing projects                                                                                                 |
| C5 | `storage-plugin` README `## Usage` says `app.register(StoragePlugin(...))`, which crashes on a starter-composed member                                                  | The README is right for a plugin-list app; the starter case needs its own sentence                                                              | `storage-plugin` README gains "on a starter-composed app, configure the `storage` arm instead"; `full-stack-starter` README's arm table is cross-linked from `setu add`'s message (§3.4) |
| C6 | `guard.ts:4-11` documents the guard as "deliberately NOT wired … a design decision rather than a gap"                                                                   | Still true of REGISTRATION (per-route); false of COMPOSITION — the body ignores the plugin the gate requires                                    | The module doc is rewritten: unwired by position, composed from `auth-plugin` by content (§3.5)                                                                                          |
| C7 | `job.ts:4-6` and the emitted JSDoc say "Functional projects keep the transport-agnostic function" — silent about the class-based-without-queue case                     | The class-based case refuses (§3.6); the functional text stands                                                                                 | Module doc gains the refusal rule                                                                                                                                                        |

## 3. Design decisions

### 3.1 The generated factory returns `IKernelApplication`; `setu add testing`; a generated smoke test (V8-12, V8-39)

- **Decision:** (a) every generated `createApp` annotates `IKernelApplication` (plugin-list path)
  and `Promise<IKernelApplication>` (starter path), importing the type from `@setu-ts/kernel`, which
  every scaffold already pins; the `IApplication` import is dropped where nothing else reads it. The
  Workers `boot`/`ensureBooted` helpers (`project-files.ts:726-792`) follow. M101f's
  `LEGACY_FACTORY_SHAPES` keeps matching the OLD `: IApplication {` text, so pre-existing projects
  are still recognised; the M101f usage check reads fragments, not the return type. The signature
  the devtool refusal PRINTS is a different matter: `EXPECTED_SIGNATURE`
  (`devtool/planner.ts:127-130`) ends `): IApplication {`, and M101f's complete edit prints it
  verbatim — so a project upgraded through `devtool enable` would be told to write the narrow
  annotation this section removes, re-creating V8-12 on exactly the path the developer followed to
  fix their project. It changes to `): IKernelApplication {` here, with the kernel type import named
  in the printed edit, and the M101f "complete edit accepted" e2e is extended so the upgraded
  project also passes `createTestApp({ app: createApp() })`. (b) `ADDABLE` gains
  `['testing', 'testing']` with a new per-row `section: 'dev'` marker: on `deno.json` it lands in
  `imports` like every other pin; on a Node/Bun `package.json` it lands in `devDependencies`. (c)
  every template emits `test/app.test.ts` using `testHarnessFor(runtime)` and
  `createTestApp({ app: await createApp() })` — the starter path's factory is async, the plugin-list
  path's is not, and `await` on a non-promise is harmless — injecting `GET /health` (`/` for the
  template-less host, which registers no health plugin) and asserting `200`, then `app.stop()`.
  `@setu-ts/testing` joins `frameworkPackages` for every socket target. The Workers target emits no
  test file (its factory needs the platform's `env` and the X65 run drove it only on real workerd)
  and its `test` task becomes `deno test -A --permit-no-files`, with the reason in the generated
  README.
- **Why:** the recipe fails for one reason — the annotation is narrower than the value — and every
  factory the config calls already returns `IKernelApplication`, so widening the annotation changes
  no runtime behaviour. A generated test is the stronger answer to V8-39 than a flag: it turns
  `deno task test` from "finds nothing" into a BOOTED proof that the scaffold composes, and it is
  the V8-12 recipe written down where the developer will copy it. The Workers exception is the one
  place the recipe cannot run under `deno test`; `--permit-no-files` there is honest rather than a
  sample that cannot execute.
- **Test home:** `packages/cli/test/unit/config-module.test.ts` (the annotation and import on every
  target), `packages/cli/test/unit/commands/add.test.ts` (`testing` → `imports` on Deno,
  `devDependencies` on Node/Bun), `packages/cli/test/unit/templates.test.ts` (the test file per
  runtime harness; Workers has none and its task carries the flag),
  `packages/cli/test/e2e/scaffold-runs-e2e.test.ts` (every bootable template: `deno task test` exits
  0 and reports one passing test; the `--runtime node`/`bun` harness files type-check through the
  existing drift check). **Negative control:** restore `IApplication` in the annotation — the
  scaffolded test fails `deno check` with the X58 `TS2739`, before it runs.

### 3.2 The full-stack Vite build resolves a workspace library (V8-13)

- **Decision:** the generated `vite.config.ts` externalises the SSR build by a function:
  `external: (id) => frameworkPackages.includes(id) || workspaceLibraries.includes(id)`, where
  `workspaceLibraries` is computed at config load by reading `../../libs/*/deno.json` with `node:fs`
  and collecting each `name` (empty when there is no workspace root or no `libs/`). The generated
  `app/README` section for the full-stack template states the boundary: a workspace library is
  importable from `.server.ts` modules and `setu.config.ts` (the server runtime resolves it through
  the workspace); a client module cannot import one, because the client bundle has no Deno
  workspace.
- **Why:** X58 imported the library from two `.server.ts` modules; Vite's SSR build met a bare
  specifier that is a Deno workspace name, not an npm package, and refused. Externalising is correct
  for the same reason the framework packages are external (`full-stack-build-files.ts:70-80`): the
  server runtime owns resolution, and bundling a copy would duplicate module state between the build
  and `setu.config.ts`. A static scope prefix was rejected because the scope is the root directory
  name and overridable per library (`commands/library.ts:64-82`); the member's own `deno.json`
  `name` is the only reliable identity, which is why the config reads it. Documenting the
  client-side limit is part of the fix, since `libs/*` invites exactly that use.
- **Test home:** `packages/cli/test/unit/full-stack-template.test.ts` (the emitted config reads
  `libs/*/deno.json` and externalises by function), `packages/cli/test/e2e/workspace-e2e.test.ts`
  (REAL: a full-stack member importing a generated library from a `.server.ts` runs
  `deno task build` to exit 0 — the X58 command — and then BOOTS and serves the route that uses the
  library). **Negative control:** restore the static array — `deno task build` fails with "failed to
  resolve import".

### 3.3 `node_modules/` is ignored wherever it can appear (V8-15)

- **Decision:** the project `.gitignore` emits `node_modules/` when `runtime !== 'deno'` AND when
  the template carries an npm build (the Deno full-stack case that sets `nodeModulesDir: 'auto'`);
  the workspace root `.gitignore` always carries `node_modules/` (a Deno root can gain a full-stack
  member at any time, and the comment at `project-files.ts:1356-1358` about noise does not apply to
  a root, which is where the directory lands). `planRootNodeModulesDir` plans a second managed-style
  edit beside the manifest: when the root `.gitignore` lacks a `node_modules/` line it is APPENDED
  (a merge, reported `updated`; an existing line is left alone), so a workspace created before this
  change is covered the first time a full-stack member is added — the exact step that created X57's
  589 MB directory.
- **Why:** both files are CLI-written and the directory is CLI-caused; the X57 harness staged 73,632
  files. Appending one line to a `.gitignore` the CLI wrote is the smallest honest merge, the same
  three-outcome rule M98c uses for tasks.
- **Test home:** `packages/cli/test/unit/templates.test.ts` (Deno full-stack project ignore has the
  line; Deno rest does not), `packages/cli/test/unit/workspace/root-files.test.ts` (root always has
  it), `packages/cli/test/unit/workspace/root-manifest.test.ts` (append when absent, no-op when
  present), `packages/cli/test/e2e/workspace-e2e.test.ts` (after the real full-stack member's
  `deno install`, `git status --porcelain` in the workspace lists no `node_modules` path — the test
  initialises a repository for this). **Negative control:** revert the project emitter — the
  full-stack standalone case lists `node_modules/` as untracked.

### 3.4 `setu add` on a starter-composed member names the arm (V8-14)

- **Decision:** `add` reads the target's `setu.config.ts`; when it contains `STARTER_FACTORY_MARK`
  and imports one of the three starter symbols, it consults a static table
  `STARTER_ARMS: Map<starterSymbol, Map<bare, arm>>` built from the 28 arms verified in §1 (REST's
  18, microservice's 4 and full-stack's 10, inherited down the chain). The pin is still written
  (harmless and makes `generate` gating see it); the "Next:" block then prints one of two sentences
  — bundled: "`<Starter>` already registers this plugin; configure its `<arm>` arm in
  `setu.config.ts` (see the starter README); `app.register(<Plugin>())` would fail with a duplicate
  plugin name" — or not bundled: "register it after the factory returns:
  `app.register(<Plugin>())`". §3.5's wiring never edits a starter-composed config (it has no
  `plugins: [` list to insert into), so the message is the whole deliverable there.
- **Why:** the starter bundles the full tier (verified from its options), `setu add` only edits
  manifests, and the plugin README's `app.register` form is right for every other composition.
  Naming the arm at the moment the developer asks for the package is the cheapest point; the
  kernel's duplicate-name error naming `override: true` is a kernel message and stays (§9).
- **Test home:** `packages/cli/test/unit/commands/add.test.ts` (iterates the 28-row table as data; a
  full-stack member adding `storage` prints the `storage` arm; adding `grpc` prints the register
  form; a plugin-list config prints neither). **Negative control:** drop the table lookup — the
  `storage` case prints nothing about the arm.

### 3.5 `setu add` registers a zero-configuration plugin in both styles; `g guard` composes `auth-plugin` (V8-31, V8-32)

- **Decision:** `withIngressProviderWiring` generalises to `withPluginWiring(config, bare)` over
  `ZERO_CONFIG_WIRINGS`: the six ingress providers plus `cache`, `health`, `metrics`, `openapi`,
  `sse`, `websocket`, `realtime-backplane` — every factory in §1 that takes `options?` or defaults
  it, asserted by a test that constructs each with no arguments inside a real kernel app and starts
  it. The insertion anchor becomes the `...(devtool?.plugins ?? []),` line every post-M98c config
  carries (functional and class-based alike), inserting `<Symbol>(),` immediately above it; the
  class-based ingress markers are no longer required. A config without the anchor (hand-written,
  starter-composed, pre-M98c) is not edited; the "Next:" block prints the one line to add. Plugins
  needing configuration (`auth`, `database`, `messaging` with a real broker, `session`, …) are never
  wired automatically; their "Next:" block prints the minimal registration with its required option
  named (`AuthPlugin({ jwt: { secret: … } })`). `g guard` emits, for the kebab name,
  `export function require<Pascal>(): MiddlewareFunction {
  return requirePermission('<kebab>'); }`
  composed from `auth-plugin`'s factory — the schematic is already gated on that plugin, so the
  import always resolves — with the JSDoc keeping the per-route guidance (C6).
- **Why:** V8-31 is the exact composition the CLI advertises — `add websocket` then
  `generate ws-route` — and it crashed the workspace because the provider was never registered in a
  functional project. The anchor line exists for precisely this purpose (the devtool spread lands
  last); inserting above it keeps the production list readable and the devtool spread last. The
  zero-config set is bounded by what boots bare, proven by the test rather than by the table's
  author. The guard's `const allowed = true` body made the only auth-gated schematic ignore the
  plugin it is gated on; `requirePermission` is M57-branded and responder-aware, so the emitted
  guard also stops answering raw JSON (X64's minor note).
- **Test home:** `packages/cli/test/unit/commands/add.test.ts` (functional and class-based configs
  both gain the line above the anchor; byte-identical when already present; an anchor-less config is
  untouched and the line is printed), `packages/cli/test/unit/schematics/guard.test.ts` (imports
  `requirePermission`; no `allowed = true`), `packages/cli/test/e2e/generate-e2e.test.ts` (REAL:
  functional `rest` project, `add websocket`, `generate ws-route board`, then BOOT and complete a
  raw RFC 6455 handshake on `/ws/board` — the X60 failure driven to success; a generated guard on a
  route answers `401` unauthenticated and `403` for a principal lacking the permission, through a
  real `AuthPlugin`), the zero-config boot table in
  `packages/cli/test/integration/zero-config-wirings.test.ts`. **Negative control:** restore the
  class-based-only markers — the functional e2e crashes at boot with the X60 message.

### 3.6 Class-based `generate job` refuses without a queue (V8-33); the dev runner stays fail-fast

- **Decision:** `SchematicMetadata` gains an optional
  `requiresPluginWhen?: (installed) => string | undefined`; `job` returns `'queue-plugin'` when
  `generatorMode(installed) === 'class-based'` and the queue plugin is absent, and
  `runGenerateCommand` applies it with the same refusal text and `setu add queue` remedy the static
  gate prints. The functional arm is unchanged. The dev runner's fail-fast on a member exit
  (`dev-runner.ts:153-157`) is KEPT, and the generated runner's comment says why: a member that
  cannot boot is a defect the developer must see, and a dependent chain is broken anyway; keeping
  siblings up would hide the failure behind a working `/health` on another port.
- **Why:** after `setu add queue` the same command emits wired, decorated ingress; before it,
  emitting a functional file into a class-based project is dead code with no hint. Refusing is what
  `guard` and `ws-route` already do. A mode-aware gate is data on the registry rather than a branch
  inside the command, so a fourth gated-by-mode schematic is a one-line entry.
- **Test home:** `packages/cli/test/unit/schematics/registry.test.ts` and `generate-command.test.ts`
  (class-based without queue → refusal naming `setu add queue`, zero writes; with queue → decorated
  ingress; functional → unchanged). **Negative control:** remove the predicate — the class-based
  fixture writes `src/jobs/<name>.job.ts`.

### 3.7 `setu add` inserts one line (V8-40)

- **Decision:** `withDependency` keeps the existing key order and inserts the new key after the LAST
  key sharing its scope prefix (`@setu-ts/` for framework pins; appended at the end otherwise), so a
  one-entry add is a one-line diff against the emitter's insertion order; when the existing keys are
  already sorted, the insertion point is the sorted position instead, so a hand-sorted map stays
  sorted. `package.json` is edited only when `detectTargetRuntime` is not `deno`: on a Deno target
  that file carries the template's own npm build dependencies and never a framework package
  (`project-files.ts:1412-1418`), so the `npm:@jsr/…` entry nothing imported is no longer written.
- **Why:** the 25-line diff came from re-serialising a sorted map over an insertion-ordered file;
  the unused npm copy came from treating every `package.json` as a dependency manifest. Both are the
  writer disagreeing with the emitter it edits.
- **Test home:** `packages/cli/test/unit/commands/add.test.ts` (a microservice manifest gains
  exactly one line; a sorted map stays sorted; a Deno full-stack project's `package.json` is
  byte-identical after `add`; a Node project's is edited). **Negative control:** restore the sort —
  the one-line assertion fails with a reordered map.

### 3.8 The no-row deliverable — a CLI path writes each installed plugin's `diagnostics` option

- **Decision:** a managed module `src/devtool/diagnostics.ts` (CLI-owned, regenerated) exporting
  `DEVTOOL_SOURCES`, one entry per installed plugin that has a diagnostics option, each of the shape
  its plugin's option type requires (§3.9 table), typed `satisfies` against the plugin's exported
  option type. It is WRITTEN by `setu new --devtool`, `setu generate app --devtool` and
  `setu devtool enable`, and REFRESHED (regenerated, `managed`) by `setu add` whenever the module
  already exists — so adding a plugin to a devtool-enabled project adds its source. The config
  consumes it through ONE line the same commands insert after the factory's opening:
  `const sources = devtool === undefined ? {} : DEVTOOL_SOURCES;`, and each wiring for a plugin with
  a source renders `<Symbol>({ ...<existing args>, ...sources.<key> })` — the spread of an absent
  key is `{}`, so a production run (no `devtool` argument) constructs the plugin exactly as before,
  and a `deno task dev` run registers every source. At scaffold time this is rendering; on
  `devtool enable` it is the same conservative textual edit §3.5 uses (the known emitted call shapes
  `<Symbol>(),` and `<Symbol>({ … }),` are rewritten; anything else is left alone and the line is
  printed), under M101f's three-outcome rules. `--dry-run` stays exact because the module is a pure
  render of (installed set × known names) and the config edit is computed from the current file.
- **Why:** X60 measured ~100 of 144 manual lines in exactly this place. The option must reach the
  plugin CONSTRUCTOR, which is why it cannot ride `main.dev.ts` (which only passes the devtool
  composition) and must be gated on the `devtool` parameter: enabling sources in production would
  schedule health and depth reads nobody consumes. A managed module keeps the allowlists in a file
  the CLI may regenerate, while the one-line spread per wiring is the only edit to the developer's
  config.
- **Test home:** `packages/cli/test/unit/devtool-sources.test.ts` (one case per plugin in the §3.9
  table: the rendered entry type-checks against the plugin's option type through a committed fixture
  `deno check` reaches, the M70m precedent), `config-module.test.ts` (the spread per wiring;
  production rendering without `devtool` unchanged), `commands/add.test.ts` (refresh when the module
  exists; untouched when it does not), `packages/cli/test/e2e/devtool-e2e.test.ts` (REAL: a `rest`
  project with `--devtool` plus `add cache`, BOOTED through `deno task dev` with credentials; signed
  `GET /v1/health` and `GET /v1/cache` return `ready`/populated sources — the X60 inspectors reached
  without a hand-written line; the same project under `deno task start` reports every source
  `disabled`). **Negative control:** drop the `devtool === undefined` gate — the production boot
  reports sources `ready`, which is the behaviour the gate exists to prevent.

### 3.9 What is written per plugin (verified from each plugin's source)

| Plugin (option key)                         | Option type and source                                                                 | Emitted entry                                                                                                                                                                                       |
| ------------------------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cache-plugin` (`diagnostics`)              | `CacheDiagnosticsOptions` — `cache-plugin/src/interfaces/index.ts:84-86`               | `{ enabled: true, alias: 'cache' }`                                                                                                                                                                 |
| `storage-plugin` (`diagnostics`)            | `StorageDiagnosticsOptions` — `storage-plugin/src/interfaces/index.ts:137-142`         | `{ enabled: true, alias: 'storage' }`                                                                                                                                                               |
| `websocket-plugin` (`diagnostics`)          | `RealtimeDiagnosticsOptions` — `common/src/diagnostics/realtime-observations.ts:45-47` | `{ enabled: true, alias: 'websocket' }`                                                                                                                                                             |
| `sse-plugin` (`diagnostics`)                | same type                                                                              | `{ enabled: true, alias: 'sse' }`                                                                                                                                                                   |
| `realtime-backplane-plugin` (`diagnostics`) | same type                                                                              | `{ enabled: true, alias: 'backplane' }` (not emitted for a `'custom'` transport, which carries no option — `realtime-backplane-plugin.ts:63-64`)                                                    |
| `events-plugin` (`diagnostics`)             | `EventsDiagnosticsOptions` — `events-plugin/src/interfaces/index.ts:60-72`             | `{ enabled: true, alias: 'events', events: { <kebab>: '<kebab>' … } }` from the scanned `event-handler` artifacts; `{}` when none, with a comment naming the key                                    |
| `scheduler-plugin` (`diagnostics`)          | `SchedulerDiagnosticsOptions` — `scheduler-plugin/src/interfaces/index.ts:165-173`     | `{ enabled: true, alias: 'scheduler', jobs: {} }` — the CLI emits no scheduler jobs; the comment names the key                                                                                      |
| `queue-plugin` (`diagnostics`)              | `QueueDiagnosticsOptions` — `queue-plugin/src/interfaces/index.ts:359-372`             | `{ enabled: true, instanceAlias: 'queue', queues: { <kebab>: '<kebab>' … } }` from scanned `job` artifacts (functional `src/jobs`; class-based ingress cannot be classified → `{}`)                 |
| `health-plugin` (`diagnostics`)             | `HealthDiagnosticsOptions` — `health-plugin/src/interfaces/index.ts:79-88`             | `{ enabled: true, indicators: { <name>: '<name>' … } }` from `PLUGIN_HEALTH_INDICATORS` of the installed set plus scanned `health-indicator` artifacts                                              |
| `config-plugin` (`diagnostics`)             | `ConfigDiagnosticsOptions` — `config-plugin/src/options.ts:154-161`                    | `{ enabled: true, keys: { <NAME>: '<NAME>' … } }` from the CLI-written `.env.example` names (template `envVariables`); `{}` when none                                                               |
| `telemetry-plugin` (`diagnostics`)          | `TraceDiagnosticsOptions` — `telemetry-plugin/src/interfaces/index.ts:214-226`         | `{ enabled: true, serviceAlias: '<project>', operations: {} }` — span names are not knowable at scaffold time; the comment names the key                                                            |
| `auth-plugin` (`authorizationDiagnostics`)  | `AuthorizationDiagnosticsOptions` — `auth-plugin/src/interfaces/index.ts:115-121`      | `{ enabled: true, roles: {}, permissions: {} }` — never derivable; emitted only when `auth-plugin` is installed AND the wiring carries an `rbac` arm, since without one the source is `unsupported` |
| `kernel`                                    | `KernelDiagnosticsOptions` — already threaded by `devtool.diagnostics`                 | unchanged                                                                                                                                                                                           |
| `sdk` `createObservedFetch`                 | an application helper, not a plugin                                                    | NOT emitted; named in the module's header comment                                                                                                                                                   |

Every entry is `enabled: true`; the gate is the `devtool` parameter, not the option.

### 3.10 A browser gate for the full-stack scaffold (no row; the M37c manual suite, committed)

- **Decision:** a Playwright suite, `apps/full-stack/browser/full-stack.browser.test.ts`, written
  with `describe`/`it` and driving a REAL Chromium through `npm:playwright` against (a) the running
  `apps/full-stack` example and (b) a `setu new --template full-stack` project scaffolded by the e2e
  helper, built with the real Vite build and booted. It asserts the eleven checks M37c ran by hand
  and recorded in `apps/full-stack/README.md`: SSR content at `/`, `/products` and `/login`;
  hydration (a client-side state change with no document reload); all eight referenced assets served
  by the framework's own static handler with `200` and the right content type; a `<Form>` submit
  performed as a client-side transition rather than a navigation; the session cookie `HttpOnly`;
  and, with JavaScript disabled, the login form degrading to a real `POST` that still answers `302`.
  The suite runs under a new root task `check:browser` and a new CI job `browser` in `ci.yml` that
  installs Chromium (`npx playwright install --with-deps chromium`) in that job ALONE — the four
  ordinary gates, `check:apps` and the compat jobs stay browser-free, so a browser is never a
  prerequisite for the suite a contributor runs. Locally the task resolves the browser from
  Playwright's own cache; absent, it exits **77** with the install command (the `check:apps` skip
  convention), and the gate is deliberately NOT in `ALLOW_SKIP`, so a CI runner without the browser
  FAILS rather than passing over it (the M37c `full-stack` precedent).
- **Why:** M37c's own lesson is that a gate which only requests what its author believed worked is
  not coverage, and the browser half has been exactly that since it shipped — eleven checks with no
  owner, re-run only when someone remembers. V8-13 (a full-stack member whose Vite build resolves a
  workspace library) is a build-path row, and the only proof a build path is RIGHT is a browser
  executing what it produced. The `v0.9.0` client-brief run (ROADMAP M104) also needs a browser
  instrument for its UI acceptance criteria; this gate is that instrument, which is why it lands in
  this letter rather than later.
- **Negative control:** abort the client entry bundle (M37c's own control) — the hydration and
  transition checks fail while the SSR checks still pass; and point the asset assertion at a bundle
  the handler does not serve — the eight-asset check fails naming the missing one.
- **Test home:** the suite IS the test; its harness (browser resolution, exit 77, the scaffold step)
  lives in `apps/full-stack/browser/harness.ts` with a unit test for the resolution decision
  (`browser present` / `absent → 77 with the install line`), since that branch is what decides
  whether the gate can go silent.

## 4. Exported surface — every symbol names its consumer

`packages/cli/src/index.ts` changes in one way: `SchematicMetadata.requiresPluginWhen?` (§3.6), an
OPTIONAL addition on a published interface (the M58 `SchematicOptions.modules` precedent). No
`common` change, no capability token, no `testing` change.

| Exported symbol                        | Kind           | Consumer / real code path that READS it                               |
| -------------------------------------- | -------------- | --------------------------------------------------------------------- |
| `SchematicMetadata.requiresPluginWhen` | optional field | `runGenerateCommand`'s gate; `printSchematics`'s availability listing |

Internal: `withPluginWiring`, `ZERO_CONFIG_WIRINGS`, `STARTER_ARMS`, `renderDevtoolSources`,
`workspaceLibraryExternals` (emitted into the Vite config), the generated `test/app.test.ts`
renderer.

### 4.1 Options — every option names its consumer

| Option               | Consumer        | Behavior (per implementation)                                                     |
| -------------------- | --------------- | --------------------------------------------------------------------------------- |
| `ADDABLE[*].section` | `runAddCommand` | `'dev'` → `devDependencies` on an npm manifest; absent → `dependencies`/`imports` |
| `requiresPluginWhen` | `generate` gate | a function of the installed set; `undefined` → ungated                            |

No new CLI flag.

## 5. Implementation files

| File                                                                                                                                      | Purpose                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/index.ts`                                                                                                               | `requiresPluginWhen` on the published metadata type                                                                                                        |
| `packages/cli/src/templates/project-files.ts`                                                                                             | §3.1 annotation and `@setu-ts/kernel` type import; the generated test; Workers `--permit-no-files`; §3.3 ignore; §3.8 `sources` line and per-wiring spread |
| `packages/cli/src/templates/full-stack-build-files.ts`                                                                                    | §3.2 function externals reading `libs/*/deno.json`                                                                                                         |
| `packages/cli/src/templates/full-stack-app-files.ts`                                                                                      | §3.2 README boundary sentence                                                                                                                              |
| `packages/cli/src/workspace/root-files.ts`, `root-manifest.ts`                                                                            | §3.3 root ignore and the append plan                                                                                                                       |
| `packages/cli/src/commands/add.ts`                                                                                                        | §3.1 `testing`; §3.4 starter arms; §3.5 `withPluginWiring`; §3.7 insertion and Deno `package.json` rule; §3.8 refresh                                      |
| `packages/cli/src/schematics/guard.ts`, `job.ts`, `registry.ts`                                                                           | §3.5 composed guard; §3.6 mode gate                                                                                                                        |
| `packages/cli/src/commands/generate.ts`                                                                                                   | §3.6 gate application                                                                                                                                      |
| `packages/cli/src/devtool/sources.ts`                                                                                                     | §3.8 `renderDevtoolSources(installed, names)`                                                                                                              |
| `packages/cli/src/devtool/planner.ts`                                                                                                     | §3.1 `EXPECTED_SIGNATURE` ends `): IKernelApplication {` and the printed edit names the kernel type import                                                 |
| `packages/cli/src/commands/devtool.ts`, `new.ts`, `app.ts`                                                                                | §3.8 module write and config edit, on M101f's merge rules                                                                                                  |
| `packages/cli/src/workspace/dev-runner.ts`                                                                                                | §3.6 comment naming the fail-fast decision                                                                                                                 |
| `packages/cli/test/fixtures/devtool-sources/*.ts`                                                                                         | §3.8 committed type fixture reached by `deno check`                                                                                                        |
| `apps/full-stack/browser/full-stack.browser.test.ts`, `apps/full-stack/browser/harness.ts`                                                | §3.10 the Playwright suite and its browser-resolution/exit-77 harness                                                                                      |
| `.github/workflows/ci.yml` (`browser` job), `deno.json` (`check:browser`), `apps/full-stack/deno.json`, `apps/full-stack/README.md`       | §3.10 the one job that installs Chromium; the task; the README's "not committed" paragraph replaced                                                        |
| `ROADMAP.md`, `PUBLIC_API.md`, `packages/testing/README.md`, `packages/storage-plugin/README.md`, `packages/cli/README.md`, `docs/cli.md` | C3–C7, the `testing` row, the devtool-sources paragraph                                                                                                    |
| `CHANGELOG.md`, `docs/upgrading.md`                                                                                                       | the annotation change for existing projects; `setu add` now wiring; `g guard` output change (behaviour change to generated output, the M58 precedent)      |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                       | src covered                                                      | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/test/unit/config-module.test.ts`                                                  | `templates/project-files.ts` (config)                            | `IKernelApplication` on every target; `sources` line and spreads under `--devtool`; byte-identical production list without                                                                                                                                                                         |
| `packages/cli/test/unit/templates.test.ts`                                                      | `templates/project-files.ts` (files)                             | `test/app.test.ts` per harness (`testHarnessFor(runtime)`); Workers task carries `--permit-no-files`; `.gitignore` rule per runtime × npmBuild                                                                                                                                                     |
| `packages/cli/test/unit/full-stack-template.test.ts`                                            | `templates/full-stack-build-files.ts`, `full-stack-app-files.ts` | function externals; README boundary                                                                                                                                                                                                                                                                |
| `packages/cli/test/unit/workspace/root-files.test.ts`, `root-manifest.test.ts`                  | `workspace/root-files.ts`, `root-manifest.ts`                    | root ignore; `planRootNodeModulesDir(contents, member)` plans the ignore append / no-op                                                                                                                                                                                                            |
| `packages/cli/test/unit/commands/add.test.ts`                                                   | `commands/add.ts`                                                | `testing` sections; 28-row starter table as data; `withPluginWiring(config, bare)` both styles / anchor-less; one-line insertion; Deno `package.json` untouched; sources refresh                                                                                                                   |
| `packages/cli/test/unit/schematics/guard.test.ts`, `job.test.ts`, `registry.test.ts`            | `schematics/guard.ts`, `job.ts`, `registry.ts`                   | composed guard; `requiresPluginWhen` for `job`                                                                                                                                                                                                                                                     |
| `packages/cli/test/unit/generate-command.test.ts`                                               | `commands/generate.ts`                                           | mode gate refusal with the `setu add queue` remedy; listing marks `job` unavailable in a class-based project without queue                                                                                                                                                                         |
| `packages/cli/test/unit/devtool-sources.test.ts`                                                | `devtool/sources.ts`                                             | `renderDevtoolSources(installed, names)` per §3.9 row; the committed fixture type-checks each entry against its plugin's option type                                                                                                                                                               |
| `packages/cli/test/unit/devtool-planner.test.ts` (extended)                                     | `devtool/planner.ts`                                             | the printed edit carries `): IKernelApplication {` and the kernel type import; a legacy `: IApplication {` factory is still recognised. **Negative control:** with the old signature restored, the upgraded-project e2e case fails `createTestApp({ app: createApp() })` with the V8-12 type error |
| `packages/cli/test/unit/devtool-refusals.test.ts`, `new-command.test.ts`, `app-command.test.ts` | `commands/devtool.ts`, `new.ts`, `app.ts`                        | the module is planned by each entry point; `devtool enable` edits recognised call shapes and prints the rest                                                                                                                                                                                       |
| `packages/cli/test/integration/zero-config-wirings.test.ts`                                     | `ZERO_CONFIG_WIRINGS` (data)                                     | every listed factory constructs with no arguments and a real kernel app starts and stops                                                                                                                                                                                                           |
| `packages/cli/test/e2e/scaffold-runs-e2e.test.ts`                                               | end to end (BOOTED)                                              | `deno task test` passes on every bootable template; the generated test exercises `createTestApp({ app })`                                                                                                                                                                                          |
| `packages/cli/test/e2e/generate-e2e.test.ts`                                                    | end to end (BOOTED)                                              | `add websocket` + `generate ws-route` boots and completes a handshake; the composed guard answers `401`/`403` through a real `AuthPlugin`                                                                                                                                                          |
| `packages/cli/test/e2e/workspace-e2e.test.ts`                                                   | end to end (BOOTED)                                              | full-stack member importing a library builds and serves; `git status` lists no `node_modules`; `add storage` on the full-stack member prints the arm                                                                                                                                               |
| `packages/cli/test/e2e/devtool-e2e.test.ts`                                                     | end to end (BOOTED)                                              | signed `/v1/health` and `/v1/cache` populated under `deno task dev`; `disabled` under `deno task start`                                                                                                                                                                                            |
| `packages/cli/test/unit/barrel-exports.test.ts`                                                 | `src/index.ts`                                                   | the one optional field; nothing else                                                                                                                                                                                                                                                               |
| `apps/full-stack/browser/full-stack.browser.test.ts` (REAL Chromium)                            | end to end (BOOTED, browser)                                     | the eleven M37c checks on the example AND a fresh `--template full-stack` scaffold; both §3.10 negative controls                                                                                                                                                                                   |
| `apps/full-stack/browser/harness.test.ts`                                                       | `apps/full-stack/browser/harness.ts`                             | browser present → runs; absent → exit 77 naming the install command; `ALLOW_SKIP` membership refused by `test/apps-gate.test.ts`                                                                                                                                                                   |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m101g-wired-scaffolds, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check
deno task release:verify 0.8.0
deno task check:browser     # §3.10 — real Chromium; exits 77 (never silently passes) when no browser is installed
```

Negative controls, each observed failing and reverted: the eight named in §3.1–§3.8 and the two in
§3.10. Controls §3.2, §3.5 and §3.8 must be run against the BOOTED project (a text assertion on the
emitted config cannot see a Vite resolution, a kernel dependency check, or which sources report
`ready`).

## 8. Risks & mitigations

- Widening the annotation to `IKernelApplication` on the Workers `boot` helpers could reach a helper
  that genuinely returns a narrower value → every factory and starter returns the kernel type (§1);
  `deno check` of the scaffold in the e2e is the proof, per target.
- `withPluginWiring` edits a developer-owned `setu.config.ts` → only above the exact anchor line the
  CLI emits and only when the factory is not already called; everything else prints the line.
- The zero-config table could name a plugin that boots bare today and gains a required option later
  → the integration test constructs every entry inside a real kernel app, so the table cannot
  outlive its truth.
- The Vite config now performs I/O at load → wrapped in `try/catch` yielding an empty list, so a
  standalone project (no `../../libs`) builds exactly as before; the e2e builds both shapes.
- A generated `test/app.test.ts` adds `@setu-ts/testing` to every scaffold → a
  `common`+`kernel`-only package already published; the install step in the scaffold e2e proves it
  resolves at the pinned version.
- `DEVTOOL_SOURCES` registers sources that cost backend reads (health scheduled, queue depths) →
  gated on the `devtool` argument so a production run constructs every plugin as before; the e2e
  asserts `disabled` under `deno task start`.
- A browser in CI is a new flake surface (download, GPU, timeouts) → Chromium only, installed in ONE
  job with Playwright's pinned version, assertions on DOM state rather than screenshots, and a
  per-check timeout; a flake is a finding against the harness, never a reason to add the gate to
  `ALLOW_SKIP`.
- M101f's `devtool enable` merge and this letter's config edit touch the same command → this branch
  rebases on M101f and extends `factoryRefusal`'s proceed outcome rather than adding a second
  classifier.

## 9. Out of scope

- The standalone devtool port and `--devtool-port` (M101f §3.8).
- The kernel's duplicate-plugin message suggesting `override: true` — a `packages/kernel` wording
  decision, not reachable from the CLI; named so it is not mistaken for forgotten.
- An auth sign-in/MFA route schematic (generator gap 7's second half).
- Keeping healthy siblings up in the dev runner — decided against in §3.6.
- Filling `telemetry.operations`, `auth.roles`/`permissions` or `scheduler.jobs` automatically — not
  knowable at scaffold time; emitted as empty maps with the key named.
