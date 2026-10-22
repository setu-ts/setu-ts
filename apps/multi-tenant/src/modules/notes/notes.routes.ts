import type { IRouterApi } from '@setu-ts/common';
import { tenantNotes } from './notes.service.ts';

/** Registers the notes routes; each request reads and writes its own tenant's notes. */
export function registerNotesRoutes(router: IRouterApi): void {
  router.group('/notes', (routes) => {
    routes.post('/', async (ctx) => {
      const { text } = await ctx.request.json<{ text: string }>();
      return ctx.response.status(201).json(await tenantNotes(ctx).create({ text }));
    });

    routes.get('/', async (ctx) => ctx.response.json(await tenantNotes(ctx).findAll()));
  });
}
