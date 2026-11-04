import { CAPABILITIES } from '@setu-ts/common';
import type { ICommandBus, IQueryBus, IServiceRegistry } from '@setu-ts/common';
import { ADD_NOTE_COMMAND } from '../../cqrs/add-note.command-handler.ts';
import type { AddNoteCommand } from '../../cqrs/add-note.command-handler.ts';
import { READ_NOTES_QUERY } from '../../cqrs/read-notes.query-handler.ts';
import type { ReadNotesQuery } from '../../cqrs/read-notes.query-handler.ts';

/** Sends an add-note command through the command bus. */
export async function addNote(services: IServiceRegistry, text: string): Promise<void> {
  const command: AddNoteCommand = { type: ADD_NOTE_COMMAND, data: { text } };
  await services.get<ICommandBus>(CAPABILITIES.COMMAND_BUS).execute<void>(command);
}

/** Reads the catalogue through the independent query bus. */
export async function readNotes(services: IServiceRegistry): Promise<readonly string[]> {
  const query: ReadNotesQuery = { type: READ_NOTES_QUERY, data: {} };
  return await services.get<IQueryBus>(CAPABILITIES.QUERY_BUS).execute<readonly string[]>(query);
}
