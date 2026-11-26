# @setu-ts/messaging-plugin — broker messages

`setu add messaging` wires `MessagingPlugin()`; provides `CAPABILITIES.MESSAGING`
(`IMessageBroker`).

## Publish

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

## Subscribe

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

## Behaviour

- Memory is process-local. Queue-less subscribers each get a copy; shared queues compete. `publish`
  resolves before handlers finish; make consumers idempotent.
- Factories resolve at `onInit`; this example needs `LoggerPlugin`.
- `name` provides `messaging.<name>` instead of the bare token.
- Pub/Sub and Service Bus retry by default; `consumerRetry: false` disables.
- `{ fanOut: true }` requests one copy per instance; verify `subscription.fanOut`.
- Service Bus `publishTimeoutMs`: 15000, 0 unbounded. `maxConcurrentCalls`: 1, integer 1–1000; above
  1 delivery can reorder. Reply inboxes expire after 5 idle minutes; receive outages affect
  readiness.
- RPC timeout answers 504, remote handler failure 502 through `errorHandler`, without remote text.
- Call `outbox.dispatch()` after commit to avoid up to `relay.intervalMs` latency. Full successful
  sweeps continue immediately; saturation warns once, recovery logs at info.

## Other options

- `broker`: memory, redis-streams, rabbitmq, nats, kafka, pubsub, service-bus or custom.
- Custom `instance: ICustomMessageBroker`: optional `publishWithHeaders`/`requestWithHeaders` carry
  tracing; `subscribe` fills `MessageMetadata.headers` and confirms `fanOut`. Missing headers warn
  once. `isHealthy` feeds reachability.
- `request`/`respond`: RPC; `behaviors`: consumers; `outbox`/`inbox`: durability.

<!-- card-allow: LoggerPlugin -->
