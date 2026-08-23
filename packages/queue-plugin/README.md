# Queue Plugin

Background job queue plugin for Setu-TS with Memory, Redis, RabbitMQ, and SQS adapters.

## Installation

```bash
deno add @setu-ts/queue-plugin
```

## Usage

### Basic Setup (Memory Adapter)

```typescript
import { QueuePlugin } from '@setu-ts/queue-plugin';

app.register(QueuePlugin({ adapter: 'memory' }));
```

### Redis Adapter

```typescript
import { QueuePlugin } from '@setu-ts/queue-plugin';

app.register(QueuePlugin({
  adapter: 'redis',
  url: 'redis://localhost:6379',
}));
```

### RabbitMQ Adapter

```typescript
import { QueuePlugin } from '@setu-ts/queue-plugin';

app.register(QueuePlugin({
  adapter: 'rabbitmq',
  url: 'amqp://localhost:5672',
  // Queue names are derived per job name from this prefix
  // (`<prefix>.<name>.ready` / `.delay` / `.dead`); there is no `queues` map.
  prefix: 'he.queue',
}));
```

### SQS Adapter

```typescript
import { QueuePlugin } from '@setu-ts/queue-plugin';

app.register(QueuePlugin({
  adapter: 'sqs',
  sqs: {
    region: 'us-east-1',
    queues: { default: 'https://sqs.us-east-1.amazonaws.com/123456789012/tasks' },
  },
}));
```

### Named Instances

```typescript
import { QueuePlugin } from '@setu-ts/queue-plugin';

// Foreground queue
app.register(QueuePlugin({ adapter: 'memory', name: 'foreground' }));

// Background queue
app.register(QueuePlugin({ adapter: 'memory', name: 'background' }));
```

## API

### Adding Jobs

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { IQueue } from '@setu-ts/common';

const queue = ctx.services.get<IQueue>(CAPABILITIES.QUEUE);

// Basic job
await queue.add('send-email', { to: 'user@example.com' });

// Delayed job
await queue.add('send-email', { to: 'user@example.com' }, { delayMs: 5000 });

// Job with retry limit
await queue.add('process-data', { rows: 100 }, { maxAttempts: 5 });
```

### Processing Jobs

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { ILogger, IMailer, IQueue } from '@setu-ts/common';

const queue = ctx.services.get<IQueue>(CAPABILITIES.QUEUE);
const mailer = ctx.services.get<IMailer>(CAPABILITIES.MAIL);
const logger = ctx.services.get<ILogger>(CAPABILITIES.LOGGER);

interface SendEmail {
  to: string;
}

queue.process<SendEmail>('send-email', async (job) => {
  await mailer.send({ to: job.data.to, subject: 'Welcome', text: 'Hello' });
}, {
  concurrency: 3,
  // Invoked once when a job has exhausted its attempts, immediately before it
  // is dead-lettered — the only programmatic notice that work was abandoned.
  onFailed: (job, error) => {
    logger.error('job dead-lettered', { id: job.id, name: job.name, error: String(error) });
  },
});
```

### Recurring Jobs

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { IQueue } from '@setu-ts/common';

const queue = ctx.services.get<IQueue>(CAPABILITIES.QUEUE);

await queue.addRecurring('cleanup', {}, { cron: '0 0 * * *' }); // Daily at midnight
```

## Options

| Option               | Type                                         | Default                    | Description                                        |
| -------------------- | -------------------------------------------- | -------------------------- | -------------------------------------------------- |
| `adapter`            | `'memory' \| 'redis' \| 'rabbitmq' \| 'sqs'` | `'memory'`                 | Queue adapter type                                 |
| `name`               | `string`                                     | —                          | Instance name for multi-instance support           |
| `url`                | `string`                                     | `'redis://localhost:6379'` | Redis / RabbitMQ connection URL                    |
| `client`             | `IRedisQueueClient \| IAmqpQueueConnection`  | —                          | Injected client, bypassing the lazy import         |
| `prefix`             | `string`                                     | `'he.queue'`               | Queue-name prefix (RabbitMQ)                       |
| `sqs`                | `SqsQueueOptions`                            | —                          | SQS configuration; required when `adapter: 'sqs'`  |
| `defaultMaxAttempts` | `number`                                     | `3`                        | Default retry attempts                             |
| `pollIntervalMs`     | `number`                                     | `1000`                     | Worker poll interval                               |
| `deadLetterTtlMs`    | `number`                                     | — (retained forever)       | Retention for a dead-lettered payload (Redis only) |

Two options this table used to list do not exist and never did: `region` (SQS configuration lives
under `sqs`) and `queues` (RabbitMQ derives its queue names from `prefix`).

## Seeing a job that failed for the last time

A job that exhausts its attempts is dead-lettered by every adapter, and used to be reachable only by
opening a Redis client: `IQueue` has no `getJob` and no dead-letter accessor, the health payload was
`{"adapter":"RedisQueue"}`, and `/metrics` carried no queue series at all. Three surfaces answer
different questions about it:

| Surface                                  | Answers                                                               |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `ProcessOptions.onFailed`                | "This job is being abandoned" — log, alert, or compensate in process. |
| `queue_jobs_total{name,outcome}`         | "How often is this happening?" — the alertable rate.                  |
| The `queues` field in the health payload | "How many are sitting there right now?" — survives a restart.         |

The counter needs `@setu-ts/metrics-plugin` registered; without it no collector is built and
behaviour is unchanged. Depths are reported by the memory and Redis adapters and OMITTED (never
reported as zeros) on RabbitMQ and SQS, whose counts need a management API.

`deadLetterTtlMs` bounds how long the retained payload lives. Without it the jobs hash grows for the
lifetime of the deployment — the retention exists for debugging, so dropping it by default would
remove the value it is there for.

Retention is enforced **per payload**: each dead-letter sweeps the dead set — which is scored by
dead-letter time — and deletes every entry older than the TTL along with its payload. A key-level
`EXPIRE` alone would not do this, because each new dead-letter renews it, so a queue that keeps
failing would retain its oldest payloads forever. The key-level expiry is kept beside the sweep as
the backstop for the case the sweep cannot reach: a queue that dead-letters once and then goes quiet
never runs another sweep.

Setting it MOVES a dead job's payload from `queue:<name>:jobs` into `queue:<name>:dead:jobs`, and
the expiry is applied to that key and the dead set. It is never applied to the live jobs hash: that
key holds the payload of **every** job for the name, Redis keeps a key's TTL across later writes,
and a job whose payload has vanished is moved to the processing set by `reserve` and never returned
— so expiring it would silently discard work that was only waiting to run.

## Adapters

### MemoryQueue

In-memory queue for testing and local development. Jobs are lost on restart.

### RedisQueue

Redis-backed queue using sorted sets for delayed job storage. Supports persistence and distributed
processing.

### RabbitMqQueue

RabbitMQ-backed queue using native channels, exchanges, and queues. Supports delayed retries through
a per-queue delay exchange with TTL-based message routing. Requires the `amqplib` package at runtime
(or an injected `RabbitMqClient`).

### SqsQueue

AWS SQS-backed queue using the AWS SDK `@aws-sdk/client-sqs`. Supports visibility timeouts, delayed
jobs (up to 15 minutes via `DelaySeconds`), and manual DLQ forwarding. The `maxAttempts` field in
the job envelope drives the DLQ promotion logic. Requires the `@aws-sdk/client-sqs` package at
runtime (or an injected transport).

#### SQS Retry and DLQ

When a job reaches `maxAttempts`, `SqsQueue.deadLetter()` forwards the original message body to the
configured DLQ queue URL (via `sqs.deadLetterQueues`), then deletes the source message. If DLQ send
fails, the source message is **not** deleted (preventing silent data loss). If the source delete
fails after a successful DLQ send, a duplicate-risk warning is logged. Note: AWS SQS does not
support managed DLQ redrive for this adapter — DLQ forwarding is manual via the `deadLetterQueues`
option.

#### ElasticMQ E2E

The SQS adapter includes guarded E2E tests against ElasticMQ (`SQS_ENDPOINT_URL` environment
variable). These tests verify enqueue→reserve→ack round-trips, queue isolation, visibility retry
progression, and DLQ promotion.

## License

MIT

## Health indicator

Registered under the queue's capability token. Since M70c it reports two signals: the adapter's
lifecycle (`isReady()`) and its reachability (`isHealthy()`).

| Status | Meaning                                                                                   |
| ------ | ----------------------------------------------------------------------------------------- |
| `up`   | The adapter is connected and reachable, or cannot be probed (`reachable` is `'unknown'`). |
| `down` | The adapter is not connected, or is connected but unreachable.                            |

`data` reports `{ adapter, reachable }`, where `reachable` is `true`, `false`, or `'unknown'` when
the adapter has no liveness check.

## Exports

| Export                         | Kind      |
| ------------------------------ | --------- |
| `adaptSnsModule`               | function  |
| `adaptSqsModule`               | function  |
| `loadSnsModule`                | function  |
| `loadSqsModule`                | function  |
| `QueuePlugin`                  | function  |
| `MemoryQueue`                  | class     |
| `QueueBackendUnavailableError` | class     |
| `RabbitMqQueue`                | class     |
| `RedisQueue`                   | class     |
| `SnsPublisher`                 | class     |
| `SqsDelayTooLongError`         | class     |
| `SqsQueue`                     | class     |
| `SqsQueueNotConfiguredError`   | class     |
| `AddJobOptions`                | interface |
| `IJob`                         | interface |
| `IQueue`                       | interface |
| `ISnsTransport`                | interface |
| `ISqsTransport`                | interface |
| `ProcessOptions`               | interface |
| `QueueDepths`                  | interface |
| `QueueLogger`                  | interface |
| `QueuePluginOptions`           | interface |
| `RabbitMqQueueOptions`         | interface |
| `RecurringOptions`             | interface |
| `RedisQueueOptions`            | interface |
| `SnsPublisherOptions`          | interface |
| `SnsSdkModule`                 | interface |
| `SqsQueueOptions`              | interface |
| `SqsReceivedMessage`           | interface |
| `SqsSdkModule`                 | interface |
| `JobProcessor`                 | type      |
| `QueueAdapterType`             | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#queue-setu-tsqueue-plugin).
