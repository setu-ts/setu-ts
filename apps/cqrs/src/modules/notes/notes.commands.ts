import { CAPABILITIES } from '@setu-ts/common';
import type { CqrsCommand, ICommandHandler, IRuntimeServices } from '@setu-ts/common';
import type { CommandHandlerRegistration } from '@setu-ts/cqrs-plugin';
import type { NoteStore } from './notes.store.ts';

export const ADD_NOTE = 'add-note';

/** Records a note, stamped with the time it was added. */
export interface AddNote extends CqrsCommand<{ readonly text: string }> {
  readonly type: typeof ADD_NOTE;
}

/**
 * Registers the `add-note` handler as a factory.
 *
 * A factory runs once every plugin has registered, so it can resolve a
 * capability — here the runtime clock — that the command itself cannot carry.
 */
export function addNoteHandler(store: NoteStore): CommandHandlerRegistration {
  return {
    type: ADD_NOTE,
    handler: (services): ICommandHandler<AddNote, void> => {
      const runtime = services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
      return {
        handle: (command) => store.add(`${command.data.text} @ ${runtime.now()}`),
      };
    },
  };
}
