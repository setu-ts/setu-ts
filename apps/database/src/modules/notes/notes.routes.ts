import type { IRouterApi } from '@setu-ts/common';
import { notFound } from '@setu-ts/exceptions';
import { validateBody } from '@setu-ts/validation-plugin';
import { CreateNoteBody, UpdateNoteBody } from './notes.schemas.ts';
import { notesRepository } from './notes.service.ts';

const createBody = validateBody(CreateNoteBody);
const updateBody = validateBody(UpdateNoteBody);

/** Registers the notes routes over the database repository. */
export function registerNotesRoutes(router: IRouterApi): void {
  router.group('/notes', (routes) => {
    routes.post('/', {
      middleware: [createBody],
      handler: async (ctx) => {
        const note = await notesRepository(ctx.services).create(createBody.value(ctx));
        return ctx.response.status(201).json(note);
      },
    });

    routes.get('/:id', async (ctx) => {
      const note = await notesRepository(ctx.services).findById(ctx.params.id);
      if (note === null) throw notFound(`Note ${ctx.params.id} was not found.`);
      return ctx.response.json(note);
    });

    routes.patch('/:id', {
      middleware: [updateBody],
      handler: async (ctx) => {
        const notes = notesRepository(ctx.services);
        if ((await notes.findById(ctx.params.id)) === null) {
          throw notFound(`Note ${ctx.params.id} was not found.`);
        }
        return ctx.response.json(await notes.update(ctx.params.id, updateBody.value(ctx)));
      },
    });
  });
}
