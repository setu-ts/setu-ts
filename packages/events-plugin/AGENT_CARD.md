# @setu-ts/events-plugin — in-process domain events

`setu add events` prints `EventsPlugin()` and installs the package; it is zero-configuration. It
registers an `IEventBus` (an `InMemoryEventBus`) under `CAPABILITIES.EVENTS`. For events that cross
a process boundary use `@setu-ts/messaging-plugin` and its `EventsMessagingBridge`.

```ts
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { EventsPlugin } from '@setu-ts/events-plugin';

export function createEventsApp() {
  return createApplication({
    plugins: [RuntimePlugin(), EventsPlugin({ async: false })],
  });
}
```

```ts
import { defineDomainEvent, type IEventBus } from '@setu-ts/events-plugin';
import { type IRuntimeServices } from '@setu-ts/common';

export function createUserCreated(runtime: IRuntimeServices, userId: string) {
  const { DomainEvent } = defineDomainEvent(runtime);
  class UserCreated extends DomainEvent<{ userId: string }> {
    override readonly type = 'user.created';
  }
  return new UserCreated({ userId });
}

export async function announce(
  bus: IEventBus,
  runtime: IRuntimeServices,
  userId: string,
): Promise<void> {
  bus.subscribe<{ userId: string }>('user.created', async (event) => {
    await Promise.resolve(event.data.userId);
  });
  await bus.publish(createUserCreated(runtime, userId));
}
```

- `async` defaults to `false`, so `publish` and `publishBatch` await every handler in order; `true`
  is fire-and-forget. A failing handler never rejects `publish` — errors go to `errorHandler`, which
  defaults to the `logger` capability when present, otherwise a no-op.
- `handlers` is `{ type, handler }[]`; `handler` may be an instance or a factory
  `(services) => handler`, called at `onInit` so it can resolve any capability. Both routes use
  `subscribeHandler`.
- `defineDomainEvent(runtime)` returns `DomainEvent` and `IntegrationEvent` bases bound to the
  runtime clock; subclass and set `type`. `IntegrationEvent` marks cross-service facts; the typed
  wire contract is `defineIntegrationEvent` in `@setu-ts/messaging-plugin`.
- `createDomainEvents()` is an aggregate-local recorder: `record`, `pending` (ordered snapshot),
  `remove` (reference equality, first match, returns `false` when absent) and `clear`. It never
  publishes; dispatch after saving.
- `diagnostics: { enabled: true, alias, events }` opts into the diagnostics connector's
  `GET /v1/event` observations; `events` is an exact type→alias allowlist of at most 64 entries.
