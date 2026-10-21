# @setu-ts/health-plugin — health checks and Kubernetes probes

Every scaffold registers `HealthPlugin()` in `setu.config.ts`; elsewhere run `setu add health` and
install — it is zero-configuration and inserts the bare call. It serves `/health`, `/live` and
`/ready` and provides `CAPABILITIES.HEALTH`.

```ts
import { createHttpIndicator, HealthPlugin } from '@setu-ts/health-plugin';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

export function createHealthApp() {
  return createApplication({
    plugins: [
      RuntimePlugin(),
      HealthPlugin({ indicators: [createHttpIndicator('api', { url: 'https://api.example.com' })] }),
    ],
  });
}
```

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IHealthService, IServiceRegistry } from '@setu-ts/common';

export function registerProbe(services: IServiceRegistry): void {
  const health = services.get<IHealthService>(CAPABILITIES.HEALTH);
  health.registerIndicator('billing', async () => ({ status: 'up', data: { queueDepth: 0 } }));
}
```

- `endpoints` renames the probe paths; defaults are `'/health'`, `'/live'` and `'/ready'`, and a key
  set to `undefined` skips that route.
- `details` defaults to `false`, so HTTP bodies carry only
  `{ status, timestamp, checks: { name: { status } } }`; `true` adds `data` and `latencyMs`. The
  service's `check`, `checkLive` and `checkReady` always return full reports.
- `indicators` takes an `IHealthIndicator` or a factory `(services) => IHealthIndicator`, called at
  `onInit` so it can resolve a later capability.
  `createHttpIndicator(name, { url, timeoutMs, fetcher })` reports `up` for a 2xx/3xx answer.
- `indicatorTimeoutMs` defaults to `5000`; a timeout records
  `{ status: 'down', data: { reason: 'timeout' } }` and a rejection `{ reason: 'error' }`. Statuses
  are `up`, `degraded` and `down`: `/health` is 200 for up or degraded and 503 for down, `/live`
  stays 200, `/ready` is 200 only when every indicator is `up`.
- `diagnostics` is opt-in with the literal `enabled: true` plus an `indicators` name→alias map; it
  never changes the probes and registers under `CAPABILITIES.HEALTH_DIAGNOSTICS`.
- `setu g health-indicator db` writes `src/health/db.indicator.ts` and `src/health/index.ts`
  exporting `HEALTH_INDICATORS`, wired as `HealthPlugin({ indicators: [...HEALTH_INDICATORS] })`.
- On Deno the `self` indicator reads the host name, so the start task needs `--allow-sys` or
  `/health` reports down.

<!-- card-allow: HEALTH_INDICATORS -->
