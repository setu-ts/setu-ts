# Milestone 121 — Full-stack members with a broker, and messaging on a full-stack project (`@setu-ts/cli`)

> **Status:** Planning. Branch: `feat/m121-full-stack-broker`. `develop` and `main` are protected —
> all work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

A full-stack project can sit on a message broker. The three entry points that refuse today —
`setu generate app <name> --template full-stack` in a broker-transport workspace,
`setu new --template full-stack --broker/--queue`, and `setu add messaging`/`queue` on a full-stack
project — instead render the transport into the full-stack starter's `messaging:`/`queue:` options,
which `createFullStackAppFromConfig` already passes to `MessagingPlugin`/`QueuePlugin`.
`setu add messaging`/`queue` also learn the workspace transport for ordinary members (today they
insert an in-memory `MessagingPlugin()` in a Redis workspace) and gain `--broker`/`--queue` for
standalone projects. `setu add react-router` on a project that is not full-stack refuses with the
command that creates one. The boundary is the CLI: no published package changes.

- **In scope:** `packages/cli` (templates, transport rendering, `new`, interactive `new`,
  `generate app`, `add`), its tests including a typed-position probe and a real-Redis e2e, docs.
  Closes **V10-51** and **V10-52**.
- **NOT this milestone:** a broker on Cloudflare Workers (unchanged refusal — Workers replaces both
  plugins with platform queues); rewriting an EXISTING `MessagingPlugin(...)`/`messaging:` value
  (left alone and printed, never overwritten — §3.7); scaffolding a React Router app into a
  non-full-stack project (refused, §3.9); the `build/` ignore for full-stack members (V10-55,
  unowned); workspace root scripts (V10-60, M122).

## 1. Contracts verified from SOURCE (not names)

Read on `origin/develop` `bc9aacb9`; probes with the CLI built from that tree (`.tmp/addprobe`).

| Reference                              | Source (file:line)                                                                                                    | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Starter options                        | `packages/starters/microservice-starter/src/options.ts:18-28`; `app.ts:29-30`; `full-stack-starter/src/options.ts:25` | `MicroserviceStarterOptions` has `messaging?: MessagingPluginOptions` and `queue?: QueuePluginOptions`; the app ALWAYS registers `MessagingPlugin(options.messaging)` and `QueuePlugin(options.queue)`. `FullStackStarterOptions extends MicroserviceStarterOptions`. No starter change is needed.                                                                                  |
| Generated full-stack factory           | `packages/cli/src/templates/full-stack.ts:65-200` (`fullStackArgs`)                                                   | Renders `(config): FullStackStarterOptions => { …; return { reactRouter…, session…, logger…, httpSecurity… }; }`. The return-type annotation is the X5-2 fix: with it a misspelled key is TS2561; without it TypeScript does not excess-property-check a callback's returned literal. `config.get<string>('TRUSTED_PROXIES', { default: '' })` is the template's existing env read. |
| Render context                         | `packages/cli/src/templates/registry.ts:173-187`                                                                      | `AppFactoryRenderContext` has `logger`, `swaggerAssets`, `runtime`, `serviceEndpoints`, `envFilePath`, `grpcBasePath`; `ResolvedHost.appFactoryContext` carries the non-runtime fields (`registry.ts:402`, `project-files.ts:185`).                                                                                                                                                 |
| Only one starter-composed template     | `grep appFactory: packages/cli/src/templates/*.ts`                                                                    | `full-stack.ts:224` is the only `appFactory`.                                                                                                                                                                                                                                                                                                                                       |
| Broker overlay                         | `packages/cli/src/templates/broker.ts:62-112`                                                                         | `withBrokerArgs`/`withQueueArgs` rewrite an inline `messaging-plugin`/`queue-plugin` wiring via `rewritePluginArgs` with `spec.messagingArgs(renderConnection(...))`, add `messagingClients`/`queueClients` via `withClientDependencies`, and carry the transport note; a host without the wiring is returned unchanged.                                                            |
| Standalone refusal                     | `broker.ts:202-232` (`standaloneOverlayRefusal`)                                                                      | Refuses on Workers, on any `host.appFactory` ("starter-composed … would look connected while talking to nobody"), and when the host has no matching wiring. Used by `new.ts:561-571` and `new-interactive.ts:188` (which hides the broker question when it refuses).                                                                                                                |
| Workspace refusal (M85)                | `packages/cli/src/commands/app.ts:248-276`                                                                            | `generate app` refuses a template with `appFactory` when the transport has `messagingArgs` or `queueArgs`.                                                                                                                                                                                                                                                                          |
| Broker flags in a workspace root       | `new.ts:238-249`                                                                                                      | `--broker`/`--queue` are refused for `setu new --workspace`: "a workspace's members share one instead … --transport".                                                                                                                                                                                                                                                               |
| Arm-flag parsing                       | `new.ts:377-412` (`readArmFlag`)                                                                                      | Validates `--broker`/`--queue` against `listBrokers()`/`listQueues()` and refuses an arm without the matching args.                                                                                                                                                                                                                                                                 |
| Transport connection                   | `packages/cli/src/workspace/transport.ts:74-94`, `:134-192`, `:651-657`                                               | `TransportConnection { variable, localDefault, urlOverridable, note? }`; `TransportSpec.messagingArgs/queueArgs(connection)`, `messagingClients/queueClients`; `renderConnection` = `profile.envRead(variable, override ?? localDefault)`.                                                                                                                                          |
| Formatting of generated output         | `packages/cli/src/utils/prettier-format.ts:213-226`; `workspace/transport.ts:302-304`, `:419-560`                     | `formatForTarget` formats npm targets with Prettier and returns Deno files as rendered. The arms' `messagingArgs` return multi-line literals indented for the inline plugin list (NATS, Kafka, Pub/Sub, Service Bus); Service Bus's default is the long emulator connection string.                                                                                                 |
| Compose env                            | `packages/cli/src/workspace/compose.ts:418-430`                                                                       | `memberEnvironment(siblings, transport)` sets the transport's variables on EVERY member service, whatever its template.                                                                                                                                                                                                                                                             |
| `setu add` and workspace transport     | `packages/cli/src/commands/add.ts:932-954` (`workspaceAddArgs`)                                                       | Only `cache-plugin`, `scheduler-plugin`, `realtime-backplane-plugin` read the workspace transport. Probe: `setu add messaging` in a `--transport redis` workspace's REST member inserts bare `MessagingPlugin()` (in-memory).                                                                                                                                                       |
| `setu add` insertion                   | `add.ts:830-895` (`withPluginWiring(source, bare, seam?, args?)`)                                                     | Inserts `Factory(args)` before the single `...(devtool?.plugins ?? [])` element; refuses (→ printed line) on a starter-composed config, an existing reference, an unrecognized import form, a missing or repeated anchor. Explicit `args` exists since M123.                                                                                                                        |
| `setu add` on a full-stack project     | `add.ts:330-350` (`printWiringNote`); `utils/starter-arms.ts:48-75`                                                   | Probe: pins `@setu-ts/messaging-plugin`, prints "createFullStackAppFromConfig owns this plugin; configure its messaging arm in setu.config.ts" with a `v0.10.0`-tagged README link. `STARTER_ARMS` also recognizes hand-written `createRestApp`/`createMicroserviceApp` configs.                                                                                                    |
| `setu add react-router`                | `add.ts:145`, `:310-312`                                                                                              | Pins the package and prints `ReactRouterPlugin({ serverBuildPath: '<server-build-module>' })`; scaffolds nothing (V10-52).                                                                                                                                                                                                                                                          |
| Real-broker e2e pattern                | `packages/cli/test/e2e/broker-scaffold-e2e.test.ts:33`, `:189-215`                                                    | Guarded on `REDIS_URL` (CI sets it against a `redis:7` service), boots a scaffold with its own permissions.                                                                                                                                                                                                                                                                         |
| Framework precedent for `add --option` | Angular `ng add <pkg> --<option>` (schematic options), Nx generator options                                           | An "add" verb taking options that shape what it writes is established; `setu new --broker` already exists for creation.                                                                                                                                                                                                                                                             |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                     | Resolution (picked side)                                                                                | Doc deliverable (same PR)                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| C1  | ROADMAP §M121 says `setu add react-router` "scaffolds or refuses"; the maintainer chose refuse (2026-10-28).                                 | Refuse (§3.9).                                                                                          | ROADMAP §M121 deliverable text when checked. |
| C2  | ROADMAP §M121 and M115-FINDINGS say the full-stack doc link "points at `develop`"; measured, it is already version-tagged (`v0.10.0`).       | Already fixed upstream; nothing to change for the link. The printed guidance is replaced anyway (§3.7). | None beyond the ROADMAP deliverable wording. |
| C3  | ROADMAP §M121 names the M61 callback trap as unguarded; the template has carried the `FullStackStarterOptions` return annotation since X5-2. | The guard exists; M121 keeps it and adds the probe that proves it (§3.10).                              | None.                                        |

## 3. Design decisions

### 3.1 The connection read inside the full-stack factory

- **Decision:** `transport.ts` gains `renderConfigConnection(connection, override?)` returning
  `config.get<string>('<variable>', { default: '<override ?? localDefault>' })`, string literals
  single-quoted, no regex literal or backslash (the CLI's config reader stays able to classify the
  file, `full-stack.ts` comment, audit C-R5). It takes the column it will be printed at and emits
  the call on one line when it fits in 100 columns, otherwise in the wrapped form `deno fmt` and
  Prettier both print (`config.get<string>(` / `'<variable>',` / `{ default: '…' },` / `)`) — the
  Service Bus emulator default alone exceeds the line. Full-stack options use it; inline plugin args
  keep `renderConnection` unchanged.
- **Why:** maintainer decision 2026-10-28 — the template's own idiom (`TRUSTED_PROXIES`), and the
  value then also comes from the project's `.env` through ConfigPlugin; Compose and Kubernetes
  environment variables still take precedence.
- **Test home:** `transport.test.ts` (rendered text per transport, override, a `'` in the default
  escaped); full-stack e2e boots with `.env` only and with the variable set.

### 3.2 Full-stack starter options carry the transport

- **Decision:** `AppFactoryRenderContext` gains `messaging?: string` and `queue?: string` — rendered
  option literals. `fullStackArgs` emits `messaging: <literal>,` and `queue: <literal>,` in the
  returned object, after `logger`. The arms' literals are pre-indented for the inline `plugins: [`
  position (8-space inner indent; Kafka's `nestConnection`), and Deno output is never reformatted
  (`formatForTarget` runs Prettier on npm targets only, `prettier-format.ts:220`), so a new internal
  `reindentLiteral(literal, fromDepth, toDepth)` in `plugin-args.ts` shifts every line after the
  first to the returned object's depth; single-line literals pass through.
  `withBrokerArgs`/`withQueueArgs` keep their inline path and gain a starter path: when
  `host.appFactory` is set, they put `spec.messagingArgs(renderConfigConnection(...))` (or
  `queueArgs`) into `appFactoryContext`, add the same `messagingClients`/`queueClients`, and carry
  the transport note. A unit table asserts every template with an `appFactory` renders both options
  (today only full-stack), so a future starter-composed template that cannot is caught.
- **Why:** M61/M67 precedent (`AppFactoryRenderContext`); the starter already accepts and registers
  both options (§1), so one rendering serves all three entry points.
- **Test home:** `full-stack-template.test.ts`; `broker-flags.test.ts`; `plugin-args.test.ts`
  (`reindentLiteral`); scaffold e2e runs `deno fmt --check` and Prettier on a full-stack project
  rendered for EVERY broker and queue arm (no install needed).

### 3.3 `setu new --template full-stack --broker/--queue`

- **Decision:** `standaloneOverlayRefusal` no longer refuses a starter-composed host; the Workers
  refusal and the no-wiring refusal stay (full-stack has no inline wiring, so the starter case is
  checked first and passes). `applyBrokerOverlay` is unchanged: it already adds the `.env` rows and
  the broker Compose file. The interactive `setu new` therefore offers the broker and queue
  questions for full-stack (it asks whenever the refusal is absent, `new-interactive.ts:188`).
- **Why:** entry point 2 of V10-51.
- **Test home:** `broker-flags.test.ts`; `new-interactive.test.ts`; scaffold e2e.

### 3.4 `setu generate app <name> --template full-stack` in a broker workspace

- **Decision:** the M85 refusal (`app.ts:248-276`) is removed; `member-host.ts` already calls
  `withBrokerArgs`/`withQueueArgs` with the workspace's `transportUrl` override, which now reaches
  the starter options (§3.2). A transport arm with a queue but no broker (and the reverse) renders
  only what it has, as for microservice members.
- **Why:** entry point 1 of V10-51.
- **Test home:** `app-command.test.ts`; real-broker e2e (§3.11).

### 3.5 `setu add messaging`/`queue` read the workspace transport

- **Decision:** `workspaceAddArgs` gains `messaging-plugin` (`transport.messagingArgs`) and
  `queue-plugin` (`transport.queueArgs`), with the arm's clients (`messagingClients`/`queueClients`)
  installed through the M119f peer path. The peer list today hard-codes `ioredis` whenever a
  workspace transport applies (`add.ts:1058-1061`); it becomes the selected arm's own client list,
  so a RabbitMQ, NATS, Kafka, Pub/Sub or Service Bus workspace installs its own driver. The rendered
  connection is `renderConnection` for an inline plugin and `renderConfigConnection` for the
  full-stack factory (§3.7).
- **Why:** maintainer decision 2026-10-28; fixes the measured in-memory insert in a Redis workspace.
- **Test home:** `commands/add.test.ts` (REST, microservice and full-stack members in a redis and a
  nats workspace — nats has no queue arm).

### 3.6 `--broker`/`--queue` on `setu add messaging`/`queue`

- **Decision:** `setu add messaging --broker <name>` and `setu add queue --queue <name>` select an
  arm for a STANDALONE project. `readArmFlag` moves from `new.ts` to `templates/broker.ts` and is
  shared, so validation and messages are identical. Refused, writing nothing: `--broker` or
  `--queue` on any other package; `--queue` on `add messaging` and `--broker` on `add queue`; on
  Cloudflare Workers (the §1 refusal text); inside a workspace member (the `new.ts:238-249`
  reasoning — the workspace transport applies, §3.5). `memory` is accepted and writes no connection
  (the starter/plugin default). Besides the option (§3.7) and the client, the command writes the
  broker Compose file only when the project has none (`brokerComposeFiles`, as `setu new --broker`)
  and prints the connection variable with its local default; it does not edit `.env` files.
- **Why:** maintainer decision 2026-10-28; precedent `ng add <pkg> --<option>`.
- **Test home:** `commands/add.test.ts` (each refusal by name; accepted arms; idempotence).

### 3.7 Where `setu add` writes the option

- **Decision:** one rule, write only what is absent and print what exists:
  - **Inline plugin list:** no existing `MessagingPlugin`/`QueuePlugin` reference → insert it with
    the transport's args through `withPluginWiring(source, bare, seam, args)`. An existing call is
    left byte-identical and the note prints the args to set.
  - **Generated full-stack factory:** a new internal `withStarterOption(source, key, literal)` in
    `packages/cli/src/commands/starter-options.ts` inserts `<key>: <literal>,` as the first property
    of the object returned by the single `(config): FullStackStarterOptions =>` callback inside the
    factory scope (`factoryScope`, `maskComments`, `referencesIdentifier`, as `withPluginWiring`).
    Refused (→ printed line) when that callback is absent or repeated, the returned object already
    has the key, or the source is not classifiable.
  - **Hand-written `createRestApp`/`createMicroserviceApp` or any other starter config:** printed
    line with the exact `messaging: …` / `queue: …` property, replacing today's "configure its
    messaging arm".
  - With no transport and no flag, the printed line for a full-stack project says messaging is
    already registered in memory by the starter and shows the `--broker` form.
- **Why:** the M123 "never overwrite" policy; the generated factory is the one shape the CLI owns.
- **Test home:** `starter-options.test.ts` (accept/refuse table); `commands/add.test.ts`.

### 3.8 Clients and dotenv for full-stack

- **Decision:** the broker client (`ioredis`, `amqplib`, `nats`, `kafkajs`, `@google-cloud/pubsub`,
  `@azure/service-bus`) is written to the project's `dependencies` (Deno: import map) on every entry
  point, through the existing client/peer writers. `setu new --broker` adds the variable to `.env` /
  `.env.example` (existing `brokerEnvVariables`); workspace members receive it from Compose (§1).
- **Why:** a full-stack member must load the driver its `messaging:` option names.
- **Test home:** `broker-flags.test.ts`; `commands/add.test.ts`.

### 3.9 `setu add react-router` on a project that is not full-stack

- **Decision:** refused with exit 1 before any write, naming `setu new <name> --template full-stack`
  (standalone) or `setu generate app <name> --template full-stack` (workspace member). A config
  whose factory is `createFullStackAppFromConfig` (or whose plugins already include
  `ReactRouterPlugin`) keeps today's behaviour: already installed.
- **Why:** maintainer decision 2026-10-28; adding only the dependency leaves an unusable half-app
  (V10-52), and one way to create a full-stack app is enough.
- **Test home:** `commands/add.test.ts`.

### 3.10 Typed-position probe

- **Decision:** a unit test type-checks a generated full-stack `setu.config.ts` rendered for EVERY
  broker arm (and every queue arm) with the M121 options through the TypeScript compiler API against
  the workspace's starter types, then the same file with `messaging` misspelled `messagin` and
  asserts TS2561 naming `messaging`; and once with the `: FullStackStarterOptions` annotation
  removed, asserting it then passes silently — the proof that the annotation is load-bearing.
- **Why:** ROADMAP's named trap (M61); C3.
- **Test home:** `full-stack-options-typecheck.test.ts`.

### 3.11 Real-broker e2e

- **Decision:** guarded on `REDIS_URL` like `broker-scaffold-e2e.test.ts`. Node workspace on
  `--transport redis`, `generate app portal --template full-stack`, install, build, then a probe
  script in the scaffold imports `createApp()`, starts it, subscribes and publishes on a topic
  through `CAPABILITIES.MESSAGING`, waits for the message, and the test reads the Redis stream for
  that topic with `XLEN` (> 0) — proving the message crossed Redis, not memory. A second case runs
  `setu new --template full-stack --broker redis` standalone and boots `/health` 200 with the Redis
  indicator up.
- **Why:** ROADMAP deliverable; a memory-backed false pass is exactly the defect class.
- **Test home:** `full-stack-broker-e2e.test.ts`.

### 3.12 Security

- **Decision:** no committed-tree audit. Generated code reads a connection URL from config and
  passes it to an existing plugin; the CLI writes only into the project it is pointed at through the
  existing writers (symlink refusals unchanged). No server behaviour or package runtime changes.
- **Why:** no trust boundary is crossed.
- **Test home:** none beyond the writer tests above.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. No package's `src/index.ts` changes.

| Exported symbol (internal to `packages/cli`)   | Kind     | Consumer / real code path that READS it              |
| ---------------------------------------------- | -------- | ---------------------------------------------------- |
| `renderConfigConnection`                       | function | `broker.ts` starter path; `add.ts` full-stack option |
| `AppFactoryRenderContext.messaging` / `.queue` | fields   | `fullStackArgs`                                      |
| `readArmFlag` (moved to `broker.ts`)           | function | `new.ts`, `add.ts`                                   |
| `withStarterOption`                            | function | `add.ts`                                             |
| `reindentLiteral`                              | function | `broker.ts` starter path; `add.ts` full-stack option |

### 4.1 Options — every option names its consumer

| Option                    | Consumer        | Behavior (per implementation)                                                          |
| ------------------------- | --------------- | -------------------------------------------------------------------------------------- |
| `setu add … --broker <n>` | `runAddCommand` | `messaging` only; standalone only; refused on Workers and in a workspace member (§3.6) |
| `setu add … --queue <n>`  | `runAddCommand` | `queue` only; same refusals; arms without a queue renderer refused by `readArmFlag`    |

## 5. Implementation files

| File                                                     | Purpose                                                                                                                                   |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/workspace/transport.ts`                | `renderConfigConnection` (§3.1)                                                                                                           |
| `packages/cli/src/templates/plugin-args.ts`              | `reindentLiteral` (§3.2)                                                                                                                  |
| `packages/cli/src/templates/registry.ts`                 | `AppFactoryRenderContext.messaging/queue` (§3.2)                                                                                          |
| `packages/cli/src/templates/full-stack.ts`               | render the two options (§3.2)                                                                                                             |
| `packages/cli/src/templates/broker.ts`                   | starter path; refusal change; `readArmFlag` moved in (§3.2, §3.3)                                                                         |
| `packages/cli/src/commands/new.ts`, `new-interactive.ts` | use the shared `readArmFlag`; broker questions for full-stack (§3.3)                                                                      |
| `packages/cli/src/commands/app.ts`                       | remove the M85 refusal (§3.4)                                                                                                             |
| `packages/cli/src/commands/add.ts`                       | transport for messaging/queue, flags, react-router refusal (§3.5–3.9)                                                                     |
| `packages/cli/src/commands/starter-options.ts` (new)     | `withStarterOption` (§3.7)                                                                                                                |
| Docs                                                     | `docs/cli.md`, `packages/cli/README.md`, full-stack starter README (`messaging`/`queue` example), `docs/upgrading.md`, CHANGELOG, ROADMAP |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                           | src covered                    | Key assertions                                                                                                          |
| ------------------------------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/test/unit/workspace/transport.test.ts`                | `transport.ts`                 | `renderConfigConnection` per arm with and without override; quoting                                                     |
| `packages/cli/test/unit/plugin-args.test.ts`                        | `plugin-args.ts`               | `reindentLiteral`: multi-line shift, single-line passthrough, nested arrays (Kafka)                                     |
| `packages/cli/test/unit/full-stack-template.test.ts`                | `full-stack.ts`, `registry.ts` | options rendered after `logger`, absent when no transport; every `appFactory` template renders both (table)             |
| `packages/cli/test/unit/broker-flags.test.ts`                       | `broker.ts`, `new.ts`          | full-stack `--broker`/`--queue` per arm: option, client, `.env` rows, Compose file; Workers still refused               |
| `packages/cli/test/unit/new-interactive.test.ts`                    | `new-interactive.ts`           | broker/queue questions offered for full-stack                                                                           |
| `packages/cli/test/unit/app-command.test.ts`                        | `app.ts`                       | full-stack member in redis, rabbitmq, nats, kafka workspaces renders the transport; M85 message gone                    |
| `packages/cli/test/unit/commands/add.test.ts`                       | `add.ts`                       | §3.5 table, §3.6 refusals and arms, §3.7 per config shape, §3.9 refusal and already-installed; dry-run lists writes     |
| `packages/cli/test/unit/commands/starter-options.test.ts` (new)     | `starter-options.ts`           | accepted insert; refused: no callback, two callbacks, key present, unclassifiable                                       |
| `packages/cli/test/unit/full-stack-options-typecheck.test.ts` (new) | generated output               | §3.10                                                                                                                   |
| `packages/cli/test/e2e/full-stack-broker-e2e.test.ts` (new)         | generated output               | §3.11 (guarded on `REDIS_URL`)                                                                                          |
| `packages/cli/test/e2e/scaffold-runs-e2e.test.ts`                   | generated output               | full-stack `--broker`/`--queue` for every arm passes `deno fmt --check` (Deno) and Prettier (Node); `redis` type-checks |

Negative controls (run by hand, recorded in the PR, never committed): remove the starter path in
`withBrokerArgs` → e2e `XLEN` assertion fails (memory); drop the return-type annotation → §3.10's
misspelled-key case passes silently; restore the M85 refusal → `app-command` full-stack cases fail.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m121-full-stack-broker
pnpm run check:plan
pnpm run fmt:check && pnpm run lint && pnpm run check && pnpm run check:docs
REDIS_URL=redis://127.0.0.1:6379 pnpm run ci:local   # cli, static, tooling shards on the final commit
pnpm run check:deploy --generated
pnpm run release:publish --dry-run && pnpm run release:verify 0.10.0
```

## 8. Risks & mitigations

- `withStarterOption` editing a user-owned config → it only accepts the single generated callback
  shape and fails closed to a printed line, like `withPluginWiring`.
- A transport arm whose messaging options type differs from what the starter's `messaging` field
  accepts → §3.10 type-checks the rendered literal for every arm against the real starter types.
- Real-broker e2e skipped locally → CI sets `REDIS_URL`; the local run uses the Redis container
  (`REDIS_URL=redis://127.0.0.1:6379`) and the PR records it ran, not skipped.

## 9. Out of scope

- Brokers on Cloudflare Workers — platform queues replace both plugins.
- Changing an existing broker selection — the CLI prints the value instead of rewriting it.
- `build/` ignore for full-stack members (V10-55) and workspace root scripts (V10-60, M122).
