# Milestone 131a — Redis, node-redis and readiness (`queue`, Redis-backed plugins, `notification`, `telemetry`, `common`, `cli`)

> **Status:** Planning. Branch: `feat/m131a-redis-readiness`. `develop` and `main` are protected —
> all work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Close the `0.11.0` smoke group for Redis, node-redis and readiness: the one `0.11.0` regression
(V11-10, a stopped Redis reads `up` on the queue indicator) and eleven rows found running a
node-redis project and its ioredis twin against real outages (Part 20 X88) plus the SMTP readiness
remainder (V11-11). The boundary: behaviour of the Redis-backed plugins and their indicators, the
`common` pieces they share (connection reporting, redaction, a backend-fault helper), the telemetry
ESM preload, and the CLI output that wires Redis clients, `.env` and telemetry. The maintainer kept
V11-10 inside this letter (2026-11-02) rather than a separate `fix/` branch.

- **In scope:** V11-10, V11-11, X88-1 … X88-10, their docs (READMEs, agent cards, `PUBLIC_API.md`,
  `CHANGELOG.md`, `docs/upgrading.md`, `docs/cli.md`), and a committed-tree security audit (X88-8
  touches redaction).
- **NOT this milestone:** M131b (kernel/runtime contracts), M131c (other CLI rows), M131d (the
  documentation batch). Re-mapping existing cache-plugin outage statuses (they already answer 503).
  A FLUSHALL leaving Redis Streams consumers on NOGROUP (X88 observation, operator action).

## 1. Contracts verified from SOURCE (not names)

Read on `develop` at `d2946685` (2026-11-02). Evidence:
`~/Projects/hono-enterprise-published-smoke/v0.11.0/part20/x88/REPORT.txt` l.75–185,
`.../regression/g5/FINDINGS.md` l.67–117.

| Reference                           | Source (file:line)                                                                                                                                                                                                                                                                                                                                                                                        | Verified surface / fact                                                                                                                                                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue indicator                     | `packages/queue-plugin/src/services/queue-service.ts:282-312`                                                                                                                                                                                                                                                                                                                                             | Probe `undefined` (no answer within its bound) → `up`, `reachable: 'unknown'`; `false` → `down`.                                                                                                                                              |
| RedisQueue probe                    | `packages/queue-plugin/src/adapters/redis-queue.ts:331-348`                                                                                                                                                                                                                                                                                                                                               | `isHealthy` = bare `client.ping()`; no client-state check. ioredis queues a stopped server's commands (offline queue), so the ping hangs → unknown.                                                                                           |
| Client state                        | ioredis `Redis#status`; `packages/common/src/redis/node-redis-adapter.ts:165-169`                                                                                                                                                                                                                                                                                                                         | Both expose a string `status`; the adapter answers `'ready'` / `'connecting'` / `'wait'`. A paused server keeps `'ready'` (TCP open).                                                                                                         |
| Cache probe                         | `packages/cache-plugin/src/stores/redis-store.ts:252-262`                                                                                                                                                                                                                                                                                                                                                 | Same `ping()` shape; the cache indicator reads `down` for a stopped server in the g5 runs.                                                                                                                                                    |
| Mail / notification readiness       | `packages/mail-plugin/src/plugin/mail-plugin.ts:165`; `packages/notification-plugin/src/plugin/notification-plugin.ts:105`                                                                                                                                                                                                                                                                                | `mail` registers `{ readiness: false }`; `notification` registers with no option and probes the same mailer.                                                                                                                                  |
| CLI URL reads                       | `packages/cli/src/templates/broker.ts:84-98,128-200`; `packages/cli/src/workspace/transport.ts:657-697`                                                                                                                                                                                                                                                                                                   | Full-stack factories read `config.get('REDIS_URL', …)` (ConfigPlugin, `.env` included); plugin-list hosts (rest, microservice) read `process.env.REDIS_URL ?? …` inside `createApp()`, before ConfigPlugin loads `.env`.                      |
| ConfigPlugin `.env`                 | `packages/config-plugin/src/services/env-loader.ts:88-110`                                                                                                                                                                                                                                                                                                                                                | Merges the file into its own map only, never into `process.env`.                                                                                                                                                                              |
| Env-file flags (probe, 2026-11-02)  | Node 24.22.1, Deno 2.9.6, Bun                                                                                                                                                                                                                                                                                                                                                                             | `node --env-file-if-exists=.env`, `deno run --env-file=.env`, Bun (automatic) each load the file; a real environment variable wins over the file; a missing file continues (Node prints "not found. Continuing without it.", Deno a warning). |
| node-redis helper                   | `packages/cli/src/templates/node-redis.ts:90-105`                                                                                                                                                                                                                                                                                                                                                         | `fromNodeRedis(factory)` with no `onError`.                                                                                                                                                                                                   |
| Reporter attach                     | `packages/common/src/health/connection-errors.ts:112,204-219`                                                                                                                                                                                                                                                                                                                                             | `attachConnectionErrorReporter(client, reporter)` needs only `on('error')`/`on('ready')`; plugins call it only for clients they build. `NodeRedisAdapter.on` forwards events (`node-redis-adapter.ts:256-258`).                               |
| `--redis-client` in `add`           | `packages/cli/src/commands/add.ts:433-446,1242,1276,1456-1470`                                                                                                                                                                                                                                                                                                                                            | A helper already detects a configuration importing `nodeRedisClient`; workspaces read `redisClient` from the manifest; standalone `add` never infers the client.                                                                              |
| ioredis load sites                  | `cache-plugin/src/stores/redis-store.ts:30`, `queue-plugin/src/adapters/redis-queue.ts:45`, `messaging-plugin/src/brokers/redis-streams-broker.ts:63`, `idempotency-plugin/src/stores/redis-client.ts:33`, `realtime-backplane-plugin/src/transports/redis-module.ts:95`, `scheduler-plugin/src/lock/redis-lock.ts:95`, **`auth-plugin/src/stores/redis-rate-limit-store.ts:28`** (missing from the note) | All `await import('ioredis')`; `amqplib` (`rabbitmq-broker.ts:41`, `rabbitmq-queue.ts:38`) and `kafkajs` (`kafka-broker.ts:81`) the same.                                                                                                     |
| OTel ESM probe (2026-11-02, x88-io) | `@opentelemetry/instrumentation-ioredis` 0.68, `import-in-the-middle`                                                                                                                                                                                                                                                                                                                                     | enable() then `await import('ioredis')`: `sendCommand.__wrapped === false`. `module.register(import-in-the-middle/hook.mjs)` BEFORE the import: `true`. A `createRequire(...)('ioredis')` after load: `true`.                                 |
| Telemetry gate                      | `packages/telemetry-plugin/src/instrumentation/instrumentation-registry.ts:97-98,161,203`                                                                                                                                                                                                                                                                                                                 | Auto-instrumentation is Node-only; others record `unsupported platform`.                                                                                                                                                                      |
| Fault classifier                    | `packages/common/src/errors/connection-fault.ts:8-29,62-80`                                                                                                                                                                                                                                                                                                                                               | `isConnectionFault` recognises the eight net codes and node-redis "Command timed out"; used only by cache and the auth rate-limit store.                                                                                                      |
| Publish timeout                     | `packages/messaging-plugin/src/errors.ts:29`                                                                                                                                                                                                                                                                                                                                                              | `PublishTimeoutError` carries `topic` and the bound; no status hint.                                                                                                                                                                          |
| Streams poll                        | `packages/messaging-plugin/src/brokers/redis-streams-broker.ts:516-525`                                                                                                                                                                                                                                                                                                                                   | Poll and reclaim `setInterval`s created inside `subscribe()`, inheriting the caller's async context.                                                                                                                                          |
| Queue loop reports                  | `packages/queue-plugin/src/services/queue-service.ts:146-160,398,429`                                                                                                                                                                                                                                                                                                                                     | `#report` logs at `error` on every failure, no state tracking.                                                                                                                                                                                |
| node-redis bound                    | `packages/common/src/redis/node-redis-adapter.ts:125`                                                                                                                                                                                                                                                                                                                                                     | `commandTimeoutMs` default 15 000 bounds every command, `XADD` included.                                                                                                                                                                      |
| Generated start                     | `packages/cli/src/templates/project-files.ts:698,942`; `full-stack-build-files.ts:412`                                                                                                                                                                                                                                                                                                                    | `await app.start(...)` with no catch.                                                                                                                                                                                                         |
| Redaction                           | `packages/common/src/redaction/{redaction-service,redactors,policy}.ts`                                                                                                                                                                                                                                                                                                                                   | The one redaction seam (M96); no URL-userinfo rule.                                                                                                                                                                                           |
| Telemetry card                      | `packages/telemetry-plugin/AGENT_CARD.md:55`                                                                                                                                                                                                                                                                                                                                                              | Lists `http`, `fetch`, `ioredis`, `amqplib`, `kafkajs` — not `redis`.                                                                                                                                                                         |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                        | Resolution (picked side)                                                         | Doc deliverable (same PR)                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| C1  | queue-plugin README / CHANGELOG / upgrading (M119b): "a stopped broker still reads `down` at once" vs the shipped `up`/unknown                                                  | The docs' promise wins (§3.1).                                                   | No doc change needed beyond the CHANGELOG `Fixed` entry; the README sentence becomes true. |
| C2  | Upgrading (M119b): "A mail outage no longer fails `/ready`" vs `notification` still failing it                                                                                  | The docs win (§3.2).                                                             | notification README: readiness membership and how to opt in.                               |
| C3  | `docs/cli.md`: "Each Redis-backed plugin gets its own client" vs four `add` commands that cannot wire one                                                                       | The docs win (§3.3).                                                             | `docs/cli.md` gains the new arm flags.                                                     |
| C4  | Generated `.env` comment ("deployments set the real endpoint here") vs a value nothing reads                                                                                    | The comment wins (§3.4); container images keep reading the platform environment. | Comment rewritten to say what reads it.                                                    |
| C5  | Telemetry README / card promise ioredis spans vs none for the plugins' clients                                                                                                  | The docs win, with the preload (§3.7).                                           | Telemetry README section "ESM applications: the preload"; card lists `redis`.              |
| C6  | ROADMAP's M131a package list omits `auth-plugin`, whose rate-limit store also skips the reporter for an injected client (`auth-plugin/src/stores/redis-rate-limit-store.ts:93`) | `auth-plugin` joins the letter for §3.5 only.                                    | ROADMAP M131a package list gains `auth-plugin`.                                            |

## 3. Design decisions

### 3.1 V11-10 — the Redis queue probe reads the client's state first

- **Decision:** `RedisQueue.isHealthy` answers `false` without I/O when the client exposes a string
  `status` that is not `'ready'`; otherwise it pings as today. The queue client type gains
  `readonly status?: string`. A paused server keeps `'ready'`, so a pause still reads
  `up`/`reachable: 'unknown'` (the intended M119b rule).
- **Why:** ioredis parks a stopped server's commands in the offline queue, so a ping cannot tell
  stopped from hung; the client already knows it has no connection. node-redis through
  `fromNodeRedis` exposes the same field.
- **Test home:** `queue-plugin/test/unit/redis-queue-health.test.ts` (status table as data: `ready`
  → pings; `connecting`, `reconnecting`, `wait`, `end` → `false` with zero pings; no `status` →
  pings); guarded `queue-plugin/test/integration/redis-queue-health-real.test.ts` on `REDIS_URL`: a
  real ioredis client pointed at a closed port reads `down` within one probe (was `up`/unknown —
  fails without the fix); positive control against the live server reads `up`/`true`. No shared
  container is stopped.

### 3.2 V11-11 — `notification` stays out of readiness by default

- **Decision:** `NotificationPlugin` registers its indicator with `{ readiness: false }`. An
  application that wants a channel to gate traffic opts in through the health plugin's existing
  per-indicator override, `HealthPlugin({ readiness: { include: ['notification'] } })`
  (`health-plugin/src/interfaces/index.ts:157-167`, since 0.11.0).
- **Why:** the M119b rule: an indicator over a dependency every replica shares stays out of
  readiness, since draining all replicas cannot fix it. Every notification channel is such a
  dependency, not only email.
- **Test home:** `notification-plugin/test/integration/readiness.test.ts` (adds
  `@setu-ts/health-plugin` as a devDependency, regenerated with
  `node scripts/node-manifests.ts --write`): a failing channel makes `/health` report
  `notification: down` while `/ready` answers 200; with the health override naming `notification`,
  `/ready` answers 503.

### 3.3 X88-1 — `setu add` puts every Redis-backed plugin on the project's Redis client

- **Decision:**
  1. A standalone project's Redis client is inferred from what it already uses: importing the
     generated `nodeRedisClient` helper means node-redis (the existing detection at
     `add.ts:433-446`), an `ioredis` dependency in `package.json` or `deno.json` means ioredis. A
     project with neither has not chosen yet, so its first Redis `setu add` takes `--redis-client`
     (ioredis when omitted) — the M117 path. Workspaces keep reading `redisClient` from the
     manifest.
  2. New Redis arm flags, named after each plugin's own option: `setu add cache --store redis`,
     `setu add idempotency --store redis`, `setu add scheduler --lock redis`,
     `setu add realtime-backplane --backplane redis` (`--transport` keeps its workspace meaning).
     Each wires its Redis arm on `REDIS_URL` through the inferred client —
     `client: nodeRedisClient(url)` for node-redis (two for the backplane), `url` for ioredis — and
     records the client package.
  3. `setu add queue --queue redis` follows the inferred client: a node-redis project gets
     `client: nodeRedisClient(url)` and no `ioredis` dependency.
  4. `--redis-client` on `add` stays accepted only with a Redis arm flag, and is refused when it
     disagrees with a client the project already uses (exit 2, naming both).
- **Why:** the docs promise one client per plugin; a project must not drift to a second Redis
  driver. Flags mirror the plugin options so the generated call reads like the flag. Compared before
  fixing them: `nest add`, `rails generate`, `artisan make:*` and `ng add` have no per-backend arm
  flag to copy (they install a package and leave wiring to options or prompts), so the precedent is
  this CLI's own `setu add messaging --broker` / `setu add queue --queue` (M121), which name the
  plugin option the same way.
- **Test home:** `cli/test/unit/add-redis-arms.test.ts` (each flag × client renders the expected
  call and dependency; disagreement refused); `cli/test/e2e` scaffold case:
  `setu new --broker redis --redis-client node-redis`, then the four adds and
  `add queue --queue redis`, type-check, assert no `ioredis` in `package.json`.

### 3.4 X88-2 — generated local start scripts load `.env` through the runtime

- **Decision:** every generated script that starts the app locally (`start`, `start:dev`,
  `start:debug`, `dev`) passes the runtime's own env-file flag: Node `--env-file-if-exists=.env`,
  Deno `--env-file=.env`; Bun loads `.env` itself. Production images and Compose keep the platform
  environment and pass no flag: the image `CMD` runs `node --enable-source-maps dist/main.js`
  directly (`cli/src/workspace/compose.ts:376`), never `npm start`, so a local script's flag cannot
  reach a container. The `.env` comment says local scripts read it. ConfigPlugin keeps reading
  `.env` as today.
- **Why:** the plugin options are evaluated in `createApp()`, before any plugin runs, so only the
  process environment is available there. Loading `.env` into the environment before the process
  starts is what Node's flag, Deno's flag, Bun, Next.js and NestJS's ConfigModule all do, and the
  probe shows a real variable still wins.
- **Test home:** `cli/test/unit/start-scripts.test.ts` (each runtime × template script carries the
  flag; Dockerfile/Compose commands do not); scaffold e2e boots a project whose `.env` points
  `REDIS_URL` at a probe port and asserts the connection goes there.

### 3.5 X88-3 — every plugin reports an injected client's connection errors

- **Decision:** each Redis-backed plugin attaches its `createConnectionErrorReporter` to an injected
  client as well as a built one (`attachConnectionErrorReporter` needs only `on`), so a node-redis
  outage logs one `warn` per plugin per state change, naming the cause. `NodeRedisAdapter.connect()`
  rejects on the first connection error emitted before the client is ready, naming the cause, as
  ioredis's first connect does; reconnection after a connection was established is unchanged.
- **Why:** the generated helper is the documented way to use node-redis, so its outages must be as
  visible as ioredis's; a 15 s boot failure reading "Command timed out" names nothing.
- **Test home:** per plugin, the existing reporter unit test gains an injected-client case;
  `common/test/unit/node-redis-adapter.test.ts`: first-connect error rejects at once with the cause;
  guarded real node-redis boot against a closed port fails in under 2 s naming `ECONNREFUSED`.

### 3.6 X88-5 — enqueue and publish failures say whether the work may have happened

- **Decision:** `common` gains `BackendUnavailableError` (503, "The request was not applied.") and
  `BackendOutcomeUnknownError` (504, "The backend did not answer; the request may have been
  applied.") plus `toBackendFault(error, source)`, which returns one of them, or `undefined`. Rule
  (the M128 rule, shared): refused before sending (a closed, offline or offline-queue-disabled
  client, `ECONNREFUSED`-class codes) → unavailable; no answer within the bound ("Command timed
  out") and a lost connection (`ECONNRESET`, `EPIPE`, `ETIMEDOUT`, `MaxRetriesPerRequestError`,
  "Connection is closed.", "Socket closed unexpectedly") → unavailable only when the caller's
  `context.unsent` is `true`, otherwise outcome unknown. ioredis's `flushQueue` rejects commands
  already written to the socket with `MaxRetriesPerRequestError` and "Connection is closed." (read
  in `event_handler.js` `closeHandler`), and a command made while disconnected is written on the
  next socket (the security audit reproduced a node-redis job stored in Redis behind a `503`), so
  neither the shape nor the state at dispatch alone proves "not applied". Each call site uses
  `watchConnection` (common), which counts socket `'connect'` events — not `'ready'`: the re-audit
  measured node-redis 6.3 writing its queued commands together with the reconnect handshake, before
  `'ready'`. `unsent` is true only when the client was disconnected at dispatch, no socket has
  connected since, and it is still disconnected at the failure (user decision and audits,
  2026-11-02). On a stopped server a "Command timed out" (node-redis has no retry budget) is a
  queued command that never left, so it follows the same rule; on a paused server the socket is open
  and the answer is outcome unknown. `watchConnection` also detaches the reporter after `quit()`
  when the plugin stops. `QueueService.add`, the backplane `publish` and the messaging `publish`
  wrap thrown driver errors through it, keeping the original as `cause`. `PublishTimeoutError` is
  not rewrapped: it keeps its name and gains the 504 hint itself.
- **Why:** a masked 500 tells a client nothing, and the X88-5 runs showed every 500'd job was
  applied; a 504 with that wording tells a retrying client to use an idempotency key.
- **Measurement gate (implementation step 1):** before the table is fixed, record the thrown
  `name`/`code`/message of `queue.add`, a backplane publish and a messaging publish on both clients
  against a stopped server (a closed port) and a paused one, using the throwaway `x88-redis*`
  containers (never `he-redis`, which is shared). Only measured shapes enter the table; anything
  unrecognised passes through unchanged.
- **Test home:** `common/test/unit/backend-fault.test.ts` (the classification as a data table);
  per-plugin unit cases asserting the wrapped class and `cause`; an integration test through
  `errorHandler` asserting the 503/504 Problem Details field by field; guarded real-Redis pause test
  is NOT added (pausing a shared container is forbidden) — the X88 probe is the post-release check.

### 3.7 X88-4 — ESM applications preload OpenTelemetry's hook

- **Decision:** every generated Node project (standalone or workspace member, any template) carries
  `instrumentation.mjs`, which calls
  `register('@opentelemetry/instrumentation/hook.mjs', import.meta.url)` inside a `try`/`catch` (a
  project with no instrumentation package starts normally), and passes
  `--import ./instrumentation.mjs` in the Node start scripts (after `tsx watch`, which reads its
  subcommand from the first argument) and the Node production image `CMD`, which copies the file.
  Generating it for every Node project rather than only telemetry templates means
  `setu add telemetry` never has to rewrite scripts or the Dockerfile: the preload is inert until
  `@opentelemetry/instrumentation` is installed. `setu add telemetry` adds
  `@opentelemetry/instrumentation` as a direct dependency so the hook resolves from the project root
  under any package manager. The telemetry README documents the preload for hand-written projects.
  No plugin imports `node:module`. Node only: Deno and Bun scripts are unchanged, since
  OpenTelemetry's auto-instrumentation records `unsupported platform` there anyway.
- **Why:** measured (x88-io, 2026-11-02): with `--import` of that preload a bare
  `await import('ioredis')` is wrapped; without it, not; with the hook package missing, the app
  starts and nothing is wrapped. The hook registered before the driver import is what makes a bare
  `await import('ioredis')` instrumented; it covers every lazily imported driver (`ioredis`,
  `amqplib`, `kafkajs`) and keeps the literal guarded `await import()` the Workers bundling rule
  requires. The alternative (a `createRequire` after load inside the plugin) needs a
  runtime-specific API in a plugin and resolves from the wrong root under pnpm.
- **Test home:** `cli/test/unit/telemetry-preload.test.ts` (file and flag generated per runtime; the
  generated preload starts without the hook package); guarded
  `cli/test/integration/telemetry-preload-real.test.ts`: a child Node process with the generated
  preload, the ioredis instrumentation and a lazily imported ioredis records an ioredis span;
  without the preload, none (negative control). It lives in `cli`, which owns the preload text. The
  hook matches bare specifiers only: an `import()` of ioredis by absolute path is not patched even
  with the preload (measured), which is why the child links the packages into a project.

### 3.8 X88-7 — the Redis Streams poll runs outside any request context

- **Decision:** the broker starts one poll timer and one reclaim timer in `connect()` (startup, no
  active span) that serve every subscription; `subscribe()` only registers the subscription. Each
  subscription keeps its own in-flight guard, stop flag and drain, so a slow subscription still
  skips only its own tick, and a subscription added after start is served by the running timers.
  `connect()` runs inside the plugin's `register()`
  (`messaging-plugin/src/plugin/messaging-plugin.ts:517`), so the timers carry no request context.
- **Why:** a timer created inside `subscribe()` inherits the caller's async context, so a handler
  that subscribes lazily parented thousands of poll spans to one request. Creating the timers at
  connect time needs no runtime API.
- **Test home:** messaging unit test with a recording runtime: timers are created once at
  `connect()`, none by `subscribe()`; poll still drains every subscription; `disconnect()` clears
  both.

### 3.9 X88-6 — document the node-redis bound on `publishTimeoutMs: 0`

- **Decision:** docs only: the messaging README and CHANGELOG say that `publishTimeoutMs: 0` removes
  the plugin's bound but an injected node-redis adapter still applies its own `commandTimeoutMs`
  (default 15 s), and how to raise it.
- **Test home:** none (documentation); `check:docs` gates the fence.

### 3.10 X88-8 — a bad Redis URL never reaches stderr with its password

- **Decision:** (a) the default redaction policy in `common` masks URL userinfo in every string
  value (`scheme://user:password@host` → `scheme://***@host`). That covers log metadata by default
  and traces and audit records when their plugin is given a policy; a log message string is not
  redacted, so `describeError` masks its own output before its 8192-character bound (audit finding).
  The rule is one linear pattern with no backtracking, applied to string values only and within the
  redaction seam's existing size bounds, because it runs on every logged string; (b) the generated
  `main.ts` catches a failed `app.start()`, writes one line (`describeError` passed through the same
  masking) to stderr with `console.error` and exits through `runtime.exit(1)`, instead of Node's
  default printer dumping the error's `input`. The entry keeps no runtime-specific API: no logger
  exists before plugins register, and `IRuntimeServices` has no stderr writer.
- **Why:** the URL is configuration, often holding a password; a malformed one must fail loudly
  without echoing it.
- **Test home:** `common/test/unit/redaction-url-userinfo.test.ts` (table: credentials masked;
  no-credential URLs, emails and `@` in paths untouched; a credential inside a 400 KB string is
  masked, and a pathological string scans in linear time — the mask has no length cut-off, since one
  would emit a long line's credential unmasked); `logger-plugin` integration: a metadata string with
  a credentialed URL is masked; scaffold e2e: a malformed `REDIS_URL` exits 1 and stderr carries no
  password.

### 3.11 X88-9 — queue loop failures report once per state change

- **Decision:** the recurring-scheduling and depth-probe failures go through a
  `createConnectionErrorReporter`-style state tracker: one `warn` when the failure starts (naming
  the cause), one `info` on recovery, nothing per poll in between.
- **Why:** the M119g rule; 75 error lines per 30 s outage bury the one that matters.
- **Test home:** `queue-plugin/test/unit/queue-loop-reporting.test.ts` (100 consecutive failures →
  one `warn`; recovery → one `info`; a new failure after recovery → one more `warn`).

### 3.12 X88-10 — node-redis in telemetry docs and `setu add telemetry`

- **Decision:** the telemetry card lists `redis`; `setu add telemetry` prints the registration it
  wired, adds `@opentelemetry/exporter-trace-otlp-http` and the instrumentation package for the
  project's Redis client (`instrumentation-redis` or `instrumentation-ioredis`), and the §3.7
  preload; the cache, queue, scheduler, backplane and idempotency cards show the
  `client: nodeRedisClient(url)` arm beside `url`.
- **Test home:** `cli/test/unit/add-telemetry.test.ts`; card claims are checked by `check:docs`.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. New members are optional; the status changes (V11-11's
readiness membership, X88-5's 503/504) are behaviour changes with CHANGELOG and upgrading entries.
Ships in minor `0.12.0`.

| Exported symbol                       | Kind  | Consumer / real code path that READS it                                                    |
| ------------------------------------- | ----- | ------------------------------------------------------------------------------------------ |
| `BackendUnavailableError` (common)    | class | Thrown by `toBackendFault`; read by `errorHandler` through its hint; apps `instanceof` it. |
| `BackendOutcomeUnknownError` (common) | class | Same.                                                                                      |
| `toBackendFault` (common)             | fn    | `QueueService.add`, the backplane `publish`, the messaging `publish`.                      |

### 4.1 Options — every option names its consumer

| Option                                          | Consumer                   | Behavior (per implementation)                                    |
| ----------------------------------------------- | -------------------------- | ---------------------------------------------------------------- |
| `setu add cache                                 | idempotency --store redis` | `cli` add command                                                | Wires the plugin's Redis store on `REDIS_URL` through the inferred client. |
| `setu add scheduler --lock redis`               | `cli` add command          | Wires `distributedLock: { enabled: true, storage: 'redis', … }`. |
| `setu add realtime-backplane --backplane redis` | `cli` add command          | Wires `transport: 'redis'` with two clients for node-redis.      |

## 5. Implementation files

| File                                                                                                                                                                                                                                                                                                                                                                                                                 | Purpose                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `queue-plugin/src/adapters/redis-queue.ts`, `queue-plugin/src/services/queue-service.ts`                                                                                                                                                                                                                                                                                                                             | §3.1, §3.6, §3.11                 |
| `notification-plugin/src/plugin/notification-plugin.ts`                                                                                                                                                                                                                                                                                                                                                              | §3.2                              |
| `cli/src/commands/add.ts`, `cli/src/templates/{broker,node-redis,project-files,full-stack-build-files}.ts`, `cli/src/workspace/compose.ts` (image `CMD` preload), a new `cli/src/templates/telemetry-preload.ts`                                                                                                                                                                                                     | §3.3, §3.4, §3.7, §3.10b, §3.12   |
| `cache-plugin/src/stores/redis-store.ts`, `idempotency-plugin/src/stores/redis-client.ts`, `realtime-backplane-plugin/src/transports/redis-backplane.ts`, `scheduler-plugin/src/lock/redis-lock.ts`, `messaging-plugin/src/brokers/redis-streams-broker.ts`, `queue-plugin/src/adapters/redis-queue.ts`, `auth-plugin/src/stores/redis-rate-limit-store.ts` (each returns an injected client before attaching today) | §3.5 reporter on injected clients |
| `common/src/redis/node-redis-adapter.ts`                                                                                                                                                                                                                                                                                                                                                                             | §3.5 first-connect rejection      |
| `common/src/errors/backend-fault.ts` (new), `common/src/index.ts`                                                                                                                                                                                                                                                                                                                                                    | §3.6                              |
| `messaging-plugin/src/brokers/redis-streams-broker.ts`, `messaging-plugin/src/errors.ts`                                                                                                                                                                                                                                                                                                                             | §3.6, §3.8                        |
| `realtime-backplane-plugin/src/transports/redis-backplane.ts`                                                                                                                                                                                                                                                                                                                                                        | §3.6                              |
| `common/src/redaction/{redactors,policy}.ts`                                                                                                                                                                                                                                                                                                                                                                         | §3.10a                            |
| READMEs, agent cards, `PUBLIC_API.md`, `CHANGELOG.md`, `docs/upgrading.md`, `docs/cli.md`                                                                                                                                                                                                                                                                                                                            | §2 deliverables, §3.9             |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                                               | src covered                            | Key assertions                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------- |
| `queue-plugin/test/unit/redis-queue-health.test.ts` (new) + `…/integration/redis-queue-health-real.test.ts` (new, guarded `REDIS_URL`)                  | `redis-queue.ts`                       | §3.1 table; closed port → `down`; live → `up`.                  |
| `queue-plugin/test/unit/queue-loop-reporting.test.ts` (new)                                                                                             | `queue-service.ts`                     | §3.11 counts; §3.6 `add` wrapping.                              |
| `notification-plugin/test/integration/readiness.test.ts` (new)                                                                                          | `notification-plugin.ts`               | §3.2 membership and override.                                   |
| `cli/test/unit/{add-redis-arms,start-scripts,telemetry-preload,add-telemetry}.test.ts` (new), scaffold e2e cases                                        | `add.ts`, templates, `compose.ts`      | §3.3, §3.4, §3.7, §3.10b, §3.12.                                |
| per-plugin reporter tests (existing files, new injected-client cases)                                                                                   | client setup in each plugin            | §3.5 one `warn` per state change for an injected client.        |
| `common/test/unit/node-redis-adapter.test.ts` (existing) + guarded real boot                                                                            | `node-redis-adapter.ts`                | §3.5 first-connect rejection.                                   |
| `common/test/unit/backend-fault.test.ts` (new) + `exceptions/test/integration/backend-fault-status.test.ts` (new; `errorHandler` lives in `exceptions`) | `backend-fault.ts`                     | §3.6 table; 503/504 Problem Details field by field.             |
| messaging unit (existing broker tests)                                                                                                                  | `redis-streams-broker.ts`, `errors.ts` | §3.6 publish wrapping, `PublishTimeoutError` hint; §3.8 timers. |
| backplane unit (existing)                                                                                                                               | `redis-backplane.ts`                   | §3.6 publish wrapping.                                          |
| `common/test/unit/redaction-url-userinfo.test.ts` (new)                                                                                                 | `redactors.ts`, `policy.ts`            | §3.10a table.                                                   |
| `cli/test/integration/telemetry-preload-real.test.ts` (new, guarded)                                                                                    | `telemetry-preload.ts` (docs claim)    | §3.7 span with preload, none without.                           |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m131a-redis-readiness
pnpm run check:plan
pnpm run fmt:check && pnpm run lint && pnpm run check && pnpm run check:docs
pnpm run ci:local            # final commit, all shards
pnpm run test:deno-lane
pnpm run release:publish --dry-run
pnpm run release:verify 0.11.0
```

Plus, because the CLI's generated output changes, the scaffold e2e gate
(`scaffold-runs-e2e.test.ts`) boots each template; and the post-release re-check named in the
hand-off note.

## 8. Risks & mitigations

- **The env-file flag prints a notice when `.env` is missing** → only local scripts carry it;
  container commands do not.
- **A broker-level poll timer changes delivery order across subscriptions** → the poll iterates
  subscriptions in registration order each tick, as today's per-subscription timers did in
  aggregate; covered by the existing delivery tests.
- **`toBackendFault` misclassifies a driver's new error text** → the classification is a data table
  in its test, measured shapes only; unknown errors pass through unchanged (still a masked 500).
- **The size of the letter (12 packages)** → implementation in two runs: runtime/plugin rows (§3.1,
  §3.2, §3.5, §3.6, §3.8, §3.10a, §3.11) first, CLI and docs rows second.

## 8a. Design security review

Revised 2026-11-02 for what was built (the original review predated §3.7's preload in every Node
project, the last-`@` masking rule, the dispatch-state rule in §3.6 and the reporter on injected
clients). The audit runs against this section, on the commit the PR merges.

- **Reviewed flows:**
  - F1 a Redis URL from the environment or `.env` reaching a client constructor, a thrown error, a
    log line, a trace, an audit record or stderr;
  - F2 a driver error reaching `toBackendFault` and a served Problem Details body;
  - F3 a node-redis or ioredis connection error reaching a plugin's `warn` line, including a client
    the application injected;
  - F4 the generated `instrumentation.mjs`, run by `node --import` before the application in every
    Node start script and the image `CMD`;
  - F5 the local start scripts reading `.env` (`--env-file-if-exists`, Deno `--env-file`) while
    images and Compose keep the platform environment.
- **Assets:** credentials inside Redis/AMQP/Kafka URLs; driver error text (hosts, ports, commands,
  keys); the truth of a `503` "not applied" claim, which tells a client a retry cannot duplicate
  work; log integrity and volume; what code runs before the application.
- **Attackers:** a misconfigured or hostile environment value (a malformed URL whose password holds
  unencoded `@`, `/`, `#`, `?`, `:` or whitespace); a log field an attacker controls, sized to
  defeat a scan (megabytes, many `://`); a client that sends requests during an outage and retries
  on `503`; a Redis server returning hostile error text (CR/LF, a forged URL); a file planted at
  `./instrumentation.mjs` or `.env` in the working directory.
- **Budgets:** one `warn` per plugin per connection-state change; one stderr line on a failed start;
  `maskUrlUserinfo` linear in its input with no length cut-off.
- **Audit obligations** (each with a positive and a negative control):
  1. Plant a canary password in a valid and in a malformed credentialed URL (unencoded `@`, `/`,
     `#`, `?`) and prove its absence from stderr of a failed boot, every log line (metadata and
     nested records), trace attributes and audit records; positive control: a no-credential URL, an
     email and a path `@` are logged unchanged. Record the over-mask of a path `@` after a port as
     deliberate.
  2. Prove the mask has no length cut-off and stays linear on hostile input (a credential after 200
     KB; 500 KB of scheme characters and 100 000 `://`).
  3. State the masking's scope honestly and test its edges: the log MESSAGE string is not masked
     (only metadata values); `describeError` truncates at 8192 code points before the mask runs —
     prove whether a URL cut by that bound can leak part of a password.
  4. Prove the 503/504 bodies carry only the fixed `detail` (no host, port, command, key or canary
     from the driver error), under both error formats.
  5. Prove a `503` is answered only where the request cannot have been applied: every
     lost-connection shape with the client connected at dispatch, or with no status, answers `504`;
     `Command timed out` follows the same rule (a paused server, socket open, answers `504`).
  6. Prove CR/LF or ANSI text in a driver error cannot split or forge a `warn` line or the stderr
     start line.
  7. Prove the reporter attached to an injected client does not keep the stopped application alive
     or route a later client error into a stopped application's logger in a way that leaks or
     throws; record the listener lifetime.
  8. Prove the preload loads only `@opentelemetry/instrumentation/hook.mjs`, resolved from the
     project root, swallows only its own failure, and that the image copies the generated file and
     no `.env` (the Dockerfile ignores `.env`; images pass no env-file flag).

| Threat                                             | Resolution                                                           |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| Password echoed by Node's default error printer    | §3.10b catch in `main.ts` and `dev.ts`, masked single line           |
| Password inside a logged or traced string          | §3.10a URL-userinfo rule in the default policy, last-`@`, no cut-off |
| Masking defeated by a long or crafted value        | Linear scan, no length bound (obligation 2)                          |
| Driver text served to clients                      | §3.6 fixed details; driver error only as `cause`                     |
| A false `503` invites a duplicating retry          | §3.6 dispatch-state rule; unknown state answers `504`                |
| Log flood during an outage                         | §3.5, §3.11 once per state change                                    |
| Code run before the app from the working directory | §3.7 generated preload, fixed specifier, image copies the file       |
| `.env` secrets reaching an image                   | §3.4 no flag in images; `.dockerignore` excludes dotenv files        |

## 9. Out of scope

- Cache-plugin's existing 503 mapping for timeouts (a write may have applied) — unchanged; noted.
- Operator recovery after FLUSHALL (NOGROUP loop) — not a row.
- Deno and Bun auto-instrumentation — unsupported by OpenTelemetry's Node hooks.
