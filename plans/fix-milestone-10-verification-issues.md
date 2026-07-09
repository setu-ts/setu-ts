# Fix Milestone 10 Verification Issues — Action Plan

**Branch:** `feat/m10-database-plugin` (all fixes must land on this branch)

---

## Issues to Fix

### 1. Per-File Coverage Below 90% Bar

**Affected files:**

| File                  | Branch    | Function  | Line      | What's Missing                                                                    |
| --------------------- | --------- | --------- | --------- | --------------------------------------------------------------------------------- |
| `drizzle-adapter.ts`  | 100%      | **0%**    | **3.8%**  | No tests exercise adapter methods at all                                          |
| `prisma-adapter.ts`   | 100%      | **0%**    | **2.8%**  | No tests exercise adapter methods at all                                          |
| `database-plugin.ts`  | **45.8%** | 100%      | **68.8%** | Missing tests for named connections, logger resolution, adapter creation branches |
| `database-service.ts` | **81.2%** | **70.6%** | **77.4%** | Missing tests for closed-state guards, query() logging path, migrate() delegation |

**Fix:**

- **1a.** Add `test/unit/drizzle-adapter.test.ts` — unit tests via fake Drizzle instance covering:
  injected-instance structural validation (accept/reject), lifecycle
  (`connect`/`disconnect`/`isReady`), transaction handling, unsupported `migrate()` throw. See plan
  Design Decision 6 and Test Strategy table.
- **1b.** Add `test/unit/drizzle-repository.test.ts` — each `IEntityDataSource` op maps to the right
  Drizzle calls; pagination/ordering. Via `test/fixtures/fake-drizzle-instance.ts`.
- **1c.** Add `test/unit/prisma-adapter.test.ts` — lifecycle, injected-client validation,
  `$transaction` deferred-promise bridge: commit resolves, rollback rejects, no double-settle.
  Lazy-import failure surfaces install/generate error. Via `test/fixtures/fake-prisma-client.ts`.
- **1d.** Add `test/unit/prisma-repository.test.ts` — data-source ops mapped to Prisma delegate
  calls (`findUnique`, `findMany` with where/orderBy/take/skip/select, `create`, `update`, `delete`,
  `count`); missing-row paths. Via `test/fixtures/fake-prisma-client.ts`.
- **1e.** Add `test/fixtures/fake-prisma-client.ts` — fake Prisma client honoring real
  `$transaction`/delegate shapes.
- **1f.** Add `test/fixtures/fake-drizzle-instance.ts` — fake Drizzle instance honoring real
  query-builder shape.
- **1g.** Extend `test/unit/plugin.test.ts` — add tests for: named instance derived plugin name,
  `provides: ['database.<name>']`, bare token NOT claimed, invalid connection name throws, missing
  optional logger does not fail.
- **1h.** Extend `test/unit/database-service.test.ts` — add tests for: closed-state guards on
  `getRepository()`/`transaction()`, query() logging path with `logQueries: true`, migrate()
  delegation.

### 2. Colon Token Violation for Named Connections

**Current code:**
[`database-plugin.ts:71`](packages/database-plugin/src/plugin/database-plugin.ts:71)

```typescript
const token = connectionName === 'default' ? CAPABILITIES.DATABASE : `database:${connectionName}`;
```

**Problem:** `createCapabilityToken` grammar forbids colons — only lowercase kebab-case with dot
namespacing is legal. Plan Design Decision 5 explicitly requires `database.<name>`.

**Fix:**

- **2a.** Change token derivation to use `createCapabilityToken('database', connectionName)` which
  produces `database.primary` etc.
- **2b.** Validate connection name to lowercase kebab-case (so derived token passes
  `createCapabilityToken`).
- **2c.** Update plugin name per instance: default → `database-plugin`; named →
  `database-plugin.<name>` (avoids duplicate name at startup).
- **2d.** Named connection `provides` only `['database.<name>']` — NOT bare `database` token (avoids
  duplicate capability provider collision).
- **2e.** Add test: two named instances coexist (`database.primary` + `database.analytics`);
  duplicate default throws.

### 3. `query()` and `migrate()` Don't Throw on Memory Adapter

**Current code:**
[`database-service.ts:115-130`](packages/database-plugin/src/services/database-service.ts:115) —
`query()` returns `[]`, `migrate()` is no-op.

**Problem:** JSDoc `@throws` claims and Design Decision 7 ("Unsupported Operations Fail Loudly") say
memory adapter must throw. PUBLIC_API.md documents these `@throws`.

**Fix:**

- **3a.** In `DatabaseService.query()`, check adapter type and throw
  `Error('The memory adapter does not support raw SQL queries.')` for memory.
- **3b.** In `DatabaseService.migrate()`, throw
  `Error('The memory adapter does not support migrations.')` for memory.
- **3c.** Or better: move throws into `MemoryAdapter.rawQuery()` and `MemoryAdapter.migrate()` so
  the adapter itself fails loudly, and `DatabaseService` delegates. This is cleaner and matches
  `IOrmAdapter` + internal `IDatabaseAdapter` design.
- **3d.** Add tests asserting the exact throw messages.

### 4. `queryEntities()` Null-Safety Bug

**Current code:**
[`memory-adapter.ts:123`](packages/database-plugin/src/adapters/memory/memory-adapter.ts:123)

```typescript
if (Object.keys(query.where).length > 0) {  // crashes when query.where is undefined
```

**Problem:** `NormalizedQuery.where` is optional (`exactOptionalPropertyTypes`-safe), so it may be
omitted. `Object.keys(undefined)` throws.

**Fix:**

- **4a.** Change to `if (query.where && Object.keys(query.where).length > 0)` or
  `if (Object.keys(query.where ?? {}).length > 0)`.
- **4b.** Add test: `queryEntities()` with query omitting `where` returns all entities.

### 5. Dead `poolSize` Option

**Current code:**
[`interfaces/index.ts:237-241`](packages/database-plugin/src/interfaces/index.ts:237) — `poolSize`
declared but never consumed.

**Problem:** Plan says poolSize was "cut" (Design Decision 5) but it still exists. An option that is
only declared and stored is a defect (dead-option rule).

**Fix:**

- **5a.** Remove `poolSize` from `DatabaseAdapterOptions` interface.
- **5b.** Remove `poolSize` handling from `buildAdapterOptions()` in `database-plugin.ts`.
- **5c.** Update JSDoc on `DatabaseAdapterOptions` noting pool sizing lives on the connection URL or
  injected client.

### 6. Fix `DatabaseService` Adapter-Type Awareness

**Current code:**
[`database-service.ts:156`](packages/database-plugin/src/services/database-service.ts:156) — Uses
`as MemoryAdapter` cast and runtime check.

**Problem:** `DatabaseService` only works with `MemoryAdapter` because it casts
`this._adapter as MemoryAdapter`. For Prisma/Drizzle paths, the service needs to know which adapter
to create data sources for. The current design can't handle multi-adapter correctly.

**Fix:**

- **6a.** Change constructor to accept the adapter type and a `createDataSource` factory function
  instead of doing type guessing. This is the clean injection pattern:
  ```typescript
  constructor(
    private readonly _adapter: IOrmAdapter,
    private readonly _createDataSource: (entity: string) => DataSource,
    ...
  )
  ```
- **6b.** `database-plugin.ts` passes the correct factory per adapter type
  (`createMemoryDataSource`, `createPrismaDataSource`, `createDrizzleDataSource`).
- **6c.** Update all test fixtures to pass the factory.

### 7. Update Tracking Documents

**Fix:**

- **7a.** Update `CLAUDE.md` — Change "Next milestone — Milestone 10" to mark Milestone 10 complete
  and point "Next milestone" at Milestone 11.
- **7b.** Update `ROADMAP.md` — Check ✅ all Milestone 10 deliverables.
- **7c.** Update `PUBLIC_API.md` — Apply three committed-doc corrections:
  - Multiple Databases: `database:primary` → `database.primary` (colon → dot)
  - Registration example: remove `poolSize`, show injection as preferred path
  - Database Interface: `IRepository<Entity, Id = string>` generic widening; document
    `query()`/`migrate()` `@throws` per adapter

---

## Execution Order

1. **Fix 4** — `queryEntities()` null-safety (quick fix, unblocks behavioral exercise)
2. **Fix 3** — `query()`/`migrate()` throws on memory adapter
3. **Fix 5** — Remove `poolSize` dead option
4. **Fix 2** — Colon → dot token for named connections
5. **Fix 6** — Adapter-type awareness in `DatabaseService` (factory injection)
6. **Fix 1** — Add missing tests (1a–1h) to bring coverage ≥90%
7. **Fix 7** — Update CLAUDE.md, ROADMAP.md, PUBLIC_API.md
8. **Run gates:** `deno task fmt:check && deno task lint && deno task check && deno task test`
9. **Run coverage:** `deno task test:coverage` — verify all files ≥90%
10. **Re-verify:** Run behavioral exercise script one final time

---

## Self-Review Checklist (post-fix)

- [ ] Every `src/` file ≥90% on branch, function, AND line
- [ ] No forbidden constructs
      (`grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__"`)
- [ ] Every option read on a real code path (no dead options)
- [ ] `query()`/`migrate()` throw on memory adapter with documented messages
- [ ] Named connections use `database.<name>` tokens
- [ ] `queryEntities()` handles omitted `where` without crashing
- [ ] CLAUDE.md marks Milestone 10 complete
- [ ] ROADMAP.md Milestone 10 deliverables checked ✅
- [ ] PUBLIC_API.md three corrections applied
- [ ] Behavioral exercise passes end-to-end
