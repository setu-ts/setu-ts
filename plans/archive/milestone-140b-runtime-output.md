# Milestone 140b — Workers, Deno and Bun project output (`@setu-ts/cli`)

> **Status:** Complete. Branch: `feat/m140b-runtime-output`. `develop` and `main` are protected, so
> all work, including fixes, stays on this one branch until it merges through a single PR into
> `develop`.

## 0. Objective & scope

ROADMAP M140b: the runtime-specific rows of the 2026-11-12/13 generated-code review
(`smoke/GENERATED-CODE-REVIEW.md`, read on `develop` `1fa2996b9`, every claim re-checked against
`develop` `8f4f226f2`). What `packages/cli` writes for a Cloudflare Workers, Deno or Bun project
names commands, exports and files that do not exist there, or describes the Node failure mode. Each
fix lands in the generator; no framework package changes.

- **In scope (10 rows):**
  - **Workers queue and cron wiring:** V12-102 (`setu add queue` installs a per-isolate memory
    queue), V12-103 (`wrangler.toml` names `queue`/`scheduled` exports the entry lacks).
  - **Workers files that are wrong or leftover:** V12-104 (a `deno.json` whose `start` cannot run),
    V12-106 (the Durable Object example pairs the wrong binding and class), V12-107 (Node wording in
    Workers files), V12-109 (no deploy section; probes nothing consumes), V12-105 framework half
    (the module sample's comment names a process restart; per-isolate `/metrics` undocumented).
  - **Deno README:** V12-118 (`deno task build` named where no such task exists).
  - **Empty environment values:** V12-80 (`PORT=` binds port 0), V12-124 (`REDIS_URL=` defeats the
    fallback).
- **NOT this milestone:**
  - **V12-105's application half** (the sample `Map` store itself): `smoke/PRODUCT-DEFECTS.md`.
  - **V12-108** (the Workers `.gitignore`): fixed in M140a (`project-files.ts` already ignores
    `.dev.vars.*`).
  - **Images, Compose, Kubernetes, workspace gRPC** (M140c, in parallel on `feat/m140c-…`),
    **generators and the agent brief** (M140d), **documentation pages** (M140e — this milestone
    ships only the CHANGELOG entry and the generated text itself).
  - **`setu add messaging` on Workers** (the same per-isolate shape for the in-memory broker) and
    the full-stack starter's default memory queue on Workers: not reviewed rows; recorded as
    follow-ups in §9.

## 1. Contracts verified from SOURCE (not names)

| Reference                                    | Source (file:line)                                                                                                                                                                                                                                                                                                                         | Verified surface / fact                                                                                                                                                                                                                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers entry renderer                       | `cli/src/templates/project-files.ts:884-1105` (`workersEntry`)                                                                                                                                                                                                                                                                             | Exports `fetch` plus one export per `WorkerExport`; each generated export inlines `acquire(env)` / `try` / `finally release(booted)`. `acquire`, `release`, `boot` are module-private. Imports `waitUntil` from `cloudflare:workers` (`:901`).                                           |
| `WorkerExport` / `RuntimeSwap.workerExports` | `cli/src/templates/registry.ts:520-606`                                                                                                                                                                                                                                                                                                    | `name`, `payloadType`, `payloadPkg`, `routes[]` (`queueName`, `pkg`, `symbol`); only `microservice`'s Workers swap declares one (`templates/microservice.ts:144-157`, a `queue` export routing `messages` and `jobs`). `rest`'s swap declares none (`templates/rest.ts:97-108`).         |
| `wrangler.toml` renderer                     | `cli/src/templates/project-files.ts:2389-2450`                                                                                                                                                                                                                                                                                             | Unconditional comments: consumer "drives the `queue` export in src/index.ts" (`:2424`), DO `name = "REPLY_INBOX"` + `class_name = "RealtimeBackplaneObject"` (`:2444-2445`), Cron "drives the `scheduled` export" (`:2451`).                                                             |
| `createQueueHandler`                         | `cloudflare-plugin/src/queues/queue-handler.ts:78`                                                                                                                                                                                                                                                                                         | `(app: IApplication, options?) => (batch) => Promise<void>`; throws `CloudflareUnsupportedError` unless `queue` resolves to a `WorkersQueue`.                                                                                                                                            |
| `createScheduledHandler` / `WorkersCron`     | `cloudflare-plugin/src/cron/scheduled-handler.ts:49`, `cron/workers-cron.ts:45-52`                                                                                                                                                                                                                                                         | Takes a `WorkersCron` (not the app); `WorkersCronOptions` is `{ logger? }`; `WorkersCron` is application-constructed and not in the registry. README section "Queues, Cron Triggers, and the edge cache" (`cloudflare-plugin/README.md:96`).                                             |
| Backplane DO binding naming                  | `cloudflare-plugin/README.md:373-400`                                                                                                                                                                                                                                                                                                      | The backplane stanza is `name = "REALTIME"`, `class_name = "RealtimeBackplaneObject"`; `REPLY_INBOX` is the `messaging.rpc` binding (`:172`, `:200`).                                                                                                                                    |
| `RUNTIME_RESTRICTIONS`                       | `cli/src/commands/add.ts:307-325`; consumers `add.ts:1964-1968`, `agents/not-installed.ts:17`                                                                                                                                                                                                                                              | `pkg → { runtimes, reason }`; `add` refuses with `Cannot add <spec> to a <runtime> project: <reason>.`; the brief omits a refused package from "not installed". `scheduler-plugin` is the X9-2 precedent (refused on Workers).                                                           |
| `QueuePlugin` default                        | `queue-plugin/src/plugin/queue-plugin.ts:83`, `services/queue-service.ts:486`                                                                                                                                                                                                                                                              | Defaults to the memory adapter, driven by a `setInterval` poll — per isolate on Workers.                                                                                                                                                                                                 |
| `--queue`/`--broker` Workers refusal         | `cli/src/commands/add.ts:2091-2097`, `templates/broker.ts:347-353`                                                                                                                                                                                                                                                                         | Only the flags are refused on Workers; a bare `setu add queue` proceeds.                                                                                                                                                                                                                 |
| Workers `deno.json`                          | `cli/src/templates/project-files.ts:2228-2270` (emitted for both `deno` and `cloudflare-workers`), `denoTasks` `:1251-1300`                                                                                                                                                                                                                | Workers gets `start: deno serve … src/index.ts` (`:1268-1270`), the root fmt/lint settings and the `@std/*` import map. Workers always gets a `package.json` with `NPM_TOOLING_SCRIPTS`, `dev`/`deploy` = wrangler (`standaloneNpmFiles`, `:1875-1910`).                                 |
| Runtime detection without `deno.json`        | `cli/src/utils/runtime-detector.ts:82,113-115`                                                                                                                                                                                                                                                                                             | Wrangler config decides `cloudflare-workers` first; `deno.json` is not read for a Workers project. Comment at `:100-104` claims Workers carries `deno.json` "which `setu generate` reads for plugin gating".                                                                             |
| Plugin gating without `deno.json`            | `cli/src/utils/plugin-detector.ts:61-77`                                                                                                                                                                                                                                                                                                   | Reads `deno.json` imports, and falls back to `package.json` `dependencies`+`devDependencies` when absent — a Workers `package.json` lists every framework package (`npmDependencies`, `:1876-1879`).                                                                                     |
| `setu add` manifest writes                   | `cli/src/commands/add.ts:1970-1990`                                                                                                                                                                                                                                                                                                        | Writes `deno.json`, `deno.jsonc` and `package.json` each only when present; comment claims a Workers project carries both.                                                                                                                                                               |
| Deno README Production                       | `cli/src/templates/project-files.ts:2099-2104`                                                                                                                                                                                                                                                                                             | Deno branch always prints `deno task build\ndeno task start`; Bun prints `bun run build` only when `manifest?.npmBuild` is set; `denoTasks` emits `build` only for `npmBuild` (`:1302-1304`).                                                                                            |
| Port reads                                   | `cli/src/templates/project-files.ts:709`, `templates/full-stack-build-files.ts:382-383`, `devtool/dev-entry.ts:87-88`                                                                                                                                                                                                                      | `Number(runtime.env.PORT ?? '3000')`, `Number(runtime.env.VITE_PORT ?? '5173')`; `''` passes `??`, so `Number('')` is `0`.                                                                                                                                                               |
| Connection reads                             | `cli/src/workspace/runtime-profile.ts:125-142` (`denoEnvRead`, `nodeEnvRead`); callers `workspace/transport.ts:581`, `workspace/discovery-module.ts:124`                                                                                                                                                                                   | Every generated broker/Redis URL and discovery host read is `Deno.env.get('X') ??\n<10 sp>'fallback'` or `process.env.X ??\n…`; `.env.example` rows are empty (`envExampleContents`).                                                                                                    |
| Readers of the generated `??` form           | `cli/src/workspace/adopt.ts:545,585` (`rewriteEntryPort` regex on `main.ts`); `devtool/dev-entry.ts:196-261` (`devEntryVariants`, `isDevEntry`, `devEntryPort`); `templates/full-stack-build-files.ts:493-517` (`fullStackDevEntryVariants`, used by `commands/adopt.ts:515`); `utils/render-call.ts:154`; `templates/node-redis.ts:54-66` | Only `rewriteEntryPort` matches the operator in a regex. The dev-entry recognizers compare against renderings from the same renderers, so they follow the change. `render-call` already parses the logical-or operator; `nodeRedisCall` re-indents by line and never reads the operator. |
| Generated lint rules                         | `cli/src/templates/npm-tooling.ts:65-90`, `templates/root-settings.ts:68`                                                                                                                                                                                                                                                                  | `js.configs.recommended` + `tseslint.configs.recommended` (no `prefer-nullish-coalescing`); Deno uses the `deno lint` defaults — a logical-or on a `string or undefined` read passes both.                                                                                               |
| Wording sites (V12-107)                      | `project-files.ts:390,536` (`main.ts` owns that), `:270-282` (`envFileContents` header, also used for `.dev.vars` at `:2365-2368`), `templates/full-stack.ts:252` (`ssr` doc "start:dev supplies"), `full-stack.ts:296-310` (TLS-proxy README section, every runtime)                                                                      | Each is emitted on Workers verbatim.                                                                                                                                                                                                                                                     |
| Workers README sections (V12-109)            | `project-files.ts:2036-2116`, `:2152-2157`; `templates/full-stack-app-files.ts:745-764`; `PLUGIN_ROUTES` `project-files.ts:1953-1964`                                                                                                                                                                                                      | Workers skips "Production"; only full-stack adds "Deploying to Cloudflare Workers"; probe purposes read "liveness probe"/"readiness probe"; `/metrics` "Prometheus metrics".                                                                                                             |
| Module sample comment (V12-105)              | `cli/src/schematics/module-files.ts:57-63`                                                                                                                                                                                                                                                                                                 | "lives in process memory … until the process restarts"; `moduleService` takes no runtime.                                                                                                                                                                                                |
| A Worker sees the client's URL               | Cloudflare Workers runtime: `request.url` is the URL the client requested at the edge (TLS terminated by Cloudflare before the Worker)                                                                                                                                                                                                     | The "Behind a TLS proxy" section (actions answering 400 behind TLS termination) does not describe a Worker.                                                                                                                                                                              |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                    | Resolution (picked side)               | Doc deliverable (same PR)                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| C1  | ROADMAP lists V12-108 under M140a and the review lists it as an open Workers row; the source already ignores `.dev.vars.*` (`project-files.ts:2131`).                                       | Fixed by M140a; not in this milestone. | None — ROADMAP already places it in M140a.                                                                                 |
| C2  | Source comments (`runtime-detector.ts:100-104`, `add.ts:1970-1973`, `project-files.ts:1255-1257`, `commands/client.ts:116-117`) say a Workers project carries `deno.json`; §3.3 removes it. | §3.3 (no `deno.json` on Workers).      | The four comments are corrected in the same change; `docs/` and website pages that show a Workers `deno.json` are M140e's. |

## 3. Design decisions

Survey for the two designed behaviours (§3.1–3.2 and §3.6), done before deciding:

- **Workers `queue` / `scheduled` exports.** Hono's Workers guide has the developer write
  `export default { fetch: app.fetch, async scheduled(...) {...} }` in a module they own; the React
  Router Cloudflare template's `workers/app.ts` is likewise a developer-owned `ExportedHandler`;
  SvelteKit's adapter has no `queue`/`scheduled` support (a custom worker wraps it); Nitro generates
  `scheduled` only from its own `scheduledTasks` config. The established shape is a user-owned entry
  where the developer adds the export beside `fetch` — this CLI already writes `src/index.ts` as a
  create-only (unmanaged) file. What none of them has is our cache of booted apps, so the gap is
  access to it, not generation.
- **Empty environment values.** POSIX shell and Docker Compose `${VAR:-default}` treat an empty
  value as unset; Express's generator reads `process.env.PORT || '3000'`; NestJS's docs use
  `process.env.PORT ?? 3000`, which is V12-80. For the values this CLI reads (a port, a connection
  URL, a host) an empty string is never valid, so empty-means-unset is the established behaviour.

### 3.1 V12-102: `setu add queue` is refused on Workers

- **Decision:** add `queue-plugin` to `RUNTIME_RESTRICTIONS` with
  `runtimes: ['deno', 'node', 'bun']` and this reason (the consumer prefixes "Cannot add <spec> to a
  cloudflare-workers project: "):

  > its default queue lives in one isolate's memory, so a job added in one request is lost to the
  > others; on Workers, register CloudflarePlugin({ queue: { binding } }) with a queue export in
  > src/index.ts (setu add cloudflare)

  The existing consumers do the rest: `add` refuses before any write, and the agent brief stops
  listing `queue` as addable on Workers. Same mechanism as X9-2's `scheduler-plugin` refusal.

- **Why:** the one existing refusal seam; a warning would still install a queue that loses work.
- **Test home:** `test/unit/commands/add.test.ts` (Workers project: exit `EXIT_USAGE`, the message,
  no manifest written; a Node project still adds it); a new case in
  `test/unit/agents/render-brief.test.ts`: a Workers project's brief does not offer
  `setu add queue`.

### 3.2 V12-103: one shared app accessor, and `wrangler.toml` comments that match the entry

- **Decision:**
  1. The entry gains a module-level function, written once in `cacheBlock`:
     `async function withApplication<T>(env: Record<string, unknown>, use: (app: IKernelApplication) => Promise<T>): Promise<T>`
     — `acquire(env)`, `await booted.app`, `await use(app)`, `release` in `finally`. Every generated
     export calls it instead of inlining `acquire`/`release`, `fetch` included: `fetch` catches a
     request-time failure INSIDE its callback (logs `setu: request failed`, answers 500), so a
     rejection that escapes `withApplication` can only be the boot failure (logs
     `setu: application failed to start`, answers 503) — the same two cases, logs and bodies as
     today. Routing `fetch` through it also keeps the function used on a host with no other export:
     an unused module-level function fails the generated project's own
     `@typescript-eslint/no-unused-vars` (`npm-tooling.ts:83`) and `deno lint`, and `rest`'s Workers
     swap declares no export. Non-`fetch` exports become
     `await withApplication(env, async (app) => { <routes> })`. Its JSDoc says it is the way to add
     a `queue` or `scheduled` export by hand.
  2. `wrangler.toml` comments are derived from the host:
     - Queue consumer: when `host.workerExports` has a `queue` export, keep "drives the `queue`
       export in src/index.ts". Otherwise: "Cloudflare delivers batches to a `queue` export, which
       src/index.ts does not have yet. Add one beside `fetch`:" followed by a typed, copyable sample
       — `async queue(batch: IQueueMessageBatch, env: Record<string, unknown>): Promise<void>` whose
       body is `await withApplication(env, (app) => createQueueHandler(app)(batch));` — naming
       `@setu-ts/cloudflare-plugin` as the source of `IQueueMessageBatch` and `createQueueHandler`.
     - Cron Triggers: "Cloudflare runs a `scheduled` export, which src/index.ts does not have. Add
       one beside `fetch`: inside `withApplication(env, async (app) => …)`, build a `WorkersCron`,
       register its handlers with `cron.on()` (they can reach `app`), and await
       `createScheduledHandler(cron)(controller)`; the parameter is an `IScheduledController`. The
       cloudflare-plugin README, 'Queues, Cron Triggers, and the edge cache', shows the registry."
       No template declares a `scheduled` export, so this text is unconditional; the SchedulerPlugin
       sentence stays.
  3. `setu add cloudflare` prints, after its existing `_waitUntil` note, one line: "To consume a
     queue or a Cron Trigger, add a `queue` or `scheduled` export to src/index.ts through
     withApplication — wrangler.toml shows both."
- **Why:** truthful comments plus the one missing piece (cache access), in the shape every surveyed
  Workers framework uses. Generating exports from `add cloudflare` would need the queue names and
  cron expressions the developer has not chosen yet.
- **Test home:** `test/unit/templates/project-files.test.ts` (rest Workers: comment names
  `withApplication` and does not claim an existing `queue` export; microservice Workers: claims it;
  both: scheduled text); `test/unit/workers-entry-boot.test.ts` (the generated microservice `queue`
  export still dispatches and releases through `withApplication`, a failed boot still rejects the
  batch; `fetch` still answers 503 on a failed boot and 500 on a request failure, each with its own
  log line, and releases in both); `test/unit/commands/add.test.ts` (the `add cloudflare` line);
  type-check and lint of every Workers entry, the export-less `rest` one included, in
  `scaffold-runs-e2e` / `workers-bundle-e2e`.

### 3.3 V12-104: a Workers project has no `deno.json`

- **Decision:** `projectFiles` emits `deno.json` for `runtime === 'deno'` only. `denoTasks` loses
  its Workers branch (`start` is always `deno run …`, `entry` always `main.ts`). The four source
  comments in C2 are corrected. Nothing else reads a Workers `deno.json`: runtime detection decides
  on the Wrangler config first, plugin gating falls back to `package.json`, and `setu add` writes
  only manifests that exist.
- **Why:** X9-7's other option. A Workers project is an npm/Prettier/ESLint/wrangler project; its
  `deno.json` held a `start` that cannot load `cloudflare:workers`, a second `fmt` block and unused
  `@std/*` imports.
- **Test home:** `test/unit/templates/project-files.test.ts` (Workers file set has no `deno.json`;
  replaces the X9-7 `deno serve` test); `test/unit/plugin-detector.test.ts` (a Workers scaffold with
  no `deno.json` reports its installed plugins from `package.json`);
  `test/unit/commands/add.test.ts` (add on a Workers scaffold writes `package.json` only).

### 3.4 V12-106: the Durable Object example names the backplane's own binding

- **Decision:** the commented DO stanza in `wrangler.toml` becomes `name = "REALTIME"`,
  `class_name = "RealtimeBackplaneObject"`, with the plugin option it pairs with in the comment line
  (`CloudflarePlugin({ durableObject: { binding: 'REALTIME', topic: '…' } })`), matching
  cloudflare-plugin's README.
- **Why:** `REPLY_INBOX` is the `messaging.rpc` binding (and the live binding the microservice swap
  appends below), so a microservice project carried two different meanings for one name.
- **Test home:** `test/unit/templates/project-files.test.ts`.

### 3.5 V12-107: Workers files use Workers wording

- **Decision:**
  - `setu.config.ts` (both factory JSDoc sites, `project-files.ts:390` and `:536`): "`src/index.ts`
    owns that" on Workers, "`main.ts` owns that" elsewhere — one helper `entryModule(runtime)` both
    read.
  - `envFileContents` takes the file it renders: for `.dev.vars` the header reads "`wrangler dev`
    reads this file into the Worker's `env`. A deployed Worker reads secrets set with
    `wrangler secret put` instead."; `.env` keeps today's text.
  - `full-stack.ts` `ssr` parameter doc becomes runtime-neutral: "Supplied by the entry: the
    compiled server build in production, the Vite runtime in local development."
  - The full-stack README's "Behind a TLS proxy" section is omitted on Workers (§1: a Worker sees
    the client's URL).
- **Why:** each sentence is false on Workers; one neutral or runtime-picked sentence per site.
- **Test home:** `test/unit/templates/project-files.test.ts` (config JSDoc per runtime, `.dev.vars`
  header), `test/unit/full-stack-template.test.ts` (no TLS section on Workers; present on Node;
  `ssr` doc text).

### 3.6 V12-109 and V12-105 (framework half): a Workers deploy section, and what `/live`, `/ready` and `/metrics` mean there

- **Decision:**
  - One renderer, `workersDeploySection(host)` in `project-files.ts`, appended to every Workers
    README (plain, rest, microservice, class-based, full-stack): `## Deploy`, then `npm run deploy`
    (`wrangler deploy`); `npx wrangler queues create <name>` for each queue name the host's
    `workerExports` routes consume (microservice: `messages`, `jobs`); one
    `npx wrangler secret put <NAME>` per generated-secret env variable (full-stack:
    `SESSION_SECRET`), with "`.dev.vars` is local only"; and "uncomment the `wrangler.toml` bindings
    CloudflarePlugin names". `FULL_STACK_README_SECTION`'s Workers block keeps only what is
    full-stack-specific (the build of client and server, and the `build/client` static-asset
    paragraph), so the secret instruction has one home.
  - On Workers, "What it serves" ends with one paragraph, emitted when the host serves the routes it
    names: "Cloudflare does not probe a Worker: `/live` and `/ready` answer an external uptime
    monitor. Each isolate keeps its own metrics, so `/metrics` reports only the isolate that answers
    the scrape."
  - The module sample comment (`module-files.ts`) becomes runtime-neutral: "This `Map` lives in the
    memory of one process (on Cloudflare Workers, one isolate: other isolates do not see it), with
    no size limit, and the generated routes that write to it are public …" — replacing "until the
    process restarts".
- **Why:** the deploy path and the platform facts belong in the README a developer reads; one
  renderer keeps the five READMEs from drifting.
- **Test home:** `test/unit/templates/project-files.test.ts` (each Workers host: `## Deploy`; the
  microservice queue lines; full-stack's `SESSION_SECRET` line appears once; the paragraph present
  with health/metrics and absent on the plain project);
  `test/unit/templates/full-stack-app-files.test.ts` (the reduced Workers block);
  `test/unit/schematics/module.test.ts` (comment text).

### 3.7 V12-118: the Deno README names only tasks the project has

- **Decision:** the Deno "Production" block prints `deno task build` only when `manifest?.npmBuild`
  is set, exactly as the Bun branch does.
- **Why:** `rest`, `class-based`, `microservice` and the plain project have no `build` task.
- **Test home:** `test/unit/templates/project-files.test.ts` — every Deno host's README Production
  commands are each a key of that host's `deno.json` `tasks` (a table over the hosts, so the claim
  is data the test iterates).

### 3.8 V12-80, V12-124: an empty value means unset

- **Decision:**
  - New internal module `cli/src/templates/env-fallback.ts` exporting
    `runtimeEnvRead(variable: string, fallback: string): string` →
    `runtime.env.${variable} || ${stringLiteral(fallback)}`. `serveEntry` (`PORT`), the full-stack
    dev entry (`PORT`, `VITE_PORT`) and the devtool dev entry (`PORT`) render through it
    (`Number(${runtimeEnvRead('PORT', '3000')})`).
  - `denoEnvRead` / `nodeEnvRead` in `runtime-profile.ts` emit `||` instead of `??`; every broker,
    Redis and discovery-host read already goes through them.
  - Comments that quote the rendered form (`plugin-args.ts:82`, `transport.ts:246`,
    `node-redis.ts:54`) are updated to the logical-or form; `nodeRedisCall` re-indents by line and
    needs no code change. Kafka's `nestConnection` (`transport.ts`) is deleted: measured on
    `deno fmt`, a logical-or continuation inside an array stays at the element's column (ten, where
    `envRead` already puts it), while a nullish one was indented two more, the shift the helper
    existed to add. The `redis-develop-outputs.json` capture stays frozen; `node-redis-cli.test.ts`
    declares the operator change as a third deliberate difference.
  - `rewriteEntryPort` (`adopt.ts`) matches the new `||` form in both its regexes (the `??` form is
    an older scaffold's; no compatibility is kept, per the maintainer's rule that there are no
    existing users). The dev-entry recognizers (`devEntryVariants`, `fullStackDevEntryVariants`)
    render their variants through the same renderers, so they recognize the new form with no edit;
    an entry an earlier release wrote with `??` reads as hand-edited, which the same rule accepts.
- **Why:** survey above; one renderer per read kind, so no site keeps `??`.
- **Test home:** `test/unit/templates/env-fallback.test.ts` (new: rendered text; and evaluating the
  rendered expression with `runtime.env.PORT = ''` gives `'3000'`),
  `test/unit/workspace/runtime-profile.test.ts` (both profiles emit `||`),
  `test/unit/adopt-entry-rewrite.test.ts` (rewrites a freshly generated `main.ts`),
  `test/unit/dev-entry.test.ts`, `test/unit/templates/project-files.test.ts`, the fixtures
  `template-baseline.json` / `redis-develop-outputs.json` regenerated; `project-files.test.ts`
  evaluates the generated `main.ts` port expression with `PORT` set to `''` and gets 3000 (no e2e on
  a fixed port: it would collide with a parallel suite).

### 3.9 CHANGELOG

- **Decision:** one `### Fixed` entry under `[Unreleased]` for M140b naming each row's user-visible
  change, including that Workers projects no longer get a `deno.json` and `setu add queue` is
  refused on Workers.
- **Why:** each code letter ships its own CHANGELOG entry (ROADMAP M140).
- **Test home:** `pnpm run check:docs` / changelog checks in `test:tooling`.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. No `src/index.ts` export changes in any package.
`setu add queue` on Workers now refuses (a CLI behaviour change, in the CHANGELOG).

| Exported symbol                                  | Kind               | Consumer / real code path that READS it                                                                                          |
| ------------------------------------------------ | ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `runtimeEnvRead` (internal, `env-fallback.ts`)   | function           | `serveEntry` (`project-files.ts`), full-stack dev entry (`full-stack-build-files.ts`), `renderDevEntry` (`devtool/dev-entry.ts`) |
| `workersDeploySection` (module-private)          | function           | `projectFiles` Workers README                                                                                                    |
| `entryModule` (module-private)                   | function           | `configModule` JSDoc sites                                                                                                       |
| `withApplication` (generated, in `src/index.ts`) | generated function | the generated `fetch` and every generated Workers export; a hand-written `queue`/`scheduled` export (`wrangler.toml` comments)   |

### 4.1 Options — every option names its consumer

| Option                                   | Consumer                                    | Behavior (per implementation)                              |
| ---------------------------------------- | ------------------------------------------- | ---------------------------------------------------------- |
| `envFileContents(…, file)` new parameter | `projectFiles` `.env` / `.dev.vars` writers | Picks the header sentence for `.env` or `.dev.vars` (§3.5) |

## 5. Implementation files

| File                                                                                    | Purpose                                                                                                                                      |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `cli/src/templates/project-files.ts`                                                    | §3.2 entry + `wrangler.toml`, §3.3 no Workers `deno.json`, §3.4, §3.5 config/`.dev.vars`, §3.6 deploy + served note, §3.7, §3.8 `serveEntry` |
| `cli/src/templates/env-fallback.ts` (new)                                               | §3.8 `runtimeEnvRead`                                                                                                                        |
| `cli/src/templates/full-stack.ts`                                                       | §3.5 `ssr` doc, TLS section off on Workers                                                                                                   |
| `cli/src/templates/full-stack-app-files.ts`                                             | §3.6 reduced Workers block                                                                                                                   |
| `cli/src/templates/full-stack-build-files.ts`                                           | §3.8 dev entry ports                                                                                                                         |
| `cli/src/devtool/dev-entry.ts`                                                          | §3.8 port                                                                                                                                    |
| `cli/src/workspace/runtime-profile.ts`                                                  | §3.8 logical-or reads                                                                                                                        |
| `cli/src/workspace/adopt.ts`                                                            | §3.8 regex                                                                                                                                   |
| `cli/src/workspace/transport.ts`, `templates/plugin-args.ts`, `templates/node-redis.ts` | §3.8 comments only                                                                                                                           |
| `cli/src/commands/client.ts`                                                            | C2 comment                                                                                                                                   |
| `cli/src/schematics/module-files.ts`                                                    | §3.6 comment                                                                                                                                 |
| `cli/src/commands/add.ts`                                                               | §3.1 restriction, §3.2 `add cloudflare` line, C2 comment                                                                                     |
| `cli/src/utils/runtime-detector.ts`                                                     | C2 comment                                                                                                                                   |
| `cli/test/fixtures/template-baseline.json`, `redis-develop-outputs.json`                | regenerated with `capture-template-baseline.ts`                                                                                              |
| `CHANGELOG.md`                                                                          | §3.9                                                                                                                                         |

`packages/cli/src/index.ts` is unchanged, so `PUBLIC_API.md` is not edited.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                   | src covered                                                                   | Key assertions (and the signature each call type-checks against)                                                                                                   |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cli/test/unit/templates/project-files.test.ts`                                                             | `project-files.ts`                                                            | §3.2 comments per host, §3.3 no Workers `deno.json`, §3.4, §3.5, §3.6, §3.7 task table, §3.8 `main.ts` port line                                                   |
| `cli/test/unit/templates/env-fallback.test.ts` (new)                                                        | `env-fallback.ts`                                                             | `runtimeEnvRead('PORT','3000')` text; evaluated with `''` and unset gives `'3000'`; a quote in the fallback stays a literal                                        |
| `cli/test/unit/workers-entry-boot.test.ts`                                                                  | `project-files.ts` (`workersEntry`)                                           | `queue` export and `fetch` go through `withApplication`; release on success and on throw; failed boot rejects the batch / answers 503; request failure answers 500 |
| `cli/test/unit/full-stack-template.test.ts`                                                                 | `full-stack.ts`                                                               | TLS section absent on Workers, present on Node; `ssr` doc text                                                                                                     |
| `cli/test/unit/templates/full-stack-app-files.test.ts`                                                      | `full-stack-app-files.ts`                                                     | Workers block keeps the static-asset paragraph, no `wrangler secret put`                                                                                           |
| `cli/test/unit/dev-entry.test.ts`                                                                           | `dev-entry.ts`                                                                | the port line uses logical-or; `isDevEntry` accepts a freshly rendered entry                                                                                       |
| `cli/test/unit/workspace/runtime-profile.test.ts`                                                           | `runtime-profile.ts`                                                          | Deno and Node reads emit logical-or                                                                                                                                |
| `cli/test/unit/adopt-entry-rewrite.test.ts`                                                                 | `adopt.ts`                                                                    | rewrites a freshly generated `main.ts` (rendered by `projectFiles`, not a hand-copied string)                                                                      |
| `cli/test/unit/schematics/module.test.ts`                                                                   | `module-files.ts`                                                             | comment names one isolate and no process restart                                                                                                                   |
| `cli/test/unit/commands/add.test.ts`                                                                        | `add.ts`                                                                      | §3.1 refusal on Workers, allowed on Node; §3.2 `add cloudflare` line; Workers add writes `package.json` only                                                       |
| `cli/test/unit/agents/render-brief.test.ts`                                                                 | `commands/add.ts` (`RUNTIME_RESTRICTIONS`, read by `agents/not-installed.ts`) | a Workers project's brief does not offer `setu add queue`; a Node project's still does                                                                             |
| `cli/test/unit/start-scripts.test.ts`, `adopt-command.test.ts` (existing tests of the full-stack dev entry) | `full-stack-build-files.ts`                                                   | `PORT`/`VITE_PORT` lines use logical-or; `fullStackDevEntryVariants` still matches a fresh `dev.ts`                                                                |
| `cli/test/e2e/scaffold-runs-e2e.test.ts`                                                                    | generated output                                                              | Workers hosts format/lint clean without `deno.json`; every changed template boots                                                                                  |
| `cli/test/e2e/workers-bundle-e2e.test.ts`, `workers-install-e2e.test.ts`                                    | generated Workers output                                                      | Workers rest, microservice and full-stack still bundle/boot on workerd                                                                                             |
| `cli/test/e2e/node-scaffold-e2e.test.ts`                                                                    | generated output                                                              | Node/Bun hosts unchanged in behaviour (port fallback)                                                                                                              |

`utils/runtime-detector.ts` changes only a comment; its existing test keeps its coverage.

## 7. Verification gates

```bash
git branch --show-current   # feat/m140b-runtime-output
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test:coverage cli          # edit loop; read the ANSI-stripped per-file table
pnpm run ci:local --shard cli   # final commit; plus `packages`/`static` shards if the diff reaches them
pnpm run release:publish --dry-run
pnpm run release:verify 0.12.0
```

The scaffold e2e boots every template this milestone changes (CLAUDE.md generated-output rule): the
Workers rest, microservice and full-stack hosts on workerd, and the Deno hosts. Before any suite
run, check `pgrep -af "vitest|local-ci.ts"` and `docker ps` for the parallel M140c session's suite.

## 8. Risks & mitigations

- **M140c edits `project-files.ts` and regenerates the same fixtures in parallel** → edits stay in
  the Workers/Deno/README/`main.ts` code; whichever branch merges second merges `origin/develop`,
  resolves and regenerates the fixtures with `capture-template-baseline.ts`.
- **Removing Workers `deno.json` breaks a test or reader that assumed it** → §1 lists every reader;
  the full `--shard cli` run and the Workers e2e catch the rest.
- **`deno lint` in `scaffold-runs-e2e` behaves differently without a config on Workers** → it then
  uses Deno's defaults over the project's sources only (no generated output exists in a fresh
  scaffold); if it lints `node_modules` or an emitted file, the lane switches to the project's own
  ESLint, which is what a Workers project runs.
- **The wrangler comment code samples drift from cloudflare-plugin's API** → each sample names only
  `createQueueHandler`, `createScheduledHandler`, `WorkersCron` and `withApplication`, all checked
  in §1; the Workers bundle e2e type-checks the entry that defines `withApplication`.

## 8a. Design security review

Completed 2026-11-14, before implementation. **No committed-tree audit is required.** No change
crosses a trust boundary: nothing parses network input, handles a credential, decides authorization
or tenancy, or sends data out of the process. Checked flows: F1 an empty connection value
(`REDIS_URL=`, a broker URL, a discovery host) used to reach the client as `''` — ioredis then falls
back to its own local default and other clients refuse it — and now becomes the generated local
default; every such default is a loopback address (standalone) or a Compose service name (`redis`,
`rabbitmq`, `nats` in a workspace member, `transport.ts:302-375`), none with credentials, so the
only new destination is the one the project already names for that service; F2 the Workers entry's
`fetch` and generated exports move into `withApplication` with the same acquire/release, the same
boot-failure rejection, and `fetch`'s same 503/500 split, generic bodies and log lines (the stack
still never reaches the client, M70l X9-8); F3 the `.dev.vars` header now tells the developer to
deploy secrets with `wrangler secret put`, which narrows where a secret is written. The code review
checks each.

## 9. Out of scope

- `setu add messaging` on Workers registering a per-isolate in-memory broker (same shape as V12-102,
  not a reviewed row) and the full-stack starter composing a memory queue on Workers — follow-ups
  for a later letter or the next smoke run.
- Every `docs/`, website and package-README change these fixes imply — M140e.
- `Number(...)` of a non-numeric `PORT` (`NaN`) — not a reviewed row.
