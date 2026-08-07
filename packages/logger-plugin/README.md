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

## Pino

`pino` is an **optional** dependency, lazily imported only when `transport: 'pino'` is configured —
a console-logging application never pulls it in. You may also inject a pre-built factory via
`PinoLoggerOptions` to skip the import entirely.

## Request logging

`createRequestLoggerMiddleware(options)` logs each request and its outcome. Durations are computed
from the monotonic clock (`runtime.hrtime()`), never from a wall-clock epoch.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md).
