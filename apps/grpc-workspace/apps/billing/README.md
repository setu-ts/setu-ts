# billing

A [Setu-TS](https://setu-ts.dev/) project targeting `node`.

## Run

```bash
npm run start:dev
```

## What it serves

On the port `./src/discovery/services.ts` exports:

- `/` — the hello-world route in `setu.config.ts`
- `/health` — aggregated health of every registered indicator
- `/live` — liveness probe
- `/ready` — readiness probe
- `/metrics` — Prometheus metrics
- `/docs` — Swagger UI for the API
- `/openapi.json` — the OpenAPI document

## Generate code

```bash
npx @setu-ts/cli@0.13.0 generate module billing
npx @setu-ts/cli@0.13.0 generate --help
```

## Development transports

- Messaging and queue options come from `src/transport/index.ts`, which the CLI writes from the
  workspace broker in setu.workspace.json. With the `memory` broker both are in-memory: one process,
  lost on restart. `nats`, `kafka`, `pubsub` and `service-bus` have no queue arm, so with them the
  queue stays in memory. Change the broker for every member with
  `npx @setu-ts/cli@0.13.0 workspace broker <name>`.
- Telemetry has no exporter: spans are dropped. Set the `TelemetryPlugin` `exporter` option.

## Production

```bash
npm run build
npm start
```

The build type-checks, checks CLI wiring and bundles the service into dist/. The start script uses a
data-URL preload to default NODE_ENV to production before imports, keeping any preset value. Run npm
test before building an image.

`/metrics`, `/docs`, `/openapi.json` are served on the application port to anyone who can reach it:
restrict them at the proxy. Turning the UI off with OpenApiPlugin's `swagger: false`, moving `/docs`
with its `endpoint` and `/openapi.json` with its `specEndpoint` or moving `/metrics` with
MetricsPlugin's `endpoint` changes a path or a page, not who can reach it.
