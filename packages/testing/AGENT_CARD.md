# @setu-ts/testing — exercise applications and middleware

**Add it:** `setu add testing` adds a dev dependency; it registers no plugin and provides no
capability.

## Test the scaffold's real composition

Pass the unstarted application from your config to this test helper:

```ts
import { createTestApp } from '@setu-ts/testing';
import type { IKernelApplication } from '@setu-ts/testing';

export async function checkGreeting(app: IKernelApplication): Promise<void> {
  const testApp = await createTestApp({ app });
  try {
    const response = await testApp.inject({ method: 'GET', url: '/greeting' });
    if (response.statusCode !== 200) throw new Error(response.body ?? 'Request failed');
  } finally {
    await testApp.stop();
  }
}
```

## Test a middleware without starting an application

```ts
import type { MiddlewareFunction } from '@setu-ts/common';
import { createTestContext } from '@setu-ts/testing';

export async function checkMiddleware(middleware: MiddlewareFunction): Promise<void> {
  const ctx = createTestContext({ request: { method: 'GET', path: '/private' } });
  let continued = false;
  await middleware(ctx, async () => { continued = true; });
  if (continued) throw new Error('Expected middleware to refuse');
  if (ctx.response.snapshot().status !== 401) throw new Error('Expected 401');
}
```

## Behaviour the types do not show

- `autoStart` defaults to true and starts without binding a socket. The plugins arm must include a
  runtime provider; no plugins are installed implicitly.
- `createTestApp` returns `IKernelApplication`; `inject` resolves `statusCode`, `headers`, `body`
  (`string | null`) and `json<T>()`. `stop()` stops plugin workers.
- Use `autoStart: false` to add global middleware or more plugins before starting.
- `without` checks every exact plugin name before removing anything; an unknown name throws.
- `overrideCapability` cannot undo the real provider's registration side effects, and refuses
  missing or multi-provider capabilities during initialization.
- `createMockPlugin` provides a missing capability; alongside a real provider it causes a
  duplicate-provider startup error.

## Other options

- `createTestApp({ plugins })` builds an isolated composition instead of adopting `app`.
- `overrideProvider` replaces a DI provider; `MockServiceRegistry` and `MockResponse` are doubles.
- `inject` accepts a URL, request options or web request; `collectStream` reads streaming bodies.

<!-- card-allow: json stop -->
