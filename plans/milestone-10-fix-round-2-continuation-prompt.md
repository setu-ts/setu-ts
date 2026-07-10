# Milestone 10 Fix Round 2 — Continuation Prompt

## Context

Branch: `feat/m10-database-plugin` (verify with `git branch --show-current` before starting — NEVER
touch `main`)

The **source code for all 10 defects is structurally complete**. What remains is test type-fixing,
new test files, documentation updates, and verification gates. Read
[`plans/milestone-10-fix-round-2.md`](plans/milestone-10-fix-round-2.md) and
[`CLAUDE.md`](CLAUDE.md) before starting.

## What's Already Done (do NOT redo)

- **A1**: [`src/adapters/adapter.ts`](packages/database-plugin/src/adapters/adapter.ts) —
  `IAdapterTransaction` + `IDatabaseAdapter` internal contracts (NOT exported from `src/index.ts`)
- **A2**:
  [`src/services/database-service.ts`](packages/database-plugin/src/services/database-service.ts) —
  accepts `IDatabaseAdapter` + `now()` param, single `wrapDataSource()` logging wrapper,
  `InternalRepo`, scoped UoW factory
- **A3**: `query()` delegates `rawQuery()`; `migrate()` throws uniform error for all adapters
- **A4**: [`src/plugin/database-plugin.ts`](packages/database-plugin/src/plugin/database-plugin.ts)
  — wired `now()` from `ctx.runtime.hrtime()`, returns `IDatabaseAdapter`, dropped logger arg
- **Defect 1a**:
  [`createPrismaDataSource(client, entity)`](packages/database-plugin/src/adapters/prisma/prisma-adapter.ts:300)
  — lowercased-first-letter delegate, P2025 → false/throw
- **Defect 1b**:
  [`createDrizzleDataSource(instance, entity, tables, operators)`](packages/database-plugin/src/adapters/drizzle/drizzle-adapter.ts:324)
  — 4 args, operators from `import('npm:drizzle-orm@0.33.0')`, no `.returning()`
- **Defect 2a**: Prisma two-deferred bridge in `beginTransaction()` (`txReady` + `hold`)
- **Defect 2b**: Drizzle bridge via `instance.transaction(fn)`
- **Defect 2c**: Memory per-tx overlay (creates array, shadows Map, tombstones Set) in
  [`MemoryAdapter`](packages/database-plugin/src/adapters/memory/memory-adapter.ts)
- **Defect 4**: `$use`/`enableQueryLogging` deleted; logging via `DatabaseService.wrapDataSource()`
- **Defect 5**: Both fakes rewritten —
  [`fake-prisma-client.ts`](packages/database-plugin/test/fixtures/fake-prisma-client.ts) and
  [`fake-drizzle-instance.ts`](packages/database-plugin/test/fixtures/fake-drizzle-instance.ts)
- **Defect 6**: JSDoc `npm:prisma` → `npm:@prisma/client` fixed
- **Defect 7**: Prisma lazy-load error reworded
- **Repo files**:
  [`prisma-repository.ts`](packages/database-plugin/src/adapters/prisma/prisma-repository.ts) and
  [`drizzle-repository.ts`](packages/database-plugin/src/adapters/drizzle/drizzle-repository.ts) now
  re-export `createDataSource` from their adapter files

## What Remains — Task List

### Phase 1: Fix Remaining Type Errors (run `cd packages/database-plugin && deno test` iteratively)

There are **~11 type errors** remaining in test files. Key issues:

1. **`test/fixtures/fake-prisma-client.ts`**:
   - `findMany()` line ~89: `Object.entries(args.where)` — `args.where` is
     `Record<string, unknown> | undefined`. Fix: copy to const first or assert non-null inside the
     `if (args?.where)` guard
   - `findMany()` lines ~101-102: `a[key] < b[key]` — `a[key]` is `unknown`. Fix: cast to `string`
     or `number` with `(a[key] as string)`
   - `count()` line ~174: same `Object.entries(args.where)` issue — same fix
   - Line ~223: `const client = {` self-referential implicit `any` — the object references itself in
     `$transaction` callback. Fix: declare type explicitly as
     `ReturnType<typeof createFakePrismaClient>` using a forward-declared type, or cast `this` in
     the callback

2. **`test/unit/drizzle-repository.test.ts`**:
   - `createDrizzleDataSource()` takes **4 args**: `(instance, entity, tables, operators)`. Tests
     pass only 2. Fix: add `{ user: {} }` as tables and
     `{ eq: () => ({}), and: () => ({}), asc: () => ({}), desc: () => ({}) }` as operators to all
     calls
   - The cast `fakeDb as unknown as DrizzleAdapter` is wrong — should be `fakeDb` directly (it
     already matches the `DrizzleInstance` type from the adapter)

### Phase 2: Create New Test Files

3. **`test/e2e/database-application.test.ts`** — Full kernel app via `createApplication()`:
   - Register `RuntimePlugin()` + `DatabasePlugin({ adapter: 'memory' })`
   - Create a route that writes via `db.getRepository('User').create()`
   - Create a route that reads back via `db.getRepository('User').findById()`
   - Create a route that does a transaction that fails mid-way — verify no partial writes survive
   - Use `app.inject()` to exercise each route
   - Assert every write is readable

4. **`test/integration/real-import.test.ts`** — Guarded real-import test:
   - Attempt `import('npm:@prisma/client@7.8.0')` — assert the import either succeeds or throws a
     descriptive error mentioning `prisma generate`
   - Attempt `import('npm:drizzle-orm@0.33.0')` — assert the import resolves the
     `eq`/`and`/`asc`/`desc` operators
   - Do NOT add deno.json test-permissions (root task already grants read/import)
   - Guard with try/catch so network failures don't fail CI

### Phase 3: Documentation Fixes

5. **Defect 8 — Trim [`src/index.ts`](packages/database-plugin/src/index.ts)**:
   - Remove internal exports (query-builder helpers like `applyOrderBy`, `applyPagination`,
     `matchesWhere`, `normalizeQuery`, `projectFields`, `normalizeCountOptions`, `NormalizedQuery`)
   - Keep public set: `DatabasePlugin`, `DatabaseService`, `MemoryAdapter`, `PrismaAdapter`,
     `DrizzleAdapter`, `BaseRepository`, `UnitOfWork`, `DataSource` type, and all interfaces from
     `interfaces/index.ts`
   - Update [`PUBLIC_API.md`](PUBLIC_API.md) DatabasePlugin section (lines ~676-817) to match: add
     `MemoryAdapter` export entry, document `drizzleTables` option, document `database.<name>`
     dot-namespacing, fix `ctx.request.json<T>()` usage

6. **Defect 9 — Flip [`ROADMAP.md`](ROADMAP.md) row 10**: Find the Progress Tracking table
   (~line 3336) and change M10 from `⬜` to `✅`

7. **Update [`plans/milestone-10-database-plugin.md`](plans/milestone-10-database-plugin.md)**:
   - Internal Ports section (~line 276): document that `src/adapters/adapter.ts` now defines
     `IAdapterTransaction` + `IDatabaseAdapter` (NOT exported)
   - Decision 7 (~line 401): note 3 deviations:
     1. Prisma bridge uses two deferreds (txReady + hold) with sentinel-swallow on rollback
     2. Memory overlay covers update shadows + delete tombstones (not just creates)
     3. Drizzle operators loaded from `import('npm:drizzle-orm@0.33.0')` at connect time, never from
        instance

### Phase 4: Verification Gates

8. Run all gates from repo root:
   ```bash
   deno task fmt:check
   deno task lint
   deno task check
   deno task test
   ```
   All must pass. Fix issues iteratively.

9. **Coverage** — every `src/` file must be ≥90% (branch/function/line):
   ```bash
   cd packages/database-plugin && deno task test:coverage
   ```
   Paste the ANSI-stripped per-file coverage table.

10. **Grep forbidden constructs** in `packages/database-plugin/src/`:
    ```bash
    grep -rn '\bany\b' packages/database-plugin/src/ --include='*.ts' | grep -v 'node_modules' | grep -v '.test.'
    grep -rn 'console\.' packages/database-plugin/src/ --include='*.ts'
    grep -rn 'Date\.now' packages/database-plugin/src/ --include='*.ts'
    grep -rn '\$use' packages/database-plugin/src/ --include='*.ts'
    ```
    All must be empty. Paste results.

11. **Behavioral driver** in `.verify-m10-fix/`:
    - Create a kernel app that exercises: create → read-back → update → read-back → transaction
      commit → transaction rollback isolation
    - Paste all outputs
    - Delete the directory after verification

### Phase 5: Commit

12. Commit on `feat/m10-database-plugin` with conventional messages:
    ```
    fix(database-plugin): implement real adapter data sources, transaction scoping, and query logging

    - Replace no-op Prisma/Drizzle data source stubs with real delegate calls
    - Implement two-deferred transaction bridge for Prisma and Drizzle
    - Add per-transaction overlay for MemoryAdapter (shadows + tombstones)
    - Delete dead $use/enableQueryLogging; add single wrapDataSource wrapper
    - Rewrite fake fixtures to real v7 shapes with P2025 errors
    - Fix JSDoc, trim index.ts exports, update PUBLIC_API.md and ROADMAP.md
    ```
    Do NOT push. Hand back `git push` and `gh pr create` commands.

## Key Constructor Signatures (for test fixes)

**`DatabaseService` constructor (6 params):**

```typescript
new DatabaseService(
  adapter: IDatabaseAdapter,
  createDataSource: (entity: string) => DataSource,
  adapterType: DatabaseAdapterType,
  options?: DatabaseAdapterOptions,
  logger?: { debug(msg: string, meta?: Record<string, unknown>): void },
  now?: () => number,
)
```

**`createDrizzleDataSource` (4 params):**

```typescript
createDrizzleDataSource(
  instance: DrizzleInstance,
  entity: string,
  tables: Record<string, unknown>,
  operators: Record<string, unknown>,
)
```

**`createPrismaDataSource` (2 params):**

```typescript
createPrismaDataSource(client: PrismaClient, entity: string)
```

**`UnitOfWork` constructor (2 params):**

```typescript
new UnitOfWork(
  transaction: ITransaction,
  repoFactory: (entity: string) => IRepository<unknown>,
)
```
