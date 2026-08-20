# Node / Bun compatibility suite

Verifies that the published packages work on Node.js and Bun (AI_GUIDELINES §4.5, §6.4). CI runs it
as the `Node compatibility` and `Bun compatibility` jobs; before that it was a pair of placeholder
jobs blocked on the first JSR publish, which happened at `v0.1.0-alpha.1`. <!-- version:history -->

```bash
cd compat
npm install && npm run test:node
bun install && bun run test:bun
```

## What it tests, and why it cannot test the working tree

Node and Bun cannot consume this repo's source. Cross-package specifiers are `jsr:@setu-ts/*` and
optional heavy dependencies are `npm:*`; neither resolves outside Deno. JSR rewrites both at publish
time, so **the published artifact is the unit under test** — installed from `https://npm.jsr.io` as
`@jsr/setu-ts__*` via the scoped registry in `.npmrc`.

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

| Check                                  | What a failure would mean                                                |
| -------------------------------------- | ------------------------------------------------------------------------ |
| Every workspace package is declared    | A package ships covered on Deno and nowhere else                         |
| Every declared package imports         | JSR's ESM output or a transitive dep does not resolve on this runtime    |
| Entry points have the documented shape | The published surface drifted from what consumers are told to call       |
| `detectRuntime()` matches host         | Runtime detection misroutes every runtime service                        |
| Capability resolves from a token       | The token-to-service binding did not survive the npm rewrite             |
| `inject()` serves a route              | Kernel pipeline and router are broken on this runtime                    |
| Real socket serves a route             | `NodeHttpAdapter` / `BunHttpAdapter` is broken — neither runs under Deno |
| `stop()` releases the port             | A redeploy on the same port would be refused                             |
| `npm:` never reaches `import()`        | A published artifact ships `npm:` through a non-literal path (X7-3)      |

The socket checks are the reason the job exists at all: the HTTP adapters are per-runtime
implementations selected by detection, so the Deno-hosted suite never executes them.

The final check — `npm:` never reaches `import()` — audits the published `grpc-plugin` and
`telemetry-plugin` artifacts for the X7-3 shape. JSR's npm-compatibility rewrite is static and
reaches only a literal `import('npm:…')` argument, so it refuses two shapes: a literal `npm:` inside
`import()`, and the indirection that evades it — a parameterized importer that forwards its
parameter into `import()` (the known-broken `alpha.5` artifact carries the latter, not the former,
which is why the first shape alone would have passed against the exact broken build). Comments are
stripped before matching, because the fixed artifact's own JSDoc documents the indirection shape it
must not contain. The check is version-guarded: while the installed packages are at or below
`0.1.0-alpha.8` (the last release that shipped the defect) it reports `pend` rather than failing;
once a newer version is installed the guard lifts and a surviving non-literal `npm:` path fails the
suite.

The first check derives its expectation from `../deno.json` rather than from this directory's own
`package.json`, so adding a package to the workspace and forgetting it here **fails the compat job**
instead of quietly shrinking coverage. The one legitimate exception is a package between its
introduction and its first publish — it cannot be installed before it exists on the registry — which
goes in `PENDING_FIRST_PUBLISH` in `compat.test.mjs` and comes out once it ships.

## Adding a check

Add it to `compat.test.mjs` behind the `check(label, passed, detail)` helper, then **prove it can
fail** — break the thing it asserts, watch the run exit 1, and restore it. A compat check that
cannot fail is worse than no check, because it reads as coverage.
