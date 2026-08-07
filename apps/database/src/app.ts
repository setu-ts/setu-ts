import { CAPABILITIES } from '@setu-ts/common';
import { DatabasePlugin } from '@setu-ts/database-plugin';
import type { IDatabaseService, IRepository } from '@setu-ts/database-plugin';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

export interface Note {
  readonly id: string;
  readonly text: string;
}

const NOTES = 'notes';

/** Builds a zero-dependency memory-database application with repository routes. */
export function createDatabaseApp(): IKernelApplication {
  const app = createApplication({ plugins: [RuntimePlugin(), DatabasePlugin({ type: 'memory' })] });
  app.router.post('/notes', async (ctx) => {
    const note = await ctx.request.json<Note>();
    const repository = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE)
      .getRepository<Note>(NOTES);
    return ctx.response.status(201).json(await repository.create(note));
  });
  app.router.get('/notes/:id', async (ctx) => {
    const repository = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE)
      .getRepository<Note>(NOTES);
    const note = await repository.findById(ctx.params.id);
    return note === null
      ? ctx.response.status(404).json({ error: 'Note not found.' })
      : ctx.response.json(note);
  });
  app.router.patch('/notes/:id', async (ctx) => {
    const update = await ctx.request.json<Partial<Note>>();
    const repository = ctx.services.get<IDatabaseService>(CAPABILITIES.DATABASE)
      .getRepository<Note>(NOTES);
    return ctx.response.json(await repository.update(ctx.params.id, update));
  });
  return app;
}

/** Runs a transaction that creates a row then throws, returning the unchanged count. */
export async function rollbackCount(app: IKernelApplication): Promise<number> {
  const database = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
  const repository: IRepository<Note> = database.getRepository<Note>(NOTES);
  const countBefore = await repository.count();
  try {
    await database.transaction(async (uow) => {
      await uow.getRepository<Note>(NOTES).create({ id: 'rolled-back', text: 'not persisted' });
      throw new Error('Roll back this demonstration transaction.');
    });
  } catch (error) {
    if (
      !(error instanceof Error) || error.message !== 'Roll back this demonstration transaction.'
    ) {
      throw error;
    }
  }
  const countAfter = await repository.count();
  if (countAfter !== countBefore) throw new Error('The transaction did not roll back its write.');
  return countAfter;
}
