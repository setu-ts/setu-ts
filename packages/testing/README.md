# @hono-enterprise/testing

First-party testing utilities for the Hono Enterprise framework.

## Installation

```bash
deno add jsr:@hono-enterprise/testing
```

## Usage

### createTestApp

Creates a started test application that can be exercised via `inject()` and `fetch()` without
binding a socket.

```typescript
import { createMockPlugin, createTestApp } from '@hono-enterprise/testing';
import { RuntimePlugin } from '@hono-enterprise/runtime';

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
import { inject } from '@hono-enterprise/testing';

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

### createMockPlugin

Creates an `IPlugin` that registers a mock service under a capability token.

```typescript
import { createMockPlugin } from '@hono-enterprise/testing';

const mockDb = createMockPlugin({
  name: 'database',
  service: { query: () => [], connect: () => {} },
});
```

### createTestContext

Builds a contract-faithful `IRequestContext` for unit-testing middleware and handlers in isolation.

```typescript
import { createTestContext } from '@hono-enterprise/testing';

const ctx = createTestContext();
expect(ctx.id).toBe('test-ctx');
expect(ctx.startTime).toBe(0); // monotonic, never Date.now()
```

### FixtureManager

Collects mocks and plugins, produces `IPlugin[]`, resets between tests.

```typescript
import { createTestApp, FixtureManager } from '@hono-enterprise/testing';
import { RuntimePlugin } from '@hono-enterprise/runtime';

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

See [Testing Package](../../PUBLIC_API.md#testing-package-hono-enterprisetesting) in PUBLIC_API.md
for the full option tables and notes.

## API Reference

- [`createTestApp`](../../PUBLIC_API.md#testing-package-hono-enterprisetesting) — Test application
  factory
- [`createMockPlugin`](../../PUBLIC_API.md#testing-package-hono-enterprisetesting) — Mock plugin
  builder
- [`inject`](../../PUBLIC_API.md#testing-package-hono-enterprisetesting) — Free-function request
  injector
- [`createTestContext`](../../PUBLIC_API.md#testing-package-hono-enterprisetesting) — Mock request
  context builder
- [`MockServiceRegistry` / `MockResponse`](../../PUBLIC_API.md#testing-package-hono-enterprisetesting)
  — Kernel-faithful doubles
- [`FixtureManager`](../../PUBLIC_API.md#testing-package-hono-enterprisetesting) — Multi-mock
  fixture manager
- [`collectStream`](../../PUBLIC_API.md#testing-package-hono-enterprisetesting) — Streaming response
  reader
