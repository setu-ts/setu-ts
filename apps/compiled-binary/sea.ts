/* eslint-disable no-console -- executable startup failures go to stderr. */
/** Entry bundled as CommonJS for Node's single executable application. */
import { createCompiledApp } from './src/app.ts';

async function main(): Promise<void> {
  const app = createCompiledApp();
  await app.start({ port: Number(process.argv[2] ?? 3000) });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void app.stop().then(
        () => process.exit(0),
        (error: unknown) => {
          console.error(error);
          process.exit(1);
        },
      );
    });
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
