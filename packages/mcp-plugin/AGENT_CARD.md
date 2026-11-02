# @setu-ts/mcp-plugin — route tools for agents

**Add it:** `setu add mcp` installs this package and the optional server SDK peer. Register
`McpPlugin({})` in `setu.config.ts`; no capability token is provided.

## Mark a route

```ts
import { McpPlugin, mcpTool } from '@setu-ts/mcp-plugin';

export const mcp = McpPlugin({});
export const read = mcpTool({ name: 'read_item', description: 'Read an item' });
```

Place `read` in the route's middleware. For controllers use @setu-ts/decorator-plugin's method-only
`@McpTool(meta?)`. Metadata accepts `name?`, `description?`, `title?`, `repeatable?: true`.
Functional names fall back to `schema.operationId`; decorated names to operationId, then method.
Description falls back to route description, then summary. Names are unique, 1–64 ASCII letters,
digits, underscores, dots or hyphens.

## Behavior the types do not show

- Every tool needs a security brand or defined `schema.security`; @setu-ts/auth-plugin's
  `publicRoute()` and `@Public()` declare public intent. Missing intent refuses startup.
- Calls re-enter guards, validation, tenancy, rate limits, idempotency and audit using forwarded
  credentials. Principal/state are never copied. The application must rate-limit tool routes.
- Path/query/body inputs merge from validation brands. Collisions refuse startup. POST/PUT/PATCH
  needs body validation; POST/PATCH also needs idempotency or `repeatable: true`.
- Branded identical retries replay within the TTL. Vary an argument for intentional repetition.
- Lists filter authentication/scopes with private cache hints; roles/policies enforce on calls.
- `maxResultBytes` defaults to 1 MiB (cap 64 MiB). `timeoutMs` defaults to 30000 ms, safe integer
  1–600000: it aborts the inner request and bounds dispatch/result reading even if cancellation is
  ignored. Deadline: `The tool timed out.`; client abort: `The tool failed.`.
- Cross-origin requests need `allowedOrigins`. Accepted Origin reaches inner CSRF checks.

Alternatively `tools?` lists exact method/path bindings. A route cannot be both marked and listed,
or carry two markers; HEAD/OPTIONS markers and an empty combined set refuse startup. Options:
`tools`, `path`, `serverInfo`, `instructions`, `allowedOrigins`, `legacy`, `maxResultBytes`,
`timeoutMs`. See README for schemas, result mapping and examples.
