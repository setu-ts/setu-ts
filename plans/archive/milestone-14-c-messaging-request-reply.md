# Milestone 14c — Messaging request-reply (`@hono-enterprise/messaging-plugin`)

<!--
  Canonical milestone plan. Developed in parallel with M28 in an isolated worktree branched off
  main, so it carries no M28 work and touches no shared files with it (M28 is storage; this is
  messaging/common). External client-API claims re-grounded from source 2026-07-24.
-->

> **Status:** Complete (PR pending). Branch: `feat/14c-messaging-request-reply` (isolated worktree
> off `main`, developed in parallel with M28). `main` is protected — all work stayed on this one
> branch. Independent of M28: no shared files and no ordering dependency, so each milestone merges
> via its own PR in any order. All four gates + per-file coverage pass; see the ROADMAP M14c
> deliverables.

## 0. Objective & scope

Add **brokered request-reply** (correlated request → awaited reply) to the existing
`@hono-enterprise/messaging-plugin`, closing the one NestJS-microservice pattern users cannot
cheaply rebuild (`client.send(pattern, data)`). This is a pure addition to the existing plugin via
the internal broker seam, mirroring the M14b precedent: no new capability token, no new plugin, the
same `CAPABILITIES.MESSAGING` service. It widens the committed `IMessageBroker` contract with two
methods and reuses all five brokers already shipped.

- **In scope:** `request()` / `respond()` on `IMessageBroker`; a shared `RequestReplyCore` +
  internal `IReplyTransport` seam; per-broker reply transport for in-memory, redis-streams,
  rabbitmq, nats; a documented `NotSupportedError` throw for kafka; exported `RequestTimeoutError` /
  `RemoteHandlerError` / `MessagingNotSupportedError`; the PUBLIC_API.md widening in the same PR.
- **NOT this milestone:** direct point-to-point typed RPC over HTTP/2 / the Connect protocol — that
  is the future **Connect plugin** (own spike + milestone; it owns retiring the README `🚧 Planned`
  gRPC row). Kafka request-reply support — deferred, ships as a tested throw here. Any change to the
  in-process `IEventBus` (M12) or CQRS buses (M13).

## 1. Contracts verified from SOURCE (not names)

| Reference                         | Source (file:line)                                                   | Verified surface / fact                                                                                                                                                                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IMessageBroker`                  | `packages/common/src/services/messaging.ts:70`                       | Pub/sub only today: `connect()`, `disconnect()`, `publish<T>(topic, message)` (:86), `subscribe<T>(topic, handler, options?)` (:96). No request-reply. Adding two methods widens ALL implementers.                                                                                            |
| `MessageMetadata`                 | `packages/common/src/services/messaging.ts:14`                       | `topic`, `messageId?`, `timestamp?`, `headers?: Readonly<Record<string,string>>` (:22). `headers` is OPTIONAL and not populated by every broker (see below) — cannot be the sole correlation channel.                                                                                         |
| `MessageHandler<T>`               | `packages/common/src/services/messaging.ts:33`                       | Returns `void \| Promise<void>` — cannot return a reply. Confirms `respond()` needs its own handler type, not a `subscribe()` overload.                                                                                                                                                       |
| `SubscribeOptions`                | `packages/common/src/services/messaging.ts:43`                       | `{ queue?: string }` only.                                                                                                                                                                                                                                                                    |
| `CAPABILITIES.MESSAGING`          | `packages/common/src/tokens.ts:55`                                   | `'messaging'`. Reused as-is; no new token.                                                                                                                                                                                                                                                    |
| `MessageBrokerAdapter`            | `packages/messaging-plugin/src/brokers/message-broker.ts:11`         | Internal seam `extends IMessageBroker`, adds `isReady()`. All five brokers implement it → all five must implement the two new methods.                                                                                                                                                        |
| `InMemoryBroker` metadata         | `packages/messaging-plugin/src/brokers/in-memory-broker.ts:101`      | `publish` builds metadata with `topic`/`messageId`/`timestamp` and **no `headers`**. Correlation must be carried out-of-band, not via `headers`.                                                                                                                                              |
| `RedisStreamsBroker` publish      | `packages/messaging-plugin/src/brokers/redis-streams-broker.ts:1056` | `xadd(topic, '*', 'payload', serialized)` — single `payload` field, metadata (:1139) has **no `headers`**. Reply correlation needs extra XADD fields + a reply stream.                                                                                                                        |
| `NatsBroker` transport            | `packages/messaging-plugin/src/brokers/nats-broker.ts:412`           | Uses **JetStream** (`js.publish`, durable consumers). `INatsConnection` (`interfaces/index.ts`) exposes only `jetstream`/`jetstreamManager`/`close` — core `nc.request()` is NOT reachable without widening the facade. Reply rides a JetStream reply subject, not native NATS request-reply. |
| `RabbitMqBroker` publish          | `packages/messaging-plugin/src/brokers/rabbitmq-broker.ts:728`       | `channel.publish(exchange, routingKey, content, properties)` already passes a `properties` object (currently just `messageId`, :741). AMQP `replyTo`/`correlationId` are standard properties — the natural carrier.                                                                           |
| `KafkaBroker` consume             | `packages/messaging-plugin/src/brokers/kafka-broker.ts:1448`         | `eachMessage` group-consumer auto-commit model. Reply correlation would need a dedicated reply topic + partition routing per caller → anti-pattern. Ships as a documented throw.                                                                                                              |
| `MessagingPlugin` named instances | `packages/messaging-plugin/src/plugin/messaging-plugin.ts:82`        | Token is `CAPABILITIES.MESSAGING` or `createNamedToken(instanceName)`. Request-reply adds no new token; each instance's resolved broker simply gains the two methods.                                                                                                                         |
| Test fakes                        | `packages/messaging-plugin/test/fixtures/fake-*-client.ts`           | Existing per-broker fake clients (amqplib/ioredis/kafkajs/nats) — extend each to support the reply path so the guarded REAL-import tests and unit tests exercise correlation.                                                                                                                 |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                | Resolution (picked side)                                                                                                                                         | Doc deliverable (same PR)                                             |
| -- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| C1 | README.md lists gRPC as the microservice-communication story; this milestone delivers brokered request-reply, not gRPC. | Keep the README gRPC row as `🚧 Planned` (Connect plugin owns it). Add a short "request-reply" note to the messaging section so readers do not conflate the two. | Edit README.md messaging section; leave the gRPC row untouched.       |
| C2 | PUBLIC_API.md documents `IMessageBroker` as pub/sub only; this widens it.                                               | Widen deliberately (flagged), documenting `request`/`respond` + the new error types with `@since 0.1.0`.                                                         | Update PUBLIC_API.md messaging section field-by-field in the same PR. |

## 3. Design decisions

### 3.1 Two new methods on `IMessageBroker`, `subscribe()` untouched

- **Decision:** Add `request<TReq, TRes>(topic, message, options?: RequestOptions): Promise<TRes>`
  and
  `respond<TReq, TRes>(topic, handler: RequestHandler<TReq, TRes>, options?: SubscribeOptions):
  Promise<ISubscription>`.
  `RequestHandler<TReq, TRes> = (message, metadata) => TRes | Promise<TRes>`. `subscribe()` /
  `publish()` are unchanged.
- **Why:** `MessageHandler` returns `void` (`messaging.ts:33`); overloading `subscribe` to return a
  reply would break every existing pub/sub caller. A distinct method pair is non-breaking and keeps
  fire-and-forget and request-reply as separate responsibilities.
- **Test home:** `common` type-level test that a `respond` handler returning `TRes` type-checks;
  unit tests per broker asserting a round-trip resolve.

### 3.2 Correlation carried per-broker, coordinated by a shared `RequestReplyCore`

- **Decision:** A shared internal `RequestReplyCore` owns the transport-agnostic machinery:
  `runtime.uuid()` correlation ids, a pending `Map<id, { resolve, reject, timer }>`, timeout arming,
  and inbox-reply dispatch. Each broker implements an internal `IReplyTransport`
  (`sendReply(replyTo, correlationId, payloadOrError)`, `openInbox(onReply): inboxAddress`,
  `sendRequest(topic, correlationId, replyTo, payload)`) that carries correlation on ITS OWN native
  envelope. The correlation ids do NOT rely on `MessageMetadata.headers`.
- **Why:** Grounded finding — in-memory (`in-memory-broker.ts:101`) and redis-streams
  (`redis-streams-broker.ts:1139`) build metadata with no `headers`, so a header-only mechanism
  would silently fail on two of five brokers. One shared core with a per-broker transport seam
  avoids duplicating the correlation/timeout logic (CLAUDE.md: route shared logic through one
  helper).
- **Test home:** `request-reply-core.test.ts` unit-tests correlation match, timeout reject + pending
  cleanup, and late-reply-after-timeout drop against a fake transport — directly on the internal
  seam.

### 3.3 Per-broker reply transport

- **Decision:**
  - **in-memory:** direct in-process pending map (no wire), routed through `RequestReplyCore`.
  - **redis-streams:** per-instance reply stream; `sendRequest` XADDs `correlationId` + `replyTo`
    fields alongside `payload`; inbox is a consumer-group poll on the reply stream.
  - **rabbitmq:** AMQP `replyTo` + `correlationId` message properties (extends the existing
    `properties` object at `rabbitmq-broker.ts:741`); per-instance exclusive reply queue as inbox.
  - **nats:** JetStream reply subject (a per-instance inbox subject filtered by a durable consumer),
    NOT core `nc.request` — the `INatsConnection` facade does not expose it.
  - **kafka:** `request`/`respond` throw `MessagingNotSupportedError` with a message pointing at a
    reply-capable broker.
- **Why:** Each choice matches the transport primitive the broker already uses (verified in §1); the
  kafka throw follows CLAUDE.md's "interface method an implementation cannot support gets an
  explicit, documented, tested throw, not silence."
- **Test home:** one unit test per broker for the resolve path; `kafka-broker.test.ts` asserts the
  throw; guarded REAL-import test per external broker exercises the real client reply path.

### 3.4 Errors and timeout

- **Decision:** Export `RequestTimeoutError` (rejects `request` when no reply within
  `RequestOptions.timeoutMs`, default `5000`), `RemoteHandlerError` (responder threw; carries the
  remote message serialized into the reply envelope), and `MessagingNotSupportedError` (kafka). All
  three are `instanceof`-checkable, following the resilience-plugin `TimeoutError` precedent.
- **Why:** A caller must distinguish a timeout from a remote failure from an unsupported transport
  without string-matching. The timeout timer is cleared and the pending entry deleted on both
  resolve and reject (no leak).
- **Test home:** timeout, remote-throw, and unsupported-throw assertions named in §6.

## 4. Exported surface — every symbol names its consumer

| Exported symbol              | Kind                     | Consumer / real code path that READS it                                                   |
| ---------------------------- | ------------------------ | ----------------------------------------------------------------------------------------- |
| `IMessageBroker.request`     | method (common)          | App code doing brokered RPC; each broker implements it.                                   |
| `IMessageBroker.respond`     | method (common)          | App code registering a responder; each broker implements it.                              |
| `RequestOptions`             | type (common)            | `request()` signature; read by `RequestReplyCore` for `timeoutMs`.                        |
| `RequestHandler<TReq,TRes>`  | type (common)            | `respond()` signature; wrapped by each broker's respond path.                             |
| `RequestTimeoutError`        | class (messaging-plugin) | Thrown by `RequestReplyCore`; caught via `instanceof` by consumers and asserted in tests. |
| `RemoteHandlerError`         | class (messaging-plugin) | Thrown by `RequestReplyCore` on a serialized remote error; consumer `instanceof`.         |
| `MessagingNotSupportedError` | class (messaging-plugin) | Thrown by `KafkaBroker.request/respond`; asserted in tests, caught by consumers.          |

<!-- DESIGN CORRECTION (verified during implementation): `common` exports NO runtime Error classes
     (resilience-plugin/src/errors.ts, cqrs-plugin/src/errors/ set the precedent — service errors
     live in the plugin). So the three error classes live in `packages/messaging-plugin/src/errors.ts`
     and are exported from the plugin barrel; `common` gains only the two TYPES + the interface
     methods. common barrel (packages/common/src/index.ts) re-exports the two types;
     messaging-plugin/src/index.ts re-exports those two types from common AND exports the three
     error classes from ./errors.ts. -->

### 4.1 Options — every option names its consumer

| Option                     | Consumer           | Behavior (per implementation)                                                                                                                                                      |
| -------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RequestOptions.timeoutMs` | `RequestReplyCore` | Reply wait budget; on expiry rejects with `RequestTimeoutError` and deletes the pending entry. Defaults to `5000` when omitted. Honored identically by every reply-capable broker. |

<!-- No new MessagingPluginOptions field: the reply inbox name is derived internally via runtime.uuid();
     no option would have a consumer, so none is added (CLAUDE.md dead-option rule). -->

## 5. Implementation files

| File                                                            | Purpose                                                                                                                                                        |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/services/messaging.ts`                     | Add `request`/`respond` to `IMessageBroker`; add `RequestOptions`, `RequestHandler` (types only — no error classes; see §4 correction).                        |
| `packages/messaging-plugin/src/errors.ts`                       | The three error classes (`RequestTimeoutError`, `RemoteHandlerError`, `MessagingNotSupportedError`), per the resilience/cqrs plugin-owns-its-errors precedent. |
| `packages/common/src/index.ts`                                  | Barrel re-export of the two types + three errors.                                                                                                              |
| `packages/messaging-plugin/src/brokers/request-reply-core.ts`   | Shared `RequestReplyCore` + internal `IReplyTransport` seam (NOT exported from index.ts).                                                                      |
| `packages/messaging-plugin/src/brokers/in-memory-broker.ts`     | Implement `request`/`respond` over an in-process transport.                                                                                                    |
| `packages/messaging-plugin/src/brokers/redis-streams-broker.ts` | Reply-stream transport.                                                                                                                                        |
| `packages/messaging-plugin/src/brokers/rabbitmq-broker.ts`      | `replyTo`/`correlationId` property transport + exclusive reply queue.                                                                                          |
| `packages/messaging-plugin/src/brokers/nats-broker.ts`          | JetStream reply-subject transport.                                                                                                                             |
| `packages/messaging-plugin/src/brokers/kafka-broker.ts`         | `request`/`respond` throw `MessagingNotSupportedError`.                                                                                                        |
| `packages/messaging-plugin/src/index.ts`                        | Export the three error classes from `./errors.ts`; re-export `RequestOptions`/`RequestHandler` from common.                                                    |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                | src covered               | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                              |
| -------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/request-reply-core.test.ts`                   | `request-reply-core.ts`   | Correlation match resolves with responder value; `timeoutMs` expiry rejects `RequestTimeoutError` AND pending map empty (no leak); late reply after timeout dropped (short-circuit); remote error → `RemoteHandlerError`. Driven by a fake `IReplyTransport`. |
| `test/unit/in-memory-broker.test.ts`                     | `in-memory-broker.ts`     | `request('t', req)` resolves with `respond('t', h)` return value; `respond` handler typed `(TReq,meta)=>TRes`.                                                                                                                                                |
| `test/unit/redis-streams-broker.test.ts`                 | `redis-streams-broker.ts` | Round-trip over fake ioredis reply stream; correlationId field written and matched.                                                                                                                                                                           |
| `test/unit/rabbitmq-broker.test.ts`                      | `rabbitmq-broker.ts`      | `channel.publish` called with `replyTo`+`correlationId` properties; reply queue consumed resolves the request.                                                                                                                                                |
| `test/unit/nats-broker.test.ts`                          | `nats-broker.ts`          | JetStream reply subject round-trip over fake nats; resolves.                                                                                                                                                                                                  |
| `test/unit/kafka-broker.test.ts`                         | `kafka-broker.ts`         | `request()` and `respond()` each throw `MessagingNotSupportedError`.                                                                                                                                                                                          |
| `test/integration/messaging-integration.test.ts`         | plugin wiring             | Resolve `CAPABILITIES.MESSAGING`, drive `request`/`respond` end-to-end on in-memory; a named instance also exposes the methods.                                                                                                                               |
| guarded REAL-import tests (per broker, existing pattern) | external client paths     | One reply round-trip on the real client, guarded/skipped when the dep is absent (logger-plugin/M9 precedent).                                                                                                                                                 |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/14c-messaging-request-reply, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # ANSI-stripped per-file table; >=90% branch/function/line every src file
```

## 8. Risks & mitigations

- **Widening a committed interface breaks external implementers.** Any test double or downstream
  package implementing `IMessageBroker` (not just consuming it) must gain the two methods → compile
  error. Mitigation: grep the repo for `implements IMessageBroker` /
  `implements MessageBrokerAdapter` before implementing; update the five brokers and every test fake
  in the same PR; the `EventsMessagingBridge` only CONSUMES a broker, so it is unaffected.
- **Reply inbox lifecycle leaks (streams/queues/consumers).** Each broker opens a per-instance inbox
  at first `request`/`respond`; it must be torn down in `disconnect()`. Mitigation: reuse the
  existing `#activeConsumers` / `#pollIntervals` teardown paths; add an inbox-cleanup assertion to
  each broker test.
- **Redis reply-stream unbounded growth.** Reply entries accumulate. Mitigation: XACK + trim replies
  after dispatch; assert the reply stream is drained in the unit test.
- **Kafka users expect parity.** A thrown `MessagingNotSupportedError` may surprise. Mitigation: the
  error message names reply-capable brokers; PUBLIC_API.md documents the limitation explicitly.

## 9. Out of scope

- Direct point-to-point typed RPC (HTTP/2 / Connect protocol over the kernel catch-all), `.proto`
  codegen, gRPC wire interop — owned by the future **Connect plugin** milestone, which also retires
  the README `🚧 Planned` gRPC row.
- Kafka brokered request-reply — deferred; ships as a tested throw in this milestone.
- Streaming replies (server-streaming RPC) — not part of the request-reply contract; revisit with
  the Connect plugin.
