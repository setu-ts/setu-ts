# @setu-ts/messaging-plugin

Cross-service messaging. Registers an `IMessageBroker` under `CAPABILITIES.MESSAGING`
(`'messaging'`).

Eight brokers ship: `InMemoryBroker` (zero-dependency default), `RedisStreamsBroker`,
`RabbitMqBroker`, `NatsBroker` (JetStream), `KafkaBroker`, `GcpPubSubBroker`
(`npm:@google-cloud/pubsub`), `ServiceBusBroker` (`npm:@azure/service-bus`), and a custom-injected
arm. Each cloud client is an **optional** dependency, lazily imported or injected.

## Installation

```typescript
import { MessagingPlugin } from '@setu-ts/messaging-plugin';
```

## Usage

```typescript
import { MessagingPlugin } from '@setu-ts/messaging-plugin';
import { CAPABILITIES, type IMessageBroker } from '@setu-ts/common';

app.register(MessagingPlugin({ broker: 'rabbitmq', url: 'amqp://localhost:5672' }));

const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);

await broker.subscribe<{ userId: string }>('user.created', async (message, metadata) => {
  await provisionAccount(message.userId);
});

await broker.publish('user.created', { userId: '123' });
```

## Options

`MessagingPluginOptions` is a union discriminated on `broker`. Two options are shared by every arm:

| Option       | Type                  | Default          | Description                                                                           |
| ------------ | --------------------- | ---------------- | ------------------------------------------------------------------------------------- |
| `broker`     | `MessagingBrokerType` | `'memory'`       | Selects the arm. Optional only on the memory arm, so `MessagingPlugin()` stays valid. |
| `name`       | `string`              | —                | Instance name for multi-instance setups.                                              |
| `serializer` | `ISerializer`         | `JsonSerializer` | Payload serializer.                                                                   |

Omitting `name` registers under the bare `CAPABILITIES.MESSAGING` token as plugin
`messaging-plugin`. Supplying one derives both — token `messaging.<name>`, plugin
`messaging-plugin.<name>` — so several brokers can coexist in one application.

Every other option is arm-specific — `url`/`client` for `'redis-streams'`, credentials for the cloud
arms, an injected `IMessageBroker` for `'custom'`. A missing per-arm field is a compile error rather
than a startup throw. See [Brokers](#brokers) for the full arm list.

## Brokers

| `broker`          | Backing client             | Request-reply |
| ----------------- | -------------------------- | ------------- |
| `'memory'`        | none                       | yes           |
| `'redis-streams'` | `npm:ioredis`              | yes           |
| `'rabbitmq'`      | `npm:amqplib`              | yes           |
| `'nats'`          | NATS JetStream client      | yes           |
| `'kafka'`         | `npm:kafkajs`              | yes¹          |
| `'pubsub'`        | `npm:@google-cloud/pubsub` | yes²          |
| `'service-bus'`   | `npm:@azure/service-bus`   | yes²          |
| `'custom'`        | injected `IMessageBroker`  | yes³          |

¹ Kafka needs its reply topic to exist — see below. ² Cloud brokers need their reply topic to
pre-exist (GCP) or require `Manage` right for admin (Azure). ³ Custom brokers carry whatever RPC
capability their adapter provides.

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
[`@setu-ts/events-plugin`](https://github.com/setu-ts/setu-ts/tree/main/packages/events-plugin) onto
the broker:

```typescript
app.register(EventsMessagingBridge({ eventTypes: ['user.created', 'user.updated'] }));
```

## Health indicator

Registered under the broker's capability token. Since M70c it reports two signals: the broker's
lifecycle (`isReady()`) and its reachability. A ready-but-unreachable broker is `down` with
`data.reachable: false` — the distinction an operator needs to tell "we never started" from "the
broker restarted under us". An unprobeable broker (e.g. the `custom` arm without `isHealthy`) is
`up` with `data.reachable: 'unknown'`, honestly reporting "we did not check".

| Status | Meaning                                                                                  |
| ------ | ---------------------------------------------------------------------------------------- |
| `up`   | The broker is connected and reachable, or cannot be probed (`reachable` is `'unknown'`). |
| `down` | The broker is not connected, or is connected but unreachable.                            |

`data` reports `{ broker, reachable }`, where `reachable` is `true`, `false`, or `'unknown'`.

## Exports

| Export                         | Kind      |
| ------------------------------ | --------- |
| `adaptPubSubModule`            | function  |
| `adaptServiceBusModule`        | function  |
| `EventsMessagingBridge`        | function  |
| `loadPubSubModule`             | function  |
| `loadServiceBusModule`         | function  |
| `MessagingPlugin`              | function  |
| `CloudBrokerUnavailableError`  | class     |
| `GcpPubSubBroker`              | class     |
| `InMemoryBroker`               | class     |
| `JsonSerializer`               | class     |
| `KafkaBroker`                  | class     |
| `MessagingNotSupportedError`   | class     |
| `NatsBroker`                   | class     |
| `RabbitMqBroker`               | class     |
| `RedisStreamsBroker`           | class     |
| `RemoteHandlerError`           | class     |
| `ReplyInboxUnavailableError`   | class     |
| `RequestTimeoutError`          | class     |
| `ServiceBusBroker`             | class     |
| `CustomMessagingOptions`       | interface |
| `EventsMessagingBridgeOptions` | interface |
| `IMessageBroker`               | interface |
| `IPubSubSubscription`          | interface |
| `IPubSubTransport`             | interface |
| `ISerializer`                  | interface |
| `IServiceBusProcessErrorArgs`  | interface |
| `IServiceBusReceiver`          | interface |
| `IServiceBusSubscribeOptions`  | interface |
| `IServiceBusSubscription`      | interface |
| `IServiceBusTransport`         | interface |
| `ISubscription`                | interface |
| `KafkaMessagingOptions`        | interface |
| `KafkaOptions`                 | interface |
| `MemoryMessagingOptions`       | interface |
| `MessageMetadata`              | interface |
| `MessagingCommonOptions`       | interface |
| `NatsMessagingOptions`         | interface |
| `NatsOptions`                  | interface |
| `PubSubOptions`                | interface |
| `PubSubSdkModule`              | interface |
| `RabbitMqMessagingOptions`     | interface |
| `RabbitMqOptions`              | interface |
| `RedisStreamsMessagingOptions` | interface |
| `RedisStreamsOptions`          | interface |
| `RequestOptions`               | interface |
| `ServiceBusOptions`            | interface |
| `ServiceBusSdkModule`          | interface |
| `SubscribeOptions`             | interface |
| `MessageHandler`               | type      |
| `MessagingBrokerType`          | type      |
| `MessagingPluginOptions`       | type      |
| `PubSubMessagingOptions`       | type      |
| `RequestHandler`               | type      |
| `ServiceBusMessagingOptions`   | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#messaging-setu-tsmessaging-plugin).
