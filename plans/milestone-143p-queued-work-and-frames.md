# Milestone 143p — Messaging lane (`@setu-ts/queue-plugin`, `@setu-ts/messaging-plugin`, `@setu-ts/realtime-backplane-plugin`)

> **Status:** Planning. Branch: `feat/m143p-queued-work-and-frames`. `develop` and `main` are
> protected; all work (implementation and fixes) stays on this one branch until it merges through a
> single PR into `develop`. D7 is decided (§0.3): Part A ships first as its own PR from this branch;
> Part B follows on the same branch, carrying its `common` change itself (D1, decided 2026-11-23).
> Lane: Messaging, first in its lane; M143m follows on the same packages. Ships in `0.14.0`.

## 0. Objective & scope

On every queue and broker arm, failed work is neither lost nor repeated without a trace, and the
realtime backplane reaches every replica on every broker it accepts. Today the SQS adapter runs a
long job again and again and deletes an exhausted one, cannot read what `SnsPublisher` writes, and
redelivers an unreadable message for ever; Pub/Sub and Service Bus redeliver a failing handler with
no delay and no limit, a fatal Pub/Sub stream error leaves the consumer dead while health says `up`,
and the Pub/Sub ordering claim does not hold; the backplane's `messaging` transport loses
cross-replica frames on four of the six cross-process brokers; a paused Redis or RabbitMQ delivers
frames seconds late; and an unroutable RabbitMQ outbox row is marked sent. This letter fixes all
eleven rows in the three Messaging-lane packages, plus two additive `common` contract changes that
ship in this letter's own PR as a flagged out-of-lane edit (§0.2, D1).

- **In scope (11 rows):** V13-198 (High), V13-199 (High), V13-258 (High), X3-3, V13-107, V13-212,
  V13-213, V13-214, V13-260, V13-261, V13-266. The design decisions in §3, each mapped to a row in
  §0.1. Docs: the queue, messaging and backplane READMEs, `PUBLIC_API.md`, `CHANGELOG.md`,
  `docs/upgrading.md`, and the agent cards of the three packages (§3.17).
- **NOT this milestone:** every M143m row (bounds, health, errors and options: V13-8, V13-38,
  V13-117, V13-118, V13-215, V13-259, V13-262, V13-263, V13-265, V13-10, V13-54, V13-120, V13-220,
  V13-267, V13-268); the backplane close-hook order and startup abort (V13-43, M143i hands it to
  M143m); the WorkersQueue exhausted-job rule on Workers (V13-197, M143o); every CLI and template
  change (CLI lane, §11); documentation-only rows (M143n, including V13-269 and V13-229, see §11).

### 0.1 Rows, their reproduction read, and where each is fixed

The reproduction reads below are from the source at `develop` `d2ec1aef1` and the runner reports
under `~/Projects/hono-enterprise-published-smoke/v0.13.0/part28/x121` and `x122`.

| Row                | Today (file:line) and why the symptom follows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Decision         | Test home                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- |
| **V13-198** (High) | Root cause: the SQS adapter has no `claimRenewal`. `QueueService.#dispatchJob` starts a renewal timer only when `this.#adapter.claimRenewal` is defined (`queue-service.ts:569-596`); `SqsQueue` never defines it (no member in `sqs-queue.ts`), while `RedisQueue` does (`redis-queue.ts:356-365`). So the visibility timeout taken at receive (`sqs-queue.ts:368`, default 30 s at `:31`) is never extended. A job longer than the timeout reappears in the queue and, at concurrency 2, is received again while the first copy still runs. When the first copy ends, `ack` looks up the receipt entry, finds `claimExpiresAtMs` in the past by the adapter's own clock (`findReceiptEntry`, `:675-686`), logs `unknown or expired receipt handle` and returns without deleting (`:480-486`). Each redelivery raises `ApproximateReceiveCount`, which the adapter reports as `attempts` (`:411-427`); on the receive where `attempts > maxAttempts` the service takes the dead-worker path (`queue-service.ts:597-625`) and calls `onFailed("attempt budget exhausted")` and `deadLetter` for a job whose every run succeeded.                                                          | §3.1, §3.2       | `sqs-claim-renewal.test.ts`, `long-job-lease-conformance.test.ts`                                           |
| **V13-199** (High) | Root cause: `SqsQueue.deadLetter` deletes the source message when `deadLetterQueues[name]` is absent (`sqs-queue.ts:588-594`), and the service counts the job `dead_lettered` before the adapter call returns (`job-processor.ts:188-196`, `queue-service.ts:623`). The README example omits the option (`queue-plugin/README.md:90-100`) and the README claims every adapter dead-letters (`:292`). Memory keeps the job in its dead list (`memory-queue.ts:172-188`), Redis moves it to its dead set (`redis-queue.ts:588-613`), RabbitMQ publishes it to its own dead queue (`rabbitmq-queue.ts:842-855`), all with nothing configured.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | §3.3             | `sqs-dead-letter-target.test.ts`, `exhausted-job-conformance.test.ts`                                       |
| **V13-258** (High) | Root cause: `MessagingBackplane.connect()` subscribes with no options (`messaging-backplane.ts:120`), and a queue-less subscription means a shared consumer group on every cross-process arm except RabbitMQ: Kafka `<defaultQueue>:<topic>` (`kafka-broker.ts:840`), NATS `<defaultQueue>.<topic>` (`nats-broker.ts:673`, the M119a decision), Redis Streams `messaging-consumers` (`redis-streams-broker.ts:716`), Pub/Sub `<defaultQueue>.<topic>` (`pubsub-broker.ts:724`), Service Bus `messaging-consumers` (`service-bus-broker.ts:1001`). A group hands each frame to one member, and when that member is the sender the origin check drops it (`messaging-backplane.ts:124`). RabbitMQ alone gives a queue-less subscriber a private exclusive queue (`rabbitmq-broker.ts:896-897`). What this plan can prove: Kafka, NATS and Redis Streams against real servers (measured by X122); Pub/Sub and Service Bus were only read from source, and this letter drives both on their emulators in a guarded suite (§6, `backplane-fan-out-real.test.ts`, `fan-out-conformance.test.ts`), with the caveat in §8 that the emulators may not honour subscription expiry or idle deletion. | §3.6, §3.7, §3.8 | `fan-out-conformance.test.ts`, `backplane-fan-out-real.test.ts`                                             |
| **X3-3**           | The `redis` transport's publisher has no offline queue since M139f (`redis-backplane.ts:270-275`), so a disconnect loses frames. A PAUSE is different: the connection stays open, `PUBLISH` is written to the socket, `commandTimeoutMs` (default 15 s, `interfaces/index.ts:252`, `:275`) rejects the caller, and the paused server executes the command when it resumes, so the frame arrives up to the pause length late while the publisher logged `publish failed`. No sender-side change can recall a command already written; only the receiver can refuse a frame that is too old. The `messaging` transport has the same shape on RabbitMQ (X122-12: 2 to 19 s late).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | §3.9             | `frame-age.test.ts`, `backplane-lateness-real.test.ts`                                                      |
| **V13-107**        | The outbox relay publishes through the public broker (`relay.ts:232-236`); RabbitMQ publishes without `mandatory` (`rabbitmq-broker.ts:785-818` sets it only when `requireRoute`, which only the retry and dead disposition copies pass), so a confirm arrives for an unrouted message and the relay marks the row `sent`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | §3.10            | `rabbitmq-unroutable-publish.test.ts`, `outbox-unroutable-real.test.ts`                                     |
| **V13-212**        | `SnsPublisher.publish(message)` sends the body only (`sns-publisher.ts:161-166` in the class, transport at `:84-92`), never the `{ v: 1, id, name, data, maxAttempts, headers }` envelope `SqsQueue` validates (`sqs-queue.ts:627-672`); a wrapped (non-raw) delivery is SNS notification JSON, which the validator also refuses. No attributes and no `traceparent` are sent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | §3.4             | `sqs-envelope.test.ts`, `sns-publisher.test.ts`, `sns-sqs-localstack.test.ts`                               |
| **V13-213**        | `reserve` skips a body that fails `JSON.parse` or envelope validation with `continue` (`sqs-queue.ts:380-399`): no delete and no visibility change, so it reappears after every visibility timeout for ever, and `:395` logs the whole parsed body at `error`. RabbitMQ moves such a message, bytes unchanged, to its dead queue and warns without the body (`rabbitmq-queue.ts:731-750`, `:768-778`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | §3.5             | `sqs-unreadable-message.test.ts`                                                                            |
| **V13-214**        | The adapter never reads the queue's `RedrivePolicy` (no `GetQueueAttributes` in `ISqsTransport`, `sqs-queue.ts:64-88`). When `maxReceiveCount` is below the job's `maxAttempts`, SQS moves the message on a receive the framework never sees, so no `onFailed`, the counter stays at `retried` and nothing is logged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | §3.3             | `sqs-dead-letter-target.test.ts`                                                                            |
| **V13-260**        | `sub.on('error')` only logs (`pubsub-broker.ts:427-431`). The SDK destroys the stream on a non-retryable status and the subscriber then emits `close` (`@google-cloud/pubsub` 6.4.1 `build/src/message-stream.js:400-406`, `subscriber.js:936-947`, `subscription.js:236-239`), which nothing listens to. Reachability is a `getTopics` call (`pubsub-broker.ts:331-345`) that says nothing about the streams.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | §3.13            | `pubsub-stream-recovery.test.ts`, `pubsub-emulator.test.ts`                                                 |
| **V13-261**        | Pub/Sub subscriptions are created with at most `enableMessageOrdering` (`pubsub-broker.ts:398-403`) and a failing handler is `nack`ed at once (`:755-759`); Service Bus abandons at once (`service-bus-broker.ts:533`, `:1022-1026`). Neither arm accepts `consumerRetry` (`interfaces/index.ts:628-677`, `:727-763`), which RabbitMQ and Redis Streams have (`:453`, `:484`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | §3.11, §3.12     | `consumer-retry-conformance.test.ts`, `pubsub-consumer-retry.test.ts`, `service-bus-consumer-retry.test.ts` |
| **V13-266**        | `sub.on('message')` starts each handler without waiting for the previous one (`pubsub-broker.ts:433-447`, `:734-764` fires an un-awaited async block), so on an ordering subscription later messages already pulled run while the failed one is being nacked. Google's own page puts this on the application: with an asynchronous callback the subscriber must keep the order itself (Compared with, row 7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | §3.14            | `pubsub-ordered-dispatch.test.ts`                                                                           |

None of the eleven failed to reproduce from source. V13-258's Pub/Sub and Service Bus halves and
X3-3's RabbitMQ half are driven for the first time by this letter's guarded suites.

### 0.2 The changes outside the lane

V13-258 needs the backplane to ask any `IMessageBroker` for a subscription that every instance
receives, and to know whether it got one. The backplane cannot import `messaging-plugin`
(AI_GUIDELINES, "no plugin imports another plugin"), so the request and the answer must be in the
`common` contract: two optional members on existing interfaces in
`packages/common/src/services/messaging.ts` (`SubscribeOptions.fanOut`, `ISubscription.fanOut`,
§3.6). Part A's discard opt-out (§3.3a) also needs a `discarded` member in the diagnostics
settlement vocabulary (`packages/common/src/services/diagnostics.ts`, `QueueSettlementState`,
§3.18). Both are additive for callers; the vocabulary member widens a union that
`diagnostics-plugin` validates against a set, so that reader is updated in this PR too.

**Decided (maintainer, 2026-11-23, D1):** these `common` changes ship in M143p's own PR, flagged in
the PR body as an out-of-lane `common` edit, not as a separate Core-lane PR first. M143i (#611) has
merged and no other session edits Core files now. Every reader of both types is found by search
(§3.6, §3.18) and each out-of-lane file touched is named in §5 and the PR body.

### 0.3 Proposed split (open decision D7)

Eleven rows across three packages, each with guarded real-backend suites, is larger than any recent
single letter. Proposed order:

1. **Part A, SQS and SNS (`queue-plugin` only):** V13-198, V13-199, V13-212, V13-213, V13-214. Needs
   nothing outside the lane and can start at once.
2. **Part B, brokers and the backplane (`messaging-plugin`, `realtime-backplane-plugin`):** V13-258,
   X3-3, V13-107, V13-260, V13-261, V13-266, plus the two `common` changes (§0.2).

**Decided (maintainer, 2026-11-22): two parts.** Part A ships first, as its own PR from this branch.
Each part has its own CHANGELOG, PUBLIC_API and upgrade entries. The Progress Tracking row, the
`CLAUDE.md` status line and the plan's archiving change only with Part B; Part A changes none of
them.

### 0.4 Compared with

Every default and rule below cites one of these rows. "Not verified" means the cell was not read in
the tool's own documentation during planning.

| #   | Question                                                 | This repo's siblings                                                                                                                                                                                                                                                                                                                | BullMQ / Sidekiq / Celery                                                                                                                                                                                                                                                                                                                     | MassTransit                                                                                                                              | Spring (Cloud AWS, Cloud Stream, AMQP)                                                                                                                                                                               | AWS .NET Message Processing Framework                                                                                                                                                                                 | Socket.IO adapters / Dapr                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | A job that outlives its lease                            | Redis renews every `visibilityTimeoutMs / 3` (`redis-queue.ts:356-365`); RabbitMQ holds an unacked delivery with no lease; memory has none                                                                                                                                                                                          | BullMQ renews its lock every `lockDuration / 2` (30 s default) ([docs](https://docs.bullmq.io/bull/important-notes)); Celery on SQS runs the task again when it outlives the visibility timeout, "again and again in a loop" ([docs](https://docs.celeryq.dev/en/v5.4.0/getting-started/backends-and-brokers/sqs.html)); Sidekiq not verified | not verified                                                                                                                             | Spring Cloud AWS extends visibility only for FIFO message groups; on a standard queue it is set once at poll ([reference 3.3.0](https://docs.awspring.io/spring-cloud-aws/docs/3.3.0/reference/html/index.html))     | Tracks and extends the visibility timeout of messages it is handling (`VisibilityTimeout` 30, threshold 5, heartbeat 1) ([docs](https://docs.aws.amazon.com/sdk-for-net/v3/developer-guide/msg-proc-fw-consume.html)) | n/a                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2   | An exhausted job with no dead-letter target configured   | memory, Redis and RabbitMQ keep it in their own dead store with nothing configured; SQS deletes it                                                                                                                                                                                                                                  | BullMQ keeps failed jobs in its failed set by default ([docs](https://docs.bullmq.io/guide/queues/auto-removal-of-jobs)); Sidekiq moves it to the Dead set (10,000 jobs or 6 months) ([wiki](https://github.com/mperham/sidekiq/wiki/Error-Handling))                                                                                         | Forwards a faulted message to an `_error` queue it creates ([SQS transport](https://masstransit.io/documentation/transports/amazon-sqs)) | Spring Cloud AWS leaves a failed message unacknowledged for the visibility timeout; the queue's redrive policy decides                                                                                               | Leaves the message "in the queue where it can be processed again or moved to a dead-letter queue, if configured"                                                                                                      | n/a                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 3   | The queue's own redrive budget below the framework's     | none of the siblings has a platform budget                                                                                                                                                                                                                                                                                          | n/a                                                                                                                                                                                                                                                                                                                                           | MassTransit: SQS does not know it moved a message unless SQS's delivery count did it (same page)                                         | defers to the redrive policy                                                                                                                                                                                         | defers to the redrive policy                                                                                                                                                                                          | n/a                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 4   | Every instance receives every message (fan-out)          | in-memory and RabbitMQ give a queue-less subscriber its own delivery; every other arm shares one group (M119a decision 2026-10-24); each arm already has a per-instance consumer for the reply inbox (`inbox.ts`, `kafka-broker.ts:508-520`, `nats-broker.ts:703-716`, `pubsub-broker.ts:532-581`, `service-bus-broker.ts:702-751`) | n/a                                                                                                                                                                                                                                                                                                                                           | not verified                                                                                                                             | Spring Cloud Stream: no group means an anonymous, non-durable, single-member group, so each instance gets a copy ([reference](https://docs.spring.io/spring-cloud-stream/docs/Ditmars.RELEASE/reference/htmlsingle)) | n/a                                                                                                                                                                                                                   | Socket.IO's AWS adapter creates an SQS queue per server on a shared SNS topic and deletes it on close ([docs](https://socket.io/docs/v4/aws-sqs-adapter/)); its Azure adapter creates "one subscription ... per Socket.IO server" ([docs](https://socket.io/docs/v4/azure-service-bus-adapter/)); its Pub/Sub adapter creates a subscription at init ([docs](https://socket.io/docs/v4/gcp-pubsub-adapter/)); Dapr delivers to one instance per app id, fan-out needs distinct consumer ids (inferred, not verified) ([docs](https://docs.dapr.io/developing-applications/building-blocks/pubsub/pubsub-overview)) |
| 5   | A failing consumer handler: delay and limit              | RabbitMQ and Redis Streams `consumerRetry` (5 attempts, tiered delays, classifier, dead store, `interfaces/index.ts:422-484`)                                                                                                                                                                                                       | Sidekiq retries about 25 times over about 21 days then the Dead set                                                                                                                                                                                                                                                                           | not verified                                                                                                                             | Spring Cloud Stream retries in process: `maxAttempts` 3, backoff 1 s to 10 s ([reference](https://docs.spring.io/spring-cloud-stream/reference/4.2/spring-cloud-stream/overview-error-handling.html))                | n/a                                                                                                                                                                                                                   | Google Pub/Sub: a subscription retry policy and a dead-letter policy (5 to 100 attempts, default 5) ([handling failures](https://docs.cloud.google.com/pubsub/docs/handling-failures))                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 6   | Unroutable publish on RabbitMQ                           | the broker already uses `mandatory` with a return listener for its retry and dead copies (`rabbitmq-broker.ts:808-818`)                                                                                                                                                                                                             | n/a                                                                                                                                                                                                                                                                                                                                           | not verified                                                                                                                             | Spring AMQP returns an unrouted message only with `mandatory` and a `ReturnsCallback`; otherwise RabbitMQ drops it ([template](https://docs.spring.io/spring-amqp/reference/amqp/template.html))                     | n/a                                                                                                                                                                                                                   | RabbitMQ: confirms do not cover routing; a return precedes the ack ([publishers](https://www.rabbitmq.com/docs/publishers))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 7   | Ordered delivery with an asynchronous handler on Pub/Sub | Service Bus keeps order at one concurrent call (README:87); Kafka by blocking the partition                                                                                                                                                                                                                                         | n/a                                                                                                                                                                                                                                                                                                                                           | n/a                                                                                                                                      | n/a                                                                                                                                                                                                                  | n/a                                                                                                                                                                                                                   | Google: the callback for a key runs to completion before the next; "if your callback schedules asynchronous work, you must keep that work in order yourself" ([ordering](https://docs.cloud.google.com/pubsub/docs/ordering))                                                                                                                                                                                                                                                                                                                                                                                      |
| 8   | Lease extension limits on SQS                            | n/a                                                                                                                                                                                                                                                                                                                                 | n/a                                                                                                                                                                                                                                                                                                                                           | n/a                                                                                                                                      | n/a                                                                                                                                                                                                                  | n/a                                                                                                                                                                                                                   | AWS: `ChangeMessageVisibility` up to 43,200 s, measured from the receive, not reset by an extension ([API](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_ChangeMessageVisibility.html)); a delete must use the most recent receipt handle, an older one "will succeed, but the message might not be deleted" ([API](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_DeleteMessage.html))                                                                                                                                                                     |
| 9   | Per-instance resource expiry                             | NATS inbox consumer `inactive_threshold` 5 min (`nats-leaked-consumers.ts`)                                                                                                                                                                                                                                                         | n/a                                                                                                                                                                                                                                                                                                                                           | n/a                                                                                                                                      | n/a                                                                                                                                                                                                                  | n/a                                                                                                                                                                                                                   | Pub/Sub `expirationPolicy.ttl` minimum 1 day, default 31 days, must exceed the subscription's message retention ([properties](https://docs.cloud.google.com/pubsub/docs/subscription-properties)); Service Bus `AutoDeleteOnIdle` minimum 5 minutes, default never ([message expiration](https://learn.microsoft.com/azure/service-bus-messaging/message-expiration))                                                                                                                                                                                                                                              |

Rows 10 to 14 were added in the Part A review (2026-11-22), from each framework's documentation or,
where the documentation is silent, its source on GitHub.

| #   | Question                                      | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Sources                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10  | A message the consumer cannot read            | NServiceBus SQS sends a body it cannot extract to the error queue once, skipping retries, warns with the message id and not the body, and sets visibility 0 when that send fails; Celery logs the body at critical and acks (deletes) it; Spring Cloud AWS, Shoryuken and the AWS .NET framework leave it for the redrive policy; RabbitMQ sibling moves it to its dead queue without logging the body                                                                      | [NServiceBus `InputQueuePump.cs`](https://github.com/Particular/NServiceBus.AmazonSQS/blob/master/src/NServiceBus.Transport.SQS/Receiving/InputQueuePump.cs), [recoverability](https://docs.particular.net/nservicebus/recoverability/), [Celery `consumer.py`](https://github.com/celery/celery/blob/main/celery/worker/consumer/consumer.py), [AWS .NET `SQSMessagePoller.cs`](https://github.com/aws/aws-dotnet-messaging/blob/main/src/AWS.Messaging/SQS/SQSMessagePoller.cs)                                                                                                                                                 |
| 11  | Renewal interval, and a failed renewal        | BullMQ renews at `lockDuration / 2`; MassTransit SQS at 0.7 of the timeout, and on an SQS error logs and lets the handler run; NServiceBus SQS before expiry, and cancels the handler's token when visibility is lost; the AWS .NET framework within 5 s of expiry, logs, handler runs on; Redis sibling every third, reported once, handler runs on                                                                                                                        | [BullMQ WorkerOptions](https://docs.bullmq.io/api/interfaces/v5.WorkerOptions.html), [MassTransit `AmazonSqsReceiveLockContext.cs`](https://github.com/MassTransit/MassTransit/blob/develop/src/Transports/MassTransit.AmazonSqsTransport/AmazonSqsTransport/AmazonSqsReceiveLockContext.cs), [NServiceBus options](https://docs.particular.net/transports/sqs/configuration-options), [AWS .NET visibility design](https://github.com/aws/aws-dotnet-messaging/blob/main/docs/docs/design/message-visibility-timeout-handling.md)                                                                                                |
| 12  | Metadata on a forwarded dead letter           | MassTransit `MT-Reason`, `MT-Fault-*` with the exception message (2,048 chars) and stack trace; NServiceBus `NServiceBus.ExceptionInfo.*` with message and stack trace; Sidekiq `error_message` (scrubbed), `error_class`, `retry_count`; redrive-only frameworks add nothing                                                                                                                                                                                               | [MassTransit `MessageHeaders.cs`](https://github.com/MassTransit/MassTransit/blob/develop/src/MassTransit.Abstractions/MessageHeaders.cs), [NServiceBus headers](https://docs.particular.net/nservicebus/messaging/headers), [Sidekiq `job_retry.rb`](https://github.com/sidekiq/sidekiq/blob/main/lib/sidekiq/job_retry.rb)                                                                                                                                                                                                                                                                                                      |
| 13  | SNS to SQS envelope and trace context         | MassTransit turns on raw delivery on every subscription it creates; the AWS .NET framework puts its envelope in `Message`, detects the wrapper by `Type` and `TopicArn`, and carries trace context in the envelope (`otel.traceparent`); OpenTelemetry's JS AWS SDK instrumentation writes `traceparent` as a message attribute and skips it when the message would exceed 10 attributes; SNS drops a message with more than 10 attributes bound for a raw SQS subscription | [MassTransit `TopicEntity.cs`](https://github.com/MassTransit/MassTransit/blob/develop/src/Transports/MassTransit.AmazonSqsTransport/AmazonSqsTransport/Topology/Entities/TopicEntity.cs), [AWS .NET `SNSMessageParser.cs`](https://github.com/aws/aws-dotnet-messaging/blob/main/src/AWS.Messaging/Serialization/Parsers/SNSMessageParser.cs), [OTel `MessageAttributes.ts`](https://github.com/open-telemetry/opentelemetry-js-contrib/blob/main/packages/instrumentation-aws-sdk/src/services/MessageAttributes.ts), [SNS raw delivery](https://docs.aws.amazon.com/sns/latest/dg/sns-large-payload-raw-message-delivery.html) |
| 14  | Reading the queue's own attributes at startup | No surveyed framework reads `RedrivePolicy` to clamp a budget (MassTransit writes one; Spring, AWS .NET, Shoryuken and Celery defer to it); NServiceBus reads queue attributes at startup and refuses to start when its delayed-delivery queue has a redrive policy                                                                                                                                                                                                         | [NServiceBus `DelayedMessagesPump.cs`](https://github.com/Particular/NServiceBus.AmazonSQS/blob/master/src/NServiceBus.Transport.SQS/Receiving/DelayedMessagesPump.cs), [MassTransit SQS](https://masstransit.massient.com/documentation/transports/amazon-sqs)                                                                                                                                                                                                                                                                                                                                                                   |

| 15 | Which queues a starting service checks (D9) | NServiceBus creates and checks only an
endpoint's own queues, and a send-only endpoint none; MassTransit creates queues for each receive
endpoint at bus start (send endpoints not verified); Spring Cloud AWS applies
`queue-not-found-strategy` to listeners | coordinator lookup, 2026-11-22 (maintainer decision D9) |
| 16 | Opting out of the dead store: BullMQ | `removeOnFail` (`number \| boolean \| KeepJobs`), per
job or in `defaultJobOptions`; default keeps the job in the failed set; `true` removes it "when it
fails after all attempts"; whether the `failed` event still fires is not stated |
[BaseJobOptions](https://docs.bullmq.io/api/interfaces/v5.BaseJobOptions.html) | | 17 | Opting out
of the dead store: Sidekiq | `sidekiq_options retry: 5, dead: false` per job class: "will retry 5
times and then disappear"; whether `sidekiq_retries_exhausted` still runs is not stated |
[Error Handling](https://github.com/sidekiq/sidekiq/wiki/Error-Handling) | | 18 | Opting out of the
dead store: MassTransit | `DiscardFaultedMessages()` inside a `ReceiveEndpoint` configuration, per
receive endpoint; default moves faulted messages to `_error`; whether `Fault<T>` is still published
when discarding is not stated. Celery has no equivalent on its tasks page (`acks_late`,
`Reject(requeue=False)` only) |
[exceptions](https://masstransit.massient.com/documentation/concepts/exceptions),
[Celery tasks](https://docs.celeryq.dev/en/stable/userguide/tasks.html) |

What rows 10 to 14 settle for Part A: the unreadable rule follows NServiceBus and the RabbitMQ
sibling (§3.5), but leaves the message for its visibility timeout when the forward fails rather than
setting visibility 0, which would make a failing target a hot loop. The renewal keeps the Redis
sibling's interval of a third, the most frequent of those surveyed and the one rule already in this
package. A failed renewal is reported and the processor runs on, as on Redis, MassTransit and the
AWS .NET framework: cancelling it, as NServiceBus does, needs a cancellation signal on `IJob`, a
`common` contract change outside the lane. The forwarded copy carries a fixed reason, the count and
the source message id, and never exception text, which is stricter than MassTransit, NServiceBus and
Sidekiq on purpose (§10). Trace context travels in the envelope body (the AWS .NET choice), so the
10-attribute cap cannot drop a message. The clamp is new among the surveyed frameworks; NServiceBus
is the precedent for refusing to start because of a queue attribute.

Where the camps split (rows 2, 4, 5, 6 and the frame-age bound), the choice is an open decision in
§12, with a recommendation.

## 1. Contracts verified from SOURCE (not names)

| Reference                                | Source (file:line)                                                                                                                                                                            | Verified surface / fact                                                                                                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `QueueAdapter.claimRenewal`              | `packages/queue-plugin/src/adapters/queue-adapter.ts:39-42`                                                                                                                                   | Optional `{ intervalMs; extend(name, id, claimToken): Promise<boolean> }`; `false` means the claim no longer belongs to this delivery                                                            |
| Renewal driver                           | `packages/queue-plugin/src/services/queue-service.ts:566-596`                                                                                                                                 | Starts `setInterval(extend, intervalMs)` only when `claimRenewal` and `claimToken` exist; one report per job on failure; cleared in `finally` (`:643-647`)                                       |
| Dead-worker path                         | `packages/queue-plugin/src/services/queue-service.ts:597-625`                                                                                                                                 | `attempts > maxAttempts` → `onFailed("attempt budget exhausted")`, `deadLetter`, counter `dead_lettered`                                                                                         |
| `runJob` settlement order                | `packages/queue-plugin/src/processors/job-processor.ts:132-210`                                                                                                                               | failure below budget → `requeue`; at budget → `onFailed`, counter, `deadLetter`; success → `ack`; adapter rejections propagate                                                                   |
| `StaleClaimError`                        | `packages/queue-plugin/src/errors.ts:11-16`                                                                                                                                                   | Internal; thrown by Redis (`redis-queue.ts:528`, `:574`, `:610`) and RabbitMQ (`rabbitmq-queue.ts:789`, `:816`, `:852`) on a stale settle; SQS logs and returns instead (`sqs-queue.ts:480-495`) |
| `SqsQueue`                               | `packages/queue-plugin/src/adapters/sqs-queue.ts:226-701`                                                                                                                                     | Members as cited in §0.1; logger parameter typed `{ error }` only (`:252`) though the plugin passes `{ error, warn, info }` (`queue-plugin.ts:501-513`, `:235-236`)                              |
| `ISqsTransport` (exported)               | `packages/queue-plugin/src/adapters/sqs-queue.ts:64-88`                                                                                                                                       | `send(url, body, delay?)`, `receive(url, max, visibility)`, `delete`, `changeVisibility`, optional `isHealthy`, `close`; no attribute read                                                       |
| `SqsSdkModule` (exported)                | `packages/queue-plugin/src/adapters/sqs-queue.ts:36-49`                                                                                                                                       | Five constructors; `GetQueueAttributesCommand`, `GetQueueUrlCommand` absent                                                                                                                      |
| SDK commands exist                       | `node_modules/.pnpm/@aws-sdk+client-sqs@3.1169.0/.../dist-types/commands/`                                                                                                                    | `GetQueueAttributesCommand` (attribute `RedrivePolicy` listed at `GetQueueAttributesCommand.d.ts:42`), `GetQueueUrlCommand`, `ChangeMessageVisibilityCommand`                                    |
| Redis lease validation                   | `packages/queue-plugin/src/adapters/redis-queue.ts:95-118`                                                                                                                                    | `visibilityTimeoutMs` from 1,000 to 2,147,483,647 ms, refused with `RangeError`                                                                                                                  |
| RabbitMQ unreadable message              | `packages/queue-plugin/src/adapters/rabbitmq-queue.ts:731-750`, `:768-778`                                                                                                                    | Moved bytes-unchanged to the dead queue, acked, warned without the body                                                                                                                          |
| `SnsPublisher`                           | `packages/queue-plugin/src/sns/sns-publisher.ts` (class after `adaptSnsModule`)                                                                                                               | `publish(message)` body only; `ISnsTransport.publish(topicArn, body)`                                                                                                                            |
| Queue tracing codec                      | `packages/queue-plugin/src/tracing/traced-queue.ts:1-60`                                                                                                                                      | Injects `traceparent` into job headers through `contextToTraceparent` from `common`                                                                                                              |
| `defaultMaxAttempts`                     | `packages/queue-plugin/src/interfaces/index.ts:254`, `plugin/queue-plugin.ts:85`                                                                                                              | Default 3                                                                                                                                                                                        |
| `SubscribeOptions` (common)              | `packages/common/src/services/messaging.ts:421-424`                                                                                                                                           | `{ readonly queue?: string }` only                                                                                                                                                               |
| `ISubscription` (common)                 | `packages/common/src/services/messaging.ts:459-464`                                                                                                                                           | `{ unsubscribe(): Promise<void> }` only                                                                                                                                                          |
| `IMessageBroker` (common)                | `packages/common/src/services/messaging.ts:476-562`                                                                                                                                           | `connect`, `disconnect`, `publish`, `subscribe(topic, handler, options?)`, `request`, `respond`, optional `isHealthy`                                                                            |
| `parsePublishOptions` (common)           | `packages/common/src/services/messaging.ts:359-382`                                                                                                                                           | Reads `orderingKey`, `deduplicationId`, `headers` only and returns a new frozen object, so a symbol key on the input does not survive it                                                         |
| Reply-inbox transient marker             | `packages/messaging-plugin/src/brokers/inbox.ts:37-44`                                                                                                                                        | `REPLY_INBOX_TRANSIENT` symbol on internal subscribe options; read by RabbitMQ and NATS                                                                                                          |
| Per-broker queue-less default            | `kafka-broker.ts:840`, `nats-broker.ts:673`, `redis-streams-broker.ts:716`, `pubsub-broker.ts:724`, `service-bus-broker.ts:1001`, `rabbitmq-broker.ts:896-897`, `in-memory-broker.ts:182-205` | As in §0.1: shared group everywhere except RabbitMQ (exclusive private queue) and memory (every queue-less subscriber invoked)                                                                   |
| NATS transient consumer                  | `packages/messaging-plugin/src/brokers/nats-broker.ts:700-716`                                                                                                                                | `deliver_policy: 'new'`, `inactive_threshold: INBOX_INACTIVE_THRESHOLD_NS` (5 min, `nats-leaked-consumers.ts`), no `durable_name`                                                                |
| Kafka per-instance group                 | `packages/messaging-plugin/src/brokers/kafka-broker.ts:493-520`                                                                                                                               | Inbox subscribes the shared reply topic with a unique group `rr-inbox-<uuid>`; Kafka expires it on `offsets.retention.minutes`                                                                   |
| Redis Streams group creation             | `packages/messaging-plugin/src/brokers/redis-streams-broker.ts:716-731`                                                                                                                       | `XGROUP CREATE <topic> <group> $ MKSTREAM`, BUSYGROUP swallowed; idle-consumer sweep `consumerIdleSweepMs` default 3,600,000 (`:437`, `:881`)                                                    |
| Pub/Sub transport port                   | `packages/messaging-plugin/src/brokers/pubsub-broker.ts:180-231`                                                                                                                              | `open(topic, sub, onMessage)` creates when absent; `createSubscription(topic, sub)`; `deleteSubscription(sub)`; no close callback                                                                |
| Pub/Sub options                          | `packages/messaging-plugin/src/brokers/pubsub-broker.ts:236-266`; `interfaces/index.ts:628-685`                                                                                               | `publishTimeoutMs`, `projectId`, `credentials`, `client`, `defaultQueue`, `replyTopic`, `enableMessageOrdering`, `logger`; no retry option                                                       |
| Pub/Sub SDK message                      | `@google-cloud/pubsub` 6.4.1 `build/src/subscriber.js:468-519`                                                                                                                                | `modAck(deadline)` and `nack()` (`modAck(0)`); subscription `close` re-emitted from the subscriber (`subscription.js:236-239`)                                                                   |
| Service Bus transport port               | `packages/messaging-plugin/src/brokers/service-bus-broker.ts:151-201`, `:498-590`                                                                                                             | `open` subscribes with `autoCompleteMessages: false` and no other receive option; `createSubscription(topic, sub)` passes no options (`:586`); `nack` = `abandonMessage` (`:532-534`)            |
| Service Bus options                      | `packages/messaging-plugin/src/interfaces/index.ts:700-771`                                                                                                                                   | `connectionString`, `adminConnectionString`, `client`, `defaultQueue`, `replyTopic`, `retryOptions`; no retry policy                                                                             |
| `ConsumerRetryOptions`                   | `packages/messaging-plugin/src/interfaces/index.ts:422-429`                                                                                                                                   | `maxAttempts?`, `delaysMs?`, `isRetryable?`; validated twice, separately, in `rabbitmq-broker.ts:86-114` and `redis-streams-broker.ts:432-455`                                                   |
| Custom broker seam                       | `packages/messaging-plugin/src/brokers/custom-adapter.ts:37-46`, `:91`                                                                                                                        | Subscribe options pass through unchanged; the returned subscription is the instance's own                                                                                                        |
| Pipelined broker                         | `packages/messaging-plugin/src/pipeline/pipelined-broker.ts:193-235`                                                                                                                          | Returns the inner subscription object; options forwarded unchanged                                                                                                                               |
| RabbitMQ routed publish                  | `packages/messaging-plugin/src/brokers/rabbitmq-broker.ts:785-840`                                                                                                                            | `#publishOn(..., requireRoute)` adds `mandatory`, a disposition id and a return listener; refuses without confirms and on/off listeners                                                          |
| Outbox relay publish                     | `packages/messaging-plugin/src/outbox/relay.ts:232-236`; built at `plugin/messaging-plugin.ts:774-781`                                                                                        | `ctx.broker.publish(topic, envelope, options)` on the plugin's facade; a rejection takes the existing failure and backoff path                                                                   |
| `MessagingBackplane`                     | `packages/realtime-backplane-plugin/src/transports/messaging-backplane.ts:116-165`                                                                                                            | Subscribes once at `connect`, drops non-frames and own-origin frames                                                                                                                             |
| Redis backplane receive                  | `packages/realtime-backplane-plugin/src/transports/redis-backplane.ts:640-660`; publish `:520-530`                                                                                            | `JSON.parse`, `isRealtimeFrame`, origin check; publishes `JSON.stringify(frame)`                                                                                                                 |
| Backplane options                        | `packages/realtime-backplane-plugin/src/interfaces/index.ts:125-265`                                                                                                                          | No age bound; `commandTimeoutMs` default 15,000 (`:275`)                                                                                                                                         |
| `RealtimeFrame` (common)                 | `packages/common/src/services/realtime.ts:41-70`                                                                                                                                              | `kind`, `origin`, `name`, `data`, `binary?`, `exceptId?`; no time field; `isRealtimeFrame` accepts extra members (`messaging-backplane.ts:31-44`)                                                |
| Backplane registration                   | `packages/realtime-backplane-plugin/src/plugin/realtime-backplane-plugin.ts:120-176`                                                                                                          | `createBackplane` then `await backplane.connect()` in `register`, health indicator `realtime-backplane`, close hook                                                                              |
| `withDeadline` (common)                  | `packages/common/src/health/deadline.ts:118`                                                                                                                                                  | Used for the connect-time attribute read bound                                                                                                                                                   |
| `createCapabilityToken`                  | `packages/common/src/tokens.ts:438`                                                                                                                                                           | No new token in this letter (checked)                                                                                                                                                            |
| Other `CAPABILITIES.MESSAGING` providers | `packages/cloudflare-plugin/src/messaging/workers-broker.ts`                                                                                                                                  | The Workers broker is the one non-messaging-plugin provider; it will not set the fan-out marker, so the backplane refuses it (§3.8)                                                              |
| Claim "M119a deferred a fan-out mode"    | M119a plan, `git show f4e4530d4:plans/milestone-119a-message-delivery-bounds.md` §0                                                                                                           | "a fan-out (every-replica) subscription mode on NATS ... need their own milestone if wanted": confirmed                                                                                          |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                  | Resolution (picked side)                                                                                                                                  | Doc deliverable (same PR)                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| C1  | `queue-plugin/README.md:292` "dead-lettered by every adapter" vs `sqs-queue.ts:588-594` deleting                                                          | The code changes (§3.3) so the claim becomes true; the README states the SQS refusal                                                                      | README "Seeing a job that failed for the last time" and "SQS Retry and DLQ" rewritten |
| C2  | `queue-plugin/README.md:452-454` "AWS SQS does not support managed DLQ redrive for this adapter" vs SQS's own redrive policy, which the adapter now reads | The sentence is deleted; the README describes both targets                                                                                                | Same section                                                                          |
| C3  | `PUBLIC_API.md` "SNS publisher for fan-out (SNS→SQS pairing)" (at `PUBLIC_API.md:8284`) vs a publisher whose output the queue cannot read                 | The code changes (§3.4); the entry names `publishJob` as the pairing and `publish` as raw                                                                 | `PUBLIC_API.md` queue-plugin section                                                  |
| C4  | `realtime-backplane-plugin/README.md:59` and `:68-70` "Reuses every broker the messaging plugin ships" vs four brokers that lose frames                   | Code changes (§3.6 to §3.8); README lists the brokers that fan out and the refusal                                                                        | Backplane README `'messaging'` section                                                |
| C5  | `messaging-plugin/README.md:86` "Order kept by blocking, on an ordering subscription" vs X122-9                                                           | Code changes (§3.14); the row is re-measured and the cell rewritten from the test                                                                         | Messaging README ordering table                                                       |
| C6  | `messaging-plugin/README.md:1106` "At-least-once delivery of every committed row" vs V13-107                                                              | Code changes (§3.10); README says "delivered to a bound queue" on RabbitMQ and names the unroutable rule                                                  | Messaging README outbox section                                                       |
| C7  | `realtime-backplane-plugin/README.md:159` "lost, never delivered late" vs X3-3's pause measurements                                                       | Code changes (§3.9); README names `maxFrameAgeMs` and the clock assumption                                                                                | Backplane README lateness paragraph (the readiness half stays with M143n, V13-269)    |
| C8  | `common` `SubscribeOptions` documents only competing groups, while RabbitMQ's queue-less form fans out                                                    | Picked: `fanOut` is the one documented way to fan out; RabbitMQ's queue-less behaviour stays and is documented as the arm's own default, not the contract | `PUBLIC_API.md` common messaging section (this PR)                                    |

## 3. Design decisions

### 3.1 SQS claim renewal

- **Decision:** `SqsQueue` defines `claimRenewal` with
  `intervalMs = Math.floor(visibilityTimeoutSeconds * 1000 / 3)` (the Redis rule,
  `redis-queue.ts:357`). Each receipt entry records `receivedAtMs` (the adapter's `runtime.now()` at
  the receive that produced it; `reserve` overwrites the entry on a redelivery, so the value is per
  receipt). `extend(name, id, claimToken)`:
  1. looks the entry up with the same expiry check the settles use (`findReceiptEntry`), and returns
     `false` when it is absent, expired by the adapter's clock, or holds a different token. A claim
     the settles would already refuse is never revived;
  2. computes `remaining = 43,200 - floor((now - receivedAtMs) / 1000)` seconds and requests
     `min(visibilityTimeoutSeconds, remaining)`; when `remaining <= 0` it returns `false` without a
     call. AWS refuses a value above the time left and does not recalculate it (SDK JSDoc,
     `ChangeMessageVisibilityCommand.d.ts:59-61`; API page, Compared with row 8), so requesting the
     full timeout near the ceiling would report a valid lease as stale;
  3. calls `changeVisibility(queueUrl, receiptHandle, seconds)` and replaces the entry with
     `claimExpiresAtMs = now + seconds * 1000`, keeping the token and `receivedAtMs`;
  4. returns `false` when SQS rejects the call (an invalid or expired receipt handle, or the
     ceiling).

  The service then reports once, as `queue job claim renewal failed` carrying the error
  `queue job claim is stale` (`queue-service.ts:574-590`), and keeps calling `extend` on later
  ticks, so one transient rejection recovers. `visibilityTimeoutSeconds` is validated at
  construction: an integer from 1 to 43,200, refused with a `RangeError` naming the option (the
  Redis rule at `redis-queue.ts:105-118`, in seconds because SQS takes whole seconds).

- **Why:** the root cause of V13-198 is the missing member; the renewal driver already exists and is
  tested. Compared with, rows 1 and 8: BullMQ and the AWS .NET framework extend; Spring Cloud AWS
  and Celery do not and run long work again, which is the defect. The 12-hour ceiling is AWS's and
  is documented, not worked around. AWS states it per receive: a message received with a 10-hour
  timeout can be extended by at most 2 hours (API page, row 8).
- **Test home:** `sqs-claim-renewal.test.ts` (fake transport and clock: a job three timeouts long is
  extended every third of the timeout, acked once, never redelivered; a token mismatch, an expired
  entry and a transport rejection each return `false`; the request is capped by the time left and no
  call is made at the ceiling); `long-job-lease-conformance.test.ts`.

### 3.2 A stale SQS settle throws, and outcomes are counted after the settle

- **Decision:**
  1. `ack`, `requeue` and `deadLetter` on `SqsQueue` throw the internal `StaleClaimError` when the
     receipt entry is absent, expired, or holds a different token, instead of logging at `error` and
     returning. The service's existing `queue job settlement failed` report
     (`queue-service.ts:661-666`) is then the one signal.
  2. `runJob` calls `notifyOutcome` (the `queue_jobs_total` counter) only after the settle call
     resolves, for all three outcomes (`job-processor.ts:166`, `:189`, `:202` today count first).
     The dead-worker path already counts after (`queue-service.ts:623`). A settle that rejects is
     counted as nothing: the job will be delivered again and counted then. The JSDoc at
     `job-processor.ts:120-129` ("invoked before the settlement call") is corrected. This applies to
     every adapter, because they share `runJob`.
- **Why:** one rule for every adapter with a claim (siblings, row 1). Returning silently made a lost
  claim look like a completed job in every observer except the log, and counting before the settle
  made a stale `ack` count `completed` and a failed dead-letter count `dead_lettered` for a job that
  runs again.
- **Test home:** `sqs-claim-renewal.test.ts` (each of the three settles, stale and expired);
  `job-processor.test.ts` (extended: a rejecting `ack`, `requeue` and `deadLetter` count nothing, a
  resolving one counts once); `exhausted-job-conformance.test.ts`.

### 3.3 Every exhausted SQS job reaches a dead-letter target, or the adapter refuses to consume it

- **Decision:** the adapter resolves one dead-letter target per **consumed** job name, through a new
  internal module `sqs-redrive.ts`. A name the process only enqueues to is never checked: an API
  service that produces to a queue consumed elsewhere needs no dead-letter target and no
  `GetQueueAttributes` right (open decision D9 for when the check runs).
  1. It reads the queue's `RedrivePolicy` with `GetQueueAttributes` (new optional
     `ISqsTransport.getQueueAttributes(queueUrl, names)`), bounded by `withDeadline` at 10,000 ms
     per call (M143m's SQS time-bound option replaces this constant, §11). The reads for several
     names run in parallel.
  2. Parse rules: `RedrivePolicy` is a JSON string. `deadLetterTargetArn` must be a string of the
     form `arn:<partition>:sqs:<region>:<account>:<name>`; `maxReceiveCount` is accepted as an
     integer number or a string of decimal digits, from 1 to 1,000. Anything else is refused with
     the error in step 4, worded "the queue's RedrivePolicy cannot be read". AWS requires the
     dead-letter queue in the same account and region as the source queue.
  3. Target: `deadLetterQueues[name]` when given; otherwise the policy's `deadLetterTargetArn`,
     turned into a URL once with `GetQueueUrl` (new optional
     `ISqsTransport.getQueueUrl(queueName, ownerAccountId)`; name and account from the ARN), bounded
     the same way.
  4. A consumed name with no target is refused with `SqsDeadLetterTargetMissingError`, naming the
     job name and the queue URL and all three ways past it: a `deadLetterQueues` entry, a redrive
     policy on the queue, or `deadLetterQueues: { '<name>': false }` to discard exhausted jobs
     (§3.3a). "No target" means: no explicit entry, together with any of: no policy, an unreadable
     policy, a refused or unavailable attribute read, or a policy target the transport cannot turn
     into a URL (no `getQueueUrl`). This is the only refusal in §3.3, because carrying on would
     delete the job with nothing keeping it (the maintainer's rule: refuse only when carrying on
     would lose data silently; otherwise adjust, warn once and keep running).
  5. When a policy exists, the effective attempt budget for that name is
     `max(1, min(job.maxAttempts, maxReceiveCount - 1))`, applied in `reserve` to the `maxAttempts`
     it returns (so `IJob.maxAttempts` shows the clamped value). SQS delivers a message at most
     `maxReceiveCount` times and moves it on the receive after that. With budget B the final failure
     runs on receive B, and a worker that dies on receive B leaves receive B + 1 <=
     `maxReceiveCount` for the dead-worker path (`queue-service.ts:597-625`), so `onFailed` always
     fires before SQS can take the message. The first time a job of a name is clamped, the adapter
     warns once for that name with the job's `maxAttempts`, the queue's `maxReceiveCount` and the
     budget used, and recommends `maxReceiveCount = maxAttempts + 1`. The budget is never a reason
     to refuse (maintainer, D3). With `maxReceiveCount` 1 the budget is 1 and the warning adds that
     a worker dying on that one attempt leaves the message to SQS's own redrive without `onFailed`;
     the payload is still kept in the dead-letter queue.
  6. When the attribute read is refused (`AccessDenied`) or the transport lacks
     `getQueueAttributes`: with an explicit `deadLetterQueues[name]` the adapter warns once that a
     redrive policy cannot be detected and continues unclamped; without one it refuses (step 4),
     because no target can be proved.
  7. `deadLetter` always forwards: send the original body to the target with three message
     attributes, `setu-dead-letter-reason` (DataType `String`: `attempts-exhausted`, `abandoned` or
     `unreadable`), `setu-attempts` (DataType `Number`, the receive count) and
     `setu-source-message-id` (DataType `String`, the source's SQS message id, so an operator can
     match the copy to the warning and the `onFailed` call; Compared with row 12), then delete the
     source. When the send fails, the source is kept and `deadLetter` throws (the service reports
     `queue job settlement failed`, §3.2 counts nothing); the message returns after its visibility
     timeout and the dead-worker path tries again. When the delete fails after a successful send,
     the existing duplicate-risk log is kept (`sqs-queue.ts:576-587`) and `deadLetter` throws. The
     delete-without-target branch (`:588-594`) is removed. No error message text is attached (§10).
     The receive requests no message attributes (`sqs-queue.ts:162`), so any attributes a producer
     set are not carried to the forwarded copy; this is documented.
- **§3.3a The discard opt-out.** `deadLetterQueues` widens from `Record<string, string>` to
  `Record<string, string | false>`. `false` for a name means "discard exhausted jobs of this name":
  1. the name is never refused and its queue attributes are not read (no clamp, no
     `GetQueueAttributes` right needed); an explicit `false` wins over a redrive policy;
  2. an exhausted job still runs `onFailed` once (both the final-failure path and the dead-worker
     path, unchanged), and `deadLetter` then deletes the source message instead of forwarding it;
  3. each discard is logged at `warn` with the job name, the job id and the receive count, never the
     payload ("discarded after N attempts; deadLetterQueues[name] is false");
  4. the outcome is counted as `queue_jobs_total{outcome="discarded"}`, a new value of the package's
     own `JobOutcome` (`job-processor.ts:52`), counted after the delete succeeds (§3.2). The
     diagnostics observer's settlement vocabulary is a `common` type (`diagnostics.ts:618-619`) with
     no discard member, so the observer is told `dead-lettered` with outcome `terminal-error`; Part
     B adds `discarded` there and the observer reports it (§3.18);
  5. an unreadable message on a `false` name (§3.5) is deleted and warned the same way; no
     `onFailed`, no count, as in §3.5.

  Name: a `false` entry beside the targets, rather than a separate option, so the target and its
  absence are decided in one place and the refusal can quote the one line to add. Compared with rows
  16 to 18: Sidekiq spells it `dead: false` per job class; BullMQ `removeOnFail: true` per job or as
  a default; MassTransit `DiscardFaultedMessages()` per receive endpoint; this repo's messaging
  brokers use `consumerRetry: false` for the same "opt out of the dead-letter store" meaning. Per
  queue matches MassTransit's receive endpoint and is the only scope the SQS adapter has (one queue
  per name).

- **Rights:** consuming now needs `sqs:GetQueueAttributes` on the source queue, `sqs:GetQueueUrl`
  when the policy names the target, `sqs:SendMessage` on the target, and `kms:GenerateDataKey` when
  the target is encrypted with a customer-managed KMS key. Native redrive needed none of them. The
  README, the upgrade note and the refusal message list them.
- **Why:** V13-199 and V13-214 are one seam, "where does an exhausted job go". Compared with, rows 2
  and 3: memory, Redis, RabbitMQ, BullMQ and Sidekiq keep the job with nothing configured;
  MassTransit creates an error queue; Spring Cloud AWS and the .NET framework defer to the redrive
  policy. Creating a queue needs `sqs:CreateQueue`, which production roles often lack, so the
  adapter uses the policy when it exists and refuses otherwise. Forwarding in both cases keeps one
  mechanism and one place where `onFailed` and the counter run (D3).
- **Test home:** `sqs-dead-letter-target.test.ts` (each step against a recording fake transport:
  parse rules, consumed names only, parallel bounded reads, the clamp and its one warning, both
  refusal and its message naming all three ways past it, forward attributes, a failed send keeps the
  source and throws, no delete without a target or `false`; the opt-out: starts with no target and
  no attribute read, runs `onFailed` once, deletes the message, warns without the payload, counts
  `discarded`; without it the start is refused); `exhausted-job-conformance.test.ts`.

### 3.4 `SnsPublisher.publishJob` writes the envelope `SqsQueue` reads, and `SqsQueue` reads a wrapped delivery

- **Decision:**
  1. A new internal module `sqs-envelope.ts` owns `encodeSqsEnvelope(job)` and
     `decodeSqsEnvelope(body, polledName)`. `SqsQueue.enqueue` and `#validateEnvelope` move onto it,
     so the queue and the publisher cannot drift.
  2. `decodeSqsEnvelope` accepts a raw envelope, and an SNS notification body
     (`Type === 'Notification'`, string `Message`, string `TopicArn`), whose `Message` it decodes as
     the envelope. It returns `{ ok: true, envelope } | { ok: false, reason }` and never throws.
     `maxAttempts` may be absent from the envelope; `reserve` then uses the queue's default (item
     5).
  3. `SnsPublisher.publishJob<T>(name, data, options?)`, with `options`
     `{ id?, maxAttempts?, headers? }`, publishes `encodeSqsEnvelope` to the topic. `id` defaults to
     `runtime.uuid()` from a new option `SnsPublisherOptions.runtime?: IRuntimeServices`
     (AI_GUIDELINES §4.2 forbids `crypto.randomUUID()` outside `packages/runtime`); `publishJob`
     with neither `runtime` nor `options.id` throws a `TypeError` saying which to pass.
     `maxAttempts`, when not given, is omitted from the envelope, so the consuming queue applies its
     own `defaultMaxAttempts`. `headers` are copied into the envelope. Nothing is mirrored into SNS
     message attributes: SNS drops a message with more than 10 attributes bound for a raw SQS
     subscription, and no framework reader would consume them (`ISnsTransport.publish` is
     unchanged).
  4. A new option `SnsPublisherOptions.telemetry?: ITelemetryService`: when given, `publishJob`
     opens a producer span and writes its `traceparent` into the envelope headers with the codec
     `TracedQueue` uses (`contextToTraceparent`, `TRACEPARENT_HEADER` from `common`). The consuming
     queue's tracing decorator then continues the trace. Its consumer is `publishJob` alone.
  5. `SqsQueue` takes a fourth constructor parameter `defaults?: { maxAttempts?: number }`, which
     the plugin fills from its resolved `defaultMaxAttempts` (`queue-plugin.ts:85`); default 3. It
     is read by `reserve` for an envelope without `maxAttempts`. The dead
     `envelope.maxAttempts ?? 3` at `sqs-queue.ts:449` goes.
  6. `publish(message)` stays as the raw form for subscribers that are not the queue adapter; its
     JSDoc and the README say the queue adapter cannot read it.
- **Why:** X121-3's three remedies are all needed for "a pairing": the publisher writes the
  envelope, the adapter unwraps a wrapped delivery, and the README documents both. Spring Cloud AWS
  unwraps SNS notifications in its SQS listener (Compared with, `@SnsNotificationMessage`, reference
  3.3.0). The envelope `name` must equal the consuming job name, which is documented: one publish
  feeds every queue whose processor consumes that name. The row's "no `traceparent`" is closed by
  the envelope header; its "no attributes" is closed by documenting why none are sent.
- **Untrusted input:** an SNS notification is accepted without verifying its signature; the queue's
  access policy is the boundary, as it is today for any principal with `SendMessage` (§10).
- **Test home:** `sqs-envelope.test.ts` (round trip, wrapped and raw, absent `maxAttempts`, every
  refusal reason, never throws); `sns-publisher.test.ts` (envelope equals `encodeSqsEnvelope`,
  `runtime.uuid()` and the `TypeError`, `traceparent` with and without telemetry, `publish`
  unchanged); `sqs-queue.test.ts` (the `defaults` parameter); `sns-sqs-localstack.test.ts` (guarded
  real round trip on a raw and a wrapped subscription).

### 3.5 A message the SQS adapter cannot read is retired once, without its body in the log

- **Decision:** when `decodeSqsEnvelope` refuses a body (malformed JSON, wrong version, a missing
  field, or a `name` other than the polled name), or the receive count is invalid, `reserve`
  forwards the body unchanged to the **polled** name's dead-letter target (one queue per name:
  `reserve(name)` polls `#getQueueUrl(name)`) with reason `unreadable`, and deletes the source,
  through the same forward as §3.3 step 7. It then warns with the job name, the reason and the SQS
  message id, never the body; the warning is per receive, so a message whose forward fails warns
  again each time it returns, and that warning says it was left for its visibility timeout (the
  RabbitMQ rule, `rabbitmq-queue.ts:738-748`). No `onFailed` runs and nothing is counted in
  `queue_jobs_total`: the message never became a job, and RabbitMQ's unreadable path does the same.
  The `JSON.stringify(parsed)` interpolation at `sqs-queue.ts:395` is removed. A
  `SubscriptionConfirmation` from a cross-account SNS subscription is retired this way too, which
  the README says (confirm the subscription from the console or the CLI first). The reader needs the
  message id, so `SqsReceivedMessage` gains `messageId?: string` and `adaptSqsModule` fills it.
- **Why:** sibling rule (Compared with, RabbitMQ row of 0.1). A target always exists for a consumed
  name after §3.3.
- **Test home:** `sqs-unreadable-message.test.ts` (malformed JSON, wrong version, wrong name, bad
  receive count; the warning text carries no body, asserted against a marker string in the body; a
  failed forward leaves the message and warns again on the next receive; no `onFailed`, no count).

### 3.6 A fan-out subscription in the `common` contract

- **Decision (in this PR, D1 decided 2026-11-23):** two optional members in
  `packages/common/src/services/messaging.ts`:
  - `SubscribeOptions.fanOut?: true`: "every subscribing instance receives every message published
    after it subscribed; the consumer is not durable and is removed on `unsubscribe()`. Refused with
    a `RangeError` together with `queue`."
  - `ISubscription.fanOut?: true`: "set by a broker that honoured `fanOut`. A caller that needs
    fan-out must check it: a broker that does not know the option ignores it."
- **Why:** the request must cross the plugin boundary, and the answer must be positive, because the
  Workers broker and a `custom` instance cannot be changed by this letter and would otherwise ignore
  the option silently. Compared with, row 4: Spring Cloud Stream's anonymous group and the Socket.IO
  adapters are the same shape (a per-instance, non-durable consumer). The alternative of a
  per-replica `queue` passed by the backplane needs no contract change but leaves a durable queue
  behind on every crash, and on RabbitMQ and Service Bus that queue keeps collecting frames for ever
  (§12, D1).
- **Test home:** `fan-out-subscribe.test.ts` (messaging-plugin; refusal with `queue`, marker set); a
  type test in `packages/common/test/unit/` that the two members exist and are optional. Every
  reader of `SubscribeOptions` and `ISubscription` is found with `rg` before the change; an
  implementor that builds a literal of one of these types is unaffected (both members optional).

### 3.7 How each broker honours `fanOut`

- **Decision:** one table, and the conformance test iterates it as data. A new internal module
  `fan-out.ts` holds the shared refusal (`fanOut` with `queue`), the per-instance name
  (`<defaultQueue>-fanout-<uuid>`), and the marker helper.

  | Arm           | Consumer created                                                                                                           | Removed on `unsubscribe()`       | Left behind by a crash, and who removes it                                                                                                                             |
  | ------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | memory        | the queue-less path (every subscriber invoked)                                                                             | yes                              | nothing                                                                                                                                                                |
  | RabbitMQ      | the queue-less exclusive auto-delete queue (`rabbitmq-broker.ts:896-897`)                                                  | yes                              | nothing (exclusive)                                                                                                                                                    |
  | NATS          | the transient ephemeral consumer the reply inbox uses (`nats-broker.ts:700-716`), `deliver_policy: 'new'`                  | deleted                          | the server, after `inactive_threshold` (5 min)                                                                                                                         |
  | Kafka         | a consumer group `<defaultQueue>-fanout-<uuid>`, joining at the end of each partition through the existing first-join rule | consumer stops; group left empty | Kafka, after `offsets.retention.minutes` (the reply-inbox precedent, `kafka-broker.ts:500-503`)                                                                        |
  | Redis Streams | a group `<defaultQueue>-fanout-<uuid>` created at `$` on the shared stream                                                 | `XGROUP DESTROY`                 | any live fan-out subscriber on the same stream destroys a `-fanout-` group whose consumers have all been idle longer than `consumerIdleSweepMs`, in the existing sweep |
  | Pub/Sub       | a subscription `<defaultQueue>-fanout-<uuid>` with `messageRetentionDuration` 600 s and `expirationPolicy.ttl` 86,400 s    | deleted                          | Pub/Sub, after one idle day (the minimum ttl; it must exceed the retention, Compared with, row 9)                                                                      |
  | Service Bus   | a subscription `<defaultQueue>-fanout-<uuid>` created through the admin client with `autoDeleteOnIdle` 5 minutes           | deleted                          | Service Bus, after 5 idle minutes (the minimum, row 9)                                                                                                                 |
  | custom        | the instance's own subscribe, options passed through                                                                       | the instance's                   | the instance's; the marker is the instance's to set                                                                                                                    |

  The transport ports gain what the table needs:
  `IPubSubTransport.createSubscription(topic, sub, options?)` and
  `IServiceBusTransport.createSubscription(topic, sub, options?)` take an optional options object
  (`{ messageRetentionSeconds?, expirationTtlSeconds? }` and `{ autoDeleteOnIdleMs? }`); M143m
  reuses the Service Bus one for the reply inbox (V13-263, §11).

- **Why:** each arm already has a per-instance consumer for its reply inbox, so fan-out reuses a
  mechanism that is built, tested and reaped, rather than inventing seven. The Redis Streams sweep
  is the one new reaper, because nothing on the server expires a group.
- **Test home:** `fan-out-conformance.test.ts` (the table as test data, §6);
  `redis-streams-fan-out-sweep.test.ts`.

### 3.8 The backplane asks for fan-out and refuses a broker that cannot give it

- **Decision:** `MessagingBackplane.connect()` subscribes with `{ fanOut: true }`. When the returned
  subscription lacks `fanOut === true`, it unsubscribes and throws `BackplaneFanOutUnsupportedError`
  (new, exported from `realtime-backplane-plugin`), whose message names the transport, says the
  broker gave a competing subscription, and points to the `redis` transport. Because `connect()`
  runs in `register` (`realtime-backplane-plugin.ts:129`), the application refuses to start.
- **Why:** ROADMAP outcome, "refuses at startup a broker it cannot fan out on". A positive marker is
  the only signal that works for the Workers broker and a `custom` instance (§3.6).
- **Test home:** `messaging-backplane.test.ts` (requested option, refusal, unsubscribe on refusal);
  `backplane-fan-out-real.test.ts` (two replicas per arm, the X122 check).

### 3.9 A frame older than `maxFrameAgeMs` is dropped by the receiver

- **Decision:** the `messaging` and `redis` transports stamp each published frame with
  `sentAtMs = runtime.now()` as an extra member beside the frame fields (the `RealtimeFrame` type is
  unchanged; a receiver from `0.13.0` ignores the member because `isRealtimeFrame` accepts extra
  members). On receipt, a frame whose `sentAtMs` is a finite number and
  `now - sentAtMs > maxFrameAgeMs` is dropped before dispatch; a frame without the member, or with a
  non-number, is delivered as today. The member is stripped before the frame reaches a handler. New
  option `maxFrameAgeMs` on `MessagingBackplaneOptions` and `RedisBackplaneOptions` only (memory
  frames cannot be late), default 5,000 (open decision D5), `0` disables, a number from 0 to
  2,147,483,647 otherwise refused with a `RangeError` at construction. Drops are counted and
  reported once per state change at `warn` through the transport's existing handler reporter
  ("dropping frames older than N ms; the oldest was M ms; check the broker and the replicas'
  clocks"), and once more when a frame is accepted again.
- **Why:** a paused server executes a command already written, so only the receiver can refuse a
  late frame (§0.1, X3-3). A wall clock across replicas is the only shared time; NTP keeps it within
  milliseconds, and the warning names the clock as a cause so a skewed host is visible rather than
  silent. The publisher's `publish failed` warning is reworded to say the frame may still arrive and
  is then dropped if older than the bound.
- **Test home:** `frame-age.test.ts` (stamp, strip, threshold edges, non-number member, disabled,
  warn once per state change); `backplane-lateness-real.test.ts` (a stalling TCP relay in front of
  Redis and of RabbitMQ, the precedent in
  `queue-plugin/test/integration/backend-fault-flap-real.test.ts:57`: frames sent during a 3 s stall
  arrive, if at all, only when younger than the bound).

### 3.10 An unroutable outbox row on RabbitMQ is not marked sent

- **Decision:** a new internal symbol `PUBLISH_REQUIRE_ROUTE` (in `publish-options.ts`, never
  exported, the `REPLY_INBOX_TRANSIENT` pattern). The outbox relay sets it on the options object it
  passes to `broker.publish`. `RabbitMqBroker.publishWithHeaders` reads it from the raw options
  before `validatePublishOptions` (which drops symbol keys, §1) and publishes through
  `#publishOn(..., requireRoute = true)`. A returned message rejects with a new exported
  `UnroutableMessageError` (topic and routing key in the message; never the payload). The relay's
  existing failure path then backs the row off and, after `relay.maxAttempts` (default 10,
  `outbox/options.ts:179`), marks it failed, which the outbox metrics already count. Every other
  broker ignores the symbol. The requirement for confirms and on/off return listeners
  (`rabbitmq-broker.ts:798-800`) applies; its error text is generalized from "consumer recovery" to
  name the routed publish. Plain `publish` is unchanged (open decision D6).
- **Why:** the README promises at-least-once delivery of every committed row; on RabbitMQ that holds
  only when a queue is bound. Compared with, row 6: Spring AMQP and RabbitMQ's own guide use
  `mandatory` with a return handler; the broker already has that path for its own copies.
- **Test home:** `rabbitmq-unroutable-publish.test.ts` (fake channel: `mandatory` on the wire for
  the relay and only for it, return → `UnroutableMessageError`, the symbol survives the traced and
  pipelined facade); `outbox-unroutable-real.test.ts` (guarded: a row for an unbound topic stays
  pending, then is delivered once a queue binds).

### 3.11 `consumerRetry` on Pub/Sub

- **Decision:** the Pub/Sub arms accept `consumerRetry?: false | ConsumerRetryOptions` and a new
  `deadLetterTopic?: string`. Enabled by default (open decision D4). Mapping, applied when the
  broker creates a subscription:
  - `delaysMs` sets the subscription `retryPolicy`: the first entry is `minimumBackoff`, the last is
    `maximumBackoff`. One or two entries, each from 0 to 600,000 ms (Pub/Sub's range); more entries,
    or a value outside the range, are refused with a `RangeError` saying Pub/Sub has only a minimum
    and a maximum. Default `[10000, 600000]`.
  - With `deadLetterTopic`, `deadLetterPolicy` is
    `{ deadLetterTopic, maxDeliveryAttempts: maxAttempts }`, `maxAttempts` from 5 to 100 (Pub/Sub's
    range), default 5. Without it there is no platform limit, and `connect()` warns once that a
    failing message is redelivered without limit until `deadLetterTopic` is set.
  - `isRetryable` returning `false` publishes the message to `deadLetterTopic` with its attributes
    plus `setu-dead-letter-reason: not-retryable` and acks it. `isRetryable` without
    `deadLetterTopic` is refused at construction.
  - An existing subscription is attached as today; when its retry or dead-letter policy differs from
    the configured one, the broker warns once naming the subscription and does not change it.
  - `false` restores today's immediate nack. The shared validation of `ConsumerRetryOptions` moves
    into a new internal `consumer-retry.ts` used by RabbitMQ, Redis Streams, Pub/Sub and Service
    Bus, each passing its own label and ranges; the RabbitMQ and Redis Streams messages stay word
    for word.
- **Why:** Pub/Sub reports `deliveryAttempt` only when a dead-letter policy exists, so the framework
  cannot count attempts itself; the platform's policies are the mechanism (Compared with, row 5,
  Google's page). Defaults follow the sibling arms (on by default) and Google's documented ranges.
- **Test home:** `pubsub-consumer-retry.test.ts` (fake transport records the created policy, every
  refusal, the not-retryable forward, the existing-subscription warning, `false`);
  `consumer-retry-conformance.test.ts`; `consumer-retry-options.test.ts` (shared validator, both old
  arms unchanged).

### 3.12 `consumerRetry` on Service Bus

- **Decision:** the Service Bus arms accept `consumerRetry?: false | ConsumerRetryOptions`, enabled
  by default with `maxAttempts` 5 and `delaysMs` `[1000, 5000, 30000, 120000]` (later attempts reuse
  the last). On a handler failure the broker reads the message's `deliveryCount`: below
  `maxAttempts` it waits the delay for that attempt while the SDK renews the lock, then abandons; at
  `maxAttempts`, or when `isRetryable` returns `false`, it calls `deadLetterMessage` with reason
  `setu-attempts-exhausted` or `setu-not-retryable`. A delay of 240,000 ms or more is refused,
  because the SDK renews a lock for at most 300,000 ms by default
  (`maxAutoLockRenewalDurationInMs`). At subscribe, when the admin client can read the
  subscription's `maxDeliveryCount` and it is below `maxAttempts`, the effective budget is
  `maxDeliveryCount` and the broker warns once (the SQS rule, §3.3). `false` restores today's
  immediate abandon. The transport port's `onMessage` gains `deliveryCount?: number` and
  `deadLetter(reason)`.
- **Why:** Service Bus has no per-message delay on abandon, and a scheduled copy sent to the topic
  would reach every other subscription; holding the message for the delay is what Spring Cloud
  Stream's in-process retry does (Compared with, row 5). It occupies one concurrency slot for the
  delay, which M143m documents with its concurrency option (V13-262, §11).
- **Test home:** `service-bus-consumer-retry.test.ts` (fake receiver and clock: spacing, budget,
  classifier, the 240,000 ms refusal, the `maxDeliveryCount` clamp and warning, `false`);
  `consumer-retry-conformance.test.ts`.

### 3.13 A Pub/Sub stream the SDK closed is re-opened, and reported while it is closed

- **Decision:** `IPubSubTransport.open` gains an optional fourth parameter
  `onClosed?: (error: unknown) => void`, called by the real adapter when the SDK subscription emits
  `close` without the broker having closed it. The broker then marks that subscription closed and
  re-opens it through `open` (which creates the subscription when it is absent,
  `pubsub-broker.ts:395-425`) after 1, 2, 5, 10, then every 30 seconds, until it succeeds or the
  broker disconnects. While any subscription is closed, `reachability()` returns `false`, so the
  messaging indicator is `down`; the closure and the recovery are each logged once.
- **Why:** the source comment's premise, "the SDK owns streaming-pull reconnection", holds only for
  retryable statuses (X122-3); the RabbitMQ and Service Bus arms recovered in the same run. Fixed
  timing, not an option: the same schedule shape as the connection recovery elsewhere in the
  package, and no row asks for a setting.
- **Test home:** `pubsub-stream-recovery.test.ts` (fake transport fires `onClosed`; re-open
  schedule, reachability `false` until it succeeds, a broker `disconnect()` stops the loop);
  `pubsub-emulator.test.ts` (guarded: delete the subscription under a running consumer through the
  admin API, recreate the topic's subscription by re-open, publish, receive).

### 3.14 Ordered Pub/Sub delivery keeps order across a failure

- **Decision:** on a broker built with `enableMessageOrdering`, a new internal module
  `pubsub-ordering.ts` dispatches messages per ordering key one at a time: the next message of a key
  runs only after the previous handler settled. When a handler fails, its message is nacked and
  every later message of the same key already received is nacked without running, until the failed
  message is delivered again. Messages without an ordering key, and brokers without
  `enableMessageOrdering`, keep concurrent dispatch.
- **Why:** Google's ordering page puts this on a subscriber with asynchronous callbacks, and a nack
  makes Pub/Sub redeliver the key's later messages (Compared with, row 7). The README cell is then
  rewritten from the measured result (C5).
- **Test home:** `pubsub-ordered-dispatch.test.ts` (serial per key, parallel across keys, the
  failure-then-redelivery sequence `0,1,2,3,4(fail),4,5,…`, no key unaffected);
  `pubsub-emulator.test.ts` re-runs X122-9's 15-message check.

### 3.15 One exhausted-job rule for every queue adapter

- **Decision:** the rule the README states becomes a tested property: on every adapter a job that
  exhausts its attempts calls `onFailed` once per final attempt, is counted `dead_lettered` once,
  when its dead-letter settle succeeds (§3.2), and its payload is in that adapter's dead store; an
  adapter that cannot prove a dead store refuses to start. Today memory, Redis and RabbitMQ satisfy
  it with nothing configured, and SQS after §3.3. The same rule is handed to M143o for WorkersQueue
  (V13-197, §11).
- **Why:** ROADMAP, "the same rule M143o applies on Workers"; Compared with, row 2.
- **Test home:** `exhausted-job-conformance.test.ts`.

### 3.16 What is not changed

- **Decision:** the SQS retry backoff and polling (V13-220), the SQS and SES reachability probe
  (V13-215) and every publish bound stay with M143m; the queue-less default of every broker stays as
  M119a decided; RabbitMQ plain publishes stay non-mandatory.
- **Why:** lane order and the maintainer decision of 2026-10-24.
- **Test home:** `no-options-unchanged.test.ts` (existing, in both packages) keeps passing with the
  new options absent, except where a row's fix changes a default (listed in the upgrade notes).

### 3.17 Documentation

- **Decision:** in this PR (or each part): queue-plugin README (SQS options table including
  `visibilityTimeoutSeconds`, `deadLetterQueues`, the redrive rule, the refusal, `publishJob`, the
  renewal, the 12-hour ceiling, the forwarded copy's attributes); messaging-plugin README (fan-out
  per arm with the table of §3.7, Pub/Sub and Service Bus `consumerRetry`, `deadLetterTopic`,
  ordering cell, stream recovery, outbox unroutable rule); backplane README (`'messaging'` section,
  `maxFrameAgeMs`, the lateness paragraph, the refusal); `PUBLIC_API.md` for every symbol in §4;
  `CHANGELOG.md` one entry per part; `docs/upgrading.md` with the BREAKING items in §4; the agent
  cards of the three packages. M143n then re-checks V13-229 and V13-269 against this text (§11).
- **Why:** CLAUDE.md, an export change updates PUBLIC_API.md in the same change.
- **Test home:** `pnpm run check:docs` and the fence gate for every changed example.

### 3.18 A `discarded` settlement state

- **Decision:** `QueueSettlementState` (`common` `diagnostics.ts`) gains `'discarded'`: "the adapter
  deleted an exhausted job because its dead-letter target is explicitly disabled
  (`deadLetterQueues[name]: false` on SQS); the job is gone, by configuration." When `deadLetter`
  returns `'discarded'` (§3.3a), the job processor and the service's dead-worker path report
  `settled('terminal-error', 'discarded')` instead of `'dead-lettered'`. SQS stays a non-confirming
  adapter (`DeleteMessage` with an old receipt can succeed without deleting), so the collector still
  maps a completed SQS settle to `unknown`; `discarded` reaches the wire only for an adapter that
  confirms, or as the input the collector maps. The JSDoc on `QueueSettlementState` is corrected:
  since Part A a stale SQS settle and a failed SQS dead-letter send reject (`failed`), and only a
  delete whose receipt has gone stale on the server is absorbed. `diagnostics-plugin`'s
  `queue-protocol.ts` accepts the new member in its `SETTLEMENTS` set. Every other reader found by
  `rg QueueSettlementState` (job processor, observation collector, service) is checked for an
  exhaustive switch or table.
- **Why:** §3.3a's discard is not a dead letter; reporting it as one tells an operator the payload
  is in a dead store when it is not.
- **Test home:** `job-processor.test.ts` and `sqs-dead-letter-target.test.ts` (the `discarded`
  settlement passed to the observer, on both the final-failure and dead-worker paths);
  `diagnostics-plugin` `queue-protocol` test (the new member accepted, an unknown string still
  refused).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none for implementors of an exported interface (every new interface
member is optional, every new transport parameter is optional). Behaviour changes that are BREAKING
for applications, all in `0.14.0` (a minor). Part A: an SQS name that is consumed with no
dead-letter target refuses (at `app.start()` for a declared processor, D9); consuming needs
`sqs:GetQueueAttributes`, `sqs:GetQueueUrl` (policy target) and `sqs:SendMessage` on the target; a
redrive policy lowers the effective `maxAttempts` (and `IJob.maxAttempts`) to `maxReceiveCount - 1`
when that is smaller; an unreadable message is moved to the dead-letter target instead of staying in
the source queue; a forwarded copy carries three `setu-` attributes and not the producer's; an SQS
`visibilityTimeoutSeconds` outside 1 to 43,200 is refused; a stale SQS settle now reports a
settlement failure; `queue_jobs_total` counts an outcome only after its settle succeeds, on every
adapter. Part B: Pub/Sub and Service Bus failing handlers are now delayed and limited by default; an
unroutable RabbitMQ outbox row is retried and then failed instead of marked sent; the backplane
`messaging` transport refuses a broker without fan-out; frames older than 5 s are dropped by
default.

| Exported symbol                                                                                     | Kind               | Consumer / real code path that READS it                                                                                |
| --------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `SubscribeOptions.fanOut` (common, out of lane)                                                     | interface member   | Read by `fan-out.ts` in every messaging-plugin broker; set by `MessagingBackplane.connect()`                           |
| `ISubscription.fanOut` (common, out of lane)                                                        | interface member   | Set by every broker that honours `fanOut`; read by `MessagingBackplane.connect()`                                      |
| `QueueSettlementState` member `'discarded'` (common, out of lane)                                   | type member        | Passed by `job-processor.ts` and `queue-service.ts` on a discard; accepted by `diagnostics-plugin` `queue-protocol.ts` |
| `SqsDeadLetterTargetMissingError` (queue-plugin)                                                    | class              | Thrown by `SqsQueue.prepareConsumer` (D9); an application catches it from `app.start()` for a declared processor       |
| `ISqsTransport.getQueueAttributes?`, `getQueueUrl?`                                                 | interface members  | Called by `sqs-redrive.ts` when a name is first consumed; `adaptSqsModule` implements both                             |
| `ISqsTransport.send` 4th parameter `attributes?`                                                    | parameter          | Read by `adaptSqsModule`'s send; written by the dead-letter forward                                                    |
| `SqsQueueOptions.deadLetterQueues` value type `string \| false`                                     | type widening      | Read by `sqs-redrive.ts` and `deadLetter` (§3.3a)                                                                      |
| `SqsReceivedMessage.messageId?`                                                                     | interface member   | Filled by `adaptSqsModule`; read by the unreadable warning and the `setu-source-message-id` attribute                  |
| `SqsSdkModule.GetQueueAttributesCommand`, `GetQueueUrlCommand`                                      | interface members  | Used by `adaptSqsModule`                                                                                               |
| `SqsQueue` constructor 4th parameter `defaults?`                                                    | parameter          | Filled by `QueuePlugin` from `defaultMaxAttempts`; read by `reserve` for an envelope without `maxAttempts`             |
| `SnsPublisher.publishJob`                                                                           | method             | Application code; the SNS to SQS pairing                                                                               |
| `SnsPublisherOptions.telemetry`                                                                     | option             | Read by `publishJob` (§4.1)                                                                                            |
| `SnsPublisherOptions.runtime`                                                                       | option             | Read by `publishJob` for the default `id` (§4.1)                                                                       |
| `UnroutableMessageError` (messaging-plugin)                                                         | class              | Thrown by `RabbitMqBroker` on a returned routed publish; read by the outbox relay's failure path and by applications   |
| `PubSubMessagingOptions*.consumerRetry`, `.deadLetterTopic`                                         | options            | Read by `GcpPubSubBroker` (§4.1)                                                                                       |
| `ServiceBusMessagingOptions*.consumerRetry`                                                         | option             | Read by `ServiceBusBroker` (§4.1)                                                                                      |
| `IPubSubTransport.createSubscription` 3rd parameter, `open` 4th parameter                           | parameters         | Read by `adaptPubSubModule`; written by the fan-out path and the recovery path                                         |
| `IServiceBusTransport.createSubscription` 3rd parameter; `onMessage` `deliveryCount?`, `deadLetter` | parameter, members | Read by `adaptServiceBusModule`; written by the fan-out path and §3.12                                                 |
| `BackplaneFanOutUnsupportedError` (backplane)                                                       | class              | Thrown by `MessagingBackplane.connect()`; surfaces from `app.start()`                                                  |
| `MessagingBackplaneOptions.maxFrameAgeMs`, `RedisBackplaneOptions.maxFrameAgeMs`                    | options            | Read by the receive path of each transport (§4.1)                                                                      |

Internal and not exported: `sqs-redrive.ts`, `sqs-envelope.ts`, `QueueAdapter.prepareConsumer`,
`fan-out.ts`, `consumer-retry.ts`, `pubsub-ordering.ts`, `frame-age.ts`, `PUBLISH_REQUIRE_ROUTE`,
`StaleClaimError`.

### 4.1 Options — every option names its consumer

| Option                                                                              | Consumer                                                         | Behavior (per implementation)                                                                                                                          |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SqsQueueOptions.visibilityTimeoutSeconds` (existing, now validated and documented) | `SqsQueue` receive and `claimRenewal`                            | Integer 1 to 43,200; renewal every third                                                                                                               |
| `SqsQueueOptions.deadLetterQueues` (existing, widened to `string \| false` values)  | `sqs-redrive.ts` target resolution; `deadLetter`                 | A URL is the explicit target and wins over the redrive policy's; `false` discards exhausted jobs of that name (§3.3a); only consumed names are checked |
| `SnsPublisherOptions.telemetry`                                                     | `SnsPublisher.publishJob`                                        | Producer span and `traceparent` in the envelope; ignored by `publish` (documented)                                                                     |
| `SnsPublisherOptions.runtime`                                                       | `SnsPublisher.publishJob`                                        | `runtime.uuid()` for an absent `id`; without it and without `id`, `publishJob` throws a `TypeError`; ignored by `publish`                              |
| `consumerRetry` on Pub/Sub                                                          | `GcpPubSubBroker` subscription creation and handler failure path | §3.11                                                                                                                                                  |
| `deadLetterTopic` on Pub/Sub                                                        | `GcpPubSubBroker` dead-letter policy and not-retryable forward   | §3.11                                                                                                                                                  |
| `consumerRetry` on Service Bus                                                      | `ServiceBusBroker` handler failure path                          | §3.12                                                                                                                                                  |
| `maxFrameAgeMs` (messaging and redis transports)                                    | each transport's receive filter                                  | §3.9; not on the memory arm                                                                                                                            |
| `SubscribeOptions.fanOut`                                                           | every broker's subscribe; the custom arm passes it through       | §3.7                                                                                                                                                   |

## 5. Implementation files

| File                                                                             | Purpose                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/common/src/services/messaging.ts` (out of lane, D1)                    | `SubscribeOptions.fanOut`, `ISubscription.fanOut` with JSDoc                                                                                                                                                                                                                                                                         |
| `packages/common/src/services/diagnostics.ts` (out of lane, D1)                  | `'discarded'` in `QueueSettlementState`; corrected JSDoc (§3.18)                                                                                                                                                                                                                                                                     |
| `packages/diagnostics-plugin/src/protocol/queue-protocol.ts` (out of lane, D1)   | `'discarded'` in the `SETTLEMENTS` set                                                                                                                                                                                                                                                                                               |
| `packages/queue-plugin/src/index.ts`                                             | Export `SqsDeadLetterTargetMissingError`                                                                                                                                                                                                                                                                                             |
| `packages/queue-plugin/src/errors.ts`                                            | `SqsDeadLetterTargetMissingError`                                                                                                                                                                                                                                                                                                    |
| `packages/queue-plugin/src/adapters/sqs-queue.ts`                                | `claimRenewal`, validation, stale settles throw, `prepareConsumer` target resolution, clamp and its warning, forward with attributes, unreadable retirement, envelope through `sqs-envelope.ts`, `defaults` parameter, `getQueueAttributes`/`getQueueUrl`/attributes/`messageId` in `adaptSqsModule`, logger typed `{ error, warn }` |
| `packages/queue-plugin/src/adapters/queue-adapter.ts`                            | Optional internal `prepareConsumer?(name): Promise<void>` (D9)                                                                                                                                                                                                                                                                       |
| `packages/queue-plugin/src/services/queue-service.ts`                            | Awaits `prepareConsumer` before a name's first poll; a refusal reported once, the name not polled; `prepare(name)` used by the plugin for declared processors                                                                                                                                                                        |
| `packages/queue-plugin/src/processors/job-processor.ts`                          | Count outcomes after the settle resolves (§3.2)                                                                                                                                                                                                                                                                                      |
| `packages/queue-plugin/src/plugin/queue-plugin.ts`                               | Passes `defaults` and the `warn` logger to `SqsQueue`; awaits `prepare` for every declared processor name before registering it (in `register`, or in `onInit` when factories defer registration)                                                                                                                                    |
| `packages/queue-plugin/src/adapters/sqs-redrive.ts` (new, internal)              | Parse `RedrivePolicy`, ARN to name and account, resolve target and budget per name                                                                                                                                                                                                                                                   |
| `packages/queue-plugin/src/adapters/sqs-envelope.ts` (new, internal)             | Encode and decode the v1 envelope; SNS notification unwrap                                                                                                                                                                                                                                                                           |
| `packages/queue-plugin/src/sns/sns-publisher.ts`                                 | `publishJob`, `telemetry` option, attributes                                                                                                                                                                                                                                                                                         |
| `packages/queue-plugin/README.md`, `packages/queue-plugin/AGENT_CARD.md`         | §3.17                                                                                                                                                                                                                                                                                                                                |
| `packages/messaging-plugin/src/index.ts`                                         | Export `UnroutableMessageError`                                                                                                                                                                                                                                                                                                      |
| `packages/messaging-plugin/src/errors.ts`                                        | `UnroutableMessageError`                                                                                                                                                                                                                                                                                                             |
| `packages/messaging-plugin/src/brokers/fan-out.ts` (new, internal)               | Shared fan-out refusal, naming, marker                                                                                                                                                                                                                                                                                               |
| `packages/messaging-plugin/src/brokers/consumer-retry.ts` (new, internal)        | Shared `ConsumerRetryOptions` validation with per-arm ranges                                                                                                                                                                                                                                                                         |
| `packages/messaging-plugin/src/brokers/pubsub-ordering.ts` (new, internal)       | Per-key serial dispatch and the nack-until-redelivered rule                                                                                                                                                                                                                                                                          |
| `packages/messaging-plugin/src/brokers/in-memory-broker.ts`                      | Fan-out marker                                                                                                                                                                                                                                                                                                                       |
| `packages/messaging-plugin/src/brokers/rabbitmq-broker.ts`                       | Fan-out marker; routed publish for `PUBLISH_REQUIRE_ROUTE`; validation through `consumer-retry.ts`                                                                                                                                                                                                                                   |
| `packages/messaging-plugin/src/brokers/nats-broker.ts`                           | Fan-out through the transient consumer path                                                                                                                                                                                                                                                                                          |
| `packages/messaging-plugin/src/brokers/kafka-broker.ts`                          | Fan-out group                                                                                                                                                                                                                                                                                                                        |
| `packages/messaging-plugin/src/brokers/redis-streams-broker.ts`                  | Fan-out group, destroy on close, idle `-fanout-` group sweep; validation through `consumer-retry.ts`                                                                                                                                                                                                                                 |
| `packages/messaging-plugin/src/brokers/pubsub-broker.ts`                         | Fan-out subscription, retry and dead-letter policies, not-retryable forward, stream recovery, ordered dispatch                                                                                                                                                                                                                       |
| `packages/messaging-plugin/src/brokers/service-bus-broker.ts`                    | Fan-out subscription with idle deletion, hold-then-abandon retry, `deadLetterMessage`, `maxDeliveryCount` read                                                                                                                                                                                                                       |
| `packages/messaging-plugin/src/brokers/publish-options.ts`                       | `PUBLISH_REQUIRE_ROUTE` symbol                                                                                                                                                                                                                                                                                                       |
| `packages/messaging-plugin/src/outbox/relay.ts`                                  | Sets `PUBLISH_REQUIRE_ROUTE`                                                                                                                                                                                                                                                                                                         |
| `packages/messaging-plugin/src/interfaces/index.ts`                              | New Pub/Sub and Service Bus options                                                                                                                                                                                                                                                                                                  |
| `packages/messaging-plugin/src/plugin/messaging-plugin.ts`                       | Forwards the new options to both brokers                                                                                                                                                                                                                                                                                             |
| `packages/messaging-plugin/README.md`, `AGENTS` card                             | §3.17                                                                                                                                                                                                                                                                                                                                |
| `packages/realtime-backplane-plugin/src/index.ts`                                | Export `BackplaneFanOutUnsupportedError`                                                                                                                                                                                                                                                                                             |
| `packages/realtime-backplane-plugin/src/errors.ts` (new)                         | `BackplaneFanOutUnsupportedError`                                                                                                                                                                                                                                                                                                    |
| `packages/realtime-backplane-plugin/src/transports/frame-age.ts` (new, internal) | Stamp, strip, age check, warn once per state change                                                                                                                                                                                                                                                                                  |
| `packages/realtime-backplane-plugin/src/transports/messaging-backplane.ts`       | `fanOut`, marker check, frame age                                                                                                                                                                                                                                                                                                    |
| `packages/realtime-backplane-plugin/src/transports/redis-backplane.ts`           | Frame age; reworded publish warning                                                                                                                                                                                                                                                                                                  |
| `packages/realtime-backplane-plugin/src/interfaces/index.ts`                     | `maxFrameAgeMs` on two arms                                                                                                                                                                                                                                                                                                          |
| `packages/realtime-backplane-plugin/src/transports/backplane-factory.ts`         | Passes `maxFrameAgeMs`                                                                                                                                                                                                                                                                                                               |
| `packages/realtime-backplane-plugin/package.json`                                | `@setu-ts/messaging-plugin` as a devDependency (test only, the `websocket-plugin` precedent)                                                                                                                                                                                                                                         |
| `packages/realtime-backplane-plugin/README.md`, `AGENTS` card                    | §3.17                                                                                                                                                                                                                                                                                                                                |
| `PUBLIC_API.md`, `CHANGELOG.md`, `docs/upgrading.md`                             | §3.17                                                                                                                                                                                                                                                                                                                                |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

Real arms run in the guarded suites when their variable is set: `REDIS_URL`, `RABBITMQ_URL`,
`NATS_URL`, `KAFKA_BROKERS`, `PUBSUB_EMULATOR_HOST` with `PUBSUB_PROJECT_ID`,
`SERVICEBUS_CONNECTION_STRING` plus a new `SERVICEBUS_ADMIN_CONNECTION_STRING` (the emulator's
administration port 5300, X122-7), `SQS_ENDPOINT_URL` (ElasticMQ), and a new
`AWS_LOCALSTACK_ENDPOINT_URL` for SNS. Every other arm runs against the package's existing recording
fakes. Each conformance table is test data; a broker or adapter missing from the table fails a
completeness assertion against the package's list of arms.

| Test file                                                                                                                                                                                                                                                                                                             | src covered                                                          | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/test/unit/fan-out-contract.test.ts` (new)                                                                                                                                                                                                                                                                     | `services/messaging.ts`, `services/diagnostics.ts` (types)           | `fanOut` optional on both interfaces; `'discarded'` assignable to `QueueSettlementState`                                                                                                                                                                                                                    |
| `diagnostics-plugin/test/unit/queue-protocol.test.ts` (extended)                                                                                                                                                                                                                                                      | `protocol/queue-protocol.ts`                                         | `discarded` accepted; an unknown settlement string still refused                                                                                                                                                                                                                                            |
| `queue-plugin/test/unit/sqs-claim-renewal.test.ts`                                                                                                                                                                                                                                                                    | `sqs-queue.ts`                                                       | §3.1, §3.2: `claimRenewal.extend(name, id, token): Promise<boolean>`; range refusals; stale settles throw                                                                                                                                                                                                   |
| `queue-plugin/test/unit/sqs-dead-letter-target.test.ts`                                                                                                                                                                                                                                                               | `sqs-redrive.ts`, `sqs-queue.ts`, `errors.ts`                        | §3.3 steps 1 to 6, both refusals, clamp warning, forward attributes, no delete without target                                                                                                                                                                                                               |
| `queue-plugin/test/unit/sqs-envelope.test.ts`                                                                                                                                                                                                                                                                         | `sqs-envelope.ts`                                                    | Round trip; SNS notification unwrap; each refusal reason; never throws                                                                                                                                                                                                                                      |
| `queue-plugin/test/unit/sqs-unreadable-message.test.ts`                                                                                                                                                                                                                                                               | `sqs-queue.ts`                                                       | §3.5; warning text carries no body (asserted against a body containing a marker string)                                                                                                                                                                                                                     |
| `queue-plugin/test/unit/sns-publisher.test.ts` (extended)                                                                                                                                                                                                                                                             | `sns-publisher.ts`                                                   | `publishJob<T>(name, data, options?)`; envelope equals `encodeSqsEnvelope`; attributes; `traceparent` with telemetry; `publish` unchanged                                                                                                                                                                   |
| `queue-plugin/test/unit/sqs-adapter.test.ts` (extended)                                                                                                                                                                                                                                                               | `sqs-queue.ts` (`adaptSqsModule`)                                    | The two new commands, the attributes argument and `messageId` reach and leave the SDK fake                                                                                                                                                                                                                  |
| `queue-plugin/test/unit/sqs-queue.test.ts` (updated)                                                                                                                                                                                                                                                                  | `sqs-queue.ts`                                                       | Existing assertions of the delete-without-target branch and the log-and-return settles are replaced by the new behaviour; `defaults` parameter                                                                                                                                                              |
| `queue-plugin/test/unit/job-processor.test.ts` (extended)                                                                                                                                                                                                                                                             | `job-processor.ts`                                                   | Outcome counted only after a resolving settle, for all three outcomes                                                                                                                                                                                                                                       |
| `queue-plugin/test/unit/sqs-consumer-preparation.test.ts`                                                                                                                                                                                                                                                             | `queue-service.ts`, `queue-plugin.ts`, `sqs-queue.ts`                | D9: a declared processor without a target fails `app.start()` with `SqsDeadLetterTargetMissingError`; a producer-only name starts; an imperative `process()` refusal is reported once and the name is never polled; `prepareConsumer` absent on other adapters changes nothing                              |
| `queue-plugin` existing SQS tests that start an SQS queue with no target (`integration/queue-diagnostics.test.ts`, `header-conformance.test.ts`, `queue-plugin-logger-ordering.test.ts`, `sqs-arm-integration.test.ts`, `unit/adapters/sqs-health.test.ts`, `unit/queue-plugin.test.ts`, `e2e/sqs-elasticmq.test.ts`) | —                                                                    | Given a `deadLetterQueues` entry or a fake `getQueueAttributes`, so they keep testing what they tested                                                                                                                                                                                                      |
| `queue-plugin/test/integration/exhausted-job-conformance.test.ts`                                                                                                                                                                                                                                                     | adapters, `queue-service.ts`                                         | §3.15 over memory, redis, rabbitmq, sqs: `onFailed` once, counter once, payload in the dead store; SQS without a target refuses; real arms guarded                                                                                                                                                          |
| `queue-plugin/test/integration/long-job-lease-conformance.test.ts`                                                                                                                                                                                                                                                    | `sqs-queue.ts`, `redis-queue.ts`                                     | A job three leases long runs once and is acked once on every adapter with a lease (redis, sqs); real ElasticMQ with a 2 s timeout and a 7 s job                                                                                                                                                             |
| `queue-plugin/test/e2e/sqs-elasticmq.test.ts` (extended)                                                                                                                                                                                                                                                              | `sqs-queue.ts`                                                       | Redrive-policy target, clamp, unreadable message retired, against ElasticMQ                                                                                                                                                                                                                                 |
| `queue-plugin/test/e2e/sns-sqs-localstack.test.ts` (new)                                                                                                                                                                                                                                                              | `sns-publisher.ts`, `sqs-envelope.ts`                                | `publishJob` read by `SqsQueue` on a raw and a wrapped subscription; `traceparent` survives                                                                                                                                                                                                                 |
| `messaging-plugin/test/unit/fan-out-subscribe.test.ts`                                                                                                                                                                                                                                                                | `fan-out.ts`, every broker file                                      | `subscribe(topic, h, { fanOut: true })` sets `fanOut` on the returned `ISubscription`; `queue` with `fanOut` refused; per-arm consumer shape on fakes as in §3.7                                                                                                                                            |
| `messaging-plugin/test/integration/fan-out-conformance.test.ts`                                                                                                                                                                                                                                                       | every broker file                                                    | Table §3.7 as data: two broker instances, N publishes from each, each instance receives all 2N; `unsubscribe()` removes the per-instance resource (recorded on fakes, listed through the admin API on real arms); negative control: the same table without `fanOut` loses messages on the shared-group arms |
| `messaging-plugin/test/unit/redis-streams-fan-out-sweep.test.ts`                                                                                                                                                                                                                                                      | `redis-streams-broker.ts`                                            | Idle `-fanout-` groups destroyed; a group with a live consumer, and a non-fan-out group, kept                                                                                                                                                                                                               |
| `messaging-plugin/test/unit/consumer-retry-options.test.ts`                                                                                                                                                                                                                                                           | `consumer-retry.ts`, `rabbitmq-broker.ts`, `redis-streams-broker.ts` | Shared validator; the two old arms' refusal texts unchanged (both entry points, non-default config)                                                                                                                                                                                                         |
| `messaging-plugin/test/unit/pubsub-consumer-retry.test.ts`                                                                                                                                                                                                                                                            | `pubsub-broker.ts`, `messaging-plugin.ts`                            | §3.11 against a recording fake transport                                                                                                                                                                                                                                                                    |
| `messaging-plugin/test/unit/service-bus-consumer-retry.test.ts`                                                                                                                                                                                                                                                       | `service-bus-broker.ts`, `messaging-plugin.ts`                       | §3.12 against a fake receiver and clock                                                                                                                                                                                                                                                                     |
| `messaging-plugin/test/integration/consumer-retry-conformance.test.ts`                                                                                                                                                                                                                                                | the four retrying brokers                                            | One table over rabbitmq, redis-streams, pubsub, service-bus: a handler that always fails is delivered exactly `maxAttempts` times (Pub/Sub: within the platform's documented approximation), spaced by at least the configured minimum delay, then dead-lettered with its payload; real arms guarded        |
| `messaging-plugin/test/unit/pubsub-ordered-dispatch.test.ts`                                                                                                                                                                                                                                                          | `pubsub-ordering.ts`, `pubsub-broker.ts`                             | §3.14 sequences                                                                                                                                                                                                                                                                                             |
| `messaging-plugin/test/unit/pubsub-stream-recovery.test.ts`                                                                                                                                                                                                                                                           | `pubsub-broker.ts`                                                   | §3.13 schedule, reachability, stop on disconnect                                                                                                                                                                                                                                                            |
| `messaging-plugin/test/unit/pubsub-adapter.test.ts` (extended)                                                                                                                                                                                                                                                        | `pubsub-broker.ts` (`adaptPubSubModule`)                             | `onClosed` on an unrequested `close`; policies and expiry passed to `createSubscription`                                                                                                                                                                                                                    |
| `messaging-plugin/test/unit/service-bus-adapter.test.ts` (extended)                                                                                                                                                                                                                                                   | `service-bus-broker.ts` (`adaptServiceBusModule`)                    | `autoDeleteOnIdle` passed; `deliveryCount` and `deadLetter` reach the receiver fake                                                                                                                                                                                                                         |
| `messaging-plugin/test/e2e/pubsub-emulator.test.ts` (extended)                                                                                                                                                                                                                                                        | `pubsub-broker.ts`                                                   | Recovery after a deleted subscription; ordering check; retry policy on the created subscription                                                                                                                                                                                                             |
| `messaging-plugin/test/e2e/service-bus-emulator.test.ts` (extended)                                                                                                                                                                                                                                                   | `service-bus-broker.ts`                                              | Retry spacing and dead-letter reason; fan-out subscription created and deleted                                                                                                                                                                                                                              |
| `messaging-plugin/test/unit/rabbitmq-unroutable-publish.test.ts`                                                                                                                                                                                                                                                      | `rabbitmq-broker.ts`, `publish-options.ts`, `relay.ts`, `errors.ts`  | §3.10 on the fake channel and through the facade                                                                                                                                                                                                                                                            |
| `messaging-plugin/test/integration/outbox-unroutable-real.test.ts`                                                                                                                                                                                                                                                    | `relay.ts`, `rabbitmq-broker.ts`                                     | Guarded `RABBITMQ_URL`: pending while unbound, delivered after binding, failed after the budget                                                                                                                                                                                                             |
| `realtime-backplane-plugin/test/unit/frame-age.test.ts`                                                                                                                                                                                                                                                               | `frame-age.ts`                                                       | §3.9                                                                                                                                                                                                                                                                                                        |
| `realtime-backplane-plugin/test/unit/messaging-backplane.test.ts` (extended)                                                                                                                                                                                                                                          | `messaging-backplane.ts`, `errors.ts`                                | `fanOut` requested; refusal and unsubscribe; frame age applied                                                                                                                                                                                                                                              |
| `realtime-backplane-plugin/test/unit/redis-backplane.test.ts` (extended)                                                                                                                                                                                                                                              | `redis-backplane.ts`                                                 | Stamp on publish, drop on receive, reworded warning                                                                                                                                                                                                                                                         |
| `realtime-backplane-plugin/test/unit/backplane-factory.test.ts` (extended)                                                                                                                                                                                                                                            | `backplane-factory.ts`, `interfaces/index.ts`                        | `maxFrameAgeMs` passed and validated on both arms                                                                                                                                                                                                                                                           |
| `realtime-backplane-plugin/test/integration/backplane-fan-out-real.test.ts` (new)                                                                                                                                                                                                                                     | `messaging-backplane.ts`                                             | The X122 check per arm (rabbitmq, kafka, nats, redis-streams, pubsub, service-bus): two replicas, 50 frames each way, all arrive; memory transport as the negative control; Workers-shaped fake broker refused at start                                                                                     |
| `realtime-backplane-plugin/test/integration/backplane-lateness-real.test.ts` (new)                                                                                                                                                                                                                                    | `redis-backplane.ts`, `messaging-backplane.ts`, `frame-age.ts`       | Stalling relay before Redis and RabbitMQ; no frame older than the bound is dispatched; frames after the stall arrive                                                                                                                                                                                        |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m143p-queued-work-and-frames, never develop or main
pnpm run check:plan        # this plan lints clean once copied into plans/
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test:coverage queue-plugin messaging-plugin realtime-backplane-plugin   # per-file 90%, ANSI-stripped
pnpm run test:deno-lane
pnpm run release:publish --dry-run
pnpm run release:verify 0.14.0
```

The guarded suites run once with the full backend set (the `full-backend-test-command` env block),
one suite at a time on the shared machine; the conformance tables' real arms are read from the
report, not assumed. The `common` and `diagnostics-plugin` changes run under the same gates
(`pnpm test:coverage common diagnostics-plugin` in the edit loop, then the full `ci:local`).

## 8. Risks & mitigations

- **The Pub/Sub and Service Bus emulators may not honour `expirationPolicy` or `autoDeleteOnIdle`**
  (not verified) → the fan-out conformance asserts creation and deletion on the emulators, and the
  crash-expiry column of §3.7 is stated from the vendor documentation only; the row's closure note
  says so.
- **Service Bus fan-out needs administration rights** (Manage) that a send-and-listen role lacks →
  the subscribe error names the right; the README says it; the backplane refusal message points to
  `redis`.
- **A replica with a skewed clock drops every frame** → the once-per-state warning names the clock;
  `0` disables; default chosen in D5.
- **`crypto.randomUUID` in `SnsPublisher`** is a global API outside `packages/runtime`
  (AI_GUIDELINES) → if the maintainer prefers, `SnsPublisherOptions` takes an `id` generator
  instead; the plan uses the global only because the publisher has no `IRuntimeServices`. Flagged
  for review.
- **The SQS connect-time attribute read adds a network call to `start()`** → bounded; failure modes
  in §3.3 step 5; M143m's reachability probe shares the transport member.
- **M143m edits the same files next** (backplane plugin close hook, Service Bus inbox) → hand-overs
  in §11 name the seams this letter adds for it.
- **Hold-then-abandon on Service Bus blocks a concurrency slot** → delay refused at 240,000 ms or
  more; M143m's concurrency option documents it.
- **Consumer roles commonly lack the new rights** (`sqs:GetQueueAttributes`, `sqs:GetQueueUrl`,
  `sqs:SendMessage` on the target, `kms:GenerateDataKey` for an encrypted target) → the refusal and
  the forward-failure report name the right; the README and the upgrade note list them. Without
  `SendMessage` every forward fails and SQS's own redrive takes the message one receive later, after
  `onFailed` may have run twice (final failure, then the dead-worker path); the payload is kept.
- **The SNS to SQS suite has no CI service**: no LocalStack in `.github/` or the CI backend set, and
  ElasticMQ has no SNS → the wrapped shape is also unit-tested against AWS's documented notification
  example; the guarded suite runs locally against the shared `smoke-localstack` container
  (`localstack/localstack:3`, `http://127.0.0.1:4566`) with resources prefixed `m143p-` and deleted
  afterwards; the closure note says CI does not run it.
- **A forwarded SQS dead letter carries no `DeadLetterQueueSourceArn`**, so a console redrive to the
  source may need an explicit destination (not verified) → the README says how to redrive.

## 9. Out of scope

- Every M143m row (§0); M143o's WorkersQueue (V13-197); CLI and template changes (§11).
- The same unroutable shape on Pub/Sub and Service Bus (a topic with no subscription drops a
  message): not measured. If a run confirms it, it is registered as a new row in `smoke/DEFECTS.md`,
  not fixed here.
- Jobs longer than SQS's 12-hour visibility ceiling (documented only).

## 10. Design security review

This letter crosses trust boundaries, so a committed-tree security audit is required before merge,
run in a fresh context per `.roo/skills/security-audit/SKILL.md`, on the exact commit of each part.

- **Data in logs:** V13-213 logged whole message bodies at `error` (`sqs-queue.ts:395`), here
  including SNS signatures. The fix removes it; the audit proves no new log line in the three
  packages carries a payload, a header value, or an error message from a remote handler.
- **Data leaving the process:** the SQS forward adds three attributes: a fixed vocabulary, a count
  and the source's own SQS message id, never error text; the Pub/Sub not-retryable forward adds one
  fixed attribute. Negative control: a handler error containing a marker string never appears on the
  wire.
- **Untrusted input:** an SNS notification body is accepted without signature verification; the
  queue's access policy is the boundary, as today for any sender with `SendMessage`. The README says
  so. `sentAtMs` on a shared topic is untrusted: only a finite number is used, and a forged future
  value can only make a frame pass the age check, which is today's behaviour.
- **New resources and rights:** per-instance subscriptions and groups are named
  `<defaultQueue>-fanout-<uuid>` and never take caller input into the name; the Redis sweep destroys
  only `-fanout-` groups with all consumers idle.
- **Required audit record:** the PR carries the audit's findings table and its negative controls.

## 11. Hand-overs

- **Core lane, taken into this letter (D1, 2026-11-23):** `SubscribeOptions.fanOut` and
  `ISubscription.fanOut` in `packages/common/src/services/messaging.ts` with the JSDoc in §3.6 and
  the `PUBLIC_API.md` common messaging entries (C8) are Part B scope, not a hand-over.
- **M143m, same lane, next:** V13-263 uses
  `IServiceBusTransport.createSubscription(topic, sub, { autoDeleteOnIdleMs })` for the reply inbox;
  V13-215 builds the SQS probe on `ISqsTransport.getQueueAttributes`; its SQS time-bound option
  replaces the 10,000 ms constant in `sqs-redrive.ts`; V13-262's README text says a Service Bus
  retry delay holds one concurrency slot; V13-265's `custom` contract documents `fanOut` and the
  `ISubscription.fanOut` marker.
- **Out-of-lane edits approved by the maintainer (2026-11-22), made in Part A:** a one-line
  `deadLetterQueues` entry in `packages/diagnostics-plugin/test/e2e/queue-observations.test.ts`
  (`:134-141` starts an SQS consumer with no target, which would now refuse); the coordinator
  corrects the lanes table in `ROADMAP.md`, not this letter. `docs/messaging-emulators.md:141-148`
  gains `AWS_LOCALSTACK_ENDPOINT_URL` here.
- **Core lane, taken into this letter (D1, 2026-11-23):** the `discarded` member of the diagnostics
  settlement vocabulary (`common` `diagnostics.ts:618-619`) is Part B scope (§3.18), with the
  `diagnostics-plugin` `queue-protocol.ts` set updated as a named out-of-lane edit.
- **M143o (Workers):** apply §3.15's rule to `WorkersQueue` (V13-197): `onFailed` once, then a
  dead-letter target, or refuse at start when none can be proved. No change is needed for the
  backplane: `WorkersBroker` subscriptions carry no `fanOut` marker, so the `messaging` transport is
  refused there and the Durable Object backplane is the Workers answer; M143o's README says so.
- **CLI lane, M143e (`add` wiring, owns V13-270):**
  "`setu add realtime-backplane --backplane messaging` is offered only when the project's broker is
  one of memory, rabbitmq, nats, kafka, redis-streams, pubsub or service-bus, and prints that
  Service Bus needs `adminConnectionString`." `setu add queue --queue sqs` (if added) writes
  `deadLetterQueues` or prints that the queue needs a redrive policy, because the adapter now
  refuses to start without one.
- **CLI lane, M143d (owns V13-264):** its fix (publishing port 5300 and setting
  `adminConnectionString` in the generated Service Bus stack) is what lets a generated project use
  the Service Bus fan-out subscription and `maxDeliveryCount` read.
- **M143n (docs):** V13-269 (backplane readiness and lateness on `messaging`) and V13-229 (SQS
  options in no document) are re-checked against the README text this letter writes; only the
  readiness half of V13-269 remains for M143n.

## 12. Open decisions for the maintainer

- **D1, how the backplane gets fan-out.** (a) Optional `SubscribeOptions.fanOut` and
  `ISubscription.fanOut` in `common` (Spring Cloud Stream anonymous groups, Socket.IO per-server
  queues and subscriptions); (b) the backplane passes a per-replica `queue`, no contract change, but
  every crash leaves a durable queue that keeps collecting frames on RabbitMQ and Service Bus; (c)
  make queue-less mean fan-out everywhere, reversing the M119a decision of 2026-10-24.
  **Recommendation: (a).** **DECIDED by the maintainer, 2026-11-23: (a), with the `common` change
  shipped in M143p's own PR and flagged as out of lane, not as a Core PR first (§0.2).**
- **D2, an SQS queue with no dead-letter target.** **DECIDED by the maintainer, 2026-11-22: (a),
  refuse at `connect()`, with the queue's redrive policy accepted as a target.** Amended the same
  day: the check runs before a consumed name's first poll (D9), and
  `deadLetterQueues: { name: false }` is the explicit opt-out that discards exhausted jobs (§3.3a).
  (a) Refuse at `connect()` (data never lost, start fails loudly); (b) leave the message in the
  queue as Spring Cloud AWS and the .NET framework do, which loops through the dead-worker path
  until retention expires; (c) create an error queue as MassTransit does, which needs
  `sqs:CreateQueue`. **Recommendation: (a)**, with the redrive policy accepted as a target so a
  queue configured the AWS way needs no option.
- **D3: native SQS redrive or framework forward.** **Kept by the maintainer, 2026-11-22**: lower the
  budget and warn once per queue, never refuse for it (§3.3 step 5). Native redrive at the last
  attempt only works when the job's budget equals `maxReceiveCount`, and a natively moved copy
  cannot carry the reason, count or source id, so the plan always forwards and clamps the budget to
  `maxReceiveCount - 1` (§3.3 step 5; the off-by-one was re-derived in the Part A review). No
  surveyed framework clamps (Compared with, row 14). Spring Cloud AWS and the .NET framework defer
  to native redrive; MassTransit forwards.
- **D9 (Part A, new in review), when the dead-letter target of a consumed name is checked.**
  **DECIDED by the maintainer, 2026-11-22: (a)** (Compared with, row 15). The adapter connects in
  `register` before any processor exists, and `queues` also lists names the process only enqueues
  to, so checking at `connect()` would refuse a producer-only service. (a) An internal
  `prepareConsumer(name)` the service awaits before a name's first poll; the plugin awaits it for
  every declared processor, so `app.start()` fails for those; an imperative `process()` refusal is
  reported once at `error` and the name is never polled, its messages left in SQS; (b) check every
  name in `queues` at `connect()` and list producer-only services as BREAKING (they need a target or
  a policy too); (c) a new `sqs.consume` list naming the consumed queues. **Recommendation: (a)**:
  it keeps D2's start-time refusal for the normal (declared) case, asks nothing of a producer, and
  adds no option.
- **D4, retries on by default for Pub/Sub and Service Bus.** (a) On by default, as RabbitMQ and
  Redis Streams are; (b) opt-in, as Google's default subscription has no retry policy.
  **Recommendation: (a)**; Spring Cloud Stream also retries by default.
- **D5, the `maxFrameAgeMs` default.** (a) 5,000 ms; (b) 2,000 ms (tighter, more sensitive to clock
  skew); (c) off by default. X3-3 measured frames up to 20 s late. **Recommendation: (a).**
- **D6, unroutable outbox rows on RabbitMQ.** (a) Always routed for the relay (retry, then failed),
  plain publish unchanged; (b) an opt-in outbox option; (c) documentation only. Spring AMQP makes
  `mandatory` opt-in for publishes in general, but the outbox README promises at-least-once delivery
  of every row. **Recommendation: (a).**
- **D7, one PR or two.** **DECIDED by the maintainer, 2026-11-22: two ordered parts**, Part A at
  once as its own PR, Part B after it on the same branch (§0.3).
- **D8, the Pub/Sub ordering row.** (a) Fix in the framework (§3.14); (b) correct the README only.
  **Recommendation: (a)**, because Google's page assigns the ordering of asynchronous work to the
  subscriber, which here is the broker.
