import { CAPABILITIES } from '@setu-ts/common';
import type {
  CqrsCommand,
  ICommandHandler,
  IRuntimeServices,
  IServiceRegistry,
} from '@setu-ts/common';
import { NOTE_STORE } from '../modules/notes/notes.service.ts';
import type { NoteStore } from '../modules/notes/notes.service.ts';

/** Type name the command bus routes on. */
export const ADD_NOTE_COMMAND = 'add-note';

/** The text to record. */
export interface AddNotePayload {
  readonly text: string;
}

/** Records a note, stamped with the time it was added. */
export interface AddNoteCommand extends CqrsCommand<AddNotePayload> {
  readonly type: typeof ADD_NOTE_COMMAND;
}

/** The mutation side, built once per application by its registered factory. */
export class AddNoteCommandHandler implements ICommandHandler<AddNoteCommand, void> {
  constructor(
    private readonly store: NoteStore,
    private readonly runtime: IRuntimeServices,
  ) {}

  handle(command: AddNoteCommand): Promise<void> {
    this.store.add(`${command.data.text} @ ${this.runtime.now()}`);
    return Promise.resolve();
  }
}

/** Resolves dependencies at onInit, after every plugin has registered. */
export function createAddNoteCommandHandler(services: IServiceRegistry): AddNoteCommandHandler {
  return new AddNoteCommandHandler(
    services.get<NoteStore>(NOTE_STORE),
    services.get<IRuntimeServices>(CAPABILITIES.RUNTIME),
  );
}
