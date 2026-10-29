# @setu-ts/telemetry-plugin

OpenTelemetry distributed tracing. Registers an `ITelemetryService` under `CAPABILITIES.TELEMETRY`
(`'telemetry'`) and a request-span middleware at priority 30.

Without an `exporter` the plugin runs in noop mode. With an exporter, install the optional peers for
the features you enable; the SDK is loaded during registration.

Install peers within the ranges declared by this package's `peerDependencies`, where this package is
installed — usually the root in an npm/Yarn/Bun workspace. A peer nested only under a member cannot
be loaded by a root-hoisted plugin. `setu add telemetry` records the four console-exporter peers in
both manifests in a Node or Bun Setu workspace. See
[Optional peers in a workspace](https://github.com/setu-ts/setu-ts/blob/main/docs/plugins.md#optional-peers-in-a-workspace).

## Installation

| Feature                                               | Optional peer packages loaded                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Any exporter                                          | `@opentelemetry/sdk-trace-base`, `@opentelemetry/resources`, `@opentelemetry/api`              |
| `exporter: 'console'`                                 | The common peers above; the console exporter is in `@opentelemetry/sdk-trace-base`             |
| `exporter: 'otlp'`                                    | Common peers plus `@opentelemetry/exporter-trace-otlp-http`                                    |
| `contextPropagation: true` (default with an exporter) | `@opentelemetry/context-async-hooks`                                                           |
| `instrumentations.http`                               | `@opentelemetry/instrumentation-http`                                                          |
| `instrumentations.fetch`                              | `@opentelemetry/instrumentation-undici`                                                        |
| `instrumentations.ioredis`                            | `@opentelemetry/instrumentation-ioredis`                                                       |
| `instrumentations.redis`                              | `@opentelemetry/instrumentation-redis` (`^0.69.0`, the first release supporting node-redis v6) |
| `instrumentations.amqplib`                            | `@opentelemetry/instrumentation-amqplib`                                                       |
| `instrumentations.kafkajs`                            | `@opentelemetry/instrumentation-kafkajs`                                                       |

A common OTLP setup with nested spans:

```bash
npm install @setu-ts/telemetry-plugin @opentelemetry/sdk-trace-base @opentelemetry/resources @opentelemetry/api @opentelemetry/exporter-trace-otlp-http @opentelemetry/context-async-hooks
```

A missing common SDK peer makes `app.start()` reject with `OptionalDependencyUnavailableError`
naming the package; it does not switch to noop. For example, without the SDK on Node:
`Optional dependency '@opentelemetry/sdk-trace-base' could not be loaded by '@setu-ts/telemetry-plugin'. Install it where '@setu-ts/telemetry-plugin' is installed, in the version range that package declares for it — in an npm, Yarn or Bun workspace that is usually the workspace root, not the member — or choose an option that does not need it on this runtime.`
A missing instrumentation package is instead a logged no-op, as described below; a missing context
manager leaves spans unnested, as described under Propagation.

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

| Option                  | Type                                                       | Default    | Description                                                                                                                                                                                                                                           |
| ----------------------- | ---------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serviceName`           | `string`                                                   | —          | Required when an exporter is configured.                                                                                                                                                                                                              |
| `serviceVersion`        | `string`                                                   | `'1.0.0'`  | Reported to the exporter.                                                                                                                                                                                                                             |
| `exporter`              | `SpanExporterKind`                                         | —          | Absent means noop mode.                                                                                                                                                                                                                               |
| `endpoint`              | `string`                                                   | —          | Required when `exporter: 'otlp'`.                                                                                                                                                                                                                     |
| `headers`               | `Record<string, string>`                                   | —          | Sent with OTLP requests.                                                                                                                                                                                                                              |
| `sampling`              | `SamplingConfig`                                           | —          | Sampling configuration.                                                                                                                                                                                                                               |
| `spanProcessor`         | `'simple' \| 'batch'`                                      | `'simple'` | Use `'batch'` in production.                                                                                                                                                                                                                          |
| `middleware`            | `boolean`                                                  | `true`     | Register the request-span middleware.                                                                                                                                                                                                                 |
| `instrumentations`      | `InstrumentationsConfig`                                   | none       | Per-instrumentation auto-instrumentation; see below.                                                                                                                                                                                                  |
| `contextPropagation`    | `boolean`                                                  | `true`     | Activate real spans for nested work.                                                                                                                                                                                                                  |
| `contextManagerFactory` | `() => Promise<{ enable(): unknown; disable(): unknown }>` | —          | Injectable async-local context manager loader: a **factory** returning a promise, not a manager instance. Its return type is structural on purpose, so the factory can resolve to an OTel context manager without importing a type from this package. |
| `redaction`             | `RedactionPolicy \| IRedactionService`                     | —          | Policy applied to retained query-parameter values when `queryParameters: 'redact'`.                                                                                                                                                                   |
| `queryParameters`       | `'omit' \| 'redact'`                                       | `'omit'`   | How `http.url` query parameters are handled; see [Request URL handling](#request-url-handling). `'redact'` without a `redaction` policy warns and fails closed to omission.                                                                           |
| `diagnostics`           | `TraceDiagnosticsOptions`                                  | —          | Opt-in minimized completed-span observations; see [Trace diagnostics (M98g)](#trace-diagnostics-m98g).                                                                                                                                                |

## Auto-instrumentation

`instrumentations` takes a per-key object (`http`, `fetch`, `ioredis`, `redis`, `amqplib`,
`kafkajs`), each `true` or an `InstrumentationConfig` — not a bare `string[]`. It is **Node-gated**:
on an unsupported runtime, or when the `@opentelemetry/instrumentation-*` package is absent, the
instrumentation is a documented **no-op, never a throw**, so one codebase deploys everywhere.

`redis` traces node-redis (`redis` v5 and v6), including a client wrapped in `fromNodeRedis` from
`@setu-ts/common`: a `SET` sent through the adapter is recorded as a `redis-SET` span with
`db.system.name` `redis`. Enable `ioredis`, `redis` or both to match the clients the application
uses. node-redis 6 can also report OpenTelemetry metrics itself (`OpenTelemetry.init`); spans need
this arm.

Each plugin instance calls `setTracerProvider` on itself; there is no global singleton.

Outcomes are reported through the plugin's logger (`ctx.logger`, read at call time): an enabled
instrumentation logs at `debug`, a failure logs at `warn` with `kind` and `reason`. A failure
remains a no-op rather than a throw — but it is no longer silent. The plugin declares the logger
capability as an **optional dependency**, so the kernel registers a plugin-provided logger (e.g.
`LoggerPlugin`) before it and the standard configuration reports every outcome; an app without a
logger plugin still boots, with nothing emitted.

## Propagation

The request-span middleware reads and writes the W3C `traceparent` header, so traces join across
services without extra configuration.

For outbound calls made with `@setu-ts/sdk`, add its `createTraceContextInterceptor(telemetry)` to
the client's request interceptors. It reads this plugin's active span and carries the same trace to
the receiving service.

Span **nesting** is a separate mechanism with its own preconditions. In real OTel mode the plugin
registers an async-local context manager and `withSpan` runs its callback with the span active, so
nested work — including messaging publishes — becomes a child span. That applies only when all three
hold: the plugin is in real OTel mode (not noop or fallback), `contextPropagation` is not `false`,
and a context manager is active. Registration is reported through the logger and never throws.

Two outcomes count as active, and only one counts as failure:

- **Registered.** The plugin installed its own async-local manager. Nesting works.
- **Adopted.** `setGlobalContextManager` reported that the host already owns a manager, so the
  plugin keeps the host's. Nesting still works — the existing manager carries the context — which is
  why this is reported as active rather than as a failure.
- **Failed.** The optional `@opentelemetry/context-async-hooks` package could not be loaded, or the
  registration call itself threw. Only here are spans still recorded but arriving as unrelated
  siblings rather than a tree.

Pass an explicit `parentContext` where the relationship must hold regardless.

Pass `root: true` (M107) to start a span with NO parent — ignoring both `parentContext` and the
active span. Work that runs on behalf of something other than the surrounding request needs it: the
messaging outbox relays a row that carries no valid stored `traceparent` under a root span, so a
sweep dispatched from inside a request does not attribute that row to the request. The plugin
carries the option to OpenTelemetry's own `SpanOptions.root`; an `ITelemetryService` implementation
that ignores it starts the span under the active span.

## Request URL handling

Request spans omit query strings and fragments from `http.url` by default. Set
`queryParameters: 'redact'` together with `redaction` to retain query parameter names while applying
the supplied policy to each value (`query.<name>`). If redact mode has no policy, the plugin warns
at registration and continues to omit the query string.

## Multiple backends

The plugin exports to **one** endpoint. To fan a single trace stream out to several vendors, point
it at an OpenTelemetry Collector — see
[docs/telemetry-collector-fanout.md](https://github.com/setu-ts/setu-ts/blob/main/docs/telemetry-collector-fanout.md)
and the reference config in
[docker/otel-collector/](https://github.com/setu-ts/setu-ts/tree/main/docker/otel-collector).

## Trace diagnostics (M98g)

`TelemetryPlugin({ diagnostics })` opts into minimized completed-span observations for the local
diagnostics connector. With the built-in OTel provider, an internal span processor is appended AFTER
the exporter processor in the same provider constructor — the exporter path is unchanged, the
processor never exports and never throws into OTel — and every finished SAMPLED span whose exact raw
name appears in `operations` is reduced to its approved alias, W3C-validated identifiers,
relationships, kind, outcome, duration and age before anything is retained. Attributes, events,
resource labels, tracestate, baggage, exceptions and the raw span name never reach collector state.
The plugin always registers an `ITraceDiagnosticsSource` under `CAPABILITIES.TRACE_DIAGNOSTICS`:
without the option it answers `disabled`; with the option under a custom `tracerProviderFactory` or
without an exporter it answers `unsupported` with the fixed coverage reason. Sampling, context
activation and export behavior are unchanged. See
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#telemetry-setu-tstelemetry-plugin)
and `docs/diagnostics-protocol.md`.

## Exports

| Export                    | Kind      |
| ------------------------- | --------- |
| `telemetryMiddleware`     | function  |
| `TelemetryPlugin`         | function  |
| `NoopTelemetryService`    | class     |
| `TELEMETRY_SPAN_KEY`      | const     |
| `InstrumentationConfig`   | interface |
| `InstrumentationsConfig`  | interface |
| `ISpan`                   | interface |
| `ITelemetryService`       | interface |
| `SamplingConfig`          | interface |
| `SpanOptions`             | interface |
| `TelemetryContext`        | interface |
| `TelemetryPluginOptions`  | interface |
| `TraceDiagnosticsOptions` | interface |
| `TracerHost`              | interface |
| `InstrumentationKind`     | type      |
| `SpanAttributeValue`      | type      |
| `SpanExporterKind`        | type      |
| `SpanKind`                | type      |
| `SpanProcessorKind`       | type      |
| `SpanStatus`              | type      |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#telemetry-setu-tstelemetry-plugin).
