# @setu-ts/react-router-plugin

Behind a reverse proxy, the request bridge uses `publicRequestUrl(ctx)` from `@setu-ts/common` so
loaders and actions see the public protocol and host when IP security has resolved them. Register
`HttpSecurityPlugin({ ipSecurity: { trustProxy: true, trustedProxies: [...] } })` with the addresses
of your proxies; choose `forwardedHeader: 'forwarded'` if they write RFC 7239 instead of
`X-Forwarded-*`. With no IP security middleware, the bridge uses the original request URL, so behind
a TLS-terminating proxy **every action answers 400**: React Router's own origin check compares the
browser's `https` origin with the internal `http` URL (V10-41). A `setu new --template full-stack`
project reads the `TRUSTED_PROXIES` setting (a comma-separated CIDR list; empty leaves IP security
off) and configures this for you (M119c). Use a configured base URL for security-sensitive links
such as password resets. See
[deployment behind a reverse proxy](https://github.com/setu-ts/setu-ts/blob/main/docs/deployment.md#behind-a-reverse-proxy).

React SSR and file-based routing, by embedding **React Router 8 framework mode** as a plugin over a
kernel catch-all handler. Registers an `SsrService` under `CAPABILITIES.SSR` (`'ssr'`).

Your React routes and your API routes live in one application, on one port, sharing the same plugin
services.

## Installation

```typescript
import { ReactRouterPlugin } from '@setu-ts/react-router-plugin';
```

`react-router` is an **optional** dependency, lazily imported alongside your compiled `ServerBuild`.

## Usage

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ReactRouterPlugin } from '@setu-ts/react-router-plugin';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    ReactRouterPlugin({
      serverBuildPath: './build/server/index.js',
      assetsDir: './build/client/assets',
    }),
  ],
});
await app.start({ port: 3000 });
```

## Options

<!-- version:history -->

| Option               | Type       | Default      | Description                                                                                                                                                                                                                                                               |
| -------------------- | ---------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serverBuildPath`    | `string`   | —            | Path to the compiled `ServerBuild`. Exactly one of `serverBuildPath`/`serverBuild` is supplied (a union `type` since 0.10.0). Correct for the socket targets; on Cloudflare Workers supply `serverBuild` — a bundled Worker cannot resolve `new URL(…, import.meta.url)`. |
| `serverBuild`        | `unknown`  | —            | The namespace of the compiled `ServerBuild`, supplied as a module (0.10.0) — the form a bundled Cloudflare Worker uses; the generated full-stack entry imports `../build/server/index.js` and passes it.                                                                  |
| `basename`           | `string`   | `'/'`        | Mount point for the SSR catch-all.                                                                                                                                                                                                                                        |
| `assetsDir`          | `string`   | —            | Directory served as static assets. Omitted → no asset route is registered at all.                                                                                                                                                                                         |
| `assetUrlPrefix`     | `string`   | `'/assets/'` | URL prefix the asset route claims. Read only when `assetsDir` is set.                                                                                                                                                                                                     |
| `publicFiles`        | `boolean`  | `true`       | Also serve files from the client build ROOT (Vite copies `public/` there — `robots.txt`, `favicon.ico`) with `must-revalidate`, not `immutable`: those files are not content-hashed. `false` restores prefix-only behaviour.                                              |
| `loadRequestHandler` | `function` | lazy import  | Injectable seam; defaults to importing `react-router` plus the build.                                                                                                                                                                                                     |

On Cloudflare Workers leave `assetsDir` unset — there is no `runtime.fs`, so the asset handler has
nothing to read, and omitting it registers no route rather than throwing. The server build arrives
as a module: supply `serverBuild` (the generated full-stack Workers entry does this) rather than
`serverBuildPath`, whose `new URL(…, import.meta.url)` form cannot resolve in a bundled Worker.

## Toolchain note

The frontend builds with **Vite on the Node/npm toolchain**. Vite is an app-level, build-time
`devDependency`; this plugin never imports it. Keep framework packages and workspace libraries
external, resolved by the server runtime, so route modules and the entry share one module instance:
context keys from `contextKeyFor()` match by identity. In development, `viteDevExternals` supplies
that guarantee; see
[the development guide](https://github.com/setu-ts/setu-ts/blob/main/docs/react-router-dev.md).

## Loader context

The default load context carries two keys — `servicesContext` and `userContext` — so a loader can
reach any registered capability:

```typescript
import { servicesContext, userContext } from '@setu-ts/react-router-plugin';
import type { RouterLoadContext } from '@setu-ts/react-router-plugin';
import { CAPABILITIES, type ICacheStore } from '@setu-ts/common';

export async function loader({ context }: { context: RouterLoadContext }) {
  const services = context.get(servicesContext);
  const user = context.get(userContext); // null when anonymous
  const cache = services?.get<ICacheStore>(CAPABILITIES.CACHE);
  return { user, featured: await cache?.get('featured') };
}
```

Override it with `populateLoadContext` to add your own keys.

`servicesContext` suits plain registered services, as above. For a module's request-bound service
use `getService` below: the registry holds such a service as its `requestService` wrapper, so
`services.get(TOKEN)` returns the wrapper rather than the service.

### `getService` — a request-bound kernel service in one line

<!-- version:history -->

Since 0.12.0 the context also carries a resolver bound to the current request (never the kernel
request context itself). `getService(context, token)` resolves through `resolveRequestService` from
`@setu-ts/common`, so a module's request-bound service is built once per request and the page and a
kernel `/api` route resolving the same token in that request share one instance:

```typescript
import { requestServiceToken } from '@setu-ts/common';
import { getService, type RouterLoadContext } from '@setu-ts/react-router-plugin';

interface ProductsService {
  list(): Promise<readonly { name: string }[]>;
}
// In a scaffolded project this lives in src/modules/products/products.token.ts.
const PRODUCTS = requestServiceToken<ProductsService>('module.products');

export async function loader({ context }: { context: RouterLoadContext }) {
  return { products: await getService(context, PRODUCTS).list() };
}
```

It throws `ServiceResolverUnavailableError` outside a request this plugin served. In a page test,
set `serviceResolverContext` on the `RouterContextProvider` to a fake `ServiceResolver`.

### Declaring your own context keys — always with `contextKeyFor`

A hand-written `{ defaultValue }` literal type-checks and then **silently returns its default**:
keys are matched by identity, and in a framework-mode application the declaring module exists twice
(Vite inlines application modules into the server build while the kernel loads `setu.config.ts` from
source), so two identical-looking literals match nothing and `context.get()` answers the default
with no error anywhere. Construct every key through [`contextKeyFor`](#full-api), which resolves by
name so both copies share one object:

```typescript
// app/server/context-keys.server.ts
import { contextKeyFor } from '@setu-ts/react-router-plugin';
import type { ISession } from '@setu-ts/common';

export const sessionContext = contextKeyFor<ISession | null>('app.session', null);
```

## Refusals and the error responder

React Router document requests and kernel API routes use different error protocols. A route
middleware refusal is rendered by the route's React Router `ErrorBoundary` as HTML with the thrown
status. The kernel `errorHandler({ format: 'rfc9457' })` continues to govern kernel routes and
responder terminals; the plugin does not rewrite a route boundary's HTML into Problem Details.

For document navigation, throw `redirect('/login')` when the user is anonymous or
`data(..., { status: 403 })` when the page is forbidden.

### `serviceCall` and `pageAction` — a service refusal keeps its status

React Router answers any error thrown from a loader or an action with 500, except a thrown
`Response`. A module service refuses with a 4xx `HttpError` (`notFound`, `conflict`, …) or another
error carrying a 4xx status hint, and two helpers keep that refusal a refusal:

```ts
import { redirect } from 'react-router';
import { getService, pageAction, serviceCall, type RouterLoadContext } from '@setu-ts/react-router-plugin';
import { ORDERS } from '~kernel/modules/orders/orders.token.ts';

export async function loader({ request, context }: { request: Request; context: RouterLoadContext }) {
  // A refusal is thrown as an RFC 9457 Problem Details Response with its status.
  return { orders: await serviceCall(request, () => getService(context, ORDERS).list()) };
}

export async function action({ request, context }: { request: Request; context: RouterLoadContext }) {
  const form = await request.formData();
  const orders = getService(context, ORDERS);
  const input = orders.parse({ name: form.get('name') });
  if (typeof input === 'string') return { error: input };
  // A refusal comes back to the form as { ok: false, error, status }.
  const result = await pageAction('create', () => orders.create(input));
  return result.ok ? redirect('/orders', 303) : { error: result.error };
}
```

`serviceCall(request, work)` throws the refusal as `application/problem+json` with `type`, `title`,
`status`, `detail` and `instance`, and `cache-control: private, no-store`. A resource route returns
it as is; a page's error boundary receives it as a route error response with that status (its `data`
is the JSON text, since React Router parses only `application/json`). React Router does not pass a
thrown `Response` to the server entry's `handleError`, so a refusal is not logged as a fault.
`pageAction(intent, work)` returns `{ ok: true, intent, value }` or, for a refusal,
`{ ok: false, intent, error, status }` with the refusal's caller-safe detail. Any other error, a 5xx
included, is rethrown by both.

A route module with no default component is a resource route: its loader or action returns any
`Response`, so files, images, PDFs and streams are served from one without a kernel `/api` route.
[Pages that write through actions](https://github.com/setu-ts/setu-ts/blob/main/docs/pages.md)
covers forms, uploads, downloads, streams, sign-out and testing.

## Protecting page actions

Every page is served by one kernel catch-all route, so route-level middleware such as
`rateLimitMiddleware`, `requirePolicy`, `requireScopes`, `idempotent()` or an upload limit does not
reach a page's loader or action by default. `pagePolicies` attaches ordinary Setu middleware to a
page by its React Router **route id**:

```typescript
import { rateLimitMiddleware } from '@setu-ts/auth-plugin';
import { ReactRouterPlugin } from '@setu-ts/react-router-plugin';

export const frontend = ReactRouterPlugin({
  serverBuildPath: new URL('./build/server/index.js', import.meta.url).href,
  assetsDir: './build/client/assets',
  pagePolicies: {
    // Five sign-in attempts a minute per caller; page views are not limited.
    'routes/_auth/login': {
      on: 'action',
      middleware: [rateLimitMiddleware({ windowMs: 60_000, max: 5 })],
    },
  },
});
```

- **Matched by React Router's own rules.** The plugin matches each request with the `matchRoutes` of
  the `react-router` module that serves it, after the same `.data` normalization, so a policy
  applies to the document request (`/login`), the single-fetch request (`/login.data`, `/_.data`)
  and an index action (`?index`) alike. Guarding a page by its path instead misses those shapes.
- **Layouts and the root apply beneath them.** A policy on a layout route or on `root` runs for
  every page under it; when several match, they run outer first. A `POST` to a layout's path without
  `?index` also runs its index child's policy, as React Router runs that child's middleware. Two
  more cases err the same way: an `'all'` policy also runs on an `OPTIONS` request, which React
  Router refuses with `405`, and a policy on `root` runs for every catch-all request, including one
  that matches no page. The one exception is React Router's route-discovery manifest request
  (`/__manifest` under the basename), which React Router answers before any route middleware; it
  carries route metadata, not loader or action data.
- **`on`** says what the policy guards. `'action'` runs it on every request React Router treats as a
  mutation (`POST`, `PUT`, `PATCH`, `DELETE`), which is every request that can run the route's
  action; page views are not affected. `'all'`, the default, runs it on every request that reaches
  the route. There is no loader-only setting: a mutation document request runs the action and then
  the loaders, so a guard on loader data needs `'all'`.
- **Same semantics as kernel route middleware.** Policies run after the global pipeline, in the
  kernel, with the page render as the terminal: a policy that answers without calling `next()` ends
  the request (the action never runs), and the client receives that policy's own response (the
  limiter's `429` with its Problem Details body, for example). A plain HTML form post shows that
  response as is. A hydrated page submitting through React Router's client fetches the route's
  `.data` URL, and React Router turns a non-data response into a route error, so the nearest
  `ErrorBoundary` renders with that status; check
  `isRouteErrorResponse(error) && error.status === 429` there to show a friendly message. Middleware
  that reads the response after `next()` sees the rendered page. A policy may read
  `ctx.request.formData()`; the action still receives the same body.
- **Refused at startup:** an id naming no route in the build (the message lists known ids), an empty
  `middleware` array or a non-function entry in it, an `on` value other than `'action'` or `'all'`,
  or a custom `loadRequestHandler` that returns no `pageRoutes`, a build without a `routes`
  manifest, and a build with React Router's `future.unstable_routePatternMatching`, which ranks
  routes differently from `matchRoutes`. In development, a rebuild that drops a page holding a
  policy makes every request a policy applies to answer `500` (the server log names the missing id)
  until the policy is removed or the page restored, rather than silently leaving the page unguarded.
  A `requirePolicy` naming an unregistered policy is refused by `AuthPlugin` as it is on any route.
- **Public files** (`/robots.txt`) are served before policies run, as before.
- **Cost.** With no `pagePolicies`, nothing changes. With them, a request whose method no policy
  applies to (a page view, with only `on: 'action'` policies) skips matching, and one that cannot
  reach a policied route is answered by a small tree holding only those routes. A request that can
  reach one is matched with React Router's `matchRoutes` over the whole tree, which ranks every
  route on each call; those results are cached per path, up to 1,000 entries per build (a path seen
  both as a page view and as an action counts twice), each path up to 512 bytes.
- Route ids are file paths without the extension, relative to `app/`: `app/routes/_auth/login.tsx`
  is `routes/_auth/login`. The conformance test runs against the installed `react-router`, which
  must be in the plugin's peer range (`^8`).

## Routing

The catch-all is mounted on all seven verbs at `joinWildcard(basename)`. `flatRoutes` and file-based
routing work transparently — they are resolved by the compiled build, not by this plugin.

Responses stream through `IResponse.stream()`; GET and HEAD request bodies are omitted.

## Static assets

Assets are served over `runtime.fs?.readFile` with **symlink-safe containment** via the optional
`IFileSystem.realPath`. Where a runtime does not implement `realPath`, containment degrades to
lexical `..` checking.

## Health

Registers a `react-router` health indicator. There is no `onClose` — the request handler is
stateless.

## HTML forms and Referrer-Policy

React Router refuses an unsafe document or single-fetch action request carrying `Origin: null`. A
browser can send that origin on a same-origin HTML form POST under `Referrer-Policy: no-referrer`,
even though the separate Setu HTTP-security CSRF check accepts a verified same-origin Fetch Metadata
request.

React Router does not run that origin check for resource routes, so an unsafe request to a resource
route is not refused for its origin. Setu's CSRF check is opt-in: it runs only when
`HttpSecurityPlugin({ csrf: { … } })` is configured.

For a hand-composed application, configure
`HttpSecurityPlugin({ headers: { referrerPolicy: 'same-origin' } })` alongside `ReactRouterPlugin`.
The plugins do not configure one another. The full-stack starter sets this default when its
`reactRouter` arm is enabled, through both `createFullStackApp` and `createFullStackAppFromConfig`.
Explicit policies, `referrerPolicy: false` and `headers: { enabled: false }` retain the
application's choice.

## Exports

| Export                            | Kind      |
| --------------------------------- | --------- |
| `assembleHandler`                 | function  |
| `assertSsrRuntime`                | function  |
| `bridgeRequestToRR`               | function  |
| `contextKeyFor`                   | function  |
| `createLoadContextFactory`        | function  |
| `createPublicFileHandler`         | function  |
| `createStaticAssetHandler`        | function  |
| `getService`                      | function  |
| `loadRequestHandler`              | function  |
| `pageAction`                      | function  |
| `ReactRouterPlugin`               | function  |
| `serviceCall`                     | function  |
| `viteDevExternals`                | function  |
| `ServiceResolverUnavailableError` | class     |
| `SsrService`                      | class     |
| `CAPABILITIES`                    | const     |
| `serviceResolverContext`          | const     |
| `servicesContext`                 | const     |
| `userContext`                     | const     |
| `HandlerResult`                   | interface |
| `IFileSystem`                     | interface |
| `IRequestContext`                 | interface |
| `ISsrService`                     | interface |
| `RouterContextKey`                | interface |
| `RouterLoadContext`               | interface |
| `ServiceResolver`                 | interface |
| `SsrRuntime`                      | interface |
| `ViteDevExternalId`               | interface |
| `ViteDevExternalsOptions`         | interface |
| `ViteDevExternalsPlugin`          | interface |
| `ViteHookContext`                 | interface |
| `ViteResolvedEnvironments`        | interface |
| `PageActionResult`                | type      |
| `PagePolicy`                      | type      |
| `PageRouteSource`                 | type      |
| `PopulateLoadContext`             | type      |
| `ReactRouterPluginOptions`        | type      |
| `RouteHandler`                    | type      |
| `SsrRequestHandler`               | type      |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#reactrouterplugin-setu-tsreact-router-plugin).

## Trademarks

React Router is a trademark of Shopify Inc. Setu-TS is independent and is not affiliated with or
endorsed by Shopify or the React Router project.
