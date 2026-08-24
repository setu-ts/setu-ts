# @setu-ts/react-router-plugin

React SSR and file-based routing, by embedding **React Router v7 framework mode** as a plugin over a
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

| Option               | Type       | Default      | Description                                                                       |
| -------------------- | ---------- | ------------ | --------------------------------------------------------------------------------- |
| `serverBuildPath`    | `string`   | —            | Path to the compiled `ServerBuild`. Required.                                     |
| `basename`           | `string`   | `'/'`        | Mount point for the SSR catch-all.                                                |
| `assetsDir`          | `string`   | —            | Directory served as static assets. Omitted → no asset route is registered at all. |
| `assetUrlPrefix`     | `string`   | `'/assets/'` | URL prefix the asset route claims. Read only when `assetsDir` is set.             |
| `loadRequestHandler` | `function` | lazy import  | Injectable seam; defaults to importing `npm:react-router` plus the build.         |

On Cloudflare Workers leave `assetsDir` unset — there is no `runtime.fs`, so the asset handler has
nothing to read, and omitting it registers no route rather than throwing.

## Toolchain note

This is the **one** place the Deno-only backend toolchain makes an exception. Your frontend is built
with **Vite on the Node/npm toolchain**, outside the Deno workspace. Vite is an app-level,
build-time `devDependency` — it is never imported by this plugin and never appears in any
JSR-published package's dependency graph.

## Loader context

The default `loadContext` exposes `{ services, user }` to your React Router loaders and actions, so
a loader can reach any registered capability:

```typescript
export async function loader({ context }) {
  const db = context.services.get(CAPABILITIES.DATABASE);
  return { orders: await db.getRepository('Order').findAll() };
}
```

Override it with `populateLoadContext` to add your own keys.

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
| `SsrService`               | class     |
| `CAPABILITIES`             | const     |
| `servicesContext`          | const     |
| `userContext`              | const     |
| `HandlerResult`            | interface |
| `IFileSystem`              | interface |
| `IRequestContext`          | interface |
| `ISsrService`              | interface |
| `ReactRouterPluginOptions` | interface |
| `RouterContextKey`         | interface |
| `RouterLoadContext`        | interface |
| `SsrRuntime`               | interface |
| `PopulateLoadContext`      | type      |
| `RouteHandler`             | type      |
| `SsrRequestHandler`        | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#reactrouterplugin-setu-tsreact-router-plugin).
