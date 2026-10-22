import { CAPABILITIES } from '@setu-ts/common';
import type { ICommandBus, IQueryBus, IServiceRegistry } from '@setu-ts/common';
import type { CqrsPluginOptions } from '@setu-ts/cqrs-plugin';
import { ADD_NOTE, addNoteHandler } from './notes.commands.ts';
import type { AddNote } from './notes.commands.ts';
import { READ_NOTES, readNotesHandler } from './notes.queries.ts';
import type { ReadNotes } from './notes.queries.ts';
import { createNoteStore } from './notes.store.ts';

/** The handlers the notes feature contributes to `CqrsPlugin`. */
export function notesHandlers(): Required<
  Pick<CqrsPluginOptions, 'commandHandlers' | 'queryHandlers'>
> {
  const store = createNoteStore();
  return { commandHandlers: [addNoteHandler(store)], queryHandlers: [readNotesHandler(store)] };
}

/** Sends an `add-note` command through the command bus. */
export async function addNote(services: IServiceRegistry, text: string): Promise<void> {
  const command: AddNote = { type: ADD_NOTE, data: { text } };
  await services.get<ICommandBus>(CAPABILITIES.COMMAND_BUS).execute<void>(command);
}

/** Asks the query bus, which is independent of the command bus, for every note. */
export async function readNotes(services: IServiceRegistry): Promise<readonly string[]> {
  const query: ReadNotes = { type: READ_NOTES, data: {} };
  return await services.get<IQueryBus>(CAPABILITIES.QUERY_BUS).execute<readonly string[]>(query);
}
