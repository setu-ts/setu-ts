import { CAPABILITIES } from '@setu-ts/common';
import type { IServiceRegistry } from '@setu-ts/common';
import type { IDatabaseService, IRepository } from '@setu-ts/database-plugin';
import type { Note } from './notes.schemas.ts';

/** The entity name every notes repository is addressed by. */
export const NOTES_ENTITY = 'notes';

/** Resolves the notes repository from the application's database capability. */
export function notesRepository(services: IServiceRegistry): IRepository<Note> {
  return services.get<IDatabaseService>(CAPABILITIES.DATABASE).getRepository<Note>(NOTES_ENTITY);
}
