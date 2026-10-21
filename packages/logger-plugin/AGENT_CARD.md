# @setu-ts/logger-plugin — structured logging and request logs

`setu add logger` adds the dependency; REST scaffolds already register `LoggerPlugin` in
`setu.config.ts`. It depends on the runtime plugin and provides `CAPABILITIES.LOGGER`.

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { ILogger } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { LoggerPlugin } from '@setu-ts/logger-plugin';
import { RuntimePlugin } from '@setu-ts/runtime';

export function createLoggingApp() {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      LoggerPlugin({
        level: 'info',
        transport: 'console',
        redact: ['password', 'token'],
        requestLogging: true,
        slowRequestThreshold: 1000,
        excludePaths: ['/live', '/ready', '/health', '/metrics'],
      }),
    ],
  });
  app.router.get('/hello', (ctx) => {
    const logger = ctx.services.get<ILogger>(CAPABILITIES.LOGGER);
    logger.info('hello', { route: '/hello' });
    return ctx.response.json({ ok: true });
  });
  return app;
}
```

- `LoggerPluginOptions.level` defaults to `'info'`; `transport` defaults to `'console'` and also
  accepts `'pino'` (requires the pino package) or `'noop'` to silence logging.
- `pretty` only affects the console transport. `redact` takes dot-paths; `redaction` accepts a
  `RedactionPolicy` or `IRedactionService` applied to every record. Secret fields are redacted by
  default.
- `requestLogging` defaults to false. When true, `slowRequestThreshold` (default 5000 ms) emits a
  warn entry and `excludePaths` takes exact strings or regular expressions.
- Read the logger from `CAPABILITIES.LOGGER`: `ILogger` has `fatal`, `error`, `warn`, `info`,
  `debug`, `trace` and `logger.child(bindings)`. Metadata is a structured record, and `logger.level`
  reports the active minimum.
- The plugin registers at high priority, so other plugins can log during registration. `pinoFactory`
  injects a pre-loaded Pino factory for tests. `ConsoleLogger`, `NoopLogger` and `PinoLogger` can be
  constructed directly, and `createRequestLoggerMiddleware` exposes the request logger with
  `RequestLoggerOptions`.
