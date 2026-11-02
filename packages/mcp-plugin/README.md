# @setu-ts/mcp-plugin

Expose explicitly declared HTTP routes as Model Context Protocol tools at one stateless endpoint.
Every call re-enters the kernel pipeline with a fresh context: authentication, tenant resolution,
guards, validation, rate limiting, idempotency and audit run as for an HTTP caller. The plugin
provides no capability token and exposes no routes automatically.

## Installation

```bash
npm install @setu-ts/mcp-plugin @modelcontextprotocol/server@^2.4.0
# Deno: deno add npm:@setu-ts/mcp-plugin npm:@modelcontextprotocol/server@^2.4.0
```

The SDK is an optional peer, loaded at bootstrap. A missing SDK fails startup with
`OptionalDependencyUnavailableError` naming `@setu-ts/mcp-plugin`. Input/output schema conversion
supports Zod `>=4.6.6 <5` through its public `toJSONSchema` API (tested with 4.6.6); Zod v3 is
refused. Install `zod` v4 for the walkthrough.

## Usage

This application keeps items in memory. Register your application's authentication configuration and
use its Bearer token when connecting an MCP client to `http://localhost:3000/mcp`.

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { AuthPlugin, requireAuth, rateLimitMiddleware } from '@setu-ts/auth-plugin';
import { IdempotencyPlugin, idempotent } from '@setu-ts/idempotency-plugin';
import { ValidationPlugin, validateBody } from '@setu-ts/validation-plugin';
import { McpPlugin } from '@setu-ts/mcp-plugin';
import { z } from 'zod';

const item = z.object({ id: z.string(), name: z.string() });
const body = validateBody(item);
const items = new Map<string, { id: string; name: string }>();
const app = createApplication({
  plugins: [
    RuntimePlugin(),
    AuthPlugin({ jwt: { secret: 'replace-with-your-application-secret-at-least-32-characters' } }),
    ValidationPlugin({ errorFormat: 'rfc9457' }),
    IdempotencyPlugin(),
    McpPlugin({
      tools: [
        { name: 'read_item', description: 'Read an item', route: { method: 'GET', path: '/items/:id' } },
        { name: 'create_item', description: 'Create an item', route: { method: 'POST', path: '/items' } },
      ],
    }),
  ],
});
app.router.get('/items/:id', {
  middleware: [requireAuth(), rateLimitMiddleware({ windowMs: 60_000, max: 60 })],
  schema: { response: { 200: item } },
  handler: (ctx) => {
    const found = items.get(ctx.params.id!);
    return found === undefined
      ? ctx.response.status(404).json({ error: 'Not Found' })
      : ctx.response.json(found);
  },
});
app.router.post('/items', {
  middleware: [requireAuth(), rateLimitMiddleware({ windowMs: 60_000, max: 20 }), body, idempotent()],
  schema: { response: { 200: item } },
  handler: (ctx) => {
    const value = body.value(ctx);
    items.set(value.id, value);
    return ctx.response.json(value);
  },
});
await app.start({ port: 3000 });
```

Call `create_item` with `{ "id": "one", "name": "Ada" }`, then `read_item` with `{ "id": "one" }`.
Both operations return structured content conforming to the route's object response schema and a
text block containing the JSON. The integration suite exercises the same client/route path without
opening a socket.

MCP servers **must rate-limit tool invocations**. The plugin uses the application's limiters; the
per-route middleware above counts that tool alone. A global limiter counts inner tool calls and the
outer MCP request, so one tool invocation consumes both budgets.

## Configuration

| Option           | Default                                  | Behavior                                                                                                    |
| ---------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `tools`          | required                                 | Non-empty declarations binding exact method and registered path pattern                                     |
| `path`           | `/mcp`                                   | POST endpoint; GET and DELETE answer 405 with `Allow: POST`                                                 |
| `serverInfo`     | `{ name: 'setu-mcp', version: VERSION }` | MCP server identity                                                                                         |
| `instructions`   | absent                                   | Server instructions                                                                                         |
| `allowedOrigins` | `[]`                                     | Additional absolute HTTP(S) origins, without a trailing slash or path                                       |
| `legacy`         | `'stateless'`                            | Serves 2025 clients; `'reject'` accepts only the modern protocol                                            |
| `maxResultBytes` | `1048576`                                | Maximum bytes read from an inner response (at most 64 MiB); excess cancels the stream                       |
| `timeoutMs`      | `30000`                                  | Per-call deadline in ms (safe integer 1–600000); aborts the inner request and returns `The tool timed out.` |

The deadline bounds both dispatch and reading the result, even when a route or response stream
ignores its signal. A client abort still returns `The tool failed.`; the first abort wins.

A declaration contains `name`, `description`, optional `title`, `route: { method, path }` and
optional `repeatable: true`. Methods are GET, POST, PUT, PATCH and DELETE. Names are unique,
case-sensitive, 1–128 ASCII letters, digits, underscores, dots or hyphens. A declaration cannot bind
to the MCP endpoint. `readOnlyHint` and `idempotentHint` are derived, never application options.
POST/PATCH requires the idempotency brand or `repeatable: true`; POST/PUT/PATCH requires a body
validation brand. An app without `IApplication.dispatch` refuses startup.

## Schemas and arguments

The flat input object merges path parameters, branded query properties and branded body properties.
The last validation brand for a target wins. Path parameters are required. A name in two sources, a
non-object body/query schema, a non-scalar query property (arrays of scalars are allowed), or
`$defs` in both query and body refuses startup. The body controls `additionalProperties`; without a
body it is false. Unknown arguments and unusable path values become generic tool errors. Query
arrays use repeated keys. Paths are encoded as single segments; empty, `.` and `..` values are
refused. Validation still runs on the route, and validation refusals become `isError` results.

The success status is the handler's response metadata status, or 200. A Zod object response schema
at that status supplies `outputSchema`; other response roots do not. Output that fails its schema is
a generic tool error. JSON without an output schema and text responses become text blocks; redirects
and unsupported media types are errors, and 5xx/thrown errors never reveal their body or message.
Only caller-visible 4xx Problem Details/default errors carry titles, details and field lines.

## Identity, visibility and retries

Credentials and tenant headers are forwarded to the inner request, and authentication and tenancy
run again. No verified principal, tenant or state map is copied. The socket peer and abort signal
are preserved. MCP, outer body and client idempotency headers are stripped; `Origin` is preserved
for inner CSRF checks after the outer Origin check. A present cross-origin Origin must be listed; a
missing Origin is accepted for non-browser clients.

Lists vary only by authentication and required OAuth scopes and have explicit private, zero-TTL
cache hints. Roles, permissions and policy checks remain on the route; such a tool can be visible
and still refuse a call. A hidden single call is answered 401/403 by the outer request's existing
Bearer challenge middleware; an unknown name is the SDK's JSON-RPC -32602. Legacy batches cannot
dispatch hidden tools because only visible tools are registered on their per-request server.

For branded routes the key is `mcp-` plus base64url SHA-256 of canonical JSON
`[toolName, arguments]`. The idempotency plugin scopes the record by principal and tenant. Two
intentional identical calls within its TTL replay too. Include a changing argument such as a client
reference when a separate operation is intended. Forwarding credentials means JWT verification runs
again on the inner call; issuer key sets remain cached. This trades additional verification work for
the same HTTP controls.

Node integration tests and one native Deno proof exercise list and call. The workerd condition has a
bundle-resolution proof; a live Workers run is a follow-on. Bun compatibility is unproven until the
0.13.0 artifacts are published and the compat row runs.

## Exports

| Export                        | Kind      |
| ----------------------------- | --------- |
| `McpPlugin`                   | function  |
| `McpPluginConfigurationError` | class     |
| `VERSION`                     | const     |
| `McpPluginOptions`            | interface |
| `McpToolDeclaration`          | interface |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.

## Full API

See
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#mcpplugin-setu-tsmcp-plugin).
