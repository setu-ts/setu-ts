# Full-stack example — React Router 8 SSR served by the kernel

A React Router 8 framework-mode application served by a Setu-TS application, composed through
`createFullStackAppFromConfig` from `@setu-ts/full-stack-starter`. It is the runnable counterpart to
`setu new --template full-stack`.

```bash
pnpm --dir apps/full-stack run start   # builds the frontend, then serves on http://localhost:3000
pnpm --dir apps/full-stack run smoke   # what CI runs
pnpm --dir apps/full-stack run test    # the removal claim, asserted
```

## What the smoke check proves

An SSR-rendered route returns HTML containing a row that was **written through the database
capability** — not a string in a component. That is the whole point: it is evidence that
`getService(context, PRODUCTS)` resolved the request-bound kernel module in a React Router loader.
The smoke check first asserts the API catalogue is empty, then seeds rows and checks the sorted API
response and page HTML.

It then signs in through the `<Form>` on `/login`, echoing the CSRF token the session minted. A
`302` rather than a `403` proves the synchronizer token round-tripped through the session plugin's
middleware, which is the mechanism a progressive-enhancement form needs and a stateless
Origin/Referer check structurally cannot provide.

## What is NOT here, and why that is the point

A conventional React Router application grows these, and this one has none of them:

| Conventional module                     | What replaces it here                                            |
| --------------------------------------- | ---------------------------------------------------------------- |
| Hand-rolled session and CSRF middleware | `session-plugin`, accessed through session and CSRF context keys |
| Hand-rolled SSE server                  | `sse-plugin`                                                     |
| Hand-rolled key-value store             | `cache-plugin` / `storage-plugin`                                |
| Hand-rolled logger                      | `logger-plugin`, resolved through `CAPABILITIES.LOGGER`          |
| Module-level client caches              | the kernel service registry                                      |

`app/server/session.server.ts` provides typed access to session and CSRF values and holds **no
state**. `test/removal.test.ts` asserts the absence of hand-rolled capabilities, stateless accessors
and both directions of context-key wiring. Kernel services use `getService` instead of application
context keys.

## Layering

Business logic lives under `src/modules/products/`; pages and page glue live under `app/`, matching
the M130 full-stack template. The products service reads the DATABASE capability and logs through
the LOGGER capability. Both the page and `GET /api/products` resolve that request-bound service in
process. Seeding runs after startup, when the database has connected.

- `src/modules/products/products.types.ts` — the plain `Product` interface.
- `src/modules/products/products.token.ts` — the typed `PRODUCTS` service token.
- `src/modules/products/products.service.ts` — the request-bound, database-backed catalogue.
- `src/modules/products/products.controller.ts` — the `/api/products` route.
- `src/modules/products/products.seed.ts` — the repository name and startup seed.
- `src/modules/products/index.ts` — service and route registration.
- `src/modules/index.ts` — `registerModules`, called by `setu.config.ts` before startup.
- `app/server/context-keys.server.ts` — session and CSRF keys created with `contextKeyFor`.
- `app/server/session.server.ts` — stateless session and CSRF accessors.
- `app/routes/_app/products._index.tsx` — `getService(context, PRODUCTS).list()` and price display.

Pages import kernel code only as `import type` or from a `*.token.ts` module through `~kernel/*`.
Token modules contain only the token and type imports; they never import the service by value.
`populateLoadContext` sets only session and CSRF values. The price formatter stays in the page.

## Toolchain

The repository uses Node 24 and pnpm. The `build` script runs React Router's Vite build; `start` and
`smoke` both build first. Install dependencies at the repository root with
`pnpm install --frozen-lockfile`. Frontend tooling stays in the app's dependencies, outside the
published framework dependency graph (AI_GUIDELINES §12.2).

`build/`, `.react-router/` and `node_modules/` are generated and ignored by repository formatting
and linting. The app's `check` script uses its generated `tsconfig.json`, which includes the `app/`
and `src/` TypeScript and TSX files. `pnpm run check:apps` runs that check, then the smoke and test
scripts. Vite's build strips types; the TypeScript check is separate.

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
