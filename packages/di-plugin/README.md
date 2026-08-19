# @setu-ts/di-plugin

Optional dependency-injection container. Registers an `IContainer` under `CAPABILITIES.DI_CONTAINER`
(`'di-container'`).

Supports singleton, scoped, and transient lifecycles, constructor injection, class/factory/value
providers, circular-dependency detection, hierarchical scopes, and an optional fallback to the
kernel's `ServiceRegistry`.

The framework does not require this package — the kernel's service registry is enough for most
applications. Reach for the container when you want constructor injection and explicit scopes
(`container.createScope()`); the framework creates no scope per request, so a `scoped` service is
not re-created on every HTTP request.

## Installation

```typescript
import { DiPlugin } from '@setu-ts/di-plugin';
```

## Usage

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { createContainer, DiPlugin } from '@setu-ts/di-plugin';
import { CAPABILITIES } from '@setu-ts/common';

const app = createApplication({
  plugins: [RuntimePlugin(), DiPlugin({ defaultScope: 'singleton', autoRegister: true })],
});
await app.start({ port: 3000 });

const container = app.services.get<IContainer>(CAPABILITIES.DI_CONTAINER);
container.register(UserService, { scope: 'scoped' });
const users = container.resolve(UserService);
```

## Options

| Option         | Type                                     | Default       | Description                                                        |
| -------------- | ---------------------------------------- | ------------- | ------------------------------------------------------------------ |
| `defaultScope` | `'singleton' \| 'scoped' \| 'transient'` | `'singleton'` | Lifecycle for providers registered without an explicit scope.      |
| `autoRegister` | `boolean`                                | `false`       | Fall back to the kernel `ServiceRegistry` for unregistered tokens. |

With `autoRegister`, the first successful fallback is cached as a singleton. Explicit container
registrations always take precedence.

## Exports

| Export             | Kind      |
| ------------------ | --------- |
| `createContainer`  | function  |
| `DiPlugin`         | function  |
| `CircularDetector` | class     |
| `ContainerBuilder` | class     |
| `DiContainer`      | class     |
| `ProviderRegistry` | class     |
| `ScopeManager`     | class     |
| `ContainerConfig`  | interface |
| `DiPluginOptions`  | interface |
| `ExternalResolver` | interface |
| `ProviderEntry`    | interface |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#api-reference-setu-tsdi-plugin).
