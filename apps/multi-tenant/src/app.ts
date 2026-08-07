import { CAPABILITIES } from '@setu-ts/common';
import type { IMultiTenancyService, ITenantRepository } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';
import { RuntimePlugin } from '@setu-ts/runtime';

interface TenantNote {
  readonly id: string;
  readonly text: string;
}

/** Builds a header-resolved application whose data store is partitioned by tenant. */
export function createMultiTenantApp(): IKernelApplication {
  const app = createApplication({
    plugins: [RuntimePlugin(), MultiTenancyPlugin({ resolver: 'header', required: true })],
  });
  app.router.post('/notes', async (ctx) => {
    const input = await ctx.request.json<{ text: string }>();
    const tenancy = ctx.services.get<IMultiTenancyService>(CAPABILITIES.MULTI_TENANCY);
    const notes = tenancy.getRepository<TenantNote>(ctx, 'notes');
    return ctx.response.status(201).json(await notes.create({ text: input.text }));
  });
  app.router.get('/notes', async (ctx) => {
    const tenancy = ctx.services.get<IMultiTenancyService>(CAPABILITIES.MULTI_TENANCY);
    const notes: ITenantRepository<TenantNote> = tenancy.getRepository(ctx, 'notes');
    return ctx.response.json(await notes.findAll());
  });
  return app;
}
