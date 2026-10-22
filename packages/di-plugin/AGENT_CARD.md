# @setu-ts/di-plugin — constructor injection and service scopes

**Add it:** `setu add di` installs it; add `DiPlugin()` to `setu.config.ts` yourself. It provides
`CAPABILITIES.DI_CONTAINER` (`IContainer`).

## Register dependencies and resolve a scoped service

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IContainer } from '@setu-ts/common';

class Greeting {
  constructor(readonly text: string) {}
}
const container = ctx.services.get<IContainer>(CAPABILITIES.DI_CONTAINER);
container.register('greeting-text', { useValue: 'hello' });
container.register<Greeting>('greeting', {
  useClass: Greeting, inject: ['greeting-text'],
}, { scope: 'scoped' });
const scope = container.createScope();
const greeting = scope.resolve<Greeting>('greeting');
```

## Behaviour the types do not show

- `defaultScope` defaults to `'singleton'`; `'transient'` creates a new instance on every resolve.
- A child from `createScope` shares parent singletons but has its own scoped instance cache. The
  container does not automatically create an HTTP request scope.
- The plugin defaults `autoRegister` to `true`: unknown tokens fall back to the service registry,
  and successful results are cached as singletons. Explicit registrations take precedence.
- Missing providers and circular dependencies throw; resolution does not silently return an absent
  value.
- A factory provider's `useFactory` is called without arguments; use a closure for dependencies.

## Other options

- `DiPlugin({ autoRegister: false })` disables fallback to framework capabilities.
- `register` accepts `useValue`, `useClass` with `inject`, or `useFactory`; scope is its third
  argument.
- `createContainer` builds a standalone container and defaults automatic registration to `false`.
