# Milestone 67 — Scaffold Defaults and Workspace Ergonomics (`@setu-ts/cli`, `@setu-ts/starters/*`)

> **Status:** Complete. Branch: `feat/m67-scaffold-defaults-workspace-ergonomics`. `main` is
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR.

## 0. Objective & scope

Remove five hand-edits from newly scaffolded applications and workspaces. The CLI will generate and
wire environment configuration, opt template error handling into RFC 9457, make full-stack workspace
members consume their generated discovery map through the starter composition, allocate and
reallocate only bindable ports, and run declared workspace dependencies only after their readiness
endpoint answers. The starter tier gains the service-discovery option needed for the full-stack
factory path; it does not gain a second plugin-composition mechanism.

- **In scope:** CLI template rendering, workspace manifest/read-write validation, port probing and
  reassignment, generated workspace dev runners and dependency metadata, REST starter
  service-discovery option inheritance, tests and documentation.
- **NOT this milestone:** runtime plugin options resolved after `ConfigPlugin` registration (M36c
  deliberately established that construction-time values require a pre-construction source); remote
  discovery backends and deployment topology (M50/M39); health endpoint contract changes (M20);
  changing existing user projects automatically.

## 1. Contracts verified from SOURCE (not names)

| Reference                      | Source (file:line)                                                                                                         | Verified surface / fact                                                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full-stack factory host        | `packages/cli/src/templates/registry.ts:178-214`                                                                           | `TemplateHost.appFactory` owns factory composition and requires `plugins` to remain empty; factory arguments currently receive only the target runtime.                       |
| Workspace overlay              | `packages/cli/src/workspace/member-host.ts:20-74`                                                                          | It rewrites only an existing `service-discovery-plugin` wiring and adds the `SERVICE_ENDPOINTS` import; hosts without that wiring are returned unchanged.                     |
| Discovery map                  | `packages/cli/src/workspace/discovery-module.ts:79-154`                                                                    | Every member receives a managed module exporting its own `SERVICE_PORT` and sorted sibling-only `SERVICE_ENDPOINTS`.                                                          |
| Starter inheritance            | `packages/starters/microservice-starter/src/options.ts:16-39`, `packages/starters/full-stack-starter/src/options.ts:22-92` | Microservice options extend REST options and full-stack options extend microservice options, so a REST arm reaches both higher tiers.                                         |
| Starter plugin builders        | `packages/starters/rest-starter/src/app.ts:34-70`, `packages/starters/full-stack-starter/src/app.ts:29-69`                 | Builders are the single registration path; full-stack composes microservice plugins, so an inherited arm is read there without duplicate registration logic.                  |
| Error-handler contract         | `packages/starters/rest-starter/src/app.ts:87-96`                                                                          | Starter factories already register `errorHandler({ format: 'rfc9457' })` at outermost priority 0; CLI inline templates currently omit that argument.                          |
| Config file option             | `packages/config-plugin/src/options.ts:19-31`                                                                              | `ConfigPluginOptions.envFilePath` accepts one path or ordered paths; default is no file loading.                                                                              |
| Pre-construction configuration | `packages/starters/full-stack-starter/src/from-config.ts:104-159`                                                          | `createFullStackAppFromConfig` loads configuration before it constructs plugins, passes one snapshot to the builder, and forwards config options into the app's `config` arm. |
| Workspace ports                | `packages/cli/src/workspace/manifest.ts:31-58`, `packages/cli/src/workspace/manifest.ts:343-360`                           | Ports are validated as integer 1–65535 and allocation is one above the highest manifest port; no operating-system bind probe exists.                                          |
| Workspace app command          | `packages/cli/src/commands/app.ts:363-450`                                                                                 | `generate app` rejects duplicate manifest ports, writes all discovery modules and root artifacts atomically after planning, but does not probe a chosen port.                 |
| Root dev task                  | `packages/cli/src/workspace/root-files.ts:84-116`, `packages/cli/src/workspace/runtime-profile.ts:151-188`                 | Root `dev` directly launches every member start script; it has no member dependency metadata or readiness wait.                                                               |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                  | Resolution (picked side)                                                                                                                   | Doc deliverable (same PR)                                                                     |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| C1 | `PUBLIC_API.md` says workspace discovery is consumed by every applicable member, while `full-stack` has no `serviceDiscovery` arm and its factory host cannot accept a CLI plugin wiring. | Add the inherited starter arm and extend the factory-rendering seam so full-stack consumes `SERVICE_ENDPOINTS` through its options object. | Update the CLI workspace and template documentation, plus the starter option surface.         |
| C2 | `PUBLIC_API.md` describes generated workspace `dev` as starting every member at once, while M67 requires readiness-safe dependency startup.                                               | Replace that description with declared dependency ordering and readiness gating.                                                           | Update the CLI workspace section and generated root README text.                              |
| C3 | `PUBLIC_API.md` documents `errorHandler` as default-format unless configured, but opinionated starter scaffolds already choose RFC 9457.                                                  | Keep the public default unchanged and make all scaffolded REST-derived templates pass `{ format: 'rfc9457' }`.                             | Update template examples and default-format wording to distinguish direct use from scaffolds. |

## 3. Design decisions

### 3.1 Full-stack discovery through the starter

- **Decision:** Add `serviceDiscovery?: ServiceDiscoveryPluginOptions` to `RestStarterOptions`,
  register it only when supplied, and extend the internal app-factory render context so the
  workspace overlay can add
  `{ serviceDiscovery: { provider: 'static', services: SERVICE_ENDPOINTS } }` to the full-stack
  factory build object while retaining an empty `TemplateHost.plugins` list.
- **Why:** The option naturally inherits through the existing REST → microservice → full-stack
  chain, and the factory remains the one owner of full-stack composition.
- **Test home:** REST, microservice, and full-stack starter unit/integration tests; CLI workspace
  member-host and full-stack template tests; workspace mesh e2e.

### 3.2 Environment files and construction-time configuration

- **Decision:** REST-derived Deno, Node, and Bun scaffolds emit a gitignored `.env` and committed
  `.env.example`, configure `ConfigPlugin({ envFilePath })` from one template-owned path, and accept
  `--env-file <path>` on `new` and `generate app` to select that path. Full-stack forwards the same
  path through `createFullStackAppFromConfig(..., { config: { envFilePath } })`; minimal projects
  reject the flag because they register no config plugin. Cloudflare Workers do not emit or read a
  dotenv file and instead receive configuration through Worker bindings.
- **Why:** A plugin option is evaluated before `ConfigPlugin` exists, so environment configuration
  must be available as a file and be documented at the generated application boundary rather than
  through a nonexistent config lookup.
- **Test home:** CLI argument/new/app/template tests and scaffold e2e, including default, custom
  path, ignored `.env`, tracked example, full-stack factory and invalid minimal flag.

### 3.3 Problem Details scaffold default

- **Decision:** Render inline REST middleware as `errorHandler({ format: 'rfc9457' })` at its
  existing priority 0; the direct exception package default remains unchanged.
- **Why:** This aligns all REST-derived scaffold paths with the starter factories and gives
  generated APIs the published Problem Details format.
- **Test home:** REST and microservice template unit tests plus a generated-project request
  assertion for exact RFC 9457 fields and absence of `message`.

### 3.4 Port availability and reassignment

- **Decision:** Introduce an injected internal port-probe seam used by workspace creation, member
  allocation, explicit member ports, and a new `setu workspace ports --reallocate` command. The
  command deterministically assigns the first currently bindable ports at or above `basePort` in
  manifest member order, rewrites the manifest and every managed discovery/deployment artifact only
  after every assignment is known, and refuses without writes when the required contiguous
  allocation is unavailable.
- **Why:** A manifest-only collision check cannot detect another process. Reassignment must preserve
  the single port datum shared by entry points, discovery modules, Compose, and Kubernetes instead
  of asking a developer to edit each.
- **Test home:** Port-probe planner tests, workspace manifest/app-command/new-command tests,
  command-dispatch tests, and workspace e2e with a deliberately occupied port and a before/after
  service-resolution exercise.

### 3.5 Dependency-aware workspace development

- **Decision:** Add an optional, validated `dependsOn` member list configured by repeated
  `--depends-on <member>` flags at `generate app` time. Render runtime-specific root development
  runners: each topologically starts members, waits for each dependency's `/ready` endpoint before
  starting its dependents, reports a dependency cycle or readiness failure by name, and terminates
  started children on failure or shutdown.
- **Why:** The workspace has no way to infer a service's startup dependency from its discovery map;
  making it explicit avoids both races and an unworkable "wait for every sibling" deadlock.
- **Test home:** workspace manifest and app command tests for validation, runner renderer tests for
  Deno/npm/Bun command shapes, and a real workspace e2e proving a dependent does not begin until its
  prerequisite answers `/ready`.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                       | Kind         | Consumer / real code path that READS it                                                                                          |
| ------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `RestStarterOptions.serviceDiscovery` | option field | `buildRestPlugins()` conditionally calls `ServiceDiscoveryPlugin`; higher-tier builders inherit it.                              |
| `setu workspace ports --reallocate`   | CLI command  | Workspace maintainers repair occupied or stale local port assignments; the command rewrites generated maps and deployment files. |
| `--env-file`                          | CLI option   | Template renderer reads it to emit `.env` files and `ConfigPlugin`/factory config.                                               |
| `--depends-on`                        | CLI option   | `generate app` stores it in the workspace member record; the generated dev runner topologically reads it.                        |

### 4.1 Options — every option names its consumer

| Option                                | Consumer                                   | Behavior (per implementation)                                                                     |
| ------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `RestStarterOptions.serviceDiscovery` | `buildRestPlugins`                         | Supplied → registers one `ServiceDiscoveryPlugin`; omitted → preserves prior starter plugin list. |
| `--env-file`                          | CLI template host/project renderer         | Selects one emitted dotenv path and config loader path; rejected by hosts without file access.    |
| `--depends-on`                        | workspace manifest and dev-runner renderer | Stores unique existing sibling names; runner waits for each before starting the member.           |

## 5. Implementation files

| File                                                                                                    | Purpose                                                                                                 |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `packages/starters/rest-starter/src/options.ts`                                                         | Add the typed service-discovery starter arm.                                                            |
| `packages/starters/rest-starter/src/app.ts`                                                             | Conditionally register the discovery plugin through the REST builder.                                   |
| `packages/starters/*/README.md`                                                                         | Document inherited service-discovery composition and configuration ordering.                            |
| `packages/cli/src/constants.ts`                                                                         | Declare new value flags and workspace command constants.                                                |
| `packages/cli/src/cli.ts`                                                                               | Dispatch the workspace maintenance command and pass the port probe.                                     |
| `packages/cli/src/main.ts`                                                                              | Provide the real Deno bind-and-close port probe at the process boundary.                                |
| `packages/cli/src/templates/registry.ts`                                                                | Add the internal factory-rendering context needed by workspace overlays.                                |
| `packages/cli/src/templates/project-files.ts`                                                           | Render environment config, app-factory additions, and template files consistently.                      |
| `packages/cli/src/templates/{rest,microservice,full-stack,minimal}.ts`                                  | Declare Problem Details, dotenv, and full-stack configuration defaults.                                 |
| `packages/cli/src/commands/{new,app,workspace}.ts`                                                      | Validate flags, probe ports, persist dependencies, and implement reassignment.                          |
| `packages/cli/src/workspace/{manifest,member-host,root-files,runtime-profile,port-probe,dev-runner}.ts` | Persist dependencies, wire full-stack discovery, render dev runners, and plan bindable port allocation. |
| `packages/cli/src/workspace/{discovery-module,compose,k8s}.ts`                                          | Consume reassigned manifest ports without divergent render paths.                                       |
| `packages/cli/src/templates/project-files.ts`                                                           | Emit `.env`, `.env.example`, `.gitignore`, and config paths from one template setting.                  |
| `PUBLIC_API.md`, `ARCHITECTURE.md`, `ROADMAP.md`, `CLAUDE.md`                                           | Correct CLI/starter docs and milestone tracking when complete.                                          |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                              | src covered                                   | Key assertions (and the signature each call type-checks against)                                                                          |
| -------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/starters/rest-starter/test/unit/app.test.ts`                                 | `rest-starter/src/app.ts`                     | The discovery arm adds exactly one provider and omission keeps the list unchanged.                                                        |
| `packages/starters/{microservice,full-stack}-starter/test/unit/app.test.ts`            | inherited starter builder paths               | Inherited discovery option reaches the composed REST builder once.                                                                        |
| `packages/cli/test/unit/templates.test.ts`                                             | CLI template declarations                     | Inline error handler passes `format: 'rfc9457'`; dotenv settings are declared only by config hosts.                                       |
| `packages/cli/test/unit/full-stack-template.test.ts`                                   | `templates/full-stack.ts`, factory rendering  | Workspace context produces a typed full-stack `serviceDiscovery` option while standalone output is unchanged.                             |
| `packages/cli/test/unit/new-command.test.ts`                                           | `commands/new.ts`, project template files     | Default/custom `--env-file`, minimal refusal, and occupied base-port refusal.                                                             |
| `packages/cli/test/unit/app-command.test.ts`                                           | `commands/app.ts`, `workspace/member-host.ts` | Full-stack map wiring, duplicate/missing dependency refusal, explicit and allocated port probe behavior.                                  |
| `packages/cli/test/unit/workspace/{manifest,port-probe,dev-runner,root-files}.test.ts` | workspace manifest/planners/renderers         | Dependency validation/topological order/cycles, deterministic reallocation, no-write probe failure, and runtime-specific runner commands. |
| `packages/cli/test/unit/cli.test.ts`                                                   | `cli.ts`, `constants.ts`                      | New workspace command and value flags dispatch with correct exit codes.                                                                   |
| `packages/cli/test/e2e/workspace-e2e.test.ts`                                          | generated workspace artifacts                 | Reallocation updates member bind ports, discovery maps, Compose and Kubernetes output together.                                           |
| `packages/cli/test/e2e/workspace-mesh-e2e.test.ts`                                     | full-stack discovery + dev runner             | Generated full-stack member resolves a sibling and a dependent starts only after `/ready`.                                                |
| `packages/cli/test/e2e/scaffold-runs-e2e.test.ts`                                      | generated template behavior                   | `.env.example`/gitignore/config loading and Problem Details body work in real scaffolded projects.                                        |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m67-scaffold-defaults-workspace-ergonomics, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; >=90% branch/function/line every src file
```

## 8. Risks & mitigations

- A port can be claimed after a probe releases it → probe immediately before writing, report the
  race honestly at process bind time, and never claim the probe is a reservation.
- A factory string can type-check while silently dropping a workspace option → boot a generated
  full-stack member and resolve a sibling through `CAPABILITIES.SERVICE_DISCOVERY`.
- A readiness runner can leak children on failure → keep one explicit child registry, shut down all
  started children, and exercise the failure path in a subprocess test.
- Existing workspace manifests lack dependency metadata → make `dependsOn` optional with an empty
  default so existing workspaces retain their current concurrent topology until they opt in.

## 9. Out of scope

- Automatically discovering startup dependencies from runtime traffic; the CLI has no truthful
  source for that graph.
- Reserving a TCP port across process startup; OS probing can only establish current availability.
- Secret generation or committing real secrets; the CLI supplies blank `.env` values and explanatory
  `.env.example` placeholders.
