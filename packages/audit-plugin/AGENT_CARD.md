# @setu-ts/audit-plugin — record immutable audit events

**Add it:** `setu add audit` adds and registers `AuditPlugin()` in `setu.config.ts` with in-memory
storage. It provides `CAPABILITIES.AUDIT` (`IAuditLogger`).

## Record a completed operation

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IAuditLogger } from '@setu-ts/common';

const audit = ctx.services.get<IAuditLogger>(CAPABILITIES.AUDIT);
await audit.log({
  action: 'account.disable',
  resource: 'account',
  resourceId: ctx.params.id,
  result: 'success',
  before: { active: true },
  after: { active: false },
});
```

## Keep events in a file

Replace the registration in `setu.config.ts`:

```ts
import { AuditPlugin } from '@setu-ts/audit-plugin';

export const audit = AuditPlugin({
  storage: 'file',
  options: { path: './var/log/audit.log' },
});
```

## Behaviour the types do not show

- Memory storage is the default and is lost on restart.
- Each record gets an id and timestamp from the runtime and is deep-frozen before storage.
- `log` propagates storage failures; it does not silently discard failed writes.
- Configured `redaction` filters `before`, `after` and `metadata` before freezing the record.
- File storage requires writable `runtime.fs`; registration fails when it is absent. File writes are
  serialized read-modify-write operations.
- Database storage requires an injected `options.client`; no driver is loaded automatically.

## Other options

- `storage: 'log'` uses `options.logger` or the logger capability; `options.level` defaults to info.
- `storage: 'database'` takes an `IAuditDbClient`; `options.table` defaults to `audit_logs`.
- `AuditQuery` and `StoredAuditEntry` describe queries on the exported storage classes.
