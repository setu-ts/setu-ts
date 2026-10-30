# DI and decorators example

This app combines `DiPlugin` with `DecoratorPlugin`, with each feature declared as a `@Module`. The
decorated controller receives its `GreetingService` through the class-level
`@Inject(GREETING_SERVICE)`.

`LifetimesController` (`GET /lifetimes`) visibly calls `container.createScope()`: singleton services
are shared across those scopes, while scoped services are retained inside one scope and differ
between scopes. The framework does **not** create a DI scope per request; applications that need
request scoping must create and carry that scope themselves.

```bash
pnpm --dir apps/di-decorators run start
pnpm --dir apps/di-decorators run smoke
```

Read the [example deep dive](../../docs/examples.md#di-decorators) for the concept and source
walkthrough.
