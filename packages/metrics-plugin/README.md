# @hono-enterprise/metrics-plugin

Prometheus metrics. Registers an `IMetricsService` under `CAPABILITIES.METRICS` (`'metrics'`) and
serves the scrape endpoint at `/metrics`.

Zero dependencies — the Prometheus text-format 0.0.4 renderer is implemented in this package.

## Installation

```typescript
import { MetricsPlugin } from '@hono-enterprise/metrics-plugin';
```

## Usage

```typescript
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { MetricsPlugin } from '@hono-enterprise/metrics-plugin';
import { CAPABILITIES, type IMetricsService } from '@hono-enterprise/common';

const app = createApplication({
  plugins: [RuntimePlugin(), MetricsPlugin({ endpoint: '/metrics', httpMetrics: true })],
});
await app.start({ port: 3000 });

const metrics = app.services.get<IMetricsService>(CAPABILITIES.METRICS);
const signups = metrics.counter('app_signups_total', { help: 'Completed signups' });
signups.inc(1);
```

## Options

| Option             | Type                  | Default                                                     | Description                                    |
| ------------------ | --------------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| `endpoint`         | `string`              | `'/metrics'`                                                | Scrape endpoint path.                          |
| `defaultMetrics`   | `boolean`             | `true`                                                      | Register the built-in metric set.              |
| `httpMetrics`      | `boolean`             | `true`                                                      | Register the HTTP request-tracking middleware. |
| `customMetrics`    | `NamedMetricConfig[]` | `[]`                                                        | Metrics pre-registered declaratively.          |
| `defaultBuckets`   | `number[]`            | `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]` | Histogram bucket boundaries.                   |
| `defaultQuantiles` | `number[]`            | `[0.5, 0.9, 0.99]`                                          | Summary quantiles.                             |

## Instruments

`counter`, `gauge`, `histogram`, and `summary`, all over a shared base.

## HTTP collectors

The metrics middleware runs at **priority 20 — outermost**, so it observes all ingress and the final
response status. The record path is wrapped in `try/finally`, so a request that throws still
decrements the active-requests gauge rather than leaking it.

## Full API

Every export and option is documented in [PUBLIC_API.md](../../PUBLIC_API.md).
