# @setu-ts/messaging-plugin — publish and consume broker messages

**Add it:** `setu add messaging` adds it and wires `MessagingPlugin()` in a recognized functional
config. It provides `CAPABILITIES.MESSAGING` (`IMessageBroker`).

## Publish an order from a route

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IMessageBroker, IRouterApi } from '@setu-ts/common';

export function registerOrderRoutes(router: IRouterApi): void {
  router.post('/orders/:id/placed', {
    handler: async (ctx) => {
      const broker = ctx.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
      await broker.publish('orders.placed', { orderId: ctx.params.id! });
      return ctx.response.status(202).json({ accepted: true });
    },
  });
}
```

## Subscribe in setu.config.ts

```ts
import { MessagingPlugin } from '@setu-ts/messaging-plugin';
import { CAPABILITIES } from '@setu-ts/common';
import type { ILogger } from '@setu-ts/common';

export const messaging = MessagingPlugin({
  subscriptions: [(services) => ({
    topic: 'orders.placed',
    options: { queue: 'billing' },
    handler: async (message) => {
      services.get<ILogger>(CAPABILITIES.LOGGER).info('Order received', { message });
    },
  })],
});
```

## Behaviour the types do not show

- Memory is the default broker: messages and subscriptions do not survive a restart.
- In memory, subscribers without a queue all receive a copy; subscribers sharing a queue receive one
  copy per group, selected round-robin.
- Memory `publish` resolves on dispatch hand-off, before handlers finish. Handler failures go to the
  logger when available and never reject that publish. Make consumers idempotent.
- Subscription factories resolve at `onInit`, after capabilities are registered. The example's
  `CAPABILITIES.LOGGER` needs `LoggerPlugin` (every template registers it).
- `name` registers a named capability such as `messaging.orders`, replacing the bare token for that
  instance.

## Other options

- `broker` also selects `'redis-streams'`, `'rabbitmq'`, `'nats'`, `'kafka'`, `'pubsub'`,
  `'service-bus'` or `'custom'` with `instance`.
- `request` and `respond` provide request/reply; `behaviors` wraps incoming handlers.
- `defineIntegrationEvent`, `publishIntegrationEvent` and `onIntegrationEvent` add versioned
  contracts; `outbox` and `inbox` configure durable publication and consumer deduplication.

<!-- card-allow: LoggerPlugin -->
