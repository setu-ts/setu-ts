# @setu-ts/testing — in-process test applications and doubles

`setu add testing` adds a dev dependency only; it registers nothing. Import the helpers in test
files and use `createTestApp` instead of listening on a socket.

```ts
import { createTestApp } from '@setu-ts/testing';
import { RuntimePlugin } from '@setu-ts/runtime';

export async function makeApp() {
  const app = await createTestApp({ plugins: [RuntimePlugin()] });
  app.router.get('/users', (ctx) => ctx.response.json([{ id: 1 }]));
  return app;
}
```

To test the composition production actually ships, build from the project's own root:

```ts
import { CAPABILITIES } from '@setu-ts/common';
import { createTestApp, overrideCapability } from '@setu-ts/testing';
import { createApp } from '../setu.config.ts';

export async function makeSubstitutedApp() {
  return await createTestApp({
    app: createApp(),
    overrides: [overrideCapability(CAPABILITIES.MAIL, { send: async () => undefined })],
  });
}
```

- `TestAppOptions` is a union of two arms: `plugins` (hand-assembled) or `app` (composition root),
  never both. The `plugins` arm must include `RuntimePlugin()` when `autoStart` is true.
- `autoStart` defaults to true. Set `autoStart: false` to add global middleware or register more
  plugins, then call `app.start()` yourself.
- `without: ['database']` removes plugins by exact `name` before startup; a misspelling throws
  naming the entry instead of silently testing the real plugin. Removal prevents the provider's
  eager side effects; `overrides` then appends replacement plugins.
- `overrideCapability(token, service)` replaces a live single-provider capability. It cannot undo
  the real provider's `register` hook, and multi-provider capabilities are refused — remove their
  plugin instead.
- `createMockPlugin` PROVIDES a capability (it declares `provides`) and is refused beside the real
  provider; use it only where the real plugin is absent. `overrideProvider(token, provider)` does
  the same for DI-container providers and needs `CAPABILITIES.DI_CONTAINER`.
- `inject(app, request)` accepts a URL string, an object or a web `Request`;
  `collectStream(response)` reads a streaming body into `chunks` and `text`. `MockServiceRegistry`,
  `MockResponse` and `FixtureManager` cover registry, response and fixture unit scope.
