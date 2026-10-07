# Examples

The [`apps/`](../apps/) directory holds sixteen runnable applications. Each one proves a specific
capability, and its `smoke.ts` is the proof: `deno task check:apps` type-checks every app and runs
every smoke check, in CI as well as locally. This guide says what each app proves, how to run it,
and which requests to try. The code itself lives in the app, not here, so this page cannot drift
from it.

## Running an example

```bash
cd apps/<example-name>
deno task start          # most apps take a port as the first argument: deno task start 3400
deno task smoke          # run the app's proof
```

Every app is a standalone Deno project outside the workspace; its `deno.json` maps the `@setu-ts/*`
packages to this repository's `packages/` sources, so an example always runs against the current
code rather than a published release.

Most apps listen on port `3000` unless you pass a port, but three do not: `graphql-demo` defaults to
`4000`, `grpc` to `5000`, and `static-site` always binds `8000`. Two apps are demonstrations that
print a result and exit rather than servers: `cqrs` and `microservices`.

## How every example is laid out

Each app splits the same three ways, which is also the shape to copy into your own project. A
factory in `src/app.ts` builds the application without starting it. `main.ts` starts it on a port.
`smoke.ts` starts it with no port and drives it with `app.inject()`, so the proof needs no socket.
This is `minimal`'s factory and smoke check, joined into one listing:

```typescript
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

// src/app.ts — builds the application and does not start it.
export function createMinimalApp(): IKernelApplication {
  const app = createApplication({ plugins: [RuntimePlugin()] });
  app.router.get('/', (ctx) => ctx.response.json({ hello: 'world' }));
  return app;
}

// smoke.ts — starts it with no port, so nothing binds a socket.
const app = createMinimalApp();
await app.start();
try {
  const response = await app.inject({ method: 'GET', url: 'http://example.test/' });
  if (response.statusCode !== 200 || response.body !== '{"hello":"world"}') {
    throw new Error(`Expected GET / to return the greeting, received ${response.statusCode}`);
  }
} finally {
  await app.stop();
}
```

`main.ts` adds the port and the `SIGTERM` handling that lets `app.stop()` run on shutdown; see
[`apps/minimal/main.ts`](../apps/minimal/main.ts) and
[Getting Started — Stopping Cleanly](./getting-started.md#stopping-cleanly).

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
| [compiled-binary](../apps/compiled-binary)       | `deno compile` produces a binary that serves `/health`                                          | —                         |
| [full-stack](../apps/full-stack)                 | A server-rendered React Router page shows rows read through the database capability             | — (builds with Deno)      |
| [static-site](../apps/static-site)               | Static files are served with cache headers, ETags, conditional requests, and byte ranges        | Port 8000 free            |

## Example deep dives

### minimal

The kernel and the runtime plugin, and one route. Nothing else is registered, so there is no
`/health` here; the [rest-api](#rest-api) example has one.

```bash
cd apps/minimal && deno task start 3400
curl localhost:3400/            # {"hello":"world"}
```

Read: [`src/app.ts`](../apps/minimal/src/app.ts).

---

### rest-api

A todo API composed with `createRestApp` from `@setu-ts/rest-starter`, with the starter's `auth` and
`openapi` options turned on. Both routes carry `requireAuth()`, so an unauthenticated write answers
`401` in RFC 9457 Problem Details form. The starter also brings health, metrics, security headers
and the error handler.

```bash
cd apps/rest-api && deno task start 3400
curl localhost:3400/health                                    # 200
curl -X POST localhost:3400/todos -H 'content-type: application/json' -d '{"title":"x"}'          # 401 Problem Details
# Swagger UI at http://localhost:3400/docs, the document at /openapi.json
```

The route `schema` documents the body for OpenAPI; it does not validate it. Validation needs
`validateBody(...)` in the route's middleware (see
[Pipelines (Validation)](./migration-nestjs.md#pipelines-validation)). The smoke check issues a
token through `issueDemoToken` and reads the written todo back.

Read: [`src/app.ts`](../apps/rest-api/src/app.ts), [`smoke.ts`](../apps/rest-api/smoke.ts).

---

### di-decorators

A `@Controller` class whose constructor receives an `@Injectable` service through
`@Inject('greeting-service')`, with `DiPlugin` providing the container. A second route shows that
the framework creates no per-request scope: the app creates two scopes itself and compares what each
returns.

```bash
cd apps/di-decorators && deno task start 3400
curl localhost:3400/greetings   # {"greeting":"Hello, decorators!"}
curl localhost:3400/lifetimes   # {"singletonShared":true,"scopeRetainsInstance":true,"scopesAreDistinct":true}
```

Read: [`src/greeting-controller.ts`](../apps/di-decorators/src/greeting-controller.ts),
[`src/greeting-service.ts`](../apps/di-decorators/src/greeting-service.ts),
[`src/app.ts`](../apps/di-decorators/src/app.ts). See also
[Decorators — Scoped Injection](./decorators.md#scoped-injection).

---

### database

`DatabasePlugin` on the in-memory adapter, behind a `notes` repository: create, read, update, and a
transaction that is rolled back.

```bash
cd apps/database && deno task start 3400
curl -X POST localhost:3400/notes -H 'content-type: application/json' -d '{"id":"1","text":"hello"}'   # 201
curl localhost:3400/notes/1                                       # {"id":"1","text":"hello"}
curl -X PATCH localhost:3400/notes/1 -H 'content-type: application/json' -d '{"text":"updated"}'
```

The memory adapter is for development and tests; the same repository code runs against PostgreSQL
through Drizzle or Prisma, or MongoDB and the other adapters. See
[`@setu-ts/database-plugin`](./plugins.md#setu-tsdatabase-plugin).

Read: [`src/app.ts`](../apps/database/src/app.ts), [`smoke.ts`](../apps/database/smoke.ts).

---

### cqrs

`CqrsPlugin` with one command handler and one query handler. `deno task start` sends a command,
reads the result through the query bus, prints it and exits; it is not a server. The command handler
is built by a factory that resolves the runtime capability, which is why the printed note carries a
timestamp.

```bash
cd apps/cqrs && deno task start
# [ "CQRS keeps commands and queries separate. @ 1791396240491" ]
```

Read: [`src/app.ts`](../apps/cqrs/src/app.ts).

---

### multi-tenant

`MultiTenancyPlugin` resolving the tenant from the `x-tenant-id` header, with `required: true`.
Notes are stored per tenant, and a request with no tenant is refused.

```bash
cd apps/multi-tenant && deno task start 3400
curl -X POST localhost:3400/notes -H 'x-tenant-id: acme' -H 'content-type: application/json' -d '{"text":"a"}'   # 201
curl localhost:3400/notes -H 'x-tenant-id: acme'                          # [ the note ]
curl localhost:3400/notes -H 'x-tenant-id: globex'                        # []
curl localhost:3400/notes                                                 # 400 Tenant Required
```

Read: [`src/app.ts`](../apps/multi-tenant/src/app.ts).

---

### plugin-development

A complete custom plugin: it registers a service under its own capability token and adds a route
that resolves the service from the request context.

```bash
cd apps/plugin-development && deno task start 3400
curl localhost:3400/greet/ada   # {"message":"Hello, ada!"}
deno task test                  # the plugin's own tests
```

Read: [`src/greeting-plugin.ts`](../apps/plugin-development/src/greeting-plugin.ts). See
[Custom Plugins](./custom-plugins.md).

---

### microservices

Two applications in one process. Service A finds service B through `ServiceDiscoveryPlugin` and
calls it over HTTP. With `REDIS_URL` set, B also registers a responder on a Redis Streams broker and
A calls it with `broker.request(...)`. `deno task start` runs both calls, prints the answers and
exits.

```bash
cd apps/microservices && deno task start 3300 3301
# Hello, service-a!
# Set REDIS_URL to demonstrate brokered request/reply between services.
REDIS_URL=redis://127.0.0.1:6379 deno task start 3300 3301   # both calls succeed
```

The two arguments are service A's and service B's ports (defaults `3000` and `3001`).

Read: [`src/app.ts`](../apps/microservices/src/app.ts).

---

### realtime

Server-Sent Events over `SsePlugin`, fanned out across replicas by `RealtimeBackplanePlugin` with
the `'redis'` transport. `POST /publish` sends to the `news` channel and every replica's
`GET /events` clients receive it. The smoke check starts two replicas as **separate processes**: two
replicas in one process would share the backplane's in-process transport and prove nothing.

```bash
cd apps/realtime && deno task start 3400   # REDIS_URL defaults to redis://127.0.0.1:6379
curl -N localhost:3400/events                                    # in one terminal
curl -X POST localhost:3400/publish -H 'content-type: application/json' -d '{"message":"hi"}'        # 204, in another
```

WebSocket rooms are shown in [realtime-clients](#realtime-clients) and in the
[`@setu-ts/websocket-plugin` README](https://github.com/setu-ts/setu-ts/blob/main/packages/websocket-plugin/README.md).

Read: [`src/app.ts`](../apps/realtime/src/app.ts), [`smoke.ts`](../apps/realtime/smoke.ts).

---

### realtime-clients

A server with SSE and WebSocket routes, driven by the `@setu-ts/sdk` realtime clients from Deno,
Node, Bun and workerd: SSE reconnection resumes from the last event id, authenticated streams send
their credentials, and a WebSocket stays alive across the server's keep-alive. Its smoke check needs
Node and Bun installed.

Read: [`src/app.ts`](../apps/realtime-clients/src/app.ts),
[`smoke.ts`](../apps/realtime-clients/smoke.ts).

---

### graphql-demo

`GraphqlPlugin` with a schema-first definition (`typeDefs` plus resolvers), subscriptions over both
WebSocket and SSE, automatic persisted queries backed by `CachePlugin`, request batching, and
GraphiQL.

```bash
cd apps/graphql-demo && deno task start          # port 4000
curl -X POST localhost:4000/graphql -H 'content-type: application/json' -d '{"query":"{ hello }"}'   # {"data":{"hello":"world"}}
# GraphiQL at http://localhost:4000/graphql in a browser
```

`deno task interop` drives the same server with the reference `graphql-ws` client and Apollo's
persisted-query link; it needs their npm packages, so CI does not run it.

Read: [`src/app.ts`](../apps/graphql-demo/src/app.ts),
[`src/schema.ts`](../apps/graphql-demo/src/schema.ts).

---

### grpc

`GrpcPlugin` serving a Connect RPC from an embedded service descriptor on the same port as an
ordinary `GET /health` route. Connect and gRPC-Web clients can call it; native gRPC cannot, because
it needs HTTP/2 trailers a fetch-based server does not send.

```bash
cd apps/grpc && deno task start                  # port 5000
curl localhost:5000/health                       # {"status":"ok"}
```

Read: [`src/app.ts`](../apps/grpc/src/app.ts), [`smoke.ts`](../apps/grpc/smoke.ts). See
[`@setu-ts/grpc-plugin`](./plugins.md#setu-tsgrpc-plugin).

---

### cloudflare

A Worker using `CloudflarePlugin`: a KV namespace, a cron trigger whose `scheduled` handler writes
to KV, and messaging over a Cloudflare queue (a publish in one `fetch` is received by a subscriber
in a separate `queue` invocation), with replies through a Durable Object. Its smoke check bundles
the Worker and runs it on **real workerd** through `wrangler dev`, and checks that `detectRuntime()`
answers `'cloudflare-workers'` there.

```bash
cd apps/cloudflare && deno task smoke            # needs `wrangler` on PATH
```

[`worker.ts`](../apps/cloudflare/worker.ts) is the entry Wrangler deploys: it starts the application
once per isolate, retries if that start fails, and shares the started application with the `queue`
handler. Bindings are declared in [`wrangler.toml`](../apps/cloudflare/wrangler.toml).

---

### compiled-binary

The same small application compiled into a standalone executable.

```bash
cd apps/compiled-binary && deno task compile     # writes ./hono-example
./hono-example 3400               # then, in another terminal:
curl localhost:3400/health        # {"status":"ok"}
```

Read: [`src/app.ts`](../apps/compiled-binary/src/app.ts). See
[Runtime Deployment — Standalone binaries](./runtime-deployment.md).

---

### full-stack

A React Router 8 framework-mode application composed with `createFullStackAppFromConfig` from
`@setu-ts/full-stack-starter`. Its smoke check writes a row through the database capability, renders
an SSR page that shows it (proving `populateLoadContext` reached the loader), and completes a
`<Form>` login whose CSRF token round-trips through the session plugin.

```bash
cd apps/full-stack && deno task start            # builds first, then serves on PORT or 3000
```

`start` runs the Vite build first, under Deno's own npm support; no Node toolchain is needed.

Read: [`setu.config.ts`](../apps/full-stack/setu.config.ts), the routes under
[`app/routes/`](../apps/full-stack/app/routes), and [`smoke.ts`](../apps/full-stack/smoke.ts).

---

### static-site

`StaticPlugin` serving `./public` at the root, beside a `GET /health` route. The smoke check
requests the cases that once failed: a `HEAD` that must not open a body, a hashed asset that keeps
its `immutable` policy when the brotli copy is served, conditional requests, and a resumed download
through `Range` and `If-Range`.

```bash
cd apps/static-site && deno task start           # always port 8000
curl -I localhost:8000/index.html
```

Port `8000` is hard-coded, so stop anything else bound there first. DynamoDB Local's default port is
also `8000`.

Read: [`main.ts`](../apps/static-site/main.ts), [`smoke.ts`](../apps/static-site/smoke.ts).

## Smoke checks

A smoke check asserts one behaviour and fails loudly. `deno task smoke` exits non-zero on the first
failed assertion, with a message naming what did not happen. A check whose external prerequisite is
missing (Redis, Wrangler) prints why and exits with code `77`, which `check:apps` records as a skip
rather than a pass.

## Running every example

```bash
deno task check:apps                                   # from the repository root
REDIS_URL=redis://127.0.0.1:6379 deno task check:apps  # include the Redis-backed checks
```

It type-checks each app, runs its `smoke` task and, where one is declared, its `test` task. In CI a
skip fails the job unless the app is in the `ALLOW_SKIP` list; see
[`apps/README.md`](../apps/README.md).

## Contributing an example

1. Create it under `apps/<name>/` with a `deno.json` declaring `start` and `smoke` tasks.
2. Make `smoke.ts` assert the behaviour the example exists for, not only that it started.
3. Add it to [`apps/README.md`](../apps/README.md) and to this guide.
4. Run `deno task check:apps`.

## Next Steps

- [Getting Started](./getting-started.md) - Set up your first application
- [Plugin Architecture](./plugin-architecture.md) - Deep dive into plugins
- [Runtime Deployment](./runtime-deployment.md) - Deploy to production
- [Docker and Kubernetes](./deployment.md) - Containerize and orchestrate an example
