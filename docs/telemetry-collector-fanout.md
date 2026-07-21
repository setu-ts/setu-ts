# Telemetry — OTel Collector Trace Fan-Out (Datadog + New Relic + App Insights)

Send one OTLP trace stream from a Hono Enterprise app to **multiple observability backends at once**
without coupling the app to any vendor. The [telemetry plugin](../packages/telemetry-plugin) exports
a single OTLP/HTTP stream; an OpenTelemetry **Collector** receives it and fans it out. Routing,
sampling, and credentials live in the collector, so backends are added or removed by editing
collector config — no app redeploy, no vendor SDK in your app.

```
                                        ┌──────────────► Datadog
Hono app ──OTLP/HTTP:4318──►  Collector ┼──────────────► New Relic (OTLP)
(exporter:'otlp')             (contrib) └──────────────► Azure App Insights
```

Reference config:
[`docker/otel-collector/collector-config.yaml`](../docker/otel-collector/collector-config.yaml).

> **Scope.** This page and that config are the telemetry fan-out reference only. Runnable
> `docker-compose`, Kubernetes manifests, and Helm are owned by **Milestone 39 (Docker and
> Kubernetes)**, which references this config rather than redefining it; the general documentation
> site is owned by **Milestone 38 (Documentation)**, which links here.

## 1. App side — point the plugin at the collector

The app is unchanged from any OTLP setup: emit one stream at the collector's `:4318`.

```typescript
app.register(TelemetryPlugin({
  serviceName: 'my-app',
  exporter: 'otlp',
  endpoint: 'http://otel-collector:4318/v1/traces',
}));
```

That is the whole app-side change. The plugin uses OTLP/**HTTP**
(`@opentelemetry/exporter-trace-otlp-http`), which is why the collector's OTLP receiver is
configured for the HTTP protocol on `:4318`.

## 2. Collector side — you need the _contrib_ distribution

The `datadog` and `azuremonitor` exporters ship only in **`otelcol-contrib`** (image
`otel/opentelemetry-collector-contrib`), not the core `otelcol` build. New Relic ingests OTLP
natively, so it uses the generic `otlphttp` exporter — no New-Relic-specific component.

## 3. Required environment (credentials — never commit these)

Every secret is referenced as `${env:...}` in the config. Provide them via your container runtime's
env or secret mechanism.

| Env var                                 | Vendor       | What it is                                                                        |
| --------------------------------------- | ------------ | --------------------------------------------------------------------------------- |
| `DD_API_KEY`                            | Datadog      | Datadog API key                                                                   |
| `DD_SITE`                               | Datadog      | Datadog site — `datadoghq.com` (US1), `datadoghq.eu` (EU), `us3.datadoghq.com`, … |
| `NEW_RELIC_OTLP_ENDPOINT`               | New Relic    | `https://otlp.nr-data.net` (US) or `https://otlp.eu01.nr-data.net` (EU)           |
| `NEW_RELIC_LICENSE_KEY`                 | New Relic    | New Relic **license** key (sent as the `api-key` header)                          |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | App Insights | Full connection string (`InstrumentationKey=...;IngestionEndpoint=...`)           |

## 4. Validate the config

The config is validated with the contrib collector — this fails on an unknown component, a malformed
pipeline, or a missing required field:

```bash
otelcol-contrib validate --config docker/otel-collector/collector-config.yaml
```

If the binary is not installed locally, validate via the image:

```bash
docker run --rm -v "$PWD/docker/otel-collector:/cfg" \
  otel/opentelemetry-collector-contrib:latest validate --config /cfg/collector-config.yaml
```

## 5. Add or remove a backend

The `traces` pipeline's `exporters` list is the fan-out set. To **add** a backend, define its
exporter under `exporters:` and add its name to `service.pipelines.traces.exporters`. To **remove**
one, delete it from that list (and optionally its exporter block). Example — drop New Relic, keep
Datadog and Azure:

```yaml
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [memory_limiter, batch]
      exporters: [datadog, azuremonitor] # otlphttp/newrelic removed
```

A backend you remove from the list stops receiving traces immediately on the next collector reload —
the app is untouched.

## 6. Security note

Never put literal key material in the committed config — the reference uses `${env:...}` for every
secret precisely so it is safe to publish. Supply the values through a container secret, a `.env`
file that is git-ignored, or your orchestrator's secret store. Rotating a key is a collector env
change, not an app change.
