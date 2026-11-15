# Milestone 140d — What the generators write, and the agent brief (`@setu-ts/cli`)

> **Status:** Planning. Branch: `feat/m140d-generator-output`. `develop` and `main` are protected,
> so all work, including fixes, stays on this one branch until it merges through a single PR into
> `develop`.

## 0. Objective & scope

ROADMAP M140d: the generator and agent-brief rows of the 2026-11-12/13 generated-code review
(`smoke/GENERATED-CODE-REVIEW.md`, read on `develop` `1fa2996b9`; every claim below re-checked
against `develop` `9ea4972f7`, after M140a and M140b merged). Each row is something `packages/cli`
writes or prints that teaches the wrong thing, wires nothing, or goes stale. Every fix lands in the
generator, the command output, or the brief renderer; no framework package changes.

- **In scope (29 rows):**
  - **`setu add` output:** V12-62 (`add validation` registers nothing), V12-70 (a Redis store makes
    the offline tests need Redis, and nothing says so), V12-82 (`add database` writes no
    `DATABASE_URL`), V12-100 (Redis comments describe messaging and workspace members).
  - **`setu generate` output:** V12-65 (`g schema` emits a shape that accepts everything and says
    nothing), V12-84 (event handler hides in-process, at-most-once delivery), V12-85 framework half
    (`g job` gives no `setu add queue` hint), V12-86 (command and event names follow two
    conventions), V12-87 (`g middleware` sends `X-<Name>: true`), V12-95 (class-based module state
    outside DI), V12-96 (`g service --module` tells the user to do what it did), V12-97 (an
    `@Inject` comment blames Deno), V12-99 (dead fallbacks in the module service), V12-101
    (`generate` rejects `--yes`).
  - **Template output:** V12-73 (microservice transports are in-memory or no-op, silently), V12-78
    (README claims DI validation everywhere), V12-79 framework half (README's
    `generate service billing` is refused once modules exist), V12-81 (failed shutdown silent
    without a logger), V12-94 framework half (README does not say `/metrics`, `/docs`,
    `/openapi.json` are on the app port), V12-98 (`setu.config.ts` JSDoc names a `main.dev.ts` that
    may not exist).
  - **Full-stack output:** V12-89 (login comment points at APIs an action cannot use), V12-90
    (module errors hand-built), V12-91 (React in both dependency lists), V12-92 framework half (nav
    and guard comments go stale after `g module --page`), V12-93 (module unit test duplicates its
    e2e and binds a port).
  - **Agent brief and devtool:** V12-125 (brief goes stale after `generate`/`sync`/`devtool`, and
    nothing says so), V12-126 (full-stack Rule 5 names `validateBody` from a package the project
    does not depend on), V12-127 (Node devtool `dev` ignores `.env` and the preload), V12-128 (the
    brief omits the devtool files and that `dev` needs the launcher). Plus M140a's hand-down: the
    brief's `start` gloss for a Deno full-stack project (its `start` now refuses without a build).
- **NOT this milestone:**
  - **Application halves** of V12-79, V12-85, V12-92, V12-94 (README "What it serves" upkeep,
    validating job data, nav entries and `returnTo`, exposure policy): `smoke/PRODUCT-DEFECTS.md`.
  - **V12-77, V12-83, V12-88:** the application's (maintainer, 2026-11-13). V12-88's framework lever
    (a sign-out recipe in auth-plugin's README) is M140e.
  - **Images, Compose, Kubernetes, workspace gRPC:** M140c (in parallel on
    `feat/m140c-deploy-output`). **Documentation pages** (`docs/`, READMEs, agent cards, website):
    M140e. This milestone ships the CHANGELOG entry and the generated text itself.
  - **A Noop-mode warning from `TelemetryPlugin` itself** (V12-73's framework-package half): not a
    `cli` change; recorded as a follow-up in §9.

## 1. Contracts verified from SOURCE (not names)

All paths are under `packages/` unless absolute.

| Reference                           | Source (file:line)                                                                                                                                                                | Verified surface / fact                                                                                                                                                                                                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ZERO_CONFIG_WIRINGS`               | `cli/src/utils/plugin-wirings.ts:17-38`                                                                                                                                           | Map `pkg → { symbol }` of 20 providers, no `validation-plugin`. Read by `add.ts:376,387,683,1210` (`registrationLine` returns `${symbol}()` first) and by W006 `unregisteredPluginFindings` (`diagnostics/wiring.ts:135-155`), which skips packages a composing starter's arm owns.              |
| `ValidationPlugin`                  | `validation-plugin/src/plugin/validation-plugin.ts:80`                                                                                                                            | `ValidationPlugin(options?: ValidationPluginOptions)`: no required option. The rest template registers it with `{ errorFormat: 'rfc9457' }` (`cli/src/templates/rest.ts:55`); minimal registers none.                                                                                            |
| Starter arms                        | `cli/src/utils/starter-arms.ts:21-40`                                                                                                                                             | `validation-plugin` is a REST arm (`validation`), so W006 never fires on starter-composed projects for it.                                                                                                                                                                                       |
| `g module` validators               | `cli/src/schematics/module.ts:55`                                                                                                                                                 | Emits schemas and `validateBody` when `validation-plugin` is in the detected set (manifest), independent of registration.                                                                                                                                                                        |
| `g schema`                          | `cli/src/schematics/schema.ts:5-23`; registry `schematics/registry.ts:160`                                                                                                        | Writes `${dir}/${kebab}.schemas.ts` with `z.object({})`; gated on `validation-plugin`. No output beyond the write lines.                                                                                                                                                                         |
| `validateBody` binding              | `cli/src/agents/rules.ts:61-64`                                                                                                                                                   | The brief's functional rule: "Bind const body = validateBody(S); use body as middleware, read body.value(ctx)" — applied on `style === 'functional'` alone.                                                                                                                                      |
| Zod version                         | `cli/src/commands/generate.ts:793-795`                                                                                                                                            | Projects install `zod@^4.6.6`; Zod 4 has `z.strictObject`.                                                                                                                                                                                                                                       |
| `generate` post-write output        | `cli/src/commands/generate.ts:782-826`                                                                                                                                            | After the write: the Zod install hint (`module`/`schema`), adoptions, wiring findings, declaration advice, the class-based `Inject it with @Inject(...)` line. The place for V12-65/V12-85/V12-125 hints.                                                                                        |
| `generate` flags                    | `cli/src/flags.ts:170-213` (`GENERATE`, `GENERATE_CUSTOM`, `GENERATE_APP`, `GENERATE_LIBRARY`); unknown-flag text `flags.ts:565`                                                  | None lists `yes`/`y`; `NEW` (`:138-166`) and `ADD` (`:225-243`) do. `generate` never prompts.                                                                                                                                                                                                    |
| `createTestApp`                     | `testing/src/test-app.ts:156-193`                                                                                                                                                 | With `app`, applies `without` (plugin names, each must exist) then `overrides`, then starts. A generated test passes neither (`cli/src/templates/project-files.ts:2265-2276`, `schematics/test-harness.ts:216-220`).                                                                             |
| Redis arm wiring in `add`           | `cli/src/commands/add.ts:1563-1600` (`defaultArm`, `transportAddArgs`); env writes `add.ts:2585-2610`                                                                             | Cache/scheduler/backplane/messaging/queue/idempotency arms write a Redis URL read and `REDIS_URL` into the env file and its example; the log names the connection only.                                                                                                                          |
| Redis text                          | `cli/src/workspace/transport.ts:271-272` (compose healthcheck comment), `cli/src/templates/broker.ts:228-240` (`brokerEnvVariables`)                                              | "Members wait on this: the messaging plugin connects during registration" and "Where the ${name} transport connects" are emitted for every Redis consumer, a single cache-only project included.                                                                                                 |
| `add database` config               | `cli/src/commands/add-database.ts:67-104` (`databaseConfig`)                                                                                                                      | Drizzle and Prisma configs read `process.env.DATABASE_URL ?? ''`; nothing writes the variable. `add` already writes generated env variables for auth/session (`add.ts:2426-2470`, `withEnvVariable` at `:2952`) with the env-file resolution there.                                              |
| Microservice wirings                | `cli/src/templates/microservice.ts:26-45`                                                                                                                                         | `MessagingPlugin()`, `QueuePlugin()` (memory), `TelemetryPlugin()` (no exporter), `ServiceDiscoveryPlugin({ provider: 'static', services: {} })`. The README's transport section appears only with a broker.                                                                                     |
| README renderer                     | `cli/src/templates/project-files.ts:2143-2175`                                                                                                                                    | "Generate code" prints `generate service billing` (`:2147`); Node Production prints "…DI graph validation happens at boot" unconditionally (`:2160`).                                                                                                                                            |
| `generate service` refusal          | `cli/src/commands/generate.ts:426-431`                                                                                                                                            | "This project uses modules; pass --module <name>" once `src/modules/` exists. `g module` (`registry.ts:151`) is ungated and mode-aware.                                                                                                                                                          |
| `main.ts` shutdown                  | `cli/src/templates/project-files.ts:733,751,810-830`                                                                                                                              | `describeError` is imported; startup logs `console.error(\`Startup failed: …\`)`; the signal handler's catch is `logger?.error('Graceful shutdown failed', { error })`then`runtime.exit(1)`.                                                                                                     |
| `setu.config.ts` devtool JSDoc      | `cli/src/templates/project-files.ts:639-645`                                                                                                                                      | Non-Workers: "supplied by `main.dev.ts` alone", emitted with or without `--devtool`. `setu.config.ts` is not rewritten by `devtool enable`.                                                                                                                                                      |
| OpenAPI/metrics options             | `openapi-plugin/src/plugin/openapi-plugin.ts:28,35`; `metrics-plugin/src/interfaces/index.ts:73`                                                                                  | `swagger?: boolean \| SwaggerOptions`, `endpoint?: string`; metrics `endpoint?: string`.                                                                                                                                                                                                         |
| Event bus delivery                  | `events-plugin/src/bus/in-memory-event-bus.ts:99-106`                                                                                                                             | `publish` catches a handler's throw and logs it; no retry.                                                                                                                                                                                                                                       |
| Command/event type names            | `cli/src/schematics/command-handler.ts:39` (`'${pascal}'`), `schematics/event-handler.ts:39,64` (`'${kebab}'`, both arms)                                                         | Two conventions.                                                                                                                                                                                                                                                                                 |
| `g job` text                        | `cli/src/schematics/job.ts:120-150`; registry `registry.ts:166-174`                                                                                                               | `job.data as …Data`; JSDoc "Replace the existing `QueuePlugin()` or `SchedulerPlugin()` call" (`:148`); functional mode does not require queue-plugin.                                                                                                                                           |
| `g middleware` body                 | `cli/src/schematics/middleware.ts:148-157`                                                                                                                                        | `await next(); ctx.response.header('X-${pascal}', 'true')`.                                                                                                                                                                                                                                      |
| Monotonic clock in a handler        | `common/src/http.ts` (`IRequestContext.startTime`, `services`); `common/src/capability-services.ts:82`; `common/src/tokens.ts:106`; `common/src/runtime.ts:358`                   | `ctx.startTime` is `runtime.hrtime()`; `ctx.services.get(CAPABILITIES.RUNTIME)` is typed `IRuntimeServices` (M139g), which has `hrtime(): number`.                                                                                                                                               |
| Class-based module service          | `cli/src/schematics/module-files.ts:42-118`                                                                                                                                       | Module-level `records` Map plus exported free functions; the `@Injectable({ token: '<kebab>-service' })` class forwards to them. With validation, `?? 0`/`?? 20` and the default parameter sit behind schema defaults, and update spreads `...body` then sets `name: body.name ?? current.name`. |
| `g service --module`, Deno comments | `cli/src/schematics/service.ts:60-80`; `cli/src/templates/class-based-showcase.ts:54-57`                                                                                          | "Add this provider to <m>.module.ts and inject …" after the command appended it; both comments blame Deno's missing `emitDecoratorMetadata` (TC39 decorators since M76 carry no parameter types anywhere).                                                                                       |
| Full-stack login / guard / nav      | `cli/src/templates/full-stack-app-files.ts:336-339` (`APP_NAV`), `:380-386` (guard JSDoc "attaches it to `/products` alone"), `:645-656` (login comments)                         | As the rows describe. auth-plugin's working recipe: `auth-plugin/README.md:955` "In the full-stack template".                                                                                                                                                                                    |
| Full-stack module                   | `cli/src/schematics/module-full-stack.ts:62-123` (service `(ctx) => …`), `:165-195` (hand-built 404/400), `:271-312` + `:354-358` (two identical tests, both `startTestServer()`) | `exceptions` is a direct full-stack dependency (`templates/full-stack.ts:263`); `@setu-ts/testing` exports `createTestContext` (`testing/src/index.ts:22`).                                                                                                                                      |
| Full-stack npm lists                | `cli/src/templates/full-stack-build-files.ts:230-266`; merged at `templates/full-stack.ts:350,359`                                                                                | `react`, `react-dom`, `react-router` appear in both lists.                                                                                                                                                                                                                                       |
| Brief facts and render              | `cli/src/agents/facts.ts:16-100`; `agents/render.ts:41-70` (`commandGloss`), `:110-120` (project map)                                                                             | Facts carry no devtool flag; the map is fixed entries plus seams and `src/modules`/`src/shared`. `start` gloss: Node "run build first", else "production entry". `dev` gloss names the devtool but not the launcher.                                                                             |
| Brief refresh hint                  | `cli/src/commands/add.ts:3019-3033` (`reportAgentsHint`); `agents/brief-file.ts` (`BRIEF_BEGIN`)                                                                                  | Only `add` prints it, and only when `AGENTS.md` carries the marker.                                                                                                                                                                                                                              |
| Node devtool `dev`                  | `cli/src/devtool/npm-manifest.ts:7,79-97`; start scripts `templates/project-files.ts:1729-1755`                                                                                   | `NODE_DEVTOOL_DEV_SCRIPT = 'tsx main.dev.ts'`, also the refusal comparand. Node `start:dev` passes `${TELEMETRY_PRELOAD_FLAG} ${envFile}` (preload always on Node).                                                                                                                              |
| Devtool names                       | `cli/src/devtool/dev-entry.ts:33,41`; `devtool/sources.ts:14`; `templates/project-files.ts:1378`                                                                                  | `SETU_DEVTOOL_SESSION_ID`, `SETU_DEVTOOL_SESSION_KEY`, `src/devtool/diagnostics.ts`, `main.dev.ts`.                                                                                                                                                                                              |
| Deno full-stack `start` (M140a)     | `cli/src/templates/project-files.ts:1329-1350`                                                                                                                                    | `start` checks for the build rather than building; the project has a `build` task.                                                                                                                                                                                                               |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                      | Resolution (picked side)                                                                                           | Doc deliverable (same PR)                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| C1  | The events README uses `'order.placed'`; `IDomainEvent.type`'s JSDoc uses `"UserCreated"`; the generators use both PascalCase and kebab-case. | PascalCase for generated command and event type names (§3.8), matching `IDomainEvent`'s JSDoc and the class names. | The events README example is M140e's (named in M140e's scope list via the CHANGELOG entry); this PR changes only generated text. |
| C2  | `setu.config.ts` JSDoc says the devtool option is "supplied by `main.dev.ts` alone" in projects that have none.                               | The JSDoc is rewritten to be true with or without the devtool (§3.12).                                             | Generated text only; no committed doc repeats it (checked `docs/cli.md`, `packages/cli/README.md`).                              |

## 3. Design decisions

The four judgment calls — §3.2 (strict empty schema, no name-collision matcher), §3.3 (print the
Redis consequences and the offline override; never edit tests), §3.8 (PascalCase type names) and
§3.17 (hints only; no `setu check` brief finding) — were approved by the maintainer on 2026-11-15.

### 3.1 V12-62 — `validation-plugin` is a zero-config wiring

- **Decision:** add `['validation-plugin', { symbol: 'ValidationPlugin' }]` to
  `ZERO_CONFIG_WIRINGS`. `setu add validation` then registers `ValidationPlugin()` like every other
  zero-config provider (inline config or `src/plugins/index.ts`, whichever the project uses), and
  W006 reports an installed-but-unregistered `validation-plugin` with no further code.
  Starter-composed projects are unaffected (REST arm).
- **Why:** `ValidationPlugin()` needs no option; the map is the one source both `add` and W006 read.
- **Test home:** `test/unit/plugin-wirings.test.ts` (the map entry),
  `test/unit/commands/add.test.ts` (`add validation` on a minimal project writes the registration),
  `test/unit/check-wiring.test.ts` (W006 fires for an unregistered validation-plugin, not on a
  starter project).

### 3.2 V12-65 — `g schema` refuses until it has fields, and says how to bind it

- **Decision:** the schematic emits `z.strictObject({})` with a JSDoc that says an empty strict
  object refuses every body with fields until fields are added, and shows the binding: functional
  `const body = validateBody(<Pascal>)` used as route middleware, read with `body.value(ctx)`;
  class-based `@ValidateBody(<Pascal>)`. After the write, `generate` prints one line naming the
  written file and how to bind it (functional or class-based form, by mode). No collision detection
  between `order.schemas.ts` and `orders.schemas.ts`: the printed line names the file, so nothing is
  silent.
- **Why:** a strict empty object fails loudly (400) instead of handing the handler `{}`; a
  name-similarity matcher is the hand-built-matcher trap M140a hit.
- **Test home:** `test/unit/schematics/schema.test.ts`; `test/unit/generate-command.test.ts` (the
  printed line, both modes).

### 3.3 V12-70 and V12-100 — a Redis arm says what now needs Redis

- **Decision:** when `setu add` writes a Redis arm into a single (non-workspace) project's config,
  it prints, after the existing connection line: that the app and the generated tests now connect to
  Redis at `REDIS_URL` during startup; how to start it locally
  (`docker compose -f docker/compose.yaml up -d redis` when the project has that file, otherwise
  "start a Redis server"); and the exact offline-test form
  `createTestApp({ app: await createApp(), without: ['<plugin name>'], overrides: [<Symbol>()] })`
  using the plugin's registered name and its zero-config factory, preceded by the factory's import
  line. A full-stack project's generated tests boot through `test/support/server.ts`, not
  `createTestApp`, so there the override line is omitted and only the Redis lines print. Generated
  tests are not edited (they are the developer's files). V12-100: the compose healthcheck comment
  becomes consumer-neutral ("plugins that use Redis connect during registration, so a service
  started before Redis is healthy fails at `app.start()` rather than retrying"), and
  `brokerEnvVariables`' description for every broker becomes "The <name> connection URL. The local
  start scripts read this value; a deployment sets <VAR> in its own environment."
- **Why:** rewriting user-owned tests needs a byte-match heuristic; printing the exact override is
  what the test helper already supports. The `without` name is the bare package name: every
  Redis-arm provider's default instance is named after its package (`cache-plugin.ts:96`,
  `queue-plugin.ts:167`, `messaging-plugin.ts:94-96`, `idempotency-plugin` `:45`, `scheduler-plugin`
  `:144`, `realtime-backplane-plugin.ts:73` `PLUGIN_NAME`). The test registers each provider the CLI
  has as a devDependency and asserts `plugin.name` equals the name the printed line uses, as a
  table.
- **Test home:** `test/unit/add-redis-arms.test.ts` (printed lines for cache with and without
  compose; the plugin name in the override; the neutral env description);
  `test/unit/templates/project-files.test.ts` or the transport test that covers the compose block
  (comment text).

### 3.4 V12-82 — `add database` writes `DATABASE_URL`

- **Decision:** when `databaseConfig` returns a config (Drizzle or Prisma), `add` appends
  `DATABASE_URL` to the resolved env file and its `.example`, through the same env-file resolution
  and `withEnvVariable` path the auth/session secret uses (extracted into one helper both call;
  `.gitignore` handling stays only on the secret path). The local value is the dialect's local URL:
  `postgresql://postgres:postgres@127.0.0.1:5432/app` for Drizzle `postgresql` and for Prisma (its
  only adapter is `@prisma/adapter-pg`, `add.ts:1716`), `file:./local.db` for Drizzle `sqlite`
  (libsql); those are the only dialects `add` accepts (`DRIZZLE_DIALECTS`, `add.ts:1709-1712`). The
  example's value is empty; the description names the variable's form. An existing `DATABASE_URL`
  line is never touched (`withEnvVariable` already skips). Where the shared resolution names no file
  (Deno with no declared dotenv file), nothing is written and the command prints
  `Set DATABASE_URL (local default <url>) in the environment that runs db:generate/db:migrate.`
- **Why:** a connection error naming a host beats a driver error about an empty URL; one env-write
  path for every `add` arm.
- **Test home:** `test/unit/commands/add.test.ts` (each dialect's value; example empty; existing
  line kept; no config → no write).

### 3.5 V12-73 — the microservice README names its development transports

- **Decision:** a microservice project without a broker gets a README section "Development
  transports": messaging and queue are in-memory (one process, lost on restart), telemetry has no
  exporter (spans are dropped), discovery is static and empty; each line names the command that
  changes it (`setu add messaging --broker <name>`, `setu add queue --queue <name>`, the
  `TelemetryPlugin` `exporter` option, the discovery `services` map). Each line is decided on its
  own: `--broker` drops only the messaging line and `--queue` only the queue line, because the two
  flags are independent (`templates/project-files.ts:2108-2110`); the existing "Local transport
  services" section is unchanged. Rendered through the microservice template's `readmeSection`
  (`templates/registry.ts:251`), so other templates are untouched.
- **Why:** the defaults are deliberate (zero-config scaffold); what was missing is saying so.
- **Test home:** `test/unit/templates/project-files.test.ts` (section present without a broker,
  absent lines with one).

### 3.6 V12-78, V12-79, V12-94, V12-81 — README and `main.ts` say what is true

- **Decision:** V12-78: the "DI graph validation happens at boot" clause is emitted only when
  `host.plugins` holds `di-plugin` or `decorator-plugin` (the class-based template; starter-composed
  templates are functional). V12-79: "Generate code" prints `generate module billing` (works with or
  without modules, every template). V12-94: the Production section adds one paragraph when
  `host.plugins` holds `metrics-plugin` or `openapi-plugin`, or when `host.appFactory` is set (every
  starter registers both: `starters/rest-starter/src/app.ts:199-202`): `/metrics`, `/docs` and
  `/openapi.json` are served on the application port; restrict them at the proxy, or turn the UI off
  with `OpenApiPlugin`'s `swagger: false` and move a route with its `endpoint` option. The paragraph
  names only the routes the project has. V12-81: the shutdown catch logs through the logger when
  present, and otherwise writes the same masked form as startup:

  ```ts
  console.error(`Graceful shutdown failed: ${describeError(error)}`);
  ```

- **Test home:** `test/unit/templates/project-files.test.ts` (rendered `main.ts` of a project
  without LoggerPlugin carries the `console.error` branch; with LoggerPlugin, the logger branch).

### 3.7 V12-84, V12-85 — event and job samples state their contract

- **Decision:** V12-84: the event-handler JSDoc (both arms) says delivery is in-process and
  at-most-once — a handler that throws is logged and the event is not redelivered — and that
  cross-service events belong in messaging-plugin's `defineIntegrationEvent`. V12-85: the job JSDoc
  says "Register these in `setu.config.ts`, in the project's
  `QueuePlugin(...)`/`SchedulerPlugin(...)` call", and `generate` prints
  `Install the queue: <cli> add queue` after `g job` when `queue-plugin` is absent (functional mode;
  class-based already requires it).
- **Test home:** `test/unit/schematics/event-handler.test.ts`, `test/unit/schematics/job.test.ts`,
  `test/unit/generate-command.test.ts`.

### 3.8 V12-86 — PascalCase type names for commands and events

- **Decision:** `g event-handler` emits `'${pascal}'` in both arms (`'OrderCreated'`), as
  `g command-handler` already does.
- **Test home:** `test/unit/schematics/event-handler.test.ts`,
  `test/unit/ingress-schematics.test.ts` where it asserts the class-based constant.

### 3.9 V12-87 — `g middleware` measures with the monotonic clock

- **Decision:** the after-handler line becomes a `Server-Timing` entry, with a comment that
  `ctx.startTime` is a monotonic reading, so `Date.now()` must never be subtracted from it:

  ```ts
  const runtime = ctx.services.get(CAPABILITIES.RUNTIME);
  await next();
  const ms = runtime.hrtime() - ctx.startTime;
  ctx.response.header('Server-Timing', `<kebab>;dur=${ms.toFixed(1)}`);
  ```

- **Test home:** `test/unit/schematics/middleware.test.ts` (text); the scaffold e2e type-checks the
  generated file (§7).

### 3.10 V12-95, V12-99 — module service shapes

- **Decision:** V12-95: in class-based mode the module service is the `@Injectable` class alone:
  `private readonly records = new Map<…>()` and the four methods; no free functions. The functional
  mode keeps its free functions. V12-99: with validation, the list function takes the schema type
  with no default parameter and no `??`; update builds
  `{ ...current, name: body.name ?? current.name, id }` without spreading `body`. Without validation
  the optional-field fallbacks stay (they are live there).
- **Test home:** `test/unit/schematics/module.test.ts`; `test/unit/generate-module-zod.test.ts`
  where it pins the rendered service.

### 3.11 V12-96, V12-97 — class-based comments

- **Decision:** V12-96: the `--module` service JSDoc says "Registered in <m>.module.ts's providers;
  inject it with `@Inject('<token>')`." V12-97: both comments say TC39 standard decorators carry no
  parameter type information on any runtime, so `@Inject` names the token.
- **Test home:** `test/unit/schematics/service.test.ts`; `test/unit/templates/` test covering the
  class-based showcase (`templates.test.ts`).

### 3.12 V12-98 — devtool JSDoc true with and without the devtool

- **Decision:** "the development-only composition … supplied only by a development entry
  (`main.dev.ts`, written by `--devtool` or `setu devtool enable`); `main.ts` never passes it."
- **Test home:** `test/unit/config-module.test.ts`.

### 3.13 V12-89, V12-92 — full-stack comments

- **Decision:** V12-89: the login comments say a real credential check goes through a request-bound
  module service resolved with `getService(context, <TOKEN>)`, as auth-plugin's README "In the
  full-stack template" shows; the `authSession.signIn` sentence is removed; `session.regenerate()`
  stays with its fixation comment. V12-92: the guard JSDoc says the scaffold attaches `requireUser`
  page by page (each guarded page exports `middleware = [requireUser]`), without naming `/products`;
  `APP_NAV` gains a comment "add an entry for each signed-in page"; `g module --page` prints
  `Add { to: '/<kebab>', label: '<Pascal>' } to APP_NAV in app/lib/nav-utils.ts to link the page.`
- **Test home:** `test/unit/templates/full-stack-app-files.test.ts`;
  `test/unit/generate-page-collisions.test.ts` or `generate-module-command.test.ts` (printed line).

### 3.14 V12-90, V12-93 — full-stack module errors and tests

- **Decision:** V12-90: the generated controller throws `notFound(...)`/`badRequest(...)` from
  `@setu-ts/exceptions` (the starter's `errorHandler` renders RFC 9457). V12-93: the `<m>.test.ts`
  unit test drives the service directly — `<camel>Service(createTestContext())`, create then get
  then list — and binds no port; the `.e2e.test.ts` keeps the server test with the CSRF refusal. On
  Cloudflare Workers, where `@setu-ts/testing` is not a dependency
  (`templates/project-files.ts:1185-1188`), only the e2e test is emitted (no duplicate).
- **Test home:** `test/unit/schematics/module-full-stack.test.ts`;
  `test/e2e/full-stack-modules-e2e.test.ts` runs both generated tests.

### 3.15 V12-91 — React only in `dependencies`

- **Decision:** remove `react`, `react-dom`, `react-router` from `FULL_STACK_NPM_DEV_DEPENDENCIES`.
- **Test home:** `test/unit/full-stack-template.test.ts` (each in `dependencies`, none in
  `devDependencies`).

### 3.16 V12-101 — `generate` accepts `--yes`

- **Decision:** `yes` and `y` join the documented flags of `GENERATE`, `GENERATE_CUSTOM`,
  `GENERATE_APP` and `GENERATE_LIBRARY`; they change nothing (`generate` never prompts) and the help
  says so.
- **Test home:** `test/unit/flags.test.ts`; `test/unit/generate-command.test.ts` (`--yes` run writes
  the same files).

### 3.17 V12-125 — commands that change the brief's inputs say so

- **Decision:** `reportAgentsHint` moves to one shared helper and is called after a successful write
  by `generate`, `sync` and `devtool enable` (the command's only verb, `commands/devtool.ts:402`),
  exactly as `add` does (only when `AGENTS.md` carries the brief marker; a read failure is reported,
  never fatal). `setu check` is not extended: brief freshness stays with `setu agents --check`,
  which the hint names.
- **Why:** the defect is silence; the one hint already exists. A W-finding in `setu check` would
  need the workspace-aware freshness walk `agents --check` owns — a second implementation.
- **Test home:** `test/unit/generate-command.test.ts`, `test/unit/sync-command.test.ts`,
  `test/unit/devtool-lifecycle.test.ts` (hint with the marker, none without).

### 3.18 V12-126, V12-128, Deno full-stack `start` — brief text

- **Decision:** V12-126: the functional rule's validation sentence is a separate clause applied only
  when `validation-plugin` is installed (detected set). V12-128: `ProjectFacts` gains
  `devtool: boolean` (`main.dev.ts` exists); the project map then lists `main.dev.ts` ("devtool
  entry; needs the launcher's SETU_DEVTOOL_SESSION_ID and SETU_DEVTOOL_SESSION_KEY and exits 1
  without them") and `src/devtool/diagnostics.ts` ("CLI-managed allowlist; change it with setu
  devtool"), and the `dev` gloss names the launcher requirement. `start` gloss: "production entry;
  run build first" whenever the project has a `build` command (Node, Deno and Bun full-stack), else
  "production entry".
- **Test home:** `test/unit/agents/render-brief.test.ts`, `test/unit/agents/rule-blocks.test.ts`,
  `test/unit/agents/gather-facts.test.ts`.

### 3.19 V12-127 — Node devtool `dev` loads `.env` and the preload

- **Decision:** `NODE_DEVTOOL_DEV_SCRIPT` becomes `nodeDevtoolDevScript(envFileFlag)` returning
  `tsx ${TELEMETRY_PRELOAD_FLAG} ${envFileFlag}main.dev.ts`, where `envFileFlag` is the same flag
  the project's start scripts use (from the scaffold's manifest at `new --devtool`; from the
  config's env-file declaration at `devtool enable`, defaulting to `--env-file-if-exists=.env `, the
  same rule as `templates/project-files.ts:1723-1728`). The refusal compares against the computed
  script only; no older script form is accepted (there are no existing projects to upgrade).
- **Test home:** `test/unit/devtool-npm-manifest.test.ts`; `test/e2e/devtool-e2e.test.ts` (Node dev
  loads a `.env` PORT).

### 3.20 Fixtures and the M140c overlap

- **Decision:** the captured template fixtures are regenerated with
  `node --conditions development --import ./scripts/lib/source-register.ts packages/cli/test/fixtures/capture-template-baseline.ts`
  after the change; whichever of M140c/M140d merges second merges `develop` and regenerates them.
  Every flipped assertion in a fixture-backed test is checked by hand (M140b lesson: a regression
  test weakened to fit).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none.

| Exported symbol                  | Kind  | Consumer / real code path that READS it                                                     |
| -------------------------------- | ----- | ------------------------------------------------------------------------------------------- |
| None from `cli/src/index.ts`     | —     | No public export changes (checked `packages/cli/src/index.ts`); PUBLIC_API.md is unchanged. |
| Internal: `nodeDevtoolDevScript` | fn    | `devtool/npm-manifest.ts` plan and the `new --devtool` scaffold path.                       |
| Internal: shared agents hint     | fn    | `add`, `generate`, `sync`, `devtool` commands.                                              |
| Internal: `ProjectFacts.devtool` | field | `agents/render.ts` project map and `dev` gloss.                                             |

### 4.1 Options — every option names its consumer

| Option                   | Consumer          | Behavior (per implementation)                           |
| ------------------------ | ----------------- | ------------------------------------------------------- |
| `--yes`/`-y` on generate | `flags.ts` parser | Accepted and ignored: `generate` never prompts (§3.16). |

## 5. Implementation files

All under `packages/cli/src/`.

| File                                                                                                  | Purpose                                                                    |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `utils/plugin-wirings.ts`                                                                             | V12-62 map entry                                                           |
| `schematics/schema.ts`                                                                                | V12-65 strict shape and JSDoc                                              |
| `commands/generate.ts`                                                                                | V12-65, V12-85, V12-92, V12-125 printed lines                              |
| `flags.ts`                                                                                            | V12-101                                                                    |
| `commands/add.ts`                                                                                     | V12-70 printed lines, V12-82 env write, shared env helper, agents-hint use |
| `commands/add-database.ts`                                                                            | V12-82 dialect local URL                                                   |
| `templates/broker.ts`                                                                                 | V12-100 env description                                                    |
| `workspace/transport.ts`                                                                              | V12-100 compose comment                                                    |
| `templates/project-files.ts`                                                                          | V12-73, V12-78, V12-79, V12-81, V12-94, V12-98                             |
| `schematics/event-handler.ts`                                                                         | V12-84, V12-86                                                             |
| `schematics/job.ts`                                                                                   | V12-85 JSDoc                                                               |
| `schematics/middleware.ts`                                                                            | V12-87                                                                     |
| `schematics/module-files.ts`                                                                          | V12-95, V12-99 (and the class-based controller's calls if they change)     |
| `schematics/service.ts`                                                                               | V12-96, V12-97                                                             |
| `templates/class-based-showcase.ts`                                                                   | V12-97                                                                     |
| `templates/full-stack-app-files.ts`                                                                   | V12-89, V12-92                                                             |
| `schematics/module-full-stack.ts`                                                                     | V12-90, V12-93                                                             |
| `templates/full-stack-build-files.ts`                                                                 | V12-91                                                                     |
| `agents/facts.ts`, `agents/render.ts`, `agents/rules.ts`                                              | V12-126, V12-128, `start` gloss                                            |
| `devtool/npm-manifest.ts` (+ its callers `commands/new.ts`, `commands/devtool.ts`, `commands/app.ts`) | V12-127                                                                    |
| `commands/sync.ts`, `commands/devtool.ts`, new `utils/agents-hint.ts`                                 | V12-125                                                                    |
| `test/fixtures/template-baseline.json`, `test/fixtures/redis-develop-outputs.json`                    | regenerated (§3.20)                                                        |
| `CHANGELOG.md`                                                                                        | M140d entry under the unreleased `0.13.0`                                  |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                     | src covered                                                           | Key assertions                                                                                                                  |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/plugin-wirings.test.ts`                                                            | `utils/plugin-wirings.ts`                                             | `validation-plugin → ValidationPlugin`                                                                                          |
| `test/unit/check-wiring.test.ts`                                                              | `diagnostics/wiring.ts` (unchanged code, new data)                    | W006 for unregistered validation; none on a `createRestApp` config                                                              |
| `test/unit/schematics/schema.test.ts`                                                         | `schematics/schema.ts`                                                | `z.strictObject({})`; JSDoc names `validateBody`/`@ValidateBody`                                                                |
| `test/unit/generate-command.test.ts`                                                          | `commands/generate.ts`                                                | schema bind line (both modes); queue hint present/absent; agents hint with/without marker; `--yes`                              |
| `test/unit/generate-module-command.test.ts`                                                   | `commands/generate.ts` (`--page`)                                     | `APP_NAV` hint after `g module --page`                                                                                          |
| `test/unit/flags.test.ts`                                                                     | `flags.ts`                                                            | `--yes`/`-y` accepted on the four generate specs                                                                                |
| `test/unit/commands/add.test.ts`                                                              | `commands/add.ts`, `commands/add-database.ts`, `utils/agents-hint.ts` | validation registration; `DATABASE_URL` per dialect, example empty, existing line kept                                          |
| `test/unit/add-redis-arms.test.ts`                                                            | `commands/add.ts`, `templates/broker.ts`                              | Redis lines with/without compose; override names the plugin; neutral env description                                            |
| `test/unit/templates/project-files.test.ts`                                                   | `templates/project-files.ts`, `workspace/transport.ts`                | microservice section; DI clause gated; `generate module billing`; exposure paragraph; shutdown `console.error`; compose comment |
| `test/unit/config-module.test.ts`                                                             | `templates/project-files.ts` (config JSDoc)                           | new devtool wording, with and without `--devtool`                                                                               |
| `test/unit/schematics/event-handler.test.ts`                                                  | `schematics/event-handler.ts`                                         | PascalCase constant; at-most-once JSDoc; both arms                                                                              |
| `test/unit/schematics/job.test.ts`                                                            | `schematics/job.ts`                                                   | new JSDoc                                                                                                                       |
| `test/unit/schematics/middleware.test.ts`                                                     | `schematics/middleware.ts`                                            | `Server-Timing`, `runtime.hrtime() - ctx.startTime`, no `Date.now()`                                                            |
| `test/unit/schematics/module.test.ts`, `generate-module-zod.test.ts`                          | `schematics/module-files.ts`                                          | class-based: Map is an instance field, no free functions; validation arm has no dead `??`                                       |
| `test/unit/schematics/service.test.ts`                                                        | `schematics/service.ts`                                               | `--module` comment; no "Deno" claim                                                                                             |
| `test/unit/templates.test.ts`                                                                 | `templates/class-based-showcase.ts`                                   | no "Deno does not support"                                                                                                      |
| `test/unit/templates/full-stack-app-files.test.ts`                                            | `templates/full-stack-app-files.ts`                                   | login comment; guard JSDoc without `/products`; `APP_NAV` comment                                                               |
| `test/unit/schematics/module-full-stack.test.ts`                                              | `schematics/module-full-stack.ts`                                     | `notFound`/`badRequest` imports; unit test uses `createTestContext`, no `startTestServer`                                       |
| `test/unit/full-stack-template.test.ts`                                                       | `templates/full-stack-build-files.ts`                                 | React trio only in `dependencies`                                                                                               |
| `test/unit/agents/render-brief.test.ts`, `rule-blocks.test.ts`, `gather-facts.test.ts`        | `agents/*.ts`                                                         | devtool map entries; `dev` gloss; `start` gloss with `build`; validation clause gated                                           |
| `test/unit/devtool-npm-manifest.test.ts`                                                      | `devtool/npm-manifest.ts`                                             | script carries preload and env flag; old script upgraded, a developer's refused                                                 |
| `test/unit/sync-command.test.ts`, `devtool-lifecycle.test.ts`                                 | `commands/sync.ts`, `commands/devtool.ts`                             | agents hint                                                                                                                     |
| `test/e2e/scaffold-runs-e2e.test.ts`, `full-stack-modules-e2e.test.ts`, `devtool-e2e.test.ts` | generated output                                                      | boots; generated tests pass; Node `dev` reads `.env`                                                                            |

Each fix's test is shown failing without the fix (the review checks a sample).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m140d-generator-output
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm run ci:local --shard cli   # sharded CLI coverage; ANSI-stripped per-file table, ≥90% each touched file
pnpm run test:deno-lane          # retained Deno proofs
pnpm run release:publish --dry-run
pnpm run release:verify 0.13.0
```

Generated-output rule: scaffold and boot every touched template — minimal, rest, microservice,
class-based (Node), full-stack (Node and Deno), a Node `--devtool` project — run each project's own
`check`, `test` and `start`, and request `/health`. Also: `setu add validation` on minimal then a
validated route answers 400, not 500; `setu add cache --store redis` prints the Redis lines;
`setu add database --type drizzle` writes `DATABASE_URL`; `g module --page` on full-stack and its
generated tests pass. Before every suite: `pgrep -af "vitest|local-ci.ts"` and `docker ps` (M140c
runs in parallel).

## 8. Risks & mitigations

- **New README and comment text fails the project's own formatter** (M63 D6: a hand-wrapped section
  made every scaffold fail `fmt --check`) → write each paragraph wrapped exactly as Prettier and
  `deno fmt` emit at lineWidth 100; the scaffold e2e runs each project's `format:check`.
- **M140c conflicts in `project-files.ts` and both fixtures** → merge `develop` before the PR if
  M140c lands first, regenerate fixtures, re-run `--shard cli`.
- **Fixture-backed tests flipped to fit** (M140b) → review every changed assertion against the row.
- **The Redis override line names the wrong plugin** → a table test asserts each provider's real
  default `name` against the printed name (§3.3).

## 9. Out of scope

- `TelemetryPlugin` warning when it runs without an exporter (V12-73's package half): a
  `telemetry-plugin` follow-up, proposed after merge.
- Editing generated tests on `add` (V12-70): the developer's files; §3.3 prints the override.
- A `setu check` brief-freshness finding (V12-125): `setu agents --check` owns it.
- Docs pages, READMEs, agent cards: M140e.
