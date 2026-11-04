# Tools for AI agents (MCP)

Expose a small, explicitly reviewed set of HTTP routes as tools when an agent needs to read or
change application data. Each tool call re-enters Setu's normal request pipeline: authentication,
scopes, validation, rate limiting and idempotency all run again. Nothing is exposed automatically.
Tool output is untrusted model input; the agent host owns prompt-injection defence.

The plugin, weighted quotas and offered example are available **from 0.12.0**. After that release,
`setu new demo --example mcp-tools` downloads the example from GitHub at the CLI's own release tag.
Before release, the CLI e2e against packed packages is the verification path. After publication,
repeat that command against the published CLI. GitHub must be reachable for `--example`; the
complete source below also lets you build the application without downloading the example.

## Install and generate the layout

Use the 0.12.0 or later CLI. These commands start a REST project and adopt its greeting into the
first feature module. `setu add` installs dependencies; it does not wire these plugins.

```bash
setu new mcp-tools --template rest --runtime node --yes
cd mcp-tools
npm install
setu generate module items --adopt-controllers
setu add auth
setu add idempotency
setu add mcp
npm install zod@^4.6.6
npm install --save-dev @modelcontextprotocol/client@^2.4.0
```

`setu add mcp` installs `@setu-ts/mcp-plugin` and its optional SDK peer,
`@modelcontextprotocol/server@^2.4.0`. An absent peer refuses bootstrap with
`OptionalDependencyUnavailableError`. Zod v4 (`>=4.6.6 <5`) supplies public JSON Schema conversion;
Zod v3 is refused.

Remove `src/modules/items/greeting.controller.ts` and `greeting.service.ts`, then run
`setu sync --dir .`. Keep the generated `main.ts`, instrumentation, build/start scripts and factory
signature. Replace the feature files and composition below. The generated barrel files are shown in
full so the project is reconstructible; `setu sync` owns them.

## Compose authentication and MCP

### `setu.config.ts`

The discovery environment remains the first parameter; development diagnostics remain the second.
The secret comes from `JWT_SECRET` with a clearly named local demo fallback. Use a separately
provisioned secret for a deployment. `MCP_RATE_MAX` is validated at startup and defaults to 60
requests per principal, per tool, per minute. `MCP_RESOURCE` identifies this resource server.

```typescript
// file: setu.config.ts
import {
  createApplication,
  type IKernelApplication,
  type KernelDiagnosticsOptions,
} from '@setu-ts/kernel';
import type { IPlugin } from '@setu-ts/common';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ConfigPlugin } from '@setu-ts/config-plugin';
import { LoggerPlugin } from '@setu-ts/logger-plugin';
import { ValidationPlugin } from '@setu-ts/validation-plugin';
import { HttpSecurityPlugin } from '@setu-ts/http-security-plugin';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { MetricsPlugin } from '@setu-ts/metrics-plugin';
import { OpenApiPlugin } from '@setu-ts/openapi-plugin';
import { McpToolsConfig } from './src/modules/items/items.schemas.ts';
import { AuthPlugin } from '@setu-ts/auth-plugin';
import { IdempotencyPlugin } from '@setu-ts/idempotency-plugin';
import { McpPlugin } from '@setu-ts/mcp-plugin';
import { errorHandler } from '@setu-ts/exceptions';
import { registerModules } from './src/modules/index.ts';
import { GENERATED_MIDDLEWARE } from './src/middleware/index.ts';
import { GENERATED_PLUGINS } from './src/plugins/index.ts';
import { HEALTH_INDICATORS } from './src/health/index.ts';
import { CUSTOM_METRICS } from './src/metrics/index.ts';

/** Local demonstration only; deploy with a secret supplied through JWT_SECRET. */
export const DEMO_JWT_SECRET = 'mcp-tools-demo-only-secret-at-least-32-characters';

/**
 * Builds the application.
 *
 * `setu` imports this factory to discover plugin-contributed CLI commands, so
 * it must NOT start the server — `main.ts` owns that.
 *
 * @param _env - The discovery environment `setu commands` passes positionally on
 * every target; accepted and unused, because a socket project reads configuration
 * from the process environment.
 * @param devtool - The development-only composition — the diagnostics plugin and
 * the kernel diagnostics option — supplied by `main.dev.ts` alone. The SECOND
 * parameter deliberately: `setu commands` passes its inert discovery env as the
 * FIRST argument on every target, which the unused `_env` above absorbs.
 * @returns The configured, unstarted application
 */
export function createApp(
  _env?: Readonly<Record<string, unknown>>,
  devtool?: { plugins?: readonly IPlugin[]; diagnostics?: KernelDiagnosticsOptions },
): IKernelApplication {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      ConfigPlugin({
        envFilePath: '.env',
        envFileOptional: true,
        validationSchema: McpToolsConfig,
      }),
      LoggerPlugin({
        requestLogging: true,
        excludePaths: ['/live', '/ready', '/health', '/metrics'],
        transport: 'pino',
      }),
      ValidationPlugin({ errorFormat: 'rfc9457' }),
      HttpSecurityPlugin(),
      HealthPlugin({ indicators: [...HEALTH_INDICATORS] }),
      MetricsPlugin({ customMetrics: [...CUSTOM_METRICS] }),
      OpenApiPlugin(),
      AuthPlugin({
        jwt: { secret: process.env.JWT_SECRET ?? DEMO_JWT_SECRET },
        resourceServer: {
          resource: process.env.MCP_RESOURCE ?? 'http://localhost:3000',
          scopesSupported: ['items:read', 'items:write'],
        },
      }),
      IdempotencyPlugin(),
      McpPlugin({
        serverInfo: { name: 'mcp-tools', version: '1.0.0' },
        allowedOrigins: [],
      }),
      ...GENERATED_PLUGINS,
      ...(devtool?.plugins ?? []),
    ],
    // Kernel diagnostics reach the CONSTRUCTOR only — the collector is built
    // there — so the devtool option threads through this object rather than
    // being registered onto a finished application.
    ...(devtool?.diagnostics !== undefined ? { diagnostics: devtool.diagnostics } : {}),
  });

  app.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 0, name: 'error-handler' });

  registerModules(app.router, app.services);
  for (const generated of GENERATED_MIDDLEWARE) {
    app.middleware.add(generated.middleware, {
      priority: generated.priority,
      name: generated.name,
    });
  }

  app.router.get('/', (ctx) => ctx.response.json({ message: 'Hello, World!' }));

  return app;
}
```

## Declare the feature

### `src/modules/items/items.schemas.ts`

The flat MCP input merges path parameters, branded query properties and branded body properties.
`archived` is the query string `"true"` or `"false"`, not JavaScript's truthiness conversion. Each
response has a Zod object schema. The create handler's 201 response metadata selects its output
schema; unbranded handlers default to status 200.

```typescript
// file: src/modules/items/items.schemas.ts
import { z } from 'zod';

/** Input for a new items record. */
export const CreateItemsBody = z.object({ name: z.string().trim().min(1).max(120) });
export type CreateItemsBody = z.infer<typeof CreateItemsBody>;
export const UpdateItemsBody = CreateItemsBody.partial();
export type UpdateItemsBody = z.infer<typeof UpdateItemsBody>;
export const ArchiveItemsBody = z.object({ reason: z.string().trim().min(1).max(240) });
export type ArchiveItemsBody = z.infer<typeof ArchiveItemsBody>;
export const ListItemsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  archived: z.enum(['true', 'false']).optional(),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListItemsQuery = z.infer<typeof ListItemsQuery>;
export const ItemsParams = z.object({ id: z.string().min(1) });
export type ItemsParams = z.infer<typeof ItemsParams>;
export const ItemsResponse = CreateItemsBody.extend({
  id: z.string(),
  archived: z.boolean(),
  reason: z.string().optional(),
});
export type ItemsResponse = z.infer<typeof ItemsResponse>;
export const ItemsListResponse = z.object({ items: z.array(ItemsResponse) });
export type ItemsListResponse = z.infer<typeof ItemsListResponse>;

/** Startup-validated per-tool rate configuration. */
export const McpToolsConfig = z.object({
  MCP_RATE_MAX: z.coerce.number().int().min(1).max(999_999).default(60),
});
```

### `src/modules/items/items.service.ts`

```typescript
// file: src/modules/items/items.service.ts
import type { IRuntimeServices } from '@setu-ts/common';
import type {
  ArchiveItemsBody,
  CreateItemsBody,
  ItemsResponse,
  ListItemsQuery,
  UpdateItemsBody,
} from './items.schemas.ts';

/** Creates process-local sample storage owned by one route registration (one app). */
export function createItemsService(): {
  listItems(query: ListItemsQuery): readonly ItemsResponse[];
  getItems(id: string): ItemsResponse | undefined;
  createItems(body: CreateItemsBody, runtime: IRuntimeServices): ItemsResponse;
  updateItems(id: string, body: UpdateItemsBody): ItemsResponse | undefined;
  archiveItems(id: string, body: ArchiveItemsBody): ItemsResponse | undefined;
} {
  // Replace this unbounded demonstration store with a repository before deployment.
  const records = new Map<string, ItemsResponse>();
  return {
    listItems(query) {
      const offset = query.offset ?? 0;
      return [...records.values()]
        .filter(
          (record) =>
            query.archived === undefined || record.archived === (query.archived === 'true'),
        )
        .slice(offset, offset + (query.limit ?? 20));
    },
    getItems(id) {
      return records.get(id);
    },
    createItems(body, runtime) {
      const record = { ...body, id: runtime.uuid(), archived: false };
      records.set(record.id, record);
      return record;
    },
    updateItems(id, body) {
      const current = records.get(id);
      if (current === undefined) return undefined;
      const record = { ...current, ...body, name: body.name ?? current.name, id };
      records.set(id, record);
      return record;
    },
    archiveItems(id, body) {
      const current = records.get(id);
      if (current === undefined) return undefined;
      const record = { ...current, archived: true, reason: body.reason };
      records.set(id, record);
      return record;
    },
  };
}
```

### `src/modules/items/items.controller.ts`

```typescript
// file: src/modules/items/items.controller.ts
import { CAPABILITIES, withResponseMetadata } from '@setu-ts/common';
import { requireScopes, rateLimitMiddleware } from '@setu-ts/auth-plugin';
import { idempotent } from '@setu-ts/idempotency-plugin';
import { mcpTool } from '@setu-ts/mcp-plugin';
import type {
  IConfig,
  IRouterApi,
  IRuntimeServices,
  IServiceRegistry,
  MiddlewareFunction,
} from '@setu-ts/common';
import { notFound } from '@setu-ts/exceptions';
import { validateBody, validateParams, validateQuery } from '@setu-ts/validation-plugin';
import {
  CreateItemsBody,
  ArchiveItemsBody,
  ItemsListResponse,
  ItemsParams,
  ItemsResponse,
  ListItemsQuery,
  UpdateItemsBody,
} from './items.schemas.ts';

import { createItemsService } from './items.service.ts';

import { archiveQuota } from './items.quota.ts';

const createBody = validateBody(CreateItemsBody);
const updateBody = validateBody(UpdateItemsBody);
const listQuery = validateQuery(ListItemsQuery);
const params = validateParams(ItemsParams);
const archiveBody = validateBody(ArchiveItemsBody);

// Config is available after bootstrap; each route owns its own limiter.
function toolRateLimit(): MiddlewareFunction {
  let limiter: MiddlewareFunction | undefined;
  return (ctx, next) => {
    limiter ??= rateLimitMiddleware({
      windowMs: 60_000,
      max: ctx.services.get<IConfig>(CAPABILITIES.CONFIG).getOrThrow<number>('MCP_RATE_MAX'),
    });
    return limiter(ctx, next);
  };
}

/** Registers the items feature routes. */
export function registerItemsRoutes(router: IRouterApi, services?: IServiceRegistry): void {
  void services;
  const { createItems, getItems, listItems, updateItems, archiveItems } = createItemsService();
  const quota = archiveQuota();
  router.group('/items', (routes) => {
    routes.get('/', {
      middleware: [
        requireScopes('items:read'),
        toolRateLimit(),
        listQuery,
        mcpTool({
          name: 'list_items',
          description: 'List items, optionally filtering archived records',
        }),
      ],
      schema: { response: { 200: ItemsListResponse } },
      handler: (ctx) =>
        ctx.response.json({
          items: listItems(listQuery.value(ctx)),
        }),
    });
    routes.get('/:id', {
      middleware: [
        requireScopes('items:read'),
        toolRateLimit(),
        params,
        mcpTool({ name: 'read_item', description: 'Read one item by id' }),
      ],
      schema: { response: { 200: ItemsResponse } },
      handler: (ctx) => {
        const id = params.value(ctx).id;
        const record = getItems(id);
        if (record === undefined) throw notFound('Items not found.');
        return ctx.response.json(record);
      },
    });
    routes.post('/', {
      middleware: [
        requireScopes('items:write'),
        toolRateLimit(),
        createBody,
        idempotent(),
        mcpTool({ name: 'create_item', description: 'Create an item' }),
      ],
      schema: { response: { 201: ItemsResponse } },
      handler: withResponseMetadata(
        (ctx) =>
          ctx.response
            .status(201)
            .json(
              createItems(
                createBody.value(ctx),
                ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME),
              ),
            ),
        { status: 201 },
      ),
    });
    routes.post('/:id/archive', {
      middleware: [
        requireScopes('items:write'),
        toolRateLimit(),
        archiveBody,
        idempotent(),
        quota,
        mcpTool({ name: 'archive_item', description: 'Archive an item for two daily quota units' }),
      ],
      schema: { params: ItemsParams, response: { 200: ItemsResponse } },
      handler: (ctx) => {
        const id = ItemsParams.parse(ctx.params).id;
        const record = archiveItems(id, archiveBody.value(ctx));
        if (record === undefined) throw notFound('Items not found.');
        return ctx.response.json(record);
      },
    });
    routes.patch('/:id', {
      middleware: [requireScopes('items:write'), toolRateLimit(), params, updateBody],
      schema: { response: { 200: ItemsResponse } },
      handler: (ctx) => {
        const id = params.value(ctx).id;
        const record = updateItems(id, updateBody.value(ctx));
        if (record === undefined) throw notFound('Items not found.');
        return ctx.response.json(record);
      },
    });
  });
}
```

## Rate limits and optional weighted quota

Every tool route has a separate `rateLimitMiddleware` after its scope guard. A global limiter would
count both the outer MCP request and the inner tool request. MCP servers must rate-limit tool
invocations.

The optional archive budget uses [weighted quotas](./ai.md): one lazy quota per application, three
units per UTC day per authenticated principal, two units per successful archive. A refused archive
refunds the reservation, including a thrown 404. A success settles at its reserved amount. The
demo's memory quota is process-local; use `RedisQuotaStore` for a shared budget across replicas.

The middleware order on archive is
`requireScopes → rate limit → body → idempotent → quota → mcpTool`. An identical retry replays
before entering quota middleware and therefore costs no additional units. Rate limiting still counts
retries because it comes first.

### `src/modules/items/items.quota.ts`

```typescript
// file: src/modules/items/items.quota.ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IRuntimeServices, MiddlewareFunction } from '@setu-ts/common';
import {
  createQuota,
  MemoryQuotaStore,
  QuotaExceededError,
  respondQuotaExceeded,
} from '@setu-ts/auth-plugin';
import type { IQuota, QuotaReservation } from '@setu-ts/auth-plugin';

/** Creates one lazy, per-principal archive budget per application. */
export function archiveQuota(): MiddlewareFunction {
  let quota: IQuota | undefined;
  return async (ctx, next) => {
    if (quota === undefined) {
      const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
      quota = createQuota({
        name: 'archive',
        window: 'utc-day',
        limit: 3,
        store: new MemoryQuotaStore(runtime),
        runtime,
      });
    }
    let reservation: QuotaReservation;
    try {
      reservation = await quota.reserve(ctx.request.user!.id, 2);
    } catch (error) {
      if (!(error instanceof QuotaExceededError)) throw error;
      respondQuotaExceeded(ctx, error);
      return;
    }
    try {
      await next();
    } catch (error) {
      // Thrown HTTP exceptions are formatted by the outer errorHandler.
      await quota.release(reservation);
      throw error;
    }
    if (ctx.response.snapshot().status >= 400) await quota.release(reservation);
    else await quota.settle(reservation, reservation.amount);
  };
}
```

## Generated wiring and entry

Keep these CLI-owned files byte-identical to `setu sync` output. They carry no custom parameters.

### `src/modules/index.ts`

```typescript
// file: src/modules/index.ts
/** CLI-owned; regenerated by setu generate module or setu generate … --module <name>. */
import type { IRouterApi, IServiceRegistry } from '@setu-ts/common';
import { registerItemsModule } from './items/index.ts';

/** Registers the feature routes. */
export function registerModules(router: IRouterApi, services?: IServiceRegistry): void {
  registerItemsModule(router, services);
}
```

### `src/modules/items/index.ts`

```typescript
// file: src/modules/items/index.ts
/** CLI-owned; regenerated by setu generate module or setu generate … --module <name>. */
import type { IRouterApi, IServiceRegistry } from '@setu-ts/common';
import { registerItemsRoutes } from './items.controller.ts';

/** Registers the feature routes. */
export function registerItemsModule(router: IRouterApi, services?: IServiceRegistry): void {
  registerItemsRoutes(router, services);
}
```

### `src/plugins/index.ts`

```typescript
// file: src/plugins/index.ts
// Generated by `setu generate plugin`.
// The CLI owns this file and rewrites it whenever an artifact is added, so edits
// here are lost — add them with the CLI.
//
// `setu.config.ts` consumes it as:
//
//   createApplication({ plugins: [/* … */, ...GENERATED_PLUGINS] })
//
// If you scaffolded this project before this seam existed, add those lines to
// wire generated artifacts in.

import type { IPlugin } from '@setu-ts/common';

/**
 * Every generated plugin, spread into `createApplication({ plugins })`.
 *
 * Array position does not decide registration order: the kernel resolves plugins
 * by their declared `dependencies`, and a generated plugin declares none. Delete a
 * plugin's file to stop registering it — this barrel is regenerated from the
 * directory, so removing the entry here alone would not survive.
 */
export const GENERATED_PLUGINS: readonly IPlugin[] = [];
```

### `src/middleware/index.ts`

```typescript
// file: src/middleware/index.ts
// Generated by `setu generate middleware`.
// The CLI owns this file and rewrites it whenever an artifact is added, so edits
// here are lost — add them with the CLI.
//
// `setu.config.ts` consumes it as:
//
//   for (const m of GENERATED_MIDDLEWARE) {
//     app.middleware.add(m.middleware, { priority: m.priority, name: m.name });
//   }
//
// If you scaffolded this project before this seam existed, add those lines to
// wire generated artifacts in.

import type { MiddlewareFunction } from '@setu-ts/common';

/** One generated middleware and the pipeline position its own module declares. */
export interface GeneratedMiddleware {
  /** Diagnostic name shown in pipeline introspection. */
  readonly name: string;
  /** Execution priority — lower runs earlier, so lower is outermost. */
  readonly priority: number;
  /** The middleware itself. */
  readonly middleware: MiddlewareFunction;
}

/** Every generated middleware, for `app.middleware.add(...)`. */
export const GENERATED_MIDDLEWARE: readonly GeneratedMiddleware[] = [];
```

### `src/health/index.ts`

```typescript
// file: src/health/index.ts
// Generated by `setu generate health-indicator`.
// The CLI owns this file and rewrites it whenever an artifact is added, so edits
// here are lost — add them with the CLI.
//
// `setu.config.ts` consumes it as:
//
//   HealthPlugin({ indicators: [...HEALTH_INDICATORS] })
//
// If you scaffolded this project before this seam existed, add those lines to
// wire generated artifacts in.

import type { HealthIndicatorEntry } from '@setu-ts/health-plugin';

/** Every generated health indicator, for `HealthPlugin({ indicators })`. */
export const HEALTH_INDICATORS: readonly HealthIndicatorEntry[] = [];
```

### `src/metrics/index.ts`

```typescript
// file: src/metrics/index.ts
// Generated by `setu generate metric`.
// The CLI owns this file and rewrites it whenever an artifact is added, so edits
// here are lost — add them with the CLI.
//
// `setu.config.ts` consumes it as:
//
//   MetricsPlugin({ customMetrics: [...CUSTOM_METRICS] })
//
// If you scaffolded this project before this seam existed, add those lines to
// wire generated artifacts in.

import type { NamedMetricConfig } from '@setu-ts/metrics-plugin';

/** Every generated metric definition, for `MetricsPlugin({ customMetrics })`. */
export const CUSTOM_METRICS: readonly NamedMetricConfig[] = [];
```

### `main.ts`

```typescript
// file: main.ts
/* eslint-disable no-console -- an example entry reports its startup failure. */
import { createApp } from './setu.config.ts';
import { createRuntimeServices } from '@setu-ts/runtime';
import { CAPABILITIES, describeError } from '@setu-ts/common';
import type { ILogger } from '@setu-ts/common';

// Built before the application, because the port is needed at start() and
// plugins do not register until then. Safe to hold alongside the application's
// own instance: runtime services are a stateless facade over platform globals.
const runtime = createRuntimeServices();

// A failed boot prints one line and exits 1. Left to the runtime's default
// printer, the error is dumped with every property it carries, and a malformed
// REDIS_URL's TypeError carries the URL, password included, as `input`.
async function boot() {
  const app = await createApp();
  await app.start({ port: Number(runtime.env.PORT ?? '3000') });
  return app;
}

const app = await boot().catch((error: unknown) => {
  console.error(`Startup failed: ${describeError(error)}`);
  return runtime.exit(1);
});

// Graceful shutdown. Without this the process dies from the signal itself and
// `app.stop()` never runs, so in-flight requests are cut, the service never
// deregisters from discovery, and no database or broker disconnects.
//
// Portable across every runtime: no `Deno`, no `process`, no OS check. On
// Windows `onSignal` is absent and this registers nothing, which is correct —
// Windows has no SIGTERM to catch.
//
// The logger is resolved only if one is registered: a project scaffolded
// without LoggerPlugin still shuts down cleanly, it just reports nothing.
const logger = app.services.has(CAPABILITIES.LOGGER)
  ? app.services.get<ILogger>(CAPABILITIES.LOGGER)
  : undefined;

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  runtime.onSignal?.(signal, () => {
    // The .catch is not optional: a rejecting onShutdown hook makes stop()
    // reject, and an unhandled rejection replaces the reason with a trace.
    void app
      .stop()
      .then(() => runtime.exit(0))
      .catch((error: unknown) => {
        logger?.error('Graceful shutdown failed', { error });
        runtime.exit(1);
      });
  });
}
```

## Security intent and scopes

This example uses
[resource-server authentication](./upgrading.md#resource-server-authentication-m132-setu-tsauth-plugin-setu-tscommon)
and `requireScopes('items:read')` / `requireScopes('items:write')`. A read-only token lists exactly
`list_items` and `read_item`; a read/write token sees all four. Roles, permissions and policy checks
still run on the route and do not filter the list.

Every tool needs explicit security intent: a branded guard, `publicRoute()`, or defined
`schema.security`. A security schema documents intent; it does not enforce authentication.
Idempotent tools also require an authenticating security brand. A hidden single call produces an
outer 401/403 Bearer challenge (`insufficient_scope` for an under-scoped token). An unknown tool
name produces JSON-RPC `-32602`.

Every present Origin, including a same-origin browser UI, must be explicitly listed in
`allowedOrigins`. The empty list accepts only requests with no Origin, such as desktop clients. To
permit a browser UI, list its exact origin, for example `https://console.example.com`. Unlisted
origins receive 403 before JSON parsing. The request's Host does not establish trust.

## Markers, explicit bindings and decorators

The feature above uses `mcpTool({ name, description })` markers. A marker can also supply `title`
and `repeatable: true`. Without a name it reads `schema.operationId`; descriptions fall back to
`schema.description`, then `schema.summary`. Names are never inferred from paths.

Alternatively, remove the marker and bind an exact method and registered path through `tools` in the
existing `McpPlugin` registration. Do not both mark and list the same route:

```typescript
import { McpPlugin } from '@setu-ts/mcp-plugin';

export const explicitMcp = McpPlugin({
  tools: [
    { name: 'read_item', description: 'Read an item', route: { method: 'GET', path: '/items/:id' } },
  ],
});
```

For a class controller, decorator-plugin provides method-only `@McpTool()`; its name defaults to
`@ApiOperation`'s operation id, then the method name. Its description has the same schema fallbacks.
Keep the controller's real authentication guards and rate limits when converting styles. Startup
refuses missing names/descriptions, duplicate or invalid names, ambiguous bindings, missing security
intent and an empty combined tool set.

## Idempotency and retries

POST/PATCH tools require `idempotent()` or explicit `repeatable: true`. POST/PUT/PATCH tools also
require branded body validation, even a small archive body. `repeatable: true` acknowledges that
repeating the handler is safe; it does not supply a stored replay.

For an idempotency-branded tool, MCP derives a key as `mcp-` plus base64url SHA-256 of canonical
JSON `[toolName, arguments]`. The store scopes the record by principal and tenant. Repeating an
intentional identical operation within its TTL also replays; use a changing argument such as a
client reference when a second operation is intended.

The default idempotency store is in-memory per process. A retry on another replica or after a
restart can execute again; an incomplete record can execute again after its lease expires. Use a
shared store as described in the [idempotency reference](../packages/idempotency-plugin/README.md),
and keep handlers safe to repeat where those windows matter. The item store is an unbounded local
demonstration store; replace it with a repository before deployment.

## Results and limits

Successful calls return structured content conforming to the object response schema plus a text
block containing the JSON. Read-only hints and idempotent hints are derived by the plugin. A missing
item returns an `isError` text result, `Not Found: Items not found.`. Validation refusals include
field lines and never a stack.

In this app's RFC 9457 error format, a rate refusal is exactly
`Quota Exceeded: Rate limit exceeded`. An archive quota refusal is exactly
`Quota Exceeded: The quota for this request is spent.`. MCP mapping drops HTTP headers such as
`Retry-After` and extension members such as `retry-after`; the client is not told when to retry. A
5xx or thrown internal error becomes a generic tool failure.

Set limits in the existing plugin registration, for example:

```typescript
import { McpPlugin } from '@setu-ts/mcp-plugin';

export const boundedMcp = McpPlugin({
  timeoutMs: 10_000,
  maxResultBytes: 262_144,
  allowedOrigins: [],
});
```

`timeoutMs` defaults to 30,000 ms (safe integer 1–600,000). A deadline aborts the inner request,
cancels result reading and returns `The tool timed out.`. A handler ignoring its signal can remain
in flight until it settles or the shutdown drain cap. `maxResultBytes` defaults to 1,048,576 bytes,
at most 64 MiB; excess cancels the response stream.

## Test with the official client

This complete test uses the generated factory and the official transport with `app.fetch`, so it
needs no listener. It signs an internal test credential and never logs it. The example's smoke
additionally covers hidden calls, validation, idempotent retries, rate limits, archive quota
accounting, separate principals/apps and one real socket Origin check.

### `mcp.test.ts`

```typescript
// file: mcp.test.ts
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createTestApp } from '@setu-ts/testing';
import { createApp } from './setu.config.ts';
import { issueDemoToken } from './token.ts';
import { ItemsResponse } from './src/modules/items/items.schemas.ts';

it('creates and reads through MCP', async () => {
  const app = await createTestApp({ app: createApp(), without: ['logger-plugin'] });
  const client = new Client({ name: 'guide-test', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } });
  try {
    const token = await issueDemoToken(app);
    await client.connect(new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
      fetch: (input, init) => app.fetch(new Request(input, init)),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }));
    assert.equal((await client.listTools()).tools.length, 4);
    const created = await client.callTool({ name: 'create_item', arguments: { name: 'Ada' } });
    const item = ItemsResponse.parse(created.structuredContent);
    const read = await client.callTool({ name: 'read_item', arguments: { id: item.id } });
    assert.deepEqual(read.structuredContent, item);
    assert.deepEqual(read.content, [{ type: 'text', text: JSON.stringify(item) }]);
  } finally {
    await client.close();
    await app.stop();
  }
});
```

Run it with `node --import tsx --test mcp.test.ts`. The generated project includes module and
application tests too; keep them and add authentication to their requests.

## Connect a desktop MCP client

### `token.ts`

This operator script issues a five-minute credential using the same environment and factory. It
writes the credential only when invoked explicitly; never add tokens to application logs.

```typescript
// file: token.ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IJwtService } from '@setu-ts/common';
import type { IKernelApplication } from '@setu-ts/kernel';
import { createApp } from './setu.config.ts';

/** Issues a five-minute local demo credential without logging it. */
export function issueDemoToken(
  app: IKernelApplication,
  scope = 'items:read items:write',
  sub = 'demo-user',
): Promise<string> {
  return app.services.get<IJwtService>(CAPABILITIES.JWT).sign({ sub, scope }, { expiresIn: '5m' });
}

// Explicit credential output for the operator; never put it in application logs.
if (import.meta.main) {
  const app = createApp();
  await app.start();
  try {
    process.stdout.write(
      `${await issueDemoToken(app, process.argv[2] ?? 'items:read items:write')}\n`,
    );
  } finally {
    await app.stop();
  }
}
```

In one terminal, configure a local secret and build/start the generated Node application:

```bash
env JWT_SECRET=replace-with-a-local-secret-at-least-32-characters npm run build
env JWT_SECRET=replace-with-a-local-secret-at-least-32-characters npm start
```

In another terminal, use the same secret to issue the short-lived credential:

```bash
env JWT_SECRET=replace-with-a-local-secret-at-least-32-characters npx tsx token.ts "items:read items:write"
```

Add an HTTP/Streamable HTTP server in your desktop MCP client's connection settings with URL
`http://localhost:3000/mcp` and an `Authorization: Bearer <the issued token>` header. For a
read-only connection, issue `items:read` instead. Refresh the credential after five minutes. Clients
differ in how they configure HTTP headers; use the client's own credential UI and keep tokens out of
checked-in configuration. No stdio bridge is part of this example.

## Runtimes

Node integration tests and one native Deno proof exercise list and call. The workerd condition has a
bundle-resolution proof; a live Workers run is a follow-on. Bun compatibility is unproven until the
0.13.0 artifacts are published and the compat row runs.

That paragraph is the package reference's verification status; 0.12.0 availability does not extend
those runtime proofs. This example targets Node. See the
[MCP package reference](../packages/mcp-plugin/README.md) for the complete option and refusal rules.
