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

| Option                | Type                                                                 | Default          | Description                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | -------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `broker`              | `MessagingBrokerType`                                                | `'memory'`       | Selects the arm. Optional only on the memory arm, so `MessagingPlugin()` stays valid.                                                                                                                                                                                                                                                                                                                                      |
| `name`                | `string`                                                             | —                | Instance name for multi-instance setups.                                                                                                                                                                                                                                                                                                                                                                                   |
| `serializer`          | `ISerializer`                                                        | `JsonSerializer` | Payload serializer.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `tracing`             | `boolean`                                                            | `true`           | Create broker producer/consumer spans when telemetry is registered.                                                                                                                                                                                                                                                                                                                                                        |
| `chainReadyTimeoutMs` | `number`                                                             | `10_000`         | Bounds a dispatch held on the behaviour-chain gate (armed only when a `behaviors` FACTORY is declared). A held dispatch past the bound rejects with `ChainGateTimeoutError`; `0` waits forever. Must be finite, non-negative, and no greater than `2_147_483_647` — `NaN`, a negative value, `Infinity`, or a larger value throws a `RangeError` naming the option at registration. Ignored when no factory is configured. |
| `subscriptions`       | `readonly SubscriptionEntry[]`                                       | —                | Declarative `subscribe()` registrations. A `SubscriptionDefinition` is `{ topic, handler, options? }`; factories resolve during async `onInit`. When a `behaviors` factory is declared, delivery is held until `onInit` has resolved the chain.                                                                                                                                                                            |
| `behaviors`           | `readonly (IIngressBehavior \| RegistryFactory<IIngressBehavior>)[]` | —                | Chain around subscribe handlers. It sees `kind: 'messaging'`, topic, message payload, and available headers; no delivery attempt is fabricated.                                                                                                                                                                                                                                                                            |

Omitting `name` registers under the bare `CAPABILITIES.MESSAGING` token as plugin
`messaging-plugin`. Supplying one derives both — token `messaging.<name>`, plugin
`messaging-plugin.<name>` — so several brokers can coexist in one application.

Every other option is arm-specific — `url`/`client` for `'redis-streams'`, credentials for the cloud
arms, an injected `IMessageBroker` for `'custom'`. A missing per-arm field is a compile error rather
than a startup throw. See [Brokers](#brokers) for the full arm list.

Broker-specific `logger` options are string sinks (`{ error: (message: string) => void }`). Broker
failures are rendered into that message with the error name, message, safe classifier fields, cause
chain, and bounded aggregate members; the sink never receives a driver object directly.

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

| `broker`          | Backing client             | Request-reply | Driven against a real backend in CI |
| ----------------- | -------------------------- | ------------- | ----------------------------------- |
| `'memory'`        | none                       | yes           | — (in-process; no backend)          |
| `'redis-streams'` | `npm:ioredis`              | yes           | yes — Redis 7 (`redis-real` suites) |
| `'rabbitmq'`      | `npm:amqplib`              | yes           | yes — RabbitMQ 4 (outage suite)     |
| `'nats'`          | NATS JetStream client      | yes           | yes — `nats:2-alpine -js` (M90d)    |
| `'kafka'`         | `npm:kafkajs`              | yes¹          | yes — `apache/kafka:4.0.0` (M90d)   |
| `'pubsub'`        | `npm:@google-cloud/pubsub` | yes²          | no — emulator suite is local-only   |
| `'service-bus'`   | `npm:@azure/service-bus`   | yes²          | no — emulator suite is local-only   |
| `'custom'`        | injected `IMessageBroker`  | yes³          | — (whatever the adapter provides)   |

¹ Kafka needs its reply topic to exist — see below. ² Cloud brokers need their reply topic to
pre-exist (GCP) or require `Manage` right for admin (Azure). ³ Custom brokers carry whatever RPC
capability their adapter provides.

"Supported" for `'nats'` and `'kafka'` meant "shipped" for four releases while neither could start
against its real backend — both were driven for the first time in M90d, which is why the column
above is stated per broker rather than left implied.

### NATS prerequisites

The nats broker **requires a JetStream-enabled server** — start it with the `-js` flag (or set
`jetstream` in its configuration). `connect()` fails with a named error rather than a bare platform
code:

- `JetStreamUnavailableError` — the server has no JetStream; the raw `503` the server answered is
  carried as the error's `cause`.
- `JetStreamStreamError` — the configured `streamName` does not exist on the server and no
  `streamSubjects` was supplied (the message names both remedies: create the stream out of band, or
  supply `streamSubjects`), or the server refused the stream read/create (the platform error is
  carried as `cause`).

The broker never creates a stream with a catch-all subject: NATS refuses `subjects: ['>']` without
`no_ack`, and `no_ack` makes every JetStream publish reject unobserved. Supply explicit subjects
when you want the broker to create the stream:

```typescript
import { MessagingPlugin } from '@setu-ts/messaging-plugin';

MessagingPlugin({
  broker: 'nats',
  streamSubjects: ['orders.>', 'billing.>'], // used only when the stream is absent
});
```

An existing stream is never touched, with or without `streamSubjects`.

### Kafka consumer groups

When `queue` is not supplied, each subscription's consumer group is derived per topic —
`<defaultQueue>:<topic>` — because members of one Kafka group must subscribe the same topics: shared
groups collapse to empty assignments and stop delivering entirely. A caller-supplied `queue` names
the group itself, so competing consumers of one topic keep load-balancing.

The separator is a colon rather than a hyphen so the derivation cannot collide. A Kafka topic name
may not contain `:` (the broker refuses one at creation), while a group id may, so the
`(defaultQueue, topic)` pair is recoverable by splitting at the last colon. With a hyphen,
`defaultQueue: 'orders-eu'` + topic `created` and `defaultQueue: 'orders'` + topic `eu-created` both
produce `orders-eu-created`, putting two differently-subscribed consumers into one group and
restoring the empty-assignment failure this derivation exists to prevent.

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

## Message identity

Every first-party broker populates `MessageMetadata.messageId` and `.timestamp` from what its
transport actually assigns — read the delivered metadata, not a per-broker guess:

| `broker`          | `messageId`                                  | `timestamp`                                |
| ----------------- | -------------------------------------------- | ------------------------------------------ |
| `'memory'`        | `runtime.uuid()`                             | publish time (`runtime.now()`)             |
| `'redis-streams'` | stream entry id                              | entry timestamp                            |
| `'rabbitmq'`      | `properties.messageId` / assigned on publish | `properties.timestamp`                     |
| `'nats'`          | JetStream stream sequence                    | `info.timestampNanos` (server assign time) |
| `'kafka'`         | `partition:offset`                           | record timestamp                           |
| `'pubsub'`        | platform `message.id`                        | platform `message.publishTime`             |
| `'service-bus'`   | platform `message.messageId`                 | platform `message.enqueuedTimeUtc`         |

An absent member means the transport carried none — never "the adapter did not look" (M90d / X28-4
closed the two cloud brokers that were not reading what their platforms assign). A consumer reading
`metadata.messageId` for de-duplication on an at-least-once transport gets a value on every
first-party broker.

## Integration events

The transport primitives above carry any payload; an integration event is the **contract** layer on
top of them. `defineIntegrationEvent` names an event, versions it, and pairs it with a parser;
`publishIntegrationEvent` and `onIntegrationEvent` put a portable envelope on the wire and take it
off again. No `IMessageBroker` method changes, no broker adapter is rewritten, and no capability
token is added: the envelope is **payload data**, the whole `message` argument to `publish`, because
payload is the one channel every broker arm carries while headers are not universally available.

The envelope's fields:

| Field              | Type        | Present always? | Meaning                                                          |
| ------------------ | ----------- | --------------- | ---------------------------------------------------------------- |
| `id`               | `string`    | yes             | Producer-assigned event identity (`runtime.uuid()`)              |
| `type`             | `string`    | yes             | The contract's semantic event name                               |
| `version`          | `number`    | yes             | The contract version                                             |
| `occurredAt`       | `string`    | yes             | Publish time, ISO-8601 (`new Date(runtime.now()).toISOString()`) |
| `data`             | the payload | yes             | The event payload, carried verbatim                              |
| `correlationId`    | `string`    | optional        | ID of the causal chain root                                      |
| `causationId`      | `string`    | optional        | ID of the directly causing event                                 |
| `aggregateId`      | `string`    | optional        | ID of the aggregate the event concerns                           |
| `aggregateVersion` | `number`    | optional        | Version of the aggregate the event concerns                      |

`occurredAt` is an ISO-8601 **string**, not a `Date`: a payload round-trips through the serializer's
`JSON.parse` on every transport, so a `Date` would arrive at the consumer as a string regardless of
what the producer put in. The string is the honest type.

One definition serves both directions — the producer reads its `type`/`version`/`topic`, the
consumer the same three plus `parse`:

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { LoggerPlugin } from '@setu-ts/logger-plugin';
import {
  defineIntegrationEvent,
  MessagingPlugin,
  onIntegrationEvent,
  publishIntegrationEvent,
} from '@setu-ts/messaging-plugin';
import { CAPABILITIES, type IMessageBroker, type IRuntimeServices } from '@setu-ts/common';

// Your application's own work — a stand-in so this example compiles as written.
declare function provisionOrder(orderId: string): Promise<void>;

const orderPlaced = defineIntegrationEvent<{ orderId: string }>({
  type: 'orders.placed',
  version: 1,
  topic: 'orders.placed.v1', // MUST end with `.v${version}` — enforced at definition time
  parse: (value) => value as { orderId: string },
});

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    LoggerPlugin(),
    MessagingPlugin({
      subscriptions: [
        // Consumer: the handler receives the PARSED payload, the envelope, and
        // the transport metadata. A malformed envelope never reaches it.
        onIntegrationEvent(orderPlaced, async (payload) => {
          await provisionOrder(payload.orderId);
        }, { queue: 'billing' }),
      ],
    }),
  ],
});

await app.start();

const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
const runtime = app.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);

await publishIntegrationEvent(runtime, broker, orderPlaced, { orderId: '123' });
```

### Correlation propagation

A handler that publishes the next event derives the causal fields from the envelope it was handed —
`causedBy` is the whole chain-root rule, extracted so no handler copies it by hand. This is an
application-level causal chain carried in the payload; it is a different thing from the W3C
`traceparent` the telemetry layer propagates in transport headers (see
[Trace propagation](#trace-propagation)), and neither replaces the other.

```typescript
import {
  causedBy,
  defineIntegrationEvent,
  publishIntegrationEvent,
} from '@setu-ts/messaging-plugin';
import type { IntegrationEventEnvelope } from '@setu-ts/messaging-plugin';
import { CAPABILITIES, type IMessageBroker, type IRuntimeServices } from '@setu-ts/common';

const orderCharged = defineIntegrationEvent<{ orderId: string }>({
  type: 'orders.charged',
  version: 1,
  topic: 'orders.charged.v1',
  parse: (value) => value as { orderId: string },
});

// Inside a handler: the consumed envelope's correlationId (or its own id,
// when it is the chain root) plus its id as the direct cause.
async function charge(
  runtime: IRuntimeServices,
  broker: IMessageBroker,
  consumed: IntegrationEventEnvelope<{ orderId: string }>,
): Promise<void> {
  await publishIntegrationEvent(runtime, broker, orderCharged, consumed.data, {
    ...causedBy(consumed),
  });
}

declare const runtime: IRuntimeServices;
declare const broker: IMessageBroker;
declare const consumed: IntegrationEventEnvelope<{ orderId: string }>;
await charge(runtime, broker, consumed);
```

### The versioned-topic rollout policy

Each incompatible version owns a **distinct topic** whose name ends in `.v<version>`, and the
factory enforces this rather than documenting it: `defineIntegrationEvent` refuses a `topic` that
does not end with the exact string `.v${version}`, at definition time — at module load, loudly, with
the expected suffix named. A version bump with an unchanged topic is precisely the change that
breaks every deployed consumer, and no type checker can see it.

Consumers subscribe explicitly to every version they support, one definition per topic, so they
never receive and reject an unsupported version from a shared topic. A producer rolls forward by
**dual-publishing** both topics until every required consumer has deployed onto the new one, then
stops the old publication after the agreed migration window:

```typescript
import { defineIntegrationEvent, publishIntegrationEvent } from '@setu-ts/messaging-plugin';
import { CAPABILITIES, type IMessageBroker, type IRuntimeServices } from '@setu-ts/common';

const ordersPlacedV1 = defineIntegrationEvent<{ orderId: string }>({
  type: 'orders.placed',
  version: 1,
  topic: 'orders.placed.v1',
  parse: (value) => value as { orderId: string },
});

const ordersPlacedV2 = defineIntegrationEvent<{ orderId: string; totalCents: number }>({
  type: 'orders.placed',
  version: 2,
  topic: 'orders.placed.v2',
  parse: (value) => value as { orderId: string; totalCents: number },
});

// The migration window: both topics are published; the v1 publication stops
// only after every required consumer has deployed onto v2.
async function publishBoth(
  runtime: IRuntimeServices,
  broker: IMessageBroker,
  order: { orderId: string; totalCents: number },
): Promise<void> {
  await publishIntegrationEvent(runtime, broker, ordersPlacedV1, { orderId: order.orderId });
  await publishIntegrationEvent(runtime, broker, ordersPlacedV2, order);
}

declare const runtime: IRuntimeServices;
declare const broker: IMessageBroker;
await publishBoth(runtime, broker, { orderId: '123', totalCents: 9900 });
```

The suffix guard locks out a topic that predates this policy — a live `orders.created` with no
version suffix cannot be expressed as a definition. The raw `broker.publish` / `broker.subscribe`
surface is unchanged and remains the documented route for such a topic.

### What the publisher does NOT do

`publishIntegrationEvent` never runs `parse`. The parser is a narrowing function `unknown → T`, and
a realistic one (a schema with defaults, coercion, or stripping) returns a different object than it
was given — running it on publish would silently change what the producer asked to send. The honest
consequence: a producer **can** publish a payload its own consumers reject, and that surfaces at the
consumer as a `reason: 'parse'` rejection. What the consumer parses is the value after a JSON round
trip, which the producer's call never saw.

### Rejections

`onIntegrationEvent`'s wrapper validates the delivered envelope structurally, checks `type` and
`version` for exact equality, and runs `parse` — all before the application handler runs. A refusal
throws `IntegrationEventRejectedError`, discriminated by `reason`:

| `reason`           | Fault                                                                      |
| ------------------ | -------------------------------------------------------------------------- |
| `malformed`        | Not an object, or a mandatory field missing or of the wrong primitive type |
| `type-mismatch`    | The envelope's `type` differs from the definition                          |
| `version-mismatch` | The envelope's `version` differs from the definition                       |
| `parse`            | The definition's parser threw (carried as `cause`)                         |

Unknown EXTRA envelope fields are accepted and forwarded — a producer on a later framework version
may add a field this build does not know about, and refusing it would make every additive envelope
change a coordinated deployment. Payload strictness is the parser's job, where the application owns
the policy.

The rejection follows the broker's native failure path — nack-and-redeliver on a real broker, the
dispatch report on the in-memory one. The error's `message` carries the whole diagnostic (reason,
topic, expected against observed), because the in-memory default composition logs exactly
`error.message` through the application's logger; the structured fields serve an `instanceof` branch
on a path that surfaces the error object, such as a dead-letter consumer or a bespoke sink on the
[`'custom'` broker arm](#options).

### Behaviour ordering

When `MessagingPlugin({ behaviors })` is configured, the ingress behaviour chain runs **before** the
integration-event wrapper, so `IngressContext.payload` is the raw envelope and never the parsed
payload. That ordering is deliberate: a behaviour that short-circuits (a tenant guard, an auth
check) must be able to refuse a message without the framework parsing it first, and a behaviour
reading `envelope.correlationId` off the raw object is doing something useful. A behaviour therefore
cannot depend on `payload` being the parsed `T`.

### Mapping a local domain event to an integration event

Mapping a fact an aggregate recorded (see
[`@setu-ts/events-plugin`](https://github.com/setu-ts/setu-ts/tree/main/packages/events-plugin))
onto a published integration event is APPLICATION policy, written out explicitly — no framework path
performs it. Two traps get named: `event.type` is the domain fact's name and deliberately NOT the
integration `type` (the contract owns its own `type`/`version` pair, so refactoring an internal
class name cannot break the wire), and `event.occurredOn` is when the fact HAPPENED while the
envelope's `occurredAt` is set at publish time — different instants, never conflated.

```typescript
import { createDomainEvents } from '@setu-ts/events-plugin';
import { defineIntegrationEvent, publishIntegrationEvent } from '@setu-ts/messaging-plugin';
import {
  CAPABILITIES,
  type IDomainEvent,
  type IMessageBroker,
  type IRuntimeServices,
} from '@setu-ts/common';

const orderPlaced = defineIntegrationEvent<{ orderId: string }>({
  type: 'orders.placed',
  version: 1,
  topic: 'orders.placed.v1',
  parse: (value) => value as { orderId: string },
});

// The facts an aggregate recorded locally, read at the application boundary.
const events = createDomainEvents();

// The contract's own parser is the narrowing step for the payload; the causal
// fields come from the domain fact.
function metadataFor(event: IDomainEvent): {
  causationId: string;
  aggregateId?: string;
  aggregateVersion?: number;
} {
  const metadata: { causationId: string; aggregateId?: string; aggregateVersion?: number } = {
    causationId: event.id,
  };
  if (event.aggregateId !== undefined) metadata.aggregateId = event.aggregateId;
  if (event.version !== undefined) metadata.aggregateVersion = event.version;
  return metadata;
}

async function publishPending(
  runtime: IRuntimeServices,
  broker: IMessageBroker,
): Promise<void> {
  for (const event of events.pending()) {
    await publishIntegrationEvent(runtime, broker, orderPlaced, orderPlaced.parse(event.data), {
      ...metadataFor(event),
    });
  }
}

declare const runtime: IRuntimeServices;
declare const broker: IMessageBroker;
await publishPending(runtime, broker);
events.clear(); // after the application's own confirmed dispatch policy
```

Publishing this way says nothing about any consumer finishing: as [Publish timing](#publish-timing)
documents, a transport accepting a publish resolves on dispatch hand-off, not on handler completion.

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

| Export                            | Kind      |
| --------------------------------- | --------- |
| `adaptPubSubModule`               | function  |
| `adaptServiceBusModule`           | function  |
| `causedBy`                        | function  |
| `defineIntegrationEvent`          | function  |
| `EventsMessagingBridge`           | function  |
| `loadPubSubModule`                | function  |
| `loadServiceBusModule`            | function  |
| `MessagingPlugin`                 | function  |
| `onIntegrationEvent`              | function  |
| `publishIntegrationEvent`         | function  |
| `ChainGateTimeoutError`           | class     |
| `CloudBrokerUnavailableError`     | class     |
| `GcpPubSubBroker`                 | class     |
| `InMemoryBroker`                  | class     |
| `IntegrationEventRejectedError`   | class     |
| `JetStreamStreamError`            | class     |
| `JetStreamUnavailableError`       | class     |
| `JsonSerializer`                  | class     |
| `KafkaBroker`                     | class     |
| `MessagingNotSupportedError`      | class     |
| `NatsBroker`                      | class     |
| `RabbitMqBroker`                  | class     |
| `RedisStreamsBroker`              | class     |
| `RemoteHandlerError`              | class     |
| `ReplyInboxUnavailableError`      | class     |
| `RequestTimeoutError`             | class     |
| `ServiceBusBroker`                | class     |
| `CustomMessagingOptions`          | interface |
| `EventsMessagingBridgeOptions`    | interface |
| `IMessageBroker`                  | interface |
| `INatsHeaders`                    | interface |
| `InMemoryBrokerOptions`           | interface |
| `IntegrationEventDefinition`      | interface |
| `IntegrationEventEnvelope`        | interface |
| `IntegrationEventMetadata`        | interface |
| `IPubSubSubscription`             | interface |
| `IPubSubTransport`                | interface |
| `ISerializer`                     | interface |
| `IServiceBusProcessErrorArgs`     | interface |
| `IServiceBusReceiver`             | interface |
| `IServiceBusSubscribeOptions`     | interface |
| `IServiceBusSubscription`         | interface |
| `IServiceBusTransport`            | interface |
| `ISubscription`                   | interface |
| `KafkaMessagingOptions`           | interface |
| `KafkaOptions`                    | interface |
| `MemoryMessagingOptions`          | interface |
| `MessageMetadata`                 | interface |
| `MessagingCommonOptions`          | interface |
| `NatsMessagingOptions`            | interface |
| `NatsOptions`                     | interface |
| `PubSubOptions`                   | interface |
| `PubSubSdkModule`                 | interface |
| `RabbitMqMessagingOptions`        | interface |
| `RabbitMqOptions`                 | interface |
| `RedisStreamsMessagingOptions`    | interface |
| `RedisStreamsOptions`             | interface |
| `RequestOptions`                  | interface |
| `ServiceBusOptions`               | interface |
| `ServiceBusRetryOptions`          | interface |
| `ServiceBusSdkModule`             | interface |
| `SubscribeOptions`                | interface |
| `SubscriptionDefinition`          | interface |
| `IntegrationEventHandler`         | type      |
| `IntegrationEventRejectionReason` | type      |
| `MessageHandler`                  | type      |
| `MessagingBrokerType`             | type      |
| `MessagingPluginOptions`          | type      |
| `PubSubMessagingOptions`          | type      |
| `RequestHandler`                  | type      |
| `ServiceBusMessagingOptions`      | type      |
| `SubscriptionEntry`               | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#messaging-setu-tsmessaging-plugin).
