# Milestone 143m — Messaging lane (`@setu-ts/messaging-plugin`, `@setu-ts/queue-plugin`, `@setu-ts/realtime-backplane-plugin`)

> **Status:** Decided (maintainer, 2026-11-25: D1–D11 as recommended, every confirmation item
> confirmed, both departures from M143p accepted); implementation by Codex. Branch:
> `feat/m143m-broker-queue-bounds`, cut from `develop` `7d3b5cf21` (M143p merged, #616). `develop`
> and `main` are protected; all work (implementation and fixes) stays on this one branch until it
> merges through a single PR into `develop`. Lane: Messaging, second in its lane after M143p. Ships
> in `0.14.0`. Codex implements; Claude plans, reviews and verifies.

## 0. Objective & scope

Every publish, request, enqueue and probe on every broker and queue arm ends within a bound and is
classified: `504` for an outcome the caller cannot know, `503` for an outage, never a bare `500`.
Today a Service Bus publish has no bound and fails as a masked `500`; an RPC with no reply, a remote
handler failure and a RabbitMQ enqueue during an outage are masked `500`s; no SQS call has a bound
and the SQS adapter has no reachability probe although the documentation says it has; a consume-only
Service Bus service never reports a dead broker; a crashed Service Bus requester leaves its reply
subscription for ever; a Pub/Sub boot fails on a missing topic without naming it, and the
dead-letter topic check that M143p added has no bound of its own; the queue job loop logs every tick
of an outage; the queue readiness cache, SQS retry spacing and SQS polling are fixed with no
setting; Service Bus consumer concurrency is fixed at 1; the `custom` broker arm is one clause of
documentation and a trace cannot cross it; the outbox relay's ceiling and its delivery latency are
undocumented and nothing warns; and an injected Redis pair can hold the backplane's start for ever.

- **In scope (16 rows):** V13-8, V13-10, V13-38, V13-54, V13-117, V13-118, V13-120, V13-215 (SQS
  half), V13-220 (SQS half), V13-259, V13-262, V13-263, V13-265, V13-267, V13-268, and one new row,
  **V13-271** (§0.2). Halves of rows owned elsewhere: V13-43 (owned by M143i, the backplane half),
  V13-216 (owned by M143r, the SQS and SNS half). Docs: the three package READMEs and agent cards,
  `PUBLIC_API.md`, `CHANGELOG.md`, `docs/upgrading.md`, `docs/health-indicators.md` row 5.
- **NOT this milestone:** the SES half of V13-215 and every non-SQS half of V13-216 (M143r, #614);
  the Workers half of V13-220 (`WorkersQueue.retryDelaySeconds`, M143o); the Workers half of V13-117
  (`CloudflareRequestTimeoutError` and `CloudflareRemoteHandlerError` in `cloudflare-plugin` carry
  no status: assigned to M143o by the maintainer, 2026-11-25, with D1's statuses, §11); an
  after-commit hook in `database-plugin` that would let the outbox dispatch itself (Data lane, §11);
  every CLI and template change (CLI lane); documentation-only rows (M143n).

### 0.1 Rows, their reproduction read, and where each is fixed

The reads are from the source at `develop` `7d3b5cf21`, and the smoke reports under
`~/Projects/hono-enterprise-published-smoke/v0.13.0/part28/x121` and `x122`, plus
`smoke/V0130-CLAIMS-VALIDATION.md`, `V0130-REDRIVE.md` and `X96-X103-FINDINGS.md` in the
maintainer's smoke folder.

| Row                    | Today (file:line) and why the symptom follows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Decision     | Test home                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------- |
| **V13-117**            | `RequestTimeoutError` (`messaging-plugin/src/errors.ts:68-73`) and `RemoteHandlerError` (`:112-121`) carry no status hint, so `errorHandler` (`exceptions/src/middleware/error-handler.ts:219-235`) masks them as `500`. Both are thrown only by `RequestReplyCore` (`brokers/request-reply-core.ts:187`, `:349`), which every broker shares. `PublishTimeoutError` carries `504` (`errors.ts:97-101`).                                                                                                                                                                                                     | §3.1         | `rpc-error-status.test.ts`                                                              |
| **V13-118**            | `RabbitMqQueue#bounded` throws a plain `Error` on expiry (`queue-plugin/src/adapters/rabbitmq-queue.ts:544-558`), and the not-connected guard (`:688`), the confirm failure (`:245`) and the closed-before-confirm path (`:250`) throw plain `Error`s too. `QueueService.add` classifies through `toBackendFault` (`services/queue-service.ts:287-297`), whose table (`common/src/errors/backend-fault.ts:196-237`) knows none of them, so the caller gets a `500`.                                                                                                                                         | §3.2         | `rabbitmq-enqueue-faults.test.ts`                                                       |
| **V13-259**            | `ServiceBusBroker.publishWithHeaders` awaits `transport.send` with no deadline (`brokers/service-bus-broker.ts:1114-1138`, send at `:1127`, adapter `sendMessages` at `:595`) and rethrows the SDK error unchanged (`:1135`). The SDK attempt timeout is 60 s with 3 retries 30 s apart (`@azure/core-amqp` `dist/commonjs/util/constants.js:76,101,103`), and an exhausted retry throws `AggregateError` (`retry.js` ~280-290). `ServiceBusOptions` has no `publishTimeoutMs` (`:272-310`); the plugin validates `publishTimeoutMs` for five arms but not this one (`plugin/messaging-plugin.ts:170-178`). | §3.3         | `service-bus-publish-bound.test.ts`                                                     |
| **V13-262**            | `receiver.subscribe(..., { autoCompleteMessages: false })` (`service-bus-broker.ts:614-663`, options at `:662`) passes no `maxConcurrentCalls`, so the SDK default of 1 applies; no option exposes it. The README ordering row describes `maxConcurrentCalls: 2` (`messaging-plugin/README.md:87`).                                                                                                                                                                                                                                                                                                         | §3.4         | `service-bus-concurrency.test.ts`                                                       |
| **V13-263**            | `#openReplyInbox` creates `rr-inbox-<uuid>` with `createSubscription(replyTopic, inboxSub)` and no options (`service-bus-broker.ts:857-860`); only a clean `close` deletes it (`:885-890`). The transport port already takes `{ autoDeleteOnIdleMs }` (`:229-233`, translated at `:694-720`), which the fan-out path passes as an inline `300000` (`:1199`).                                                                                                                                                                                                                                                | §3.5         | `service-bus-reply-inbox.test.ts`                                                       |
| **V13-267**            | `processError` only logs (`service-bus-broker.ts:657-660`). Reachability turns `false` only on a failed `send` without a numeric `statusCode` (`isDataPlaneNetworkFailure`, `:473-479`, recorded at `:1132-1134`) or a management probe answering 404/410 (`:400-415`), so a service that never publishes stays `up`.                                                                                                                                                                                                                                                                                       | §3.6         | `service-bus-receiver-health.test.ts`                                                   |
| **V13-268**            | `adaptPubSubModule.open` rethrows any create failure but `ALREADY_EXISTS` raw (`brokers/pubsub-broker.ts:634-641`); `#openConsumer` wraps it only when a dead-letter target is configured and `topicExists(target)` says the DEAD-LETTER topic is missing (`:1370-1386`); otherwise the raw `5 NOT_FOUND` escapes and names neither topic nor subscription. Kafka names its topic (`KafkaTopicUnavailableError`, `errors.ts:463-487`, thrown at `kafka-broker.ts:943-944`).                                                                                                                                 | §3.7         | `pubsub-missing-topic.test.ts`                                                          |
| **V13-271** (new)      | `#openConsumer` awaits `transport.topicExists(target)` with no bound (`pubsub-broker.ts:1379`); the adapter calls `topic.exists()` (`:729-734`), which takes no call options (`@google-cloud/pubsub` `build/src/topic.js:152-163`), so the gax default applies: 60 s per attempt, retried up to 600 s (`@google-cloud/pubsub-api@0.7.0` `build/src/v1/publisher_client_config.json`, `GetTopic`). Its sibling `topicHasSubscriptions` is bounded at 1,500 ms (`:1421-1425`). CodeRabbit's unanswered finding on setu-ts/setu-ts#616.                                                                        | §3.7         | `pubsub-missing-topic.test.ts`                                                          |
| **V13-265**            | `asBrokerAdapter` returns the instance unchanged only when all six of `isReady`, `reachability`, `isHealthy`, `publishWithHeaders`, `subscribeWithHeaders`, `requestWithHeaders` are functions (`brokers/custom-adapter.ts:37-47`), members of the unexported `MessageBrokerAdapter` (`brokers/message-broker.ts:40-84`); then no publish option is validated. Otherwise the wrapper's `publishWithHeaders` drops the framework headers (`custom-adapter.ts:77-85`), so `traceparent` never reaches the transport. `TracedBroker` injects and extracts it (`tracing/traced-broker.ts:52-76`, `:86-110`).    | §3.8         | `custom-broker-contract.test.ts`                                                        |
| **V13-38**             | `#poll` reports a reserve failure through the untracked `#report` at `error` with a stack, every tick, per name (`queue-plugin/src/services/queue-service.ts:623-631`, `#report` `:162-181`); the poll-loop catch does the same (`:563-571`), and so does `queue recurring enqueue failed` (`:809`). The once-per-state tracker `#loopFailed`/`#loopRecovered` (`:187-224`) is used only by the recurring loop (`:573-584`) and the depth probe (`:539-547`).                                                                                                                                               | §3.9         | `queue-loop-reporting.test.ts`                                                          |
| **V13-120**            | `PROBE_TTL_MS = 5000` and `PROBE_TIMEOUT_MS = 2000` are module constants (`queue-service.ts:38`, `:41`) used only by `#buildProbe` (`:486-501`); `createCachedProbe` caches every outcome, failures included (`common/src/health/probe.ts:188-191`). `QueuePluginOptions` has no health member (`interfaces/index.ts:233-414`).                                                                                                                                                                                                                                                                             | §3.10        | `queue-probe-options.test.ts`                                                           |
| **V13-215** (SQS half) | `adaptSqsModule` returns no `isHealthy` (`adapters/sqs-queue.ts:193-293`), so `SqsQueue.isHealthy` exists only for an injected transport (`:331-338`, `#installProbe` `:457-465`) and the SDK path reads `reachable: 'unknown'`. `docs/health-indicators.md:48` and `CHANGELOG.md:8582-8583` claim a `GetQueueAttributes` probe.                                                                                                                                                                                                                                                                            | §3.11        | `sqs-reachability.test.ts`, `sqs-probe-poll-localstack.test.ts` (new, guarded)          |
| **V13-216** (SQS half) | No SQS or SNS call has a bound except the redrive reads, which use an inline 10,000 ms (`adapters/sqs-redrive.ts:65-89`). `send` (`sqs-queue.ts:514`), `receive` (`:571`), `delete` (`:653`), `changeVisibility` (`:669`, renewal `:885-888`) and `SnsPublisher` (`sns/sns-publisher.ts:86-110`) are unbounded, and the client is built with only `region`, `credentials`, `endpoint` (`sqs-queue.ts:197-201`). `@smithy/node-http-handler` defaults `requestTimeout` to 0, "no timeout".                                                                                                                   | §3.12        | `sqs-request-bound.test.ts`, `sns-publisher.test.ts` (extended)                         |
| **V13-220** (SQS half) | `computeBackoffMs` (`retry/retry-strategy.ts:12-45`) is called with no base or cap (`processors/job-processor.ts:162`), for every adapter; nothing configures it. `ReceiveMessage` carries no `WaitTimeSeconds` (`sqs-queue.ts:221-227`), and `#poll` awaits each name's reserve in turn (`queue-service.ts:590-649`), so a long poll on one name would hold every name after it.                                                                                                                                                                                                                           | §3.13, §3.14 | `retry-delay-option.test.ts`, `sqs-long-poll.test.ts`, `queue-poll-concurrency.test.ts` |
| **V13-8**              | The relay walks rows one at a time, three awaited round-trips each (`outbox/relay.ts:602-609`, `examine` `:375-555`); a sweep stops at `publishLimit` (default 100, `outbox/options.ts:177`) and nothing re-sweeps a full one (`endedBy` is only stored, `outbox-service.ts:380`); the scheduler runs it every `intervalMs` (1,000 ms, `plugin/messaging-plugin.ts:862-864`) and skips an overlapping tick. So the ceiling is at most `publishLimit` per `intervalMs`, lower when the serial cost of 100 rows exceeds the interval. Nothing logs a backlog (`outbox-health.ts:149-155` only reports).       | §3.15        | `outbox-relay-saturation.test.ts`                                                       |
| **V13-10**             | No code calls `outbox.dispatch()` after a commit (no after-commit hook exists: `database-plugin/src/services/database-service.ts:337-340`), and the README calls the call optional (`messaging-plugin/README.md:1199-1200`) without its cost.                                                                                                                                                                                                                                                                                                                                                               | §3.16        | `pnpm run check:docs` and the fence gate                                                |
| **V13-54**             | On the injected pair, `connect()` awaits `client.connect()` and `subscriber.subscribe(topic)` with no bound (`transports/redis-backplane.ts:254-266`, `:403-406`); `commandTimeoutMs` is read only on the lazy path (`interfaces/index.ts:257-262`), and `waitForReady` runs only when the pair is owned (`:330-338`). The bare `subscribe` cannot be cancelled even by `close()` (`:407-416` is the only cancellable branch).                                                                                                                                                                              | §3.17        | `injected-pair-connect.test.ts`                                                         |
| **V13-43** (half)      | `register` awaits `backplane.connect()` (`plugin/realtime-backplane-plugin.ts:130`) before registering its close hook (`:173-178`) and never reads `ctx.signal`. The kernel half (M143i, #611) aborts `IPluginContext.signal` (`common/src/plugin.ts:575-585`) on a stop during start and runs a late `onClose` at once (`kernel/src/lifecycle/lifecycle-manager.ts:144-150`); M143i hands over "registers its close hook before connecting and passes `ctx.signal` to the connect wait" (`plans/archive/milestone-143i-process-and-runtimes.md:614-615`).                                                  | §3.17        | `backplane-start-cancel.test.ts`                                                        |

None failed to reproduce from source. V13-259, V13-262, V13-263 and V13-267 are re-driven on the
Service Bus emulator, V13-268 and V13-271 on the Pub/Sub emulator, and V13-215, V13-216 and V13-220
on LocalStack, in the guarded suites of §6.

### 0.2 The new row

**V13-271 (Low, `messaging-plugin` (`pubsub`)).** The dead-letter topic check M143p added on the
Pub/Sub subscription create path, `topicExists`, has no bound: the gax default holds it up to 600 s
on a hung `GetTopic`, inside `app.start()`. Found by CodeRabbit on setu-ts/setu-ts#616 and left
unanswered; still unbounded at `7d3b5cf21`. The register row is added to `smoke/DEFECTS.md` by the
coordinator with this text (the smoke folder is the maintainer's, not this branch's).

### 0.3 Compared with

Every default below cites one of these rows. The sources were read on 2026-11-25 on each project's
default branch or official documentation; "not found" means the cell was searched for in a primary
source and nothing was found. The surveys' condensed sources are in the shared notes folder
(`m143m-framework-survey.md`).

| #   | Question                                    | This repo's siblings                                                                                                                                                 | Frameworks (primary sources)                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Status of an RPC that gets no reply         | `PublishTimeoutError` 504 (`errors.ts:97-101`); Redis publish faults 503/504 through `toBackendFault`                                                                | Moleculer `RequestTimeoutError` code 504, a remote handler error code 500 (`src/errors.js`); NATS answers `503` "no responders" at the protocol level (`core/src/nats.ts:241`); Dapr folds an invocation failure into 500 (`pkg/messages/predefined.go:71`); MassTransit `RequestTimeoutException` and `RequestFaultException` carry no status; NServiceBus callbacks have no timeout of their own                         |
| 2   | A Service Bus publish bound                 | every other arm: `publishTimeoutMs` 15,000 ms, `0` disables (`brokers/publish-timeout.ts:4-22`)                                                                      | SDK: 60 s per attempt, 3 retries 30 s apart, only a caller `abortSignal` bounds the whole call (`service-bus/src/core/messageSender.ts:169-171`); Spring Cloud Azure producer `sendTimeout` 10,000 ms (`ServiceBusProducerProperties.java:23-24`); Dapr `timeoutInSec` 60 (`metadata.go:82`); MassTransit sets SDK retries only (`HostSettings.cs:15-17`); NServiceBus not found                                           |
| 3   | Service Bus consumer concurrency default    | RabbitMQ `prefetch` 32 (`rabbitmq-broker.ts:96-104`); Redis Streams fixed at one; Kafka, NATS, Pub/Sub no option                                                     | JS and Java SDKs `maxConcurrentCalls` 1 (`service-bus/src/models.ts` ~246-252), so Spring Cloud Azure 1; MassTransit `max(ProcessorCount*2, 16)` (`TransportConfiguration.cs:44,63`); NServiceBus `max(processors, 2)` (tuning docs); Dapr unlimited (`metadata.go:95`). Where ordering is mentioned, it is kept by sessions, one handler per session                                                                      |
| 4   | A crashed instance's reply subscription     | NATS inbox consumer reaped after 5 min (`nats-leaked-consumers.ts`); Service Bus fan-out `autoDeleteOnIdle` 5 min (`service-bus-broker.ts:1199`, `:1205`)            | MassTransit `TemporaryAutoDeleteOnIdle` 5 minutes (`AzureServiceBusTransport/Defaults.cs:15-16`); NServiceBus never auto-deletes instance queues (`TimeSpan.MaxValue`); Azure: minimum 5 minutes, a receive counts as activity even when empty (message-expiration docs)                                                                                                                                                   |
| 5   | Health of a consume-only service            | Pub/Sub reports a closed stream as unreachable (`pubsub-broker.ts:990-994`)                                                                                          | MassTransit: the receive endpoint's own `Faulted` event makes it Unhealthy (`HealthResultReceiveEndpointObserver.cs:59,69-82`); Spring Cloud Azure: the processor's error callback makes it DOWN, UP again after 2 error-free minutes (`ServiceBusMessageChannelBinder.java:316`); Dapr and NServiceBus: no runtime signal                                                                                                 |
| 6   | Pub/Sub missing topic                       | Kafka names topic and group (`errors.ts:463-487`)                                                                                                                    | Spring Cloud GCP `ProvisioningException("Non-existing '<topic>' topic.")` (`PubSubChannelProvisioner.java:126-141`); Dapr "could not get valid topic - topic:%q" (`pubsub/gcp/pubsub/pubsub.go:270-296`); Google: `NOT_FOUND` "If the corresponding topic doesn't exist" (REST reference)                                                                                                                                  |
| 7   | Bound of a Pub/Sub admin call               | `topicHasSubscriptions` 1,500 ms; the health `getTopics` `gaxOpts { timeout: 1500, retry: null }` (`pubsub-broker.ts:577`, `:1421-1425`)                             | gax default for `GetTopic`, `CreateSubscription`, `ListTopicSubscriptions`: 60 s per attempt, 600 s total (nodejs-pubsub `main`, `src/v1/*_client_config.json`); `topic.exists()` takes no call options, `getMetadata(gaxOpts)` does (`src/topic.ts:401-471`)                                                                                                                                                              |
| 8   | A transport the application writes, tracing | first-party brokers carry `traceparent` through the internal header channel (`traced-broker.ts`)                                                                     | MassTransit injects and extracts in shared send and receive code, so any transport that round-trips headers is traced (`LogContextActivityExtensions.cs:65-100`, `ReceivePipeDispatcher.cs:53`); Dapr's runtime writes `traceparent` into the CloudEvent, the component only carries bytes; Spring Cloud Stream's function wrapper does not cross the broker, each binder propagates itself; OTel semconv names no carrier |
| 9   | A fetch loop during an outage: logging      | recurring loop and depth probe: once per state change at `warn`, recovery at `info` (`queue-service.ts:187-224`, X88-9)                                              | Sidekiq: first failure only, recovery logged with downtime (`processor.rb:91-120`); Celery: every retry at error, recovery at info (`consumer.py:466-470,691-696`); Spring Cloud AWS, NServiceBus SQS, AWS .NET: every failure at error, no visible recovery line; BullMQ: library logs nothing                                                                                                                            |
| 10  | Probe result caching                        | queue, messaging, outbox and backplane probes: 5 s cache, 2 s bound, fixed                                                                                           | Spring Boot `management.endpoint.health.cache.time-to-live`, default 0, caches DOWN too (`CachingOperationInvoker.java:57-87`); Microsoft HealthChecks: no cache, publisher `Delay` 5 s and `Period` 30 s configurable; no fixed non-configurable TTL found anywhere                                                                                                                                                       |
| 11  | An SQS reachability probe                   | Redis `PING`, RabbitMQ a throw-away channel (`redis-queue.ts:389-410`, `rabbitmq-queue.ts:453-484`)                                                                  | Xabaril `SqsHealthCheck` calls `GetQueueUrl` per configured queue (`SqsHealthCheck.cs:20-44`); Spring Cloud AWS, MassTransit, NServiceBus have no SQS probe; `GetQueueAttributes` on a missing queue answers `QueueDoesNotExist`, HTTP 400 (API reference)                                                                                                                                                                 |
| 12  | AWS call bound                              | M143r: `requestTimeoutMs` on every AWS arm, whole call including SDK retries, `withDeadline` plus `send(cmd, { abortSignal })`; storage 30 s, secrets 5 s, mail 15 s | JS SDK v3 and Java SDK v2: no overall timeout by default (`node-http-handler.ts:33-37`; Java timeouts docs); .NET SDK 100 s; a JS caller needs an `abortSignal` per call                                                                                                                                                                                                                                                   |
| 13  | SQS long-poll default                       | none (short poll every `pollIntervalMs`)                                                                                                                             | NServiceBus 20 s hard-coded (`InputQueuePump.cs:105-121`); AWS .NET 20 s, range 0-20 (`SQSMessagePollerConfiguration.cs:18-42`); Spring Cloud AWS `pollTimeout` 10 s; Celery/Kombu 10 s; MassTransit 3 s; Shoryuken leaves it to the queue. AWS: maximum 20 s, short polling is the service default, long polling "helps reduce the cost"                                                                                  |
| 14  | Retry spacing of a failed job               | `computeBackoffMs` 1 s doubling to 30 s, fixed, every adapter; M143o: `WorkersQueue.retryDelaySeconds`, number or function of the attempt                            | BullMQ per-job `backoff`; Sidekiq `sidekiq_retry_in`; Shoryuken `retry_intervals` (array or callable, `exponential_backoff_retry.rb:43-96`); Spring Cloud AWS `ExponentialBackoffErrorHandler` opt-in; MassTransit redelivery 1 s; NServiceBus 5 immediate then 10, 20, 30 s                                                                                                                                               |
| 15  | Outbox relay delivery and backlog           | relay every 1 s, at most 100 rows a sweep, serial rows; health reports `pending`, oldest age, reason after 60 s                                                      | MassTransit wakes the relay on commit and loops with no delay while rows remain (`BusOutboxNotification.cs`, `BusOutboxDeliveryService.cs` ~75-90); NServiceBus, Wolverine and Spring Modulith dispatch on commit and poll only to recover; no surveyed framework documents a throughput ceiling or warns on a growing backlog                                                                                             |
| 16  | Backplane start with an application's Redis | the plugin's own pair waits at most `commandTimeoutMs` (15 s) for ready                                                                                              | Socket.IO Redis adapter, SignalR Redis and ActionCable do not wait at start; phoenix_pubsub_redis waits once, bounded by Redix's 5 s connect timeout, then reconnects in the background; no surveyed backplane fails the start                                                                                                                                                                                             |

## 1. Contracts verified from SOURCE (not names)

| Reference                                               | Source (file:line)                                                                                                           | Verified surface / fact                                                                                                                                                              |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `withHttpStatusHint`, `httpStatusHintOf`                | `packages/common/src/errors/status-hint.ts:141-149`, `:175`                                                                  | Defines a non-enumerable `Symbol.for('setu.http.status-hint')` member `{ status, title, detail }`; `errorHandler` serves the hint's own detail and skips masking                     |
| `BackendUnavailableError`, `BackendOutcomeUnknownError` | `packages/common/src/errors/backend-fault.ts:85-147`                                                                         | `constructor(source: string, options: { cause: unknown })`; hints 503 "The request was not applied." and 504; `toBackendFault` returns an instance of these unchanged (`:280-288`)   |
| `toBackendFault` table                                  | `packages/common/src/errors/backend-fault.ts:196-262`                                                                        | Walks `.cause` only (depth 5), never `AggregateError.errors`; knows no Azure or AWS shape                                                                                            |
| `withDeadline`, `deadlineRangeError`                    | `packages/common/src/health/deadline.ts:77-85`, `:118`                                                                       | `0` returns the plain call; range 0 to 2,147,483,647                                                                                                                                 |
| `createCachedProbe`                                     | `packages/common/src/health/probe.ts:137-195`                                                                                | Options `ttlMs` (default 5000), `timeoutMs` (2000), `fallback`; caches every outcome including the fallback                                                                          |
| `IPluginContext.signal?`                                | `packages/common/src/plugin.ts:575-585`                                                                                      | Aborted with `StartCancelledError` when `stop()` runs during `start()`; the kernel always sets it                                                                                    |
| Late `onClose` after a cancelled start                  | `packages/kernel/src/lifecycle/lifecycle-manager.ts:100-150`                                                                 | After `cancelRegistrations`, `onClose` runs the hook at once                                                                                                                         |
| `IRealtimeBackplane.connect()`                          | `packages/common/src/services/realtime.ts:116`                                                                               | Takes no arguments; not changed by this plan (no `common` change, §3.17)                                                                                                             |
| `MessageMetadata.headers`                               | `packages/common/src/services/messaging.ts:389-401`                                                                          | Optional delivered headers; first-party brokers set `{}` when none                                                                                                                   |
| `RESERVED_HEADER_NAMES`                                 | `packages/common/src/services/messaging.ts:99-109`                                                                           | Includes `traceparent`, `tracestate`: a caller header of that name is refused by `parsePublishOptions` (`:305-307`), so tracing cannot ride on caller options                        |
| `MessageBrokerAdapter`                                  | `packages/messaging-plugin/src/brokers/message-broker.ts:40-84`                                                              | `publishWithHeaders(topic, message, headers, options?)`, `subscribeWithHeaders`, `requestWithHeaders(topic, message, headers, options?)`, `isReady`, `reachability`; internal        |
| `asBrokerAdapter`                                       | `packages/messaging-plugin/src/brokers/custom-adapter.ts:28-107`                                                             | Six-member bypass at `:37-47`; wrapper validates through `validatePublishOptions` (`:78`, `:84`) and drops headers                                                                   |
| `RequestReplyCore` timeout                              | `packages/messaging-plugin/src/brokers/request-reply-core.ts:32`, `:187`, `:349`                                             | Default `timeoutMs` 5,000; the two throw sites                                                                                                                                       |
| Service Bus port                                        | `packages/messaging-plugin/src/brokers/service-bus-broker.ts:60-79`, `:150-154`, `:220-233`, `:563-596`, `:610-663`          | `IServiceBusSubscribeOptions` already types `maxConcurrentCalls` (`:79`); `createSubscription(topic, sub, { autoDeleteOnIdleMs? })`; `send` caches a sender per topic                |
| Service Bus SDK send                                    | `@azure/service-bus@7.10.0` `dist/esm/sender.d.ts:43`, `dist/esm/modelsToBeSharedWithEventHubs.d.ts:8`                       | `sendMessages(messages, options?: OperationOptionsBase)`, which carries `abortSignal`; the signal is passed into `retry`                                                             |
| Service Bus consumer retry hold                         | `service-bus-broker.ts:1253-1323`; `brokers/consumer-retry.ts:109-117`                                                       | A failing message holds its `processMessage` call for the retry delay (defaults `[1000, 5000, 30000, 120000]`), so it occupies one concurrency slot                                  |
| Pub/Sub port                                            | `pubsub-broker.ts:364`, `:372`, `:622-741`, `:1351-1444`                                                                     | `topicExists?`, `topicHasSubscriptions?`; `open` create path and catch; the 15,000 ms terminal forward literal at `:1194` (M143p decision 7)                                         |
| Pub/Sub SDK `Topic`                                     | `@google-cloud/pubsub` `build/src/topic.js:152-199`                                                                          | `exists()` has no call options and maps code 5 to `false`; `getMetadata(gaxOpts?)` accepts `CallOptions`                                                                             |
| Kafka topic precedent                                   | `messaging-plugin/src/errors.ts:463-487`; `kafka-broker.ts:934-947`                                                          | `KafkaTopicUnavailableError(topic, groupId, cause)`, readonly `topic`, `groupId`                                                                                                     |
| `QueueService` loop and probe                           | `queue-plugin/src/services/queue-service.ts:38-41`, `:162-224`, `:423-501`, `:563-650`                                       | As in §0.1; `QueueLogger` `{ error, warn?, info? }` (`:50-57`), wired by `resolveLogger` (`plugin/queue-plugin.ts:509-515`)                                                          |
| Retry spacing                                           | `queue-plugin/src/retry/retry-strategy.ts:12-45`; `processors/job-processor.ts:162`                                          | `computeBackoffMs(attempts, base = 1000, max = 30000)`, base·2^(attempts-1)                                                                                                          |
| `SqsQueueOptions`, `ISqsTransport`                      | `queue-plugin/src/adapters/sqs-queue.ts:87-170`                                                                              | Members as in §0.1; `getQueueAttributes?`, `getQueueUrl?` added by M143p; `SQS_MAX_RECEIVE` 10 (`:33`)                                                                               |
| Redrive read bound                                      | `queue-plugin/src/adapters/sqs-redrive.ts:65-89`                                                                             | Inline 10,000 ms `withDeadline`; M143p hands it to this letter's SQS bound (archived M143p plan §11)                                                                                 |
| `SnsPublisher`                                          | `queue-plugin/src/sns/sns-publisher.ts:48-110`, `:199-249`                                                                   | Options `runtime`, `telemetry`, `topicArn`, `region`, `credentials`, `endpoint`, `client?`; no bound                                                                                 |
| RabbitMQ queue publish                                  | `queue-plugin/src/adapters/rabbitmq-queue.ts:150-170`, `:245-250`, `:544-558`, `:686-709`                                    | `DEFAULT_PUBLISH_TIMEOUT_MS` 15,000; the four plain `Error`s of §0.1                                                                                                                 |
| Outbox options and relay                                | `messaging-plugin/src/outbox/options.ts:57-215`; `relay.ts:173-207`, `:375-615`; `outbox-service.ts:223-251`, `:341-389`     | As in §0.1; `dispatch()` coalesces one running and one follow-up sweep; `OutboxSweepResult.endedBy` values                                                                           |
| Outbox health                                           | `messaging-plugin/src/outbox/outbox-health.ts:34-179`                                                                        | Reasons `oldest-pending-age`, `failed-rows`, `failed-scan-cap`, `blocked-key-cap`, `store-write-failing`, `relay-overlap`; status stays `up`                                         |
| Backplane redis transport                               | `realtime-backplane-plugin/src/transports/redis-backplane.ts:127-144`, `:250-338`, `:403-416`, `:701-745`                    | Injected pair path, owned-pair `waitForReady` with `BackendUnavailableError`, `#openWait` cancellation                                                                               |
| Backplane plugin                                        | `realtime-backplane-plugin/src/plugin/realtime-backplane-plugin.ts:90-178`                                                   | Order in §0.1; health indicator always `up` with `reachable`                                                                                                                         |
| Health readiness override                               | `packages/health-plugin/src/interfaces/index.ts:158-166`                                                                     | `readiness.include` / `exclude` by indicator name: the way out for an app that does not want a consumer's broker in readiness                                                        |
| M143r bound shape                                       | `feat/m143r-provider-arms` at `8020ab9bf`, `plans/archive/milestone-143r-provider-arms.md` §3.1, lines 91-123                | `requestTimeoutMs`; whole call including SDK retries; `0` disables; `RangeError` through `deadlineRangeError`; expiry → `BackendOutcomeUnknownError`; probe reachable below HTTP 500 |
| M143o retry shape                                       | `feat/m143o-workers-realtime-queues-bindings` at `47e85f628`, `cloudflare-plugin/src/queues/workers-queue.ts:47`, `:116-120` | `RetryDelaySeconds = number \| ((attempts: number) => number)`, bounded, a throwing function warns once and retries without a delay                                                  |
| No new capability token                                 | `packages/common/src/tokens.ts:438`                                                                                          | Checked: this letter adds none                                                                                                                                                       |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                      | Resolution (picked side)                                                                                          | Doc deliverable (same PR)                                                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| C1  | `docs/health-indicators.md:48` claims the queue probe issues `GetQueueAttributes`; the SDK path has no probe                                                                                  | The code changes (§3.11) so the row becomes true; the row names the call and the down rule                        | Row 5 of `docs/health-indicators.md` (only this row: #614 edits rows 3-4) |
| C2  | `CHANGELOG.md:8582-8583` (M70c, released) lists a `GetQueueAttributes` probe                                                                                                                  | A released entry is history and is not edited; the `0.14.0` Fixed entry says the probe now exists on the SDK path | `CHANGELOG.md` `[Unreleased]` Fixed                                       |
| C3  | `ISqsTransport.isHealthy` JSDoc says "the SDK adapter has no reachability probe" (`sqs-queue.ts:135-143`, `:331-338`)                                                                         | The code changes; both comments are rewritten                                                                     | JSDoc in `sqs-queue.ts`                                                   |
| C4  | `messaging-plugin/README.md:87` describes Service Bus at `maxConcurrentCalls: 2`, which no application could set                                                                              | The option now exists (§3.4); the row stays and names the option                                                  | README ordering table and "Service Bus retries" section                   |
| C5  | `README.md:1199` "Optional: request a sweep now" vs the measured cost (up to `intervalMs` of latency)                                                                                         | The README states the cost and calls `dispatch()` after the transaction in every example (§3.16)                  | README "Transactional outbox", "The relay"                                |
| C6  | `realtime-backplane-plugin` `commandTimeoutMs` JSDoc and README (`interfaces/index.ts:257-262`, `README.md:123`, `:225-228`) say it applies only on the lazy path                             | The code changes (§3.17) so it also bounds the injected pair's connect wait; the text is rewritten                | JSDoc, README options table                                               |
| C7  | The README says a reply subscription lasts until a clean stop; the new auto-delete changes that (`ReplyInboxUnavailableError`'s JSDoc describes only a creation failure and is unchanged, C6) | Code changes (§3.5); the README states the 5-minute crash cleanup                                                 | README request-reply section                                              |

## 3. Design decisions

Each decision below is the plan's recommendation. Those marked **(open, D<n>)** are held for the
maintainer in §12 with their comparison and impact; the rest follow from a sibling or a settled rule
and are listed in §12 for confirmation only.

### 3.1 RPC errors carry a status (V13-117, open D1)

- **Decision:** `RequestTimeoutError` gets the hint
  `{ status: 504, title: 'Gateway Timeout', detail: 'No reply arrived in time; the request may have been handled.' }`.
  `RemoteHandlerError` gets
  `{ status: 502, title: 'Bad Gateway', detail: 'The service that handled the request failed.' }`;
  the remote message stays on `remoteMessage` and is never in the response body. Both are set in the
  constructors through `withHttpStatusHint`, the `PublishTimeoutError` pattern.
  `RequestTimeoutError` gains readonly `topic` and `timeoutMs`, set by `RequestReplyCore` at `:187`
  (constructor `(message?, details?)` stays source-compatible).
- **Why:** Compared with, row 1: Moleculer is the one framework that stamps codes and uses 504 for a
  timeout; a 502 tells the client the fault was upstream, where a masked 500 tells it nothing. An
  RPC timeout is an outcome the caller cannot know (the responder may have run), the same contract
  as `PublishTimeoutError`.
- **Impact on upgrade:** a client that saw `500` sees `504` or `502`. An application that catches
  the classes is unaffected. Way out: catch and rethrow its own error, which `errorHandler` serves
  as before (`error-handler.ts:219`: an `HttpError` is never re-hinted).
- **Test home:** `rpc-error-status.test.ts` (hint fields on both classes; a kernel app whose route
  calls `request()` on the in-memory broker with no responder answers 504 with the Problem Details
  fields, and `remoteMessage` absent from the body when the responder throws).

### 3.2 A RabbitMQ enqueue fault is classified (V13-118)

- **Decision:** `RabbitMqQueue.enqueue` throws `common`'s classes itself, source
  `queue-plugin: rabbitmq enqueue`, the original error as `cause`, for six paths:
  1. the publish deadline (`#bounded`, `:544-558`) → `BackendOutcomeUnknownError`;
  2. not connected (`:688`) → `BackendUnavailableError`;
  3. a new explicit guard: `#supervisor.faulted` true at entry → `BackendUnavailableError` (today
     the call goes on to a closed channel);
  4. a synchronous throw from `channel.publish` (amqplib `IllegalOperationError('Channel closed')`,
     `amqplib@0.10.9 lib/channel.js:155-156`, `:373`; the outage path, because `#channel` keeps the
     closed channel until `#reconnect` replaces it, `:609-644`, and asserts are cached) and a
     rejected `#assertQueues` → `BackendUnavailableError` (nothing was written);
  5. a broker nack → `BackendUnavailableError` (the broker refused: not applied);
  6. a channel closed after the write and before the confirm → `BackendOutcomeUnknownError`.
     `publishConfirmed` (`:240-257`) settles paths 5 and 6 through one wrapper today; it is split so
     the nack and the close reject with distinct internal reasons. `QueueService.add` already passes
     these through (`toBackendFault` returns them unchanged).
- **Why:** the Redis sibling answers 503/504 through the same classes; the messaging publish
  answers 504. A RabbitMQ nack is a definite refusal, a lost confirm is not.
- **Impact on upgrade:** a client that saw `500` sees `503` or `504`; nothing to change.
- **Test home:** `rabbitmq-enqueue-faults.test.ts` (fake channel and supervisor: each of the six
  paths, class and source; one route through a kernel app with `@setu-ts/exceptions`' `errorHandler`
  answers 503 and 504, which adds `@setu-ts/exceptions` as a `devDependency` of `queue-plugin`).

### 3.3 A Service Bus publish is bounded and classified (V13-259, open D2)

- **Decision:** both Service Bus arms (`ServiceBusMessagingOptionsInjected` and `…Production`, and
  `ServiceBusOptions`) gain `publishTimeoutMs`, default `15000`, `0` disables, validated by
  `resolvePublishTimeoutMs` (the plugin adds `service-bus` to its construction check,
  `messaging-plugin.ts:170-178`). `publishWithHeaders` creates an `AbortController`, passes its
  signal to `transport.send` (the port's `send` gains `options?: { abortSignal?: AbortSignal }`,
  forwarded to `sendMessages(message, { abortSignal })`), and runs the call in `withDeadline`; on
  expiry it aborts the signal, records negative data-plane evidence, and throws
  `PublishTimeoutError`. The bound covers the SDK's own retries.

  A failure that is not the bound is classified by one internal predicate,
  `isServiceBusOutage(error)` in the new `service-bus-faults.ts`, because a `ServiceBusError`
  carries `code` and `retryable` and never a numeric `statusCode` (`service-bus@7.10.0`
  `dist/commonjs/serviceBusError.js:44-75`; core-amqp `MessagingError`): an outage is an
  `AggregateError` (several attempts failed, core-amqp `retry.js` ~280-290), an error with
  `retryable === true`, a `code` in `{ ServiceCommunicationProblem, ServiceTimeout, ServiceBusy }`,
  or an error with neither `code` nor `retryable` (a raw socket error). An outage →
  `BackendOutcomeUnknownError('messaging-plugin: service-bus publish', { cause })`, because a
  retried send may have been delivered (X122-2: all three "failed" messages arrived afterwards).
  Everything else (`retryable === false` with another code: `MessagingEntityNotFound`,
  `UnauthorizedAccess`, `MessageSizeExceeded`, `QuotaExceeded`, …) is a refusal and is rethrown
  unchanged, as today. When the outage is an `AggregateError`, its `cause` is a new `Error` whose
  message is the last inner error's message and whose own `cause` is the `AggregateError`, so the
  log names the fault (`BackendOutcomeUnknownError`'s own message is fixed,
  `backend-fault.ts:136-139`). The same predicate replaces `isDataPlaneNetworkFailure` (`:473-479`)
  for the send-side evidence, which today counts every Service Bus refusal as a network failure
  because none carries a `statusCode` (an existing defect of the same shape, fixed here, named in
  the CHANGELOG).

- **Why:** Compared with, row 2: every sibling arm defaults to 15 s; the SDK alone allows about 5.5
  minutes; Spring Cloud Azure bounds the send at 10 s. The abort signal makes the bound real: the
  SDK stops retrying instead of sending after the caller gave up.
- **Impact on upgrade:** a publish that used to take longer than 15 s now rejects with
  `PublishTimeoutError` (`504`), and an outage that was a masked `500` is a `504`. Way out:
  `publishTimeoutMs: 0` restores today's unbounded call, or a larger value. `retryOptions` keeps its
  meaning inside the bound.
- **Test home:** `service-bus-publish-bound.test.ts` (fake sender that never settles: rejection at
  the bound, signal aborted, `0` waits; the predicate's table as data, built from real
  `ServiceBusError` instances of the installed SDK: each outage shape → 504 with the inner message,
  each refusal code unchanged and recording no evidence; range refusal at construction for both
  arms); `service-bus-outage-control.test.ts` (§3.19: a paused emulator gives `PublishTimeoutError`
  within the bound).

### 3.4 Service Bus consumer concurrency (V13-262, open D3)

- **Decision:** both Service Bus arms gain `maxConcurrentCalls`, default `1`, an integer from 1 to
  1,000 (refused with `RangeError` outside). The seam:
  `IServiceBusTransport.open(topic, sub, onMessage, options?)` gains an optional fourth parameter
  `{ maxConcurrentCalls?: number; onReceiveError?: (error: unknown, errorSource: string) => void }`,
  which `adaptServiceBusModule.open` (a module-level function that cannot reach the broker's private
  members, `:552-663`) passes to `receiver.subscribe` and calls from `processError`. The broker
  passes `maxConcurrentCalls` on every application subscription, including backplane fan-out
  subscriptions, and not on the reply inbox (`:867`), which stays 1; it passes `onReceiveError` on
  all of them (§3.6). An injected transport that ignores the parameter keeps concurrency 1 and
  reports no receive errors, as today. The README ordering row states: order is kept only at 1;
  above 1 a later message may be handled first, realtime frames included; a consumer-retry hold
  occupies one slot for its delay (about 156 s at the defaults), so a subscription with failing
  messages needs `maxConcurrentCalls` above 1 to keep up (the M143p hand-over).
- **Why:** Compared with, row 3: the SDKs and Spring default to 1, which keeps the README's ordering
  claim; MassTransit, NServiceBus and Dapr default to parallel. Keeping 1 changes nothing for a
  running application.
- **Impact on upgrade:** none. An application that needs throughput sets the option.
- **Test home:** `service-bus-concurrency.test.ts` (the option reaches `subscribe`; the inbox does
  not get it; range refusal); `service-bus-outage-real.test.ts` (guarded: at 4, four handlers
  overlap).

### 3.5 A crashed requester's Service Bus reply subscription expires (V13-263)

- **Decision:** `#openReplyInbox` creates `rr-inbox-<uuid>` with `{ autoDeleteOnIdleMs: 300000 }`,
  the Azure minimum; one named constant `SERVICE_BUS_MIN_AUTO_DELETE_ON_IDLE_MS` replaces the inline
  value in the fan-out path too. A clean stop still deletes the subscription.
- **Why:** Compared with, row 4: MassTransit's temporary endpoints use 5 minutes; Azure counts a
  receive as activity even when it returns nothing, so a live requester keeps it.
- **Impact on upgrade:** none for a running requester. A crashed one's subscription is gone within 5
  idle minutes.
- **Test home:** `service-bus-reply-inbox.test.ts` (the option on the create call; delete on close
  unchanged); `service-bus-outage-real.test.ts` (guarded, M143p's capability-probe rule, C3: the
  test first creates a probe subscription with `PT5M` and reads it back; when the backend returns
  the maximum timespan, as the emulator does, the test records "autoDeleteOnIdle not honoured by
  this backend" and asserts only that the request carried `PT300S`; where it is honoured, the read
  back must be five minutes. Expiry itself is not waited for, §8).

### 3.6 A consume-only Service Bus service reports a dead broker (V13-267, open D4)

- **Decision:** the broker's `onReceiveError` callback (§3.4's seam; the log line in `processError`
  stays) records negative data-plane evidence (the existing `#recordDataPlaneOutcome(false)`) when
  `isServiceBusOutage(error)` (§3.3) is true and `errorSource` is `'receive'` (the SDK's union is
  `'abandon' | 'complete' | 'processMessageCallback' | 'receive' | 'renewLock'`, `models.d.ts:22` in
  7.10.0), and a delivered message records positive evidence. A deleted subscription or a revoked
  key (`MessagingEntityNotFound`, `UnauthorizedAccess`, not retryable) is not an outage and does not
  mark the broker down. Recovery is the existing path: positive evidence, or the management probe
  answering `true`, clears it.
- **Why:** Compared with, row 5: MassTransit and Spring Cloud Azure both use the consumer's own
  error callback, with no extra probe; Pub/Sub in this repo already reports a closed stream. The
  evidence store exists; only the receive side never fed it.
- **Impact on upgrade:** a consume-only service turns not-ready while its receiver cannot reach the
  namespace. Way out: `HealthPlugin({ readiness: { exclude: ['messaging'] } })` keeps it in rotation
  (`health-plugin/src/interfaces/index.ts:158-166`).
- **Test home:** `service-bus-receiver-health.test.ts` (an outage-shaped `ServiceBusError` from a
  receive makes `reachability()` false; a refusal code and a `'complete'` or `'renewLock'` source do
  not; a delivery clears it; the adapter forwards `processError` to `onReceiveError`);
  `service-bus-outage-control.test.ts` (§3.19: emulator stopped, `/ready` 503 within one probe
  period).

### 3.7 A missing Pub/Sub topic is named, and the dead-letter check is bounded (V13-268, V13-271, open D5)

- **Decision:**
  1. New exported `PubSubTopicMissingError(topic, subscription, cause)`, readonly `topic` and
     `subscription`, message naming both and saying to create the topic (the Kafka precedent).
  2. In `#openConsumer`'s catch, on the create path only (not `attachedFailure`, `:1371-1376`, where
     a code 5 from `sub.getMetadata()` means the subscription vanished), a create failure with gRPC
     code 5 becomes that error, after the existing dead-letter check: a configured dead-letter
     target that `topicExists` reports missing still gives `PubSubDeadLetterTopicMissingError`; when
     the dead-letter check is `true`, rejects, times out, or is absent, code 5 gives
     `PubSubTopicMissingError`, whose message also names the dead-letter topic as a possible cause
     when one is configured and was not proved to exist. Any other code is rethrown unchanged. This
     amends M143p's rule "the create's original error is rethrown unchanged" for code 5 only; the
     original stays as `cause`.
  3. `topicExists` is bounded at 1,500 ms by `withDeadline`, the bound of its sibling
     `topicHasSubscriptions`, and the adapter implements it with
     `topic.getMetadata({ timeout: 1500, retry: null })` (code 5 → `false`, other errors reject),
     because `exists()` takes no call options. A timeout counts as "rejecting" in step 2.
  4. One named constant `PUBSUB_ADMIN_READ_TIMEOUT_MS = 1500` replaces the three inline `1500`s
     (`:577`, `:1421-1425`, the new call).
- **Why:** Compared with, rows 6 and 7: Spring Cloud GCP and Dapr name the topic; gax would hold the
  check up to 600 s.
- **Impact on upgrade:** a boot that failed with the raw gRPC error fails with the named one; the
  code is on `cause.code`. Nothing else changes.
- **Test home:** `pubsub-missing-topic.test.ts` (code 5 with no dead-letter target, with one that
  exists, with one missing, with a check that hangs past the bound under a fake clock, with no
  `topicExists`; a code other than 5 unchanged; the adapter's `getMetadata` call options);
  `pubsub-emulator.test.ts` (guarded: subscribe to an absent topic names it).

### 3.8 The `custom` broker contract (V13-265, open D6)

- **Decision:** one exported interface, `ICustomMessageBroker extends IMessageBroker`, with two
  optional members of the internal adapter's signatures:
  `publishWithHeaders?(topic, message, headers, options?)` and
  `requestWithHeaders?(topic, request, headers, options?)`. `headers` is the framework's channel
  (`traceparent`, `tracestate`); the instance must deliver them to the consumer as
  `MessageMetadata.headers`, which is all the consumer span needs. `CustomMessagingOptions.instance`
  is typed `ICustomMessageBroker`. `asBrokerAdapter` always wraps: it validates the caller's options
  with `validatePublishOptions` first, then calls `publishWithHeaders` when present and `publish`
  otherwise (dropping the framework headers, as today, and warning once that traces will not cross
  this broker); the same for `requestWithHeaders`. The six-member bypass is deleted. `isHealthy`
  feeds reachability as today; `subscribe` options (including `fanOut`) pass through, and the
  instance sets `ISubscription.fanOut` itself (the M143p hand-over). A README section "Writing a
  custom broker" states this contract, health, RPC and fan-out, and an example compiles in the fence
  gate.
- **Why:** Compared with, row 8: MassTransit and Dapr inject and extract trace context in the
  framework, so any transport that round-trips headers is traced; that is what `TracedBroker`
  already does once the header channel reaches the instance. Caller headers cannot carry it:
  `traceparent` is reserved (§1), and a custom broker that delegates to a first-party broker's
  public `publish` would refuse it.
- **Impact on upgrade:** an instance that implemented all six internal members keeps producer-side
  tracing through `publishWithHeaders`, whose signature is unchanged, and now has its caller options
  validated, so a caller header of a reserved name is refused as on every other arm. Two of its
  members are no longer called: its own `reachability()` (which could answer "unknown") is replaced
  by the `isHealthy`-derived boolean (`custom-adapter.ts:59-65`), and its `subscribeWithHeaders` by
  `subscribe`, so the consumer span joins the trace only when `subscribe` fills `metadata.headers`.
  An instance with none of the members behaves as today and gets one warning.
- **Test home:** `custom-broker-contract.test.ts` (with and without each member; the reserved header
  refused in both; `traceparent` delivered and the consumer span parented through a kernel app with
  the telemetry test host; the warning once); `custom-adapter.test.ts` (existing): its bypass
  assertion (`:18`) is inverted.

### 3.9 Queue loop failures are reported once per episode (V13-38)

- **Decision:** a reserve failure goes through the tracker under the key `reserve:<name>`: the first
  failure logs `queue reserve failed` at `warn` with `{ name, error }` (no stack), later ones are
  silent, and the first successful reserve for that name logs `queue reserve recovered` at `info`.
  The poll-loop catch (`:563-571`, key `poll`) and the recurring enqueue failure (`:809`, key
  `recurring-enqueue:<name>`) use the tracker the same way. The tracker's message is parameterised
  so these keep their own texts. Each episode's failure count is in the recovery line.
- **Why:** Compared with, row 9: the X88-9 rule already in this service, which matches Sidekiq
  (first failure, recovery with downtime) and Celery (a recovery line); the frameworks that log
  every failure at error give no recovery signal.
- **Impact on upgrade:** an alert on `queue reserve failed` at `error` now sees it at `warn`, once.
  Named in `docs/upgrading.md`.
- **Test home:** `queue-loop-reporting.test.ts` (existing, extended: three failing ticks → one warn;
  recovery → one info with the count; two names tracked apart; the recurring path; a reserve aborted
  by `disconnect` reports nothing, §3.14).

### 3.10 Queue probe cache and bound are options (V13-120)

- **Decision:** `QueuePluginOptions.health?: { probeCacheMs?: number; probeTimeoutMs?: number }`,
  defaults 5,000 and 2,000 (today's values), `probeCacheMs: 0` probes on every read, both validated
  (0 to 2,147,483,647 and 1 to 2,147,483,647, `RangeError`). Read by `#buildProbe`. Failures stay
  cached for the same TTL, as Spring does.
- **Why:** Compared with, row 10: Spring makes the TTL a setting; no surveyed library has a fixed
  one. The outbox's `health` sub-object is the naming precedent.
- **Impact on upgrade:** none.
- **Test home:** `queue-probe-options.test.ts` (each value reaches `createCachedProbe`; `0` probes
  every read; range refusals).

### 3.11 The SQS adapter has a reachability probe (V13-215, SQS half)

- **Decision:** `SqsQueue` (which holds the queue map; `adaptSqsModule` receives only region,
  credentials and endpoint, `:193-201`) installs `isHealthy()` whenever its transport has
  `getQueueAttributes`, so the SDK path now has one: `GetQueueAttributes(url, ['QueueArn'])` for
  every distinct URL in `queues` in parallel (not `deadLetterQueues`, which M143p's preparation
  already reads). Each call has its own bound, `SQS_PROBE_CALL_TIMEOUT_MS = 1500`, below the probe's
  default `probeTimeoutMs` of 2,000 (the Pub/Sub admin-read precedent, §3.7), with SDK retries off
  for that call (`adaptSqsModule` gives the probe its own client with `maxAttempts: 1`), so a hung
  endpoint resolves `false` before the cached probe's own bound turns it into `unknown`
  (`probe.ts:162-176`, mapped to `up` at `queue-service.ts:441-443`). `isHealthy` catches every
  failure and resolves a boolean, never rejects. Down when any call fails on the network, hits its
  bound, answers HTTP 500 or above, or answers `QueueDoesNotExist`; reachable when every call
  answered below 500 otherwise (an access refusal is an answer, M143r §3.9's rule). The probe passes
  no abort signal (`createCachedProbe` gives `probe()` none); its own call bound is what ends it.
  The cache of §3.10 still applies. `docs/health-indicators.md` row 5 and both JSDoc comments are
  corrected (C1, C3).
- **Why:** Compared with, row 11: Xabaril probes every configured queue; a missing queue makes the
  consumer useless, so it is down (the smoke run left `/ready` 200 with the queue deleted).
  `GetQueueAttributes` is the call the docs already name, and consumers already need its right since
  M143p.
- **Impact on upgrade:** `/ready` now reports an SQS outage or a missing queue. Way out: the health
  plugin's `readiness.exclude`.
- **Test home:** `sqs-reachability.test.ts` (fake transport: each outcome, including a call that
  never settles, which reads `down` within 1,500 ms under a fake clock, and a rejecting call that
  resolves `false`); `sqs-probe-poll-localstack.test.ts` (guarded: a deleted queue reads down).

### 3.12 Every SQS and SNS call is bounded and classified (V13-216, SQS half)

- **Decision:** `SqsQueueOptions.requestTimeoutMs` and `SnsPublisherOptions.requestTimeoutMs`,
  default `15000`, `0` disables, `RangeError` through `deadlineRangeError`, M143r's name and
  semantics: the whole call including SDK retries, `withDeadline` with the runtime's timers plus
  `client.send(command, { abortSignal })`. It bounds every command: send, receive (whose bound is
  `waitTimeSeconds × 1000 + requestTimeoutMs`, capped at 2,147,483,647, §3.14; C4), delete, change
  visibility and SNS publish. The redrive reads use it too, but they run inside `app.start()` (M143p
  D9), so they keep a finite floor: `min(requestTimeoutMs, 10000)`, and `10000` when
  `requestTimeoutMs` is `0`, the M143p decision-7 rule that a start-path or terminal call keeps a
  finite bound even when the option is disabled; at the default the read bound stays 10 s. An
  injected `ISqsTransport` is bounded by the race alone, and its methods gain an optional trailing
  `{ abortSignal }`. When `SnsPublisherOptions.runtime` is absent (it is optional,
  `sns-publisher.ts:49-50`), `withDeadline` uses the ambient timers (`deadline.ts:51-58`).

  Faults, an internal `toSqsFault(error, source)` in `sqs-faults.ts`, M143r's `toMailError` ordering
  verbatim: (1) an expired bound → `BackendOutcomeUnknownError`; (2) `toBackendFault(error)` (its
  in-flight codes such as ECONNRESET already answer 504); (3) a 503 from step 2 becomes 504 when
  `$metadata.attempts > 1` (an earlier attempt may have been applied; `@smithy/core` sets
  `$metadata.attempts` even on a failure with no response); (4) otherwise an HTTP 5xx or a
  throttling answer → `BackendUnavailableError`, with the same attempts upgrade to 504; (5) anything
  else is rethrown unchanged. `SqsQueue.enqueue`, `SnsPublisher.publish` and
  `SnsPublisher.publishJob` throw the result, so `queue.add` and a publish answer 503 or 504.

- **Why:** Compared with, row 12: the JS SDK has no bound at all; M143r chose this shape for every
  other AWS arm, and the SQS default matches its queue siblings (RabbitMQ `publishTimeoutMs` and
  Redis `commandTimeoutMs`, 15 s).
- **Impact on upgrade:** an SQS or SNS call that took longer than 15 s now fails (a send as 504, a
  receive as a reported reserve failure). Way out: `requestTimeoutMs: 0` or larger.
- **Test home:** `sqs-request-bound.test.ts` (each command under a hung fake with a fake clock; the
  signal aborted; the classification table as data); `sns-publisher.test.ts` (extended).

### 3.13 Retry spacing is an option (V13-220, open D7)

- **Decision:** `QueuePluginOptions.retryDelayMs?: number | ((attempts: number) => number)`, the
  shape of M143o's `retryDelaySeconds` in this plugin's unit (every other queue duration option is
  in ms). Absent, today's `computeBackoffMs(attempts + 1)` applies unchanged
  (`job-processor.ts:161-162`). A number is the delay for every retry; a function receives the
  attempt that just failed (1 on the first delivery, as on M143o) and returns ms. A non-finite or
  negative number is refused at construction. A function that throws or returns a non-finite value
  retries with no delay and warns once, M143o's rule; a result is clamped to 0 and `MAX_TIMER_MS`
  (2,147,483,647). The option is threaded from `QueuePlugin` through `QueueService` into `runJob`'s
  options; the warn goes through the `QueueLogger.warn` channel (falling back to `error`), which
  `runJob`'s options gain beside its existing `report` (`job-processor.ts:140`). On SQS the delay is
  still clamped to the visibility left (`sqs-queue.ts:657-675`).
- **Why:** Compared with, row 14: BullMQ, Sidekiq and Shoryuken make it configurable, Shoryuken with
  the same number-or-callable shape; one plugin option rather than an SQS-only one, because the
  backoff is computed above the adapters and is fixed on all four.
- **Impact on upgrade:** none.
- **Test home:** `retry-delay-option.test.ts` (number, function, throwing function, refusal; the
  value reaches `requeue` on memory and SQS fakes).

### 3.14 SQS long polling, and per-name reserves that do not wait for each other (V13-220, open D8)

- **Decision:** `SqsQueueOptions.waitTimeSeconds`, an integer 0 to 20, default **20**, sent as
  `WaitTimeSeconds` on every receive (`ISqsTransport.receive` gains an optional `waitTimeSeconds`).
  Because a long poll holds its reserve, `QueueService.#poll` starts each name's prepare-and-reserve
  as its own task without awaiting the previous one (the existing `reserveInProgress` flag still
  stops a second reserve for the same name), so one name's long poll never delays another. Each
  task:
  1. has its own `catch`, which reports through the §3.9 tracker (the `#poll().catch` at `:564-569`
     no longer sees it);
  2. reads `now` when its reserve starts, not once per tick (`:587`);
  3. after `reserve` settles, checks `#connected` and that `this.#generation` is the generation the
     task started under; if not, it reports nothing (a receive aborted by `disconnect` is not an
     outage) and dispatches nothing: the jobs it returned are left unsettled, so SQS redelivers them
     after the visibility timeout and the other adapters after their lease, as after a crash;
  4. is tracked in a set that `QueueService.disconnect` awaits after it bumps the generation, with
     `SqsQueue.disconnect` aborting every in-flight receive through its signal first, so `stop()` is
     not held for 20 s, and an injected transport that ignores the signal holds `stop()` at most
     until its receive returns. `0` restores short polling.
- **Why:** Compared with, row 13: AWS recommends long polling for cost; NServiceBus and the AWS .NET
  framework use the 20 s maximum; the smoke run counted 240 receives in 40 s for six names.
- **Impact on upgrade:** fewer receive calls; a message is received as soon as it arrives rather
  than at the next tick. A transport injected through `client` that ignores the new parameter keeps
  short polling. Way out: `waitTimeSeconds: 0`.
- **Test home:** `sqs-long-poll.test.ts` (the parameter on the command; abort on disconnect; range
  refusal); `queue-poll-concurrency.test.ts` (a reserve that never settles on one name does not stop
  another name's reserve; one reserve per name at a time; a reserve that resolves after `disconnect`
  dispatches nothing and reports nothing; `disconnect` waits for the tasks; on memory and Redis
  fakes too); `sqs-probe-poll-localstack.test.ts` (guarded: a message published during a wait is
  received within 1 s).

### 3.15 The outbox relay's ceiling is documented, warned about, and lifted when a sweep is full (V13-8, open D9)

- **Decision:** A sweep is **full** when it ends with `endedBy: 'publish-limit'` and
  `failures === 0`: `publish-limit` alone is not enough, because `budget.attempted` counts a claim
  before its publish (`relay.ts:446`, and poisoned rows at `:409`), so during a broker outage every
  sweep of a large backlog ends on `publish-limit` with every publish failed.
  1. When any sweep (scheduled, dispatched or a follow-up) is full, the service starts one follow-up
     sweep at once through the existing `#followUp` coalescing, and keeps doing so while sweeps are
     full and the service is not closing. A sweep with a failure is never followed up: the existing
     backoff governs it. With `relay.schedule: false` the chain still runs after each `dispatch()`,
     since a dispatched sweep can be full too; the scheduler tick, when on, runs as before.
  2. The first full sweep after one that was not logs once at `warn`:
     `outbox relay is at its sweep budget` with `{ publishLimit, intervalMs }`; the first sweep
     after it that completes its lap logs `outbox relay caught up` at `info`. A sweep with failures
     neither logs the warning nor ends the episode.
  3. The README "The relay" section states the ceiling: rows are published one at a time, each with
     a claim, a publish and a mark; a sweep publishes at most `publishLimit` rows; with step 1 the
     rate is bounded by the serial cost of a row, not by `intervalMs`.
- **Why:** Compared with, row 15: MassTransit loops with no delay while rows remain; no surveyed
  framework warns on a backlog, so step 2 has no analogue (it is one log line on a state change, the
  queue loop's rule).
- **Impact on upgrade:** during a backlog the relay runs back to back until it drains. The extra
  store work is one claim and one mark per delivered row, the cost of delivering the backlog; a
  sweep with any failure is never followed up. There is no switch, as MassTransit's delivery loop
  has none (C5).
- **Test home:** `outbox/outbox-relay-saturation.test.ts` (150 rows with `publishLimit` 100 drain in
  two sweeps without a second tick; one warn and one info; a rejecting broker ends each sweep on
  `publish-limit` with failures and starts no follow-up and no warning; `schedule: false` with
  `dispatch()`; closing stops the chain).

### 3.16 Outbox delivery latency is documented (V13-10, open D10)

- **Decision:** documentation only in this letter: the README says a row written without
  `dispatch()` waits up to `intervalMs` (default 1 s) and at most `publishLimit` rows go per sweep,
  and every example calls `outbox.dispatch()` after the transaction resolves, without "Optional". An
  after-commit hook that would let the plugin call it itself needs a `database-plugin` change (Data
  lane) and is handed over (§11).
- **Why:** Compared with, row 15: NServiceBus, Wolverine, Spring Modulith and MassTransit all
  deliver on commit; this plugin cannot see the commit without that hook.
- **Impact on upgrade:** none.
- **Test home:** `pnpm run check:docs` and the fence gate.

### 3.17 The backplane's start is bounded and cancellable (V13-54, V13-43 half, open D11)

- **Decision:**
  1. `register` registers its `onClose` hook before `connect()`. The hook closes the backplane
     always, and detaches the observer and closes the collector only when they exist (both are
     created after `connect()`, `realtime-backplane-plugin.ts:136-149`, so the hook reads them
     through variables that start unset). On a cancelled start the kernel runs `runClose()` from
     `#start`'s catch while `register()` is still pending
     (`kernel/src/application/application.ts:619-646`, `:688-704`), so this early hook is what
     closes the backplane and ends the pending `connect()`; no separate `ctx.signal` listener is
     added. After `connect()` settles, `register()` checks `ctx.signal?.aborted` and, when set,
     returns without registering the service, the health indicator or the diagnostics source.
  2. On the injected pair, `connect()` bounds `client.connect()` and the first `subscribe` together
     by `commandTimeoutMs` (default 15,000, `0` unbounded), the bound the owned pair already uses,
     and fails as `waitForReady` does (`redis-backplane.ts:739-743`): source
     `realtime-backplane-plugin: redis transport`, with an `Error` naming the injected client and
     the bound as `cause`; the `subscribe` wait is made cancellable by `close()` on both branches
     (`settledUnlessCancelled`, as the `0` branch already does).
  3. On the `messaging` transport, `close()` during `connect()` makes `connect()` reject (today it
     only bumps the generation); no new bound there, the broker's subscribe owns its own (§8). No
     `common` change: `ctx.signal` already exists and `connect()` keeps its signature.
- **Why:** Compared with, row 16: Phoenix bounds its wait at 5 s; the others do not wait. Failing
  the start after the bound is this plugin's existing rule for its own pair, so the injected pair
  now behaves like it.
- **Impact on upgrade:** an injected pair that took longer than 15 s to connect now fails the start.
  Way out: `commandTimeoutMs: 0`, or connect the clients before `app.start()`.
- **Test home:** `injected-pair-connect.test.ts` (hung `connect`, hung `subscribe`, `0` waits,
  `close()` ends both); `backplane-start-cancel.test.ts` (kernel app: `stop()` during a hung start
  closes the clients and ends `connect()`, no socket is left, and nothing is registered after it).

### 3.18 Documentation

- **Decision:** messaging README (Service Bus options table with `publishTimeoutMs` and
  `maxConcurrentCalls`, publish bounds list including Service Bus, reply-inbox cleanup, receiver
  health, Pub/Sub missing-topic error, "Writing a custom broker", outbox relay ceiling and
  `dispatch()` latency, RPC statuses); queue README (SQS `requestTimeoutMs`, `waitTimeSeconds`,
  probe, `retryDelayMs`, `health`, loop logging); backplane README (`commandTimeoutMs` on the
  injected pair, start cancellation); the three agent cards (every option named exists);
  `PUBLIC_API.md` for every symbol in §4; `CHANGELOG.md` one entry; `docs/upgrading.md` one section
  with each impact above; `docs/health-indicators.md` row 5. If M143o has merged first, the README
  sentence that `WorkersBroker` drops the producer's `traceparent` (`README.md:1590-1592`) is
  re-checked against its code and removed if false (M143o hand-over), and `queue-plugin/README.md`'s
  "dead-lettered by every adapter" wording is made to allow `deadLetterQueues: { name: false }`
  (M143o C3).
- **Why:** CLAUDE.md: an export change updates `PUBLIC_API.md` in the same change.
- **Test home:** `pnpm run check:docs`, the fence gate, and the agent-card option test.

### 3.19 The two Service Bus outage tests (C2)

- **Decision:** the §3.3 paused-publish test and the §3.6 consume-only `/ready` test live in one new
  guarded suite, `service-bus-outage-control.test.ts`, which runs only when
  `SERVICE_BUS_EMULATOR_CONTAINER` names the emulator container (otherwise it skips, so CI and every
  other run never touch a container). The test pauses (§3.3) or stops (§3.6) that container through
  `docker` in a child process and, in a `finally`, unpauses or starts it again and waits until the
  emulator answers. The reviewer runs it alone, through `setu-suite-queue`, inside a shell `trap`
  that runs `docker unpause he-sb; docker start he-sb` on every exit, so the emulator comes back
  even when the test process is killed (maintainer decision C2, 2026-11-26).
- **Why:** the milestone gate proves a Part 26 row on the stand-in it was found on.
- **Test home:** that suite: a publish during the pause rejects with `PublishTimeoutError` within
  `publishTimeoutMs` (set to 3,000 ms); with the emulator stopped, a consume-only application's
  `/ready` answers 503 within one probe cache period, and 200 again after the restart.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** an `ICustomMessageBroker` that relied on the six-member bypass now
has its publish options validated, a custom `ISqsTransport` gains optional parameters only; ships in
minor 0.14.0.

| Exported symbol                                                             | Kind              | Consumer / real code path that READS it                                        |
| --------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------ |
| `PubSubTopicMissingError` (messaging)                                       | class             | Thrown by `GcpPubSubBroker#openConsumer`; applications `instanceof` it at boot |
| `ICustomMessageBroker` (messaging)                                          | interface         | Type of `CustomMessagingOptions.instance`; read by `asBrokerAdapter`           |
| `RequestTimeoutError.topic`, `.timeoutMs` (messaging)                       | readonly fields   | Set by `RequestReplyCore`; read by applications' error logs                    |
| `ServiceBusOptions.publishTimeoutMs`, `.maxConcurrentCalls`                 | option members    | §4.1                                                                           |
| `SqsQueueOptions.requestTimeoutMs`, `.waitTimeSeconds` (queue)              | option members    | §4.1                                                                           |
| `SnsPublisherOptions.requestTimeoutMs` (queue)                              | option member     | §4.1                                                                           |
| `QueuePluginOptions.health`, `.retryDelayMs` (queue)                        | option members    | §4.1                                                                           |
| `ISqsTransport` optional `{ abortSignal }` and `waitTimeSeconds` parameters | interface members | Called by `SqsQueue`; implemented by `adaptSqsModule`                          |

Exported transport ports that gain optional parameters (each read by the broker or adapter named,
and implemented by the module adapter): `IServiceBusTransport.send(..., options?: { abortSignal })`
and `.open(..., options?: { maxConcurrentCalls, onReceiveError })` (messaging, §3.3, §3.4, §3.6);
`IPubSubTransport.topicExists` keeps its signature and gains the bound in the broker (§3.7);
`ISqsTransport` methods' trailing `{ abortSignal }` and `receive`'s `waitTimeSeconds` (queue, §3.12,
§3.14); `SqsSdkModule.SQSClient`'s constructor type gains `maxAttempts` for the probe client
(§3.11). An existing implementation of any of these keeps compiling.

No other export changes. The status hints are not exports (a non-enumerable symbol member).

### 4.1 Options — every option names its consumer

| Option                                                      | Consumer                                                                                          | Behavior (per implementation)                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Service Bus `publishTimeoutMs`                              | `ServiceBusBroker.publishWithHeaders`                                                             | 15,000 default, `0` unbounded, both arms; the injected arm's own client is bounded the same way |
| Service Bus `maxConcurrentCalls`                            | `ServiceBusBroker` application `subscribe`                                                        | 1 default, 1-1,000; not the reply inbox                                                         |
| SQS `requestTimeoutMs`                                      | every `adaptSqsModule` command, `sqs-redrive.ts` (the probe has its own 1,500 ms per call, §3.11) | 15,000 default, `0` unbounded; race only on an injected transport                               |
| SQS `waitTimeSeconds`                                       | `adaptSqsModule.receive`                                                                          | 20 default, 0-20; an injected transport may ignore it                                           |
| SNS `requestTimeoutMs`                                      | `adaptSnsModule` publish                                                                          | as SQS                                                                                          |
| `QueuePluginOptions.health.probeCacheMs`, `.probeTimeoutMs` | `QueueService#buildProbe`                                                                         | 5,000 and 2,000; every adapter with a probe                                                     |
| `QueuePluginOptions.retryDelayMs`                           | `job-processor.ts` retry path                                                                     | every adapter; absent → `computeBackoffMs`                                                      |
| Backplane `commandTimeoutMs` (widened)                      | `RedisBackplane.connect` on both paths                                                            | 15,000 default, `0` unbounded                                                                   |

## 5. Implementation files

| File                                                                          | Purpose                                                                          |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/messaging-plugin/src/index.ts`                                      | Barrel: `PubSubTopicMissingError`, `ICustomMessageBroker`                        |
| `packages/messaging-plugin/src/errors.ts`                                     | Hints on the RPC errors, `RequestTimeoutError` fields, `PubSubTopicMissingError` |
| `packages/messaging-plugin/src/brokers/request-reply-core.ts`                 | Pass topic and bound to `RequestTimeoutError`                                    |
| `packages/messaging-plugin/src/brokers/service-bus-broker.ts`                 | §3.3-§3.6                                                                        |
| `packages/messaging-plugin/src/brokers/service-bus-faults.ts` (new)           | Internal: the publish fault classification of §3.3                               |
| `packages/messaging-plugin/src/brokers/pubsub-broker.ts`                      | §3.7                                                                             |
| `packages/messaging-plugin/src/brokers/custom-adapter.ts`                     | §3.8                                                                             |
| `packages/messaging-plugin/src/interfaces/index.ts`                           | Service Bus options, `ICustomMessageBroker`, `CustomMessagingOptions`            |
| `packages/messaging-plugin/src/plugin/messaging-plugin.ts`                    | Service Bus option forwarding and validation                                     |
| `packages/messaging-plugin/src/outbox/outbox-service.ts`                      | §3.15 follow-up and the two log lines                                            |
| `packages/queue-plugin/src/services/queue-service.ts`                         | §3.9, §3.10, §3.13 threading, §3.14                                              |
| `packages/queue-plugin/src/processors/job-processor.ts`                       | §3.13                                                                            |
| `packages/queue-plugin/src/adapters/rabbitmq-queue.ts`                        | §3.2                                                                             |
| `packages/queue-plugin/src/adapters/sqs-queue.ts`                             | §3.11, §3.12, §3.14                                                              |
| `packages/queue-plugin/src/adapters/sqs-faults.ts` (new)                      | Internal: `toSqsFault`                                                           |
| `packages/queue-plugin/src/adapters/sqs-redrive.ts`                           | Read the request bound instead of 10,000 ms                                      |
| `packages/queue-plugin/src/sns/sns-publisher.ts`                              | §3.12                                                                            |
| `packages/queue-plugin/src/interfaces/index.ts`, `src/plugin/queue-plugin.ts` | New options and their forwarding                                                 |
| `packages/realtime-backplane-plugin/src/plugin/realtime-backplane-plugin.ts`  | §3.17 step 1                                                                     |
| `packages/realtime-backplane-plugin/src/transports/redis-backplane.ts`        | §3.17 step 2                                                                     |
| `packages/realtime-backplane-plugin/src/transports/messaging-backplane.ts`    | §3.17 step 3                                                                     |
| `packages/realtime-backplane-plugin/src/interfaces/index.ts`                  | `commandTimeoutMs` JSDoc                                                         |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                  | src covered                                       | Key assertions                         |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------- |
| `messaging-plugin/test/unit/rpc-error-status.test.ts`                                                      | `errors.ts`, `request-reply-core.ts`              | §3.1                                   |
| `messaging-plugin/test/unit/service-bus-publish-bound.test.ts`                                             | `service-bus-broker.ts`, `service-bus-faults.ts`  | §3.3                                   |
| `messaging-plugin/test/unit/service-bus-concurrency.test.ts`                                               | `service-bus-broker.ts`, `messaging-plugin.ts`    | §3.4                                   |
| `messaging-plugin/test/unit/service-bus-reply-inbox.test.ts`                                               | `service-bus-broker.ts`                           | §3.5                                   |
| `messaging-plugin/test/unit/service-bus-receiver-health.test.ts`                                           | `service-bus-broker.ts`                           | §3.6                                   |
| `messaging-plugin/test/unit/pubsub-missing-topic.test.ts`                                                  | `pubsub-broker.ts`, `errors.ts`                   | §3.7                                   |
| `messaging-plugin/test/unit/custom-broker-contract.test.ts`                                                | `custom-adapter.ts`, `interfaces/index.ts`        | §3.8                                   |
| `messaging-plugin/test/unit/outbox/outbox-relay-saturation.test.ts`                                        | `outbox-service.ts`                               | §3.15                                  |
| `messaging-plugin/test/integration/service-bus-outage-real.test.ts` (extended, guarded)                    | real SDK path                                     | §3.3-§3.6 on the emulator              |
| `messaging-plugin/test/e2e/pubsub-emulator.test.ts` (extended, guarded)                                    | real SDK path                                     | §3.7 on the emulator                   |
| `queue-plugin/test/unit/rabbitmq-enqueue-faults.test.ts`                                                   | `rabbitmq-queue.ts`                               | §3.2                                   |
| `queue-plugin/test/unit/queue-loop-reporting.test.ts` (extended)                                           | `queue-service.ts`                                | §3.9                                   |
| `queue-plugin/test/unit/queue-probe-options.test.ts`                                                       | `queue-service.ts`, `queue-plugin.ts`             | §3.10                                  |
| `queue-plugin/test/unit/queue-poll-concurrency.test.ts`                                                    | `queue-service.ts`                                | §3.14                                  |
| `queue-plugin/test/unit/retry-delay-option.test.ts`                                                        | `job-processor.ts`, `queue-plugin.ts`             | §3.13                                  |
| `queue-plugin/test/unit/sqs-reachability.test.ts`                                                          | `sqs-queue.ts`                                    | §3.11                                  |
| `queue-plugin/test/unit/sqs-request-bound.test.ts`                                                         | `sqs-queue.ts`, `sqs-faults.ts`, `sqs-redrive.ts` | §3.12                                  |
| `queue-plugin/test/unit/sqs-long-poll.test.ts`                                                             | `sqs-queue.ts`                                    | §3.14                                  |
| `queue-plugin/test/unit/sns-publisher.test.ts` (extended)                                                  | `sns-publisher.ts`                                | §3.12                                  |
| `queue-plugin/test/e2e/sqs-probe-poll-localstack.test.ts` (new, guarded like `sns-sqs-localstack.test.ts`) | real SDK path                                     | §3.11, §3.12, §3.14 against LocalStack |
| `realtime-backplane-plugin/test/unit/injected-pair-connect.test.ts`                                        | `redis-backplane.ts`                              | §3.17 step 2                           |
| `realtime-backplane-plugin/test/unit/messaging-backplane-close.test.ts`                                    | `messaging-backplane.ts`                          | §3.17 step 3                           |
| `realtime-backplane-plugin/test/integration/backplane-start-cancel.test.ts`                                | `realtime-backplane-plugin.ts`                    | §3.17 step 1 with a kernel app         |

Every new or changed test is run once without its fix and shown to fail. The guarded suites run
against the running `he-*` containers and the shared LocalStack; their file names are checked to
exist before extension, and a missing one is created with the same guard.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m143m-broker-queue-bounds
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm test:coverage messaging-plugin queue-plugin realtime-backplane-plugin
pnpm run test:deno-lane
pnpm run ci:local            # once, on the final commit, through setu-suite-queue
pnpm run release:publish --dry-run
pnpm run release:verify 0.13.0
```

Every touched `src` file at 90% branch, function and line, read ANSI-stripped. The code-review and
docs-claims skills on the full range and every fix range. A security audit by a freshly spawned
agent (§10).

## 8. Risks & mitigations

- **Whether an open Service Bus receiver counts as activity for `autoDeleteOnIdle`** is
  vendor-documented ("a receive counts even when empty"), not measured; an inbox deleted under a
  live requester would fail its requests → the emulator suite reads the setting back; the closure
  note says expiry was not waited for; MassTransit runs the same 5-minute value on its receivers.
- **Concurrent per-name reserves (§3.14) change timing for every adapter** → the per-name flag is
  kept, the concurrency test runs on memory and Redis fakes, and `ci:local` covers the real Redis
  and RabbitMQ suites.
- **Long polls hold HTTP sockets:** `@smithy/node-http-handler` allows 50 sockets per client by
  default (`dist-cjs/index.js:451`), so 50 or more long-polling names would queue `SendMessage`
  behind them until the 15 s bound → the README states the limit, the SQS adapter warns once at
  connect when the configured names reach it with `waitTimeSeconds` above 0, and the probe uses its
  own client (§3.11).
- **The send-side Service Bus evidence rule changes (§3.3):** a refusal such as
  `MessagingEntityNotFound` no longer marks the broker down, which it did because no
  `ServiceBusError` carries a `statusCode` → named in the CHANGELOG and tested with real SDK error
  instances.
- **`maxConcurrentCalls` above 1 breaks the ordering claim** → the README row says so and the
  default stays 1.
- **The messaging backplane transport's subscribe stays as bounded as its broker** (RabbitMQ and
  Kafka subscribes are not all bounded) → recorded as a residual in the PR; the close path now
  rejects.
- **Other Pub/Sub admin calls on the subscribe path** (`createSubscription`, `getMetadata`,
  `deleteSubscription`) keep gax's 60 s per attempt and 600 s total → recorded as a residual; the
  new row covers only the check M143p added.
- **`toSqsFault` duplicates M143r's mail classification rule** (`mail-plugin` `bounded-send.ts`);
  plugins cannot import each other → §11 hands a `common` consolidation to the Core lane once both
  have merged.
- **LocalStack and the emulators run in containers this session must not restart** → the guarded
  suites only create and delete their own prefixed resources; a needed restart is asked of the
  coordinator.

## 9. Out of scope

- The SES half of V13-215 and every non-SQS half of V13-216 (M143r); the Workers half of V13-220
  (M143o); the Workers half of V13-117 (M143o, assigned 2026-11-25); an outbox after-commit hook
  (Data lane); CLI and template changes (CLI lane); performance work beyond the relay follow-up.

## 10. Design security review

The diff crosses trust boundaries: error bodies that reach clients, logs, and messages from a broker
an application wrote.

- **No remote text in a response:** `RemoteHandlerError`'s hint detail is fixed; the remote message
  stays on the object. Test asserts its absence from the body.
- **No secrets in logs:** the new warn lines carry names, counts and bounds only; an SQS or Service
  Bus error is logged through `describeError`, never with the request body or a connection string.
- **Validation cannot be skipped:** every custom-broker publish is validated (§3.8); the test drives
  a reserved header through both member shapes.
- **Bounds cannot be disabled by accident:** `0` is the only way to disable, each is documented, and
  a negative or non-finite value is refused (integers are required only for `maxConcurrentCalls`,
  the queue health options and `waitTimeSeconds`).

The committed tree is security-audited by a freshly spawned agent before the PR, with an audit
record for the PR body.

## 11. Hand-overs

- **M143o (L1, decided 2026-11-25):** the Workers half of V13-117 (`CloudflareRequestTimeoutError`,
  `CloudflareRemoteHandlerError` at `cloudflare-plugin/src/errors.ts:96-135` carry no status) goes
  to M143o with D1's statuses (504 and 502, fixed details, no remote text in the body); the
  coordinator tells M143o. This letter does not touch `cloudflare-plugin`.
- **Data lane:** an after-commit callback on `DatabaseService.transaction` would let the outbox
  dispatch itself (§3.16); proposed, not required for this row.
- **Core lane, after M143r and this letter merge:** one `common` helper for AWS fault classification
  in place of `mail-plugin`'s and `queue-plugin`'s copies.
- **M143r (#614):** `docs/health-indicators.md` rows 3-4 sit next to row 5; whichever merges second
  resolves the adjacent hunk. No other shared file overlaps except the `[Unreleased]` and upgrading
  sections, kept both sides.
- **M143o:** the two README hand-overs in §3.18, applied when M143o has merged.
- **M143n:** re-checks the README text this letter writes.

## 12. Open decisions for the maintainer

**Code-review items, DECIDED by the maintainer, 2026-11-26** (from `m143m-review-decisions-2.md`,
each as recommended): R1 the Service Bus outage predicate checks a refusal code set first
(`UnauthorizedAccess`, `MessagingEntityNotFound`, `MessagingEntityDisabled`, `MessageSizeExceeded`,
`QuotaExceeded`, before `retryable`), classifies an `AggregateError` by its last inner error, and
its tests build errors with the SDK's `translateServiceBusError`; R2 the backplane never disconnects
an injected Redis client, on close or on a failed start: `close()` stops waiting, removes its
listeners and unsubscribes when subscribed (Socket.IO's adapters treat such a client as borrowed);
R3 the SQS probe's per-call bound is `min(1500, floor(0.75 × probeTimeoutMs))`.

**Implementation review items, DECIDED by the maintainer, 2026-11-26** (from
`m143m-review-decisions-1.md` in the shared notes): C2 (a) this session may pause or stop and then
restart the `he-sb` Service Bus emulator, only for the §3.3 paused-publish and §3.6 consume-only
`/ready` tests, only inside its own queued run, restarted by a trap even when the test fails; C3
M143p's capability-probe rule for `autoDeleteOnIdle`; C4 the composed SQS receive bound capped at
2,147,483,647; C5 the relay impact text corrected, no option added; C6 the three wording fixes.

**DECIDED by the maintainer, 2026-11-25:** every decision below as recommended, (a) in each of D1 to
D11; every "for confirmation" item confirmed; both declared departures from M143p accepted. L1: the
Workers half of V13-117 goes to M143o with D1's statuses.

- **D1 (§3.1), RPC statuses:** (a) timeout 504, remote failure 502; (b) timeout 504, remote failure
  500 (unmasked title); (c) unchanged. Recommendation (a).
- **D2 (§3.3), Service Bus publish bound:** (a) `publishTimeoutMs` 15,000 like every sibling, with
  an abort signal; (b) 10,000 like Spring; (c) opt-in, default unbounded. Recommendation (a).
- **D3 (§3.4), Service Bus concurrency default:** (a) 1, the SDK's, keeps ordering; (b) a parallel
  default like MassTransit (16). Recommendation (a).
- **D4 (§3.6), receiver errors feed reachability:** (a) yes, network-shaped receive errors only; (b)
  keep it a documented residual. Recommendation (a).
- **D5 (§3.7), Pub/Sub missing topic:** (a) `PubSubTopicMissingError` on code 5, amending M143p's
  rethrow rule for that code; (b) only add the topic name to the raw error's message. Recommendation
  (a). The 1,500 ms bound for `topicExists` follows its sibling.
- **D6 (§3.8), the `custom` contract:** (a) exported `ICustomMessageBroker` with two optional header
  members, bypass deleted, options always validated; (b) export the full internal adapter interface;
  (c) documentation only. Recommendation (a).
- **D7 (§3.13), retry spacing:** (a) plugin-level `retryDelayMs`, number or function, every adapter;
  (b) SQS-only `sqs.retryDelaySeconds`, M143o's exact name. Recommendation (a).
- **D8 (§3.14), SQS long poll default:** (a) 20 s, with per-name reserves no longer awaited in turn;
  (b) 10 s (Spring, Celery); (c) 0, opt-in. Recommendation (a).
- **D9 (§3.15), outbox relay:** (a) follow-up sweep while full, plus the warn and recovery lines;
  (b) the warn and recovery lines only; (c) documentation only. Recommendation (a).
- **D10 (§3.16), dispatch after commit:** (a) documentation plus the Data-lane hand-over; (b) take a
  `database-plugin` change into this letter as an out-of-lane edit. Recommendation (a).
- **D11 (§3.17), injected backplane pair:** (a) bound by `commandTimeoutMs`, start fails after it;
  (b) a new `connectTimeoutMs`; (c) no bound, only cancellation. Recommendation (a).
- **Declared departures from M143p (for confirmation):** (1) §3.7 wraps a create-path code 5 in
  `PubSubTopicMissingError` where M143p rethrew it unchanged; (2) §3.12 keeps the SQS redrive reads
  at a finite 10 s floor when `requestTimeoutMs` is `0`, following M143p decision 7 rather than
  letting `0` remove a start-path bound.
- **For confirmation (no alternative proposed):** §3.2 RabbitMQ enqueue classes, §3.5 reply-inbox
  5-minute auto-delete, §3.9 loop reporting, §3.10 probe options, §3.11 SQS probe rule, §3.12 SQS
  `requestTimeoutMs` 15,000, §3.17 steps 1 and 3.
