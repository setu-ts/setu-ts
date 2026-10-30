# @setu-ts/di-plugin — constructor injection and service scopes

**Add it:** `setu add di` adds it; add `DiPlugin()` to `setu.config.ts` yourself. It provides
`CAPABILITIES.DI_CONTAINER` (`IContainer`).

## Register dependencies and resolve a scoped service per request

```ts
import { CAPABILITIES, createToken } from '@setu-ts/common';
import type { IContainer, IRequestContext } from '@setu-ts/common';

class Greeting {
  constructor(readonly text: string) {}
}
const GREETING = createToken<Greeting>('greeting');
// In a plugin's register(); the container closes after bootstrap.
const container = ctx.services.get<IContainer>(CAPABILITIES.DI_CONTAINER);
container.register('greeting-text', { useValue: 'hello' });
container.register(GREETING, { useClass: Greeting, inject: ['greeting-text'] }, { scope: 'scoped' });
// One Greeting per request, disposed when it finishes.
function greet(request: IRequestContext): Greeting {
  return container.forRequest(request).resolve(GREETING);
}
```

## Behaviour the types do not show

- `defaultScope` defaults to `'singleton'`; `'transient'` creates a new instance on every resolve.
- The graph is validated at boot: a missing dependency, a cycle, or a singleton reaching a scoped
  service (directly or through transients) fails `app.start()` with `ContainerValidationError`.
- Resolving a `'scoped'` token on the root container throws `ScopeRequiredError`; use `forRequest`
  or `createScope`.
- `register` after the container closes throws `ContainerClosedError`. A scope may register new
  tokens but not shadow one its parent has.
- `autoRegister` defaults to `true`: unknown tokens fall back to the service registry, cached as
  singletons.
- `useFactory` receives its `inject` dependencies as arguments; a factory without `inject` is not
  checked at boot.
- `forRequest` needs the kernel's request context; test request scopes with `createTestApp`.

## Other options

- `DiPlugin({ autoRegister: false })` disables fallback to framework capabilities.
- A token is a string, a `createToken` token, or a class; `inject` entries may be
  `{ token, optional: true }`.
- `register`'s third argument takes `scope` and `dispose`; `dispose` releases what the container
  created.
- `createContainer` builds a standalone container, defaults automatic registration to `false`, and
  stays open until `close` on the `DiContainer`.
