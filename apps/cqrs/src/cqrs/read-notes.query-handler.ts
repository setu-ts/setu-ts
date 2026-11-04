import type { CqrsQuery, IQueryHandler, IServiceRegistry } from '@setu-ts/common';
import { NOTE_STORE } from '../modules/notes/notes.service.ts';
import type { NoteStore } from '../modules/notes/notes.service.ts';

/** Type name the query bus routes on. */
export const READ_NOTES_QUERY = 'read-notes';

/** Reads every recorded note. */
export interface ReadNotesQuery extends CqrsQuery<Record<string, never>> {
  readonly type: typeof READ_NOTES_QUERY;
}

/** The read side; querying never mutates the feature store. */
export class ReadNotesQueryHandler implements IQueryHandler<ReadNotesQuery, readonly string[]> {
  constructor(private readonly store: NoteStore) {}

  handle(query: ReadNotesQuery): Promise<readonly string[]> {
    void query;
    return Promise.resolve(this.store.all());
  }
}

/** Shares the application-owned store with the command handler. */
export function createReadNotesQueryHandler(services: IServiceRegistry): ReadNotesQueryHandler {
  return new ReadNotesQueryHandler(services.get<NoteStore>(NOTE_STORE));
}
