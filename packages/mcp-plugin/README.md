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

The walkthrough below also uses the kernel, runtime, auth, idempotency and validation packages and
Zod v4:

```bash
npm install @setu-ts/kernel @setu-ts/runtime @setu-ts/auth-plugin @setu-ts/idempotency-plugin @setu-ts/validation-plugin zod
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
import { McpPlugin, mcpTool } from '@setu-ts/mcp-plugin';
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
    McpPlugin({}),
  ],
});
app.router.get('/items/:id', {
  middleware: [requireAuth(), rateLimitMiddleware({ windowMs: 60_000, max: 60 }),
    mcpTool({ name: 'read_item', description: 'Read an item' })],
  schema: { response: { 200: item } },
  handler: (ctx) => {
    const found = items.get(ctx.params.id!);
    return found === undefined
      ? ctx.response.status(404).json({ error: 'Not Found' })
      : ctx.response.json(found);
  },
});
app.router.post('/items', {
  middleware: [requireAuth(), rateLimitMiddleware({ windowMs: 60_000, max: 20 }), body, idempotent(),
    mcpTool({ name: 'create_item', description: 'Create an item' })],
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

## Declaring tools

Place `mcpTool(meta?)` in the route's middleware. Its optional metadata is
`{ name?, description?, title?, repeatable?: true }`. The name defaults to `schema.operationId`;
description defaults to `schema.description`, then `schema.summary`. Names are never derived from
paths.

For class controllers, decorator-plugin supplies method-only `@McpTool(meta?)`. Its name defaults to
`@ApiOperation`'s `operationId`, then the method name. Description uses the same schema fallbacks.
Constructor injection and route guards run normally on each tool call.

As an alternative to markers, declare exact method/path bindings in the plugin options:

```typescript
import { McpPlugin } from '@setu-ts/mcp-plugin';

export const mcp = McpPlugin({
  tools: [
    { name: 'read_item', description: 'Read an item', route: { method: 'GET', path: '/items/:id' } },
  ],
});
```

A route must have declared security intent: a security-branded guard (including `publicRoute()`) or
defined `schema.security`. Decorator `@Public()` supplies `security: []`. Applications using global
authentication declare `schema.security` on each tool route. This declaration does not replace
enforcing guards.

Startup refuses missing names/descriptions, invalid or duplicate names, two markers on one route, a
route both marked and listed, HEAD/OPTIONS markers, missing security intent, and a combined tool set
that is empty. Both sources pass through the same schema, binding and retry checks.

## Configuration

| Option           | Default                                  | Behavior                                                                                                    |
| ---------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `tools`          | `[]`                                     | Optional declarations merged with route markers; together they must yield at least one tool                 |
| `path`           | `/mcp`                                   | POST endpoint; GET and DELETE answer 405 with `Allow: POST`                                                 |
| `serverInfo`     | `{ name: 'setu-mcp', version: VERSION }` | MCP server identity                                                                                         |
| `instructions`   | absent                                   | Server instructions                                                                                         |
| `allowedOrigins` | `[]`                                     | Allowed HTTP(S) origins, including same-origin browser UIs, without a trailing slash or path                |
| `legacy`         | `'stateless'`                            | Serves 2025 clients; `'reject'` accepts only the modern protocol                                            |
| `maxResultBytes` | `1048576`                                | Maximum bytes read from an inner response (at most 64 MiB); excess cancels the stream                       |
| `timeoutMs`      | `30000`                                  | Per-call deadline in ms (safe integer 1–600000); aborts the inner request and returns `The tool timed out.` |

The deadline releases the tool result even when a route ignores its signal. On deadline or client
abort, the response reader is cancelled. A hung inner route remains in the kernel's in-flight count
until it settles or the shutdown drain cap, just like a hung HTTP request. A client abort still
returns `The tool failed.`; the first abort wins.

A declaration contains `name`, `description`, optional `title`, `route: { method, path }` and
optional `repeatable: true`. Methods are GET, POST, PUT, PATCH and DELETE. Names are unique,
case-sensitive, 1–64 ASCII letters, digits, underscores, dots or hyphens. A declaration cannot bind
to the MCP endpoint. `readOnlyHint` and `idempotentHint` are derived, never application options.
POST/PATCH requires the idempotency brand or `repeatable: true`; POST/PUT/PATCH requires a body
validation brand. An idempotency-branded tool must also carry an authenticating security brand;
startup refuses anonymous idempotency scopes. An anonymous side-effecting tool uses
`repeatable: true` without an idempotency brand and receives no derived key. An app without
`IApplication.dispatch` refuses startup.

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
for inner CSRF checks after the outer Origin check. Every present Origin must be explicitly listed
in `allowedOrigins`, including same-origin browser UIs. The request's Host-derived origin supplies
no trust. A missing Origin is accepted for non-browser clients.

Dispatch pins the tool's registered pattern: a path argument cannot select a static sibling or
re-enter the MCP endpoint.

Tool output is untrusted model input; prompt-injection defence belongs to the agent host.

Lists vary only by authentication and required OAuth scopes and have explicit private, zero-TTL
cache hints. That filtering reads the route's branded guards (`requireAuth()`, `requireScopes()` and
the other auth-plugin and decorator guards): a route that declares security only through
`schema.security` passes the startup intent check but carries no brand, so its tool stays listed for
every caller and its own enforcement decides the call. Roles, permissions and policy checks remain
on the route; such a tool can be visible and still refuse a call. A hidden single call is answered
401/403 by the outer request's existing Bearer challenge middleware; an unknown name is the SDK's
JSON-RPC -32602. Legacy batches cannot dispatch hidden tools because only visible tools are
registered on their per-request server.

For branded routes the key is `mcp-` plus base64url SHA-256 of canonical JSON
`[toolName, arguments]`. The idempotency plugin scopes the record by principal and tenant. Two
intentional identical calls within its TTL replay too. Include a changing argument such as a client
reference when a separate operation is intended. The derived key is sent in the header the route
reads its key from (`Idempotency-Key`, or the header named in `idempotent({ key: { header } })`); a
route whose key comes from a body field or a function refuses startup, because MCP cannot supply it.
The replay guarantee is only as durable as the idempotency store: the default in-memory store is per
process, so a retry that reaches another replica, or arrives after a restart, can run the handler
again, and a call whose record could not be completed can run again once its lease expires. Use a
shared store (see the idempotency plugin's README) for multi-replica deployments, and keep handlers
safe to repeat where those windows matter. Forwarding credentials means JWT verification runs again
on the inner call; issuer key sets remain cached. This trades additional verification work for the
same HTTP controls.

Node integration tests and one native Deno proof exercise list and call. The workerd condition has a
bundle-resolution proof; a live Workers run is a follow-on. Bun compatibility is unproven until the
0.13.0 artifacts are published and the compat row runs.

## Exports

| Export                        | Kind      |
| ----------------------------- | --------- |
| `McpPlugin`                   | function  |
| `mcpTool`                     | function  |
| `McpPluginConfigurationError` | class     |
| `VERSION`                     | const     |
| `McpPluginOptions`            | interface |
| `McpToolDeclaration`          | interface |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.

## Full API

See
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#mcpplugin-setu-tsmcp-plugin).
