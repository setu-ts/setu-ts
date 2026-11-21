/**
 * Child server for the Bun and Deno proofs of M143i: the runtime from source,
 * the kernel from its build, a logger writing JSON lines to stdout. Prints
 * `{"ready":true}` once listening on the port given as the first argument.
 *
 * @module
 */
import process from 'node:process';

import { CAPABILITIES } from '@setu-ts/common';
import type { ILogger, IPlugin, LogMetadata } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';

import { RuntimePlugin } from '../../src/index.ts';

const port = Number(process.argv[2]);
const encoder = new TextEncoder();

/** One JSON line on stdout. */
function emit(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

const line =
  (level: string) =>
  (msg: string, metadata?: LogMetadata): void =>
    emit({ level, msg, ...metadata });
const logger: ILogger = {
  level: 'info',
  fatal: line('fatal'),
  error: line('error'),
  warn: line('warn'),
  info: line('info'),
  debug: () => {},
  trace: () => {},
  child: () => logger,
};
const loggerPlugin: IPlugin = {
  name: 'json-logger',
  version: '1.0.0',
  provides: [CAPABILITIES.LOGGER],
  register(ctx) {
    ctx.services.register(CAPABILITIES.LOGGER, logger);
  },
};

const app = createApplication({ plugins: [RuntimePlugin(), loggerPlugin] });
app.router.get('/doc', (ctx) => {
  return ctx.response.json({ hello: 'world' });
});
app.router.get('/broken', (ctx) => {
  let sent = false;
  return ctx.response.stream(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(encoder.encode('first'));
          return;
        }
        controller.error(new Error('source failed'));
      },
    }),
  );
});
app.router.get('/quiet', (ctx) => {
  let step = 0;
  return ctx.response.stream(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        step++;
        if (step === 1) {
          controller.enqueue(encoder.encode('open\n'));
          return;
        }
        // Silent past Bun's 10 s default idle timeout.
        await new Promise((resolve) => setTimeout(resolve, 12_000));
        controller.enqueue(encoder.encode('still here\n'));
        controller.close();
      },
    }),
  );
});
app.router.get('/full', (ctx) => {
  ctx.defer?.(() => emit({ marker: 'cleanup' }));
  let n = 0;
  return ctx.response.stream(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        n++;
        emit({ marker: `chunk ${n}` });
        controller.enqueue(encoder.encode(`chunk ${n}\n`));
        if (n === 3) controller.close();
      },
    }),
  );
});
await app.start({ port, hostname: '127.0.0.1' });
emit({ ready: true });
