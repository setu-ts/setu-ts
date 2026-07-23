# Milestone 26 — Audit Plugin (`@hono-enterprise/audit-plugin`)

> **Status:** Planning. Branch: `feat/26-audit-plugin`. `main` is protected — all work (implementation +
> fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Provide an immutable audit trail as a plugin: a single `IAuditLogger` (already committed in `common`)
registered under `CAPABILITIES.AUDIT`, backed by a pluggable internal `IAuditStorage` port.
`AuditService.log()` stamps each committed `AuditEntry` with an internally-assigned `id`
(`runtime.uuid()`) and wall-clock `timestamp` (`runtime.now()`), deep-freezes the record (immutability),
and appends it to the selected storage. Four storage backends ship: `MemoryAuditStorage`
(zero-dependency default, runs on every target including Cloudflare Workers), `LogAuditStorage` (routes
structured records to the resolved `ILogger`), `DatabaseAuditStorage` (appends through an injected
`IAuditDbClient` — inject-only, since there is no canonical SQL driver to lazy-load), and
`FileAuditStorage` (JSONL over `runtime.fs`, Node/Deno/Bun only). This is a pure-plugin milestone: the
contract (`AuditEntry`/`IAuditLogger`) and token (`CAPABILITIES.AUDIT = 'audit'`) are already committed
in `common` (M1) — no `common` change, no new capability token (mirrors M25 secrets).

- **In scope:** `AuditPlugin` factory; `AuditService` (`log` + stamp/freeze); four storage backends
  (`Memory`, `Log`, `Database`, `File`); internal `IAuditStorage` port plus `StoredAuditEntry`/
  `AuditQuery` (not exported); pure record transforms (freeze, query-match, row serialize/deserialize);
  injected `IAuditDbClient` structural interface; `audit` health indicator; README; PUBLIC_API.md +
  ROADMAP + CLAUDE.md status updates.
- **NOT this milestone:** a public read/query API on the `IAuditLogger` capability (the committed
  contract is write-only, like `ILogger`; widening it is a `common` change — deferred, see §3.3 and §9);
  an automatic audit middleware recording every request and security error (ROADMAP lists none for M26;
  ARCHITECTURE §13's "errors are audited" is aspirational cross-cutting owned by a future
  middleware/interceptor milestone); consuming the `database` capability token at runtime (ARCHITECTURE
  scopes audit to `common`/`kernel`/`logger` — the DB backend takes an injected client, never the
  `database` token).

## 1. Contracts verified from SOURCE (not names)

| Reference                  | Source (file:line)                          | Verified surface / fact                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IAuditLogger`             | `packages/common/src/services/audit.ts:48-56` | Exactly one async method: `log(entry: AuditEntry): Promise<void>`. Write-only — no `query`/`get`/`list`. (Drives §3.3: retrieval is not on the public service.)                                                  |
| `AuditEntry`               | `packages/common/src/services/audit.ts:13-30` | `readonly action: string`, `resource: string`, `resourceId?: string`, `userId?: string`, `result` is `success` or `failure`, `before?`/`after?`/`metadata?: Readonly<Record<string, unknown>>`. **No `id`, no `timestamp`** — the plugin adds those internally as `StoredAuditEntry`. |
| `CAPABILITIES.AUDIT`       | `packages/common/src/tokens.ts:75`          | Value is the literal `'audit'` (lowercase, dot-free — passes the `createCapabilityToken` grammar). One provider only; the resolver throws on duplicate capability providers, so `AuditPlugin` is single-instance. |
| `IAuditLogger`/`AuditEntry` export | `packages/common/src/index.ts:151`   | Re-exported as types from `common`; the plugin re-exports them from its own `index.ts` (mirrors `secrets-plugin` re-exporting `ISecretManager`).                                                                 |
| `IServiceRegistry.register` | `packages/common/src/registry.ts:66`        | `register<T extends object>(token, service, options?)` — `T extends object`, so the `AuditService` class instance registers cleanly; throws on duplicate without `override`.                                    |
| `IPluginContext`           | `packages/common/src/plugin.ts:409-448`     | Non-optional `runtime` (435); optional `logger?: ILogger` directly on context (439); `services` (411), `health` (419), `lifecycle` (429) present. Used for `services.register`, `health.register`, `lifecycle.onClose`, `runtime`. |
| `IRuntimeServices.uuid`    | `packages/common/src/runtime.ts:143`        | `uuid(): string` — UUID v4; supplies the audit record `id`.                                                                                                                                                     |
| `IRuntimeServices.now`     | `packages/common/src/runtime.ts:159`        | `now(): number` — **wall-clock ms since epoch** (not the monotonic `hrtime`). Correct for a compliance timestamp and does not mix clocks (CLAUDE.md clock rule).                                                |
| `IFileSystem` (no append)  | `packages/common/src/runtime.ts:49-104`     | Has `readFile`/`writeFile`/`stat`/`readdir`/`mkdir`/`rm`/optional `realPath` — **no append primitive**. `FileAuditStorage` therefore does read-modify-write (read JSONL, append a line, write whole), not native append (drives §3.5 + risk). |
| `IRuntimeServices.fs`      | `packages/common/src/runtime.ts:207`        | `readonly fs?: IFileSystem` — optional, absent on edge/Workers. `FileAuditStorage` throws at `register()` when `fs` is absent (drives §2 C3 + tested throw).                                                    |
| `ILogger`                  | `packages/common/src/services/logger.ts:29-81` | `info(message, metadata?: LogMetadata)` and siblings; `LogMetadata = Readonly<Record<string, unknown>>` (14). `LogAuditStorage` calls `logger.info('audit', record)`. `ctx.logger` is the optional source.     |
| `HealthIndicatorFn`        | `packages/common/src/services/health.ts:26` | `() => Promise<HealthCheckResult>`; `HealthCheckResult = { status: HealthStatus; data?: ... }` (13). The `audit` indicator reports `storage.isReady() ? 'up' : 'down'`.                                          |
| Inject-only client precedent | `packages/cache-plugin/src/stores/redis-store.ts` (`validateClient`) | Structural client injected via options and validated, else a lazy import. For the DB backend there is no canonical driver to lazy-load, so it is **inject-only** — a missing client is a documented, tested throw (see §3.5). |
| Plan-lint canonical root   | `scripts/plan-lint.ts:41`                    | `milestone-\d+-[a-z0-9.-]+\.md` is permitted at `plans/` root; this file's name conforms. All nine required sections are present; no unfilled placeholders and no undecided-alternative markers remain (verified by grepping the plan against the marker rules). |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                       | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                                          | Doc deliverable (same PR)                                                                                                  |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| C1 | ROADMAP §M26 shows `storage: 'database'` as the registration example, but a zero-config default must be zero-dependency and run on every target (incl. CF Workers); AI_GUIDELINES §13.4 mandates the lowest-friction secure default. | Default `storage` is `'memory'` (zero-dependency, universal). `'database'` (and `'log'`, `'file'`) remain valid explicit opt-ins; the ROADMAP example stays valid as an explicit choice.                                                                                                                                                                                            | PUBLIC_API.md notes the default is `'memory'` and that memory is non-durable; ROADMAP §M26 example gains a one-line "default is memory" note. |
| C2 | ARCHITECTURE lists audit's dependencies as "`common`, `kernel` (consumes `logger` capability via token)", implying logger is always consumed — but only the `'log'` backend uses it. | `logger` is declared in `optionalDependencies` (not hard `dependencies`); it is consumed only by `LogAuditStorage`, which throws at `register()` when `storage: 'log'` and no logger is registered. The other three backends never touch it.                                                                                                                                         | ARCHITECTURE §8 audit row and PUBLIC_API note that the logger is consumed only by the `log` backend.                       |
| C3 | ROADMAP §M26 note says `FileAuditStorage` (writable FS) is Node/Deno/Bun-only, and the committed `IFileSystem` has no `appendFile`.                                             | `FileAuditStorage` persists JSONL via `runtime.fs` read-modify-write (`readFile`, append one line, `writeFile`), and throws at `register()` when `runtime.fs` is absent (Workers/edge). Documented as a Node/Deno/Bun-only backend.                                                                                                                                                 | README and PUBLIC_API note the FS constraint and the read-modify-write strategy.                                           |
| C4 | ROADMAP/ARCHITECTURE list "audit trail retrieval" and "logs are immutable", but the committed `IAuditLogger` is write-only (`log`) and `AuditEntry` carries no `id`/`timestamp`. | Keep `IAuditLogger`/`AuditEntry` unchanged (no `common` change, M25 precedent). The plugin assigns internal `id` + `timestamp` as `StoredAuditEntry`, deep-freezes records (immutability), and exposes retrieval at the internal `IAuditStorage.query()` port, proven by write-then-read-back tests. No public query API ships this milestone (§3.3, §9).                            | PUBLIC_API notes `AuditEntry` is the write shape; stored records add `id`/`timestamp` internally and are immutable.        |

## 3. Design decisions

### 3.1 Service ↔ storage seam (internal port)

- **Decision:** An internal `IAuditStorage` port — `append(entry: StoredAuditEntry): Promise<void>` and
  `query(criteria?: AuditQuery): Promise<StoredAuditEntry[]>` — declared in `src/interfaces/index.ts`
  and **NOT** exported from `src/index.ts`. `AuditService` composes one storage; the committed
  `IAuditLogger.log` delegates to `storage.append` after stamping and freezing.
- **Why:** `IAuditLogger` is a thin write contract with no notion of id/timestamp or backend; a storage
  port keeps those concerns in the implementations (Interface Segregation; mirrors `SecretProvider`
  behind `SecretsService` in M25, and `ICacheStore` behind `CacheService`).
- **Test home:** `audit-service.test.ts` drives `log()` against a fake storage (asserts it appends a
  stamped and frozen record); each backend test exercises a real storage.

### 3.2 Stored record shape + immutability

- **Decision:** `StoredAuditEntry = AuditEntry & { readonly id: string; readonly timestamp: number }`.
  `AuditService.log()` builds
  `const record = freezeAuditRecord({ ...entry, id: runtime.uuid(), timestamp: runtime.now() })` then
  `await storage.append(record)`. `freezeAuditRecord` (pure, in `src/storage/audit-record.ts`)
  deep-freezes the record and its nested `before`/`after`/`metadata` so a stored entry cannot be
  mutated thereafter (ARCHITECTURE: "audit logs are immutable").
- **Why:** the committed `AuditEntry` has no id/timestamp and only shallow-`readonly` fields; deep-freeze
  enforces immutability for real (mutation throws in strict mode), and centralizing it in one pure
  function makes the input-to-output transform directly unit-testable.
- **Test home:** `audit-record.test.ts` asserts a frozen record's nested-field mutation throws, and
  `audit-service.test.ts` asserts the appended record carries a fresh `id`/`timestamp`.

### 3.3 Retrieval model (no public query API)

- **Decision:** `IAuditLogger` stays exactly as committed (write-only). Retrieval lives on the internal
  `IAuditStorage.query()` port and is consumed by integration tests that write an entry then read it back
  through the same storage (per CLAUDE.md "for every write, READ IT BACK"). No symbol is exported for
  query this milestone.
- **Why:** widening the committed `IAuditLogger` (`@since 0.1.0`) is a `common` change; M25 set the
  no-`common`-change precedent for these contract-already-committed plugins. `ILogger` is the analogous
  write-only precedent (you read logs from the sink, not the logger). A public query surface with stable
  pagination/filtering semantics is a deliberate future `common` addition (§9), not an improvisation.
- **Test home:** `audit-integration.test.ts` — `log()` then `storage.query()` returns the entry; each
  backend unit test asserts read-back of its own writes.

### 3.4 Storage selection + naming

- **Decision:** `storage` is a closed union `'memory' | 'log' | 'database' | 'file'` (default
  `'memory'`). A `createStorage(type, options, ctx)` factory maps each id to its class; an unknown id
  throws at `register()`. `MemoryAuditStorage` is the default branch.
- **Why:** a closed union plus a single factory keeps the seam uniform (one branching point), and the
  default is the zero-dependency, runtime-portable choice (§13.4, conflict C1). `MemoryAuditStorage`
  follows the universal in-memory pattern of every storage/port in the repo (`MemoryStore`,
  `MemoryRateLimitStore`, `InMemoryBroker`, `MemoryQueue`, …).
- **Test home:** `audit-plugin.test.ts` asserts each id builds the matching class, an unknown id throws,
  and the default is `memory`.

### 3.5 Backend-specific semantics

- **Decision (memory):** `MemoryAuditStorage` holds a `StoredAuditEntry[]` in process; `append` pushes
  the already-frozen record; `query` filters via the shared `matchAuditQuery` predicate. `isReady()`
  returns `true`. Non-durable (documented).
- **Decision (log):** `LogAuditStorage` resolves a logger from `options.logger`, falling back to
  `ctx.logger`; at `register()`, when `storage: 'log'` and no logger is present, it throws
  `Error('LogAuditStorage requires the logger capability; register LoggerPlugin or choose another
  storage')`. `append` calls `logger[level]('audit', record)` where `level` defaults to `'info'`
  (configurable). `query` returns `[]` (the log sink is the durable trail; read-back is through the
  logging backend, not this object) — a documented, tested behavior for an interface method this
  implementation cannot meaningfully fulfill from process state.
- **Decision (database):** `DatabaseAuditStorage` is **inject-only**: it requires
  `options.client: IAuditDbClient` (structural: `insert(table, row)` plus `select(table, criteria?)`).
  There is no canonical SQL driver to lazy-load, so a missing client throws at `register()` with a clear
  error. `append` serializes the record to a flat row (`before`/`after`/`metadata` become JSON strings)
  via `toAuditRow` and calls `client.insert(table, row)`; `query` calls `client.select(table, criteria)`
  and maps rows back via `fromAuditRow`. `table` defaults to `'audit_logs'`.
- **Decision (file):** `FileAuditStorage` persists JSONL via `runtime.fs`: at `register()`, when
  `runtime.fs` is absent it throws (Workers/edge — conflict C3); otherwise `append` does
  read-modify-write — `readFile(path)` (empty when absent), decode, append `JSON.stringify(record) +
  '\n'`, `writeFile`. `query` reads and filters lines. `path` defaults to `'./audit.log'`.
- **Why:** each backend honors only what it can honestly support; unsupported paths are documented,
  tested throws (the planned behavior for a method an implementation cannot support), never silent
  no-ops or lies.
- **Test home:** one unit test per backend (memory/log/database/file) covering append, query, and the
  documented throw branch (no-logger / no-client / no-fs).

### 3.6 Health + lifecycle

- **Decision:** `register()` builds the storage via `createStorage`, constructs
  `AuditService(storage, runtime)`, registers it under `CAPABILITIES.AUDIT`, registers a health
  indicator named `audit` returning `{ status: storage.isReady() ? 'up' : 'down' }`, and registers
  `lifecycle.onClose` to flush/tear the storage down (File flushes any buffer; memory/log/database are
  stateless and close as no-ops).
- **Why:** mirrors the `cache-plugin`/`secrets-plugin` register wiring; graceful shutdown is mandatory
  (AI_GUIDELINES §14.5).
- **Test home:** `audit-integration.test.ts` — a real kernel app resolves `IAuditLogger`, logs an entry,
  reads it back, and the `audit` health indicator reports `up`.

## 4. Exported surface — every symbol names its consumer

| Exported symbol         | Kind    | Consumer / real code path that READS it                                                                                          |
| ----------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `AuditPlugin`           | factory | Application `app.register(AuditPlugin(...))`; integration test drives it through a kernel app.                                   |
| `AuditService`          | class   | Registered under `CAPABILITIES.AUDIT`; resolved by apps as `IAuditLogger`. Exported for replaceability/testing (mirrors `SecretsService`). |
| `MemoryAuditStorage`    | class   | Built by `createStorage('memory')` (default); exported for direct construction/injection in tests and apps.                      |
| `LogAuditStorage`       | class   | Built by `createStorage('log')`; exported for direct construction/injection.                                                     |
| `DatabaseAuditStorage`  | class   | Built by `createStorage('database')`; exported for direct construction/injection.                                                |
| `FileAuditStorage`      | class   | Built by `createStorage('file')`; exported for direct construction/injection.                                                    |
| `AuditPluginOptions`    | type    | Parameter of `AuditPlugin`; read by apps configuring the plugin.                                                                 |
| `AuditStorageType`      | type    | The `storage` field union; read by apps selecting a backend.                                                                     |
| `AuditStorageOptions`   | type    | The `options` field shape; read by `createStorage` and each backend constructor.                                                 |
| `IAuditDbClient`        | type    | Structural shape validated and consumed by `DatabaseAuditStorage`; the type of `options.client` for the database backend.        |
| `IAuditLogger`, `AuditEntry` | type | Re-exported from `common`; the interface apps type their resolved service as and the entry shape they pass to `log()`.         |

### 4.1 Options — every option names its consumer

| Option           | Consumer               | Behavior (per implementation)                                                                                       |
| ---------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `storage`        | `createStorage` in plugin | Selects the backend class; default `'memory'`. Unknown id throws.                                                |
| `options.table`  | `DatabaseAuditStorage` | Table name for `client.insert`/`select`; default `'audit_logs'`. Ignored by other backends.                       |
| `options.client` | `DatabaseAuditStorage` | Injected `IAuditDbClient`; required for `'database'` (throws when absent). Ignored by other backends.              |
| `options.path`   | `FileAuditStorage`     | JSONL file path; default `'./audit.log'`. Ignored by other backends.                                               |
| `options.level`  | `LogAuditStorage`      | Logger method to emit at (`'info'`/`'warn'`/`'error'`); default `'info'`. Ignored by other backends.               |
| `options.logger` | `LogAuditStorage`      | Injectable `ILogger` overriding `ctx.logger` (for tests/direct construction). Defaults to `ctx.logger`. Ignored by other backends. |

## 5. Implementation files

| File                             | Purpose                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `src/index.ts`                   | Barrel: plugin, service, four storage backends, option/client types, re-exported `IAuditLogger`/`AuditEntry`.            |
| `src/plugin/audit-plugin.ts`     | `AuditPlugin` factory; `createStorage`; health indicator and `onClose` wiring; logger/runtime resolution.                |
| `src/services/audit-service.ts`  | `AuditService implements IAuditLogger` — `log()` stamps `id`/`timestamp`, freezes, delegates to `IAuditStorage.append`.  |
| `src/interfaces/index.ts`        | Internal `IAuditStorage` port plus `StoredAuditEntry`/`AuditQuery` (type-only; NOT exported from `src/index.ts`).        |
| `src/storage/audit-record.ts`    | Pure transforms: `freezeAuditRecord`, `matchAuditQuery`, `toAuditRow`, `fromAuditRow`.                                   |
| `src/storage/memory-audit.ts`    | `MemoryAuditStorage` — in-process array; `append` plus `query` via `matchAuditQuery`.                                    |
| `src/storage/log-audit.ts`       | `LogAuditStorage` — routes frozen records to `ILogger`; no-logger throw; `query` returns `[]`.                           |
| `src/storage/database-audit.ts`  | `DatabaseAuditStorage` — inject-only `IAuditDbClient`; row serialize/deserialize; `table`.                               |
| `src/storage/file-audit.ts`      | `FileAuditStorage` — JSONL read-modify-write over `runtime.fs`; no-`fs` throw; `path`.                                   |
| `README.md`                      | Purpose, install, usage per backend, config options, runtime-portability/Workers notes.                                  |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                   | src covered                 | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/audit-record.test.ts`            | `storage/audit-record.ts`   | `freezeAuditRecord`: nested-field mutation throws (strict mode); primitives frozen. `matchAuditQuery`: record matches on each criterion (action/resource/resourceId/userId/result/from/to/limit) and is excluded on mismatch; `limit` truncates. `toAuditRow`/`fromAuditRow`: round-trip identity; `before`/`after`/`metadata` serialized as JSON strings and parsed back. Calls type-check against `StoredAuditEntry`/`AuditQuery`. |
| `test/unit/audit-service.test.ts`           | `services/audit-service.ts` | `log(entry)` calls `storage.append` once with a record carrying a fresh `id` (`runtime.uuid`) and `timestamp` (`runtime.now`); the appended record is the frozen superset of the input `AuditEntry`; a `failure` result passes through. Driven by a fake `IAuditStorage` recording appends; calls type-check against `IAuditLogger.log(entry: AuditEntry)`.                                                  |
| `test/unit/memory-audit.test.ts`            | `storage/memory-audit.ts`   | `append` then `query()` returns the entry in order; `query(criteria)` filters via `matchAuditQuery`; `isReady()` returns `true`; multiple entries preserve order.                                                                                                                                                                                                                                            |
| `test/unit/log-audit.test.ts`               | `storage/log-audit.ts`      | fake `ILogger` records `logger.info('audit', record)` on `append`; `level: 'warn'` routes to `logger.warn`; constructing without a logger (with `storage: 'log'`) throws the documented error; `query()` returns `[]`.                                                                                                                                                                                       |
| `test/unit/database-audit.test.ts`          | `storage/database-audit.ts` | fake `IAuditDbClient` records `insert(table, row)` on `append` and returns rows on `select`; row-to-record round-trips; `table` option threaded; constructing `'database'` without `options.client` throws the documented error. (No guarded real-import test — this backend is inject-only, with no lazy `npm:` driver.)                                                                                  |
| `test/unit/file-audit.test.ts`              | `storage/file-audit.ts`     | fake `IFileSystem`: `append` does read-modify-write producing `JSON.stringify(record) + '\n'` lines, multiple appends accumulate, absent file treated as empty; `query` reads and filters; constructing when `runtime.fs` is absent throws the documented error.                                                                                                                                            |
| `test/unit/audit-plugin.test.ts`            | `plugin/audit-plugin.ts`    | each `storage` id builds the matching class; unknown id throws; default is `memory`; `CAPABILITIES.AUDIT` registered as `AuditService`; `audit` health indicator registered; `onClose` registered; `storage: 'log'` without a logger throws at register.                                                                                                                                                    |
| `test/unit/barrel-exports.test.ts`          | `index.ts`                  | every documented symbol is exported and defined; `IAuditLogger`/`AuditEntry` re-exported from `common`.                                                                                                                                                                                                                                                                                                      |
| `test/integration/audit-integration.test.ts` | plugin + service + memory  | real kernel app: `register(AuditPlugin())`, resolve `IAuditLogger` from `CAPABILITIES.AUDIT`, `log({...})` an entry, read it back through the storage port, and assert the `audit` health indicator reports `up`.                                                                                                                                                                                            |
| `test/fixtures/fake-audit-db-client.ts`     | (fixture)                   | `IAuditDbClient` fake recording `insert`/`select` for the database unit test.                                                                                                                                                                                                                                                                                                                               |

> `src/interfaces/index.ts` is type-only (the port and its supporting types compile away to no
> executable statements); it is verified by `deno task check` (it type-checks the fakes and backends
> against the port) rather than by line coverage, the same way `secrets-plugin`'s internal
> `src/interfaces/index.ts` is treated.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/26-audit-plugin, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # ANSI-stripped per-file table; >=90% branch/function/line every src file
```

## 8. Risks & mitigations

- `IFileSystem` has no `appendFile`, so `FileAuditStorage` read-modify-write is O(file size) per append
  → documented tradeoff; audit write rates are low and the backend is opt-in; a future append/buffering
  primitive (out of scope) would remove it.
- Mutating a returned `StoredAuditEntry` after read could breach immutability → `freezeAuditRecord`
  deep-freezes before append; the freeze transform is unit-tested by asserting mutation throws.
- A `log()` failure (storage rejects) must not be swallowed → `AuditService.log` awaits
  `storage.append` and lets the rejection propagate (no try/catch swallow); tested with a rejecting
  fake storage.
- Mistaking the non-durable `memory` default for durable audit → README and PUBLIC_API state plainly
  that memory is non-durable and production must select `log`/`database`/`file`.
- The `database` backend has no default driver → inject-only `IAuditDbClient` with a tested throw when
  absent; the ROADMAP example omitting `client` is reconciled in §2 (C1/C4) doc deliverables.

## 9. Out of scope

- A public read/query API on the `IAuditLogger` capability — the committed contract is write-only;
  adding `query()` is a `common` change (PUBLIC_API delta) deferred to a follow-up.
- An automatic audit middleware recording every request and security error — ROADMAP M26 lists no
  middleware; ARCHITECTURE §13's "errors are audited" is aspirational cross-cutting owned by a future
  middleware/interceptor milestone.
- Consuming the `database` capability token at runtime — ARCHITECTURE scopes audit to
  `common`/`kernel`/`logger`; the DB backend takes an injected client, never the `database` token.
- Tamper-evident chaining (hash chaining / WORM storage) and audit retention/rotation — durability
  hardening for a later milestone; this milestone delivers pluggable, immutable-at-rest records.
