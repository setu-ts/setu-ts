# @setu-ts/metrics-plugin — application metrics and scraping

**Add it:** `setu add metrics` adds the dependency and inserts `MetricsPlugin()` in recognized
scaffolds (already registered in REST projects). It provides `CAPABILITIES.METRICS`
(`IMetricsService`).

## Count a completed operation

```ts
import { CAPABILITIES } from "@setu-ts/common";
import type { IMetricsService, IRouterApi } from "@setu-ts/common";

export function registerExportRoutes(router: IRouterApi): void {
  router.get("/export", {
    handler: (ctx) => {
      const metrics = ctx.services.get<IMetricsService>(CAPABILITIES.METRICS);
      metrics.counter("exports_total", { help: "Exports served" }).inc();
      return ctx.response.json({ rows: [] });
    },
  });
}
```

## Declare metrics before the first operation

Configure the existing registration in `setu.config.ts`:

```ts
import { MetricsPlugin } from "@setu-ts/metrics-plugin";

app.register(MetricsPlugin({
  customMetrics: [{ name: "exports_total", type: "counter", help: "Exports served" }],
}));
```

## Behaviour the types do not show

- `endpoint` defaults to `/metrics`; scrapes serve Prometheus text with version `0.0.4`.
- `defaultMetrics` and `httpMetrics` both default to `true`; HTTP collection runs only when both are
  enabled. The scrape endpoint is always excluded from HTTP collection.
- `excludePaths` replaces the default health/live/ready exclusions rather than extending them.
- `counter`, `gauge`, `histogram` and `summary` return the existing instrument for a repeated name;
  requesting another type under that name throws. `get` returns `undefined` when absent.
- Counters default to incrementing by one and reject negative increments. Record value first,
  optional labels second; when labels are declared, supplied names must match that set.
- `customMetrics` registers at initialization, so metric declarations appear before recording a
  sample. Unspecified `help` in factory calls defaults to the metric name.

## Other options

- `endpoint` changes the scrape path; `excludePaths` accepts exact strings or regular expressions.
- `defaultBuckets` and `defaultQuantiles` set histogram and summary defaults.
- `MetricOptions` adds per-instrument `labels`, `buckets`, `quantiles` and `maxSamples`;
  `NamedMetricConfig` types declarative `customMetrics` entries.
