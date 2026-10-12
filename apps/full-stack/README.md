# Full-stack example — React Router 8 SSR served by the kernel

A React Router 8 framework-mode application served by a Setu-TS application, composed through
`createFullStackAppFromConfig` from `@setu-ts/full-stack-starter`. It is the runnable counterpart to
`setu new --template full-stack`.

```bash
deno task start   # builds the frontend, then serves on http://localhost:3000
deno task smoke   # what CI runs
deno task test    # the removal claim, asserted
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

The frontend build is the one documented exception to this repository's Deno-only toolchain
(AI_GUIDELINES §12.2): React Router builds through Vite on the npm package ecosystem. It does
**not** require a Node toolchain — `deno task build` runs
`deno install --allow-scripts --min-dep-age 0` followed by the `@react-router/dev` CLI under Deno's
own npm support. The minimum-age exception prevents a fresh CI runner from rejecting an
otherwise-resolved, just-published transitive platform package. CI needs no `setup-node` step and
this example is deliberately **not** in `ALLOW_SKIP`. Its proof runs on every pull request.

Two consequences worth knowing:

- `build/`, `node_modules/` and `deno.lock` here are generated and gitignored, and `build/` is in
  the root `deno.json` `exclude` so `fmt`, `lint` and `check` never walk bundled output.
- `deno.json` sets `"nodeModulesDir": "auto"`. It is load-bearing, and CI is the only thing that
  proves it: because this example carries a `package.json`, Deno resolves npm specifiers from
  `node_modules` rather than its global cache — and `check:apps` type-checks an app **before** it
  runs the smoke, which is what creates `node_modules` here. On a cold checkout
  `deno check main.ts
  smoke.ts` therefore failed with
  `Could not find a matching package for 'npm:ws@^8.18.0'`, because the app's import graph reaches
  plugins that lazily import npm drivers. `auto` lets Deno install what a check needs, so the order
  stops mattering. A local run hides this completely once `node_modules` exists.
- `smoke.ts` ends with an explicit `Deno.exit(0)`. Importing `react-dom/server` under Deno leaves
  the process alive after the application has stopped — measured by importing it alone in an
  otherwise empty script — while `deno test`'s op and resource sanitizers report nothing leaked, so
  it is not a handle this example or the framework owns. A failed assertion still throws and exits
  non-zero before reaching that line.

## What the gate does not cover

The `app/` tree is type-checked by this example's own `check:app` task
(`deno check app/**/*.ts app/**/*.tsx`), which the `test` task runs and `check:apps` therefore
executes. That task exists because neither of the obvious candidates covers those files: the gate's
`deno check` entry points are fixed at `main.ts` and `smoke.ts`, which reach six app modules and
none of the `.tsx`, and `vite build` does not type-check at all — rolldown strips types without
checking them, so a pure type error builds green.

The dedicated `deno task check:browser` gate at the repository root builds and tests this example
and a fresh CLI full-stack scaffold in real Chromium. It checks SSR, hydration, asset delivery,
link/Form transitions, HttpOnly cookies and native no-JavaScript login. Aborting the client entry
proves transition checks fail while SSR still renders; removing a referenced asset proves the asset
check names the missing bundle.

Install the pinned browser with `deno run -A npm:playwright@1.63.0 install chromium`. A missing
browser exits 77 locally and fails in CI, which installs Chromium in its dedicated job. The gate
locates the browser through Playwright's own resolution, so `PLAYWRIGHT_BROWSERS_PATH`,
`XDG_CACHE_HOME` and `LOCALAPPDATA` are honored; the task grants read access to the Linux and macOS
default caches only, and a cache elsewhere fails with the exact `--allow-read` to rerun with rather
than being reported as missing. Ordinary tests do not launch a browser. Set `PORT` to choose the
application's listening port (default 3000).

The full-stack configuration selects `Referrer-Policy: same-origin` so native form posts retain
their origin for React Router's action check. Cross-origin referrers remain suppressed; both session
CSRF and React Router origin verification remain active.

## Cloudflare Workers

On Workers the `assetsDir` option is omitted: there is no filesystem, so the framework registers no
asset route at all and the platform's static-asset binding serves them. Scaffolding the same
template with `--runtime cloudflare-workers` emits exactly that difference, and the CLI's own
end-to-end test pins it. This example targets Deno, which is what `check:apps` runs.

## Session secret

`setu.config.ts` falls back to a development secret so the example runs with no environment at all.
A real deployment uses `config.getOrThrow<string>('SESSION_SECRET')` and refuses to boot without one
— which is what the CLI scaffolds.
