# @hono-enterprise/messaging-plugin

Cross-service messaging. Registers an `IMessageBroker` under `CAPABILITIES.MESSAGING`
(`'messaging'`).

Five brokers ship: `InMemoryBroker` (zero-dependency default), `RedisStreamsBroker`,
`RabbitMqBroker`, `NatsBroker` (JetStream), and `KafkaBroker`. Each client is an **optional**
dependency, lazily imported or injected.

## Installation

```typescript
import { MessagingPlugin } from '@hono-enterprise/messaging-plugin';
```

## Usage

```typescript
import { MessagingPlugin } from '@hono-enterprise/messaging-plugin';
import { CAPABILITIES, type IMessageBroker } from '@hono-enterprise/common';

app.register(MessagingPlugin({ broker: 'rabbitmq', url: 'amqp://localhost:5672' }));

const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);

await broker.subscribe<{ userId: string }>('user.created', async (message, metadata) => {
  await provisionAccount(message.userId);
});

await broker.publish('user.created', { userId: '123' });
```

## Brokers

| `broker`          | Backing client        | Request-reply |
| ----------------- | --------------------- | ------------- |
| `'in-memory'`     | none                  | yes           |
| `'redis-streams'` | `npm:ioredis`         | yes           |
| `'rabbitmq'`      | `npm:amqplib`         | yes           |
| `'nats'`          | NATS JetStream client | yes           |
| `'kafka'`         | `npm:kafkajs`         | **no**        |

## Request-reply

`request()` / `respond()` carry correlation inside a message envelope over each broker's ordinary
`publish`/`subscribe` — **not** transport headers, which the in-memory and Redis brokers do not
populate.

Kafka's consumer-group and auto-commit model does not fit the pattern, so `KafkaBroker.request` and
`.respond` throw the exported `MessagingNotSupportedError`. `RequestTimeoutError` and
`RemoteHandlerError` are also exported for `instanceof` handling.

## Bridging in-process events

`EventsMessagingBridge` forwards selected events from
[`@hono-enterprise/events-plugin`](https://github.com/dkpaul91/hono-enterprise/tree/main/packages/events-plugin)
onto the broker:

```typescript
app.register(EventsMessagingBridge({ eventTypes: ['user.created', 'user.updated'] }));
```

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/dkpaul91/hono-enterprise/blob/main/PUBLIC_API.md).
