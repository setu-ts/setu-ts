# @setu-ts/audit-plugin

Immutable audit-trail logging for Setu-TS. Registers an `IAuditLogger` under `CAPABILITIES.AUDIT`,
backed by a pluggable storage backend. Each entry is stamped with an internally assigned `id`
(`runtime.uuid()`) and wall-clock `timestamp` (`runtime.now()`), deep-frozen for immutability, then
appended to the selected storage.

Storage backends:

| Backend                | `storage` id | Persistence                                | Dependency                                         |
| ---------------------- | ------------ | ------------------------------------------ | -------------------------------------------------- |
| `MemoryAuditStorage`   | `memory`     | in-process array (**non-durable**)         | none (every runtime, incl. Cloudflare Workers)     |
| `LogAuditStorage`      | `log`        | routed to the resolved `ILogger`           | the `logger` capability (LoggerPlugin)             |
| `DatabaseAuditStorage` | `database`   | rows via an injected `IAuditDbClient`      | an injected client facade (inject-only, no driver) |
| `FileAuditStorage`     | `file`       | JSONL via `runtime.fs` (read-modify-write) | writable `runtime.fs` (Node/Deno/Bun only)         |

The default backend is `memory` — zero-dependency and portable, but **non-durable**: it is lost on
restart. Select `log`, `database`, or `file` for production. No database driver is ever a hard
dependency; the `database` backend takes an injected client facade and never touches the `database`
capability token.

## Installation

```typescript
import { AuditPlugin } from '@setu-ts/audit-plugin';
```

The `memory`, `log`, and `file` backends need nothing beyond the framework. The `database` backend
needs an injected client that adapts your driver to the `IAuditDbClient` shape (`insert(table, row)`
/ `select(table, criteria?)`).

## Usage

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { AuditPlugin } from '@setu-ts/audit-plugin';
import { CAPABILITIES } from '@setu-ts/common';
import type { IAuditLogger } from '@setu-ts/common';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    // In-memory (default — non-durable)
    AuditPlugin(),
  ],
});
await app.start();

const audit = app.services.get<IAuditLogger>(CAPABILITIES.AUDIT);
await audit.log({
  action: 'user.delete',
  resource: 'user',
  resourceId: '123',
  userId: currentUser.id,
  result: 'success',
  before: { active: true },
  after: { active: false },
});
```

`IAuditLogger` is write-only (like `ILogger`). `AuditEntry` is the write shape and carries no
`id`/`timestamp`; those are assigned internally on the stored record, which is immutable once
written.

## Backend configuration

```typescript
// Route audit records through the resolved logger.
AuditPlugin({ storage: 'log', options: { level: 'info' } });

// Persist to a database via an injected client (inject-only).
AuditPlugin({ storage: 'database', options: { client: myDbClient, table: 'audit_logs' } });

// Append JSONL to a file (Node/Deno/Bun only — requires runtime.fs).
AuditPlugin({ storage: 'file', options: { path: './audit.log' } });
```

| Option           | Backend    | Default         | Notes                                                                 |
| ---------------- | ---------- | --------------- | --------------------------------------------------------------------- |
| `storage`        | —          | `'memory'`      | `'memory'` \| `'log'` \| `'database'` \| `'file'`. Unknown ids throw. |
| `options.level`  | `log`      | `'info'`        | `'info'` \| `'warn'` \| `'error'`.                                    |
| `options.logger` | `log`      | `ctx.logger`    | Injected `ILogger`; throws at registration when neither is present.   |
| `options.client` | `database` | —               | Injected `IAuditDbClient`; required (throws when absent).             |
| `options.table`  | `database` | `'audit_logs'`  | Table for `insert`/`select`.                                          |
| `options.path`   | `file`     | `'./audit.log'` | Throws at registration when `runtime.fs` is absent (Workers/edge).    |

## Health

Registers an `audit` health indicator reporting `{ storage, reachable }`. It carries BOTH signals:
`isReady()` is lifecycle (constructed and accepting writes), and a cached, bounded probe is
reachability (the sink answers right now).

| Backend    | Probe                                                              | Reports           |
| ---------- | ------------------------------------------------------------------ | ----------------- |
| `memory`   | none needed — an in-process array                                  | `reachable: true` |
| `log`      | none needed — the sink is the resolved in-process `ILogger`        | `reachable: true` |
| `database` | `select` on the primary key against a sentinel that matches no row | `true` / `false`  |
| `file`     | the last append's outcome, then `stat` of the target directory     | `true` / `false`  |

A ready backend whose sink does not answer is `down`. A backend that cannot probe reports
`reachable: 'unknown'` — never a falsely affirmative `true`. Outcomes are cached for 5 s and each
probe is bounded at 2 s on the runtime's own clock and timers, so scraping `/health` never turns
into sink load.

The database probe READS and never writes: an `insert` would put a fabricated record into the trail
this plugin exists to keep trustworthy. The file probe does not write either, for the same reason —
which leaves one gap it is honest about: a directory that is readable but not writable reports
`true` until the first append proves otherwise, and that is why the append outcome is tracked.

## Runtime portability

- `memory` and `log` run on every target, including Cloudflare Workers.
- `file` requires a writable `runtime.fs`; it throws at registration on runtimes without one
  (Workers/edge). The committed `IFileSystem` has no native append, so writes are read-modify-write
  and concurrent appends are serialized; on shutdown the plugin's `onClose` drains any in-flight
  write. The target file's parent directory is created recursively on first write, so a configured
  `path` in a not-yet-existing directory (e.g. `./var/log/audit.log`) does not fail with `ENOENT`.
- `database` is inject-only — there is no canonical SQL driver to lazy-load. Equality filters
  (`action`/`resource`/`result`/`userId`/`resourceId`) are delegated to the client's `select` WHERE;
  time-range (`from`/`to`), ordering, and `limit` are applied in-process.

## Immutability

Every stored record is deep-frozen — including nested `before`/`after`/`metadata` — so it cannot be
mutated after it is written, and records reconstructed on read (database/file) are frozen too.

## License

MIT

## Exports

| Export                 | Kind      |
| ---------------------- | --------- |
| `AuditPlugin`          | function  |
| `AuditService`         | class     |
| `DatabaseAuditStorage` | class     |
| `FileAuditStorage`     | class     |
| `LogAuditStorage`      | class     |
| `MemoryAuditStorage`   | class     |
| `AuditEntry`           | interface |
| `AuditPluginOptions`   | interface |
| `AuditQuery`           | interface |
| `AuditStorageOptions`  | interface |
| `IAuditDbClient`       | interface |
| `IAuditLogger`         | interface |
| `StoredAuditEntry`     | interface |
| `AuditStorageType`     | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#auditplugin-setu-tsaudit-plugin).
