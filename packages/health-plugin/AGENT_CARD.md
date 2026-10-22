# @setu-ts/health-plugin — health checks and readiness probes

**Add it:** `setu add health` adds the dependency and inserts `HealthPlugin()` in recognized
scaffolds (already registered in REST projects). It provides `CAPABILITIES.HEALTH`
(`IHealthService`).

## Probe an upstream dependency

Replace the existing registration in `setu.config.ts`:

```ts
import { createHttpIndicator, HealthPlugin } from "@setu-ts/health-plugin";

app.register(HealthPlugin({
  indicators: [createHttpIndicator("billing", { url: "https://billing.example.com/health" })],
  indicatorTimeoutMs: 3000,
}));
```

## Read a complete health report

```ts
import { CAPABILITIES } from "@setu-ts/common";
import type { IHealthService } from "@setu-ts/common";

const health = ctx.services.get<IHealthService>(CAPABILITIES.HEALTH);
const report = await health.checkReady();
```

## Behaviour the types do not show

- Default routes are `/health`, `/live`, `/ready`. `/health` is `503` only for down, `/ready` is
  `200` only when every selected indicator is up, and `/live` always responds `200`.
- `checkLive` runs only the built-in self indicator; `checkReady` excludes it. `check` runs all.
- `details` defaults to `false`: HTTP checks expose only status, while programmatic reports always
  include indicator data and measured latency.
- Indicators run concurrently, but report checks retain registration order. Duplicate names throw.
- `indicatorTimeoutMs` defaults to `5000` milliseconds. A timed-out or rejecting callback yields
  down with a fixed reason rather than serializing its thrown error.
- Indicator factories in `indicators` run at initialization after all plugins register, so they can
  resolve later capabilities. `createHttpIndicator` accepts HTTP 2xx and 3xx as up.

## Other options

- `endpoints` replaces the default path object; omitted keys skip their routes.
- `createHttpIndicator` also takes `timeoutMs` and an injected `fetcher`.
- `diagnostics` with `enabled: true` and indicator aliases enables minimized observations under
  `CAPABILITIES.HEALTH_DIAGNOSTICS` (`IHealthDiagnosticsSource`); `scheduled` opts into polling.
