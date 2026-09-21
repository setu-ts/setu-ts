# Milestone 98c — Devtool Scaffolding (`@setu-ts/cli`)

> **Status:** Planning. Branch: `feat/m98c-devtool-scaffolding`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

M98b ships the connector and documents how to wire it by hand. This letter makes the CLI emit that
wiring, for a standalone project and for a member of a monorepo workspace, so a developer opts in
with a flag instead of hand-editing their composition, their entry points, their task permissions
and their workspace manifest. The boundary is the framework side of the handoff: the CLI emits the
development entry point, the port, and the credential contract the separately maintained devtool
launcher reads. It does not implement the launcher.

- **In scope:** a devtool opt-in on `setu new` and `setu generate app`, one `setu devtool` command
  that enables it on a project that already exists, a second allocated port per workspace member,
  the credential contract the launcher must satisfy, the development entry point and the `dev` task
  that runs it, and a scaffold-boot-and-read end-to-end gate driven by `createDiagnosticsClient`.
- **NOT this milestone:** the connector, its protocol and its client, all shipped by M98b. The
  launcher, the extension UI, packaging and subscriptions remain the separately maintained devtool
  product, per the M98 "Explicit Follow-ons" section. Narrowing any generated task's `--allow-net`
  is deferred, on both `start` and the new `dev`; see §2 C3 and §3.7 for the measurement that
  settles it.

## 1. Contracts verified from SOURCE (not names)

Every row was read at the cited line. The M98b rows were read on
`feat/m98b-local-diagnostics-connector` while PR #347 was open; that branch has since merged, so
they are shipped contracts on `main` and were re-checked there.

| Reference                           | Source (file:line)                                                            | Verified surface / fact                                                                                                                                                                                                                                               |
| ----------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery calls the factory         | `packages/cli/src/app-loader.ts:180`                                          | `setu commands` invokes the config factory with `discoveryEnv()` as the FIRST positional argument **on every target**, and the in-source comment says so explicitly. A single-parameter `createApp(extra?)` therefore receives that proxy as `extra`.                 |
| The discovery proxy                 | `packages/cli/src/app-loader.ts:67`                                           | `discoveryEnv()` answers every string key with `inertBinding()` and every symbol key with `undefined`, so `extra.plugins` is a truthy non-iterable and spreading it throws `Result of the Symbol.iterator method is not an object`. Reproduced, not reasoned.         |
| `WorkspaceMember`                   | `packages/cli/src/workspace/manifest.ts:113`                                  | `{ name, port, dependsOn?, healthProbes?, metricsEndpoint? }`. ONE port per member. The two optional booleans are the precedent for an optional field recorded at `generate app` time, each documenting that absent means unknown rather than false.                  |
| Port allocation                     | `packages/cli/src/workspace/manifest.ts:417`                                  | `allocatePort` is `max(basePort - 1, ...members.map(m => m.port)) + 1`. It walks `member.port` and nothing else, so any second port stored beside it is invisible to the allocator.                                                                                   |
| Port validation on read             | `packages/cli/src/workspace/manifest.ts:358`                                  | A member port is range-checked on the way IN, because it reaches the member's own binding and every sibling's discovery map.                                                                                                                                          |
| `setu workspace ports --reallocate` | `packages/cli/src/commands/workspace.ts:33`, `:9`, `:10`, `:11`               | Reallocates every member port and regenerates the discovery module, the Compose files and the Kubernetes files together.                                                                                                                                              |
| Generated task permissions          | `packages/cli/src/templates/project-files.ts:958`                             | `denoPermissions` emits a bare `--allow-net`, never a scoped one, plus `--allow-env` and a conditional `--allow-read`.                                                                                                                                                |
| Generated tasks                     | `packages/cli/src/templates/project-files.ts:849`                             | `denoTasks` emits `start`, `test` and `host.extraTasks`; the Deno entry is `main.ts`.                                                                                                                                                                                 |
| The `extraTasks` seam               | `packages/cli/src/templates/registry.ts:363`                                  | `TemplateHost.extraTasks?: Readonly<Record<string, string>>` is the committed way a host contributes a task.                                                                                                                                                          |
| Config factory rendering            | `packages/cli/src/templates/project-files.ts:425`                             | `createApp(${factoryParam})`, where `factoryParam` is empty for every target except Cloudflare Workers, which receives `env` and conditionally `waitUntil`.                                                                                                           |
| `generate app` flags                | `packages/cli/src/commands/app.ts:102`, `:103`, `:407`                        | Accepts `--env-file <path>` and a repeatable `--depends-on <name>`, each refused by name when inapplicable.                                                                                                                                                           |
| Workspace runtimes                  | `packages/cli/src/workspace/runtime-profile.ts:197`                           | `WORKSPACE_RUNTIMES` is `['deno', 'node', 'bun']`, so a workspace member is not necessarily a Deno project.                                                                                                                                                           |
| Dev runner                          | `packages/cli/src/workspace/dev-runner.ts:6`, `:91`; `runtime-profile.ts:142` | `scripts/dev.ts` spawns each member with `Deno.Command('deno', …)` passing `args`, `cwd` and the three stdio fields and **no `env` map**, so every member inherits the runner's whole environment. The root `dev` task grants `--allow-read --allow-run --allow-net`. |
| Root `dev` task grant               | `packages/cli/src/workspace/runtime-profile.ts:142`                           | `deno run --allow-read --allow-run --allow-net scripts/dev.ts` — no `--allow-env`, so the runner cannot read an environment variable today. Measured: `Deno.env.get` answers `NotCapable` under exactly that grant.                                                   |
| Member names are kebab-case         | `packages/cli/src/commands/app.ts:398`; `utils/names.ts:29`                   | A member is recorded as `names.kebab`, so a member name is `[a-z0-9]` and hyphens. Relevant to §3.4, where the rejected per-member variable family would have required the launcher to reproduce the kebab→`screaming` mapping.                                       |
| Explicit `--port` collision refusal | `packages/cli/src/commands/app.ts:433`                                        | An explicit `--port` equal to an existing `member.port` is refused, under a comment stating that refusing there is the only place that can see a flag-versus-file collision. The comparison reads `member.port` alone.                                                |
| Connector options (M98b)            | `packages/diagnostics-plugin/src/interfaces/index.ts`                         | `DiagnosticsPluginOptions` is `{ enabled: true, port, sessionId, sessionKey, ttlMs? }`; `enabled` is the literal `true`, so a computed flag is a compile error and the opt-in is by construction.                                                                     |
| Connector runtime gate (M98b)       | `packages/runtime/src/diagnostics/local-diagnostics-listener.ts`              | The listener factory rejects every `listen` on a non-Deno platform before any bind, so a devtool-enabled non-Deno project would fail at startup rather than degrade.                                                                                                  |
| Session scope (M98b)                | `plans/archive/milestone-98b-local-diagnostics-connector.md` §3.2             | A session ID and key are per launch, and sharing one pair across applications is unsupported. N members therefore need N pairs.                                                                                                                                       |
| Reviewed client (M98b)              | `packages/diagnostics-plugin/src/client/client.ts`                            | `createDiagnosticsClient` is the one reviewed implementation of the protocol's client side, so an end-to-end gate can drive a scaffolded project with the real client rather than a stand-in.                                                                         |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                | Resolution (picked side)                                                                                                                                                                                                                                                                                                              | Doc deliverable (same PR)                                                                                                        |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| C1 | The M98b README documents `createApp(extra?)` as a single parameter, which collides with discovery (§1 row 1). PR #347 corrects the README to a second parameter; nothing yet emits it. | The CLI emits the second-parameter form, and a test drives a scaffolded project through the real discovery path so the collision cannot come back.                                                                                                                                                                                    | Update the M98b README example to match what the CLI emits, once they are the same shape.                                        |
| C2 | `planWorkspace`'s doc comment says "a Setu workspace is a Deno workspace", while `WORKSPACE_RUNTIMES` admits `node` and `bun`.                                                          | The code is right and the comment is stale: workspaces support three runtimes. The devtool opt-in is what is Deno-only, and it is refused by name on the other two.                                                                                                                                                                   | Correct the `planWorkspace` comment in `packages/cli/src/commands/new.ts`.                                                       |
| C3 | The M98b README shows a scoped `--allow-net` as "a second, independent guarantee", while `denoPermissions` emits a bare `--allow-net` for every generated project.                      | The CLI emits neither scoped grant. On Deno 2.9.6 an allowlist governs OUTBOUND as well as bind (§3.7, measured), so the README's example refuses every database, broker and outbound API call an application makes — it is optional hardening for a project with no egress, not a default. The loopback guarantee is the listener's. | Mark the README grant as optional hardening, say that it also blocks outbound, and stop implying a generated project carries it. |
| C4 | `WorkspaceMember` documents one port per member; a devtool member needs two.                                                                                                            | Add `devtoolPort?: number`, following the `healthProbes` and `metricsEndpoint` precedent for an optional field recorded at generate time, and widen `allocatePort` to walk both so the allocator's invariant holds.                                                                                                                   | Document the second port in the workspace section of the CLI README.                                                             |

## 3. Design decisions

### 3.1 The factory seam is a second parameter, never the first

- **Decision:** the generated `createApp` takes the devtool composition as its SECOND parameter.
  Discovery passes its inert env proxy positionally as the first argument on every target
  (`app-loader.ts:180`), so a first-parameter `extra` is captured by `setu commands` and throws on
  the spread. The Workers target already renders `env` first, so this is the one shape that is
  correct on all four targets at once.
- The parameter is emitted for every template and target, not gated on the devtool flag: a project
  that adds the devtool later must not need its config module rewritten, and an unused optional
  parameter costs a generated project nothing.
- **Test home:** `packages/cli/test/unit/config-module.test.ts`, plus the discovery test in §6 that
  drives the real loader.

### 3.2 One planner, three entry points

- **Decision:** `setu devtool enable [member]` is the implementation. `setu new --devtool` and
  `setu generate app <name> --devtool` call the same planner, so the emitted files cannot drift
  between the flag and the command. This is the repo's one-capability-one-implementation rule
  applied to a scaffolding verb; `generate app` and `new` only CREATE, so a project that already
  exists needs the standalone command regardless.
- The planner refuses by name, never silently: a non-Deno runtime (the listener refuses every
  non-Deno `listen` before binding), a member that already has a devtool port, and a workspace whose
  manifest cannot be read.
- **Test home:** `packages/cli/test/unit/devtool-planner.test.ts`,
  `test/unit/devtool-refusals.test.ts`.

### 3.3 A second allocated port, from the same sequence

- **Decision:** `WorkspaceMember` gains `devtoolPort?: number`, and `allocatePort` walks
  `devtoolPort` alongside `port`. A fixed offset such as `port + 1000` was rejected: nothing
  constrains `basePort` spacing, so an offset collides with a sibling's application port as soon as
  a workspace has enough members. Leaving the field outside the allocator was rejected for the same
  reason — the allocator's whole contract is that it never hands out a port already in use, and
  `manifest.ts:417` reads `member.port` alone today.
- **An explicit port is refused on collision, and the collision space is now 2N values.**
  `app.ts:433` already refuses an explicit `--port` equal to an existing `member.port`, under a
  comment saying that refusing there "is the only place that can see it, since the collision is
  between a flag and a file". Both halves of that check are widened: `--devtool-port` is refused by
  name when it equals any member's `port` or `devtoolPort`, and the existing `--port` check gains
  the `devtoolPort` comparison — without it, `--port 5001` is accepted against a sibling whose
  devtool already holds 5001, and widening the allocator cannot see a flag. An accepted collision is
  silent in the worst way: one of the two listeners fails to bind while both addresses stay
  published, so the launcher connects to whichever process won.
- Read-time validation range-checks `devtoolPort` exactly as `manifest.ts:358` range-checks `port`,
  because the value reaches a generated task line and the launcher's connect address. A read-time
  DUPLICATE check is deliberately not folded in: nothing refuses two members sharing a `port` today,
  uniqueness is enforced at the two write sites (allocation and the explicit-flag refusal), and
  adding one would refuse manifests the CLI accepts today for `port` — a behaviour change to every
  workspace rather than a devtool concern. Named here so a reviewer meets it as a decision.
- `setu workspace ports --reallocate` moves both ports together and regenerates the discovery
  module, Compose and Kubernetes exactly as it does now, so the devtool port cannot survive a
  reallocation pointing at a stale address.
- **Test home:** `packages/cli/test/unit/allocate-port.test.ts`, `test/unit/reallocate.test.ts`, and
  both collision refusals in `test/unit/devtool-refusals.test.ts`.

### 3.4 Credentials come from the launcher, by a contract this letter fixes

- **Decision:** the generated development entry reads `SETU_DEVTOOL_SESSION_ID` and
  `SETU_DEVTOOL_SESSION_KEY` from the process environment, validates them against the shapes
  `DiagnosticsPluginOptions` requires (32 lowercase hex characters, and 32 bytes as 64 hex
  characters), and refuses to start with a named message when a variable is absent or malformed. It
  never generates a pair of its own, never writes one to a file, and never prints one.
- **This names a contract the separately maintained launcher must satisfy, and the names are
  published CLI surface once emitted.** They need §10.2 approval before implementation, because a
  later rename is a breaking change to every scaffolded project.
- **In a workspace the launcher names the member it is inspecting**, setting `SETU_DEVTOOL_MEMBER`
  beside the same two variables; `scripts/dev.ts` gives the pair to THAT member's child and blanks
  it for every other. Inheritance is what makes the naive version wrong: `Deno.Command` MERGES `env`
  into the inherited environment and only `clearEnv: true` stops inheritance (measured on Deno 2.9.6
  — `{ env: { … } }` leaves a parent marker visible in the child, `{ env, clearEnv: true }` does
  not), while `dev-runner.ts:91` passes no `env` at all, so as things stand every member would
  inherit the runner's whole environment and hold a working credential for the inspected member's
  connector. M98b's README forbids exactly that, in as many words: "application subprocesses must
  not inherit these values". The runner therefore passes an explicit `env` for every child — the
  three variables at their real values for the selected member, and at the empty string for every
  other. An empty value is not a credential, and `main.ts`, which every non-selected member runs
  (§3.6), reads none of the three.
- **The root `dev` task's grant gains a SCOPED `--allow-env`**, so `runtime-profile.ts:142`'s
  `--allow-read --allow-run --allow-net` becomes that plus
  `--allow-env=SETU_DEVTOOL_SESSION_ID,SETU_DEVTOOL_SESSION_KEY,SETU_DEVTOOL_MEMBER`. Measured:
  under today's grant `Deno.env.get` answers `NotCapable` for every name, so the runner cannot read
  the pair at all; under the scoped grant it reads exactly those three and still answers
  `NotCapable` for `HOME`. Passing `env` or `clearEnv` to `Deno.Command` needs no environment
  permission of its own, only `--allow-run`, so blanking costs nothing beyond the read.
  `clearEnv: true` over `Deno.env.toObject()` was rejected for that reason: it would put UNSCOPED
  `--allow-env` on every generated workspace's `dev` task in order to remove three names.
- **One devtool member per `dev` run, which is M98b's model rather than a shortcut.** A session is
  per launch and per application, so inspecting two members at once is two launches. Per-member
  variable names (`SETU_DEVTOOL_SESSION_ID_<SCREAMING>`) were rejected: they are a second published
  name family the separately maintained launcher must produce by reimplementing `deriveNames`'
  kebab→`screaming` rule (`utils/names.ts:29`), and reimplementing it wrongly fails silently — the
  runner would simply find no pair for that member. `SETU_DEVTOOL_MEMBER` is the one additional
  name, flagged for §10.2 approval with the pair above.
- **Test home:** `packages/cli/test/unit/dev-entry.test.ts`, `test/e2e/devtool-e2e.test.ts`,
  `test/e2e/dev-runner-e2e.test.ts`.

### 3.5 The launcher discovers endpoints from the manifest it already reads

- **Decision:** no new file. A standalone project's devtool port lives in its `deno.json` `dev` task
  and is passed explicitly in the generated entry; a workspace's lives in `setu.workspace.json` as
  `devtoolPort`, beside the `port` a launcher must already understand to address a member at all.
  Adding a second CLI-owned index of the same values would be a second source of truth, and
  `ports --reallocate` would have to keep both correct.
- **Test home:** `packages/cli/test/unit/workspace-manifest.test.ts`.

### 3.6 The dev runner spawns the development entry for devtool members

- **Decision:** `scripts/dev.ts` spawns `main.dev.ts` for the member named by `SETU_DEVTOOL_MEMBER`
  and `main.ts` for every other member, reading `setu.workspace.json` as it already does
  (`dev-runner.ts:43`, `:120`). The root `dev` task's `--allow-net` stays unscoped and unchanged
  (`runtime-profile.ts:142`); its one addition is the scoped `--allow-env` §3.4 needs in order to
  read the three variables it forwards.
- **The selector chooses the entry, never the manifest field.** A member carrying `devtoolPort`
  still runs `main.ts` unless it is the selected one, so `deno task dev` with no devtool variables
  set is byte-identical to today. Keying the entry off `devtoolPort` was rejected because
  `main.dev.ts` refuses to start without credentials (§3.4): every plain `deno task dev` would then
  fail for anyone who had once run `setu devtool enable`, which turns an opt-in into a workspace
  that only the launcher can run.
- The runner refuses by name when `SETU_DEVTOOL_MEMBER` names a member the manifest does not carry,
  or one with no `devtoolPort`. Falling back to `main.ts` would leave the launcher polling a port
  nothing ever binds, which reads as a hung application rather than a misspelt member name.
- `dev-runner.ts` emits TWO runners — `scripts/dev.ts` for a Deno workspace and `scripts/dev.mjs`
  for a Node or Bun one (`dev-runner.ts:33`) — and each parses the manifest into its own inline
  member type. Only the Deno runner can host a devtool member, because the connector refuses every
  non-Deno `listen`; the `.mjs` runner is left unchanged, and the §3.2 refusal is what guarantees it
  never meets one. Both are named so the implementation cannot wire one and miss the other.
- **Test home:** `packages/cli/test/e2e/dev-runner-e2e.test.ts`, extending the M67 fixture.

### 3.7 The `dev` task's permissions are the `start` task's

- **Decision:** the emitted `dev` task takes its flags from the same `denoPermissions(manifest)`
  call the `start` task takes them from (`project-files.ts:958`), so the two cannot drift. The only
  difference between the tasks is the entry module. Neither task carries a scoped `--allow-net`.
- **A scoped grant would refuse the application's own egress, and that is measured rather than
  reasoned.** On Deno 2.9.6 an allowlist governs OUTBOUND as well as bind: under
  `--allow-net=127.0.0.1:45999` both `Deno.connect` and `fetch` to any other address fail with
  `NotCapable: Requires net access to "…"`. `main.dev.ts` is the production composition plus
  `DiagnosticsPlugin`, so `--allow-net=0.0.0.0:<port>,127.0.0.1:<devtoolPort>` would refuse every
  database driver, broker client and outbound API call the project makes — and the CLI cannot
  enumerate those hosts at scaffold time, because they arrive from `.env` at run time and change
  whenever the developer edits it. This is C3's own argument about `start`, which applies unchanged
  to `dev`; an earlier revision of this plan scoped `dev` while quoting that argument against
  scoping `start`.
- **The loopback restriction is the listener's, not a permission flag's.**
  `local-diagnostics-listener.ts:214` fixes the hostname to `127.0.0.1` before any bind and rejects
  every `listen` on a non-Deno platform outright, and `DiagnosticsPluginOptions.enabled` is the
  literal `true`, so the connector can be neither enabled by a computed flag nor moved off loopback
  by configuration. Nothing about the guarantee depended on the grant.
- **Test home:** `packages/cli/test/unit/deno-tasks.test.ts` — the `dev` and `start` flag strings
  are asserted identical, and `start` is asserted byte-identical to today.

## 4. Exported surface — every symbol names its consumer

`packages/cli/src/index.ts` is UNCHANGED: this letter adds a command and generated output, not
library surface. A `barrel-exports` assertion pins that, because a re-export file is fully covered
by being loaded and a silent addition here would ship unannounced.

| Exported symbol               | Kind                    | Consumer / real code path that READS it                                                               |
| ----------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------- |
| `WorkspaceMember.devtoolPort` | optional manifest field | `allocatePort`, the dev runner, `ports --reallocate`, and the launcher reading `setu.workspace.json`. |

Every other symbol this letter adds is internal to `packages/cli/src` and is read by the planner,
the renderers and their tests. Crypto, protocol and session internals stay M98b's.

### 4.1 Options — every option names its consumer

| Option                               | Consumer                  | Behavior (per implementation)                                                                                                                                                                 |
| ------------------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setu new --devtool`                 | the shared planner (§3.2) | Emits the development entry, the `dev` task and the dependency. Refused on a non-Deno runtime by name.                                                                                        |
| `setu generate app <name> --devtool` | the shared planner        | As above, plus allocating and recording `devtoolPort` for the new member.                                                                                                                     |
| `setu devtool enable [member]`       | the shared planner        | Enables the devtool on a project that already exists. In a workspace the member name is required; standalone it is refused as an extra positional.                                            |
| `--devtool-port <port>`              | the planner, the manifest | Overrides allocation with an explicit port. Range-checked as a member port is, and refused by name when it equals any member's `port` or `devtoolPort` (§3.3). Absent, the port is allocated. |

## 5. Implementation files

| File                                                                                            | Purpose                                                                                                  |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/commands/devtool.ts`                                                          | The `setu devtool enable` command and its refusals.                                                      |
| `packages/cli/src/devtool/planner.ts`                                                           | The one planner all three entry points call.                                                             |
| `packages/cli/src/devtool/dev-entry.ts`                                                         | Renders `main.dev.ts`, including the credential read and its refusal.                                    |
| `packages/cli/src/commands/new.ts`, `commands/app.ts`                                           | The `--devtool` flag, its refusals, the widened `--port` collision check, and the call into the planner. |
| `packages/cli/src/templates/project-files.ts`                                                   | The second factory parameter and the `dev` task.                                                         |
| `packages/cli/src/workspace/manifest.ts`                                                        | `devtoolPort`, its validation, and the widened `allocatePort`.                                           |
| `packages/cli/src/workspace/dev-runner.ts`                                                      | Spawning `main.dev.ts` for the selected member, and the per-child environment.                           |
| `packages/cli/src/workspace/runtime-profile.ts`                                                 | The scoped `--allow-env` the root `dev` task needs (§3.4).                                               |
| `packages/cli/src/commands/workspace.ts`                                                        | Moving both ports in `ports --reallocate`.                                                               |
| `packages/cli/README.md`, `PUBLIC_API.md`, `CHANGELOG.md`, `ROADMAP.md`, `CLAUDE.md`, this plan | Documentation, release notes, tracking and plan archival in the implementation PR.                       |
| `packages/diagnostics-plugin/README.md`                                                         | The C1 and C3 corrections.                                                                               |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                         | src covered                                                 | Key assertions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit/devtool-planner.test.ts`    | `devtool/planner.ts`                                        | One planner, three entry points: the files emitted by `new --devtool`, `generate app --devtool` and `devtool enable` are byte-identical for the same inputs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `unit/devtool-refusals.test.ts`   | `commands/devtool.ts`, `commands/new.ts`, `commands/app.ts` | Non-Deno runtime, already-enabled member, unreadable manifest, an extra positional standalone, an out-of-range `--devtool-port`, a `--devtool-port` colliding with a sibling's `port`, and a `--devtool-port` colliding with a sibling's `devtoolPort` each refuse by name and write nothing. A `--port` colliding with a sibling's `devtoolPort` is refused too, which fails without the widened check.                                                                                                                                                                                                                                                                                                |
| `unit/dev-entry.test.ts`          | `devtool/dev-entry.ts`                                      | Absent and malformed credentials refuse with a named message; no generated line prints a credential.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `unit/allocate-port.test.ts`      | `workspace/manifest.ts`                                     | `allocatePort` walks `devtoolPort`, so a new member never receives a port an existing member's devtool already holds. Fails without the widening.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `unit/deno-tasks.test.ts`         | `templates/project-files.ts`                                | The `dev` and `start` flag strings are identical and carry no scoped `--allow-net`; `start` is byte-identical to today; the tasks differ only in the entry module.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `unit/config-module.test.ts`      | `templates/project-files.ts`                                | The factory's devtool parameter is SECOND on every target, and the Workers signature keeps `env` first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `unit/workspace-manifest.test.ts` | `workspace/manifest.ts`                                     | `devtoolPort` round-trips, is range-checked on read, and absent stays absent. A manifest whose members share a port is accepted exactly as it is today, pinning §3.3's decision not to add a read-time duplicate check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `unit/dev-runner-grant.test.ts`   | `workspace/runtime-profile.ts`                              | The root `dev` task carries `--allow-env` scoped to exactly the three devtool names, and its `--allow-net` is byte-identical to today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `unit/reallocate.test.ts`         | `commands/workspace.ts`                                     | `ports --reallocate` moves a member's application port and its devtool port together and regenerates the discovery module, Compose and Kubernetes; a member with no devtool port is untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `integration/discovery.test.ts`   | `app-loader.ts`, `templates/project-files.ts`               | A scaffolded project's factory survives the REAL discovery path. The single-parameter shape reproduces the `Symbol.iterator` throw; the emitted shape does not. This is the guard C1 exists for.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `e2e/devtool-e2e.test.ts`         | all of the above                                            | Scaffold with `--devtool`, type-check against this workspace, boot with credentials in the environment, and read a snapshot and an event batch with `createDiagnosticsClient`. Then boot WITHOUT the credentials and assert the named refusal.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `e2e/dev-runner-e2e.test.ts`      | `workspace/dev-runner.ts`                                   | A two-member workspace, BOTH carrying a `devtoolPort`, with `SETU_DEVTOOL_MEMBER` naming one: that member runs `main.dev.ts` and answers its connector with the supplied pair, the other runs `main.ts`, both application ports answer, and the non-selected child's own environment carries no usable value for any of the three devtool variables — the assertion that fails today, since `dev-runner.ts:91` passes no `env` and the child inherits the runner's. A third case runs with no devtool variables set and asserts both members run `main.ts`, so a devtool-enabled workspace is still runnable without the launcher. A fourth names a member that does not exist and asserts the refusal. |

The e2e repoints the scaffolded project at this workspace rather than JSR, for the M34b reason: a
project is pinned to the CLI's own version, which on a release branch is not published yet.

## 7. Verification gates

```bash
git branch --show-current   # feat/m98c-devtool-scaffolding during implementation
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage
deno task check:docs
```

Read the ANSI-stripped per-file table and enforce 90% branch, function and line for every changed
source file. Commit, then run `deno task publish:check` and `deno task release:verify` with the
committed workspace version. Boot a scaffolded devtool project and read it with the real client; a
probe that only inspects emitted text verifies the renderer, not the feature.

## 8. Risks & mitigations

- The credential variable names become published CLI surface before the launcher exists: fixed in
  §3.4, flagged for §10.2 approval, and a rename after release is breaking for generated output.
- A second port silently collides with a sibling's application port: the allocator is widened in
  §3.3 and a unit test fails without the widening.
- The factory parameter breaks `setu commands`: reproduced at plan time, resolved in §3.1, and
  guarded by an integration test that drives the real loader.
- Emitted text passes review while the generated project does not run: the e2e boots it and reads
  through the real client, which is the M58 and M63 lesson about generated output.
- The devtool reaches a production composition: the entry point is a separate module the production
  entry never imports, and the connector's own `enabled: true` literal keeps the runtime flag shape
  from compiling.
- A scoped `dev` grant silently breaks a project with a database or a broker: measured in §3.7 and
  resolved by giving `dev` the same permissions `start` has, with the loopback guarantee sourced
  from the listener instead.

### 8.1 Attacker actions against this letter's boundary

M98a and M98b own the connector's threat model; the assets THIS letter introduces are the
credentials in transit from the launcher to the application, the generated files that describe where
the connector listens, and the process tree the workspace runner creates. Named as actions rather
than as failures, since the ROADMAP's threat-model paragraph binds every letter:

- **A co-resident process reads the pair from an environment it was handed.** The credentials arrive
  through the child process environment, so any process the launcher's descendants spawn can read
  them for the session's lifetime. Mitigated where this letter can reach it: the runner blanks the
  three variables in every child but the selected member (§3.4), the generated entry never writes or
  prints a pair, and M98b bounds the session with a monotonic TTL and revocation. Residual and
  stated rather than implied — a process already running as the developer is inside M98b's trust
  boundary, and this is not a sandbox against it.
- **A credential is harvested from version control.** Nothing generated ever contains a pair: not
  `deno.json`, not the dotenv pair, not `setu.workspace.json`, not `main.dev.ts`. The entry READS
  two variable names and mints nothing, and `unit/dev-entry.test.ts` asserts no generated line
  prints or persists a credential.
- **A local process squats the devtool port to impersonate the connector.** An attacker binding the
  port first denies the launcher its connector, and may try to answer in its place. M98b makes the
  second unreachable without the key: the client verifies the response MAC over the exact bounded
  bytes before parsing anything, so an impostor produces a refusal rather than fabricated records.
  Ensuring the port is not already in use is the launcher's, as it is for the application port.
- **The development entry is shipped.** An operator or an image build that runs `main.dev.ts` in
  production exposes the connector. The production entry never imports it, `enabled` is the literal
  `true`, and the listener refuses a non-Deno `listen` and a non-loopback bind.
- **`setu.workspace.json` is edited to redirect the launcher at another port.** Out of scope with
  its reason: writing that file needs repository write, which already grants arbitrary code
  execution through the member's own `main.ts`, so the manifest is not the weakest link.

## 9. Out of scope

- The connector, its wire protocol, its client and its threat model: all M98b.
- The launcher, the extension UI, packaging and subscriptions: the separately maintained devtool
  product, per the M98 "Explicit Follow-ons" section.
- Narrowing the existing unscoped `--allow-net` on the generated `start` task (C3).
- Remote and production connections, persistence and any transport beyond M98b's loopback listener.
