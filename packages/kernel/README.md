# @hono-enterprise/kernel

Plugin kernel for the Hono Enterprise framework: plugin registry, service registry, middleware
pipeline, router, and application lifecycle.

This package is the framework's orchestration layer. It resolves plugin dependencies, builds the
middleware pipeline and router, validates environment variables, and dispatches requests through the
pipeline to route handlers. It owns no runtime-specific behavior — every runtime operation goes
through `IRuntimeServices` provided by the runtime plugin.

## Installation

```bash
# Deno
deno add jsr:@hono-enterprise/kernel

# npm / pnpm / yarn / bun (via JSR's npm compatibility layer)
npx jsr add @hono-enterprise/kernel
```

## What's Inside

| Area              | Exports                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| Application       | `createApplication()`, `ApplicationOptions`, `IKernelApplication`, `InjectRequest`, `InjectResponse` |
| Plugin resolution | `resolvePluginOrder()` (internal), dependency topological sort, cycle detection                      |
| Service registry  | `ServiceRegistry` (internal), single/multi/lazy-factory registrations, request-scoped children       |
| Middleware        | `MiddlewarePipeline` (internal), priority-ordered execution, short-circuit, double-next guard        |
| Router            | `Router` (internal), 7 verbs, route groups, static-over-param matching preference                    |
| Lifecycle         | `LifecycleManager` (internal), init/bootstrap/shutdown (LIFO)/close + request/response/error         |

Only the five public exports listed above are part of the public API; all concrete classes are
internal.

## Usage

Create an application, register plugins, and start it:

```typescript
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';

const app = createApplication({
  plugins: [RuntimePlugin()],
});

app.router.get('/health', (ctx) => ctx.response.json({ status: 'ok' }));

await app.start({ port: 3000 });
```

Test without a server using `inject()`:

```typescript
const res = await app.inject({ method: 'GET', url: 'http://localhost/health' });
console.log(res.statusCode, res.json());
```

## Rules

- No runtime-specific APIs — all timers, UUIDs, and clocks go through `IRuntimeServices`.
- No `console.*` — the kernel has no logger; it never logs.
- Listening requires both `CAPABILITIES.HTTP_ADAPTER` and a `port` option; otherwise `start()` skips
  server creation (so `inject()` and tests need no server).
- The kernel emits only bare 404/500 JSON; error formatting belongs to the exceptions package.
- A runtime provider is mandatory — `start()` fails fast if no plugin provides
  `CAPABILITIES.RUNTIME`.

See the repository's [`PUBLIC_API.md`](../../PUBLIC_API.md) for the full API contract and
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) for how this package fits the plugin architecture.
