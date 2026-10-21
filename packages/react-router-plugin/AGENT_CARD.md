# @setu-ts/react-router-plugin — React Router SSR inside the kernel

`setu add react-router` pins the package and prints a `ReactRouterPlugin({ serverBuildPath: … })`
line for `setu.config.ts`. Install `react-router` v8 in the application and build a server bundle;
the plugin loads both lazily. It registers `CAPABILITIES.SSR` during `app.start()` and mounts the
SSR catch-all.

```ts
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ReactRouterPlugin } from '@setu-ts/react-router-plugin';

export const app = createApplication({
  plugins: [
    RuntimePlugin(),
    ReactRouterPlugin({
      serverBuildPath: new URL('./build/server/index.js', import.meta.url).href,
      assetsDir: './build/client/assets',
      basename: '/',
      mode: 'production',
    }),
  ],
});
```

```ts
import { contextKeyFor, ReactRouterPlugin } from '@setu-ts/react-router-plugin';

const requestId = contextKeyFor<string | null>('request-id', null);

export const plugin = ReactRouterPlugin({
  serverBuildPath: '/srv/app/build/server/index.js',
  populateLoadContext: (ctx, context) => {
    context.set(requestId, ctx.request.headers.get('x-request-id'));
  },
});
```

- Supply exactly one build arm: `serverBuildPath` (absolute path or `file:` URL) or `serverBuild`
  (the imported module namespace, which is how a Workers bundle supplies it). Both or neither is a
  type error. `loadRequestHandler` is the seam for a dev server.
- Omitting `assetsDir` registers no asset route. `assetUrlPrefix` defaults to `'/assets/'`;
  `publicFiles` (on) also serves the client-build root, with revalidation rather than immutable
  caching.
- `basename` must match your `react-router.config.ts` `basename`. A route you name beats the
  catch-all, and a static segment beats a wildcard.
- Loaders read `context.get(servicesContext)` — an `IServiceRegistry | null` — and
  `context.get(userContext)` for the principal. Both keys are set on every SSR request.
- `contextKeyFor<T>(name, defaultValue)` returns one memoised key per name. A hand-written
  `{ defaultValue }` object matches nothing once Vite inlines a second copy.
- A refusal in route middleware on a document request renders through React Router's error boundary,
  not the kernel error responder.
