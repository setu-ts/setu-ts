# Hono Enterprise — Session Instructions

Plugin-first enterprise backend framework. **Deno-first toolchain** (Deno 2 workspaces), published
to **JSR** under `@hono-enterprise`, consumable from Node/Bun via JSR npm compatibility.

## Before writing any code

1. Read **AI_GUIDELINES.md** — every rule is mandatory (SOLID, no `any`, no runtime-specific APIs
   outside `packages/runtime`, capability tokens from `CAPABILITIES`, composition over inheritance,
   `IXxx` interface naming).
2. Check **ROADMAP.md** for the current milestone scope. Work on **one package per milestone**; do
   not start the next until the current one is complete (compiles, tested 90%+, documented).
3. Any change to a package's `src/index.ts` exports requires updating **PUBLIC_API.md** in the same
   change, with JSDoc on every export.

## Current status

- **Milestone 0** (monorepo foundation) — complete (CI verification pending first push to a remote)
- **Next: Milestone 1** (`packages/common` — types and capability tokens)

## Verification (run before declaring any work done)

```bash
deno task fmt:check
deno task lint
deno task check
deno task test
```

All four must pass. A milestone also requires 90%+ coverage (`deno task test:coverage`).

## Key conventions

- Tests: `@std/testing/bdd` + `@std/expect`, in `test/{unit,integration,e2e}/` per package.
- No plugin imports another plugin — communicate via `ctx.services.get<T>(CAPABILITIES.X)`.
- Heavy deps (Prisma, Redis clients, …) are never hard dependencies: injected via options or lazy
  `npm:` imports (AI_GUIDELINES §12.2).
- Branches: `feat/[milestone]-[description]`; commits: conventional format (`feat(scope): subject`);
  no direct commits to `main`.
