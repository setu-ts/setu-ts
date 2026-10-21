# @setu-ts/audit-plugin — immutable audit trail

`setu add audit` adds the dependency and inserts `AuditPlugin()` — the in-memory backend, which is
lost on restart. It registers `CAPABILITIES.AUDIT`; each stored entry is stamped with an id and a
timestamp, then deep-frozen.

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IAuditLogger, IRequestContext } from '@setu-ts/common';

export async function recordDeletion(context: IRequestContext): Promise<void> {
  const audit = context.services.get<IAuditLogger>(CAPABILITIES.AUDIT);
  await audit.log({
    action: 'user.delete',
    resource: 'user',
    resourceId: context.params.id,
    result: 'success',
    before: { active: true },
    after: { active: false },
  });
}
```

```ts
import { AuditPlugin } from '@setu-ts/audit-plugin';

export const audit = AuditPlugin({ storage: 'file', options: { path: './var/log/audit.log' } });
```

- `storage` is `'memory'` (default), `'log'`, `'database'` or `'file'`; an unknown id throws at
  registration.
- `AuditEntry` is `action`, `resource`, optional `resourceId`, `userId`, `before`, `after`,
  `metadata`, plus `result`: `'success'` or `'failure'`. `IAuditLogger` has one method, `log`.
- `'log'` takes `options.level` (`'info'` default, or `'warn'`, `'error'`) and `options.logger`;
  with neither an injected logger nor a registered logger capability, registration throws.
- `'database'` is inject-only: `options.client` is required (an `IAuditDbClient` with `insert` and
  `select`); `options.table` defaults to `audit_logs`. No driver is ever loaded.
- `'file'` defaults `options.path` to `./audit.log` and throws at registration on runtimes without a
  writable `runtime.fs` (Workers/edge). Writes are read-modify-write and serialized.
- `redaction` filters `before`, `after` and `metadata` before the entry is frozen. An `audit` health
  indicator reports `{ storage, reachable }`.
