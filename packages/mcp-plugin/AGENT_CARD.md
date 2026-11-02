# @setu-ts/mcp-plugin — expose declared routes as MCP tools

**Add it:** `setu add mcp` installs the package and optional `@modelcontextprotocol/server` peer.
Declare tools explicitly in `setu.config.ts`; there is no zero-config registration or capability
token.

## Register the endpoint

```ts
import { McpPlugin } from '@setu-ts/mcp-plugin';

export const mcp = McpPlugin({
  tools: [{ name: 'read_item', description: 'Read an item', route: { method: 'GET', path: '/items/:id' } }],
});
```

Register `/items/:id` on the application router before bootstrap. POST `/mcp` serves the tools; GET
and DELETE answer 405. The default legacy posture serves 2025 clients as well as modern clients.

## Behavior the types do not show

- Calls re-enter the kernel pipeline with forwarded credential and tenant headers. Guards,
  validation, rate limiting, idempotency and audit run again. Principal/state are never copied.
- The application must rate-limit tool invocations; place `rateLimitMiddleware` on each tool route.
- Input merges path/query/body properties from validation brands (Zod v4). Collisions refuse
  startup.
- POST/PUT/PATCH needs body validation. POST/PATCH also needs idempotency middleware or
  `repeatable: true`.
- Branded retries derive a stable argument-based key. Identical intentional calls within the TTL
  replay; vary a client-reference argument when another operation is intended.
- Lists filter authentication and required scopes, with private cache hints. Role/policy guards
  remain on the route. Hidden single calls answer 401/403; unknown names are JSON-RPC -32602.
- Only object success schemas produce structured content. Validation refusals are tool errors; 5xx
  and thrown messages are generic. `maxResultBytes` defaults to 1 MiB.
- `timeoutMs` defaults to 30000 ms (safe integer 1–600000). The deadline bounds dispatch and result
  reading even when the route ignores its signal; it aborts the inner request and returns
  `The tool timed out.`. A client abort still returns `The tool failed.`.
- A present Origin must match the endpoint origin or `allowedOrigins`. Accepted Origin is forwarded
  so inner CSRF checks run. Disconnects abort the inner handler.

`path`, `serverInfo`, `instructions`, `allowedOrigins`, `legacy`, `maxResultBytes` and `timeoutMs`
configure the endpoint. See the package README for the runnable application and output mapping.
