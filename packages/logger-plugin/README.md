# @setu-ts/logger-plugin

Structured logging. Registers an `ILogger` under `CAPABILITIES.LOGGER` (`'logger'`) and, optionally,
request/response logging middleware.

Three implementations ship: `ConsoleLogger` (zero-dependency default), `PinoLogger` (over
`npm:pino`, lazily imported or injected), and `NoopLogger`.

## Installation

```typescript
import { LoggerPlugin } from '@setu-ts/logger-plugin';
```

## Usage

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { LoggerPlugin } from '@setu-ts/logger-plugin';
import { CAPABILITIES, type ILogger } from '@setu-ts/common';

const app = createApplication({
  plugins: [RuntimePlugin(), LoggerPlugin({ transport: 'console', level: 'info' })],
});
await app.start({ port: 3000 });

const logger = app.services.get<ILogger>(CAPABILITIES.LOGGER);
logger.info('server ready', { port: 3000 });
```

## Options

| Option                 | Type                | Default     | Description                                            |
| ---------------------- | ------------------- | ----------- | ------------------------------------------------------ |
| `level`                | `LogLevel`          | `'info'`    | Minimum level to emit.                                 |
| `transport`            | `LoggerTransport`   | `'console'` | Implementation: `'console'`, `'pino'`, or `'noop'`.    |
| `pretty`               | `boolean`           | `false`     | Pretty-print entries (console transport only).         |
| `redact`               | `readonly string[]` | `[]`        | Dot-paths to strip from metadata.                      |
| `requestLogging`       | `boolean`           | `false`     | Register request/response logging middleware.          |
| `slowRequestThreshold` | `number`            | `5000`      | Requests slower than this (ms) log at `warn`.          |
| `excludePaths`         | `readonly string[]` | `[]`        | Exact paths excluded from request logging.             |
| `pinoFactory`          | `PinoFactory`       | —           | Inject a pre-loaded Pino factory, skipping the import. |

## Pino

`pino` is an **optional** dependency, lazily imported only when `transport: 'pino'` is configured —
a console-logging application never pulls it in. You may also inject a pre-built factory via
`PinoLoggerOptions` to skip the import entirely.

## Request logging

`createRequestLoggerMiddleware(options)` logs each request and its outcome. Durations are computed
from the monotonic clock (`runtime.hrtime()`), never from a wall-clock epoch.

## Exports

| Export | Kind |
| --- | --- |
| `createRequestLoggerMiddleware` | function |
| `LoggerPlugin` | function |
| `ConsoleLogger` | class |
| `NoopLogger` | class |
| `PinoLogger` | class |
| `ConsoleLoggerOptions` | interface |
| `LoggerPluginOptions` | interface |
| `NoopLoggerOptions` | interface |
| `PinoLoggerOptions` | interface |
| `RequestLoggerOptions` | interface |
| `LoggerTransport` | type |
| `PinoFactory` | type |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#loggerplugin-setu-tslogger-plugin).
