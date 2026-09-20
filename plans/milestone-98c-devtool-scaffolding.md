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
  the credential contract the launcher must satisfy, the development entry point and its scoped
  task, and a scaffold-boot-and-read end-to-end gate driven by `createDiagnosticsClient`.
- **NOT this milestone:** the connector, its protocol and its client, all shipped by M98b. The
  launcher, the extension UI, packaging and subscriptions remain the separately maintained devtool
  product, per the M98 "Explicit Follow-ons" section. Narrowing the `start` task's existing unscoped
  `--allow-net` is deferred; see §2 C3.

## 1. Contracts verified from SOURCE (not names)

Every row was read at the cited line on `main` at plan time, except the M98b rows, which were read
on `feat/m98b-local-diagnostics-connector` (PR #347) and are a dependency of this letter rather than
a shipped contract.

| Reference                           | Source (file:line)                                                            | Verified surface / fact                                                                                                                                                                                                                                       |
| ----------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Discovery calls the factory         | `packages/cli/src/app-loader.ts:180`                                          | `setu commands` invokes the config factory with `discoveryEnv()` as the FIRST positional argument **on every target**, and the in-source comment says so explicitly. A single-parameter `createApp(extra?)` therefore receives that proxy as `extra`.         |
| The discovery proxy                 | `packages/cli/src/app-loader.ts:65`                                           | `discoveryEnv()` answers every string key with `inertBinding()` and every symbol key with `undefined`, so `extra.plugins` is a truthy non-iterable and spreading it throws `Result of the Symbol.iterator method is not an object`. Reproduced, not reasoned. |
| `WorkspaceMember`                   | `packages/cli/src/workspace/manifest.ts:113`                                  | `{ name, port, dependsOn?, healthProbes?, metricsEndpoint? }`. ONE port per member. The two optional booleans are the precedent for an optional field recorded at `generate app` time, each documenting that absent means unknown rather than false.          |
| Port allocation                     | `packages/cli/src/workspace/manifest.ts:417`                                  | `allocatePort` is `max(basePort - 1, ...members.map(m => m.port)) + 1`. It walks `member.port` and nothing else, so any second port stored beside it is invisible to the allocator.                                                                           |
| Port validation on read             | `packages/cli/src/workspace/manifest.ts:358`                                  | A member port is range-checked on the way IN, because it reaches the member's own binding and every sibling's discovery map.                                                                                                                                  |
| `setu workspace ports --reallocate` | `packages/cli/src/commands/workspace.ts:33`, `:9`, `:10`, `:11`               | Reallocates every member port and regenerates the discovery module, the Compose files and the Kubernetes files together.                                                                                                                                      |
| Generated task permissions          | `packages/cli/src/templates/project-files.ts:958`                             | `denoPermissions` emits a bare `--allow-net`, never a scoped one, plus `--allow-env` and a conditional `--allow-read`.                                                                                                                                        |
| Generated tasks                     | `packages/cli/src/templates/project-files.ts:849`                             | `denoTasks` emits `start`, `test` and `host.extraTasks`; the Deno entry is `main.ts`.                                                                                                                                                                         |
| The `extraTasks` seam               | `packages/cli/src/templates/registry.ts:363`                                  | `TemplateHost.extraTasks?: Readonly<Record<string, string>>` is the committed way a host contributes a task.                                                                                                                                                  |
| Config factory rendering            | `packages/cli/src/templates/project-files.ts:425`                             | `createApp(${factoryParam})`, where `factoryParam` is empty for every target except Cloudflare Workers, which receives `env` and conditionally `waitUntil`.                                                                                                   |
| `generate app` flags                | `packages/cli/src/commands/app.ts:102`, `:103`, `:407`                        | Accepts `--env-file <path>` and a repeatable `--depends-on <name>`, each refused by name when inapplicable.                                                                                                                                                   |
| Workspace runtimes                  | `packages/cli/src/workspace/runtime-profile.ts:197`                           | `WORKSPACE_RUNTIMES` is `['deno', 'node', 'bun']`, so a workspace member is not necessarily a Deno project.                                                                                                                                                   |
| Dev runner                          | `packages/cli/src/workspace/dev-runner.ts:6`, `:91`; `runtime-profile.ts:142` | `scripts/dev.ts` spawns each member with `Deno.Command('deno', …)`; the root `dev` task grants `--allow-read --allow-run --allow-net`.                                                                                                                        |
| Connector options (M98b)            | `packages/diagnostics-plugin/src/interfaces/index.ts`                         | `DiagnosticsPluginOptions` is `{ enabled: true, port, sessionId, sessionKey, ttlMs? }`; `enabled` is the literal `true`, so a computed flag is a compile error and the opt-in is by construction.                                                             |
| Connector runtime gate (M98b)       | `packages/runtime/src/diagnostics/local-diagnostics-listener.ts`              | The listener factory rejects every `listen` on a non-Deno platform before any bind, so a devtool-enabled non-Deno project would fail at startup rather than degrade.                                                                                          |
| Session scope (M98b)                | `plans/archive/milestone-98b-local-diagnostics-connector.md` §3.2             | A session ID and key are per launch, and sharing one pair across applications is unsupported. N members therefore need N pairs.                                                                                                                               |
| Reviewed client (M98b)              | `packages/diagnostics-plugin/src/client/client.ts`                            | `createDiagnosticsClient` is the one reviewed implementation of the protocol's client side, so an end-to-end gate can drive a scaffolded project with the real client rather than a stand-in.                                                                 |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                | Resolution (picked side)                                                                                                                                                                                                   | Doc deliverable (same PR)                                                                    |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| C1 | The M98b README documents `createApp(extra?)` as a single parameter, which collides with discovery (§1 row 1). PR #347 corrects the README to a second parameter; nothing yet emits it. | The CLI emits the second-parameter form, and a test drives a scaffolded project through the real discovery path so the collision cannot come back.                                                                         | Update the M98b README example to match what the CLI emits, once they are the same shape.    |
| C2 | `planWorkspace`'s doc comment says "a Setu workspace is a Deno workspace", while `WORKSPACE_RUNTIMES` admits `node` and `bun`.                                                          | The code is right and the comment is stale: workspaces support three runtimes. The devtool opt-in is what is Deno-only, and it is refused by name on the other two.                                                        | Correct the `planWorkspace` comment in `packages/cli/src/commands/new.ts`.                   |
| C3 | The M98b README presents a scoped `--allow-net` as a second, independent guarantee, while `denoPermissions` emits a bare `--allow-net` for every generated project.                     | Scope the grant on the new `dev` task only. Narrowing the existing `start` grant is a behaviour change to every generated project, including ones making outbound calls, so it is named as deferred rather than folded in. | Scope the M98b README claim to the `dev` task, and record the `start` grant as an open item. |
| C4 | `WorkspaceMember` documents one port per member; a devtool member needs two.                                                                                                            | Add `devtoolPort?: number`, following the `healthProbes` and `metricsEndpoint` precedent for an optional field recorded at generate time, and widen `allocatePort` to walk both so the allocator's invariant holds.        | Document the second port in the workspace section of the CLI README.                         |

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
- `setu workspace ports --reallocate` moves both ports together and regenerates the discovery
  module, Compose and Kubernetes exactly as it does now, so the devtool port cannot survive a
  reallocation pointing at a stale address.
- **Test home:** `packages/cli/test/unit/allocate-port.test.ts`, `test/unit/reallocate.test.ts`.

### 3.4 Credentials come from the launcher, by a contract this letter fixes

- **Decision:** the generated development entry reads `SETU_DEVTOOL_SESSION_ID` and
  `SETU_DEVTOOL_SESSION_KEY` from the process environment, validates them against the shapes
  `DiagnosticsPluginOptions` requires (32 lowercase hex characters, and 32 bytes as 64 hex
  characters), and refuses to start with a named message when a variable is absent or malformed. It
  never generates a pair of its own, never writes one to a file, and never prints one.
- **This names a contract the separately maintained launcher must satisfy, and the names are
  published CLI surface once emitted.** They need §10.2 approval before implementation, because a
  later rename is a breaking change to every scaffolded project.
- In a workspace each member reads the same two variable names from its own process environment,
  because the dev runner spawns one process per member and M98b forbids sharing a session across
  applications. The launcher supplies a distinct pair per spawned member.
- **Test home:** `packages/cli/test/unit/dev-entry.test.ts`, `test/e2e/devtool-e2e.test.ts`.

### 3.5 The launcher discovers endpoints from the manifest it already reads

- **Decision:** no new file. A standalone project's devtool port lives in its `deno.json` `dev` task
  and is passed explicitly in the generated entry; a workspace's lives in `setu.workspace.json` as
  `devtoolPort`, beside the `port` a launcher must already understand to address a member at all.
  Adding a second CLI-owned index of the same values would be a second source of truth, and
  `ports --reallocate` would have to keep both correct.
- **Test home:** `packages/cli/test/unit/workspace-manifest.test.ts`.

### 3.6 The dev runner spawns the development entry for devtool members

- **Decision:** `scripts/dev.ts` spawns `main.dev.ts` for a member carrying `devtoolPort` and
  `main.ts` for every other member, from the manifest it already reads. The root `dev` task's grant
  is unchanged: it already carries `--allow-net` unscoped (`runtime-profile.ts:142`).
- **Test home:** `packages/cli/test/e2e/dev-runner-e2e.test.ts`, extending the M67 fixture.

### 3.7 The scoped grant lands on the new task only

- **Decision:** the emitted `dev` task carries `--allow-net=0.0.0.0:<port>,127.0.0.1:<devtoolPort>`
  and the `start` task is untouched. C3 records why: narrowing `start` is a behaviour change for
  every generated project, and a project that calls an external service would stop working.
- **Test home:** `packages/cli/test/unit/deno-tasks.test.ts`.

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

| Option                               | Consumer                  | Behavior (per implementation)                                                                                                                      |
| ------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setu new --devtool`                 | the shared planner (§3.2) | Emits the development entry, the `dev` task and the dependency. Refused on a non-Deno runtime by name.                                             |
| `setu generate app <name> --devtool` | the shared planner        | As above, plus allocating and recording `devtoolPort` for the new member.                                                                          |
| `setu devtool enable [member]`       | the shared planner        | Enables the devtool on a project that already exists. In a workspace the member name is required; standalone it is refused as an extra positional. |
| `--devtool-port <port>`              | the planner, the manifest | Overrides allocation with an explicit port, validated by the same range check member ports get. Absent, the port is allocated.                     |

## 5. Implementation files

| File                                                                                            | Purpose                                                                            |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/cli/src/commands/devtool.ts`                                                          | The `setu devtool enable` command and its refusals.                                |
| `packages/cli/src/devtool/planner.ts`                                                           | The one planner all three entry points call.                                       |
| `packages/cli/src/devtool/dev-entry.ts`                                                         | Renders `main.dev.ts`, including the credential read and its refusal.              |
| `packages/cli/src/commands/new.ts`, `commands/app.ts`                                           | The `--devtool` flag, its refusals, and the call into the planner.                 |
| `packages/cli/src/templates/project-files.ts`                                                   | The second factory parameter, the `dev` task and its scoped grant.                 |
| `packages/cli/src/workspace/manifest.ts`                                                        | `devtoolPort`, its validation, and the widened `allocatePort`.                     |
| `packages/cli/src/workspace/dev-runner.ts`                                                      | Spawning `main.dev.ts` for a devtool member.                                       |
| `packages/cli/src/commands/workspace.ts`                                                        | Moving both ports in `ports --reallocate`.                                         |
| `packages/cli/README.md`, `PUBLIC_API.md`, `CHANGELOG.md`, `ROADMAP.md`, `CLAUDE.md`, this plan | Documentation, release notes, tracking and plan archival in the implementation PR. |
| `packages/diagnostics-plugin/README.md`                                                         | The C1 and C3 corrections.                                                         |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                         | src covered                                                 | Key assertions                                                                                                                                                                                                                                 |
| --------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit/devtool-planner.test.ts`    | `devtool/planner.ts`                                        | One planner, three entry points: the files emitted by `new --devtool`, `generate app --devtool` and `devtool enable` are byte-identical for the same inputs.                                                                                   |
| `unit/devtool-refusals.test.ts`   | `commands/devtool.ts`, `commands/new.ts`, `commands/app.ts` | Non-Deno runtime, already-enabled member, unreadable manifest, an extra positional standalone, and an out-of-range `--devtool-port` each refuse by name and write nothing.                                                                     |
| `unit/dev-entry.test.ts`          | `devtool/dev-entry.ts`                                      | Absent and malformed credentials refuse with a named message; no generated line prints a credential.                                                                                                                                           |
| `unit/allocate-port.test.ts`      | `workspace/manifest.ts`                                     | `allocatePort` walks `devtoolPort`, so a new member never receives a port an existing member's devtool already holds. Fails without the widening.                                                                                              |
| `unit/deno-tasks.test.ts`         | `templates/project-files.ts`                                | The `dev` task carries the scoped grant; `start` is byte-identical to today.                                                                                                                                                                   |
| `unit/config-module.test.ts`      | `templates/project-files.ts`                                | The factory's devtool parameter is SECOND on every target, and the Workers signature keeps `env` first.                                                                                                                                        |
| `unit/workspace-manifest.test.ts` | `workspace/manifest.ts`                                     | `devtoolPort` round-trips, is range-checked on read, and absent stays absent.                                                                                                                                                                  |
| `integration/discovery.test.ts`   | `app-loader.ts`, `templates/project-files.ts`               | A scaffolded project's factory survives the REAL discovery path. The single-parameter shape reproduces the `Symbol.iterator` throw; the emitted shape does not. This is the guard C1 exists for.                                               |
| `e2e/devtool-e2e.test.ts`         | all of the above                                            | Scaffold with `--devtool`, type-check against this workspace, boot with credentials in the environment, and read a snapshot and an event batch with `createDiagnosticsClient`. Then boot WITHOUT the credentials and assert the named refusal. |
| `e2e/dev-runner-e2e.test.ts`      | `workspace/dev-runner.ts`                                   | A two-member workspace with the devtool on one member spawns `main.dev.ts` for it and `main.ts` for the other, and both ports answer.                                                                                                          |

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

## 9. Out of scope

- The connector, its wire protocol, its client and its threat model: all M98b.
- The launcher, the extension UI, packaging and subscriptions: the separately maintained devtool
  product, per the M98 "Explicit Follow-ons" section.
- Narrowing the existing unscoped `--allow-net` on the generated `start` task (C3).
- Remote and production connections, persistence and any transport beyond M98b's loopback listener.
