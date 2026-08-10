# Milestone 62 — CLI monorepo support (`@setu-ts/cli`)

> **Status:** Planning. Branch: `feat/m62-monorepo-support`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

The CLI has no workspace concept: `grep -rn "workspace\|monorepo" packages/cli/src` returns one
unrelated React Router `appDirectory`. Adding a second service today means `setu new other --dir .`,
which produces a fully independent project that knows nothing about its sibling — and M50b wires
`ServiceDiscoveryPlugin({ provider: 'static', services: {} })` into the microservice template with a
**deliberately empty** map, because a sample entry would resolve to a dead port. So every caller's
map is hand-edited in every service and nothing propagates a new name. This milestone gives the CLI
a workspace: `setu new <name> --workspace` creates a Deno-workspace root, `setu generate app <name>`
adds a member to it, and every member's static discovery map is regenerated from one CLI-owned
manifest, so a new service is reachable by name from its siblings with no edit to a file the
developer owns.

- **In scope:** the workspace root (`deno.json` with a member glob + `setu.workspace.json`), the
  `setu generate app` member command, per-member port allocation, the CLI-owned
  `src/discovery/services.ts` module each member's `setu.config.ts` and `main.ts` read, the
  microservice template's discovery wiring pointing at it, and an e2e that scaffolds a workspace,
  adds two members, type-checks both, boots both, and has one call the other through the discovery
  capability.
- **Folded in after the first review (§10):** a workspace-level `--transport` choice, and a
  three-member e2e proving full-mesh discovery, cross-service communication on the chosen transport,
  and that DI and decorators are reachable inside a member through the CLI alone.
- **NOT this milestone:** Docker Compose / Kubernetes objects per member — **M39** owns the platform
  objects, this milestone owns the workspace and the app-side discovery map. Converting an existing
  single-service project into a workspace — unowned, its own design (§9). Shared library members
  (`nest g library`) — deferred until the application case is proven (§9). Interactive prompts —
  unowned (§9).

## 1. Contracts verified from SOURCE (not names)

| Reference                                 | Source (file:line)                                                               | Verified surface / fact                                                                                                                                                            |
| ----------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IFileSystem`                             | `packages/common/src/runtime.ts:51-105`                                          | `readFile`, `writeFile`, `stat`, `readdir`, `mkdir`, `rm`; `realPath?`/`readStream?` optional. No `exists`, no `rename` — every probe is a `stat` in a `try`.                      |
| `GeneratedFile`                           | `packages/cli/src/utils/file-writer.ts:12-35`                                    | `{ path, contents, managed? }`. `managed: true` is read ONLY by `findExisting` (`:121`), which skips it — the sole overwrite exemption.                                            |
| `findExisting` / `writeFiles`             | `packages/cli/src/utils/file-writer.ts:115-157`                                  | Check-all-then-write-all; `writeFiles` creates parents and writes unconditionally. The command layer owns the ordering.                                                            |
| `Schematic`                               | `packages/cli/src/schematics/registry.ts:96-99`                                  | `(names, options) => readonly GeneratedFile[]` — PURE, no I/O, no async. A member command reads the filesystem, so `app` cannot be a registry entry (§3.3).                        |
| `CUSTOM_SCHEMATIC` dispatch               | `packages/cli/src/commands/generate.ts:133-145`                                  | `generate` already special-cases a non-registry verb before the registry lookup. `app` follows that precedent.                                                                     |
| `TemplateHost`                            | `packages/cli/src/templates/registry.ts:230-325`                                 | `plugins`, `middleware`, optional `appFactory`, `packageImports`, `manifest`, `localImports`, `files`, `pluginSpreads`, `setupCalls`.                                              |
| `resolveHost` / `projectFiles`            | `packages/cli/src/commands/new.ts:118-133`, `:598-737`                           | `resolveHost` fills optional members and applies `--di`; `projectFiles` renders the whole project file set and is already PURE. Both move to `templates/project-files.ts` (§3.4).  |
| `serveEntry`                              | `packages/cli/src/commands/new.ts:279-286`                                       | Emits `await app.start({ port: 3000 })` — a hardcoded literal, which is exactly what a workspace member cannot use (§3.6).                                                         |
| `firstDuplicatePath`                      | `packages/cli/src/commands/new.ts:750-757`                                       | Guards two plan entries sharing one path; the filesystem probe cannot see them. `generate app` plans across several directories and needs the same guard (§3.7).                   |
| `MICROSERVICE_ADDITIONS` discovery wiring | `packages/cli/src/templates/microservice.ts:53-57`                               | `args: "{ provider: 'static', services: {} }"` — the empty map this milestone fills.                                                                                               |
| `withPluginOptionSeams`                   | `packages/cli/src/templates/seam.ts:142-169`                                     | Rewrites a wiring's `args` by package name, returning a new list. The member overlay uses the same technique (§3.5).                                                               |
| `StaticDiscoveryOptions`                  | `packages/service-discovery-plugin/src/options.ts:44-58`                         | `{ provider: 'static'; services: Readonly<Record<string, readonly StaticServiceDefinition[]>>; watchIntervalMs? }` — a union arm with no default, so a bare call does not compile. |
| `StaticServiceDefinition`                 | `packages/service-discovery-plugin/src/interfaces/index.ts:141-156`              | `{ id?, host, port, secure?, weight?, tags?, metadata? }` — `host` and `port` are the only required fields, which is exactly what a generated map can honestly supply.             |
| `StaticProvider.#instances`               | `packages/service-discovery-plugin/src/providers/static-provider.ts:70-84`       | An unknown service name resolves to `[]`; `id` defaults to `<host>:<port>`.                                                                                                        |
| `IServiceDiscovery`                       | `packages/common/src/services/service-discovery.ts:107-167`                      | `resolve`, `pick`, `resolveUrl(serviceName, path?, options?)`, `report`, `watch`. `resolveUrl` returns `string \| null`.                                                           |
| `CAPABILITIES.SERVICE_DISCOVERY`          | `packages/common/src/tokens.ts:117`                                              | `'service-discovery'`.                                                                                                                                                             |
| `ServiceDiscoveryPlugin`                  | `packages/service-discovery-plugin/src/plugin/service-discovery-plugin.ts:52-62` | `provides: [CAPABILITIES.SERVICE_DISCOVERY]`; options resolved eagerly at construction.                                                                                            |
| `detectPlugins`                           | `packages/cli/src/utils/plugin-detector.ts:71-90`                                | Reads the target dir's `deno.json` `imports`, falling back to `package.json`. It reads ONE directory and never walks up — so a member must carry its own framework pins (§3.2).    |
| `application.start` hostname              | `packages/kernel/src/application/application.ts:334`                             | `adapter.listen(options.port, options.hostname)` — hostname is caller-supplied and the generated entry passes none, so the adapter's default binds loopback-reachable (§3.8).      |
| Deno workspace globs                      | measured, `deno 2.9.5`                                                           | `"workspace": ["./apps/*"]` resolves members: `deno task --recursive hello` ran both members' tasks. **A member list therefore never needs rewriting when one is added** (§3.1).   |
| Memberless workspace                      | measured, `deno 2.9.5`                                                           | A root whose glob matches nothing (no `apps/` directory at all) runs and type-checks normally — so a root scaffolded before its first member is valid (§3.1).                      |
| Member `imports` merge                    | measured, `deno 2.9.5`                                                           | A member's own `imports` resolve ALONGSIDE the root's; neither replaces the other. So per-member framework pins are additive (§3.2).                                               |
| Member `compilerOptions`                  | measured, `deno 2.9.5`                                                           | A member's `compilerOptions.experimentalDecorators` is honored — a decorated class in a member type-checks and runs. No "ignored in workspace member" diagnostic.                  |
| Member `nodeModulesDir`                   | measured, `deno 2.9.5`                                                           | `Warning "nodeModulesDir" field can only be specified in the workspace root deno.json file.` This is why `full-stack` is refused as a member (§3.9).                               |
| Member without `name`/`version`           | measured, `deno 2.9.5`                                                           | A member `deno.json` carrying only `tasks` participates in `--recursive`. Members need no JSR identity, so the scaffolded member manifest is unchanged from a standalone one.      |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                   | Resolution (picked side)                                                                                                                                                                                                       | Doc deliverable (same PR)                                                                                                                                      |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `ROADMAP.md:6392` leaves the verb name open — "`app` matches Nest, `service` matches the domain".                                                                                          | **`app`**. `service` is already a schematic name (`packages/cli/src/schematics/registry.ts:173` — `setu g service` emits a class), so reusing it would make one word mean two things in the same command.                      | ROADMAP M62 deliverable list rewritten with the settled verb.                                                                                                  |
| C2 | `ROADMAP.md:6377-6380` frames the workspace shape as an open question whose Deno-workspace arm implies a member list that must be maintained.                                              | **Deno workspace with a `./apps/*` GLOB.** Measured (§1): a glob resolves members, so adding one never rewrites the root manifest. The trade-off the ROADMAP recorded does not exist.                                          | ROADMAP M62 section records the measured glob finding and drops the framing as an open question.                                                               |
| C3 | `ROADMAP.md:6381-6383` asks who owns the discovery map and answers "probably" the M58 barrel technique.                                                                                    | **Confirmed and made specific:** a CLI-owned `src/discovery/services.ts` per member, `managed: true`, regenerated for every member on each `generate app`; `setu.workspace.json` is the authoritative data it is derived from. | ROADMAP M62 section states the two files by name; PUBLIC_API gains the workspace subsection.                                                                   |
| C4 | `PUBLIC_API.md:4858-4930` documents the CLI's whole command surface and knows nothing about workspaces; `docs/plugins.md:1111-1112` lists the CLI's commands as `new` and `generate` only. | Both are correct-as-of-M61 and incomplete after this milestone.                                                                                                                                                                | PUBLIC_API CLI section gains a "Monorepo workspaces" subsection + the `--workspace`/`--port` option rows; `docs/plugins.md` command list gains `generate app`. |

## 3. Design decisions

### 3.1 What a Setu monorepo IS

- **Decision:** A **Deno workspace** whose root `deno.json` declares `"workspace": ["./apps/*"]`, a
  glob, plus a `setu.workspace.json` the CLI owns. Members live at `apps/<name>` and are ordinary
  scaffolded projects. The root is created by `setu new <name> --workspace` and is never rewritten
  afterwards.
- **Why:** The glob is what makes this cheap: measured against `deno 2.9.5`, `["./apps/*"]` resolves
  members for `deno task --recursive`, and a root whose glob matches nothing still runs. So adding a
  member touches no manifest a developer edits — the objection that made M58 refuse to edit
  `setu.config.ts` never arises, because there is nothing to edit. The alternative shape (sibling
  directories with independent manifests) gives up one lockfile and one recursive task for no gain.
  This repository is itself a Deno workspace, so the shape has an in-house precedent.
- **Test home:** `test/unit/workspace/root-files.test.ts` (the emitted glob and manifest);
  `test/e2e/workspace-e2e.test.ts` (a real `deno task --recursive` over two real members).

### 3.2 Where a member's framework pins live

- **Decision:** Each member's own `deno.json` carries the full `imports` map `setu new` already
  emits. The workspace root's `deno.json` carries the member glob and shared tasks, and **no
  framework pins at all**.
- **Why:** `detectPlugins` (`plugin-detector.ts:71-90`) reads exactly one directory's manifest and
  never walks up, so pins living only at the root would make every gated schematic refuse inside a
  member — `setu g controller` in a REST member would report the decorator plugin missing. Measured
  (§1), a member's `imports` merge with the root's rather than replacing them, so per-member pins
  are additive and members may legitimately differ: one member REST, another microservice.
- **Test home:** `test/e2e/workspace-e2e.test.ts` asserts a gated generate succeeds inside a member.

### 3.3 Where `generate app` lives

- **Decision:** `setu generate app <name>` / `setu g app <name>`, dispatched inside
  `runGenerateCommand` by an early name check, exactly as `custom` already is
  (`generate.ts:133-145`), and implemented in `src/commands/app.ts`. It is **not** a schematic
  registry entry.
- **Why:** `Schematic` is `(names, options) => readonly GeneratedFile[]` — pure and synchronous
  (`registry.ts:96-99`). The member command must read `setu.workspace.json`, allocate a port from
  it, and regenerate every sibling's module; hoisting all of that into `SchematicOptions` the way
  `modules` and `artifacts` were hoisted would put workspace state on a published interface that no
  other schematic reads, which is dead surface by the rule in CLAUDE.md. Keeping the verb under
  `generate` keeps one help surface and one `--dir`/`--dry-run` implementation.
- **Test home:** `test/unit/app-command.test.ts`; `test/unit/generate-command.test.ts` (the dispatch
  and the `--help` listing).

### 3.4 Reuse of the project renderer

- **Decision:** Move the rendering half of `commands/new.ts` — `resolveHost`, `ResolvedHost`,
  `projectFiles` and the private renderers they call — into `src/templates/project-files.ts`, and
  move `firstDuplicatePath` into `src/utils/file-writer.ts`. `commands/new.ts` keeps the command
  (flag parsing, refusals, the write pipeline). Both commands import the renderer.
- **Why:** A member IS a scaffolded project; re-rendering one in `commands/app.ts` would be a second
  copy of ~700 lines (§11.1). A command importing another command is the alternative, and the
  renderer is template code rather than command code, so the file it belongs in is under
  `templates/`. `firstDuplicatePath` operates on a `GeneratedFile[]`, which is `file-writer.ts`'s
  subject, and both commands now need it.
- **Test home:** the existing `test/unit/new-command.test.ts` and `test/unit/file-writer.test.ts`
  keep their assertions with updated imports; a scaffolded standalone project's files stay
  byte-identical, pinned by the existing template e2e.

### 3.5 How a member's discovery map reaches the plugin

- **Decision:** Each member carries a CLI-owned `src/discovery/services.ts` exporting `SERVICE_PORT`
  (this member's own port) and `SERVICE_ENDPOINTS` (every OTHER member, keyed by name, as
  `[{ host: '127.0.0.1', port }]`). The member's `setu.config.ts` imports `SERVICE_ENDPOINTS`
  through `TemplateHost.localImports` and the discovery wiring's `args` becomes
  `{ provider: 'static', services: SERVICE_ENDPOINTS }`, rewritten by a member overlay that uses the
  same technique as `withPluginOptionSeams` (`seam.ts:142-169`). The file is emitted with
  `managed: true` and regenerated for every member on every `generate app`.
- **Why:** This is the M58 mechanism — a CLI-owned generated module the config already imports —
  applied to a cross-file write. The map is honest here in a way M50b's sample would not have been:
  the sibling exists in this repository and its port is allocated by the same command, so the entry
  resolves to something that is actually there. The wiring rewrite is applied ONLY when the member's
  plugin set contains `service-discovery-plugin`, so a REST member gets no unresolvable import,
  while still appearing in other members' maps — being reachable and consuming the map are separate
  properties.
- **Test home:** `test/unit/workspace/discovery-module.test.ts` (contents, self-exclusion);
  `test/unit/workspace/member-host.test.ts` (the rewrite and the gated import);
  `test/e2e/workspace-e2e.test.ts` (a booted member resolving its sibling).

### 3.6 Where a member's port comes from

- **Decision:** `setu.workspace.json` holds `{ version, basePort, members: [{ name, port }] }` and
  is the single authoritative source. A new member's port is `max(basePort - 1, ...existing) + 1`.
  The member's generated `main.ts` binds `SERVICE_PORT` imported from its discovery module rather
  than a literal, so the port a member binds and the port its siblings dial are the same datum.
  `serveEntry` gains an optional port-import parameter; a standalone project keeps `port: 3000`
  byte-identically.
- **Why:** Two members both defaulting to 3000 cannot run together, which is the whole point of a
  monorepo dev loop, and a map whose ports are guessed independently of what each member binds is
  the drift this design exists to remove. `max + 1` rather than `basePort + index` keeps an existing
  member's port stable when a name sorting before it is added — an index-derived port would silently
  change what an existing service binds.
- **Test home:** `test/unit/workspace/manifest.test.ts` (allocation, including a hand-edited port
  above the base); `test/e2e/workspace-e2e.test.ts` (the resolved URL is fetched and answers `200`,
  which is the only thing that proves map and binding agree).

### 3.7 What `generate app` plans, and in what order

- **Decision:** One plan, checked before any write: the member's own project files (rooted at
  `apps/<name>/`), then EVERY member's `src/discovery/services.ts` including the new one, then the
  rewritten `setu.workspace.json`. The regenerated modules and the manifest are `managed: true`; the
  member's own files are not. The new member's discovery module is emitted ONLY by the regeneration
  pass, never also by the member host's `files`, and `firstDuplicatePath` guards the whole plan.
- **Why:** `findExisting` probes the filesystem and cannot see one path planned twice
  (`file-writer.ts:115-130`); emitting the new member's module from both the host and the
  regeneration pass would write it twice with the last silently winning. `managed` is the exemption
  the M58 barrel established, and it is per-file precisely so the member's own source keeps the
  overwrite refusal.
- **Test home:** `test/unit/app-command.test.ts` (plan contents, `managed` flags, duplicate guard).

### 3.8 What the generated map's `host` is

- **Decision:** `127.0.0.1`. The module's header states that the map is the local development
  topology and that a deployed topology comes from a real provider arm (`consul`, `kubernetes`,
  `dns`) rather than from this file.
- **Why:** The members run on one machine during development, and that is the only topology the CLI
  can know. `application.start` passes the caller's hostname straight to the adapter
  (`application.ts:334`) and the generated entry passes none, so a member is reachable on loopback.
  Claiming anything else would be a guess about deployment, which is M39's subject.
- **Test home:** `test/unit/workspace/discovery-module.test.ts`; the e2e's real fetch.

### 3.9 Which templates and runtimes a member may use

- **Decision:** Members are Deno-only, and `--template full-stack` is refused for a member.
  `generate
  app` accepts no template, `rest`, `microservice`, and `nest`, plus `--di`. A
  non-`deno` `--runtime` is a usage error naming `setu new --runtime <target>` for a standalone
  project.
- **Why:** A workspace is a Deno construct; there is no npm-workspace design here and inventing one
  is a milestone of its own. `full-stack` is refused for a measured reason rather than a cautious
  one: it emits a `package.json` (its Vite build), which switches Deno to node_modules resolution,
  and M37c established that such a project needs `nodeModulesDir` in its own manifest — which a
  member may not declare. Deno says so in as many words:
  `"nodeModulesDir" field can only be
  specified in the workspace root deno.json file.` Refusing at
  scaffold time beats emitting a member that cannot resolve its own dependencies.
- **Test home:** `test/unit/app-command.test.ts` (both refusals, each asserting the message names
  the reason).

### 3.10 Creating the workspace root

- **Decision:** `setu new <name> --workspace [--port <n>]` creates the root and no member. Combining
  `--workspace` with `--template` is a usage error naming `setu generate app <name> --template <t>`;
  combining it with a non-`deno` `--runtime` is a usage error. `--port` sets `basePort` (default
  `3000`) and must parse as an integer in `1..65535`.
- **Why:** A workspace root registers no plugins and starts no server, so a template applied to it
  has nothing to configure — silently ignoring the flag is the defect class M34 shipped with
  `--runtime`. Keeping the root member-free means one command does one thing, and the memberless
  root is valid (§1, measured). `--port` exists because a fixed 3000 makes two workspaces on one
  machine collide, and because the e2e must allocate a free base port rather than gamble on 3000
  being unused.
- **Test home:** `test/unit/new-command.test.ts` (the three refusals, the emitted root files, the
  base port).

### 3.11 Refusing outside a workspace, and refusing a duplicate member

- **Decision:** `generate app` with no readable `setu.workspace.json` in the target directory exits
  `1` naming `setu new <name> --workspace`. A member name already present in the manifest exits `1`
  naming the existing directory. A manifest whose `version` is not `1` exits `1` naming the CLI
  version.
- **Why:** Falling back to "create a workspace implicitly" would scatter roots wherever the command
  happened to run. The duplicate check is explicit rather than left to `findExisting`, whose message
  ("Refusing to overwrite existing files") describes a symptom rather than the cause.
- **Test home:** `test/unit/app-command.test.ts`.

## 4. Exported surface — every symbol names its consumer

**No change to `packages/cli/src/index.ts`.** Every symbol below is internal to the package, exactly
as the seam and template machinery is; the CLI's public surface is its command line, which §2/C4
documents.

| Exported symbol                                                       | Kind    | Consumer / real code path that READS it                                                                    |
| --------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `WORKSPACE_MANIFEST`, `MEMBERS_DIR`                                   | const   | `commands/app.ts` and `workspace/root-files.ts` build every workspace path from them.                      |
| `WorkspaceManifest`, `WorkspaceMember`                                | type    | `commands/app.ts`, `workspace/discovery-module.ts`, `workspace/root-files.ts`.                             |
| `readWorkspaceManifest`                                               | fn      | `commands/app.ts` — the workspace gate and the member list.                                                |
| `renderWorkspaceManifest`                                             | fn      | `commands/app.ts` (rewrite) and `workspace/root-files.ts` (initial).                                       |
| `allocatePort`                                                        | fn      | `commands/app.ts` — the new member's port.                                                                 |
| `DISCOVERY_MODULE`, `SERVICE_PORT_EXPORT`, `SERVICE_ENDPOINTS_EXPORT` | const   | `workspace/member-host.ts` (the config import and the entry import), `commands/app.ts` (the emitted path). |
| `renderDiscoveryModule`                                               | fn      | `commands/app.ts` — one call per member on every run.                                                      |
| `withWorkspaceMember`                                                 | fn      | `commands/app.ts` — the member's resolved host.                                                            |
| `workspaceRootFiles`                                                  | fn      | `commands/new.ts` — the `--workspace` branch.                                                              |
| `runAppCommand`                                                       | fn      | `commands/generate.ts` — the `app` dispatch.                                                               |
| `projectFiles`, `resolveHost`, `ResolvedHost`, `EntryPort`            | fn/type | `commands/new.ts` and `commands/app.ts` (moved, §3.4).                                                     |
| `firstDuplicatePath`                                                  | fn      | `commands/new.ts` and `commands/app.ts` (moved, §3.4).                                                     |
| `resolveTemplateChoice`, `TemplateChoice`                             | fn/type | `commands/new.ts` and `commands/app.ts` — one template-selection implementation for both verbs.            |

### 4.1 Options — every option names its consumer

| Option                           | Consumer                                                    | Behavior (per implementation)                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `--workspace` (`new`)            | `runNewCommand`                                             | Renders the workspace root instead of a project. Refuses `--template` and a non-`deno` `--runtime`.                                            |
| `--port <n>` (`new --workspace`) | `runNewCommand` → `workspaceRootFiles`                      | Sets `basePort` in the manifest; the first member binds it. Rejected outside `--workspace`, and rejected when it does not parse as `1..65535`. |
| `--template <name>` (`g app`)    | `runAppCommand` → `resolveTemplateChoice`                   | Selects the member's plugin set. `full-stack` refused (§3.9); the other three behave exactly as under `setu new`.                              |
| `--di` (`g app`)                 | `runAppCommand` → `resolveHost`                             | Registers `DiPlugin` in the member, identically to `setu new --di`.                                                                            |
| `--dir <path>` (`g app`)         | `runGenerateCommand`'s existing `resolveDir`                | The workspace root to operate on. Unchanged code path.                                                                                         |
| `--dry-run` (`g app`)            | `runAppCommand`                                             | Prints every planned path — member files, every regenerated module, the manifest — and writes nothing.                                         |
| `version` (manifest field)       | `readWorkspaceManifest`                                     | `1`. Anything else is refused, naming the CLI version, rather than being read with a guessed shape.                                            |
| `basePort` (manifest field)      | `allocatePort`                                              | Floor for allocation; a member hand-edited above it keeps the next allocation above that member.                                               |
| `members[].name` / `.port`       | `allocatePort`, `renderDiscoveryModule`, the duplicate gate | The service name in every sibling's map, and the port that member binds.                                                                       |

## 5. Implementation files

| File                                | Purpose                                                                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                      | Unchanged — no new public export (§4).                                                                                                          |
| `src/constants.ts`                  | `VALUE_FLAGS` gains `port`; `APP_VERB` const for the `generate app` name.                                                                       |
| `src/workspace/manifest.ts`         | `WorkspaceManifest`/`WorkspaceMember`, `WORKSPACE_MANIFEST`, `MEMBERS_DIR`, `readWorkspaceManifest`, `renderWorkspaceManifest`, `allocatePort`. |
| `src/workspace/discovery-module.ts` | `DISCOVERY_MODULE`, the two export names, `renderDiscoveryModule(member, siblings)`.                                                            |
| `src/workspace/member-host.ts`      | `withWorkspaceMember(host)` — the discovery `localImport` and the `args` rewrite, applied only when the member installs the plugin.             |
| `src/workspace/root-files.ts`       | `workspaceRootFiles(name, basePort)` — root `deno.json` (glob + `dev` task), `setu.workspace.json`, `README.md`, `.gitignore`.                  |
| `src/templates/project-files.ts`    | Moved from `commands/new.ts`: `resolveHost`, `ResolvedHost`, `projectFiles`, `EntryPort` and the private renderers (§3.4).                      |
| `src/templates/choice.ts`           | `resolveTemplateChoice` — template lookup, unsupported-runtime refusal, `--di` reading; shared by both verbs.                                   |
| `src/commands/app.ts`               | `runAppCommand` — the workspace gate, refusals, port allocation, the plan, and the write pipeline.                                              |
| `src/commands/new.ts`               | Modified: `--workspace` branch, `--port` validation, delegates rendering and template selection.                                                |
| `src/commands/generate.ts`          | Modified: `app` dispatch before the registry lookup, and the `--help` listing line.                                                             |
| `src/cli.ts`                        | Modified: top-level help mentions `generate app` and `new --workspace`.                                                                         |
| `src/utils/file-writer.ts`          | Modified: `firstDuplicatePath` moves here (§3.4).                                                                                               |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                       | src covered                         | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/workspace/manifest.test.ts`          | `src/workspace/manifest.ts`         | `readWorkspaceManifest(fs, dir)` → `undefined` when absent, when the JSON is malformed, and when the root is not an object; a `version` other than `1` is reported distinctly from "absent". `allocatePort({ basePort: 3000, members: [] })` → `3000`; with a hand-edited `4100` member → `4101`; sorted or unsorted member order gives the same answer. `renderWorkspaceManifest` round-trips through `readWorkspaceManifest`.                                                                                                                                                                                                                                           |
| `test/unit/workspace/discovery-module.test.ts`  | `src/workspace/discovery-module.ts` | `renderDiscoveryModule(member, siblings)` emits `export const SERVICE_PORT = <port>;`, one entry per sibling with `host: '127.0.0.1'`, EXCLUDES the member itself, sorts sibling keys, and emits `{}` for a lone member. The emitted text contains the `setu.config.ts` and `main.ts` wiring lines (the M58 header contract).                                                                                                                                                                                                                                                                                                                                             |
| `test/unit/workspace/member-host.test.ts`       | `src/workspace/member-host.ts`      | `withWorkspaceMember(host)` on a microservice host rewrites the `service-discovery-plugin` wiring to `{ provider: 'static', services: SERVICE_ENDPOINTS }` and adds exactly one `localImports` entry; on a host without that package it changes NOTHING (deep-equal to the input) — the gate that keeps a REST member's config resolvable.                                                                                                                                                                                                                                                                                                                                |
| `test/unit/workspace/root-files.test.ts`        | `src/workspace/root-files.ts`       | `workspaceRootFiles('acme', 3000)` emits `deno.json` whose `workspace` is `['./apps/*']` (parsed, not substring-matched), `setu.workspace.json` with `version: 1`, `basePort: 3000`, `members: []`, plus README and `.gitignore`. No path is emitted twice.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `test/unit/app-command.test.ts`                 | `src/commands/app.ts`               | Against `createFakeFs`: refuses outside a workspace (exit `1`, message names `--workspace`); refuses a duplicate member; refuses `--runtime node`; refuses `--template full-stack` naming `nodeModulesDir`; refuses `version: 2`. On success plans `apps/<n>/main.ts`, `apps/<n>/setu.config.ts`, `apps/<n>/deno.json`, every member's `src/discovery/services.ts` with `managed: true`, and `setu.workspace.json` with `managed: true`; `--dry-run` writes nothing; a second member's plan regenerates the FIRST member's module with the new entry.                                                                                                                     |
| `test/unit/templates/choice.test.ts`            | `src/templates/choice.ts`           | `resolveTemplateChoice(flags, runtime)` returns the definition for a known name, a refusal naming every template for an unknown one, a refusal for an unsupported template/runtime pairing, and `features.di` from the boolean flag.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `test/unit/new-command.test.ts` (extended)      | `src/commands/new.ts`               | `--workspace` emits the root file set and no `setu.config.ts`; `--workspace --template rest` is exit `2` naming `generate app`; `--workspace --runtime node` is exit `2`; `--port abc`, `--port 0`, `--port 70000` are exit `2`; `--port` without `--workspace` is exit `2`. Existing assertions unchanged.                                                                                                                                                                                                                                                                                                                                                               |
| `test/unit/generate-command.test.ts` (extended) | `src/commands/generate.ts`          | `g app` reaches `runAppCommand` (a workspace-less run returns its refusal, not "Unknown schematic"); `generate --help` lists the `app` verb.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `test/unit/file-writer.test.ts` (extended)      | `src/utils/file-writer.ts`          | `firstDuplicatePath` assertions move here unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `test/unit/templates/project-files.test.ts`     | `src/templates/project-files.ts`    | `resolveHost` and `projectFiles` assertions moved from `new-command.test.ts`, plus: `projectFiles` with an `EntryPort` emits `app.start({ port: SERVICE_PORT })` and the import, and without one emits `port: 3000` byte-identically.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `test/e2e/workspace-e2e.test.ts`                | the whole path, against a REAL Deno | Scaffold a workspace on a free base port; add `orders` and `billing` as microservice members; assert the manifest, both modules, and that `deno task --recursive` sees both members. Repoint both members at this workspace and `deno check` each member's `main.ts`, `setu.config.ts` and discovery module. Then BOOT `billing` as a subprocess and run a probe subprocess that starts `orders`' app, resolves `billing` through `CAPABILITIES.SERVICE_DISCOVERY`, fetches the resolved URL and prints the status — asserting the URL carries billing's allocated port and the fetch answers `200`. Also: a gated `g controller` succeeds inside a `rest` member (§3.2). |

Negative controls to run and revert during verification, each observed failing:

1. Drop the `managed: true` from the regenerated sibling modules → the second `generate app` refuses
   with "Refusing to overwrite existing files".
2. Emit the new member's discovery module from the member host as well as the regeneration pass →
   the duplicate-path guard fires.
3. Point the member's `main.ts` at a literal `3000` instead of `SERVICE_PORT` → the e2e's fetch
   fails, proving the map/binding agreement is actually measured.
4. Remove the `service-discovery-plugin` gate from the member overlay → a `rest` member's
   `setu.config.ts` fails `deno check` on an unresolvable identifier.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m62-monorepo-support, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # on a COMMITTED tree
deno task release:verify 0.1.0-alpha.5
```

## 8. Risks & mitigations

- **The e2e binds real ports and could collide in CI.** → The workspace's base port is allocated by
  the test from a real free-port probe (`Deno.listen({ port: 0 })`, read the assigned port, close),
  never a constant. That needs a scoped `net` grant in `packages/cli/deno.json`'s
  `test.permissions`; M53 established that a CLI-level `--allow-net` REPLACES a package block, and
  the root test task passes no net flag, so the package grant is the one that applies.
- **The e2e's subprocesses could outlive a failing assertion.** → Every spawned process is killed in
  a `finally`, and its stdout/stderr are captured so a failure reports what the member printed
  rather than a bare timeout.
- **Moving ~700 lines out of `commands/new.ts` could silently change scaffolded output.** → The move
  is mechanical, and the existing template e2e already type-checks scaffolded projects for all four
  templates; a byte-identical assertion on a standalone project's `main.ts` pins the `EntryPort`
  default.
- **A workspace member's manifest could drift from what `detectPlugins` expects.** → The e2e runs a
  gated `g controller` inside a member, which fails if the pins are not where the detector looks.
- **Deno's workspace glob behavior could change.** → It is measured in this plan against the pinned
  toolchain and re-measured by the e2e's real `deno task --recursive` run, so a regression surfaces
  in CI rather than in a user's repository.

## 9. Out of scope

- **Compose / Kubernetes objects per member** — **M39**, per the boundary the ROADMAP draws.
- **Converting an existing single-service project into a workspace** — a migration command is its
  own design; this milestone creates a workspace or adds to one. Unowned.
- **Shared library members (`nest g library`)** — deferred until the application case is proven.
  Unowned.
- **`full-stack` members** — refused with a measured reason (§3.9). A workspace-root
  `nodeModulesDir` design is what would unblock it; unowned.
- **Non-Deno workspaces** (npm workspaces for `node`/`bun` members) — a different mechanism with its
  own manifest shape. Unowned.
- **A per-member `--port` override on `generate app`** — the base port plus a hand-editable manifest
  covers the need, and the next `generate app` regenerates from it. Unowned.
- **Interactive prompts for the member's template** — the CLI has no prompt surface anywhere and no
  stdin seam; adding one is its own milestone. Unowned.

## 10. Folded-in scope — inter-service transport (added after the first code review)

The first review shipped a workspace whose members talk over exactly one mechanism: HTTP, through
the discovery map. Probed with two generated microservice members, one subscribing to
`orders.created` and the other publishing to it, the publish reported success and **nothing
crossed** — `MessagingPlugin()` defaults to the in-memory broker, which is process-local. N
generated services each holding a private broker is a silent no-op between them, so the transport
becomes a choice.

### 10.1 Contracts verified from SOURCE

| Reference                                    | Source (file:line)                                                 | Verified surface / fact                                                                                                                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MessagingPluginOptions`                     | `packages/messaging-plugin/src/interfaces/index.ts:293-303`        | Union discriminated on `broker`. Memory's discriminant is OPTIONAL, so `MessagingPlugin()` stays valid.                                                                                                       |
| `RedisStreamsMessagingOptions`               | `…/interfaces/index.ts:127-135`                                    | `{ broker: 'redis-streams'; url?; client?; defaultQueue?; pollIntervalMs?; blockSizeMs? }` — a URL is the only thing a scaffold needs.                                                                        |
| `RabbitMqMessagingOptions`                   | `…/interfaces/index.ts:142-148`                                    | `{ broker: 'rabbitmq'; url?; … }`.                                                                                                                                                                            |
| `NatsMessagingOptions`                       | `…/interfaces/index.ts:155-161`                                    | `{ broker: 'nats'; url?; … }`.                                                                                                                                                                                |
| `KafkaMessagingOptions`                      | `…/interfaces/index.ts:168-175`                                    | `{ broker: 'kafka'; brokers?: readonly string[]; … }` — a LIST, not a `url`.                                                                                                                                  |
| Pub/Sub + Service Bus arms                   | `…/interfaces/index.ts:181-262`                                    | Both require a credential (`projectId` / `connectionString`) with no usable default — excluded from the flag (§10.2).                                                                                         |
| Default broker                               | `packages/messaging-plugin/src/plugin/messaging-plugin.ts:116-117` | `brokerType === 'memory'` → `new InMemoryBroker(...)`, process-local.                                                                                                                                         |
| `GrpcPluginOptions`                          | `packages/grpc-plugin/src/interfaces/index.ts:14-47`               | `{ basePath?; reflection?; health?; services?; connectModule? }` — every field optional, so `GrpcPlugin()` is a valid registration.                                                                           |
| `GrpcServiceDefinition`                      | `packages/common/src/services/grpc.ts:43-58`                       | `{ typeName, method: Record<string, TMethod> }`. A real one comes from a revived `FileDescriptorSet` (`grpc-unary-e2e.test.ts:24-28`), NOT from a hand-written literal.                                       |
| A bare `GrpcPlugin()` serves a callable RPC  | measured                                                           | `POST /grpc/grpc.health.v1.Health/Check` with `content-type: application/json` → `200 {"status":"SERVING"}`, with no descriptor generated and no proto toolchain. This is what makes a gRPC transport honest. |
| Cross-process delivery on the default broker | measured                                                           | Two generated members, one `subscribe`, one `publish`: `ORDERS_PUBLISHED` / no `BILLING_RECEIVED`. The defect this scope closes.                                                                              |

### 10.2 Design decisions

#### 10.2.1 The transport is a WORKSPACE property, not a per-member one

- **Decision:** `setu new <name> --workspace --transport <t>` records it in `setu.workspace.json`;
  every member added later inherits it. `generate app` does NOT take `--transport` and refuses it,
  naming the workspace flag — exactly as it refuses `--port`.
- **Why:** members can only talk over a broker they SHARE. A per-member flag makes a workspace whose
  members silently cannot reach each other trivially expressible, which is the failure this whole
  milestone exists to remove. One workspace, one bus.
- **Test home:** `test/unit/workspace/transport.test.ts`, `test/unit/app-command.test.ts`.

#### 10.2.2 Which transports ship

- **Decision:** `http` (default), `grpc`, `memory`, `redis`, `rabbitmq`, `nats`, `kafka`. `tcp` is
  REFUSED with a message naming `http`. Pub/Sub and Service Bus are omitted.
- **Why:** `http` is the existing discovery + `fetch` path and stays the default, so an upgrade
  changes nothing. `grpc` registers `GrpcPlugin()`, which co-serves Connect RPC on the member's own
  port and is callable immediately (measured above). The four brokers need only a URL (or a broker
  list) and have a real local default. Pub/Sub and Service Bus need a credential no scaffold can
  invent — a generated `projectId: ''` is a dead option. There is no raw-TCP transport in this
  framework: HTTP over TCP is the honest reading of "TCP", so the refusal says so rather than
  inventing one.
- **Test home:** `test/unit/workspace/transport.test.ts`; the refusal in `new-command.test.ts`.

#### 10.2.3 What a transport renders

- **Decision:** one `TransportSpec` per transport (`plugins`, `defaultEndpoint`, `describe`), read
  by the member overlay. `http` adds nothing; `grpc` adds `GrpcPlugin()`; a broker arm rewrites the
  existing `MessagingPlugin` wiring's `args` to its discriminated-union literal.
- **Why:** it is the `withPluginOptionSeams` technique the seams already use, so a template's own
  wiring list stays the single source of what a member registers. Rewriting rather than appending
  matters: the microservice template ALREADY registers `MessagingPlugin`, and appending a second one
  would trip the kernel's duplicate-plugin-name check at `start()`.
- **Test home:** `test/unit/workspace/member-host.test.ts`.

#### 10.2.4 The endpoint a broker points at

- **Decision:** a per-transport local default (`redis://127.0.0.1:6379`, `amqp://127.0.0.1:5672`,
  `nats://127.0.0.1:4222`, `127.0.0.1:9092`), overridable with `--transport-url` at workspace
  creation and recorded beside the transport in the manifest.
- **Why:** the same reasoning as the `127.0.0.1` discovery map — the CLI knows only the local
  development topology, and a broker on its standard local port is what `docker run redis` gives
  you. The override exists because a shared dev broker is common and editing four generated configs
  by hand is the churn this milestone removes.
- **Test home:** `test/unit/workspace/transport.test.ts`.

### 10.3 Verification bar for the folded-in scope

Three members, not two — a two-member mesh cannot distinguish "every member learns every other" from
"the pair happens to know each other":

1. `setu new acme --workspace --transport <t>` then three `generate app` runs.
2. Every member's map names the OTHER TWO and never itself (full mesh, 3×2 entries).
3. All three type-check from the workspace root through the glob.
4. All three boot, and one calls BOTH others on the chosen transport, asserting a response from
   each.
5. DI and decorators inside a member, via the CLI alone: `generate app x --di --template nest`, then
   `setu generate module`/`service`/`controller` inside it, then `deno check`, then BOOT and drive
   the decorated route.
