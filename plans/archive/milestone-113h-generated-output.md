# Milestone 113h — Generated output that is wrong (`@setu-ts/cli`, `@setu-ts/runtime`, `@setu-ts/kernel`)

> **Status:** Complete. Branch: `fix/m113h-generated-output` (a **fix** letter: the ROADMAP lets
> each row ship on its own `fix/…` branch; all nine ship on this one, the M113j precedent).
> `develop` and `main` are protected — all work and every fix stays on this branch until it merges
> via a single PR into `develop`.

## 0. Objective & scope

Nine rows from the `v0.9.0` smoke programme (`smoke/DEFECTS.md`) share one shape: the CLI writes
something — a comment, a manifest entry, a Kubernetes probe, an ignore rule, a log configuration —
that is wrong for the project it writes it into, and the developer only finds out when the project
fails. Each row gets the smallest fix that makes the generated output true, plus a test that drives
the REAL generated output (not a hand-written fixture of it — `adopt`'s tests passed for months
because their fixture still carried a `main.ts` shape the CLI stopped emitting at X4-10).

- **In scope:** V9-8, V9-17, V9-38, V9-39, V9-9, V9-11, V9-42, V9-67, V9-81 — as decided in §3.
- **NOT this milestone:** the other CLI guidance rows (M113i); emitting a `decorators:` arm or any
  other edit INTO an existing `setu.config.ts` (M101g narrowed what the CLI edits in that file to a
  language it can decide; this letter prints a line, it does not edit); a typed bound-address on
  `IHttpAdapter.listen` (`ServerHandle` stays opaque — §3.9); a `dev.ts` port rewrite for adopted
  full-stack projects (§9).

**Package-list correction** (the M70b/M70g/M70k precedent): the ROADMAP row names `cli`, `runtime`,
`logger-plugin`, `kernel`. `logger-plugin` needs **no source change** — its `requestLogging` default
stays `false` (changing a released default is not a fix-letter decision); the scaffold opts in
instead (§3.9). Its README gains one sentence. `common` is not touched.

## 1. Contracts verified from SOURCE (not names)

| Reference                             | Source (file:line)                                                                               | Verified surface / fact                                                                                                                                                                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generatorMode`                       | `packages/cli/src/utils/generator-mode.ts:22-23`                                                 | `plugins.has('decorator-plugin') ? 'class-based' : 'functional'` — nothing about a starter.                                                                                                                                                                                                     |
| `g service` class comment             | `packages/cli/src/schematics/service.ts:75-77`                                                   | Claims `setu.config.ts` passes `APP_SERVICES` to `DecoratorPlugin` "so this class needs no further wiring". Also module doc `:14-16`, inline `:125-128`.                                                                                                                                        |
| `SERVICES_SEAM` / barrel header       | `packages/cli/src/seams/services.ts:71-95, 187-196`                                              | `exports: [APP_SERVICES_EXPORT]`, `requiresPlugin: 'decorator-plugin'`; header via `seamHeader(…, ['DecoratorPlugin({ services: [...APP_SERVICES] })'])`.                                                                                                                                       |
| `seamHeader`                          | `packages/cli/src/seams/seam-spec.ts:256-273`                                                    | Prints "`setu.config.ts` consumes it as:" + the wiring lines + "If you scaffolded this project before this seam existed, add those lines".                                                                                                                                                      |
| `SeamSpec`                            | `packages/cli/src/seams/seam-spec.ts:16-69`                                                      | Internal (not in `packages/cli/src/index.ts`): `schematic`, `dir`, `suffix`, `importSymbols`, `barrel`, `exports`, `requiresPlugin?`, `renderBarrel`.                                                                                                                                           |
| Decorator seams                       | `seams/http.ts:212` (`APP_CONTROLLERS`, `REGISTER_ROUTES`), `seams/ingress.ts:40-62`             | Three decorator-gated seams: services, controllers, ingress handlers.                                                                                                                                                                                                                           |
| Starter detection                     | `packages/cli/src/commands/add.ts:249-269, 426-429`                                              | `STARTER_ARMS` (`createRestApp`/`createMicroserviceApp`/`createFullStackAppFromConfig`) and a PRIVATE `composingStarter(source)`; `FULL_STACK_ARMS` maps `decorator-plugin` → `decorators`.                                                                                                     |
| Starter registers `DecoratorPlugin`   | `packages/starters/rest-starter/src/app.ts:99`, `options.ts:108`                                 | Always `DecoratorPlugin(options.decorators)`; `decorators?: DecoratorPluginOptions`; inherited by microservice and full-stack options.                                                                                                                                                          |
| `DecoratorPluginOptions` members      | `packages/decorator-plugin/src/plugin/decorator-plugin.ts:75`                                    | `services`, `controllers`, `ingress` (and `modules`).                                                                                                                                                                                                                                           |
| `generate` post-write hook            | `packages/cli/src/commands/generate.ts:417, 505-525`                                             | Reads config via `readConfigModule` already (`legacyRegistrarNotice`); prints post-write lines (migration note) after `writeFiles`.                                                                                                                                                             |
| NATS transport arm                    | `packages/cli/src/workspace/transport.ts:383-410`                                                | `messagingArgs: (c) => \`{ broker: 'nats', url: ${c} }\``; compose comment says a server without `-js` "refuses the stream creation" (implies the broker creates it).                                                                                                                           |
| `NatsMessagingOptions.streamSubjects` | `packages/messaging-plugin/src/interfaces/index.ts:554-577`                                      | No default, no catch-all; absent + stream absent → `JetStreamStreamError` at startup; an existing stream is never touched. Stream name default `'MESSAGING'` (`nats-broker.ts:240`).                                                                                                            |
| NATS RPC subjects                     | `messaging-plugin/src/brokers/request-reply-core.ts:40`, `inbox.ts:20`, README `:409-412`        | Requests on `rr.req.<topic>`, replies on `rr.inbox.<uuid>`; README's documented RPC-capable set `['orders.>', 'rr.req.orders.>', 'rr.inbox.>']`; only one stream per account may own `rr.inbox.>`.                                                                                              |
| Real NATS test uses that set          | `packages/messaging-plugin/test/integration/nats-real.test.ts:277`                               | `streamSubjects: [\`${scope}.>\`, \`rr.req.${scope}.>\`, 'rr.inbox.>']` boots and round-trips RPC against real NATS.                                                                                                                                                                            |
| adopt probe input                     | `packages/cli/src/workspace/k8s.ts:68-118, 250-268`; `commands/adopt.ts:164-174`                 | Probe kind from `member.healthProbes === true`; adopt's member record sets neither `healthProbes` nor `metricsEndpoint`, so every adopted member gets `tcpSocket` + the "no --template" comment and no Prometheus annotations.                                                                  |
| `generate app` probe input            | `packages/cli/src/commands/app.ts:668-678`                                                       | `healthProbes`/`metricsEndpoint: typeof args.flags['template'] === 'string'`.                                                                                                                                                                                                                   |
| `detectPlugins`                       | `packages/cli/src/utils/plugin-detector.ts:61` (barrel-exported)                                 | Bare `@setu-ts/*` names from `deno.json(c)` imports or `package.json` (dev)dependencies.                                                                                                                                                                                                        |
| adopt move list                       | `packages/cli/src/workspace/adopt.ts:43-67, 138`                                                 | `ADOPTED_ENTRIES` has no env file; doc `:30-42` claims it is "every entry the CLI emits", false for `.env`/`.env.example`.                                                                                                                                                                      |
| Member cwd                            | `workspace/dev-runner.ts:146,243`; `workspace/compose.ts` Dockerfile `WORKDIR`                   | Each member runs in `apps/<member>`, so `envFilePath: '.env'` reads `apps/<member>/.env`; `envFileOptional: true` makes the miss silent.                                                                                                                                                        |
| `envFilePath` reader                  | `packages/cli/src/devtool/sources.ts:1273-1277`; `templates/env-file.ts:27`                      | Regex `/\benvFilePath:\s*'([^']+)'/` over the config + `readEnvFilePath` validation.                                                                                                                                                                                                            |
| `.dockerignore`                       | `packages/cli/src/workspace/compose.ts:214-235, 456`                                             | One renderer, workspace root, `managed: true`; no env rule; Dockerfiles `COPY apps/${MEMBER}`.                                                                                                                                                                                                  |
| adopt entry matcher                   | `packages/cli/src/workspace/adopt.ts:280-309`; message `commands/adopt.ts:405-411`               | Regex `/await app\.start\(\{ port: 3000 \}\);/` only.                                                                                                                                                                                                                                           |
| Current entry                         | `packages/cli/src/templates/project-files.ts:622-651`                                            | Standalone emits `await app.start({ port: Number(runtime.env.PORT ?? '3000') });`; member emits `import { SERVICE_PORT } from '<from>';` + `port: SERVICE_PORT`. `runtime` is still used by `createRuntimeServices` and `shutdownBlock`.                                                        |
| Workers full-stack check              | `full-stack-build-files.ts:53-56, 228-239`; `project-files.ts:1363-1405, 1519-1550`              | `vite.config.ts` imports `node:fs`; Workers `types: ['@cloudflare/workers-types', 'vite/client']`, no `@types/node` devDependency; `typescript: '^5.9.2'` in the full-stack list overrides tooling `~6.0.3` (`npm-tooling.ts:26`) on EVERY npm target (merge order `:1609-1615`, `:1930-1936`). |
| `@react-router/dev@8` TS peer         | `npm view @react-router/dev@8 peerDependencies`                                                  | `typescript: "^5.1.0 \|\| ^6.0.0 \|\| ^7.0.0"` — `~6.0.3` satisfies it.                                                                                                                                                                                                                         |
| `.gitignore` / ignore lists           | `project-files.ts:1791-1810`; `npm-tooling.ts:53, 67, 98-113`; `root-settings.ts:60-71`          | Build output dir handled via one `buildOutputDir?` string; no `.react-router/` anywhere.                                                                                                                                                                                                        |
| `ws` peer                             | `packages/runtime/package.json:46-53`; `scripts/node-dependency-ranges.ts:84`                    | Optional peer `ws: ^8.18.0`; `EXTERNAL_RANGES.ws = '^8.18.0'` (the client-dependencies drift test holds `CLIENT_RANGES` to it).                                                                                                                                                                 |
| `setu add` edits                      | `packages/cli/src/commands/add.ts:714-793`                                                       | Detects the target runtime (`detectTargetRuntime`), writes only the `@setu-ts/*` dependency; no optional-peer arm exists.                                                                                                                                                                       |
| Node upgrade swallow                  | `runtime/src/adapters/node/node-http-adapter.ts:293-295, 322-358`; `node-ws-upgrader.ts:166-178` | `loadWsModule` throws a helpful `Error` (`npm install ws`); both the listener `.catch` and the handshake `catch` call `rejectRawUpgrade(socket, 500)` and log nothing. Same silence: Deno `deno-http-adapter.ts:246`, Workers `cf-http-adapter.ts:122`.                                         |
| `HttpAdapterOptions`                  | `runtime/src/adapters/shared/adapter-options.ts:18-33`; barrel `runtime/src/index.ts:14`         | Published; one member `maxBodyBytes?`; built by `RuntimePlugin.register` (`runtime-plugin.ts:204`) after `services` exist (`:182-189`).                                                                                                                                                         |
| `IRuntimeServices.reportError?`       | `common/src/runtime.ts:310`                                                                      | Last-resort JSON-line error sink (M113f); kernel pattern: logger when registered, else `reportError` (`kernel/.../application.ts:2134-2160`).                                                                                                                                                   |
| Kernel listen                         | `packages/kernel/src/application/application.ts:790-811`                                         | `await adapter.listen(port, hostname)`; no log. `ServerHandle = unknown` (`common/src/runtime.ts:27`). Deno's default serve host keeps Deno's own native "Listening on" banner (`deno-http-adapter.ts:101-103`); Node and Bun print nothing.                                                    |
| `LoggerPlugin.requestLogging`         | `packages/logger-plugin/src/plugin/logger-plugin.ts:110, 151-157`                                | Default `false`; middleware only when `true`. Since M113f the completed line reports the served status.                                                                                                                                                                                         |
| Scaffold logger wiring                | `cli/src/templates/rest.ts:38`; `rest-starter/src/app.ts:89`                                     | `{ pkg: 'logger-plugin', symbol: 'LoggerPlugin' }` (no args); the starter's `logger?` arm exists (`RestStarterOptions.logger`), full-stack's generated factory passes none.                                                                                                                     |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                                                                               | Resolution (picked side)                                                                        | Doc deliverable (same PR)                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| C1  | `k8s.ts:25-29` module doc says probes are always `tcpSocket`; the generated `k8s/README.md` says only `setu generate app` writes it and keys probes on `--template`.                                                                                   | Code: probes follow DETECTED health support (§3.4). Docs follow the code.                       | `k8s.ts` module doc and the rendered README text (also names `setu adopt`). |
| C2  | `workspace/adopt.ts:30-42` claims `ADOPTED_ENTRIES` is every entry the CLI emits.                                                                                                                                                                      | False for the dotenv pair; the list stays static and the env files are moved separately (§3.5). | Rewrite that doc comment.                                                   |
| C3  | `workspace/adopt.ts:283` says a standalone entry binds the literal `3000` (stale since X4-10).                                                                                                                                                         | Code (§3.6).                                                                                    | Rewrite the `rewriteEntryPort` JSDoc.                                       |
| C4  | `templates/registry.ts:437-440, 462-466` say `pluginSpreads`/`setupCalls` must be empty when `appFactory` is set, "enforced by a unit test across the registry"; full-stack sets `setupCalls`, and `seam-wiring.test.ts:279-302` asserts the opposite. | Code (full-stack's `setupCalls` work and are tested).                                           | Correct both JSDoc sentences, including the false test claim.               |
| C5  | Transport compose comment implies the NATS broker creates its stream unconditionally.                                                                                                                                                                  | `messaging-plugin` source: it creates it only from `streamSubjects`.                            | New comment (§3.2).                                                         |

## 3. Design decisions

### 3.1 V9-8 — a decorator barrel the config does not consume is reported, never claimed wired

- **Decision:**
  - (a) **Truthful comments.** The class comments in `schematics/service.ts` (`:75-77`, module doc
    `:14-16`, inline `:125-128`) AND `schematics/controller.ts:36-38` stop saying "needs no further
    wiring". They say the barrel is consumed by `DecoratorPlugin` — inline as
    `DecoratorPlugin({ <key>: [...<EXPORT>] })`, or through a starter's `decorators: { <key>: … }`
    arm — and that `setu generate` reports when `setu.config.ts` does not reference the barrel. The
    three decorator barrel headers (`seams/services.ts`, `seams/http.ts` class-based arm,
    `seams/ingress.ts`) get a second wiring line through `seamHeader` naming the starter form.
  - (b) **One mapping, by export.** A new internal
    `decoratorKeyFor(spec): 'controllers' | 'services' | 'ingress' | undefined` in
    `templates/seam.ts` returns the key from the spec's EXPORTS (`APP_CONTROLLERS_EXPORT` →
    controllers, `APP_SERVICES_EXPORT` → services, `INGRESS_HANDLERS_EXPORT` → ingress).
    `decoratorSeamExtras` is rewritten to use it, so there is one table (§11.1). No new `SeamSpec`
    field.
  - (c) **The report.** After a successful write, `generate` collects the barrel PATHS it wrote,
    matches each against `scanSeamSpecs(installed)` by `spec.barrel` (controller and class-based
    route share `src/controllers/index.ts`; the ingress barrel is written by five schematics), and
    for each matched spec with a `decoratorKeyFor` key, checks whether the export identifier appears
    as a whole word in `maskSourceCode(config)` (strings and comments masked, so a mention in a
    comment or a string does not count as wired). An UNCLASSIFIABLE config (`maskSourceCode` returns
    `undefined`) reports — fail toward reporting. A config that cannot be read reports nothing.
    Output goes to `deps.error`, like generate's other post-write notices: in a starter-composed
    project `<starterSymbol> owns DecoratorPlugin; merge the barrel into its decorators arm:` /
    `  decorators: { <key>: [...<EXPORT>] }` / `  import { <EXPORT> } from './<barrel>';`; otherwise
    `setu.config.ts does not reference <EXPORT>; add it to DecoratorPlugin:` /
    `  <key>: [...<EXPORT>]` / the import line. One block per unreferenced export.
  - (d) `STARTER_ARMS` and `composingStarter` move from `add.ts` to a new internal
    `src/utils/starter-arms.ts`, imported by both commands.
- **Why:** M101g limited config edits to text the CLI can classify; a starter config is outside
  that, so printing the exact line is the honest maximum. Keyed on the export identifier, it also
  catches a pre-seam inline project whose config never got the line.
- **Test home:** `test/unit/generate-unwired-seam.test.ts` (new);
  `test/unit/schematics/service.test.ts`, `controller.test.ts`;
  `test/unit/utils/starter-arms.test.ts` (new); `test/unit/seam-wiring.test.ts` (unchanged output of
  `decoratorSeamExtras`); `test/unit/commands/add.test.ts` (unchanged behaviour).

### 3.2 V9-17 — every NATS scaffold carries a stream subject set under one fixed scope

- **Decision:** the NATS `messagingArgs` emits
  `{ broker: 'nats', url: <c>, streamSubjects: ['app.>', 'rr.req.app.>', 'rr.inbox.>'] }` — the
  README's documented RPC-capable shape with the fixed scope `app`, held in one internal constant
  `NATS_STREAM_SUBJECTS` in `transport.ts`. The spec's `connection.note` says: every topic published
  through NATS must start with `app.`; the broker creates the `MESSAGING` stream with these subjects
  on first start and uses a pre-existing stream as is; a `RealtimeBackplanePlugin` on the
  `'messaging'` transport must pass `topic: 'app.realtime'` (its default `setu-ts.realtime`,
  `realtime-backplane-plugin/src/interfaces/index.ts:280`, is outside the set). The compose comment
  is corrected (C5). Standalone and workspace both change.
- **Standalone README channel:** `ResolvedHost` gains an internal
  `transportNotes?: readonly string[]`, appended by `withBrokerArgs` and `withQueueArgs` from
  `spec.connection.note` when present; `projectFiles()` renders them in the "Local transport
  services" block, wrapped by the same helper the workspace root README uses (hand-wrapping breaks
  the scaffold's own `fmt --check`, M63).
- **Why fixed and not per project:** workspace members share the one `MESSAGING` stream
  (cross-member pub/sub needs it); the first member to start creates it and later members never
  touch an existing stream, so a per-member prefix leaves the others' subjects uncaptured. The
  workspace manifest records no name to derive a shared scope from. `>` alone is refused by NATS
  (X28-2), and `*.>` overlaps `$JS.API.>`.
- **Test home:** `test/unit/workspace/transport.test.ts` (the line-70 exact-string assertion
  updated), `test/unit/broker-flags.test.ts`, `test/unit/workspace/root-files.test.ts`,
  `test/unit/templates/project-files.test.ts` (standalone note rendered). The REAL boot is a new
  case in `packages/messaging-plugin/test/integration/nats-real.test.ts` (guarded on `NATS_URL`,
  which CI sets): first `jsm.streams.find('app.x')` — if a stream already owns the subject, fail
  with a message naming it and saying to delete it (not an opaque overlap error); then the literal
  set on a fresh stream name, publish/subscribe `app.x`, request/respond on `app.y`, stream deleted
  in `finally`. It lives there rather than in the CLI because only one stream per account may own
  `rr.inbox.>` and a second package's NATS file running concurrently would collide. The CLI unit
  test pins the rendered string to the same literal.

### 3.3 V9-9 — a Workers full-stack scaffold type-checks its own Vite config; one TypeScript pin

- **Decision:** (a) the `@types/node` literal `'^24.0.0'` in `runtimeDevDependencies`
  (`project-files.ts:1525`) becomes a module constant `NODE_TYPES_RANGE`. `runtimeDevDependencies`
  and `tsconfigOptions` take the manifest (or a `hasNpmBuild` boolean); on Workers with an
  `npmBuild`, `types` adds `'node'` and the dev dependencies add `@types/node: NODE_TYPES_RANGE`.
  (b) `FULL_STACK_NPM_DEV_DEPENDENCIES.typescript` reads `NPM_TOOLING_DEV_DEPENDENCIES.typescript`
  instead of `'^5.9.2'`. This moves EVERY full-stack `package.json` to `~6.0.3`, including the Deno
  full-stack one (npm build path `:1600-1614`); `@react-router/dev@8` accepts TS 6.
- **Why:** Node types in the Worker program are the cost of one `tsconfig.json`; a second config for
  one file is more machinery than this row warrants.
- **Test home:** `test/unit/templates/project-files.test.ts` (the line-446 `types` assertion
  updated); `test/e2e/workers-install-e2e.test.ts` gains `npm run check` exiting 0 on the Workers
  full-stack scaffold; the existing Deno full-stack build e2e must stay green on `~6.0.3`.

### 3.4 V9-38 — adopt records probe support from the project's own dependencies

- **Decision:** before moving anything, `adopt` runs `detectPlugins` on the project and writes into
  the member record it persists in `setu.workspace.json`: `healthProbes` = `health-plugin` or any
  starter package (`rest-starter`, `microservice-starter`, `full-stack-starter` — each registers
  `HealthPlugin` and `MetricsPlugin` unconditionally, `rest-starter/src/app.ts:96-97`);
  `metricsEndpoint` = `metrics-plugin` or any starter. Because the values are persisted, later
  `generate app` and `ports --reallocate` re-renders keep them. The `tcpSocket` comment becomes
  "this member declares no `@setu-ts/health-plugin`, so it serves no /live or /ready"; the k8s
  README names both `setu generate app` and `setu adopt`, states the rule as "declared health
  support", and adds the caveat that a dependency does not prove registration and that custom
  `HealthPlugin` endpoints need the probe paths edited.
- **Test home:** `test/unit/adopt-command.test.ts` (probe and annotation cases per dependency set),
  `test/unit/workspace/k8s.test.ts`, and the new `test/e2e/adopt-e2e.test.ts` (§6).

### 3.5 V9-39 — adopt moves the configured dotenv pair; no dotenv file reaches an image or git

- **Decision:**
  - (a) A shared internal `configuredEnvFilePath(configSource)` in `templates/env-file.ts` (the
    regex from `devtool/sources.ts:1273` + `readEnvFilePath` validation), used by both
    `devtool/sources.ts` and `adopt`.
  - (b) `planAdoption` moves `<envFilePath>` and `<envFilePath>.example` when the config names a
    valid SINGLE-SEGMENT path (the default `.env`, or a custom `name.env`) and the file exists. A
    multi-segment path (`config/.env`) is not moved and adopt prints one line saying to move it by
    hand and add an ignore rule — because a `.gitignore` pattern containing a slash is anchored to
    its directory, so the root `.gitignore` would stop ignoring it after the move. A single-segment
    pattern is unanchored and keeps matching under `apps/<member>/`. No config or no `envFilePath` →
    nothing extra moves. The moved files ride the existing interruption rollback.
  - (c) The workspace root `.gitignore` (`root-files.ts:207-213`, written when the project had none)
    gains `.env`, `.env.*` and `!.env.example`.
  - (d) `dockerignore()` gains `**/.env`, `**/.env.*` and `!**/.env.example`, with a comment that a
    custom `--env-file` name is not covered. This also protects members created by `generate app`,
    which already keep their `.env` under `apps/<member>/`. (No `.dev.vars`: a workspace refuses
    Workers.)
- **Test home:** `test/unit/adopt-command.test.ts`, `test/unit/workspace/compose.test.ts`,
  `test/unit/workspace/root-files.test.ts`, `test/unit/env-file.test.ts`, the new adopt e2e
  (`git check-ignore apps/<m>/.env` succeeds; root `.env` absent), and
  `test/e2e/scaffold-interrupted.test.ts` (an interrupted adopt restores the env pair to the root).

### 3.6 V9-42 — adopt rewrites the entry the CLI actually emits

- **Decision:** `rewriteEntryPort` matches the start line in both shipped forms — the current
  `port: Number(runtime.env.PORT ?? '3000')` (single or double quotes, since Prettier may have run)
  or the legacy literal `3000` — and inserts the import after the `createApp` import line matched by
  regex (single or double quotes). Output for an unmodified current entry equals what
  `serveEntry(runtime, { symbol, from })` would emit modulo the import's position. If one of the two
  pieces is missing, the result is `undefined` → the existing hand-edit message (now true by
  construction).
- **Test home:** `test/unit/adopt-entry-rewrite.test.ts` drives the entry REAL `serveEntry` renders
  for deno/node/bun, plus the Prettier-formatted node output via the CLI's own `formatForTarget`;
  e2e asserts the adopted `main.ts` imports `SERVICE_PORT` and no hand-edit line is printed.

### 3.7 V9-11 — the React Router typegen directory is a generated directory

- **Decision:** `TemplateManifest.npmBuild` gains `generatedDirs?: readonly string[]`; full-stack
  sets `['.react-router']`. One internal helper `generatedOutputDirs(manifest)` returns
  `[outputDir, ...generatedDirs]` and replaces the single `buildOutputDir` string at the four
  standalone consumers: `.gitignore`, ESLint ignores, `.prettierignore`, Deno `fmt`/`lint`
  `exclude`. A workspace root `.gitignore` also gains `.react-router/` (unanchored, so it covers
  members). Members' fmt/lint excludes are NOT changed: a full-stack member has no
  `rootManifestSettings` today (`project-files.ts:1869`), a pre-existing gap recorded in §9.
- **Test home:** `test/unit/templates/project-files.test.ts`,
  `test/unit/templates/npm-tooling.test.ts` (new), `test/unit/root-settings.test.ts`,
  `test/unit/workspace/root-files.test.ts`.

### 3.8 V9-67 — `setu add websocket` declares `ws` on Node; a failed Node handshake is reported

- **Decision:**
  - (a) `CLIENT_RANGES` gains `ws: '^8.18.0'`. The `ADDABLE` value type gains an optional
    `peers?: { readonly runtimes: readonly TargetRuntime[]; readonly packages: readonly string[] }`;
    `websocket` sets `{ runtimes: ['node'], packages: ['ws'] }`. On a matching runtime `add` writes
    each missing peer into `package.json` `dependencies` at its `CLIENT_RANGES` range — **also when
    `@setu-ts/websocket-plugin` is already present**, so re-running `setu add websocket` is how an
    affected project recovers; an existing `ws` entry is never overwritten. It logs
    `added ws (the Node WebSocket server, an optional peer of @setu-ts/runtime)`.
    `setu generate ws-route` is unchanged (§9) — the runtime report below covers a project that
    never runs `add` again.
  - (b) `HttpAdapterOptions` gains
    `reportError?: (record: Readonly<Record<string, unknown>>) => void` (`@since 0.10.0`).
    `RuntimePlugin` supplies one resolved at CALL time: logger registered →
    `logger.error(msg, rest)`, else `services.reportError?.(record)`, all inside `try/catch`.
  - (c) Only the **Node handshake catch** (`node-http-adapter.ts:349-357`) reports — it is the
    server-fault path (`ws` missing, or `ws` itself throwing). `NodeHttpServerHandle` receives the
    whole `HttpAdapterOptions` object instead of its positional `maxBodyBytes` (constructor
    `(wsModule?, options?)`, internal class), and reports
    `{ level: 'error', msg: 'WebSocket handshake failed', ...serializeError(cause) }` before
    refusing, **at most once per distinct error message per handle** (a set capped at 16 entries),
    so a missing `ws` logs once, not once per upgrade. Wire behaviour (500, no body) is unchanged;
    no option → silent as today.
  - Not reported: Node's listener `.catch` and the Deno and Workers handshake catches. A client can
    trigger those (a malformed upgrade, an oversized body), so reporting them at `error` would let
    any client flood the log; they stay as they are (§9).
- **Test home:** `test/unit/commands/add.test.ts`,
  `test/unit/templates/client-dependencies.test.ts`;
  `packages/runtime/test/unit/node-http-adapter-report.test.ts` (new); the `runtime-plugin` unit
  test for the logger/`reportError` choice.

### 3.9 V9-81 — the kernel announces it is listening; scaffolds log requests

- **Decision:**
  - (a) After a successful `adapter.listen`, the kernel logs through `CAPABILITIES.LOGGER` when one
    is registered: `logger.info('Server listening', { port, hostname? })`, `hostname` only when
    supplied; for `port: 0`, `'Server listening on an ephemeral port'` with no `port` field. No
    logger → nothing. A throwing logger never fails `start()`.
  - (b) The generated configs opt in to request logging with probe traffic excluded: `REST_PLUGINS`'
    logger wiring gets
    `args: "{ requestLogging: true, excludePaths: ['/live', '/ready', '/health', '/metrics'] }"`
    (rest, class-based, microservice share it), and the full-stack factory gains
    `logger: { requestLogging: true, excludePaths: [...the same four] },`. Otherwise every kubelet
    probe in the generated manifests writes a log line. `LoggerPlugin`'s defaults are unchanged.
- **Rejected alternative:** an `HttpAdapterOptions.onListen` reporting the real bound address. It
  would give port 0 a number and replace Deno's native banner, but needs per-adapter work in Node
  (`@hono/node-server`'s listen callback), Deno and Bun for a Low row; the kernel line works on
  every runtime that has a logger. Deno prints its native banner AND this line — documented.
- **Fixtures this changes:** `test/unit/new-command.test.ts:546-552` asserts `LoggerPlugin()`; the
  `template-baseline.json` byte-identity fixture (`style-baseline.test.ts`) covers rest,
  microservice and class-based on every runtime, so every hash moves. Regenerate the baseline with
  its capture script (check its header for the current Node invocation; the `deno run` line at
  `capture-template-baseline.ts:11` is stale and is corrected in the same change).
- **Test home:** `packages/kernel/test/integration/startup-log.test.ts` (new, asserting the LOGGER
  call, never Deno's banner); `test/unit/config-module.test.ts`,
  `test/unit/full-stack-template.test.ts`, `test/unit/new-command.test.ts`;
  `test/e2e/scaffold-runs-e2e.test.ts` asserts the booted rest project's output has
  `Server listening`, a completed-request line for a normal route, and none for `/health`.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. One additive optional member on a published interface
(`HttpAdapterOptions.reportError?`). Generated output changes are behaviour changes for newly
scaffolded projects only, recorded under Changed.

| Exported symbol                                       | Kind             | Consumer / real code path that READS it                                                                       |
| ----------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `HttpAdapterOptions.reportError` (`@setu-ts/runtime`) | interface member | Read by the Node, Deno and Workers adapters in their handshake catches; supplied by `RuntimePlugin.register`. |

No CLI barrel change; `decoratorKeyFor`, `NATS_STREAM_SUBJECTS`, `ResolvedHost.transportNotes`,
`configuredEnvFilePath`, `generatedOutputDirs`, `starter-arms.ts` and `ADDABLE.peers` are internal.

### 4.1 Options — every option names its consumer

| Option                                    | Consumer                                                           | Behavior (per implementation)                                                                                     |
| ----------------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `HttpAdapterOptions.reportError`          | Node `#handleUpgradePipeline` handshake catch only (§3.8c)         | Once per distinct message per handle; absent → silent refusal as today. Deno, Workers and Bun adapters ignore it. |
| `TemplateManifest.npmBuild.generatedDirs` | `generatedOutputDirs` → gitignore, ESLint, Prettier, Deno fmt/lint | Each dir is ignored/excluded like the build output.                                                               |
| `ResolvedHost.transportNotes`             | `projectFiles()` README transport block                            | Appended by `withBrokerArgs`/`withQueueArgs` from `connection.note`.                                              |
| `ADDABLE[...].peers`                      | `runAddCommand` dependency write                                   | Written only on a listed runtime.                                                                                 |

## 5. Implementation files

| File                                                                                | Purpose                                                        |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `packages/cli/src/schematics/{service,controller}.ts`                               | §3.1 truthful comments                                         |
| `packages/cli/src/seams/{services,http,ingress}.ts`                                 | §3.1 second wiring line in headers                             |
| `packages/cli/src/templates/seam.ts`                                                | §3.1 `decoratorKeyFor`; `decoratorSeamExtras` uses it          |
| `packages/cli/src/utils/starter-arms.ts` (new)                                      | §3.1 moved `STARTER_ARMS` + `composingStarter`                 |
| `packages/cli/src/commands/add.ts`                                                  | imports starter-arms; §3.8 peers                               |
| `packages/cli/src/commands/generate.ts`                                             | §3.1 unwired-barrel report                                     |
| `packages/cli/src/workspace/transport.ts`                                           | §3.2 args, note, compose comment                               |
| `packages/cli/src/templates/broker.ts`                                              | §3.2 `transportNotes`                                          |
| `packages/cli/src/templates/project-files.ts`                                       | §3.2 README notes, §3.3 Workers types/dev deps, §3.7 gitignore |
| `packages/cli/src/templates/full-stack-build-files.ts`                              | §3.3 TS pin                                                    |
| `packages/cli/src/templates/{registry,full-stack,npm-tooling,root-settings}.ts`     | §3.7, §3.9 full-stack logger arm, C4                           |
| `packages/cli/src/templates/rest.ts`                                                | §3.9 logger args                                               |
| `packages/cli/src/templates/env-file.ts`, `packages/cli/src/devtool/sources.ts`     | §3.5 shared env-path reader                                    |
| `packages/cli/src/templates/client-dependencies.ts`                                 | §3.8 `ws`                                                      |
| `packages/cli/src/workspace/{adopt,k8s,compose,root-files}.ts`, `commands/adopt.ts` | §3.4–§3.6, §3.7 workspace gitignore, C1–C3                     |
| `packages/cli/test/fixtures/capture-template-baseline.ts`                           | §3.9 stale invocation line                                     |
| `packages/runtime/src/adapters/shared/adapter-options.ts`                           | §3.8 option                                                    |
| `packages/runtime/src/adapters/node/node-http-adapter.ts`                           | §3.8 report, options threaded to the handle                    |
| `packages/runtime/src/plugin/runtime-plugin.ts`                                     | §3.8 call-time reporter                                        |
| `packages/kernel/src/application/application.ts`                                    | §3.9 startup line                                              |

Docs: `PUBLIC_API.md` (runtime `HttpAdapterOptions.reportError`, kernel startup line), runtime,
logger-plugin (one sentence: scaffolds opt in), websocket-plugin and cli READMEs,
`docs/deployment.md` (the dotenv rule and its custom-name limit), `CHANGELOG.md` Unreleased (Fixed +
Changed entries), `docs/upgrading.md` (NATS `app.` scope for newly scaffolded projects — existing
projects keep their own stream; add the `.dockerignore` and `.gitignore` lines to an existing
workspace), ROADMAP M113h "Shipped." paragraph + Progress row `113h` ✅, `CLAUDE.md` "Current
status" entry.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

Paths under `packages/cli/test/` unless stated.

| Test file                                                                                                                                                                                       | src covered                                                                                          | Key assertions                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unit/generate-unwired-seam.test.ts` (new)                                                                                                                                                      | `generate.ts`, `templates/seam.ts`                                                                   | full-stack config + class service → arm block printed; inline config referencing `APP_SERVICES` → nothing; mention only in a comment or string → printed; unclassifiable → printed; unreadable config → nothing; class-based route (shared barrel) and an ingress schematic map to `controllers`/`ingress`. |
| `unit/utils/starter-arms.test.ts` (new)                                                                                                                                                         | `utils/starter-arms.ts`                                                                              | each starter detected; commented-out import not detected.                                                                                                                                                                                                                                                   |
| `unit/schematics/service.test.ts`, `unit/schematics/controller.test.ts`                                                                                                                         | `service.ts`, `controller.ts`, seam headers                                                          | "no further wiring" absent; both forms named.                                                                                                                                                                                                                                                               |
| `unit/seam-wiring.test.ts`                                                                                                                                                                      | `decoratorSeamExtras`                                                                                | output byte-identical to before.                                                                                                                                                                                                                                                                            |
| `unit/workspace/transport.test.ts`, `unit/broker-flags.test.ts`, `unit/workspace/root-files.test.ts`, `unit/templates/project-files.test.ts`                                                    | `transport.ts`, `broker.ts`, `project-files.ts`, `root-files.ts`                                     | exact NATS args literal; note in workspace AND standalone READMEs; root `.gitignore` env and `.react-router/` rules.                                                                                                                                                                                        |
| `messaging-plugin/test/integration/nats-real.test.ts` (new case, `NATS_URL`)                                                                                                                    | —                                                                                                    | pre-check `streams.find('app.x')`; literal set boots on a fresh stream; publish/subscribe `app.x`; RPC on `app.y`; stream deleted.                                                                                                                                                                          |
| `unit/templates/project-files.test.ts`, `unit/templates/npm-tooling.test.ts` (new), `unit/root-settings.test.ts`                                                                                | `project-files.ts`, `npm-tooling.ts`, `root-settings.ts`, `registry.ts`, `full-stack-build-files.ts` | Workers full-stack `types` includes `node`, `@types/node` present; every full-stack `package.json` has `typescript: ~6.0.3`; `.react-router/` in all four sites.                                                                                                                                            |
| `e2e/workers-install-e2e.test.ts`                                                                                                                                                               | —                                                                                                    | Workers full-stack scaffold `npm run check` exit 0.                                                                                                                                                                                                                                                         |
| `unit/adopt-command.test.ts`, `unit/adopt-entry-rewrite.test.ts`, `unit/workspace/k8s.test.ts`, `unit/workspace/compose.test.ts`, `unit/env-file.test.ts`                                       | adopt files, k8s, compose, env-file, `devtool/sources.ts`                                            | probes and annotations per detected deps, persisted in the manifest; env pair moved; multi-segment path not moved + line printed; dockerignore rules; rewrite of the REAL rendered entries (deno, Prettier-formatted node, bun) and the legacy literal; unmatched → undefined.                              |
| `e2e/adopt-e2e.test.ts` (new)                                                                                                                                                                   | —                                                                                                    | real `new --template rest` + `adopt`: `httpGet /ready`; `main.ts` imports `SERVICE_PORT`; no hand-edit line; `apps/<m>/.env` present, root `.env` absent; `git check-ignore apps/<m>/.env` succeeds.                                                                                                        |
| `e2e/scaffold-interrupted.test.ts`                                                                                                                                                              | —                                                                                                    | an interrupted adopt restores the env pair at the root.                                                                                                                                                                                                                                                     |
| `unit/commands/add.test.ts`, `unit/templates/client-dependencies.test.ts`                                                                                                                       | `add.ts`, `client-dependencies.ts`                                                                   | node: `ws` added, including when websocket-plugin is already present; deno/bun/workers: not; existing `ws` untouched; drift test still equal.                                                                                                                                                               |
| `runtime/test/unit/node-http-adapter-report.test.ts` (new), runtime-plugin unit test                                                                                                            | `node-http-adapter.ts`, `adapter-options.ts`, `runtime-plugin.ts`                                    | missing-`ws` handshake → ONE record naming `npm install ws` across two upgrades, wire still 500; no option → no throw; plugin routes to a registered logger, else `reportError`; a throwing logger is swallowed.                                                                                            |
| `kernel/test/integration/startup-log.test.ts` (new)                                                                                                                                             | `application.ts`                                                                                     | real adapter on an unused port → one `info` with the port; port 0 → ephemeral message; no logger → nothing; throwing logger → `start()` resolves.                                                                                                                                                           |
| `unit/config-module.test.ts`, `unit/full-stack-template.test.ts`, `unit/new-command.test.ts`, `style-baseline` + regenerated `fixtures/template-baseline.json`, `e2e/scaffold-runs-e2e.test.ts` | `rest.ts`, `full-stack.ts`                                                                           | logger args rendered; booted rest scaffold logs `Server listening` and a completed normal request, and no `/health` line.                                                                                                                                                                                   |

Negative controls (each observed failing, then reverted): the NATS args reverted (real-NATS case
fails with `JetStreamStreamError`); adopt detection reverted (e2e sees `tcpSocket`); the old matcher
restored (e2e sees the hand-edit line); the Node `reportError` call removed (report test fails); the
dockerignore rules removed (compose test fails); the TS/types change reverted (Workers check e2e
fails); the comment-masking dropped (the comment-mention case passes silently → test fails).

## 7. Verification gates

```bash
git branch --show-current   # fix/m113h-generated-output
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test
pnpm test:coverage          # ANSI-stripped per-file table; ≥90% every changed src file
pnpm run test:deno-lane     # runtime Deno adapter
pnpm run release:publish --dry-run
pnpm run release:verify <version>
```

## 8. Risks & mitigations

- **A leftover `MESSAGING` stream owns `rr.inbox.>` on a shared NATS** (from a booted scaffold,
  including this milestone's own verification) → the M101b RPC case and the new case would fail with
  an overlap error. The new case pre-checks and names the owning stream; verification deletes the
  scaffold's `MESSAGING` stream after booting one.
- **A scaffold e2e that needs a network-installed toolchain skips silently** → the Workers check is
  added to the existing Workers install e2e, which already fails rather than skips in CI.
- **The `app.` scope surprises an existing NATS project** → only newly scaffolded output changes;
  the upgrade guide says an existing project keeps its own stream.
- **Prettier output of `main.ts` differs from `serveEntry`'s raw text** → the matcher is a regex
  over the start line and the import line, and the test drives the formatted output.
- **The startup line duplicates Deno's native banner** → documented; both are accurate.

## 9. Out of scope

- Editing `setu.config.ts` to add a `decorators:` arm (§0; M101g's rule).
- Rewriting an adopted full-stack project's `dev.ts` port (it reads `PORT`; the dev runner sets it).
- A typed bound address from `IHttpAdapter.listen` (§3.9 rejected alternative).
- `setu generate ws-route` guidance about `ws` (§3.8: the runtime report covers it).
- Reporting client-triggerable upgrade failures (Node listener catch, Deno, Workers) — would need a
  rate-limited non-error channel.
- Fmt/lint excludes for a full-stack WORKSPACE member's build and typegen dirs (no
  `rootManifestSettings` for members today, `project-files.ts:1869`).
- Moving a multi-segment `envFilePath` during adopt (§3.5b prints the step instead).
- The M113i CLI guidance rows.

## 10. Design security review

- **V9-39 is a secret-exposure fix.** Controls: the `.dockerignore` rules (they also cover members
  from `generate app`), the root `.gitignore` rules, and moving only single-segment dotenv paths so
  the kept unanchored ignore pattern still matches. A custom `--env-file` name is not covered by the
  generic image rules — stated in the generated comment, `docs/deployment.md` and the upgrade guide.
  A multi-segment path is left in place, never silently un-ignored.
- **adopt moves one more pair of files:** the path comes from the developer's own config, validated
  by `readEnvFilePath` (no absolute, no `..`, no empty or `.` segment); it rides the existing
  interruption rollback.
- **V9-67's report** fires only on the Node handshake catch (server fault: `ws` missing or `ws`
  throwing), at most once per distinct message per handle, so a client cannot flood the log through
  it. Client-triggerable paths (malformed upgrade, oversized body) are NOT reported. The record is
  `serializeError` of the cause — the `ws` load error's message and stack, no request data — routed
  to the configured logger (with its redaction) or stderr.
- **The startup line** carries only the port and the configured hostname.
- **The NATS subject set** captures only `app.>`, `rr.req.app.>` and `rr.inbox.>` — never a
  catch-all.

A committed-tree security audit is required (V9-39 changes what reaches a container image and git),
run by a fresh Claude agent per `.roo/skills/security-audit/SKILL.md`.
