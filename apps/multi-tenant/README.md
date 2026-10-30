# Multi-tenant example

The `MultiTenancyPlugin` resolves a tenant from `x-tenant-id`; its memory store partitions each
tenant's notes.

```bash
pnpm --dir apps/multi-tenant run start
pnpm --dir apps/multi-tenant run smoke
```

The smoke check proves that tenant B cannot read tenant A's write.

Read the [example deep dive](../../docs/examples.md#multi-tenant) for the concept and source
walkthrough.
