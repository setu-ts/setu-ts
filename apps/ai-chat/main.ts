/* eslint-disable no-console -- an example entry reports its address and shutdown failures. */
import { createRuntimeServices } from '@setu-ts/runtime';
import { createApp } from './setu.config.ts';
import { createChatModels } from './src/modules/chat/chat.models.ts';

const runtime = createRuntimeServices();
const port = Number(process.argv[2] ?? 3000);
const { models, telemetry } = createChatModels(runtime.env);
const app = createApp(models, telemetry);

await app.start({ port });
console.log(`AI chat listening on http://localhost:${port}`);

// Without a handler, SIGTERM ends the process before `app.stop()` can run its shutdown hooks.
// `onSignal` is absent where no signal can be caught (Windows). See docs/deployment.md.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  runtime.onSignal?.(signal, () => {
    void app
      .stop()
      .then(() => runtime.exit(0))
      .catch((error: unknown) => {
        console.error('Graceful shutdown failed:', error);
        runtime.exit(1);
      });
  });
}
