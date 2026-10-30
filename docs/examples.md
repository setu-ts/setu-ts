# Examples

The [`apps/`](../apps/) directory holds seventeen runnable applications. Each example teaches one
concept, and its `smoke.ts` proves it. Follow the learning path below, then use the deep dives to
connect each file to the behavior it implements.

## Before you start

To start a project from an example without cloning the repository:

```bash
npm create @setu-ts my-app -- --example rest-api
cd my-app && npm install
npm run smoke   # the example's own proof; exits when done
npm start       # serves until stopped
```

`--example` creates a standalone Node project, fetching the example from the GitHub release tag
matching the CLI version. GitHub must be reachable when scaffolding; `--dry-run` only lists paths
and fetches nothing. Offered examples are `minimal`, `rest-api`, `database`, `di-decorators`,
`cqrs`, `multi-tenant`, `static-site`, `worker-pool`, `graphql-demo`, `grpc`, `microservices` and
`realtime`. The Redis-backed smoke checks can exit `77` when Redis is unavailable. For `full-stack`,
use `--template full-stack`; the other excluded examples need repository scripts or source. See
[the CLI guide](./cli.md#start-from-an-example) for the flag restrictions.

An example is a teaching project, not a production starting point. Some carry fixed demonstration
values: `rest-api` signs and verifies its tokens with the fixed `DEMO_JWT_SECRET` in
`src/auth/demo-token.ts`, so anyone could forge a token for a copy deployed unchanged. Replace such
values with configuration (for example a secret read through `ConfigPlugin`) before deploying.

Install Node 24, then clone and prepare the repository:

```bash
git clone https://github.com/setu-ts/setu-ts.git
cd setu-ts
corepack enable
pnpm install
```

The repository pins pnpm through `packageManager`. These examples run from repository source;
outside the repository, use the `--example` command above or a `--template` scaffold.

## Running an example

```bash
pnpm --dir apps/minimal run start 3400  # pick an app and a port
pnpm --dir apps/minimal run smoke       # run its proof
```

Every app is a private pnpm workspace member. Its `package.json` uses `workspace:^` dependencies and
its generated `tsconfig.json` maps framework imports to repository source. The scripts run with
`tsx`, so an example exercises the current code.

Most apps listen on port `3000` unless you pass a port, but three do not: `graphql-demo` defaults to
`4000`, `grpc` to `5000`, and `static-site` to `8000`. Three apps' `start` scripts do not serve:
`cqrs` and `microservices` print a result and exit, and `cloudflare`'s prints how to run the Worker
with Wrangler.

## How every example is laid out

Each example has the layout `setu new` scaffolds, so the shape to copy is the shape the CLI gives
you:

```text
apps/<name>/
  setu.config.ts          createApp(): the plugin composition, without starting it
  main.ts                 starts createApp() on a port and stops it cleanly on SIGTERM
  src/modules/<feature>/  one folder per feature: <feature>.routes.ts, .service.ts, .schemas.ts
  smoke.ts                proves the example's claim with node:test against createApp()
```

`setu.config.ts` composes and does not start, so `main.ts` and `smoke.ts` run the same application.
The smoke check starts it with no port and drives it with `app.inject()`, so most proofs need no
socket. This is `minimal`'s factory and smoke check, joined into one listing:

```typescript
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

// setu.config.ts — builds the application and does not start it.
export function createApp(): IKernelApplication {
  const app = createApplication({ plugins: [RuntimePlugin()] });
  app.router.get('/', (ctx) => ctx.response.json({ hello: 'world' }));
  return app;
}

// smoke.ts — starts it with no port, so nothing binds a socket.
describe('minimal example', () => {
  let app: IKernelApplication;

  before(async () => {
    app = createApp();
    await app.start();
  });

  after(async () => {
    await app.stop();
  });

  it('answers GET / with a greeting', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { hello: 'world' });
  });
});
```

`main.ts` adds the port and the `SIGTERM` handling that lets `app.stop()` run on shutdown; see
[`apps/minimal/main.ts`](../apps/minimal/main.ts) and
[Getting Started — Stopping Cleanly](./getting-started.md#stopping-cleanly).

A few examples differ, and say why: `cloudflare` adds the Worker entry `worker.ts`,
`compiled-binary` adds the CommonJS entry `sea.ts` its executable is built from, `realtime-clients`
adds a client driver that runs on several runtimes and a `worker.ts` that hosts it on workerd, and
`microservices` composes two services, so it has one factory per service under `src/service-a/` and
`src/service-b/`. `full-stack` keeps the React Router layout `setu new --template full-stack`
scaffolds — `app/routes`, `app/features`, `app/services` — and reads its port from `PORT`, as that
template does.

## A learning path

| Step | Example                                          | Concept                                                    | Needs                                   |
| ---- | ------------------------------------------------ | ---------------------------------------------------------- | --------------------------------------- |
| 1    | [minimal](../apps/minimal)                       | Compose a kernel, runtime and one route                    | —                                       |
| 2    | [rest-api](../apps/rest-api)                     | Build an authenticated, validated API described by OpenAPI | —                                       |
| 3    | [database](../apps/database)                     | Use repositories and verify transaction rollback           | —                                       |
| 4    | [di-decorators](../apps/di-decorators)           | Inject decorated services and compare request lifetimes    | —                                       |
| 5    | [cqrs](../apps/cqrs)                             | Write through a command bus and read through a query bus   | —                                       |
| 6    | [multi-tenant](../apps/multi-tenant)             | Isolate request data by tenant                             | —                                       |
| 7    | [plugin-development](../apps/plugin-development) | Register and resolve a custom plugin capability            | —                                       |
| 8    | [graphql-demo](../apps/graphql-demo)             | Compose a schema-first GraphQL API                         | —                                       |
| 9    | [grpc](../apps/grpc)                             | Serve descriptor-backed RPC and HTTP on one port           | —                                       |
| 10   | [static-site](../apps/static-site)               | Serve static files with caching, ETags and byte ranges     | —                                       |
| 11   | [worker-pool](../apps/worker-pool)               | Offload CPU work and share worker buffers                  | —                                       |
| 12   | [full-stack](../apps/full-stack)                 | Pass framework services into SSR loaders and form actions  | Node 24 and pnpm                        |
| 13   | [realtime](../apps/realtime)                     | Deliver SSE messages across replicas                       | Redis                                   |
| 14   | [microservices](../apps/microservices)           | Discover an HTTP service, then call it through a broker    | Redis for the second half               |
| 15   | [realtime-clients](../apps/realtime-clients)     | Resume authenticated SSE and keep WebSockets alive         | Node, Bun and Wrangler (fetched by npx) |
| 16   | [cloudflare](../apps/cloudflare)                 | Wire KV, scheduled work and queue messaging on workerd     | Wrangler                                |
| 17   | [compiled-binary](../apps/compiled-binary)       | Package a health application as a Node single executable   | —                                       |

## Example deep dives

### minimal

**Concept.** Compose an application from the kernel and runtime, then register a handler on its
router. The factory returns the unstarted app, so a server entry and an injected smoke check can
reuse the same composition.

The kernel and the runtime plugin, and one route. Nothing else is registered, so there is no
`/health` here; the [rest-api](#rest-api) example has one.

```bash
pnpm --dir apps/minimal run start 3400
curl localhost:3400/            # {"hello":"world"}
```

**Read, in order:**

- [`setu.config.ts`](../apps/minimal/setu.config.ts) — createApp registers RuntimePlugin and the
  greeting route, then returns without starting the application.

---

### rest-api

**Concept.** Combine authentication, body validation and response metadata on a todo route. The same
validated input drives the write, and an authenticated read checks the stored result; OpenAPI
describes the operations alongside them.

A todo API composed with `createRestApp` from `@setu-ts/rest-starter`, with the starter's `auth`
option turned on and its always-on OpenAPI configured with a bearer scheme. Both routes carry
`requireAuth()`, so an unauthenticated write answers `401` in RFC 9457 Problem Details form. The
starter also brings health, metrics, security headers and the error handler.

```bash
pnpm --dir apps/rest-api run start 3400
curl localhost:3400/health                                    # 200
curl -X POST localhost:3400/todos -H 'content-type: application/json' -d '{"title":"x"}'          # 401 Problem Details
# Swagger UI at http://localhost:3400/docs, the document at /openapi.json
```

The write route validates its body with `validateBody(...)`, which also documents it for OpenAPI
(see [Pipelines (Validation)](./migration-nestjs.md#pipelines-validation)), and a todo that does not
exist answers a Problem Details `404`. The smoke check issues a token through `issueDemoToken` and
reads the written todo back.

**Read, in order:**

- [`src/modules/todos/`](../apps/rest-api/src/modules/todos/) — registerTodosRoutes puts requireAuth
  before the bound createBody validator and reads that validator's value when creating a todo.
- [`setu.config.ts`](../apps/rest-api/setu.config.ts) — createApp turns on the REST starter's auth,
  configures its OpenAPI document and registers the feature routes.
- [`smoke.ts`](../apps/rest-api/smoke.ts) — issueDemoToken supplies the bearer credential; the
  write/read assertion compares the returned todo, and the document checks enumerate the todo paths.

---

### di-decorators

**Concept.** Declare a controller's dependencies with decorators and compare service lifetimes
within a request. Constructor injection supplies the greeting service, while parameter injection and
the request scope resolve the same scoped instance during one request.

A `@Controller` class whose constructor receives an `@Injectable` service through
`@Inject(GREETING_SERVICE)`, with `DiPlugin` providing the container; each feature is a `@Module`. A
second controller shows the per-request scope: `GET /lifetimes` resolves a scoped service through
`@Params(Service(...))` and `container.forRequest(ctx)`, and two requests receive different
instances: call it twice and compare `scopedId`, which differs on every request.

```bash
pnpm --dir apps/di-decorators run start 3400
curl localhost:3400/greetings   # {"greeting":"Hello, decorators!"}
curl localhost:3400/lifetimes   # {"singletonShared":true,"scopeRetainsInstance":true,"scopedId":"<uuid>"}
curl localhost:3400/lifetimes   # same flags, a different scopedId
```

**Read, in order:**

- [`src/modules/greeting/`](../apps/di-decorators/src/modules/greeting/) — GreetingController
  injects GREETING_SERVICE by constructor position; GreetingService registers that token with
  Injectable and formats the greeting.
- [`src/modules/lifetimes/`](../apps/di-decorators/src/modules/lifetimes/) —
  LifetimesController.report compares parameter-injected instances with container.forRequest(ctx);
  ScopedReportService gets its id from the runtime, making the request's instance visible in the
  response.

See also [Decorators — Scoped Injection](./decorators.md#scoped-injection).

---

### database

**Concept.** Keep data access behind a repository resolved from the database capability. Writes,
updates and transaction rollback can then be checked by reading the data back, rather than trusting
a successful write response.

`DatabasePlugin` on the in-memory adapter, behind a `notes` repository: create, read, update, and a
transaction that is rolled back.

```bash
pnpm --dir apps/database run start 3400
curl -X POST localhost:3400/notes -H 'content-type: application/json' -d '{"id":"1","text":"hello"}'   # 201
curl localhost:3400/notes/1                                       # {"id":"1","text":"hello"}
curl -X PATCH localhost:3400/notes/1 -H 'content-type: application/json' -d '{"text":"updated"}'
```

The memory adapter is for development and tests; the same repository code runs against PostgreSQL
through Drizzle or Prisma, or MongoDB and the other adapters. See
[`@setu-ts/database-plugin`](./plugins.md#setu-tsdatabase-plugin).

**Read, in order:**

- [`src/modules/notes/`](../apps/database/src/modules/notes/) — notesRepository resolves the notes
  repository from the database service; registerNotesRoutes uses it for create, findById and update.
- [`smoke.ts`](../apps/database/smoke.ts) — The database.transaction callback throws after creating
  a note; the count afterward must equal the count before, alongside write/read and update/read
  checks.

---

### cqrs

**Concept.** Separate a mutation's command handler from the query that reads its result. Both
handlers share one feature store; the command handler's factory resolves the runtime clock, while
the query handler needs no capability.

`CqrsPlugin` with one command handler and one query handler. `pnpm --dir apps/cqrs run start` sends
a command, reads the result through the query bus, prints it and exits; it is not a server. The
command handler is built by a factory that resolves the runtime capability, which is why the printed
note carries a timestamp.

```bash
pnpm --dir apps/cqrs run start
# [ 'CQRS keeps commands and queries separate. @ 1791396240491' ]
```

**Read, in order:**

- [`src/modules/notes/`](../apps/cqrs/src/modules/notes/) — notesHandlers creates the shared store;
  addNoteHandler stamps writes with runtime.now(), and readNotesHandler returns the store through
  the separate query registration.

---

### multi-tenant

**Concept.** Resolve a repository for the current request's tenant instead of selecting a global
store. The header resolver requires a tenant, and both note routes obtain their repository through
that request context.

`MultiTenancyPlugin` resolving the tenant from the `x-tenant-id` header, with `required: true`.
Notes are stored per tenant, and a request with no tenant is refused.

```bash
pnpm --dir apps/multi-tenant run start 3400
curl -X POST localhost:3400/notes -H 'x-tenant-id: acme' -H 'content-type: application/json' -d '{"text":"a"}'   # 201
curl localhost:3400/notes -H 'x-tenant-id: acme'                          # [ the note ]
curl localhost:3400/notes -H 'x-tenant-id: globex'                        # []
curl localhost:3400/notes                                                 # 400 Tenant Required
```

**Read, in order:**

- [`src/modules/notes/`](../apps/multi-tenant/src/modules/notes/) — tenantNotes passes ctx to the
  multi-tenancy service's getRepository; registerNotesRoutes calls it for both create and findAll,
  so each request uses its tenant's notes.

---

### plugin-development

**Concept.** Provide a capability and consume it through the request's service registry. A custom
plugin can register its own service and route together without making the handler depend on the
service implementation.

A complete custom plugin: it registers a service under its own capability token and adds a route
that resolves the service from the request context.

```bash
pnpm --dir apps/plugin-development run start 3400
curl localhost:3400/greet/ada   # {"message":"Hello, ada!"}
pnpm --dir apps/plugin-development run test                  # the plugin's own tests
```

**Read, in order:**

- [`src/plugins/greeting.plugin.ts`](../apps/plugin-development/src/plugins/greeting.plugin.ts) —
  GreetingPlugin declares GREETING in provides, registers an IGreetingService under it, and resolves
  that same token inside the greeting handler.

See [Custom Plugins](./custom-plugins.md).

---

### microservices

**Concept.** Compare two ways of calling another service: resolve its HTTP URL through discovery, or
send a request over a broker. Both paths use the same greeting contract; Redis enables the second
path without changing the HTTP call.

Two applications in one process. Service A finds service B through `ServiceDiscoveryPlugin` and
calls it over HTTP. With `REDIS_URL` set, B also registers a responder on a Redis Streams broker and
A calls it with `broker.request(...)`. `pnpm --dir apps/microservices run start` runs both calls,
prints the answers and exits.

```bash
pnpm --dir apps/microservices run start 3300 3301
# Hello, service-a!
# Set REDIS_URL to demonstrate brokered request/reply between services.
REDIS_URL=redis://127.0.0.1:6379 pnpm --dir apps/microservices run start 3300 3301   # both calls succeed
```

The two arguments are service A's and service B's ports (defaults `3000` and `3001`).

**Read, in order:**

- [`src/greeting.contract.ts`](../apps/microservices/src/greeting.contract.ts) — SERVICE_B names
  discovery, GREETING_TOPIC names broker requests, and greetingFor builds their shared reply shape.
- [`src/service-a/`](../apps/microservices/src/service-a/) — greetOverHttp resolves /hello through
  discovery; greetOverBroker sends a GreetingRequest through the messaging capability instead.
- [`src/service-b/`](../apps/microservices/src/service-b/) — createServiceB registers /hello and
  optional messaging; respondToGreetings registers a responder on the shared topic and answers with
  greetingFor.

---

### realtime

**Concept.** Fan out a named SSE channel across replicas through a Redis backplane. The route opens
a channel connection or publishes to it, while the smoke check uses separate server processes so
shared in-process state cannot satisfy the cross-replica delivery assertion.

Server-Sent Events over `SsePlugin`, fanned out across replicas by `RealtimeBackplanePlugin` with
the `'redis'` transport. `POST /publish` sends to the `news` channel and every replica's
`GET /events` clients receive it. The smoke check starts two replicas as **separate processes**: two
replicas in one process would share the backplane's in-process transport and prove nothing.

```bash
pnpm --dir apps/realtime run start 3400   # REDIS_URL defaults to redis://127.0.0.1:6379
curl -N localhost:3400/events                                    # in one terminal
curl -X POST localhost:3400/publish -H 'content-type: application/json' -d '{"message":"hi"}'        # 204, in another
```

WebSocket rooms are shown in [realtime-clients](#realtime-clients) and in the
[`@setu-ts/websocket-plugin` README](https://github.com/setu-ts/setu-ts/blob/main/packages/websocket-plugin/README.md).

**Read, in order:**

- [`src/modules/news/`](../apps/realtime/src/modules/news/) — registerNewsRoutes adds each /events
  connection to NEWS_CHANNEL and publishes POST /publish messages to that same channel.
- [`smoke.ts`](../apps/realtime/smoke.ts) — startReplica launches each server separately; the
  assertion subscribes on replica B and posts on replica A before waiting for the message.

---

### realtime-clients

**Concept.** Use the SDK's SSE and WebSocket clients against a live server. Reconnection must carry
the last event id and authentication; a read-only WebSocket must survive the server's idle timeout
through keep-alive traffic.

A server with SSE and WebSocket routes, driven by the `@setu-ts/sdk` realtime clients from Node
(with and without type stripping), Bun and workerd: SSE reconnection resumes from the last event id,
authenticated streams send their credentials, and a WebSocket stays alive across the server's
keep-alive. Its smoke check needs Bun installed and runs Wrangler through `npx` (downloaded on first
use); a missing one fails the check rather than skipping it.

**Read, in order:**

- [`setu.config.ts`](../apps/realtime-clients/setu.config.ts) — createApp composes SSE and WebSocket
  plugins with short heartbeat and idle timings, plus the idle-socket plugin used by the driver.
- [`driver.ts`](../apps/realtime-clients/driver.ts) — checkSseClient sends the bearer header and
  compares resumedWith to the first event id; checkIdleSocket waits longer than the idle timeout
  before closing intentionally.
- [`smoke.ts`](../apps/realtime-clients/smoke.ts) — exerciseRealtimeClients runs against a real
  server from the current Node process, type-stripped Node, Bun and a workerd client host.

---

### graphql-demo

**Concept.** Define an API with a schema and resolvers, then configure its transports at composition
time. The books feature keeps resolver state per application; the composition enables subscriptions,
persisted queries and batching alongside ordinary queries.

`GraphqlPlugin` with a schema-first definition (`typeDefs` plus resolvers), subscriptions over both
WebSocket and SSE, automatic persisted queries backed by `CachePlugin`, request batching, and
GraphiQL.

```bash
pnpm --dir apps/graphql-demo run start          # port 4000
curl -X POST localhost:4000/graphql -H 'content-type: application/json' -d '{"query":"{ hello }"}'   # {"data":{"hello":"world"}}
# GraphiQL at http://localhost:4000/graphql in a browser
```

`pnpm --dir apps/graphql-demo run interop` boots its own copy of the app and drives it with the
reference `graphql-ws` client and Apollo's persisted-query link. It is a manual check to run when
changing the GraphQL transports, not part of `check:apps`.

**Read, in order:**

- [`setu.config.ts`](../apps/graphql-demo/setu.config.ts) — createApp supplies typeDefs and a fresh
  createResolvers result to GraphqlPlugin, with WebSocket/SSE subscriptions, a persisted-query cache
  and batching.
- [`src/modules/books/`](../apps/graphql-demo/src/modules/books/) — typeDefs declares queries, a
  mutation and subscriptions; createResolvers owns the books list and notifies bookAdded listeners
  when addBook writes.

---

### grpc

**Concept.** Register a descriptor-backed RPC service beside ordinary HTTP routes. The smoke check
calls the Connect client and the health URL on the same application port, showing where RPC fits
into the server rather than replacing it.

`GrpcPlugin` serving a Connect RPC from an embedded service descriptor on the same port as an
ordinary `GET /health` route. Connect and gRPC-Web clients can call it; native gRPC cannot, because
it needs HTTP/2 trailers a fetch-based server does not send.

```bash
pnpm --dir apps/grpc run start                  # port 5000
curl localhost:5000/health                       # {"status":"ok"}
```

**Read, in order:**

- [`src/modules/echo/`](../apps/grpc/src/modules/echo/) — echoServiceRegistration couples the
  revived ECHO_SERVICE descriptor to echo and ping implementations; the descriptor is embedded, so
  this example does not require a generation step.
- [`smoke.ts`](../apps/grpc/smoke.ts) — createEchoClient sends an RPC to baseUrl, then fetch reads
  /health using that same baseUrl.

---

### cloudflare

**Concept.** Adapt application capabilities to platform invocations instead of a socket listener.
The Worker shares a started application between fetch and queue deliveries, writes scheduled results
to KV, and uses a Durable Object for reply inboxes.

A Worker using `CloudflarePlugin`: a KV namespace, a cron trigger whose `scheduled` handler writes
to KV, and messaging over a Cloudflare queue (a publish in one `fetch` is received by a subscriber
in a separate `queue` invocation), with replies through a Durable Object. Its smoke check bundles
the Worker and runs it on **real workerd** through `wrangler dev`, and checks that `detectRuntime()`
answers `'cloudflare-workers'` there.

```bash
pnpm --dir apps/cloudflare run smoke            # needs `wrangler` on PATH
```

**Read, in order:**

- [`worker.ts`](../apps/cloudflare/worker.ts) — createWorkerHandler shares one startup promise,
  clears failed starts for retry, and supplies the same app to fetch and queue; scheduled writes its
  run count to KV.
- [`wrangler.toml`](../apps/cloudflare/wrangler.toml) — The configuration declares EXAMPLE_KV, the
  MESSAGES producer and consumer, the cron expression and REPLY_INBOX Durable Object binding.

---

### compiled-binary

**Concept.** Keep application composition independent of the executable entry. The same small health
application can be built into a Node single executable, while a CommonJS-compatible entry owns
startup and graceful shutdown.

The same small application compiled into a standalone executable.

```bash
pnpm --dir apps/compiled-binary run build:sea     # writes ./.tmp/compiled-binary/server
./.tmp/compiled-binary/server 3400               # then, in another terminal:
curl localhost:3400/health        # {"status":"ok"}
```

**Read, in order:**

- [`setu.config.ts`](../apps/compiled-binary/setu.config.ts) — createApp registers the runtime and
  /health without starting, keeping the application reusable by the executable.
- [`sea.ts`](../apps/compiled-binary/sea.ts) — main wraps startup in an async function rather than
  top-level await and installs signal handlers that stop the app before exiting.

---

### full-stack

**Concept.** Bridge kernel capabilities into server-rendered route loaders through context keys. The
composition writes session, CSRF, logger and database values into React Router context; the product
loader reads its view through that context, and the smoke check verifies rendered database rows and
a form login.

A React Router 8 framework-mode application composed with `createFullStackAppFromConfig` from
`@setu-ts/full-stack-starter`. Its smoke check writes a row through the database capability, renders
an SSR page that shows it (proving `populateLoadContext` reached the loader), and completes a
`<Form>` login whose CSRF token round-trips through the session plugin.

```bash
pnpm --dir apps/full-stack run start            # builds first, then serves on PORT or 3000
```

`start` runs the React Router / Vite build first using Node and pnpm.

**Read, in order:**

- [`setu.config.ts`](../apps/full-stack/setu.config.ts) — createApp enables SSR, session and the
  memory database; populateLoadContext puts the four context values into the provider on each
  request.
- [`app/routes/`](../apps/full-stack/app/routes/) — The products loader calls
  buildProductsView(context), and ProductsRoute renders the returned rows; the login loader reads
  the CSRF context and its action writes the email into the session.
- [`smoke.ts`](../apps/full-stack/smoke.ts) — seedProducts writes through the database service
  before HTML assertions; the login test carries the session cookie and the rendered CSRF token into
  its form post.

---

### worker-pool

**Concept.** Move CPU-bound work into task modules while the main event loop keeps running. The
smoke check contrasts timer progress during a spin, fair sharing between task modules and a shared
buffer whose writes remain visible to the caller.

CPU-bound task modules sharing one worker slot. The smoke check proves main-thread timers keep
running during a spin, that a second task module is not starved behind a queue of the first, that
worker writes to a `SharedArrayBuffer` are visible to the caller, and that `/health` reports the
budget.

```bash
pnpm --dir apps/worker-pool run start 3400      # loopback-only, http://127.0.0.1:3400/health
pnpm --dir apps/worker-pool run smoke
```

**Read, in order:**

- [`src/tasks/`](../apps/worker-pool/src/tasks/) — defineWorkerTask registers a spin that
  deliberately busy-waits; the fill task writes through a Uint8Array view and returns its length,
  exposing the difference between shared and copied buffers.
- [`smoke.ts`](../apps/worker-pool/smoke.ts) — The describe block asserts a timer ticks during the
  spin, a fill finishes before the spin queue drains, and the shared buffer is inspected in the
  caller after the worker returns.

---

### static-site

**Concept.** Compose static delivery with an application route, then inspect HTTP file semantics.
The example serves a public directory with an SPA fallback; its smoke checks distinguish missing
scripts from browser pages and exercise cache validation and partial downloads.

`StaticPlugin` serving `./public` at the root with an SPA fallback, beside a `GET /health` route.
The smoke check requests the cases that once failed: a `HEAD` that must not open a body, a hashed
asset that keeps its `immutable` policy when the brotli copy is served, conditional requests, and a
resumed download through `Range` and `If-Range`.

```bash
pnpm --dir apps/static-site run start 3400      # the port; defaults to 8000
curl -I localhost:3400/index.html
```

The default port `8000` is also DynamoDB Local's default, so pass another port when that is running.

**Read, in order:**

- [`setu.config.ts`](../apps/static-site/setu.config.ts) — createApp mounts StaticPlugin at / with
  index.html as fallback and adds a concrete /health route.
- [`smoke.ts`](../apps/static-site/smoke.ts) — The get helper drives checks that compare HEAD length
  and body, revalidate to 304, resume with Range/If-Range, and retain the immutable policy on a
  brotli sidecar.

## Smoke checks

A smoke check is a `node:test` file: each `it` asserts one behaviour with `node:assert/strict`, so a
failure reports every check that failed and the values it compared. A check whose external
prerequisite is missing (Redis, Wrangler) prints why and exits with code `77`, which `check:apps`
records as a skip rather than a pass. The skip applies only when every check that could run passed;
a real failure still exits non-zero.

## Running every example

```bash
pnpm run check:apps                                   # from the repository root
REDIS_URL=redis://127.0.0.1:6379 pnpm run check:apps  # include the Redis-backed checks
```

It type-checks each app, runs its `smoke` task and, where one is declared, its `test` task. In CI a
skip fails the job unless the app is in the `ALLOW_SKIP` list; see
[`apps/README.md`](../apps/README.md).

## Contributing an example

1. Create it under `apps/<name>/` with a private `package.json` declaring `start`, `smoke` and
   `check` scripts and a `tsconfig.json` extending `../../tsconfig.apps.json`, laid out as
   [above](#how-every-example-is-laid-out).
2. Make `smoke.ts` assert the behaviour the example exists for, not only that it started.
3. Add it to [`apps/README.md`](../apps/README.md) and to this guide.
4. Run `pnpm run check:apps`, and `pnpm run test:tooling test/apps-layout.test.ts`. The second
   scaffolds projects with this tree's CLI and checks every example against them: the composition
   file and factory, the entry's shutdown handling, the smoke check's test runner, how feature
   folders are named, and how the module index imports and wires them. Where an example cannot
   follow a rule, add it to that test's exceptions with the reason; an exception that stops being
   needed fails the test.

## Next Steps

- [Getting Started](./getting-started.md) - Set up your first application
- [Plugin Architecture](./plugin-architecture.md) - Deep dive into plugins
- [Runtime Deployment](./runtime-deployment.md) - Deploy to production
- [Docker and Kubernetes](./deployment.md) - Containerize and orchestrate an example
