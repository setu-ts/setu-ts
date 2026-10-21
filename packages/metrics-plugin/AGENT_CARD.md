# @setu-ts/metrics-plugin — Prometheus metrics and a scrape endpoint

Every scaffold registers `MetricsPlugin()` in `setu.config.ts`; elsewhere run `setu add metrics` and
install (zero-configuration, so the bare call is inserted). It serves `/metrics` and provides
`CAPABILITIES.METRICS`.

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IMetricsService } from '@setu-ts/common';
import { MetricsPlugin } from '@setu-ts/metrics-plugin';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

export async function createMetricsApp() {
  const app = createApplication({
    plugins: [RuntimePlugin(), MetricsPlugin({ endpoint: '/metrics', httpMetrics: true })],
  });
  await app.start(); // capabilities exist only after start()
  const metrics = app.services.get<IMetricsService>(CAPABILITIES.METRICS);
  metrics.counter('app_signups_total', { help: 'Completed signups' }).inc(1);
  return app;
}
```

Pre-register metrics so their `# HELP` and `# TYPE` lines appear from startup:

```ts
import { MetricsPlugin } from '@setu-ts/metrics-plugin';
import type { NamedMetricConfig } from '@setu-ts/metrics-plugin';

const billing: readonly NamedMetricConfig[] = [
  { name: 'invoices_total', type: 'counter', help: 'Invoices issued' },
];

export const plugin = MetricsPlugin({ customMetrics: billing });
```

- `endpoint` defaults to `'/metrics'`; a scrape answers `text/plain; version=0.0.4; charset=utf-8`.
- `defaultMetrics` and `httpMetrics` default to `true`. The middleware runs outermost (priority 20).
  `excludePaths` REPLACES the default `['/health', '/live', '/ready']` set, and `endpoint` is always
  excluded.
- `counter`, `gauge`, `histogram` and `summary` are get-or-create (a repeat call returns the same
  instrument). Record value-first: `inc(value?, labels?)`, `set(value, labels?)`,
  `observe(value, labels?)`; `get` returns an existing instrument or `undefined`.
- `MetricOptions` carries `help` (defaults to the name), `labels`, `buckets`, `quantiles` and
  `maxSamples`. Buckets default to `defaultBuckets`, summary quantiles to `defaultQuantiles`.
- `customMetrics` takes `NamedMetricConfig`: `name`, `type`, `help`, optional `labels` and
  `buckets`.
- `setu g metric signup` writes `src/metrics/signup.metric.ts` with `SIGNUP_TOTAL`, `SIGNUP_METRIC`
  and `signupCounter`, and `src/metrics/index.ts` exports `CUSTOM_METRICS`, wired as
  `MetricsPlugin({ customMetrics: [...CUSTOM_METRICS] })`.

<!-- card-allow: SIGNUP_TOTAL SIGNUP_METRIC CUSTOM_METRICS -->
