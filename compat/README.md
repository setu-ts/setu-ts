# Node / Bun compatibility suite

Verifies the published npm packages on Node.js and Bun. The workflow probes the npm scope before
installing: HTTP 404 reports an unpublished scope and skips; HTTP 200 runs the suite; other statuses
fail. It installs all 52 `@setu-ts/*` packages at `latest` from the ordinary npm registry.

```bash
cd compat
npm install && npm run test:node
bun install && bun run test:bun
```

## What it tests, and why it cannot test the working tree

The published `dist/` artifact is the unit under test. The source workspace and its import map could
hide a missing dependency or an incorrect emitted specifier.

Two consequences follow, and both are deliberate:

- **This suite gates the last release, not `HEAD`.** `package.json` depends on `latest`. Pinning it
  to the workspace version would deadlock a release PR: the workspace is bumped _before_ the
  publish, so CI would demand a version that does not exist yet (the M34b drift-gate lesson).
- **No lockfile is committed.** Resolving `latest` on every run is the point; `.gitignore` excludes
  `package-lock.json` and `bun.lock`.

**Breadth is every published package; depth is the core four.** Every workspace member is installed
and imported, because a package that fails to _load_ on Node or Bun is broken for every consumer of
it and nothing else in CI would notice. Driving each one's behaviour is a different matter — that is
what the Deno suite under `packages/*/test` is for, and duplicating it here would be a second test
suite maintained against a published snapshot. So the deep checks run against `common`, `kernel`,
`runtime`, and `logger-plugin`: enough to boot an application, resolve a capability, and serve a
request.

| Check                                    | What a failure would mean                                                |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| Every workspace package is declared      | A package ships covered on Deno and nowhere else                         |
| Every declared package imports           | ESM output or a transitive dep does not resolve on this runtime          |
| Entry points have the documented shape   | The published surface drifted from what consumers are told to call       |
| `detectRuntime()` matches host           | Runtime detection misroutes every runtime service                        |
| Capability resolves from a token         | The token-to-service binding did not survive the build                   |
| `inject()` serves a route                | Kernel pipeline and router are broken on this runtime                    |
| Real socket serves a route               | `NodeHttpAdapter` / `BunHttpAdapter` is broken — neither runs under Deno |
| `stop()` releases the port               | A redeploy on the same port would be refused                             |
| `npm:` / `jsr:` never reaches `import()` | A published artifact ships `npm:` through a non-literal path (X7-3)      |

The socket checks are the reason the job exists at all: the HTTP adapters are per-runtime
implementations selected by detection, so the Deno-hosted suite never executes them.

<!-- version:history -->

The final check audits every installed package's `dist/` for `npm:` or `jsr:` inside `import()`,
including parameterized importers. Comments are stripped before matching. There is no version guard:
npm never received the historical broken JSR builds.

The first check derives its expectation from `../deno.json` rather than from this directory's own
`package.json`, so adding a package to the workspace and forgetting it here **fails the compat job**
instead of quietly shrinking coverage. The one legitimate exception is a package between its
introduction and its first publish — it cannot be installed before it exists on the registry — which
goes in `PENDING_FIRST_PUBLISH` in `compat.test.mjs` and comes out once it ships.

The workflow probes `@setu-ts/common` first: HTTP 404 reports the npm scope as unpublished and skips
install and suite steps; HTTP 200 runs them; every other status fails. All 52 dependencies are
already declared, so the first npm publish arms the suite without an edit.

## Adding a check

Add it to `compat.test.mjs` behind the `check(label, passed, detail)` helper, then **prove it can
fail** — break the thing it asserts, watch the run exit 1, and restore it. A compat check that
cannot fail is worse than no check, because it reads as coverage.
