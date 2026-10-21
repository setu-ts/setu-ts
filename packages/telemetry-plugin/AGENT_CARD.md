# @setu-ts/telemetry-plugin — OpenTelemetry tracing

Run `setu add telemetry`, install, then add `TelemetryPlugin(...)` to the `plugins` array in
`setu.config.ts`; `setu add` prints the line but does not rewrite the config. No `exporter` means
noop mode — the service is still registered, at zero SDK cost.

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

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IRequestContext, ITelemetryService } from '@setu-ts/common';

export async function traceOrder(context: IRequestContext): Promise<string> {
  const telemetry = context.services.get<ITelemetryService>(CAPABILITIES.TELEMETRY);
  return await telemetry.withSpan('create-order', async (span) => {
    span.setAttribute('order.id', 'o-1');
    span.setStatus('ok');
    return 'done';
  });
}
```

- `withSpan(name, fn, options?)` ends the span exactly once, even when `fn` throws. `span.setStatus`
  takes `'ok'`, `'error'` or `'unset'`; `span.recordException(error)` records a failure.
- `exporter` is `'otlp'` or `'console'`; `'otlp'` also needs `endpoint`. `serviceName` is required
  in real mode. `serviceVersion` defaults to `'1.0.0'`; `spanProcessor` defaults to `'simple'`.
- `instrumentations` is a per-kind map (`http`, `fetch`, `ioredis`, `amqplib`, `kafkajs`), each
  `true` or a config object — Node only; elsewhere it is a no-op, never a throw.
- The request-span middleware runs at priority 30 by default (`middleware: false` drops it), reads
  and writes W3C `traceparent`, and stores the span on `ctx.state` under `TELEMETRY_SPAN_KEY`.
- Pass `parentContext` or `root: true` in `withSpan` options when nesting must not depend on
  `contextPropagation`; `contextPropagation: false` leaves spans flat.
