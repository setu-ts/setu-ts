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
import { createTestApp } from '@hono-enterprise/testing';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { createMockPlugin } from '@hono-enterprise/testing';
import { CAPABILITIES } from '@hono-enterprise/common';

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

## API Reference

- [`createTestApp`](../../PUBLIC_API.md#testing-package) — Test application factory
- [`createMockPlugin`](../../PUBLIC_API.md#testing-package) — Mock plugin builder
- [`inject`](../../PUBLIC_API.md#testing-package) — Free-function request injector
- [`createTestContext`](../../PUBLIC_API.md#testing-package) — Mock request context builder
- [`FixtureManager`](../../PUBLIC_API.md#testing-package) — Multi-mock fixture manager
- [`collectStream`](../../PUBLIC_API.md#testing-package) — Streaming response reader
