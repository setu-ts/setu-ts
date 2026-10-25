# Milestone 119h — CLI Output and Commands That Are Wrong (`@setu-ts/cli`)

> **Status:** Complete (archived). Branch: `fix/m119h-cli-output` (a **fix** letter of M119, so a
> `fix/…` branch; one branch for all eleven rows, the M113h and M119g precedent). `develop` and
> `main` are protected — all work stays on this branch until it merges via a single PR.

## 0. Objective & scope

Eleven local defects in what `@setu-ts/cli` generates and how its commands behave, found by the
`v0.10.0` smoke programme (ROADMAP M119h; register rows in `smoke/DEFECTS.md`, findings in
`smoke/X75-X82-FINDINGS.md` and `smoke/V0100-REGRESSION.md`). Each has its cause at one site.

- **In scope:**
  - **V10-18** — `setu generate … --module <m>` reports when the module is not activated.
  - **V10-23** — Workers projects get `test` and `test:e2e`, run against the real Worker on workerd.
  - **V10-24** — `setu agents --check --strict` fails on a missing agent card.
  - **V10-25** — `setu agents` run inside a symlinked workspace member refuses instead of writing a
    standalone brief into the link target.
  - **V10-26** — `setu agents --dry-run` reports what the real run will do: unchanged briefs are not
    written, and an unwritable target is refused in both modes with a named reason.
  - **V10-27** — the ownership refusal gives a remedy per reason.
  - **V10-35** — the generated module's 404 no longer echoes the caller's id.
  - **V10-9** — `setu new --runtime cloudflare-workers` refuses a name wrangler refuses.
  - **V10-10** (+ the V9-13 remainder) — a re-run of an interrupted `setu adopt` reads the project
    manifest from wherever the interrupted run left it.
  - **V10-11** — the generated injectable-service comment names the class-level `@Inject(...)`.
  - **V10-42** — documentation links printed by a published CLI name its own version tag.
- **NOT this milestone:** every documentation-only row (M119i); a production build and multi-stage
  Dockerfile (M120); `setu check` (M118). Workers module tests generated for projects scaffolded
  before this release get no new `package.json` scripts — the upgrade guide says how to add them.

## 1. Contracts verified from SOURCE (not names)

| Reference                     | Source (file:line)                                                                  | Verified surface / fact                                                                                                                                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--module` admission          | `packages/cli/src/commands/generate.ts:375-393`                                     | A module is admitted when `scanModules` finds its files; activation in `src/modules/index.ts` is never read                                                                                                                                        |
| `reportUnwiredSeams`          | `packages/cli/src/commands/generate.ts:677-735`                                     | Inspects only barrels this run WROTE; the `registerModules` config check runs only when `src/modules/index.ts` was written; runs after the write, never in dry-run                                                                                 |
| functional activation barrel  | `packages/cli/src/seams/modules.ts:8-55`                                            | `src/modules/index.ts` exports `registerModules(router, services)` calling `register<Pascal>Module` from `./<kebab>/index.ts`; `registerModuleSymbol(names)`                                                                                       |
| class-based activation barrel | `packages/cli/src/schematics/module-barrel.ts:15-87`                                | `src/modules/index.ts` exports `MODULES` listing `<Pascal>Module`; config passes `modules: [...MODULES]` (`templates/module-seam.ts:117-128`)                                                                                                      |
| source masking                | `packages/cli/src/devtool/sources.ts:110`                                           | `maskSourceCode(source): string \| undefined` masks strings and comments; `undefined` = unclassifiable                                                                                                                                             |
| config reader                 | `packages/cli/src/utils/legacy-layout.ts:90`                                        | `readConfigModule(fs, dir)` returns `''` when unreadable                                                                                                                                                                                           |
| Workers test tasks            | `packages/cli/src/templates/project-files.ts:1236-1251, 1963-1968`                  | Workers `deno.json` `test` is `deno test -A --permit-no-files`; no `test:e2e`; `package.json` has no `test` script; README says no smoke test is emitted                                                                                           |
| module schematic tests        | `packages/cli/src/schematics/module.ts:81-95`                                       | `<name>.test.ts`, `<name>.e2e.test.ts` and `test/support/server.ts` are skipped on `cloudflare-workers`                                                                                                                                            |
| test harness renderers        | `packages/cli/src/schematics/test-harness.ts:46,89,141,174,210`                     | `testHarnessFor(runtime)`, `renderTestServer()` (Node-socket `startTestServer(): { baseUrl, stop }`), `renderModuleTest`, `renderModuleE2e`, `renderAppE2e`                                                                                        |
| Node runner devDependencies   | `packages/cli/src/templates/project-files.ts:1614-1649`                             | `tsx: '^4.20.0'` and `@types/node: '^24.0.0'` (`NODE_TYPES_RANGE`) are added for `node` only                                                                                                                                                       |
| wrangler test harness         | `node_modules/wrangler/wrangler-dist/cli.d.ts:960-1113` (wrangler 4.148.0)          | `createTestHarness({ workers: [{ configPath }] })` → `listen(): Promise<{ url: URL }>`, `fetch`, `close()`; exported from the package root. Generated projects pin `wrangler: '~4.148.0'`                                                          |
| harness probe (this plan)     | scratch probe on published 0.10.0 scaffolds                                         | `rest`, `microservice` (queues + Durable Object bindings) and `full-stack` (after `react-router build`) Workers scaffolds answer 200 on their routes under `tsx --test`; removing `registerModules(...)` makes `/greetings` 404 (negative control) |
| Workers types                 | scratch probe                                                                       | `"types": ["@cloudflare/workers-types", "node"]` with `@types/node@^24` type-checks `node:test` files with `tsc --noEmit`                                                                                                                          |
| agents workspace walk         | `packages/cli/src/commands/agents.ts:80-98`                                         | Walks up from the PHYSICAL `dir`; an ancestor manifest counts only when it lists this exact `memberPath`; otherwise the standalone branch runs unchecked                                                                                           |
| agents dry-run                | `packages/cli/src/commands/agents.ts:148-151`                                       | Prints `would write` for every planned file, including unchanged ones; no writability probe                                                                                                                                                        |
| agents card warnings          | `packages/cli/src/agents/card-presence.ts:34-97`                                    | `cardWarnings(fs, dir, installed, workspaceRoot?)` returns warning strings; called only after a write                                                                                                                                              |
| ownership check               | `packages/cli/src/utils/agent-workspace-ownership.ts:16-48`                         | Reasons `symlink`, `not a directory`, `not owned by you`; every message ends `run \`setu agents\` in a workspace you own`; root-owned directories pass                                                                                             |
| link refusal text             | `packages/cli/src/utils/file-writer.ts:286-291`                                     | `assertInsideProject` says "Replace the link with the files it points at, or remove it, then run this again."                                                                                                                                      |
| dry-run plan reporter         | `packages/cli/src/utils/file-writer.ts:523-546`                                     | `reportDryRunPlan` prints `unchanged <p>` / `would create <p>` / `would update <p>`                                                                                                                                                                |
| temp-file write               | `packages/cli/src/utils/node-regular-file.ts:67-180`                                | Temp name `.<name>.setu-<hex>.tmp`; an `open` failure is wrapped in `RegularFileWriteError(before, cause, false)`, whose message is the raw cause (`EACCES … .tmp`)                                                                                |
| process boundary              | `packages/cli/src/main.ts:85-101`, `packages/cli/src/cli.ts:48-70`                  | `cwd: () => process.cwd()` (physical); `CliDependencies` is exported from `src/index.ts` and has no logical-path member                                                                                                                            |
| 404 detail                    | `packages/cli/src/schematics/module-files.ts:131-136`                               | `notFoundStatement` interpolates `${id}`; used at four sites (lines 182, 198, 263, 279)                                                                                                                                                            |
| project name rule             | `packages/cli/src/commands/new.ts:703-716`, `utils/names.ts:175-185`                | `isPathSegmentSafe` admits Unicode letters, digits, `.` and `-`; `projectName = names.kebab` is written into `wrangler.toml` `name` (`project-files.ts:2185`)                                                                                      |
| wrangler name rule            | `node_modules/wrangler/wrangler-dist/cli.js:60249-60311`                            | `checkWorkerNameValidity`: non-empty, no leading/trailing `-`, only `[a-z0-9-]` (its regex also tolerates a space, which `deriveNames` never emits), at most 63 characters                                                                         |
| adopt probes                  | `packages/cli/src/commands/adopt.ts:191,197`                                        | `detectPlugins(fs, project)` and `detectProjectRuntime(fs, project)` read the ORIGINAL root only                                                                                                                                                   |
| runtime detection             | `packages/cli/src/workspace/runtime-profile.ts:289-305`                             | `deno.json`/`deno.jsonc` → deno; no `package.json` → node; `bun.lock`/`bun.lockb` → bun                                                                                                                                                            |
| plugin detection              | `packages/cli/src/utils/plugin-detector.ts:61-79`                                   | Reads `deno.json(c)` imports, else `package.json` dependencies and devDependencies, of one directory                                                                                                                                               |
| service comment               | `packages/cli/src/schematics/service.ts:95-96`                                      | Says `@Inject('<token>')` goes "on a constructor parameter"                                                                                                                                                                                        |
| `@Inject`                     | `packages/decorator-plugin/src/decorators/injection.ts:67-92`                       | A CLASS decorator taking one token per constructor argument, in order                                                                                                                                                                              |
| printed links                 | `packages/cli/src/commands/add.ts:339`, `packages/cli/src/commands/generate.ts:604` | `blob/develop/…/README.md` and `tree/develop/packages/database-plugin#migrations-and-readiness`; the only two `github.com/setu-ts/setu-ts/(blob\|tree)/` sites in `packages/cli/src`                                                               |
| CLI version                   | `packages/cli/src/version.ts:13`                                                    | `VERSION` literal rewritten by `release:bump`; release tags are `v<version>` (`git tag` lists `v0.10.0`)                                                                                                                                           |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                  | Resolution (picked side)                                                                                   | Doc deliverable (same PR)                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| C1  | `docs/cli.md` §"Flags and exit codes": card presence is deliberately not part of `--check`, so it can run before install; V10-24 asks `--check` to fail on a missing card | Both: `--check` stays install-independent; a new `--strict` (valid only with `--check`) adds card presence | `docs/cli.md` agents flags; `packages/cli/README.md` agents block |
| C2  | `docs/cli.md`: `--dry-run` "prints `would write <path>`"                                                                                                                  | The code changes to `reportDryRunPlan`'s verbs                                                             | `docs/cli.md` agents flags                                        |
| C3  | `docs/cli.md`: a symlinked workspace is refused asking to "run `setu agents` in a workspace you own"                                                                      | Per-reason remedy (§3.6)                                                                                   | `docs/cli.md` §Workspaces                                         |
| C4  | Generated Workers README: "No smoke test is emitted here; `deno task test` permits an empty suite"                                                                        | Workers projects carry tests (§3.2)                                                                        | the generated README (code); `docs/upgrading.md` Unreleased entry |
| C5  | `PUBLIC_API.md` `CliDependencies` row lists no logical working directory                                                                                                  | `CliDependencies` gains optional `logicalCwd` (§3.5)                                                       | `PUBLIC_API.md` `CliDependencies` row                             |

## 3. Design decisions

### 3.1 V10-18 — scoped generation names an inactive module

- **Decision:** after `setu generate <schematic> … --module <m>` writes (and in `--dry-run`, after
  the plan prints), `generate.ts` runs a new `reportInactiveModule(fs, dir, module, mode, error)`
  that reads only existing files, independent of the write set:
  1. Read `src/modules/index.ts` (bounded read, `readExistingText`) and mask it with
     `maskSourceCode`. The module is active when the masked code contains `\b<symbol>\b`, where
     `<symbol>` is `registerModuleSymbol(names)` (functional) or `<Pascal>Module` (class-based). A
     missing, unreadable or unclassifiable barrel counts as inactive (fails toward reporting, the
     `reportUnwiredSeams` rule).
  2. Inactive → three lines on the error channel, exit status unchanged (0):
     `Module "<m>" is not activated in src/modules/index.ts, so its routes are unreachable; add:`
     then the import line and the call (`register<Pascal>Module(router, services);` inside
     `registerModules`) or the array entry (`<Pascal>Module` in `MODULES`).
  3. Active → check the config: `setu.config.ts` masked code references `registerModules`
     (functional) or `MODULES` (class-based); if not, print the existing `registerModules` lines, or
     for class-based `setu.config.ts does not reference MODULES; add it to DecoratorPlugin:` /
     `  modules: [...MODULES]` / `  import { MODULES } from './src/modules/index.ts';`. An empty
     config read (`''`) reports nothing, as today.
  4. `reportUnwiredSeams` keeps its own `registerModules` check for runs that wrote the barrel; the
     new check runs only when `--module` is given, so the two never print for the same run.
- **Why:** the module scanner admits a module from its files, not its activation; a warning (not a
  refusal) keeps the files the developer asked for and matches every other "written but not wired"
  report in `generate`.
- **Test home:** `packages/cli/test/unit/generate-inactive-module.test.ts` (new): functional and
  class-based, barrel line removed → the three lines, exit 0, files written; dry-run prints the same
  lines; barrel active but config missing the export → the config lines; barrel active and config
  wired → no line; barrel mention only inside a comment → reported.

### 3.2 V10-23 — Workers tests run against the real Worker

- **Decision:**
  1. `renderTestServer(runtime)` gains a `cloudflare-workers` variant with the same exported
     `startTestServer(): Promise<{ baseUrl: string; stop: () => Promise<void> }>`, implemented with
     `createTestHarness({ workers: [{ configPath: './wrangler.toml' }] })` from `wrangler`:
     `baseUrl` is the `listen()` URL's origin, `stop` calls `close()`. It is a managed file
     (`test/support/server.ts`), like the socket variant.
  2. Every generated Workers test boots through it, never `createApp()` in-process: a Workers app
     may need platform bindings to boot (the microservice template needs queue and Durable Object
     bindings), and the harness supplies the bindings `wrangler.toml` declares. So on Workers:
     `test/app.test.ts` requests the smoke path through `startTestServer` + `fetch`;
     `test/e2e/app.e2e.test.ts` is emitted with `renderAppE2e` as on the socket targets;
     `renderModuleTest` renders a `fetch`-based `<name>.test.ts` (the same list → create → read-back
     sequence); `module.ts` stops skipping the test files on Workers. `renderModuleE2e` already uses
     `startTestServer` + `fetch` and is unchanged. The `rest` showcase
     (`templates/rest-showcase.ts`) derives its greeting module from `generateModule` and replaces
     its `.test.ts` with an in-process `createTestApp` test; on Workers that replacement is the
     `fetch`-based form too. (`@setu-ts/testing` stays a non-Workers dependency,
     `project-files.ts:1133-1136`.)
  3. Workers `package.json` scripts gain `test`
     (`tsx --test --test-force-exit '**/!(*.e2e).test.ts'`) and `test:e2e`
     (`tsx --test --test-force-exit '**/*.e2e.test.ts'`), the Node arm's commands; a template with
     an npm build (full-stack) prefixes both with `npm run build && `. devDependencies gain
     `tsx: '^4.20.0'` and `@types/node: NODE_TYPES_RANGE`; `tsconfig.json` `types` becomes
     `["@cloudflare/workers-types", "node"]`.
  4. The Workers `deno.json` drops its `test` task (the `--permit-no-files` task is the defect); the
     generated README's Testing section names `npm test` and `npm run test:e2e` and says they run
     the Worker on workerd through wrangler.
- **Why:** the finding's fix is a workerd harness with a route-contract e2e. Compared:
  `@cloudflare/vitest-pool-workers` (what `create-cloudflare` templates ship) adds Vitest and a pool
  version pinned to Vitest 4 beside wrangler; in-process `createApp()` cannot boot the microservice
  template. `createTestHarness` ships in the wrangler version already pinned, is runner-agnostic so
  the project keeps `node:test` like the Node arm, and its probe (§1) passed on all three Workers
  templates with a working negative control.
- **Test home:** `packages/cli/test/unit/schematics/test-harness.test.ts` (Workers server variant
  imports `createTestHarness`, same export signature);
  `packages/cli/test/unit/schematics/module.test.ts` (Workers module emits both test files and the
  managed server); `packages/cli/test/unit/templates.test.ts` (Workers scripts, devDependencies,
  `types`, no `deno.json` `test`, README text); `packages/cli/test/e2e/node-scaffold-e2e.test.ts`
  (the `rest on workers` host runs `test` and `test:e2e` — its comment and `boots`-gated script list
  change; the rest scaffold's greeting module tests run there too);
  `packages/cli/test/unit/templates/rest-showcase.test.ts` (new: the Workers greeting `.test.ts`
  uses `startTestServer`, not `createTestApp`). `feature-module-e2e` drives node, deno and bun only
  and is not extended.

### 3.3 V10-24 — `setu agents --check --strict`

- **Decision:** `--strict` is accepted only with `--check` (alone: usage error, exit 2,
  `--strict requires --check.`). With it, after the freshness comparison, `cardWarnings(...)` runs
  for each brief that has facts and every warning is an error line `<AGENTS.md path>: <warning>`;
  exit 1 when any freshness or card line was printed. `--help` gains
  `--strict    With --check, also refuse a brief whose agent cards are not installed`. Plain
  `--check` is unchanged (C1).
- **Why:** M116 made `--check` install-independent on purpose so CI can run it before install; the
  card check belongs after install, so it is opt-in.
- **Test home:** `packages/cli/test/unit/agents/check-mode.test.ts`: `--check` passes with a missing
  card; `--check --strict` exits 1 naming the card; `--strict` alone exits 2.

### 3.4 V10-26 — dry-run matches the real run

- **Decision:**
  1. The agents command splits the planned briefs: a brief whose spliced contents equal the bytes on
     disk is `unchanged` and is NOT written by the real run (it prints `unchanged <path>`).
  2. `ICliFileSystem` gains optional `canWrite?(path: string): Promise<boolean>` — Node:
     `access(path, W_OK)` for an existing file, else `access(dirname(path), W_OK)`; absent on fakes
     and skipped then. Before any write, and in dry-run, the command checks every brief that would
     change; each unwritable one prints `<path>: not writable by you; nothing was written` (dry-run:
     `WOULD REFUSE: <path> is not writable by you`) and the command exits 1 without writing
     anything.
  3. Dry-run prints through `reportDryRunPlan` (`would create` / `would update` / `unchanged`).
  4. `writeRegularFile` maps an `EACCES`/`EPERM` from opening the temp file to
     `<path>: permission denied creating a file in <directory>` (the `cause` keeps the raw error),
     so no message names the temp file. This applies to every CLI write.
- **Why:** the source comment at `agents.ts:103` promises a dry run "never promises a plan the real
  run refuses"; root-owned directories pass the ownership rule, so writability needs its own probe.
- **Test home:** `packages/cli/test/unit/commands/agents.test.ts` (unchanged brief not rewritten,
  dry-run verbs, a fake `canWrite` returning false refuses both modes with nothing written);
  `packages/cli/test/unit/utils/node-regular-file-write.test.ts` (temp-open `EACCES` → mapped
  message without `.tmp`); `packages/cli/test/integration/agents-ownership.test.ts` (real read-only
  directory: the Node `canWrite`, skipped when running as root).

### 3.5 V10-25 — a symlinked member is refused from inside it

- **Decision:** `CliDependencies` gains optional `logicalCwd?: string`, threaded to
  `IAgentsDependencies`. `main.ts` supplies `process.env['PWD']` only when it is absolute and its
  real path equals the real path of `process.cwd()` (the shell's `pwd -L` rule); otherwise it is
  omitted. When the physical walk finds no workspace and `logicalCwd` differs from the physical
  `cwd`, the command resolves the logical target (`resolveDir(logicalCwd, --dir)`) and walks its
  ancestors with the same manifest rule. A manifest listing the logical target as a member is used
  ONLY to refuse, in every mode:
  `<logical target> is a symlinked member of the workspace at <root>; Setu will not write through links inside a workspace. Replace the link with the directory it points at, then run setu agents from <root>.`
  — exit 1, nothing written. It never authorizes a write.
- **Why:** from the root or a sibling the same member is refused; the physical walk cannot see the
  workspace from inside the link target.
- **Test home:** `packages/cli/test/unit/commands/agents.test.ts` (fake fs: logical path under a
  workspace listing it, physical path elsewhere → refusal in write, `--check` and `--dry-run`);
  `packages/cli/test/integration/agents-ownership.test.ts` (real symlink, real `PWD`);
  `packages/cli/test/unit/process-boundary.test.ts` (`PWD` used only when it resolves to `cwd`).

### 3.6 V10-27 — a remedy per refusal reason

- **Decision:** `assertAgentWorkspaceOwnership` keeps its reasons and attaches a remedy per reason:
  `symlink` →
  `replace the link with the directory it points at, or run setu agents from its real path`
  (followed by ` (<real path>)` when `fs.realPath` resolves it); `not a directory` →
  `fix the workspace layout so every member path is a directory`; `not owned by you` and the
  cannot-check case → the existing `run setu agents in a workspace you own`.
- **Test home:** `packages/cli/test/unit/commands/agents-ownership.test.ts`: one case per reason,
  asserting the remedy and that the symlink case never says "you own".

### 3.7 V10-35 — a fixed 404 detail

- **Decision:** `notFoundStatement` renders the fixed detail `'<Pascal> not found.'` at all four
  sites; the id is not interpolated into the detail or the thrown error. The Problem Details
  `instance` member still carries the percent-encoded request path, set by `@setu-ts/exceptions`
  (audit F1, accepted: Spring sets `instance` to the request path, and Fastify and Express echo the
  encoded path in their default 404).
- **Why:** the caller-supplied id reached the Problem Details body and the warn log. The request
  logger already records the path.
- **Test home:** `packages/cli/test/unit/schematics/module.test.ts` (both arms, with and without
  exceptions: no `${id}` in the 404 statement); `packages/cli/test/e2e/feature-module-e2e.test.ts`
  (`GET /<plural>/%22%3E%3Cimg%20src%3Dx%3E` → 404 body `detail` without the input).

### 3.8 V10-9 — Workers project names wrangler accepts

- **Decision:** `utils/names.ts` adds `isWorkerNameSafe(kebab): boolean`
  (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, at most 63 characters) and `WORKER_NAME_RULE`. `setu new` with
  `--runtime cloudflare-workers` (flag or interactive answer) refuses a name whose kebab fails it,
  exit 2:
  `Invalid Workers project name: "<raw>". wrangler accepts only lowercase letters, digits and -, at most 63 characters.`
  Other runtimes keep the path rule.
- **Test home:** `packages/cli/test/unit/names.test.ts` (table: `shop`, `my-shop`, `a.b`, `café`, 64
  characters); `packages/cli/test/unit/new-command.test.ts`
  (`setu new a.b --runtime cloudflare-workers` exits 2 and writes nothing; `setu new a.b` on Node
  still scaffolds).

### 3.9 V10-10 — an interrupted adoption re-reads the moved manifest

- **Decision:** `adopt.ts` probes plugins and runtime across both the project root and the planned
  member root (`<project>/apps/<member>`): plugins are the union of `detectPlugins` on both
  directories; `detectProjectRuntime` gains an optional second directory, and a marker file counts
  when present in at least one of them. A fresh adoption has no member directory, so its result is
  unchanged. The member root is read only after `assertInsideProject(fs, project, memberRoot)`
  passes; when it throws (a link at `apps/<member>`), the probes use the project root alone and
  planning continues to its existing refusals.
- **Why:** a SIGKILL after some moves leaves the manifest under `apps/<member>/`; the re-run then
  recorded `healthProbes`/`metricsEndpoint: false`, and a Deno project whose `deno.json` had moved
  would be re-detected as Node.
- **Test home:** `packages/cli/test/unit/adopt-command.test.ts`: a fake tree with `package.json`
  (health and metrics plugins) already under `apps/<member>/` → the member record carries
  `healthProbes: true`, `metricsEndpoint: true`; a moved `deno.json` → the workspace runtime stays
  `deno`.

### 3.10 V10-11 — the class-level `@Inject` in the service comment

- **Decision:** the comment at `schematics/service.ts:95-96` says consumers list `'<token>'` in
  their class-level `@Inject(...)`, one token per constructor argument in order.
- **Test home:** `packages/cli/test/unit/schematics/service.test.ts` asserts the new sentence and
  the absence of "on a constructor parameter".

### 3.11 V10-42 — links name the CLI's version tag

- **Decision:** new internal `packages/cli/src/utils/repository-links.ts` exports
  `repositoryFileUrl(path: string): string` →
  `https://github.com/setu-ts/setu-ts/blob/v${VERSION}/${path}`. `add.ts:339` uses it for the
  starter README; `generate.ts:604` uses it for
  `packages/database-plugin/README.md#migrations-and-readiness` (a file link, so the anchor
  resolves).
- **Test home:** `packages/cli/test/unit/utils/repository-links.test.ts` (the URL carries
  `v${VERSION}`); `packages/cli/test/unit/commands/add.test.ts` and
  `packages/cli/test/unit/generate-command.test.ts` (printed line contains `/blob/v` and no
  `develop`).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. One additive optional member on an exported type; ships in
minor 0.11.0.

| Exported symbol                       | Kind              | Consumer / real code path that READS it                                   |
| ------------------------------------- | ----------------- | ------------------------------------------------------------------------- |
| `CliDependencies.logicalCwd` (member) | type member (new) | `cli.ts` passes it to `runAgentsCommand`; `agents.ts` logical walk (§3.5) |

### 4.1 Options — every option names its consumer

| Option                                      | Consumer                        | Behavior (per implementation)                                         |
| ------------------------------------------- | ------------------------------- | --------------------------------------------------------------------- |
| `setu agents --strict`                      | `commands/agents.ts` check mode | Card warnings become check failures (§3.3); refused without `--check` |
| `ICliFileSystem.canWrite` (internal)        | `commands/agents.ts` preflight  | Node: `access(W_OK)`; absent → preflight skipped (§3.4)               |
| `IAgentsDependencies.logicalCwd` (internal) | `commands/agents.ts`            | Refusal-only logical walk (§3.5)                                      |

## 5. Implementation files

| File                                                                                          | Purpose                                                               |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/cli/src/commands/generate.ts`                                                       | §3.1 `reportInactiveModule`; §3.11 migration link                     |
| `packages/cli/src/schematics/test-harness.ts`                                                 | §3.2 Workers `renderTestServer`, fetch-based module/app tests         |
| `packages/cli/src/schematics/module.ts`                                                       | §3.2 Workers module tests                                             |
| `packages/cli/src/templates/project-files.ts`                                                 | §3.2 Workers scripts, devDependencies, `types`, README, files         |
| `packages/cli/src/templates/rest-showcase.ts`                                                 | §3.2 Workers greeting test                                            |
| `packages/cli/src/commands/agents.ts`                                                         | §3.3, §3.4, §3.5                                                      |
| `packages/cli/src/utils/file-writer.ts`                                                       | §3.4 `canWrite` on `ICliFileSystem`                                   |
| `packages/cli/src/utils/node-regular-file.ts`                                                 | §3.4 Node `canWrite`; temp-open permission message                    |
| `packages/cli/src/utils/agent-workspace-ownership.ts`                                         | §3.6 per-reason remedy                                                |
| `packages/cli/src/cli.ts`, `packages/cli/src/main.ts`                                         | §3.5 `logicalCwd`                                                     |
| `packages/cli/src/schematics/module-files.ts`                                                 | §3.7                                                                  |
| `packages/cli/src/utils/names.ts`, `commands/new.ts`                                          | §3.8 (the interactive answers reach the same check: `new.ts:685-713`) |
| `packages/cli/src/commands/adopt.ts`, `workspace/runtime-profile.ts`                          | §3.9                                                                  |
| `packages/cli/src/schematics/service.ts`                                                      | §3.10                                                                 |
| `packages/cli/src/utils/repository-links.ts` (new), `commands/add.ts`                         | §3.11                                                                 |
| `docs/cli.md`, `packages/cli/README.md`, `PUBLIC_API.md`, `docs/upgrading.md`, `CHANGELOG.md` | C1–C5; Unreleased entries per row                                     |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                         | src covered                                          | Key assertions                          |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------- |
| `packages/cli/test/unit/generate-inactive-module.test.ts` (new)                                                   | `commands/generate.ts`                               | §3.1                                    |
| `packages/cli/test/unit/schematics/test-harness.test.ts`                                                          | `schematics/test-harness.ts`                         | §3.2 (1)(2)                             |
| `packages/cli/test/unit/schematics/module.test.ts`                                                                | `schematics/module.ts`, `schematics/module-files.ts` | §3.2 (2), §3.7                          |
| `packages/cli/test/unit/templates.test.ts`                                                                        | `templates/project-files.ts`                         | §3.2 (3)(4)                             |
| `packages/cli/test/unit/templates/rest-showcase.test.ts` (new)                                                    | `templates/rest-showcase.ts`                         | §3.2 (2) Workers greeting test          |
| `packages/cli/test/e2e/node-scaffold-e2e.test.ts`                                                                 | generated Workers project                            | §3.2: `test` and `test:e2e` exit 0      |
| `packages/cli/test/unit/agents/check-mode.test.ts`                                                                | `commands/agents.ts`                                 | §3.3                                    |
| `packages/cli/test/unit/commands/agents.test.ts`                                                                  | `commands/agents.ts`                                 | §3.4, §3.5                              |
| `packages/cli/test/unit/commands/agents-ownership.test.ts`                                                        | `utils/agent-workspace-ownership.ts`                 | §3.6                                    |
| `packages/cli/test/integration/agents-ownership.test.ts`                                                          | `utils/node-regular-file.ts`, `commands/agents.ts`   | §3.4 real `canWrite`, §3.5 real symlink |
| `packages/cli/test/unit/utils/node-regular-file-write.test.ts`                                                    | `utils/node-regular-file.ts`                         | §3.4 (4)                                |
| `packages/cli/test/unit/file-writer.test.ts`                                                                      | `utils/file-writer.ts`                               | type-only member; no new branch         |
| `packages/cli/test/unit/process-boundary.test.ts`, `cli.test.ts`                                                  | `main.ts`, `cli.ts`                                  | §3.5 `PWD` rule and threading           |
| `packages/cli/test/e2e/feature-module-e2e.test.ts`                                                                | generated module                                     | §3.7 no echo                            |
| `packages/cli/test/unit/names.test.ts`, `new-command.test.ts`                                                     | `utils/names.ts`, `commands/new.ts`                  | §3.8                                    |
| `packages/cli/test/unit/adopt-command.test.ts`                                                                    | `commands/adopt.ts`, `workspace/runtime-profile.ts`  | §3.9                                    |
| `packages/cli/test/unit/schematics/service.test.ts`                                                               | `schematics/service.ts`                              | §3.10                                   |
| `packages/cli/test/unit/utils/repository-links.test.ts` (new), `commands/add.test.ts`, `generate-command.test.ts` | `utils/repository-links.ts`, `commands/add.ts`       | §3.11                                   |

Bug-fix proof: each row's new assertion is run once against the unfixed source and shown to fail.

## 7. Verification gates

```bash
git branch --show-current   # MUST be fix/m119h-cli-output
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run check:docs
pnpm run ci:local           # final commit: every shard, per-file coverage ≥90% on every touched src file
pnpm run test:deno-lane
pnpm run release:publish --dry-run
pnpm run release:verify 0.10.0
```

The milestone changes what `packages/cli` generates, so `scaffold-runs-e2e.test.ts` and
`node-scaffold-e2e.test.ts` must run (they are in `ci:local`); one scaffolded Workers project is
also driven by hand: `npm install`, `npm test`, `npm run test:e2e`, then the mount removed to show
`test:e2e` fail.

## 8. Risks & mitigations

- `createTestHarness` is new in wrangler 4.x and could change shape → generated projects pin
  `wrangler: '~4.148.0'`; the Workers row of `node-scaffold-e2e` runs the generated tests on every
  PR, so a wrangler bump that breaks it fails CI before release.
- workerd may be unavailable on a developer's platform (it ships per-platform npm binaries) → the
  same constraint `wrangler dev` already has; the README's Run section depends on it too.
- `PWD` can be stale or forged → used only when it resolves to the physical cwd, and only to refuse.
- `canWrite` races a permission change → the preflight is advisory; the mapped temp-open message
  covers the race without leaking the temp name.

## 8a. Design security review

- **Reviewed flows:** an HTTP client requesting a generated module's `GET/PATCH /:id`; a developer
  running `setu agents` in a workspace whose directories another user or a symlink controls; a
  re-run of `setu adopt` reading manifests from `apps/<member>/` (§3.9); a developer running a
  generated Workers project's `test`/`test:e2e`; a developer running `setu new`/`adopt`/`add`/
  `generate` and reading the printed guidance.
- **Assets:** the generated application's responses and logs (no reflected input); the integrity of
  files outside the developer's own tree (no write through a link or into another user's directory);
  terminal output integrity.
- **Attackers:** an unauthenticated HTTP client sending a hostile id; another local user owning or
  linking a directory in the workspace chain, or planting a link at `apps/<member>` before a re-run
  of `adopt`; a hostile `PWD` value in the environment; a project name chosen to break out of the
  `wrangler.toml` string.
- **Budgets:** the §3.4 `canWrite` preflight adds one `access` call per brief that would change
  (bounded by the workspace member count); the §3.5 logical walk adds one bounded manifest read per
  ancestor of the logical path, only when the physical walk found no workspace and `logicalCwd`
  differs; §3.9 adds one manifest read set for the member root.
- **Audit obligations:** a hostile id (`"><img src=x>`, CR/LF, a 10 KB value) never reaches the 404
  detail or the thrown error's message (the `instance` member echoes the encoded path, F1); a
  logical path never authorizes a write (§3.5 refusal-only); an unwritable target is refused before
  any byte is written in both modes and the message names no temp file; the symlink remedy never
  suggests running in "a workspace you own"; printed links carry no unescaped project input; a link
  at `apps/<member>` contributes nothing to the §3.9 probes (the member root is checked with
  `assertInsideProject` before it is read, and skipped when the check fails); the generated Workers
  `test/support/server.ts` loads only `wrangler` and the project's own `wrangler.toml`, located from
  the file itself rather than the working directory (F2), and starts no process beyond wrangler's
  local workerd; a project name carrying a control character (CR, LF, TAB, NUL, DEL) is refused as
  typed, before whitespace folding, on every runtime (F3), and a Workers name carrying a quote,
  backslash or `.` is refused before anything is written, so nothing but `[a-z0-9-]` reaches
  `wrangler.toml`.

| Threat                                                   | Resolution                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------ |
| Reflected id in the 404 body and log                     | §3.7 fixed detail                                                        |
| Write through a symlinked member                         | §3.5 refusal; existing ownership and containment checks stay             |
| Forged `PWD` steering writes                             | §3.5: validated against the physical cwd, refusal-only                   |
| Partial write into an unwritable tree                    | §3.4 preflight before the first write                                    |
| Temp-file name and raw errno in output                   | §3.4 (4) mapped message                                                  |
| Planted link at `apps/<member>` feeding the adopt probes | §3.9: member root checked with `assertInsideProject`, skipped on failure |
| TOML injection through the Workers project name          | §3.8 name rule `[a-z0-9-]`, at most 63 characters                        |
| Generated test harness running foreign code              | §3.2: harness reads only the project's own `wrangler.toml`               |

**Committed-tree audit of `2527ea36` (fresh Claude agent): three Low findings.**

| Finding                                                                                                                                                            | Disposition                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 — Problem Details `instance` echoes the percent-encoded request path                                                                                            | ACCEPTED: existing `@setu-ts/exceptions` behaviour; Spring sets `instance` to the request path, Fastify 5 and Express 5 echo the encoded path in their default 404 (measured). §3.7 and the obligations above corrected |
| F2 — the generated harness resolved `./wrangler.toml` from the working directory, so a foreign config (and its `[build] command`) ran when tests started elsewhere | FIXED after the audit: `configPath: new URL('../../wrangler.toml', import.meta.url)`                                                                                                                                    |
| F3 — a bare CR/LF/TAB in a project name was folded to `-`, not refused                                                                                             | FIXED after the audit: control characters are refused on the name as typed, on every runtime (create-cloudflare refuses rather than converts)                                                                           |

## 9. Out of scope

- Adding `test`/`test:e2e` scripts to Workers projects scaffolded by 0.10.0 or earlier — the upgrade
  guide shows the two scripts and devDependencies to add.
- Removing the `deno.json` a Workers project still carries — beyond dropping its `test` task, its
  purpose is not this letter's to settle.
- Every documentation-only V10 row — M119i.
