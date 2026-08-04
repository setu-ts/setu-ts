# Multi-tenant example

The `MultiTenancyPlugin` resolves a tenant from `x-tenant-id`; its memory store partitions each
tenant's notes.

```bash
cd apps/multi-tenant
deno task start
deno task smoke
```

The smoke check proves that tenant B cannot read tenant A's write.
