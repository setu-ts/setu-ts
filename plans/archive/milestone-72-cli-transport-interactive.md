# Milestone 72 — CLI transport selection and interactive scaffolding (`@setu-ts/cli`)

> **Status:** Planning. Branch: `feat/m72-cli-transport-interactive`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Two asks, landed in the order the ROADMAP sets. **First**, a standalone project can choose its
message broker and its job queue at scaffold time, instead of getting a bare `MessagingPlugin()` /
`QueuePlugin()` on the in-memory default and hand-editing `setu.config.ts`. **Second**, `setu new`
can ask for the choices it already accepts as flags, without any path a gate drives ever blocking on
input. The second ask is structural and the first is not, which is why the flag lands first and the
prompt layer is built on top of it rather than beside it: a prompt whose answer no flag can express
would be a second way to configure a project.

- **In scope:** `--broker <name>` and `--queue <name>` on `setu new` for a standalone project,
  derived from the transport registry that already ships rather than from a second table; the
  matching connection variable added to the generated dotenv pair; a per-project
  `docker/compose.yaml` carrying the broker the flag selected, so the scaffold can actually start;
  an optional `ask` seam on `CliDependencies` with a terminal implementation supplied from
  `src/main.ts` only when stdin is a TTY; a `--yes` escape hatch; prompts for `--runtime`,
  `--template`, `--broker` and `--queue` on a standalone `setu new`, and for `--runtime` and
  `--transport` on `setu new --workspace`; and a recurrence gate refusing any stdin or prompt
  reference in `packages/cli/src` outside the two files allowed to carry one.
- **NOT this milestone:** prompting inside `setu generate` in any form, including `generate app`
  (the ROADMAP excludes it, and a generate runs inside scripts and editor hooks); `--queue sqs`
  (§9); a URL-override flag for the standalone arms, which the dotenv pair replaces (§3.6); the full
  Docker and Kubernetes story for a standalone project, which is M39's; realtime authentication
  (M73), realtime registry reads (M74) and broker trace propagation (M75).

## 1. Contracts verified from SOURCE (not names)

Every row below was read in the tree at `feat/m72-cli-transport-interactive`, cut from `main` at
`8a06307f`.

| Reference                          | Source (file:line)                                      | Verified surface / fact                                                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRANSPORT_SPECS`                  | `packages/cli/src/workspace/transport.ts:248`           | Nine arms: `http`, `grpc`, `memory`, `redis`, `rabbitmq`, `nats`, `kafka`, `pubsub`, `service-bus`. Six declare `messagingArgs`; exactly two (`redis`, `rabbitmq`) declare `queueArgs`.                                                                              |
| `TransportSpec`                    | `packages/cli/src/workspace/transport.ts:132`           | `name`, `description`, `plugins`, `messagingArgs?`, `queueArgs?`, `connection?`, `compose?`, `memberFiles?`, `memberTasks?`, `memberImports?`. `messagingArgs`/`queueArgs` take a rendered connection expression and return an argument literal without parentheses. |
| `TransportConnection`              | `packages/cli/src/workspace/transport.ts:72`            | `variable`, `localDefault`, `urlOverridable`, `note?`. The variable and the local default are exactly the two fields an `EnvVariable` row needs.                                                                                                                     |
| `ComposeBacking`                   | `packages/cli/src/workspace/transport.ts:95`            | `services` (YAML at two-space indent, ready to nest under `services:`), `dependsOn`, `condition`, `memberEnv`, `files?`.                                                                                                                                             |
| `withTransport`                    | `packages/cli/src/workspace/member-host.ts:166`         | Module-private. Rewrites the `messaging-plugin` and `queue-plugin` wirings from one rendered connection, appends `transport.plugins`, `memberFiles`, `memberTasks`, `memberImports`.                                                                                 |
| `wrapPluginArgs`                   | `packages/cli/src/workspace/member-host.ts:54`          | Module-private. Splits an argument literal on TOP-LEVEL commas and re-indents it when it exceeds a 60-column budget, so a broker connection read does not overflow the emitted `fmt.lineWidth: 100`.                                                                 |
| `MICROSERVICE_ADDITIONS`           | `packages/cli/src/templates/microservice.ts:33`         | Registers `MessagingPlugin` and `QueuePlugin` with NO arguments. Confirmed the only template that does: a grep for both symbols across `src/templates/` returns hits in this file alone.                                                                             |
| `WORKERS_SWAP`                     | `packages/cli/src/templates/microservice.ts:116`        | `removePackages: ['messaging-plugin', 'queue-plugin']`, replaced by `CloudflarePlugin`. So on `--runtime cloudflare-workers` there is no wiring for a broker arm to rewrite.                                                                                         |
| `applyRuntimeSwap`                 | `packages/cli/src/templates/project-files.ts:243`       | Runs inside `resolveHost`, i.e. BEFORE any transport overlay. Confirms the ordering above rather than assuming it.                                                                                                                                                   |
| `ResolvedHost`                     | `packages/cli/src/templates/project-files.ts:87`        | Carries `plugins`, `files`, `extraTasks`, `extraImports`, `manifest?`, `appFactory?` — every field a standalone broker overlay has to touch.                                                                                                                         |
| `TemplateManifest.envVariables`    | `packages/cli/src/templates/registry.ts:181`            | Optional `readonly EnvVariable[]`, consumed at `project-files.ts:1328` and `:1332` for the gitignored `.env` and the tracked `.env.example`.                                                                                                                         |
| `EnvVariable`                      | `packages/cli/src/templates/registry.ts:122`            | `{ name, description, develop }` — a `TransportConnection` supplies `name` and `develop` directly.                                                                                                                                                                   |
| `denoPermissions`                  | `packages/cli/src/templates/project-files.ts:941`       | The generated `start` task always carries an UNSCOPED `--allow-net`, so a broker connection needs no permission change. Checked because M63's D2 was exactly a missing permission on this task.                                                                      |
| `CliDependencies`                  | `packages/cli/src/cli.ts:41`                            | `fs`, `cwd`, `now`, `log`, `error`, and three OPTIONAL members (`load?`, `loadApp?`, `portAvailable?`). An optional `ask?` follows that precedent and breaks no programmatic caller.                                                                                 |
| `runCli`                           | `packages/cli/src/cli.ts:114`                           | Returns a `Promise<number>` and never calls `Deno.exit`; `src/main.ts:23` owns the single exit.                                                                                                                                                                      |
| `VALUE_FLAGS`                      | `packages/cli/src/constants.ts:66`                      | Eleven entries, including `transport` and `transport-url`. A flag absent from the set becomes boolean `true` and its value becomes a POSITIONAL, so `--broker` and `--queue` must be added here.                                                                     |
| standalone `--transport` refusal   | `packages/cli/src/commands/new.ts:282`                  | `--transport` and `--transport-url` are BOTH refused on a standalone project today, naming `new --workspace`. So the broker flag is genuinely new surface, not a widening of an accepted one.                                                                        |
| workspace `--transport` acceptance | `packages/cli/src/commands/new.ts:142`                  | `readTransport(args)` is reached from `planWorkspace` only. This is what makes the ROADMAP's "the broker is not selectable at all" true of a standalone project and false of a workspace (§2, C1).                                                                   |
| `generate app` transport refusal   | `packages/cli/src/commands/app.ts:331`                  | Refuses `--transport`/`--transport-url` because a member inherits the workspace's. The broker flags need the same refusal in the same place.                                                                                                                         |
| starter-composed refusal           | `packages/cli/src/commands/app.ts:204`                  | `contributes = transport.plugins.length > 0 \|\| transport.messagingArgs !== undefined`, refused when `template.appFactory !== undefined`, because the factory branch DROPS a plugin-list overlay.                                                                   |
| `QueueAdapterType`                 | `packages/queue-plugin/src/interfaces/index.ts:172`     | `'memory' \| 'redis' \| 'rabbitmq' \| 'sqs'`. The registry declares `queueArgs` for two of the four; `memory` is the default and `sqs` has no arm (§9).                                                                                                              |
| `MessagingPluginOptions`           | `packages/messaging-plugin/src/interfaces/index.ts:376` | Eight arms; seven are named brokers (`memory`, `redis-streams`, `rabbitmq`, `nats`, `kafka`, `pubsub`, `service-bus`) and one is `custom`. The registry covers every named arm.                                                                                      |
| `workspaceProfile` / `envRead`     | `packages/cli/src/workspace/runtime-profile.ts:84`      | `envRead(variable, fallback)` renders the environment read as source, per runtime. Defined for `deno`, `node` and `bun` only — Cloudflare Workers has no profile, which matches the swap above.                                                                      |
| root `test/state-key-convention`   | `test/state-key-convention.test.ts:28`                  | The precedent for a source-scanning recurrence gate: a regex sweep over package sources with an explicit, asserted allowlist.                                                                                                                                        |
| `docs/cli.md` fence budget         | `test/guide-fence-compiler.test.ts:69`                  | `total: 12, ts: 1, compile: 1, skipped: 11`. Shell and tree fences count toward `total` and `skipped`, so any fence added to that guide moves two numbers.                                                                                                           |
| CLI test permissions               | `packages/cli/deno.json` `test.permissions`             | `read`, `write`, `env`, `sys: [hostname, cpus]`, `net: ['127.0.0.1']`, `run: ['deno']`. A boot test spawns the generated project, whose own task flags govern its network access.                                                                                    |
| CI job env                         | `.github/workflows/ci.yml:16`                           | `REDIS_URL: redis://localhost:6379` is JOB-level, so it reaches the CLI package's tests, and a `redis:7` service container backs it.                                                                                                                                 |

### 1.1 Runtime facts established by probe, not by documentation

Deno's built-in `prompt()` is the mechanism the terminal implementation uses, so its behaviour was
measured on `deno 2.9.5` rather than read. Each of these changed a design decision.

| Probe                                                 | Result                                                          | What it decides                                                                                                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt()` with stdin closed (`< /dev/null`)          | returns `null` in ~1 ms                                         | The built-in cannot hang a non-interactive run.                                                                                                                |
| `prompt()` with an open pipe carrying data            | returns `null` in ~1 ms, consuming nothing                      | It gates on `isTerminal()`, not on data availability, so piped input never reaches it.                                                                         |
| `prompt()` / `confirm()` under `deno test`            | `null` / `false`, ~1 ms                                         | Every existing gate is safe by construction even before the `ask` seam is considered.                                                                          |
| `Deno.stdin.isTerminal()` under a pty via `script(1)` | `true`; `prompt()` returned the typed line                      | The interactive path is real and is drivable in a test through a pty.                                                                                          |
| bare Enter at a pty prompt                            | returns `''`, not `null`                                        | `''` and `null` are distinguishable: `''` means "accept the default", `null` means "cannot ask".                                                               |
| `prompt(message, second)` at a pty                    | returned `"restaaa"` for a second argument `rest` + typed `aaa` | The second argument PRE-FILLS an editable buffer and typed text appends to it. It is not a fallback, so §3.7 renders the default in the question text instead. |
| a second `prompt()` after input is exhausted          | returns `null`                                                  | Mid-session EOF looks exactly like a non-terminal, and both mean "stop asking".                                                                                |
| `prompt()` with no permission flags at all            | works                                                           | Prompting adds no permission to the installed `setu`.                                                                                                          |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                                                    | Resolution (picked side)                                                                                                                                                                                                                                                                                 | Doc deliverable (same PR)                                                                                                                                                                                           |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `ROADMAP.md:7363` states "the **broker is not selectable at all**". `packages/cli/src/workspace/transport.ts` ships nine selectable transports and `PUBLIC_API.md:5567` documents `--transport`, both merged on `main` at `1f62926b` (2026-08-10) — two weeks BEFORE the M72 section was written (PR #186, 2026-08-25). The claim is true of a standalone project and false of a workspace. | The narrow claim is the true one. The gap this milestone closes is the STANDALONE project, and the mechanism is reused rather than rebuilt.                                                                                                                                                              | Rewrite the M72 ROADMAP gap paragraph to say "not selectable for a standalone project", cite `commands/new.ts:282` as the refusal that proves it, and note that the workspace half shipped with the transport work. |
| C2 | The same paragraph's grep evidence (`prompt\|stdin\|confirm(\|readLine\|@std/cli` over `packages/cli/src` returns ONE hit) no longer holds: `src/workspace/dev-runner.ts:94` carries `stdin: 'inherit'`, inside the dev-runner source the CLI EMITS rather than executes.                                                                                                                   | The conclusion stands (the CLI still prompts nowhere) and the evidence does not. Emitted source and executed source must be told apart, which is what §3.10's allowlisted gate does instead of a bare grep.                                                                                              | Correct the ROADMAP evidence line to name the emitted-source hit, so the next reader is not misled into thinking a bare grep is a sufficient gate.                                                                  |
| C3 | `packages/cli/README.md:218` lists "**Plugin installation.** `setu` generates and dispatches; it does not edit your manifest" under **Not yet supported**, while `setu add` shipped in M70h and is documented at `PUBLIC_API.md` and `docs/cli.md`.                                                                                                                                         | `setu add` ships; the README bullet is stale. Corrected here because this milestone rewrites the section immediately above it (Options) and the same list is where the interactive behaviour has to be described.                                                                                        | Delete the stale bullet from `packages/cli/README.md` and replace the list's coverage of interactivity with what actually ships.                                                                                    |
| C4 | `packages/cli/src/commands/app.ts:212` refuses a starter-composed member with "scaffold it standalone with `setu new <name> --template full-stack`" — advice that, before this milestone, hands the user a project with no broker selection at all, so the suggested escape does not restore what was refused.                                                                              | The advice becomes correct for the broker case only once `--broker` exists standalone, and `full-stack` composes through `createFullStackApp`, so a standalone `full-stack` still cannot take one (§3.5). The message is therefore narrowed rather than left implying an equivalence that does not hold. | Reword the refusal so it points at `--template microservice` for a broker and keeps the standalone suggestion for the non-broker transports (`http`, `memory`), matching what each actually delivers.               |

## 3. Design decisions

### 3.1 The broker flags are derived from the transport registry, never from a second table

- **Decision:** `--broker` and `--queue` resolve through `getTransport()` against the existing
  `TRANSPORT_SPECS`. The accepted `--broker` set is every arm declaring `messagingArgs`, plus
  `memory`; the accepted `--queue` set is every arm declaring `queueArgs`, plus `memory`. Two new
  readers, `listBrokers()` and `listQueues()`, derive those sets from the record so help text,
  refusal text and validation cannot drift from the arms that exist.
- **Why:** §11.1. The connection variable, the local default, the rendered option literal and the
  Compose backing already live on `TransportSpec`; a parallel broker table would be a second source
  of truth for all four, and the workspace and standalone paths would drift on the first arm added.
- **Test home:** `test/unit/broker-flags.test.ts` asserts each derived list equals the arms of
  `TRANSPORT_SPECS` carrying the matching renderer, so adding an arm without a list entry fails.

### 3.2 They are separate flags, not an extension of `--transport`

- **Decision:** the standalone spelling is `--broker` and `--queue`. `--transport` stays refused on
  a standalone project, with its refusal message extended to name the two flags that do apply.
- **Why:** `--transport` means "how the members of a workspace reach each other" and bundles four
  things a standalone project has no use for — the `http` arm resolving siblings through the
  discovery map, the `grpc` arm's proto toolchain, the Compose member wiring, and the `memberEnv`
  block. Its `http` and `grpc` arms are meaningless for one service. Messaging and the queue are
  also genuinely independent axes: `QueueAdapterType` supports four backends where the broker union
  supports seven, so one value cannot honestly set both.
- **Test home:** `test/unit/new-command.test.ts` pins that `--transport` on a standalone project
  still refuses and that the message now names `--broker` and `--queue`.

### 3.3 The overlay is extracted from `withTransport`, so one implementation serves both paths

- **Decision:** `wrapPluginArgs` moves to a new `src/templates/plugin-args.ts` beside a
  `rewritePluginArgs(host, pkg, render, connection)` helper, and a new `src/templates/broker.ts`
  exposes `withBrokerArgs(host, spec, profile)` and `withQueueArgs(host, spec, profile)`.
  `workspace/member-host.ts`'s `withTransport` is rewritten to compose those two, so its observable
  output is unchanged.
- **Why:** the standalone path needs exactly the rewrite `withTransport` already performs, minus the
  member name, the proto files and the discovery map. Copying it would duplicate the top-level comma
  splitter and the "both or neither" connection invariant. Extracting deletes a duplicate instead of
  creating one.
- **Test home:** `test/unit/plugin-args.test.ts` covers the splitter directly; the existing
  workspace member tests are the regression guard that `withTransport`'s output is byte-identical,
  and one added case asserts a `--transport rabbitmq` member's rendered wiring is unchanged by the
  refactor.

### 3.4 A broker flag is refused wherever it would be a silent no-op

- **Decision:** `--broker` and `--queue` are usage errors, each naming its own reason, in six cases:
  an unknown name; a name that exists but has no arm for that flag (`http`, `grpc`, and `nats`,
  `kafka`, `pubsub`, `service-bus` for `--queue`); a template that registers no `messaging-plugin` /
  `queue-plugin` wiring; `--runtime cloudflare-workers`; `--workspace`; and `generate app`. `memory`
  is accepted everywhere the flag is accepted and rewrites nothing, because it is the default the
  plugin already takes and refusing an explicit statement of the default would be hostile.
- **Why:** `withTransport` maps over the plugin list and leaves a non-matching wiring alone. That
  silence is correct for a workspace, where the transport is workspace-wide and some members
  legitimately register no messaging; it is wrong for a standalone project, where the user typed the
  flag for THIS project. The Workers case is the sharpest: `WORKERS_SWAP` removes both plugins
  before any overlay runs, so the flag would report success while the project talked to Cloudflare
  Queues.
- **Test home:** `test/unit/broker-flags.test.ts`, one case per refusal, each asserting the exit
  code is the usage code and that the message names the alternative.

### 3.5 A starter-composed template is refused a broker, not silently dropped

- **Decision:** `--template full-stack --broker <arm>` is refused, reusing the reason
  `commands/app.ts:204` already encodes: an `appFactory` host renders its whole plugin set through
  the factory call, so a plugin-list rewrite is dropped by the renderer.
- **Why:** identical mechanism, identical failure, and leaving it unguarded would reintroduce "looks
  connected while talking to nobody" on the standalone path a month after the workspace path closed
  it.
- **Test home:** `test/unit/broker-flags.test.ts` asserts the refusal and that its message names
  `--template microservice`.

### 3.6 The endpoint is configured through the generated dotenv pair, not through a flag

- **Decision:** no `--broker-url` and no `--queue-url`. The rendered wiring keeps the registry's
  `envRead(variable, localDefault)` form, and the selected arm's `TransportConnection` is appended
  to the template manifest's `envVariables`, so the scaffold writes the variable into the gitignored
  `.env` with the local default and into the tracked `.env.example` with an empty value.
- **Why:** a per-flag URL would be four flags for two axes, and it would bake an endpoint into a
  committed file — the exact failure the workspace arms already avoid, where a literal
  `redis://127.0.0.1:6379` is unreachable from inside a container. The dotenv pair is M67's
  machinery and needs no new contract: `EnvVariable` wants `name` and `develop`, and
  `TransportConnection` already carries `variable` and `localDefault`.
- **Test home:** `test/unit/broker-flags.test.ts` asserts a `--broker redis` project's `.env`
  carries `REDIS_URL` with the local default and its `.env.example` carries the name with an empty
  value.

### 3.7 The broker the flag names is also started: the project gets a Compose file for it

- **Decision:** a standalone project selecting a broker arm also gets `docker/compose.yaml`
  containing that arm's `ComposeBacking.services` verbatim, plus any `ComposeBacking.files`, and a
  README line naming the command. No application service, no Dockerfile, no Kubernetes objects.
- **Why:** the messaging plugin connects during `register()` and does not retry, so a fresh
  `setu new svc --template microservice --broker redis` cannot complete `app.start()` with nothing
  listening. The repository's own bar — a scaffold that runs, enforced by
  `test/e2e/scaffold-runs-e2e.test.ts` — is otherwise broken by the flag that this milestone adds.
  The data is shared with the workspace stack rather than re-authored; only the surrounding document
  differs, because a standalone project has no member services to interleave.
- **Boundary:** M39 owns the deployable image and the orchestration objects. This file starts a
  broker for local development and says so in its own header.
- **Test home:** `test/unit/broker-flags.test.ts` asserts the emitted YAML contains the arm's
  service block and that no broker arm is selected without one;
  `test/e2e/broker-scaffold-e2e.test.ts` boots the project against a real broker.

### 3.8 The prompter is an optional dependency, so every gate is non-interactive by construction

- **Decision:** `CliDependencies` gains `readonly ask?: Prompter`. When it is absent, no prompt is
  ever attempted and every absent flag takes its documented default. `src/main.ts` supplies it only
  when `Deno.stdin.isTerminal()` reports true.
- **Why:** this is the primary guarantee, and it does not depend on runtime detection being right.
  Every gate in the repository reaches the CLI through an in-process `runCli` call (`grep` finds
  `runCli(` in ten test files and in no script or workflow), and none of them will pass `ask`. TTY
  detection in `main.ts` is the SECOND line, covering a human's non-interactive shell; the measured
  `null` return from `prompt()` on a non-terminal is the third. The ROADMAP's "defaults to
  non-interactive when unsure" is satisfied by all three failing closed.
- **Test home:** `test/unit/new-command.test.ts` asserts that a `runCli` call with no `ask` and no
  flags produces the same file set as `--yes`, byte for byte.

### 3.9 Prompting rewrites flag values and then the existing pipeline runs unchanged

- **Decision:** a new `resolveNewChoices(args, prompter, log)` returns a NEW `ParsedArgs` whose
  flags carry the answers. `planWorkspace` and `planProject` are untouched and stay pure functions
  of their arguments. Schematics are not involved at all.
- **Why:** it keeps `--dry-run` exact — the plan is still computed from a flag record, so what is
  printed is what would be written — and it means every prompted value is expressible as a flag,
  which is the ROADMAP's constraint stated as a type. It also makes the whole question set
  unit-testable against a scripted fake with no filesystem.
- **Test home:** `test/unit/new-interactive.test.ts` drives the resolver directly and asserts the
  returned flag record.

### 3.10 The question set, its order, and the conditions each question is asked under

- **Decision:** questions are asked only for a flag that is ABSENT, only when `--yes` is absent, and
  only when `ask` is present. Standalone order: `--runtime`, then `--template`, then `--broker`,
  then `--queue`. Workspace order: `--runtime`, then `--transport`. The broker and queue questions
  are asked only when the answers already collected make the flag legal under §3.4 — a `class-based`
  template or a Workers runtime skips both, and a template with no queue wiring skips the queue
  question. Choices are rendered through the injected `log`; the question line itself is written by
  the prompter, because a prompt is not a line.
- **Why:** asking a question whose answer would then be refused is worse than not asking. Deriving
  the condition from the same predicate §3.4 refuses on means the two cannot disagree.
- **Test home:** `test/unit/new-interactive.test.ts` records every question the fake prompter is
  asked and asserts the exact sequence for six flag combinations, including the two that must ask
  nothing.

### 3.11 `--yes` is the single escape hatch, and the default answer is rendered in the question

- **Decision:** one boolean flag, `--yes` (short `-y`), meaning "take every default and ask
  nothing". It is not a `VALUE_FLAGS` entry. A default is shown inside the question text
  (`Template? [rest]`) and a bare Enter selects it; the second argument of Deno's `prompt()` is
  deliberately unused.
- **Why:** the ROADMAP offers `--yes` and `--no-input` as candidates; shipping both would leave one
  of them read by nothing, which §4 forbids. `--yes` is the spelling every comparable scaffolder
  uses. The `prompt()` second argument is rejected on measured evidence: it pre-fills an editable
  buffer, so a caller passing `rest` and a user typing `aaa` gets `restaaa` (§1.1).
- **Test home:** `test/unit/prompt.test.ts` covers the default, the empty answer, the invalid answer
  and the `null` answer; `test/unit/new-interactive.test.ts` covers `--yes` asking nothing.

### 3.12 The recurrence gate is an allowlist, because a bare grep cannot see emitted source

- **Decision:** `test/unit/process-boundary.test.ts` sweeps `packages/cli/src` for `prompt(`,
  `confirm(`, `Deno.stdin` and `Deno.exit`, and fails on any file outside an explicit two-entry
  allowlist — `src/main.ts` (the process boundary) and `src/workspace/dev-runner.ts` (whose matches
  are inside the runner source the CLI writes into a generated workspace). A second assertion pins
  the allowlist's membership, so adding a third entry is a visible edit rather than a one-word
  exemption.
- **Why:** C2. The ROADMAP's grep evidence is already stale for exactly this reason, and the
  allowlist-with-membership-assertion shape is the one M37c settled on for `ALLOW_SKIP` after a
  silent exemption was found to leave a gate green while covering less.
- **Test home:** the gate is its own test; its negative control is described in §6.1.

## 4. Exported surface — every symbol names its consumer

Two additions to `packages/cli/src/index.ts`. Both are types, because `CliDependencies.ask` cannot
be implemented by a programmatic consumer without naming them (§10.2 approval + `PUBLIC_API.md` in
this PR).

| Exported symbol   | Kind      | Consumer / real code path that READS it                                                                                                                                                   |
| ----------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Prompter`        | interface | Referenced by `CliDependencies.ask?`; implemented by `createTerminalPrompter` in `src/prompt.ts` and called by `resolveNewChoices` in `src/commands/new-interactive.ts`.                  |
| `PromptChoice`    | interface | The element type of `Prompter.select`'s second parameter; built by `resolveNewChoices` from `listTemplates()`, `TARGET_RUNTIMES`, `listBrokers()`, `listQueues()` and `listTransports()`. |
| `CliDependencies` | interface | ALREADY exported; gains the optional `ask` member. Read by `runCli`, which forwards it to `runNewCommand`.                                                                                |

`createTerminalPrompter` is deliberately NOT barrel-exported: its only consumer is `src/main.ts`,
which imports it directly, and a second export with no reader is the dead surface §4 exists to
prevent. `listBrokers`, `listQueues`, `withBrokerArgs`, `withQueueArgs`, `rewritePluginArgs`,
`wrapPluginArgs` and `resolveNewChoices` are all module-internal for the same reason.

### 4.1 Options — every option names its consumer

| Option            | Consumer                                                               | Behavior (per implementation)                                                                                                                                                                                                                             |
| ----------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--broker <name>` | `planProject` via a new `readBrokerFlags`, applied by `withBrokerArgs` | Rewrites the `messaging-plugin` wiring to the named arm's `messagingArgs`, appends the arm's connection variable to `envVariables`, and emits its Compose service. `memory` accepted and inert. Refused per §3.4 and §3.5.                                |
| `--queue <name>`  | the same reader, applied by `withQueueArgs`                            | Rewrites the `queue-plugin` wiring to the named arm's `queueArgs`, sharing the connection variable and the Compose service when it is the same arm as `--broker`. Accepts `memory`, `redis`, `rabbitmq`. Refuses the four broker names with no queue arm. |
| `--yes` / `-y`    | `runNewCommand`, before `resolveNewChoices`                            | Suppresses every prompt; each absent flag takes its documented default. A no-op when no prompter is present, never an error.                                                                                                                              |
| `ask?: Prompter`  | `runCli`, forwarded to `runNewCommand`                                 | Absent → no prompt is ever attempted. Present → `resolveNewChoices` asks §3.10's questions. `select` returning `undefined` is treated identically to absent for that one question.                                                                        |

## 5. Implementation files

| File                              | Purpose                                                                                                                                                              |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/prompt.ts`                   | NEW. `Prompter`, `PromptChoice`, and `createTerminalPrompter(isTerminal, promptFn, log)` — the injected-seam implementation over Deno's built-in `prompt`.           |
| `src/commands/new-interactive.ts` | NEW. `resolveNewChoices(args, prompter, log)`: §3.10's question set, returning an augmented `ParsedArgs`.                                                            |
| `src/templates/plugin-args.ts`    | NEW. `wrapPluginArgs` (moved from `workspace/member-host.ts`) and `rewritePluginArgs(host, pkg, render, connection)`.                                                |
| `src/templates/broker.ts`         | NEW. `withBrokerArgs`, `withQueueArgs`, `brokerEnvVariables(spec)`, `brokerComposeFiles(specs)` — the standalone overlay, sharing every renderer with the workspace. |
| `src/workspace/transport.ts`      | CHANGED. Adds `listBrokers()` and `listQueues()`, derived from `TRANSPORT_SPECS`.                                                                                    |
| `src/workspace/member-host.ts`    | CHANGED. `withTransport` composes `withBrokerArgs`/`withQueueArgs`; the local splitter and the rewrite loop are deleted.                                             |
| `src/commands/new.ts`             | CHANGED. Reads `--broker`/`--queue` with §3.4's refusals, extends the `--transport` refusal message, applies the overlay, and calls `resolveNewChoices`.             |
| `src/commands/app.ts`             | CHANGED. Refuses `--broker`/`--queue` beside the existing `--transport` refusal, and C4's reworded starter refusal.                                                  |
| `src/constants.ts`                | CHANGED. `VALUE_FLAGS` gains `broker` and `queue`.                                                                                                                   |
| `src/cli.ts`                      | CHANGED. `CliDependencies.ask?: Prompter`, forwarded to `runNewCommand`; top-level help gains `--yes`.                                                               |
| `src/main.ts`                     | CHANGED. Supplies `ask` from `createTerminalPrompter(() => Deno.stdin.isTerminal(), prompt, console.log)`.                                                           |
| `src/index.ts`                    | CHANGED. Re-exports `Prompter` and `PromptChoice`.                                                                                                                   |

Documentation, all in this PR: `PUBLIC_API.md` (three option rows, the two new types, the
interactive-behaviour note), `packages/cli/README.md` (Options table, C3's stale bullet, the
regenerated Exports table via `deno task docs:exports`), `docs/cli.md` (a broker section and the
interactive section, with `test/guide-fence-compiler.test.ts`'s `total`/`skipped` budget moved to
match), `ARCHITECTURE.md` (the `@setu-ts/cli` Rules cell), `ROADMAP.md` (C1, C2, the M72 row flipped
to complete), `CLAUDE.md` (the status entry), and `CHANGELOG.md`.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                       | src covered                                                                    | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/prompt.test.ts`                      | `src/prompt.ts`                                                                | Against `createTerminalPrompter(isTerminal: () => boolean, promptFn: (m: string) => string \| null, log: (m: string) => void)`: a non-terminal never calls `promptFn` and resolves `undefined`; a `null` answer resolves `undefined`; `''` resolves the fallback; an exact match resolves itself; an unrecognised answer re-asks and a following valid answer resolves; an unrecognised answer then `null` resolves `undefined` (the EOF bound on the retry loop); the choice list reaches `log` and the question reaches `promptFn`. |
| `test/unit/new-interactive.test.ts`             | `src/commands/new-interactive.ts`                                              | Against `resolveNewChoices(args: ParsedArgs, prompter: Prompter, log): Promise<ParsedArgs>`: the exact question sequence for standalone-no-flags, workspace-no-flags, every-flag-supplied (asks nothing), `--template class-based` (no broker question), `--runtime cloudflare-workers --template microservice` (no broker question), and a `select` returning `undefined` mid-sequence (later questions still asked, flag left absent).                                                                                              |
| `test/unit/plugin-args.test.ts`                 | `src/templates/plugin-args.ts`                                                 | The splitter leaves a short literal untouched, wraps a long one on top-level commas only, leaves a nested object on its line, ignores a comma inside a quoted string, and returns a non-object literal unchanged. `rewritePluginArgs` rewrites only the named package and returns the input array identity-equal when no wiring matches.                                                                                                                                                                                              |
| `test/unit/broker-flags.test.ts`                | `src/templates/broker.ts`, `src/workspace/transport.ts`, `src/commands/new.ts` | `listBrokers()`/`listQueues()` equal the arms carrying the matching renderer; a `--broker redis` project's `setu.config.ts` carries `broker: 'redis-streams'` with the environment read; `--queue redis` carries `adapter: 'redis'`; `.env` and `.env.example` carry the variable; `docker/compose.yaml` carries the arm's service block; and one case per §3.4 and §3.5 refusal asserting the usage exit code and the named alternative.                                                                                             |
| `test/unit/process-boundary.test.ts`            | the gate itself (§3.12)                                                        | No file under `packages/cli/src` outside the two-entry allowlist matches `prompt(`, `confirm(`, `Deno.stdin` or `Deno.exit`; and the allowlist contains exactly those two entries.                                                                                                                                                                                                                                                                                                                                                    |
| `test/unit/new-command.test.ts` (extended)      | `src/commands/new.ts`, `src/cli.ts`                                            | `runCli` with no `ask` produces a byte-identical file set to `--yes`; `--transport` on a standalone project still refuses and now names both new flags; `--yes` with a prompter present records zero prompter calls.                                                                                                                                                                                                                                                                                                                  |
| `test/unit/app-command.test.ts` (extended)      | `src/commands/app.ts`                                                          | `generate app x --broker redis` and `--queue redis` are usage errors naming the workspace's `--transport`; C4's reworded starter refusal names `--template microservice`.                                                                                                                                                                                                                                                                                                                                                             |
| `test/unit/workspace/*` (existing, extended)    | `src/workspace/member-host.ts`                                                 | A `--transport rabbitmq` member's rendered `MessagingPlugin` and `QueuePlugin` wirings are byte-identical to the pre-refactor strings — the regression guard for §3.3.                                                                                                                                                                                                                                                                                                                                                                |
| `test/unit/barrel-exports.test.ts` (extended)   | `src/index.ts`                                                                 | `Prompter` and `PromptChoice` are nameable from the barrel, asserted at compile time (the M56 lesson: a runtime assertion over a type export passes when the export is gone).                                                                                                                                                                                                                                                                                                                                                         |
| `test/unit/help.test.ts` (extended)             | `src/cli.ts`, `src/commands/new.ts`                                            | `setu new --help` lists `--broker`, `--queue` and `--yes`, with the broker and queue lists rendered from `listBrokers()`/`listQueues()` rather than hand-written.                                                                                                                                                                                                                                                                                                                                                                     |
| `test/e2e/broker-scaffold-e2e.test.ts`          | the whole path, end to end                                                     | Scaffolds `--template microservice --broker redis --queue redis`, repoints its imports at this workspace, `deno fmt --check`s it, `deno lint`s it, `deno check`s it, and — guarded on `REDIS_URL`, which CI's job env sets — BOOTS it and requests `/health` for a `200`. A second case scaffolds `--broker rabbitmq` and type-checks it without booting.                                                                                                                                                                             |
| `test/e2e/scaffold-runs-e2e.test.ts` (extended) | the boot bar                                                                   | The default `microservice` scaffold still boots unchanged, proving the flag's absence changes nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                |

`src/main.ts` is not measured: no test imports it, so Deno never loads it and it never appears in
the coverage table. That is precisely why `createTerminalPrompter` takes its three effects as
parameters — the decidable logic lives in `src/prompt.ts`, which is measured.

### 6.1 Negative controls — each observed failing, then reverted

1. Drop `broker` from `VALUE_FLAGS`: `setu new svc --broker redis` must parse `redis` as a
   positional and the broker assertions must fail. Proves the constants entry is load-bearing.
2. Make `withBrokerArgs` a no-op for a template with no messaging wiring instead of refusing:
   `--template rest --broker redis` must scaffold successfully with an in-memory broker, which is
   the silent success §3.4 exists to remove.
3. Remove the `cloudflare-workers` refusal: `--runtime cloudflare-workers --broker redis` must
   scaffold a project whose config registers `CloudflarePlugin` and no Redis, again reporting
   success.
4. Supply `ask` unconditionally from `src/main.ts` instead of behind `isTerminal()`: the
   `process-boundary` allowlist still passes, so this control must be observed at the prompt level —
   with a scripted `promptFn` that would block, the terminal prompter must be shown to call it, and
   with the guard restored it must not.
5. Delete the Compose emission: the `--broker redis` e2e must fail to boot when the CI Redis is
   absent, and the assertion that a broker arm always emits a service block must fail.
6. Use `prompt(question, fallback)` instead of rendering the default in the question text: the
   pty-driven case in `test/unit/prompt.test.ts` must return the concatenation measured in §1.1.
7. Add a third entry to the `process-boundary` allowlist: the membership assertion must fail.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m72-cli-transport-interactive, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; >=90% branch/function/line every src file
deno task check:docs        # docs/cli.md fence budget, README exports table, generated API docs
deno task docs:exports      # regenerates the README Exports table; must leave the tree clean
```

A package changes, so both publish gates run on the COMMITTED tree:

```bash
deno task publish:check
deno task release:verify 0.1.0-alpha.8
```

Plus the end-of-task self-audit from CLAUDE.md, including the forbidden-construct grep over
`packages/cli/src` and a demonstration that a `--broker redis` scaffold's rendered `setu.config.ts`
differs from the default one.

## 8. Risks & mitigations

- **The refactor in §3.3 changes a shipped workspace's generated output.** Mitigated by an added
  byte-identity assertion on a `--transport rabbitmq` member's two rewritten wirings, checked
  against the strings the current implementation produces, captured before the refactor.
- **A `--broker redis` scaffold cannot boot where no broker runs**, so the e2e's boot half is
  guarded on `REDIS_URL`. Mitigated by keeping the type-check half unguarded, so the common failure
  (a malformed rendered literal, invisible to the CLI's own `deno check` — the M50b trap) is caught
  on every run, and by CI setting `REDIS_URL` at job level so the boot half is not a permanent skip.
- **The Compose file is new surface in a package M39 also writes deployment artifacts from.**
  Mitigated by scope: one file, broker services only, its own header naming the boundary, and no
  Dockerfile or Kubernetes object.
- **A pty-driven test is platform-sensitive.** Mitigated by injecting `promptFn` rather than
  reaching for a real terminal: the pty was used to establish §1.1's facts, and the suite drives the
  seam.
- **`--yes` could read as "answer yes to a confirmation" rather than "take the defaults".**
  Mitigated by the help text and by the fact that no confirmation prompt exists, so the two readings
  cannot diverge in behaviour.

## 9. Out of scope

- **`--queue sqs`.** `QueueAdapterType` names it and `SqsQueue` ships (M54), but no transport arm
  declares it, and adding one means an arm with a queue renderer and no messaging renderer plus a
  region and credentials no scaffold can invent. `TransportSpec`'s shape already supports that
  combination, so it is a small addition for whichever milestone wants it. Named here rather than
  left as an unexplained absence from the `--queue` list.
- **A URL-override flag for the standalone arms** (§3.6) — the dotenv pair replaces it.
- **Prompting inside `setu generate`, including `generate app`** — excluded by the ROADMAP; a
  generate runs inside scripts and editor hooks.
- **Prompting for the project name.** It is a positional, not a flag, and §3.9's constraint is that
  every prompted value is expressible as a flag.
- **A general `--starter` flag** (`packages/cli/README.md` Not yet supported) — unchanged here.
- **Realtime authentication over cookies (M73), read-only realtime registry lookups and the
  `SseMessage.data` narrowing (M74), and W3C trace propagation across the brokers (M75).**
