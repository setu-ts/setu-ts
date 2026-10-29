# Upgrading Setu-TS

The CHANGELOG answers "what changed in the framework"; this guide answers "what must I change in
**my** project". A release that demands reader action adds an entry here, version by version — that
is a release step ([releasing.md](./releasing.md)), not a memory exercise.

Each heading names the release that **shipped** the change, so an upgrade spanning several releases
is the union of every section between the version you are on and the one you are moving to.

`## Unreleased` holds entries written as their milestone landed, which is where the knowledge is;
cutting a release renames that heading to the version and is a rename, not a recall.

## Unreleased

### node-redis as a supported Redis client (M117, 0.11.0)

Nothing changes for an application on ioredis: every plugin still loads ioredis lazily when no
client is injected, and scaffolds still default to it. To move a plugin to node-redis, install
`redis` (v5 or v6) and pass `fromNodeRedis(createClient({ url }))` as its `client` — one client per
plugin, two for the realtime backplane. A plugin's own `commandTimeoutMs` does not apply to an
injected client; set the adapter's (`fromNodeRedis(client, { commandTimeoutMs })`, default 15 s),
and keep it above the Redis Streams broker's `blockSizeMs`. The idempotency store never closes an
injected client, so close it at shutdown. For traces, add `instrumentations.redis` and install
`@opentelemetry/instrumentation-redis` `^0.69.0`.

A custom client implementing `IRedisLockClient` keeps compiling: `eval` now returns
`Promise<unknown>`. A custom `IRedisBackplaneClient` that exposes `connect()` and reports `status`
`'wait'` is now connected when the backplane starts.

### Session and account lifecycle (M124, 0.11.0, `@setu-ts/auth-plugin`)

Nothing breaks. Three things change what an existing application can rely on:

- **`signIn: { providers: [] }` no longer throws** when neither `mfa` nor `passkeys` is set. An
  application that worked around the refusal with `AuthPlugin({ session: { toPrincipal } })` and its
  own session key can move to `IAuthSessionService.signIn` to get `refreshPrincipal`, `amr` and
  session-id rotation at sign-in.
- **Adding `signIn.sessionStamp` to a running application ends every session whose user already has
  a stamp**: those sessions were recorded without one, and a recorded "no stamp" matches only a user
  whose stamp is still `null`. Deploy it when a one-time sign-out is acceptable, or return `null`
  until every session has been renewed.
- **`requireAuth()` without options is unchanged.** With `signInPage`, an anonymous `fetch()` still
  gets `401`; only a page navigation is redirected. A route guarded by a role or permission guard
  alone keeps answering `401`; put `requireAuth({ signInPage })` first to redirect it.

### `setu add messaging` and full-stack brokers (M121, 0.11.0, `@setu-ts/cli`)

Full-stack projects now accept `new --broker` / `--queue`, and full-stack workspace members receive
the workspace transport through their starter options. Existing standalone projects can run
`setu add messaging --broker redis` or `setu add queue --queue redis`; members use the workspace
transport automatically. Install again after adding so the selected client is available. Existing
calls and option values are preserved; review the exact property printed when manual configuration
is needed. Standalone `add` creates missing broker Compose files and prints the connection variable
and default, while leaving dotenv files unchanged; an existing `docker/compose.yaml` is never
rewritten, and a selected service it lacks is printed for you to add. Generated full-stack options
use `config.get`, so both dotenv values and deployment environment variables apply, with environment
taking precedence.

`setu add react-router` now refuses an app without a full-stack factory or an existing
ReactRouterPlugin. Create a full-stack project with `setu new <name> --template full-stack`, or a
workspace member with `setu generate app <name> --template full-stack`. Adding the dependency alone
does not create the frontend files, routes or build scripts. Workers continues to refuse broker and
queue flags.

### `setu add view` and the styled app shell (M123, 0.11.0, `@setu-ts/cli`)

Fresh full-stack scaffolds include Tailwind 4 through Vite, neutral shadcn tokens, Button/Card,
`components.json`, a fixed app shell and a light/dark/system theme toggle. Existing apps are not
rewritten. When copying files from a fresh scaffold, replace `classNames` from `app/lib/utils.ts`
with `cn` from shadcn's `cn` package (the copied components import it too) and add `cn`,
`class-variance-authority` and `radix-ui` to runtime dependencies. Add `tailwindcss` and
`@tailwindcss/vite` at `^4.3.3` to development dependencies and put `tailwindcss()` before
`reactRouter()` in Vite's plugins. Copy the stylesheet and theme files together with the layouts;
the shell resets its content scroll position on pathname changes.

Rerun `setu add view` to fill missing view setup in an existing project; a project whose
`setu.config.ts` already registers `ViewPlugin()` also gets the example `/ui` route. It preserves
existing files, pins, compiler choices and CSS tasks and prints what needs manual work; review every
note. A `build` or `start:dev` script the command creates or prefixes runs CSS once first; one that
already called `css` is left as it was, so check its order. Run the separate CSS watcher while
editing. Workers receives only the dependency/JSX/example-view pieces; use Wrangler static assets
for CSS. See [styling server-rendered views](./mvc.md#styling-server-rendered-views). If adding a
CSP, allow the static inline theme scripts by hash or nonce.

### `setu build`, production images and Bun library resolution (M120, 0.11.0, `@setu-ts/cli`)

Update existing Node scripts explicitly; the CLI does not rewrite scripts:

```json
{
  "build": "tsc --noEmit && setu build",
  "start": "node --enable-source-maps dist/main.js",
  "start:dev": "tsx watch main.ts",
  "start:debug": "node --inspect --import tsx main.ts"
}
```

Keep TypeScript, tsx and the matching CLI version as development dependencies. Full-stack Node
prefixes build and check with `react-router build && `; development/debug use dev.ts instead of
main.ts (development is `tsx dev.ts`, without watch). Prefix full-stack tests with
`react-router build && `, replacing `npm run build && `, so tests do not depend on wiring checks. In
full-stack socket main.ts import `* as serverBuild` from `./build/server/index.js` and call
`createApp(undefined, undefined, { serverBuild })`; in `setu.config.ts` that arm must also set
`assetsDir: './build/client/assets'` on Node, Bun and Deno (not Workers), or the page renders and
every `/assets/*.js` answers 404. Keep the config's path fallback for tests and set `allowJs: true`
in tsconfig.json so the static server-build import can be checked.

Bun keeps `start: bun run main.ts`; add `start:dev: bun --watch main.ts` and
`start:debug: bun --inspect main.ts`. Full-stack uses `bun run dev.ts` and `bun --inspect dev.ts`;
run its frontend build before starting, removing the build prefix from start. Deno keeps its
production start; add watch/inspect to its existing run command with the same grants. Full-stack
Deno instead uses `deno task install && deno run -A --watch dev.ts` and the inspect equivalent; its
check prefixes `deno task build && `.

Ignore dist/ in standalone Node projects. Workspace roots add `apps/*/build/` everywhere and
`apps/*/dist/` on Node/Bun. Use the generated Dockerfile from a fresh scaffold as the migration
template: Node builds in one stage, installs production dependencies in a separate stage and copies
dist/ and frontend build/. Bun installs with --production. Deno builds a declared frontend in a
Debian `frontend` stage, caches source, and switches a root `nodeModulesDir: "auto"` to `"manual"`
after installing (under `"auto"` a read-only container cannot start). Copy the generated
.dockerignore too: exclude node_modules, dist, build, coverage, git and dotenv files, keeping
.env.example. Workspace images use the root context and MEMBER build argument. See
[deployment](./deployment.md).

Generated install steps mount an optional build secret `npmrc` at `/root/.npmrc` (M120b), so
`docker build --secret id=npmrc,src=.npmrc …` or `NPMRC="$(cat .npmrc)" docker compose … up --build`
supplies a private registry token or npm settings without copying `.npmrc` into the image. An
existing project gets this by regenerating its Dockerfile and Compose file, or by adding
`--mount=type=secret,id=npmrc,target=/root/.npmrc` after `RUN` on each install line and a
`secrets: [npmrc]` build entry with a top-level `secrets: { npmrc: { environment: NPMRC } }`. The
mount needs BuildKit.

Bun workspace roots need bunfig.toml containing:

```toml
[install]
linker = "hoisted"
```

Rerun bun install. This exposes sibling libraries to members. Library generation creates a missing
file, preserves hoisted settings and refuses other or missing linker settings in existing TOML, with
the line to add. The CLI never rewrites user-owned TOML. The Bun image copies this file too.

For built Node migrations use `node dist/src/migrations/run.js`; in development use
`npx tsx src/migrations/run.ts`. Bun and Deno keep their source runners. Native `bun build` and
`deno compile` are available for custom packaging; generated services do not emit those steps.

### `setu check` in the generated check script (M118, 0.11.0, `@setu-ts/cli`)

New projects run `setu check` from their `check` script. Nothing rewrites an existing project's
scripts, so add it yourself. In a Node, Bun or Workers project, add the CLI as a development
dependency at your framework version and append ` && setu check` to the end of your existing `check`
script, keeping whatever runs before it:

```json
{
  "scripts": { "check": "tsc --noEmit && setu check" },
  "devDependencies": { "@setu-ts/cli": "^0.11.0" }
}
```

A Workers project with a build keeps its build first: its script becomes
`npm run build && tsc --noEmit && setu check`.

In a Deno project, add a `check` task (`main.dev.ts` belongs in the `deno check` list only when you
enabled the devtool):

```json
{
  "tasks": {
    "check": "deno check main.ts setu.config.ts && deno run -A npm:@setu-ts/cli@^0.11.0 check"
  }
}
```

Run `setu check` once before you add it. A project that copied or hand-wrote files into a seam
directory reports `setu.E003`; `setu sync` rewrites the barrels from their directories. A finding
you accept can be silenced in `.setu-ts/check.json` — see
[Silencing a finding](./cli.md#silencing-a-finding).

`setu devtool enable` replaces a scaffold's own `check` task with the devtool form, which adds
`main.dev.ts`. In a project that enabled the devtool before this release, re-running it refuses the
older `check` task by name; change the task to the form above, with `main.dev.ts` in the list.

A plugin command named `check` or `sync` is now shadowed by the built-in verb; rename it.

### Optional peers and `setu add` workspace root entries (M119f, 0.11.0, `@setu-ts/common`, `@setu-ts/cli`)

In a Node or Bun Setu workspace, re-run `setu add <plugin> --dir apps/<member>` for an installed
plugin whose optional peers are missing at the root, then run the printed install command from the
workspace root. The command now records its peers in both root and member `package.json`
`dependencies`, leaving a peer already in `dependencies`, `optionalDependencies` or a non-optional
`peerDependencies` as it is, adding an optional peer to `dependencies` at its own spec, moving one
declared only in `devDependencies` to `dependencies` with its pin unchanged, and recording a peer
the root `overrides` pins (a string value, or an object's `"."` entry) at the override's own spec,
since npm refuses a direct dependency whose spec differs from its override. A `$name` reference or a
conditional override (a version-selector key, or several rules for one package) is left to you with
a printed line. When a workspace member pins the peer at a different spec, the root entry is still
written at the CLI's range and a note names that member, since npm may install a second copy for it.
Both edited paths are printed. No framework pin is added at the root, and `setu add` still targets a
member.

For manually selected drivers, install peers where the framework package is installed, within the
version range it declares for them. Avoid conflicting member pins: they can produce nested copies
that a hoisted plugin cannot load. Existing pins are never corrected automatically. An absent root
`package.json` keeps the member-only behavior; JSONC or invalid JSON is refused by filename before
writing. Deno workspaces and standalone projects keep their existing behavior.

The startup error now names the loading package and the placement rule via the optional `requiredBy`
constructor option. Its `dependency` and `cause` are unchanged. See
[Optional peers in a workspace](./plugins.md#optional-peers-in-a-workspace).

### Portable data contract: tenant columns, cursors, unknown fields and refused values (M119e, 0.11.0, `@setu-ts/database-plugin`, `@setu-ts/common`, `@setu-ts/cloudflare-plugin`)

Restart pagination once on Memory, Prisma, Drizzle, MongoDB, DynamoDB, Cosmos DB, Bigtable and D1:
old cursors are refused with `InvalidCursorError` (400), because new fingerprints bind entity, key
columns and sort. Treat the cursor as a correctness token; continue enforcing tenant predicates.

On Drizzle, a default tenant column `tenant_id` resolves to the model property `tenantId` when
declared as `tenantId: text('tenant_id')`. Use model properties in payloads. The bridge caches the
resolved field per entity, stamps it last, strips it from updates, and uses it for ownership and
conditional writes. An absent or ambiguous column now throws `TenantColumnUnresolvedError` (500). An
explicit wrong Drizzle primary-key mapping now fails connect with `MissingKeyColumnError`; fix
`entities.<Entity>.primaryKey` or the table registration.

D1 unknown payload fields and invalid payload identifiers, and Prisma unknown payload fields now
answer 400 `UnknownPayloadFieldError`. PostgreSQL field type refusals through Drizzle, Prisma
validation and `P2007` known-request refusals, and D1 STRICT-table type refusals now answer 400
`InvalidFieldValueError`. SQL payload restriction is adapter-specific: Memory, MongoDB, DynamoDB,
Cosmos DB and Bigtable store unknown fields; restrict request fields in the route body schema.
Existing database-plugin imports of `UnknownPayloadFieldError` keep working; the class is now
defined in common.

Attach a node-postgres pool `'error'` listener in app setup (see the database-plugin README). The
framework installs a reporting listener only when the pool has none; the app owns closing it.

Prisma conditional-write validation now uses the same 400 split as ordinary writes, replacing its
previous 501. Prisma refusal causes contain a fresh error with only the original name and code in a
fixed message; query text and payload values are discarded.

### Upgrade `zod` and override `@azure/msal-node` for Azure secrets (0.11.0)

Upgrade Zod to `>=4.6.6 <5` and migrate any Zod 3 API usage. Zod 3 support has been removed;
validation is tested with Zod 4 only. OpenAPI schemas without `toJSONSchema` now produce `{}` and
the existing `not a recognized zod schema` diagnostic in `x-setu-unrepresentable`. Regenerate
OpenAPI documents and clients after upgrading.

If you use the Azure secrets provider (`@azure/identity`), add this pnpm override to your
`pnpm-workspace.yaml` until Azure ships an identity release that accepts patched MSAL Node:

```yaml
overrides:
  '@azure/msal-node': ^7.1.0
```

For npm, put `"overrides": { "@azure/msal-node": "^7.1.0" }` in the root `package.json`. Reinstall
dependencies and verify that the lockfile resolves MSAL Node 7.1.0 or newer. These steps address
[GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) and
[GHSA-xcx6-jx8p-x3h5](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5).

### NATS subscriptions without a queue are shared, and every publish is bounded (M119a, 0.11.0, `@setu-ts/messaging-plugin`)

Affects every application on the NATS arm that subscribes without a `queue`, and every application
on the Kafka, Pub/Sub, RabbitMQ, Redis Streams or NATS arm that publishes.

- **Queue-less NATS subscriptions no longer fan out.** Before this release a `subscribe()` with no
  `queue` gave every process its own durable consumer (`messaging-<uuid>`), so every replica
  received every message, and every start replayed the whole stream. The subscription now uses one
  durable JetStream consumer per topic — `<defaultQueue>.<topic>` (default prefix
  `messaging-consumers`) — shared by every replica: each message is delivered to ONE replica, and a
  restart resumes from the consumer's acknowledgement floor. A group created for the first time
  starts at messages published after it, so messages published before any replica of a new
  queue-less group subscribed are not delivered — the same rule as a new Kafka group. An explicit
  `queue` is unchanged. `respond()` with no queue follows the same path. If you relied on every
  replica receiving every message, pass a `queue` that is stable and unique per replica (for example
  the pod name). Do not build the queue from a random per-start value: it would leave a durable
  consumer behind on every start.
- **Catch `PublishTimeoutError`.** The Kafka, Pub/Sub, RabbitMQ, Redis Streams and NATS publish
  paths reject an expired publish with the exported `PublishTimeoutError` (readonly `topic: string`
  and `timeoutMs: number`). A timeout does not cancel the transport: the message may still be
  delivered, so retries need de-duplication. The Kafka, Pub/Sub and RabbitMQ message texts are
  unchanged from before.
- **Redis Streams publishes are bounded at 15 s by default.** Before this release a publish held
  indefinitely against a paused Redis. Set `publishTimeoutMs: 0` to keep the previous unbounded
  publish wait; consumer reads are unaffected.
- **The NATS publish bound moved from the client's fixed 5 s to `publishTimeoutMs` (default 15 s).**
  Code that relied on the 5-second refusal now sees 15 s by default; set `publishTimeoutMs` to the
  bound you need.
- **The NATS `request()` reply inbox is ephemeral.** It is deleted on shutdown and re-created if the
  server removes it, so it no longer leaves a durable consumer behind on every start.
- **Consumers earlier releases leaked are reaped.** On `connect()` the broker sets a 5-minute
  `inactive_threshold` on durable consumers named exactly `messaging-<uuid>` or
  `rr_2einbox_2e<uuid>` whose recorded `setu.queue` metadata is absent or matches, so the server
  removes them once nothing reads from them; a replica still running an older version keeps its
  consumer while it reads. A user queue literally named `messaging-<uuid>` is a reserved shape for
  this reason: such a consumer is reaped only after 5 min with no client attached.

### Health indicators gain a readiness membership, and a mail outage no longer drains every replica (M119b, 0.11.0, `@setu-ts/health-plugin`, `@setu-ts/mail-plugin`)

Affects every application that registers `HealthPlugin`, and — through the changed default and the
repaired probes — every application using `@setu-ts/mail-plugin`, `@setu-ts/queue-plugin`,
`@setu-ts/realtime-backplane-plugin`, `@setu-ts/database-plugin` (migration readiness) or the gRPC
health bridge.

- **A mail outage no longer fails `/ready`.** The `mail` indicator is registered outside readiness
  by default (V10-49). Its status mapping is unchanged: an unreachable mail backend still reads
  `down`, so `/health` reports the outage (503) and alerts still fire — but `/ready` ignores the
  indicator and stays 200, because an SMTP outage is shared by every replica and does not stop
  request serving. **To restore the previous behaviour, pass
  `HealthPlugin({ readiness: { include: ['mail'] } })`.**
- **Override readiness membership by name.**
  `HealthPlugin({ readiness: { include: [...], exclude: [...] } })` forces a named indicator into
  readiness (`include`) or out of it (`exclude`), overriding what the contributing plugin declared;
  a plugin can declare it itself with `ctx.health.register(name, fn, { readiness: false })`. An
  invalid list (a non-array, an empty or non-string name, the name `self`, or a name in both lists)
  throws `TypeError` at `HealthPlugin(...)`; names that match no registered indicator produce one
  count-only warning at startup. An indicator outside readiness still runs on `/health` — its `down`
  still 503s the endpoint and still alerts — but is absent from the `/ready` report.
- **A queue reachability check that does not answer is `up` with `reachable: 'unknown'`.** For every
  queue adapter, a check that does not answer within its 2 s bound now reports `up` with
  `reachable: 'unknown'` and no depth counts, instead of `down`: a queue backend that hangs keeps
  the replica in rotation where it used to be drained, and a stopped broker still reads `down` at
  once. The RabbitMQ adapter's check also opens and closes a throwaway channel, so a paused broker
  no longer reports `reachable: true` (V10-22).
- **A paused Redis no longer drains the replica through the backplane indicator (V10-20).** The
  `realtime-backplane` reachability check is cached for 5 s and bounded at 2 s; a check that does
  not answer within the bound reports `reachable: 'unknown'` and the status stays `up`.
- **gRPC health reads readiness.** `grpc.health.v1.Health/Check` for the whole server now maps the
  readiness report, so an indicator that is out of readiness (mail, by default) no longer turns the
  server `NOT_SERVING`.
- **A paused database reads `degraded` in one bound (V10-31).** With migration readiness opted in,
  the ledger is read only on a reachable connection; otherwise the indicator's result is returned
  unchanged with `data.migrations.state: 'unknown'` added — an adapter with no reachability check is
  still checked — and a paused database reads `degraded` within one ~2 s bound instead of `down`
  after ~4 s.

### Generated projects, CSRF and `setu add` defaults that broke a normal setup (M119c, 0.11.0, `@setu-ts/cli`, `@setu-ts/http-security-plugin`)

- **Full-stack behind a TLS proxy:** a project generated by `setu new --template full-stack` before
  0.11.0 answers 400 on every React Router action behind TLS termination. Add IP security yourself —
  `httpSecurity: { ipSecurity: { trustProxy: true, trustedProxies: ['<your proxy CIDRs>'] } }` — or
  read a `TRUSTED_PROXIES` value as new scaffolds do. List only your proxies — IPv6 proxies as
  single addresses, since an IPv6 CIDR matches nothing — and never `0.0.0.0/0`, which trusts every
  IPv4 client.
- **CSRF and `Origin: null`:** a same-origin form POST under the default `Referrer-Policy` now
  passes when the browser sends `Sec-Fetch-Site: same-origin`. If you set
  `referrerPolicy: 'same-origin'` only to work around the 403, you can keep or remove it. To keep
  refusing every `null` origin, set `csrf: { acceptNullOriginSameOrigin: false }`.
- **Swagger UI `{ baseUrl }`:** install `swagger-ui-dist` at exactly `5.33.3`
  (`npm install swagger-ui-dist@5.33.3 --save-exact`); a newer release fails the integrity hashes.
- **Telemetry peers:** install
  `@opentelemetry/api@~1.9.0 @opentelemetry/sdk-trace-base@^2.9.0 @opentelemetry/resources@^2.9.0 @opentelemetry/context-async-hooks@^2.0.0`;
  unpinned names fail with ERESOLVE today.
- **Generated tests:** add `--test-force-exit` to an existing Node project's `test` and `test:e2e`
  scripts to stop a failed start hanging CI.

### Workers tests, `setu agents` output and module 404 details (M119h, 0.11.0, `@setu-ts/cli`)

- **Workers projects can run tests.** A `cloudflare-workers` project scaffolded before 0.11.0 has no
  test scripts, and its `deno.json` `test` task permits an empty suite. Add the two scripts and the
  devDependencies new scaffolds ship:

  ```json
  "scripts": {
    "test": "tsx --test --test-force-exit '**/!(*.e2e).test.ts'",
    "test:e2e": "tsx --test --test-force-exit '**/*.e2e.test.ts'"
  },
  "devDependencies": {
    "tsx": "^4.20.0",
    "@types/node": "^24.0.0"
  }
  ```

  Prefix both commands with `npm run build && ` when the tests need the built Worker, and add
  `"node"` to `types` in `tsconfig.json`. Then add `test/support/server.ts`, which boots the Worker
  on workerd through wrangler's `createTestHarness` (the `wrangler` dependency the project already
  has supplies it), and write tests that call `startTestServer()` and
  `fetch(server.baseUrl + path)`:

  ```ts
  import { createTestHarness } from 'wrangler';

  export async function startTestServer(): Promise<{
    readonly baseUrl: string;
    readonly stop: () => Promise<void>;
  }> {
    // Located from this file: a relative path would resolve from the working directory.
    const harness = createTestHarness({
      workers: [{ configPath: new URL('../../wrangler.toml', import.meta.url) }],
    });
    const { url } = await harness.listen();
    return {
      baseUrl: url.origin,
      stop: async () => {
        await harness.close();
      },
    };
  }
  ```

- **`setu agents --dry-run` speaks in `would create` / `would update` / `unchanged`.** A script that
  matched the old `would write <path>` line must match the verb; an unchanged brief is reported and
  no longer rewritten by the real run. Add `--strict` to `setu agents --check` where CI should also
  fail on a missing agent card.
- **A pre-0.11.0 generated module still echoes the id in its 404.** New modules answer
  `<Pascal> not found.`; an existing module keeps its text until you edit the detail in its
  controller or routes. A test that asserted the old `<Pascal> <id> was not found.` must assert the
  fixed detail instead, and should not assert that the id is echoed.

### DI lifetimes are enforced, and every request has a scope (M125, 0.11.0, `@setu-ts/di-plugin`, `@setu-ts/common`, `@setu-ts/decorator-plugin`, breaking)

Affects applications that register `DiPlugin`, and any code implementing `IContainer` itself. An
application without `DiPlugin` is unaffected.

- **A boot failure naming a `captive` dependency** means a `singleton` reaches a `scoped` service,
  directly or through `transient`s. Before 0.11.0 the singleton kept the first scope's instance for
  the life of the application. Make the dependent `scoped` too, or resolve the scoped service per
  request: `container.forRequest(ctx).resolve(token)` in a handler, or `@Params(Service(token))` on
  a decorated one. A decorated **controller** is always a singleton (it is built once, at
  registration, whatever `defaultScope` says), so a controller constructor that takes a scoped
  service needs the handler-parameter form:

  ```typescript
  // Before: constructor(private readonly reports: ReportService) {} — now a boot failure
  @Get()
  @Params(Service<ReportService>('report-service'))
  today(reports: ReportService) {
    return reports.summary();
  }
  ```

- **A boot failure naming a `missing` dependency or a `cycle`** used to surface on the first request
  that resolved it; it now fails `app.start()`, listing every finding at once.
- **`ScopeRequiredError`** replaces the old behaviour of a `scoped` token resolved on the root
  container quietly acting as a singleton. It is also thrown for a `transient` with a `dispose`
  option resolved on the root, which the root would otherwise keep until the application closes.
  Resolve it through `forRequest(ctx)` or a scope from `createScope()`.
- **`ContainerClosedError`**: `DiPlugin` closes the container after the last bootstrap hook. Move a
  `register` that runs after `app.start()` into a plugin's `register()`, `onInit` or `onBootstrap`.
  A scope may still register tokens its parent does not have, but registering one the parent has now
  throws; register the replacement on the root, or use `overrideProvider` in tests.
- **Factories receive their dependencies.** `useFactory` is called with the resolved `inject`
  entries in order. A zero-argument factory that resolves from a captured container keeps working,
  but boot validation cannot see what it uses; prefer
  `{ useFactory: (db: Db) => new Repo(db), inject: [DB] }`.
- **Own `IContainer` implementations** add `forRequest(ctx)` and `dispose()`. Delegating to the
  wrapped container, as `OverridingContainer` in `@setu-ts/testing` does, is enough for a wrapper.
- **`ScopeManager` is gone** from `@setu-ts/di-plugin`; nothing replaces it as an export.
- **Unit tests of a request-scoped handler** need the kernel's request context, which implements
  `ctx.defer`: test them through `createTestApp` and `inject()`. A `createTestContext` context makes
  `forRequest` throw `RequestScopeUnavailableError`.
- **A `dispose` that takes longer than 5 s** no longer holds the response, the scope's other
  disposals or `app.stop()`: it is reported (at `warn` for a request, in the `AggregateError` from
  `dispose()`) and the rest still run. The bound is per disposal, so k disposals that never settle
  hold `app.stop()` for about k × 5 s — longer than the 10 s drain once k exceeds 2. A request
  scope's disposal failures are logged at `warn` as `Request scope disposal failed`, even when they
  settle after the kernel's own 5 s bound.
- **A provider registered on a scope lives as long as that scope.** A `singleton` lifetime there
  means once per scope; it is no longer created and kept on the root.
- **Shutdown and streamed responses.** A streamed response whose request used a scope stays
  in-flight until its body finishes, so `stop()` waits for it, up to the 10 s drain bound.

## 0.10.0

### Run a patched Node release (`engines.node ^22.23.4 || ^24.22.1 || >=26.12.1`, 0.10.0)

Every package now declares `"node": "^22.23.4 || ^24.22.1 || >=26.12.1"`: the first releases of each
supported line carrying the Node.js security fixes of 2026-10-21. npm only warns on an `engines`
mismatch unless `engine-strict` is set, so an older Node keeps installing; the range records the
floor, it does not enforce it. The fixes are in Node itself, so no Setu-TS code change closes them:

- **Upgrade Node** on developer machines, CI and servers.
- **Rebuild container images with `--pull`.** A cached `node:24-alpine` or `node:24-bookworm` layer
  stays on the release it was pulled at.
- **Rebuild every single executable (SEA)**, including one built from `docker/Dockerfile.compiled`.
  A SEA embeds the Node binary it was built with, so one built before the patch carries every one of
  these bugs until it is rebuilt with a patched Node. The advisory also names SEAs for
  CVE-2026-106074, under which `crypto.randomUUID()` and `crypto.randomInt()` can repeat values
  across processes — `runtime.uuid()` uses `crypto.randomUUID()` for connection, claim, audit and
  idempotency ids.
- **Treat outbound HTTPS as exposed until patched.** Node's `fetch` decompresses a
  `Content-Encoding: br` response itself, so a server that an attacker controls or can intercept
  reaches the Brotli decoder flaw (CVE-2026-111497, rated High, out-of-bounds write) through any
  outbound call: the SDK client, OIDC discovery and key-set fetches, Consul and Kubernetes
  discovery, Vault, and the SendGrid, Twilio, FCM and Slack providers.

### Declared `@ApiOperation` ids and descriptions (0.10.0)

`@ApiOperation({ operationId, description })` now reaches the document through optional
`RouteSchema.operationId` and `RouteSchema.description`; programmatic routes can declare both too.
Previously ignored ids are now used verbatim: `@ApiOperation({ operationId: 'listUsers' })` on
`GET /users` changes `get-users` to `listUsers`. Regenerate SDK clients and update their callers:
the method and every id-derived name can change — `<Op>Args`, `<Op>Error`, `is<Op>Error`,
`<Op>Error<status>Body`, `<Op>Body`, `<Op>Response<status>` and `<Op><Param>Param`. Hoisted
components follow the id too (`GetUsersBody` → `ListUsersBody`, only where a schema is hoisted), as
does `x-setu-unrepresentable[].at`; update references to those names.

Declared ids are reserved before derived ones. In a mixed document, an undeclared route's
`get-users` becomes `get-users-2` when another route declares `get-users`, even if the undeclared
route was registered first. Check those client names too. Documents without declared ids or
descriptions remain byte-identical.

Empty or whitespace-only ids and duplicate declared ids among included routes now fail `app.start()`
with `OperationIdError` from `@setu-ts/openapi-plugin`, carrying `reason: 'blank' | 'duplicate'` and
a message naming the id and affected `METHOD path` routes. Direct `OpenApiGenerator.generate()`
calls throw the same error. Remove an id to keep deriving it, or choose a unique nonblank id.
Excluded paths and owners neither claim nor collide. Startup scans routes without building the
document; routes registered after bootstrap are checked when the document is first built, so invalid
late declarations cause a request-time `500`.

Check SDK names as well: declared `getUsers` beside undeclared `GET /users` (derived `get-users`) is
valid OpenAPI, but `generateOpenApiClient` refuses it with `Duplicate operation name` because both
sanitize to `getUsers`. Choose ids with distinct sanitized TypeScript names.

### Environment secrets fall back to config (V9-77, 0.10.0, `@setu-ts/secrets-plugin`)

When CONFIG is registered, the default `EnvProvider` now resolves string secrets present only in
ConfigPlugin's snapshot, including `.env` values. Environment strings still win and are returned
unchanged. This also affects `SessionPlugin`'s `SESSION_SECRET` and full-stack starter apps, which
always compose `SecretsPlugin`. A consequence to check: `SessionPlugin` used to refuse to start when
no `SESSION_SECRET` existed outside a dotenv file; a dotenv file present at runtime now satisfies
that check. If a deployment relied on the refusal, keep dotenv files out of production or set
`configFallback: false`. To preserve environment-only reads, use:

```typescript
SecretsPlugin({ options: { configFallback: false } });
```

`configFallback` defaults to `true`. A non-boolean value throws at plugin construction naming
`options.configFallback`; other providers ignore the option. With no CONFIG capability, the env
provider silently reads only the environment.

A validation schema must declare the secret key or pass unknown keys through; stripped keys stay
missing. Config-sourced secrets follow `${NAME}` expansion: for literal references in secrets
containing `$`, use `ConfigPlugin({ expandVariables: false })` or set the secret in the real
environment. Only string config values qualify. On Workers, config normally contains the same string
bindings as `runtime.env` and adds no keys; an injected `ConfigPlugin({ instance })` or another
`IConfig` provider can supply additional keys. `envFilePath` requires filesystem support.

### Declare JSON media types on validated bodies (M114, 0.10.0, `@setu-ts/validation-plugin`)

Send `Content-Type: application/json` on JSON requests to `validateBody` or `@ValidateBody` routes
using the first-party validation service. It also accepts any `application/*+json` type, ignoring
case and parameters. An unsupported type, including `text/plain` or an absent header, now answers
`415 Unsupported Media Type` before reading the body. In particular, `fetch` with a string body and
no headers sends `text/plain` and is refused instead of validated; an empty body-validated request
without the header answers 415 instead of 400. A form type on a JSON-only route now answers 415
instead of 400; `{ forms: true }` still opts that validator into form bodies. Routes reading
`ctx.request.json()` directly are unchanged. Replacement `IValidationService` implementations own
their media-type handling. Cookie-authenticated routes still need `csrfMiddleware` or
`csrfFormMiddleware`.

### Refresh generated output for M114 (0.10.0, `@setu-ts/cli`, `@setu-ts/validation-plugin`)

**Existing generated modules need no layout changes.** Their `src/controllers/<name>.routes.ts`
files are still wired by the controllers barrel, and only newly generated modules use the new
layout. A project scaffolded before this milestone does not call `registerModules`;
`setu generate module` prints the import line and the `registerModules(app.router, app.services);`
call to add.

- **To adopt the new module layout for a pre-M114 functional module:** move
  `src/controllers/<name>.routes.ts` into `src/modules/<name>/`, change its service import to
  `./<name>.service.ts`, widen its registrar to
  `register<Pascal>Routes(router: IRouterApi, services?: IServiceRegistry)` (importing the type from
  `@setu-ts/common`; the regenerated index passes both), replace `src/modules/<name>/index.ts` with
  the registrar the CLI now generates — it imports `register<Pascal>Routes` from
  `./<name>.routes.ts` and exports
  `register<Pascal>Module(router: IRouterApi, services?: IServiceRegistry)`, which calls
  `register<Pascal>Routes(router, services)` — in the same change. The module scan admits a
  functional module only when its `index.ts` exports `register<Pascal>Module`, and the moved routes
  file no longer reaches the controllers barrel, so until the index is replaced the routes are not
  registered and every `--module <name>` command refuses the module. Then run any
  `setu generate … --module <name>` command (or add the two lines the command prints) so the
  activation barrel is regenerated. The module's `index.ts` no longer re-exports the service —
  import it from `./<name>.service.ts` directly.
- **To stop casting validated values:** switch the
  `ctx.state.get(validatedStateKey('body')) as z.infer<typeof Schema>` read to the validator itself
  — declare `const body = validateBody(Schema);`, list it in the route's `middleware`, and read
  `body.value(ctx)` in the handler. `value(ctx)` throws a `TypeError` naming the target when that
  validator did not run on the request or a later validator for the same target overwrote it. The
  state-key read still works and is unchanged if you keep it.
- **Generated tests and tasks:** new scaffolds split `test` (every `*.test.ts` except
  `*.e2e.test.ts`) and `test:e2e` (only `*.e2e.test.ts`, over real HTTP through the CLI-owned
  `test/support/server.ts`); `setu new` emits `test/e2e/app.e2e.test.ts` on socket targets, and
  `setu g module` adds a per-module `<name>.e2e.test.ts` beside the module. `<name>.test.ts`
  replaces `<name>.service.test.ts` (it drives the module in-process through
  `createTestApp({ app: await createApp() })`), and a module on Cloudflare Workers no longer emits a
  test.
- **Validation:** send the JSON media-type header described above. To accept form posts, pass
  `{ forms: true }` to `validateBody` or `@ValidateBody` and add `csrfFormMiddleware`; that route
  then validates `application/x-www-form-urlencoded` and `multipart/form-data` bodies with the same
  schema — numbers and booleans arrive as strings (use `z.coerce`), a file part is the framework's
  `FormFile` (not a web `File`), a repeated field becomes an array in wire order, and a name ending
  `[]` is always an array. An over-limit body on a validated route answers `413` instead of `400`
  when `RuntimePlugin({ maxBodyBytes })` is set. `zod` is declared by every template that installs
  `validation-plugin` and added by `setu add validation` on every runtime; `setu g module` and
  `setu g schema` print the runtime's install command in a project that lacks it.

### Refresh generated output for M113h (0.10.0, `@setu-ts/cli`, `@setu-ts/runtime`, `@setu-ts/kernel`)

New scaffolds emit the corrected output; an existing project keeps working, and these steps are what
adopts the fixes.

- **NATS.** New scaffolds set `streamSubjects: ['app.>', 'rr.req.app.>', 'rr.inbox.>']`, so every
  topic published through NATS must start with `app.`. An existing project keeps its own stream and
  subjects. If it uses `RealtimeBackplanePlugin` on the `'messaging'` transport, set
  `topic: 'app.realtime'`; its default `setu-ts.realtime` is outside the emitted set. Only one
  stream per account may own `rr.inbox.>`, so remove the scaffold's `MESSAGING` stream before
  adopting the set on an account that already has one.
- **Ignore rules.** Add `**/.env`, `**/.env.*` and `!**/.env.example` to `.dockerignore`, and
  `.env`, `.env.*`, `!.env.example` to the workspace root `.gitignore`. A custom `--env-file name`
  is not covered by the generic rules.
- **`ws` on Node.** Re-run `setu add websocket`; it writes the `ws` peer into `package.json` even
  when the plugin is already installed. A missing `ws` now also reports the failed handshake once
  instead of refusing silently.
- **Workers full-stack `check`.** A Workers full-stack project's `check` script now runs the build
  first, because its entry imports the compiled server build. An existing project can change its
  `check` script to `npm run build && tsc --noEmit`.
- **Adopted workspaces.** `setu adopt` records `healthProbes`/`metricsEndpoint` from the project's
  dependencies. A workspace adopted before this release keeps its manifest as written: an absent
  record stays "unknown", so its Kubernetes probes stay `tcpSocket` and its Prometheus annotations
  stay off until you set the fields.

### Add a `create<Pascal>JobProcessor` export to existing job modules, and expect `--dry-run` to exit 1 on a collision (M113i, 0.10.0, `@setu-ts/cli`)

**Standalone job modules in a functional project with `queue-plugin`.** `setu generate job` now
emits the module's exported `create<Pascal>JobProcessor` factory and the managed `src/jobs/index.ts`
barrel beside it. An existing standalone `src/jobs/<name>.job.ts` that exports no processor factory
is skipped and reported by `setu generate`: add the `create<Pascal>JobProcessor` export to the
module, or delete the file and regenerate it. A functional project without `queue-plugin` is
unchanged: the standalone function is emitted and scanned as before, with no skip report.

**`--dry-run` exit codes.** The `--dry-run` of `setu generate`, `setu new`, `setu library` and
`setu generate app` now reports `WOULD REFUSE: <path> already exists` for every file a real run
would refuse to overwrite and exits 1 when any exists, matching `setu adopt`; before, it printed
`would create` for every file and exited 0 before the existing-file check ran. A script or CI step
that ran a dry run over files that already exist and expected exit 0 must handle the new exit 1. A
clean dry run still exits 0, printing the `would create` / `would update` / `unchanged` lines.

### Pass the database and ledger to `runMigrations` (M113o, 0.10.0)

Regenerate managed `src/migrations/run.ts` and `index.ts` with `setu generate migration`. Replace
custom `runMigrations('up')` calls with
`runMigrations('up', { database, ledger: createMigrationLedger(database) })`, importing
`createMigrationLedger` from `@setu-ts/database-plugin`. Existing zero-argument `up`/`down` methods
remain assignable; new migrations can receive `{ database }`.

Create the application-owned ledger table or entity mapping described in the database-plugin README
before running. Run one migration job and make each change idempotent: ledger writes follow changes
outside any transaction. Memory history exists only in the serving process. Import `MIGRATION_NAMES`
from `./src/migrations/index.ts` and opt in with
`DatabasePlugin({ readiness: { migrations: MIGRATION_NAMES } })`. Socket entry points boot the whole
app without a port; named connections need a caller resolving that connection. Workers runners have
no executable entry block: call from code holding bindings or use `wrangler d1 migrations`.

Discovery warm-cache outages now keep the indicator `up`. If you alerted on `degraded`, inspect
`data.degraded` and `data.reachable` instead; `/ready` keeps serving warm replicas.

### Review `IRequest.ip`, rate-limit buckets and loader URLs (M113n, 0.10.0, breaking)

Node, Deno and Bun now set `IRequest.ip` to the socket peer, normalized from IPv4-mapped IPv6.
Unauthenticated `defaultRateLimitKey` calls therefore use `ip:<peer>` instead of one global
`anonymous` bucket. Review limiter budgets; behind a proxy register IP security with
`trustProxy: true` and `trustedProxies` to count clients rather than proxies.

The trusted-proxy walk now starts at that peer. List every legitimate proxy or sidecar; a sidecar
omitted from the list now resolves as the client and its forwarded headers are ignored. Direct
callers cannot select their own identity with a forged header. `proxyHops` and the leftmost default
still use header-only selection for the client IP, and in the `X-Forwarded-*` family a header too
short for `proxyHops`, or an all-trusted chain, resolves no client rather than the proxy itself.
With `trustedProxies`, a trusted proxy that sends no forwarding header also resolves no client, so
make sure each proxy writes one. Workers and plain fetch have no peer and retain the header-only
path. Workers can use `ipHeader: 'CF-Connecting-IP'`, which Cloudflare overwrites.

With IP security in `trustedProxies` mode and a trusted socket peer, React Router loaders/actions
now see the public URL; no other mode publishes a forwarded origin. Update redirects or tests that
expected the internal URL. `requestOriginOf` and `publicRequestUrl` in `@setu-ts/common` expose the
same origin. Select `forwardedHeader: 'forwarded'` for RFC 7239 instead of `X-Forwarded-*`; do not
also set `ipHeader`. Configure your proxy to overwrite the chosen origin headers. Use a configured
base URL for security-sensitive links.

`csrf: {}` works behind standard TLS termination using a validated `X-Forwarded-*` own-origin
candidate, even without IP security, for requests whose browser sends `Sec-Fetch-Site: same-origin`
(every current browser does). This comparison grants no proxy trust to session cookies or URLs.
Session `cookie.secure: 'auto'` follows the trusted origin protocol; its default stays `true`.
`'auto'` with `sameSite: 'none'` is refused at construction. See
[Behind a reverse proxy](./deployment.md#behind-a-reverse-proxy).

### Fix invalid scheduler times that reject with `RangeError` and refresh JWTs before `exp` (M113m, breaking)

**Fix invalid values before registering a job.** The async `delay` call now rejects with a
`RangeError` for a non-finite or negative `delayMs`; `every` rejects for a non-finite or
non-positive `intervalMs`; `delay`, `every` and `cron` reject for a non-finite or negative
`retry.delay`. Check configured or computed values before registration. Zero `delayMs` and zero
`retry.delay` are still accepted, and there is no upper delay or interval limit. Long waits now run
until their due time instead of being clamped to about 1 ms.

**Pause only re-runs unfinished one-shots.** A one-shot that already succeeded or exhausted its
retries is removed even while paused and is not re-run. A one-shot paused mid-retry stays registered
and resumes from attempt 1 with its original delay, discarding remaining backoff. Disconnect
releases its `:once` slot regardless of outcome. A cancelled fire is not reported as success:
diagnostics settle it with `false` and count it in `failed`, since no separate cancellation counter
exists. An in-flight handler can still reach a final success or failure after pause or disconnect.
`resume()` now rejects on a disconnected service: call `connect()` first.

**Refresh before `exp`.** First-party `JwtService.verify` now uses fractional seconds without clock
tolerance and rejects once `now >= exp`, instead of accepting a token for up to one second after
expiry; it also rejects while `now < nbf`. Update tests or clients that assumed a token remained
valid during the second of its `exp`. The outside-issuer verifier (`issuers`) now rejects exactly at
`exp + clockToleranceSec` too (previously only after it); its not-before check remains
`now + clockToleranceSec < nbf`.

### Key-change and cursor refusals answer `400`; Drizzle refuses unknown payload fields; bound PostgreSQL calls with `query_timeout` (M113g, breaking)

**Catch `PrimaryKeyChangeError`, not the old answers, for a key change through `update`.** Every
`update` and `updateWhere` of the eight data sources now refuses a payload that carries a key column
whose value differs from the addressed key, with `PrimaryKeyChangeError` (branded `400 Bad Request`,
fixed detail "An update cannot change a row's primary key."), before any I/O. If your code relied on
the old divergence — Drizzle, Prisma or D1 moving the row, or MongoDB, Cosmos DB or DynamoDB
answering success with the key column stripped — the same call now rejects. An equal value is still
accepted, compared as a string for `string`, `number`, `bigint` and `ObjectId`-like values and by
time for `Date` values, so `update('5', { id: 5 })` works and `'05'` against `5` is refused.
Bigtable's old `501` `UnsupportedQueryFeatureError` (`row-key`) answer is the same `400`; if you
branch on `instanceof UnsupportedQueryFeatureError` or on the `501` status for a Bigtable key
change, switch to `PrimaryKeyChangeError`.

**Catch `InvalidCursorError` for a bad cursor.** A `?cursor=` token that is malformed, was made
under a different sort, or is the wrong shape for the target now rejects with `InvalidCursorError`
(branded `400 Bad Request`, fixed detail "The pagination cursor is not valid for this query.") from
every `findPage` implementation, before any backend call; `instanceof UnsupportedQueryFeatureError`
no longer matches it. `501` remains for a backend that cannot page the query at all, so a catch that
meant "this backend cannot page" must now distinguish the two.

**Pick the columns before a Drizzle write.** A Drizzle `create`, `update` or `updateWhere` payload
that names a field that is not a column of the table is now refused by name before any I/O instead
of being dropped by Drizzle, with `UnknownPayloadFieldError` (`400`); if you passed a whole DTO,
project the table's columns first. A Drizzle table whose key column is not a column of the table is
now refused when the repository is created (`getRepository`), instead of lazily inside `findById`,
`update` or `delete` — check the table definition and the `primaryKey` override at startup, not on
first use.

**Bound PostgreSQL calls with `query_timeout`.** The plugin adds no call deadline of its own — a
JavaScript deadline cannot cancel the statement, and inside a transaction it rejects while the
statement may still commit. Set `query_timeout` (and `connectionTimeoutMillis` for the connect
attempt) on the `Pool` you hand Drizzle; a query that hits the bound now answers
`504 Gateway Timeout` with `DatabaseTimeoutError` (fixed detail "The database did not answer in
time."), and node-postgres's second connect-timeout message
(`Connection terminated due to connection timeout`) answers `503` beside
`timeout exceeded when trying to connect` instead of a masked `500`. The timed-out statement may
have run, so a write's outcome is unknown — make a retried write idempotent. The behaviour of a
timed-out statement inside a transaction is measured in this milestone; see the
`@setu-ts/database-plugin` README's `Bounding a call` section.

### Health `details` and `SwaggerOptions` (M113f, breaking)

**V9-47:** `/health`, `/live`, and `/ready` now return status-only checks by default:
`{ status, timestamp, checks: { name: { status } } }`. Dashboards that read `checks[*].data` or
`latencyMs` must set `HealthPlugin({ details: true })` (or a starter's `health: { details: true }`).
Programmatic health reports stay full and the gRPC bridge is unchanged; diagnostics never carried
indicator `data` and are unaffected.

**V9-49:** Swagger UI now self-hosts its assets. Install `swagger-ui-dist` (`^5`) in applications
that use `OpenApiPlugin` or a starter with Swagger enabled. Deno tasks also need `--allow-read`.
Otherwise startup fails with `OptionalDependencyUnavailableError`. To use the pinned external assets
instead, set `OpenApiPlugin({ swagger: { assets: 'cdn' } })`, or a starter's
`openapi: { swagger: { assets: 'cdn' } }`. Workers needs that external mode or
`assets: { baseUrl: '/assets' }`; the starters select the CDN there when no Swagger asset mode is
chosen; a custom base must serve the exact 5.33.3 files for SRI to pass. Fresh CLI projects declare
the dependency and select CDN mode for Workers automatically. If you add `swagger-ui-dist` to an
existing npm project, it pulls in `@scarf/scarf`, whose `postinstall` sends install analytics; set
`"scarfSettings": { "enabled": false }` in your root `package.json` to opt out, as generated
projects do. In a workspace the setting belongs in the root `package.json`, the one npm is run from;
a member's own setting is ignored.

Handled 4xx now logs once at `warn`; handled 5xx logs once at `error`. Completion logs report the
responder's status rule; a custom `respond` hook choosing another status is not reflected there.
Without a logger, handled 5xx and kernel unhandled errors reach the runtime's default error sink.

### `principalAuthorityIsGlobal`, `exemptBearer`, anonymous sessions and `needsRehash` (M113e)

**Scoped RBAC no longer reads the principal's own roles.** If your scoped checks
(`requireScopedRole`, `requireScopedPermission`, `@ScopedRoles`, `@ScopedPermissions`) passed
because a token carried the role or permission, they now answer `403` until the principal holds a
grant for that scope. Issue the grants, or set `scopedRbac: { …, principalAuthorityIsGlobal: true }`
to keep the old behaviour — every principal role and permission then counts in every scope.

**Form CSRF skips only a bearer request that a bearer strategy authenticated and that restored no
session.** With `SessionPlugin({ csrf: {} })`, a request carrying `Authorization: Bearer <token>` is
no longer checked for a form token when a bearer (header-credential) strategy authenticated it and
it restored no session. If you added an `exclude` such as `/^\/api\//` only to let a bearer API
through, you can remove it. To keep checking those requests, set `csrf: { exemptBearer: false }`.
The exemption no longer trusts a bare header: a junk bearer header beside a session cookie is still
verified, and an unauthenticated bearer header is verified too. A request carrying a valid session
cookie must send the CSRF header even with a valid bearer token, because the handler would otherwise
act on that browser's session — so a browser app calling the bearer API while holding a session
cookie must send the CSRF header. A request the bearer rule exempts also gets no browser session:
whatever its handler writes to the session is not committed and no `Set-Cookie` is sent (M113e, L4),
so it cannot plant a session in a browser whose cookie no longer restores. The form-CSRF middleware
moved from priority 275 to 325 (after authentication at 300, before authorization at 350) to make
that check; custom middleware registered between 275 and 325 that relied on form CSRF having run
must move above 325.

**Anonymous sessions on the store strategy stay in the cookie.** Nothing to change. During a rolling
deploy an older replica treats the new anonymous cookie as no session, so a visitor with a form open
may get one `403` and must reload it; signed-in sessions are unaffected.

**`PasswordHasher` hashes at 600,000 iterations.** Existing hashes keep verifying. To upgrade them,
re-hash on a successful sign-in:

```typescript
if ((await hasher.verify(user.passwordHash, password)) && hasher.needsRehash(user.passwordHash)) {
  await saveHash(user.id, await hasher.hash(password));
}
```

On Cloudflare Workers, which are reported to refuse PBKDF2 counts above 100,000, construct the
hasher with `new PasswordHasher(runtime, { iterations: 100_000 })`.

### Outbox and inbox `release` refusals answer `400`/`404`/`409`; `OutboxRowStateError` gains `invalid-id` (M113j)

**`release` refusals no longer answer a masked `500`.** An unhandled `release` refusal under
`errorHandler` now answers its own status: `400` for a bad row id (`invalid-id`), `404` for an
absent row (`missing`), and `409` for a row in the wrong state (`not-failed` for the outbox,
`not-parked` for the inbox). `InboxRowStateError` and `OutboxRowStateError` are branded with
`withHttpStatusHint`, so the answer carries the mapped status with the class's own title and detail;
the row id and the stored status stay out of the body. No reader action is needed — match the new
status instead of the old `500`; the rejection is the same one.

**`OutboxRowStateError.outcome` gains `'invalid-id'`.** An outbox `release` with an empty or
non-string row id no longer rejects with a bare `TypeError`; it rejects with
`OutboxRowStateError('invalid-id')` (the `400` above), like the other refusals. If you switch on
`outcome` exhaustively without a `default`, add a case for `'invalid-id'`.

### Queue reconnect, `QueueProcessorDefinition` and Deno shutdown (M113c)

RabbitMQ queues now recover automatically. Unacked jobs can be delivered again with their original
attempt count after a reconnect; make processors idempotent. Injected connections remain
caller-owned.

Redis queues now use a renewed 30000 ms delivery lease (`visibilityTimeoutMs`, from `1000` to
`2147483647`, on both RedisQueue and QueuePlugin). Redis 5+ and `eval` are required for the lease; a
minimal injected client without `eval` keeps the old behavior, with one connection-error report
naming the inactive option when a reporter is configured (`QueuePlugin` always configures one). The
service renews every third of the lease while a processor runs, with no overlap, and reports renewal
failure once. Raise the duration for expected event-loop pauses; delivery remains at least once, so
make processors idempotent. A live stuck processor keeps renewing and is not reclaimed.

**Drain old replicas before upgrading.** Their processing scores are immediately expired under the
new model; stuck jobs return on reserve. Each abandoned lease counts as an attempt, and dispatch
dead-letters a job above `maxAttempts` without running it. Redis and RabbitMQ now reject a stale
ack, retry or dead-letter with internal `StaleClaimError`; the service records failed settlement and
leaves the current delivery intact. Claim tokens are delivery fences, not authorization; Redis ACLs
remain the boundary.

`QueueProcessorDefinition<T>` accepts typed payload processors and calls them as methods on the
definition. Its `processor` member loses `readonly`; enforce immutability in application code if
needed.

Deno stop initiates HTTP shutdown after the kernel's bounded drain and waits for shutdown or a 1000
ms grace, catching a rejection. Lifecycle cleanup then runs even with requests still in flight. Put
resource teardown in shutdown/close hooks. The default drain plus grace bounds stop at about 11 s.

Redis `keyPrefix` defaults to `queue:`. Give applications on shared Redis distinct prefixes. Drain
or migrate existing jobs before changing a deployed prefix; the RabbitMQ `prefix` option does not
configure Redis.

### Workers projects: thread `waitUntil` through the factory

<!-- version:history -->

A Workers project scaffolded by 0.10.0 passes the platform's `waitUntil` from `src/index.ts` into
`createApp` in `setu.config.ts` as its SECOND parameter, on every template. The CLI does not edit an
existing project, so a project scaffolded by 0.9.0 or earlier keeps what it had: only the
`microservice` template threaded `waitUntil`, and the others call `createApp(env)`.

`setu add cloudflare` prints a registration that reads `waitUntil`. To use it in an older `rest`,
`class-based` or `full-stack` Workers project, make two edits:

```typescript
// setu.config.ts — add the second parameter
export function createApp(
  env: Readonly<Record<string, unknown>> = {},
  waitUntil?: (promise: Promise<unknown>) => void,
  _devtool?: { plugins?: readonly IPlugin[]; diagnostics?: KernelDiagnosticsOptions },
): IKernelApplication {

// src/index.ts — import the sink and pass it
import { waitUntil } from 'cloudflare:workers';
// …
return createApp(env, waitUntil);
```

A project scaffolded by 0.10.0 already has the parameter, named `_waitUntil` while nothing reads it;
rename it to `waitUntil` when you add the registration.

Without `waitUntil`, `CloudflarePlugin` now logs one warning at startup on Workers, and
`cacheApiMiddleware` awaits its cache write before answering instead of losing it.

### Full-stack Workers projects: pass `serverBuild` as a module

<!-- version:history -->

A `full-stack` Workers project scaffolded by 0.9.0 builds but cannot start: its `setu.config.ts`
locates the server build with `new URL('./build/server/index.js', import.meta.url)`, which a bundled
Worker cannot resolve. Scaffolding a new project is simplest. To repair an existing one:

- In `src/index.ts`, add `import * as serverBuild from '../build/server/index.js';` and call
  `createApp(env, waitUntil, undefined, { serverBuild })`.
- In `setu.config.ts`, give `createApp` a second `_waitUntil` parameter and widen the `ssr`
  parameter to
  `{ serverBuild: unknown } | Pick<ReactRouterPluginOptions, 'loadRequestHandler' | 'mode'>`. In the
  `reactRouter` options, pass `serverBuild: ssr.serverBuild` when `ssr` carries one, and keep
  `serverBuildPath` otherwise (`setu commands` loads this file without the entry).
- In `wrangler.toml`, add `[assets]` with `directory = "./build/client"` and `[build]` with
  `command = "npm run build"`, so the client bundle is served and the server build exists before the
  Worker is bundled.
- Create `.dev.vars` with `SESSION_SECRET` for `wrangler dev`, add it to `.gitignore`, and set the
  production value with `npx wrangler secret put SESSION_SECRET`.

### Readiness and `RedisRateLimitStore` outage migration (M113b)

- **Breaking readiness behaviour (M113b, 0.10.0).** Seven indicators now remain `up` where they
  previously reported `degraded`, so `/ready` changes from 503 to 200 and `/health` no longer
  changes overall status for these conditions. Migrate alerts to inbox `data.parked` /
  `data.reasons`, outbox `data.reasons` (all six reasons), realtime-backplane `data.reachable`,
  worker-pool `data.available`, static-files `data.fs`, auth `data.current` / `data.issuers`, and
  feature-flags `data.healthy` / `data.detail`. `degraded` still means out of rotation: `/ready`
  503, `/health` 200. Healthy Kubernetes and Consul discovery probes now preserve their receiver and
  allow readiness.
- **Breaking Redis outage responses (M113b).** Cache and rate-limit connection faults now carry 503
  status hints instead of reaching `errorHandler` as masked 500s; cache-backed sessions inherit the
  cache response. Update response handling to accept 503 and inspect `cause` instead of checking raw
  driver errors. WRONGTYPE/programming errors are unchanged.
- **Breaking rate-limit wait bound (M113b).** Built `RedisRateLimitStore` clients now use a 15000 ms
  command bound. Configure `commandTimeoutMs` higher for slow Redis, or `0` for the previous
  unbounded wait; configure injected clients directly.

### Messaging `publishTimeoutMs`, `reconnect` and Kafka group starts (M113a)

- Kafka and Pub/Sub now bound publishes at 15000 ms, including RPC and outbox publishes. Set
  `publishTimeoutMs` higher for slow brokers or to `0` for the previous unbounded wait. A timeout
  does not prove rejection: the message may still arrive, so retries need de-duplication.
- An injected Kafka factory without `admin()` reports unknown reachability. Supply an admin-capable
  factory for a probe; its timeouts remain your responsibility. Lazy clients build a separate
  short-timeout health client. Pub/Sub transports may return `undefined` from `isHealthy()`; code
  consuming that member directly must handle unknown. Existing boolean implementations still fit.
- Lazy NATS connections reconnect forever by default. To retain the previous budget use
  `reconnect: { maxAttempts: 10, waitMs: 2000 }`; exhausted connections stay down. Configure an
  injected connection yourself: combining `client` and `reconnect` throws `TypeError`.
- Fresh Kafka groups start at the high watermark captured during `subscribe()`. Remove sleeps or
  repeated publishes that worked around losing the first message; a single post-subscribe publish is
  delivered once the consumer joins, without replaying earlier history. Existing committed groups
  are unchanged. The first join seeks assigned uncommitted partitions to the minimum start offsets
  advertised by current members, so concurrent first starts also deliver messages published after
  any member’s subscription resolves, without replaying history before the first subscription. Group
  members are trusted for this: joining needs only Read on the group, so a principal without topic
  Read can still make a new group replay unlogged; restrict who can join the consumer group (Kafka
  group ACLs) where a replayed history matters. Without admin the step is skipped. Injected
  factories try importing kafkajs once at connect; if unavailable, members seek their own offsets
  and concurrent first starts can miss messages. A member crashing before the join takes its start
  offsets with it. Admin/metadata failures warn once per subscription with topic/group and remain
  non-fatal.

<!-- version:history -->

## 0.9.0

### The framework installs from npm (`npm:@setu-ts/`); `--runtime` defaults to `node`

<!-- version:history -->

From 0.9.0 the packages are published to npm under their own names (`@setu-ts/kernel`, …), and the
CLI is a Node program. What an existing project changes depends on its target:

<!-- version:history -->

- **Node, Bun or Workers project.** Replace each `npm:@jsr/setu-ts__<pkg>@^0.8.0` dependency with
  `^0.9.0` under the key it already has (`"@setu-ts/kernel": "^0.9.0"`), delete the
  `@jsr:registry=…` line from `.npmrc` (or the file, if that was its only line), and reinstall.
- **Deno project.** Search for `jsr:@setu-ts/[^"\s]+@[^"\s]+` (matching both `@^0.8.0` and
  `@0.8.0`). Replace each `jsr:@setu-ts/<pkg>@…` import, whatever its range, with
  `npm:@setu-ts/<pkg>@^0.9.0`, add `"nodeModulesDir": "auto"` to `deno.json`, and run
  `deno install`. The CLI now imports `setu.config.ts` from Node to find plugin commands, so it
  reads the project's `node_modules`; until `deno install` has created it, `setu <command>` refuses
  and says so.
- **A project you are adopting into a workspace.** `setu adopt` rewrites both pre-0.9 forms onto npm
  as it moves the project, and reports each pin it changed.

Scaffolding without `--runtime` now produces a Node project; pass `--runtime deno` where a script
relied on the old default. Install the CLI from npm: `npx @setu-ts/cli …`, `npm create @setu-ts`, or
`npm install --global @setu-ts/cli`.

Code that embeds the CLI through `@setu-ts/cli/main`: `MainProcess.prompt` now returns
`Promise<string | null>` and takes the run's interrupt signal as a second argument, and
`denoProcess` is replaced by `nodeProcess`.

### `RedactionPolicy.fields` values may now be a `FieldRedaction`

No action is required for a policy that supplies classification strings — every existing policy
behaves identically. Only code that READS a policy's `fields` values back as a `DataClassification`
is affected: the member is now `DataClassification | FieldRedaction`, so narrow with
`typeof value === 'string'` before using the value as a classification. No released framework code
path reads a policy back, so this is a note rather than a required migration.

### Set `maxWorkers` to size worker pools across task modules

WorkerPoolPlugin now caps the sum of worker slots across modules. The default is the largest of
available parallelism, defaultPoolSize and the sum of explicitly configured pool sizes. Applications
with several modules using fallback sizes share that budget; tasks may wait or cause idle workers to
retire. Set `maxWorkers` for your container's memory budget, or pass `maxWorkers: Infinity` to
restore the previous unbounded sum. Invalid explicit bounds throw `RangeError` at construction. Task
timeouts include time waiting for budget. `/health` now reports `budget: { maxWorkers, workers }`
(`null` for the unbounded limit).

A worker that does not signal ready within `startupTimeoutMs` (default 10 s, applied even with
`taskTimeoutMs: 0`) is terminated, its slot returns to the budget, and the oldest waiting task for
that module rejects with `WorkerTaskError` (`remoteName: 'WorkerStartupTimeout'`). When a queued
task expires while another module has work and no worker, the expiring module yields a starting
worker to it, so a module that never becomes ready cannot starve the others under steady demand.
Callbacks from removed slots are ignored. Termination throws/rejections are contained; shutdown
waits at most 1,000 ms per termination, including already-retired slots. This bounds waiting, not
physical thread exit: a failing host can leave a worker alive. Module metadata remains retained for
the service lifetime. `NaN` or `Infinity` legacy default/pool sizes contribute zero to the derived
budget; their per-pool behavior remains unchanged, while independently valid configured modules
remain usable.

With `taskTimeoutMs: 0` (or a per-call `run()` option of `timeoutMs: 0`) under a finite
`maxWorkers`, a task that never settles holds its slot until restart and can starve other modules;
keep a task timeout on modules that share the budget, or pass `maxWorkers: Infinity`. `register()`
logs a warning when the plugin-wide or a per-pool `taskTimeoutMs` is `0`; a per-call `timeoutMs: 0`
is not visible at registration and gets no warning. On Deno a timed-out CPU-bound task keeps running
after its slot is released, and may keep writing to a `SharedArrayBuffer` after its promise
rejected: do not reuse such a buffer.

`taskTimeoutMs` (plugin-wide and per pool) and the per-call `timeoutMs` are now validated: each must
be `0` or a positive integer no greater than 2147483647. `NaN` (what `Number()` returns for an unset
environment variable), negative, fractional and larger values used to be accepted and either
disabled the timeout or fired it after about 1 ms; they now throw `RangeError` at construction, or
reject that `run()` call. Parse configuration explicitly and pass `0` if you mean "no timeout".

The worker-pool example starts on 127.0.0.1 with scoped Deno permissions. Remote health exposure
requires an explicit application deployment decision.

### Pass `autoRegister: false` to keep a container closed

`DiPlugin()` now defaults `autoRegister` to `true`, so a token the container does not hold resolves
from the kernel's service registry. Nothing changes for a project that already passed
`autoRegister: true`. A project that relied on the old default to refuse framework capabilities
passes `DiPlugin({ autoRegister: false })`.

### Handle `409` for a duplicate key, where it used to be `500`

A write that duplicates a primary key or a unique index now rejects with `DuplicateKeyError` from
`@setu-ts/common` and answers `409 Conflict`. Before, every backend answered a masked `500`. Nothing
in your code has to change for the new status to be correct, but a test or a client matching `500`
for a duplicate stops matching. `instanceof DuplicateKeyError` replaces matching driver codes or
message text. Do not retry it: unlike `SerializationConflictError`, the same write fails the same
way.

### Make RabbitMQ handlers idempotent and configure `consumerRetry`

Durable consumer groups now retry handler failures with five total attempts and delays
`[5000, 30000, 120000, 600000]` ms. Make handlers idempotent: retries and a crash between confirmed
copy and original ack can repeat side effects. Deserialize and integration-event rejections
dead-letter immediately; `consumerRetry.isRetryable` can return false for other deterministic
failures. Set `consumerRetry: false` to retain the existing operator DLX policy.

Allow the application to declare durable `Q.retry.<delay>ms` quorum queues and `Q.dead`. Extend
vhost permissions before upgrading: the RabbitMQ user needs configure permission on `Q.dead` and
`Q.retry.<delay>ms`, read permission on `Q.retry.<delay>ms`, and write permission on the default
exchange, `amq.default`, which carries every retry and dead-letter copy (measured on RabbitMQ 4:
without them `subscribe()` fails with `403 ACCESS_REFUSED` on the first helper declaration, and a
copy published without `amq.default` write closes the channel). Changing delays is safe; changing
`deadLetterMaxLength` (default 10000) requires draining and deleting `Q.dead` before restart,
because RabbitMQ rejects changed queue arguments. Inspect `x-setu-attempts`, `x-setu-topic` and the
bounded `x-setu-error` in dead letters, and apply access/retention policy for their data. Default
prefetch is now 32 per consumer; configure `prefetch` for handler concurrency and latency. Injected
channels should implement `prefetch`. Private exclusive queues and RPC reply inboxes retain discard
behavior. A failed copy leaves the original unacked; the broker then closes that channel, which
returns it to `Q`, and reconnects, re-declaring the retry and dead queues before consuming again.

`ConsumerRetryOptions` now names the shared RabbitMQ/Redis retry object type; Redis behavior and its
existing option shape are unchanged.

Group names ending in `.dead` or `.retry.<digits>ms` are reserved when retries are enabled, and
generated helper names must fit 255 UTF-8 bytes. Rename conflicting groups, or set
`consumerRetry: false` to retain existing names. Migrate queues already occupying helper names in
the same vhost before enabling retries. Invalid names fail before declaration, so they cannot close
the shared consumer channel with a 406. Injected recovery channels must support publisher confirms,
`on`/`off` return listeners and `close()`; otherwise `subscribe()` on a retrying group now rejects,
so supply `createConfirmChannel()` or set `consumerRetry: false`. Mandatory retry/dead publishes
reject unroutable returns and leave the original unacked; `x-setu-disposition-id` is framework-owned
and replaced on each copy.

### Update `IRedisStreamsClient` facades and Redis consumer handlers

Injected messaging Redis facades must implement the required `xpending`, `xclaim`, and `xinfo`
methods using ioredis 5 RESP2 reply shapes, and accept `xgroup('DELCONSUMER', ...)`. A facade
missing a method now fails connection. Redis 6.2 or newer is required for `XPENDING IDLE`; its
trimmed-entry `XCLAIM` reply contains a null slot, which the facade must preserve.

Failed messages now redeliver, including pending entries from before an app restart. Make handlers
idempotent. Set `consumerRetry.delaysMs[0]` above the longest handler runtime to prevent another
replica claiming a slow handler's entry. Defaults are five total attempts, delays
`[30000, 60000, 300000, 600000]`, and a 5000 ms reclaim interval. `consumerRetry.isRetryable` can
return `false` for immediate dead-lettering; deserialize and integration-event rejections
dead-letter immediately regardless. There is no `consumerRetry: false` option.

Inspect failed messages in `<topic>.dead.<group>`; each carries its original fields,
`x-setu-source-id`, and `x-setu-deliveries`. Configure `deadLetterMaxLen` (default 10000,
approximate trimming) and suitable Redis access/retention policy for payload data.
`consumerIdleSweepMs` defaults to one hour. Clean consumers are removed on stop; consumers with
pending entries remain until their work is recovered.

### Set `referrerPolicy` for native full-stack forms (M101g)

Existing full-stack starter compositions should configure
`httpSecurity: { headers: { referrerPolicy: 'same-origin' } }` in `setu.config.ts`. The default
`no-referrer` policy can make Chromium send `Origin: null` on a native form post, which React Router
refuses. The full-stack scaffold now sets `same-origin`: cross-origin referrers remain suppressed,
and session CSRF and React Router origin checks remain enabled.

### Enable development policies with `setu devtool enable` (M101g)

Run `setu devtool enable` on an eligible Deno project to generate the CLI-managed
`src/devtool/diagnostics.ts` policy and wire recognized plugin calls. Manual configurations receive
guidance. Source options activate only when `createApp` receives its devtool argument. The module
contains approved names, never environment values, and is refreshed by `setu add`; keep
application-specific policies in application-owned configuration. Empty approval maps approve no
observations.

### Return `IKernelApplication` from scaffold factories (M101g, V8-12)

In `setu.config.ts`, replace `createApp`'s `IApplication` return annotation with
`IKernelApplication`, imported as a type from `@setu-ts/kernel`. For an async starter factory, use
`Promise<IKernelApplication>`. Remove the old common type import if nothing else reads it. The value
already has this type; the old annotation hid `inject`, `unregister`, and `hasPlugin` from
`createTestApp({ app: await createApp() })`. Workers' `boot` and `ensureBooted` helpers follow the
same type change in new scaffolds.

`setu add testing` now accepts `@setu-ts/testing`, putting it in Deno's import map or npm's
`devDependencies`. New socket-target scaffolds include `test/app.test.ts`; an existing project can
add the same composition-root smoke test using its runtime's test harness.

### Replace links inside a project before running a writing `setu` command

`setu` now refuses to write through, or `adopt` to move, a path reached through a symbolic link
inside the project or workspace, and refuses a dangling link, with nothing written. If you link a
file into a project on purpose (a shared `deno.json`, for example), replace the link with a copy
before running `generate`, `add`, `devtool enable`, `workspace ports --reallocate` or `adopt`. A
project reached through a linked parent directory needs no change.

### Refresh `main.dev.ts` and production images (M101f)

<!-- version:history -->

Upgrade every `@setu-ts/*` pin together before `setu devtool enable`; mixed versions are refused.
Apply the complete factory edit in the CLI README: the second parameter AND both usage spreads. The
development entry now stops when composition is discarded. Restore an edited entry before
`ports --reallocate`; only CLI-rendered entries are rewritten, and an unedited 0.8.0 entry counts as
one — the next reallocation or `devtool enable` upgrades it. Workspace manifests record
`devtoolBasePort` on first allocation, defaulting to `basePort + 1000` (capped at 65535). Standalone
defaults probe 4919–5019; read the reported port or pass `--devtool-port`.

Regenerate managed deployment files with `generate app`, `devtool enable`, or `ports --reallocate`
and rebuild production images to exclude the development entry and connector cache. Replace aliases
containing Unicode format characters (bidi controls, zero-width format characters) or the line and
paragraph separators U+2028/U+2029 with printable ones; these now fail at construction and wire
validation. Code matching the old "contains a control character" refusal text should match "contains
a control, format or line-separator character".

The devtool extension release must re-pin the framework to this milestone merge commit and retain
previous recipe renderings in its catalog. Until that cross-repository update, an older launcher may
refuse newly generated entries with `PREPARATION_FAILED`.

### Update programmatic CLI `Prompter` implementations

<!-- version:history -->

`Prompter.select` now returns `PromptSelection`. Replace a string result with
`{ kind: 'answer', value }`, inability to prompt with `{ kind: 'unavailable' }`, and user
cancellation with `{ kind: 'cancelled' }`. Cancellation stops scaffolding and exits `130`. This is a
breaking change for programmatic `Prompter` implementors and ships in `0.9.0`.

The four M101a entries (`acquireTimeoutMs`, `SecretProviderUnavailableError`, the `database` and
`queue` health data, `commandTimeoutMs`) do not fail to compile; each is a default that now applies
to a running application. The three M102 mail entries can. The three M101b messaging entries do not
fail to compile; each changes what a running broker names or refuses. The two M101c entries do not
fail to compile: one changes a documented recipe that otherwise refuses an IdP posting
`Origin: null`, the other makes the memory adapter refuse writes it used to accept. The RabbitMQ
durability entry does not fail to compile; it makes `publish()` and `add()` wait for the broker.

### Handle a rejecting RabbitMQ publish (`publishTimeoutMs`)

With `broker: 'rabbitmq'` (`messaging-plugin`) or `adapter: 'rabbitmq'` (`queue-plugin`),
`publish()` and `queue.add()` now resolve only once RabbitMQ has accepted the message, and reject
when it refuses it, when the channel closes first, or when `publishTimeoutMs` (default `15000`)
expires. Before, they resolved before RabbitMQ had stored anything and never rejected — which is
also why a broker restart could lose messages without any caller noticing. Code that published
without handling a rejection should now handle it. A rejection is not proof the message was dropped:
retrying can deliver it twice, so a retried message needs an idempotent consumer.

Messages are also published persistent now, so they survive a broker restart. To keep the old
transient publishes for deliberately ephemeral traffic, pass `persistentMessages: false`. An
injected AMQP connection without `createConfirmChannel()` still works, unconfirmed, and logs one
warning; a real amqplib connection always has the method.

### Give memory-adapter rows distinct keys, and do not change a key by `update` (M101c)

The memory adapter now refuses a `create` whose caller-supplied primary key is already stored, and
an `update` whose payload changes a primary-key value — every real backend already refuses both. A
test that inserted the same key twice, or renamed a row's id through `update`, now rejects: give
each row its own key (or let the adapter generate one), and delete and recreate a row to change its
id.

### Change the SAML CSRF recipe to use `CsrfOptions.exclude` instead of trusting the IdP origin (M101c)

If you run a SAML provider behind both CSRF defences, the documented recipe now exempts the ACS path
on **both** plugins rather than trusting the IdP's origin on `http-security-plugin`:

```diff
  SessionPlugin({
    secret: '…',
    csrf: { exclude: ['/auth/corp/acs'] },
  });
- HttpSecurityPlugin({ csrf: { trustedOrigins: ['https://sts.example.com'] } });
+ HttpSecurityPlugin({ csrf: { exclude: ['/auth/corp/acs'] } });
```

Why the change: an IdP that serves `Referrer-Policy: no-referrer` (Keycloak does) makes the browser
post the ACS with `Origin: null`. The old recipe's `trustedOrigins` admits only a REAL origin, so
under `Origin: null` the ACS answers `403` and sign-in is broken. The one allowlist answer —
`trustedOrigins: ['null']` — is worse than the exemption, because it admits every opaque-origin
`POST` on every route. `exclude` is path-scoped: it exempts the ACS, whose signed assertion,
single-use request and binding cookie are the defences the CSRF check would otherwise add. Nothing
to do if you do not run both CSRF defences in front of a SAML ACS, or if your IdP sends a real
origin and you keep `trustedOrigins` for it.

### Regenerate clients whose OpenAPI document declares `3xx` responses

Generated SDK clients keep an error arm for every declared `3xx`, including the statuses `fetch`
follows automatically (`301`, `302`, `303`, `307`, and `308`), since an unfollowed one — no
`Location` — still throws `HttpClientError`. Regenerate affected clients; any operation declaring an
auto-follow redirect or the OpenAPI `3XX` range now returns `unknown`, representing the follow
target body the document does not name. This also applies when the operation declares a `2xx`
response alongside the redirect.

### Keep `acquireTimeoutMs` below each scheduled job's interval

Every distributed-lock acquire is now bounded by `distributedLock.acquireTimeoutMs`, default `5000`.
An acquire still unsettled at the bound skips that fire. If a job runs more often than every five
seconds, set `acquireTimeoutMs` below its interval. If you set `commandTimeoutMs`, it must not
exceed a non-zero `acquireTimeoutMs`, or `SchedulerPlugin(...)` throws `RangeError`. `0` restores
the old unbounded wait, which leaves the schedule parked while the lock backend is unreachable.

### Catch `SecretProviderUnavailableError` where you handled a Vault error

A Vault request that fails on the network or times out (default `requestTimeoutMs: 5000`) now
rejects with `SecretProviderUnavailableError`, answered `503` through `errorHandler`, instead of a
plain `Error` answered as a masked `500`. Catch it by identity if you handled the old error, and
raise `requestTimeoutMs` if a slow Vault legitimately takes longer.

### Review alerts keyed on the `database` and `queue` health data

A Drizzle pool connection timeout now reports `degraded` instead of `down`, and, with `poolStats`
supplied, a saturated pool reports `up` with `reachable: 'unknown'` while its queries keep
completing through the adapter (a full pool with no completed query in 10 seconds reports
`degraded`; queries run on your own Drizzle instance are not counted, while once the typed
`getDrizzleDatabase`/`getDrizzleTransaction` seam is used progress is unobservable and saturation
reads `up`). An alert that paged on `down` for pool exhaustion should watch `degraded` or
`data.capacity` instead. Separately, a queue depth row the latest diagnostics cycle could not read
is now absent rather than repeating the previous count; a dashboard should read `depthCoverage`
instead of assuming every name has a row.

### Raise `commandTimeoutMs` for a slow Redis network

Cache and queue Redis commands are now bounded at `15000` ms through `commandTimeoutMs`. An injected
client is unaffected. Set `commandTimeoutMs` higher, or `0` to disable, if a command legitimately
takes longer.

### Await `TemplateEngine.render` if you call the mail template engine directly

`@setu-ts/mail-plugin`'s exported `TemplateEngine.render(name, data)` now returns a
`Promise<RenderedTemplate>` (M102), so a direct caller adds an `await`; unknown-template and
missing-placeholder refusals arrive as rejections rather than synchronous throws. Nothing to do if
you only ever reached templates through `IMailer.sendTemplate`, which already returned a promise.
The constructor's new second parameter (a view engine) is optional and only needed for the new
component-template arm, which `MailPlugin` supplies for you.

### Extend `MailStringTemplate`, not `MailTemplate`

`MailTemplate` is now the union `MailStringTemplate | MailComponentTemplate` (M102). TypeScript
refuses to extend or implement a union, so `interface X extends MailTemplate` (`TS2312`) and
`class Y implements MailTemplate` (`TS2422`) stop compiling. Name `MailStringTemplate` instead — it
carries the released `{ html?, text? }` shape. Anything that only holds or assigns a `MailTemplate`
value needs no change.

### Connect a `LogProvider` before sending through it directly

`@setu-ts/mail-plugin`'s `LogProvider` and `SendGridProvider` now reject a send while not connected,
matching the SMTP and SES providers. Through `MailPlugin` nothing changes, because the plugin
connects the provider during `register()`. A test that constructs `new LogProvider()` and sends on
it without connecting must add `await provider.connect()` first.

### Drain the old shared `messaging-consumers` Pub/Sub subscription

A Pub/Sub subscription with no `queue` is now named per topic, `messaging-consumers.<topic>`
(M101b). On upgrade every topic gets a new subscription, and an existing `messaging-consumers`
subscription keeps any backlog with no consumer. Pass
`SubscribeOptions.queue: 'messaging-consumers'` on the ONE topic that owns it until its backlog is
drained, then delete it. A subscription whose name is already bound to another topic now rejects
`subscribe()` with `PubSubSubscriptionBoundElsewhereError` instead of being attached to.

### Run NATS 2.10 or later for `setu.queue` consumer metadata

A NATS consumer now records its raw queue as `setu.queue` metadata (M101b), which the server accepts
from 2.10. On an older server every `subscribe()` rejects. If you use request-reply, the JetStream
stream must also cover `rr.req.<topic>` and `rr.inbox.>`.

### Pre-create Kafka topics, or expect `KafkaTopicUnavailableError`

A subscription to an unknown Kafka topic now retries for about 9 s (`retry`), then rejects with
`KafkaTopicUnavailableError` (M101b) — so on a broker without `auto.create.topics.enable`, `start()`
for a declared subscription to a missing topic fails after that budget rather than at once. Create
the topic first, or set `retry: { retries: 0 }` to fail immediately.

### Run Node.js 22 or later (`engines.node >=22`)

<!-- version:history -->

The documented floor was Node 18; five packages use `Promise.withResolvers`, which Node 22 was the
first to ship. Upgrade runtimes and production images to Node 22 or newer before installing `0.9.0`
(CI verifies on Node 24).

### Test a missing header against `undefined`, not `null`

`@Params(Header('X-Name'))` now passes `undefined` for an absent header, like a missing cookie or
query parameter. A handler testing `=== null` must test `=== undefined`.

### Match bare package names in lazy-import errors and `GrpcRuntimeLoadError`

Lazy-import failures now name the bare package (`ioredis`, `@connectrpc/connect`,
`@node-saml/node-saml`) instead of an `npm:…` specifier, including `GrpcRuntimeLoadError.specifier`
and the telemetry loaders' reported `specifier`. Code matching the old strings must match the bare
name.

### Handle a rejecting `NatsBroker` publish

`NatsBroker.publish()` now resolves only once JetStream has stored the message, and rejects with an
error naming the subject when no stream captures it. A publish that used to resolve silently now
rejects: await it, handle the rejection, and make sure a stream captures every subject you publish
to.

### Keep `RabbitMqBroker` names within 255 bytes

An exchange, queue, topic, message id or header name over 255 bytes is now refused (a processor at
registration, a publish before it is sent) instead of jamming the channel. Shorten any that exceed
the limit, counting the suffixes the queue adapter appends to a job name.

### Set a `content-type` on streamed responses that clients read as text

On Node, a `ctx.response.stream(...)` body with no `content-type` no longer arrives labelled
`text/plain; charset=UTF-8`, matching Deno, Bun and Workers. Set the content type explicitly where a
client relied on that default, and send `X-Content-Type-Options: nosniff` for untrusted bytes.

### Order a global `cacheMiddleware` after the locale and tenant middleware

`cache-plugin` and `cloudflare-plugin`'s `cacheApiMiddleware` now key on the resolved locale and
tenant, read when the cache middleware runs. A GLOBAL cache middleware must therefore run after the
locale (and tenancy) middleware — give it a higher priority number — and a per-request locale
override must happen before the lookup. Existing cached entries simply miss once.

### Rename Vault secrets that relied on a literal `%`, `?` or `#`

Each `/`-separated segment of a Vault secret name is now percent-encoded, and a name with an empty,
`.` or `..` segment is refused. A name that relied on a literal `%`, `?` or `#` reaching Vault
unencoded now reads a different path; rename those secrets. `connect()` also refuses an address that
is not an absolute `http:`/`https:` URL.

### Set `retry.maxRetryAfterMs` if a server's `Retry-After` may exceed the default cap

Generated and hand-built SDK clients now cap how long an honoured `Retry-After` may make them wait,
and surface the original error at once when the hint exceeds the cap. Raise `retry.maxRetryAfterMs`
where longer server-directed waits are acceptable. Client construction also refuses non-finite or
invalid retry counts and delays.

### Import `hono`, not `@hono/hono`, in views and templates

`@setu-ts/view-plugin` now depends on the npm package `hono`; `@hono/hono` is the JSR name and does
not exist on npm. Rewrite `@hono/hono/html` and `@hono/hono/jsx` imports as `hono/html` and
`hono/jsx`, set `jsxImportSource` to `hono/jsx`, and install `hono` as a direct dependency
(`npm install hono`, or `deno add npm:hono` on Deno), since your own compiler resolves those paths.

### Repair projects scaffolded by an earlier `setu new`

<!-- version:history -->

Three defects were in generated output, so a project scaffolded before `0.9.0` keeps them until you
copy the fix from a fresh scaffold:

- **Workers:** pin `"wrangler": "~4.148.0"` and `"@cloudflare/workers-types": "^5.20261006.1"` as a
  fresh `setu new --runtime cloudflare-workers` project does (the old pair fails `npm install` with
  `ERESOLVE`), and replace `src/index.ts`'s single memoized application with the per-`env` cache the
  new entry carries, so a bindings-only deploy is picked up.
- **Full-stack on Node or Bun:** run the build before production start. Use start:dev for
  development; see the M120 production scripts above.
- **Generated guards:** `setu generate guard <name>` now emits `requirePermission('<name>')`, which
  answers `501` unless `AuthPlugin` is registered with an `rbac` option. A guard generated earlier
  is unchanged.

<!-- version:history -->

## 0.8.0

The two `app.inject()` changes below are silent — they compile, so the compiler will not point at
them. Neither affects a served request.

### Check a test that asserts no `content-type` for a `Blob` body

`inject()` now defaults the request's content type from a non-empty `Blob.type`, which is what the
platform already does for `new Request(url, { body: blob })`. Before, a `Blob` was treated as bare
bytes and contributed nothing, so an injected multipart upload answered `500` with an error claiming
the body was not multipart — while the same bytes through `app.fetch` answered `200`.

Nothing to do if you pass an untyped `Blob`, a `Uint8Array` or an `ArrayBuffer`: those still carry
no default, because bytes alone say nothing about their encoding. Two cases DO change. A test that
asserted the header's absence for a typed `Blob` now sees the type and should assert it instead. And
a route that BRANCHES on the content type now takes the branch the blob declares — if the type does
not describe the bytes, either correct the type or set `headers['content-type']` explicitly, which
still wins over the default.

### Stop catching the eleven storage provider methods in a synchronous `try`/`catch`

`@setu-ts/storage-plugin`'s cloud providers guard every operation with a connection check that
throws. Ten of the methods — `S3Provider` `get`/`delete`/`exists`/`getSignedUrl`/`getStream`,
`GcsProvider` `put`/`getStream`, and `AzureBlobProvider` `delete`/`exists`/`getSignedUrl` — are
typed `Promise<...>` but were not `async`, so that throw escaped **synchronously**:
`provider.get('k').catch(handleIt)` never ran, and the error was uncaught instead of handled. The
methods are now `async`, so the "not connected" precondition arrives as a REJECTION, matching the
`IStorage` contract and the providers' own `async` methods (which always rejected).
`AzureBlobProvider.getSignedUrl`'s second refusal — the resolved client has no account key to sign
with — rejects for the same reason.

`LocalStorageProvider.getSignedUrl` is the eleventh. Its refusal is permanent rather than a
lifecycle precondition — local storage cannot presign at all — but it escaped the same way, and it
escaped further: `StorageService.getSignedUrl` passes the provider's promise straight through
without awaiting it, so the throw came out of the `IStorage` you resolve from
`CAPABILITIES.STORAGE`, not just out of the provider class. If you configured
`StoragePlugin({ provider: 'local' })` and called `storage.getSignedUrl(...).catch(...)`, the
`catch` never ran. It now rejects with the same message.

If you pass your OWN provider to the exported `StorageService`, its `delete`, `exists` and
`getSignedUrl` used to hand your provider's promise straight back without awaiting it, so a
synchronous throw from your provider escaped `IStorage` too. They are now `async`. Nothing changes
for the five built-in providers, which all return promises.

No source change is needed in either case, but the two differ in what they observe. An `await`
caller sees exactly what it saw before: the operand is evaluated inside the surrounding
`try`/`catch`, so a synchronous throw and a rejection were already caught the same way. A `.catch()`
caller sees a real difference, and it is the point of the fix — `provider.get('k').catch(handleIt)`
evaluated `provider.get('k')` BEFORE `.catch` was attached, so the throw escaped and `handleIt`
never ran; now the promise rejects and `handleIt` runs.

What does need a source change is code that wrapped one of the eleven calls in a synchronous
`try`/`catch` without awaiting — `try { const p = provider.get(k); } catch { … }` — which now never
catches, because the throw no longer happens at the call. Move the handling onto the promise:
`await` the call inside an `async` function with a `try`/`catch` around the `await`, or attach
`.catch(...)`.

### Stop relying on `inject()` mutating a `Headers` instance you passed

`inject()` used to write its content-type default onto the caller's own object when
`InjectRequest.headers` was a `Headers` rather than a plain record. Reusing one instance across two
requests — the ordinary way to hoist a shared auth header into a fixture — therefore carried the
first request's content type into the second, where it suppressed the correct default: a
`URLSearchParams` body following a JSON body arrived as JSON. The default is now written onto a
copy.

Nothing to do in the normal case, and a test that was silently getting the wrong content type starts
getting the right one. The one thing to change is code that READ the header back off its own
`Headers` object after calling `inject()`, expecting to find what `inject()` had put there. That
object is now untouched, and `InjectResponse.headers` is no substitute — those are the RESPONSE
headers. Either set the request's `content-type` explicitly, in which case it is both what you
passed and what the handler sees, or read `ctx.request.headers` inside the handler and report it.

<!-- version:history -->

### Create a new application instead of retrying a failed `start()`

If your code catches a rejected `app.start()` and calls `start()` again on the same application,
that retry now works only when the failure came before any plugin ran `register()` — plugin
resolution: a missing runtime provider, an unsatisfied dependency, a dependency cycle. Once
registration has begun, a second `start()` throws
`Cannot retry start() after plugins have registered … Create a new application instead.`

Most such retries already failed, with the misleading `Capability 'runtime' is already registered`.
One case used to succeed and is now refused: the first plugin to run threw before writing any state,
such as a runtime provider rejecting its options. In every case, rebuild the application (call your
`createApp()` again) and start that one.

### Remove hand-added global `authMiddleware()` calls

`AuthPlugin` now registers `authMiddleware()` globally at priority 300. Remove any existing global
`app.middleware.add(authMiddleware(), ...)` call; leaving it in place remains correct but executes
every passive strategy twice. If the old application deliberately attached authentication only to
selected routes, configure `middleware: false` and keep those route-level copies.

The `jwt` option is now optional. A configuration must still supply at least one passive request
strategy through `jwt`, `apiKey`, `session`, or `strategies`; `local` alone only verifies login
credentials and is refused at startup.

### Add `pending()` to a hand-written `IAuthSessionService`, and handle the new sign-in outcome

`IAuthSessionService` (`@setu-ts/common`) gains a REQUIRED member,
`pending(ctx): PendingSignIn | null`, so a class or object literal implementing the interface by
hand no longer type-checks. Add the member; a service that never holds a sign-in back can return
`null`. Applications that only consume the service `AuthPlugin` registers have nothing to add.

`SignInOutcome` also widens from one arm to two: `signIn` now resolves
`{ status: 'second-factor-required' }` when `signIn.mfa.required` answers `true`. Code that treated
every resolved `signIn` as a completed sign-in must branch on `status` — on that arm the session
holds a pending record, not the principal, so `requireAuth()` routes stay closed until the second
factor is completed through `TotpService.completeSignIn`. Without an `mfa` option the second arm is
never produced.

<!-- version:history -->

## 0.7.0

### Regenerate your client if you adopt `@HttpCode` or `@Redirect`

Nothing changes if you change nothing: `@setu-ts/decorator-plugin` gains `@HttpCode`,
`@ResponseHeader` and `@Redirect`, and `@setu-ts/openapi-plugin` gains `deriveResponseStatus`
(default `true`) — but the brand the derivation reads is new surface, so no handler written before
this release carries one and an untouched application produces a byte-identical document.

What DOES change the document is adopting the decorator, and that is the point of it. A route that
gains `@HttpCode(201)` is documented under `201` instead of the assumed `200`, so a client generated
from that document types its success body under `201` — a compile-time break for a call site reading
the success body under the old key, and the fix is to regenerate the client and read the new one.
Declaring `schema.response` (or `@ApiResponse`) still wins over the derivation, and
`OpenApiPlugin({ deriveResponseStatus: false })` restores the assumed `200` for every branded route.

Adopting the decorators also moves several checks from "never" to **startup**. `@HttpCode` takes an
integer in `[200, 599]`; `@Redirect` takes one in `[300, 399]` plus a non-blank target the runtime
will carry as a `Location` header; a header name and value must be ones the runtime accepts and the
same header name may not be declared twice; and one handler may not carry both `@HttpCode` and
`@Redirect`, because both set the status. Each refusal names the controller, the method and the
value. There is nothing to migrate — no released code can trip these — but a `register()` that
suddenly refuses is the decorator you just added, not a regression.

### Stop reading a multipart field named `unknown`

A multipart part whose `Content-Disposition` carries no `name` parameter is now DROPPED, where it
used to be delivered as a real field literally named `unknown` — colliding with any legitimate field
of that name. An EMPTY value in either spelling — `name=""` or `name=` — is still a field, with an
empty name. If you read a form field named `unknown`, you were reading parts no correct client sends
(the platform discards them); read the part's real name now. In exchange, a part your client sends
with the unquoted form — `name=x` rather than `name="x"` — now arrives under its REAL name instead
of `unknown`, and an upload sent with an unquoted `filename=a.txt` now reaches `getUploadedFile()`
instead of arriving as a text field. The full table of accepted spellings is pinned by
`packages/common/test/unit/form/multipart-platform-parity.test.ts`.

### Drop the cast around an injected `MongoClient`

`IMongoClient` (the `DatabasePlugin({ type: 'mongodb' })` injection seam) now admits the real
`mongodb` driver structurally: `connect()` returns `Promise<unknown>` because the driver's
`connect(): Promise<this>` is not assignable to `Promise<void>`. An application that wrote
`new MongoClient(url) as unknown as IMongoClient` to satisfy the option can now assign directly —
and the compile-time fixture `packages/database-plugin/test/types/mongo-seam.assert.ts` fails the
build if the seam drifts from the driver again.

### `inject()` refuses non-plain-object bodies (JavaScript callers)

`app.inject()` used to JSON-stringify whatever body it was handed; it now carries the documented
shapes verbatim (`Uint8Array`, `ArrayBuffer`, `Blob`, `URLSearchParams`, plain object, string) and
REFUSES every other shape with a `TypeError` naming the received type. TypeScript callers are
compile-checked; a JavaScript caller passing an array, `Date`, class instance or number must convert
first — arrays and plain data to a plain object, `Date` to a string or number, binary data to
`Uint8Array`. A byte body now also sets NO default content type, so an injected multipart test
request must pass its own `multipart/form-data; boundary=…` header, exactly as a served request
does.

<!-- version:history -->

### Check any view component you copied from the `0.6.0` docs

`@setu-ts/view-plugin`'s README and `docs/migration-nestjs.md` showed the class-based example with a
PLAIN template literal:

```typescript
// DO NOT USE — a plain template literal is a `string`, so nothing escapes it.
const UserList = (props: { readonly users: readonly string[] }) =>
  `<ul>${props.users.map((user) => `<li>${user}</li>`).join('')}</ul>`;
```

Escaping belongs to the rendering runtime, and a component that is already a `string` is returned
unchanged — so any value reaching it is written to the page verbatim. With a user-supplied name of
`<script>alert(1)</script>` that example emits the script tag, where JSX and hono's `html` tag both
emit `&lt;script&gt;`.

<!-- version:history -->

Nothing in the plugin changed and no version is affected — the engine always behaved this way. What
changed is the documentation. If you copied that shape, switch to either escaping form. The
`@hono/hono` import below is the JSR name earlier releases used; on npm write `hono/html` instead
(see "Import `hono`, not `@hono/hono`" under 0.9.0):

```tsx
// JSX — what `ViewPlugin()` selects with no options.
const UserList = (props: { readonly users: readonly string[] }) => (
  <ul>{props.users.map((user) => <li>{user}</li>)}</ul>
);
```

```typescript
// Or hono's `html` tag, for a project with no JSX toolchain.
import { html } from '@hono/hono/html';

const UserList = (props: { readonly users: readonly string[] }) =>
  html`<ul>${props.users.map((user) => html`<li>${user}</li>`)}</ul>`;
```

`raw()` remains the documented opt-out when you genuinely intend to emit trusted markup.

<!-- version:history -->

## 0.6.0

One change fails `deno check`, and only for a hand-written stand-in. Two change behaviour silently —
they compile, so the compiler will not point at them: check whether you upload files without a
`filename`, and whether anything reads a `415` response body.

### Check uploads posted without a `filename`

`@setu-ts/storage-plugin`'s `createUploadMiddleware` now delivers only the parts that declared a
`filename`, because it reads the request through M94b's shared form accessor and a part with no
`filename` is a plain form value in the web standard's terms. It used to report such a part as an
`UploadedFile` whose `filename` fell back to the field name.

**A browser file input always sends a `filename`, even an empty one for an empty input, so ordinary
uploads are unaffected** — and `filename=""` still arrives as a file. What changes is a non-browser
client (a hand-built `curl -F`, an SDK, a test fixture) posting a plain value under the upload field
name: `getUploadedFile(ctx)` now returns `undefined` for it, with no error and no log line.

Two ways forward, depending on what the part actually is:

```typescript
// It is a file: have the client declare a filename on the part.
//   Content-Disposition: form-data; name="file"; filename="report.csv"

// It is a plain field: read it as one, which is now possible on any request.
const form = await ctx.request.formData!();
const note = form.get('note'); // string | FormFile | undefined
if (typeof note === 'string') { /* … */ }
```

Relatedly, a `multipart/form-data` content-type carrying no `boundary=` now passes through the
upload middleware unparsed instead of being answered `400`: it cannot be parsed as a form at all, so
the shared classifier treats it as not-a-form. A handler that calls `formData()` on such a request
gets a `415`.

### A `415` response body's title changed under the Problem Details formats

`@setu-ts/exceptions` had no `STATUS_TITLES` row for `415`, so a `415` served through
`errorHandler({ format: 'rfc9457' })` (or `'rfc7807'`) carried `"title": "Error"`. It now carries
`"title": "Unsupported Media Type"`, matching what the same error already reported as `"message"`
under the `'default'` format. No action is needed unless something asserts or branches on that
string — a contract test with a recorded fixture, or a client mapping titles to messages.

### Add `unregister` to a hand-written `IKernelApplication`

`@setu-ts/kernel`'s `IKernelApplication` gained a required `unregister(name: string): boolean`,
which removes every pending plugin carrying that name before `start()` and throws once startup has
begun, plus a required `hasPlugin(name: string): boolean` — a pure read reporting whether such a
plugin is pending. It exists because overriding a capability is a _post-hoc_ substitution: by the
time an override replaces a service, the real plugin's `register()` has already run, so an eager
side effect inside it — `DatabasePlugin` calls `adapter.connect()` there — has already happened.
Only removing the plugin prevents that.

`createApplication` and all three starters return an implementation, so callers are unaffected. If
you wrote your own stand-in:

```typescript
// TS2741 Property 'unregister' is missing in type '…' but required in type 'IKernelApplication'.
const app: IKernelApplication = {
  // …router, middleware, services, register, start, stop, fetch, inject…
  unregister: (_name) => false, // see the note below
  hasPlugin: (_name) => false,
};
```

`false` is correct for a stand-in that holds no plugins of its own — there is never one to remove.
It is NOT a complete implementation of the contract: a stand-in that can be started must also throw
once startup has begun, since a plugin that already registered cannot be un-run.

The intended caller is `@setu-ts/testing`:

```typescript
import { createTestApp, overrideCapability } from '@setu-ts/testing';
import { CAPABILITIES } from '@setu-ts/common';
import { createApp } from '../setu.config.ts';

const app = await createTestApp({
  app: createApp(), // the composition production uses
  without: ['database'], // never connects
  overrides: [overrideCapability(CAPABILITIES.MAIL, fakeMailer)],
});
```

Nothing about existing tests changes: `createTestApp({ plugins: [...] })` behaves exactly as it did.

<!-- version:history -->

## 0.5.0

<!-- version:history -->

0.5.0 is a breaking release across several packages. Two changes fail `deno check`; the rest change
a status code, a response body, a Redis key, a consumer-group name or a CLI exit code, and are
listed here because each one can pass a type-checker and fail in production.

### Add `ping()` to an injected `IRedisClient`

`@setu-ts/cache-plugin`'s Redis store gained a reachability probe, so `IRedisClient` gained a
required `ping(): Promise<string>` member. If you pass your own client — the commonest case being a
test double — supply it:

```typescript
// TS2741 Property 'ping' is missing in type '…' but required in type 'IRedisClient'.
const client: IRedisClient = {
  // …get, set, del, exists, scan, quit…
  ping: () => Promise.resolve('PONG'),
};
```

`ioredis` already has it, so an application passing a real client needs no change. The probe treats
a rejection as unreachability rather than an error, so a double that rejects reports
`reachable: false` on `/health` and nothing else.

### Add `rotate` and `revokeFamily` to a custom `RefreshTokenStore`

`@setu-ts/auth-plugin` now revokes a whole credential family when a refresh token is replayed or a
session is logged out, which a store must implement:

```typescript
class MyStore implements RefreshTokenStore {
  // …existing members…

  /**
   * Must be ATOMIC: two concurrent refreshes of one token may not both succeed.
   * `rotated` says whether the presented token was live when `successor` was
   * stored — the loser of a race gets `{ record, rotated: false }`, which the
   * service reads as a replay.
   */
  async rotate(
    jti: string,
    successor: RefreshTokenRecord,
  ): Promise<IRefreshTokenRotation> {/* … */}

  /** Revokes the token and every descendant, and RETURNS what it revoked. */
  async revokeFamily(jti: string): Promise<readonly RefreshTokenRecord[]> {/* … */}
}
```

`revokeFamily` returns the records rather than `void` because their `accessTokenJti` values are what
the service revokes alongside them. Your records must also persist the optional lineage fields on
`RefreshTokenRecord` (`familyId`, `accessTokenJti`, `accessTokenExpiresAt`), or `revokeFamily` has
no chain to walk and a replayed token revokes only itself. `MemoryRefreshTokenStore` implements both
and is the in-repo reference.

Policy refusals also stopped disclosing the required role or permission: a `403` now reads
`Insufficient privileges`. Update tests asserting the old detail.

### Errors that were `500` now carry their real status

Every condition below is one a caller caused, or one a caller can retry, and all of them were
reaching clients as a masked `500`. They now answer honestly. Nothing about **your** code has to
change for these to be correct — but a `catch` or a test matching `500` will stop matching:

| Condition                                                              | Was | Now   |
| ---------------------------------------------------------------------- | --- | ----- |
| A malformed JSON request body (`IRequest.json()`)                      | 500 | `400` |
| A backend serialization conflict (`SerializationConflictError`)        | 500 | `409` |
| A transiently unreachable database (`DatabaseUnavailableError`)        | 500 | `503` |
| Bulkhead full / circuit open (`BulkheadFullError`, `CircuitOpenError`) | 500 | `503` |
| A resilience timeout (`TimeoutError`)                                  | 500 | `504` |
| A write to a read-only secret provider (`ReadOnlySecretProviderError`) | 500 | `501` |
| Memory-adapter raw SQL and `migrate()`                                 | 500 | `501` |

`instanceof SerializationConflictError` is the retry signal for optimistic concurrency, which the
masked `500` made unusable. None of these carries `Retry-After`.

One is also a call-shape change: `DatabaseService.query()` on the memory adapter used to throw
**synchronously** from a method typed `Promise`, so a caller using `.catch()` never saw it. It
rejects now. A synchronous `try`/`catch` around an un-awaited `query()` no longer catches — `await`
it, or use `.catch()`.

### The rate limiter's `429` body and Redis keys both change

`@setu-ts/auth-plugin`'s `rateLimitMiddleware` wrote its own `{ error, message }` body, ignoring
`errorHandler`'s configured format. It now answers in that format like every other refusal, so a
client reading `body.message` should read `body.detail` (or `body.details.detail` under
`format: 'default'`). The `Retry-After` and `RateLimit-*` headers are unchanged.

It also stopped refusing the operational probes. `exclude` now defaults to `/live`, `/ready`,
`/health`, `/metrics`, `/openapi.json` and `/docs` — an exhausted limiter used to answer `/live`
with `429`, which a kubelet reads as a failed liveness probe and restarts a container whose only
fault was load. A caller list **replaces** the defaults, so spread
`DEFAULT_RATE_LIMIT_EXCLUDED_PATHS` to extend them, or pass `exclude: []` for the previous
behaviour.

Finally, `RedisRateLimitStore` now namespaces its keys under `DEFAULT_RATE_LIMIT_KEY_PREFIX`
(`'setu:ratelimit:'`). Two applications sharing one managed Redis were previously counting against
each other's budget. In-flight counters under the old keys are orphaned but TTL-bounded, so the
blast radius is one window; pass `keyPrefix: ''` for the previous keys byte for byte.

### Kafka's shared `messaging-consumers` group is derived per topic

A subscription with no `queue` used to join one shared `messaging-consumers` group. Members of a
Kafka consumer group must subscribe the same topics, so an application subscribing two topics ended
with empty assignments and **no delivery at all**. The group is now `<defaultQueue>:<topic>`. If you
have tooling, dashboards or ACLs keyed on the literal `messaging-consumers`, repoint them at the
derived names. A caller-supplied `queue` still names the group itself and is unaffected.

### `CAPABILITIES.LOGGER` resolves to a wrapper

The registered `ILogger` is now a trace-enriching decorator around your configured transport, so
`logger instanceof ConsoleLogger` no longer holds. Every `ILogger` method behaves identically and
`level` passes through. Branch on behaviour or on your own configuration instead — `ILogger` is the
contract and the concrete class never was.

### The `setu` CLI refuses unknown flags, and bare `setu generate` exits 0

`setu` collected every flag and positional and consulted neither, so `setu new app --templat rest`
scaffolded the **minimal** project and reported success. Unknown flags and extra positionals now
exit `2` with nothing written. In the other direction, bare `setu generate` now exits `0` and lists
the schematics, where it printed the same guidance and exited `2`. A script branching on either exit
code needs updating; a script passing a stray flag was already misbehaving silently.

### Health indicators run concurrently under `indicatorTimeoutMs`

`/health` used to await each selected indicator in registration order, so a 2-second outage across
six dependency indicators held the endpoint for 12+ seconds and one never-settling indicator held it
forever. Indicators now run concurrently under `HealthPluginOptions.indicatorTimeoutMs` (default
5,000). Report shape and key order are unchanged; a timeout records
`{ status: 'down', data: { reason: 'timeout' } }`. If a test asserted wall-clock interleaving
between two indicators, assert on the report instead.

<!-- version:history -->

## 0.2.0

### Add `findPage` to a hand-written `IRepository`

<!-- version:history -->

`IRepository` gained a **required** `findPage(options: PageOptions): Promise<Page<Entity>>` member
in 0.2.0 (keyset cursor pagination). The `IDataSource.findPage?` the CHANGELOG's Added entry
describes is optional — a different type. If you implement `IRepository` by hand rather than
extending `BaseRepository` — the commonest case being a test double — you must now supply it:

<!-- version:history -->

```typescript
// Before — compiles until 0.2.0, then:
// TS2741 Property 'findPage' is missing in type '…' but required in type 'IRepository<UserRow, string>'.
class UserRepo implements IRepository<UserRow, string> {
  // …findById, findAll, findOne, create, update, delete, exists, count…
}

// After — the member is required on the interface.
class UserRepo implements IRepository<UserRow, string> {
  // …
  async findPage(options: PageOptions): Promise<Page<UserRow>> {
    // `nextCursor` is non-null IF AND ONLY IF the page is non-terminal, and is
    // never derived from `rows.length`: a page that returns exactly `limit`
    // rows may still be the last one. The row-based mechanism is to fetch one
    // more row than asked for and let the extra row be the signal.
    const limit = options.limit ?? 50;
    const rows = await this.load({ ...options, limit: limit + 1 });
    return rows.length > limit
      ? { rows: rows.slice(0, limit), nextCursor: this.cursorAfter(rows[limit - 1]) }
      : { rows, nextCursor: null };
  }
}
```

`load` and `cursorAfter` above stand for your own storage and sort key — the block is a **sketch of
the member**, not a file that compiles on its own, which is also why the class body is elided. For
one that does compile, and is type-checked and tested on every run, the in-repo reference
implementation is
[`repository-implementor.ts`](../packages/database-plugin/test/fixtures/repository-implementor.ts),
a hand-written `IRepository` that doubles as a compile-time tripwire: adding a required member to
the interface without updating it fails `deno check`.

<!-- version:history -->

## 0.1.0-alpha.10

### Remove `experimentalDecorators` from your own manifest

The decorator surface moved to TC39 standard decorators and the legacy form was removed. The
framework removed the option from all of **its own** declaration sites — that part is done for you.
What the release entry does not do for you: a project scaffolded by an earlier CLI still carries
`"compilerOptions": { "experimentalDecorators": true }` in its own `deno.json` (or the equivalent in
a generated Node `tsconfig.json`), and a migrated project that keeps it compiles its decorators
under the **legacy** semantics and fails `deno check` with `TS1238`/`TS1241` on every decorated
member.

The errors point at the decorators, not the option, which is exactly why this step needs to be
written down:

```text
TS1238  Unable to resolve signature of class decorator when called as an expression.
        The runtime will invoke the decorator with 1 arguments, but the decorator expects 2.
TS1241  Unable to resolve signature of method decorator when called as an expression.
```

Remove **that one key** from your project's manifest. Leave the rest of your `compilerOptions`
alone: Deno applies its own defaults to every option you do not specify, so declaring one option
does not disturb the others (measured on Deno 2.9.6 — a manifest declaring only
`experimentalDecorators` still type-checks under `strict`). If `experimentalDecorators` was the only
option you had, the whole `compilerOptions` object can go.

<!-- version:history -->

## 0.1.0-alpha.8

### Add `findOne` to a hand-written `IRepository`

The same class of change as `findPage` above, two releases earlier: `IRepository` gained a required
`findOne` member. A class implementing `IRepository` without extending `BaseRepository` must now
implement `findOne`.
