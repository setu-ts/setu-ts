# Milestone 113i — CLI commands whose refusals and guidance mislead (`@setu-ts/cli`)

> **Status:** Planning. Branch: `fix/m113i-cli-guidance` (a **fix** letter, per the ROADMAP M113
> table). `develop` and `main` are protected — all work (implementation + fixes) stays on this one
> branch until it merges via a single PR.

## 0. Objective & scope

Nine `v0.9.0` smoke rows in one package share one shape: a CLI command tells the developer something
false — a refusal names the wrong situation, a help line promises what the command refuses, a dry
run promises a write the real run refuses, a README names a command that does not resolve, or a
command reports success while leaving the artifact registered nowhere. This milestone makes every
one of those messages and outcomes true. No `common` change, no new capability token, no barrel
export.

- **In scope:** V9-5, V9-12, V9-13, V9-30 (with the V8-32 remainder it names), V9-40, V9-60, V9-61
  (with the same defect in `new`, `library` and `generate app`), V9-62, V9-75.
- **NOT this milestone:** the documentation rows outside `packages/cli` (V9-6, V9-7, V9-10, V9-51 …
  V9-59, V9-69, V9-72 … V9-74, V9-77, V9-78) — **M113l**. The feature-folder module layout and
  `src/shared/` convention the M104 review raised alongside V9-60 — **M114**. `setu add exceptions`
  and `setu add kernel`/`runtime` (every scaffold already carries them; the refusal for them is
  truthful and no help text promises them) — unowned, not a defect.

## 1. Contracts verified from SOURCE (not names)

| Reference                             | Source (file:line)                                                             | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devtoolRuntimeRefusal(runtime)`      | `packages/cli/src/devtool/planner.ts:254`                                      | One string for every caller; ends "Scaffold without --devtool, or create the project with --runtime deno." Callers: `new.ts:553`, `app.ts:567` (scaffold time); `devtool.ts:436`, `:756`, `:767` (enable time).                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ADDABLE` catalogue                   | `packages/cli/src/commands/add.ts:102-143`                                     | 41 entries. Absent: `view-plugin`, `localization-plugin`, `idempotency-plugin`, `diagnostics-plugin` (also `exceptions`, `kernel`, `runtime`, starters, `cli`, `create`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `add --help` text                     | `packages/cli/src/commands/add.ts:1071`                                        | "The full specifier works too, so `add auth` and `add @setu-ts/auth-plugin` …" — true only for catalogue entries; `add @setu-ts/view-plugin` is refused at `:703`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ZERO_CONFIG_WIRINGS`                 | `packages/cli/src/commands/add.ts:179-192`                                     | 12 providers inserted into `setu.config.ts`; criterion stated at `:171-178`: an in-memory, zero-configuration default that makes a coherent development composition.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `registrationLine(bare)`              | `packages/cli/src/commands/add.ts:234-266`                                     | Printed-line arms for auth, session, grpc, database, feature-flags, notification, graphql, static, react-router, multi-tenancy, service-discovery, cloudflare. Every other package returns `undefined`, so `printWiringNote` prints nothing.                                                                                                                                                                                                                                                                                                                                                                                                               |
| Factory signatures                    | each package's `src/plugin/*.ts`                                               | `WorkerPoolPlugin(options?)`, `SecretsPlugin(options?)` (default `'env'`), `StoragePlugin(options?)` (default `'memory'`), `AuditPlugin(options?)` (default `'memory'`), `MailPlugin(options?)` (default `'log'`, `mail-plugin.ts:34`), `ResiliencePlugin(options?)`, `ViewPlugin(options = {})` (default `'hono-jsx'`), `IdempotencyPlugin(options?)` (default `{ type: 'memory' }`, `resolve-store.ts:16`), `TelemetryPlugin(options = {})` (no exporter = noop), `LocalizationPlugin(options)` (required `supportedLocales` + `catalogues` or `source`, `localization-plugin/src/interfaces/index.ts:81-160`), `DiagnosticsPlugin(options)` (required). |
| `TelemetryPluginOptions`              | `packages/telemetry-plugin/src/interfaces/index.ts:120-131`                    | `serviceName?: string`, `exporter?: 'otlp' \| 'console'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `view-plugin` dependencies            | `packages/view-plugin/package.json`                                            | `dependencies: { '@setu-ts/common', hono }` — no peer the scaffold lacks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `INGRESS_SEAM`                        | `packages/cli/src/seams/ingress.ts:55-64`                                      | `dir: 'src/ingress'`, `suffix: '.ingress.ts'`, import symbol `<Pascal>Ingress`. All five class-based schematics (`job.ts:33`, `event-handler.ts:33`, `command-handler.ts:33`, `query-handler.ts:33`, `ws-route.ts:17`) write `src/ingress/<kebab>.ingress.ts`.                                                                                                                                                                                                                                                                                                                                                                                             |
| `readArtifactNames`                   | `packages/cli/src/utils/artifact-scanner.ts:203-240`                           | An artifact's name is the filename stem before `spec.suffix`; `deriveNames(stem)` gives its symbols. So `widget-job.ingress.ts` → stem `widget-job` → `WidgetJobIngress`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `generate` dry-run ordering           | `packages/cli/src/commands/generate.ts:501-512`                                | `--dry-run` prints `would create <path>` for every file and returns 0 BEFORE `findExisting` runs at `:507`. Same order in `new.ts:766-773`, `library.ts:203-210`; `app.ts:739-752` classifies create/update but never reports a refusal.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `adopt` dry-run (the precedent)       | `packages/cli/src/commands/adopt.ts:292-301`                                   | Computes collisions first, prints `WOULD REFUSE: <path> already exists`, exits 1 when any exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `findExisting` / `classifyFiles`      | `packages/cli/src/utils/file-writer.ts:283-300`, `:331`                        | `findExisting` skips `managed` files; writer outcomes are `'created' \| 'updated' \| 'unchanged'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Seam registry `job` absence           | `packages/cli/src/seams/registry.ts:18-21`                                     | States `job` is unwired because registering it "starts a worker loop polling for a job name nothing enqueues" and "`QueuePluginOptions` has no `processors` option" — the second is false since M86.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `QueuePluginOptions.processors`       | `packages/queue-plugin/src/interfaces/index.ts:356`, `:474-491`                | `readonly processors?: readonly QueueProcessorEntry[]`; entry = `QueueProcessorDefinition` (`name`, `processor(job)` method, `options?`) or `RegistryFactory<QueueProcessorDefinition>`. M113c made `processor` a method, so a typed processor compiles (V9-76 closed).                                                                                                                                                                                                                                                                                                                                                                                    |
| `withPluginOptionSeams`               | `packages/cli/src/templates/seam.ts:173-200`                                   | REPLACES a wiring's `args` with the seam's object.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `withQueueArgs` / `rewritePluginArgs` | `packages/cli/src/templates/broker.ts:98-119`                                  | REPLACES `QueuePlugin`'s args with the transport arm (`{ adapter: 'redis', url: … }`, `workspace/transport.ts:341`, `:372`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `reportUnwiredDecoratorSeams`         | `packages/cli/src/commands/generate.ts:573-610`                                | After a write, prints the registration line when a decorator barrel was written and `setu.config.ts` does not reference its export. Decorator seams only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Generated README "Generate code"      | `packages/cli/src/templates/project-files.ts:1862-1867`                        | `${PROGRAM_NAME} generate service billing` — a bare `setu`, while no scaffold declares `@setu-ts/cli`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| CLI rollback docs                     | `docs/cli.md:468-472`, `packages/cli/README.md:202-204`, `PUBLIC_API.md:10008` | Exit `130` "built-in writes are rolled back"; SIGKILL is not named.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| CLI README schematic table            | `packages/cli/README.md:141-157`                                               | `plugin` listed as `src/plugins/<name>.ts`; `controller` "Requires decorator-plugin"; `ws-route` listed only as `src/plugins/<name>.plugin.ts`; class-based `src/ingress/` outputs of the CQRS/event handlers absent.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| PUBLIC_API schematic table            | `PUBLIC_API.md:10370-10380`                                                    | `plugin` correctly `src/plugins/<name>.plugin.ts`; checked for the same class-based omissions.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                 | Resolution (picked side)                                         | Doc deliverable (same PR)                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| C1  | `packages/cli/README.md:143` says `plugin` emits `src/plugins/<name>.ts`; the schematic and `PUBLIC_API.md:10375` say `<name>.plugin.ts` | Source wins: `<name>.plugin.ts`                                  | README table row corrected (V9-62)                             |
| C2  | README says `controller` requires `decorator-plugin`; the schematic registry no longer gates it (M70h ungated it)                        | Source wins: ungated, functional and class-based shapes          | README row: "—", with the two shapes named                     |
| C3  | `seams/registry.ts:18-21` says `QueuePluginOptions` has no `processors` option                                                           | Source wins (`queue-plugin/src/interfaces/index.ts:356`)         | The registry comment is rewritten for the new jobs seam (§3.6) |
| C4  | `add --help` says the full specifier works; four published framework packages are refused                                                | The help is the contract; the catalogue grows to match it (§3.2) | None beyond the code — the help line becomes true              |

## 3. Design decisions

### 3.1 V9-5 — the devtool runtime refusal names the situation it is in

- **Decision:** `devtoolRuntimeRefusal(runtime, context)` takes `context: 'scaffold' | 'enable'`.
  The shared first sentence (why the devtool needs Deno) stays, but its last clause "could never
  start the connector it was scaffolded with" becomes "could never start its diagnostics connector"
  so it reads correctly in both contexts. The remedy differs: `'scaffold'` keeps "Scaffold without
  --devtool, or create the project with --runtime deno."; `'enable'` says "This project targets
  <runtime>; the devtool can only be enabled on a Deno project." with no "scaffold" wording.
  `new.ts:553` and `app.ts:567` pass `'scaffold'`; `devtool.ts:436`, `:756`, `:767` pass `'enable'`.
  Required parameter, so no call site can keep the old wording by omission.
- **Why:** the refusal is correct; only its remedy names the wrong command.
- **Test home:** `test/unit/devtool-refusals.test.ts` — both contexts, every runtime; asserts the
  enable message contains neither "Scaffold" nor "scaffolded".

### 3.2 V9-40 — `setu add` accepts the published packages its help promises

- **Decision:** `ADDABLE` gains `view` → `view-plugin`, `localization` → `localization-plugin`,
  `idempotency` → `idempotency-plugin`. `diagnostics` (and `@setu-ts/diagnostics-plugin`) is NOT
  added as an installable package: `setu add diagnostics` refuses with
  "`@setu-ts/diagnostics-plugin` is installed and wired by `setu devtool enable`." and exits 2. A
  refusal for any other `@setu-ts/<name>` specifier names that the package is not one this command
  installs and lists the catalogue, as today.
- **Why:** the devtool composition (connector entry, dev task, port, session variables) is
  `devtool enable`'s job; installing the bare package would produce a project that cannot start the
  connector (`DiagnosticsPlugin(options)` has required options).
- **Test home:** `test/unit/commands/add.test.ts` — `add view`, `add @setu-ts/view-plugin`,
  `add localization`, `add idempotency` succeed; `add diagnostics` and
  `add @setu-ts/diagnostics-plugin` refuse naming `devtool enable`.

### 3.3 V9-30 + the V8-32 remainder — every added plugin is registered or named

- **Decision (maintainer, 2026-10-20):** `ZERO_CONFIG_WIRINGS` gains `worker-pool-plugin`
  (`WorkerPoolPlugin`), `secrets-plugin` (`SecretsPlugin`), `storage-plugin` (`StoragePlugin`),
  `audit-plugin` (`AuditPlugin`), `mail-plugin` (`MailPlugin`), `resilience-plugin`
  (`ResiliencePlugin`), `view-plugin` (`ViewPlugin`) and `idempotency-plugin` (`IdempotencyPlugin`),
  so `add` inserts the bare call exactly as it does for `cache`. Each meets the list's stated
  criterion (§1). `registrationLine` gains printed lines for the two that need a user choice:
  telemetry → `TelemetryPlugin({ serviceName: '<service-name>', exporter: 'console' })` (inserting
  it adds span middleware to every request and has no exporter), and localization →
  `LocalizationPlugin({ supportedLocales: ['en'], catalogues: { en: {} } })`. Starter-composed
  projects keep the existing starter-arm guidance path unchanged. A Workers project: the inserted
  calls are runtime-portable except `WorkerPoolPlugin`, which registers and reports itself
  unavailable (documented M45 behaviour), so no new runtime restriction is added.
- **Why:** the list's own comment defines membership by default behaviour, and these eight meet it;
  the difference between `add cache` and `add storage` was an omission, not a design.
- **Test home:** `test/unit/commands/add.test.ts` — a table over all ten packages: the eight insert
  `XPlugin()` once (and a second `add` is a no-op), the two print the exact line and leave the
  config byte-identical. The insertion is proven compiling by `seam-probe` (§6).

### 3.4 V9-61 — a dry run reports the refusal the real run makes

- **Decision:** one internal helper, `reportDryRunPlan(deps, files)` in `src/utils/file-writer.ts`,
  used by `generate`, `new`, `library` and `generate app`. It calls `findExisting` and
  `classifyFiles` once, prints `would create <path>` / `would update <path>` (managed files that
  exist) / `unchanged <path>`, then `WOULD REFUSE: <path> already exists` for each collision, and
  returns `EXIT_ERROR` when any collision exists, else `EXIT_OK`. This is `adopt`'s existing wording
  and exit code (`adopt.ts:292-301`), which keeps its own branch because it also prints moves. The
  helper is not barrel-exported.
- **Why:** `adopt` already decided the output; four commands disagreed with it.
- **Test home:** `test/unit/file-writer.test.ts` (helper branches) and one dry-run collision case
  per command in `generate-command.test.ts`, `new-command.test.ts`, `library-command.test.ts`,
  `app-command.test.ts`, asserting exit 1 and no file written.

### 3.5 V9-60 — class-based ingress filenames carry their kind

- **Decision:** the five class-based ingress schematics derive their file stem and class name from
  `<name>-<kind>`: `job` → `src/ingress/<kebab>-job.ingress.ts` / `<Pascal>JobIngress`,
  `event-handler` → `…-event-handler.ingress.ts` / `<Pascal>EventHandlerIngress`, `command-handler`,
  `query-handler`, `ws-route` likewise. Every OTHER symbol inside the file (`<SCREAMING>_JOB`, the
  payload interface, event and command names) keeps the plain `names` so the emitted addresses do
  not change. `INGRESS_SEAM` and the scanner are unchanged: a stem already maps to its class, so
  existing `src/ingress/<name>.ingress.ts` files keep scanning with `<Pascal>Ingress` and stay
  registered. One internal `ingressNames(names, kind)` in `seams/ingress.ts` computes it for all
  five schematics.
- **Why:** the collision is between kinds, so the kind must be in the name; keeping the scanner
  unchanged is what keeps released projects registered.
- **Test home:** `test/unit/ingress-schematics.test.ts` — the five paths and class names;
  `generate-seam-command.test.ts` — in a class-based project `g event-handler widget` then
  `g job widget` both write and the barrel lists both classes; a pre-existing
  `src/ingress/widget.ingress.ts` exporting `WidgetIngress` stays in the regenerated barrel.

### 3.6 V9-75 — a functional `g job` is wired when `QueuePlugin` is installed

- **Decision:** a new `JOBS_SEAM` in `src/seams/jobs.ts` (schematic `job`, `dir: 'src/jobs'`,
  `suffix: '.job.ts'`, barrel `src/jobs/index.ts`, export `QUEUE_PROCESSORS`,
  `requiresPlugin: 'queue-plugin'`, import symbol `create<Pascal>JobProcessor`), registered in
  `SEAM_REGISTRY` and excluded in class-based mode from both `hostSeamSpecs` (beside the events and
  CQRS seams it already excludes there) and `scanSeamSpecs` — a class-based `g job` is refused
  without `queue-plugin` and writes the ingress seam with it, so a class-based project never holds a
  jobs barrel. `scanSeamSpecs` ALSO drops `JOBS_SEAM` when `queue-plugin` is not installed: unlike
  `hostSeamSpecs` it does not filter by `requiresPlugin` (`seams/registry.ts:142-149`), and a
  functional project without a queue legitimately holds standalone `src/jobs/*.job.ts` files that
  export no processor factory — scanning them would print a "does not export" skip report on every
  `setu generate`, the M65 false-report loop. In a functional project with `queue-plugin`, `g job`
  emits the module with its existing `<SCREAMING>_JOB` and `<Pascal>JobData` plus an exported
  `create<Pascal>JobProcessor(services): QueueProcessorDefinition<<Pascal>JobData>` (the M70d
  factory convention), and the managed barrel. Without `queue-plugin` the standalone function is
  emitted unchanged. `withPluginOptionSeams` maps the seam to
  `QueuePlugin({ processors: [...QUEUE_PROCESSORS] })`. The transport arm and the seam must compose,
  so `rewritePluginArgs` for `QueuePlugin` and the seam mapping both go through one internal
  `mergeObjectArgs(a, b)` that joins two CLI-authored single-level `{ … }` literals (it refuses any
  input not of that shape, which only CLI code supplies); a `--queue redis` microservice therefore
  renders `QueuePlugin({ adapter: 'redis', url: …, processors: [...QUEUE_PROCESSORS] })`. After a
  write, `generate` reports an unconsumed jobs barrel the way `reportUnwiredDecoratorSeams` reports
  a decorator barrel — one added branch for `src/jobs/index.ts` only (the other plugin-option seams
  keep today's behaviour; widening the report to them is not a V9 row), printing
  `Pass the barrel to QueuePlugin: QueuePlugin({ processors: [...QUEUE_PROCESSORS] })` and the
  import line. The `seams/registry.ts` comment for `job` is rewritten (C3): a processor polls only
  its own job name, which is the same trade the class-based arm already makes (V8-33).
- **Why:** the class-based arm already wires a queue processor; the functional arm had no seam
  because of a stale premise.
- **Test home:** `test/unit/schematics/job.test.ts` (both functional shapes), `test/unit/seams/`
  (barrel render), `generate-unwired-seam.test.ts` (the report), `test/unit/templates/`
  (microservice scaffold with and without `--queue redis`), and `seam-probe.test.ts` booting the
  functional microservice host, enqueueing a generated job through `CAPABILITIES.QUEUE`, and
  observing the processor run.

### 3.7 V9-12 — a generated README names a command that resolves

- **Decision (maintainer, 2026-10-20):** every command a generated file or the CLI's own output
  tells the reader to RUN renders the CLI as the pinned package for the target: npm-family (node,
  cloudflare-workers) `npx @setu-ts/cli@<VERSION>`, bun `bunx @setu-ts/cli@<VERSION>`, deno
  `deno run -A npm:@setu-ts/cli@<VERSION>`, where `<VERSION>` is the CLI's own `VERSION`
  (`src/version.ts`, the version every scaffold already pins its framework packages to). One
  internal `cliInvocation(runtime)` in `templates/project-files.ts` renders it, at every such site
  (found by `grep -rn PROGRAM_NAME packages/cli/src/templates packages/cli/src/workspace` plus the
  printed next steps): the project README "Generate code" fence (`project-files.ts:1865-1866`), the
  Workers `wrangler.toml` comment (`project-files.ts:2111`), the workspace root README fences and
  the `ports --reallocate` instruction (`workspace/root-files.ts:121`, `:138`, `:152`), the
  full-stack architecture table cell (`full-stack-app-files.ts:779`), and the workspace `Next:` line
  `setu new --workspace` prints (`commands/new.ts:804`), which `npm create @setu-ts` users read
  without `setu` on their PATH. A provenance comment ("Generated by `setu generate app`") names what
  wrote the file, not something to run, and is unchanged. No scaffold gains a dependency.
- **Why:** `npx setu` resolves the unrelated npm package `setu`; pinning keeps the generator's
  output matched to the framework version the project uses.
- **Test home:** `test/unit/templates/project-files.test.ts` README case per runtime;
  `scaffold-runs-e2e.test.ts` (Node target) runs the README's own `generate` line against the local
  registry overlay and asserts the file appears. The CLI has one `bin` (`setu`), which is what lets
  `npx`, `bunx` and `deno run npm:` pick it without a bin name; the Deno and Bun forms are each run
  once by hand against published `0.9.0` and the result recorded in the PR.

### 3.8 V9-13 and V9-62 — CLI documentation that matches the source

- **Decision:** `docs/cli.md`, `packages/cli/README.md` and `PUBLIC_API.md` state that rollback
  covers SIGINT (Ctrl+C) and a caught error only — `main.ts:46` registers SIGINT and nothing else,
  so SIGTERM, SIGKILL (`kill -9`) and power loss all end the command with no rollback — and that
  re-running `setu adopt` converges while an interrupted `new`/`generate` leaves the files it wrote,
  which the next run's refusal lists. Handling SIGTERM too is a code change outside V9-13 and is
  named in §9. The schematic tables in `packages/cli/README.md` (C1/C2), `docs/cli.md:229-245` and
  `PUBLIC_API.md:10370-10380` are each corrected: the class-based
  `src/ingress/<name>-<kind>.ingress.ts` outputs of `ws-route`, `job`, `command-handler`,
  `query-handler` and `event-handler`, and the functional `job` row naming the `QueuePlugin` wiring
  of §3.6.
- **Why:** the docs promised more than signals can deliver, and the table lagged three milestones.
- **Test home:** `test/unit/schematics/readme-table.test.ts` (new) parses the
  `packages/cli/README.md` schematic table, and for each row runs that schematic for the name
  `widget` under the plugin set its "Requires" cell names, in both generator modes, and asserts
  every backticked `src/…` path in the "Emits" cell (with `<name>` → `widget`, `<kind>` → the
  schematic) is a path the schematic returns; it also asserts every registered schematic has a row.
  A row naming a path no schematic emits fails, so the table cannot drift again. The `docs/cli.md`
  and `PUBLIC_API.md` tables are corrected by hand and checked in review.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. Generated output changes (V9-60 filenames, V9-75 jobs seam,
V9-12 README text) are recorded under CHANGELOG `Changed` for the next minor, 0.10.0.

| Exported symbol | Kind | Consumer / real code path that READS it                                                                                                                                                                                                        |
| --------------- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None (checked)  | —    | `packages/cli/src/index.ts` is unchanged; every new symbol (`reportDryRunPlan`, `ingressNames`, `JOBS_SEAM`, `mergeObjectArgs`, `cliInvocation`) is internal and read by the call sites named in §3. `barrel-exports.test.ts` pins the barrel. |

### 4.1 Options — every option names its consumer

| Option                                         | Consumer                    | Behavior (per implementation)          |
| ---------------------------------------------- | --------------------------- | -------------------------------------- |
| `context` parameter of `devtoolRuntimeRefusal` | the five call sites in §3.1 | Selects the remedy sentence; required. |

## 5. Implementation files

| File                                                                             | Purpose                                                                                 |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/index.ts`                                                                   | Unchanged                                                                               |
| `src/devtool/planner.ts`                                                         | `devtoolRuntimeRefusal(runtime, context)` (§3.1)                                        |
| `src/commands/devtool.ts`, `new.ts`, `app.ts`                                    | Pass the context (§3.1); `new`/`app` call `reportDryRunPlan` (§3.4)                     |
| `src/commands/add.ts`                                                            | Catalogue entries, diagnostics refusal, zero-config entries, printed lines (§3.2, §3.3) |
| `src/utils/file-writer.ts`                                                       | `reportDryRunPlan` (§3.4)                                                               |
| `src/commands/generate.ts`, `library.ts`                                         | `reportDryRunPlan`; generalized unwired-seam report (§3.4, §3.6)                        |
| `src/seams/ingress.ts`                                                           | `ingressNames` (§3.5)                                                                   |
| `src/schematics/{job,event-handler,command-handler,query-handler,ws-route}.ts`   | Kind-qualified ingress names; functional queue job shape (§3.5, §3.6)                   |
| `src/seams/jobs.ts`, `src/seams/registry.ts`                                     | `JOBS_SEAM`, registration, mode filtering, corrected comment (§3.6)                     |
| `src/templates/seam.ts`, `src/templates/broker.ts`                               | Seam-to-option mapping for `queue-plugin`; `mergeObjectArgs` composition (§3.6)         |
| `src/templates/project-files.ts`                                                 | `cliInvocation` in the README (§3.7)                                                    |
| `README.md`, `docs/cli.md`, `PUBLIC_API.md`, `CHANGELOG.md`, `docs/upgrading.md` | §3.8; CHANGELOG `Fixed`/`Changed`; upgrade note for the jobs barrel                     |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                | src covered                                                    | Key assertions                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/devtool-refusals.test.ts`                                                     | `devtool/planner.ts`, `commands/devtool.ts`                    | §3.1 both contexts × node/bun/workers; enable path reached through `runDevtoolCommand` on a Node project                                                                                                         |
| `test/unit/new-command.test.ts`, `app-command.test.ts`                                   | `new.ts`, `app.ts`                                             | scaffold-context wording; dry-run collision exits 1 with `WOULD REFUSE`, nothing written                                                                                                                         |
| `test/unit/commands/add.test.ts`                                                         | `commands/add.ts`                                              | §3.2 and §3.3 tables; second `add` idempotent; starter-composed project keeps arm guidance                                                                                                                       |
| `test/unit/file-writer.test.ts`                                                          | `utils/file-writer.ts`                                         | `reportDryRunPlan`: create, managed update, unchanged, collision → exit 1                                                                                                                                        |
| `test/unit/generate-command.test.ts`, `library-command.test.ts`                          | `generate.ts`, `library.ts`                                    | dry-run collision exits 1, nothing written; a clean dry run is unchanged                                                                                                                                         |
| `test/unit/ingress-schematics.test.ts`, `generate-seam-command.test.ts`                  | five schematics, `seams/ingress.ts`                            | §3.5 paths, class names, both-kinds coexist, legacy file stays registered                                                                                                                                        |
| `test/unit/schematics/job.test.ts`, `test/unit/seams/*`, `generate-unwired-seam.test.ts` | `job.ts`, `seams/jobs.ts`, `seams/registry.ts`, `generate.ts`  | §3.6 three shapes (class-based, functional+queue, functional alone); barrel; unconsumed-barrel report; class-based mode has no jobs seam; a queue-less functional project scans no jobs seam and reports no skip |
| `test/unit/templates/*`, `test/unit/plugin-args.test.ts`                                 | `templates/seam.ts`, `templates/broker.ts`, `project-files.ts` | microservice `QueuePlugin({ processors })`; `--queue redis` merged args; `mergeObjectArgs` refusal of a non-literal; §3.7 README per runtime                                                                     |
| `test/unit/schematics/readme-table.test.ts` (new)                                        | README table (§3.8)                                            | every schematic's emitted path matches its README row                                                                                                                                                            |
| `test/e2e/seam-probe.test.ts`                                                            | integration                                                    | §3.3 inserted plugins compile and boot; §3.6 functional job runs when enqueued                                                                                                                                   |
| `test/e2e/scaffold-runs-e2e.test.ts`                                                     | integration                                                    | §3.7 README `generate` line resolves and writes                                                                                                                                                                  |

**Negative controls (each must be observed failing, then reverted):** (1) drop the `context`
parameter's enable arm → the enable test fails; (2) remove `view` from `ADDABLE` → `add view` test
fails; (3) remove `StoragePlugin` from `ZERO_CONFIG_WIRINGS` → the insertion row fails; (4) restore
`would create` before `findExisting` in `generate` → the dry-run collision test fails; (5) drop the
kind from `ingressNames` → the both-kinds test fails on the existing file; (6) make the seam mapping
replace instead of merge → the `--queue redis` template test loses `adapter: 'redis'`; (7) render
`setu` instead of `cliInvocation` → the README test fails; (8) drop the `queue-plugin` condition
from `scanSeamSpecs` → a functional project without a queue holding a standalone job reports a skip
on the next `g route`.

## 7. Verification gates

```bash
git branch --show-current   # MUST be fix/m113i-cli-guidance, never develop or main
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test:coverage cli     # ANSI-stripped per-file table; ≥90% branch/function/line every changed src file
pnpm run release:publish --dry-run
pnpm run release:verify 0.9.0
```

`scaffold-runs-e2e` and `seam-probe` are part of the `cli` suite and boot real scaffolds.

## 8. Risks & mitigations

- An existing functional project with `queue-plugin` holds a standalone `src/jobs/<name>.job.ts`
  without the processor factory → the scanner skips it and reports it (the M60 report); the upgrade
  guide names adding `create<Pascal>JobProcessor` or deleting and regenerating.
- `mergeObjectArgs` could be handed a user-written argument → it is only reached with strings the
  CLI rendered (template wirings and transport arms), and refuses any other shape, tested.
- Inserting `IdempotencyPlugin()` without any `idempotent()` route registers a store that nothing
  uses → harmless and identical to `add cache` before a route uses it.
- Changed ingress class names in new files could collide with a hand-written class → the M60
  duplicate-token refusal already covers it.

## 9. Out of scope

- Documentation rows outside `packages/cli` — M113l.
- Feature-folder modules and `src/shared/` — M114.
- `setu add exceptions`/`kernel`/`runtime` — every scaffold carries them; no help text promises
  them.
- Making the CLI a scaffold dependency — rejected by the maintainer in favour of §3.7.
- Rolling back on SIGTERM — the CLI registers SIGINT only (`main.ts:46`); adding a second signal is
  a behaviour change, not a V9 row. Unowned; §3.8 documents the limit instead.
