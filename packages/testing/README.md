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

| Option      | Type        | Default | Behavior                                                                        |
| ----------- | ----------- | ------- | ------------------------------------------------------------------------------- |
| `plugins`   | `IPlugin[]` | `[]`    | Pre-registered before `start()`. Must include a `runtime` capability provider.  |
| `autoStart` | `boolean`   | `true`  | `false` returns the un-started app, needed to add plugins or global middleware. |

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
