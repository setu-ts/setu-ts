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
npx @setu-ts/cli@0.12.0 generate service billing
npx @setu-ts/cli@0.12.0 generate --help
```

## Production

```bash
npm run build
npm start
```

The build type-checks, checks CLI wiring and bundles the service into dist/. Run npm test before building an image: DI graph validation happens at boot.
