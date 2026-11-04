# DI and decorators example

This app combines `DiPlugin` with `DecoratorPlugin`, with each feature declared as a `@Module`. The
decorated controller receives its `GreetingService` through the class-level
`@Inject(GREETING_SERVICE)`.

`LifetimesController` (`GET /lifetimes`) compares parameter-injected services with
`container.forRequest(ctx)`. The framework creates the request scope lazily and disposes it at
request completion: singleton services are shared across requests, while scoped services are
retained within one request and differ between requests.

```bash
pnpm --dir apps/di-decorators run start
pnpm --dir apps/di-decorators run smoke
```

`src/modules/index.ts` is CLI-owned: `setu.config.ts` passes its `MODULES` to `DecoratorPlugin` and
calls `registerModules(app.router, app.services)`. Each module also has a managed `index.ts`. The
lifetime providers live in `singleton-report.service.ts` and `scoped-report.service.ts`, matching
separately generated service artifacts.

Read the [example deep dive](../../docs/examples.md#di-decorators) for the concept and source
walkthrough.
