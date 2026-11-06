# Setu-TS examples

Each directory is a member of the pnpm workspace (`pnpm-workspace.yaml` lists `apps/*`) with a
private `package.json`: `@setu-ts/*` as `workspace:^` dependencies, `start` and `smoke` scripts that
run through `tsx`, and a generated `tsconfig.json` extending `../../tsconfig.apps.json`. `tsx`
applies that config's `paths`, so framework imports run HEAD source. The full-stack example builds
its frontend first. Run an example's `smoke` script to verify the claim below. Examples use the
structure the CLI writes for their artifacts: `setu.config.ts`, `main.ts`, and CLI-owned module,
plugin or CQRS barrels where those seams are used. Module compositions call
`registerModules(app.router, app.services)`; class-based ones also pass `MODULES` to
DecoratorPlugin, and custom plugins register through `GENERATED_PLUGINS`. `setu sync` regenerates
those files and `setu check` checks their wiring. No example adds an empty barrel for an unused
artifact family.

The [examples guide](../docs/examples.md#how-every-example-is-laid-out) explains the layouts:
single-route examples need no modules; GraphQL and gRPC keep their transport-specific files inside
modules with generated indexes; worker-pool tasks have no CLI schematic; `microservices`
deliberately keeps two factories under `src/service-a/` and `src/service-b/`. `mcp-tools` keeps the
scaffold's compiled Node `start`; run its `build` script before `start`. The layout gate in
`test/apps-layout.test.ts` compares the examples with projects generated from this checkout.

M37 kept the examples out of the Deno workspace so an application-only npm dependency could never
reach a published package's graph. They are members of the pnpm workspace because a published
package's dependency graph is defined by its own `package.json`, which no app touches, and the root
lockfile is not published. M37's reason was a resolution property of the Deno workspace that pnpm
does not have.

| Example                                      | What its smoke check proves                                                                         |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [`minimal`](./minimal)                       | Kernel + runtime serve one `200` route.                                                             |
| [`rest-api`](./rest-api)                     | Authenticated CRUD reads a written todo back and is described by OpenAPI.                           |
| [`worker-pool`](./worker-pool)               | CPU work leaves timers running; modules share one worker fairly; SAB writes are visible.            |
| [`cqrs`](./cqrs)                             | A command mutation is observable through a separate query bus.                                      |
| [`multi-tenant`](./multi-tenant)             | A write under one tenant is invisible to another tenant.                                            |
| [`mcp-tools`](./mcp-tools)                   | MCP scopes, schemas, idempotent retries, validation, rate limits, Origin checks and archive quotas. |
| [`semantic-search`](./semantic-search)       | Background indexing, tenant-scoped search, re-ingest replacement and refused filters.               |
| [`durable-agent`](./durable-agent)           | An agent run that survives reloads and restarts, a refund approval, and a refund written once.      |
| [`ai-chat`](./ai-chat)                       | AI SDK streams, trusted tools, quotas, usage delivery, fallback and OTLP content controls.          |
| [`microservices`](./microservices)           | Service A discovers and calls B, plus brokered request/reply.                                       |
| [`di-decorators`](./di-decorators)           | A decorated route uses `@Inject`; manual scopes distinguish lifetimes.                              |
| [`database`](./database)                     | Repository writes read back, updates persist, and transactions roll back.                           |
| [`plugin-development`](./plugin-development) | A custom plugin registers and resolves a capability from a route.                                   |
| [`compiled-binary`](./compiled-binary)       | A Node single executable serves `/health`.                                                          |
| [`graphql-demo`](./graphql-demo)             | The adopted GraphQL example answers a basic operation.                                              |
| [`grpc`](./grpc)                             | A descriptor-backed Connect RPC and HTTP route share one application.                               |
| [`cloudflare`](./cloudflare)                 | Worker bindings wire KV and cron (requires Wrangler).                                               |
| [`realtime`](./realtime)                     | A publish on A reaches B's SSE client through Redis (requires Redis).                               |
| [`realtime-clients`](./realtime-clients)     | SDK SSE resume/auth and WebSocket keep-alive on a real server.                                      |
| [`full-stack`](./full-stack)                 | A request-bound kernel module serves database rows to an SSR page and API.                          |
| [`static-site`](./static-site)               | Static file serving with caching, ETags, and range requests.                                        |

See the [examples guide](../docs/examples.md) for learning paths and more details.

The root `pnpm run check:apps` gate type-checks every app and runs each smoke script. When a smoke
script exits with code 77, the gate records it as a skip and prints a warning. In CI, the gate reads
the `ALLOW_SKIP` environment variable (a comma-separated list of application names) and treats a
skip for any app **not** listed there as a failure — so a newly added example whose backend CI does
not provide must be added to `ALLOW_SKIP` or it fails the gate. Locally, `ALLOW_SKIP` is unset by
default, so every skip remains a warning and the gate does not block.

`full-stack` is the one example that builds something before it can prove anything: its `smoke`
script runs the real React Router / Vite frontend build first, and costs a few seconds, so the
example is deliberately **not** in `ALLOW_SKIP`, and `test/apps-gate.test.ts` asserts that it never
becomes so.

`realtime-clients` drives the SDK from Node, Bun, and workerd. CI provisions Node and Bun; the
example is deliberately absent from `ALLOW_SKIP`.
