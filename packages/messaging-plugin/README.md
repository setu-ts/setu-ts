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

## Publish options and trust

`broker.publish(topic, message, options)` takes an optional third argument:

| Option            | Bound                                                                            | Mapped to                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `orderingKey`     | non-empty string ≤ 128 UTF-8 bytes, no control characters, no edge whitespace    | Kafka message `key`, Pub/Sub `orderingKey`, and the `x-setu-ordering-key` header on every broker                            |
| `deduplicationId` | same rule                                                                        | NATS `Nats-Msg-Id`, Service Bus `messageId`, RabbitMQ `messageId`, and the `x-setu-deduplication-id` header on every broker |
| `headers`         | ≤ 32 entries; names 1–255 bytes of visible ASCII except `:`; values ≤ 1024 bytes | written beside the framework's own headers                                                                                  |

Every option is carried as a transport header beside any native mapping, so it is observable through
`MessageMetadata.headers` on every broker and never silently dropped. The constants
`ORDERING_KEY_HEADER` and `DEDUPLICATION_ID_HEADER` (from `@setu-ts/common`) name the two headers.
The `Cloudflare Workers` broker carries `orderingKey`, `deduplicationId` and the caller's `headers`
as envelope fields, because a Cloudflare queue has no transport header channel; on delivery all of
them are surfaced as the same transport headers. Invalid options are refused on publish; on
delivery, an envelope entry failing the shared rules is dropped. A `NatsBroker` with an injected
connection and no `headersFactory` drops caller headers and the ordering key (reported once through
the logger) but still applies the de-duplication id as nats.js's native `msgID`.

### What `orderingKey` promises

`orderingKey` decides **placement** — the same key reaches the same partition, retry queue or
ordered subscription where the broker has one — not the order handlers **finish** in. Measured
2026-10-07 against real backends:

| Broker          | On a handler failure                                                                                                                                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kafka           | Order kept by blocking: the offset stays uncommitted, so one failing message stalls its partition                                                                                                                                                              |
| Pub/Sub         | Order kept by blocking, on an ordering subscription (`enableMessageOrdering`)                                                                                                                                                                                  |
| Service Bus     | Order kept by blocking ONLY at `maxConcurrentCalls: 1` (the broker's default): the abandoned message is redelivered before the next is handled. At `maxConcurrentCalls: 2` the later message is handled first, so order is LOST. Measured both ways 2026-10-07 |
| RabbitMQ        | Order lost on retry: later messages for the key are handled while the failed one waits                                                                                                                                                                         |
| Redis Streams   | Order lost on retry (reclaim)                                                                                                                                                                                                                                  |
| NATS            | Order lost on retry                                                                                                                                                                                                                                            |
| in-memory       | Dispatch already follows publish order                                                                                                                                                                                                                         |
| `WorkersBroker` | Follows `dispatch` batch order                                                                                                                                                                                                                                 |

A consumer that needs order compares the delivered envelope's version and drops or defers a stale
message.

### What a consumer may trust, and what a producer must not derive

1. A delivered `x-setu-ordering-key` or `x-setu-deduplication-id` header is a **hint written by
   whoever published the message** — validation runs on the publish side only — so a foreign or
   compromised producer can send any value under these names. Use it to order or de-duplicate your
   own work, **never to authorize anything**.
2. A `deduplicationId` derived from request input lets the caller who chooses it suppress another
   message with the same id for the broker's window (NATS's `duplicate_window`, 120 s by default;
   Service Bus's configured detection window). Derive it from a producer-assigned id — the envelope
   id `publishIntegrationEvent` uses by default is one.
3. An `orderingKey` derived from request input lets a caller concentrate load on one Kafka partition
   or one Pub/Sub ordering key (1 MB/s per key), and on a log-compacted Kafka topic it lets the
   caller erase an earlier message that carries the same key. Derive it from an aggregate the
   application owns.

Invalid options are rejected with a `RangeError` **as a rejected promise**, naming the field and the
rule and never echoing the refused value. A header name a broker or its server acts on
(`traceparent`, `tracestate`, `cc`, `bcc`, `payload`, `nats-*`, `x-setu-*`, RabbitMQ's `x-death` /
`x-delivery-count` / `x-acquired-count` / `x-delay` and the `x-first-death-*` / `x-last-death-*`
forms) is refused on **every** broker, compared case-insensitively. A `goog` prefix is refused too,
as a precaution: Pub/Sub's reservation of it is stated only by third-party documentation, and the
emulator accepts `goog` attributes.

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

With `'redis-streams'`, connection errors of the `ioredis` client the broker builds go to the
application logger — the first error of an outage at `warn`, identical repeats at `debug`, the
recovery at `info` — instead of `ioredis` printing every reconnect failure to `console.error`. An
injected client gets no listener: it belongs to the caller.

### RabbitMQ durability

Consumer-group queues are declared durable, and every message is published **persistent** — a
durable queue keeps only persistent messages across a broker restart. Before 0.9.0 messages were
published transient, so a RabbitMQ restart emptied every group queue of the messages waiting in it.
Publishes also go through a **confirm channel**: `publish()` resolves only once RabbitMQ has
accepted the message, and rejects when it refuses it (or the channel closes first).

Each `publish()` is bounded by `publishTimeoutMs` (default `15000`, `0` unbounded). The bound covers
every broker round trip the publish makes, so a paused broker — which keeps its socket open and
answers nothing — rejects the call instead of leaving it pending forever. A rejection is not proof
the message was dropped: RabbitMQ may still accept it after the bound.

```typescript
import { MessagingPlugin } from '@setu-ts/messaging-plugin';

MessagingPlugin({
  broker: 'rabbitmq',
  url: 'amqp://localhost:5672',
  // Both values are the defaults, shown for reference.
  persistentMessages: true,
  publishTimeoutMs: 15_000,
});
```

`persistentMessages: false` restores the transient behaviour, for deliberately ephemeral traffic
where losing in-flight messages on a restart is acceptable. An injected `client` without
`createConfirmChannel()` keeps a plain channel — `publish()` then resolves before RabbitMQ has
stored anything — and the broker logs one warning saying so; a real amqplib connection always has
it.

### RabbitMQ consumer recovery

Since 0.9.0, durable consumer-group handlers **must be idempotent**: failures redeliver, and a crash
after a confirmed copy but before the original ack can duplicate a message.

| RabbitMQ option             | Default                         | Behavior                                                                                               |
| --------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `consumerRetry.maxAttempts` | `5`                             | Total delivery budget, initial attempt included; positive safe integer                                 |
| `consumerRetry.delaysMs`    | `[5000, 30000, 120000, 600000]` | Nonempty, nondecreasing positive integer milliseconds ≤2147483647; later attempts reuse the final tier |
| `consumerRetry.isRetryable` | absent                          | False dead-letters immediately; a throwing classifier is logged and counts as retryable                |
| `consumerRetry`             | enabled                         | `false` restores nack with requeue disabled, including any operator DLX policy                         |
| `deadLetterMaxLength`       | `10000`                         | Positive safe integer; `x-max-length` on `Q.dead`                                                      |
| `prefetch`                  | `32`                            | Integer 1–65535; maximum unacked deliveries per consumer, re-applied on reconnect                      |

These numeric options throw `RangeError` at construction for invalid values, including `NaN`,
fractions, empty delay arrays and decreasing tiers. `ConsumerRetryOptions` is shared with Redis
Streams; each broker retains its own defaults and lease semantics.

For group queue `Q`, each distinct delay `d` creates a durable quorum queue `Q.retry.<d>ms`, with
queue-level `x-message-ttl: d` and default-exchange dead-letter routing back to `Q`. It uses
at-least-once dead-lettering (`x-dead-letter-strategy: at-least-once`, `x-overflow: reject-publish`)
because the original is acked once the copy is confirmed: classic at-most-once dead-lettering drops
a copy that `Q` cannot take when it expires (measured on RabbitMQ 4: `Q` absent at expiry received
nothing in 240 s; the quorum queue held the copy and delivered it about 180 s after `Q` reappeared).
Changing delays creates new queues without a 406 redeclaration conflict; old retry queues drain into
`Q`. No per-message expiration is copied. The default budget gives about 12.6 minutes of backoff
before dead-lettering.

With retries enabled, group names ending in `.dead` or `.retry.<digits>ms` are reserved for helper
queues. Every generated queue name must fit 255 UTF-8 bytes. Declarative names are checked at plugin
construction; imperative and factory subscriptions are checked before declaring anything. Rename
conflicting groups, or set `consumerRetry: false` to keep their existing names. Before enabling
retries, migrate any existing queues occupying `Q.dead` or `Q.retry.<delay>ms` in the same vhost.

Deserialize failures and `IntegrationEventRejectedError` go straight to `Q.dead`. Other failures run
the application classifier, then retry below the total attempt budget or dead-letter when exhausted.
Retry copies preserve body bytes, messageId, timestamp and transport headers (including
traceparent), adding `x-setu-attempt` (absent means initial attempt 1). Copies omit `expiration`,
`userId` and the `CC`/`BCC` headers: RabbitMQ refuses another user's `user_id` by closing the
channel, and CC/BCC would deliver the copy to the queues they name. Malformed attempt headers
dead-letter immediately. Dead letters add `x-setu-attempts`, `x-setu-topic` and `x-setu-error`,
rendered via `describeError` and bounded to 1 KiB UTF-8. Error descriptions and payloads may contain
sensitive data: grant queue and diagnostic-log access only to readers trusted with that data, and
apply retention policy. Dead-letter log lines normalize control and format characters in queue,
topic and error text, and cap the complete diagnostic at 8192 Unicode code points with a visible
truncation marker. Routing names and retained topic headers preserve their original values. When the
dead queue exceeds its cap, RabbitMQ drops its oldest ready messages. Drain and delete `Q.dead`
before changing `deadLetterMaxLength`; RabbitMQ rejects different `x-max-length` arguments with 406.

The copy is always persistent, even if original publishes use `persistentMessages: false`. It uses
the same confirmed publish path and timeout as normal publishes, and the original is acked only
after that publish succeeds. Copies use mandatory publishing: an unroutable `basic.return` rejects
the disposition even if RabbitMQ sends a positive confirm. The framework-owned
`x-setu-disposition-id` header is replaced for each copy and correlates concurrent returns without
changing the original message ID. Return listeners are removed on confirm, return, close or timeout.
A failed disposition leaves the original unacked and logs the failure, then the broker closes that
channel (returning the original to `Q`) and runs its reconnect-and-replay recovery, which
re-declares the retry and dead queues before consuming again; otherwise the unacked originals would
fill `prefetch` on a live channel and stall the consumer. The RabbitMQ user needs configure
permission on `Q.dead` and `Q.retry.<delay>ms`, read permission on `Q.retry.<delay>ms`, and write
permission on the default exchange, `amq.default`, which carries every retry and dead-letter copy
(measured on RabbitMQ 4: without them `subscribe()` fails with `403 ACCESS_REFUSED` on the first
helper declaration, and a copy published without `amq.default` write closes the channel). Recovery
requires confirm channels with channel `on`/`off` return listeners and `close()`; `subscribe()`
refuses a retrying consumer group on an injected facade missing any of them, before declaring
anything, and names `consumerRetry: false` as the alternative. Normal publishes retain their
documented unconfirmed-publish limitation. Use `consumerRetry: false` for legacy nack behavior.

Private exclusive fan-out queues and RPC reply inboxes keep nack with requeue disabled. Measured:
TTL dead-lettering reaches an exclusive queue while its connection lives, but discards the copy once
the connection is gone. Durable retries therefore apply only to consumer groups. Messages unacked
behind a slow handler stay leased until channel closure; elapsed time alone does not cause
redelivery. A large prefetch allows more messages to wait in that consumer's memory and can increase
their latency and reduce fairness across replicas. Handlers may run concurrently up to prefetch.

Local RabbitMQ 4 measurement (2,000 persistent messages, 2 ms async handler): prefetch 1/8/32/128
took 6554/813/209/65 ms. Default 32 bounds local backlog while reaching about 9,570 messages/s in
this probe; these numbers describe this machine, not a throughput guarantee.

### Redis Streams recovery

Redis **6.2 or newer** is required (`XPENDING IDLE`). Handlers must be idempotent: failed messages
now retry, including after an application restart. New and reclaimed entries use the same payload,
headers, metadata, and acknowledgement path. Reclaim uses `XPENDING IDLE` and atomic `XCLAIM`; it
reads at most ten pending entries per pass, rotating the cursor so later entries cannot starve.

| Redis option                | Default                          | Behavior                                                                       |
| --------------------------- | -------------------------------- | ------------------------------------------------------------------------------ |
| `consumerRetry.maxAttempts` | `5`                              | Total delivery budget, including the initial attempt.                          |
| `consumerRetry.delaysMs`    | `[30000, 60000, 300000, 600000]` | Delay indexed by deliveries minus one, clamped to the final tier.              |
| `consumerRetry.isRetryable` | all handler failures retry       | `false` dead-letters immediately; a throwing classifier is logged and retries. |
| `reclaimIntervalMs`         | `5000`                           | One reclaim pass per subscription per interval.                                |
| `deadLetterMaxLen`          | `10000`                          | Approximate `MAXLEN ~` retention on each dead-letter stream.                   |
| `consumerIdleSweepMs`       | `3600000`                        | Sweep inactive foreign consumers only with pending count zero.                 |

Counts must be positive safe integers. Millisecond values must be positive integers no greater than
`2147483647`; delays must be nonempty and nondecreasing. Invalid values, including `NaN`, throw
`RangeError` at broker construction. There is no `consumerRetry: false` arm.

The first delay is also the lease for in-flight handlers: set it above the longest handler runtime,
or another replica may reclaim a slow handler's work and run it concurrently. Effective retry
latency is the tier plus up to one reclaim interval when the pass keeps pace with the backlog;
rotating through a larger backlog adds passes. Reclaimed entries may arrive after newer entries; use
`aggregateVersion` when the application needs ordered effects.

Deserialize failures, missing payloads, and `IntegrationEventRejectedError` go directly to
`<topic>.dead.<group>`. Exhausted deliveries go there too. The stream carries the original fields
plus `x-setu-source-id` and `x-setu-deliveries`, written with `XADD MAXLEN ~` **before** source
`XACK`. A crash between those commands can duplicate a dead-letter entry; a failed write preserves
the source pending entry. Approximate trimming can exceed the configured length by Redis allocation
blocks. Dead-letter streams retain message data; apply suitable Redis ACLs and retention.

Each pass adds a pending query, up to ten claims, and a consumer-info query; cleanup adds deletion
commands as needed. Clean unsubscribe/disconnect deletes its own consumer only when pending count is
zero. Pending consumers survive shutdown for another replica to reclaim. Redis 6.2 uses consumer
`idle` for the sweep; Redis 7.2+ uses `inactive` (falling back to `idle` for consumers that have
never delivered).

Injected `IRedisStreamsClient` facades must supply `xpending`, `xclaim`, and `xinfo` as well as the
existing methods, and support `xgroup('DELCONSUMER', ...)`.

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

**`publish()` resolves once JetStream has stored the message.** It waits for the server's
acknowledgement, so a publish to a subject no stream captures rejects with an error naming the
subject (the server answers `503`), and an unresponsive server rejects after the client's own 5 s
timeout. Before 0.9.0 the acknowledgement was not awaited: such a publish resolved as a success and
the refusal surfaced as an unhandled rejection, which terminates a Deno or Node process by default.

**Request-reply needs its subjects in the stream too.** A responder consumes the derived
`rr.req.<topic>` subject and the requester's reply inbox is `rr.inbox.<uuid>`, so an RPC-capable
stream must cover both — for example
`streamSubjects: ['orders.>', 'rr.req.orders.>', 'rr.inbox.>']`. NATS refuses two streams whose
subjects overlap, so only **one** stream per account can own `rr.inbox.>`: applications that use RPC
on one server must share that stream.

**Queue names become consumer names.** A `SubscribeOptions.queue` is the JetStream durable consumer
name, and the nats client refuses `.`, `*`, `>`, `/`, `\`, space, tab, CR and LF in one before
anything reaches the server — which is why the reply inbox's dotted `rr.inbox.<uuid>` queue made
every `request()` fail. Each refused character is now escaped as `_` plus two hex digits
(`orders.eu` → `orders_2eeu`), so the name stays readable in `nats consumer ls`; a queue with none
of them is used unchanged, so no existing consumer is renamed. The consumer records its raw queue as
`setu.queue` metadata, which needs **NATS 2.10 or later**.

The escape is not injective: the legal queue `orders_2eeu` encodes like `orders.eu`. Rather than let
two independent queues split one consumer's deliveries, `subscribe()` rejects with
`NatsConsumerNameCollisionError` naming both queues — in one process, and across processes by
reading the existing consumer's recorded queue. The same error refuses a queue reused across two
topics, which used to attach silently to the first topic's consumer. A consumer created before this
release carries no `setu.queue`; it is accepted when its durable name equals the requested queue and
its filter matches the topic.

### Pub/Sub subscriptions

When `queue` is not supplied, each subscription is derived per topic — `<defaultQueue>.<topic ID>`
(default prefix `messaging-consumers`; a fully-qualified `projects/<p>/topics/<id>` name contributes
only its ID, because `/` is illegal in a subscription ID) — because a Pub/Sub subscription name is
**project-global**: the old single shared default attached a second topic to the first topic's
subscription, so one topic's handler consumed the other's messages with no log, and the RPC channel
of one run attached to the previous run's. A caller-supplied `queue` is used verbatim, so competing
consumers of one topic keep sharing a subscription.

The broker creates a subscription when it is absent. When it already exists, the broker reads which
topic it is bound to and refuses one bound elsewhere with `PubSubSubscriptionBoundElsewhereError`
naming the subscription, its topic and the requested topic — pass a distinct `queue`, or delete the
subscription. Pub/Sub reserves no character in a name, so unlike Kafka's colon the `.` separator is
not recoverable by splitting. A derived or supplied name over 255 characters is refused at
`subscribe()`. Topics must already exist; the broker creates none.

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

### Kafka topics

The broker creates no topic. On a broker with `auto.create.topics.enable` (Kafka's default), the
metadata request that creates a topic answers `UNKNOWN_TOPIC_OR_PARTITION` — measured on Kafka 4.0
in KRaft mode — and kafkajs does not retry that answer, so a subscription to a topic that did not
exist yet used to die at boot with a raw `KafkaJSProtocolError` naming no topic. `subscribe()` now
retries that one error with exponential backoff within `retry` (kafkajs's defaults: 5 retries from
300 ms, about 9 s in all), and the next attempt finds the new topic. When the topic is still unknown
after the budget — a broker that does not auto-create — it rejects with `KafkaTopicUnavailableError`
naming the topic and the consumer group; `retry: { retries: 0 }` names it at once. Pre-create the
topic, or enable auto-creation.

`retry` is also forwarded to `new Kafka({ retry })` for kafkajs's own retries, unless a `client` is
injected. A consumer's `run()` can reject — kafkajs's crash handler rethrows a disconnect that fails
— and the broker reports that through the logger instead of letting it become an unhandled
rejection.

A consumer that crashes with an error kafkajs would retry is restarted by the broker, after the
crash's own `retryTime`, else `retry.initialRetryTime`, else 300 ms — read the way kafkajs's own
restart reads them, so `initialRetryTime: 0` waits 300 ms rather than restarting at once. The
`retry` read is `KafkaOptions.retry`, not an injected client's own. The broker declines kafkajs's
restart in favour of its own so that stopping can always reach the restarted consumer.

Stopping releases every consumer: `disconnect()` and `unsubscribe()` cancel a scheduled restart,
wait up to 10 s for an in-flight group join to settle, then disconnect the consumer. A join still
pending at 10 s is not disconnected under — that neither stops a join that later succeeds nor
returns before kafkajs's pending JoinGroup is answered — so the release returns and the consumer is
disconnected the moment its join settles or fails. Until then the process stays alive, and a record
delivered in that window is left uncommitted for the group to redeliver. On a broker with Kafka's
default `group.initial.rebalance.delay.ms` (3 s), stopping an application moments after it started
takes a few seconds.

## Request-reply

`request()` / `respond()` carry correlation inside a message envelope over each broker's ordinary
`publish`/`subscribe`. Correlation is carried in the message envelope independently of transport
headers.

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
what the producer put in. The string is the honest type. `correlationId`, `causationId` and
`aggregateId` are strings; `aggregateVersion` is the only number, and it must be FINITE, because
JSON serialization maps `NaN`/`Infinity` to `null` — a non-finite one would arrive as `null`. Each
is checked on both sides: refused at the producer, and refused as a `malformed` rejection at the
consumer.

**Publish options.** `publishIntegrationEvent` takes the same `PublishOptions` as `broker.publish`
as an optional sixth argument (after the causal metadata), with two defaults of its own:
`deduplicationId` defaults to the envelope `id`, so re-publishing the same envelope is de-duplicated
where the broker supports it; and `orderingKey` comes from the caller, else from an optional
`orderingKey: (envelope) => string | undefined` selector on the definition, else none. The selector
runs only when the caller supplied no key; if it throws or returns a value the rules refuse, the
publish rejects.

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
  // `parse` is the payload validation boundary, and it runs on a value that has
  // crossed a process. A bare `value as T` is a compile-time assertion that
  // checks NOTHING at runtime, so a wrong payload would reach the handler typed
  // as if it were right. Narrow it for real:
  parse: (value) => {
    const candidate = value as { orderId?: unknown };
    if (typeof candidate?.orderId !== 'string') {
      throw new TypeError('orderPlaced: "orderId" must be a string');
    }
    return { orderId: candidate.orderId };
  },
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
  parse: (value) => value as { orderId: string }, // terse here; validate for real (see above)
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
  parse: (value) => value as { orderId: string }, // terse here; validate for real (see above)
});

const ordersPlacedV2 = defineIntegrationEvent<{ orderId: string; totalCents: number }>({
  type: 'orders.placed',
  version: 2,
  topic: 'orders.placed.v2',
  parse: (value) => value as { orderId: string; totalCents: number }, // terse; validate for real
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

A payload of `undefined` is refused at the producer: `JSON.stringify` drops a key whose value is
`undefined`, so such an event would publish cleanly and then arrive with no `data` at all, and every
consumer would refuse it as malformed — silently, on a composition with no logger. A payloadless
integration event publishes `null`. For the same reason a non-finite `aggregateVersion` (which
serializes to `null`) is refused, and on the consumer side a present
`correlationId`/`causationId`/`aggregateId` must be a string, a present `aggregateVersion` a finite
number, and `occurredAt` a real ISO-8601 instant — otherwise the envelope's declared types would be
a lie one hop before `causedBy` copies `correlationId` into the next event.

`occurredAt` must be an ISO-8601 instant in the interoperable RFC 3339 profile — a full date, a time
to at least seconds, and an explicit `Z` or a numeric offset (`2026-01-01T00:00:00Z`,
`2026-01-01T00:00:00.000Z`, `2026-01-01T00:00:00+05:30`). A date-only value, an RFC 2822 date, or a
zone-LESS timestamp is refused: `Date.parse` accepts all three, and the zone-less form is read in
each engine's own local time — measured, `2026-01-01T00:00:00` becomes `2025-12-31T18:30:00.000Z` on
a `+05:30` host — so one event would mean a different instant on every consumer.

The rejection follows the broker's OWN failure path, and that path differs per arm — it is not a
retry guarantee. RabbitMQ durable groups now send deterministic rejections directly to `Q.dead` and
log the failure; private queues, reply inboxes and `consumerRetry: false` retain nack with requeue
disabled (operator DLX if configured, otherwise discard). NATS naks, which redelivers while the
stream retains the message, and (since PR #287) also logs it. The in-memory broker reports through
`onDispatchError` and drops. Because a rejection here is deterministic — the same envelope fails the
same way on every delivery — redelivery cannot resolve it, so a dead-letter queue rather than a
retry is where a refused event is inspected. The error's `message` carries the whole diagnostic
(reason, topic, expected against observed), because the in-memory default composition logs exactly
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
  parse: (value) => value as { orderId: string }, // terse here; validate for real (see above)
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

**Since M95b** reachability reads the plane the application actually uses. The Service Bus broker
records the outcome of every real publish — the **data plane** — as evidence and `reachability()`
consults it FIRST: a positive success resolves `true` for `ServiceBusOptions.dataPlaneEvidenceMs`
(default `5000`), while a network-layer failure (a rejection carrying no `statusCode`; a rejected
topic or a quota error is an application-level fact, never an outage) resolves `false` until a
successful publish or positive management probe contradicts it. **Since M101a** that retained
failure is answered at once: the management probe runs in the background, and only a `true` answer
clears the outcome, for the NEXT read — before, `reachability()` awaited the probe, whose own 2 s
bound tied the indicator's, so the indicator's bound fired first and a recorded outage was reported
`up`. A failure inside a window the indicator has already cached as `up` is reported at the first
poll after that 5 s cache expires. The plane distinction is the substance: the management round trip
proves the **management** plane is reachable — evidence about the data plane, never proof of it —
and that gap is what let a stopped namespace report `up` while every publish threw. Two further
changes, and the first has **two layers** because the health indicator is not the only caller. The
indicator wraps every arm's `reachability()` in its own `createCachedProbe` (5-second TTL, 2-second
bound), which is the universal outer bound: a probe that cannot answer — a **hung** broker, the
condition a stopped one never produces — settles `reachable: 'unknown'` instead of holding `/health`
open. `RabbitMqBroker` and `ServiceBusBroker` additionally build their own cached, bounded probes,
which is what `isHealthy()` reads; that inner layer is what protects a **direct** caller, such as
`realtime-backplane-plugin`'s `'messaging'` transport, which resolves the broker itself and never
passes through this indicator. Second, the RabbitMQ probe is a real round trip (a throwaway channel
open/close), replacing the connection-fault flag read that a hung broker never trips. Residual
exposure, stated rather than implied: a deployment whose Service Bus management plane is unreachable
and that publishes nothing keeps reporting `reachable: 'unknown'` with status `up` until its first
publish — an operator who needs the signal can publish synthetically.

## Exports

| Export                                  | Kind      |
| --------------------------------------- | --------- |
| `adaptPubSubModule`                     | function  |
| `adaptServiceBusModule`                 | function  |
| `causedBy`                              | function  |
| `defineIntegrationEvent`                | function  |
| `EventsMessagingBridge`                 | function  |
| `loadPubSubModule`                      | function  |
| `loadServiceBusModule`                  | function  |
| `MessagingPlugin`                       | function  |
| `onIntegrationEvent`                    | function  |
| `publishIntegrationEvent`               | function  |
| `ChainGateTimeoutError`                 | class     |
| `CloudBrokerUnavailableError`           | class     |
| `GcpPubSubBroker`                       | class     |
| `InMemoryBroker`                        | class     |
| `IntegrationEventRejectedError`         | class     |
| `JetStreamStreamError`                  | class     |
| `JetStreamUnavailableError`             | class     |
| `JsonSerializer`                        | class     |
| `KafkaBroker`                           | class     |
| `KafkaTopicUnavailableError`            | class     |
| `MessagingNotSupportedError`            | class     |
| `NatsBroker`                            | class     |
| `NatsConsumerNameCollisionError`        | class     |
| `OutboxEnvelopeTooLargeError`           | class     |
| `OutboxNotReadyError`                   | class     |
| `OutboxRelayUnscheduledError`           | class     |
| `OutboxRowStateError`                   | class     |
| `OutboxUnknownTenantError`              | class     |
| `PubSubSubscriptionBoundElsewhereError` | class     |
| `RabbitMqBroker`                        | class     |
| `RedisStreamsBroker`                    | class     |
| `RemoteHandlerError`                    | class     |
| `ReplyInboxUnavailableError`            | class     |
| `RequestTimeoutError`                   | class     |
| `ServiceBusBroker`                      | class     |
| `ConsumerRetryOptions`                  | interface |
| `CustomMessagingOptions`                | interface |
| `EventsMessagingBridgeOptions`          | interface |
| `IMessageBroker`                        | interface |
| `INatsHeaders`                          | interface |
| `InMemoryBrokerOptions`                 | interface |
| `IntegrationEventDefinition`            | interface |
| `IntegrationEventEnvelope`              | interface |
| `IntegrationEventMetadata`              | interface |
| `IOutbox`                               | interface |
| `IPubSubSubscription`                   | interface |
| `IPubSubTransport`                      | interface |
| `ISerializer`                           | interface |
| `IServiceBusProcessErrorArgs`           | interface |
| `IServiceBusReceiver`                   | interface |
| `IServiceBusSubscribeOptions`           | interface |
| `IServiceBusSubscription`               | interface |
| `IServiceBusTransport`                  | interface |
| `ISubscription`                         | interface |
| `KafkaMessagingOptions`                 | interface |
| `KafkaOptions`                          | interface |
| `MemoryMessagingOptions`                | interface |
| `MessageMetadata`                       | interface |
| `MessagingCommonOptions`                | interface |
| `NatsMessagingOptions`                  | interface |
| `NatsOptions`                           | interface |
| `OutboxCommonOptions`                   | interface |
| `OutboxHealthOptions`                   | interface |
| `OutboxRelayOptions`                    | interface |
| `OutboxSweepResult`                     | interface |
| `OutboxWriteInput`                      | interface |
| `PubSubOptions`                         | interface |
| `PubSubSdkModule`                       | interface |
| `RabbitMqMessagingOptions`              | interface |
| `RabbitMqOptions`                       | interface |
| `RedisStreamsMessagingOptions`          | interface |
| `RedisStreamsOptions`                   | interface |
| `RequestOptions`                        | interface |
| `ServiceBusOptions`                     | interface |
| `ServiceBusRetryOptions`                | interface |
| `ServiceBusSdkModule`                   | interface |
| `SubscribeOptions`                      | interface |
| `SubscriptionDefinition`                | interface |
| `IntegrationEventHandler`               | type      |
| `IntegrationEventRejectionReason`       | type      |
| `MessageHandler`                        | type      |
| `MessagingBrokerType`                   | type      |
| `MessagingPluginOptions`                | type      |
| `OutboxOptions`                         | type      |
| `OutboxStoreEntry`                      | type      |
| `PubSubMessagingOptions`                | type      |
| `RequestHandler`                        | type      |
| `ServiceBusMessagingOptions`            | type      |
| `SubscriptionEntry`                     | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#messaging-setu-tsmessaging-plugin).
