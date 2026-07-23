# @hono-enterprise/audit-plugin

Immutable audit-trail logging for Hono Enterprise. Registers an `IAuditLogger` under
`CAPABILITIES.AUDIT`, backed by a pluggable storage backend. Each entry is stamped with an
internally assigned `id` (`runtime.uuid()`) and wall-clock `timestamp` (`runtime.now()`),
deep-frozen for immutability, then appended to the selected storage.

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
import { AuditPlugin } from '@hono-enterprise/audit-plugin';
```

The `memory`, `log`, and `file` backends need nothing beyond the framework. The `database` backend
needs an injected client that adapts your driver to the `IAuditDbClient` shape (`insert(table, row)`
/ `select(table, criteria?)`).

## Usage

```typescript
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { AuditPlugin } from '@hono-enterprise/audit-plugin';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IAuditLogger } from '@hono-enterprise/common';

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
