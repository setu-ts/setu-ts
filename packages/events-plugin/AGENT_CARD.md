# @setu-ts/events-plugin — in-process domain events

**Add it:** `setu add events` installs it and wires `EventsPlugin()` in a recognized functional
config. It provides `CAPABILITIES.EVENTS` (`IEventBus`).

## Publish a domain fact from a route

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IEventBus, IRouterApi, IRuntimeServices } from '@setu-ts/common';
import { defineDomainEvent } from '@setu-ts/events-plugin';

export function registerOrderRoutes(router: IRouterApi): void {
  router.post('/orders/:id/placed', {
    handler: async (ctx) => {
      const { DomainEvent } = defineDomainEvent(ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME));
      class OrderPlaced extends DomainEvent<{ orderId: string }> {
        override readonly type = 'order.placed';
      }
      const bus = ctx.services.get<IEventBus>(CAPABILITIES.EVENTS);
      await bus.publish(new OrderPlaced({ orderId: ctx.params.id! }));
      return ctx.response.json({ ok: true });
    },
  });
}
```

## Register a subscriber in setu.config.ts

```ts
import { EventsPlugin } from '@setu-ts/events-plugin';

export const events = EventsPlugin({
  handlers: [{
    type: 'order.placed',
    handler: { handle: async (event) => { console.log(event.data); } },
  }],
});
```

## Behaviour the types do not show

- Dispatch defaults to `async: false`: handlers run in subscription order and publishing awaits
  them. With `async: true`, publishing does not await completion.
- Handler failures go to `errorHandler`; the default logs when a logger exists and otherwise does
  nothing. A custom error handler can itself throw.
- Domain event IDs and timestamps come from the runtime. Optional aggregate metadata is omitted when
  absent.
- This bus is process-local; a restart loses its subscriptions and there is no message persistence.
- Handler factories in `handlers` resolve at `onInit`, when registered capabilities are available.

## Other options

- `publishBatch` publishes events in array order; `subscribe` returns an unsubscribe function.
- `createDomainEvents` records ordered pending facts locally; it never publishes them.
- `diagnostics` enables observations only for the configured event type allowlist.
