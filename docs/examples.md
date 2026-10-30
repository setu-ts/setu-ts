# Examples

The [`apps/`](../apps/) directory holds seventeen runnable applications. Each one proves a specific
capability, and its `smoke.ts` is the proof: `pnpm run check:apps` type-checks every app and runs
every smoke check, in CI as well as locally. This guide says what each app proves, how to run it,
and which requests to try. The code itself lives in the app, not here, so this page cannot drift
from it.

## Running an example

```bash
pnpm --dir apps/minimal run start 3400  # pick an app and a port
pnpm --dir apps/minimal run smoke       # run its proof
```

Every app is a private pnpm workspace member. Its `package.json` uses `workspace:^` dependencies and
its generated `tsconfig.json` maps framework imports to repository source. The scripts run with
`tsx`, so an example exercises the current code.

Most apps listen on port `3000` unless you pass a port, but three do not: `graphql-demo` defaults to
`4000`, `grpc` to `5000`, and `static-site` to `8000`. Two apps are demonstrations that print a
result and exit rather than servers: `cqrs` and `microservices`.

## How every example is laid out

Each example has the layout of a project after its first `setu g module`, so the shape to copy is
the shape the CLI gives you. A new project starts flat, with its controllers in `src/controllers/`
and its services in `src/services/`; the first module moves them into `src/modules/<feature>/`:

```text
apps/<name>/
  setu.config.ts          createApp(): the plugin composition, without starting it
  main.ts                 starts createApp() on a port and stops it cleanly on SIGTERM
  src/modules/<feature>/  one folder per feature: <feature>.controller.ts, .service.ts, .schemas.ts
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
adds a client driver that runs on several runtimes, and `microservices` composes two services, so it
has one factory per service under `src/service-a/` and `src/service-b/`. `full-stack` keeps the
React Router layout `setu new --template full-stack` scaffolds — `app/routes`, `app/features`,
`app/services` — and reads its port from `PORT`, as that template does.

## Examples by capability

| Example                                          | What its smoke check proves                                                                     | Needs                     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------- |
| [minimal](../apps/minimal)                       | The kernel and the runtime serve one `200` route                                                | —                         |
| [rest-api](../apps/rest-api)                     | An authenticated todo API reads a written todo back and is described by OpenAPI                 | —                         |
| [di-decorators](../apps/di-decorators)           | A decorated controller answers through an injected service; manual scopes distinguish lifetimes | —                         |
| [database](../apps/database)                     | Repository writes read back, updates persist, and a rolled-back transaction changes nothing     | —                         |
| [cqrs](../apps/cqrs)                             | A command's mutation is visible through a separate query bus                                    | —                         |
| [multi-tenant](../apps/multi-tenant)             | A note written under one tenant is invisible to another                                         | —                         |
| [plugin-development](../apps/plugin-development) | A custom plugin registers a capability that its own route resolves                              | —                         |
| [microservices](../apps/microservices)           | Service A discovers and calls service B over HTTP, plus brokered request/reply                  | Redis for the second half |
| [realtime](../apps/realtime)                     | A publish on one replica reaches an SSE client on another, through a Redis backplane            | Redis                     |
| [realtime-clients](../apps/realtime-clients)     | The SDK's SSE resume and auth, and WebSocket keep-alive, against a real server                  | Node and Bun for the run  |
| [graphql-demo](../apps/graphql-demo)             | The GraphQL endpoint answers a basic operation                                                  | —                         |
| [grpc](../apps/grpc)                             | A descriptor-backed Connect RPC and an ordinary HTTP route share one application and one port   | —                         |
| [cloudflare](../apps/cloudflare)                 | KV, a cron trigger, and queue-backed messaging work on real workerd                             | Wrangler                  |
| [compiled-binary](../apps/compiled-binary)       | Node SEA produces a binary that serves `/health`                                                | —                         |
| [full-stack](../apps/full-stack)                 | A server-rendered React Router page shows rows read through the database capability             | Node 24 and pnpm          |
| [worker-pool](../apps/worker-pool)               | CPU work off the event loop, fair sharing of one worker slot, and shared-buffer writes          | —                         |
| [static-site](../apps/static-site)               | Static files are served with cache headers, ETags, conditional requests, and byte ranges        | —                         |

## Example deep dives

### minimal

The kernel and the runtime plugin, and one route. Nothing else is registered, so there is no
`/health` here; the [rest-api](#rest-api) example has one.

```bash
pnpm --dir apps/minimal run start 3400
curl localhost:3400/            # {"hello":"world"}
```

Read: [`setu.config.ts`](../apps/minimal/setu.config.ts).

---

### rest-api

A todo API composed with `createRestApp` from `@setu-ts/rest-starter`, with the starter's `auth` and
`openapi` options turned on. Both routes carry `requireAuth()`, so an unauthenticated write answers
`401` in RFC 9457 Problem Details form. The starter also brings health, metrics, security headers
and the error handler.

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

Read: [`src/modules/todos/`](../apps/rest-api/src/modules/todos),
[`setu.config.ts`](../apps/rest-api/setu.config.ts), [`smoke.ts`](../apps/rest-api/smoke.ts).

---

### di-decorators

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

Read: [`src/modules/greeting/`](../apps/di-decorators/src/modules/greeting),
[`src/modules/lifetimes/`](../apps/di-decorators/src/modules/lifetimes). See also
[Decorators — Scoped Injection](./decorators.md#scoped-injection).

---

### database

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

Read: [`src/modules/notes/`](../apps/database/src/modules/notes),
[`smoke.ts`](../apps/database/smoke.ts).

---

### cqrs

`CqrsPlugin` with one command handler and one query handler. `pnpm --dir apps/cqrs run start` sends
a command, reads the result through the query bus, prints it and exits; it is not a server. The
command handler is built by a factory that resolves the runtime capability, which is why the printed
note carries a timestamp.

```bash
pnpm --dir apps/cqrs run start
# [ "CQRS keeps commands and queries separate. @ 1791396240491" ]
```

Read: [`src/modules/notes/`](../apps/cqrs/src/modules/notes).

---

### multi-tenant

`MultiTenancyPlugin` resolving the tenant from the `x-tenant-id` header, with `required: true`.
Notes are stored per tenant, and a request with no tenant is refused.

```bash
pnpm --dir apps/multi-tenant run start 3400
curl -X POST localhost:3400/notes -H 'x-tenant-id: acme' -H 'content-type: application/json' -d '{"text":"a"}'   # 201
curl localhost:3400/notes -H 'x-tenant-id: acme'                          # [ the note ]
curl localhost:3400/notes -H 'x-tenant-id: globex'                        # []
curl localhost:3400/notes                                                 # 400 Tenant Required
```

Read: [`src/modules/notes/`](../apps/multi-tenant/src/modules/notes).

---

### plugin-development

A complete custom plugin: it registers a service under its own capability token and adds a route
that resolves the service from the request context.

```bash
pnpm --dir apps/plugin-development run start 3400
curl localhost:3400/greet/ada   # {"message":"Hello, ada!"}
pnpm --dir apps/plugin-development run test                  # the plugin's own tests
```

Read: [`src/plugins/greeting.plugin.ts`](../apps/plugin-development/src/plugins/greeting.plugin.ts).
See [Custom Plugins](./custom-plugins.md).

---

### microservices

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

Read: [`src/greeting.contract.ts`](../apps/microservices/src/greeting.contract.ts),
[`src/service-a/`](../apps/microservices/src/service-a),
[`src/service-b/`](../apps/microservices/src/service-b).

---

### realtime

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

Read: [`src/modules/news/`](../apps/realtime/src/modules/news),
[`smoke.ts`](../apps/realtime/smoke.ts).

---

### realtime-clients

A server with SSE and WebSocket routes, driven by the `@setu-ts/sdk` realtime clients from Node
(with and without type stripping), Bun and workerd: SSE reconnection resumes from the last event id,
authenticated streams send their credentials, and a WebSocket stays alive across the server's
keep-alive. Its smoke check needs Node and Bun installed.

Read: [`setu.config.ts`](../apps/realtime-clients/setu.config.ts),
[`driver.ts`](../apps/realtime-clients/driver.ts), [`smoke.ts`](../apps/realtime-clients/smoke.ts).

---

### graphql-demo

`GraphqlPlugin` with a schema-first definition (`typeDefs` plus resolvers), subscriptions over both
WebSocket and SSE, automatic persisted queries backed by `CachePlugin`, request batching, and
GraphiQL.

```bash
pnpm --dir apps/graphql-demo run start          # port 4000
curl -X POST localhost:4000/graphql -H 'content-type: application/json' -d '{"query":"{ hello }"}'   # {"data":{"hello":"world"}}
# GraphiQL at http://localhost:4000/graphql in a browser
```

`pnpm --dir apps/graphql-demo run interop` drives the same server with the reference `graphql-ws`
client and Apollo's persisted-query link; it needs their npm packages, so CI does not run it.

Read: [`setu.config.ts`](../apps/graphql-demo/setu.config.ts),
[`src/modules/books/`](../apps/graphql-demo/src/modules/books).

---

### grpc

`GrpcPlugin` serving a Connect RPC from an embedded service descriptor on the same port as an
ordinary `GET /health` route. Connect and gRPC-Web clients can call it; native gRPC cannot, because
it needs HTTP/2 trailers a fetch-based server does not send.

```bash
pnpm --dir apps/grpc run start                  # port 5000
curl localhost:5000/health                       # {"status":"ok"}
```

Read: [`src/modules/echo/`](../apps/grpc/src/modules/echo), [`smoke.ts`](../apps/grpc/smoke.ts). See
[`@setu-ts/grpc-plugin`](./plugins.md#setu-tsgrpc-plugin).

---

### cloudflare

A Worker using `CloudflarePlugin`: a KV namespace, a cron trigger whose `scheduled` handler writes
to KV, and messaging over a Cloudflare queue (a publish in one `fetch` is received by a subscriber
in a separate `queue` invocation), with replies through a Durable Object. Its smoke check bundles
the Worker and runs it on **real workerd** through `wrangler dev`, and checks that `detectRuntime()`
answers `'cloudflare-workers'` there.

```bash
pnpm --dir apps/cloudflare run smoke            # needs `wrangler` on PATH
```

[`worker.ts`](../apps/cloudflare/worker.ts) is the entry Wrangler deploys: it starts the application
once per isolate, retries if that start fails, and shares the started application with the `queue`
handler. Bindings are declared in [`wrangler.toml`](../apps/cloudflare/wrangler.toml).

---

### compiled-binary

The same small application compiled into a standalone executable.

```bash
pnpm --dir apps/compiled-binary run build:sea     # writes ./.tmp/compiled-binary/server
./.tmp/compiled-binary/server 3400               # then, in another terminal:
curl localhost:3400/health        # {"status":"ok"}
```

Read: [`setu.config.ts`](../apps/compiled-binary/setu.config.ts),
[`sea.ts`](../apps/compiled-binary/sea.ts). See
[Runtime Deployment — Standalone binaries](./runtime-deployment.md).

---

### full-stack

A React Router 8 framework-mode application composed with `createFullStackAppFromConfig` from
`@setu-ts/full-stack-starter`. Its smoke check writes a row through the database capability, renders
an SSR page that shows it (proving `populateLoadContext` reached the loader), and completes a
`<Form>` login whose CSRF token round-trips through the session plugin.

```bash
pnpm --dir apps/full-stack run start            # builds first, then serves on PORT or 3000
```

`start` runs the React Router / Vite build first using Node and pnpm.

Read: [`setu.config.ts`](../apps/full-stack/setu.config.ts), the routes under
[`app/routes/`](../apps/full-stack/app/routes), and [`smoke.ts`](../apps/full-stack/smoke.ts).

---

### worker-pool

CPU-bound task modules sharing one worker slot. The smoke check proves main-thread timers keep
running during a spin, that a second task module is not starved behind a queue of the first, that
worker writes to a `SharedArrayBuffer` are visible to the caller, and that `/health` reports the
budget.

```bash
pnpm --dir apps/worker-pool run start 3400      # loopback-only, http://127.0.0.1:3400/health
pnpm --dir apps/worker-pool run smoke
```

Read: [`src/tasks/`](../apps/worker-pool/src/tasks), [`smoke.ts`](../apps/worker-pool/smoke.ts).

---

### static-site

`StaticPlugin` serving `./public` at the root with an SPA fallback, beside a `GET /health` route.
The smoke check requests the cases that once failed: a `HEAD` that must not open a body, a hashed
asset that keeps its `immutable` policy when the brotli copy is served, conditional requests, and a
resumed download through `Range` and `If-Range`.

```bash
pnpm --dir apps/static-site run start 3400      # the port; defaults to 8000
curl -I localhost:3400/index.html
```

The default port `8000` is also DynamoDB Local's default, so pass another port when that is running.

Read: [`setu.config.ts`](../apps/static-site/setu.config.ts),
[`smoke.ts`](../apps/static-site/smoke.ts).

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
