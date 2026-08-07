# @setu-ts/events-plugin

In-process domain events. Registers an `IEventBus` under `CAPABILITIES.EVENTS` (`'events'`), backed
by `InMemoryEventBus`.

For events that must cross a process boundary, use
[`@setu-ts/messaging-plugin`](https://github.com/setu-ts/setu-ts/tree/main/packages/messaging-plugin)
— or bridge the two with its `EventsMessagingBridge`.

## Installation

```typescript
import { EventsPlugin } from '@setu-ts/events-plugin';
```

## Usage

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { defineDomainEvent, EventsPlugin } from '@setu-ts/events-plugin';
import { CAPABILITIES, type IEventBus, type IRuntimeServices } from '@setu-ts/common';

const app = createApplication({
  plugins: [RuntimePlugin(), EventsPlugin()],
});
await app.start({ port: 3000 });

// Bind the event bases to the runtime once, then subclass them.
const runtime = app.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
const { DomainEvent } = defineDomainEvent(runtime);

class UserCreated extends DomainEvent<{ userId: string }> {
  override readonly type = 'user.created';
}

const bus = app.services.get<IEventBus>(CAPABILITIES.EVENTS);
bus.subscribe<{ userId: string }>('user.created', async (event) => {
  await welcome(event.data.userId);
});

await bus.publish(new UserCreated({ userId: '123' }));
await bus.publishBatch([new UserCreated({ userId: '124' }), new UserCreated({ userId: '125' })]);
```

## Options

| Option         | Type                                            | Default   | Description                                                              |
| -------------- | ----------------------------------------------- | --------- | ------------------------------------------------------------------------ |
| `async`        | `boolean`                                       | `false`   | `false` awaits all handlers before resolving; `true` is fire-and-forget. |
| `errorHandler` | `(error: unknown, event: IDomainEvent) => void` | see below | Where handler failures go.                                               |

`errorHandler` defaults to logging through the optional `logger` capability when one is registered,
otherwise a no-op. **A failing handler never makes `publish` reject** in either dispatch mode.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md).
