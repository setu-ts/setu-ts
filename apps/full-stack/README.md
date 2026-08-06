# Full-stack example — React Router 8 SSR served by the kernel

A React Router 8 framework-mode application served by a Hono Enterprise application, composed
through `createFullStackAppFromConfig` from `@hono-enterprise/full-stack-starter`. It is the
runnable counterpart to `honoe new --template full-stack`.

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
**not** require a Node toolchain — `deno task build` runs `deno install --allow-scripts` followed by
the `@react-router/dev` CLI under Deno's own npm support, so CI needs no `setup-node` step and this
example is deliberately **not** in `ALLOW_SKIP`. Its proof runs on every pull request.

Two consequences worth knowing:

- `build/`, `node_modules/` and `deno.lock` here are generated and gitignored, and `build/` is in
  the root `deno.json` `exclude` so `fmt`, `lint` and `check` never walk bundled output.
- `smoke.ts` ends with an explicit `Deno.exit(0)`. Importing `react-dom/server` under Deno leaves
  the process alive after the application has stopped — measured by importing it alone in an
  otherwise empty script — while `deno test`'s op and resource sanitizers report nothing leaked, so
  it is not a handle this example or the framework owns. A failed assertion still throws and exits
  non-zero before reaching that line.

## What the gate does not cover

`check:apps` runs no browser. Hydration, static-asset delivery and client-side navigation were
verified manually against Chrome via Playwright when this example was written — 11/11 checks,
including that all 8 referenced assets are served by the framework's own handler, that a `<Form>`
submit is a client-side transition rather than a document reload, and that the session cookie is
`HttpOnly`. Aborting the client entry bundle flips the hydration and transition checks to failing
while the SSR content still renders, which is how that suite was shown to discriminate — and which
also demonstrates that the login form degrades to a real POST with JavaScript disabled.

That suite is not committed, for the same reason M51b's npm-client interop suite for
`apps/graphql-demo` is manual: it needs a browser CI does not install.

## Cloudflare Workers

On Workers the `assetsDir` option is omitted: there is no filesystem, so the framework registers no
asset route at all and the platform's static-asset binding serves them. Scaffolding the same
template with `--runtime cloudflare-workers` emits exactly that difference, and the CLI's own
end-to-end test pins it. This example targets Deno, which is what `check:apps` runs.

## Session secret

`honoe.config.ts` falls back to a development secret so the example runs with no environment at all.
A real deployment uses `config.getOrThrow<string>('SESSION_SECRET')` and refuses to boot without one
— which is what the CLI scaffolds.
