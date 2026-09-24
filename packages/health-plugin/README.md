# @setu-ts/health-plugin

Health checks and Kubernetes-style probes. Registers an `IHealthService` under `CAPABILITIES.HEALTH`
(`'health'`) and serves `/health`, `/live`, and `/ready`.

Plugins across the framework contribute their own indicators (cache, storage, mail, scheduler,
websocket, …), so a health report reflects the whole application without extra wiring.

## Installation

```typescript
import { createHttpIndicator, HealthPlugin } from '@setu-ts/health-plugin';
```

## Usage

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { createHttpIndicator, HealthPlugin } from '@setu-ts/health-plugin';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    HealthPlugin({
      endpoints: { health: '/health', live: '/live', ready: '/ready' },
      indicators: [
        createHttpIndicator('external-api', { url: 'https://api.example.com/health' }),
      ],
    }),
  ],
});
await app.start({ port: 3000 });
```

## Options

| Option        | Type                       | Default                                                 | Description                                  |
| ------------- | -------------------------- | ------------------------------------------------------- | -------------------------------------------- |
| `endpoints`   | `EndpointsOptions`         | `{ health: '/health', live: '/live', ready: '/ready' }` | Probe paths.                                 |
| `indicators`  | `IHealthIndicator[]`       | `[]`                                                    | Indicators registered at startup.            |
| `diagnostics` | `HealthDiagnosticsOptions` | _(absent — disabled)_                                   | Opt-in minimized health observations (M98d). |

Indicators passed via `indicators` are registered **before** the `onInit` drain, so they are present
even when the lifecycle is bypassed.

## Statuses

An indicator reports `'up'`, `'degraded'`, or `'down'`; the overall report takes the worst status
among them.

## Health observations (M98d)

An opt-in `diagnostics` option exposes the health checks' outcomes as minimized observations through
the M98b diagnostics connector (`GET /v1/health`). It never changes `/health`, `/live`, or `/ready`.

```typescript
import { HealthPlugin } from '@setu-ts/health-plugin';

// Opt-in minimized health observations (M98d). The allowlist maps each
// registered indicator name to a safe display alias; unlisted indicators are
// never retained. This never changes /health, /live, or /ready.
HealthPlugin({
  diagnostics: {
    enabled: true,
    indicators: { 'database.check': 'database' },
    staleAfterMs: 30000,
    // Optional bounded scheduled collection (absent by default).
    scheduled: {
      indicators: ['database.check'],
      intervalMs: 30000,
      timeoutMs: 5000,
      concurrency: 2,
    },
  },
});
```

Only the latest outcome per approved alias is retained — never a history. Each observation carries
the approved alias, the framework's own status (present only when `reported`), the outcome state
(`reported` / `timed-out` / `failed` / `never-observed`), and monotonic `latencyMs`/`ageMs`. No
indicator `data`, no error text, and no absolute time is ever projected. `enabled` is the LITERAL
`true`; an omitted option registers an inert, disabled source and performs no capture. The source is
registered under `CAPABILITIES.HEALTH_DIAGNOSTICS`; see
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#health-setu-tshealth-plugin)
and `docs/diagnostics-protocol.md` for the wire shape.

## Exports

| Export                              | Kind      |
| ----------------------------------- | --------- |
| `createHttpIndicator`               | function  |
| `HealthPlugin`                      | function  |
| `HealthService`                     | class     |
| `HealthCheckResult`                 | interface |
| `HealthDiagnosticsObservation`      | interface |
| `HealthDiagnosticsOptions`          | interface |
| `HealthDiagnosticsScheduledOptions` | interface |
| `HealthDiagnosticsSnapshot`         | interface |
| `HealthPluginOptions`               | interface |
| `HealthReport`                      | interface |
| `HttpIndicatorOptions`              | interface |
| `IHealthDiagnosticsSource`          | interface |
| `IHealthIndicator`                  | interface |
| `IHealthService`                    | interface |
| `HealthIndicatorEntry`              | type      |
| `HealthIndicatorFn`                 | type      |
| `HealthObservationState`            | type      |
| `HealthStatus`                      | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#health-setu-tshealth-plugin).
