import { serviceToken } from '@setu-ts/common';

/** The notes the command side writes and the query side reads. */
export interface NoteStore {
  add(note: string): void;
  all(): readonly string[];
}

/** Creates an in-memory note store owned by one application. */
export function createNoteStore(): NoteStore {
  const notes: string[] = [];
  return {
    add: (note) => {
      notes.push(note);
    },
    all: () => [...notes],
  };
}

/** The application-owned store shared by command and query handlers. */
export const NOTE_STORE = serviceToken<NoteStore>('example.note-store');
