import { CAPABILITIES } from '@setu-ts/common';
import type {
  CqrsCommand,
  CqrsQuery,
  ICommandBus,
  ICommandHandler,
  IQueryBus,
  IRuntimeServices,
  IServiceRegistry,
} from '@setu-ts/common';
import { CqrsPlugin } from '@setu-ts/cqrs-plugin';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

export interface AddNote extends CqrsCommand {
  readonly data: { readonly text: string };
}

export interface ReadNotes extends CqrsQuery {
  readonly data: { readonly marker: 'notes' };
}

/**
 * Builds the CQRS composition.
 *
 * The command handler is a FACTORY that resolves `CAPABILITIES.RUNTIME` and
 * stamps its clock into the note — the post-start imperative `wire()` shim is
 * gone. The query handler is a plain instance, so the app exercises both arms
 * of the widened registration: a factory (resolved at `onInit`) and an instance
 * (registered at `register()`).
 */
export function createCqrsApp(): IKernelApplication {
  const notes: string[] = [];
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      CqrsPlugin({
        commandHandlers: [
          {
            type: 'add-note',
            handler: (services: IServiceRegistry): ICommandHandler<AddNote, void> => {
              // The factory runs at the `onInit` phase, after every plugin has
              // registered, so the runtime capability is present. This is the
              // dependency the old `wire()` could not reach declaratively.
              const runtime = services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
              return {
                handle: (command: AddNote): void => {
                  notes.push(`${command.data.text} @ ${runtime.now()}`);
                },
              };
            },
          },
        ],
        queryHandlers: [
          {
            type: 'read-notes',
            handler: { handle: (): readonly string[] => [...notes] },
          },
        ],
      }),
    ],
  });
  app.router.get('/notes', (ctx) => ctx.response.json({ ready: true }));
  return app;
}

/** Executes the command then asks the independent query bus for the state. */
export async function addAndRead(
  app: IKernelApplication,
  text: string,
): Promise<readonly string[]> {
  const commands = app.services.get<ICommandBus>(CAPABILITIES.COMMAND_BUS);
  const queries = app.services.get<IQueryBus>(CAPABILITIES.QUERY_BUS);
  const command: AddNote = { type: 'add-note', data: { text } };
  const query: ReadNotes = { type: 'read-notes', data: { marker: 'notes' } };
  await commands.execute<void>(command);
  return await queries.execute<readonly string[]>(query);
}
