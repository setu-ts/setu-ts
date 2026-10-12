# Milestone 101e — CLI commands that write where or when they should not (`@setu-ts/cli`)

> **Status:** Complete (PR #412). Branch: `feat/m101e-cli-write-safety`. `main` is protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Seven `v0.8.0` smoke rows with one shape: a write the CLI performs without checking a precondition
it could have checked — where it is writing (V8-16, V8-35), whether the user still wants the write
(V8-17, V8-38), what the manifest actually says (V8-36), whether the target can use what is written
(V8-37), and whether a path it reports as `created` was in fact modified (V8-41). Every row
reproduces identically on the `0.7.0` control (`smoke/X59-FINDINGS.md`, `smoke/X57-FINDINGS.md`);
none is a regression. The fix is one set of write-safety rules in the command layer, shared by every
command that writes, rather than seven patches.

**Dependencies (decided in the ROADMAP sequence).** This letter depends on nothing. M101f sits on
it: `devtool enable`, `ports --reallocate` and the upgrade fixes reuse the project-detection helper
(§3.1), the JSONC-tolerant manifest reader (§3.5) and the created-versus-updated reporting (§3.7)
this letter introduces. M101g sits on both. Neither later plan redefines those helpers; they cite
this one.

- **In scope:** `setu generate` refusing to write outside a project; a cancelled interactive session
  writing nothing and exiting `130`; SIGINT during a write batch completing the M99b rollback
  instead of dying mid-tree; `generate app` reconciling the workspace manifest against the
  filesystem; reading `deno.json`/`deno.jsonc` with comments; `setu add` refusing a package the
  project's runtime cannot run; honest `created`/`updated` reporting and documented `--no-lock`
  invocation for the CLI itself.
- **NOT this milestone:** the devtool lifecycle rows (M101f: V8-18–V8-22, V8-34); any wiring the
  scaffold is missing (M101g: V8-12–V8-15, V8-31–V8-33, V8-39, V8-40); rewriting a `deno.json` that
  carries comments through `setu add` or `devtool enable` (reading is fixed here; the writer keeps
  refusing, with a better message — §3.5); the dev runner's fail-fast on a member exit (M101g's
  V8-31 decides it).

## 1. Contracts verified from SOURCE (not names)

| Reference                                  | Source (file:line)                                                                            | Verified surface / fact                                                                                                                                                                                                                                                      |
| ------------------------------------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runGenerateCommand` entry                 | `packages/cli/src/commands/generate.ts:130-162`                                               | resolves `--dir`, dispatches `app`/`library`, then calls `detectPlugins` — nothing checks that `dir` is a project or refuses a workspace root; the plugin gate at `:238-255` is the ONLY refusal and an ungated schematic passes it                                          |
| `detectPlugins` / `readManifest`           | `packages/cli/src/utils/plugin-detector.ts:19-38,71-90`                                       | a missing file and a `JSON.parse` failure both return `undefined`, documented as "treated as no plugins detected, never a throw" — so a comment in `deno.json` reads as an empty import map (V8-36) and a non-project directory reads as "no plugins" (V8-16)                |
| `detectTargetRuntime`                      | `packages/cli/src/utils/runtime-detector.ts:57-95`                                            | `wrangler.toml` → `cloudflare-workers`; `package.json` `start` prefix decides bun/node; falls back to `deno` when a `deno.json` sits beside a start-less `package.json`; the bare-`JSON.parse` catch at `:161-168` falls through to `deno`                                   |
| `setu add` workspace refusal               | `packages/cli/src/commands/add.ts:299-308,419-443`                                            | `findWorkspaceMarker` recognises `setu.workspace.json`, a `deno.json` `workspace` key and a `package.json` `workspaces` key — the three root markers §3.1 reuses                                                                                                             |
| `setu add` write path and allow-list       | `packages/cli/src/commands/add.ts:57-96,331-354,386-389`                                      | `ADDABLE` is a flat name map with no runtime column; edits are written with a bare `fs.writeFile` loop (not `writeFiles`), reported as `updated`; a `withDependency` parse failure is refused at `:344-347` ("Cannot read … as JSON") — which is the dead end V8-36 lands on |
| Terminal prompter null mapping             | `packages/cli/src/prompt.ts:89`                                                               | `if (answer === null) return Promise.resolve(undefined);` — Ctrl-D and Ctrl-C both arrive here (Deno's `prompt()` reads in raw mode and returns `null` on `\x03`, measured by X59 on a real pty)                                                                             |
| Interactive `ask` skip                     | `packages/cli/src/commands/new-interactive.ts:86,365-375`                                     | `if (answer === undefined) return;` — an unanswered question leaves the flag absent and the pipeline applies the default (the V8-17 mechanism)                                                                                                                               |
| Where prompting is dispatched              | `packages/cli/src/commands/new.ts:634-637`                                                    | `resolveNewChoices(args, deps.ask, deps.log)` returns a `ParsedArgs`; there is no cancellation arm in its result type                                                                                                                                                        |
| `CliDependencies`                          | `packages/cli/src/cli.ts:45-74`                                                               | `fs`, `cwd`, `now`, `log`, `error`, optional `load`/`loadApp`/`portAvailable`/`ask`; deliberately no default. No signal or interruption member exists                                                                                                                        |
| Process boundary                           | `packages/cli/src/main.ts:17-18,33-51`                                                        | `createDenoRuntimeServices()` is already constructed there; `Deno.exit(await runCli(...))` is the single exit; no `Deno.addSignalListener`                                                                                                                                   |
| `IRuntimeServices.onSignal?`               | `packages/common/src/runtime.ts:40,445`                                                       | `onSignal?(signal: 'SIGTERM' \| 'SIGINT', handler: () => void): void` — additive handlers, never removed; OPTIONAL (absent on Workers and on Windows)                                                                                                                        |
| Deno `onSignal` implementation             | `packages/runtime/src/adapters/deno/deno-runtime.ts:218-222`                                  | delegates to `host.addSignalListener`; omitted entirely on Windows. Registering a listener suppresses Deno's default exit-on-SIGINT (Deno's documented behaviour; re-measured in §7 control 4)                                                                               |
| `writeFiles` rollback and its stated limit | `packages/cli/src/utils/file-writer.ts:254,260-299`                                           | compensates a CAUGHT failure; the JSDoc at `:254` states "process termination cannot execute asynchronous rollback" — the exact V8-38 mechanism. The loop at `:269-274` awaits between files, which is where an interruption can be observed                                 |
| `IFileSystem.stat`/`readFile`/`rm`         | `packages/common/src/runtime.ts:118` (`rm`, required) and the writer's existing use of `stat` | the three members every helper below needs are REQUIRED on the interface — no `common` widening                                                                                                                                                                              |
| `generate app` discovery regeneration      | `packages/cli/src/commands/app.ts:311-320`                                                    | writes a `managed` discovery module for EVERY `next.members` entry without checking that the member's directory exists — the V8-35 resurrection                                                                                                                              |
| `generate app` reporting                   | `packages/cli/src/commands/app.ts:718`                                                        | `for (const file of files) deps.log(\`created ${file.path}\`)`— including the root`deno.json`that`planRootNodeModulesDir`MODIFIED (`workspace/root-manifest.ts:110-119`returns it with`managed: true`)                                                                       |
| Other `created` loops                      | `packages/cli/src/commands/generate.ts:460`, `new.ts:740`                                     | identical wording; `new` never writes over a pre-existing file so only `generate app` mislabels today, but §3.7 fixes the loop once                                                                                                                                          |
| `readWorkspaceManifest` and `MEMBERS_DIR`  | `packages/cli/src/workspace/manifest.ts:27,319`                                               | members live under `apps/<name>`; the manifest reader validates shape, never the filesystem                                                                                                                                                                                  |
| Exit codes                                 | `packages/cli/src/constants.ts:28-34`                                                         | `EXIT_OK = 0`, `EXIT_ERROR = 1`, `EXIT_USAGE = 2`; no interruption code exists                                                                                                                                                                                               |
| `SchedulerPlugin` on Workers               | `packages/scheduler-plugin/src/plugin/scheduler-plugin.ts:151-152`                            | `register()` throws `SchedulerUnavailableError` when `platform() === 'cloudflare-workers'` — a package no Workers project can register                                                                                                                                       |
| `CloudflarePlugin` outside Workers         | `packages/cloudflare-plugin/src/plugin/cloudflare-plugin.ts:70,124`                           | `register()` throws `CloudflareBindingMissingError` when a required binding is absent; a Node/Bun/Deno process has no `env` bindings to pass, so the package cannot register there (V8-37's measured case)                                                                   |
| M99b precedent for the e2e                 | `packages/cli/test/e2e/scaffold-interrupted.test.ts:54-118`                                   | drives real-filesystem failures through `runCli` and asserts byte-identity of the restored tree — the harness §6 extends                                                                                                                                                     |
| Deno `prompt()` facts                      | `packages/cli/src/prompt.ts:7-20` (module doc, measured on deno 2.9.5)                        | `null` in ~1 ms on a non-terminal; bare Enter is `''`; the second argument pre-fills a buffer                                                                                                                                                                                |

**Measured by the smoke run, not inferred.** X59 drove `setu new` on a real pty: `\x03` at
`Runtime?` and `Template?` produced a full minimal project with exit `0`; `kill -INT` to the process
group was also absorbed and the CLI moved to the next prompt. During writes, a SIGINT sweep at 1–2
ms granularity left 17/34, 30/34 and 32/34 files of a full-stack scaffold with status `-2` and no
message, and the retry refused with "Refusing to overwrite existing files" naming the CLI's own
output.

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                          | Resolution (picked side)                                                                                                                                                                                    | Doc deliverable (same PR)                                                                                                               |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `docs/cli.md` "Exit codes" (`:408`) documents `0`/`1`/`2` only; §3.3 adds `130`                                                                                                                                                                                                   | The code gains the new arm; the doc is extended                                                                                                                                                             | `docs/cli.md` Exit codes gains `130 — interrupted; nothing the run wrote remains`                                                       |
| C2 | `plugin-detector.ts:62-65` documents "a missing or malformed manifest yields an empty set … a plain plugin-not-installed gate rather than a crash" — which is the V8-16/V8-36 behaviour                                                                                           | The documented behaviour is the defect. Missing → the command layer refuses (§3.1); malformed → reported by name (§3.5)                                                                                     | The module JSDoc is rewritten to state the new contract                                                                                 |
| C3 | `file-writer.ts:254` states process termination cannot execute rollback, and `smoke/X59` cites it as the V8-38 mechanism                                                                                                                                                          | True for an UNHANDLED signal; §3.4 makes the signal handled, so the sentence is narrowed to what remains uncovered (SIGKILL, power loss)                                                                    | The `writeFiles` JSDoc names the interruption seam and what it still cannot cover                                                       |
| C4 | `docs/cli.md` Install (`:10-18`), `README.md:222`, `packages/cli/README.md:9`, `docs/plugins.md:1241`, `docs/getting-started.md:37` all show `deno install -g … jsr:@setu-ts/cli@…/main` with no note that running the installed binary inside a workspace writes its `deno.lock` | Deno behaviour, not the CLI's — but the install line is where the reader can be told. The global install already runs outside the project's config; the note covers `deno run jsr:…` invocations inside one | Each of the five sites gains one sentence: run the CLI from the global install, or pass `--no-config --no-lock` to an ad-hoc `deno run` |
| C5 | `add.ts:169-170` claims "the emitters this has to agree with sort their maps" — `project-files.ts:862-870` emits `jsrImports` in insertion order and never sorts                                                                                                                  | The comment is false; the behaviour it justifies is V8-40, owned by **M101g**, which fixes the insertion                                                                                                    | None here; recorded so M101g's plan cites a verified fact rather than the comment                                                       |

## 3. Design decisions

### 3.1 Where `setu generate` may write — one project-detection helper

- **Decision:** a new internal `utils/project-detector.ts` exporting
  `detectProject(fs, dir): Promise<ProjectDetection>` with a discriminated result:
  `{ kind: 'project', manifests: readonly ManifestFile[] }`,
  `{ kind: 'workspace-root', marker: string }`, `{ kind: 'none' }`,
  `{ kind: 'unreadable', path: string, reason: string }`. A project is a directory holding at least
  one of `deno.json`, `deno.jsonc`, `package.json`; a workspace root is detected by the three
  markers `findWorkspaceMarker` already uses (`setu.workspace.json`, a `deno.json`/`deno.jsonc`
  `workspace` key, a `package.json` `workspaces` key), and that function MOVES into this module so
  `add` and `generate` share one definition. `runGenerateCommand` calls it before `detectPlugins`
  and refuses `none` (`EXIT_ERROR`, "`<dir>` holds no deno.json, deno.jsonc or package.json — run
  this inside a project, or pass `--dir`"), `workspace-root` (`EXIT_USAGE`, naming the marker and
  `--dir apps/<member>`, the wording `add` already prints) and `unreadable` (§3.5). The bare listing
  (`setu generate` with no schematic, and `--help`) still prints in a non-project directory, because
  it is informational; the refusal sits after it, before any schematic resolves.
- **Why:** `add` already had this rule (C2 of X59 closed it for the workspace case); `generate`
  never did, and the X59 harness proved that an empty directory, a directory holding only user
  files, a project's parent and a workspace root all accept `generate controller` and exit `0`.
  There is no walk-up: the CLI never guesses a project above the cwd, because the one case a walk-up
  would "fix" — running from a subdirectory — is indistinguishable from running in a sibling
  project's parent, and a wrong guess writes into the wrong tree. Reusing the three workspace
  markers rather than only `setu.workspace.json` keeps a hand-built workspace refused too.
- **Test home:** `packages/cli/test/unit/utils/project-detector.test.ts` and
  `packages/cli/test/unit/generate-command.test.ts` (new cases: empty dir, user-files-only dir,
  parent of a project, each of the three root markers — all exit non-zero with nothing written; bare
  listing and `--help` still exit `0`). **Negative control:** remove the `detectProject` call from
  `generate.ts` — the four refusal cases write `src/controllers/*` and exit `0`.

### 3.2 A cancelled interactive session writes nothing

- **Decision:** `Prompter.select` returns a three-way result rather than `string | undefined`:
  `{ kind: 'answer', value }`, `{ kind: 'unavailable' }` (stdin not a terminal, no choices) and
  `{ kind: 'cancelled' }` (the `promptFn` returned `null`, which on a terminal means Ctrl-C or
  Ctrl-D). `resolveNewChoices` returns `{ kind: 'resolved', args }` or `{ kind: 'cancelled' }`; on
  `cancelled` it stops asking at once. `runNewCommand` maps `cancelled` to a new
  `EXIT_INTERRUPTED = 130` (`constants.ts`) with one line on the error sink ("Cancelled; nothing was
  written.") and never reaches the plan or the writer.
- **Why:** both `null` sources are a human stopping the session — the non-terminal case never
  reaches `promptFn` at all (the `isTerminal()` gate at `prompt.ts:78` precedes it), so inside
  `createTerminalPrompter` a `null` is always a user action. Mapping it to "take the default" was
  the mechanism that scaffolded a whole project after Ctrl-C. Distinguishing Ctrl-C from Ctrl-D is
  not possible through `prompt()` and not needed: `130` is the conventional code for an interrupted
  run and is correct for both. The X59 process-group case (`kill -INT` while `prompt()` blocks) is
  covered twice: the prompter's `null` becomes `cancelled`, and the interruption signal of §3.4 is
  checked after every `promptFn` return, so a `''` answer arriving after a delivered SIGINT is also
  treated as cancelled. The `Prompter` interface is exported from `src/index.ts` (`cli.ts:26`
  imports it; `barrel-exports.test.ts` pins it), so this is a **breaking type change for a
  programmatic `Prompter` implementor** — CHANGELOG'd and in `docs/upgrading.md`, with the one-line
  adapter (`{ kind: 'answer', value }`).
- **Test home:** `packages/cli/test/unit/prompt.test.ts` (a `promptFn` returning `null` yields
  `cancelled`; `''` still yields the default; an aborted interruption signal after a `''` answer
  yields `cancelled`), `packages/cli/test/unit/new-interactive.test.ts` (cancellation on the second
  question stops the third from being asked), `packages/cli/test/unit/new-command.test.ts` (exit
  `130`, zero `writeFile` calls on the fake fs, the message on the error sink). **Negative
  control:** restore the `null → undefined` mapping — the `new-command` case writes a full project
  and exits `0`, the X59 observation verbatim.

### 3.3 One interruption seam for the whole CLI

- **Decision:** `CliDependencies` gains an optional `interrupt?: AbortSignal`. `src/main.ts` creates
  an `AbortController`, registers `runtime.onSignal?.('SIGINT', () => controller.abort())` through
  the `IRuntimeServices` it already constructs (never `Deno.addSignalListener` — the boundary rule
  the generated `main.ts` follows too), and passes `controller.signal`. On a runtime that omits
  `onSignal` (Windows) the signal is never aborted and Deno's default termination stays in force —
  byte-identical to today. `runCli` threads the signal to `new`, `generate`, `add`, `devtool`,
  `adopt` and `workspace`; `runCli` itself returns `EXIT_INTERRUPTED` when a command reports
  interruption through a thrown `InterruptedError` (`utils/interruption.ts`, internal).
- **Why:** once a SIGINT listener is registered Deno no longer exits on the signal, so the CLI takes
  ownership of two things: observing the signal at the points where stopping is safe, and exiting
  `130` itself. The signal is deliberately observed only at WRITE boundaries (§3.4) and PROMPT
  boundaries (§3.2), never mid-computation: every other phase of every command is a few milliseconds
  of planning, and letting it run to the next boundary is cheaper and safer than interrupting an
  arbitrary `await`. A run whose writes have all completed before the signal arrives finishes
  normally and exits `0` — the tree is complete, and reporting "interrupted" over a finished
  scaffold would be false. A second SIGINT during rollback is absorbed by the same listener, which
  is the property that lets the rollback finish.
- **Test home:** `packages/cli/test/unit/cli.test.ts` (an already-aborted signal passed to a `new`
  run yields `130` and no writes; an un-aborted one is byte-identical to today),
  `packages/cli/test/unit/process-boundary.test.ts` (the `main.ts` source registers through
  `runtime.onSignal?.` and never names `Deno.addSignalListener` — asserted on the file text, since
  `main.ts` is never imported by a test). **Negative control:** drop the `onSignal` registration
  from `main.ts` — the `scaffold-interrupted` e2e case of §3.4 leaves a partial tree.

### 3.4 SIGINT during a write batch completes the rollback

- **Decision:** `writeFiles(fs, files, options?: { signal?: AbortSignal })` checks `signal.aborted`
  before every file's write and before every directory creation, AND again after each write settles
  — the final write included — still inside the rollback-protected `try`; when set it throws
  `InterruptedError`, which the existing `catch` turns into the M99b rollback (restore pre-existing
  bytes, remove created files, remove created directories deepest-first) before rethrowing. Each
  writing command maps `InterruptedError` to `EXIT_INTERRUPTED` with "Interrupted; the files this
  run wrote were removed." and — when the rollback itself reported an incomplete recovery through
  the existing `AggregateError` — lists the paths that remain. Retry guidance is added once, in
  `findExisting`'s refusal: when every existing path lies under one directory the run would have
  created, the refusal adds "If an earlier run was interrupted before this change, delete `<dir>`
  and run this again."
- **Adoption recovery:** relocation, root writes and the entry rewrite run through one internal
  filesystem journal, `withFileTransaction`. It snapshots only paths the command mutates, checks
  interruption around copies/deletions/directory creation, restores source bytes and removed empty
  directories, and removes destination files and new directories before returning `130`. Recovery
  ignores the aborted signal; unrelated concurrent writes remain untouched. Existing ordinary-I/O
  refusal behavior is retained.
- **Why:** M99b built the compensation and documented at `file-writer.ts:254` that a signal cannot
  reach it; §3.3 makes the signal reach it. Checking BETWEEN writes rather than racing a write in
  progress is what keeps the rollback's invariant: a write that started is recorded in `attempted`
  before it begins, so an interruption observed after it completes still restores it. The post-write
  check is what makes §3.3's boundary exact: a signal that arrives while the LAST write is pending
  arrived before the writes had all completed, so it rolls back; only a signal observed after
  `writeFiles` has returned leaves the finished tree and exits `0`. The `generate app` drift states
  X59 reached — siblings' discovery maps naming a member the manifest does not — are the same batch,
  so the same rollback covers them. The retry hint exists because a pre-fix tree (or a SIGKILL)
  still leaves debris, and the refusal's current wording blames the user's files.
- **Test home:** `packages/cli/test/unit/write-files-rollback.test.ts` (an `AbortController` aborted
  by the fake fs on the Nth write: no new file remains, pre-existing bytes restored, the thrown
  error is `InterruptedError`; aborted before the first write: zero `writeFile` calls; aborted by
  the fake fs DURING the final write, which then succeeds: `InterruptedError` and a complete
  rollback, so no post-write check is skipped for the last file),
  `packages/cli/test/e2e/scaffold-interrupted.test.ts` (REAL filesystem:
  `setu new --template
  full-stack` with a signal aborted from a fake fs wrapper on the 17th write
  leaves the target directory absent; `generate app` into a two-member workspace interrupted on the
  last member's discovery module leaves every file byte-identical to its pre-run contents and the
  manifest unchanged; the immediate retry succeeds). **Negative control:** remove the
  `signal.aborted` check from the loop — the full-stack case leaves a partial tree and the retry
  refuses naming the CLI's own files.

### 3.5 Reading a manifest that carries comments

- **Decision:** a new internal `utils/manifest-reader.ts` exporting
  `readJsonManifest(fs, path): Promise<ManifestRead>` with
  `{ kind: 'ok', value, format: 'json' | 'jsonc' }`, `{ kind: 'missing' }` and
  `{ kind: 'unreadable', reason }`. It parses plain JSON first and, on failure, strips `//` and
  `/* */` comments outside string literals and trailing commas before objects' and arrays' closing
  brackets, then parses again — a ~40-line pure function, unit-tested on the comment-in-string and
  nested-comment cases, because `packages/cli` deliberately has no runtime dependency beyond
  `common` and `runtime` (`packages/cli/deno.json:9-12`). `detectPlugins`, `detectTargetRuntime`,
  `detectProject`, `findWorkspaceMarker` and `devtool`'s `openDenoJson` read through it, and all of
  them accept `deno.jsonc` beside `deno.json`. `generate` reports `unreadable` by name and exits
  `EXIT_ERROR` ("Cannot read `<path>`: <reason>") instead of treating it as empty. The WRITERS
  (`withDependency` in `add`, `openDenoJson`'s `serialize` in `devtool`) do not change what they
  accept: a file whose text is not plain JSON is still refused, but the message now says why and
  what to do — "`<path>` is JSONC (comments, trailing commas); rewriting it would discard them. Add
  this line under `imports` yourself: `"@setu-ts/<pkg>": "jsr:…"`" — and the same for a `deno.jsonc`
  filename.
- **Why:** Deno accepts both forms, so the project is valid; the CLI's reader was not. Reading
  tolerantly closes V8-36's loop (`generate` said the plugin was missing and sent the user to `add`,
  which refused). Writing tolerantly was rejected: `withDependency` re-serialises from the parsed
  object (`add.ts:160-174`), so it would silently delete every comment the developer wrote, which
  X59 item 11 explicitly listed as a property to keep ("No command rewrote comments away"). A
  comment-preserving JSON editor is a different, larger change with its own risk; the refusal with
  the exact line to paste is the honest intermediate.
- **Test home:** `packages/cli/test/unit/utils/manifest-reader.test.ts` (comments, trailing commas,
  a `//` inside a string, a genuinely malformed file → `unreadable`),
  `packages/cli/test/unit/plugin-detector.test.ts` (a commented `deno.json` and a `deno.jsonc` both
  detect the pinned plugins), `packages/cli/test/unit/generate-command.test.ts` (a commented
  manifest no longer refuses a gated schematic; a malformed one exits `1` naming the file),
  `packages/cli/test/unit/commands/add.test.ts` (the JSONC refusal names the line to add).
  **Negative control:** route `detectPlugins` back through bare `JSON.parse` — the commented `rest`
  manifest case reports `health-plugin` missing, the X59 message verbatim.

### 3.6 `generate app` reconciles the manifest against the filesystem

- **Decision:** before planning, `runAppCommand` stats `apps/<name>` for every manifest member; a
  member whose directory is absent is refused by name (`EXIT_ERROR`): "Member `<name>` is in
  `setu.workspace.json` but `apps/<name>` does not exist. Remove its entry (and its `dependsOn`
  references) from the manifest, or restore the directory, then run this again." Nothing is written.
  The same check runs in `ports --reallocate` (M101f inherits it by calling the same helper,
  `workspace/reconcile.ts`, which this letter adds and M101f cites).
- **Why:** `app.ts:314-320` regenerates a discovery module for every manifest member, so a deleted
  member came back as a one-file directory while compose and k8s kept building it. Removing the
  stale entry automatically was rejected: the manifest is the developer's record of intent, a
  missing directory may be an unfinished `git mv`, and a silent removal would also drop the member
  from every sibling's map without a word. A refusal that names the two real remedies is the
  smallest correct change; a `--prune` flag is dead surface until someone asks for it.
- **Test home:** `packages/cli/test/unit/app-command.test.ts` (a manifest naming `beta` with no
  `apps/beta` refuses, writes nothing, names both remedies; with the directory present the plan is
  byte-identical to today), `packages/cli/test/e2e/workspace-e2e.test.ts` (real filesystem: delete
  `apps/beta`, run `generate app gamma`, assert `apps/beta` is still absent and compose does not
  name `gamma`). **Negative control:** remove the stat loop — `apps/beta/src/discovery/services.ts`
  reappears and the command exits `0`.

### 3.7 Honest reporting: `created` versus `updated`

- **Decision:** `writeFiles` returns `readonly WriteOutcome[]` —
  `{ path, outcome: 'created' | 'updated' | 'unchanged' }` — derived from the `before` bytes it
  already captures per file (`file-writer.ts:271-272`): no prior bytes → `created`; prior bytes
  differ → `updated`; prior bytes identical → `unchanged`. The three `created` loops (`new.ts:740`,
  `generate.ts:460`, `app.ts:718`) print the outcome word; `--dry-run` prints `would create` /
  `would update` from the same classification by reading, never writing (`findExisting` already
  stats every unmanaged path; a managed path is read once more under `--dry-run` to classify it).
  `unchanged` paths are printed as `unchanged` so a managed regeneration that changed nothing is
  visible rather than claimed as work.
- **Why:** X57 step 3 reported a modified root `deno.json` as `created`, and X59 item 5 observed
  `generate app` printing `created` for root files it rewrote byte-identically. The bytes needed to
  tell the three apart are already read by the rollback, so the classification costs nothing and
  makes the report true. Returning the outcomes rather than logging from the writer keeps the writer
  silent (every command owns its own sinks).
- **Test home:** `packages/cli/test/unit/file-writer.test.ts` (the three outcomes),
  `packages/cli/test/unit/app-command.test.ts` (the root manifest edit prints `updated`; an
  unchanged Dockerfile prints `unchanged`; `--dry-run` prints `would update` for the root manifest).
  **Negative control:** print `created` unconditionally — the root-manifest case fails on the word.

### 3.8 `setu add` refuses a package the runtime cannot run

- **Decision:** `ADDABLE` gains a per-package `runtimes?: readonly TargetRuntime[]` column, absent
  meaning every target. Exactly two rows carry one, each verified from the plugin's own source:
  `cloudflare-plugin` → `['cloudflare-workers']` (its `register()` needs the platform's `env`
  bindings and throws `CloudflareBindingMissingError` without them), and `scheduler-plugin` →
  `['deno', 'node', 'bun']` (its `register()` throws `SchedulerUnavailableError` on Workers).
  `runAddCommand` detects the runtime BEFORE planning edits and refuses (`EXIT_USAGE`) naming the
  package, the detected runtime, and the reason sentence from the table — nothing written.
- **Why:** the two rows are the ones whose plugin cannot even register on the target; everything
  else degrades by documented design (the messaging cloud gate refuses two of seven brokers on
  Workers while the in-memory broker and M59's `WorkersBroker` work, `worker-pool-plugin` registers
  and throws from `run()`). A longer table would assert runtime facts this plan has not verified,
  and the rule is the CLAUDE.md one: the enumeration lives in a table the test iterates, so a third
  row is a decision with a source citation rather than a guess.
- **Test home:** `packages/cli/test/unit/commands/add.test.ts` (iterates the table: each refused
  pairing exits `2` with nothing written; each allowed pairing writes; the table has exactly the
  rows named here, asserted as data). **Negative control:** drop the runtime check —
  `add cloudflare-plugin` into a `--runtime node` fixture writes the pin and exits `0`.

### 3.9 The CLI's own lockfile side effect (V8-41)

- **Decision:** documentation only, plus §3.7. The `deno.lock` write is Deno's: an ad-hoc
  `deno run jsr:@setu-ts/cli` resolves configuration from the cwd and records the CLI's own
  dependency graph in whatever lockfile it finds. The global install every doc site already
  recommends does not do this (the installed binary carries its own resolution). The five sites in
  C4 gain the one-sentence note with the `--no-config --no-lock` form for an ad-hoc run; the CLI
  itself cannot prevent a host-level write that happens before `main.ts` executes.
- **Why:** there is no CLI code path to change — the lockfile is touched before the first line of
  `main.ts` runs. Saying so where the reader installs the tool is the whole fix.
- **Test home:** none beyond `deno task check:docs`, which already lints the five files. The
  deliverable is one prose sentence per site; this plan says so rather than inventing a test that
  would assert a substring and nothing else.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** `Prompter.select`'s return type changes (§3.2), which breaks a
programmatic `Prompter` implementation — ships in minor `0.9.0`, with the adapter named in §8.

`packages/cli/src/index.ts` changes in exactly one way: the `Prompter` interface's `select` return
type (§3.2). Every other addition is internal to `src/`.

| Exported symbol             | Kind      | Consumer / real code path that READS it                                                                     |
| --------------------------- | --------- | ----------------------------------------------------------------------------------------------------------- |
| `Prompter` (changed)        | interface | `cli.ts` (`CliDependencies.ask`), `new-interactive.ts` (`select`), `src/main.ts` (`createTerminalPrompter`) |
| `PromptSelection` (new)     | type      | the `select` return type; read by `resolveNewChoices` and by any programmatic `Prompter`                    |
| `CliDependencies.interrupt` | field     | `runCli` threads it to every writing command; `src/main.ts` supplies it                                     |

Internal (NOT barrel-exported, pinned by `barrel-exports.test.ts`): `detectProject`,
`readJsonManifest`, `InterruptedError`, `WriteOutcome`, `reconcileMembers`, `EXIT_INTERRUPTED` (a
`constants.ts` value read by `cli.ts`, `new.ts` and every writing command).

### 4.1 Options — every option names its consumer

| Option                      | Consumer                                  | Behavior (per implementation)                                                                                |
| --------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `CliDependencies.interrupt` | `writeFiles` (via each command), prompter | aborted → `InterruptedError` at the next write boundary / `cancelled` at the next prompt; absent → unchanged |
| `writeFiles` `signal`       | the write loop                            | checked before every write and directory creation                                                            |
| `ADDABLE[*].runtimes`       | `runAddCommand`                           | absent → every target; present → refuse any other detected runtime before planning                           |

No new CLI flag. `--prune` (for §3.6) and `--force` (M58) were considered and are not added.

## 5. Implementation files

| File                                                                                               | Purpose                                                                                       |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/cli/src/index.ts`                                                                        | `Prompter` return type change; `PromptSelection` export                                       |
| `packages/cli/src/constants.ts`                                                                    | `EXIT_INTERRUPTED = 130`                                                                      |
| `packages/cli/src/utils/project-detector.ts`                                                       | §3.1 `detectProject`; `findWorkspaceMarker` moves here from `add.ts`                          |
| `packages/cli/src/utils/manifest-reader.ts`                                                        | §3.5 JSONC-tolerant reader                                                                    |
| `packages/cli/src/utils/interruption.ts`                                                           | §3.3 `InterruptedError`, `throwIfInterrupted(signal)`                                         |
| `packages/cli/src/utils/file-writer.ts`                                                            | §3.4 signal checks; §3.7 `WriteOutcome[]` return; `findExisting` retry hint; C3 JSDoc         |
| `packages/cli/src/utils/plugin-detector.ts`                                                        | reads through `readJsonManifest`; `deno.jsonc`; C2 JSDoc                                      |
| `packages/cli/src/utils/runtime-detector.ts`                                                       | reads through `readJsonManifest`                                                              |
| `packages/cli/src/prompt.ts`                                                                       | §3.2 three-way result; signal check after each answer                                         |
| `packages/cli/src/commands/new-interactive.ts`                                                     | §3.2 cancellation propagation                                                                 |
| `packages/cli/src/commands/new.ts`                                                                 | §3.2 exit `130`; §3.3/§3.4 signal threading; §3.7 outcome words                               |
| `packages/cli/src/commands/generate.ts`                                                            | §3.1 refusal; §3.5 unreadable report; §3.3/§3.4; §3.7                                         |
| `packages/cli/src/commands/add.ts`                                                                 | §3.8 runtime table; §3.5 JSONC refusal wording; `findWorkspaceMarker` import; §3.3            |
| `packages/cli/src/commands/app.ts`                                                                 | §3.6 reconciliation; §3.7 outcome words; §3.3/§3.4                                            |
| `packages/cli/src/workspace/reconcile.ts`                                                          | §3.6 `reconcileMembers(fs, dir, manifest)` — shared with M101f                                |
| `packages/cli/src/commands/devtool.ts`                                                             | reads through `readJsonManifest` (JSONC refusal wording on write); §3.3/§3.4 threading        |
| `packages/cli/src/commands/workspace.ts`                                                           | §3.6 reconciliation call; §3.3/§3.4 threading                                                 |
| `packages/cli/src/commands/adopt.ts`                                                               | §3.3/§3.4 threading                                                                           |
| `packages/cli/src/cli.ts`                                                                          | `CliDependencies.interrupt`; `InterruptedError` → `EXIT_INTERRUPTED`                          |
| `packages/cli/src/main.ts`                                                                         | `AbortController` + `runtime.onSignal?.('SIGINT', …)`                                         |
| `docs/cli.md`, `README.md`, `packages/cli/README.md`, `docs/plugins.md`, `docs/getting-started.md` | C1, C4                                                                                        |
| `CHANGELOG.md`, `docs/upgrading.md`                                                                | the `Prompter` type change (breaking for implementors); the new exit code; the `add` refusals |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                      | src covered                                        | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/utils/project-detector.test.ts`                                                                     | `utils/project-detector.ts`                        | `detectProject(fs, dir)` → `none` for empty / user-files-only; `project` for each manifest name incl. `deno.jsonc`; `workspace-root` for each of the three markers; `unreadable` for a malformed manifest                                                                                                         |
| `test/unit/utils/manifest-reader.test.ts`                                                                      | `utils/manifest-reader.ts`                         | `readJsonManifest(fs, path)` → `ok/json`, `ok/jsonc` (line + block comments, trailing commas, `//` inside a string), `missing`, `unreadable` with reason                                                                                                                                                          |
| `test/unit/utils/interruption.test.ts`                                                                         | `utils/interruption.ts`                            | `throwIfInterrupted(signal)` throws `InterruptedError` only when aborted                                                                                                                                                                                                                                          |
| `test/unit/file-writer.test.ts`, `test/unit/write-files-rollback.test.ts`                                      | `utils/file-writer.ts`                             | `writeFiles(fs, files, { signal })` returns `WriteOutcome[]` with the three outcomes; abort on the Nth write rolls back and throws `InterruptedError`; abort before the first write performs zero writes; `findExisting` refusal hint fires only when every existing path is under one would-be-created directory |
| `test/unit/plugin-detector.test.ts`                                                                            | `utils/plugin-detector.ts`                         | commented `deno.json` and `deno.jsonc` detect pins; malformed → the detector reports `unreadable` rather than an empty set                                                                                                                                                                                        |
| `test/unit/utils/runtime-detector.test.ts`                                                                     | `utils/runtime-detector.ts`                        | a commented `package.json` with a `bun` start still detects `bun`                                                                                                                                                                                                                                                 |
| `test/unit/prompt.test.ts`                                                                                     | `prompt.ts`                                        | `select(question, choices)` → `cancelled` on `null`; `answer` on `''` (default) and on a match; `cancelled` on a `''` answer when `interrupt` is aborted; `unavailable` on a non-terminal                                                                                                                         |
| `test/unit/new-interactive.test.ts`                                                                            | `commands/new-interactive.ts`                      | `resolveNewChoices(args, prompter, log, interrupt)` → `cancelled` stops at the cancelled question; counts the questions asked                                                                                                                                                                                     |
| `test/unit/new-command.test.ts`                                                                                | `commands/new.ts`                                  | cancelled session → `130`, zero writes, one error line; an aborted `interrupt` → `130` and zero writes; outcome words in the report                                                                                                                                                                               |
| `test/unit/generate-command.test.ts`                                                                           | `commands/generate.ts`                             | §3.1 refusals (four directory shapes); listing and `--help` still `0` outside a project; §3.5 commented manifest passes the gate, malformed exits `1` by name; interruption → `130`                                                                                                                               |
| `test/unit/commands/add.test.ts`                                                                               | `commands/add.ts`                                  | §3.8 table iterated as data; JSONC refusal names the line to add; workspace refusal still works through the moved `findWorkspaceMarker`                                                                                                                                                                           |
| `test/unit/app-command.test.ts`                                                                                | `commands/app.ts`, `workspace/reconcile.ts`        | missing member refuses with both remedies and zero writes; `updated`/`unchanged` words; `--dry-run` `would update`                                                                                                                                                                                                |
| `test/unit/workspace-command.test.ts`, `test/unit/devtool-refusals.test.ts`, `test/unit/adopt-command.test.ts` | `commands/workspace.ts`, `devtool.ts`, `adopt.ts`  | reconciliation refusal (workspace); JSONC read accepted, JSONC write refused with wording (devtool); interruption → `130` on each                                                                                                                                                                                 |
| `test/unit/cli.test.ts`                                                                                        | `cli.ts`, `constants.ts`                           | `runCli(argv, { …, interrupt })` returns `130` for an aborted signal on a writing command; unchanged without it                                                                                                                                                                                                   |
| `test/unit/process-boundary.test.ts`                                                                           | `main.ts` (source text)                            | names `runtime.onSignal?.` and never `Deno.addSignalListener`                                                                                                                                                                                                                                                     |
| `test/e2e/sigint-scaffold.test.ts`, `test/fixtures/sigint-scaffold.ts`                                         | process boundary                                   | real SIGINT after write 17: handled rollback and successful retry; unhandled control terminates by signal and leaves partial output                                                                                                                                                                               |
| `test/unit/barrel-exports.test.ts`                                                                             | `src/index.ts`                                     | `Prompter`/`PromptSelection` present; none of the internal helpers exported                                                                                                                                                                                                                                       |
| `test/e2e/scaffold-interrupted.test.ts`                                                                        | end to end                                         | real fs: interrupted `new --template full-stack` leaves no target directory; interrupted `generate app` leaves the two-member workspace byte-identical; immediate retry succeeds; a pre-existing debris tree gets the retry hint                                                                                  |
| `test/e2e/generate-e2e.test.ts`, `test/e2e/workspace-e2e.test.ts`                                              | end to end                                         | `generate controller` in an empty temp dir and at a real workspace root exits non-zero with no `src/`; a commented `deno.json` project generates a gated schematic; deleted-member `generate app` leaves it deleted                                                                                               |
| `test/e2e/scaffold-runs-e2e.test.ts`                                                                           | end to end (CLAUDE.md: generated output is BOOTED) | unchanged templates still boot — this letter changes no generated file, which the existing boot matrix proves; one added case boots a project scaffolded through a `Prompter` fake answering `rest` so the new three-way result reaches the real pipeline                                                         |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m101e-cli-write-safety, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check
deno task release:verify 0.8.0
```

Negative controls, each observed failing and reverted (the one named in each §3 decision):

1. §3.1 — remove `detectProject` from `generate.ts`: four directory shapes write and exit `0`.
2. §3.2 — restore `null → undefined`: the cancelled-session case scaffolds a project, exit `0`.
3. §3.4 — remove the `signal.aborted` check: the full-stack interruption leaves a partial tree.
4. §3.3 — omit `onSignal` in the real-process fixture: `sigint-scaffold.test.ts` launches a
   subprocess with real runtime services, pauses after its seventeenth filesystem write and sends
   `SIGINT`. The handled arm exits `130` with no target directory; the unhandled control dies with
   `status.signal === 'SIGINT'` and leaves partial files. Deno exposes the signal separately from
   the exit code (other harnesses render this as `-2`). Both arms are committed regression tests.
5. §3.5 — bare `JSON.parse` in the detector: the commented manifest reports the plugin missing.
6. §3.6 — remove the stat loop: the deleted member's discovery module reappears.
7. §3.7 — print `created` unconditionally: the root-manifest `updated` assertion fails.
8. §3.8 — drop the runtime check: `add cloudflare-plugin` into a Node fixture writes and exits `0`.

Control 4 is the one that proves the process-boundary half: with the listener absent, Deno's default
handler terminates the process before any rollback can run, which is exactly the V8-38 observation.

## 8. Risks & mitigations

- Registering a SIGINT listener makes the CLI responsible for exiting; a code path that never
  reaches a write or prompt boundary after the signal would run to completion → every command ends
  in milliseconds once planning is done, and the one long-running phase (`writeFiles`) checks per
  file. The listener is process-wide, so `dispatchPluginCommand` (which boots the user's
  application) is threaded too: on abort it stops the booted app through its existing teardown and
  exits `130`; §6's `cli.test.ts` covers it. Startup settles before interruption is observed so
  teardown cannot race startup; an in-flight handler is no longer awaited, but arbitrary handler
  code and external side effects cannot be cancelled through the existing `CliCommandHandler`
  contract. Applications release their resources in shutdown hooks.
- `onSignal` is additive and never removed → the CLI registers exactly one listener for its whole
  life, in `main.ts`, and never inside a command.
- The JSONC stripper mis-parses an edge case → it is used for READING only, and a false `unreadable`
  degrades to the loud refusal path rather than a silent empty set; the comment-in-string and
  nested-comment cases are in the unit table.
- `reconcileMembers` turns a transient filesystem state into a refusal → the refusal names both
  remedies and writes nothing, so a wrong refusal costs one re-run.
- Changing `Prompter` breaks a programmatic implementor → named as breaking, with the adapter in
  `docs/upgrading.md`; the only in-repo implementors are `src/main.ts` and the test fakes.
- Three later letters (M101f, M101g) touch the same command files → they rebase on this branch and
  reuse `detectProject`, `readJsonManifest`, `reconcileMembers` and `WriteOutcome` rather than
  adding a second detector or a second created/updated classification.

## 9. Out of scope

- A comment-preserving manifest WRITER (`setu add`/`devtool enable` into a JSONC file) — refused
  with the exact line to add; a future milestone if asked.
- `--prune` on `generate app` and `--force` on `findExisting` — rejected here and in M58.
- The devtool rows that reuse these helpers (M101f) and the scaffold wiring rows (M101g).
- The dev runner's behaviour when one member dies (decided in M101g with V8-31).
- Preventing Deno's own `deno.lock` write before `main.ts` runs — not reachable from the CLI;
  documented (§3.9).
