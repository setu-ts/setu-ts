# @setu-ts/react-router-plugin — serve React Router pages

**Add it:** `setu add react-router` adds it and prints the registration for `setu.config.ts`.
`ReactRouterPlugin` provides `CAPABILITIES.SSR` (`ISsrService`); the application supplies a React
Router 8 server build and installs its runtime.

## Mount a built frontend

Put this plugin in the config's plugins array:

```ts
import { ReactRouterPlugin } from '@setu-ts/react-router-plugin';

export const frontend = ReactRouterPlugin({
  serverBuildPath: new URL('./build/server/index.js', import.meta.url).href,
  assetsDir: './build/client/assets',
  basename: '/',
  mode: 'production',
});
```

## Read kernel services in a loader

Put this in the frontend route module:

```ts
import { getService } from '@setu-ts/react-router-plugin';
import { PRODUCTS } from '~kernel/modules/products/products.token.ts';

export async function loader({ context }: Route.LoaderArgs) {
  return { products: await getService(context, PRODUCTS).list() };
}
```

`getService` resolves through `resolveRequestService` (`@setu-ts/common`): a module registered with
`requestService` is built once per request and shared with kernel routes in that request.

## Behaviour the types do not show

- The build and runtime load lazily during startup; `serverBuildPath` must be absolute or a file
  URL.
- Omitting `assetsDir` mounts no asset route. The default `assetUrlPrefix` is `/assets/`.
- `publicFiles` defaults to true: client-build root files use revalidation caching.
- `basename` must match the frontend config; specific kernel routes beat the SSR catch-all.
- Every SSR request sets `servicesContext`, `userContext` and `serviceResolverContext`; anonymous
  users resolve to null. `getService` throws `ServiceResolverUnavailableError` outside a request.
- Route-middleware refusals on document requests render through React Router's error boundary.

## Other options

- `serverBuild` takes the module namespace instead of a path, for bundled Workers applications.
- `populateLoadContext` adds values; use `contextKeyFor` for keys shared with the frontend build.
- `loadRequestHandler` injects a runtime for a development server; `publicFiles: false` serves only
  assets.
