# @setu-ts/testing

First-party testing utilities for the Setu-TS framework.

## Installation

```bash
deno add jsr:@setu-ts/testing
```

## Usage

### createTestApp

Creates a started test application that can be exercised via `inject()` and `fetch()` without
binding a socket.

```typescript
import { createMockPlugin, createTestApp } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';

const app = await createTestApp({
  plugins: [
    RuntimePlugin(),
    createMockPlugin({ name: 'database', service: { query: () => [] } }),
  ],
});

app.router.get('/users', (ctx) => ctx.response.json([{ id: 1 }]));
const res = await app.inject({ method: 'GET', url: '/users' });
console.log(res.statusCode); // 200
```

> **`plugins` must include a runtime provider.** This package depends only on `common` and `kernel`,
> so it cannot supply `RuntimePlugin` for you, and the kernel requires the `runtime` capability at
> `start()`. `await createTestApp()` with no plugins rejects with
> `No plugin provides the mandatory 'runtime' capability`.
>
> **Global middleware needs `autoStart: false`.** `start()` compiles the pipeline, after which
> `app.middleware.add(...)` throws. Routes are unaffected — `app.router.get(...)` works on a started
> app.
>
> **Unhandled errors answer in the kernel's fallback format.** `createTestApp` does not install
> `errorHandler` (this package depends only on `common` and `kernel`, not `exceptions`), so an
> unhandled error returns the kernel's `{ error, detail? }` fallback body, not RFC 9457.
>
> `errorHandler(...)` from `@setu-ts/exceptions` is a **middleware**, not a plugin — it cannot be
> passed to `plugins` (which accepts `IPlugin[]` and would throw
> `TypeError: plugin.register is not a function` at `start()`). Register it on an un-started app,
> then start:
>
> ```typescript
> import { createTestApp } from '@setu-ts/testing';
> import { RuntimePlugin } from '@setu-ts/runtime';
> import { errorHandler } from '@setu-ts/exceptions';
>
> const app = await createTestApp({
>   plugins: [RuntimePlugin()],
>   autoStart: false,
> });
>
> app.middleware.add(errorHandler({ format: 'rfc9457' }), {
>   priority: 0,
>   name: 'error-handler',
> });
>
> await app.start();
> ```
>
> Once registered, the responder seam governs the kernel's own 404/500 terminals too.
>
> **The `app:` arm dissolves this.** An application built from the project's own composition root
> already carries whatever `errorHandler` that root registered, so its error bodies are the ones
> production serves. This package deliberately installs no responder of its own: it depends on
> `common` and `kernel` only, so a default would mean a second RFC 9457 formatter that
> `@setu-ts/exceptions`' own tests do not drive.

### Building from the composition root

`createTestApp` has a second arm. Pass `app` instead of `plugins` and the test starts from the
application the project actually ships — the `createApp()` a scaffolded project exports from
`setu.config.ts`, or a starter factory's return value — then subtracts from it:

```typescript
import { createTestApp, overrideCapability } from '@setu-ts/testing';
import { CAPABILITIES } from '@setu-ts/common';
import { createApp } from '../setu.config.ts';

const app = await createTestApp({
  app: createApp(),
  without: ['database'],
  overrides: [overrideCapability(CAPABILITIES.MAIL, fakeMailer)],
});
```

Everything the root registered is present: its middleware, its error handling, its health
indicators, its route ordering. A test therefore observes the composition production has rather than
a second one assembled by hand — which is what the `plugins` arm inevitably drifts into.

The two arms are mutually exclusive: `TestAppOptions` is a union, so supplying both `plugins` and
`app` is a compile error rather than a runtime throw.

**`without` and `overrides` do different things, and the difference matters.**

|                                                 | `without`                            | `overrides`                             |
| ----------------------------------------------- | ------------------------------------ | --------------------------------------- |
| When                                            | Before `start()`                     | After `start()` has run the real plugin |
| Effect                                          | The plugin's `register()` never runs | The plugin's service is replaced        |
| Eager side effects (`connect()`, a broker dial) | Prevented                            | **Already happened**                    |

`DatabasePlugin.register()` calls `adapter.connect()`, so an override leaves a real connection
attempt in place. Use `without` when you need the plugin not to run at all, and `overrides` when you
want it composed but serving a double.

`without` throws naming an entry the application does not hold. A silently ignored
`without: ['databse']` would run the whole test against the real plugin while reporting success.

### overrideCapability

Creates a plugin that **replaces** an already-provided capability, leaving the rest of the
composition intact.

```typescript
import { overrideCapability } from '@setu-ts/testing';
import { CAPABILITIES } from '@setu-ts/common';

const app = createApp();
app.register(overrideCapability(CAPABILITIES.MAIL, { send: () => Promise.resolve() }));
await app.start();
```

It applies the three constraints that make a replacement plugin work: it declares no `provides` (a
second declaration of a live token is refused before any plugin runs), it registers with
`{ override: true }`, and it carries a priority above `PLUGIN_PRIORITY.LOWEST` so it wins regardless
of the replaced plugin's own band.

It **throws at `register()` when nothing provides the token**. Without that check a mistyped token
would register the double under a nonsense name, leave the real service serving, and let the test
pass against the real dependency.

> **`overrideCapability` replaces, `createMockPlugin` provides.** `createMockPlugin` declares the
> token in `provides` — which is what satisfies a dependent plugin's `dependencies` check, and which
> the kernel refuses when a real plugin already declares it
> (`Capability 'database' is provided by both 'database' and 'database-mock'`). Use it in an
> application that does not register the real plugin.

### inject

Free-function HTTP request injector with string, `InjectRequest`, and web-standard `Request`
shorthand.

```typescript
import { inject } from '@setu-ts/testing';

// String shorthand (GET only)
const res = await inject(app, '/users');

// POST with JSON body
const res2 = await inject(app, {
  method: 'POST',
  url: '/users',
  body: { name: 'test' },
});

// Web Request
const req = new Request('http://localhost/users', {
  method: 'POST',
  body: JSON.stringify({ name: 'test' }),
});
const res3 = await inject(app, req);
```

> A `Request` body is a one-shot stream. Injecting one consumes it, so the same `Request` cannot be
> injected twice or injected and then handed to `app.fetch()` — the second call throws and names the
> cause rather than quietly sending no body. Build a separate `Request` per call.

### createMockPlugin

Creates an `IPlugin` that registers a mock service under a capability token.

```typescript
import { createMockPlugin } from '@setu-ts/testing';

const mockDb = createMockPlugin({
  name: 'database',
  service: { query: () => [], connect: () => {} },
});
```

### createTestContext

Builds a contract-faithful `IRequestContext` for unit-testing middleware and handlers in isolation.

```typescript
import { createTestContext } from '@setu-ts/testing';

const ctx = createTestContext();
expect(ctx.id).toBe('test-ctx');
expect(ctx.startTime).toBe(0); // monotonic, never Date.now()
```

### FixtureManager

Collects mocks and plugins, produces `IPlugin[]`, resets between tests.

```typescript
import { createTestApp, FixtureManager } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';

const fixtures = new FixtureManager();

beforeEach(async () => {
  fixtures
    .mock('database', { query: () => [] })
    .mock('cache', { get: () => null });

  const app = await createTestApp({
    plugins: [RuntimePlugin(), ...fixtures.plugins()],
  });
});

afterEach(() => fixtures.reset());
```

## Configuration Options

`createTestApp(options?: TestAppOptions)`:

A union of two mutually exclusive arms.

`TestAppFromPlugins` — assemble by hand:

| Option      | Type        | Default | Behavior                                                                        |
| ----------- | ----------- | ------- | ------------------------------------------------------------------------------- |
| `plugins`   | `IPlugin[]` | `[]`    | Pre-registered before `start()`. Must include a `runtime` capability provider.  |
| `autoStart` | `boolean`   | `true`  | `false` returns the un-started app, needed to add plugins or global middleware. |

`TestAppFromApp` — start from the composition root:

| Option      | Type                 | Default  | Behavior                                                                                                         |
| ----------- | -------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `app`       | `IKernelApplication` | required | An already-constructed, not-yet-started application.                                                             |
| `without`   | `readonly string[]`  | `[]`     | Plugin names dropped before `start()`, so their `register()` never runs. Throws on a name the app does not hold. |
| `overrides` | `readonly IPlugin[]` | `[]`     | Plugins appended after `without` — usually `overrideCapability` results.                                         |
| `autoStart` | `boolean`            | `true`   | As above.                                                                                                        |

`overrideCapability(token: CapabilityToken, service: object)` takes no options; it throws at
`register()` when nothing provides `token`.

`createMockPlugin(options: MockPluginOptions)`:

| Option     | Type                                             | Default  | Behavior                                               |
| ---------- | ------------------------------------------------ | -------- | ------------------------------------------------------ |
| `name`     | `string`                                         | required | Plugin name, and the token when `provides` is omitted. |
| `service`  | `object`                                         | required | The mock service registered under the token.           |
| `provides` | `string`                                         | `name`   | Capability token override.                             |
| `priority` | `number`                                         | omitted  | Registration priority.                                 |
| `register` | `(ctx: IPluginContext) => void \| Promise<void>` | omitted  | Extra registration after the service.                  |

`createTestContext(options?: TestContextOptions)` accepts `request`, `body`, `runtime`, `startTime`,
`services`, `response`, `params`, `query`, `state` and `signal`. `startTime` takes precedence over
`runtime.hrtime()` and must be a monotonic reading — never `Date.now()`. `signal` precedence is
`request.signal` > `signal` > a live never-aborting signal, matching the kernel.

See
[Testing Package](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#testing-package-setu-tstesting)
in PUBLIC_API.md for the full option tables and notes.

## API Reference

- [`createTestApp`](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#testing-package-setu-tstesting)
  — Test application factory
- [`createMockPlugin`](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#testing-package-setu-tstesting)
  — Mock plugin builder
- [`overrideCapability`](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#testing-package-setu-tstesting)
  — Capability replacement plugin builder
- [`inject`](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#testing-package-setu-tstesting)
  — Free-function request injector
- [`createTestContext`](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#testing-package-setu-tstesting)
  — Mock request context builder
- [`MockServiceRegistry` / `MockResponse`](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#testing-package-setu-tstesting)
  — Kernel-faithful doubles
- [`FixtureManager`](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#testing-package-setu-tstesting)
  — Multi-mock fixture manager
- [`collectStream`](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#testing-package-setu-tstesting)
  — Streaming response reader

## Exports

| Export                | Kind      |
| --------------------- | --------- |
| `collectStream`       | function  |
| `createMockPlugin`    | function  |
| `createTestApp`       | function  |
| `createTestContext`   | function  |
| `inject`              | function  |
| `overrideCapability`  | function  |
| `FixtureManager`      | class     |
| `MockResponse`        | class     |
| `MockServiceRegistry` | class     |
| `IKernelApplication`  | interface |
| `InjectRequest`       | interface |
| `InjectResponse`      | interface |
| `MockPluginOptions`   | interface |
| `StreamingBody`       | interface |
| `TestAppFromApp`      | interface |
| `TestAppFromPlugins`  | interface |
| `TestContextOptions`  | interface |
| `TestAppOptions`      | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.
