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
| `'kafka'`         | `npm:kafkajs`         | yes¹          |

¹ Kafka needs its reply topic to exist — see below.

## Request-reply

`request()` / `respond()` carry correlation inside a message envelope over each broker's ordinary
`publish`/`subscribe` — **not** transport headers, which the in-memory and Redis brokers do not
populate.

RPC rides a channel derived from the topic, so it never collides with plain pub/sub: a
`subscribe('orders', …)` consumer never sees a request envelope, and a `publish('orders', …)` is
never consumed by a responder on `'orders'`.

Each broker decides what its reply inbox is. The four whose topics are cheap mint a fresh
per-instance one. **Kafka** cannot — a topic there is a durable, partitioned cluster resource — so
it reads a shared `replyTopic` (default `'messaging.replies'`) under a consumer group unique to each
instance:

```typescript
app.register(MessagingPlugin({
  broker: 'kafka',
  brokers: ['localhost:9092'],
  replyTopic: 'orders.replies', // must already exist; the broker creates no topics
}));
```

Every instance reads every reply on that topic and discards the ones it did not originate, so give a
high-traffic service its own `replyTopic` to bound the fan-out.

`RequestTimeoutError` and `RemoteHandlerError` are exported for `instanceof` handling.
`MessagingNotSupportedError` is also still exported but **deprecated** — it existed for the Kafka
broker's former refusal and no broker throws it now.

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
