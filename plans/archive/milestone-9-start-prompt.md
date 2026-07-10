# Milestone 9 — Fresh Context Start Prompt

Copy and paste this into a fresh Code mode session to begin implementing Milestone 9.

---

## Task

Implement **Milestone 9: Decorator Plugin** for the Hono Enterprise framework —
`packages/decorator-plugin`.

**Full implementation plan:** `plans/milestone-9-decorator-plugin.md` — read this in full before
writing code. It contains the complete architecture, decorator signatures, composition rules,
discovery algorithm, fixture designs, and test strategy.

---

## Mandatory Documents to Read (in order)

1. **`CLAUDE.md`** — Session instructions, branch rules, verification gates, common pitfalls,
   self-review checklist. **Read in full.**
2. **`AI_GUIDELINES.md`** — All rules are mandatory. Key sections: §1 (SOLID), §3 (Plugin Rules), §4
   (Runtime Independence), §5 (TypeScript Rules), §6 (Testing Rules), §7 (Documentation Rules), §8
   (Milestone Rules), §10 (Public API Rules), §12 (Dependency Rules).
3. **`ROADMAP.md`** — Read Milestone 9 section (§1183) for scope and deliverables. Check "Progress
   Tracking" table.
4. **`ARCHITECTURE.md`** — Read §12 (Decorator System) for design rationale. Read §3 (Plugin Rules)
   and §6 (Service Registry).
5. **`packages/common/src/plugin.ts`** — `IMetadataStore`, `IDecoratorApi`, `DecoratorHandler`,
   `IPlugin`, `IPluginContext`.
6. **`packages/common/src/container.ts`** — `Constructor`, `ServiceScope`, `IContainer` — used by
   injection decorators.
7. **`packages/common/src/http.ts`** — `IRequestContext`, `RouteDefinition`, `RouteHandler`,
   `MiddlewareFunction` — the types decorators produce metadata for.
8. **`packages/common/src/index.ts`** — Barrel exports — confirm which types are available.
9. **`packages/kernel/src/application/application.ts`** — How `IPluginContext` is built (Proxy with
   lazy getters for `metadata`/`container`), how routes are registered,
   `CAPABILITIES.METADATA_STORE` resolution at line 223.
10. **`packages/di-plugin/src/index.ts`** — Reference for plugin export patterns.
11. **`packages/di-plugin/src/plugin/di-plugin.ts`** — Reference for plugin factory pattern, options
    interface, registration flow.
12. **`packages/di-plugin/test/fixtures/fake-context.ts`** — Fixture pattern to follow.
13. **`packages/logger-plugin/test/fixtures/fake-runtime.ts`** — Fake runtime pattern to follow.
14. **`packages/config-plugin/test/fixtures/fake-runtime.ts`** — `IFileSystem` fixture pattern.

---

## Step 0 — Branch Rule

**Before reading docs or writing code:**

```bash
git branch --show-current
# If it prints "main":
git switch -c feat/m9-decorator-plugin
# If it already prints the branch, continue on it.
```

**Never work on or commit to `main`.** All work stays on `feat/m9-decorator-plugin` until merge.

---

## Package Structure

```
packages/decorator-plugin/
├── deno.json
├── src/
│   ├── index.ts                          # Barrel exports
│   ├── plugin/
│   │   └── decorator-plugin.ts           # DecoratorPlugin factory
│   ├── metadata/
│   │   └── metadata-store.ts             # IMetadataStore implementation + internal metadata types
│   ├── decorators/
│   │   ├── controller.ts                 # @Controller, @Version
│   │   ├── http.ts                       # @Get, @Post, @Put, @Patch, @Delete, @Head, @Options
│   │   ├── injection.ts                  # @Injectable, @Inject
│   │   ├── request.ts                    # @Body, @Query, @Param, @Header, @Cookie
│   │   ├── security.ts                   # @Roles, @Permissions, @CurrentUser, @Public
│   │   ├── pipeline.ts                   # @UseGuards, @UseInterceptors, @UseFilters
│   │   ├── validation.ts                 # @ValidateBody, @ValidateQuery, @ValidateParams
│   │   └── openapi.ts                    # @ApiTags, @ApiOperation, @ApiResponse
│   ├── discovery/
│   │   └── controller-discovery.ts       # Auto-discovery of decorated classes
│   └── resolvers/
│       └── parameter-resolver.ts         # Resolves @Body/@Query/@Param from IRequestContext
└── test/
    ├── fixtures/
    │   ├── fake-context.ts               # Fake IPluginContext with observable internals
    │   ├── fake-runtime.ts               # Deterministic IRuntimeServices
    │   ├── fake-request-context.ts       # Fake IRequestContext for parameter resolver tests
    │   └── fake-lifecycle.ts             # Fake ILifecycleApi tracking hook registrations
    ├── unit/
    │   ├── metadata-store.test.ts
    │   ├── controller-decorator.test.ts
    │   ├── http-decorator.test.ts
    │   ├── injection-decorator.test.ts
    │   ├── request-decorator.test.ts
    │   ├── security-decorator.test.ts
    │   ├── pipeline-decorator.test.ts
    │   ├── validation-decorator.test.ts
    │   ├── openapi-decorator.test.ts
    │   ├── parameter-resolver.test.ts
    │   ├── create-decorator.test.ts
    │   └── controller-discovery.test.ts
    ├── integration/
    │   └── decorator-plugin.test.ts
    └── e2e/
        └── decorator-application.test.ts
```

---

## Key Implementation Rules

- **No runtime-specific APIs** — Use `IRuntimeServices` only. No `Deno`, `process`, `fs`, or
  `Date.now()`.
- **No `any` type** — Use `unknown` with narrowing, or generics.
- **No `import` from another plugin** — Only `@hono-enterprise/common` and optionally
  `@hono-enterprise/kernel`.
- **`import type` for type-only imports** — `verbatim-module-syntax` lint rule.
- **No `export default`** — Named exports only.
- **No `enum`** — String literal union types.
- **JSDoc on every export** — `@param`, `@returns`, `@throws`, `@example`, `@since`.
- **Update PUBLIC_API.md** — Every new export in `src/index.ts` must be documented there.
- **Test framework** — `@std/testing/bdd` + `@std/expect`.
- **90%+ per-file coverage** on branch, function, AND line.

---

## Verification Gates (run after ALL code is written)

```bash
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage    # Read per-file table — enforce 90%+ yourself
```

**Forbidden construct grep:**

```bash
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/decorator-plugin/src
```

**DO NOT push or create PRs.** Once all gates pass and everything is committed, stop and report the
results.

---

## Implementation Order

Follow the plan's implementation order:

1. Update `deno.json` with dependencies
2. `src/metadata/metadata-store.ts` — Core storage layer
3. Decorators (any order, but test each before moving on):
   - `src/decorators/controller.ts`
   - `src/decorators/http.ts`
   - `src/decorators/request.ts`
   - `src/decorators/injection.ts`
   - `src/decorators/security.ts`
   - `src/decorators/pipeline.ts`
   - `src/decorators/validation.ts`
   - `src/decorators/openapi.ts`
4. `src/resolvers/parameter-resolver.ts`
5. `src/discovery/controller-discovery.ts`
6. `src/plugin/decorator-plugin.ts`
7. `src/index.ts` — Barrel exports with JSDoc
8. Fixtures, then unit tests, then integration tests, then e2e tests
9. Update `PUBLIC_API.md`
10. Run verification gates
11. Update `CLAUDE.md` and `ROADMAP.md` milestone tracking

---

## Critical Reminders from CLAUDE.md

- **Never mix clocks** — `ctx.startTime` is `runtime.hrtime()` (monotonic), NOT `Date.now()`
  (epoch).
- **A lazily-loaded optional dep must ACTUALLY load** — Use `await import('npm:<pkg>')`, never a
  `globalThis.__x` hook.
- **Read coverage ANSI-stripped, per file** — `sed 's/\x1b\[[0-9;]*m//g'` and confirm every `src`
  file is ≥90% on branch, function, AND line.
- **Every option must be consumed** — Grep that each option name appears somewhere BEYOND its
  declaration.
- **A no-op change passes every gate** — Prove the change works: for decorators, assert metadata is
  stored AND the plugin reads it.
- **Flipping milestone status IN the milestone PR** — Update `CLAUDE.md` "Current status" and
  `ROADMAP.md` tracking table on the `feat/` branch.
