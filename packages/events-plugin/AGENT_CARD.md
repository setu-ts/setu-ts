# @setu-ts/events-plugin — in-process domain events

**Add it:** `setu add events` adds it and wires `EventsPlugin()` in a recognized functional config.
It provides `CAPABILITIES.EVENTS` (`IEventBus`).

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
        override readonly type = 'OrderPlaced';
      }
      const bus = ctx.services.get<IEventBus>(CAPABILITIES.EVENTS);
      await bus.publish(new OrderPlaced({ orderId: ctx.params.id! }));
      return ctx.response.json({ ok: true });
    },
  });
}
```

## Handle the event

`setu g event-handler order-placed` writes `src/events/order-placed.event-handler.ts` and wires it
into `EventsPlugin({ handlers: EVENT_HANDLERS })`; fill in its `handle`:

```ts
import type { IDomainEvent } from '@setu-ts/common';
import type { IEventHandler } from '@setu-ts/events-plugin';

export const ORDER_PLACED_EVENT = 'OrderPlaced';

export let ordersPlaced = 0;

export class OrderPlacedEventHandler implements IEventHandler<{ orderId: string }> {
  async handle(_event: IDomainEvent<{ orderId: string }>): Promise<void> {
    ordersPlaced += 1;
  }
}

export function createOrderPlacedEventHandler(): OrderPlacedEventHandler {
  return new OrderPlacedEventHandler();
}
```

## Behaviour the types do not show

- Dispatch defaults to `async: false`: handlers run in subscription order and publishing awaits
  them. With `async: true`, publishing does not await completion.
- Handler failures go to `errorHandler`, which by default logs when a logger exists.
- This bus is process-local; a restart loses its subscriptions and there is no message persistence.
- State a route reads back can live in a module both files import. A handler factory may take
  `services`; factories resolve at `onInit`, when capabilities are registered.

## Other options

- `publishBatch` publishes events in array order; `subscribe` returns an unsubscribe function.
- `createDomainEvents` records ordered pending facts locally; it never publishes them.
- `diagnostics` enables observations only for the configured event type allowlist.
