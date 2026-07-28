# @hono-enterprise/telemetry-plugin

OpenTelemetry distributed tracing. Registers an `ITelemetryService` under `CAPABILITIES.TELEMETRY`
(`'telemetry'`) and a request-span middleware at priority 30.

The OTel SDK is an **optional** dependency, lazily imported via `npm:` specifiers. Without an
`exporter` the plugin runs in noop mode, so tracing can stay off in development at zero cost.

## Installation

```typescript
import { TelemetryPlugin } from '@hono-enterprise/telemetry-plugin';
```

## Usage

```typescript
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { TelemetryPlugin } from '@hono-enterprise/telemetry-plugin';
import { CAPABILITIES, type ITelemetryService } from '@hono-enterprise/common';

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

| Option             | Type                     | Default    | Description                                          |
| ------------------ | ------------------------ | ---------- | ---------------------------------------------------- |
| `serviceName`      | `string`                 | —          | Required when an exporter is configured.             |
| `serviceVersion`   | `string`                 | `'1.0.0'`  | Reported to the exporter.                            |
| `exporter`         | `SpanExporterKind`       | —          | Absent means noop mode.                              |
| `endpoint`         | `string`                 | —          | Required when `exporter: 'otlp'`.                    |
| `headers`          | `Record<string, string>` | —          | Sent with OTLP requests.                             |
| `sampling`         | `SamplingConfig`         | —          | Sampling configuration.                              |
| `spanProcessor`    | `'simple' \| 'batch'`    | `'simple'` | Use `'batch'` in production.                         |
| `middleware`       | `boolean`                | `true`     | Register the request-span middleware.                |
| `instrumentations` | `InstrumentationsConfig` | none       | Per-instrumentation auto-instrumentation; see below. |

## Auto-instrumentation

`instrumentations` takes a per-key object (`http`, `fetch`, `ioredis`, `amqplib`, `kafkajs`), each
`true` or an `InstrumentationConfig` — not a bare `string[]`. It is **Node-gated**: on an
unsupported runtime, or when the `@opentelemetry/instrumentation-*` package is absent, the
instrumentation is a documented **no-op, never a throw**, so one codebase deploys everywhere.

Each plugin instance calls `setTracerProvider` on itself; there is no global singleton.

## Propagation

The request-span middleware reads and writes the W3C `traceparent` header, so traces join across
services without extra configuration.

## Multiple backends

The plugin exports to **one** endpoint. To fan a single trace stream out to several vendors, point
it at an OpenTelemetry Collector — see
[docs/telemetry-collector-fanout.md](https://github.com/dkpaul91/hono-enterprise/blob/main/docs/telemetry-collector-fanout.md)
and the reference config in
[docker/otel-collector/](https://github.com/dkpaul91/hono-enterprise/tree/main/docker/otel-collector).

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/dkpaul91/hono-enterprise/blob/main/PUBLIC_API.md).
