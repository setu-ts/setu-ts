# Hono Enterprise examples

Each directory is a standalone Deno application kept outside the workspace so its application-only
dependencies cannot enter a published package graph. Run its `smoke` task to verify the claim below.

| Example                                      | What its smoke check proves                                           |
| -------------------------------------------- | --------------------------------------------------------------------- |
| [`minimal`](./minimal)                       | Kernel + runtime serve one `200` route.                               |
| [`rest-api`](./rest-api)                     | A written todo reads back and is described by OpenAPI.                |
| [`cqrs`](./cqrs)                             | A command mutation is observable through a separate query bus.        |
| [`multi-tenant`](./multi-tenant)             | A write under one tenant is invisible to another tenant.              |
| [`microservices`](./microservices)           | Static discovery and brokered request/reply connect two services.     |
| [`plugin-development`](./plugin-development) | A custom plugin registers and resolves a capability from a route.     |
| [`compiled-binary`](./compiled-binary)       | `deno compile` creates a binary that serves `/health`.                |
| [`graphql-demo`](./graphql-demo)             | The adopted GraphQL example answers a basic operation.                |
| [`grpc`](./grpc)                             | A descriptor-backed Connect RPC and HTTP route share one application. |
| [`cloudflare`](./cloudflare)                 | Worker bindings wire KV and cron (requires Wrangler).                 |
| [`realtime`](./realtime)                     | A replica is configured for Redis backplane fan-out (requires Redis). |

The root `deno task check:apps` gate type-checks every app and runs each smoke task.
