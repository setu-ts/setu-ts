# Milestone 139d — The CLI on a full-stack project (`cli` + `kernel` message + docs)

> **Status:** Complete. Branch: `feat/m139d-cli-full-stack`. `develop` and `main` are protected, so
> all work, including fixes, stays on this one branch until it merges through a single PR into
> `develop`.

## 0. Objective & scope

ROADMAP M139d's CLI rows from the `0.12.0` review and regression runs (`smoke/V0120-REVIEW.md`,
`smoke/V0120-REGRESSION.md`, `smoke/X87-X93-FINDINGS.md`, `smoke/X57-FINDINGS.md`). They share one
shape: on a full-stack project the CLI writes, adds or advises something that does not match how
that project is wired, so a recipe passes every gate and then fails at boot, or an agent following
the brief does the wrong thing. The two regressions (V12-42, V12-47) go first.

- **Regressions:** V12-42 (a `--module` route collides with another module at boot), V12-47 (the
  telemetry preload wraps the app's own `.tsx` files).
- **Runtime and dev entries:** V12-46 (a page 500 logs no stack or request id), V12-24 (no plain
  startup line), V12-48 (a taken `VITE_PORT` is an uncaught Vite stack), V12-44 (the devtool says
  the connector did not start when it did), V8-14 (the kernel's duplicate-plugin hint), V12-12
  (`setu build` cannot ship a worker-pool task).
- **`setu add`:** V12-2 (`mcp`), V12-3 (full-stack never inserts a zero-config plugin), V12-25 (one
  package per run), V12-26 (`view` has no capability-only path), V12-27 (no backend peer for `mail`,
  `database`, `vector-store`), V12-28 (`database` writes no migration scripts), V12-30
  (`exceptions`), V12-33 (`g job` on a `--queue redis` full-stack project).
- **Generated text and gates:** V12-1 (an `--agents` scaffold fails its own `format:check`), V12-22,
  V12-23 (the full-stack brief), V12-16 (barrel headers), V12-31 (`g middleware` JSDoc), V12-32
  (W001 on ordinary literals), V12-43, V12-45, X91-1 (same-named adoption on full-stack), X93-3 (the
  download cause chain).

- **In scope:** the rows above, their tests, CHANGELOG entries, and the docs each row's behaviour
  change touches (`docs/cli.md`, `packages/cli/README.md`, the AGENT_CARDs named in §3, the
  worker-pool README).
- **NOT this milestone:**
  - **X91-9** is already fixed: PR #537 (`c1b7f52dc`, CHANGELOG `[0.12.0]`) writes `REDIS_URL` and
    prints a headed `Connection:` line (`packages/cli/src/commands/add.ts:2105-2181`). It is dropped
    from M139d and closes on a published re-run (C1).
  - **A `setu check` finding for an installed but unregistered plugin** (V12-2's side note): no such
    finding exists for any plugin (`packages/cli/src/diagnostics/ids.ts:5-28`). Registered as its
    own DEFECTS row, not built here.
  - **The documentation batch** (M139e), apart from the doc lines this milestone's behaviour changes
    make false.

## 1. Contracts verified from SOURCE (not names)

| Reference                         | Source (file:line)                                                                                               | Verified surface / fact                                                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full-stack module mount           | `packages/cli/src/schematics/module-full-stack.ts:161`                                                           | a module's own routes mount at `router.group('/api/${kebab}')`; the scaffold's products module owns `/api/products` (`templates/full-stack-module-files.ts:109`)                         |
| `--module` route/controller mount | `schematics/http-module.ts:28`, `schematics/controller.ts:37`, `schematics/sse.ts:36`                            | mounts at `/<m>/<name>` (SSE `/<m>/sse/<name>`) on every template                                                                                                                        |
| Page-shadow base                  | `commands/generate.ts:497-502`, refusal text `:516-517`                                                          | computes `/api/<name>` for `module`, `/<m>/<name>` otherwise; the refusal recommends the colliding recipe                                                                                |
| Class-based full-stack module     | `schematics/module.ts:48-56`, `templates/module-files.ts:250`                                                    | full-stack module shape only when `!classBased`; class-based mounts at `@Controller('/<name>')`                                                                                          |
| Telemetry preload                 | `templates/telemetry-preload.ts`; written at `templates/project-files.ts:2315`                                   | `register('@opentelemetry/instrumentation/hook.mjs', import.meta.url)` with no options                                                                                                   |
| iitm `register` data              | `node_modules/.pnpm/import-in-the-middle@3.5.3/.../create-hook.mjs:140-160, 390-406, 447-457, 719-723`           | `initialize(data)` applies `data.include`/`exclude` (bare specifier, file URL, RegExp); builtins also match `node:` forms; `onWrapFailure` prints the warning                            |
| Telemetry instrumentation kinds   | `packages/telemetry-plugin/src/interfaces/index.ts:44`, `plugin/telemetry-plugin.ts:65-68`                       | `http`, `fetch`, `ioredis`, `redis`, `amqplib`, `kafkajs`; fetch uses `diagnostics_channel` (no hook)                                                                                    |
| `handleError` template            | `templates/full-stack-app-files.ts:161-171`                                                                      | logs `error('SSR request failed', { path, error: describeError(error) })`                                                                                                                |
| `describeError`                   | `packages/common/src/errors/describe-error.ts:51`                                                                | one line `name: message (classifiers) <- cause…`, URL userinfo masked, no stack                                                                                                          |
| `IRequestContext.id`              | `packages/common/src/http.ts:383`                                                                                | `readonly id: string`, the id logger-plugin's request logger uses                                                                                                                        |
| `maskUrlUserinfo`                 | `packages/common/src/index.ts:379`                                                                               | exported; masks `user:pass@` in URLs inside a string                                                                                                                                     |
| Load context                      | `packages/react-router-plugin/src/handler/load-context.ts:28-35`; template arm `templates/full-stack.ts:141-149` | sets services, resolver, user only; the template's `populateLoadContext` adds session and CSRF keys                                                                                      |
| Entry renderers                   | `templates/project-files.ts:691-728` (`serveEntry`), `templates/full-stack-build-files.ts:384-450`               | nothing printed after `app.start`; Vite `createServer`/`listen` run outside `boot()`'s `.catch`                                                                                          |
| `IApplication.start`              | `packages/common/src/plugin.ts:422-427, 467`                                                                     | `start(options?: { port?, hostname? }): Promise<void>`; no address returned                                                                                                              |
| Deno banner                       | `packages/runtime/src/adapters/deno/deno-http-adapter.ts:101-103`                                                | Deno prints its own listening line unless `onListen` is passed                                                                                                                           |
| Vite strict port                  | `node_modules/.pnpm/vite@8.3.5…/dist/node/chunks/node.js:14641-14670`                                            | `strictPort` throws `Error('Port N is already in use')`, no `code`                                                                                                                       |
| Devtool boot text                 | `devtool/dev-entry.ts:148-156`, recognition `:197-219`                                                           | prints "…The connector did not start." for every boot failure; `devEntryVariants` recognises CLI renderings by exact text                                                                |
| Duplicate plugin error            | `packages/kernel/src/registry/plugin-resolver.ts:106-117`                                                        | throws `Error("Duplicate plugin name '<n>'. To replace a plugin, register the replacement's services with { override: true } …")`                                                        |
| `setu build` entries              | `commands/build.ts:163-165, 186-200`                                                                             | entries `main.ts` + `src/migrations/run.ts`; esbuild `bundle`, `esm`, `node22`, `outdir: 'dist'`, `outbase: '.'`                                                                         |
| esbuild and `new URL`             | probe, esbuild 0.28                                                                                              | `new URL('./src/tasks/a.task.ts', import.meta.url)` is left verbatim; an extra entry `src/tasks/a.task.ts` emits `dist/src/tasks/a.task.js`                                              |
| Node worker host                  | `packages/runtime/src/adapters/node/node-worker-host.ts:63-65`                                                   | `new Worker(new URL(specifier))` for `file:` URLs; no extension mapping                                                                                                                  |
| `ZERO_CONFIG_WIRINGS`             | `commands/add.ts:293-327`; `registrationLine` `:380-427`; `withPluginWiring` `:1180-1236`                        | `{ symbol }` only; emits `${symbol}()`; no mcp arm; returns `undefined` on a starter config (`:1205`)                                                                                    |
| `McpPlugin`                       | `packages/mcp-plugin/src/plugin/mcp-plugin.ts:38`                                                                | `McpPlugin(options: McpPluginOptions)`: a required argument, every field optional                                                                                                        |
| Full-stack config shape           | `templates/full-stack.ts:272-276`, `templates/seam.ts:193-196`                                                   | after `createFullStackAppFromConfig(...)`: `registerModules(...)` then `for (const generated of GENERATED_PLUGINS) app.register(generated);` in every full-stack scaffold                |
| Starter arms                      | `utils/starter-arms.ts:22-74` (`STARTER_ARMS`, `FULL_STACK_ARMS` `:48-62`)                                       | package → starter option arm, for every starter                                                                                                                                          |
| One-package refusal               | `commands/add.ts:1600-1607`                                                                                      | `add takes one package; got N` exit 2                                                                                                                                                    |
| View setup                        | `commands/add.ts:2217-2239`; `commands/add-view.ts:55-246`                                                       | refuses a modular project without `--module`; always plans examples, controller, Tailwind, StaticPlugin                                                                                  |
| `Prompter`                        | `packages/cli/src/prompt.ts:40`; `cli.ts:276-282`                                                                | `select` prompt; `new` receives `deps.ask`, `add` does not                                                                                                                               |
| Client ranges                     | `templates/client-dependencies.ts:21-52`                                                                         | `CLIENT_RANGES` pins Redis/broker clients; `withPeerDependencies` (`add.ts:1882`) writes them                                                                                            |
| Backend peers                     | `packages/mail-plugin/package.json`, `database-plugin/package.json`, `vector-store-plugin/package.json`          | all `optional: true`; mail smtp `nodemailer`, ses `@aws-sdk/client-sesv2`; database drizzle `drizzle-orm`, mongodb, dynamodb, cosmos, bigtable SDKs; vector-store pgvector `drizzle-orm` |
| Mail provider option              | `packages/mail-plugin/src/interfaces/index.ts:39, 231-235`                                                       | `provider?: 'log' \| 'smtp' \| 'ses' \| 'sendgrid'`                                                                                                                                      |
| `withClientScripts`               | `commands/add.ts:1086-1130`                                                                                      | writes `client` scripts only when absent and logs `left … unchanged`                                                                                                                     |
| drizzle-kit CLI                   | orm.drizzle.team docs (generate, migrate, config file); `npm view drizzle-kit version` = `0.31.11`               | `drizzle-kit generate`, `drizzle-kit migrate`; `drizzle.config.ts` default path; `defineConfig` from `drizzle-kit`; `dialect` + `schema` required; postgres `dbCredentials: { url }`     |
| Prisma 7 config                   | `packages/database-plugin/test/fixtures/prisma.config.ts`; README `:764-772`; `npm view prisma dist-tags`        | datasource `url` lives in `prisma.config.ts` (P1012 in schema); `latest` is `8.0.0-rc.33`, `prev` `7.10.1`, so pin `^7.10.0`                                                             |
| `exceptions` not addable          | `commands/add.ts:178-262` (`ADDABLE`); rule `agents/rules.ts:78-83`                                              | absent from `ADDABLE`; Rule `errors` `applies: () => true`                                                                                                                               |
| Full-stack package imports        | `templates/full-stack.ts:240-258`; `frameworkPackages` `templates/project-files.ts:1132-1158`                    | no `exceptions`; a no-symbol entry is pinned but not imported                                                                                                                            |
| Queue arm on full-stack           | `templates/broker.ts:173-188`; `seams/jobs.ts:44-53`; `commands/generate.ts:377-405`; `schematics/job.ts:65-70`  | sets the redis literal only; job seam gated on `queue-plugin`; `g job` refuses without the package; the job imports a type from `@setu-ts/queue-plugin`                                  |
| Workspace member queue            | `packages/cli/src/workspace/member-host.ts:155-198`                                                              | sets `queue: { ...queueOptions(config) }` without the package                                                                                                                            |
| Brief rendering                   | `agents/render.ts:25, 103-104, 115-116, 131, 153-154`; check `commands/agents.ts:236-240`                        | no blank line around markers; padded-less tables; `--check` compares bytes                                                                                                               |
| Deno fmt settings                 | `templates/root-settings.ts:31-36`                                                                               | no `proseWrap`, so `deno fmt` defaults to `always`                                                                                                                                       |
| Brief budget                      | `packages/cli/test/unit/agents/budget.test.ts`                                                                   | 13312-byte cap; full brief 12877 bytes unformatted, 19040 once Prettier pads tables                                                                                                      |
| Installed set                     | `agents/facts.ts:79`; `utils/plugin-detector.ts:61-79`; `agents/not-installed.ts:35-44`                          | direct deps only; every `ADDABLE` not in it is "Not installed"                                                                                                                           |
| Rule 11                           | `agents/rules.ts:118, 124`                                                                                       | "Loaders use service context keys from setu.config.ts"; scaffold uses `getService(context, TOKEN)` (`templates/full-stack-app-files.ts:569`)                                             |
| Barrel headers                    | `seams/jobs.ts:14, 24-26`; `seams/plugins.ts:49-51, 63`; `seams/seam-spec.ts:284-301`                            | fixed text naming `QueuePlugin(...)` and `createApplication({ plugins })`                                                                                                                |
| Middleware JSDoc                  | `schematics/middleware.ts:100-107`                                                                               | names `app/middleware/`; the example is `app/server/require-user.server.ts`                                                                                                              |
| W001 lexer                        | `devtool/sources.ts:550-646`; `diagnostics/wiring.ts:10-31`; `diagnostics/modules.ts:66`; `diagnose.ts:313-330`  | stops on the first backtick, `/`, `\`, non-ASCII, computed access; one stop makes the whole file unclassifiable                                                                          |
| Strict-mask consumers             | `utils/modular-registration.ts:89`, `module-declaration.ts:96`, `module-switch.ts:223`, `starter-arms.ts:87`     | automatic edits and the devtool rely on the strict lexer                                                                                                                                 |
| Workers devtool comment           | `templates/project-files.ts:617-618`; `runtime/src/diagnostics/local-diagnostics-listener.ts:15-19, 51-58`       | comment says "Deno-only"; the listener supports Deno and Node                                                                                                                            |
| k8s README flags                  | `workspace/k8s.ts:313-315`; `commands/workspace-ops.ts:99, 116`                                                  | flag list omits `--pull-secret <name>` (repeatable)                                                                                                                                      |
| Adoption on full-stack            | `utils/module-switch.ts:314-320`; `generate.ts:602`; `seams/modules.ts:98-108`                                   | any same-named adoption refused on full-stack; the index registers the service only when the scan admits `<m>.token.ts`                                                                  |
| Download cause                    | `examples/new.ts:37-50, 176`; `packages/create/src/bin.ts`                                                       | reads `cause.cause` only, appends `.`; `create` only calls `runMain(['new', …])`                                                                                                         |
| undici proxy 403 chain            | measured, Node 24.22.1 / undici 7.30.1                                                                           | `TypeError fetch failed` → `DOMException Request was cancelled.` → `RequestAbortedError Proxy response (403) !== 200 when HTTP Tunneling` (`UND_ERR_ABORTED`)                            |
| X91-9 already fixed               | `commands/add.ts:2105-2181`; CHANGELOG `[0.12.0]` (PR #537)                                                      | headed `Connection: REDIS_URL …`, written to the declared env file and its example                                                                                                       |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                             | Resolution (picked side)                                        | Doc deliverable (same PR)                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| C1  | ROADMAP M139d lists X91-9; the source and CHANGELOG `[0.12.0]` show it fixed by #537                                                 | the source; X91-9 leaves M139d and closes on a published re-run | ROADMAP M139d section: drop X91-9 with a "fixed in 0.12.0 by #537" note                                                |
| C2  | `docs/cli.md:416-418, 620` and the `generate.ts:516-517` refusal give the colliding `g module api` + `g route … --module api` recipe | §3.1's mount                                                    | `docs/cli.md` recipe and mount sentence; the refusal text; `packages/cli/README.md` where it states route paths        |
| C3  | `packages/cli/README.md:830` says "twelve" zero-config providers; `ZERO_CONFIG_WIRINGS` has 20 (21 with mcp)                         | the source                                                      | README count, plus the full-stack insertion sentence from §3.10                                                        |
| C4  | worker-pool, idempotency, view and mcp AGENT_CARDs say `add` inserts only into a functional `setu.config.ts`                         | §3.10: full-stack inserts too                                   | the four cards' _Add it_ lines                                                                                         |
| C5  | `worker-pool-plugin/README.md:76-79` and its AGENT_CARD give a task specifier that `setu build` cannot ship                          | §3.8                                                            | worker-pool README "Building with `setu build`", AGENT_CARD, `docs/cli.md` build section, `apps/worker-pool/README.md` |
| C6  | `docs/cli.md:229-230` quotes "The connector did not start."                                                                          | §3.6's wording                                                  | `docs/cli.md`                                                                                                          |
| C7  | `database-plugin/AGENT_CARD.md:3-4` says add `DatabasePlugin(...)`, duplicating the starter's on a starter-composed project          | the starter arm                                                 | one sentence on the card: with a starter, set its `database` option                                                    |

## 3. Design decisions

### 3.1 V12-42: a `--module` route mounts under its module's base (regression, maintainer's choice)

- **Decision:** one helper, `moduleRouteBase(module, plugins)` in `packages/cli/src/schematics/`,
  returns `/api/<m>` on a functional full-stack project
  (`plugins.has('react-router-plugin') && generatorMode(plugins) !== 'class-based'`) and `/<m>`
  elsewhere. `http-module.ts`, `controller.ts` (class branch), `sse.ts` (`<base>/sse/<name>`),
  `module-full-stack.ts` and the `generate.ts` page-shadow base all call it, which also fixes the
  class-based full-stack shadow base. Module names are unique (E016), so two modules' routes cannot
  collide by construction, and no collision scanner is added. The refusal text and C2's docs carry
  the new recipe: `setu g module orders` gives `/api/orders`, `setu g route summary --module orders`
  gives `/api/orders/summary`. The docs note that a static `/api/<m>/<name>` beats the module's own
  `/api/<m>/:id` (M22's static-over-param rule).
- **Why:** M130 put module controllers under `/api/<m>`; the `--module` generators were not moved,
  so the guide's recipe collides at boot.
- **Test home:** `test/unit/generate-page-collisions.test.ts` (rewrite `:114`, `:127`, `:131-136`);
  `test/e2e/full-stack-modules-e2e.test.ts` (add `g route summary --module articles`, boot, request
  `/api/articles/summary` and `/api/products`).

### 3.2 V12-47: the preload hooks only the instrumented modules (regression)

- **Decision:** the preload passes `{ data: { include: [...] } }` to `register`, with the list
  `http`, `https`, `ioredis`, `redis`, `@redis/client`, `@node-redis/client`, `amqplib`, `kafkajs`.
  The list is one exported constant in `templates/telemetry-preload.ts`, and a unit test holds it as
  data against telemetry-plugin's instrumentation kinds and the module names each OTel
  instrumentation hooks.
- **Why:** with no include list import-in-the-middle wraps every ESM import, including the app's
  `.tsx` views it cannot parse. The dynamic `createAddHookMessageChannel` form would need
  `import-in-the-middle` as a direct project dependency and an acknowledgement after
  telemetry-plugin registers its hooks, which the preload cannot wait for.
- **Test home:** `test/integration/telemetry-preload-real.test.ts` (guarded real test): import a
  local `.tsx` and assert no `failed to wrap` on stderr; keep the `ioredis` positive control; add an
  `http` span positive control. `test/unit/telemetry-preload.test.ts` for the text and the data
  table.

### 3.3 V12-46: a page 500 logs a masked stack and the request id

- **Decision:** the full-stack context-keys module gains
  `requestIdContext = contextKeyFor<string | null>('app.request-id', null)`; the template's
  `populateLoadContext` sets it from `ctx.id`; `handleError` logs
  `{ path, requestId, error: describeError(error), stack }`, where `stack` is
  `maskUrlUserinfo(error.stack)` for an `Error` with a stack and the key is omitted otherwise.
- **Why:** this matches the exceptions `errorHandler`, which masks before logging; passing the raw
  `Error` would reach the logger unmasked.
- **Test home:** `test/unit/full-stack-template.test.ts:341-348` (text);
  `test/e2e/full-stack-wiring-e2e.test.ts` (a throwing loader: the log carries `requestId` and
  `stack`, and a URL password in the message is masked).

### 3.4 V12-24: a plain startup line from the generated entries

- **Decision:** templates only, no kernel change. After a successful `boot()`, `serveEntry`,
  `renderFullStackDevEntry` and the devtool `renderEntry` print
  `Listening on http://localhost:<port>/` with `console.log`. The line is not emitted on Deno, whose
  runtime already prints its own banner; the full-stack dev entry has its runtime threaded in for
  that.
- **Why:** every generated entry binds a known non-zero port, so the address is known at render
  time; an `onListen` contract would change `common`, `kernel` and `runtime` for a line the
  templates can print.
- **Test home:** `test/unit/start-scripts.test.ts`, `test/unit/templates/project-files.test.ts`
  (text); `test/e2e/scaffold-runs-e2e.test.ts:729` (the booted output contains the line on Node);
  template baseline fixtures recaptured.

### 3.5 V12-48: a taken `VITE_PORT` is a named refusal

- **Decision:** `renderFullStackDevEntry` wraps `createServer` and `listen` in `try`/`catch`; on
  failure it closes the server if created, prints
  `Startup failed: Vite could not listen on <port> (VITE_PORT): <describeError>` and a remedy that
  names `VITE_PORT` for a standalone project and `setu.workspace.json` for a workspace member
  (decided at render time), then exits 1. The message is not parsed.
- **Why:** the listen runs outside `boot()`'s guarded path.
- **Test home:** the dev-entry unit text test; `test/e2e/full-stack-dev-ports-e2e.test.ts` (occupy
  `VITE_PORT`: exit 1, output names `VITE_PORT`, no `at ` stack line).

### 3.6 V12-44: the devtool boot failure says what is true

- **Decision:** the text becomes
  `setu devtool: startup failed: <describeError>. The application did not start, and the connector is not running.`
  The 0.12.0 rendering is added to `devEntryVariants` as a recognised previous rendering. C6 updates
  `docs/cli.md`.
- **Why:** the sentence holds whether or not the connector bound, so no branching is needed.
- **Test home:** `test/unit/dev-entry.test.ts:166-176`; `test/e2e/devtool-e2e.test.ts` (app port
  taken: new sentence present, "did not start" absent).

### 3.7 V8-14: the duplicate-plugin error names the starter case

- **Decision:** kernel-only wording:
  `Duplicate plugin name '<n>': it is registered twice. A starter (createRestApp, createMicroserviceApp, createFullStackApp, createFullStackAppFromConfig) may already include it; configure it through the starter's option instead of registering it again. To replace a plugin's services, register them with { override: true } under a different plugin name.`
  The stale literal in
  `packages/multi-tenancy-plugin/test/unit/multi-tenancy-plugin.test.ts:426-431` is updated.
- **Why:** the kernel cannot know which starter registered a plugin without a provenance contract in
  `common`, which is too much for one message.
- **Test home:** `packages/kernel/test/unit/plugin-resolver.test.ts:89-91` (assert the starter
  sentence).

### 3.8 V12-12: `setu build` builds and rewrites worker-pool tasks (maintainer's choice)

- **Decision:** before bundling, `setu build` scans the bundle's source files for the literal
  `new URL('<relative>.task.ts', import.meta.url)`; each target becomes an extra esbuild entry
  (landing at `dist/<path>.task.js` under `outbase: '.'`), and an esbuild `onLoad` plugin rewrites
  each literal to the `.js` path relative to the bundle that contains it. esbuild runs `onLoad` once
  per module per build, and `setu.config.ts` is bundled into both `dist/main.js` and
  `dist/src/migrations/run.js` (the runner boots the app), so one rewrite cannot be right for both:
  `setu build` therefore runs one esbuild build per entry: `main.ts`, the migrations runner when
  present, and each task module (a task can reference another task through a shared helper), each
  build with its own rewrite base, which is that entry's output directory. All outputs stay in
  memory and pass the existing development-import gate before `dist/` is replaced, as today. A
  `*.task.ts` reference that is not a string literal fails the build with a message naming the file
  and line. `--dry-run` lists the task outputs. Bun and Deno images run source, so nothing changes
  there; `setu build` is Node-only.
- **Why:** the source specifier stays identical in development and production, the way Vite treats
  workers, and the README example keeps working.
- **Test home:** `test/unit/build-command.test.ts` (injected `deps.bundle`: entries include the
  task, rewritten text, non-literal refusal, dry-run listing); `test/e2e/build-e2e.test.ts` (a
  scaffold running a task through `WorkerPoolPlugin` after `setu build`).

### 3.9 V12-2: `add mcp` prints `McpPlugin({})` and when it can boot

- **Decision:** `IPluginWiring` gains `args?: string` (default empty), used by `registrationLine`,
  `withPluginWiring` and §3.10's insert. `mcp-plugin` is NOT in `ZERO_CONFIG_WIRINGS`:
  `registrationLine` gains an `mcp-plugin` arm printing `McpPlugin({})` with the note that the app
  boots with it only once at least one route is marked with `mcpTool()` or `@McpTool()`. The mcp
  AGENT_CARD says the same.
- **Why:** `McpPlugin` takes a required options argument, so `McpPlugin()` would not type-check; and
  `packages/mcp-plugin/src/compile/discovery.ts:53-54` throws
  `MCP requires at least one tool at bootstrap.`, so inserting it into an app with no marked route
  would break the app's next start.
- **Test home:** `test/unit/commands/add.test.ts` (`add mcp` changes no config and prints
  `McpPlugin({})` with the tool note; `args` drives `withPluginWiring` for a fixture wiring);
  `test/integration/zero-config-wirings.test.ts` (generalised to `[factory, args]`; mcp not in the
  table).

### 3.10 V12-3: full-stack inserts a zero-config plugin after the factory

- **Decision:** `withFactoryRegistration(source, bare, args)` in `add.ts`, used when the config
  composes `createFullStackAppFromConfig` and the starter does not own the arm. It finds exactly one
  masked-code match of the CLI-emitted
  `for (const generated of GENERATED_PLUGINS) app.register(generated);` inside the factory and
  inserts `app.register(<Symbol>(<args>));` on its own line above it at the same indent, with the
  import. It reuses the existing refusals (provider binding, specifier count, existing reference,
  barrel import plan); any doubt prints today's guidance. C3 and C4 update the README and cards.
- **Why:** the loop is a single CLI-emitted anchor in every full-stack config; the factory call has
  no `plugins` option.
- **Test home:** `test/unit/commands/starter-wiring-output.test.ts` (scaffold full-stack,
  `add worker-pool`, the line and import inserted, output type-checks; storage keeps the arm
  guidance); `test/unit/commands/add.test.ts` (alias, existing use, two loop lines → guidance).

### 3.11 V12-25: `setu add` takes several packages (maintainer's choice)

- **Decision:** every name is resolved and validated before any write (unknown names, duplicates by
  alias, runtime restrictions, the react-router refusal). Each per-package flag must apply to at
  least one listed package, else it is refused before any write; a flag applies to every listed
  package it fits. The body becomes `addOne(bare, …)`, run in the given order, each re-reading the
  disk; each package's output is headed `@setu-ts/<pkg>:`; one `Next:` install command and one
  agents hint print at the end. On a failure it stops and reports
  `added a, b; stopped at c; d not attempted`. `--dry-run` previews each package against the disk as
  it stands.
- **Why:** `add` is idempotent, so re-running after a stop is safe.
- **Test home:** `test/unit/positional-refusal.test.ts` and the X18-1 case in
  `test/unit/commands/add.test.ts` (now "adds both"); new cases for a misapplied flag and an unknown
  second name refused before the first is written; a mid-run failure report.

### 3.12 V12-26: `add view --plugin-only`

- **Decision:** a boolean `--plugin-only` pins `view-plugin` and its `hono` peer and wires
  `ViewPlugin()` (inline, or §3.10 on full-stack); it writes JSX compilerOptions only where
  compatible, otherwise prints the pragma note; it skips the example files, controller and
  registration, Tailwind, CSS scripts, StaticPlugin, `.gitignore` and the module refusal.
  `--plugin-only` with `--module` is refused. On a `createFullStackAppFromConfig` project the
  plugin-only path is the default, since pages belong to React Router there.
- **Why:** mail templates need the capability without a views controller.
- **Test home:** `test/unit/add-view.test.ts`; `test/unit/commands/add.test.ts` (modular project
  with `--plugin-only` writes only manifest and config, exit 0);
  `test/unit/commands/starter-wiring-output.test.ts` (full-stack default).

### 3.13 V12-27: `add mail|database|vector-store` records the chosen backend's peer

- **Decision:** flags named after each plugin's option: `--provider` (mail:
  `log|smtp|ses|sendgrid`), `--type` (database:
  `memory|drizzle|prisma|mongodb|dynamodb|cosmos|bigtable`), `--adapter` (vector-store:
  `memory|pgvector|qdrant`). On a TTY with no flag, `add` asks through `Prompter.select`
  (`AddCommandDependencies` gains an optional `ask`, supplied by `src/main.ts` only when stdin is a
  terminal, exactly as `new` receives it, and threaded through `cli.ts`); without a TTY, or with
  `--yes`, the default arm is used (`log`, `memory`, `memory`). A `BACKEND_PEERS` table (plugin →
  arm → peers) feeds `peerPackages`; ranges come from new `CLIENT_RANGES` entries, and a unit test
  asserts each equals the plugin's own `peerDependencies`. `add` never writes backend config: it
  prints the arm's registration line (added to `test/fixtures/registration-lines.ts` so it
  type-checks) and names app-side packages that are not plugin peers (`pg`, `@prisma/client`,
  `@prisma/adapter-pg`) in the printed install command without recording them. For mail a bare
  `MailPlugin()` is inserted only for `log`.
- **Why:** the maintainer's proposed fix; every non-default arm needs app-owned objects or
  credentials, so config cannot be written honestly.
- **Test home:** `test/unit/commands/add.test.ts` (per-arm peer pin on npm and Deno, default arm
  without a TTY and with `--yes`, unknown value refused, a hand-pinned peer kept);
  `test/unit/templates/client-dependencies.test.ts` (range equality); `test/unit/flags.test.ts`.

### 3.14 V12-28: `add database` writes migration scripts for its backend

- **Decision:** `withDatabaseScripts`, modelled on `withClientScripts`, never overwrites a script.
  - **drizzle** (Node, Bun): scripts `db:generate: drizzle-kit generate`,
    `db:migrate: drizzle-kit migrate`; devDependency `drizzle-kit` `^0.31.11`; a create-only
    `drizzle.config.ts` using `defineConfig` from `drizzle-kit` with `dialect` from
    `--dialect postgresql|mysql|sqlite` (default `postgresql`),
    `schema: './src/database/schema.ts'`, `out: './drizzle'` and
    `dbCredentials: { url: process.env.DATABASE_URL ?? '' }`.
  - **prisma:** scripts `db:generate: prisma generate`, `db:migrate: prisma migrate dev`,
    `db:deploy: prisma migrate deploy`; devDependency `prisma` `^7.10.0`; a create-only
    `prisma.config.ts` with `schema`, `migrations.path` and `datasource.url` from `DATABASE_URL`,
    following `packages/database-plugin/test/fixtures/prisma.config.ts`, pointing at
    `prisma/schema.prisma`.
  - Neither schema file is written: the drizzle table module and the Prisma schema (with its
    generator output path) are the application's, per the database README's Prisma 7 setup. `add`
    prints the path each config expects and links that README section.
  - **memory, mongodb, dynamodb, cosmos, bigtable:** no scripts.
  - **Deno:** scripts are printed, not written. **Workers (D1):** none.
  - The brief and the database README gain one line separating schema migrations (these scripts)
    from data migrations (`setu g migration`, `src/migrations/run.ts`).
- **Why:** the maintainer's expected behaviour (2026-11-08).
- **Test home:** `test/unit/commands/add.test.ts` beside the sdk client-scripts block (written once,
  an existing script kept, config create-only, none for mongodb, printed on Deno); a type-check of
  the written `drizzle.config.ts` against drizzle-kit's own `defineConfig` types (drizzle-kit added
  as a `packages/cli` devDependency for that test); `test/unit/agents/gather-facts.test.ts`.

### 3.15 V12-30: `exceptions` is a direct dependency of full-stack and addable

- **Decision:** full-stack's `packageImports` gains `{ pkg: 'exceptions' }` (pinned, not imported);
  `ADDABLE` gains `exceptions` (manifest only, no registration line); Rule `errors` applies only
  when `exceptions` is installed.
- **Why:** the brief tells agents to import a package the scaffold reaches only by hoisting.
- **Test home:** `test/unit/full-stack-template.test.ts`; `test/unit/commands/add.test.ts`;
  `test/unit/agents/rule-blocks.test.ts` (absent on minimal, present on full-stack).

### 3.16 V12-33: `new --queue redis` on full-stack writes the queue package and the job seam

- **Decision:** the `withQueueArgs` starter branch, for a non-memory queue, adds `queue-plugin` to
  the framework packages, emits the jobs seam barrel, and sets `processors: [...QUEUE_PROCESSORS]`
  in the arm (the same literal `setu add queue` writes). Workspace full-stack members get the same
  in `workspace/member-host.ts`. `g job` is unchanged.
- **Why:** relaxing `g job` alone would generate an import that resolves only by hoisting.
- **Test home:** `test/unit/broker-flags.test.ts` (manifest, `src/jobs/index.ts`, processors); a
  `generate job` case after `new --queue redis`; `test/unit/full-stack-options-typecheck.test.ts`;
  `test/e2e/full-stack-broker-e2e.test.ts` gains a `g job` step and boot.

### 3.17 V12-1: the brief survives the project's formatter

- **Decision:** `render.ts` writes a blank line after `BRIEF_BEGIN` and before `BRIEF_END` and
  renders its tables as lists; the generated `deno.json` `fmt` block gains `proseWrap: "preserve"`;
  `setu agents --check` and the writer compare the section with whitespace runs collapsed, and the
  writer leaves a file whose normalised section is equal untouched.
- **Why:** Prettier-padded tables exceed the 13312-byte budget; lists need no padding and pass both
  formatters.
- **Test home:** `test/unit/agents/render-brief.test.ts` (real Prettier with the scaffold's options
  leaves `renderBrief` and `renderWorkspaceRoot` output unchanged); `budget.test.ts`;
  `test/unit/agents/check-mode.test.ts` (a formatted brief: `--check` exits 0, `agents` reports
  unchanged); `test/e2e/scaffold-runs-e2e.test.ts` adds `--agents` to one npm template and the Deno
  template, then runs `format:check` / `deno fmt --check` and `agents --check --strict`.

### 3.18 V12-22 and V12-16 (card half): the brief names starter-provided plugins

- **Decision:** packages in the composing starter's `STARTER_ARMS` entry leave "Not installed" and
  are listed under one heading, "Provided by `@setu-ts/<starter>`: configure its option in
  setu.config.ts; never `setu add` or register a second instance. Some options are off until
  configured.", which also states that a card's _Add it_ line does not apply to them. Rule 4's gate
  counts only the remaining list.
- **Why:** the starter registers them; `setu add` already uses `STARTER_ARMS` for the same purpose.
- **Test home:** `test/unit/agents/render-brief.test.ts` (full-stack: `queue` under the starter
  heading, not under Not installed); `test/unit/agents/rule-blocks.test.ts`; `budget.test.ts`.

### 3.19 Generated text: V12-23, V12-16 (barrels), V12-31, V12-43, V12-45

- **Decision:**
  - **V12-23:** Rules 11 (`full-stack`, `full-stack-workers`) say loaders resolve services with
    `getService(context, TOKEN)` from `@setu-ts/react-router-plugin`, and context keys carry only
    non-service values such as the session and CSRF token.
  - **V12-16:** the jobs and plugins barrel headers name both forms (the plugin call and the
    starter's `queue: { processors: [...] }` option; `createApplication({ plugins })` and the
    full-stack `app.register` loop). `test/fixtures/redis-develop-outputs.json` gets delta entries.
  - **V12-31:** the middleware JSDoc names `app/server/require-user.server.ts`.
  - **V12-43:** the Workers config says the devtool's diagnostics listener runs only on Deno and
    Node.
  - **V12-45:** `k8s/README.md` lists `--pull-secret <name>` (repeatable, an existing registry
    Secret in the namespace).
- **Test home:** `test/unit/agents/rule-blocks.test.ts`; `test/unit/seam-wiring.test.ts`;
  `test/unit/node-redis-cli.test.ts` deltas; `test/unit/schematics/middleware.test.ts:65`;
  `test/unit/config-module.test.ts`; `test/unit/k8s-manifest.test.ts:108-118`.

### 3.20 X91-1: controller-only adoption on full-stack

- **Decision:** on full-stack, an adopted same-named controller is used and the generated controller
  and its two tests are not written; `types`, `service`, `token`, `index` and the page are. An
  adopted same-named service is still refused, with the reason (the token and index import
  `<P>Service` and `<camel>Service`). The CHANGELOG `[0.12.0]` explanation line gains an Unreleased
  counterpart.
- **Test home:** `test/unit/generate-module-switch.test.ts:117-124` (split into the two cases);
  `test/unit/generate-module-command.test.ts` (full-stack fixture with
  `src/controllers/orders.controller.ts`: `check` and a type-check pass).

### 3.21 V12-32: a check-only reference mask

- **Decision:** a new `diagnostics/reference-mask.ts` used only by `diagnostics/wiring.ts`,
  `diagnostics/modules.ts:66` and `diagnose.ts:313`. It masks template literals (substitutions
  scanned as code with a brace-depth stack), regex literals (a regex after `( , = : [ ! & | ? { ;`,
  `return`, `typeof` or at the start; division after an identifier, number, `)` or `]`; a `/` after
  `}` is undecidable, since a block and an object literal both end there) and escapes. It still
  stops, and W001 still fires, on `eval`, `Function`, `require`, dynamic `import(`, `globalThis`,
  `self`, `window`, `Reflect`, `Proxy` and the reflection identifiers, computed member access, a
  backslash in code, non-ASCII code, unterminated source, and any regex-versus-division case the
  rule cannot decide. `devtool/sources.ts` and every automatic edit keep the strict lexer unchanged.
- **Why:** the strict lexer is security-audited and guards edits; a read-only check can be more
  tolerant without widening what is edited.
- **Test home:** `test/unit/reference-mask.test.ts` (nested `${}`, a regex in an array, division, a
  backtick in a substitution, each stop construct still stops); `test/unit/check-wiring.test.ts`
  (both repros → `wired`; a symbol only inside a template string part → `unwired`);
  `test/unit/check-command.test.ts` (no W001 for the repro config).

### 3.22 X93-3: the download error reads the deepest cause

- **Decision:** `examples/new.ts` walks `.cause` (depth bound 8, cycle guard, the existing
  `AggregateError` first-member rule at each level), takes the deepest non-empty message and the
  deepest string `code`, strips one trailing `.`, masks it with `maskUrlUserinfo`, and prints
  `Cause: <message> (code <code>).`. `packages/create` needs no change.
- **Test home:** `test/unit/examples.test.ts` (the measured three-level proxy chain, a cyclic cause,
  a credentialed URL masked; existing two-level cases unchanged).

### 3.23 CHANGELOG

One Unreleased entry per row (Fixed for the defects; Added for multi-package `add`, `--plugin-only`,
`--provider`/`--type`/`--adapter`/`--dialect`/`--yes`, task builds). V12-42's entry says a
`--module` route on functional full-stack now mounts at `/api/<m>/<name>`.

### 3.24 Review round 1 amendments (supersede the sections they name)

The code review of `5349c4072` found defects, four of them in this plan's own design. Where this
section and an earlier one disagree, this section holds.

- **§3.5:** only `listen()` failures get the `VITE_PORT` message; a `createServer` failure (a
  `vite.config.ts` or plugin error) prints a plain `Startup failed: <describeError>` and exits 1.
- **§3.8 discovery and rewrite agree:** the rewrite plugin is the source of truth. Any task literal
  `onLoad` rewrites whose target is not among the built task entries fails the build by file and
  line (a target outside the project is refused the same way). Build inputs are read with a plain
  file read, not the 1 MiB inspection reader, and neither discovery nor `onLoad` applies
  `assertInsideProject` to files it only scans, so a large or symlinked source no longer fails a
  project. The scanner skips template-literal contents and regex literals, and refuses a `.task.ts`
  occurrence only in a `new URL(` or `import` position.
- **§3.9 `args` is removed:** no zero-config wiring needs arguments, so `IPluginWiring.args` and the
  `wiring` parameter on `withPluginWiring` are deleted; the `mcp-plugin` registration line is a
  fixed string. The unreachable `backendLine` branch inside the messaging/queue arm goes too.
- **§3.10:** the factory insert is refused (today's guidance printed) whenever the plugin's
  arguments come from a transport or workspace arm, since those reference the starter callback's
  `config`; and when the insert succeeds, the "Register it after the factory returns" note is not
  printed.
- **§3.12:** on a project whose tsconfig has `jsx: "react-jsx"` with no `jsxImportSource` and a
  React dependency, `add view` leaves compilerOptions alone and prints the pragma note; on
  full-stack, `--module` is refused by name.
- **§3.13:** on a starter-composed project, a backend choice prints the starter arm form
  (`mail: { provider: 'smtp', options: { … } }`, `database: { type: …, options: … }`), never a
  second plugin registration.
- **§3.14:** `drizzle.config.ts` and `prisma.config.ts` load the env file `setu.config.ts` declares
  (`envFileDeclaration`, default `.env`) with `process.loadEnvFile` when that file exists, so the
  `db:*` scripts see `DATABASE_URL` as the app's other scripts do. The schema hint names the README
  section for the chosen arm.
- **§3.14 dialects (CodeRabbit review of PR #582):** `--dialect` is `postgresql|sqlite`, not
  `mysql`: the Drizzle adapter writes through `RETURNING`, which MySQL lacks, and refuses
  synchronous drivers, so the app-owned client printed is `pg` or `@libsql/client`.
- **§3.17:** the section ends with exactly one newline in every write path: `spliceBrief` consumes
  the line terminator after `BRIEF_END` when it replaces a section and adds none after a section
  that already ends with one.
- **§3.18 heading:** "Provided by `@setu-ts/<starter>`: configure its option in setu.config.ts
  (`setu add <name>` edits that option where it supports the starter); never register a second
  instance." The "never `setu add`" wording was wrong: `setu add queue` and `setu add messaging`
  write the starter's own option, and Rule 12 says so.
- **§3.19 V12-43:** the Workers JSDoc is one sentence wrapped under 100 columns.
- **§3.21 regex rule:** a `/` after `!` (a TypeScript non-null assertion may precede division) and
  after `)` (a control head's `)` may precede a regex) is undecidable and stops; `default` and
  `extends` join the keywords after which a regex follows.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. No exported symbol of any package changes; the kernel change is
an error message, and the CLI's changes are to generated output and commands.

| Exported symbol | Kind | Consumer / real code path that READS it                                  |
| --------------- | ---- | ------------------------------------------------------------------------ |
| None            | —    | `packages/cli/src/index.ts` and `packages/kernel/src/index.ts` unchanged |

### 4.1 Options — every option names its consumer

| Option                   | Consumer                                        | Behavior (per implementation)                               |
| ------------------------ | ----------------------------------------------- | ----------------------------------------------------------- |
| `setu add` several names | `runAddCommand` → `addOne`                      | §3.11                                                       |
| `--plugin-only`          | `add view` path                                 | §3.12; refused with any other package unless view is listed |
| `--provider`             | `add mail` → `BACKEND_PEERS`, registration line | §3.13                                                       |
| `--type`                 | `add database` → peers, §3.14 scripts           | §3.13, §3.14                                                |
| `--adapter`              | `add vector-store` → peers                      | §3.13                                                       |
| `--dialect`              | `add database --type drizzle` config file       | §3.14; refused with any other type                          |
| `--yes`                  | the §3.13 prompt                                | skips the prompt, takes the default arm                     |
| `IPluginWiring.args`     | removed (§3.24)                                 | —                                                           |

## 5. Implementation files

| File                                                                                                                                              | Purpose                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `packages/cli/src/schematics/module-route-base.ts` (new)                                                                                          | §3.1 helper                                                                  |
| `schematics/http-module.ts`, `controller.ts`, `sse.ts`, `module-full-stack.ts`                                                                    | §3.1 callers                                                                 |
| `commands/generate.ts`                                                                                                                            | §3.1 shadow base and refusal text                                            |
| `templates/telemetry-preload.ts`                                                                                                                  | §3.2                                                                         |
| `templates/full-stack-app-files.ts`, `templates/full-stack.ts`                                                                                    | §3.3, §3.15                                                                  |
| `templates/project-files.ts`                                                                                                                      | §3.4 (`serveEntry`), §3.19 V12-43                                            |
| `templates/full-stack-build-files.ts`                                                                                                             | §3.4, §3.5                                                                   |
| `devtool/dev-entry.ts`                                                                                                                            | §3.4, §3.6                                                                   |
| `packages/kernel/src/registry/plugin-resolver.ts`                                                                                                 | §3.7                                                                         |
| `commands/build.ts`, `build/task-entries.ts` (new)                                                                                                | §3.8 scan, extra entries, `onLoad` rewrite                                   |
| `commands/add.ts`, `commands/add-view.ts`, `commands/add-database.ts` (new)                                                                       | §3.9–§3.15                                                                   |
| `templates/client-dependencies.ts`                                                                                                                | §3.13 ranges, §3.14 `drizzle-kit`, `prisma`                                  |
| `packages/cli/package.json`, `pnpm-lock.yaml`                                                                                                     | §3.14 test-only devDependency `drizzle-kit` `0.31.11` (published 2026-09-21) |
| `packages/multi-tenancy-plugin/test/unit/multi-tenancy-plugin.test.ts`                                                                            | §3.7 stale duplicate-plugin literal (test only)                              |
| `constants.ts`, `flags.ts`, `cli.ts`                                                                                                              | §3.11–§3.14 flags, `ask` for `add`                                           |
| `templates/broker.ts`, `workspace/member-host.ts`                                                                                                 | §3.16                                                                        |
| `agents/render.ts`, `agents/brief-file.ts`, `commands/agents.ts`                                                                                  | §3.17                                                                        |
| `templates/root-settings.ts`                                                                                                                      | §3.17 `proseWrap`                                                            |
| `agents/not-installed.ts`, `agents/rules.ts`                                                                                                      | §3.15, §3.18, §3.19 V12-23                                                   |
| `seams/jobs.ts`, `seams/plugins.ts`                                                                                                               | §3.19 V12-16                                                                 |
| `schematics/middleware.ts`, `workspace/k8s.ts`                                                                                                    | §3.19 V12-31, V12-45                                                         |
| `utils/module-switch.ts`                                                                                                                          | §3.20                                                                        |
| `diagnostics/reference-mask.ts` (new), `diagnostics/wiring.ts`, `modules.ts`, `diagnose.ts`                                                       | §3.21                                                                        |
| `examples/new.ts`                                                                                                                                 | §3.22                                                                        |
| Docs: `docs/cli.md`, `packages/cli/README.md`, AGENT_CARDs, worker-pool README, `apps/worker-pool/README.md`, database README, ROADMAP, CHANGELOG | §2 C1–C7, §3.23                                                              |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                                                                                                                             | src covered                                                                                   | Key assertions                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `test/unit/generate-page-collisions.test.ts`                                                                                                                                                                                          | `module-route-base.ts`, `generate.ts`, schematics                                             | §3.1 paths on full-stack, REST, class-based full-stack        |
| `test/e2e/full-stack-modules-e2e.test.ts`                                                                                                                                                                                             | §3.1                                                                                          | boot answers `/api/articles/summary` and `/api/products`      |
| `test/unit/telemetry-preload.test.ts`, `test/integration/telemetry-preload-real.test.ts`                                                                                                                                              | `telemetry-preload.ts`                                                                        | §3.2 list as data; no wrap warning; ioredis and http controls |
| `test/unit/full-stack-template.test.ts`, `test/e2e/full-stack-wiring-e2e.test.ts`                                                                                                                                                     | `full-stack-app-files.ts`, `full-stack.ts`                                                    | §3.3, §3.15                                                   |
| `test/unit/start-scripts.test.ts`, `test/unit/templates/project-files.test.ts`, `test/e2e/scaffold-runs-e2e.test.ts`                                                                                                                  | `project-files.ts`, `full-stack-build-files.ts`                                               | §3.4, §3.17 e2e                                               |
| dev-entry unit test, `test/e2e/full-stack-dev-ports-e2e.test.ts`                                                                                                                                                                      | `full-stack-build-files.ts`                                                                   | §3.5                                                          |
| `test/unit/dev-entry.test.ts`, `test/e2e/devtool-e2e.test.ts`                                                                                                                                                                         | `dev-entry.ts`                                                                                | §3.4, §3.6                                                    |
| `packages/kernel/test/unit/plugin-resolver.test.ts`                                                                                                                                                                                   | `plugin-resolver.ts`                                                                          | §3.7                                                          |
| `test/unit/build-command.test.ts`, `test/unit/build-task-entries.test.ts`, `test/e2e/build-e2e.test.ts`                                                                                                                               | `build.ts`, `build/task-entries.ts`                                                           | §3.8                                                          |
| `test/unit/commands/add.test.ts`, `test/integration/zero-config-wirings.test.ts`, `test/unit/commands/starter-wiring-output.test.ts`, `test/unit/positional-refusal.test.ts`, `test/unit/add-view.test.ts`, `test/unit/flags.test.ts` | `add.ts`, `add-view.ts`, `add-database.ts`, `flags.ts`, `constants.ts`, `cli.ts`              | §3.9–§3.15                                                    |
| `test/unit/templates/client-dependencies.test.ts`                                                                                                                                                                                     | `client-dependencies.ts`                                                                      | §3.13 range equality with each plugin's `peerDependencies`    |
| `test/unit/broker-flags.test.ts`, `test/unit/full-stack-options-typecheck.test.ts`, `test/e2e/full-stack-broker-e2e.test.ts`                                                                                                          | `broker.ts`, `member-host.ts`                                                                 | §3.16                                                         |
| `test/unit/agents/render-brief.test.ts`, `check-mode.test.ts`, `rule-blocks.test.ts`, `budget.test.ts`, `gather-facts.test.ts`                                                                                                        | `render.ts`, `brief-file.ts`, `agents.ts`, `not-installed.ts`, `rules.ts`, `root-settings.ts` | §3.14, §3.15, §3.17–§3.19                                     |
| `test/unit/seam-wiring.test.ts`, `test/unit/node-redis-cli.test.ts`                                                                                                                                                                   | `seams/jobs.ts`, `seams/plugins.ts`, `k8s.ts`                                                 | §3.19                                                         |
| `test/unit/schematics/middleware.test.ts`, `test/unit/config-module.test.ts`, `test/unit/k8s-manifest.test.ts`                                                                                                                        | `middleware.ts`, `project-files.ts`, `k8s.ts`                                                 | §3.19                                                         |
| `test/unit/generate-module-switch.test.ts`, `test/unit/generate-module-command.test.ts`                                                                                                                                               | `module-switch.ts`                                                                            | §3.20                                                         |
| `test/unit/reference-mask.test.ts`, `test/unit/check-wiring.test.ts`, `test/unit/check-command.test.ts`                                                                                                                               | `reference-mask.ts`, `wiring.ts`, `modules.ts`, `diagnose.ts`                                 | §3.21                                                         |
| `test/unit/examples.test.ts`                                                                                                                                                                                                          | `examples/new.ts`                                                                             | §3.22                                                         |

Every row's new test must fail without its fix; the hand-back records each mutation.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m139d-cli-full-stack
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run check:docs
pnpm test:coverage packages/cli packages/kernel packages/multi-tenancy-plugin --no-tooling   # per-file ≥90%, ANSI-stripped
pnpm run ci:local --shard cli   # the scaffold-boot e2e, on the final commit
pnpm run test:tooling
pnpm run test:deno-lane
pnpm run release:publish --dry-run
pnpm run release:verify 0.12.0
```

## 8a. Design security review

- **Assets:** the developer's source tree and `dist/` (what `setu build` reads and writes); the
  credentials a URL, stack or error cause can carry into a log or the terminal; the correctness of
  the edits the CLI makes to `setu.config.ts` and member configs.
- **Attackers and inputs:** a hostile or merely unusual project file the CLI reads (a
  `setu.config.ts` with exotic syntax or a crafted `envFilePath`, a task specifier pointing outside
  the project, a symlinked source, a very large or semicolon-free source); hostile flag values and
  package names on `setu add`; an error chain with throwing getters, cycles or credentials in a URL;
  a hostile workspace display value reaching `AGENTS.md`.
- **Trust boundary, the reference mask:** §3.21 adds a lexer next to the security-audited devtool
  lexer. The new mask is read-only: it decides what `setu check` reports, never an edit. The strict
  lexer is unchanged, and every automatic edit keeps it, including the `setu workspace broker|rpc`
  decision whether a member reads its transport module, which calls `strictlyCalledOutsideImports`
  (audit F2). A property named like a keyword is a value before `/` (audit F1).
- **`setu build` (§3.8):** a task target outside the project, a symlinked target, a target that was
  not built, and a non-literal task reference are each refused by file and line; every output path
  passes `assertInsideProject`; the development-import gate runs over every entry's build before
  `dist/` is replaced. Scan-only reads use a plain read with no size cap (a source is the
  developer's own), and the scanner is linear on semicolon-free sources (audit F3).
- **Data leaving the process:** §3.3 logs a stack and §3.22 prints a cause; both pass through
  `maskUrlUserinfo`, and the cause walk escapes terminal controls and stops at cycles, depth 8 and a
  throwing getter or revoked Proxy.
- **Generated configs:** §3.14's config files read `DATABASE_URL` from the environment, contain no
  credential, and load only an `envFilePath` inside the project (anything else falls back to
  `.env`).
- **Accepted risk, audit F4:** `drizzle-kit` 0.31.11 (the `packages/cli` test devDependency and the
  range `setu add database --type drizzle` pins) depends on `esbuild@0.18.20`, which carries
  GHSA-67mh-4wv8-2f99 (moderate: the esbuild development server answers cross-origin requests).
  drizzle-kit never starts esbuild's development server, the dependency is development-only, and
  `pnpm run audit:ci` passes it; it is accepted until a drizzle-kit release drops `@esbuild-kit`.
- **Audit:** a committed-tree security audit by a fresh Claude agent per
  `.roo/skills/security-audit/SKILL.md`, before the PR merges.

## 8. Risks & mitigations

- **Many rows, one CLI:** the fixtures `redis-develop-outputs.json` and the template baselines pin
  generated text. → Recapture with deliberate-delta entries, never a blind regenerate.
- **The scaffold-boot e2e is slow and contends with other suites.** → Run `ci:local --shard cli`
  once on the final commit, checking first that no other suite or M139b's benchmark is running.
- **§3.8's rewrite misses a task form.** → Only the literal form is supported, and every other
  `*.task.ts` reference fails the build by name.
- **§3.17 changes a brief already on disk.** → The writer's normalised comparison leaves a formatted
  file alone.

## 9. Out of scope

- X91-9 (fixed by #537; closes on a published re-run).
- A `setu check` finding for installed but unregistered plugins (new DEFECTS row).
- `createRestApp`/`createMicroserviceApp` configs for §3.10: no template emits them.
- Plain full-stack `g job` without a queue: `setu add queue` remains the path.
- The M139e documentation batch.
