# Milestone 138 — Workspace transports (`@setu-ts/cli`)

> **Status:** Complete (PR #568). Branch: `feat/m138-workspace-transports`. `develop` and `main` are
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR.

## 0. Objective & scope

A Setu workspace records ONE `transport` in `setu.workspace.json`, and that one value mixes two
different choices. `http` and `grpc` are how a service is CALLED. `memory`, `redis`, `rabbitmq`,
`nats`, `kafka`, `pubsub` and `service-bus` are the BUS that members publish to. Because both share
one field, a gRPC workspace cannot have a broker: `--transport grpc` leaves every microservice
member on `MessagingPlugin()`, which is in-memory and process-local (measured on a scaffold made by
the published `0.11.0` CLI, 2026-11-06). The choice also cannot be changed later. No command rewires
an existing workspace, and `generate app` refuses `--broker`/`--queue` on a member and says to
scaffold that service outside the workspace instead (`app.ts:412-447`). This milestone splits the
field in two. The **broker** stays a workspace-wide choice, because members can only meet on a bus
they share. The **RPC style** (`http` or `grpc`) is chosen per member. Two commands change each one
later, by regenerating a CLI-owned module that each member's `setu.config.ts` reads. The pattern is
the same one the discovery map already uses for ports.

**Compared with** (current docs, checked 2026-11-06):

| Framework           | How the sync style is chosen                                               | How the bus is chosen                                                         | How it is changed later                           |
| ------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------- |
| Dapr                | `dapr.io/app-protocol` per app (`http` default, `grpc`, …)                 | a named pub/sub component the apps share                                      | edit the component YAML; app code does not change |
| NestJS              | per service; a hybrid app calls `connectMicroservice()` once per transport | per client (`ClientsModule`)                                                  | edit the module config in code                    |
| Moleculer           | — (one bus only)                                                           | ONE `transporter` per broker; nodes meet only on a shared bus                 | one config value                                  |
| MassTransit         | —                                                                          | the transport is set in bus config; one bus is recommended, MultiBus for more | bus configuration                                 |
| Spring Cloud Stream | —                                                                          | a binder per binding, with `defaultBinder`                                    | properties, with no code change                   |
| Quarkus SmallRye    | —                                                                          | `mp.messaging.*.<channel>.connector`, one per channel                         | properties, with no code change                   |

Two results came out of this. (1) The sync style is chosen per service everywhere it can be chosen
(Dapr, NestJS), and the bus is shared wherever services must meet on it (Moleculer, Dapr's shared
component, MassTransit's single-bus advice). So the split here is per-member RPC and a
workspace-wide broker. (2) Every framework that can change its transport does it by changing
**configuration that the code reads**, never by rewriting code. Setu renders the wiring as source in
a user-owned `setu.config.ts`, so the equivalent here is a CLI-owned module the config imports
(§3.3). Spring's and Quarkus's per-binding binders, and MassTransit's MultiBus, give one service
more than one bus. That is out of scope (§9).

- **In scope:** the manifest split (`broker` at the workspace level, `rpc` per member, version 2,
  and a read of version 1); `setu new --workspace --broker` and `generate app --rpc`; the CLI-owned
  `src/transport/index.ts` in every member; `setu workspace broker <name>` and
  `setu workspace rpc <member> <http|grpc>`; routing `setu add messaging|queue|grpc` and `setu sync`
  in a member through the same planner; regenerated Compose, Kubernetes and root-README transport
  section; refusals for wiring that the switch would orphan; docs, CHANGELOG and upgrade notes; unit
  and CLI e2e coverage.
- **NOT this milestone:** more than one broker per workspace or per member (§9); changing a
  STANDALONE project's broker (it already has `setu add messaging --broker`); moving the Redis-only
  arms (cache, idempotency, scheduler lock, backplane) into the module (§3.8); a `setu check`
  finding for a member that stopped reading the module (§9).

## 1. Contracts verified from SOURCE (not names)

| Reference                                      | Source (file:line)                                                                                                                                                        | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TRANSPORTS`, `TRANSPORT_SPECS`                | `packages/cli/src/workspace/transport.ts:45-55`, `:314-645`                                                                                                               | One list of nine names. `http` has no plugins. `grpc` adds `GrpcPlugin({ basePath: '/grpc' })`, the clients `@connectrpc/connect` and `@bufbuild/protobuf`, the proto toolchain files, tasks, scripts and devDependencies, and NO `messagingArgs`. `memory` is the arm-less default (no `messagingArgs`, no `queueArgs`, `:343-347`). Six arms add `messagingArgs` (redis, rabbitmq, nats, kafka, pubsub, service-bus); `queueArgs` exists on redis and rabbitmq only (`:355`, `:392`).                                              |
| `listBrokers()` / `listQueues()`               | `transport.ts:779-798`                                                                                                                                                    | Already derives the broker set (`memory` + every arm with `messagingArgs`), and the queue subset. `setu new --broker` uses these.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `transportSpec(name, redisClient)`             | `transport.ts:732-754`                                                                                                                                                    | Swaps the redis arms to node-redis client calls. `workspace.ts:134`, `devtool.ts:683` and `workspace-ops.ts:469` call it WITHOUT `redisClient`. Compose and k8s read only `compose`/`memberEnv`, which do not depend on the client, so this is harmless today. The new planner passes the client throughout.                                                                                                                                                                                                                         |
| `WorkspaceManifest.transport`, `transportUrl`  | `packages/cli/src/workspace/manifest.ts:199-207`                                                                                                                          | `transport: TransportName` is required in memory and defaults to `http` when absent on disk (`:402-406`). An unknown value is refused with `unknown-transport`.                                                                                                                                                                                                                                                                                                                                                                      |
| `WORKSPACE_VERSION`                            | `manifest.ts:36`, `:369-371`                                                                                                                                              | `1`. Any other number is refused as `unsupported-version`, so an older CLI refuses a version-2 file instead of misreading it. The reader returns the PARSED `version` (`:494`) and `renderWorkspaceManifest` spreads it back (`:511-521`); four writers re-serialize a read manifest (`app.ts:354`, `workspace.ts:152`, `devtool.ts:704`, `adopt.ts:320`).                                                                                                                                                                           |
| `withWorkspaceMember` / `withTransport`        | `packages/cli/src/workspace/member-host.ts:39-47`, `:103-157`                                                                                                             | Rewrites the template's `MessagingPlugin`/`QueuePlugin` args into literals through `withBrokerArgs`/`withQueueArgs` (`templates/broker.ts`). Appends `transport.plugins`. Sets `grpcBasePath` only for an app-factory (full-stack) host.                                                                                                                                                                                                                                                                                             |
| `MessagingPluginOptions`, memory arm           | `packages/messaging-plugin/src/interfaces/index.ts:413-415`, `:792-798`; exported from `src/index.ts:144`                                                                 | `MemoryMessagingOptions.broker?: 'memory'`, so `{}` is a valid memory configuration. Union of every broker arm.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `QueuePluginOptions`                           | `packages/queue-plugin/src/index.ts:22`                                                                                                                                   | Exported type, usable on plugin-list hosts only: a full-stack member declares neither `@setu-ts/messaging-plugin` nor `@setu-ts/queue-plugin` (`templates/full-stack.ts:297-312`), so its module types through `NonNullable<FullStackStarterOptions['messaging']>` / `['queue']` (`full-stack-starter` is declared). The full-stack callback's `config` is `IConfig` (`starters/full-stack-starter/src/from-config.ts:8`).                                                                                                           |
| `GrpcPluginOptions.basePath`                   | `packages/grpc-plugin/src/interfaces/index.ts:14-26`                                                                                                                      | Optional `basePath`. The scaffold passes `'/grpc'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Microservice/full-stack starters own messaging | `packages/starters/microservice-starter/src/app.ts:29-30`                                                                                                                 | `MessagingPlugin(options.messaging)` and `QueuePlugin(options.queue)` are always registered, so `messaging: messagingOptions(config)` returning `{}` keeps the memory default. In a workspace only the full-stack template reaches this path; the microservice TEMPLATE is a plugin list.                                                                                                                                                                                                                                            |
| CSRF `exclude`                                 | `packages/session-plugin/src/csrf/exclude.ts:32-33`                                                                                                                       | `for (const entry of exclude ?? [])`, so `exclude: []` behaves exactly as an absent `exclude`.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Full-stack gRPC CSRF exclusion                 | `packages/cli/src/templates/full-stack.ts:90-94`                                                                                                                          | Renders `new RegExp('^/grpc(?:/                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | $)')` inline, and only with no regex literal and no backslash, so the config stays inside the language the CLI's classifier reads.                                                                                                                                                                                                                                                           |
| `setu add` never rewrites an existing call     | `packages/cli/src/commands/add.ts:549-560`, `:603-608`                                                                                                                    | When the plugin is already called, `add` prints `Set X(args) …; the existing call was preserved` and does not edit. This milestone keeps that rule for user-owned source.                                                                                                                                                                                                                                                                                                                                                            |
| `workspaceAddArgs`                             | `add.ts:1378-1390`                                                                                                                                                        | In a member, `setu add messaging`/`queue`/Redis arms render a LITERAL from the workspace transport. This milestone changes the messaging and queue arms to call the module (§3.6).                                                                                                                                                                                                                                                                                                                                                   |
| `setu add grpc` registration                   | `add.ts:180`, `:383`                                                                                                                                                      | Adds the dependency and prints `GrpcPlugin({ services: [] })`. There is no toolchain, no clients, and no wiring.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Classifier helpers                             | `packages/cli/src/devtool/sources.ts:123` (`maskComments`), `:653` (`factoryScope`), `:816` (`referencesIdentifier`); `src/utils/starter-arms.ts:86` (`composingStarter`) | Exported, and shared by `add` and `devtool`. `factoryScope` recognizes only a SYNCHRONOUS `export function createApp(` (`sources.ts:653-698`); the full-stack config is `export async function createApp(` (`templates/project-files.ts:510`), so it is unclassified there. `maskSourceCode`/`maskComments` return `undefined` on a template literal, backslash, regex or division (`sources.ts:96-110`). `calledOutsideImports` (`src/diagnostics/wiring.ts:16-19`) masks, strips imports and tests for a call, on both host kinds. |
| Managed files regenerated per change           | `packages/cli/src/commands/app.ts:338-362`; `workspace.ts:132-152`                                                                                                        | `generate app` and `ports --reallocate` regenerate the discovery modules, manifest, Compose and k8s for the whole workspace as `managed: true`.                                                                                                                                                                                                                                                                                                                                                                                      |
| Root README transport section                  | `packages/cli/src/workspace/root-files.ts:174-200`                                                                                                                        | Written once by `setu new --workspace`, with no marker and not managed, so a transport change would leave it stale.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `readTransport` / `tcp` alias                  | `packages/cli/src/commands/new.ts:288-367`; `transport.ts:808`                                                                                                            | Validates `--transport`/`--transport-url`, refuses `tcp` by name, and refuses a URL on `pubsub`/`service-bus` with the variable named.                                                                                                                                                                                                                                                                                                                                                                                               |
| Interactive workspace question                 | `packages/cli/src/commands/new-interactive.ts:117`                                                                                                                        | Asks `transport` on a workspace.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `setu sync`                                    | `packages/cli/src/commands/sync.ts:1-80`; `commands/check.ts:71-74`                                                                                                       | Rewrites only CLI-managed barrels, transactionally, per project or workspace. `forEachProject`'s callback receives only `dir`, and run inside a member it takes the project branch with no workspace knowledge. It writes nothing when E012 (`config-unreadable`) fires.                                                                                                                                                                                                                                                             |
| Devtool auto-wiring regex                      | `packages/cli/src/devtool/sources.ts:1319-1325` (`wireSources`), rows `:44-90`, `withSourceArgs` `:1220-1228`                                                             | Auto-wires only a ONE-LINE call matching `^[ \t]_Sym\((\{[^()]_?\}                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | )\),[ \t]*$`; anything else becomes manual guidance. Of the transport plugins only `QueuePlugin` is a source row (`:79`); `MessagingPlugin`is not. Today the memory-broker`QueuePlugin({ processors: [...QUEUE_PROCESSORS] })`matches; the redis/rabbitmq rendering is multi-line and already falls to guidance.`withSourceArgs`wraps any argument text as`{ ...<args>, ...sources.<key> }`. |
| Starter arm editing                            | `packages/cli/src/commands/starter-options.ts:191-212` (`literalEntries`), `:239-256` (`withStarterArmEntry`)                                                             | `literalEntries` returns `undefined` on any entry that is not `key: value`. `withStarterArmEntry` calls it on the returned object AND on the arm's inner object, so it fails closed on `queue: { ...queueOptions(config) }`.                                                                                                                                                                                                                                                                                                         |
| node-redis helper                              | `packages/cli/src/templates/node-redis.ts:22-34`; `templates/broker.ts:51-63`                                                                                             | The node-redis client call imports `nodeRedisClient` from the CLI-written `src/node-redis.ts`; the helper defers the connection itself (`node-redis.ts:98-103`).                                                                                                                                                                                                                                                                                                                                                                     |
| Env-read indentation                           | `packages/cli/src/workspace/runtime-profile.ts:126`, `:141`; `transport.ts:310`                                                                                           | `envRead` bakes a fixed 10-space continuation for a plugin option at depth 8; `nestConnection` re-indents one level.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Manifest merge on disk                         | `packages/cli/src/commands/add.ts:747` (`withDependency`), `:1470`, `:1814-1858`                                                                                          | `withDependency` is `JSON.parse`-only and refuses JSONC; in an npm/Bun workspace `add` also records optional peers in the root (M119f). `withClientDependencies` works on a `ResolvedHost` at scaffold time only.                                                                                                                                                                                                                                                                                                                    |
| Generated lint unused-arg rule                 | `packages/cli/src/templates/npm-tooling.ts:83`                                                                                                                            | `argsIgnorePattern: '^_'`; an unused parameter must be `_`-prefixed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Proto output dir                               | `packages/cli/src/workspace/proto-toolchain.ts:37`                                                                                                                        | `PROTO_OUT_DIR` = `src/gen`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Ownership precedent                            | `manifest.ts:6-9`; `discovery-module.ts`                                                                                                                                  | The discovery module is CLI-owned and derived from the manifest, and the user's config imports it. §3.3 follows this exactly.                                                                                                                                                                                                                                                                                                                                                                                                        |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                                                                                                                                                                    | Resolution (picked side)                           | Doc deliverable (same PR)                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `transport.ts:12-15` and `manifest.ts:192-198` say a per-member transport "would make a workspace whose services silently cannot reach each other". That is true of a BUS and false of an RPC style: an `http` member and a `grpc` member still reach each other over HTTP through the discovery map, because a grpc member co-serves HTTP. | Kept for the broker and dropped for the RPC style. | Rewrite both module docs. `docs/cli.md` at every mention (`:111-112`, `:257`, `:303`, `:314`, `:343`, `:727`, `:737`, `:757-759`, `:810`, `:913`), `docs/deployment.md:505`, `:760`, `ARCHITECTURE.md`, `PUBLIC_API.md`, `docs/plugins.md`, `docs/messaging-emulators.md` and the full-stack starter README wherever they say `--transport`. |
| C2  | `docs/cli.md:757-759` lists seven transports and omits `pubsub`/`service-bus`, which `TRANSPORTS` accepts.                                                                                                                                                                                                                                  | The source is right.                               | The rewritten paragraph lists the brokers from `listBrokers()` order.                                                                                                                                                                                                                                                                        |

## 3. Design decisions

### 3.1 Manifest shape: `broker` at the workspace, `rpc` per member, version 2

- **Decision:** `WorkspaceManifest` drops `transport`/`transportUrl` and gains `broker: BrokerName`
  (default `memory`) and `brokerUrl?: string`. `redisClient` stays. `WorkspaceMember` gains
  `rpc?: 'grpc'`, where absent means `http`, the convention `redisClient` already uses. A
  hand-written `rpc: 'http'` is accepted and normalized to absent; any other value is refused as
  `malformed`. `WORKSPACE_VERSION` becomes `2`.

  `readWorkspaceManifest` accepts version 1 and maps it as follows:

  | Version-1 input                                        | Version-2 result                                               |
  | ------------------------------------------------------ | -------------------------------------------------------------- |
  | `transport` names a broker                             | `broker` is that name; `transportUrl` becomes `brokerUrl`      |
  | `transport: 'grpc'`                                    | `broker: 'memory'`; `rpc: 'grpc'` on every member              |
  | `transport: 'http'` or absent                          | `broker: 'memory'`                                             |
  | `transportUrl` with `http`/`grpc`/absent (hand-edited) | refused as `malformed`: a URL with no broker addresses nothing |
  | an unknown `transport`                                 | refused as `unknown-broker`, naming the value                  |

  The result of that mapping carries `version: WORKSPACE_VERSION`, not the parsed number, so all
  four writers that re-serialize a read manifest (`app.ts:354`, `workspace.ts:152`,
  `devtool.ts:704`, `adopt.ts:320`) write version 2. A version-2 file that still carries `transport`
  or `transportUrl` is refused as `malformed`, so it cannot be half-migrated.

- **Why:** an older CLI given a version-2 file must refuse it (`manifest.ts:369-371`) and not read
  `transport` as absent and silently fall back to `http`. That cannot happen while the version stays
  1. Returning the parsed version would write `version: 1` carrying `broker`, and the next read
     would take the version-1 path, find no `transport`, and map to `memory`: the same silent
     fallback. The version-1 read covers workspaces made by `0.11.0`, which is the shipped CLI.
     Nothing older is supported (there are no existing users).
- **Test home:** `test/unit/workspace/manifest.test.ts`: every row of the table above; version 2
  round-trips; version 3 and `rpc: 'rest'` are refused; `rpc: 'http'` normalizes to absent. Plus a
  version-1 file rewritten through `ports --reallocate` (`test/unit/workspace-command.test.ts`) and
  through `devtool enable` (`test/unit/devtool-planner.test.ts`) reads back as version 2 with the
  same broker. The root-level `test/unit/workspace-manifest.test.ts` is updated to match.

### 3.2 Two registries: brokers and RPC styles

- **Decision:** `transport.ts` keeps only the seven broker names: `BROKERS`, `BrokerName`,
  `DEFAULT_BROKER = 'memory'`, `getBroker(raw, redisClient)` (an untrusted string) and
  `brokerSpec(name, redisClient)` (total). Together these replace `TRANSPORTS`, `TransportName`,
  `DEFAULT_TRANSPORT`, `getTransport`, `transportSpec` and `listTransports`, and every caller moves
  (§5). The broker spec is renamed `BrokerSpec`, with the fields no broker sets removed: `plugins`,
  `clients`, `memberFiles`, `memberTasks`, `memberImports`, `memberScripts` and
  `memberDevDependencies`. `listBrokers()`/`listQueues()` keep their behaviour.

  `http` and `grpc` move to a new `src/workspace/rpc.ts`: `RPC_STYLES = ['http', 'grpc']`,
  `RpcStyle`, `getRpc(raw)`, `rpcSpec(name)` and `RPC_ALIASES = { tcp: 'http' }`. `RpcSpec` carries
  `plugin` (the `GrpcPlugin` wiring, whose `pkg` is the `@setu-ts/grpc-plugin` dependency),
  `clients`, `memberFiles`, `memberTasks`, `memberImports`, `memberScripts` and
  `memberDevDependencies`, exactly as `transport.ts:320-342` holds them today.

- **Why:** one registry per axis, so neither can name a value from the other, and no dead fields are
  left behind. Moving the grpc values unchanged keeps the generated proto files byte-identical (the
  M63 format bar).
- **Test home:** `test/unit/workspace/transport.test.ts` (the broker registry; existing arm cases
  kept); new `test/unit/workspace/rpc.test.ts` (the grpc spec equals today's values; the `tcp`
  alias).

### 3.3 The CLI-owned transport module, `src/transport/index.ts`

- **Decision:** every workspace member gets a `managed: true` `src/transport/index.ts`, rendered by
  `renderTransportModule(input)` in a new `src/workspace/transport-module.ts`. Its input is:
  - the broker spec, `brokerUrl` and redis client;
  - the member's `rpc` and runtime profile;
  - the host kind: `app-factory` when the member's manifest declares `full-stack-starter`, otherwise
    `plugin-list`;
  - for plugin-list hosts only, whether `messaging-plugin` and `queue-plugin` are installed
    (`detectPlugins`). An app-factory host always gets both, because the starter always registers
    them (`microservice-starter/src/app.ts:29-30`).

  It exports only what applies to the member:
  - `messagingOptions()` and `queueOptions()`. They are functions rather than constants, so no
    environment read or client construction happens when the module is imported (`setu commands`
    imports the config).
    - On a plugin-list host they take no argument, read `profile.envRead(...)` as today, and are
      typed with `MessagingPluginOptions` / `QueuePluginOptions`.
    - On an app-factory host they take `config: IConfig`, read `renderConfigConnection(...)`, and
      are typed `NonNullable<FullStackStarterOptions['messaging']>` and
      `NonNullable<FullStackStarterOptions['queue']>` respectively (both inherited from
      `MicroserviceStarterOptions`, `microservice-starter/src/options.ts:16-28`). Where the body
      does not use the parameter (the memory broker, or a queue on a broker with no queue arm), it
      is rendered `_config`, so the generated ESLint (`argsIgnorePattern: '^_'`) and `deno lint`
      accept it. The call site stays `messagingOptions(config)` whatever the broker.
    - Memory, and a queue with no arm for the broker, return `{}`.
  - `transportPlugins(): readonly IPlugin[]` returns `[GrpcPlugin({ basePath: '/grpc' })]` for a
    grpc member, otherwise `[]`. It imports `@setu-ts/grpc-plugin` only in the grpc case.
  - `csrfExclusions(): readonly RegExp[]`, on app-factory hosts only, returns
    `[new RegExp('^/grpc(?:/|$)')]` or `[]`.
  - Imports: the node-redis arm imports `nodeRedisClient` from `../node-redis.ts`.

  Formatting follows the profile: every multi-line expression in a function body is re-indented from
  the depth it sits at, using the `nestConnection` technique (`transport.ts:310`) rather than
  `envRead`'s fixed depth-8 continuation. On npm targets the output then goes through
  `formatForTarget`, as other generated files do. Deno members get no formatter, so the rendering
  itself must already pass `deno fmt --check`.

  The rendered `setu.config.ts` calls the module:
  - Plugin-list host: `MessagingPlugin(messagingOptions())`,
    `QueuePlugin({ processors: [...QUEUE_PROCESSORS], ...queueOptions() })` (the existing jobs seam
    is kept), and `...transportPlugins()` just before `...GENERATED_PLUGINS`.
  - Full-stack host: `messaging: messagingOptions(config)`, `queue: { ...queueOptions(config) }`
    (with `processors` merged by the existing seam path when present),
    `session: { …, csrf: { exclude: [...csrfExclusions()] } }`, and
    `for (const plugin of transportPlugins()) app.register(plugin);` after the starter returns.

  Standalone projects keep their literal wiring and do not change.

- **Why:** this is the comparison's second result. Every framework that changes its transport does
  it through configuration the code reads. The discovery module already does that for ports, and it
  makes a change total: regenerate one file per member and touch no user-owned source. Taking the
  types from the starter, and giving an app-factory host both functions every time, means the module
  only imports packages the member actually declares.
- **Rejected:** rewriting the literal arguments inside `setu.config.ts` when they still match the
  old rendering. That would add a source-rewrite path that `add` deliberately does not have
  (`add.ts:549-560`). It would also have to recognise both runtimes' formatting, and it would fail
  closed on any edit, so a change would only half-work.
- **Test home:** new `test/unit/workspace/transport-module.test.ts` covers every broker × host kind
  × rpc × plugin presence; the node-redis import; `_config` on the arms that do not use the
  parameter; and the `{}` memory case. `test/unit/workspace/member-host.test.ts` and
  `test/unit/full-stack-template.test.ts` assert the config calls. The e2e (§6) shows module and
  config format, lint, type-check and boot on both runtimes.

### 3.4 The two classifiers learn one spread form

- **Decision:** with §3.3, a call sits inside the `QueuePlugin` argument and inside the full-stack
  `queue` arm, and the CLI's own classifiers would refuse both shapes. Each is widened by exactly
  one form:
  - **`wireSources`** (`devtool/sources.ts:1319-1325`) also matches a one-line call whose object
    literal contains exactly one keyless `...<identifier>()` spread of a zero-argument call. For
    example `QueuePlugin({ processors: [...QUEUE_PROCESSORS], ...queueOptions() }),`. The
    replacement path does not change: `withSourceArgs` already wraps any argument text. A member's
    `QueuePlugin` then auto-wires on EVERY broker. Today it does so only on brokers with no queue
    arm, because the redis/rabbitmq literal is multi-line.
  - **`withStarterArmEntry`** (`commands/starter-options.ts:239-256`) accepts one keyless
    `...<identifier>(<identifier>)` spread as the only non-`key: value` entry of the ARM's inner
    object, and inserts the new property after it. `literalEntries` itself does not change, so the
    top-level returned object is classified exactly as today.

  Two spreads, a spread whose call has any other arguments, a spread at the top level of the
  returned object, and a multi-line call all still fail closed.

- **Why:** without this, the module would quietly turn two working auto-edits into manual guidance
  on every workspace member.
- **Test home:** `test/unit/devtool-sources.test.ts` and
  `test/unit/commands/starter-options.test.ts` test the new form, its refused neighbours (two
  spreads, a call with another argument), and that existing cases do not change.

### 3.5 Flags at creation

- **Decision:**
  - `setu new --workspace` takes `--broker <name>` (from `listBrokers()`) and `--broker-url <url>`.
    `--broker-url` keeps the old `--transport-url` rules: it is refused on `pubsub` and
    `service-bus`, naming the variable, and is now also refused on `memory`. `--redis-client` stays.
  - `--transport` and `--transport-url` are refused with a message naming `--broker` and
    `generate app --rpc grpc`. The `tcp` refusal moves to `--rpc`.
  - The current workspace refusal of `--broker` (`new.ts:247-256`) is inverted. `--queue` on a
    workspace is still refused, because the queue follows the broker (the X2-3 rationale at
    `transport.ts:175-179`).
  - Standalone `setu new` refuses `--broker-url` and `--rpc`, naming `--workspace`.
  - `generate app` takes `--rpc http|grpc`, which is recorded on the member. `--broker`,
    `--broker-url`, `--queue` and `--redis-client` on `generate app` stay refused, but the message
    now names `setu workspace broker`.
  - The interactive workspace question asks for the broker.
  - `VALUE_FLAGS` (`constants.ts:84-85`) and the flag specs (`flags.ts:151-152`, `:208`) gain
    `broker-url` and `rpc`. The `--example` refusal list (`examples/new.ts:65-66`), help text
    (`cli.ts:129`) and the add texts naming `--transport` (`add.ts:1623`, `:1682`, `:2470`) are
    updated.
  - `readArmFlag` in `templates/broker.ts:458-496` reads `getBroker`. Standalone `--broker grpc` is
    then refused as "not a broker", naming `--rpc` for a workspace member.
- **Why:** `--broker` is the name a standalone project already uses for the same choice
  (`new --broker`), and `--rpc` mirrors Dapr's per-app protocol. The old flag is refused rather than
  kept as an alias: an alias that accepts `grpc` would have to mean "every member", which brings
  back the conflation. No released project depends on it.
- **Test home:** `test/unit/new-command.test.ts`, `new-interactive.test.ts`, `flags.test.ts`,
  `broker-flags.test.ts`, `help.test.ts`, `examples.test.ts`, `app-command.test.ts`.

### 3.6 `setu workspace broker <name>` and `setu workspace rpc <member> <style>`

- **Decision:** two new operations in `commands/workspace.ts`. Both are planned by one function,
  `planTransportChange(workspace, change, options)`, in a new `src/workspace/rewire.ts`. Both take
  `--dir`, `--dry-run` and `--force` (a new flag spec); `broker` also takes `--broker-url` and
  `--redis-client`. `--redis-client` is refused unless the target broker is `redis`, and
  `redisClient` is dropped from the manifest when the workspace leaves redis.

  The plan for each affected member puts every file in one of four ownership classes:

  1. **CLI-owned, always rewritten:**
     - `src/transport/index.ts`;
     - the manifest and the discovery modules (whose content does not change);
     - `docker/compose.yaml` with the new broker's backing files;
     - `k8s/members.yaml` and `k8s/README.md`;
     - the root README's transport section, between `<!-- setu:transport -->` and
       `<!-- /setu:transport -->` markers that `setu new --workspace` now writes. A README without
       the markers is left alone, and the new section is printed instead.
  2. **Merged, never removed — the member manifest.** The new arm's packages are merged into the
     member's `package.json` or `deno.json`:
     - the broker's `messagingClients`/`queueClients`;
     - for grpc, `@setu-ts/grpc-plugin` (the wiring's `pkg`), its `clients`, and the proto
       scripts/tasks/imports/devDependencies;
     - for node-redis, `redis`.

     Specifiers and ranges are the ones the scaffold already writes for that runtime
     (`CLIENT_RANGES` in `templates/client-dependencies.ts`; `deno.json` `imports`/`tasks` on a Deno
     member, `package.json` `dependencies`/`scripts`/`devDependencies` on npm). The merge is a
     plain-JSON merge in `rewire.ts` that adds an entry only when the package is declared in no
     section (checklist rows 6 and 7), strips a BOM (row 11), and never removes one. The entries go
     in the member only, exactly as `generate app` declares them; root peer recording stays
     `setu add`'s (M119f). _Implementation note (2026-11-06):_ the plan first named `add.ts`'s
     `withDependency` and root-peer path; importing `commands/add.ts` from `workspace/` would have
     made an import cycle, and matching `generate app` keeps the switch and the creation path on one
     rule. A JSONC manifest refuses the whole change before anything is written, naming the lines to
     add (all-or-nothing). Packages no longer needed are listed in the output, not deleted. The plan
     runs the M119f 16-shape manifest checklist (project memory `cli-manifest-write-checklist`)
     before implementation.

  3. **Create-only:** the proto toolchain files (`buf.yaml`, `buf.gen.yaml`, `proto/…`) and
     `src/node-redis.ts`. An existing file is kept. Files of the PREVIOUS choice (the proto files,
     `docker/servicebus-config.json`) stay on disk and are listed in the output.
  4. **User-owned, never written:** `setu.config.ts`, the member README (its transport notes go
     stale, and the output names that), and all other source. The planner uses
     `calledOutsideImports` (`diagnostics/wiring.ts:16-19`), which works on both host kinds, to
     check that the config CALLS each function the member needs: `messagingOptions` and
     `queueOptions` where applicable, `transportPlugins`, and `csrfExclusions` on app-factory hosts.
     An `undefined` result (an unclassifiable config) counts as missing. For each missing call the
     planner prints the exact line to add, writes nothing, and exits `1` (`EXIT_ERROR`). A config
     written before this milestone takes this path, and that is its migration (§3.10).

  A no-op prints that nothing changed and exits `0`. A no-op means the same broker, `brokerUrl` and
  `redisClient` for `broker`, and the same `rpc` for `rpc`. The plan is written transactionally
  through `writeFiles`, as `ports --reallocate` is. Afterwards the command prints the install
  command for the workspace runtime.

- **Why:** this states exactly what is CLI-owned: the files that are already `managed: true`, the
  module §3.3 adds, and a marked README section. Everything else is merged additively, or left to
  the user with guidance, which is the `add` rule. Writing nothing on a refusal means a workspace is
  never half-switched.
- **Test home:** `test/unit/workspace/rewire.test.ts`, on `test/fixtures/fake-fs.ts`:
  - each ownership class;
  - a no-op, for each field;
  - dry-run lists exactly the planned paths;
  - a missing call writes nothing and names the line, on both host kinds;
  - a README with no markers prints the section;
  - a JSONC member manifest refuses everything;
  - root-peer recording in an npm workspace;
  - `--redis-client` with a non-redis broker is refused.

  `test/unit/workspace-command.test.ts` covers dispatch, usage text and exit codes.

### 3.7 One planner for every entry point

- **Decision:** seven entry points render the module through `renderTransportModule`:
  `generate app`, `setu workspace broker`, `setu workspace rpc`, `setu sync` in a workspace, and,
  inside a member, `setu add messaging`, `setu add queue` and `setu add grpc`.
  - `generate app` writes the new member and regenerates every member's module (managed, so
    `findExisting` skips them, `file-writer.ts:342`). It does NOT run the missing-call refusal on
    existing members, so a 0.11.0 workspace can still gain members.
  - In a member, `setu add grpc` is the same operation as `setu workspace rpc <member> grpc`, and
    goes through `planTransportChange`.
  - On a plugin-list member, `setu add messaging|queue` inserts
    `MessagingPlugin(messagingOptions())` or
    `QueuePlugin({ processors: [...QUEUE_PROCESSORS], ...queueOptions() })` (with the seam's
    `processors`), adds the module import, and regenerates the module. It no longer inserts a
    literal. A full-stack member already calls both functions, because the starter owns those
    plugins, so there `setu add messaging|queue` keeps today's starter-arm behaviour
    (`add.ts:536-560`).
  - `setu sync` regenerates each member's module from the manifest and its installed plugins. Sync's
    E012 hold applies to the barrels only. The module does not depend on `setu.config.ts`, so it is
    still regenerated when E012 fires. Sync finds the workspace by walking up to
    `setu.workspace.json` with the existing `installSearchDirs` helper (`app-loader.ts:221`), from
    inside its per-project callback, so running it inside a member or at the root both work and
    `forEachProject` (`check.ts:71-74`) is unchanged.
- **Why:** CLAUDE.md "one capability, one implementation". A member reachable by `add grpc` and by
  `workspace rpc` must not get two different wirings.
- **Test home:** `test/unit/workspace/rewire.test.ts` "every entry point". One table drives all
  seven entry points on a NON-default workspace (`broker: rabbitmq`, one grpc member) and asserts
  identical module bytes. A 0.11.0-shaped workspace gains a member through `generate app` without a
  refusal. Also `test/unit/commands/add.test.ts` and `test/unit/sync-command.test.ts`.

### 3.8 Refusing a switch that would orphan wiring

- **Decision:** before planning, the switch scans each affected member's `setu.config.ts` and
  `src/**`, walked with `walkProjectFiles` (`workspace/adopt.ts`). It excludes `src/transport/` and
  `src/gen/` (`PROTO_OUT_DIR`), because generated descriptors import each other. It looks for
  references the switch would leave dangling:
  - **Leaving a broker:** the old arm's connection variable (`REDIS_URL`, …). This catches the
    Redis-only arms that `setu add cache|idempotency|scheduler|realtime-backplane` wrote, which
    would lose their Compose service.
  - **Leaving grpc:** `CAPABILITIES.GRPC`, an `@setu-ts/grpc-plugin` import, or an import from
    `src/gen/`.

  Files are scanned with comments masked (`maskComments`). A file the masker cannot classify (it
  returns `undefined` on template literals, regex and division) is scanned as raw text instead, so
  it can refuse but never be skipped. Each hit is printed as `file:line` with what will stop
  working, and the command exits `1`. With `--force` the switch goes ahead and prints the same list
  as warnings. Switching TO grpc or to a broker orphans nothing and is never refused. `--force`
  never bypasses §3.6's missing-call refusal.

- **Why:** removing a backing service or a plugin that code still uses produces a stack that starts
  and then fails at the first call. That is the "safe framework, broken default" class. Falling back
  to raw text only for files that cannot be masked keeps the scan fail-closed.
- **Test home:** `test/unit/workspace/rewire.test.ts` "orphans":
  - every pattern refuses;
  - the same text in a comment of a maskable file does not refuse;
  - an unmaskable file containing the pattern refuses;
  - files under `src/gen/` are ignored;
  - `--force` writes and warns.

### 3.9 The Redis-only arms keep their literals

- **Decision:** `cacheArgs`, `idempotencyArgs`, `schedulerArgs` and `backplaneArgs` stay as literals
  that `setu add` writes. They do not move into the module.
- **Why:** these are Redis choices, not the workspace bus. A cache stays on Redis when the bus moves
  to Kafka, so following the bus would be wrong. §3.8 protects the one real hazard: Redis
  disappearing from Compose.
- **Test home:** `test/unit/commands/add.test.ts` and `test/unit/add-redis-arms.test.ts` (existing
  literal cases do not change), plus the §3.8 `REDIS_URL` case.

### 3.10 Migration for existing workspaces

- **Decision:** a workspace made by `0.11.0` reads through §3.1's version-1 path, and any later
  write records version 2. Its existing members' configs do not call the module. `setu sync` (or
  `generate app`) writes the module into them, and `setu workspace broker|rpc` then takes §3.6's
  guidance path: it prints the replacement lines per member and writes nothing until they are in
  place. `docs/upgrading.md` gets the four line changes under its `## Unreleased` heading.
- **Why:** user-owned source is never rewritten (§3.6). With no existing users, a guided hand-edit
  plus one regeneration is enough.
- **Test home:** `test/unit/workspace/rewire.test.ts` "0.11.0 workspace". A version-1 manifest with
  literal-wired configs refuses with the lines. After `setu sync` and the edits, the switch
  succeeds.

### 3.11 Delegation

- **Decision:** Claude reviews and verifies. opencode on `opencode/deepseek-v4.1-flash-free`
  implements in four briefed batches:

  | Batch | Scope                                                                                              |
  | ----- | -------------------------------------------------------------------------------------------------- |
  | A     | §3.1, §3.2 and §3.5, with every §5 caller renamed and their unit tests; output otherwise unchanged |
  | B     | §3.3 and §3.4, with unit tests and fixture recaptures                                              |
  | C     | §3.6–§3.10, with unit tests and e2e cases                                                          |
  | D     | docs, CHANGELOG and upgrade notes                                                                  |

  Codex is not used (the user's choice for this cycle). Each brief carries the exact functions, file
  paths and acceptance tests from this plan, so no design is left to opencode. Each batch is
  reviewed, and its gates run, before the next is briefed.

- **Why:** CLAUDE.local.md assigns implementation to an external agent and says opencode must not
  get novel design. Every decision opencode needs is therefore settled here.
- **Test home:** n/a (process).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** `none` for library packages. For the CLI, the flag surface changes
(`--transport` and `--transport-url` are refused on `setu new --workspace`), and the manifest shape
changes (version 2). Both ship in minor `0.12.0` and are recorded in CHANGELOG and
`docs/upgrading.md`.

`packages/cli/src/index.ts` exports nothing new. The symbols below are internal to the CLI, so the
consumer column names their reader inside the package.

| Exported symbol (module-internal to the CLI)                 | Kind       | Consumer / real code path that READS it                                                                                  |
| ------------------------------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| `BROKERS`, `BrokerName`, `BrokerSpec`, `DEFAULT_BROKER`      | const/type | `manifest.ts` (reader and default), `new.ts`, `new-interactive.ts`, `adopt.ts`, `rewire.ts`                              |
| `getBroker`                                                  | fn         | `new.ts` (`--broker`), `templates/broker.ts` (`readArmFlag`), `manifest.ts`, `agents/render.ts`                          |
| `brokerSpec`                                                 | fn         | `app.ts`, `workspace.ts`, `workspace-ops.ts`, `devtool.ts`, `add.ts`, `rewire.ts`, and the `compose.ts`/`k8s.ts` callers |
| `RPC_STYLES`, `RpcStyle`, `getRpc`, `rpcSpec`, `RPC_ALIASES` | const/fn   | `app.ts` (`--rpc`), `new.ts` (`tcp` refusal), `manifest.ts` (member `rpc`), `transport-module.ts`, `rewire.ts`           |
| `renderTransportModule`                                      | fn         | `rewire.ts`, `member-host.ts` (via `generate app`), `sync.ts`                                                            |
| `TRANSPORT_MODULE`                                           | const      | the path constant; `rewire.ts`, `member-host.ts`, `sync.ts`, and the §3.8 scan exclusion                                 |
| `planTransportChange`                                        | fn         | `commands/workspace.ts` (`broker`, `rpc`), `commands/add.ts` (member grpc/messaging/queue)                               |
| `TRANSPORT_README_MARKERS`                                   | const      | `root-files.ts` (writes them), `rewire.ts` (replaces between them)                                                       |

### 4.1 Options — every option names its consumer

| Option                                                    | Consumer                               | Behavior (per implementation)                                                             |
| --------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `setu new --workspace --broker`                           | `new.ts` → manifest `broker`           | Validated against `listBrokers()`. Defaults to `memory`.                                  |
| `setu new --workspace --broker-url`                       | `new.ts` → manifest `brokerUrl`        | Refused on `memory`, `pubsub` and `service-bus`.                                          |
| `generate app --rpc`                                      | `app.ts` → member `rpc`                | `http` (the default, recorded as absent) or `grpc`. `tcp` is refused with the alias text. |
| `workspace broker <name> [--broker-url] [--redis-client]` | `workspace.ts` → `planTransportChange` | Rewires every member (§3.6).                                                              |
| `workspace rpc <member> <http\|grpc>`                     | `workspace.ts` → `planTransportChange` | Rewires one member. An unknown member is refused, naming the members that exist.          |
| `--dry-run` (both)                                        | `reportDryRunPlan`                     | Prints the plan and writes nothing.                                                       |
| `--force` (both)                                          | the §3.8 scan                          | Turns orphan refusals into warnings. It never bypasses the missing-call refusal.          |

## 5. Implementation files

| File                                                                                           | Purpose                                                                                                                      |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/index.ts`                                                                    | Unchanged (no new public export).                                                                                            |
| `packages/cli/src/workspace/transport.ts`                                                      | The broker registry only, with dead fields pruned (§3.2). Module doc rewritten (C1).                                         |
| `packages/cli/src/workspace/rpc.ts` (new)                                                      | The RPC-style registry. The grpc spec moves here unchanged.                                                                  |
| `packages/cli/src/workspace/transport-module.ts` (new)                                         | `renderTransportModule` (§3.3).                                                                                              |
| `packages/cli/src/workspace/rewire.ts` (new)                                                   | `planTransportChange`: ownership classes, missing-call check, orphan scan, README markers.                                   |
| `packages/cli/src/workspace/manifest.ts`                                                       | Version 2, `broker`/`brokerUrl`, member `rpc`, the version-1 read.                                                           |
| `packages/cli/src/workspace/member-host.ts`                                                    | Renders config calls to the module instead of literals.                                                                      |
| `packages/cli/src/templates/full-stack.ts`                                                     | Module calls in the starter callback, the CSRF exclusion, and the register loop.                                             |
| `packages/cli/src/templates/broker.ts`                                                         | `getBroker`/`BrokerSpec`; `readArmFlag` text.                                                                                |
| `packages/cli/src/devtool/sources.ts`, `src/commands/starter-options.ts`                       | The one spread form (§3.4).                                                                                                  |
| `packages/cli/src/workspace/root-files.ts`                                                     | README transport section between markers; `--broker` wording.                                                                |
| `packages/cli/src/workspace/compose.ts`, `k8s.ts`                                              | Take `BrokerSpec` (type rename only).                                                                                        |
| `packages/cli/src/commands/new.ts`, `new-interactive.ts`, `src/examples/new.ts`                | `--broker`/`--broker-url` and their refusals; the workspace question; the `--example` refusal list.                          |
| `packages/cli/src/constants.ts`, `src/flags.ts`, `src/cli.ts`                                  | `VALUE_FLAGS`; flag specs for `new`, `generate app`, `workspace broker`, `workspace rpc`, `--force`; help lines.             |
| `packages/cli/src/commands/app.ts`                                                             | `--rpc`; refusal texts name `setu workspace broker`; module regeneration.                                                    |
| `packages/cli/src/commands/workspace.ts`                                                       | The `broker` and `rpc` operations; usage text.                                                                               |
| `packages/cli/src/commands/add.ts`                                                             | Member messaging/queue/grpc through the planner (§3.7); message texts.                                                       |
| `packages/cli/src/commands/sync.ts`, `check.ts`                                                | Module regeneration; the workspace root passed to the callback.                                                              |
| `packages/cli/src/commands/devtool.ts`, `workspace-ops.ts`, `adopt.ts`, `src/agents/render.ts` | `manifest.broker` replaces `manifest.transport`; the brief line names the broker and each member's rpc.                      |
| `scripts/check-deploy.ts` (`:999`, `:1311`, `:1597`)                                           | `--transport redis\|http` becomes `--broker redis` (or nothing).                                                             |
| `packages/cli/AGENT_CARD.md`, `packages/cli/README.md`                                         | Flags and commands.                                                                                                          |
| Docs                                                                                           | §2 C1/C2 list; `docs/upgrading.md` `## Unreleased`; `CHANGELOG.md`; `ROADMAP.md` (M138 section and row); `CLAUDE.md` status. |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                                                         | src covered                                                                                                    | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/workspace/manifest.test.ts`, `test/unit/workspace-manifest.test.ts`                                                                                    | `manifest.ts`                                                                                                  | §3.1 table; `readWorkspaceManifest(fs, dir)` → `WorkspaceManifestResult`.                                                                                                                                                                                                                                                                                      |
| `test/unit/workspace/transport.test.ts`                                                                                                                           | `transport.ts`                                                                                                 | Broker registry; `brokerSpec(name, redisClient)`.                                                                                                                                                                                                                                                                                                              |
| `test/unit/workspace/rpc.test.ts` (new)                                                                                                                           | `rpc.ts`                                                                                                       | The grpc spec equals today's; the `tcp` alias.                                                                                                                                                                                                                                                                                                                 |
| `test/unit/workspace/transport-module.test.ts` (new)                                                                                                              | `transport-module.ts`                                                                                          | §3.3 matrix.                                                                                                                                                                                                                                                                                                                                                   |
| `test/unit/workspace/rewire.test.ts` (new)                                                                                                                        | `rewire.ts`                                                                                                    | §3.6–§3.8 and §3.10 tables.                                                                                                                                                                                                                                                                                                                                    |
| `test/unit/workspace/member-host.test.ts`, `test/unit/full-stack-template.test.ts`                                                                                | `member-host.ts`, `templates/full-stack.ts`                                                                    | Config calls for both host kinds × rpc; no literal broker args left in a member config.                                                                                                                                                                                                                                                                        |
| `test/unit/devtool-sources.test.ts`, `test/unit/commands/starter-options.test.ts`                                                                                 | `devtool/sources.ts`, `commands/starter-options.ts`                                                            | §3.4.                                                                                                                                                                                                                                                                                                                                                          |
| `test/unit/workspace/root-files.test.ts`                                                                                                                          | `root-files.ts`                                                                                                | Markers present; the section per broker.                                                                                                                                                                                                                                                                                                                       |
| `test/unit/workspace/compose.test.ts`, `k8s.test.ts`                                                                                                              | `compose.ts`, `k8s.ts`                                                                                         | Output unchanged per broker.                                                                                                                                                                                                                                                                                                                                   |
| `test/unit/new-command.test.ts`, `new-interactive.test.ts`, `flags.test.ts`, `broker-flags.test.ts`, `help.test.ts`, `examples.test.ts`, `node-redis-cli.test.ts` | `new.ts`, `new-interactive.ts`, `flags.ts`, `cli.ts`, `constants.ts`, `templates/broker.ts`, `examples/new.ts` | §3.5.                                                                                                                                                                                                                                                                                                                                                          |
| `test/unit/app-command.test.ts`                                                                                                                                   | `app.ts`                                                                                                       | `--rpc`; refusal texts; module regeneration does not refuse on legacy configs.                                                                                                                                                                                                                                                                                 |
| `test/unit/workspace-command.test.ts`                                                                                                                             | `commands/workspace.ts`                                                                                        | Dispatch, usage, exit codes 0/1/2, dry-run; version-1 rewrite through `ports --reallocate`.                                                                                                                                                                                                                                                                    |
| `test/unit/commands/add.test.ts`, `test/unit/add-redis-arms.test.ts`                                                                                              | `add.ts`                                                                                                       | Member messaging/queue/grpc through the planner; Redis arms unchanged.                                                                                                                                                                                                                                                                                         |
| `test/unit/sync-command.test.ts`                                                                                                                                  | `sync.ts`, `check.ts`                                                                                          | Module regenerated from a member directory and from the root; regenerated under E012; a standalone project untouched.                                                                                                                                                                                                                                          |
| existing `devtool`, `workspace-ops`, `adopt` and `agents` tests                                                                                                   | those files                                                                                                    | Field rename; version-1 rewrite through `devtool enable`; the brief line text.                                                                                                                                                                                                                                                                                 |
| `test/fixtures/redis-default-outputs.ts`, `redis-develop-outputs.json`                                                                                            | golden fixtures                                                                                                | Recaptured with `--broker redis`. The diff is reviewed: module calls replace the literals, and nothing else moves.                                                                                                                                                                                                                                             |
| `test/integration/workspace-deploy-links.test.ts`, `symlink-containment.test.ts`; root `test/deploy-gate.test.ts`                                                 | integration and tooling                                                                                        | Flag rename.                                                                                                                                                                                                                                                                                                                                                   |
| `test/e2e/workspace-e2e.test.ts`                                                                                                                                  | generated output                                                                                               | (a) `--broker rabbitmq` with a microservice member and a full-stack `--rpc grpc` member, on npm and on Deno: format, lint, type-check and each member's `check` script (`setu check`) pass. (b) After `workspace broker redis`, then `workspace rpc <m> http`, all of that still passes; `compose.yaml` names `redis`; the member's module has no grpc import. |
| `test/e2e/workspace-mesh-e2e.test.ts`                                                                                                                             | generated output, real boot                                                                                    | Scaffold on `memory`, run `setu workspace broker redis`, boot two members, and deliver a message (the existing redis probe, guarded on a reachable Redis). A grpc member boots and answers `POST /grpc/grpc.health.v1.Health/Check` with 200; after `workspace rpc <m> http` the same POST is 404 and `/health` is 200.                                        |
| `test/e2e/full-stack-broker-e2e.test.ts`, `scaffold-runs-e2e.test.ts`                                                                                             | generated output                                                                                               | Flag rename; the full-stack workspace member on redis still boots.                                                                                                                                                                                                                                                                                             |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m138-workspace-transports
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run check:docs
pnpm run test:tooling:coverage   # check-deploy.ts and the root deploy-gate test change
pnpm test:coverage cli           # ANSI-stripped per-file table; ≥90% branch/function/line on every changed src file
pnpm run test:deno-lane
pnpm run ci:local --shard cli    # final commit; includes scaffold-runs-e2e and the workspace e2e (confirm both in its job list)
pnpm run release:publish --dry-run
pnpm run release:verify 0.12.0
```

## 8. Risks & mitigations

- **The generated config could leave the language the classifier reads (E012 `config-unreadable`).**
  Plain calls and spreads stay inside it, and `csrfExclusions()` keeps the RegExp in the module.
  Mitigation: e2e (a) runs `setu check` on every member, on both host kinds.
- **The missing-call check could misread Prettier-wrapped output.** It uses `calledOutsideImports`
  on masked code, never text matching. Mitigation: it is exercised on the Prettier-formatted output
  that the e2e writes.
- **Module formatting could drift on Deno, which has no CLI formatter.** Mitigation: the e2e runs
  `deno fmt --check` on a Deno workspace after each switch.
- **The manifest version bump makes `0.11.0` CLIs refuse new workspaces.** This is intended, and
  CHANGELOG notes it.
- **Batch C is the hardest work handed to opencode** (the planner, the orphan scan, the ownership
  classes). Mitigation: the brief carries §3.6–§3.8 verbatim with the test tables. If the result
  fails review twice, the user decides who finishes it.
- **The sibling task `chore/grpc-workspace-example` uses `--transport grpc`.** Mitigation: after
  this merges it rebases onto `--rpc grpc`, and the PR body says so.

## 9. Out of scope

- More than one broker per workspace, or per-binding binders (Spring Cloud Stream, Quarkus,
  MassTransit MultiBus). There is no demand, and it needs a messaging-plugin change. It is not on
  the ROADMAP.
- A `setu check` finding for a workspace member whose config stopped calling the transport module.
  This is a candidate follow-up after `0.12.0`.
- Changing a standalone project's broker. `setu add messaging --broker` and `--queue` already do
  this.
- Removing packages or files that a switch no longer needs. They are listed, never deleted (§3.6).
