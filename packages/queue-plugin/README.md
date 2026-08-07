# Queue Plugin

Background job queue plugin for Hono Enterprise with Memory, Redis, RabbitMQ, and SQS adapters.

## Installation

```bash
deno add @hono-enterprise/queue-plugin
```

## Usage

### Basic Setup (Memory Adapter)

```typescript
import { QueuePlugin } from '@hono-enterprise/queue-plugin';

app.register(QueuePlugin({ adapter: 'memory' }));
```

### Redis Adapter

```typescript
import { QueuePlugin } from '@hono-enterprise/queue-plugin';

app.register(QueuePlugin({
  adapter: 'redis',
  url: 'redis://localhost:6379',
}));
```

### RabbitMQ Adapter

```typescript
import { QueuePlugin } from '@hono-enterprise/queue-plugin';

app.register(QueuePlugin({
  adapter: 'rabbitmq',
  url: 'amqp://localhost:5672',
  queues: { default: 'tasks' },
}));
```

### SQS Adapter

```typescript
import { QueuePlugin } from '@hono-enterprise/queue-plugin';

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
import { QueuePlugin } from '@hono-enterprise/queue-plugin';

// Foreground queue
app.register(QueuePlugin({ adapter: 'memory', name: 'foreground' }));

// Background queue
app.register(QueuePlugin({ adapter: 'memory', name: 'background' }));
```

## API

### Adding Jobs

```typescript
import { CAPABILITIES } from '@hono-enterprise/common';

const queue = ctx.services.get<IQueue>(CAPABILITIES.QUEUE);

// Basic job
await queue.add('send-email', { to: 'user@example.com' });

// Delayed job
await queue.add('send-email', { to: 'user@example.com' }, { delayMs: 5000 });

// Job with retry limit
await queue.add('process-data', data, { maxAttempts: 5 });
```

### Processing Jobs

```typescript
queue.process('send-email', async (job) => {
  await emailService.send(job.data);
}, { concurrency: 3 });
```

### Recurring Jobs

```typescript
await queue.addRecurring('cleanup', {}, { cron: '0 0 * * *' }); // Daily at midnight
```

## Options

| Option               | Type                                         | Default                    | Description                              |
| -------------------- | -------------------------------------------- | -------------------------- | ---------------------------------------- |
| `adapter`            | `'memory' \| 'redis' \| 'rabbitmq' \| 'sqs'` | `'memory'`                 | Queue adapter type                       |
| `name`               | `string`                                     | -                          | Instance name for multi-instance support |
| `url`                | `string`                                     | `'redis://localhost:6379'` | Redis / RabbitMQ connection URL          |
| `region`             | `string`                                     | -                          | AWS region (SQS)                         |
| `queues`             | `Record<string, string>`                     | -                          | Queue name→URL mapping (RabbitMQ / SQS)  |
| `defaultMaxAttempts` | `number`                                     | `3`                        | Default retry attempts                   |
| `pollIntervalMs`     | `number`                                     | `1000`                     | Worker poll interval                     |

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
