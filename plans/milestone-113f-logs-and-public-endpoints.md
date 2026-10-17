# Milestone 113f — What Reaches Logs and Public Endpoints (`@setu-ts/exceptions`, `@setu-ts/logger-plugin`, `@setu-ts/database-plugin`, `@setu-ts/health-plugin`, `@setu-ts/openapi-plugin`)

> **Status:** Planning. Branch: `feat/m113f-logs-and-public-endpoints`. `develop` and `main` are
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR.

## 0. Objective & scope

Seven findings from the `v0.9.0` smoke run, one shape: data reaches a log or a public endpoint that
should not, and the log lies about what happened. The maintainer's decisions (2026-10-17), each
checked against how Spring Boot, ASP.NET Core, EF Core, Django, Express and FastAPI/NestJS handle
it, are recorded in §3.

- **In scope:**
  - **V9-45** (`database-plugin`): a Drizzle query error carries the bound values into its message
    and stack, and both reach the error log. Keep the SQL, drop the values (EF Core's default).
  - **V9-47** (`health-plugin`): `/live`, `/ready` and `/health` are public and return every
    indicator's `data`, including the runtime version and pod hostname. Status only by default;
    `HealthPlugin({ details: true })` restores the data (Spring Boot `show-details: never`).
  - **V9-43** (`exceptions` + `logger-plugin`): an expected 4xx is logged twice at `error`, once
    with a stack. Log it once, from `errorHandler`, at `warn` for 4xx and `error` for 5xx (Django).
  - **V9-80** (`logger-plugin` + `exceptions` + `common`): the request logger logs `status: 200` for
    every request that failed through `errorHandler`. Log the status `errorHandler` serves.
  - **V9-82** (`common` + `runtime` + `kernel` + `exceptions`): with no logger registered an
    unhandled 500 is logged nowhere. The runtime supplies a default error sink (stderr), as every
    compared framework ships a default sink.
  - **V9-41** (`logger-plugin`): `LoggerPluginOptions.excludePaths` is `readonly string[]` while the
    middleware takes `PathPattern[]`.
  - **V9-49** (`openapi-plugin` + `cli`): `/docs` loads Swagger UI from `unpkg.com/...@5`, a
    floating major with no integrity hash. Self-host by default (NestJS); pinned CDN with SRI as an
    explicit opt-in.
- **NOT this milestone:** a redaction policy for log messages in general (M96 covers fields, not
  free text); trace ids on `errorHandler`'s own log line (it runs outside the telemetry span at
  priority 0 — pre-existing, unowned); request-scoped error reporting for non-HTTP ingress.

## 1. Contracts verified from SOURCE (not names)

| Reference                          | Source (file:line)                                                                                 | Verified surface / fact                                                                                                                                                                                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DrizzleQueryError`                | `node_modules/.pnpm/drizzle-orm@0.45.2_…/node_modules/drizzle-orm/errors.js:10-18`                 | `super(\`Failed query: ${query}\nparams: ${params}\`)`; own `query`, `params`, `cause`. The `stack`'s first line repeats the message, so the values appear in BOTH `message`and`stack`                                                                                 |
| `classifiedOrOriginal`             | `packages/database-plugin/src/services/database-service.ts:83-103`, called at :265/295/318/497…583 | The one funnel every adapter error passes through; wraps conflict/unavailable/duplicate with the driver error as `cause`, else returns the ORIGINAL                                                                                                                    |
| `serializeError`                   | `packages/common/src/errors/serialize-error.ts:160-240`                                            | Copies `name`, `message`, `stack`, `cause` (recursively) and `CLASSIFIER_KEYS` (`code`, `errno`, `syscall`, `severity`, `constraint`, `codeName`, `statusCode`) — NOT `detail`, so a pg error's `Key (email)=(…)` detail is not logged; its message carries no values  |
| `errorHandler` status rule         | `packages/exceptions/src/middleware/error-handler.ts:178-250`                                      | `HttpError` → its `statusCode`; otherwise `httpStatusHintOf` → hint status; otherwise `500`; then `resolveResponseStatus` clamps (`common/src/errors/error-responder.ts:308`)                                                                                          |
| `logError`                         | `packages/exceptions/src/middleware/error-handler.ts:327-339`                                      | `logger.error(error.message, { statusCode, requestId, cause })` for every status; silently nothing without `CAPABILITIES.LOGGER`                                                                                                                                       |
| `IErrorResponder`                  | `packages/common/src/errors/error-responder.ts:170-178`                                            | One member, `respond(target, init)`; published by `errorHandler` under `ERROR_RESPONDER_STATE_KEY` BEFORE `next()` (`error-handler.ts:174`)                                                                                                                            |
| Request logger                     | `packages/logger-plugin/src/middleware/request-logger.ts:53-105`                                   | On a throw: logs `request failed` at `error` with the stack, rethrows; `finally` reads `ctx.response.snapshot().status` (still 200) for `request completed`                                                                                                            |
| Request logger priority            | `packages/logger-plugin/src/plugin/logger-plugin.ts:150-156`                                       | `PLUGIN_PRIORITY.HIGH` (100), inside `errorHandler` (0, `rest-starter/src/app.ts:101`) and inside telemetry (30), so its lines carry trace ids (M90i). Moving it outermost would lose them — the reason §3.4 does not                                                  |
| `LoggerPluginOptions.excludePaths` | `packages/logger-plugin/src/plugin/logger-plugin.ts:65, 304-310`                                   | `readonly string[]`; the middleware option (`request-logger.ts:32`) is `readonly PathPattern[]`                                                                                                                                                                        |
| Kernel unhandled-error report      | `packages/kernel/src/application/application.ts:2132-2150`                                         | `#reportUnhandledError` logs through `CAPABILITIES.LOGGER` or degrades silently (the no-console rule)                                                                                                                                                                  |
| `IRuntimeServices`                 | `packages/common/src/runtime.ts:303-445`                                                           | Optional members precedent: `fs?`, `workers?`, `dns?`, `onSignal?` (absent = the runtime cannot do it). No error sink today                                                                                                                                            |
| Health endpoints                   | `packages/health-plugin/src/plugin/health-plugin.ts:241-280`                                       | `createHealthHandler` serializes the full `HealthReport` (`checks[*].data` included) for `/health`, `/live`, `/ready`; `self` indicator data = `{ platform, version, hostname }` (`indicators/self-indicator.ts:33-37`)                                                |
| `OpenApiPlugin` Swagger            | `packages/openapi-plugin/src/plugin/openapi-plugin.ts:21, 88, 171`; `ui/swagger-ui.ts:34-50`       | `swagger?: boolean`, default `true`; the HTML loads `unpkg.com/swagger-ui-dist@5/{swagger-ui.css, swagger-ui-bundle.js, swagger-ui-standalone-preset.js}` with no `integrity`                                                                                          |
| `swagger-ui-dist`                  | npm `swagger-ui-dist@5.33.3` (packed and read, 2026-10-17)                                         | `absolute-path.js` exports `getAbsoluteFSPath()`; `index.js` also `require`s the 1.5 MB bundles, so import `swagger-ui-dist/absolute-path.js`, not the main entry. Ships `swagger-ui.css`, `swagger-ui-bundle.js`, `swagger-ui-standalone-preset.js`; package is 12 MB |
| Templates using `OpenApiPlugin`    | `packages/cli/src/templates/rest.ts:46`; `packages/starters/rest-starter/src/app.ts:51`            | Every inline template composed from `rest`, and every starter, registers it with Swagger on                                                                                                                                                                            |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                             | Resolution (picked side)                            | Doc deliverable (same PR)                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------- |
| C1  | logger README / middleware document `excludePaths` as `PathPattern[]`; `LoggerPluginOptions` says `string[]` (V9-41) | Widen the plugin option to `readonly PathPattern[]` | logger README options table, `PUBLIC_API.md` `LoggerPluginOptions` row          |
| C2  | Health README/PUBLIC_API show the full report with `data` as the endpoint response                                   | Status-only default (§3.2)                          | health README, `PUBLIC_API.md` health section, `docs/deployment.md` probe notes |
| C3  | No README says the logger is the only error sink (V9-82)                                                             | A default sink now exists (§3.5)                    | logger + exceptions READMEs, `PUBLIC_API.md` `IRuntimeServices` row             |

## 3. Design decisions

### 3.1 V9-45 — Drizzle query errors keep the SQL, lose the values

- **Decision:** a new internal `scrubDriverError(error)` in
  `packages/database-plugin/src/errors/scrub.ts`, applied inside `classifiedOrOriginal` to the error
  BEFORE classification wraps it (so the wrapper's `cause` is scrubbed too), and to the returned
  original. It walks the `cause` chain (bounded at the classifier's `MAX_CAUSE_DEPTH`, 5). A node is
  a Drizzle query error when it is an `Error` with an own string `query` and own array `params` and
  a message starting `Failed query: `. Such a node is replaced by a new `Error` (same `name`) whose
  `message` is `Failed query: <query>`, whose `stack` is that message followed by the original
  stack's frame lines (the first line, which repeats the old message, is dropped), whose `cause` is
  the scrubbed next node, and which carries `query` but NOT `params`. Every other node is returned
  unchanged. Classification still reads the original chain (codes live on the pg error, which is
  kept).
- **Why:** the SQL with placeholders is the operator's diagnostic; the values are user data. EF Core
  omits values by default; Laravel added masking after the same leak.
- **Test home:** `database-plugin/test/unit/errors/scrub.test.ts`;
  `test/integration/driver-error-log.test.ts` (a real `pg-proxy` Drizzle instance whose driver
  rejects; the log record through a real kernel app with `errorHandler` + a recording logger
  contains the SQL and none of the bound values, in message AND stack).

### 3.2 V9-47 — health endpoints answer status only by default

- **Decision:** `HealthPluginOptions.details?: boolean`, default `false`. With `false`, the three
  HTTP handlers serialize `{ status, timestamp, checks: { <name>: { status } } }` — each check's
  `data` and `latencyMs` omitted — while the HTTP status codes are unchanged. `true` serializes
  today's full report. The programmatic `HealthService` (`check`/`checkLive`/`checkReady`), the gRPC
  bridge, and diagnostics keep the full report: the projection is in the HTTP handler only. A
  non-boolean `details` throws `TypeError` at `HealthPlugin(...)`.
- **Why:** Spring Boot defaults `show-details: never`; ASP.NET Core's default writer answers a plain
  status. Probes need only the status.
- **Breaking:** yes — a dashboard reading `checks[*].data` sets `details: true`. CHANGELOG + upgrade
  guide.
- **Test home:** `health-plugin/test/integration/details.test.ts` (real app: default omits `data`,
  `version`, `hostname` on all three endpoints, status codes unchanged; `details: true` restores
  them; `HealthService.check()` still returns data; refusal).

### 3.3 V9-43 — one error log, level by status

- **Decision:** `errorHandler`'s `logError` logs at `warn` when the served status is below 500 and
  at `error` otherwise; the record shape is unchanged. The request logger stops logging
  `request failed` (§3.4). The kernel's own unhandled-error report (no `errorHandler`) stays at
  `error`.
- **Why:** Django: 4xx `WARNING`, 5xx `ERROR`. One owner per error.
- **Test home:** `exceptions/test/unit/error-handler-logging.test.ts` (404 → one `warn`, no stack
  field; 500 → one `error`); `logger-plugin/test/integration/request-status.test.ts` (one error
  record per failed request across both packages).

### 3.4 V9-80 — the request logger logs the status `errorHandler` serves

- **Decision:** `IErrorResponder` gains an OPTIONAL `statusFor?(error: unknown): number` returning
  the status the responder's owner serves for a thrown value. `createErrorResponder` in `exceptions`
  implements it with the exact `errorHandler` rule (§1), extracted into one internal function that
  the `errorHandler` catch block ALSO calls for the status it serves — one implementation.
  `statusFor` must be PURE: `resolveResponseStatus` logs when it clamps (`error-responder.ts:341`),
  so the shared rule uses a non-reporting range check and only the serving path calls the reporting
  `resolveResponseStatus` — otherwise one clamped error is reported twice. The request logger, on a
  throw: reads the responder from `ERROR_RESPONDER_STATE_KEY`; status = `responder.statusFor(err)`
  when present, else `500` (the kernel's fallback status); logs `request completed` with that status
  from `finally`, and rethrows. On a normal return it keeps reading
  `ctx.response.snapshot().status`. It no longer logs `request failed`. The logger stays at priority
  100 (inside telemetry, so trace ids are kept).
- **Limit (documented):** an `ErrorHandlerOptions.respond` hook (M94a) that serves a different
  status than the rule is not reflected; the logger reports the rule's status.
- **Test home:** `logger-plugin/test/integration/request-status.test.ts` (real app with
  `errorHandler`: a thrown 404 HttpError logs `status: 404`, a thrown `Error` `500`, a hinted error
  its hint status, a clamped status `500`; without `errorHandler` a thrown `Error` logs `500`);
  `exceptions` unit test that `statusFor` and the served status agree for each case.

### 3.5 V9-82 — the runtime's default error sink

- **Decision:** `IRuntimeServices` gains an OPTIONAL
  `reportError?(record: Readonly<Record<string, unknown>>): void`, documented as the runtime's
  last-resort error sink: it writes `JSON.stringify(record)` plus a newline to the process's
  standard error and never throws (a serialization or write failure is swallowed). Implemented in
  `packages/runtime`: Node and Bun via `process.stderr.write` (static `node:process` import), Deno
  via `Deno.stderr.writeSync` with `TextEncoder`, Cloudflare Workers via `console.error` under a
  scoped `eslint-disable-next-line no-console -- runtime sink (M113f)` — Workers has no stderr
  stream and `console` is its log channel. Consumers, each only when `CAPABILITIES.LOGGER` is NOT
  registered: the kernel's `#reportUnhandledError` (record
  `{ level: 'error', message: 'Unhandled request error', ...serializeError(error), requestId, method, path }`),
  and `errorHandler`'s `logError` for a served status ≥ 500 only (4xx stays silent without a
  logger).
- **Why:** every compared framework has a default sink; the no-console rule confines it to
  `runtime`.
- **Test home:** `runtime/test/unit/report-error.test.ts` (each adapter writes one JSON line; a
  throwing writer is swallowed); `kernel` and `exceptions` unit tests (no logger →
  `runtime.reportError` called once with the record; with a logger → not called).

### 3.6 V9-41 — `excludePaths` takes patterns

- **Decision:** `LoggerPluginOptions.excludePaths?: readonly PathPattern[]` (import `PathPattern`
  from `common`), passed through unchanged to the middleware. Source-compatible.
- **Test home:** `logger-plugin/test/unit/logger-plugin-options.test.ts` (a `RegExp` entry excludes
  a path through the plugin).

### 3.7 V9-49 — Swagger UI self-hosted by default

- **Decision:** `OpenApiPluginOptions.swagger?: boolean | SwaggerOptions`, where
  `SwaggerOptions = { readonly assets?: 'self' | 'cdn' | { readonly baseUrl: string } }`. `true` and
  `{}` mean `assets: 'self'`.
  - **`'self'`** (default): `register()` awaits a guarded literal
    `import('swagger-ui-dist/absolute-path.js')` inside a `try` (the M113d rule), calls
    `getAbsoluteFSPath()`, reads the three files once through `runtime.fs.readFile`, and serves them
    at `<endpoint>/swagger-ui.css`, `<endpoint>/swagger-ui-bundle.js`,
    `<endpoint>/swagger-ui-standalone-preset.js` with the correct content types and
    `Cache-Control: public, max-age=3600`. A missing package fails `register()` with
    `OptionalDependencyUnavailableError` naming `swagger-ui-dist` and both remedies (install it, or
    `assets: 'cdn'`). No `runtime.fs` (Workers) fails `register()` naming `assets: 'cdn'` and
    `{ baseUrl }`.
  - **`'cdn'`**: loads from `https://unpkg.com/swagger-ui-dist@<PINNED>/…` with
    `integrity="sha384-…"` and `crossorigin="anonymous"` on each tag; `<PINNED>` = `5.33.3`, and the
    three hashes are computed from that version's real files and committed as constants.
  - **`{ baseUrl }`**: the same tags and hashes against `<baseUrl>/<file>`; a `baseUrl` that is not
    an absolute `https:`/`http:` URL or a path starting `/` is refused at construction.
  - `swagger-ui-dist` is an OPTIONAL peer (range `^5`) in the generated manifest table, plus a dev
    dependency for tests.
  - **Spec exclusion:** the three asset routes are added to the plugin's `excludedPaths`
    (`openapi-plugin.ts:97`) beside `endpoint`, so they never appear as API operations.
  - **CLI:** every generated project whose template registers `OpenApiPlugin` declares
    `swagger-ui-dist` through `TemplateManifest.npmDependencies`
    (`cli/src/templates/registry.ts:232`), reaching each target's manifest form (`package.json` for
    Node/Bun, the `deno.json` import map for Deno — verify how `npmDependencies` reaches a Deno
    target and extend it if it does not). A Cloudflare Workers target renders
    `OpenApiPlugin({ swagger: { assets: 'cdn' } })` through the template's
    `runtimeSwaps['cloudflare-workers']` (the M59 mechanism, `templates/microservice.ts:202`). The
    `full-stack` template composes through `rest-starter`'s `openapi` option, so it declares the
    dependency the same way and its Workers target passes `openapi: { swagger: { assets: 'cdn' } }`.
  - **Starters:** `rest-starter` documents the requirement; no default change (it forwards
    `options.openapi`).
- **Breaking:** an app upgrading with Swagger on and without `swagger-ui-dist` installed fails at
  startup with the named error. CHANGELOG + upgrade guide.
- **Test home:** `openapi-plugin/test/unit/swagger-assets.test.ts` (option resolution, refusals,
  HTML for each mode, hashes present only for `cdn`/`baseUrl`);
  `test/integration/swagger-self-host.test.ts` (guarded REAL import of `swagger-ui-dist`; the three
  files served with the right type and bytes equal to the package's); CLI template tests and the
  scaffold boot gate (`/docs` 200 and its assets 200 on a booted Node/Deno project; the Workers
  template renders `assets: 'cdn'`).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none — `IErrorResponder.statusFor?` and
`IRuntimeServices.reportError?` are optional. Behaviour changes (§3.2 health default, §3.7 Swagger
self-host) ship in minor 0.10.0 with CHANGELOG and upgrade-guide entries.

| Exported symbol                       | Kind          | Consumer / real code path that READS it                                  |
| ------------------------------------- | ------------- | ------------------------------------------------------------------------ |
| `IErrorResponder.statusFor?` (common) | method        | logger-plugin request logger (§3.4); `errorHandler` serves the same rule |
| `IRuntimeServices.reportError?`       | method        | kernel `#reportUnhandledError`; `errorHandler` `logError` (§3.5)         |
| `HealthPluginOptions.details`         | option member | health HTTP handlers (§3.2)                                              |
| `SwaggerOptions` (openapi-plugin)     | type          | `OpenApiPluginOptions.swagger`; CLI Workers template                     |
| `LoggerPluginOptions.excludePaths`    | option member | request-logger middleware (widened type)                                 |

### 4.1 Options — every option names its consumer

| Option                           | Consumer                    | Behavior (per implementation)                               |
| -------------------------------- | --------------------------- | ----------------------------------------------------------- |
| `HealthPlugin({ details })`      | `createHealthHandler`       | `false` (default): status only; `true`: full report         |
| `OpenApiPlugin({ swagger })`     | `register()` + Swagger HTML | `'self'` default; `'cdn'` pinned + SRI; `{ baseUrl }` + SRI |
| `LoggerPlugin({ excludePaths })` | request logger              | strings and `RegExp`s, as the middleware already accepts    |

## 5. Implementation files

| File                                                                                           | Purpose                                                                                     |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `packages/common/src/errors/error-responder.ts`                                                | `IErrorResponder.statusFor?`                                                                |
| `packages/common/src/runtime.ts`                                                               | `IRuntimeServices.reportError?`                                                             |
| `packages/runtime/src/adapters/{node,deno,bun}/*-runtime.ts`, `adapters/workers/cf-runtime.ts` | `reportError` per runtime                                                                   |
| `packages/kernel/src/application/application.ts`                                               | `#reportUnhandledError` falls back to `runtime.reportError`                                 |
| `packages/exceptions/src/middleware/error-handler.ts` + responder                              | shared status rule; `statusFor`; level by status; sink fallback                             |
| `packages/logger-plugin/src/middleware/request-logger.ts`                                      | status from `statusFor`; no `request failed`                                                |
| `packages/logger-plugin/src/plugin/logger-plugin.ts`                                           | `excludePaths` type                                                                         |
| `packages/database-plugin/src/errors/scrub.ts` (new) + `database-service.ts`                   | `scrubDriverError` applied in `classifiedOrOriginal`                                        |
| `packages/health-plugin/src/plugin/health-plugin.ts` + `interfaces/index.ts`                   | `details` option and projection                                                             |
| `packages/openapi-plugin/src/ui/swagger-ui.ts`, `plugin/openapi-plugin.ts`, `src/index.ts`     | asset modes, serving, `SwaggerOptions` export                                               |
| `packages/cli/src/templates/…`                                                                 | `swagger-ui-dist` dependency; Workers `assets: 'cdn'`                                       |
| Manifest range table (`scripts/node-manifests.ts` inputs)                                      | `swagger-ui-dist` optional peer + dev dependency                                            |
| Docs                                                                                           | §2 deliverables, CHANGELOG `Unreleased`, `docs/upgrading.md`, ROADMAP row, CLAUDE.md status |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                       | src covered                          | Key assertions                                                                                                                           |
| ----------------------------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `database-plugin/test/unit/errors/scrub.test.ts`                                                | `errors/scrub.ts`                    | Drizzle node scrubbed (message, stack, no `params`, `query` kept); non-Drizzle nodes untouched; depth bound; cause chain preserved       |
| `database-plugin/test/integration/driver-error-log.test.ts`                                     | `database-service.ts`                | Real `pg-proxy` Drizzle rejection through a kernel app: SQL logged, bound values absent from message AND stack; classification unchanged |
| `health-plugin/test/integration/details.test.ts`                                                | `health-plugin.ts`                   | §3.2 assertions                                                                                                                          |
| `exceptions/test/unit/error-handler-logging.test.ts`                                            | `error-handler.ts`, responder        | §3.3 levels; `statusFor` equals served status for HttpError / hint / plain / clamped; no-logger 5xx → `reportError` once, 4xx → none     |
| `logger-plugin/test/integration/request-status.test.ts`                                         | `request-logger.ts`                  | §3.4 assertions; exactly one error-level record per failed request                                                                       |
| `logger-plugin/test/unit/logger-plugin-options.test.ts`                                         | `logger-plugin.ts`                   | §3.6                                                                                                                                     |
| `runtime/test/unit/report-error.test.ts`                                                        | adapters                             | §3.5                                                                                                                                     |
| `kernel/test/unit/unhandled-error-sink.test.ts`                                                 | `application.ts`                     | no logger → `reportError` record; logger → logger only                                                                                   |
| `openapi-plugin/test/unit/swagger-assets.test.ts`, `test/integration/swagger-self-host.test.ts` | `swagger-ui.ts`, `openapi-plugin.ts` | §3.7                                                                                                                                     |
| CLI template unit tests + `scaffold-runs-e2e`                                                   | `cli/src/templates/…`                | §3.7 CLI assertions; a booted scaffold serves `/docs` and its assets                                                                     |

Negative controls (each observed failing, then reverted): (1) skip the scrub → the integration log
contains a bound value; (2) scrub only `message` → the value survives in the stack; (3) request
logger reads `snapshot().status` again → logged 200; (4) `logError` always `error` → the 404 case
fails; (5) health projection removed → `hostname` present; (6) drop SRI attributes → the `cdn` HTML
test fails; (7) no-logger sink call removed → `reportError` not called.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m113f-logs-and-public-endpoints
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run check:docs
pnpm run test:tooling
pnpm test:coverage common runtime kernel exceptions logger-plugin database-plugin health-plugin openapi-plugin cli
pnpm test:coverage            # the full suite, once, captured to a log
pnpm run test:deno-lane
pnpm run release:publish --dry-run && pnpm run release:verify 0.9.0
```

## 8. Risks & mitigations

- **Swagger self-host breaks upgrades** → named startup error with both remedies; CHANGELOG and
  upgrade guide; every generated project declares the package.
- **A scrubber that misses a Drizzle shape** (another driver wrapper, a future drizzle message) →
  detection keys on own `query`/`params` and the `Failed query: ` prefix; the integration test
  drives the real drizzle-orm 0.45.2 error; other drivers' messages carry no values (pg's `detail`
  is not serialized).
- **Hidden health data consumers** → `details: true` restores the old body exactly.
- **`statusFor` diverging from the served status** → one shared function, and a test per branch.

## 9. Out of scope

- Free-text redaction of arbitrary log messages (M96 is field-based). Unowned.
- Trace ids on `errorHandler`'s log line (it runs outside the telemetry span). Unowned.
- A Swagger alternative viewer (Redoc, Scalar). Unowned.

## 10. Design security review

| #   | Threat                                                         | Mitigation in the design                                                                                   |
| --- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| S1  | User data (bound values) reaches logs via driver errors        | §3.1 scrub of message and stack, applied at the single funnel                                              |
| S2  | Public probes disclose runtime version, hostname, backend data | §3.2 status-only default                                                                                   |
| S3  | Tampered or floating third-party script on `/docs`             | §3.7 self-hosted by default; CDN only pinned with SRI                                                      |
| S4  | Self-hosted asset route serves arbitrary files                 | Exactly three fixed file names read at `register()`; no path from the request                              |
| S5  | The stderr sink leaks what the logger would have redacted      | The sink receives only `serializeError` output (already scrubbed by §3.1) plus request id, method and path |
| S6  | Error-level alerting blinded or flooded                        | §3.3/§3.4: one record per error, 4xx at `warn`, true statuses                                              |

A committed-tree security audit runs before the PR, in a fresh context.
