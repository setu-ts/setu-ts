# React Router development mode (HMR) with `@setu-ts/react-router-plugin`

The plugin's production path imports a compiled `ServerBuild` once, at `register()` time, so a
rebuild needs a process restart. This guide sets up a development loop where editing a route file
changes the rendered output with **no restart**, and the browser gets Vite's Hot Module Replacement
and React Fast Refresh — while the setu-ts app still serves the SSR document and your API routes.

No plugin code is required. The `loadRequestHandler` option is the seam; everything here is
app-level configuration.

Every claim below was verified end-to-end against a running kernel app on **Deno 2.9.4**, **Vite
7.3.6**, **react-router 8.3.0**, and **@react-router/dev 8.3.0**. Where a plausible-looking approach
does not work, it is called out explicitly rather than omitted.

> **Not related to `deno desktop --hmr`.** Deno 2.9.4 added `--hmr` support for React Router, but it
> is scoped to the `deno desktop` command, which detects `@react-router/dev` in `package.json` and
> shells out to `deno task dev` — React Router's own Vite dev server, with the plugin and your
> kernel app out of the picture entirely. It is not a mechanism this plugin can use.

## How it works

Two facts drive the design:

1. **`createRequestHandler` accepts a build _thunk_.** Its signature is
   `(build: ServerBuild | (() => ServerBuild | Promise<ServerBuild>), mode?: string)`. Passing a
   function makes the build re-resolve per request, so Vite's module-graph invalidation is picked up
   without rebuilding the handler.
2. **Vite must run in the same process.** `ssrLoadModule` needs the `ViteDevServer` object, so a
   separate `react-router dev` process cannot supply the server build. Vite runs in-process **on its
   own port** — not in `middlewareMode` — which also means Vite serves the client module graph and
   the HMR WebSocket itself.

The app then needs exactly one extra route: a proxy for the URLs Vite owns.

## Setup

### 1. Pin the versions React Router requires

```jsonc
// package.json
{
  "type": "module",
  "dependencies": {
    "react": "19.2.8", // MUST be the exact same version as react-dom
    "react-dom": "19.2.8",
    "react-router": "^8.3.0",
    "isbot": "^5" // see note below
  },
  "devDependencies": {
    "@react-router/dev": "^8.3.0",
    "vite": "^7.0.0"
  }
}
```

Two non-obvious requirements, both of which fail at `ssrLoadModule`/`createServer` time rather than
at install time:

- **`react` and `react-dom` must be the identical version**, not merely compatible ranges. `^19.0.0`
  on both resolved to `19.2.7` and `19.2.8` and produced
  `Incompatible React versions: The "react" and "react-dom" packages must have the exact same version`.
- **Declare `isbot` yourself.** React Router's default server entry uses it, and the dev plugin
  tries to `npm install isbot@5` on the fly when it is missing — which fails inside Deno's managed
  `node_modules` (`npm error Cannot read properties of null`).

`nodeModulesDir` must be enabled, because Vite cannot be loaded from Deno's global npm cache:

```jsonc
// deno.json
{ "nodeModulesDir": "auto" }
```

### 2. Namespace Vite's URLs with `base`

```typescript
// vite.config.ts
import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [reactRouter()],
  base: '/__vite/', // every client URL React Router emits gets this prefix
  server: { port: 5199, strictPort: true },
});
```

`base` is what makes a single proxy route sufficient. Without it, the SSR document references
`/app/root.tsx`, `/@react-router/critical.css`, and `/node_modules/...` at the root — all of which
would hit the setu-ts app and collide with real application routes. With `base: '/__vite/'`, those
become `/__vite/app/root.tsx`, `/__vite/@react-router/critical.css`, and so on.

> **`server.origin` does not do this.** It affects asset URLs produced by Vite's asset pipeline, not
> the module script paths React Router emits into the document — those stayed root-relative in
> testing with and without it. Use `base`.

The React Router Vite plugin also **requires a real config file**: passing `configFile: false` to
`createServer` fails with `The React Router Vite plugin requires the use of a Vite config file`.

### 3. Wire the dev seam

```typescript
import * as vite from 'vite';
import { createRequestHandler, RouterContextProvider } from 'react-router';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ReactRouterPlugin } from '@setu-ts/react-router-plugin';

const VITE_PORT = 5199;
const BASE = '/__vite/';

const viteServer = await vite.createServer({
  root: import.meta.dirname,
  configFile: `${import.meta.dirname}/vite.config.ts`,
  server: { port: VITE_PORT, strictPort: true },
  logLevel: 'error',
});
await viteServer.listen();

const app = createApplication();
app.register(RuntimePlugin());
app.register(ReactRouterPlugin({
  // Unused when loadRequestHandler is supplied, but the option is required —
  // pass the virtual id so the health indicator reports something meaningful.
  serverBuildPath: 'virtual:react-router/server-build',
  mode: 'development',
  // Omit assetsDir in dev: there is no build/client, and Vite serves the client graph.
  loadRequestHandler: (_path, mode) =>
    Promise.resolve({
      handler: createRequestHandler(
        () => viteServer.ssrLoadModule('virtual:react-router/server-build'),
        mode,
      ),
      // Must come from the same react-router module as the handler — RR checks
      // `context instanceof RouterContextProvider` nominally.
      createLoadContext: () => new RouterContextProvider(),
    }),
}));
```

Note the two halves of `SsrRuntime`. `createLoadContext` is not optional busywork: React Router 8
rejects any context that is not a real `RouterContextProvider` instance with a 500, so a dev seam
that returns only a handler cannot work. See the Notes section of PUBLIC_API.md for the full
rationale.

### 4. Add the single proxy route

```typescript
app.router.get(`${BASE}*`, async (ctx) => {
  const url = new URL(ctx.request.url);
  const upstream = await fetch(
    `http://localhost:${VITE_PORT}${url.pathname}${url.search}`,
    { headers: ctx.request.headers },
  );

  ctx.response.status(upstream.status);
  for (const [key, value] of upstream.headers.entries()) {
    const lower = key.toLowerCase();
    if (lower !== 'content-encoding' && lower !== 'content-length') {
      ctx.response.appendHeader(key, value);
    }
  }
  return ctx.response.stream(upstream.body!);
});

await app.start({ port: 5299 });
```

`/__vite/*` carries one static segment, so it outranks the plugin's `/*` catch-all under the
precedence rules in PUBLIC_API.md — registering it _after_ `ReactRouterPlugin` works, which is how
the verification above was run. Keep at least one static segment in the prefix: a bare `/*`-adjacent
pattern would tie with the catch-all and be silently shadowed.

## The HMR WebSocket needs nothing from you

Vite's HMR client connects back to **Vite's own port**, not the app's. That is deliberate and worth
being explicit about:

- No `IHttpAdapter.setUpgradeRouter` involvement, so **no conflict with `WebSocketPlugin`** — the
  adapter exposes a single upgrade-router slot, and the WebSocket plugin claims it.
- If the browser cannot reach Vite's port directly (containers, remote dev), set `server.hmr.port` /
  `server.hmr.clientPort` in the Vite config rather than trying to route the socket through the app.

## Production

Nothing changes: build with `react-router build`, then register the plugin with the compiled build
and let it use the default loader.

```typescript
app.register(ReactRouterPlugin({
  serverBuildPath: './build/server/index.js',
  assetsDir: './build/client/assets',
  mode: 'production',
}));
```

Keep the dev-only Vite import and proxy route behind an environment check so neither reaches a
production bundle. Vite stays an app-level `devDependency` and is never imported by the plugin
(AI_GUIDELINES §12.2).

## Notes on `entry.server.tsx` under Deno

Deno's own framework documentation states that React Router's default server entry targets Node and
that a Deno-compatible `app/entry.server.tsx` is needed before building for `deno desktop`. **That
did not reproduce here.** With no custom entry at all, React Router 8.3.0's default server entry
rendered a document successfully under Deno 2.9.4, both through `createRequestHandler` directly and
through the plugin over a real socket.

Treat a custom entry as something to reach for when you hit an actual Node-only API — not as a
prerequisite. If you do write one, it is app-level and invisible to the plugin, which consumes only
the compiled build.

## Verified behavior summary

| Step                                                      | Result                                  |
| --------------------------------------------------------- | --------------------------------------- |
| `import 'vite'` under Deno                                | works (requires `nodeModulesDir`)       |
| `@react-router/dev/vite` under Deno                       | works                                   |
| `vite.createServer()` in-process                          | works (real config file required)       |
| `ssrLoadModule('virtual:react-router/server-build')`      | returns the `ServerBuild`               |
| SSR through the build thunk on the app port               | 200 HTML                                |
| Client modules under `base`, proxied through the app port | 200 `text/javascript`                   |
| Vite HMR client reachable through the app port            | 200                                     |
| Editing a route file, then re-requesting                  | new output, **no restart**              |
| `server.origin` rewriting emitted module URLs             | **does not work** — use `base`          |
| `configFile: false`                                       | **rejected** by the React Router plugin |
| Mismatched `react` / `react-dom` patch versions           | **throws** at `ssrLoadModule`           |
