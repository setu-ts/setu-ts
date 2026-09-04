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
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MessagingPlugin } from '@setu-ts/messaging-plugin';
import { CAPABILITIES, type IMessageBroker } from '@setu-ts/common';

// Your application's own work — a stand-in so this example compiles as written.
declare function provisionAccount(userId: string): Promise<void>;

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    MessagingPlugin({ broker: 'rabbitmq', url: 'amqp://localhost:5672' }),
  ],
});

// Plugins register during `start()`, so the capability is resolvable only after it.
await app.start({ port: 3000 });

const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);

await broker.subscribe<{ userId: string }>('user.created', async (message) => {
  await provisionAccount(message.userId);
});

await broker.publish('user.created', { userId: '123' });
```

## Publish timing

`publish` resolves once every matching subscription's work item has been **handed to dispatch** —
never once every handler has returned. This is the guarantee real brokers give (a RabbitMQ or Redis
`publish` returns before delivery), so the in-memory default honours it too, and a plugin that
publishes during its own `register()` cannot deadlock startup against the behaviour-chain gate. A
handler that rejects never rejects the publish and never surfaces as an unhandled rejection: on the
in-memory broker — which has no ack model and no redelivery — the failure path terminates in a
report through the application's logger. An application constructing `InMemoryBroker` directly
supplies its own reporter via `InMemoryBrokerOptions.onDispatchError`; absent one the rejection is
observed and dropped. One slow or throwing fan-out handler also no longer delays or aborts delivery
to its siblings.

## Options

`MessagingPluginOptions` is a union discriminated on `broker`. Two options are shared by every arm:

| Option                | Type                                                                 | Default          | Description                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | -------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `broker`              | `MessagingBrokerType`                                                | `'memory'`       | Selects the arm. Optional only on the memory arm, so `MessagingPlugin()` stays valid.                                                                                                                                                                                                                                                                                          |
| `name`                | `string`                                                             | —                | Instance name for multi-instance setups.                                                                                                                                                                                                                                                                                                                                       |
| `serializer`          | `ISerializer`                                                        | `JsonSerializer` | Payload serializer.                                                                                                                                                                                                                                                                                                                                                            |
| `tracing`             | `boolean`                                                            | `true`           | Create broker producer/consumer spans when telemetry is registered.                                                                                                                                                                                                                                                                                                            |
| `chainReadyTimeoutMs` | `number`                                                             | `10_000`         | Bounds a dispatch held on the behaviour-chain gate (armed only when a `behaviors` FACTORY is declared). A held dispatch past the bound rejects with `ChainGateTimeoutError`; `0` waits forever. Must be a finite, non-negative number — `NaN`, a negative value, or `Infinity` throws a `RangeError` naming the option at registration. Ignored when no factory is configured. |
| `subscriptions`       | `readonly SubscriptionEntry[]`                                       | —                | Declarative `subscribe()` registrations. A `SubscriptionDefinition` is `{ topic, handler, options? }`; factories resolve during async `onInit`. When a `behaviors` factory is declared, delivery is held until `onInit` has resolved the chain.                                                                                                                                |
| `behaviors`           | `readonly (IIngressBehavior \| RegistryFactory<IIngressBehavior>)[]` | —                | Chain around subscribe handlers. It sees `kind: 'messaging'`, topic, message payload, and available headers; no delivery attempt is fabricated.                                                                                                                                                                                                                                |

Omitting `name` registers under the bare `CAPABILITIES.MESSAGING` token as plugin
`messaging-plugin`. Supplying one derives both — token `messaging.<name>`, plugin
`messaging-plugin.<name>` — so several brokers can coexist in one application.

Every other option is arm-specific — `url`/`client` for `'redis-streams'`, credentials for the cloud
arms, an injected `IMessageBroker` for `'custom'`. A missing per-arm field is a compile error rather
than a startup throw. See [Brokers](#brokers) for the full arm list.

Declare subscriptions where the plugin is composed, instead of resolving the broker after `start()`:

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MessagingPlugin } from '@setu-ts/messaging-plugin';
import type { IIngressBehavior } from '@setu-ts/common';

/** Runs ahead of every subscribe handler; `next()` continues the chain. */
const auditEveryMessage: IIngressBehavior = {
  handle: (ctx, next) => {
    console.log(`${ctx.kind} ${ctx.name}`, ctx.headers ?? {});
    return next();
  },
};

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    MessagingPlugin({
      broker: 'memory',
      behaviors: [auditEveryMessage],
      subscriptions: [
        {
          topic: 'orders',
          handler: (message) => {
            console.log('order received', message);
          },
        },
      ],
    }),
  ],
});

// Declared subscriptions are established during startup, so nothing is
// subscribed until now.
await app.start({ port: 3000 });
```

The behaviour chain wraps `subscribe()` handlers only. `respond()` remains unwrapped and has no
registration arm: its request handler returns a value, unlike the void-returning subscription
handler. With no behaviours configured, no `PipelinedBroker` decorator is applied.

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
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MessagingPlugin } from '@setu-ts/messaging-plugin';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    MessagingPlugin({
      broker: 'kafka',
      brokers: ['localhost:9092'],
      replyTopic: 'orders.replies', // must already exist; the broker creates no topics
    }),
  ],
});
```

Every instance reads every reply on that topic and discards the ones it did not originate, so give a
high-traffic service its own `replyTopic` to bound the fan-out.

`RequestTimeoutError` and `RemoteHandlerError` are exported for `instanceof` handling.
`MessagingNotSupportedError` is also still exported but **deprecated** — it existed for the Kafka
broker's former refusal and no broker throws it now.

## Trace propagation

With `TelemetryPlugin` registered and tracing enabled, every first-party broker sends W3C
`traceparent` with published messages and reads it on delivery. The plugin creates `publish <topic>`
producer and `receive <topic>` consumer spans. `MessageMetadata.headers` is always an object for the
first-party transports (`{}` when the message has no headers); custom brokers retain their own
metadata behavior. An injected NATS client must supply `headersFactory` to construct NATS headers.

## Bridging in-process events

`EventsMessagingBridge` forwards selected events from
[`@setu-ts/events-plugin`](https://github.com/setu-ts/setu-ts/tree/main/packages/events-plugin) onto
the broker:

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { EventsMessagingBridge, MessagingPlugin } from '@setu-ts/messaging-plugin';
import { EventsPlugin } from '@setu-ts/events-plugin';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    EventsPlugin(),
    MessagingPlugin({ broker: 'memory' }),
    EventsMessagingBridge({ eventTypes: ['user.created', 'user.updated'] }),
  ],
});
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
| `ChainGateTimeoutError`        | class     |
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
| `INatsHeaders`                 | interface |
| `InMemoryBrokerOptions`        | interface |
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
| `SubscriptionDefinition`       | interface |
| `MessageHandler`               | type      |
| `MessagingBrokerType`          | type      |
| `MessagingPluginOptions`       | type      |
| `PubSubMessagingOptions`       | type      |
| `RequestHandler`               | type      |
| `ServiceBusMessagingOptions`   | type      |
| `SubscriptionEntry`            | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#messaging-setu-tsmessaging-plugin).
