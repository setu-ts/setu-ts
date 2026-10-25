# @setu-ts/di-plugin

Optional dependency-injection container. Registers an `IContainer` under `CAPABILITIES.DI_CONTAINER`
(`'di-container'`).

Supports singleton, scoped, and transient lifetimes, constructor and factory injection, string,
typed and class tokens, a request scope, disposal, and an optional fallback to the kernel's
`ServiceRegistry`. The graph is compiled into direct factories and validated once at boot: a missing
dependency, a cycle, or a singleton that reaches a scoped service fails `app.start()`.

The framework does not require this package — the kernel's service registry is enough for most
applications. Reach for the container when you want constructor injection, per-request instances
(`container.forRequest(ctx)`), or something to dispose of what you created.

## Installation

```typescript
import { DiPlugin } from '@setu-ts/di-plugin';
```

## Usage

Register providers while plugins register (or from `onInit` and `onBootstrap`); the container closes
after the last bootstrap hook, and a `register` after that throws `ContainerClosedError`.

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { DiPlugin } from '@setu-ts/di-plugin';
import { CAPABILITIES, createToken, type IContainer, type IPlugin } from '@setu-ts/common';

class Clock {
  now(): number {
    return 0;
  }
}

class UnitOfWork {
  constructor(readonly clock: Clock) {}
  release(): void {}
}

const UNIT_OF_WORK = createToken<UnitOfWork>('unit-of-work');

const providers: IPlugin = {
  name: 'app-providers',
  version: '1.0.0',
  dependencies: [CAPABILITIES.DI_CONTAINER],
  register(ctx) {
    const container = ctx.services.get<IContainer>(CAPABILITIES.DI_CONTAINER);
    container.register(Clock, { useClass: Clock });
    container.register(
      UNIT_OF_WORK,
      { useClass: UnitOfWork, inject: [Clock] },
      { scope: 'scoped', dispose: (uow) => uow.release() },
    );
  },
};

const app = createApplication({ plugins: [RuntimePlugin(), DiPlugin(), providers] });

app.router.get('/now', (ctx) => {
  // One UnitOfWork per request, released when the response is finished.
  const scope = ctx.services.get<IContainer>(CAPABILITIES.DI_CONTAINER).forRequest(ctx);
  const uow = scope.resolve(UNIT_OF_WORK);
  return ctx.response.json({ now: uow.clock.now() });
});

await app.start({ port: 3000 });
```

A token is a string, a typed token from `createToken<T>(name)`, or a class; `resolve` infers the
type from the last two. A factory declares its dependencies in `inject` and receives them as
arguments: `{ useFactory: (clock: Clock) => new UnitOfWork(clock), inject: [Clock] }`.

## Options

| Option         | Type                                     | Default       | Description                                                        |
| -------------- | ---------------------------------------- | ------------- | ------------------------------------------------------------------ |
| `defaultScope` | `'singleton' \| 'scoped' \| 'transient'` | `'singleton'` | Lifecycle for providers registered without an explicit scope.      |
| `autoRegister` | `boolean`                                | `true`        | Fall back to the kernel `ServiceRegistry` for unregistered tokens. |

With `autoRegister`, boot validation checks a fallback token with `has()`, and the first successful
resolve is cached as a singleton. Explicit container registrations always take precedence.

## Exports

| Export                         | Kind      |
| ------------------------------ | --------- |
| `createContainer`              | function  |
| `DiPlugin`                     | function  |
| `CircularDetector`             | class     |
| `ContainerBuilder`             | class     |
| `ContainerClosedError`         | class     |
| `ContainerValidationError`     | class     |
| `DiContainer`                  | class     |
| `ProviderRegistry`             | class     |
| `RequestScopeUnavailableError` | class     |
| `ScopeDisposedError`           | class     |
| `ScopeRequiredError`           | class     |
| `ContainerConfig`              | interface |
| `DiPluginOptions`              | interface |
| `ExternalResolver`             | interface |
| `ProviderEntry`                | interface |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#api-reference-setu-tsdi-plugin).
