# Full-stack example — React Router 8 SSR served by the kernel

A React Router 8 framework-mode application served by a Setu-TS application, composed through
`createFullStackAppFromConfig` from `@setu-ts/full-stack-starter`. It is the runnable counterpart to
`setu new --template full-stack`.

```bash
pnpm --dir apps/full-stack run start:dev  # Vite in middleware mode, served on http://localhost:3000
pnpm --dir apps/full-stack run smoke      # what CI runs
pnpm --dir apps/full-stack run test       # the removal claim and the app test, asserted
pnpm --dir apps/full-stack run build      # frontend, type-check, setu check, then dist/main.js
pnpm --dir apps/full-stack run start      # runs the built dist/main.js; build first
```

The layout, theme toggle, `components/ui` Button and Card, the Dockerfile, `test/app.test.ts`,
`test/e2e/` and `test/support/` are what the scaffold writes, unchanged. The Dockerfile is the one a standalone project builds with its own lockfile: here the app's `@setu-ts/*` dependencies are `workspace:^` links, so it does not build inside this repository, and the root images do not cover full-stack ([Container images](../../docs/deployment.md#container-images)). The example's own additions
are the memory database and its startup seed (called from `main.ts` and `dev.ts`), the development
session-secret fallback, the CSV download at `/products/export`, the `/forbidden` route, `smoke.ts`, `test/removal.test.ts` and the browser
harness.

## What the smoke check proves

An SSR-rendered route returns HTML containing a row that was **written through the database
capability** — not a string in a component. The products page sits behind the scaffold's
`requireUser` route middleware, so the smoke check first proves a signed-out request is sent to
`/login`, then signs in and reads the page. That is the whole point: it is evidence that
`getService(context, PRODUCTS)` resolved the request-bound kernel module in a React Router loader.
The smoke check first asserts the API catalogue is empty, then seeds rows and checks the sorted API
response and page HTML.

It then signs in through the `<Form>` on `/login`, echoing the CSRF token the session minted. A
`302` rather than a `403` proves the synchronizer token round-tripped through the session plugin's
middleware, which is the mechanism a progressive-enhancement form needs and a stateless
Origin/Referer check structurally cannot provide.

Then it uses the page the way a visitor does:

- **Create through the page.** The products form posts to the page's own `action`, as a document
  POST to `/products?index` (no JavaScript) and to `/products.data?index` (what React Router sends
  with JavaScript). Both answer through the same request-bound service as the loader, and the page
  then shows the new rows. No browser code calls `/api/products`.
- **A refusal shown in place.** A duplicate name is a `409 conflict` in the service; `pageAction`
  returns its detail to the form, so the page answers 200 with the message instead of an error page.
- **A download from a resource route.** `/products/export` has no component, so React Router returns
  its loader's `Response` (a CSV attachment) as is. It is behind `requireUser` like the page, and
  `serviceCall` keeps a refusal's status there instead of answering 500.
- **Sign-out.** The header links to `/logout`, a guarded page whose form posts to its action, which
  clears and regenerates the session; the products page then sends the visitor to `/login`.
- **The API stays for outside callers.** One check reads `GET /api/products` and finds the rows the
  page created, from the same service.

## What is NOT here, and why that is the point

A conventional React Router application grows these, and this one has none of them:

| Conventional module                     | What replaces it here                                            |
| --------------------------------------- | ---------------------------------------------------------------- |
| Hand-rolled session and CSRF middleware | `session-plugin`, accessed through session and CSRF context keys |
| Hand-rolled SSE server                  | `sse-plugin`                                                     |
| Hand-rolled key-value store             | `cache-plugin` / `storage-plugin`                                |
| Hand-rolled logger                      | `logger-plugin`, resolved through `CAPABILITIES.LOGGER`          |
| Module-level client caches              | the kernel service registry                                      |

`app/server/session.server.ts` provides typed access to session, CSRF and signed-in-user values and
holds **no state**. `test/removal.test.ts` asserts the absence of hand-rolled capabilities,
stateless accessors and both directions of context-key wiring. Kernel services use `getService`
instead of application context keys.

## Layering

Business logic lives under `src/modules/products/`; pages and page glue live under `app/`, matching
the M130 full-stack template. The products service reads the DATABASE capability and logs through
the LOGGER capability. Both the page and `GET /api/products` resolve that request-bound service in
process. Seeding runs in `main.ts` and `dev.ts` after startup, when the database has connected.

- `src/modules/products/products.types.ts` — the plain `Product` interface.
- `src/modules/products/products.token.ts` — the typed `PRODUCTS` service token.
- `src/modules/products/products.service.ts` — the request-bound, database-backed catalogue:
  `parse`, `list`, and `create`, which refuses a duplicate name.
- `src/modules/products/products.controller.ts` — the `/api/products` route, for callers outside the
  app.
- `src/modules/products/products.seed.ts` — the repository name and startup seed.
- `src/modules/products/index.ts` — service and route registration.
- `src/modules/index.ts` — `registerModules`, called by `setu.config.ts` before startup.
- `app/server/context-keys.server.ts` — request id, session, CSRF and signed-in-user keys created
  with `contextKeyFor`.
- `app/server/session.server.ts` — stateless session, CSRF and signed-in-user accessors.
- `app/server/require-user.server.ts` — the route middleware that guards the products page.
- `app/routes/_app/products._index.tsx` — the loader (`getService(context, PRODUCTS).list()`), the
  action (`parse`, then `create` through `pageAction`) and the form.
- `app/routes/_app/products.export.tsx` — the CSV resource route, through `serviceCall`.
- `app/routes/_app/logout.tsx` — the sign-out page and its action.

Pages import kernel code only as `import type` or from a `*.token.ts` module through `~kernel/*`.
Token modules contain only the token and type imports; they never import the service by value.
`populateLoadContext` sets only the request id, session and CSRF values; `requireUser` sets the
signed-in user. The price formatter stays in the page.

## Toolchain

The repository uses Node 24 and pnpm. The `build` script runs React Router's Vite build, the
type-check and `setu build`; `start` runs the result and refuses when `dist/main.js` is missing, and
`smoke` runs only the frontend build first, since it loads the framework from source. In this
repository, `build` bundles against the framework packages' compiled output; in a fresh clone,
compile them once from the repository root with `pnpm exec tsc -b`. Install dependencies at the
repository root with `pnpm install --frozen-lockfile`. Frontend tooling stays in the app's
dependencies, outside the published framework dependency graph (AI_GUIDELINES §12.2).

`build/`, `.react-router/` and `node_modules/` are generated and ignored by repository formatting
and linting. The app's `check` script runs the React Router build and then uses its generated
`tsconfig.json`, which includes the `app/` and `src/` TypeScript and TSX files.
`pnpm run check:apps` runs that check, then the smoke and test scripts. Vite's build strips types;
the TypeScript check is separate.

## Browser verification

The dedicated `pnpm run check:browser` gate at the repository root builds and tests this example and
a fresh CLI full-stack scaffold in real Chromium. It checks SSR, hydration, asset delivery,
link/Form transitions, HttpOnly cookies and native no-JavaScript login. Aborting the client entry
proves transition checks fail while SSR still renders; removing a referenced asset proves the asset
check names the missing bundle.

Install the pinned browser with `pnpm --dir apps/full-stack exec playwright install chromium`. A
missing browser exits 77 locally and fails in CI, which installs Chromium in its dedicated job. The
harness resolves Playwright's browser cache, including `PLAYWRIGHT_BROWSERS_PATH`. Ordinary tests do
not launch a browser. Set `PORT` to choose the listening port (default 3000).

The full-stack configuration selects `Referrer-Policy: same-origin` so native form posts retain
their origin for React Router's action check. Cross-origin referrers remain suppressed; both session
CSRF and React Router origin verification remain active.

## Cloudflare Workers

On Workers the `assetsDir` option is omitted: there is no filesystem, so the framework registers no
asset route at all and the platform's static-asset binding serves them. Scaffolding the same
template with `--runtime cloudflare-workers` emits exactly that difference, and the CLI's own
end-to-end test pins it. This example runs on Node through `check:apps`.

## Session secret

`setu.config.ts` falls back to a development secret so the example runs with no environment at all.
A real deployment uses `config.getOrThrow<string>('SESSION_SECRET')` and refuses to boot without one
— which is what the CLI scaffolds.

Read the [example deep dive](../../docs/examples.md#full-stack) for the concept and source
walkthrough.
