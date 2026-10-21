# @setu-ts/di-plugin — optional dependency-injection container

`setu add di` installs the package; no scaffold wires it, so register `DiPlugin()` yourself. It
provides an `IContainer` under `CAPABILITIES.DI_CONTAINER`. The kernel's service registry remains
the primary resolution mechanism — no other plugin requires this container, and `ctx.container` is
`undefined` without it.

```ts
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { DiPlugin } from '@setu-ts/di-plugin';
import { CAPABILITIES, type IContainer } from '@setu-ts/common';

export async function createDiApp() {
  const app = createApplication({
    plugins: [RuntimePlugin(), DiPlugin({ defaultScope: 'singleton', autoRegister: true })],
  });
  await app.start(); // capabilities exist only after start()
  const container = app.services.get<IContainer>(CAPABILITIES.DI_CONTAINER);
  return { app, container };
}
```

```ts
import type { IContainer } from '@setu-ts/common';

class UserService {
  constructor(readonly label: string) {}
}

export function resolveUsers(container: IContainer): UserService {
  container.register('user-service-label', { useValue: 'users' });
  container.register<UserService>(
    'user-service',
    { useClass: UserService, inject: ['user-service-label'] },
    { scope: 'scoped' },
  );
  const scope = container.createScope();
  return scope.resolve<UserService>('user-service');
}
```

- Tokens are strings; the class, factory or value travels in the provider, and the lifecycle in the
  third `register` argument. `ClassProvider` takes `useClass` plus optional `inject` tokens,
  `FactoryProvider` takes `useFactory`, `ValueProvider` takes `useValue`.
- `defaultScope` defaults to `'singleton'`; `'scoped'` means one instance per `createScope` scope
  and `'transient'` a new instance per resolve.
- `autoRegister` defaults to `true` in the plugin: an unknown token falls back to the kernel
  registry and the first success is cached as a singleton. `createContainer` instead defaults it to
  `false`; explicit container registrations always win.
- `createScope` returns a child sharing the parent's singletons with its own scoped cache. The
  framework creates no scope per request, so a `scoped` service is not re-created per HTTP request.
- A dependency cycle throws at resolve with a readable chain, including through factory providers
  calling back into the container.
