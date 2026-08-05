# Hono Enterprise examples

Each directory is a standalone Deno application kept outside the workspace so its application-only
dependencies cannot enter a published package graph. Run its `smoke` task to verify the claim below.

| Example                                      | What its smoke check proves                                               |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| [`minimal`](./minimal)                       | Kernel + runtime serve one `200` route.                                   |
| [`rest-api`](./rest-api)                     | Authenticated CRUD reads a written todo back and is described by OpenAPI. |
| [`cqrs`](./cqrs)                             | A command mutation is observable through a separate query bus.            |
| [`multi-tenant`](./multi-tenant)             | A write under one tenant is invisible to another tenant.                  |
| [`microservices`](./microservices)           | Service A discovers and calls B, plus brokered request/reply.             |
| [`di-decorators`](./di-decorators)           | A decorated route uses `@Inject`; manual scopes distinguish lifetimes.    |
| [`database`](./database)                     | Repository writes read back, updates persist, and transactions roll back. |
| [`plugin-development`](./plugin-development) | A custom plugin registers and resolves a capability from a route.         |
| [`compiled-binary`](./compiled-binary)       | `deno compile` creates a binary that serves `/health`.                    |
| [`graphql-demo`](./graphql-demo)             | The adopted GraphQL example answers a basic operation.                    |
| [`grpc`](./grpc)                             | A descriptor-backed Connect RPC and HTTP route share one application.     |
| [`cloudflare`](./cloudflare)                 | Worker bindings wire KV and cron (requires Wrangler).                     |
| [`realtime`](./realtime)                     | A publish on A reaches B's SSE client through Redis (requires Redis).     |

The root `deno task check:apps` gate type-checks every app and runs each smoke task. When a smoke
task exits with code 77, the gate records it as a skip and prints a warning. In CI, the gate reads
the `ALLOW_SKIP` environment variable (a comma-separated list of application names) and treats a
skip for any app **not** listed there as a failure — so a newly added example whose backend CI does
not provide must be added to `ALLOW_SKIP` or it fails the gate. Locally, `ALLOW_SKIP` is unset by
default, so every skip remains a warning and the gate does not block.
