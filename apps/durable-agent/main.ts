/* eslint-disable no-console -- an example entry reports its startup failure. */
import { createApp } from './setu.config.ts';
import { createRuntimeServices } from '@setu-ts/runtime';
import { CAPABILITIES, describeError } from '@setu-ts/common';
import type { ILogger } from '@setu-ts/common';

// Built before the application, because the port is needed at start() and
// plugins do not register until then. Safe to hold alongside the application's
// own instance: runtime services are a stateless facade over platform globals.
const runtime = createRuntimeServices();

// A failed boot prints one line and exits 1. Left to the runtime's default
// printer, the error is dumped with every property it carries, and a malformed
// REDIS_URL's TypeError carries the URL, password included, as `input`.
async function boot() {
  const app = await createApp();
  // Loopback only by default: the example trusts a demonstration identity
  // header, so it must not be reachable from the network unless you say so.
  await app.start({
    port: Number(runtime.env.PORT ?? '3000'),
    hostname: runtime.env.HOST ?? '127.0.0.1',
  });
  return app;
}

const app = await boot().catch((error: unknown) => {
  console.error(`Startup failed: ${describeError(error)}`);
  return runtime.exit(1);
});

// Graceful shutdown. Without this the process dies from the signal itself and
// `app.stop()` never runs, so in-flight requests are cut, the service never
// deregisters from discovery, and no database or broker disconnects.
//
// Portable across every runtime: no `Deno`, no `process`, no OS check. On
// Windows `onSignal` is absent and this registers nothing, which is correct —
// Windows has no SIGTERM to catch.
//
// The logger is resolved only if one is registered: a project scaffolded
// without LoggerPlugin still shuts down cleanly, it just reports nothing.
const logger = app.services.has(CAPABILITIES.LOGGER)
  ? app.services.get<ILogger>(CAPABILITIES.LOGGER)
  : undefined;

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  runtime.onSignal?.(signal, () => {
    // The .catch is not optional: a rejecting onShutdown hook makes stop()
    // reject, and an unhandled rejection replaces the reason with a trace.
    void app
      .stop()
      .then(() => runtime.exit(0))
      .catch((error: unknown) => {
        logger?.error('Graceful shutdown failed', { error });
        runtime.exit(1);
      });
  });
}
