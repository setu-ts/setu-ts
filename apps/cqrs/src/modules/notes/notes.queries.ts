import type { CqrsQuery } from '@setu-ts/common';
import type { QueryHandlerRegistration } from '@setu-ts/cqrs-plugin';
import type { NoteStore } from './notes.store.ts';

export const READ_NOTES = 'read-notes';

/** Reads every recorded note. */
export interface ReadNotes extends CqrsQuery<Record<string, never>> {
  readonly type: typeof READ_NOTES;
}

/** Registers the `read-notes` handler as a plain instance, which needs no capability. */
export function readNotesHandler(store: NoteStore): QueryHandlerRegistration {
  return { type: READ_NOTES, handler: { handle: (): readonly string[] => store.all() } };
}
