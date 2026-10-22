/* eslint-disable no-console -- an executable reports startup and shutdown failures on stderr. */
/**
 * The entry `build-sea.ts` bundles as CommonJS for Node's single executable.
 *
 * `main.ts` cannot be bundled directly: CommonJS has no top-level `await`.
 */
import { createRuntimeServices } from '@setu-ts/runtime';
import { createApp } from './setu.config.ts';

async function main(): Promise<void> {
  const runtime = createRuntimeServices();
  const app = createApp();
  await app.start({ port: Number(process.argv[2] ?? 3000) });

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
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
