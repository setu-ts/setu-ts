# Node / Bun compatibility suite

Verifies that the published packages work on Node.js and Bun (AI_GUIDELINES §4.5, §6.4). CI runs it
as the `Node compatibility` and `Bun compatibility` jobs; before that it was a pair of placeholder
jobs blocked on the first JSR publish, which happened at `v0.1.0-alpha.1`.

```bash
cd compat
npm install && npm run test:node
bun install && bun run test:bun
```

## What it tests, and why it cannot test the working tree

Node and Bun cannot consume this repo's source. Cross-package specifiers are
`jsr:@hono-enterprise/*` and optional heavy dependencies are `npm:*`; neither resolves outside Deno.
JSR rewrites both at publish time, so **the published artifact is the unit under test** — installed
from `https://npm.jsr.io` as `@jsr/hono-enterprise__*` via the scoped registry in `.npmrc`.

Two consequences follow, and both are deliberate:

- **This suite gates the last release, not `HEAD`.** `package.json` depends on `latest`. Pinning it
  to the workspace version would deadlock a release PR: the workspace is bumped _before_ the
  publish, so CI would demand a version that does not exist yet (the M34b drift-gate lesson).
- **No lockfile is committed.** Resolving `latest` on every run is the point; `.gitignore` excludes
  `package-lock.json` and `bun.lock`.

The suite is deliberately narrow — it is a compatibility check, not a second test suite. The Deno
suite under `packages/*/test` owns behaviour coverage; this one owns the claims that only a live
Node or Bun process can settle:

| Check                            | What a failure would mean                                                |
| -------------------------------- | ------------------------------------------------------------------------ |
| Entry points import              | JSR's ESM/`.d.ts` output does not load on this runtime                   |
| `detectRuntime()` matches host   | Runtime detection misroutes every runtime service                        |
| Capability resolves from a token | The token-to-service binding did not survive the npm rewrite             |
| `inject()` serves a route        | Kernel pipeline and router are broken on this runtime                    |
| Real socket serves a route       | `NodeHttpAdapter` / `BunHttpAdapter` is broken — neither runs under Deno |
| `stop()` releases the port       | A redeploy on the same port would be refused                             |

The last two are the reason the job exists at all: the HTTP adapters are per-runtime implementations
selected by detection, so the Deno-hosted suite never executes them.

## Adding a check

Add it to `compat.test.mjs` behind the `check(label, passed, detail)` helper, then **prove it can
fail** — break the thing it asserts, watch the run exit 1, and restore it. A compat check that
cannot fail is worse than no check, because it reads as coverage.
