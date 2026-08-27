# @setu-ts/telemetry-plugin

OpenTelemetry distributed tracing. Registers an `ITelemetryService` under `CAPABILITIES.TELEMETRY`
(`'telemetry'`) and a request-span middleware at priority 30.

The OTel SDK is an **optional** dependency, lazily imported via `npm:` specifiers. Without an
`exporter` the plugin runs in noop mode, so tracing can stay off in development at zero cost.

## Installation

```typescript
import { TelemetryPlugin } from '@setu-ts/telemetry-plugin';
```

## Usage

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { TelemetryPlugin } from '@setu-ts/telemetry-plugin';
import { CAPABILITIES, type ITelemetryService } from '@setu-ts/common';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    TelemetryPlugin({
      serviceName: 'orders-api',
      exporter: 'otlp',
      endpoint: 'http://localhost:4318/v1/traces',
      spanProcessor: 'batch',
      instrumentations: { http: true, ioredis: true },
    }),
  ],
});
await app.start({ port: 3000 });
```

## Options

| Option                  | Type                            | Default    | Description                                          |
| ----------------------- | ------------------------------- | ---------- | ---------------------------------------------------- |
| `serviceName`           | `string`                        | —          | Required when an exporter is configured.             |
| `serviceVersion`        | `string`                        | `'1.0.0'`  | Reported to the exporter.                            |
| `exporter`              | `SpanExporterKind`              | —          | Absent means noop mode.                              |
| `endpoint`              | `string`                        | —          | Required when `exporter: 'otlp'`.                    |
| `headers`               | `Record<string, string>`        | —          | Sent with OTLP requests.                             |
| `sampling`              | `SamplingConfig`                | —          | Sampling configuration.                              |
| `spanProcessor`         | `'simple' \| 'batch'`           | `'simple'` | Use `'batch'` in production.                         |
| `middleware`            | `boolean`                       | `true`     | Register the request-span middleware.                |
| `instrumentations`      | `InstrumentationsConfig`        | none       | Per-instrumentation auto-instrumentation; see below. |
| `contextPropagation`    | `boolean`                       | `true`     | Activate real spans for nested work.                 |
| `contextManagerFactory` | `() => Promise<ContextManager>` | —          | Injectable async-local context manager loader.       |

## Auto-instrumentation

`instrumentations` takes a per-key object (`http`, `fetch`, `ioredis`, `amqplib`, `kafkajs`), each
`true` or an `InstrumentationConfig` — not a bare `string[]`. It is **Node-gated**: on an
unsupported runtime, or when the `@opentelemetry/instrumentation-*` package is absent, the
instrumentation is a documented **no-op, never a throw**, so one codebase deploys everywhere.

Each plugin instance calls `setTracerProvider` on itself; there is no global singleton.

Outcomes are reported through the plugin's logger (`ctx.logger`, read at call time): an enabled
instrumentation logs at `debug`, a failure logs at `warn` with `kind` and `reason`. A failure
remains a no-op rather than a throw — but it is no longer silent. The plugin declares the logger
capability as an **optional dependency**, so the kernel registers a plugin-provided logger (e.g.
`LoggerPlugin`) before it and the standard configuration reports every outcome; an app without a
logger plugin still boots, with nothing emitted.

## Propagation

The request-span middleware reads and writes the W3C `traceparent` header, so traces join across
services without extra configuration. In real OTel mode, `withSpan` also activates its span with an
async-local context manager: nested work, including messaging publishes, becomes a child span.

## Multiple backends

The plugin exports to **one** endpoint. To fan a single trace stream out to several vendors, point
it at an OpenTelemetry Collector — see
[docs/telemetry-collector-fanout.md](https://github.com/setu-ts/setu-ts/blob/main/docs/telemetry-collector-fanout.md)
and the reference config in
[docker/otel-collector/](https://github.com/setu-ts/setu-ts/tree/main/docker/otel-collector).

## Exports

| Export                   | Kind      |
| ------------------------ | --------- |
| `telemetryMiddleware`    | function  |
| `TelemetryPlugin`        | function  |
| `NoopTelemetryService`   | class     |
| `TELEMETRY_SPAN_KEY`     | const     |
| `InstrumentationConfig`  | interface |
| `InstrumentationsConfig` | interface |
| `ISpan`                  | interface |
| `ITelemetryService`      | interface |
| `SamplingConfig`         | interface |
| `SpanOptions`            | interface |
| `TelemetryContext`       | interface |
| `TelemetryPluginOptions` | interface |
| `TracerHost`             | interface |
| `InstrumentationKind`    | type      |
| `SpanAttributeValue`     | type      |
| `SpanExporterKind`       | type      |
| `SpanKind`               | type      |
| `SpanProcessorKind`      | type      |
| `SpanStatus`             | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#telemetry-setu-tstelemetry-plugin).
