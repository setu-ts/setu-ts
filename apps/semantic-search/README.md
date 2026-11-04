# semantic-search

A [Setu-TS](https://github.com/setu-ts/setu-ts) project targeting `node`.

## Run

```bash
npm run start:dev
```

## What it serves

At `http://localhost:3000` (set `PORT` to change it):

- `/` — the hello-world route in `setu.config.ts`
- `/greetings` — the example controller, greeting the world
- `/greetings/:name` — the same controller, greeting `name`
- `/health` — aggregated health of every registered indicator
- `/live` — liveness probe
- `/ready` — readiness probe
- `/metrics` — Prometheus metrics
- `/docs` — Swagger UI for the API
- `/openapi.json` — the OpenAPI document

## Generate code

```bash
npx @setu-ts/cli@0.11.0 generate service billing
npx @setu-ts/cli@0.11.0 generate --help
```

## Production

```bash
npm run build
npm start
```

The build type-checks, checks CLI wiring and bundles the service into dist/. Run npm test before building an image: DI graph validation happens at boot.

```bash
docker build -t semantic-search .
docker run --rm -p 3000:3000 semantic-search
```
