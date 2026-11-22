# Milestone 143b — A First Command That Fails (`@setu-ts/cli`, `@setu-ts/telemetry-plugin`)

> **Status:** Planning. Branch: `feat/m143b-first-command-fails`. `develop` and `main` are protected
> — all work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Eleven `0.13.0` smoke rows where a command the documentation tells a new user to run fails, or
silently does something other than what was asked, in the first hour. After this letter each
documented first command works as written (`--env-file` renamed to a flag Node does not own,
`setu add view` followed by `npm test`, `setu add database --type bigtable` followed by
`npm install`, `setu add messaging --broker pubsub` against the emulator, `setu add telemetry` on
Workers), and a flag with no value, a target that is a file or a non-empty directory, and an
unsupported Node version are refused or warned about by name. First letter of the CLI lane; it edits
only `packages/cli`, `packages/telemetry-plugin` (README only), the comments `apps/*/.dockerignore`
carry from CLI output (`apps/` is in the CLI lane), and the shared files every letter touches
(`CHANGELOG.md`, `PUBLIC_API.md`, `docs/upgrading.md`, ROADMAP row, `CLAUDE.md` status line).
**Deliberate exception:** `docs/cli.md` and `docs/deployment.md` belong to no code lane (M143n, the
Docs letter, runs after every code letter); this letter edits only the sentences in them that name
the CLI's own `--env-file` flag, because leaving them would ship a documented command that cannot
run. No other `docs/` file is touched.

- **In scope:** V13-36, V13-140, V13-141, V13-142 (CLI half), V13-143, V13-145, V13-148, V13-154,
  V13-161, V13-166, V13-168.
- **NOT this milestone:** the `database-plugin` half of V13-142 (M143q, Data lane: a README note
  only, see §3.4); the `OptionalDependencyUnavailableError` text that says "in an npm, Yarn or Bun
  workspace…" on Workers, which is `common` (Core lane, not registered as a row; reported as a
  follow-up); concurrent writers other than `setu` itself (an editor saving `package.json` while
  `add` runs) — out of reach of any CLI lock; SIGTERM rollback (V13-147, M143f); foreign lockfiles
  (V13-167, M143e); misleading `cd` hint with `--dir` (V13-169, M143k).

## 1. Contracts verified from SOURCE (not names)

| Reference                                | Source (file:line)                                                                 | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node consumes `--env-file` after script  | measured, Node 24.22.1: `node a.mjs --env-file nope` → exit 9                      | Node scans the whole argv, script arguments included; `--env-file=x` too. Bun 1.4.5 and Deno 2.9.6 pass it through. `--dotenv` and `--env-path` reach the script on all three. A `--` before it is not consumed, but users do not type `--`.                                                                                                                                                                                                                                                                |
| `parseArgs` valued flag with no value    | `packages/cli/src/args.ts:96-109`                                                  | `--key=` (empty) and `--key` followed by a flag or end of argv are recorded as boolean `true`.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `stringFlag`                             | `packages/cli/src/args.ts:125-131`                                                 | returns `undefined` for `true`, so `new.ts` reads `--template`/`--runtime`/`--dir` as absent.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `VALUE_FLAGS`                            | `packages/cli/src/constants.ts:70-114`                                             | the set of flags that consume the next token; includes `env-file` (`:100`).                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Dispatcher gates                         | `packages/cli/src/cli.ts:175-236`                                                  | control-character gate, `builtInFlagRefusal`, `builtInPositionalRefusal` run before any command body; all return `EXIT_USAGE` (2) through `deps.error`. Plugin commands' flags are checked in their own dispatcher.                                                                                                                                                                                                                                                                                         |
| `--env-file` registration                | `flags.ts:146`, `flags.ts:200`, `templates/env-file.ts:53-80`                      | `new` and `generate app` accept it; `readEnvFilePath(flags)` reads `flags['env-file']`, and two internal callers build a fake flag record (`env-file.ts:138`, `workspace/manifest.ts:430` — a string-keyed record, so a missed key type-checks); `new.ts:216` refuses it with `--workspace`; other mentions: `new.ts:542-543,638,657`, `app.ts:195,357`, `examples/new.ts:84`, `workspace/compose.ts:394` (generated `.dockerignore` comment, committed in `apps/*/.dockerignore`), `templates/rest.ts:37`. |
| `add view` script prefixing              | `packages/cli/src/commands/add-view.ts:154-166`                                    | prefixes the CSS step to `build` and `start:dev` only; `build/` is gitignored and `StaticPlugin({ root: './build/assets' })` reports down while it is missing, so `/health` is 503.                                                                                                                                                                                                                                                                                                                         |
| `add telemetry` peers                    | `packages/cli/src/commands/add.ts:289-303`                                         | peers `@opentelemetry/api`, `sdk-trace-base`, `resources`, `context-async-hooks` restricted to `runtimes: ['node', 'bun', 'deno']`.                                                                                                                                                                                                                                                                                                                                                                         |
| OTel peer ranges                         | `packages/cli/src/templates/client-dependencies.ts:30-34`                          | `api ~1.9.0`, `sdk-trace-base ^2.9.0`, `resources ^2.9.0`, `context-async-hooks ^2.0.0` — the one table of versions.                                                                                                                                                                                                                                                                                                                                                                                        |
| Telemetry loads peers only with exporter | `packages/telemetry-plugin/src/plugin/telemetry-plugin.ts:240-270`                 | a bare `TelemetryPlugin()` loads nothing; `exporter` set → `loadOtelTracerProvider` imports the peers, throwing `OptionalDependencyUnavailableError` (boot failure → Workers answers 503 per request).                                                                                                                                                                                                                                                                                                      |
| Microservice registers telemetry         | `packages/cli/src/templates/microservice.ts:39`, `:239-247`                        | `TelemetryPlugin` in `MICROSERVICE_ADDITIONS` on every runtime; the template declares no `npmDependencies`. The class-based host takes `CLASS_BASED_MODULE_MANIFEST` (`templates/style.ts`), and `withReadmeSection` copies only `readmeSection` from `MICROSERVICE_MANIFEST`, so a peer added to `MICROSERVICE_MANIFEST` alone would miss `--style class-based`.                                                                                                                                           |
| Template npm dependencies                | `packages/cli/src/templates/registry.ts:262-266`, `project-files.ts:1226`          | `TemplateManifest.npmDependencies` is merged into `dependencies` on npm targets and the Deno import map.                                                                                                                                                                                                                                                                                                                                                                                                    |
| Bigtable ERESOLVE                        | measured, npm 11.19.1, scratch projects                                            | telemetry-plugin@0.13.0 + database-plugin@0.13.0 + bigtable ^6 → ERESOLVE (`resources@1` hoisted vs optional peer ^2.9). Adding only `@opentelemetry/resources ^2.9.0` to the project → install exit 0. Bigtable 7.5.1 still pulls ^1.                                                                                                                                                                                                                                                                      |
| Pub/Sub connection                       | `packages/cli/src/workspace/transport.ts:408-451`                                  | `connection.variable = PUBSUB_PROJECT_ID`; the emulator host appears only in `connection.note` and Compose `memberEnv` (workspaces). `PubSubOptions` has no endpoint; the SDK reads `PUBSUB_EMULATOR_HOST` from the environment.                                                                                                                                                                                                                                                                            |
| Broker env rows                          | `packages/cli/src/templates/broker.ts:225-240`, `add.ts:3208-3260`                 | `brokerEnvVariables(spec)` returns one row (the connection variable); `add` appends it to the dotenv and `.example` and never prints `connection.note`.                                                                                                                                                                                                                                                                                                                                                     |
| Generated test scripts                   | `project-files.ts:1662-1684` (npm), `:1300-1317` (Deno), `:1712-1736`              | `start*` scripts load the dotenv (`--env-file-if-exists` on Node, implicit/`--env-file=` on Bun, `--env-file=` on Deno when declared); `test`/`test:e2e` load nothing. `generatedTestScripts` also produces Workers' scripts, and Workers manifests have `envFilePath` stripped (`:338`) and read `.dev.vars`. Node's shared `nodeFlags` (`:1734-1736`) also carries the telemetry preload. The comment at `:1296` says a missing Deno env file is a hard error, which the measurement below contradicts.   |
| Deno missing env file                    | measured, Deno 2.9.6                                                               | `--env-file=nope` prints a warning and continues (exit 0).                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Workspace root test                      | `packages/cli/src/workspace/runtime-profile.ts:237,253`, `root-files.ts:180,210`   | npm `npm run test --workspaces --if-present` exits 1 "No workspaces found!" with no member; Bun `bun run --filter '*' test` exits 1. Measured: npm 11.19.1, Bun 1.4.5.                                                                                                                                                                                                                                                                                                                                      |
| `findExisting` rethrow                   | `packages/cli/src/utils/file-writer.ts:361-380`                                    | rethrows any non-ENOENT stat error; `new.ts:840` does not catch → ENOTDIR stack trace; `examples/new.ts:146` also calls it with no catch.                                                                                                                                                                                                                                                                                                                                                                   |
| `new` target                             | `packages/cli/src/commands/new.ts:813-844`                                         | refuses only exact file collisions; a non-empty directory is written into.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `writeFiles` is not a lock               | `packages/cli/src/utils/file-writer.ts:651-666`                                    | its own JSDoc: "not crash-atomic storage or a lock against concurrent editors".                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `IFileSystem.mkdir`                      | `packages/common/src/runtime.ts:105-111`, `cli/src/utils/node-regular-file.ts:216` | `mkdir(path, { recursive? })`; the JSDoc does not promise EEXIST, but the Node implementation the CLI runs on rejects a non-recursive `mkdir` of an existing path (EEXIST) — an atomic create. `StatResult.mtime` is optional (`runtime.ts:47-55`). `IFileSystem` has no `rename`.                                                                                                                                                                                                                          |
| Engines                                  | `packages/cli/package.json:22-24`, `packages/create/package.json:22-24`            | both `^22.23.4 \|\| ^24.22.1 \|\| >=26.12.1`; `bin.ts` has no version check; `create` runs the same `runMain`.                                                                                                                                                                                                                                                                                                                                                                                              |
| `MainProcess` is published               | `packages/cli/package.json:37-40` (`./main` subpath), `PUBLIC_API.md:11281-11301`  | adding a field to `MainProcess` changes a documented published interface.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| In-process command composition           | `commands/generate.ts:189,204`                                                     | `generate` calls `runAppCommand` and `runLibraryCommand` in the same process.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Workspace root files                     | `workspace/root-files.ts:317-327`, `commands/adopt.ts:69`                          | the root `.gitignore` is written here; `adopt` reuses `workspaceRootFiles`.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Root peer recording                      | `commands/add.ts:2849-2915`                                                        | only `add` records optional peers in an npm/Bun workspace root (M119f); `generate app` does not.                                                                                                                                                                                                                                                                                                                                                                                                            |     |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                  | Resolution (picked side)                           | Doc deliverable (same PR)                                                                        |
| --- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| C1  | `packages/cli/README.md:65` and `docs/cli.md` show `--env-file`, which can never run (Node owns it).      | Code: the flag becomes `--dotenv`.                 | Every `--env-file` CLI mention in `packages/cli/README.md`, `docs/cli.md`, `docs/deployment.md`. |
| C2  | `packages/telemetry-plugin/README.md:17-20` says `add telemetry` records the four peers on every runtime. | README is right; code is wrong (Workers excluded). | None beyond the fix; README re-read and adjusted to name the microservice template too.          |
| C3  | README "Options" promises exit 2 for a missing argument; three flags exit 0.                              | README is right.                                   | None.                                                                                            |

## 3. Design decisions

### 3.1 V13-140 — `--env-file` becomes `--dotenv`

- **Decision:** rename the CLI flag to `--dotenv <path>` for `new` and `generate app` (VALUE_FLAGS,
  both `flags.ts` tables, `readEnvFilePath`, help text, every message that names the flag, the
  `--workspace` refusal). The internal name `envFilePath` stays. `readEnvFilePath` changes to take
  the raw flag value (`string | boolean | readonly string[] | undefined`) instead of a flag record,
  so every caller names the key itself and the compiler sees it: `new.ts`, `app.ts` pass
  `args.flags['dotenv']`; `env-file.ts:138` and `workspace/manifest.ts:430` pass the stored path
  string. Every site in the §1 row is updated, including the generated `.dockerignore` comment in
  `workspace/compose.ts:394` and the six `apps/*/.dockerignore` files that carry it. A literal
  `--env-file` that reaches the CLI (it does under Bun and Deno launchers) is refused by the
  dispatcher with exit 2 (it runs before the positional refusal too, since with `env-file` gone from
  VALUE_FLAGS its path would otherwise be read as a stray positional):
  `--env-file is Node's own option and never reaches setu under Node; use --dotenv <path>.`
  `--env-file` is removed from VALUE_FLAGS and from both flag tables, and the refusal runs before
  `builtInFlagRefusal` so it is the message the user sees instead of "unknown flag".
- **Why:** Node exits 9 before any JavaScript runs; no code in `bin.ts` can intercept it. A shebang
  `env -S node --` would work on Linux but not through npm's Windows command shims. No existing
  users (maintainer rule), so no alias.
- **Test home:** `test/unit/args.test.ts` / `test/unit/flags.test.ts` (rename + refusal); a unit
  test that a workspace manifest whose member has `envFilePaths` still reads after the rename (the
  `manifest.ts:430` caller); the scaffold-and-boot gate row "`--dotenv` scaffold boots and reads the
  chosen file" spawning the built `bin.js` through `node`, so the Node argv path is exercised for
  real. No test asserts Node's own exit 9 (that is Node's behaviour, not Setu's).

### 3.2 V13-145 — a valued flag with no value is refused

- **Decision:** a new dispatcher gate in `cli.ts`, run for built-in commands after the control-
  character gate: every flag in `VALUE_FLAGS` whose parsed value is `true` is refused (a repeatable
  flag with any value-less occurrence already collapses to `true` in `setFlag`, `args.ts:63-70`, so
  no array case exists) with exit 2 and
  `Option --<flag> needs a value (write --<flag>=<value> when the value begins with "-").` Plugin
  commands are not gated (their flags are their handler's). `parseArgs` is unchanged; its JSDoc
  sentence "callers type-check the value" is replaced by a pointer to the gate.
- **Why:** one central check covers every current and future valued flag; per-command checks (the
  existing `--broker needs a value`) stay for direct callers but are unreachable through `runCli`.
  The existing tests that assert those per-command messages through `runCli`
  (`new-command.test.ts:1425,1557,1563`, `app-command.test.ts:429,460`,
  `library-command.test.ts:178`, `logger-choice.test.ts:114`) are updated to the gate's message.
  `--example` with no value now exits 2 with the gate message instead of exit 1 with the offered
  list; accepted (`setu new --help` lists the examples).
- **Test home:** `test/unit/cli-dispatch.test.ts` table over `--template`, `--runtime`, `--dir`,
  `--template=`, `g service foo --dir`, `--depends-on` repeated with a missing value; each exit 2,
  nothing written. Scaffold gate: not needed (no generated output changes).

### 3.3 V13-36 — telemetry peers on Workers and in the microservice template

- **Decision:** one internal constant `TELEMETRY_PEERS` (in `templates/client-dependencies.ts`): the
  four OTel peer names with their pinned ranges, the same on every runtime (Deno's `npm:` prefix is
  added downstream, `project-files.ts:1212`). The `add` table's `telemetry.peers.packages` is
  derived from its keys and its `runtimes` lists all four runtimes, Workers included. The
  microservice template sets `npmDependencies` to it on BOTH hosts: `MICROSERVICE_MANIFEST`
  (functional) and the class-based manifest built in `withReadmeSection`. So a microservice project
  on Node, Bun, Deno and Workers, functional or class-based, lists the peers from the first commit.
  In an npm or Bun workspace, `generate app` also records the template's peers in the workspace root
  through the same root-recording function `add` uses (`add.ts:2849-2915`, extracted if needed so
  both call one implementation), because a root-hoisted plugin cannot load a peer nested only under
  a member (checklist item 10). No other peer (otlp exporter, instrumentations) is added by this
  letter.
- **Why:** a bare `TelemetryPlugin()` needs no peer, but the Workers README and the printed
  registration set `exporter`, and then every route answers 503. Measured by the runner: 200 with
  exactly these four installed.
- **Test home:** unit — `add telemetry` on a Workers fixture records the four peers; the
  `microservice` manifest lists them for every style × runtime; one test asserts the `add` table and
  the template read the same constant; `generate app --template microservice` in an npm workspace
  records them in the root. Scaffold gate — a Workers rest project, `add telemetry`, paste the
  printed registration (`exporter: 'console'`), install, run the generated workerd test: 200
  (guarded the same way as the existing Workers rows).

### 3.4 V13-142 — Bigtable and telemetry install together (CLI half)

- **Decision:** the microservice template lists the OTel peers (§3.3), which alone resolves the
  ERESOLVE (measured: `resources ^2.9.0` at the project level is enough). In addition, when
  `add database --type bigtable` runs on an npm or Bun manifest (`package.json`; ERESOLVE is an npm
  failure, Deno import maps are not affected) that has `@setu-ts/telemetry-plugin` and lacks any of
  the four peers, it records the missing ones through the same peer-recording path `add` already
  uses (member and workspace root per M119f), and prints
  `Added the OpenTelemetry peers telemetry-plugin needs: Bigtable pulls @opentelemetry/resources 1, which npm would otherwise hoist in their place.`
- **M143q half (Data lane, not edited here):** no `database-plugin` code or range change is needed —
  Bigtable 6 and 7 both pull `resources ^1`, so no range fixes it. M143q adds a note to
  `packages/database-plugin/README.md`'s Bigtable section: an application that also uses
  `@setu-ts/telemetry-plugin` lists `@opentelemetry/resources@^2.9.0` (and the other OTel peers) in
  its own `package.json`, which `setu new --template microservice` and `setu add` now write.
- **Test home:** unit — bigtable add on a manifest with telemetry-plugin records the missing peers
  and prints the line, records and prints nothing when they are present, and nothing on a Deno
  import map; scaffold gate (network) — microservice Node, `add database --type bigtable`,
  `npm install` exit 0; and the same in an npm workspace member created by `generate app`.

### 3.5 V13-141 — the CSS build runs before `test`

- **Decision:** `add view` prefixes its CSS call to `test` and `test:e2e` as well as `build` and
  `start:dev`, with the existing rules for an existing script (one already containing
  `run css`/`task css` is noted and kept; a non-string value is noted), except that an absent `test`
  or `test:e2e` stays absent rather than being set to the CSS call alone. Deno runs its `css` task,
  Bun and npm their `css` script.
- **Why:** `/health` is 503 while `build/assets` is missing, and `build/` is gitignored, so every
  fresh clone fails its own `npm test`.
- **Test home:** unit in `test/unit/add-view.test.ts`; scaffold gate — rest Node and Deno:
  `add view`, delete `build/`, run the project's test script: exit 0.

### 3.6 V13-143 — the Pub/Sub emulator host is written and printed

- **Decision:** `TransportConnection` gains an optional `emulator?: { variable; localDefault }`; the
  Pub/Sub arm sets `{ variable: 'PUBSUB_EMULATOR_HOST', localDefault: '127.0.0.1:8085' }`.
  `brokerEnvVariables(spec)` returns a second row for it (description: the SDK reads it and skips
  authentication; remove it to reach real Google Cloud). So `setu new --broker pubsub`,
  `generate app` and `setu add messaging --broker pubsub` write it to the dotenv (local value) and
  the `.example` (empty value). `new` already writes every row with its own `develop` value
  (`new.ts:422`); `add` calls `withEnvVariable`, which handles only `variables[0]` with one value
  (`add.ts:3799-3805`), so `add` loops over the rows and passes each row's own value. `add` also
  prints `connection.note` after the `Connection:` line for every transport that has one. The
  Pub/Sub note is reworded: the dotenv now carries `PUBSUB_EMULATOR_HOST`, so it says the local
  dotenv points the SDK at the emulator and that a deployment leaves the variable unset to reach
  Google Cloud (no "export" instruction); the topics caveat stays. The Compose `memberEnv` key is
  derived from `emulator.variable`, so the name has one source. And the generated `test` and
  `test:e2e` scripts load the project's dotenv the way its `start` scripts do (Node
  `--env-file-if-exists=<dotenv>`, Bun `--env-file=<dotenv>` only for a non-default name — the
  `bun test --env-file=` form is measured before it is used, Deno `--env-file=<dotenv>` when the
  manifest declares one). One helper returns ONLY the env-file fragment and both the start and test
  scripts call it; a Bun test script with a non-default dotenv also appends
  `--env-file=.env.test --env-file=.env.test.local`, because naming any file stops `bun test`
  loading those two and the last file wins (measured on Bun 1.4.5, PR #610 review); the Node
  telemetry preload is not added to test scripts. Workers test scripts get no flag (Workers reads
  `.dev.vars` through wrangler and has no `envFilePath`). The comment at `project-files.ts:1296` is
  corrected to the measured Deno behaviour.
- **Why:** the SDK takes the emulator only from the environment; `setu.config.ts` is evaluated
  before ConfigPlugin runs, so only the process environment reaches it, and the test scripts had
  none. Deno 2.9 warns on a missing env file and continues; Node's flag is `-if-exists`.
- **Test home:** unit — `brokerEnvVariables` for pubsub returns both rows;
  `add messaging --broker pubsub` writes both and prints the note; test scripts carry the env flag
  per runtime. Scaffold gate — `new --template microservice --broker pubsub` and
  `add messaging --broker pubsub`: `.env` holds `PUBSUB_EMULATOR_HOST=127.0.0.1:8085`, and a probe
  test file run by the project's own test script sees it in `process.env`. The real emulator is not
  started (the gcloud image is not local; pulling it is outside this letter) — the M143 gate "proved
  against the emulator" is recorded as open for the release re-run. A unit test asserts the reworded
  note in the generated README.

### 3.7 V13-148 — one `setu` writer per project at a time

- **Decision:** a new internal `utils/project-lock.ts` exports
  `withProjectLock(fs, lockRoot, isAlive, fn)`. It creates `<lockRoot>/.setu-ts/write.lock` with a
  non-recursive `mkdir` (parent created recursively first) and writes `owner.json`
  `{ pid, command }` inside it; on EEXIST it never removes, takes over or rewrites the existing lock
  — every automatic stale-takeover protocol over path-based `mkdir`/`rm` lets two writers in (Codex
  showed two deterministic interleavings: the gap between `mkdir` and the owner write, and two
  contenders acting on the same dead-owner snapshot, one deleting the other's fresh lock). It reads
  the owner only to choose the message, and always refuses with exit 1. A live pid (or an owner that
  is missing or unreadable, which includes the `mkdir`-to-owner window):
  `Another setu command (<command>, pid <pid>) is changing this project; run this again when it finishes.`;
  with the owner details omitted when unknown, followed by
  `If no setu command is running, delete <lockRoot>/.setu-ts/write.lock and run this again.`; an
  owner whose pid is not running:
  `A setu command (<command>, pid <pid>) that is no longer running may have left <lockRoot>/.setu-ts/write.lock.`
  followed by
  `Confirm no setu command is running in this project, then delete it and run this again.` A
  workspace member is locked at its workspace root, found from the path as given and then from its
  real path; a member linked to a project outside the workspace also takes that project's own lock,
  after the workspace lock, so a command run in the project directly is refused (PR #610 review). A
  lock is left behind only when the process is killed without running its `finally` (SIGKILL, power
  loss); SIGINT and thrown errors release it. Released in a `finally` (SIGINT reaches the finally
  through the existing interruption path). Each command acquires it itself, after project detection
  has succeeded (so a refused `add` outside a project leaves no `.setu-ts/` behind) and before its
  first read of a file it will rewrite. There is exactly one acquisition site per command (two
  nested locks only for the linked-out member above): `runGenerateCommand` acquires it before it
  dispatches to schematics, `runAppCommand` or `runLibraryCommand`, and those two never acquire it
  themselves. The lock is not re-entrant: a second acquisition by the same pid refuses like any live
  owner, which is what the concurrency test relies on. `lockRoot` is the workspace root when the
  target is a workspace member (so two members' `add` runs cannot race on the root manifest),
  otherwise the project directory. Applied to `add`, `generate` (schematics, `generate app`,
  `generate library`) and `sync`, and skipped for `--dry-run`. Other commands that rewrite the same
  files — `devtool enable`, `workspace broker`, `workspace rpc`, `adopt` — are not locked by this
  letter; the helper is ready for M143d (`adopt`, workspace) and M143k (devtool), and the report
  names them. `isAlive` comes from `MainProcess` (`process.kill(pid, 0)` on Node; EPERM counts as
  alive) and only selects the message. The scaffolded project `.gitignore` and the workspace root
  `.gitignore` (`root-files.ts:317-327`) both gain `.setu-ts/write.lock/`.
- **Why:** last-writer-wins lost a package 10/10 with `setu check` clean. A compare-before-write in
  `writeFiles` would need every call site to pass the bytes it planned from, and still leaves a
  window; a lock around read-plan-write closes it.
- **Test home:** `test/unit/project-lock.test.ts` (acquire, live-owner refusal naming the path,
  dead-owner refusal naming the path and leaving the lock in place, owner-not-yet-written window
  refused, EPERM counts as alive, release on throw and on interruption, a lock never removed by a
  contender); `generate app` and `generate library` succeed with the lock wired; a refused `add`
  outside a project leaves no `.setu-ts/`; `test/integration/concurrent-add.test.ts` — two
  `runCli(['add', …])` started together against one temp project: each package lands or the second
  exits 1 with the named message, and the final `package.json`/`setu.config.ts` hold every package
  whose run exited 0.

### 3.8 V13-154 — an empty workspace's root test passes

- **Decision:** npm and Bun workspace roots get a generated `scripts/test.mjs` (CLI-owned, beside
  `scripts/dev.mjs` and rendered the way `workspaceDevRunner` renders that file, with the same
  generated-by header) and the root `test` script becomes `node scripts/test.mjs` /
  `bun scripts/test.mjs`. It expands the root `workspaces` globs, and when no matched directory
  holds a `package.json` it prints `No members or libraries yet; nothing to test.` and exits 0;
  otherwise it runs the profile's current `testAll` command and exits with its code. The script runs
  the package manager with `shell: true` on Windows (`process.platform === 'win32'`), where `npm` is
  `npm.cmd`. Deno is unchanged (its root task passes today). `adopt` writes root files through
  `workspaceRootFiles` (`adopt.ts:69`), so an adopted workspace gets the script too. `testAll` stays
  the one owner of the per-member command.
- **Why:** both package managers fail on an empty match. npm has no flag for it; Bun's
  `--if-present` beside `--filter` does exit 0 on an empty match (measured, Bun 1.4.5), but one
  script for both keeps one mechanism and one message.
- **Test home:** unit for the root manifest and script content; scaffold gate — `new --workspace`
  (Node, Bun): root test exit 0 with no member; after `generate app`, a failing member test makes
  the root test fail (exit propagation); a unit test that `adopt`'s root files include the script.

### 3.9 V13-161 and V13-168 — the `new` target must be absent or an empty directory

- **Decision:** before planning writes (and in `--dry-run`, as `WOULD REFUSE`), `new` inspects the
  target path: a non-directory at the target or at any of its ancestors (the `--dir` path included)
  → exit 1 `Cannot create <path>: <ancestor> is a file, not a directory.`; an existing directory
  holding anything other than `.git` → exit 1
  `<path> already exists and is not empty (<n> entries); choose another name or empty it.` When the
  entries look like an interrupted `new` (the existing `interruptedRunRetryHint` condition), its
  hint is printed after the refusal. The same target check runs on the `new --example` path
  (`examples/new.ts`, dispatched at `new.ts:697` before the template path) through one shared
  function. `findExisting` keeps rethrowing (other callers rely on it); the remaining `new.ts` call
  is wrapped so an unexpected filesystem error is reported by name, never as a stack trace.
- **Why:** writing beside a user's files is surprising and hard to undo; a directory with only
  `.git` is a common deliberate target.
- **Test home:** unit in `test/unit/new-command.test.ts` (file target, file ancestor, non-empty dir,
  `.git`-only dir accepted, dry-run refusal, interrupted-run hint kept) and the same file-target and
  non-empty cases through `new --example`.

### 3.10 V13-166 — a warning in the soft band, a refusal below the hard floor

- **Decision (maintainer, 2026-11-22, from the §3.11 comparison):** two bands. Below a **hard floor
  of Node 22.9.0** the CLI refuses with exit 1 and
  `setu needs Node 22.9.0 or newer; this is Node <v>. Supported: ^22.23.4 || ^24.22.1 || >=26.12.1.`
  From 22.9.0 up to but outside the declared `engines` range (`SUPPORTED_NODE` =
  `^22.23.4 || ^24.22.1 || >=26.12.1`) it writes the existing one-line warning and continues (exit
  code unaffected). The floor check runs in `bin.ts` and in the `create` package's bin BEFORE any
  other module is imported. Both bins statically import only `node:process` and the dependency-free
  `node-version` module, call one function `nodeFloorRefusal(versions, isDeno)` that returns the
  refusal message or `undefined` (Bun and Deno always `undefined`), refuse or continue, and only
  then load the rest with a dynamic `import()`. `create` reaches the module through a new subpath
  export `@setu-ts/cli/node-version` (see §4): importing `@setu-ts/cli/main` would load the command
  modules before the check, and a relative path into the CLI's `dist/` assumes an install layout.
  Measured on Node 18 the CLI dies on import (`crypto is not defined`), so a check inside `runMain`
  could never print. The warning stays in `runMain` as built. `HARD_FLOOR_NODE = '22.9.0'` lives
  beside `SUPPORTED_NODE` with the measurement in its JSDoc.
- **How the floor was measured (2026-11-22, official `node:<v>-slim` images, the branch's built
  CLI):** each version ran `setu --version`, `setu new p --template rest --runtime node --yes`, then
  in `p`: `npm install`, `npm test`, `npm run check`, `npm run build`, `npm start` + `GET /health`.

  | Node              | CLI                                         | `npm test`                                              | check / build | `npm start`                                   |
  | ----------------- | ------------------------------------------- | ------------------------------------------------------- | ------------- | --------------------------------------------- |
  | 18.20.8           | crashes on import (`crypto is not defined`) | —                                                       | —             | —                                             |
  | 20.20.2           | works                                       | fails: `node --test` does not expand the generated glob | pass          | 200                                           |
  | 21.7.3            | works                                       | fails (exit 9)                                          | pass          | does not start                                |
  | 22.0.0, 22.8.0    | works                                       | pass                                                    | pass          | `node: bad option: --env-file-if-exists=.env` |
  | 22.9.0, 22.12.0   | works                                       | pass                                                    | pass          | 200                                           |
  | 22.23.4 (control) | works                                       | pass                                                    | pass          | 200                                           |

  22.9.0 is the lowest version on which the CLI and a freshly generated project both work; every
  version below it fails one of the project's own documented commands.

- **Why:** the comparison (§3.11) splits: npm, Vite and the package managers' `engines` checks warn
  and continue; Angular and pnpm warn in a soft band and refuse below a hard floor; Next.js refuses.
  The maintainer chose the Angular/pnpm shape, with the floor set by measurement.
- **Test home:** `test/unit/node-version.test.ts` (range table; floor table incl. 18.20.8, 20.20.2,
  21.7.3, 22.8.0 refused and 22.9.0, 22.12.0 warned; the constant equals both `engines.node`);
  `test/unit/main-node-runtime.test.ts` (warning printed / not printed / skipped under Bun); a bin
  test that spawns the built `bin.js` under a faked version (an injected `process.versions` override
  through a `--import` preload) and asserts exit 1 with the message and no other output, for BOTH
  bins, and that neither bin has a static import besides `node:process` and the `node-version`
  module.

### 3.10a Decisions taken from the comparison (maintainer, 2026-11-22)

- **Missing value exits 2** (§3.2): kept. The parsers exit 1, but this CLI documents exit 2 for
  every usage error and its existing missing-value refusals already exit 2.
- **`--template=` with an empty value is refused** (§3.2): kept. Parsers accept `''`; no setu option
  takes an empty value, and before the fix it silently meant "the default".
- **A held project lock is refused at once, never waited for or taken over** (§3.7): kept, like git.
  Condition, already met by batch 1 and tested: the refusal names the lock path, says how to clear a
  stale one, and says when the owner process is gone.
- **Unsupported Node: soft band and hard floor** (§3.10): changed from warn-only, as above.
- **Security audit risks accepted (the maintainer, 2026-11-22):**
  - A lock release failure after the command itself succeeded exits 1, because a lock left on disk
    refuses the next command. Condition, met in the fix range: the message says the command
    completed and only the lock cleanup failed, names the lock path, and says not to run the command
    again.
  - A dangling `write.lock` symlink is refused as a held lock: the link exists, the refusal names
    it, and deleting it clears the refusal; it fails closed.
  - Compared: git refuses on any existing `.git/index.lock`, even one left by a dead process, and
    tells the user to delete it by hand; `proper-lockfile` reports a failed release as an error
    rather than ignoring it; other tools' exit codes were not verified.

### 3.11 Compared with — sibling commands and established tools

Each decision above that sets a default or a behaviour (rather than repairing a plain bug) was
compared, from primary sources, with this CLI's own commands and with established tools. Sources:
nodejs/node#67642 (open PR, 2026-11-20, "read env files only from Node.js options"); Node
`lib/internal/util/parse_args/parse_args.js` (`checkOptionUsage`); commander `lib/command.js`
(`optionMissingArgument`, `error`); yargs-parser `lib/yargs-parser.ts` (`eatNargs`); cac
`src/command.ts` (`checkOptionValue`); npm `nopt/lib/nopt-lib.js`; create-vite `src/index.ts`
(`isEmpty`); create-next-app `helpers/is-folder-empty.ts`, `create-app.ts`; cargo
`src/ops/cargo_new.rs`, `src/util/flock.rs`; git `lockfile.c` (`unable_to_lock_message`); Yarn
`src/cli/index.js` (`runEventuallyWithFile`); Angular `packages/angular/cli/bin/ng.js`; Next.js
`packages/next/src/bin/next.ts`; Vite `packages/vite/src/node/cli.ts` (`checkNodeVersion`); npm
`lib/cli/validate-engines.js`; pnpm `pnpm11/pnpm/bin/pnpm.mjs`; dotenv-cli and dotenvx READMEs.

| Decision                                           | This CLI's siblings                                                                                          | Established tools                                                                                                                                                                                                                                                     | Verdict                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| §3.1 dotenv flag name `--dotenv`                   | no other env-file flag                                                                                       | Native binaries (Bun, Deno, Docker) use `--env-file`; Node-launched JS tools avoid it (dotenv-cli `-e`, dotenvx `-f`, Vite `--mode` + `envDir`, Next.js none). Node's open PR #67642 confirms Node reads `--env-file` after the script name. No tool uses `--dotenv`. | Matches the practice of avoiding the name; the spelling is ours. |
| §3.2 missing value: refuse                         | `--broker`, `--rpc`, `--scope`, `--logger`, `--port` already refuse with exit 2; README: usage errors exit 2 | parseArgs (strict), commander, cac, yargs `requiresArg` refuse; default yargs and npm's nopt silently take `''`.                                                                                                                                                      | Matches the strict parsers.                                      |
| §3.2 missing value: exit code 2                    | exit 2 for every usage error (`README.md:266,485`)                                                           | commander and yargs exit 1; parseArgs and cac leave it to the caller.                                                                                                                                                                                                 | **Diverges** from the parsers; kept by the maintainer (§3.10a).  |
| §3.2 `--template=` (empty inline value) refused    | —                                                                                                            | parseArgs, commander, cac all accept it as `''`.                                                                                                                                                                                                                      | **Diverges**: stricter; kept by the maintainer (§3.10a).         |
| §3.9 non-empty target refused, `.git` tolerated    | `generate app` refuses an existing member directory                                                          | create-next-app refuses (exit 1, long allow-list); cargo new refuses an existing path (101); `ng new`/`dotnet new` refuse a conflict unless `--force`; create-vite prompts and cancels non-interactively, tolerating only `.git`.                                     | Matches.                                                         |
| §3.7 held lock: refuse at once, never take over    | no sibling lock                                                                                              | git refuses at once (128), names the lock, never removes it, says when the owner is gone; cargo and Yarn `--mutex` wait (their locks cannot stay stale).                                                                                                              | **Split**; matches git; kept by the maintainer (§3.10a).         |
| §3.10 unsupported Node: soft band + measured floor | no sibling check                                                                                             | npm, Vite, npm/pnpm `engines` handling warn and continue; Next.js refuses (1); Angular and pnpm warn in a soft band and refuse below a hard floor (3, 1).                                                                                                             | **Split**; maintainer chose the Angular/pnpm shape (§3.10).      |

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none in TypeScript (two optional fields are added to the published
`MainProcess`, which is additive). The CLI flag `--env-file` is renamed `--dotenv` (a command-line
break, listed under BREAKING in `CHANGELOG.md` and in `docs/upgrading.md`); ships in minor `0.14.0`.

| Exported symbol                                                                                                                           | Kind                                                             | Consumer / real code path that READS it                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MainProcess.nodeVersion?`, `MainProcess.isProcessAlive?`                                                                                 | optional fields, `@setu-ts/cli/main`                             | `runMain` (version warning) and `withProjectLock` (refusal message); `PUBLIC_API.md` `MainProcess` entry updated in the same PR.                                                                                                                                                                                                                                                                                |
| `@setu-ts/cli/node-version` (new subpath): `SUPPORTED_NODE`, `HARD_FLOOR_NODE`, `isNodeBelowFloor`, `isSupportedNode`, `nodeFloorRefusal` | subpath export (`package.json` `exports`, `deno.json` `exports`) | `nodeFloorRefusal` is read by both bins (`packages/cli/src/bin.ts`, `packages/create/src/bin.ts`); `isSupportedNode`/`SUPPORTED_NODE` by `runMain`'s warning; `HARD_FLOOR_NODE`/`isNodeBelowFloor` by `nodeFloorRefusal`. `PUBLIC_API.md` gains the subpath entry. Deviation from the earlier "all internal" plan, taken 2026-11-22 because `create` must check the floor before importing `@setu-ts/cli/main`. |
| Nothing new from any package `src/index.ts`                                                                                               | —                                                                | The other new symbols are internal to `packages/cli` (`TELEMETRY_PEERS`, `withProjectLock`, `TransportConnection.emulator`). `packages/telemetry-plugin` changes only its README.                                                                                                                                                                                                                               |

### 4.1 Options — every option names its consumer

| Option                         | Consumer                                            | Behavior (per implementation)                                   |
| ------------------------------ | --------------------------------------------------- | --------------------------------------------------------------- |
| `--dotenv <path>`              | `readEnvFilePath` → `new`, `generate app`           | same grammar and effect as the old `--env-file`.                |
| `TransportConnection.emulator` | `brokerEnvVariables` → `new`, `generate app`, `add` | pubsub only; other transports leave it undefined.               |
| `MainProcess.nodeVersion`      | `runMain` version check                             | undefined → no check (Bun, Deno, tests that do not set it).     |
| `MainProcess.isProcessAlive`   | `withProjectLock` refusal message                   | undefined → owner treated as alive (the "is changing" message). |

## 5. Implementation files

| File                                                                                                           | Purpose                                                                                                  |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/index.ts`                                                                                    | unchanged (no new export).                                                                               |
| `packages/cli/src/cli.ts`                                                                                      | §3.1 `--env-file` refusal, §3.2 empty-value gate.                                                        |
| `packages/cli/src/args.ts`                                                                                     | JSDoc only (§3.2).                                                                                       |
| `packages/cli/src/constants.ts`, `src/flags.ts`                                                                | `env-file` → `dotenv`.                                                                                   |
| `packages/cli/src/templates/env-file.ts`                                                                       | reads `dotenv`; messages name `--dotenv`.                                                                |
| `packages/cli/src/workspace/manifest.ts`, `examples/new.ts`, `workspace/compose.ts`, `templates/rest.ts`       | `readEnvFilePath` caller and the remaining `--env-file` mentions (§3.1); `examples/new.ts` also §3.9.    |
| `apps/*/.dockerignore` (six files)                                                                             | the regenerated CLI comment naming `--dotenv`.                                                           |
| `packages/cli/src/templates/style.ts` (if the class-based manifest is built there)                             | §3.3 peers on the class-based microservice host.                                                         |
| `PUBLIC_API.md`                                                                                                | `MainProcess` optional fields (§4).                                                                      |
| `packages/cli/src/commands/new.ts`, `commands/app.ts`                                                          | help/refusal text; §3.9 target checks.                                                                   |
| `packages/cli/src/commands/add.ts`                                                                             | §3.3 peers on Workers, §3.4 bigtable peers, §3.6 note printing, §3.7 lock.                               |
| `packages/cli/src/commands/add-view.ts`                                                                        | §3.5 test scripts.                                                                                       |
| `packages/cli/src/commands/generate.ts`, `commands/sync.ts`                                                    | §3.7 lock.                                                                                               |
| `packages/cli/src/templates/client-dependencies.ts`                                                            | `TELEMETRY_PEERS`.                                                                                       |
| `packages/cli/src/templates/microservice.ts`                                                                   | `npmDependencies` from `TELEMETRY_PEERS` on both hosts.                                                  |
| `packages/cli/src/templates/project-files.ts`                                                                  | §3.6 test scripts load the dotenv; §3.7 `.gitignore` line.                                               |
| `packages/cli/src/workspace/transport.ts`, `templates/broker.ts`                                               | §3.6 `emulator` field and second env row.                                                                |
| `packages/cli/src/workspace/runtime-profile.ts`, `workspace/root-files.ts`                                     | §3.8 root test script and `scripts/test.mjs`.                                                            |
| `packages/cli/src/utils/project-lock.ts` (new)                                                                 | §3.7.                                                                                                    |
| `packages/cli/src/utils/node-version.ts` (new)                                                                 | §3.10 comparator, `SUPPORTED_NODE`, `HARD_FLOOR_NODE`, `nodeFloorRefusal`; the `./node-version` subpath. |
| `packages/cli/src/bin.ts`, `packages/create/src/bin.ts`, `packages/cli/package.json`, `packages/cli/deno.json` | §3.10 floor check before any other import; the subpath export.                                           |
| `packages/cli/src/main.ts`                                                                                     | §3.10 check; `nodeVersion`/`isProcessAlive` on the Node host.                                            |
| `packages/cli/README.md`, `docs/cli.md`, `docs/deployment.md`                                                  | §2 C1, and every behaviour above that the docs describe.                                                 |
| `packages/telemetry-plugin/README.md`                                                                          | §2 C2: peers on every runtime, microservice template lists them, Bigtable note.                          |
| `CHANGELOG.md`, `docs/upgrading.md`, `ROADMAP.md`, `CLAUDE.md`                                                 | letter entries.                                                                                          |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                    | src covered                                                                                  | Key assertions                                                                                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/test/unit/cli-dispatch.test.ts`                | `cli.ts`, `args.ts`                                                                          | §3.1 refusal text/exit 2; §3.2 table, nothing written; plugin commands not gated.                                                   |
| existing flag/env-file unit tests                            | `flags.ts`, `constants.ts`, `templates/env-file.ts`                                          | `--dotenv` accepted with the old grammar; `env-file` absent from both tables.                                                       |
| `packages/cli/test/unit/new-command.test.ts`                 | `commands/new.ts`                                                                            | §3.9 cases; `--dotenv` with `--workspace` refused.                                                                                  |
| existing `app` unit tests                                    | `commands/app.ts`                                                                            | `generate app --dotenv`.                                                                                                            |
| `packages/cli/test/unit/add-view.test.ts`                    | `commands/add-view.ts`                                                                       | §3.5 per runtime; existing `css` in `test` noted, absent `test` left absent.                                                        |
| existing `add` unit tests                                    | `commands/add.ts`                                                                            | §3.3 Workers peers; §3.4 bigtable records missing peers / nothing when present; §3.6 note printed.                                  |
| existing template unit tests                                 | `microservice.ts`, `client-dependencies.ts`, `project-files.ts`, `broker.ts`, `transport.ts` | peers in every runtime's manifest; test scripts' env flag per runtime equals the start scripts'; pubsub rows.                       |
| existing workspace unit tests                                | `runtime-profile.ts`, `root-files.ts`                                                        | root `test` script, `scripts/test.mjs` content.                                                                                     |
| `packages/cli/test/unit/project-lock.test.ts` (new)          | `utils/project-lock.ts`                                                                      | §3.7 acquire, refuse live and dead owners by name, never remove a held lock, release on throw, EPERM alive.                         |
| `packages/cli/test/integration/concurrent-add.test.ts` (new) | lock wiring in `add.ts`/`generate.ts`/`sync.ts`                                              | two concurrent runs: no silent loss (fails without the lock: verified by reverting the wiring).                                     |
| `packages/cli/test/unit/node-version.test.ts` (new)          | `utils/node-version.ts`                                                                      | range table; constant equals both `engines.node`.                                                                                   |
| existing `main` unit tests                                   | `main.ts`                                                                                    | warning printed / not printed / skipped.                                                                                            |
| existing workspace manifest unit tests                       | `workspace/manifest.ts`                                                                      | a member with `envFilePaths` still reads after the rename.                                                                          |
| existing examples unit tests                                 | `examples/new.ts`                                                                            | §3.9 file target and non-empty directory through `new --example`.                                                                   |
| existing `generate` unit tests                               | `commands/generate.ts`                                                                       | `generate app`/`library` succeed with the lock; `generate app --template microservice` records OTel peers in an npm workspace root. |
| `packages/cli/test/e2e/scaffold-runs-e2e.test.ts`            | generated output                                                                             | rows named in §3.1, §3.3, §3.4, §3.5, §3.6, §3.8 — each fails on `develop` source.                                                  |

Every row's fix is shown failing first: the brief requires Codex to run each new test against the
unfixed source and record the failure.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m143b-first-command-fails
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test:coverage cli      # ANSI-stripped per-file table; ≥90% branch/function/line on every changed src file
flock /home/dkpaul91/.cache/setu-ts/locks/suite.lock pnpm run ci:local --shard cli
pnpm run release:publish --dry-run
pnpm run release:verify 0.14.0
```

## 8. Risks & mitigations

- Loading the dotenv in generated test scripts changes what every new project's tests see → the
  start scripts already load it and ConfigPlugin already reads the same file, so tests only gain
  parity; the scaffold gate's existing "boots with no dotenv file at all" row keeps the fresh-clone
  case covered.
- A `.setu-ts/write.lock` left by a SIGKILLed run blocks the next command → the refusal says the
  owner is no longer running and names the exact path to delete; no automatic takeover, because
  every takeover over path-based operations admits two writers.
- The scaffold-gate rows that install from npm (Bigtable) are network-bound → they follow the
  existing guarded-install pattern of that file and are run once locally with the result reported.
- `--dotenv` misses a doc site → `rg -- '--env-file'` over docs and CLI sources after the change;
  every remaining hit must be Node's/tsx's/Deno's own flag.

## 9. Out of scope

- The `database-plugin` README note for V13-142 (M143q).
- The `common` optional-dependency message on Workers (Core lane; proposed as a follow-up).
- Proving Pub/Sub against the real emulator image (needs an image pull; the release re-run).
- Foreign lockfiles (V13-167, M143e), SIGTERM rollback (V13-147, M143f), `--dir` next-step text
  (V13-169, M143k).
