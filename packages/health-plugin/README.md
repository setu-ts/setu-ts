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
      indicators: [createHttpIndicator('external-api', { url: 'https://api.example.com/health' })],
      // M119b: a shared third-party API outage reports on /health but does not
      // take every replica out of /ready.
      readiness: { exclude: ['external-api'] },
    }),
  ],
});
await app.start({ port: 3000 });
```

## Options

| Option        | Type                       | Default                                                 | Description                                                                               |
| ------------- | -------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `endpoints`   | `EndpointsOptions`         | `{ health: '/health', live: '/live', ready: '/ready' }` | Probe paths.                                                                              |
| `indicators`  | `IHealthIndicator[]`       | `[]`                                                    | Indicators registered at startup.                                                         |
| `diagnostics` | `HealthDiagnosticsOptions` | _(absent — disabled)_                                   | Opt-in minimized health observations (M98d).                                              |
| `details`     | `boolean`                  | `false`                                                 | Include indicator data and latency in HTTP responses. Non-booleans throw at construction. |

Indicators passed via `indicators` are registered **before** the `onInit` drain, so they are present
even when the lifecycle is bypassed.

## Statuses

HTTP responses from `/health`, `/live`, and `/ready` default to
`{ status, timestamp, checks: { name: { status } } }`. They omit indicator `data` and `latencyMs`,
including runtime version and hostname. Set `HealthPlugin({ details: true })` to restore full
reports for a dashboard; protect those endpoints when their data is sensitive. The option affects
only those HTTP bodies: `HealthService.check()`, `checkLive()` and `checkReady()` still return full
reports, and the gRPC bridge is unchanged. Diagnostics are unaffected too, and record only their
minimized observations, never indicator `data` (see
[Health observations](#health-observations-m98d)).

An indicator reports `'up'`, `'degraded'`, or `'down'`; the overall report takes the worst status
among them. A result that is not one of those — not an object, or a `status` outside the three — is
reported as `{ status: 'down', data: { reason: 'invalid-result' } }` and its value is never
published, so an unrecognized status can never hide another indicator's `down`.

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
indicator `data`, no error text, and no absolute time is ever projected; a result whose `status` is
not `up`/`degraded`/`down` is observed as `failed`. `enabled` is the LITERAL `true` — any other
value is refused when `HealthPlugin(...)` is called, as is every other invalid option — and an
omitted option registers an inert, disabled source and performs no capture. Scheduled cycles cover
every scheduled indicator from a rotating start; a hung check keeps only its own concurrency slot,
so while fewer than `concurrency` checks are hung the rest keep refreshing. Once every slot is held
by a hung check, no scheduled check starts until one settles — the work stays bounded, and each
stalled alias keeps its last observation with a growing `ageMs` (or stays `never-observed`), while
the snapshot's `state` turns `stale` once any retained observation ages past `staleAfterMs`. The
source is registered under `CAPABILITIES.HEALTH_DIAGNOSTICS`; see
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

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#health-setu-tshealth-plugin).

## What `degraded` means

`/ready` runs the indicators that count toward readiness (never `self`), concurrently, each bounded
by `indicatorTimeoutMs`. A timeout, a throw, or an invalid result counts as `down`. When no
indicator counts toward readiness, `/ready` answers 200 with no checks. `/live` runs only `self`.

`/ready` returns 200 only when every indicator that counts toward readiness is `up`; `degraded` and
`down` both return 503. `/health` returns 200 for `up` or `degraded`, and 503 for `down`. `/live`
remains 200.

Use `degraded` when this replica should stop taking traffic. A shared problem that does not stop
request serving belongs in the indicator's `data`: draining every replica would remove healthy
serving capacity. Alert on those data fields.

## Readiness membership

Since **M119b** every indicator carries a readiness membership — whether it counts toward `/ready` —
that the contributing plugin declares and the application overrides by exact name. Absent, an
indicator counts toward readiness (the previous behaviour); a plugin registers one outside readiness
with `ctx.health.register(name, fn, { readiness: false })`. The application overrides it with the
`readiness` option, shown in the [Usage](#usage) example. Each name must match a registered
indicator — for example, with `MailPlugin` and `DatabasePlugin` registered,
`HealthPlugin({ readiness: { include: ['mail'], exclude: ['database'] } })` brings mail back into
readiness and takes the database out.

- `include` forces a named indicator into readiness; `exclude` forces it out. Each overrides the
  membership the contributing plugin declared, including an indicator a plugin registers directly
  through `IHealthService.registerIndicator`.
- `HealthPlugin(...)` (and a directly constructed `HealthService`) refuses an invalid option with
  `TypeError`: a `readiness` that is not a plain object, a list that is not an array, an empty or
  non-string name, the name `self`, or a name in both lists — the message names the option and never
  echoes a name. Names that match no registered indicator produce one warning at startup giving only
  a count.
- `/ready` runs only the readiness members (never `self`). An indicator outside readiness still runs
  on `/health`, where a `down` keeps it 503 and alerts firing; it is absent from the `/ready`
  report. `/live` is unchanged.

Every framework comparison gives each check this membership — Spring Boot's health groups (its mail
indicator is not in the readiness group by default), ASP.NET Core's health-check tags, and
MicroProfile's `@Readiness` — and Setu's default follows them: the `mail` indicator is registered
outside readiness, so an SMTP outage stays visible on `/health` without draining every replica (see
the
[mail-plugin README](https://github.com/setu-ts/setu-ts/blob/main/packages/mail-plugin/README.md#health-indicator)).
