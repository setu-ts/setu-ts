# Hono Enterprise — Session Instructions

Plugin-first enterprise backend framework. **Deno-first toolchain** (Deno 2 workspaces), published
to **JSR** under `@hono-enterprise`, consumable from Node/Bun via JSR npm compatibility.

## Starting a new milestone — READ THESE FIRST (mandatory)

Do NOT write, edit, or scaffold any code until you have read, in this order:

1. **AI_GUIDELINES.md** — in full. Every rule is mandatory (SOLID, no `any`, no runtime-specific
   APIs outside `packages/runtime`, capability tokens from `CAPABILITIES`, composition over
   inheritance, `IXxx` interface naming). Also read the "Common pitfalls", "Self-review checklist",
   and "Before reporting a task done" sections lower in THIS file.
2. **ROADMAP.md** — the section for the milestone you are starting (its scope, file list, and
   deliverables) AND the "Progress Tracking" table. Work on **one package per milestone**; do not
   start the next until the current one is complete (compiles, tested 90%+, documented).
3. **ARCHITECTURE.md** — the sections relevant to the package you are building (e.g. §6 service
   registry, §10 middleware pipeline). It explains WHY, not just what.
4. **PUBLIC_API.md** — the sections for `@hono-enterprise/common` and any package you depend on, so
   you consume existing interfaces instead of inventing new ones.
5. **The `@hono-enterprise/common` source** for the interfaces you will implement — implement the
   committed contracts exactly; do not redefine, widen, or re-declare them.

Only after that, begin. And: any change to a package's `src/index.ts` exports requires updating
**PUBLIC_API.md** in the same change, with JSDoc on every export.

## Current status

- **Milestone 0** (monorepo foundation) — complete (PR #1)
- **Milestone 1** (`packages/common`) — complete (PR #2)
- **Milestone 2** (`packages/kernel` — plugin kernel, service registry, pipeline, router,
  application lifecycle) — implemented, PR pending
- **Milestone 3** (`packages/runtime` — runtime services for Node/Deno/Bun, detection,
  RuntimePlugin) — implemented, PR pending. HTTP server adapters **deferred** to Milestone 39 (see
  ROADMAP.md) — `IResponse` has no read surface; needs a web-standard Request/Response seam designed
  against the kernel.
- **Next milestone** — Milestone 4 (`packages/logger-plugin` — structured logging)

## Verification (run before declaring any work done)

```bash
deno task fmt:check
deno task lint
deno task check
deno task test
```

All four must pass. A milestone also requires 90%+ coverage (`deno task test:coverage`).

## Common pitfalls (these fail the gates)

- `exactOptionalPropertyTypes` is on: never assign `undefined` to an optional property — omit it.
- The `verbatim-module-syntax` lint rule requires `import type { … }` for type-only imports.
- `no-console` applies everywhere except `packages/cli` and `scripts/` (scripts use
  `// deno-lint-ignore-file no-console` with a reason).
- Unused variables fail lint — delete them; do not underscore-prefix.
- Run `deno fmt` before `deno task fmt:check`; it also reformats markdown — never hand-wrap tables.
- `scripts/coverage.ts` tolerates empty coverage only while packages are stubs; with real code it
  hard-fails below expectations.
- Use web-standard APIs in contracts (`Headers`, `SubtleCrypto`); runtime-specific shapes live
  behind `IRuntimeServices` only.
- `eval` and `new Function()` are forbidden (AI_GUIDELINES §13.5). NOTE: `deno lint`'s `no-eval`
  catches `eval()` but NOT `new Function()` — the gates will not flag it, so this is on you. To load
  Node builtins in `packages/runtime`, use static `node:` imports (Deno/Node/Bun all support them),
  never a smuggled `require`.

## Self-review checklist (bugs that slipped through before — check every time)

- **Per-file coverage, not aggregate**: the 90% bar applies to every file under `src/` — read the
  per-file table from `deno task test:coverage`. Test fixtures belong under `test/` and are excluded
  from coverage measurement.
- **Token ↔ interface binding is fixed**: a service resolved from a `CAPABILITIES` token must be
  typed as that token's documented interface. Never resolve one token and cast to another interface.
  If no token fits the need, add one to `CAPABILITIES` (that is a public API change — update
  PUBLIC_API.md).
- **Short-circuit tests are mandatory**: any chain/dispatch mechanism (global middleware, route
  middleware, guards, hooks) needs an explicit test proving that when a stage responds without
  calling `next()`, downstream stages — including the handler — do NOT run and cannot overwrite the
  response.
- **Hoist per-request work to registration time**: parse route patterns, compile chains, and build
  lookup structures once at startup, never per request (AI_GUIDELINES §14).

## Before reporting a task done (evidence, not vibes)

Passing gates is necessary but NOT sufficient — these misses all passed the gates:

- **A no-op change passes every gate.** A mis-quoted flag (`"--exclude='/test/'"` in an args array),
  a `@ts-ignore`, a `new Function` shim, a test that asserts nothing — all green, all wrong. Prove
  the change does what it claims: for a config/flag/exclude change, show the before→after behavior
  difference; for a bug fix, confirm the test fails WITHOUT the fix and passes with it.
- **Read coverage ANSI-stripped, per file, after EVERY change — including deletions.**
  `deno coverage` colorizes output; naive parsing misreads the numbers (a `[33m` prefix turned 75.9
  into a false "OK"). Pipe through `sed 's/\x1b\[[0-9;]*m//g'` and confirm every changed `src` file
  is ≥90% on branch, function, AND line. Deleting or rewriting a test can drop an UNRELATED file
  below the bar, and the aggregate will hide it — re-check per file after refactors and deletions,
  not just additions.
- **Grep for constructs the gates don't catch**:
  `grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore" packages/<pkg>/src` — must be empty
  (comments excepted).
- **Report the evidence.** When handing back, paste the ANSI-stripped per-file coverage table and
  the grep result. "Done" without that evidence is not done.

## Key conventions

- Tests: `@std/testing/bdd` + `@std/expect`, in `test/{unit,integration,e2e}/` per package.
- No plugin imports another plugin — communicate via `ctx.services.get<T>(CAPABILITIES.X)`.
- Heavy deps (Prisma, Redis clients, …) are never hard dependencies: injected via options or lazy
  `npm:` imports (AI_GUIDELINES §12.2).
- Branches: `feat/[milestone]-[description]`; commits: conventional format (`feat(scope): subject`);
  no direct commits to `main`.
