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
`populateLoadContext` bridged the kernel's service registry into a React Router loader.

It then signs in through the `<Form>` on `/login`, echoing the CSRF token the session minted. A
`302` rather than a `403` proves the synchronizer token round-tripped through the session plugin's
middleware, which is the mechanism a progressive-enhancement form needs and a stateless
Origin/Referer check structurally cannot provide.

## What is NOT here, and why that is the point

A conventional React Router application grows these, and this one has none of them:

| Conventional module                                | What replaces it here                                           |
| -------------------------------------------------- | --------------------------------------------------------------- |
| `lib/session.server.ts`                            | `session-plugin`, reached through `sessionContext`              |
| `lib/csrf.server.ts`                               | the same plugin's form-CSRF middleware, token via `csrfContext` |
| `lib/sse.server.ts`                                | `sse-plugin`                                                    |
| `lib/kv.server.ts`                                 | `cache-plugin` / `storage-plugin`                               |
| `lib/service-logger.server.ts`                     | `logger-plugin`, reached through `loggerContext`                |
| module-level caches in `config/services.server.ts` | the kernel's service registry                                   |

`app/config/services.server.ts` still exists — typed accessors are genuinely app code — but it holds
**no state**. `test/removal.test.ts` asserts both halves of that claim, because a claim nothing
executes is a comment.

## Layering

`routes → features → services → models`, with `lib/` for glue and `.server.ts` marking server-only
modules. A route parses the request and renders; a feature composes a use case; a service talks to
the outside world; a model is plain data shared with the browser.

## Toolchain

The repository uses Node 24 and pnpm. The `build` script runs React Router's Vite build; `start` and
`smoke` both build first. Install dependencies at the repository root with
`pnpm install --frozen-lockfile`. Frontend tooling stays in the app's dependencies, outside the
published framework dependency graph (AI_GUIDELINES §12.2).

`build/`, `.react-router/` and `node_modules/` are generated and ignored by repository formatting
and linting. The app's `check` script uses its generated `tsconfig.json`, which includes the `app/`
TypeScript and TSX files. `pnpm run check:apps` runs that check, then the smoke and test scripts.
Vite's build strips types; the TypeScript check is separate.

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
