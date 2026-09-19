# @setu-ts/kernel

Plugin kernel for the Setu-TS framework: plugin registry, service registry, middleware pipeline,
router, and application lifecycle.

This package is the framework's orchestration layer. It resolves plugin dependencies, builds the
middleware pipeline and router, validates environment variables, and dispatches requests through the
pipeline to route handlers. It owns no runtime-specific behavior — every runtime operation goes
through `IRuntimeServices` provided by the runtime plugin.

## Installation

```bash
# Deno
deno add jsr:@setu-ts/kernel

# npm / pnpm / yarn / bun (via JSR's npm compatibility layer)
npx jsr add @setu-ts/kernel
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

Only the seven public exports listed above are part of the public API; all concrete classes are
internal.

## Kernel diagnostics (optional, since 0.8.0)

Pass `diagnostics` to `createApplication` to enable an optional, read-only view of application
composition and kernel execution, exposed as the pull-only `app.diagnostics` reader. An omitted
option allocates nothing — no collector, ring, or timer — and the property is absent.

```typescript
const app = createApplication({
  plugins: [RuntimePlugin()],
  // labels is the disclosure decision: a name appears ONLY when it exactly
  // matches an allowlist entry; everything else is projected as opaque ids.
  diagnostics: { labels: { plugins: ['catalog'], routes: ['/items'] } },
});
await app.start();

const snapshot = app.diagnostics!.snapshot(); // bounded composition view
let cursor = 0;
const poll = setInterval(() => {
  // Poll non-destructively: each read returns the events after `cursor`
  // (up to 128) and reports evicted records as `lost`. Other readers polling
  // at their own cursors are unaffected — reads never consume.
  const batch = app.diagnostics!.read(cursor, 128);
  cursor = batch.next;
}, 1000);
```

`snapshot()` and `read()` never resolve a lazy factory, invoke application code, or mutate state,
and everything they return is frozen. Timing is monotonic from runtime registration; records before
that carry `null` timings. Startup failure and final shutdown clear retained metadata — a reader
then sees only the coarse state, the failure code, and drop counters. Bounded by construction: 1,024
nodes / 4,096 edges / 256 KiB per snapshot, 1,024 events / 1,024 bytes per event, with
`droppedEvents` and `lost` reporting what did not fit. See
[`PUBLIC_API.md`](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#kernel-diagnostics-setu-tskernel--setu-tscommon)
for the full contract; `scripts/inspect-kernel.ts` in the repository is a runnable consumer.

## Usage

Create an application, register plugins, and start it:

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

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

## Options

`createApplication(options?)` takes one option:

| Option    | Type        | Default | Description                                    |
| --------- | ----------- | ------- | ---------------------------------------------- |
| `plugins` | `IPlugin[]` | `[]`    | Plugins registered before `start()` is called. |

Everything else is configured on the application itself: `app.register(plugin)` adds a plugin after
construction, `app.middleware.add()` installs global middleware, and `app.start({ port })` binds the
socket. `start()` with no `port` runs the full lifecycle without listening, which is what `inject()`
and the CLI's command discovery rely on.

## Rules

- No runtime-specific APIs — all timers, UUIDs, and clocks go through `IRuntimeServices`.
- No `console.*` — the kernel has no logger; it never logs.
- Listening requires both `CAPABILITIES.HTTP_ADAPTER` and a `port` option; otherwise `start()` skips
  server creation (so `inject()` and tests need no server).
- The kernel emits only bare 404/500 JSON; error formatting belongs to the exceptions package.
- A runtime provider is mandatory — `start()` fails fast if no plugin provides
  `CAPABILITIES.RUNTIME`.

See the repository's
[`PUBLIC_API.md`](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#createapplication-setu-tskernel)
for the full API contract and
[`ARCHITECTURE.md`](https://github.com/setu-ts/setu-ts/blob/main/ARCHITECTURE.md) for how this
package fits the plugin architecture.

## Exports

| Export                          | Kind      |
| ------------------------------- | --------- |
| `createApplication`             | function  |
| `ApplicationOptions`            | interface |
| `IKernelApplication`            | interface |
| `InjectRequest`                 | interface |
| `InjectResponse`                | interface |
| `KernelDiagnosticsLabelOptions` | interface |
| `KernelDiagnosticsOptions`      | interface |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.
