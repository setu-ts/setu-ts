# Multi-tenant example

The `MultiTenancyPlugin` resolves a tenant from `x-tenant-id` and checks it against the `tenants`
list (`acme`, `globex`); its memory store partitions each tenant's notes. A request naming any other
tenant answers `404 Unknown Tenant` before a handler runs.

```bash
pnpm --dir apps/multi-tenant run start
pnpm --dir apps/multi-tenant run smoke
```

The smoke check proves that `globex` cannot read `acme`'s write, and that `initech` — not in the
list — is refused and creates nothing.

A queue job or message handler that reads a tenant id from its payload checks it the same way with
`lookupTenant` before touching the trusted `getRepositoryFor`:

```typescript
const tenancy = services.get<IMultiTenancyService>(CAPABILITIES.MULTI_TENANCY);
const tenant = await tenancy.lookupTenant(job.tenantId);
if (!tenant.present) return; // unknown tenant: drop the job
await tenancy.getRepositoryFor<Note>(tenant.value.id, 'Note').create({ text: job.text });
```

Read the [example deep dive](../../docs/examples.md#multi-tenant) for the concept and source
walkthrough.
