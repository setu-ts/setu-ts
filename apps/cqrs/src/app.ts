import { CAPABILITIES } from '@setu-ts/common';
import type { CqrsCommand, CqrsQuery, ICommandBus, IQueryBus } from '@setu-ts/common';
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

/** Builds a CQRS composition with separate command and query handlers. */
export function createCqrsApp(): IKernelApplication {
  const notes: string[] = [];
  const app = createApplication({ plugins: [RuntimePlugin(), CqrsPlugin()] });
  let wired = false;
  const wire = (): void => {
    if (wired) {
      return;
    }
    wired = true;
    const commands = app.services.get<ICommandBus>(CAPABILITIES.COMMAND_BUS);
    const queries = app.services.get<IQueryBus>(CAPABILITIES.QUERY_BUS);
    commands.register<AddNote, void>('add-note', {
      handle: (command) => void notes.push(command.data.text),
    });
    queries.register<ReadNotes, readonly string[]>('read-notes', { handle: () => [...notes] });
  };
  app.router.get('/notes', (ctx) => ctx.response.json({ ready: true }));
  return Object.assign(app, { wire });
}

/** Executes the command then asks the independent query bus for the state. */
export async function addAndRead(
  app: IKernelApplication,
  text: string,
): Promise<readonly string[]> {
  const extended = app as IKernelApplication & { wire?: () => void };
  extended.wire?.();
  const commands = app.services.get<ICommandBus>(CAPABILITIES.COMMAND_BUS);
  const queries = app.services.get<IQueryBus>(CAPABILITIES.QUERY_BUS);
  await commands.execute<void>({ type: 'add-note', data: { text } });
  return await queries.execute<readonly string[]>({
    type: 'read-notes',
    data: { marker: 'notes' },
  });
}
