# @setu-ts/logger-plugin — structured and request logging

**Add it:** `setu add logger` adds the dependency; register `LoggerPlugin()` in `setu.config.ts`
(the REST scaffold already does). It provides `CAPABILITIES.LOGGER` (`ILogger`) and requires
runtime.

## Log a request with structured fields

```ts
import { CAPABILITIES } from "@setu-ts/common";
import type { ILogger, IRouterApi } from "@setu-ts/common";

export function registerGreetingRoutes(router: IRouterApi): void {
  router.get("/hello", {
    handler: (ctx) => {
      const logger = ctx.services.get<ILogger>(CAPABILITIES.LOGGER);
      logger.child({ requestId: ctx.id }).info("Greeting requested", { path: ctx.request.path });
      return ctx.response.json({ greeting: "Hello" });
    },
  });
}
```

## Enable automatic request logs

Configure the existing registration in `setu.config.ts`:

```ts
import { LoggerPlugin } from "@setu-ts/logger-plugin";

app.register(LoggerPlugin({
  level: "info",
  requestLogging: true,
  slowRequestThreshold: 1000,
  excludePaths: ["/live", "/ready", "/health", "/metrics"],
}));
```

## Behaviour the types do not show

- `level` defaults to `"info"` and `transport` to `"console"`; console output is JSON lines unless
  `pretty` is enabled.
- `requestLogging` defaults to `false`. When enabled, it logs incoming method/path and outgoing
  status/duration with a request ID; it does not log the thrown error itself.
- `slowRequestThreshold` is milliseconds and defaults to `5000`; longer requests emit a warning.
- `excludePaths` defaults to an empty list; strings match exactly and regular expressions test the
  path.
- Known secret fields are redacted by default. `redact` supplies a replacement dot-path list;
  `redaction` can apply an additional policy or service to structured records.
- The logger registers at high priority so later plugins can log during registration.

## Other options

- `transport: "pino"` loads `pino`; `pinoFactory` injects a preloaded factory. `"noop"` discards
  logs.
- `ILogger` also has `fatal`, `error`, `warn`, `debug`, `trace` and `child` for shared bindings.
- `createRequestLoggerMiddleware` attaches request logging explicitly when you need pipeline
  control.
