# @setu-ts/messaging-plugin — cross-service brokers and integration events

`setu add messaging` installs it and, in a recognized functional config, registers
`MessagingPlugin()`; otherwise add that line in `setu.config.ts`. The default broker is in-memory;
`CAPABILITIES.MESSAGING` resolves only after `app.start`.

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IMessageBroker } from '@setu-ts/common';
import { MessagingPlugin } from '@setu-ts/messaging-plugin';

app.register(MessagingPlugin());

await app.start();
const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
await broker.publish('orders.placed', { orderId: 'o-1' });
```

Integration events add a versioned envelope:

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { IMessageBroker, IRuntimeServices } from '@setu-ts/common';
import {
  defineIntegrationEvent,
  onIntegrationEvent,
  publishIntegrationEvent,
} from '@setu-ts/messaging-plugin';

const orderPlaced = defineIntegrationEvent<{ orderId: string }>({
  type: 'orders.placed',
  version: 1,
  topic: 'orders.placed.v1', // must end with `.v${version}`
  parse: (value) => {
    if (typeof (value as { orderId?: unknown }).orderId !== 'string') throw new TypeError('bad');
    return value as { orderId: string };
  },
});

await app.start();
const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
const runtime = app.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
const d = onIntegrationEvent(orderPlaced, async (payload) => void payload.orderId);
await broker.subscribe(d.topic, d.handler);
await publishIntegrationEvent(runtime, broker, orderPlaced, { orderId: 'o-1' });
```

- `publish` resolves when delivery is handed to dispatch, not when handlers finish; a throwing
  handler is logged, never rethrown. Handlers must be idempotent.
- `broker` selects `'memory'` (default), `'redis-streams'`, `'rabbitmq'`, `'nats'`, `'kafka'`,
  `'pubsub'`, `'service-bus'` or `'custom'` (`instance`). `name` registers token `messaging.<name>`
  and plugin `messaging-plugin.<name>`.
- `broker.subscribe` takes a topic, handler and `{queue}`. `broker.publish` accepts `orderingKey`,
  `deduplicationId` and `headers`; invalid values reject with RangeError.
- `parse` runs only on the consumer; a malformed envelope becomes `IntegrationEventRejectedError`
  and is not retried. Delivered headers are hints, not authorization.
- Also exported: outbox, inbox, `broker.request`/`broker.respond`, `EventsMessagingBridge`; see
  README.
