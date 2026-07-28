# @hono-enterprise/di-plugin

Optional dependency-injection container. Registers an `IContainer` under `CAPABILITIES.DI_CONTAINER`
(`'di-container'`).

Supports singleton, scoped, and transient lifecycles, constructor injection, class/factory/value
providers, circular-dependency detection, hierarchical scopes, and an optional fallback to the
kernel's `ServiceRegistry`.

The framework does not require this package — the kernel's service registry is enough for most
applications. Reach for the container when you want constructor injection and per-request scopes.

## Installation

```typescript
import { DiPlugin } from '@hono-enterprise/di-plugin';
```

## Usage

```typescript
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { createContainer, DiPlugin } from '@hono-enterprise/di-plugin';
import { CAPABILITIES } from '@hono-enterprise/common';

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

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/dkpaul91/hono-enterprise/blob/main/PUBLIC_API.md).
