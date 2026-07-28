# Milestone 34 — CLI (`@hono-enterprise/cli`)

> **Status:** Planning. Branch: `feat/m34-cli`. `main` is protected — all work (implementation +
> fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Ship the `honoe` command-line tool: project scaffolding (`honoe new`) and code generation
(`honoe generate <schematic> <name>`) for the framework's recurring shapes — plugins, controllers,
services, routes, middleware, guards, health indicators, metrics, CQRS handlers, event handlers,
jobs, and migrations. Generation is **plugin-aware**: the tool reads the target project's dependency
manifest and only offers schematics whose backing plugin is installed. Everything the CLI emits is
plain source text; the CLI never runs the generated application and never imports the kernel.

- **In scope:** the `new` and `generate` commands with their aliases (`g`), `--dry-run`, a
  `--runtime deno|node|bun|cloudflare-workers` flag on `new`, thirteen built-in schematics, custom
  schematics loaded from `.hono-enterprise/schematics/`, plugin detection from `deno.json` /
  `package.json`, and a zero-dependency argument parser.
- **NOT this milestone:**
  - Consuming plugin-registered CLI commands via `CAPABILITIES.CLI_COMMAND` — deferred, see §9.
    Requires booting the user's application; owned by a follow-up milestone.
  - `new --template rest|microservice` — the starter packages are Milestone 0 stubs that export
    nothing (**Milestone 36** owns them).
  - The client SDK (**Milestone 35**) and example applications (**Milestone 37**).

## 1. Contracts verified from SOURCE (not names)

| Reference                       | Source (file:line)                                             | Verified surface / fact                                                                                                                                                                                            |
| ------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IFileSystem`                   | `packages/common/src/runtime.ts:50`                            | `readFile`, `writeFile(path, Uint8Array)`, `stat`, `readdir`, `mkdir(path, {recursive?})`, `rm`, optional `realPath`. Exactly the surface generation needs — no new port is invented.                              |
| `createDenoRuntimeServices`     | `packages/runtime/src/adapters/deno/deno-runtime.ts:69`        | `(host: DenoHost = Deno, workers?) => IRuntimeServices`. The `host` parameter defaults to the real `Deno` global and is injectable — this is the test seam; the CLI adds none of its own.                          |
| `DenoHost`                      | `packages/runtime/src/adapters/deno/deno-runtime.ts`           | Declares `writeFile`, `mkdir`, `stat`, `readDir`, `readFile`, `realPath`, `env`, `exit`. A fake host satisfying this drives every filesystem branch without touching disk.                                         |
| `ICliApi` / `CliCommandHandler` | `packages/common/src/plugin.ts:261,269`                        | `register(name: string, handler: (args: readonly string[]) => void \| Promise<void>): void`. Committed, and its JSDoc claims the CLI consumes it — see conflict C4.                                                |
| `CAPABILITIES.CLI_COMMAND`      | `packages/common/src/tokens.ts:115`                            | `'cli-command'`. Registered by the kernel with `{ multi: true }` at `packages/kernel/src/application/application.ts:214`, readable via `getAll`. Real read path exists; consuming it still requires a running app. |
| Consuming a `multi` token       | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:294` | Precedent: `getAll<{ name: string; handler: DecoratorHandler }>(TOKEN)` — the registration shape is re-declared structurally at the consumption site; no shared type is exported.                                  |
| `no-console` lint exemption     | `packages/cli/deno.json`                                       | The package already sets `lint.rules.exclude: ["no-console"]`, so CLI output needs no per-file ignore. Confirmed present in the existing stub.                                                                     |
| Stub state                      | `packages/cli/src/index.ts`                                    | Currently `export {}` only. `scripts/verify-release.ts` rejects publishing a stub, so this package is excluded from releases until this milestone lands.                                                           |
| Root workspace imports          | `deno.json`                                                    | Only `@std/expect` and `@std/testing`. There is no `@std/cli`; adding one would be a new dependency requiring approval (AI_GUIDELINES §16.3) — see design decision 3.2.                                            |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                       | Resolution (picked side)                                                                                                                                                                                                   | Doc deliverable (same PR)                                                                                          |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| C1 | Command name. ROADMAP and PUBLIC_API both spell every invocation `hono-enterprise …`; the maintainer chose a shorter binary.                                   | The command is **`honoe`**. Deno picks the executable name at install time (`deno install -g -n`), and its default inference yields a useless name for a package called `cli`, so an explicit `-n` is required regardless. | Rewrite every invocation in PUBLIC_API.md §CLI and ROADMAP M34 to `honoe`.                                         |
| C2 | Command list. ROADMAP lists `generate metric`; PUBLIC_API omits it. PUBLIC_API lists `g` aliases, `--dry-run`, and `generate custom`; ROADMAP omits all three. | Ship the **union**: 13 schematics, `g`/`n` aliases, `--dry-run`, custom schematics.                                                                                                                                        | Add the missing entries to both documents so the two lists match.                                                  |
| C3 | Package dependencies. ARCHITECTURE §"@hono-enterprise/cli" states `common`, `kernel`.                                                                          | Dependencies are **`common` + `runtime`**. `kernel` is not needed — the CLI emits source text and never builds an application. `runtime` supplies the `IFileSystem` implementation.                                        | Correct the ARCHITECTURE dependency row for `cli`.                                                                 |
| C4 | `ICliApi`'s JSDoc says it is "consumed by the CLI tool to discover plugin-provided commands". This milestone does not consume it.                              | Keep `ICliApi` as committed (it is public API; removing it is a breaking change), but **correct the JSDoc** so it describes the contract rather than asserting a consumer that does not exist yet.                         | Reword the `ICliApi` doc comment in `packages/common/src/plugin.ts`; record the consumer as a follow-up milestone. |
| C5 | ROADMAP's implementation-file list names 11 schematics but its command list includes `metric` and `migration`, which have no files.                            | Implement **13** schematic files, one per command.                                                                                                                                                                         | Add `metric.ts` and `migration.ts` to the ROADMAP M34 file list.                                                   |
| C6 | `new --template rest\|microservice` (PUBLIC_API) would generate a project importing starter packages that export nothing.                                      | **Drop `--template` from this milestone.** `new` generates a kernel+runtime project; `--runtime` selects the entry-point shape.                                                                                            | Remove the `--template` examples from PUBLIC_API.md §CLI and note that starters arrive in Milestone 36.            |

## 3. Design decisions

### 3.1 Filesystem access

- **Decision:** The CLI writes through `IFileSystem` from `@hono-enterprise/common`, obtained from
  `createDenoRuntimeServices()` in `@hono-enterprise/runtime`. Every command takes an optional
  `fs: IFileSystem` parameter defaulting to that; tests pass an in-memory implementation.
- **Why:** Reuses a committed port rather than inventing a parallel one, and
  `createDenoRuntimeServices` already exposes an injectable `DenoHost`. Direct `Deno.writeTextFile`
  calls would make the 90% per-file bar unreachable without touching disk.
- **Test home:** `test/unit/file-writer.test.ts` drives write, mkdir-recursive, and already-exists
  branches against an in-memory `IFileSystem`.

### 3.2 Argument parsing

- **Decision:** A hand-written parser in `src/args.ts`. **No `@std/cli`, no new dependency.**
- **Why:** AI_GUIDELINES §12.1 prefers zero-dependency implementations, and §16.3 makes a new
  dependency an approval item. The surface is small and closed — a command, an optional subcommand,
  a name, and boolean/`--key=value` flags — so a ~60-line parser is fully coverable and keeps the
  published package dependency-free.
- **Test home:** `test/unit/args.test.ts` — flags before and after positionals, `--key=value`,
  repeated flags, `--` terminator, unknown flags, and an empty argv.

### 3.3 Name normalization

- **Decision:** One `src/utils/names.ts` exporting a single `deriveNames(input)` returning
  `{ raw, kebab, camel, pascal, screaming }`. Every schematic consumes it; no schematic does its own
  case conversion.
- **Why:** `honoe g controller user-profile` and `… UserProfile` must produce identical output.
  Duplicated case logic across 13 schematics is precisely the DRY violation AI_GUIDELINES §11.1
  forbids, and it is how one schematic silently drifts from the rest.
- **Test home:** `test/unit/names.test.ts` — kebab, camel, Pascal, snake, and single-word inputs all
  round-trip to the same five forms.

### 3.4 Schematic contract

- **Decision:** Every schematic is a pure function
  `(names: DerivedNames, options: SchematicOptions) => readonly GeneratedFile[]`, where
  `GeneratedFile` is `{ path: string; contents: string }`. Schematics perform **no I/O**; the
  command layer writes what they return.
- **Why:** Purity makes each of the 13 schematics testable by asserting returned strings, with no
  filesystem involvement, which is what makes the per-file 90% bar cheap to hit. It also makes
  `--dry-run` fall out for free: the same call, minus the write.
- **Test home:** one test file per schematic; each asserts the emitted path and that the contents
  contain the identifiers derived from the input name.

### 3.5 Templates

- **Decision:** Template literals inside each schematic module. No template engine, no file-based
  templates, and — per AI_GUIDELINES §13.5 — no `eval` and no `new Function`.
- **Why:** Generated code must type-check against the real framework; keeping it in TypeScript
  source means a contract change breaks the build rather than silently emitting stale code.
- **Test home:** each schematic's test asserts the generated text compiles-by-inspection against the
  documented import paths (asserted as substrings, since generated code is not compiled in-suite).

### 3.6 `--dry-run`

- **Decision:** The command layer collects `GeneratedFile[]`, and when `dryRun` is set prints each
  path prefixed `would create` and returns without calling `fs.writeFile` even once.
- **Why:** A dry run that writes anything is worse than none. Because schematics are pure (3.4), the
  guard lives in exactly one place.
- **Test home:** `test/unit/generate-command.test.ts` asserts the injected `IFileSystem` recorded
  **zero** `writeFile` and **zero** `mkdir` calls under `--dry-run`.

### 3.7 Overwrite protection

- **Decision:** A generate that would overwrite an existing file fails with exit code 1 and writes
  nothing at all — the check runs across the whole `GeneratedFile[]` before the first write.
- **Why:** A schematic emitting several files must not leave a half-written tree. Silent overwrite
  would destroy user code.
- **Test home:** `test/unit/generate-command.test.ts` — a fake `fs` reporting one of three planned
  paths as existing produces zero writes and a non-zero exit.

### 3.8 Plugin detection

- **Decision:** `src/utils/plugin-detector.ts` reads `deno.json` (`imports`) and, when absent,
  `package.json` (`dependencies` + `devDependencies`), returning the set of installed
  `@hono-enterprise/*` package names. Detection **never** boots the project.
- **Why:** Manifest reading is what "detects installed plugins" can mean without executing user
  code, which would be both slow and unsafe.
- **Test home:** `test/unit/plugin-detector.test.ts` — a Deno project, an npm project, a project
  with neither manifest, and a malformed manifest (returns empty, does not throw).

### 3.9 Plugin-gated schematics

- **Decision:** Schematics declare a `requiresPlugin?: string`. `honoe generate` refuses one whose
  plugin is absent, naming the package to install; `honoe generate --help` lists only available
  ones. Gated: `command-handler`/`query-handler` (`cqrs-plugin`), `event-handler` (`events-plugin`),
  `guard` (`auth-plugin`), `health-indicator` (`health-plugin`), `metric` (`metrics-plugin`),
  `migration` (`database-plugin`).
- **Why:** This is the milestone's "plugin-aware" requirement. Generating a CQRS handler into a
  project without the CQRS plugin produces code that cannot compile.
- **Test home:** `test/unit/generate-command.test.ts` — detector reporting no plugins refuses a
  gated schematic and still allows an ungated one.

### 3.10 Custom schematics

- **Decision:** `honoe generate custom <name>` resolves `.hono-enterprise/schematics/<name>.ts` and
  loads it with a **real** dynamic `await import(url)` behind an injectable `loadSchematic` seam.
  The module must export a `schematic` function matching 3.4. A missing file, or a module without
  that export, is an error naming the expected path and shape.
- **Why:** CLAUDE.md forbids fake lazy imports — a `globalThis.__x` hook that only tests populate
  throws in production. The injectable seam lets unit tests drive the branching while a guarded test
  exercises the real `import()`.
- **Test home:** `test/unit/custom-schematic.test.ts` for the branches (missing file, missing
  export, wrong type, success) via the seam; `test/integration/custom-schematic-real-import.test.ts`
  writes a fixture module to a temp dir and loads it through the **real** default loader.

### 3.11 Program name in help output

- **Decision:** One exported `PROGRAM_NAME = 'honoe'` constant in `src/constants.ts`; every usage
  string interpolates it. No string in the codebase spells the name literally more than once.
- **Why:** AI_GUIDELINES §11.2 forbids repeated magic strings, and the install name is user-chosen
  (`deno install -g -n`). A single constant means a rename is one edit. Deno exposes no reliable
  argv[0], so deriving the actual invoked name is not possible — the README documents that help text
  shows the default name.
- **Test home:** `test/unit/help.test.ts` asserts the help text contains `PROGRAM_NAME` and that no
  usage line contains the literal `hono-enterprise`.

### 3.12 Exit codes and the process boundary

- **Decision:** `runCli(argv, deps): Promise<number>` returns an exit code and never calls
  `Deno.exit`. Only `src/main.ts` — the bin entry point, excluded from coverage as a two-line
  wrapper — calls `Deno.exit(await runCli(Deno.args))`. `0` success, `1` runtime error, `2` usage
  error.
- **Why:** A function that calls `Deno.exit` cannot be tested; it terminates the test runner.
- **Test home:** `test/unit/cli.test.ts` asserts the returned code for success, unknown command (2),
  and a schematic failure (1).

## 4. Exported surface — every symbol names its consumer

`src/index.ts` is the programmatic surface; `src/main.ts` is the executable entry (declared as the
`.` binary export, not re-exported from the barrel).

| Exported symbol    | Kind     | Consumer / real code path that READS it                                                                                     |
| ------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `runCli`           | function | `src/main.ts` calls it with `Deno.args`; every command test drives it. The single entry point for programmatic use.         |
| `CliDependencies`  | type     | Parameter type of `runCli`; consumed by `main.ts` (defaults) and by every test that injects a fake `fs`/`loadSchematic`.    |
| `deriveNames`      | function | Called by all 13 schematics (§3.3) and exported so a custom schematic can produce identical casing.                         |
| `DerivedNames`     | type     | The `names` parameter of every schematic, including user-authored custom schematics.                                        |
| `GeneratedFile`    | type     | Return element of every schematic; the write loop in `commands/generate.ts` consumes it. Custom schematics must return it.  |
| `Schematic`        | type     | The contract a `.hono-enterprise/schematics/*.ts` module must satisfy; `loadSchematic` validates against it.                |
| `SchematicOptions` | type     | Second parameter of every schematic; carries `runtime` and the detected plugin set.                                         |
| `PROGRAM_NAME`     | const    | Interpolated into every usage/help string (§3.11); asserted by `test/unit/help.test.ts`.                                    |
| `detectPlugins`    | function | Called by `commands/generate.ts` to gate schematics (§3.9); exported so a custom schematic can branch on installed plugins. |

Nothing else is exported. The 13 schematic functions are **internal** — they are reached through
`runCli`, never imported by consumers, so exporting them would be surface with no reader.

### 4.1 Options — every option names its consumer

| Option                                          | Consumer                         | Behavior (per implementation)                                                                                                                                                                                           |
| ----------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--dry-run`                                     | `commands/generate.ts`, `new.ts` | Prints `would create <path>` per file; the injected `fs` receives zero `writeFile`/`mkdir` calls (§3.6).                                                                                                                |
| `--runtime deno\|node\|bun\|cloudflare-workers` | `commands/new.ts`                | Selects the entry-point shape and manifest. `cloudflare-workers` emits `export default { fetch: app.fetch }` plus a `wrangler.toml` and **no** `listen`; the other three emit the Hono serve entry. Defaults to `deno`. |
| `--dir <path>`                                  | `commands/new.ts`, `generate.ts` | Root the generated paths here instead of the working directory. Lets tests assert absolute paths deterministically.                                                                                                     |
| `--help`, `-h`                                  | `cli.ts`                         | Prints usage for the command (or the tool) and returns exit code `0`.                                                                                                                                                   |
| `--version`, `-v`                               | `cli.ts`                         | Prints the version read from the package `deno.json` and returns `0`.                                                                                                                                                   |

No option is stored without a reader; each row names the file that branches on it.

## 5. Implementation files

| File                                 | Purpose                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `src/index.ts`                       | Barrel: the nine symbols in §4, each with JSDoc.                                            |
| `src/main.ts`                        | Bin entry. `Deno.exit(await runCli(Deno.args))` — the only `Deno.exit` in the package.      |
| `src/cli.ts`                         | `runCli`: dispatch to `new`/`generate`, `--help`/`--version`, exit-code mapping (§3.12).    |
| `src/args.ts`                        | Zero-dependency argument parser (§3.2).                                                     |
| `src/constants.ts`                   | `PROGRAM_NAME`, exit-code constants, the schematic registry keys.                           |
| `src/commands/new.ts`                | Project scaffolding; `--runtime` shapes (§4.1).                                             |
| `src/commands/generate.ts`           | Schematic lookup, plugin gating (§3.9), overwrite check (§3.7), dry-run (§3.6), write loop. |
| `src/schematics/plugin.ts`           | `IPlugin` factory module.                                                                   |
| `src/schematics/controller.ts`       | Controller class with decorator imports.                                                    |
| `src/schematics/service.ts`          | Service class.                                                                              |
| `src/schematics/route.ts`            | Route module registering handlers on `ctx.router`.                                          |
| `src/schematics/middleware.ts`       | Middleware factory.                                                                         |
| `src/schematics/guard.ts`            | `requireXxx` guard (gated on `auth-plugin`).                                                |
| `src/schematics/health-indicator.ts` | `IHealthIndicator` (gated on `health-plugin`).                                              |
| `src/schematics/metric.ts`           | Metric registration (gated on `metrics-plugin`). **New file — conflict C5.**                |
| `src/schematics/command-handler.ts`  | `ICommandHandler` (gated on `cqrs-plugin`).                                                 |
| `src/schematics/query-handler.ts`    | `IQueryHandler` (gated on `cqrs-plugin`).                                                   |
| `src/schematics/event-handler.ts`    | `IEventHandler` (gated on `events-plugin`).                                                 |
| `src/schematics/job.ts`              | Scheduler/queue job module.                                                                 |
| `src/schematics/migration.ts`        | Timestamped migration stub (gated on `database-plugin`). **New file — conflict C5.**        |
| `src/schematics/custom.ts`           | `loadSchematic` seam + validation (§3.10).                                                  |
| `src/schematics/registry.ts`         | Name → schematic map plus `requiresPlugin` metadata; the single source `generate` reads.    |
| `src/utils/names.ts`                 | `deriveNames` (§3.3).                                                                       |
| `src/utils/plugin-detector.ts`       | `detectPlugins` (§3.8).                                                                     |
| `src/utils/file-writer.ts`           | Overwrite check + ordered write over `IFileSystem` (§3.1, §3.7).                            |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                               | src covered                                              | Key assertions (and the signature each call type-checks against)                                                                                                                  |
| ------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/args.test.ts`                                | `src/args.ts`                                            | `parseArgs(readonly string[])` — flags before/after positionals, `--key=value`, `--` terminator, unknown flag, empty argv.                                                        |
| `test/unit/names.test.ts`                               | `src/utils/names.ts`                                     | `deriveNames(string): DerivedNames` — `user-profile`, `UserProfile`, `userProfile`, `user_profile`, `user` all yield identical five forms.                                        |
| `test/unit/plugin-detector.test.ts`                     | `src/utils/plugin-detector.ts`                           | `detectPlugins(fs, dir): Promise<ReadonlySet<string>>` — Deno manifest, npm manifest, neither, malformed JSON (empty set, no throw).                                              |
| `test/unit/file-writer.test.ts`                         | `src/utils/file-writer.ts`                               | Writes in order, creates parents with `mkdir(..., {recursive:true})`, and rejects when any target exists — asserted against an in-memory `IFileSystem`.                           |
| `test/unit/cli.test.ts`                                 | `src/cli.ts`, `src/constants.ts`                         | `runCli(argv, deps): Promise<number>` — `0` success, `2` unknown command, `2` missing name, `1` schematic failure, `--version` reads the package version.                         |
| `test/unit/help.test.ts`                                | `src/cli.ts` (help paths)                                | Help text interpolates `PROGRAM_NAME` and contains no literal `hono-enterprise` (§3.11).                                                                                          |
| `test/unit/generate-command.test.ts`                    | `src/commands/generate.ts`, `src/schematics/registry.ts` | Dry-run performs **zero** writes; overwrite aborts with zero writes; a gated schematic is refused when its plugin is absent and allowed when present.                             |
| `test/unit/new-command.test.ts`                         | `src/commands/new.ts`                                    | Each `--runtime` value emits its documented entry shape; `cloudflare-workers` emits `wrangler.toml` and no `listen`; `--dir` roots the paths.                                     |
| `test/unit/schematics/plugin.test.ts`                   | `src/schematics/plugin.ts`                               | `schematic(names, options): readonly GeneratedFile[]` — emits `src/plugins/<kebab>.ts`; contents contain `<Pascal>Plugin`, `name: '<kebab>'`, and an `IPlugin` import.            |
| `test/unit/schematics/controller.test.ts`               | `src/schematics/controller.ts`                           | Emits `src/controllers/<kebab>.controller.ts`; contains `@Controller` and `<Pascal>Controller`.                                                                                   |
| `test/unit/schematics/service.test.ts`                  | `src/schematics/service.ts`                              | Emits `src/services/<kebab>.service.ts`; contains `class <Pascal>Service`.                                                                                                        |
| `test/unit/schematics/route.test.ts`                    | `src/schematics/route.ts`                                | Emits `src/routes/<kebab>.routes.ts`; registers on `ctx.router` at a `/<kebab>` path.                                                                                             |
| `test/unit/schematics/middleware.test.ts`               | `src/schematics/middleware.ts`                           | Emits `src/middleware/<kebab>.middleware.ts`; exports a `<camel>Middleware` factory that calls `next()`.                                                                          |
| `test/unit/schematics/guard.test.ts`                    | `src/schematics/guard.ts`                                | Emits `src/guards/<kebab>.guard.ts`; exports `require<Pascal>`; `requiresPlugin === 'auth-plugin'`.                                                                               |
| `test/unit/schematics/health-indicator.test.ts`         | `src/schematics/health-indicator.ts`                     | Emits an `IHealthIndicator` returning a `HealthStatus`; `requiresPlugin === 'health-plugin'`.                                                                                     |
| `test/unit/schematics/metric.test.ts`                   | `src/schematics/metric.ts`                               | Emits a metric registration using `IMetricsService`; `requiresPlugin === 'metrics-plugin'`.                                                                                       |
| `test/unit/schematics/command-handler.test.ts`          | `src/schematics/command-handler.ts`                      | Emits `<Pascal>Command` + handler implementing `ICommandHandler`; `requiresPlugin === 'cqrs-plugin'`.                                                                             |
| `test/unit/schematics/query-handler.test.ts`            | `src/schematics/query-handler.ts`                        | Emits `<Pascal>Query` + handler implementing `IQueryHandler`; `requiresPlugin === 'cqrs-plugin'`.                                                                                 |
| `test/unit/schematics/event-handler.test.ts`            | `src/schematics/event-handler.ts`                        | Emits an `IEventHandler` subscribing to `<kebab>`; `requiresPlugin === 'events-plugin'`.                                                                                          |
| `test/unit/schematics/job.test.ts`                      | `src/schematics/job.ts`                                  | Emits `src/jobs/<kebab>.job.ts` with a named handler; ungated.                                                                                                                    |
| `test/unit/schematics/migration.test.ts`                | `src/schematics/migration.ts`                            | Emits a timestamped filename with `up`/`down`; the timestamp comes from an INJECTED clock so the assertion is deterministic; `requiresPlugin === 'database-plugin'`.              |
| `test/unit/barrel-exports.test.ts`                      | `src/index.ts`                                           | Every symbol in §4 is importable from the barrel and nothing beyond them is exported — mirrors the existing `packages/openapi-plugin/test/unit/barrel-exports.test.ts` precedent. |
| `test/unit/custom-schematic.test.ts`                    | `src/schematics/custom.ts`                               | Through the injected `loadSchematic`: missing file, module without `schematic`, `schematic` not a function, and success.                                                          |
| `test/integration/custom-schematic-real-import.test.ts` | `src/schematics/custom.ts` (default loader)              | Writes a fixture schematic to a temp dir and loads it via the **real** `import()` — the guarded real-path test CLAUDE.md requires for a lazy import.                              |
| `test/e2e/generate-e2e.test.ts`                         | `src/cli.ts` end-to-end                                  | `runCli(['g','service','user-profile','--dir',tmp])` against a real temp directory, then reads the file back and asserts its contents — a write demonstrated by reading it back.  |

`src/main.ts` is excluded from the coverage bar: it is a two-line
`Deno.exit(await runCli(Deno.args))` wrapper whose only statement is the process-terminating call
that §3.12 exists to isolate. Every other `src/` file above has a named test file.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m34-cli, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

Additionally, because this milestone's product is generated text:

```bash
deno run --allow-all packages/cli/src/main.ts new /tmp/honoe-smoke --runtime deno
cd /tmp/honoe-smoke && deno check main.ts     # generated project must type-check
```

## 8. Risks & mitigations

- **Generated code drifts from the framework's real API.** A schematic emitting a stale import or a
  renamed symbol type-checks fine here — it is a string. → The e2e gate above scaffolds a project
  and runs `deno check` on it, so a drifted template fails the build rather than shipping.
- **13 schematics is a wide surface; a single sloppy one drags coverage below the bar.** → All 13
  share one pure contract (§3.4) and one naming helper (§3.3), so each test file is small and
  uniform; the per-file table is read after every change, not just at the end.
- **`@hono-enterprise/cli` is currently a stub excluded from releases.** Implementing it changes
  `verify-release.ts`'s stub check from "correctly excluded" to "should now publish". → Moving `cli`
  from `UNPUBLISHED_PACKAGES` to `PUBLISHED_PACKAGES` is an explicit deliverable of this PR, and
  `deno task release:verify` fails if the two lists stop covering the workspace.
- **JSR package creation for `@hono-enterprise/cli`.** Publishing it needs the package to exist
  first; the scope's weekly creation quota is currently raised to 40 but may be reinstated at 20. →
  Not a blocker for this milestone (release is a separate step), but noted in `docs/releasing.md`.

## 9. Out of scope

- **Plugin-contributed CLI commands** (`CAPABILITIES.CLI_COMMAND`, `ICliApi`). Reading them requires
  the CLI to import and boot the user's application — entry-point discovery, plugin registration,
  and failure handling for apps that do not start. Deferred to a follow-up milestone; conflict C4
  corrects the misleading JSDoc in the meantime.
- **`new --template rest|microservice`** — Milestone 36 (starters).
- **Publishing `@hono-enterprise/cli` to JSR** — the release process is separate and owned by
  `docs/releasing.md`; this milestone only makes the package publishable.
- **Interactive prompts.** All input is flags and positionals, so every path is scriptable and
  testable without a TTY.
