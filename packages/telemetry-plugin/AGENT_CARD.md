# @setu-ts/telemetry-plugin — trace requests and application work

**Add it:** `setu add telemetry` adds it and prints the registration for `setu.config.ts`.
`TelemetryPlugin` provides `CAPABILITIES.TELEMETRY` (`ITelemetryService`); without an exporter it
registers a no-op service.

## Export sampled request traces

Put this plugin in the config's plugins array:

```ts
import { TelemetryPlugin } from '@setu-ts/telemetry-plugin';

export const telemetry = TelemetryPlugin({
  serviceName: 'orders-api',
  exporter: 'otlp',
  endpoint: 'http://localhost:4318/v1/traces',
  spanProcessor: 'batch',
  sampling: { type: 'traceidratio', ratio: 0.1 },
});
```

## Add a span inside a module route

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IRouterApi, ITelemetryService } from '@setu-ts/common';

export function registerOrderRoutes(router: IRouterApi): void {
  router.post('/orders', {
    handler: async (ctx) => {
      const telemetry = ctx.services.get<ITelemetryService>(CAPABILITIES.TELEMETRY);
      return await telemetry.withSpan('create-order', async (span) => {
        span.setAttribute('order.id', 'o-1');
        span.setStatus('ok');
        return ctx.response.status(201).json({ id: 'o-1' });
      });
    },
  });
}
```

## Behaviour the types do not show

- No exporter means no SDK load; callbacks still run and return their result.
- `withSpan` ends the span in a finally path; a thrown error is rethrown after marking failure.
- `serviceName` is required with an exporter; OTLP also needs `endpoint`.
- `serviceVersion` defaults to `'1.0.0'`; `spanProcessor` defaults to `'simple'`.
- Request middleware runs at priority 30 and propagates W3C traceparent; query strings are omitted
  from the recorded URL by default.

## Other options

- `exporter: 'console'` writes spans locally; `middleware: false` disables request spans.
- `instrumentations` enables `http`, `fetch`, `ioredis`, `amqplib` or `kafkajs` on Node only.
- `parentContext` or `root: true` controls span ancestry; `contextPropagation: false` disables
  activation.
- `diagnostics` retains minimized observations only for explicitly approved operations.
