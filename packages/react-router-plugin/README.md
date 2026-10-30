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

### Declaring your own context keys — always with `contextKeyFor`

A hand-written `{ defaultValue }` literal type-checks and then **silently returns its default**:
keys are matched by identity, and in a framework-mode application the declaring module exists twice
(Vite inlines application modules into the server build while the kernel loads `setu.config.ts` from
source), so two identical-looking literals match nothing and `context.get()` answers the default
with no error anywhere. Construct every key through [`contextKeyFor`](#full-api), which resolves by
name so both copies share one object:

```typescript
// app/lib/context-keys.server.ts
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
`data(..., { status: 403 })` when the page is forbidden. A fetch caller that requires the API error
shape should call the corresponding kernel API route.

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

## Exports

| Export                     | Kind      |
| -------------------------- | --------- |
| `assembleHandler`          | function  |
| `assertSsrRuntime`         | function  |
| `bridgeRequestToRR`        | function  |
| `contextKeyFor`            | function  |
| `createLoadContextFactory` | function  |
| `createPublicFileHandler`  | function  |
| `createStaticAssetHandler` | function  |
| `loadRequestHandler`       | function  |
| `ReactRouterPlugin`        | function  |
| `viteDevExternals`         | function  |
| `SsrService`               | class     |
| `CAPABILITIES`             | const     |
| `servicesContext`          | const     |
| `userContext`              | const     |
| `HandlerResult`            | interface |
| `IFileSystem`              | interface |
| `IRequestContext`          | interface |
| `ISsrService`              | interface |
| `RouterContextKey`         | interface |
| `RouterLoadContext`        | interface |
| `SsrRuntime`               | interface |
| `ViteDevExternalId`        | interface |
| `ViteDevExternalsOptions`  | interface |
| `ViteDevExternalsPlugin`   | interface |
| `ViteHookContext`          | interface |
| `ViteResolvedEnvironments` | interface |
| `PopulateLoadContext`      | type      |
| `ReactRouterPluginOptions` | type      |
| `RouteHandler`             | type      |
| `SsrRequestHandler`        | type      |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#reactrouterplugin-setu-tsreact-router-plugin).

## Trademarks

React Router is a trademark of Shopify Inc. Setu-TS is independent and is not affiliated with or
endorsed by Shopify or the React Router project.
