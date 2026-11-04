import { CqrsPlugin } from '@setu-ts/cqrs-plugin';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { COMMAND_HANDLERS, QUERY_HANDLERS } from './src/cqrs/index.ts';
import { registerModules } from './src/modules/index.ts';
import { createNoteStore, NOTE_STORE } from './src/modules/notes/notes.service.ts';

/** Builds the CQRS composition, without starting it. */
export function createApp(): IKernelApplication {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      CqrsPlugin({ commandHandlers: COMMAND_HANDLERS, queryHandlers: QUERY_HANDLERS }),
    ],
  });
  app.services.register(NOTE_STORE, createNoteStore());
  registerModules(app.router, app.services);
  return app;
}
